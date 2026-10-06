import { sha256Hex } from './uploadSafety.js';
import { TOKEN_VAULT_PATH, emptyTokenVault, isTokenVault } from './tokenVault.js';
import {
  ADMIN_ACTIVITY_COMMENT, ADMIN_ACTIVITY_PATH, mergeAdminActivity
} from './adminActivity.js';

export { ADMIN_ACTIVITY_PATH, TOKEN_VAULT_PATH };

const API_ROOT = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const REQUEST_TIMEOUT_MS = 20_000;
// A large resource (up to 50 MB, base64-encoded in one commit) can take far
// longer than a metadata read on a school connection. File writes therefore
// use their own, much longer budget so a slow-but-healthy upload is not
// aborted halfway and reported to the administrator as a failure.
const FILE_REQUEST_TIMEOUT_MS = 240_000;
const MAX_CONFLICT_RETRIES = 3;
const MAX_TRANSPORT_RETRIES = 2;
const TRANSPORT_RETRY_DELAYS_MS = [700, 2_000];
export const PUBLISH_TOKEN_SECRET_NAME = 'SCHOOLCLOUD_PUBLISH_TOKEN';

function encodePath(path) {
  return String(path)
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
}

function decodeBase64Text(value) {
  const bytes = decodeBase64Bytes(value);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function decodeBase64Bytes(value) {
  const normalized = String(value || '').replace(/\s/g, '');
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function encodeBase64Bytes(bytes, { onProgress } = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.subarray(offset, Math.min(offset + chunkSize, data.length));
    for (let index = 0; index < chunk.length; index += 1) {
      binary += String.fromCharCode(chunk[index]);
    }
    // Encoding a 50 MB file is real work on a school laptop; reporting it keeps
    // the upload dialog honest instead of looking frozen.
    if (typeof onProgress === 'function' && (offset / chunkSize) % 16 === 0) {
      onProgress(Math.min(1, (offset + chunkSize) / data.length));
    }
  }
  onProgress?.(1);
  return btoa(binary);
}

export function sanitizeUploadName(name) {
  const raw = String(name || '').normalize('NFC').trim();
  if (!raw || raw === '.' || raw === '..' || /[\\/\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error('Choose a file name without folders or control characters.');
  }
  const safe = raw.replace(/[<>:"|?*]/g, '-').replace(/\s+/g, ' ').trim();
  if (!safe || safe.startsWith('.')) throw new Error('That file name is not allowed.');
  return safe;
}

function headersFor(token, hasJson = false) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': API_VERSION,
    ...(hasJson ? { 'Content-Type': 'application/json' } : {})
  };
}

function apiUrl(owner, repo, path = '') {
  const root = `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return path ? `${root}/${path}` : root;
}

async function request(url, token, options = {}) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, ...fetchOptions } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...fetchOptions,
      headers: { ...headersFor(token, fetchOptions.body !== undefined), ...fetchOptions.headers },
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text.slice(0, 300) };
      }
    }
    if (!response.ok) {
      const error = new Error(body?.message || `GitHub returned HTTP ${response.status}.`);
      error.status = response.status;
      error.response = body;
      error.transient = response.status === 429 || response.status >= 500;
      throw error;
    }
    return body;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('GitHub did not respond in time. Check your connection and retry.');
      timeoutError.transient = true;
      timeoutError.timedOut = true;
      throw timeoutError;
    }
    // A dropped connection surfaces as a bare TypeError from fetch. It is the
    // most common failure on school Wi-Fi and is worth one quiet retry.
    if (error instanceof TypeError) error.transient = true;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

const RETRYABLE_METHODS = new Set(['GET', 'PUT', 'HEAD']);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * `request`, with a small exponential backoff for transient failures.
 *
 * Only idempotent-by-value requests are retried: reads, and writes whose body
 * is a complete replacement. A DELETE is never retried, and a retried PUT that
 * actually landed the first time comes back as a 409/422 which the callers
 * resolve by comparing the stored content with what they sent.
 */
async function requestWithRetry(url, token, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const retryable = RETRYABLE_METHODS.has(method);
  let lastError = null;
  for (let attempt = 0; attempt <= (retryable ? MAX_TRANSPORT_RETRIES : 0); attempt += 1) {
    try {
      return await request(url, token, options);
    } catch (error) {
      lastError = error;
      if (!retryable || !error?.transient || attempt >= MAX_TRANSPORT_RETRIES) throw error;
      await sleep(TRANSPORT_RETRY_DELAYS_MS[Math.min(attempt, TRANSPORT_RETRY_DELAYS_MS.length - 1)]);
    }
  }
  throw lastError || new Error('The GitHub request failed.');
}

export async function verifyGitHubToken({ token, owner, repo }) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) throw new Error('Paste a GitHub Personal Access Token first.');
  // Verify repository access only. Fine-grained tokens that are correctly
  // scoped to Contents do not need the unrelated read:user permission.
  const repository = await request(apiUrl(owner, repo), cleanToken);
  if (!repository?.full_name) throw new Error('The token cannot access the configured repository.');
  if (repository.permissions && repository.permissions.push !== true) {
    throw new Error('This token can read the repository but does not have write access. Grant Contents: Read and write.');
  }
  return { login: '', repository: repository.full_name };
}

/**
 * Save the publisher token one time as a GitHub Actions repository secret.
 * GitHub only accepts a LibSodium sealed-box value here; the plaintext token is
 * never written to a repository file or returned by the Secrets API. Existing
 * secrets are deliberately left unchanged so a repeated save cannot rotate or
 * overwrite the original credential by accident.
 */
export async function savePublishingTokenToGitHub({ owner, repo, token }) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) throw new Error('Paste a GitHub Personal Access Token first.');

  const secretPath = `actions/secrets/${encodeURIComponent(PUBLISH_TOKEN_SECRET_NAME)}`;
  let existingSecret;
  try {
    existingSecret = await request(apiUrl(owner, repo, secretPath), cleanToken);
  } catch (error) {
    if (error.status === 404) {
      existingSecret = null;
    } else if (error.status === 403) {
      throw new Error('GitHub denied access to repository secrets. Give this fine-grained token Secrets: Read and write permission, then try again.');
    } else {
      throw error;
    }
  }
  if (existingSecret) {
    return {
      saved: false,
      alreadySaved: true,
      secretName: PUBLISH_TOKEN_SECRET_NAME,
      updatedAt: existingSecret.updated_at || ''
    };
  }

  let publicKey;
  try {
    publicKey = await request(apiUrl(owner, repo, 'actions/secrets/public-key'), cleanToken);
  } catch (error) {
    if ([403, 404].includes(error.status)) {
      throw new Error('GitHub denied access to repository secrets. Give this fine-grained token Secrets: Read and write permission, then try again.');
    }
    throw error;
  }
  if (!publicKey?.key || !publicKey?.key_id) {
    throw new Error('GitHub did not return the repository secrets encryption key. No token was saved.');
  }

  let sodium;
  try {
    ({ default: sodium } = await import('../../vendor/libsodium-wrappers.mjs'));
    await sodium.ready;
  } catch {
    throw new Error('Secure token encryption is unavailable in this browser. No token was saved.');
  }

  let encryptedValue;
  try {
    const sealed = sodium.crypto_box_seal(
      new TextEncoder().encode(cleanToken),
      decodeBase64Bytes(publicKey.key)
    );
    encryptedValue = encodeBase64Bytes(sealed);
  } catch {
    throw new Error('GitHub’s repository key could not encrypt the token. No token was saved.');
  }

  try {
    await request(apiUrl(owner, repo, secretPath), cleanToken, {
      method: 'PUT',
      body: JSON.stringify({ encrypted_value: encryptedValue, key_id: publicKey.key_id })
    });
  } catch (error) {
    if ([403, 404].includes(error.status)) {
      throw new Error('GitHub denied permission to save repository secrets. Give this fine-grained token Secrets: Read and write permission, then try again.');
    }
    throw error;
  }

  return { saved: true, alreadySaved: false, secretName: PUBLISH_TOKEN_SECRET_NAME };
}

/* ---------------------------------------------------------------------------
 * Website token vault
 *
 * `savePublishingTokenToGitHub` above hands the token to GitHub's write-only
 * Actions secret store, which this website can never read back. The vault
 * below is the readable half: the same token, encrypted in the browser with
 * the administrator's passwords (see lib/tokenVault.js) and committed to the
 * repository so that GitHub Pages serves it with the site. Any computer the
 * administrator signs in on can fetch it and decrypt it locally, so the token
 * is stored "in the website" rather than in one browser.
 *
 * Only ciphertext is ever written here. These helpers refuse to commit
 * anything that is not a valid encrypted vault.
 * ------------------------------------------------------------------------- */

/**
 * Read the encrypted vault straight from the repository.
 *
 * The file is public, so this works without a token — which is the point: a
 * brand-new device has no credentials yet. A token is used when one is already
 * connected, purely to get the authenticated API rate limit. A missing or
 * unrecognisable file is reported as `null` rather than as an error.
 */
export async function readTokenVaultFromGitHub({ owner, repo, branch = 'main', token = '' } = {}) {
  const cleanToken = String(token || '').trim();
  const query = new URLSearchParams({ ref: branch });
  const url = apiUrl(owner, repo, `contents/${encodePath(TOKEN_VAULT_PATH)}?${query}`);
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      ...(cleanToken ? { Authorization: `Bearer ${cleanToken}` } : {})
    },
    cache: 'no-store',
    credentials: 'omit'
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not read the stored website token (HTTP ${response.status}).`);
  const file = await response.json();
  if (!file?.content) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(decodeBase64Text(file.content));
  } catch {
    return null;
  }
  return isTokenVault(parsed) ? parsed : null;
}

