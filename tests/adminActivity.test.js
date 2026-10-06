import { readFile, readdir } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_ACTIVITY_LIMIT, ADMIN_ACTIVITY_PATH, activityEntryKey, adminLoginStatistics,
  cloudFileInventory, emptyAdminActivity, formatStoredDays, localDayKey, mergeAdminActivity,
  normalizeAdminActivity, recentAdminLogins, recentAdminUploads, storageSummary, storedDays,
  withAdminLogin, withAdminUpload
} from '../assets/js/lib/adminActivity.js';
import {
  mergeAdminActivityIntoGitHub, readCloudFileDetails
} from '../assets/js/lib/githubPublish.js';
import { formatRelativeTime } from '../assets/js/lib/format.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

function mockResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (body === null ? '' : JSON.stringify(body)),
    json: async () => body
  };
}

function base64Json(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

afterEach(() => vi.unstubAllGlobals());

/** A fixed "now": 6 October 2026, 21:00 local time. */
const NOW = new Date(2026, 9, 6, 21, 0, 0).getTime();
const at = (dayOffset, hour = 9) => new Date(2026, 9, 6 + dayOffset, hour, 0, 0).toISOString();

describe('administrator activity record', () => {
  it('normalizes, de-duplicates and orders sign-ins and uploads', () => {
    const merged = mergeAdminActivity(
      {
        logins: [
          { at: at(-1), user: 'hsc-admin' },
          { at: at(0, 8), user: 'hsc-admin' },
          { at: 'not-a-date', user: 'hsc-admin' },
          { at: at(0, 8), user: 'hsc-admin' }
        ]
      },
      {
        logins: [{ at: at(0, 12), user: 'hsc-admin' }],
        uploads: [
          { at: at(0, 10), path: 'apps/Paper 2.docx', name: 'Paper 2.docx', title: 'Paper 2', bytes: 2048, years: [12, '12', 99] },
          { at: at(0, 10), path: 'apps/Paper 2.docx', name: 'Paper 2.docx', bytes: 2048 },
          { at: at(-2), path: 'outside/repo.txt', name: 'repo.txt' }
        ]
      }
    );

    // Newest first, one entry per sign-in, unusable timestamps dropped.
    expect(merged.logins.map(entry => entry.at)).toEqual([at(0, 12), at(0, 8), at(-1)]);
    // A repeated upload merges into one entry; the path outside apps/ is kept
    // as a name-only record rather than pretending it is a published file.
    expect(merged.uploads).toHaveLength(2);
    expect(merged.uploads[0]).toMatchObject({
      at: at(0, 10), path: 'apps/Paper 2.docx', bytes: 2048, years: [12]
    });
    expect(merged.uploads[1].path).toBe('');
    expect(activityEntryKey('login', merged.logins[0])).not.toBe(activityEntryKey('login', merged.logins[1]));
  });

  it('caps the record so a busy year never grows the repository file', () => {
    const logins = Array.from({ length: ADMIN_ACTIVITY_LIMIT + 25 }, (_, index) => ({
      at: new Date(NOW - index * 60_000).toISOString(),
      user: 'hsc-admin'
    }));
    const merged = mergeAdminActivity({ logins });
    expect(merged.logins).toHaveLength(ADMIN_ACTIVITY_LIMIT);
    expect(merged.logins[0].at).toBe(new Date(NOW).toISOString());
  });

  it('degrades malformed records to an empty, well-shaped record', () => {
    for (const value of [null, undefined, 'text', 42, [], { logins: 'no', uploads: { at: 1 } }]) {
      expect(normalizeAdminActivity(value)).toEqual(emptyAdminActivity());
    }
    const dirty = normalizeAdminActivity({
      updatedAt: 'yesterday',
      logins: [{ at: at(0), user: 'hsc\u0000admin\u0007'.repeat(20) }],
      uploads: [{ at: at(0), path: 'apps/a.pdf', name: 'a.pdf', bytes: -5, subject: 'X'.repeat(400) }]
    });
    expect(dirty.updatedAt).toBe('');
    expect(dirty.logins[0].user).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(dirty.logins[0].user.length).toBeLessThanOrEqual(64);
    expect(dirty.uploads[0].bytes).toBe(0);
    expect(dirty.uploads[0].subject.length).toBeLessThanOrEqual(60);
  });

  it('appends one sign-in or upload at a time', () => {
    const first = withAdminLogin(emptyAdminActivity(), { at: at(0), user: 'hsc-admin' });
    const second = withAdminUpload(first, {
      at: at(0, 11), path: 'apps/Notes.pdf', name: 'Notes.pdf', title: 'Notes', bytes: 512, subject: 'Mathematics', years: [11]
    });
    expect(second.logins).toHaveLength(1);
    expect(second.uploads).toHaveLength(1);
    // Adding the same sign-in again is a no-op, never a double count.
    expect(withAdminLogin(second, { at: at(0), user: 'hsc-admin' }).logins).toHaveLength(1);
  });

  it('reports local-day keys, stored days and readable storage ages', () => {
    expect(localDayKey(NOW)).toBe('2026-10-06');
    expect(storedDays(new Date(NOW - 3 * 86_400_000).toISOString(), NOW)).toBe(3);
    expect(storedDays('', NOW)).toBeNull();
    expect(formatStoredDays(0)).toBe('Stored today');
    expect(formatStoredDays(1)).toBe('1 day in the cloud');
    expect(formatStoredDays(12)).toBe('12 days in the cloud');
    expect(formatStoredDays(null)).toBe('Storage age unknown');
    expect(formatStoredDays(400)).toContain('(~1.1 years)');
  });
});

describe('administrator sign-in statistics', () => {
  const activity = {
    logins: [
      { at: at(0, 8), user: 'hsc-admin' },
      { at: at(0, 12), user: 'hsc-admin' },
      { at: at(-1, 9), user: 'hsc-admin' },
      { at: at(-6, 15), user: 'hsc-admin' },
      { at: at(-10, 15), user: 'hsc-admin' },
      { at: at(-40, 15), user: 'hsc-admin' }
    ]
  };

  it('counts sign-ins for today, the week and the month', () => {
    const stats = adminLoginStatistics(activity, NOW, { seriesDays: 14 });
    expect(stats.today).toBe(2);
    // Today plus the previous six calendar days.
    expect(stats.week).toBe(4);
    // Everything inside the last thirty days, so the 40-day-old sign-in is out.
    expect(stats.month).toBe(5);
    expect(stats.total).toBe(6);
    expect(stats.lastLoginAt).toBe(at(0, 12));
    expect(stats.firstLoginAt).toBe(at(-40, 15));
    expect(stats.activeDays).toBe(4);
    expect(stats.seriesTotal).toBe(5);
    expect(stats.busiestDay).toMatchObject({ day: '2026-10-06', count: 2 });
    expect(stats.perDay).toHaveLength(14);
    expect(stats.perDay.at(-1)).toMatchObject({ day: '2026-10-06', count: 2, isToday: true });
    expect(stats.perDay[0].day).toBe('2026-09-23');
  });

  it('handles an empty record without inventing numbers', () => {
    const stats = adminLoginStatistics(emptyAdminActivity(), NOW);
    expect(stats).toMatchObject({ today: 0, week: 0, month: 0, total: 0, lastLoginAt: '' });
    expect(stats.busiestDay).toBeNull();
    expect(recentAdminLogins(emptyAdminActivity())).toEqual([]);
    expect(recentAdminUploads(emptyAdminActivity())).toEqual([]);
  });
});

describe('cloud storage totals', () => {
  const items = [
    { id: 'apps/a.pdf', name: 'A', fileName: 'a.pdf', path: 'apps/a.pdf', size: 400, source: 'github', addedAt: at(-40), meta: { subject: 'Mathematics' } },
    { id: 'apps/b.pdf', name: 'B', fileName: 'b.pdf', path: 'apps/b.pdf', size: 100, source: 'github', addedAt: at(0), meta: { subject: 'Mathematics' } },
    { id: 'apps/c.pdf', name: 'C', fileName: 'c.pdf', path: 'apps/c.pdf', size: 0, source: 'github', addedAt: '', meta: {} }
  ];

  it('adds up what is used and what is left of the allowance', () => {
    const summary = storageSummary({ items, quotaBytes: 1000, now: NOW });
    expect(summary.usedBytes).toBe(500);
    expect(summary.availableBytes).toBe(500);
    expect(summary.percentUsed).toBe(50);
    expect(summary.fileCount).toBe(3);
    expect(summary.knownSizeCount).toBe(2);
    expect(summary.unknownSizeCount).toBe(1);
    expect(summary.overQuota).toBe(false);
    expect(summary.largestFile).toMatchObject({ name: 'A', bytes: 400 });
    // Longest-stored file first, and it is the one with the recorded date.
    expect(summary.oldestFile).toMatchObject({ name: 'A', storedDays: 40 });
  });

  it('never reports negative space and identifies an over-full allowance', () => {
    const over = storageSummary({ items, quotaBytes: 300, now: NOW });
    expect(over.availableBytes).toBe(0);
    expect(over.overQuota).toBe(true);
    expect(over.percentUsed).toBe(100);
    const unlimited = storageSummary({ items, quotaBytes: 0, now: NOW });
    expect(unlimited.hasQuota).toBe(false);
    expect(unlimited.availableBytes).toBe(0);
    expect(unlimited.percentUsed).toBe(0);
  });

  it('lists each file with its size and days stored, largest first', () => {
    const rows = cloudFileInventory(items, { now: NOW, downloadsOf: item => (item.id === 'apps/b.pdf' ? 7 : 0) });
    expect(rows.map(row => row.name)).toEqual(['A', 'B', 'C']);
    expect(rows[0]).toMatchObject({ sizeKnown: true, storedDays: 40, storedLabel: '40 days (~1 month) in the cloud' });
    expect(rows[1]).toMatchObject({ sizeKnown: true, storedDays: 0, downloads: 7 });
    expect(rows[2]).toMatchObject({ sizeKnown: false, storedDays: null, bytes: 0, storedLabel: 'Storage age unknown' });
  });

  it('formats short relative times for the dashboard', () => {
    expect(formatRelativeTime(NOW - 5_000, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW - 12 * 60_000, NOW)).toBe('12 minutes ago');
    expect(formatRelativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3 hours ago');
    expect(formatRelativeTime(NOW - 2 * 86_400_000, NOW)).toBe('2 days ago');
    expect(formatRelativeTime('not-a-date', NOW)).toBe('');
  });
});

describe('sharing the activity record through GitHub', () => {
  it('merges queued entries into the repository record without replacing it', async () => {
    const existing = {
      updatedAt: '2026-10-05T00:00:00.000Z',
      logins: [{ at: at(-1), user: 'hsc-admin' }],
      uploads: []
    };
    const fetchMock = vi.fn(async (url, init = {}) => {
      if (init.method === 'PUT') return mockResponse(201, { commit: { html_url: 'https://github.com/Petgabs/HSC/commit/activity' } });
      return mockResponse(200, { sha: 'file-sha', content: base64Json(existing) });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await mergeAdminActivityIntoGitHub({
      owner: 'Petgabs', repo: 'HSC', token: 'admin-token',
      activity: {
        logins: [{ at: at(0, 8), user: 'hsc-admin' }],
        uploads: [{ at: at(0, 9), path: 'apps/Notes.pdf', name: 'Notes.pdf', bytes: 1024 }]
      }
    });

    expect(result).toMatchObject({ path: ADMIN_ACTIVITY_PATH, logins: 1, uploads: 1 });
    const putBody = JSON.parse(fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')[1].body);
    const written = JSON.parse(Buffer.from(putBody.content, 'base64').toString('utf8'));
    expect(written.path).toBeUndefined();
    expect(written.logins).toHaveLength(2);
    expect(written.logins[0].at).toBe(at(0, 8));
    expect(written.uploads).toHaveLength(1);
    expect(putBody.sha).toBe('file-sha');
  });

  it('refuses to write without a connected token', async () => {
    await expect(mergeAdminActivityIntoGitHub({ owner: 'Petgabs', repo: 'HSC', token: '', activity: {} }))
      .rejects.toThrow('Connect a GitHub token');
  });
});

describe('resolving file sizes and upload dates from GitHub', () => {
  it('reads sizes from the directory listing and dates from the commit history', async () => {
    const fetchMock = vi.fn(async url => {
      const target = String(url);
      if (target.includes('/contents/apps')) {
        return mockResponse(200, [
          { type: 'file', name: 'a.pdf', path: 'apps/a.pdf', size: 400, sha: 'sha-a' },
          { type: 'file', name: 'b.pdf', path: 'apps/b.pdf', size: 100, sha: 'sha-b' }
        ]);
      }
      // Newest commit first, oldest last: the upload date is the oldest one.
      return mockResponse(200, [
        { commit: { author: { date: at(0, 9) } } },
        { commit: { author: { date: at(-30, 9) } } }
      ]);
    });
    vi.stubGlobal('fetch', fetchMock);

    const details = await readCloudFileDetails({
      owner: 'Petgabs', repo: 'HSC', paths: ['apps/a.pdf', 'apps/b.pdf'],
      knownDates: { 'apps/b.pdf': at(-5) }, spacingMs: 0
    });

    expect(details.sizes).toEqual({ 'apps/a.pdf': 400, 'apps/b.pdf': 100 });
    expect(details.addedAt['apps/a.pdf']).toBe(at(-30, 9));
    // A cached date costs no request.
    expect(details.addedAt['apps/b.pdf']).toBe(at(-5));
    expect(details.dateLookups).toBe(1);
    const commitCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('/commits?'));
    expect(commitCalls).toHaveLength(1);
  });

  it('reports a blocked GitHub API instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse(403, { message: 'rate limited' })));
    const details = await readCloudFileDetails({ owner: 'Petgabs', repo: 'HSC', paths: ['apps/a.pdf'] });
    expect(details.sizes).toEqual({});
    expect(details.warnings.length).toBeGreaterThan(0);
  });
});

describe('dashboard wiring for storage and sign-in statistics', () => {
  it('shows file sizes, total used, available space and days stored', async () => {
    const [html, app, config] = await Promise.all([
      read('../index.html'), read('../assets/js/app.js'), read('../assets/js/config.js')
    ]);
    expect(html).toContain('id="cloud-storage-heading"');
    expect(html).toContain('Total size used');
    expect(html).toContain('Available in cloud');
    expect(html).toContain('Cloud allowance');
    expect(html).toContain('id="cloud-inventory-heading"');
    expect(html).toContain('File size &amp; storage age');
    expect(html).toContain('Days in cloud');
    expect(html).toContain('x-text="sizeLabel(app)"');
    expect(html).toContain('x-text="sizeLabel(resource)"');
    expect(html).toContain('storedAgeShort(app)');
    expect(html).toContain('@click="refreshCloudFileDetails()"');
    // The allowance is configuration, not a hard-coded number in the markup.
    expect(config).toContain('quotaBytes: 1_000_000_000');
    expect(config).toContain('storage');
    expect(app).toContain('cloudStorageStatistics');
    expect(app).toContain('storageSummary');
    expect(app).toContain('readCloudFileDetails');
    expect(app).toContain('storedAgeLabel');
  });

  it('records sign-ins and uploads, and reports today, week, month and the latest', async () => {
    const [html, app, worker, activity] = await Promise.all([
      read('../index.html'), read('../assets/js/app.js'), read('../sw.js'),
      read('../stats/admin-activity.json')
    ]);
    expect(html).toContain('id="admin-signins-heading"');
    expect(html).toContain('>Today<');
    expect(html).toContain('This week');
    expect(html).toContain('This month');
    expect(html).toContain('Latest administrator sign-in');
    expect(html).toContain('id="latest-uploads-heading"');
    expect(html).toContain('Latest uploaded files');
    expect(html).toContain('x-text="adminLoginStats.today"');
    expect(html).toContain('x-text="adminLoginStats.week"');
    expect(html).toContain('x-text="adminLoginStats.month"');
    expect(html).toContain('@click="syncAdminActivityFromButton()"');
    // A successful sign-in and a successful publish both write the record.
    expect(app).toMatch(/recordAdminLogin\(\);\s*\n\s*this\.openDashboard\(\)/);
    expect(app).toContain('this.recordAdminUpload(item');
    expect(app).toContain('mergeAdminActivityIntoGitHub');
    expect(app).toContain('adminLoginStatistics');
    expect(app).toContain('ADMIN_ACTIVITY_PATH');
    // The record ships with the upload history and travels with the site.
    const record = JSON.parse(activity);
    expect(record.logins).toEqual([]);
    expect(record.uploads.length).toBeGreaterThan(0);
    for (const entry of record.uploads) {
      expect(entry.path).toMatch(/^apps\/[^/]+$/);
      expect(entry.bytes).toBeGreaterThan(0);
    }
    expect(worker).toContain("'./assets/js/lib/adminActivity.js'");
    expect(worker).toContain('/stats/admin-activity.json');
  });

  it('keeps a per-file byte count in library.json for every published file', async () => {
    const [library, names] = await Promise.all([
      read('../library.json'), readdir(new URL('../apps/', import.meta.url))
    ]);
    const metadata = JSON.parse(library);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const entry = metadata[`apps/${name}`];
      expect(entry, `library.json is missing metadata for ${name}`).toBeTruthy();
      expect(entry.bytes).toBeGreaterThan(0);
    }
  });
});
