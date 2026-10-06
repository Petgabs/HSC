import { afterEach, describe, expect, it, vi } from 'vitest';
import { sanitizeUploadName, uploadResourceToGitHub, verifyGitHubToken } from '../assets/js/lib/githubPublish.js';

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