/**
 * Commit the encrypted vault. The plaintext token is only ever used here as
 * the API credential for the write; what lands in the repository is the
 * ciphertext the caller prepared.
 */
export async function saveTokenVaultToGitHub({ owner, repo, branch = 'main', token, vault }) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) throw new Error('Connect a GitHub token before storing it in the website.');
  if (!isTokenVault(vault)) throw new Error('Refusing to commit a token store that is not encrypted.');
  const serialized = JSON.stringify(vault);
  if (serialized.includes(cleanToken)) {
    throw new Error('Refusing to commit the token in readable form. Nothing was written.');
  }
  const result = await updateJson({
    owner, repo, branch, path: TOKEN_VAULT_PATH, token: cleanToken,
    message: 'Update the encrypted website publishing token',
    transform() {
      return vault;
    }
  });
  return {
    path: TOKEN_VAULT_PATH,
    commitUrl: result?.commit?.html_url || '',
    updatedAt: vault.updatedAt || ''
  };
}

/**
 * Empty the vault without deleting the file, so the website keeps serving a
 * valid (token-free) record instead of a 404. The previous ciphertext stays in
 * the Git history, which is why the interface also advises revoking the token
 * on GitHub when it may have been exposed.
 */
export async function clearTokenVaultOnGitHub({ owner, repo, branch = 'main', token }) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) throw new Error('Connect a GitHub token before changing the website token store.');
  let existing = null;
  try {
    existing = await readContents({ owner, repo, branch, path: TOKEN_VAULT_PATH, token: cleanToken });
  } catch {
    existing = null;
  }
  if (!existing) return { path: TOKEN_VAULT_PATH, cleared: false, missing: true, commitUrl: '' };
  const blank = emptyTokenVault({ repository: `${owner}/${repo}` });
  const result = await updateJson({
    owner, repo, branch, path: TOKEN_VAULT_PATH, token: cleanToken,
    message: 'Remove the stored website publishing token',
    transform() {
      return blank;
    }
  });
  return {
    path: TOKEN_VAULT_PATH,
    cleared: true,
    missing: false,
    commitUrl: result?.commit?.html_url || ''
  };
}

