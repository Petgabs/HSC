import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import sodium from 'libsodium-wrappers';

/**
 * The administrator problem this covers end to end:
 *
 *   "I save the access token on the school desktop, then open the website on
 *    my laptop and Publish says to connect a token again."
 *
 * Saving the token now also stores it — encrypted with the administrator's own
 * passwords — inside the website (`assets/data/publish-token.json`). These
 * tests boot the real page twice, with two separate browsers sharing only the
 * published website, and check the second one reconnects by itself.
 */

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const configSource = await readFile(new URL('../assets/js/config.js', import.meta.url), 'utf8');

const VAULT_PATH = 'assets/data/publish-token.json';
const TOKEN = 'github_pat_11TESTONLY_website_token_0123456789';
const ACCOUNT = { username: 'test-admin', password: 'desktop-pass-1', master: 'desktop-master-1' };
const ROTATED_MASTER = 'rotated-master-2';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const base64 = text => Buffer.from(text, 'utf8').toString('base64');
const unbase64 = value => Buffer.from(String(value || '').replace(/\s/g, ''), 'base64').toString('utf8');

function gateFor({ username, password, master }) {
  const salt = sha256(`salt:${password}`).slice(0, 32);
  const masterSalt = sha256(`master-salt:${master}`).slice(0, 32);
  return {
    admin: { username, salt, passwordHash: sha256(`${salt}:${password}`) },
    master: { salt: masterSalt, passwordHash: sha256(`${masterSalt}:${master}`) }
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/**
 * Open the website in a brand-new browser. `repository` is the shared state
 * standing in for GitHub and the deployed site: whatever one visit commits,
 * the next visit downloads.
 */
async function openPage({ credentials, repository, stored = {} }) {
  await sodium.ready;
  const keyPair = sodium.crypto_box_keypair();
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, {
    url: 'https://schoolcloud.example.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole
  });
  const { window } = dom;
  for (const [key, value] of Object.entries(stored)) window.localStorage.setItem(key, value);

  const fetchMock = vi.fn(async (input, init = {}) => {
    const url = String(input);
    if (url === 'https://api.github.com/repos/Petgabs/HSC') {
      const auth = init?.headers?.Authorization || '';
      if (auth !== `Bearer ${repository.liveToken}`) return jsonResponse({ message: 'Bad credentials' }, 401);
      return jsonResponse({ full_name: 'Petgabs/HSC', permissions: { push: true } });
    }
    // The website as GitHub Pages serves it.
    if (url.includes(`/${VAULT_PATH}`) && !url.includes('api.github.com')) {
      repository.siteReads += 1;
      return repository.deployedVault
        ? jsonResponse(repository.deployedVault)
        : jsonResponse({ message: 'Not Found' }, 404);
    }
    // The repository copy, which is authoritative the moment it is written.
    if (url.includes(`contents/${VAULT_PATH}`)) {
      if (init.method === 'PUT') {
        const body = JSON.parse(init.body);
        repository.vault = JSON.parse(unbase64(body.content));
        repository.vaultCommits.push(repository.vault);
        return jsonResponse({ content: { sha: 'vault-sha' }, commit: { html_url: 'https://github.com/Petgabs/HSC/commit/vault' } });
      }
      repository.apiReads += 1;
      return repository.vault
        ? jsonResponse({ sha: 'vault-sha', content: base64(JSON.stringify(repository.vault)) })
        : jsonResponse({ message: 'Not Found' }, 404);
    }
    if (url.includes('/contents/assets/js/config.js')) {
      if (init.method === 'PUT') {
        const body = JSON.parse(init.body);
        repository.config = unbase64(body.content);
        return jsonResponse({ commit: { html_url: 'https://github.com/Petgabs/HSC/commit/rotated' } });
      }
      return jsonResponse({ sha: 'config-sha-1', content: base64(repository.config) });
    }
    if (url.includes('/actions/secrets/public-key')) {
      return jsonResponse({ key_id: 'repository-key', key: Buffer.from(keyPair.publicKey).toString('base64') });
    }
    if (url.includes('/actions/secrets/SCHOOLCLOUD_PUBLISH_TOKEN')) {
      if (init.method === 'PUT') {
        repository.actionsSecretSaved = true;
        return jsonResponse({}, 201);
      }
      return repository.actionsSecretSaved
        ? jsonResponse({ name: 'SCHOOLCLOUD_PUBLISH_TOKEN', updated_at: '2026-10-06T00:00:00Z' })
        : jsonResponse({ message: 'Not Found' }, 404);
    }
    if (url.includes('apps.json')) return jsonResponse([]);
    if (url.includes('library.json')) return jsonResponse({});
    if (url.includes('/hit/') || url.includes('/get/')) return jsonResponse({ value: 1 });
    return jsonResponse([]);
  });

  for (const [key, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    MutationObserver: window.MutationObserver,
    Element: window.Element,
    ShadowRoot: window.ShadowRoot,
    CustomEvent: window.CustomEvent,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    Event: window.Event,
    getComputedStyle: window.getComputedStyle.bind(window),
    fetch: fetchMock,
    requestAnimationFrame: callback => window.setTimeout(callback, 0)
  })) vi.stubGlobal(key, value);
  window.fetch = fetchMock;
  window.confirm = () => true;
  window.console.warn = (...args) => errors.push(args.join(' '));
  window.console.error = (...args) => errors.push(args.join(' '));

  const visit = { window, errors, state: null };
  try {
    vi.resetModules();
    const config = await import('../assets/js/config.js');
    config.applyAdminGate(credentials.admin);
    config.applyMasterGate(credentials.master);
    await import('../assets/js/app.js');
    await new Promise(resolve => setTimeout(resolve, 150));
    visit.state = window.document.body._x_dataStack?.[0];
    return visit;
  } finally {
    if (!visit.state) await close(visit);
  }
}

