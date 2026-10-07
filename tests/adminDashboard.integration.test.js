import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';

/**
 * Page-level checks for the upgraded administrator dashboard: per-file sizes,
 * total cloud storage used, the space still available, how many days each file
 * has been stored, the administrator sign-in statistics (today / week / month,
 * plus the latest sign-in), subject-filtered document deletion and uploads.
 *
 * Everything runs against the real index.html and the real app.js with a
 * stubbed network, so the wiring — not just the helpers — is under test.
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

const DAY_MS = 86_400_000;
const isoDaysAgo = days => new Date(Date.now() - days * DAY_MS).toISOString();

const MANIFEST = [
  { type: 'file', name: 'Algebra app.html', path: 'apps/Algebra app.html', download_url: 'apps/Algebra app.html' },
  { type: 'file', name: 'Revision notes.pdf', path: 'apps/Revision notes.pdf', download_url: 'apps/Revision notes.pdf' },
  { type: 'file', name: 'Old paper.pdf', path: 'apps/Old paper.pdf', download_url: 'apps/Old paper.pdf' },
  { type: 'file', name: 'Mystery notes.pdf', path: 'apps/Mystery notes.pdf', download_url: 'apps/Mystery notes.pdf' }
];

// Sizes are only carried by library.json on GitHub Pages (the generated
// apps.json has no size), which is exactly what the dashboard must handle.
const LIBRARY = {
  'apps/Algebra app.html': { title: 'Algebra app', subject: 'Mathematics', years: [12], bytes: 4_000_000, addedAt: isoDaysAgo(10) },
  'apps/Revision notes.pdf': { title: 'Revision notes', subject: 'Mathematics', years: [12], bytes: 1_000_000, addedAt: isoDaysAgo(2) },
  'apps/Old paper.pdf': { title: 'Old paper', subject: 'Mathematics', years: [11], addedAt: isoDaysAgo(200) },
  // Nothing is known about this one until GitHub is asked.
  'apps/Mystery notes.pdf': { title: 'Mystery notes', subject: 'Mathematics', years: [10] }
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function openPage({ credentials = null, activity = null } = {}) {
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
  let listing = [
    { type: 'file', name: 'Algebra app.html', path: 'apps/Algebra app.html', size: 4_000_000 },
    { type: 'file', name: 'Revision notes.pdf', path: 'apps/Revision notes.pdf', size: 1_000_000 },
    { type: 'file', name: 'Old paper.pdf', path: 'apps/Old paper.pdf', size: 250_000 }
  ];
  let commitHistory = [];
  let library = { ...LIBRARY };
  let activityRecord = activity;
  let storedFile = null;

  const fetchMock = vi.fn(async (input, init = {}) => {
    const url = String(input);
    const method = String(init.method || 'GET').toUpperCase();
    if (url === 'https://api.github.com/repos/Petgabs/HSC') {
      return jsonResponse({ full_name: 'Petgabs/HSC', permissions: { push: true } });
    }
    // The public apps/ directory listing used to resolve missing sizes.
    if (method === 'GET' && /\/contents\/apps(\?|$)/.test(url)) {
      return jsonResponse([...listing]);
    }
    // Commit history: newest first, oldest last (the upload date). A brand-new
    // file has none until the test says GitHub reports one.
    if (method === 'GET' && url.includes('/commits?')) {
      return jsonResponse([...commitHistory]);
    }
    if (url.includes('/hit/')) return jsonResponse({ value: 41 });
    if (url.includes('/get/')) return jsonResponse({ value: 7 });
    if (url.includes('/contents/')) {
      repositoryCalls.push({ url, method, body: init.body || '' });
      if (url.includes('/contents/library.json')) {
        if (method === 'PUT') {
          library = JSON.parse(Buffer.from(JSON.parse(init.body).content, 'base64').toString('utf8'));
          return jsonResponse({ commit: { html_url: 'https://github.com/Petgabs/HSC/commit/library' } });
        }
        return jsonResponse({ sha: 'library-sha', content: base64Json(library) });
      }
      if (url.includes('/contents/stats/admin-activity.json')) {
        if (method === 'PUT') {
          activityRecord = JSON.parse(Buffer.from(JSON.parse(init.body).content, 'base64').toString('utf8'));
          return jsonResponse({ commit: { html_url: 'https://github.com/Petgabs/HSC/commit/activity' } });
        }
        return activityRecord
          ? jsonResponse({ sha: 'activity-sha', content: base64Json(activityRecord) })
          : jsonResponse({ message: 'Not Found' }, 404);
      }
      if (url.includes('/contents/apps/')) {
        if (method === 'PUT') {
          storedFile = { bytes: Buffer.from(JSON.parse(init.body).content, 'base64') };
          return jsonResponse({ content: { name: 'New notes.pdf', download_url: 'apps/New notes.pdf' }, commit: { html_url: '.../commit/file' } });
        }
        if (!storedFile) return jsonResponse({ message: 'Not Found' }, 404);
        return jsonResponse({ sha: 'blob-sha', content: storedFile.bytes.toString('base64') });
      }
    }
    if (url.includes('admin-activity.json')) {
      return activityRecord ? jsonResponse(activityRecord) : jsonResponse({ message: 'Not Found' }, 404);
    }
    if (url.includes('apps.json')) return jsonResponse(MANIFEST);
    if (url.includes('library.json')) return jsonResponse(library);
    if (url.includes('stats/downloads.json')) return jsonResponse({ namespace: 'petgabs-hsc-schoolcloud', updatedAt: '', visitors: 5, files: {} });
    return jsonResponse({});
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
  // Alpine reports a bad expression through console.error; collecting both
  // makes an unrenderable binding fail the test instead of passing silently.
  window.console.warn = (...args) => errors.push(args.join(' '));
  window.console.error = (...args) => errors.push(args.join(' '));

  let state = null;
  try {
    if (credentials) {
      const config = await import('../assets/js/config.js');
      config.applyAdminGate(credentials.admin);
      config.applyMasterGate(credentials.master);
    }
    await import('../assets/js/app.js');
    await new Promise(resolve => setTimeout(resolve, 200));
    state = window.document.body._x_dataStack?.[0];
  } finally {
    if (!state) window.close();
  }
  return {
    window, state, errors, fetchMock, repositoryCalls,
    activity: () => activityRecord,
    /** A file GitHub can newly report, to prove a refresh resolves it. */
    addToRepositoryListing(entry) { listing = [...listing, entry]; },
    setCommitHistory(entries) { commitHistory = [...entries]; },
    apiCalls: () => fetchMock.mock.calls.map(call => String(call[0])).filter(url => url.includes('api.github.com'))
  };
}