export async function listRepositoryFiles({ owner, repo, branch = 'main' }) {
  return readPublicRepositoryFiles({ owner, repo, branch });
}

async function readContents({ owner, repo, branch, path, token }) {
  const query = new URLSearchParams({ ref: branch });
  try {
    return await requestWithRetry(apiUrl(owner, repo, `contents/${encodePath(path)}?${query}`), token);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function putContents({ owner, repo, branch, path, token, content, message, sha, timeoutMs = REQUEST_TIMEOUT_MS }) {
  const body = { message, content, branch };
  if (sha) body.sha = sha;
  return requestWithRetry(apiUrl(owner, repo, `contents/${encodePath(path)}`), token, {
    method: 'PUT',
    timeoutMs,
    body: JSON.stringify(body)
  });
}

/**
 * The bytes of a file already in the repository. The Contents API inlines only
 * small files, so anything larger is fetched through the Git Blobs API using
 * the blob SHA the Contents API reports. Returns `{ bytes }`, `{ unreadable: true }`
 * or `{ missing: true }` — never throws for a file that simply cannot be read.
 */
async function readStoredBytes({ owner, repo, token, file }) {
  if (!file) return { missing: true };
  try {
    if (file.content && file.encoding !== 'none') {
      return { bytes: decodeBase64Bytes(file.content) };
    }
    if (!file.sha) return { unreadable: true };
    const blob = await requestWithRetry(apiUrl(owner, repo, `git/blobs/${encodeURIComponent(file.sha)}`), token);
    if (!blob?.content) return { unreadable: true };
    return { bytes: decodeBase64Bytes(blob.content) };
  } catch {
    return { unreadable: true };
  }
}

async function digestOfStoredFile({ owner, repo, token, file }) {
  const stored = await readStoredBytes({ owner, repo, token, file });
  if (!stored.bytes) return '';
  return sha256Hex(stored.bytes);
}

/**
 * Write the file, and — if the connection drops or the write conflicts —
 * establish what actually happened before reporting failure.
 *
 * GitHub's Contents API rejects a second write with 409/422, and a timed-out
 * write may well have landed. Comparing the stored digest with the digest of
 * the file in the administrator's browser turns both cases into an accurate
 * answer instead of a scary (and wrong) "already exists" error.
 */
async function putUploadedFile({ owner, repo, branch, path, token, content, message, digest, onProgress }) {
  try {
    return await putContents({
      owner, repo, branch, path, token, content, message, timeoutMs: FILE_REQUEST_TIMEOUT_MS
    });
  } catch (error) {
    const inconclusive = [409, 422].includes(Number(error?.status)) || Boolean(error?.transient);
    if (!inconclusive) throw error;
    onProgress?.({ stage: 'recovering', percent: 55, detail: 'The connection was interrupted. Checking whether GitHub stored the file…' });
    const stored = await readContents({ owner, repo, branch, path, token });
    if (!stored) throw error;
    const storedDigest = await digestOfStoredFile({ owner, repo, token, file: stored });
    if (storedDigest && digest && storedDigest === digest) {
      return {
        recovered: true,
        content: { name: stored.name, path: stored.path, sha: stored.sha, download_url: stored.download_url || '' }
      };
    }
    if (storedDigest) {
      throw new Error(`A file named “${path.slice('apps/'.length)}” is already in apps/. Rename the new file before uploading; existing files are never overwritten.`);
    }
    throw error;
  }
}

/**
 * Remove a file and its metadata entry after a failed verification. Best
 * effort only: the caller reports the rollback outcome either way, and a
 * half-removed upload is still visible to the administrator in GitHub.
 */
async function rollbackUpload({ owner, repo, branch, path, token, name }) {
  let fileRemoved = false;
  try {
    const file = await readContents({ owner, repo, branch, path, token });
    if (file?.sha) {
      await request(apiUrl(owner, repo, `contents/${encodePath(path)}`), token, {
        method: 'DELETE',
        body: JSON.stringify({ message: `Roll back unverified upload: ${file.name || name}`, sha: file.sha, branch })
      });
      fileRemoved = true;
    }
  } catch {
    fileRemoved = false;
  }
  try {
    await updateJson({
      owner, repo, branch, path: 'library.json', token,
      message: `Roll back metadata for ${name}`,
      transform(current) {
        if (!current || typeof current !== 'object' || Array.isArray(current)) return current || {};
        delete current[path];
        return current;
      }
    });
  } catch {
    // The file itself is the important part of a rollback.
  }
  return fileRemoved;
}

async function updateJson({ owner, repo, branch, path, token, message, transform }) {
  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt += 1) {
    const file = await readContents({ owner, repo, branch, path, token });
    let data = {};
    if (file?.content) {
      try {
        data = JSON.parse(decodeBase64Text(file.content));
      } catch {
        throw new Error(`${path} is not valid JSON. No changes were written to it.`);
      }
    }
    const next = transform(data);
    const content = encodeBase64Bytes(new TextEncoder().encode(`${JSON.stringify(next, null, 2)}\n`));
    try {
      return await putContents({
        owner, repo, branch, path, token, content,
        message,
        sha: file?.sha
      });
    } catch (error) {
      if (![409, 422].includes(error.status) || attempt === MAX_CONFLICT_RETRIES - 1) throw error;
    }
  }
  throw new Error(`Could not update ${path} because it changed repeatedly. Please retry.`);
}

async function updateTextFile({ owner, repo, branch, path, token, message, transform }) {
  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt += 1) {
    const file = await readContents({ owner, repo, branch, path, token });
    if (!file?.sha) throw new Error(`${path} was not found in the repository. Nothing was changed.`);
    const current = decodeBase64Text(file.content);
    const next = transform(current, file);
    if (next === current) return { changed: false, commitUrl: '' };
    try {
      const result = await putContents({
        owner, repo, branch, path, token,
        content: encodeBase64Bytes(new TextEncoder().encode(next)),
        message,
        sha: file.sha
      });
      return { changed: true, commitUrl: result?.commit?.html_url || '' };
    } catch (error) {
      if (![409, 422].includes(error.status) || attempt === MAX_CONFLICT_RETRIES - 1) throw error;
    }
  }
  throw new Error(`Could not update ${path} because it changed repeatedly. Please retry.`);
}

