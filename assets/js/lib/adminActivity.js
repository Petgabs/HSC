/**
 * Administrator activity record for a static site.
 *
 * GitHub Pages has no server and no database, so "how many times did an
 * administrator sign in today / this week / this month, and which files were
 * uploaded" needs a record that travels with the website. The dashboard keeps
 * one small JSON document in the repository (`stats/admin-activity.json`):
 *
 *   {
 *     updatedAt: "...",
 *     logins:  [{ at, user }],
 *     uploads: [{ at, path, name, title, bytes, subject, years, owner }]
 *   }
 *
 * The administrator's browser appends to it through the GitHub Contents API
 * whenever publishing is connected; every other computer then sees the same
 * numbers after the next read. A device that cannot write to GitHub right away
 * keeps its entries in local storage and flushes them on the next successful
 * connection, so a login is never lost just because the token was locked.
 *
 * Everything in this module is pure and defensive: the record is public
 * repository content and untrusted input, so malformed shapes degrade to an
 * empty record instead of throwing, every entry is sanitized and bounded, and
 * merges are de-duplicated by key. No names, accounts, devices, IP addresses
 * or locations are ever recorded beyond the administrator username that is
 * already public in `config.js`.
 */

/** Repository path of the durable administrator activity record. */
export const ADMIN_ACTIVITY_PATH = 'stats/admin-activity.json';

/** Maximum entries kept per list, newest first, so the file stays tiny. */
export const ADMIN_ACTIVITY_LIMIT = 400;

/** Days shown in the dashboard sign-in mini chart. */
export const ADMIN_ACTIVITY_SERIES_DAYS = 14;

/** The rolling windows the dashboard reports: today, a week, a month. */
export const ADMIN_ACTIVITY_WINDOWS = Object.freeze({ week: 7, month: 30 });

const MAX_USER_LENGTH = 64;
const MAX_TITLE_LENGTH = 160;
const MAX_SUBJECT_LENGTH = 60;
const MAX_OWNER_LENGTH = 80;

export const ADMIN_ACTIVITY_COMMENT = [
  'Durable record of administrator sign-ins and published uploads.',
  'Written by the administrator dashboard through the GitHub Contents API and',
  'served to every device with the website, so sign-in and upload statistics',
  'survive a cleared browser and appear on any computer.',
  'Shape: { updatedAt, logins: [{ at, user }], uploads: [{ at, path, name, title, bytes, subject, years, owner }] }.',
  'Newest first, capped, and merged by timestamp — a repeated save can never',
  'double-count a sign-in or an upload. No device, network or personal data is',
  'stored here; the username is already public in assets/js/config.js.'
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value, maxLength = 0) {
  const text = String(value ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return maxLength > 0 ? text.slice(0, maxLength) : text;
}

function safeBytes(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function safeYears(value) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list
    .map(Number)
    .filter(year => Number.isInteger(year) && year >= 7 && year <= 13))]
    .sort((left, right) => left - right);
}

/** A timestamp that can be trusted, as an ISO string; '' when unusable. */
export function safeActivityAt(value) {
  const timestamp = typeof value === 'number' ? value : Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) return '';
  try {
    return new Date(timestamp).toISOString();
  } catch {
    return '';
  }
}

export function emptyAdminActivity() {
  return { updatedAt: '', logins: [], uploads: [] };
}

/** Normalize one `{ at, user }` sign-in entry (or null when unusable). */
export function normalizeLoginEntry(entry) {
  if (!isPlainObject(entry)) return null;
  const at = safeActivityAt(entry.at);
  if (!at) return null;
  return { at, user: safeString(entry.user, MAX_USER_LENGTH) };
}

/** Normalize one upload entry (or null when unusable). */
export function normalizeUploadEntry(entry) {
  if (!isPlainObject(entry)) return null;
  const at = safeActivityAt(entry.at);
  if (!at) return null;
  const path = safeString(entry.path, 200);
  const name = safeString(entry.name, 200) || path.split('/').pop() || '';
  if (!name && !path) return null;
  return {
    at,
    path: /^apps\/[^/]+$/.test(path) ? path : '',
    name,
    title: safeString(entry.title, MAX_TITLE_LENGTH) || name,
    bytes: safeBytes(entry.bytes),
    subject: safeString(entry.subject, MAX_SUBJECT_LENGTH),
    years: safeYears(entry.years),
    owner: safeString(entry.owner, MAX_OWNER_LENGTH)
  };
}

/**
 * Normalize the whole record. Anything malformed becomes an empty, well-shaped
 * record so a bad file can never break the dashboard.
 */
export function normalizeAdminActivity(data) {
  const empty = emptyAdminActivity();
  if (!isPlainObject(data)) return empty;
  const logins = (Array.isArray(data.logins) ? data.logins : [])
    .map(normalizeLoginEntry)
    .filter(Boolean);
  const uploads = (Array.isArray(data.uploads) ? data.uploads : [])
    .map(normalizeUploadEntry)
    .filter(Boolean);
  return {
    updatedAt: safeActivityAt(data.updatedAt) || '',
    logins: sortEntriesDescending(logins),
    uploads: sortEntriesDescending(uploads)
  };
}