async function close(visit) {
  await new Promise(resolve => setTimeout(resolve, 250));
  try {
    visit.window.Alpine?.destroyTree?.(visit.window.document.body);
    visit.window.close();
  } catch { /* The window may already be gone. */ }
  vi.unstubAllGlobals();
  vi.resetModules();
}

async function waitForIdle(state, timeoutMs = 3_000) {
  const started = Date.now();
  while (state.cloudDetails.refreshing && Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  expect(state.cloudDetails.refreshing).toBe(false);
}

describe('cloud storage dashboard', () => {
  it('reports each file size, the total used and the space available', async () => {
    const visit = await openPage();
    try {
      const state = visit.state;
      expect(visit.errors.filter(message => /Alpine Expression Error|ReferenceError|TypeError/.test(message))).toEqual([]);
      expect(state.apps).toHaveLength(4);
      await waitForIdle(state);

      // Sizes come from library.json first, then from the GitHub listing for a
      // file the metadata cannot measure — never from an invented number.
      const stats = state.cloudStorageStatistics;
      expect(stats.usedBytes).toBe(5_250_000);
      expect(stats.totalBytes).toBe(5_250_000);
      expect(stats.fileCount).toBe(4);
      expect(stats.knownSizeCount).toBe(3);
      expect(stats.unknownSizeCount).toBe(1);
      expect(stats.hasQuota).toBe(true);
      expect(stats.quotaBytes).toBe(1_000_000_000);
      expect(stats.availableBytes).toBe(994_750_000);
      expect(stats.percentUsed).toBe(0.5);
      expect(stats.usedLabel).toBe('5.0 MB');
      expect(stats.availableLabel).toBe('949 MB');
      expect(stats.quotaLabel).toBe('954 MB');
      expect(stats.usedDetail).toBe('3 of 4 files measured');

      const algebra = state.apps.find(item => item.fileName === 'Algebra app.html');
      expect(state.sizeLabel(algebra)).toBe('3.8 MB');
      const oldPaper = state.apps.find(item => item.fileName === 'Old paper.pdf');
      expect(state.sizeLabel(oldPaper)).toBe('244 KB');
      const mystery = state.apps.find(item => item.fileName === 'Mystery notes.pdf');
      expect(state.sizeLabel(mystery)).toBe('Size unknown');
      expect(state.sizeLabel(mystery)).toBe('Size unknown');
      expect(state.storageQuotaLabel).toBe('GitHub Pages allowance');
      expect(state.averageFileSizeLabel).toBe('Average file size 1.7 MB');
    } finally {
      await close(visit);
    }
  });

  it('reports how many days each file has been stored in the cloud', async () => {
    const visit = await openPage();
    try {
      const state = visit.state;
      await waitForIdle(state);
      const rows = state.cloudFileInventory;
      expect(rows.map(row => row.fileName)).toEqual([
        'Algebra app.html', 'Revision notes.pdf', 'Old paper.pdf', 'Mystery notes.pdf'
      ]);
      const algebra = rows.find(row => row.fileName === 'Algebra app.html');
      expect(algebra.storedDays).toBe(10);
      expect(algebra.storedLabel).toBe('10 days in the cloud');
      const oldPaper = rows.find(row => row.fileName === 'Old paper.pdf');
      expect(oldPaper.storedDays).toBe(200);
      expect(oldPaper.storedLabel).toContain('200 days');
      const mystery = rows.find(row => row.fileName === 'Mystery notes.pdf');
      expect(mystery.storedDays).toBeNull();
      expect(mystery.storedLabel).toBe('Storage age unknown');
      expect(state.cloudStorageOldestLabel).toContain('Old paper');
      expect(state.storedAgeShort(state.apps.find(item => item.fileName === 'Revision notes.pdf'))).toBe('2 days');
      expect(state.storedAgeShort(state.apps.find(item => item.fileName === 'Mystery notes.pdf'))).toBe('Unknown');
      expect(state.storedAgeTitle(state.apps.find(item => item.fileName === 'Mystery notes.pdf'))).toContain('Refresh file details');
    } finally {
      await close(visit);
    }
  });

  it('resolves a missing size and upload date from GitHub when asked', async () => {
    const visit = await openPage();
    try {
      const state = visit.state;
      await waitForIdle(state);
      const mystery = () => state.apps.find(item => item.fileName === 'Mystery notes.pdf');
      expect(mystery().size).toBe(0);
      expect(mystery().addedAt).toBe('');

      // GitHub now reports the file, so a refresh fills in both facts: the
      // size from the directory listing, the date from its commit history.
      visit.addToRepositoryListing({ type: 'file', name: 'Mystery notes.pdf', path: 'apps/Mystery notes.pdf', size: 500_000 });
      visit.setCommitHistory([
        { commit: { author: { date: isoDaysAgo(5) } } },
        { commit: { author: { date: isoDaysAgo(9) } } }
      ]);
      const ok = await state.refreshCloudFileDetails({ silent: true });
      expect(ok).toBe(true);
      expect(state.sizeLabel(mystery())).toBe('488 KB');
      expect(mystery().size).toBe(500_000);
      // The oldest commit is the upload, so its date is the storage start.
      expect(Math.abs(Date.parse(mystery().addedAt) - Date.parse(isoDaysAgo(9)))).toBeLessThan(60_000);
      expect(state.storedAgeShort(mystery())).toBe('9 days');
      expect(state.cloudStorageStatistics.usedBytes).toBe(5_750_000);
      expect(state.cloudStorageStatistics.unknownSizeCount).toBe(0);
      expect(state.cloudDetails.error).toBe('');
      expect(state.cloudDetails.message).toContain('sizes and storage ages are up to date');
      // The upload date came from the commit history, and only for the file
      // that had no recorded date.
      const commitCalls = visit.apiCalls().filter(url => url.includes('/commits?'));
      expect(commitCalls.length).toBeGreaterThanOrEqual(1);
      expect(commitCalls.every(url => url.includes('Mystery'))).toBe(true);
    } finally {
      await close(visit);
    }
  });
});

describe('document and resource subject filters', () => {
  it('filters the delete table by subject and keeps deletion scoped to one file', async () => {
    const visit = await openPage();
    try {
      const state = visit.state;
      await waitForIdle(state);

      // The fixture normally has one subject; assign one document to another
      // to verify that the filter separates files rather than only counting.
      const selectedFile = state.resources.find(item => item.fileName === 'Old paper.pdf');
      selectedFile.meta.subject = 'CAL';
      expect(state.dashboardResourceSubjectOptions).toEqual([
        { subject: 'CAL', count: 1 },
        { subject: 'Mathematics', count: 2 }
      ]);

      state.isAdmin = true;
      state.currentView = 'dashboard';
      await new Promise(resolve => setTimeout(resolve, 30));

      const manager = visit.window.document.getElementById('dashboard-resource-manager');
      const subjectFilter = manager?.querySelector('#dashboard-resource-subject');
      expect(subjectFilter).toBeTruthy();
      expect([...subjectFilter.options].map(option => option.textContent.trim())).toEqual([
        'All subjects (3)', 'CAL (1)', 'Mathematics (2)'
      ]);

      subjectFilter.value = 'CAL';
      subjectFilter.dispatchEvent(new visit.window.Event('change', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 30));

      expect(state.dashboardResourceSubject).toBe('CAL');
      expect(state.filteredDashboardResources.map(item => item.fileName)).toEqual(['Old paper.pdf']);
      const rows = [...manager.querySelectorAll('tbody tr')];
      expect(rows).toHaveLength(1);
      expect(rows[0].textContent).toContain('Old paper.pdf');

      // The row action still targets just the selected file after filtering.
      const deleteButton = rows[0].querySelector('button[aria-label^="Delete"]');
      expect(deleteButton).toBeTruthy();
      state.githubAuth.connected = true;
      state.githubAuth.activeToken = 'test-token';
      visit.window.confirm = () => true;
      const deleted = [];
      state.deleteGithubResource = item => deleted.push(item);
      deleteButton.click();
      expect(deleted).toHaveLength(1);
      expect(deleted[0].fileName).toBe('Old paper.pdf');
      expect(visit.errors.filter(message => /Alpine Expression Error|ReferenceError|TypeError/.test(message))).toEqual([]);
    } finally {
      await close(visit);
    }
  });
});

describe('administrator sign-in statistics', () => {
  it('records a sign-in and counts today, this week and this month', async () => {
    const visit = await openPage({ credentials: gateFor(ORIGINAL) });
    try {
      const state = visit.state;
      expect(state.adminLoginStats).toMatchObject({ today: 0, week: 0, month: 0, total: 0 });
      expect(state.latestAdminLogin).toBeNull();

      state.loginForm.username = ORIGINAL.username;
      state.loginForm.password = ORIGINAL.password;
      await state.login();
      expect(state.isAdmin).toBe(true);

      // The dashboard answers straight away, from the device copy.
      const stats = state.adminLoginStats;
      expect(stats).toMatchObject({ today: 1, week: 1, month: 1, total: 1 });
      expect(state.latestAdminLogin).toMatchObject({ user: ORIGINAL.username });
      expect(state.latestAdminLogin.relative).toBe('just now');
      expect(state.recentAdminLogins).toHaveLength(1);
      expect(state.adminLoginStats.perDay.at(-1)).toMatchObject({ count: 1, isToday: true });

      // The sign-in is also written to the shared record for every computer.
      state.githubAuth.connected = true;
      state.githubAuth.activeToken = 'test-token';
      await state.syncAdminActivityToGitHub({ silent: true });
      const record = visit.activity();
      expect(record).toBeTruthy();
      expect(record.logins).toHaveLength(1);
      expect(record.logins[0].user).toBe(ORIGINAL.username);
      expect(Date.parse(record.logins[0].at)).toBeGreaterThan(Date.now() - 60_000);
      const put = visit.repositoryCalls.find(call => call.method === 'PUT' && call.url.includes('/contents/stats/admin-activity.json'));
      expect(put).toBeTruthy();
      expect(state.adminActivityStatus.pendingCount).toBe(0);
    } finally {
      await close(visit);
    }
  });

  it('reports a shared record written by another computer', async () => {
    const shared = {
      updatedAt: new Date().toISOString(),
      logins: [
        { at: new Date().toISOString(), user: 'hsc-admin' },
        { at: isoDaysAgo(3), user: 'hsc-admin' },
        { at: new Date(Date.now() - 3 * DAY_MS - 3_600_000).toISOString(), user: 'hsc-admin' },
        { at: isoDaysAgo(20), user: 'hsc-admin' },
        { at: isoDaysAgo(90), user: 'hsc-admin' }
      ],
      uploads: [
        { at: isoDaysAgo(4), path: 'apps/Revision notes.pdf', name: 'Revision notes.pdf', title: 'Revision notes', bytes: 1_000_000 },
        { at: isoDaysAgo(30), path: 'apps/Deleted paper.pdf', name: 'Deleted paper.pdf', bytes: 500_000 }
      ]
    };
    const visit = await openPage({ activity: shared });
    try {
      const state = visit.state;
      expect(state.adminLoginStats.today).toBe(1);
      expect(state.adminLoginStats.week).toBe(3);
      expect(state.adminLoginStats.month).toBe(4);
      expect(state.adminLoginStats.total).toBe(5);
      expect(state.latestAdminLogin.user).toBe('hsc-admin');
      expect(state.recentAdminLogins).toHaveLength(5);
      // Latest uploads show size, age, and whether the file is still published.
      const uploads = state.recentAdminUploads;
      expect(uploads[0]).toMatchObject({
        name: 'Revision notes.pdf', sizeLabel: '977 KB', presentInLibrary: true, storedLabel: '4 days in the cloud'
      });
      expect(uploads[1]).toMatchObject({ name: 'Deleted paper.pdf', presentInLibrary: false });
      expect(state.adminActivityStatus.source).toBe('github');
      expect(state.adminActivitySourceLabel).toContain('stats/admin-activity.json');
    } finally {
      await close(visit);
    }
  });

  it('queues a sign-in that cannot be shared yet and saves it once connected', async () => {
    const visit = await openPage({ credentials: gateFor(ORIGINAL) });
    try {
      const state = visit.state;
      // No token yet: the entry is kept on this device and stays visible.
      state.githubAuth.connected = false;
      state.githubAuth.activeToken = '';
      state.recordAdminLogin();
      expect(state.adminLoginStats.today).toBe(1);
      expect(state.adminActivityStatus.pendingCount).toBe(1);
      expect(visit.activity()).toBeNull();

      // Connecting publishing flushes the queue into the shared record.
      state.githubAuth.activeToken = 'test-token';
      state.githubAuth.connected = true;
      await state.syncAdminActivityToGitHub({ silent: true });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(visit.activity()?.logins).toHaveLength(1);
      expect(state.adminActivityStatus.pendingCount).toBe(0);
    } finally {
      await close(visit);
    }
  });
});

describe('latest uploaded files', () => {
  it('logs a published file with its size and links it to the library', async () => {
    const visit = await openPage({ credentials: gateFor(ORIGINAL) });
    try {
      const state = visit.state;
      state.isAdmin = true;
      state.githubAuth.connected = true;
      state.githubAuth.activeToken = 'test-token';
      state.draft.title = 'New notes';
      state.draft.subject = 'Mathematics';
      state.draft.years = '12';
      state.draft.owner = 'Mathematics faculty';
      await waitForIdle(state);
      const usedBefore = state.cloudStorageStatistics.usedBytes;
      const pdfBytes = new TextEncoder().encode('%PDF-1.4\n% dashboard upload\n');
      state.setDraftFile({ name: 'New notes.pdf', size: pdfBytes.length, arrayBuffer: async () => pdfBytes.buffer });
      await new Promise(resolve => setTimeout(resolve, 60));
      await state.submitResource();
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(state.uploadResult).toBeTruthy();
      const uploads = state.recentAdminUploads;
      expect(uploads[0]).toMatchObject({
        name: 'New notes.pdf', title: 'New notes', presentInLibrary: true, sizeLabel: `${pdfBytes.length} B`
      });
      const record = visit.activity();
      expect(record.uploads[0]).toMatchObject({ path: 'apps/New notes.pdf', bytes: pdfBytes.length, subject: 'Mathematics' });
      // The new file is part of the storage total immediately.
      expect(state.cloudStorageStatistics.usedBytes).toBe(usedBefore + pdfBytes.length);
    } finally {
      await close(visit);
    }
  }, 20_000);
});