function curatedMetadata(metadata = {}) {
  const allowed = [
    'title', 'description', 'subject', 'years', 'tags', 'keywords', 'topic',
    'resourceType', 'language', 'owner', 'department', 'academicYear',
    'visibility', 'version', 'reviewDate', 'licence', 'accessibility', 'addedAt',
    // Integrity fields written by the uploader: the SHA-256 digest and byte
    // count let the dashboard re-verify a published file against what the
    // administrator chose, and let a re-upload be spotted immediately.
    'sha256', 'bytes'
  ];
  const result = {};
  for (const key of allowed) {
    const value = metadata[key];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      result[key] = key === 'years'
        ? value.map(Number).filter(year => Number.isInteger(year) && year >= 7 && year <= 12)
        : value.map(item => String(item).trim()).filter(Boolean);
    } else if (key === 'bytes') {
      const number = Number(value);
      if (Number.isSafeInteger(number) && number >= 0) result[key] = number;
    } else {
      result[key] = String(value).trim();
    }
  }
  if (!result.addedAt) result.addedAt = new Date().toISOString();
  return result;
}

/**
 * Publish one resource: write the file into `apps/`, record its curated
 * metadata (including the SHA-256 digest and byte count) in `library.json`, and
 * then re-read both from GitHub to confirm the published bytes are exactly the
 * bytes the administrator chose.
 *
 * The result reports what was verified so the interface can tell the
 * administrator precisely what happened, rather than a generic success toast:
 *
 *   - `verified`            the stored bytes match the local digest
 *   - `verificationSkipped` GitHub stored the file but it was too large to
 *                           re-read in the browser
 *   - `recovered`           the first write timed out, but the second read
 *                           proved the file had in fact landed
 *
 * On a digest mismatch the upload is rolled back (file and metadata removed)
 * and an error is thrown: publishing bytes that do not match the checked file
 * would defeat the safety inspection that ran before the upload.
 */
