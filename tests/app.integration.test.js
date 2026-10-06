import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import sodium from 'libsodium-wrappers';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('School Cloud page integration', () => {
  it('boots Alpine, loads public files and reads visitor/file counts from Abacus', async () => {
    await sodium.ready;
    const publisherKeyPair = sodium.crypto_box_keypair();
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
    window.localStorage.setItem('githubToken', 'stale-token-for-test-only');
    window.sessionStorage.setItem('schoolcloud.githubToken', 'stale-token-for-test-only');
    const manifest = [
      { type: 'file', name: 'Year 12 algebra.html', path: 'apps/Year 12 algebra.html', download_url: 'https://raw.githubusercontent.com/Petgabs/HSC/main/apps/Year%2012%20algebra.html' },
      { type: 'file', name: 'HSC revision.pdf', path: 'apps/HSC revision.pdf', download_url: 'https://raw.githubusercontent.com/Petgabs/HSC/main/apps/HSC%20revision.pdf' }
    ];
    const library = {
      'apps/Year 12 algebra.html': { title: 'Interactive Algebra', subject: 'Mathematics', years: [12], tags: ['practice'] },
      'apps/HSC revision.pdf': { title: 'HSC Revision Notes', subject: 'Mathematics', years: [12] }
    };
    let savedStatsRecord = null;
    let savedPublisherSecret = false;
    let publisherSecretPutCount = 0;
    const fetchMock = vi.fn(async (input, init = {}) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/Petgabs/HSC') {
        return jsonResponse({ full_name: 'Petgabs/HSC', permissions: { push: true } });
      }
      if (url.includes('/actions/secrets/public-key')) {
        return jsonResponse({ key_id: 'test-repository-key', key: btoa(String.fromCharCode(...publisherKeyPair.publicKey)) });
      }
      if (url.includes('/actions/secrets/SCHOOLCLOUD_PUBLISH_TOKEN')) {
        if (init.method === 'PUT') {
          savedPublisherSecret = true;
          publisherSecretPutCount += 1;
          return jsonResponse({}, 201);
        }
        return savedPublisherSecret
          ? jsonResponse({ name: 'SCHOOLCLOUD_PUBLISH_TOKEN', updated_at: '2026-10-06T00:00:00Z' })
          : jsonResponse({ message: 'Not Found' }, 404);
      }
      if (url.includes('apps.json')) return jsonResponse(manifest);
      if (url.includes('library.json')) return jsonResponse(library);
      if (url.includes('/contents/stats/downloads.json')) {
        if (init.method === 'PUT') {
          const body = JSON.parse(init.body);
          savedStatsRecord = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body.content), char => char.charCodeAt(0))));
          return jsonResponse({ commit: { html_url: 'https://github.com/Petgabs/HSC/commit/stats' } }, 201);
        }
        return jsonResponse({ message: 'Not Found' }, 404);
      }
      if (url.includes('/hit/')) return jsonResponse({ value: url.includes('download-') ? 8 : 41 });
      if (url.includes('/get/')) return jsonResponse({ value: url.includes('download-') ? 7 : 41 });
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

    try {
      await import('../assets/js/app.js');
      await new Promise(resolve => setTimeout(resolve, 150));
      const state = window.document.body._x_dataStack?.[0];
      expect(window.Alpine?.version).toBeTruthy();
      expect(state).toBeTruthy();
      expect(state.apps).toHaveLength(2);
      expect(state.miniApps).toHaveLength(1);
      expect(state.resources).toHaveLength(1);
      expect(state.stats.visitors).toBe(41);
      expect(state.downloadsOf(state.apps[0])).toBe(7);
      expect(state.stats.backend).toBe('abacus');
      expect(state.loginMode).toBe('admin');
      expect(state.githubAuth.activeToken).toBe('');
      expect(window.localStorage.getItem('githubToken')).toBeNull();
      expect(window.sessionStorage.getItem('schoolcloud.githubToken')).toBeNull();
      expect(errors.filter(message => /ReferenceError|TypeError|Alpine Expression Error/.test(message))).toEqual([]);
      const visitorHits = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/hit/petgabs-hsc-schoolcloud/visitors'));
      const visitorReads = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/get/petgabs-hsc-schoolcloud/visitors'));
      const fileReads = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/get/') && String(url).includes('download-'));
      expect(visitorHits()).toHaveLength(1);
      expect(fileReads()).toHaveLength(2);

      // Re-reading the page's visitor statistic must use Abacus GET, not a hit.
      await state.countVisitor();
      expect(visitorHits()).toHaveLength(1);
      expect(visitorReads()).toHaveLength(1);
      expect(state.stats.visitors).toBe(41);

      // An immediate GitHub save refreshes the visitor total as well as file counts.
      state.isAdmin = true;
      state.githubAuth.connected = true;
      state.githubAuth.activeToken = 'admin-token-for-test';
      await state.syncDownloadStatsToGitHub();
      expect(visitorReads()).toHaveLength(2);
      expect(savedStatsRecord.visitors).toBe(41);
      expect(savedStatsRecord.files['apps/Year 12 algebra.html'].downloads).toBe(7);

      // The dashboard saves a new PAT once, encrypts it for GitHub, and guards
      // against duplicate clicks. A later save check leaves the existing
      // Actions secret untouched.
      state.githubAuth.connected = false;
      state.githubAuth.activeToken = '';
      state.githubAuth.token = 'one-time-admin-token';
      await Promise.all([state.connectGithub(), state.connectGithub()]);
      expect(state.githubAuth.connected).toBe(true);
      expect(state.githubAuth.cloudSecretSaved).toBe(true);
      expect(state.githubAuth.activeToken).toBe('one-time-admin-token');
      expect(state.githubAuth.token).toBe('');
      expect(window.localStorage.getItem('githubToken')).toBeNull();
      expect(window.sessionStorage.getItem('schoolcloud.githubToken')).toBeNull();
      // The verified token is remembered on this device so the administrator
      // only ever pastes it once.
      expect(window.localStorage.getItem('schoolcloud.github.token.v1')).toBe('one-time-admin-token');
      expect(state.githubAuth.remembered).toBe(true);
      expect(publisherSecretPutCount).toBe(1);
      const savedSecretCall = fetchMock.mock.calls.find(([url, init]) =>
        String(url).includes('/actions/secrets/SCHOOLCLOUD_PUBLISH_TOKEN') && init?.method === 'PUT');
      const savedSecretBody = JSON.parse(savedSecretCall[1].body);
      expect(savedSecretBody).not.toHaveProperty('token');
      expect(savedSecretBody.encrypted_value).not.toBe('one-time-admin-token');

      await state.saveGithubSecret();
      expect(publisherSecretPutCount).toBe(1);
    } finally {
      // Allow Alpine's x-transition cleanup timers to settle before JSDOM tears
      // down the globals used by its MutationObserver callbacks.
      await new Promise(resolve => setTimeout(resolve, 200));
      window.Alpine?.destroyTree?.(window.document.body);
      window.close();
    }
  });

  it('remembers the verified token on the device across reloads and sign-out', async () => {
    const savedToken = 'remembered-admin-token';
    const dom = new JSDOM(html, {
      url: 'https://schoolcloud.example.test/',
      runScripts: 'outside-only',
      pretendToBeVisual: true
    });
    const { window } = dom;
    window.HTMLAnchorElement.prototype.click = vi.fn();
    // A previous session saved the token; the old per-tab keys are stale.
    window.localStorage.setItem('schoolcloud.github.token.v1', savedToken);
    window.localStorage.setItem('githubToken', 'stale-token-for-test-only');
    window.sessionStorage.setItem('schoolcloud.githubToken', 'stale-token-for-test-only');

    let repoStatus = 200;
    const fetchMock = vi.fn(async input => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/Petgabs/HSC') {
        if (repoStatus !== 200) return jsonResponse({ message: 'Bad credentials' }, repoStatus);
        return jsonResponse({ full_name: 'Petgabs/HSC', permissions: { push: true } });
      }
      if (url.includes('apps.json')) return jsonResponse([]);
      if (url.includes('library.json')) return jsonResponse({});
      if (url.includes('/hit/')) return jsonResponse({ value: 1 });
      if (url.includes('/get/')) return jsonResponse({ value: 1 });
      return jsonResponse([]);
    });
    for (const [key, value] of Object.entries({
      window,
      document: window.document,
      navigator: window.navigator,
      location: window.location,
      localStorage: window.localStorage,
      sessionStorage: window.sessionStorage,
      MutationObserver: window.MutationObserver,
      Element: window.Element,
      ShadowRoot: window.ShadowRoot,
      CustomEvent: window.CustomEvent,
      HTMLElement: window.HTMLElement,
      Node: window.Node,
      Event: window.Event,
      URL: window.URL,
      getComputedStyle: window.getComputedStyle.bind(window),
      fetch: fetchMock,
      requestAnimationFrame: callback => window.setTimeout(callback, 0)
    })) vi.stubGlobal(key, value);
    window.fetch = fetchMock;

    try {
      await import('../assets/js/app.js');
      await new Promise(resolve => setTimeout(resolve, 150));
      const state = window.document.body._x_dataStack?.[0];
      const repoCalls = () => fetchMock.mock.calls.filter(([url]) => String(url) === 'https://api.github.com/repos/Petgabs/HSC');

      // Boot restores the saved token without needing the sign-in form, and
      // the stale per-tab keys stay purged.
      expect(state).toBeTruthy();
      expect(window.localStorage.getItem('githubToken')).toBeNull();
      expect(window.sessionStorage.getItem('schoolcloud.githubToken')).toBeNull();
      expect(window.localStorage.getItem('schoolcloud.github.token.v1')).toBe(savedToken);
      expect(state.githubAuth.activeToken).toBe(savedToken);
      expect(state.githubAuth.connected).toBe(true);
      expect(state.githubAuth.remembered).toBe(true);
      // A public visitor never sends the remembered token to GitHub.
      expect(repoCalls()).toHaveLength(0);

      // The next administrator sign-in silently re-checks the saved token.
      state.isAdmin = true;
      await state.verifySavedGithubToken();
      expect(repoCalls()).toHaveLength(1);
      expect(state.githubAuth.connected).toBe(true);
      expect(state.githubAuth.error).toBe('');

      // Signing out ends the session but keeps the token saved on the device.
      state.logout();
      expect(state.githubAuth.activeToken).toBe('');
      expect(state.githubAuth.connected).toBe(false);
      expect(state.githubAuth.remembered).toBe(true);
      expect(window.localStorage.getItem('schoolcloud.github.token.v1')).toBe(savedToken);
      expect(state.isAdmin).toBe(false);

      // Signing back in reconnects automatically, with no pasting.
      state.isAdmin = true;
      expect(state.restoreSavedGithubToken()).toBe(true);
      expect(state.githubAuth.activeToken).toBe(savedToken);
      expect(state.githubAuth.connected).toBe(true);

      // A network or rate-limit failure must not discard the saved token.
      repoStatus = 503;
      await state.verifySavedGithubToken();
      expect(window.localStorage.getItem('schoolcloud.github.token.v1')).toBe(savedToken);
      expect(state.githubAuth.remembered).toBe(true);
      expect(state.githubAuth.error).not.toBe('');

      // A credential GitHub rejects is forgotten so a replacement is requested.
      repoStatus = 401;
      await state.verifySavedGithubToken();
      expect(window.localStorage.getItem('schoolcloud.github.token.v1')).toBeNull();
      expect(state.githubAuth.activeToken).toBe('');
      expect(state.githubAuth.connected).toBe(false);
      expect(state.githubAuth.remembered).toBe(false);
      expect(state.githubAuth.error).toContain('replacement token');

      // Re-saving and choosing "Forget token on this device" clears storage.
      state.rememberGithubToken(savedToken);
      expect(window.localStorage.getItem('schoolcloud.github.token.v1')).toBe(savedToken);
      state.disconnectGithub();
      expect(window.localStorage.getItem('schoolcloud.github.token.v1')).toBeNull();
      expect(state.githubAuth.remembered).toBe(false);
    } finally {
      await new Promise(resolve => setTimeout(resolve, 200));
      window.Alpine?.destroyTree?.(window.document.body);
      window.close();
    }
  });

  it('keeps the last saved library copy open when the live refresh fails', async () => {
    const dom = new JSDOM(html, {
      url: 'https://schoolcloud.example.test/',
      runScripts: 'outside-only',
      pretendToBeVisual: true
    });
    const { window } = dom;
    window.localStorage.setItem('schoolcloud.library.snapshot.v1', JSON.stringify({
      version: 1,
      savedAt: '2026-10-06T06:00:00.000Z',
      manifest: [
        { type: 'file', name: 'Cached Notes.pdf', path: 'apps/Cached Notes.pdf', download_url: 'apps/Cached%20Notes.pdf' }
      ],
      library: {
        'apps/Cached Notes.pdf': { title: 'Cached Notes', subject: 'Mathematics', years: [12] }
      },
      stats: {
        namespace: 'petgabs-hsc-schoolcloud',
        updatedAt: '2026-10-06T05:59:00.000Z',
        visitors: 22,
        files: { 'apps/Cached Notes.pdf': { downloads: 5, key: 'download-deadbeef' } }
      }
    }));
    const fetchMock = vi.fn(async input => {
      const url = String(input);
      if (url.includes('/hit/') || url.includes('/get/')) return jsonResponse({ value: 22 });
      throw new TypeError('Failed to fetch');
    });
    for (const [key, value] of Object.entries({
      window,
      document: window.document,
      navigator: window.navigator,
      location: window.location,
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

    try {
      await import('../assets/js/app.js');
      await new Promise(resolve => setTimeout(resolve, 1300));
      const state = window.document.body._x_dataStack?.[0];
      expect(state?.apps).toHaveLength(1);
      expect(state.apps[0].name).toBe('Cached Notes');
      expect(state.usingCachedLibrary).toBe(true);
      expect(state.errors.library).toContain('last saved copy');
      expect(state.stats.visitors).toBe(22);
      expect(state.downloadsOf(state.apps[0])).toBeGreaterThanOrEqual(5);
    } finally {
      await new Promise(resolve => setTimeout(resolve, 200));
      window.Alpine?.destroyTree?.(window.document.body);
      window.close();
    }
  });

  it('loads file counters lazily and fetches remaining counts on the admin dashboard', async () => {
    const dom = new JSDOM(html, {
      url: 'https://schoolcloud.example.test/',
      runScripts: 'outside-only',
      pretendToBeVisual: true
    });
    const { window } = dom;
    window.HTMLAnchorElement.prototype.click = vi.fn();
    const observers = [];
    window.IntersectionObserver = class {
      constructor(callback, options) {
        this.callback = callback;
        this.options = options;
        this.targets = new Set();
        observers.push(this);
      }
      observe(target) { this.targets.add(target); }
      unobserve(target) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); }
      intersect(target) {
        this.callback([{ target, isIntersecting: true }], this);
      }
    };
    const manifest = [
      { type: 'file', name: 'Year 12 algebra.html', path: 'apps/Year 12 algebra.html', download_url: 'https://raw.githubusercontent.com/Petgabs/HSC/main/apps/Year%2012%20algebra.html' },
      { type: 'file', name: 'HSC revision.pdf', path: 'apps/HSC revision.pdf', download_url: 'https://raw.githubusercontent.com/Petgabs/HSC/main/apps/HSC%20revision.pdf' }
    ];
    const fetchMock = vi.fn(async input => {
      const url = String(input);
      if (url.includes('apps.json')) return jsonResponse(manifest);
      if (url.includes('library.json')) return jsonResponse({});
      if (url.includes('/hit/')) return jsonResponse({ value: url.includes('download-') ? 8 : 41 });
      if (url.includes('/get/')) return jsonResponse({ value: 7 });
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

    try {
      await import('../assets/js/app.js');
      await new Promise(resolve => setTimeout(resolve, 200));
      const state = window.document.body._x_dataStack?.[0];
      const getCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/get/'));
      const fileGetCalls = () => getCalls().filter(([url]) => String(url).includes('download-'));
      const visitorGetCalls = () => getCalls().filter(([url]) => String(url).includes('/visitors'));
      expect(state?.apps).toHaveLength(2);
      expect(observers).toHaveLength(1);
      expect(observers[0].targets.size).toBe(2);
      expect(getCalls()).toHaveLength(0);

      const visibleCard = [...observers[0].targets][0];
      const visibleItem = visibleCard._schoolCloudCounterItem;
      observers[0].intersect(visibleCard);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(fileGetCalls()).toHaveLength(1);
      expect(state.downloadsOf(visibleItem)).toBe(7);

      state.isAdmin = true;
      state.openDashboard();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(fileGetCalls()).toHaveLength(2);
      expect(state.apps.every(item => state.downloadsOf(item) === 7)).toBe(true);

      // Opening the dashboard re-reads an already-seen file once its cached
      // Abacus value is stale, not just counters that were never visible.
      state._counterReadAt[visibleItem.id] = Date.now() - 10_001;
      state.openDashboard();
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(fileGetCalls()).toHaveLength(3);

      for (const item of state.apps) state._counterReadAt[item.id] = Date.now();
      await state.refreshStats();
      expect(fileGetCalls()).toHaveLength(3);
      expect(visitorGetCalls()).toHaveLength(1);
      for (const item of state.apps) state._counterReadAt[item.id] = Date.now() - 10_001;
      await state.refreshStats();
      expect(fileGetCalls()).toHaveLength(5);
      expect(visitorGetCalls()).toHaveLength(2);

      state.downloadApp(visibleItem);
      await new Promise(resolve => setTimeout(resolve, 30));
      const downloadHits = fetchMock.mock.calls.filter(([url]) => {
        const requestUrl = String(url);
        return requestUrl.includes('/hit/') && requestUrl.includes(visibleItem.counterKey);
      });
      expect(downloadHits).toHaveLength(1);
      expect(state.downloadsOf(visibleItem)).toBe(8);
      expect(state.toast.visible).toBe(true);
      expect(state.toast.tone).toBe('success');
      expect(state.toast.message).toContain('Download started successfully');
    } finally {
      // Wait out view transitions so their deferred DOM callbacks do not outlive JSDOM.
      await new Promise(resolve => setTimeout(resolve, 200));
      window.Alpine?.destroyTree?.(window.document.body);
      window.close();
    }
  });

  it('seeds counters from the GitHub-saved record when Abacus is unreachable', async () => {
    const dom = new JSDOM(html, {
      url: 'https://schoolcloud.example.test/',
      runScripts: 'outside-only',
      pretendToBeVisual: true
    });
    const { window } = dom;
    window.HTMLAnchorElement.prototype.click = vi.fn();
    const manifest = [
      { type: 'file', name: 'Year 12 algebra.html', path: 'apps/Year 12 algebra.html', download_url: 'apps/Year 12 algebra.html' },
      { type: 'file', name: 'HSC revision.pdf', path: 'apps/HSC revision.pdf', download_url: 'apps/HSC revision.pdf' }
    ];
    const record = {
      namespace: 'petgabs-hsc-schoolcloud',
      updatedAt: '2026-10-06T05:15:00.000Z',
      visitors: 100,
      files: {
        'apps/Year 12 algebra.html': { downloads: 30, key: 'download-aaaaaaaa' },
        'apps/HSC revision.pdf': { downloads: 12, key: 'download-bbbbbbbb' }
      }
    };
    const unavailable = () => new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 });
    const fetchMock = vi.fn(async input => {
      const url = String(input);
      if (url.includes('apps.json')) return jsonResponse(manifest);
      if (url.includes('library.json')) return jsonResponse({});
      if (url.includes('stats/downloads.json')) return jsonResponse(record);
      if (url.includes('/hit/') || url.includes('/get/')) return unavailable();
      return jsonResponse([]);
    });
    for (const [key, value] of Object.entries({
      window,
      document: window.document,
      navigator: window.navigator,
      location: window.location,
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

    try {
      await import('../assets/js/app.js');
      await new Promise(resolve => setTimeout(resolve, 200));
      const state = window.document.body._x_dataStack?.[0];
      expect(state?.apps).toHaveLength(2);
      expect(state.hasDownloadRecord).toBe(true);
      expect(state.downloadStatsRecord.files.size).toBe(2);
      expect(state.githubRecordLabel()).toContain('GitHub');
      // Every shared layer failed, so the same-origin GitHub record serves the numbers.
      expect(state.stats.online).toBe(false);
      expect(state.stats.backend).toBe('github');
      expect(state.stats.visitors).toBe(100);
      const seeded = Object.fromEntries(state.apps.map(item => [item.path, state.downloadsOf(item)]));
      expect(seeded['apps/Year 12 algebra.html']).toBe(30);
      expect(seeded['apps/HSC revision.pdf']).toBe(12);
      expect(state.totalDownloads).toBe(42);

      // A download still increments locally and attempts exactly one Abacus hit.
      const downloaded = state.apps.find(item => item.path === 'apps/Year 12 algebra.html');
      state.downloadApp(downloaded);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(state.downloadsOf(downloaded)).toBe(31);
      const downloadHits = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/hit/') && String(url).includes(downloaded.counterKey));
      expect(downloadHits).toHaveLength(1);
      expect(state.stats.backend).toBe('github');
    } finally {
      await new Promise(resolve => setTimeout(resolve, 200));
      window.Alpine?.destroyTree?.(window.document.body);
      window.close();
    }
  });
});