function entryTimestamp(entry) {
  const timestamp = Date.parse(String(entry?.at || ''));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function sortEntriesDescending(entries) {
  return [...entries].sort((left, right) => entryTimestamp(right) - entryTimestamp(left));
}

/** Stable identity used to merge records without double-counting an entry. */
export function activityEntryKey(kind, entry) {
  if (kind === 'login') {
    return `login|${safeActivityAt(entry?.at)}|${safeString(entry?.user, MAX_USER_LENGTH).toLowerCase()}`;
  }
  return `upload|${safeActivityAt(entry?.at)}|${safeString(entry?.path || entry?.name, 200).toLowerCase()}`;
}

function dedupeAndCap(entries, kind, limit = ADMIN_ACTIVITY_LIMIT) {
  const seen = new Set();
  const result = [];
  for (const entry of sortEntriesDescending(entries)) {
    const key = activityEntryKey(kind, entry);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
    if (result.length >= limit) break;
  }
  return result;
}

/**
 * Merge any number of activity records (or raw objects) into one, newest
 * first, without duplicates. This is what keeps a device's queue and the
 * repository copy consistent no matter how often either is written.
 */
export function mergeAdminActivity(...sources) {
  const logins = [];
  const uploads = [];
  let updatedAt = '';
  for (const source of sources.flat()) {
    const normalized = normalizeAdminActivity(source);
    logins.push(...normalized.logins);
    uploads.push(...normalized.uploads);
    if (entryTimestamp({ at: normalized.updatedAt }) > entryTimestamp({ at: updatedAt })) updatedAt = normalized.updatedAt;
  }
  return {
    updatedAt,
    logins: dedupeAndCap(logins, 'login'),
    uploads: dedupeAndCap(uploads, 'upload')
  };
}

/** Add (or refresh) one sign-in entry, returning a new record. */
export function withAdminLogin(activity, entry) {
  const normalized = normalizeLoginEntry(entry);
  if (!normalized) return normalizeAdminActivity(activity);
  return mergeAdminActivity(activity, { logins: [normalized], uploads: [] });
}

/** Add (or refresh) one upload entry, returning a new record. */
export function withAdminUpload(activity, entry) {
  const normalized = normalizeUploadEntry(entry);
  if (!normalized) return normalizeAdminActivity(activity);
  return mergeAdminActivity(activity, { logins: [], uploads: [normalized] });
}

/** Local calendar day key (`YYYY-MM-DD`) for a timestamp. */
export function localDayKey(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(Number.isFinite(Number(value)) ? Number(value) : String(value || ''));
  if (!Number.isFinite(date.getTime())) return '';
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

function startOfLocalDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function shiftDays(timestamp, days) {
  const date = new Date(timestamp);
  date.setDate(date.getDate() + days);
  return date.getTime();
}

/**
 * Sign-in statistics for the dashboard: how many administrator sign-ins
 * happened today, in the last seven days and in the last thirty days, when the
 * newest one was, and a per-day series for the mini chart.
 *
 * "Today" means the local calendar day, so the numbers match the clock on the
 * administrator's own computer.
 */
export function adminLoginStatistics(activity, now = Date.now(), {
  seriesDays = ADMIN_ACTIVITY_SERIES_DAYS,
  windows = ADMIN_ACTIVITY_WINDOWS
} = {}) {
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const logins = normalizeAdminActivity(activity).logins;
  const todayStart = startOfLocalDay(nowMs);
  const windowStarts = {
    today: todayStart,
    week: shiftDays(todayStart, -(Math.max(1, windows.week) - 1)),
    month: shiftDays(todayStart, -(Math.max(1, windows.month) - 1))
  };

  const countSince = since => logins.filter(entry => entryTimestamp(entry) >= since).length;
  const lastLogin = logins[0] || null;
  const firstLogin = logins.length ? logins[logins.length - 1] : null;

  const days = Math.max(1, Math.min(90, Number(seriesDays) || ADMIN_ACTIVITY_SERIES_DAYS));
  const countsByDay = new Map();
  for (const entry of logins) {
    const key = localDayKey(entry.at);
    if (!key) continue;
    countsByDay.set(key, (countsByDay.get(key) || 0) + 1);
  }

  const perDay = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const dayStart = shiftDays(todayStart, -offset);
    const key = localDayKey(dayStart);
    const date = new Date(dayStart);
    perDay.push({
      day: key,
      label: date.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' }),
      shortLabel: date.toLocaleDateString('en-AU', { day: 'numeric', month: 'numeric' }),
      count: countsByDay.get(key) || 0,
      isToday: offset === 0
    });
  }

  const busiest = perDay.reduce((best, day) => (day.count > (best?.count || 0) ? day : best), null);
  const activeDays = perDay.filter(day => day.count > 0).length;
  const seriesTotal = perDay.reduce((sum, day) => sum + day.count, 0);

  return {
    today: countSince(windowStarts.today),
    week: countSince(windowStarts.week),
    month: countSince(windowStarts.month),
    total: logins.length,
    seriesTotal,
    activeDays,
    averagePerDay: Number((seriesTotal / days).toFixed(2)),
    busiestDay: busiest && busiest.count > 0 ? busiest : null,
    lastLoginAt: lastLogin?.at || '',
    lastLoginUser: lastLogin?.user || '',
    firstLoginAt: firstLogin?.at || '',
    perDay
  };
}

/** Newest sign-ins first, ready for a list in the dashboard. */
export function recentAdminLogins(activity, limit = 6) {
  const count = Math.max(0, Number(limit) || 0);
  return normalizeAdminActivity(activity).logins.slice(0, count);
}

/** Newest uploads first, ready for a list in the dashboard. */
export function recentAdminUploads(activity, limit = 8) {
  const count = Math.max(0, Number(limit) || 0);
  return normalizeAdminActivity(activity).uploads.slice(0, count);
}

/** Whole days a file has been stored in the cloud (0 on upload day). */
export function storedDays(addedAt, now = Date.now()) {
  const timestamp = Date.parse(String(addedAt || ''));
  if (!Number.isFinite(timestamp)) return null;
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  return Math.max(0, Math.floor((nowMs - timestamp) / 86_400_000));
}

/** Human wording for `storedDays`, including the unknown case. */
export function formatStoredDays(days) {
  if (!Number.isFinite(Number(days)) || days === null || days === '') return 'Storage age unknown';
  const value = Math.max(0, Math.floor(Number(days)));
  if (value === 0) return 'Stored today';
  if (value === 1) return '1 day in the cloud';
  if (value < 31) return `${value} days in the cloud`;
  const months = Math.floor(value / 30);
  if (value < 365) return `${value} days (~${months} month${months === 1 ? '' : 's'}) in the cloud`;
  const years = (value / 365).toFixed(1);
  return `${value} days (~${years} years) in the cloud`;
}

/**
 * Per-file storage rows for the cloud inventory table: the file's size and how
 * long it has been stored, joined with live download totals. Files whose size
 * is not recorded anywhere are reported as unknown rather than as zero, so the
 * totals stay honest.
 */
export function cloudFileInventory(items, { now = Date.now(), downloadsOf = () => 0 } = {}) {
  return (Array.isArray(items) ? items : [])
    .map(item => {
      const bytes = Number(item?.size) || 0;
      const addedAt = String(item?.addedAt || item?.meta?.addedAt || '');
      const days = storedDays(addedAt, now);
      return {
        id: String(item?.id || item?.path || item?.fileName || ''),
        name: String(item?.name || item?.fileName || ''),
        fileName: String(item?.fileName || ''),
        path: String(item?.path || ''),
        subject: String(item?.meta?.subject || ''),
        extension: String(item?.fileName || '').split('.').pop().toLowerCase(),
        bytes,
        sizeKnown: bytes > 0,
        addedAt,
        storedDays: days,
        storedLabel: formatStoredDays(days),
        downloads: Number(downloadsOf(item)) || 0,
        source: String(item?.source || '')
      };
    })
    .sort((left, right) => (right.bytes || 0) - (left.bytes || 0) || left.name.localeCompare(right.name));
}

/**
 * Cloud storage totals against the hosting allowance: how much the published
 * files use, how much room is left, and how full the allowance is.
 *
 * `quotaBytes` of 0 means "no allowance is configured", so the remaining
 * figure is reported as unknown instead of inventing a number.
 */
export function storageSummary({ items = [], quotaBytes = 0, now = Date.now(), downloadsOf = () => 0 } = {}) {
  const files = cloudFileInventory(items, { now, downloadsOf });
  const quota = Math.max(0, Number(quotaBytes) || 0);
  const usedBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const knownSizeCount = files.filter(file => file.sizeKnown).length;
  const unknownSizeCount = files.length - knownSizeCount;
  const availableBytes = quota > 0 ? Math.max(0, quota - usedBytes) : 0;
  const percentUsed = quota > 0 ? Math.min(100, Math.round((usedBytes / quota) * 1000) / 10) : 0;
  const largest = files.reduce((best, file) => (file.bytes > (best?.bytes || 0) ? file : best), null);
  const oldest = files.reduce((best, file) => {
    if (file.storedDays === null) return best;
    if (!best || best.storedDays === null) return file;
    return file.storedDays > best.storedDays ? file : best;
  }, null);

  return {
    usedBytes,
    quotaBytes: quota,
    availableBytes,
    hasQuota: quota > 0,
    overQuota: quota > 0 && usedBytes > quota,
    percentUsed,
    fileCount: files.length,
    knownSizeCount,
    unknownSizeCount,
    averageBytes: knownSizeCount > 0 ? Math.round(usedBytes / knownSizeCount) : 0,
    newestFile: files.slice().sort((left, right) => entryTimestamp({ at: right.addedAt }) - entryTimestamp({ at: left.addedAt }))[0] || null,
    largestFile: largest?.bytes ? largest : null,
    oldestFile: oldest,
    files
  };
}