export async function uploadResourceToGitHub({
  owner,
  repo,
  branch = 'main',
  token,
  file,
  metadata,
  fileBytes = null,
  bytes = 0,
  sha256: expectedDigest = '',
  verify = true,
  onProgress = null
}) {
  const report = progress => {
    if (typeof onProgress !== 'function') return;
    try { onProgress(progress); } catch { /* Progress reporting must never break an upload. */ }
  };

  if (!file || (typeof file.arrayBuffer !== 'function' && !fileBytes)) throw new Error('Choose a file to upload.');
  const name = sanitizeUploadName(file.name);
  const path = `apps/${name}`;

  report({ stage: 'checking', percent: 4, detail: 'Checking GitHub for a file with this name…' });
  const existing = await readContents({ owner, repo, branch, path, token });
  if (existing) {
    throw new Error(`A file named “${name}” is already in apps/. Rename the new file before uploading; existing files are never overwritten.`);
  }

  report({ stage: 'reading', percent: 10, detail: 'Reading the file from this device…' });
  let data = fileBytes instanceof Uint8Array ? fileBytes : null;
  if (!data) {
    try {
      data = new Uint8Array(await file.arrayBuffer());
    } catch {
      throw new Error('The selected file could not be read. It may have been moved, renamed or is still open in another program — re-select it and try again.');
    }
  }
  const byteCount = Number(bytes) > 0 ? Number(bytes) : data.length;
  const digest = String(expectedDigest || '').toLowerCase() || await sha256Hex(data);

  report({ stage: 'encoding', percent: 20, detail: 'Preparing the upload…' });
  const content = encodeBase64Bytes(data, {
    onProgress: ratio => report({ stage: 'encoding', percent: 20 + Math.round((Number(ratio) || 0) * 15), detail: 'Preparing the upload…' })
  });

  report({ stage: 'uploading', percent: 38, detail: `Sending ${name} to GitHub… large files can take a minute.` });
  const uploaded = await putUploadedFile({ owner, repo, branch, path, token, content, message: `Publish resource: ${name}`, digest, onProgress: report });

  report({ stage: 'metadata', percent: 68, detail: 'Recording the library metadata…' });
  let metadataCommit = null;
  try {
    const entry = curatedMetadata({ ...metadata, sha256: digest || undefined, bytes: byteCount });
    metadataCommit = await updateJson({
      owner, repo, branch, path: 'library.json', token,
      message: `Add library metadata for ${name}`,
      transform(current) {
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
          throw new Error('library.json must contain a JSON object.');
        }
        current[path] = entry;
        return current;
      }
    });
  } catch (error) {
    error.uploadedPath = path;
    error.uploadCommitUrl = uploaded?.commit?.html_url || '';
    throw error;
  }

  const verification = { verified: false, skipped: false, message: '', storedDigest: '' };
  if (verify && digest) {
    report({ stage: 'verifying', percent: 85, detail: 'Re-reading the published file to confirm it matches…' });
    const stored = await readContents({ owner, repo, branch, path, token });
    const storedBytes = stored ? await readStoredBytes({ owner, repo, token, file: stored }) : { missing: true };
    if (storedBytes.unreadable) {
      verification.skipped = true;
      verification.message = 'GitHub stored the file, but it is larger than this browser re-reads, so the byte-for-byte check could not be completed.';
    } else if (!storedBytes.bytes) {
      verification.skipped = true;
      verification.message = 'The published file could not be re-read straight away. It will appear after GitHub Pages deploys; check it from the dashboard when convenient.';
    } else {
      verification.storedDigest = await sha256Hex(storedBytes.bytes);
      if (verification.storedDigest && verification.storedDigest !== digest) {
        const rolledBack = await rollbackUpload({ owner, repo, branch, path, token, name });
        const error = new Error(rolledBack
          ? 'The bytes GitHub stored did not match the file on this device, so the upload was removed again and nothing was published. Please try once more.'
          : 'The bytes GitHub stored did not match the file on this device. The file was not published; remove it manually in GitHub if it still appears.');
        error.digestMismatch = true;
        error.rolledBack = rolledBack;
        throw error;
      }
      verification.verified = Boolean(verification.storedDigest);
      if (!verification.verified) verification.message = 'The published file was re-read but its digest could not be recomputed in this browser.';
    }
  } else if (!digest) {
    verification.skipped = true;
    verification.message = 'This browser cannot compute SHA-256, so the upload could not be verified byte-for-byte.';
  }

  // Confirm the metadata record is really there — a file with no library entry
  // is invisible to students, which is exactly the sort of silent half-success
  // this verification step exists to catch.
  if (verify) {
    const library = await readContents({ owner, repo, branch, path: 'library.json', token });
    let recorded = null;
    if (library?.content) {
      try {
        recorded = JSON.parse(decodeBase64Text(library.content))?.[path] || null;
      } catch {
        recorded = null;
      }
    }
    if (!recorded) throw Object.assign(
      new Error('The file was stored, but its library.json metadata could not be confirmed. Check library.json in GitHub, or delete and re-upload the file.'),
      { uploadedPath: path, uploadCommitUrl: uploaded?.commit?.html_url || '' }
    );
    verification.metadataVerified = true;
    if (digest && recorded.sha256 && String(recorded.sha256).toLowerCase() !== digest) {
      throw Object.assign(
        new Error('The recorded metadata does not match this file. Nothing was deleted — check library.json in GitHub before trying again.'),
        { uploadedPath: path, metadataMismatch: true }
      );
    }
  }

  report({ stage: 'done', percent: 100, detail: 'Published and verified.' });
  return {
    path,
    name,
    downloadUrl: uploaded?.content?.download_url || '',
    commitUrl: metadataCommit?.commit?.html_url || uploaded?.commit?.html_url || '',
    sha256: digest,
    bytes: byteCount,
    verified: verification.verified,
    verificationSkipped: verification.skipped,
    verificationMessage: verification.message || '',
    metadataVerified: Boolean(verification.metadataVerified),
    recovered: Boolean(uploaded?.recovered)
  };
}

