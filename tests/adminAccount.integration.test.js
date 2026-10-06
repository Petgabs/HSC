import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';

/**
 * End-to-end checks for the Administrator account section of Cloud Settings.
 *
 * Real credentials are never used here — and never stored in the repository.
 * Each run mints throwaway salts and digests and pushes them into the config
 * module before the page boots, which is exactly what a rotation does.
 */

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const configSource = await readFile(new URL('../assets/js/config.js', import.meta.url), 'utf8');

const CREDENTIALS_KEY = 'schoolcloud.admin.credentials.v1';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const digestFor = (salt, password) => sha256(`${salt}:${password}`);

const ORIGINAL = { username: 'test-admin', password: 'original-pass-1', master: 'original-master-1' };
const ROTATED = { username: 'test-admin', password: 'rotated-pass-2', master: 'rotated-master-2' };

function gateFor({ username, password, master }) {
  const salt = sha256(`salt:${password}`).slice(0, 32);
  const masterSalt = sha256(`master-salt:${master}`).slice(0, 32);
  return {
    admin: { username, salt, passwordHash: digestFor(salt, password) },
    master: { salt: masterSalt, passwordHash: digestFor(masterSalt, master) }
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

const base64 = text => Buffer.from(text, 'utf8').toString('base64');
const unbase64 = value => Buffer.from(String(value || '').replace(/\s/g, ''), 'base64').toString('utf8');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/**
 * Boot the real page against a stubbed network. `credentials`, when given, are
 * pushed into the config module first — the module instance is shared with
 * app.js, so this is what the deployed config.js would contain on that visit.
 */
async function openPage({ credentials = null, stored = {}, configFile = configSource, commits = [] } = {}) {
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
      return jsonResponse({ full_name: 'Petgabs/HSC', permissions: { push: true } });
    }
    if (url.includes('apps.json')) return jsonResponse([]);
    if (url.includes('library.json')) return jsonResponse({});
    if (url.includes('/contents/assets/js/config.js')) {
      if (init.method === 'PUT') {
        const body = JSON.parse(init.body);
        commits.push({ sha: body.sha, content: unbase64(body.content) });
        return jsonResponse({ commit: { html_url: 'https://github.com/Petgabs/HSC/commit/rotated' } });
      }
      return jsonResponse({ sha: 'config-sha-1', content: base64(configFile) });
    }
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
  window.console.warn = (...args) => errors.push(args.join(' '));
  window.console.error = (...args) => errors.push(args.join(' '));

  const result = { window, commits, errors, state: null };
  try {
    vi.resetModules();
    if (credentials) {
      const config = await import('../assets/js/config.js');
      config.applyAdminGate(credentials.admin);
      config.applyMasterGate(credentials.master);
    }
    await import('../assets/js/app.js');
    await new Promise(resolve => setTimeout(resolve, 150));
    result.state = window.document.body._x_dataStack?.[0];
    return result;
  } finally {
    if (!result.state) await close(result);
  }
}

/** Tear a visit down the way the page would unload, settling Alpine first. */
async function close(visit) {
  if (visit.closed) return;
  visit.closed = true;
  // Alpine cancels in-flight x-transition promises when the tree changes; let
  // them settle before the window goes away so nothing is left unresolved.
  await new Promise(resolve => setTimeout(resolve, 400));
  try {
    visit.window.Alpine?.destroyTree?.(visit.window.document.body);
    await new Promise(resolve => setTimeout(resolve, 100));
    visit.window.close();
  } catch { /* The window may already be gone. */ }
}

// View changes animate with Alpine's x-transition; give the previous
// transition time to finish so the next one is not cancelled mid-flight.
const settle = () => new Promise(resolve => setTimeout(resolve, 200));

async function signIn(state, username, password) {
  state.loginForm.username = username;
  state.loginForm.password = password;
  await state.login();
  await settle();
  return state.isAdmin;
}

describe('administrator account section', () => {
  it('requires the master password for Cloud Settings and locks again on exit or reopen', async () => {
    const visit = await openPage({ credentials: gateFor(ORIGINAL) });
    try {
      const state = visit.state;
      expect(await signIn(state, ORIGINAL.username, ORIGINAL.password)).toBe(true);
      expect(state.adminAccount.unlocked).toBe(false);

      const settingsButton = visit.window.document.querySelector('button[aria-label="Settings"]');
      expect(settingsButton).toBeTruthy();
      settingsButton.click();
      await settle();
      expect(state.currentView).toBe('settings');
      expect(state.adminAccount.unlocked).toBe(false);
      const gate = visit.window.document.getElementById('cloud-settings-password-gate');
      const settingsContent = visit.window.document.getElementById('github-repository')?.closest('[x-show="adminAccount.unlocked"]');
      expect(gate).toBeTruthy();
      expect(settingsContent?.style.display).toBe('none');

      state.adminAccount.masterPassword = 'wrong-master-password';
      await state.unlockAdminAccount();
      expect(state.adminAccount.unlocked).toBe(false);
      expect(state.adminAccount.error).toContain('incorrect');

      state.adminAccount.masterPassword = ORIGINAL.master;
      await state.unlockAdminAccount();
      expect(state.adminAccount.unlocked).toBe(true);
      await settle();
      expect(settingsContent?.style.display).not.toBe('none');

      // The header settings icon starts a fresh locked settings visit even if
      // settings were already open.
      settingsButton.click();
      await settle();
      expect(state.adminAccount.unlocked).toBe(false);
      expect(settingsContent?.style.display).toBe('none');

      // Leaving the page locks it too; dashboard and quick-action navigation
      // must both go through the same password gate when settings are reopened.
      state.openDashboard();
      await settle();
      expect(state.adminAccount.unlocked).toBe(false);
      state.openAdminWorkspace('settings');
      await settle();
      expect(state.currentView).toBe('settings');
      expect(state.adminAccount.unlocked).toBe(false);
    } finally {
      await close(visit);
    }
  }, 30_000);

  it('stays locked until the master password is accepted, then commits a rotation', async () => {
    const original = gateFor(ORIGINAL);
    let storedOverride = null;
    let writtenConfig = configSource;

    // Signed in as the administrator on a deployment that still ships the
    // original credentials.
    let visit = await openPage({ credentials: original });
    try {
      const state = visit.state;
      expect(state).toBeTruthy();
      expect(await signIn(state, ORIGINAL.username, ORIGINAL.password)).toBe(true);

      // Nothing about the account is reachable without the master password.
      expect(state.adminAccount.unlocked).toBe(false);
      state.adminAccount.masterPassword = 'not-the-master-password';
      await state.unlockAdminAccount();
      expect(state.adminAccount.unlocked).toBe(false);
      expect(state.adminAccount.error).toContain('incorrect');

      // The master password opens it and prefills the current username.
      state.adminAccount.masterPassword = ORIGINAL.master;
      await state.unlockAdminAccount();
      expect(state.adminAccount.unlocked).toBe(true);
      expect(state.adminAccount.error).toBe('');
      expect(state.adminAccount.form.username).toBe(ORIGINAL.username);

      // Short and mismatched passwords are refused before anything is sent.
      state.adminAccount.form.password = 'short';
      state.adminAccount.form.confirmPassword = 'short';
      await state.saveAdminAccount();
      expect(state.adminAccount.error).toContain('at least 8');
      state.adminAccount.form.password = 'long-enough-pass';
      state.adminAccount.form.confirmPassword = 'long-enough-typo';
      await state.saveAdminAccount();
      expect(state.adminAccount.error).toContain('do not match');
      expect(visit.commits).toHaveLength(0);

      // Without a connected token the credentials cannot be committed.
      state.adminAccount.form.password = ROTATED.password;
      state.adminAccount.form.confirmPassword = ROTATED.password;
      await state.saveAdminAccount();
      expect(state.adminAccount.error).toContain('Connect a GitHub token');
      expect(visit.commits).toHaveLength(0);

      // Rotating both passwords commits the new digests to config.js.
      state.githubAuth.connected = true;
      state.githubAuth.activeToken = 'admin-token-for-test';
      state.adminAccount.form.masterPassword = ROTATED.master;
      state.adminAccount.form.confirmMasterPassword = ROTATED.master;
      await state.saveAdminAccount();

      expect(visit.commits).toHaveLength(1);
      expect(visit.commits[0].sha).toBe('config-sha-1');
      const written = visit.commits[0].content;
      expect(written).not.toContain(ROTATED.password);
      expect(written).not.toContain(ROTATED.master);
      expect(written).not.toMatch(/\bpassword\s*:\s*'/i);
      expect(written.split('\n')).toHaveLength(configSource.split('\n').length);
      expect(state.adminAccount.notice).toContain('committed');
      expect(state.adminAccount.noticeUrl).toContain('/commit/rotated');
      writtenConfig = written;

      // The new credential works immediately.
      expect(await signIn(state, ROTATED.username, ROTATED.password)).toBe(true);

      // The rotated master password opens the section.
      state.adminAccount.masterPassword = ROTATED.master;
      await state.unlockAdminAccount();
      expect(state.adminAccount.unlocked).toBe(true);

      // Signing out leaves nothing unlocked behind.
      state.logout();
      await settle();
      expect(state.adminAccount.unlocked).toBe(false);
      expect(state.adminAccount.form.password).toBe('');

      storedOverride = visit.window.localStorage.getItem(CREDENTIALS_KEY);
      expect(storedOverride).toBeTruthy();
      expect(storedOverride).not.toContain(ROTATED.password);
    } finally {
      await close(visit);
    }

    // While GitHub Pages still serves the old config.js, this device keeps
    // using the credential it rotated — and the replaced one stops working.
    visit = await openPage({
      credentials: original,
      stored: { [CREDENTIALS_KEY]: storedOverride }
    });
    try {
      expect(await signIn(visit.state, ORIGINAL.username, ORIGINAL.password)).toBe(false);
      expect(await signIn(visit.state, ROTATED.username, ROTATED.password)).toBe(true);
      visit.state.adminAccount.masterPassword = ROTATED.master;
      await visit.state.unlockAdminAccount();
      expect(visit.state.adminAccount.unlocked).toBe(true);
      expect(visit.window.localStorage.getItem(CREDENTIALS_KEY)).toBeTruthy();
    } finally {
      await close(visit);
    }

    // Once the deployment lands, the shipped config.js wins again and the
    // device copy is discarded.
    visit = await openPage({
      credentials: gateFor(ROTATED),
      stored: { [CREDENTIALS_KEY]: storedOverride },
      configFile: writtenConfig
    });
    try {
      expect(visit.window.localStorage.getItem(CREDENTIALS_KEY)).toBeNull();
      expect(await signIn(visit.state, ROTATED.username, ROTATED.password)).toBe(true);
      visit.state.adminAccount.masterPassword = ROTATED.master;
      await visit.state.unlockAdminAccount();
      expect(visit.state.adminAccount.unlocked).toBe(true);
    } finally {
      await close(visit);
    }
  }, 60_000);

  it('never opens the section for a visitor who is not signed in', async () => {
    const visit = await openPage({ credentials: gateFor(ORIGINAL) });
    try {
      const state = visit.state;
      expect(state.isAdmin).toBe(false);
      // The master password alone must not open the section.
      state.adminAccount.masterPassword = ORIGINAL.master;
      await state.unlockAdminAccount();
      expect(state.adminAccount.unlocked).toBe(false);
      expect(state.adminAccount.error).toContain('not signed in');
    } finally {
      await close(visit);
    }
  }, 30_000);
});
