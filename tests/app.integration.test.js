import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';

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
    const fetchMock = vi.fn(async input => {
      const url = String(input);
      if (url.includes('apps.json')) return jsonResponse(manifest);
      if (url.includes('library.json')) return jsonResponse(library);
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
    } finally {
      // Allow Alpine's x-transition cleanup timers to settle before JSDOM tears
      // down the globals used by its MutationObserver callbacks.
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
    } finally {
      // Wait out view transitions so their deferred DOM callbacks do not outlive JSDOM.
      await new Promise(resolve => setTimeout(resolve, 200));
      window.Alpine?.destroyTree?.(window.document.body);
      window.close();
    }
  });
});