export async function deleteResourceFromGitHub({ owner, repo, branch = 'main', token, path }) {
  if (!/^apps\/[^/]+$/.test(String(path || ''))) throw new Error('Refusing to delete a path outside apps/.');
  const file = await readContents({ owner, repo, branch, path, token });
  if (!file?.sha) throw new Error('The file was not found in the repository. Refresh the library and try again.');
  const result = await request(apiUrl(owner, repo, `contents/${encodePath(path)}`), token, {
    method: 'DELETE',
    body: JSON.stringify({ message: `Remove resource: ${file.name}`, sha: file.sha, branch })
  });
  try {
    await updateJson({
      owner, repo, branch, path: 'library.json', token,
      message: `Remove library metadata for ${file.name}`,
      transform(current) {
        if (!current || typeof current !== 'object' || Array.isArray(current)) return current || {};
        delete current[path];
        delete current[file.name];
        return current;
      }
    });
  } catch (error) {
    error.deletedPath = path;
    throw error;
  }
  return { path, commitUrl: result?.commit?.html_url || '' };
}

/**
 * Administrator credentials live in the shipped `assets/js/config.js`, so a
 * rotation is a normal repository commit: this static site has no server and
 * no database to hold them in. Only the username, a fresh salt and the
 * SHA-256 digest are ever written — never a plain password.
 */
export const ADMIN_CONFIG_PATH = 'assets/js/config.js';

const GATE_USERNAME_PATTERN = /^[A-Za-z0-9._@+-]{3,64}$/;
const GATE_SALT_PATTERN = /^[a-f0-9]{16,128}$/;
const GATE_HASH_PATTERN = /^[a-f0-9]{64}$/;

function escapeSingleQuoted(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function assertGateValue(value, pattern, label) {
  const clean = String(value || '').trim();
  if (!pattern.test(clean)) throw new Error(`The new ${label} is not in the expected format. Nothing was written to the repository.`);
  return clean;
}

/**
 * Replace one credential block inside the shipped config source. The block is
 * matched by name (`admin:` / `master:`) and only the quoted values inside it
 * are rewritten, so the rest of the file — comments, freezing, ordering — is
 * preserved byte for byte.
 */
export function replaceConfigGateValues(source, blockName, values) {
  const text = String(source || '');
  const block = new RegExp(`(\\n\\s*${blockName}:\\s*(?:Object\\.freeze\\(\\s*)?\\{)([^}]*)(\\})`);
  const match = text.match(block);
  if (!match) return null;
  let body = match[2];
  for (const [field, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    const fieldPattern = new RegExp(`(${field}:\\s*)'[^']*'`);
    if (!fieldPattern.test(body)) return null;
    const replacement = escapeSingleQuoted(value);
    body = body.replace(fieldPattern, (_full, prefix) => `${prefix}'${replacement}'`);
  }
  return text.replace(block, (_full, opening, _body, closing) => `${opening}${body}${closing}`);
}

/**
 * Rewrite the administrator and master-password blocks of `config.js`.
 * Exported as a pure function so the rotation can be tested without touching
 * GitHub. Throws rather than writing a half-updated file.
 */
export function replaceConfigCredentials(source, { admin, master } = {}) {
  let next = String(source || '');
  if (admin) {
    const updated = replaceConfigGateValues(next, 'admin', {
      username: assertGateValue(admin.username, GATE_USERNAME_PATTERN, 'administrator username'),
      salt: assertGateValue(admin.salt, GATE_SALT_PATTERN, 'administrator salt'),
      passwordHash: assertGateValue(admin.passwordHash, GATE_HASH_PATTERN, 'administrator password digest')
    });
    if (updated === null) throw new Error('The administrator block could not be found in assets/js/config.js. Nothing was changed; edit the file in GitHub instead.');
    next = updated;
  }
  if (master) {
    const updated = replaceConfigGateValues(next, 'master', {
      salt: assertGateValue(master.salt, GATE_SALT_PATTERN, 'master-password salt'),
      passwordHash: assertGateValue(master.passwordHash, GATE_HASH_PATTERN, 'master-password digest')
    });
    if (updated === null) throw new Error('The master-password block could not be found in assets/js/config.js. Nothing was changed; edit the file in GitHub instead.');
    next = updated;
  }
  return next;
}

/**
 * Commit rotated administrator credentials to the repository. Requires a
 * connected token with Contents: Read and write. The plain passwords never
 * reach this function — the caller hashes them first.
 */
export async function saveAdminCredentialsToGitHub({ owner, repo, branch = 'main', token, admin, master }) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) throw new Error('Connect a GitHub token in Settings before changing the administrator sign-in.');
  const result = await updateTextFile({
    owner, repo, branch, path: ADMIN_CONFIG_PATH, token: cleanToken,
    message: 'Update administrator sign-in credentials',
    transform(current) {
      return replaceConfigCredentials(current, { admin, master });
    }
  });
  return {
    path: ADMIN_CONFIG_PATH,
    changed: result.changed,
    commitUrl: result.commitUrl || ''
  };
}

export async function readPublicRepositoryFiles({ owner, repo, branch = 'main' }) {
  const query = new URLSearchParams({ ref: branch });
  const response = await fetch(`${apiUrl(owner, repo, `contents/apps?${query}`)}`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION },
    cache: 'no-store',
    credentials: 'omit'
  });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`Could not load repository files (HTTP ${response.status}).`);
  const result = await response.json();
  return Array.isArray(result) ? result.filter(entry => entry.type === 'file') : [];
}

