import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';

/**
 * Page-level checks for the administrator safety features: the live
 * admin-online indicator, the repeated-click / rate-limit protection and the
 * pre-upload safety scan. Everything runs against the real index.html and the
 * real app.js with a stubbed network, so the wiring — not just the helpers — is
 * what is being tested.
 */

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

const sha256 = value => createHash('sha256').update(value).digest('hex');
const ORIGINAL = { username: 'test-admin', password: 'original-pass-1', master: 'original-master-1' };

function gateFor({ username, password, master }) {
  const salt = sha256(`salt:${password}`).slice(0, 32);
  const masterSalt = sha256(`master-salt:${master}`).slice(0, 32);
  return {
    admin: { username, salt, passwordHash: sha256(`${salt}:${password}`) },
    master: { salt: masterSalt, passwordHash: sha256(`${masterSalt}:${master}`) }
  };
}

const base64 = value => Buffer.from(value).toString('base64');
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json' }
});
const base64Json = value => base64(JSON.stringify(value));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function openPage({ credentials = null, presenceValue = 0 } = {}) {
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

  const repositoryCalls = [];
  let library = {};
  let storedFile = null;
  const fetchMock = vi.fn(async (input, init = {}) => {
    const url = String(input);
    const method = String(init.method || 'GET').toUpperCase();
    const isPresence = /admin-online-\d+/.test(url);
    if (url === 'https://api.github.com/repos/Petgabs/HSC') {
      return jsonResponse({ full_name: 'Petgabs/HSC', permissions: { push: true } });
    }
    if (url.includes('/hit/')) return jsonResponse({ value: isPresence ? 1 : 41 });
    if (url.includes('/get/')) return jsonResponse({ value: isPresence ? presenceValue : 41 });
    if (url.includes('/contents/')) {
      repositoryCalls.push({ url, method, body: init.body || '' });
      if (url.includes('/contents/library.json')) {
        if (method === 'PUT') {
          library = JSON.parse(Buffer.from(JSON.parse(init.body).content, 'base64').toString('utf8'));
          return jsonResponse({ commit: { html_url: 'https://github.com/Petgabs/HSC/commit/library' } });
        }
        return jsonResponse({ sha: 'library-sha', content: base64Json(library) });
      }
      if (url.includes('/contents/apps/')) {
        if (method === 'PUT') {
          storedFile = { bytes: Buffer.from(JSON.parse(init.body).content, 'base64') };
          return jsonResponse({ content: { name: 'Notes.pdf', download_url: 'apps/Notes.pdf' }, commit: { html_url: '.../commit/file' } });
        }
        if (!storedFile) return jsonResponse({ message: 'Not Found' }, 404);
        return jsonResponse({ sha: 'blob-sha', content: storedFile.bytes.toString('base64') });
      }
    }
    if (url.includes('apps.json')) return jsonResponse([]);
    if (url.includes('library.json')) return jsonResponse(library);
    return jsonResponse({});
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

  let state = null;
  try {
    if (credentials) {
      const config = await import('../assets/js/config.js');
      config.applyAdminGate(credentials.admin);
      config.applyMasterGate(credentials.master);
    }
    await import('../assets/js/app.js');
    await new Promise(resolve => setTimeout(resolve, 150));
    state = window.document.body._x_dataStack?.[0];
  } finally {
    if (!state) window.close();
  }
  return { window, state, errors, fetchMock, repositoryCalls };
}

async function close(visit) {
  await new Promise(resolve => setTimeout(resolve, 300));
  try {
    visit.window.Alpine?.destroyTree?.(visit.window.document.body);
    visit.window.close();
  } catch { /* The window may already be gone. */ }
  vi.unstubAllGlobals();
  vi.resetModules();
}

function fillDraft(state, file) {
  state.isAdmin = true;
  state.githubAuth.connected = true;
  state.githubAuth.activeToken = 'test-token';
  state.draft.title = 'Year 12 Practice';
  state.draft.subject = 'Mathematics';
  state.draft.years = '12';
  state.draft.owner = 'Mathematics faculty';
  state.setDraftFile(file);
}

describe('live admin-online indicator', () => {
  it('lights up for a visitor when a heartbeat landed in a recent bucket', async () => {
    const visit = await openPage({ presenceValue: 1 });
    try {
      expect(visit.state.presence.label).toBe('Admin online');
      expect(visit.state.adminPresenceLive).toBe(true);
      const reads = visit.fetchMock.mock.calls.map(([url]) => String(url)).filter(url => url.includes('admin-online-'));
      expect(reads.length).toBeGreaterThan(0);
      expect(reads[0]).toMatch(/\/get\/petgabs-hsc-schoolcloud\/admin-online-\d+$/);
      // Nothing about the administrator is ever transmitted.
      expect(reads.join(' ')).not.toContain(ORIGINAL.username);
      // The real page boots without Alpine or runtime errors.
      expect(visit.errors.filter(message => /ReferenceError|TypeError|Alpine Expression Error/.test(message))).toEqual([]);
    } finally {
      await close(visit);
    }
  });

  it('stays offline when no recent bucket has been hit', async () => {
    const visit = await openPage({ presenceValue: 0 });
    try {
      expect(visit.state.adminPresenceLive).toBe(false);
      expect(visit.state.presence.label).toBe('No admin online');
      expect(visit.state.presence.detail).toContain('No administrator heartbeat');
    } finally {
      await close(visit);
    }
  });

  it('publishes a heartbeat the moment the administrator signs in', async () => {
    const visit = await openPage({ credentials: gateFor(ORIGINAL) });
    try {
      const state = visit.state;
      state.loginForm.username = ORIGINAL.username;
      state.loginForm.password = ORIGINAL.password;
      await state.login();
      await new Promise(resolve => setTimeout(resolve, 60));

      const hits = visit.fetchMock.mock.calls.map(([url]) => String(url))
        .filter(url => url.includes('/hit/') && url.includes('admin-online-'));
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatch(/\/hit\/petgabs-hsc-schoolcloud\/admin-online-\d+$/);
      expect(state.isAdmin).toBe(true);
      expect(state.adminPresenceLive).toBe(true);
      expect(state.presence.source).toBe('local');
      // Signing out stops the heartbeat but leaves the last-seen mark to expire.
      state.logout();
      expect(state.isAdmin).toBe(false);
      expect(state.presence.lastSeenAt).toBeGreaterThan(0);
    } finally {
      await close(visit);
    }
  });
});

describe('repeated-click and rate-limit protection', () => {
  it('pauses repeated administrator actions and shows a countdown', async () => {
    const visit = await openPage({ credentials: gateFor(ORIGINAL) });
    try {
      const state = visit.state;
      state.isAdmin = true;
      const results = [];
      for (let index = 0; index < 6; index += 1) results.push(state.guardAction('login'));
      expect(results.slice(0, 5).every(Boolean)).toBe(true);
      expect(results[5]).toBe(false);
      expect(state.rateLimit.message).toContain('Too many sign-in attempts');

      // A further click reports the remaining cooldown instead.
      expect(state.guardAction('login')).toBe(false);
      expect(state.rateLimit.message).toContain('Please wait');
      expect(state.blockedSeconds('login')).toBeGreaterThan(0);
      expect(state.blockedButtonLabel('login', 'Sign In')).toMatch(/^Please wait \d+s$/);
      expect(state.actionBlocked('login')).toBe(true);

      // The same guard covers uploading: the button counts down instead of
      // firing another publish.
      for (let index = 0; index < 9; index += 1) state.guardAction('upload');
      expect(state.actionBlocked('upload')).toBe(true);
      expect(state.blockedSeconds('upload')).toBeGreaterThan(0);
    } finally {
      await close(visit);
    }
  });

  it('slows a wrong password without blocking the correct one', async () => {
    const visit = await openPage({ credentials: gateFor(ORIGINAL) });
    try {
      const state = visit.state;
      state.loginForm.username = ORIGINAL.username;
      state.loginForm.password = 'definitely-wrong';
      await state.login();
      expect(state.loginError).toContain('incorrect');
      expect(state.isAdmin).toBe(false);
      expect(state.blockedSeconds('login')).toBe(0);

      state.loginForm.password = ORIGINAL.password;
      await state.login();
      expect(state.isAdmin).toBe(true);
      expect(state.loginError).toBe('');
    } finally {
      await close(visit);
    }
  });

  it('keeps the sign-in lockout in force after a reload', async () => {
    const { RATE_LIMIT_STORAGE_KEY } = await import('../assets/js/lib/guard.js');
    const visit = await openPage({ credentials: gateFor(ORIGINAL) });
    try {
      const state = visit.state;
      state.isAdmin = true;
      for (let index = 0; index < 6; index += 1) state.guardAction('login');
      expect(state.blockedSeconds('login')).toBeGreaterThan(0);

      const stored = JSON.parse(visit.window.localStorage.getItem(RATE_LIMIT_STORAGE_KEY) || '{}');
      expect(Object.keys(stored.blockedUntil || {})).toContain('login');
      const until = Number(stored.blockedUntil.login);
      expect(until).toBeGreaterThan(Date.now());
    } finally {
      await close(visit);
    }
  });
});

describe('upload safety before anything is sent to GitHub', () => {
  it('refuses a renamed file and never touches the repository', async () => {
    const visit = await openPage({ credentials: gateFor(ORIGINAL) });
    try {
      const state = visit.state;
      const htmlBytes = new TextEncoder().encode('<!doctype html><html><body>not a pdf</body></html>');
      fillDraft(state, { name: 'Pretend.pdf', size: htmlBytes.length, arrayBuffer: async () => htmlBytes.buffer });
      await new Promise(resolve => setTimeout(resolve, 60));

      expect(state.draftErrors.file).toContain('not PDF');
      expect(state.uploadChecks.some(check => check.status === 'block')).toBe(true);

      await state.submitResource();
      expect(visit.repositoryCalls).toEqual([]);
      expect(state.submitting).toBe(false);
      expect(state.uploadMessage).toContain('safety checks');
    } finally {
      await close(visit);
    }
  });

  it('uploads once, then verifies the published bytes and records the fingerprint', async () => {
    const visit = await openPage({ credentials: gateFor(ORIGINAL) });
    try {
      const state = visit.state;
      const pdfBytes = new TextEncoder().encode('%PDF-1.4\n% verified content\n');
      const digest = sha256(Buffer.from(pdfBytes));
      fillDraft(state, { name: 'Notes.pdf', size: pdfBytes.length, arrayBuffer: async () => pdfBytes.buffer });
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(state.uploadChecks.length).toBeGreaterThan(0);
      expect(state.draftErrors.file).toBe('');

      // Two clicks in the same tick: the second must not start a second upload.
      const first = state.submitResource();
      const second = state.submitResource();
      await Promise.all([first, second]);

      const filePuts = visit.repositoryCalls.filter(call => call.method === 'PUT' && call.url.includes('/contents/apps/'));
      expect(filePuts).toHaveLength(1);
      expect(state.uploadResult).toMatchObject({ verified: true, metadataVerified: true, sha256: digest });
      expect(state.uploadResult.bytes).toBe(pdfBytes.length);
      // The metadata committed to library.json carries the fingerprint.
      const metadataPut = visit.repositoryCalls.find(call => call.method === 'PUT' && call.url.includes('/contents/library.json'));
      expect(metadataPut).toBeTruthy();
      const committed = JSON.parse(Buffer.from(JSON.parse(metadataPut.body).content, 'base64').toString('utf8'));
      expect(committed['apps/Notes.pdf']).toMatchObject({
        title: 'Year 12 Practice', subject: 'Mathematics', sha256: digest, bytes: pdfBytes.length
      });
      expect(state.draftFile).toBe(null);
    } finally {
      await close(visit);
    }
  });

  it('warns about behaviour the site policy will not run and requires acknowledgement', async () => {
    const visit = await openPage({ credentials: gateFor(ORIGINAL) });
    try {
      const state = visit.state;
      const htmlBytes = new TextEncoder().encode('<html><body><script src="https://cdn.example.com/x.js"></script></body></html>');
      fillDraft(state, { name: 'Chart app.html', size: htmlBytes.length, arrayBuffer: async () => htmlBytes.buffer });
      await new Promise(resolve => setTimeout(resolve, 60));

      expect(state.draftErrors.file).toBe('');
      expect(state.uploadWarnings.length).toBeGreaterThan(0);
      expect(state.uploadNeedsAcknowledgement).toBe(true);

      await state.submitResource();
      expect(state.uploadMessage).toContain('acknowledgement');
      expect(visit.repositoryCalls).toEqual([]);

      state.uploadAcknowledgedWarnings = true;
      expect(state.uploadNeedsAcknowledgement).toBe(false);
    } finally {
      await close(visit);
    }
  });
});