async function close(visit) {
  if (visit.closed) return;
  visit.closed = true;
  await new Promise(resolve => setTimeout(resolve, 400));
  try {
    visit.window.Alpine?.destroyTree?.(visit.window.document.body);
    await new Promise(resolve => setTimeout(resolve, 100));
    visit.window.close();
  } catch { /* The window may already be gone. */ }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 200));

/** Alpine evaluates bindings even inside hidden panels, so a typo shows up here. */
function expectNoScriptErrors(visit) {
  expect(visit.errors.filter(message => /ReferenceError|TypeError|Alpine Expression Error/.test(message))).toEqual([]);
}

async function signIn(state, username, password) {
  state.loginForm.username = username;
  state.loginForm.password = password;
  await state.login();
  await state._websiteTokenPromise;
  await settle();
  return state.isAdmin;
}

async function unlockSettings(state, master) {
  state.openCloudSettings();
  state.adminAccount.masterPassword = master;
  await state.unlockAdminAccount();
  await state._websiteTokenPromise;
  await settle();
  return state.adminAccount.unlocked;
}

function freshRepository() {
  return {
    vault: null,
    deployedVault: null,
    vaultCommits: [],
    config: configSource,
    liveToken: TOKEN,
    actionsSecretSaved: false,
    siteReads: 0,
    apiReads: 0
  };
}

