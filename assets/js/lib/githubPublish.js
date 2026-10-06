const API_ROOT = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_CONFLICT_RETRIES = 3;
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

export function encodeBase64Bytes(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.subarray(offset, Math.min(offset + chunkSize, data.length));
    for (let index = 0; index < chunk.length; index += 1) {
      binary += String.fromCharCode(chunk[index]);
    }
  }
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      headers: { ...headersFor(token, options.body !== undefined), ...options.headers },
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
      throw error;
    }
    return body;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('GitHub did not respond in time. Check your connection and retry.');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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

export async function listRepositoryFiles({ owner, repo, branch = 'main' }) {
  return readPublicRepositoryFiles({ owner, repo, branch });
}

async function readContents({ owner, repo, branch, path, token }) {
  const query = new URLSearchParams({ ref: branch });
  try {
    return await request(apiUrl(owner, repo, `contents/${encodePath(path)}?${query}`), token);
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function putContents({ owner, repo, branch, path, token, content, message, sha }) {
  const body = { message, content, branch };
  if (sha) body.sha = sha;
  return request(apiUrl(owner, repo, `contents/${encodePath(path)}`), token, {
    method: 'PUT',
    body: JSON.stringify(body)
  });
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

function curatedMetadata(metadata = {}) {
  const allowed = [
    'title', 'description', 'subject', 'years', 'tags', 'keywords', 'topic',
    'resourceType', 'language', 'owner', 'department', 'academicYear',
    'visibility', 'version', 'reviewDate', 'licence', 'accessibility', 'addedAt'
  ];
  const result = {};
  for (const key of allowed) {
    const value = metadata[key];
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      result[key] = key === 'years'
        ? value.map(Number).filter(year => Number.isInteger(year) && year >= 7 && year <= 12)
        : value.map(item => String(item).trim()).filter(Boolean);
    } else {
      result[key] = String(value).trim();
    }
  }
  if (!result.addedAt) result.addedAt = new Date().toISOString();
  return result;
}

export async function uploadResourceToGitHub({
  owner,
  repo,
  branch = 'main',
  token,
  file,
  metadata
}) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('Choose a file to upload.');
  const name = sanitizeUploadName(file.name);
  const path = `apps/${name}`;
  const existing = await readContents({ owner, repo, branch, path, token });
  if (existing) {
    throw new Error(`A file named “${name}” is already in apps/. Rename the new file before uploading; existing files are never overwritten.`);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const uploaded = await putContents({
    owner, repo, branch, path, token,
    content: encodeBase64Bytes(bytes),
    message: `Publish resource: ${name}`
  });

  let metadataCommit = null;
  try {
    const entry = curatedMetadata(metadata);
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

  return {
    path,
    name,
    downloadUrl: uploaded?.content?.download_url || '',
    commitUrl: metadataCommit?.commit?.html_url || uploaded?.commit?.html_url || ''
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
