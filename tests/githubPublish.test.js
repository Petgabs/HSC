import { afterEach, describe, expect, it, vi } from 'vitest';
import sodium from 'libsodium-wrappers';
import {
  encodeBase64Bytes, PUBLISH_TOKEN_SECRET_NAME, sanitizeUploadName,
  saveDownloadStatsToGitHub, savePublishingTokenToGitHub,
  uploadResourceToGitHub, verifyGitHubToken
} from '../assets/js/lib/githubPublish.js';

function mockResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body === null ? '' : JSON.stringify(body)
  };
}

function base64Json(value) {
  return btoa(new TextEncoder().encode(JSON.stringify(value)).reduce((result, byte) => result + String.fromCharCode(byte), ''));
}

afterEach(() => vi.unstubAllGlobals());

describe('one-time GitHub Actions publisher secret', () => {
  it('encrypts the token for GitHub and never overwrites an existing secret', async () => {
    await sodium.ready;
    const keyPair = sodium.crypto_box_keypair();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse(404, { message: 'Not Found' }))
      .mockResolvedValueOnce(mockResponse(200, {
        key_id: 'repository-key-id', key: encodeBase64Bytes(keyPair.publicKey)
      }))
      .mockResolvedValueOnce(mockResponse(201, null));
    vi.stubGlobal('fetch', fetchMock);

    const token = 'fine-grained-token-example';
    await expect(savePublishingTokenToGitHub({ owner: 'Petgabs', repo: 'HSC', token }))
      .resolves.toMatchObject({ saved: true, alreadySaved: false, secretName: PUBLISH_TOKEN_SECRET_NAME });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0][0]).toContain(`/actions/secrets/${PUBLISH_TOKEN_SECRET_NAME}`);
    expect(fetchMock.mock.calls[1][0]).toContain('/actions/secrets/public-key');

    const secretRequest = fetchMock.mock.calls[2][1];
    const body = JSON.parse(secretRequest.body);
    expect(secretRequest.method).toBe('PUT');
    expect(secretRequest.headers.Authorization).toBe(`Bearer ${token}`);
    expect(body).toMatchObject({ key_id: 'repository-key-id' });
    expect(body.encrypted_value).not.toBe(token);
    expect(JSON.stringify(body)).not.toContain(token);

    const sealed = Uint8Array.from(atob(body.encrypted_value), character => character.charCodeAt(0));
    const plaintext = sodium.crypto_box_seal_open(sealed, keyPair.publicKey, keyPair.privateKey);
    expect(new TextDecoder().decode(plaintext)).toBe(token);
  });

  it('leaves an existing repository secret unchanged', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, {
      name: PUBLISH_TOKEN_SECRET_NAME, updated_at: '2026-10-06T00:00:00Z'
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(savePublishingTokenToGitHub({ owner: 'Petgabs', repo: 'HSC', token: 'replacement-token' }))
      .resolves.toMatchObject({ saved: false, alreadySaved: true, secretName: PUBLISH_TOKEN_SECRET_NAME });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBeUndefined();
  });

  it('requires read/write access to repository secrets before saving', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(403, { message: 'Resource not accessible by integration' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(savePublishingTokenToGitHub({ owner: 'Petgabs', repo: 'HSC', token: 'valid-repo-token' }))
      .rejects.toThrow('Secrets: Read and write');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('direct GitHub publishing', () => {
  it('rejects path traversal and folder names', () => {
    expect(() => sanitizeUploadName('../secret.pdf')).toThrow();
    expect(() => sanitizeUploadName('folder/resource.pdf')).toThrow();
    expect(sanitizeUploadName('Year 12 revision.pdf')).toBe('Year 12 revision.pdf');
  });

  it('verifies repository write access without requiring read:user', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, {
      full_name: 'Petgabs/HSC', permissions: { push: true }
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(verifyGitHubToken({ token: 'new-token', owner: 'Petgabs', repo: 'HSC' }))
      .resolves.toMatchObject({ repository: 'Petgabs/HSC' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.github.com/repos/Petgabs/HSC');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer new-token');
  });

  it('commits a resource into apps/ and merges curated library metadata', async () => {
    const existingLibrary = { _comment: ['keep this comment'] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse(404, { message: 'Not Found' }))
      .mockResolvedValueOnce(mockResponse(201, {
        content: { name: 'Practice.pdf', download_url: 'https://raw.githubusercontent.com/Petgabs/HSC/main/apps/Practice.pdf' },
        commit: { html_url: 'https://github.com/Petgabs/HSC/commit/file' }
      }))
      .mockResolvedValueOnce(mockResponse(200, {
        sha: 'library-sha', content: base64Json(existingLibrary)
      }))
      .mockResolvedValueOnce(mockResponse(200, {
        commit: { html_url: 'https://github.com/Petgabs/HSC/commit/metadata' }
      }));
    vi.stubGlobal('fetch', fetchMock);

    const file = {
      name: 'Practice.pdf',
      arrayBuffer: async () => new TextEncoder().encode('%PDF-content').buffer
    };
    const result = await uploadResourceToGitHub({
      owner: 'Petgabs', repo: 'HSC', branch: 'main', token: 'secret-token', file,
      metadata: { title: 'Year 12 Practice', years: [12], subject: 'Mathematics', tags: ['revision'] }
    });

    expect(result).toMatchObject({ path: 'apps/Practice.pdf', name: 'Practice.pdf' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const uploadRequest = fetchMock.mock.calls[1][1];
    const uploadBody = JSON.parse(uploadRequest.body);
    expect(uploadRequest.method).toBe('PUT');
    expect(uploadRequest.headers.Authorization).toBe('Bearer secret-token');
    expect(uploadBody.message).toContain('Practice.pdf');
    expect(atob(uploadBody.content)).toBe('%PDF-content');
    expect(uploadBody).not.toHaveProperty('token');

    const metadataRequest = fetchMock.mock.calls[3][1];
    const metadataBody = JSON.parse(metadataRequest.body);
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(metadataBody.content), char => char.charCodeAt(0)));
    const library = JSON.parse(decoded);
    expect(library._comment).toEqual(['keep this comment']);
    expect(library['apps/Practice.pdf']).toMatchObject({ title: 'Year 12 Practice', years: [12], subject: 'Mathematics' });
  });

  it('never overwrites a same-named file', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, { sha: 'already-there' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(uploadResourceToGitHub({
      owner: 'Petgabs', repo: 'HSC', token: 'token',
      file: { name: 'Existing.pdf', arrayBuffer: async () => new ArrayBuffer(0) },
      metadata: { title: 'replacement' }
    })).rejects.toThrow('already in apps/');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('download-count record sync', () => {
  function decodeJsonCall(call) {
    const request = call[1];
    const body = JSON.parse(request.body);
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(body.content), char => char.charCodeAt(0)));
    return { request, body, record: JSON.parse(decoded) };
  }

  it('creates the stats record when none exists', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse(404, { message: 'Not Found' }))
      .mockResolvedValueOnce(mockResponse(201, { commit: { html_url: 'https://github.com/Petgabs/HSC/commit/stats' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await saveDownloadStatsToGitHub({
      owner: 'Petgabs', repo: 'HSC', branch: 'main', token: 'secret-token',
      stats: {
        namespace: 'petgabs-hsc-schoolcloud', updatedAt: '2026-10-06T05:15:00.000Z', visitors: 41,
        files: { 'apps/Practice.pdf': { downloads: 8, key: 'download-abc12345' } }
      }
    });

    expect(result).toMatchObject({ path: 'stats/downloads.json', fileCount: 1, visitors: 41 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain('/contents/stats/downloads.json');
    const { request, body, record } = decodeJsonCall(fetchMock.mock.calls[1]);
    expect(request.method).toBe('PUT');
    expect(request.headers.Authorization).toBe('Bearer secret-token');
    expect(body.message).toContain('download counts');
    expect(body).not.toHaveProperty('sha');
    expect(body).not.toHaveProperty('token');
    expect(record).toMatchObject({
      namespace: 'petgabs-hsc-schoolcloud', visitors: 41, updatedAt: '2026-10-06T05:15:00.000Z'
    });
    expect(record.files['apps/Practice.pdf']).toMatchObject({ downloads: 8, key: 'download-abc12345' });
    expect(record._comment.length).toBeGreaterThan(0);
  });

  it('merges max-wins and never drags saved totals backwards', async () => {
    const existing = {
      _comment: ['keep this comment'],
      namespace: 'petgabs-hsc-schoolcloud',
      updatedAt: '2026-10-01T00:00:00.000Z',
      visitors: 50,
      files: {
        'apps/Old.pdf': { downloads: 9, key: 'download-aaaaaaaa' },
        'apps/Stale.pdf': { downloads: 4, key: 'download-cccccccc' }
      }
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse(200, { sha: 'stats-sha', content: base64Json(existing) }))
      .mockResolvedValueOnce(mockResponse(200, { commit: { html_url: 'https://github.com/Petgabs/HSC/commit/stats2' } }));
    vi.stubGlobal('fetch', fetchMock);

    await saveDownloadStatsToGitHub({
      owner: 'Petgabs', repo: 'HSC', token: 'secret-token',
      stats: {
        namespace: 'petgabs-hsc-schoolcloud', updatedAt: '2026-10-06T05:15:00.000Z', visitors: 41,
        files: {
          'apps/Old.pdf': { downloads: 12, key: 'download-aaaaaaaa' },
          'apps/New.pdf': { downloads: 7, key: 'download-bbbbbbbb' },
          '../escape.pdf': { downloads: 999, key: 'download-eeeeeeee' }
        }
      }
    });

    const { body, record } = decodeJsonCall(fetchMock.mock.calls[1]);
    expect(body.sha).toBe('stats-sha');
    expect(record._comment).toEqual(['keep this comment']);
    expect(record.visitors).toBe(50);
    expect(record.files['apps/Old.pdf']).toMatchObject({ downloads: 12, key: 'download-aaaaaaaa' });
    expect(record.files['apps/New.pdf']).toMatchObject({ downloads: 7, key: 'download-bbbbbbbb' });
    expect(record.files['apps/Stale.pdf']).toMatchObject({ downloads: 4 });
    expect(record.files).not.toHaveProperty('../escape.pdf');
  });

  it('requires a token and valid existing JSON', async () => {
    await expect(saveDownloadStatsToGitHub({ owner: 'Petgabs', repo: 'HSC', stats: { files: {} } }))
      .rejects.toThrow('Connect a GitHub token');
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, { sha: 'x', content: btoa('not json{{{') }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(saveDownloadStatsToGitHub({ owner: 'Petgabs', repo: 'HSC', token: 't', stats: { files: {} } }))
      .rejects.toThrow('not valid JSON');
  });
});