/**
 * Persist the shared download-count record (`stats/downloads.json`) to the
 * repository. Used by the admin's immediate sync and the scheduled GitHub
 * Actions job. The merge is max-wins per file and for visitors, so an
 * unreachable Abacus read can never drag saved totals backwards. Entries for
 * files that no longer exist are retained because they may still be rolling
 * out through a Pages deployment.
 */
export const DOWNLOAD_STATS_PATH = 'stats/downloads.json';

const DOWNLOAD_STATS_COMMENT = [
  'Durable record of the shared Abacus download counters.',
  'Written by the GitHub Actions sync and the admin dashboard, then served to',
  'every visitor as a same-origin fallback when Abacus is unreachable.',
  'Shape: { namespace, updatedAt, visitors, files: { "apps/Name.pdf": { downloads, key } } }.',
  'Counts only ever move upwards here: each sync keeps the larger of the',
  'saved value and the live value. Entries for deleted files may be removed.'
];

function safeCount(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

export async function saveDownloadStatsToGitHub({ owner, repo, branch = 'main', token, stats }) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) throw new Error('Connect a GitHub token in Settings before saving counts.');
  const files = stats?.files && typeof stats.files === 'object' && !Array.isArray(stats.files) ? stats.files : {};
  const now = new Date().toISOString();
  const result = await updateJson({
    owner, repo, branch, path: DOWNLOAD_STATS_PATH, token: cleanToken,
    message: `Update download counts (${Object.keys(files).length} files)`,
    transform(current) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        throw new Error(`${DOWNLOAD_STATS_PATH} must contain a JSON object.`);
      }
      const mergedFiles = {};
      const previous = current.files && typeof current.files === 'object' && !Array.isArray(current.files) ? current.files : {};
      for (const [path, entry] of Object.entries(previous)) {
        if (typeof path !== 'string' || !path) continue;
        mergedFiles[path] = {
          downloads: safeCount(entry?.downloads),
          key: typeof entry?.key === 'string' && entry.key ? entry.key : String(entry?.key || '')
        };
      }
      for (const [path, entry] of Object.entries(files)) {
        if (typeof path !== 'string' || !/^apps\/[^/]+$/.test(path)) continue;
        const key = typeof entry?.key === 'string' && entry.key ? entry.key : (mergedFiles[path]?.key || '');
        mergedFiles[path] = {
          downloads: Math.max(safeCount(mergedFiles[path]?.downloads), safeCount(entry?.downloads)),
          key
        };
      }
      return {
        _comment: Array.isArray(current._comment) && current._comment.length ? current._comment : DOWNLOAD_STATS_COMMENT,
        namespace: typeof stats?.namespace === 'string' && stats.namespace ? stats.namespace : (current.namespace || ''),
        updatedAt: typeof stats?.updatedAt === 'string' && stats.updatedAt ? stats.updatedAt : now,
        visitors: Math.max(safeCount(current.visitors), safeCount(stats?.visitors)),
        files: mergedFiles
      };
    }
  });
  return {
    path: DOWNLOAD_STATS_PATH,
    commitUrl: result?.commit?.html_url || '',
    visitors: safeCount(stats?.visitors),
    fileCount: Object.keys(files).length
  };
}

/**
 * Remove one file's entry from the shared download-count record
 * (`stats/downloads.json`). Used when an admin deletes a resource so the
 * removed file stops appearing in statistics after the next Pages deploy.
 * Everything else in the record (visitor total, other files, namespace and
 * comment) is preserved byte-for-byte apart from a refreshed `updatedAt`.
 * A missing record is a successful no-op: there is nothing to remove.
 */
export async function removeDownloadStatsForPath({ owner, repo, branch = 'main', token, path }) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) throw new Error('Connect a GitHub token in Settings before saving counts.');
  const wanted = String(path || '').normalize('NFC').trim();
  if (!/^apps\/[^/]+$/.test(wanted)) throw new Error('Refusing to edit download counts for a path outside apps/.');
  const wantedKey = wanted.toLowerCase();
  const fileName = wanted.slice('apps/'.length);

  const existing = await readContents({ owner, repo, branch, path: DOWNLOAD_STATS_PATH, token: cleanToken });
  if (!existing) return { path: DOWNLOAD_STATS_PATH, removed: false, missing: true, commitUrl: '' };

  const now = new Date().toISOString();
  let removed = false;
  const result = await updateJson({
    owner, repo, branch, path: DOWNLOAD_STATS_PATH, token: cleanToken,
    message: `Remove download counts for ${fileName}`,
    transform(current) {
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        throw new Error(`${DOWNLOAD_STATS_PATH} must contain a JSON object.`);
      }
      const previous = current.files && typeof current.files === 'object' && !Array.isArray(current.files)
        ? current.files
        : {};
      const mergedFiles = {};
      removed = false;
      for (const [entryPath, entry] of Object.entries(previous)) {
        if (String(entryPath || '').normalize('NFC').toLowerCase() === wantedKey) {
          removed = true;
          continue;
        }
        mergedFiles[entryPath] = {
          downloads: safeCount(entry?.downloads),
          key: typeof entry?.key === 'string' && entry.key ? entry.key : String(entry?.key || '')
        };
      }
      return {
        _comment: Array.isArray(current._comment) && current._comment.length ? current._comment : DOWNLOAD_STATS_COMMENT,
        namespace: typeof current.namespace === 'string' ? current.namespace : '',
        updatedAt: now,
        visitors: safeCount(current.visitors),
        files: mergedFiles
      };
    }
  });
  return {
    path: DOWNLOAD_STATS_PATH,
    removed,
    missing: false,
    commitUrl: result?.commit?.html_url || ''
  };
}

