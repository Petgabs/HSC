import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TOKEN_VAULT_PATH, createTokenVault, describeTokenVault, emptyTokenVault, isTokenVault,
  openTokenVault, tokenVaultSlotIsStale, tokenVaultSlots
} from '../assets/js/lib/tokenVault.js';
import {
  clearTokenVaultOnGitHub, readTokenVaultFromGitHub, saveTokenVaultToGitHub
} from '../assets/js/lib/githubPublish.js';

/**
 * The publishing token is stored in the website itself so that every computer
 * the administrator signs in on can publish. These tests pin the two promises
 * that makes: the committed file never contains a usable token, and the right
 * password always gets it back.
 */

// Keep the key derivation honest but quick in tests; production uses 310,000.
const ITERATIONS = 60_000;
const TOKEN = 'github_pat_11TESTONLY_notarealtoken_0123456789';
const PASSWORDS = { admin: 'admin-password-for-test', master: 'master-password-for-test' };

function mockResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (body === null ? '' : JSON.stringify(body)),
    json: async () => body
  };
}

const base64Json = value =>
  btoa(new TextEncoder().encode(JSON.stringify(value)).reduce((text, byte) => text + String.fromCharCode(byte), ''));

async function makeVault(overrides = {}) {
  return createTokenVault({
    token: TOKEN,
    passwords: PASSWORDS,
    repository: 'Petgabs/HSC',
    gates: { admin: 'admin-gate-salt', master: 'master-gate-salt' },
    iterations: ITERATIONS,
    ...overrides
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('encrypted website token vault', () => {
  it('stores ciphertext only and never the token itself', async () => {
    const vault = await makeVault();
    const serialized = JSON.stringify(vault);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain(PASSWORDS.admin);
    expect(serialized).not.toContain(PASSWORDS.master);
    expect(serialized).not.toMatch(/github_pat/);
    expect(vault.cipher).toBe('AES-GCM');
    expect(vault.kdf).toMatchObject({ name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS });
    expect(isTokenVault(vault)).toBe(true);
    expect(tokenVaultSlots(vault)).toEqual(['admin', 'master']);
    expect(describeTokenVault(vault)).toMatchObject({ present: true, repository: 'Petgabs/HSC' });
  });

  it('gives the token back to either administrator password', async () => {
    const vault = await makeVault();
    await expect(openTokenVault(vault, { password: PASSWORDS.admin, slot: 'admin' }))
      .resolves.toEqual({ token: TOKEN, slot: 'admin' });
    await expect(openTokenVault(vault, { password: PASSWORDS.master, slot: 'master' }))
      .resolves.toEqual({ token: TOKEN, slot: 'master' });
    // The slot hint is only a hint: the master password still opens the vault
    // when the sign-in slot is tried first.
    await expect(openTokenVault(vault, { password: PASSWORDS.master, slot: 'admin' }))
      .resolves.toMatchObject({ token: TOKEN, slot: 'master' });
  });

  it('refuses a wrong password, an empty password and tampered ciphertext', async () => {
    const vault = await makeVault();
    await expect(openTokenVault(vault, { password: 'not-the-password' }))
      .rejects.toMatchObject({ code: 'locked' });
    await expect(openTokenVault(vault, { password: '' }))
      .rejects.toMatchObject({ code: 'locked' });

    const tampered = JSON.parse(JSON.stringify(vault));
    const bytes = Uint8Array.from(atob(tampered.token.data), character => character.charCodeAt(0));
    bytes[0] ^= 0xff;
    tampered.token.data = btoa(String.fromCharCode(...bytes));
    await expect(openTokenVault(tampered, { password: PASSWORDS.admin }))
      .rejects.toMatchObject({ code: 'locked' });
  });

  it('reports a missing vault instead of pretending it is locked', async () => {
    await expect(openTokenVault(null, { password: PASSWORDS.admin })).rejects.toMatchObject({ code: 'missing' });
    await expect(openTokenVault(emptyTokenVault({ repository: 'Petgabs/HSC' }), { password: PASSWORDS.admin }))
      .rejects.toMatchObject({ code: 'missing' });
    expect(isTokenVault(emptyTokenVault())).toBe(false);
    expect(tokenVaultSlots(emptyTokenVault())).toEqual([]);
  });

  it('locks only the slots whose password is available', async () => {
    const vault = await makeVault({ passwords: { admin: PASSWORDS.admin, master: '' } });
    expect(tokenVaultSlots(vault)).toEqual(['admin']);
    await expect(openTokenVault(vault, { password: PASSWORDS.admin })).resolves.toMatchObject({ token: TOKEN });
    await expect(createTokenVault({ token: TOKEN, passwords: {}, iterations: ITERATIONS }))
      .rejects.toThrow(/sign in again/i);
    await expect(createTokenVault({ token: '', passwords: PASSWORDS, iterations: ITERATIONS }))
      .rejects.toThrow(/no connected token/i);
  });

  it('flags a copy that was locked with a replaced password', async () => {
    const vault = await makeVault();
    expect(tokenVaultSlotIsStale(vault, 'admin', 'admin-gate-salt')).toBe(false);
    expect(tokenVaultSlotIsStale(vault, 'admin', 'rotated-gate-salt')).toBe(true);
    expect(tokenVaultSlotIsStale(vault, 'master', 'master-gate-salt')).toBe(false);
  });

  it('uses fresh salts and a fresh data key every save', async () => {
    const [first, second] = [await makeVault(), await makeVault()];
    expect(first.slots.admin.salt).not.toBe(second.slots.admin.salt);
    expect(first.slots.admin.iv).not.toBe(second.slots.admin.iv);
    expect(first.token.data).not.toBe(second.token.data);
    await expect(openTokenVault(second, { password: PASSWORDS.admin })).resolves.toMatchObject({ token: TOKEN });
  });
});

describe('reading and writing the vault on GitHub', () => {
  it('commits the encrypted record to the repository path served by the site', async () => {
    const vault = await makeVault();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse(404, { message: 'Not Found' }))
      .mockResolvedValueOnce(mockResponse(201, { commit: { html_url: 'https://github.com/Petgabs/HSC/commit/vault' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await saveTokenVaultToGitHub({ owner: 'Petgabs', repo: 'HSC', token: TOKEN, vault });
    expect(result).toMatchObject({ path: TOKEN_VAULT_PATH, commitUrl: expect.stringContaining('/commit/vault') });
    expect(TOKEN_VAULT_PATH).toBe('assets/data/publish-token.json');

    const [url, init] = fetchMock.mock.calls[1];
    expect(String(url)).toContain('contents/assets/data/publish-token.json');
    expect(init.method).toBe('PUT');
    const written = JSON.parse(init.body);
    const committed = Buffer.from(written.content, 'base64').toString('utf8');
    expect(committed).not.toContain(TOKEN);
    expect(JSON.parse(committed).slots.admin.salt).toBeTruthy();
    // The token is only used as the API credential for the write itself.
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('never commits a record that is not encrypted', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(saveTokenVaultToGitHub({
      owner: 'Petgabs', repo: 'HSC', token: TOKEN, vault: { version: 1, token: TOKEN, slots: {} }
    })).rejects.toThrow(/not encrypted/i);
    await expect(saveTokenVaultToGitHub({ owner: 'Petgabs', repo: 'HSC', token: '', vault: await makeVault() }))
      .rejects.toThrow(/Connect a GitHub token/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads the stored record without any credentials', async () => {
    const vault = await makeVault();
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, {
      sha: 'vault-sha', content: base64Json(vault)
    }));
    vi.stubGlobal('fetch', fetchMock);

    const loaded = await readTokenVaultFromGitHub({ owner: 'Petgabs', repo: 'HSC' });
    expect(isTokenVault(loaded)).toBe(true);
    await expect(openTokenVault(loaded, { password: PASSWORDS.master })).resolves.toMatchObject({ token: TOKEN });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('treats a missing or unusable record as “nothing stored yet”', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(404, { message: 'Not Found' })));
    await expect(readTokenVaultFromGitHub({ owner: 'Petgabs', repo: 'HSC' })).resolves.toBeNull();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(200, {
      sha: 'vault-sha', content: base64Json(emptyTokenVault({ repository: 'Petgabs/HSC' }))
    })));
    await expect(readTokenVaultFromGitHub({ owner: 'Petgabs', repo: 'HSC' })).resolves.toBeNull();
  });

  it('blanks the stored record without deleting the published file', async () => {
    const vault = await makeVault();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(mockResponse(200, { sha: 'vault-sha', content: base64Json(vault) }))
      .mockResolvedValueOnce(mockResponse(200, { sha: 'vault-sha', content: base64Json(vault) }))
      .mockResolvedValueOnce(mockResponse(200, { commit: { html_url: 'https://github.com/Petgabs/HSC/commit/cleared' } }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await clearTokenVaultOnGitHub({ owner: 'Petgabs', repo: 'HSC', token: TOKEN });
    expect(result).toMatchObject({ cleared: true, missing: false });
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    const committed = JSON.parse(Buffer.from(JSON.parse(put[1].body).content, 'base64').toString('utf8'));
    expect(committed.token).toBeNull();
    expect(committed.slots).toEqual({});
    expect(isTokenVault(committed)).toBe(false);
  });
});