describe('the publishing token stored in the website', () => {
  it('is saved once on one computer and reconnects by itself on another', async () => {
    const credentials = gateFor(ACCOUNT);
    const repository = freshRepository();

    // --- the school desktop -------------------------------------------------
    let visit = await openPage({ credentials, repository });
    try {
      const state = visit.state;
      expect(await signIn(state, ACCOUNT.username, ACCOUNT.password)).toBe(true);
      expect(await unlockSettings(state, ACCOUNT.master)).toBe(true);
      expect(state.githubAuth.website.status).toBe('missing');

      state.githubAuth.token = TOKEN;
      await state.connectGithub();
      expect(state.githubAuth.connected).toBe(true);
      expect(state.githubAuth.website.saved).toBe(true);
      expect(state.githubAuth.website.slots).toEqual(['admin', 'master']);
      expect(state.websiteTokenStatusLabel).toBe('Stored in this website');

      // What the repository now carries is ciphertext, not a usable token.
      expect(repository.vault).toBeTruthy();
      const committed = JSON.stringify(repository.vault);
      expect(committed).not.toContain(TOKEN);
      expect(committed).not.toContain(ACCOUNT.password);
      expect(committed).not.toContain(ACCOUNT.master);
      expect(repository.vault.cipher).toBe('AES-GCM');
      expect(Object.keys(repository.vault.slots)).toEqual(['admin', 'master']);
      // The write-only Actions secret is still saved alongside it.
      expect(repository.actionsSecretSaved).toBe(true);
      expectNoScriptErrors(visit);
    } finally {
      await close(visit);
    }

    // GitHub Pages deploys the commit, so the website now serves the vault.
    repository.deployedVault = repository.vault;

    // --- a different laptop, nothing saved in this browser -------------------
    visit = await openPage({ credentials, repository });
    try {
      const state = visit.state;
      expect(state.githubAuth.activeToken).toBe('');
      expect(state.autoPublishReady).toBe(false);

      expect(await signIn(state, ACCOUNT.username, ACCOUNT.password)).toBe(true);

      // No pasting, no settings visit: signing in was enough.
      expect(state.githubAuth.activeToken).toBe(TOKEN);
      expect(state.githubAuth.connected).toBe(true);
      expect(state.autoPublishReady).toBe(true);
      expect(state.githubAuth.website.saved).toBe(true);
      expect(state.managementAlerts.some(alert => alert.id === 'github-token')).toBe(false);
      // The website copy was read from the deployed site, not the API.
      expect(repository.siteReads).toBeGreaterThan(0);
      // And the laptop now remembers it locally as well.
      expect(visit.window.localStorage.getItem('schoolcloud.github.token.v1')).toBe(TOKEN);
      expectNoScriptErrors(visit);
    } finally {
      await close(visit);
    }

    // --- a third computer that only ever opens Cloud Settings ----------------
    visit = await openPage({ credentials, repository });
    try {
      const state = visit.state;
      state.loginForm.username = ACCOUNT.username;
      state.loginForm.password = ACCOUNT.password;
      await state.login();
      state.githubAuth.activeToken = '';
      state.githubAuth.connected = false;
      expect(await unlockSettings(state, ACCOUNT.master)).toBe(true);
      expect(state.githubAuth.activeToken).toBe(TOKEN);
      expect(state.autoPublishReady).toBe(true);
      expectNoScriptErrors(visit);
    } finally {
      await close(visit);
    }
  }, 90_000);

  it('keeps working after a master-password rotation and explains a locked copy', async () => {
    const credentials = gateFor(ACCOUNT);
    const repository = freshRepository();

    let visit = await openPage({ credentials, repository });
    try {
      const state = visit.state;
      await signIn(state, ACCOUNT.username, ACCOUNT.password);
      await unlockSettings(state, ACCOUNT.master);
      state.githubAuth.token = TOKEN;
      await state.connectGithub();
      expect(state.githubAuth.website.saved).toBe(true);

      // Rotating the master password re-locks the stored copy automatically.
      state.adminAccount.form.username = ACCOUNT.username;
      state.adminAccount.form.masterPassword = ROTATED_MASTER;
      state.adminAccount.form.confirmMasterPassword = ROTATED_MASTER;
      await state.saveAdminAccount();
      expect(state.adminAccount.error).toBe('');
      expect(state.adminAccount.notice).toContain('re-locked');
      expect(repository.vaultCommits).toHaveLength(2);
      expect(JSON.stringify(repository.vault)).not.toContain(TOKEN);
    } finally {
      await close(visit);
    }

    repository.deployedVault = repository.vault;
    const rotated = gateFor({ ...ACCOUNT, master: ROTATED_MASTER });

    // The new master password opens the re-locked copy on another computer.
    visit = await openPage({ credentials: rotated, repository });
    try {
      const state = visit.state;
      state.loginForm.username = ACCOUNT.username;
      state.loginForm.password = ACCOUNT.password;
      await state.login();
      state.githubAuth.activeToken = '';
      state.githubAuth.connected = false;
      expect(await unlockSettings(state, ROTATED_MASTER)).toBe(true);
      expect(state.githubAuth.activeToken).toBe(TOKEN);
    } finally {
      await close(visit);
    }

    // A computer whose passwords no longer match is told what to do instead of
    // being left with a bare "connect a token" message.
    const stranger = gateFor({ username: ACCOUNT.username, password: 'other-pass-9', master: 'other-master-9' });
    visit = await openPage({ credentials: stranger, repository });
    try {
      const state = visit.state;
      expect(await signIn(state, ACCOUNT.username, 'other-pass-9')).toBe(true);
      expect(state.githubAuth.activeToken).toBe('');
      expect(state.githubAuth.website.status).toBe('locked');
      expect(state.tokenMissingMessage).toContain('Cloud Settings');
      await state.submitResource();
      expect(state.uploadMessage === '' || state.uploadMessage.includes('Cloud Settings')).toBe(true);
    } finally {
      await close(visit);
    }
  }, 90_000);

  it('can stop storing the token in the website', async () => {
    const credentials = gateFor(ACCOUNT);
    const repository = freshRepository();
    const visit = await openPage({ credentials, repository });
    try {
      const state = visit.state;
      await signIn(state, ACCOUNT.username, ACCOUNT.password);
      await unlockSettings(state, ACCOUNT.master);
      state.githubAuth.token = TOKEN;
      await state.connectGithub();
      expect(state.githubAuth.website.saved).toBe(true);

      await state.removeTokenFromWebsite();
      expect(state.githubAuth.website.saved).toBe(false);
      expect(state.githubAuth.website.status).toBe('missing');
      expect(repository.vault.token).toBeNull();
      expect(repository.vault.slots).toEqual({});
      // Removing the shared copy leaves this computer connected.
      expect(state.githubAuth.connected).toBe(true);
      expect(state.githubAuth.activeToken).toBe(TOKEN);
    } finally {
      await close(visit);
    }
  }, 60_000);
});