export function decodeGitHubText(content) {
  return decodeBase64Text(content);
}

export function getGitHubApiRoot() {
  return API_ROOT;
}

/**
 * Merge this device's administrator sign-in and upload entries into
 * `stats/admin-activity.json` in the repository.
 *
 * The write merges instead of replacing: the record already on GitHub, the
 * browser's cached copy and the pending queue are combined with de-duplication
 * by timestamp, so two administrators working at once cannot lose each other's
 * entries and a retry cannot double-count one sign-in. The transform is
 * bounded and sanitized by the adminActivity module.
 */
export async function mergeAdminActivityIntoGitHub({ owner, repo, branch = 'main', token, activity }) {
  const cleanToken = String(token || '').trim();
  if (!cleanToken) throw new Error('Connect a GitHub token in Settings before saving administrator activity.');
  const incoming = mergeAdminActivity(activity);
  const now = new Date().toISOString();
  const result = await updateJson({
    owner, repo, branch, path: ADMIN_ACTIVITY_PATH, token: cleanToken,
    message: `Record administrator activity (${incoming.logins.length} sign-ins, ${incoming.uploads.length} uploads)`,
    transform(current) {
      const merged = mergeAdminActivity(current, incoming);
      return {
        _comment: Array.isArray(current?._comment) && current._comment.length
          ? current._comment
          : ADMIN_ACTIVITY_COMMENT,
        updatedAt: now,
        logins: merged.logins,
        uploads: merged.uploads
      };
    }
  });
  return {
    path: ADMIN_ACTIVITY_PATH,
    commitUrl: result?.commit?.html_url || '',
    logins: incoming.logins.length,
    uploads: incoming.uploads.length
  };
}

const FILE_DETAIL_REQUEST_SPACING_MS = 120;

function publicGitHubHeaders() {
  return { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': API_VERSION };
}

async function publicGitHubJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: publicGitHubHeaders(),
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error(`GitHub returned HTTP ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The date a published file first joined the repository, read from its commit
 * history. `per_page=100` is enough for a school library: the oldest commit in
 * the list is the upload that added the file.
 */
async function firstCommitDate({ owner, repo, branch, path }) {
  const query = new URLSearchParams({ path, sha: branch, per_page: '100' });
  const commits = await publicGitHubJson(apiUrl(owner, repo, `commits?${query}`));
  if (!Array.isArray(commits) || !commits.length) return '';
  const oldest = commits[commits.length - 1];
  const stamp = oldest?.commit?.author?.date || oldest?.commit?.committer?.date || '';
  const parsed = Date.parse(String(stamp || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

/**
 * Resolve the two facts the dashboard cannot get from `apps.json` alone: each
 * published file's size in bytes and the date it was added to the repository.
 *
 * Sizes come from one directory listing. Upload dates are only looked up for
 * files that have no `addedAt` in `library.json`, and each file costs one
 * public GitHub request, so the caller passes a budget (`maxDateLookups`) and
 * may pass previously resolved dates (`knownDates`) to skip repeat lookups.
 *
 * Best effort by design: a blocked or rate-limited GitHub API returns whatever
 * partly resolved, never an exception, so the dashboard still renders.
 */
export async function readCloudFileDetails({
  owner, repo, branch = 'main', paths = [], knownDates = {}, maxDateLookups = 12,
  spacingMs = FILE_DETAIL_REQUEST_SPACING_MS, wait = ms => new Promise(resolve => setTimeout(resolve, ms))
}) {
  const sizes = {};
  const addedAt = {};
  const warnings = [];
  let files = [];
  try {
    files = await readPublicRepositoryFiles({ owner, repo, branch });
  } catch (error) {
    warnings.push(error?.message || 'The repository file list could not be read.');
  }
  for (const file of files) {
    const path = String(file?.path || '');
    const size = Number(file?.size);
    if (path && Number.isFinite(size) && size > 0) sizes[path] = size;
  }

  const wanted = [...new Set((Array.isArray(paths) ? paths : []).filter(path => /^apps\/[^/]+$/.test(String(path || ''))))];
  const known = knownDates && typeof knownDates === 'object' ? knownDates : {};
  const budget = Math.max(0, Math.min(wanted.length, Number(maxDateLookups) || 0));
  let used = 0;
  for (const path of wanted) {
    const cached = String(known[path] || '');
    if (Number.isFinite(Date.parse(cached))) {
      addedAt[path] = new Date(Date.parse(cached)).toISOString();
      continue;
    }
    if (used >= budget) continue;
    if (used > 0 && spacingMs > 0) await wait(spacingMs);
    used += 1;
    try {
      const stamp = await firstCommitDate({ owner, repo, branch, path });
      if (stamp) addedAt[path] = stamp;
    } catch (error) {
      warnings.push(`Upload date for ${path.split('/').pop()} could not be read: ${error?.message || 'unknown error'}`);
    }
  }

  return { sizes, addedAt, files: files.length, dateLookups: used, warnings };
}

