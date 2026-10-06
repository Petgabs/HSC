const API_ROOT = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_CONFLICT_RETRIES = 3;

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

export function decodeGitHubText(content) {
  return decodeBase64Text(content);
}

export function getGitHubApiRoot() {
  return API_ROOT;
}
