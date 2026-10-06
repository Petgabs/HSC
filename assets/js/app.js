import Alpine from '../vendor/alpine.esm.js';
import {
  SITE_CONFIG, SUBJECTS, YEAR_LEVELS,
  applyAdminGate, applyMasterGate, gateSignature, readAdminGate, readMasterGate
} from './config.js';
import { AbacusCounters, claimSessionCounterHit, downloadCounterKey, downloadsFromRecord, maxCounter, normalizeStatsRecord, readLocalCounter, writeLocalCounter } from './lib/counters.js';
import {
  clearTokenVaultOnGitHub, deleteResourceFromGitHub, mergeAdminActivityIntoGitHub,
  readCloudFileDetails, readPublicRepositoryFiles, readTokenVaultFromGitHub,
  removeDownloadStatsForPath, saveAdminCredentialsToGitHub, saveDownloadStatsToGitHub,
  savePublishingTokenToGitHub, saveTokenVaultToGitHub, uploadResourceToGitHub, verifyGitHubToken
} from './lib/githubPublish.js';
import {
  ADMIN_ACTIVITY_PATH, ADMIN_ACTIVITY_SERIES_DAYS, activityEntryKey, adminLoginStatistics,
  emptyAdminActivity, formatStoredDays, mergeAdminActivity, normalizeAdminActivity,
  normalizeLoginEntry, normalizeUploadEntry, recentAdminLogins, recentAdminUploads,
  storageSummary, storedDays, withAdminLogin, withAdminUpload
} from './lib/adminActivity.js';
import {
  TOKEN_VAULT_PATH, TOKEN_VAULT_SLOT_LABELS, createTokenVault, describeTokenVault,
  isTokenVault, openTokenVault, tokenVaultSlotIsStale, tokenVaultSlots
} from './lib/tokenVault.js';
import { inferMetadata, isSupportedFile, metadataFromLibrary, normalizeLibraryEntry } from './lib/metadata.js';
import { searchResources, sortResources } from './lib/search.js';
import {
  fileExtension, fileIcon, formatBytes, formatCount, formatDate, formatDateTime,
  formatDownloadCount, formatRelativeTime, formatYears, freshness, isReviewDue,
  kindLabel, subjectAccent, visibilityAccent, visibilityLabel
} from './lib/format.js';
import { canPreviewItem, previewDescriptor } from './lib/preview.js';
import { ADMIN_ACTION_LIMITS, RateLimiter, createExclusiveRunner, formatRetryAfter } from './lib/guard.js';
import {
  AdminPresenceBeacon, PRESENCE_BUCKET_MS, PRESENCE_WINDOW_MS, describePresence, localPresenceIsLive,
  presenceBucketIndex
} from './lib/presence.js';
import { interfaceModeForViewport } from './lib/responsive.js';
import {
  findDigestMatch, formatDigest, inspectUpload, readFileBytes, sha256Hex as sha256HexBytes, suggestAvailableFileName
} from './lib/uploadSafety.js';

const LEGACY_TOKEN_KEYS = [
  'schoolcloud.githubToken', 'schoolCloud.githubToken', 'schoolcloud.github-token',
  'school-cloud.github-token', 'githubAutoPublishToken', 'githubToken', 'github_token',
  'github-token', 'hsc.github.token', 'cloudToken'
];
const ADMIN_LOGIN_SESSION_KEY = 'schoolcloud.admin.signed-in.v1';
// The verified administrator token is remembered on this device so the
// dashboard never asks for it twice. It survives sign-out, reloads and new
// tabs; "Forget token on this device" (or Clear local settings) removes it.
const SAVED_TOKEN_STORAGE_KEY = 'schoolcloud.github.token.v1';
// The same verified token is also stored *in the website* — encrypted into
// assets/data/publish-token.json — so signing in on any other computer
// reconnects publishing without pasting the token again. This preference
// controls whether a save does that; it is a convenience setting only and
// never holds a credential itself.
const STORE_TOKEN_ON_WEBSITE_KEY = 'schoolcloud.github.token.website.v1';
// A credential rotated in Cloud Settings is committed to assets/js/config.js
// on GitHub. Until GitHub Pages deploys that commit, this device remembers the
// new credential so the change is usable straight away; the copy is dropped as
// soon as the deployed config file changes.
const SAVED_ADMIN_CREDENTIALS_KEY = 'schoolcloud.admin.credentials.v1';
const LIBRARY_CACHE_STORAGE_KEY = 'schoolcloud.library.snapshot.v1';
const LIBRARY_CACHE_VERSION = 1;
// Administrator sign-ins and uploads are recorded in the repository so they
// appear on every computer. The same-device copies below keep the dashboard
// accurate instantly, survive a reload, and hold entries that could not be
// written yet (for example while the publishing token is still locked).
const ADMIN_ACTIVITY_STORAGE_KEY = 'schoolcloud.admin.activity.v1';
const ADMIN_ACTIVITY_PENDING_KEY = 'schoolcloud.admin.activity.pending.v1';
// Upload dates resolved from GitHub's commit history are cached so the API is
// asked once per file, not on every dashboard visit.
const CLOUD_FILE_DATES_STORAGE_KEY = 'schoolcloud.cloud.file-dates.v1';
const CLOUD_FILE_DATE_LOOKUP_BUDGET = 12;
const VALID_YEAR_LEVELS = new Set(YEAR_LEVELS.map(String));
const MAX_DESCRIPTION_LENGTH = 3000;
const MIN_PASSWORD_LENGTH = 8;
const USERNAME_PATTERN = /^[A-Za-z0-9._@+-]{3,64}$/;
const FETCH_RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const FETCH_RETRY_DELAYS_MS = [350, 900];
const CRASH_NOTICE_THROTTLE_MS = 10_000;
// Presence: one heartbeat per minute, and a fresh read at most every 30
// seconds. Together that keeps the shared counter traffic tiny while the
// indicator stays live.
const PRESENCE_HEARTBEAT_MS = PRESENCE_BUCKET_MS;
const PRESENCE_REFRESH_MS = 30_000;
// After this long an upload is clearly not instant, so the dialog explains
// that a large file over a school connection simply takes a while.
const UPLOAD_SLOW_NOTICE_MS = 12_000;
const UPLOAD_STAGE_LABELS = Object.freeze({
  checking: 'Checking GitHub',
  reading: 'Reading the file',
  encoding: 'Preparing the upload',
  uploading: 'Uploading to GitHub',
  recovering: 'Confirming an interrupted upload',
  metadata: 'Recording library metadata',
  verifying: 'Verifying the published file',
  done: 'Published'
});

function parseRepoName(value, fallbackOwner, fallbackName) {
  const match = String(value || '').trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) return { owner: fallbackOwner, name: fallbackName };
  return { owner: match[1], name: match[2] };
}

function emptyDraft() {
  return {
    title: '', description: '', topic: '', subject: '', years: '',
    owner: '', department: '', academicYear: String(new Date().getFullYear()),
    keywords: '', resourceType: '', language: 'English', visibility: 'public',
    version: '1.0', reviewDate: '', licence: '', accessibility: ''
  };
}

function emptyIntegrityReport() {
  return {
    status: 'ok', statusLabel: 'Ready', issues: [],
    counts: { publishedFiles: 0, metadataEntries: 0, queueEntries: 0, errors: 0, warnings: 0 }
  };
}

function safeStorageRemove(storage, key) {
  try { storage?.removeItem(key); } catch { /* Storage can be disabled. */ }
}

function safeStorageGet(storage, key) {
  try { return storage?.getItem(key) ?? null; } catch { return null; }
}

function safeStorageSet(storage, key, value) {
  try { storage?.setItem(key, value); return true; } catch { return false; }
}

function isTransientNetworkError(error) {
  return error?.name === 'AbortError' || /network|fetch|timeout|offline|failed to fetch/i.test(String(error?.message || error));
}

function resolveFileUrl(item) {
  const candidate = item?.downloadUrl || item?.url || item?.path;
  if (!candidate) return '';
  try {
    const url = new URL(candidate, globalThis.location?.href || 'https://schoolcloud.invalid/');
    const sameOrigin = Boolean(globalThis.location && url.origin === globalThis.location.origin);
    const allowedRemote = url.protocol === 'https:' && (
      url.hostname === 'raw.githubusercontent.com' ||
      url.hostname === 'github.com' ||
      url.hostname.endsWith('.github.io')
    );
    const allowed = (sameOrigin && ['http:', 'https:'].includes(url.protocol)) || allowedRemote;
    return allowed ? url.href : '';
  } catch {
    return '';
  }
}

function titleFromFilename(filename) {
  return String(filename || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function digestHex(buffer) {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle) throw new Error('Secure password checking is not available in this browser.');
  const data = new TextEncoder().encode(value);
  return digestHex(await crypto.subtle.digest('SHA-256', data));
}

async function verifyConfiguredAdmin(username, password) {
  const configured = SITE_CONFIG.admin;
  if (!configured?.username || !configured?.salt || !configured?.passwordHash) {
    return { ok: false, configurationMissing: true };
  }
  const usernameMatches = String(username).trim() === configured.username;
  const candidate = await sha256Hex(`${configured.salt}:${password}`);
  const expected = String(configured.passwordHash).trim().toLowerCase();
  return { ok: usernameMatches && candidate === expected, configurationMissing: false };
}

/**
 * Check the master password that opens Cloud Settings. Same scheme as the
 * sign-in gate: a salt plus the SHA-256 digest of `<salt>:<password>`, never
 * the plain password.
 */
async function verifyConfiguredMaster(password) {
  const configured = readMasterGate();
  if (!configured?.salt || !configured?.passwordHash) {
    return { ok: false, configurationMissing: true };
  }
  const candidate = await sha256Hex(`${configured.salt}:${password}`);
  const expected = String(configured.passwordHash).trim().toLowerCase();
  return { ok: candidate === expected, configurationMissing: false };
}

/** Fresh 32-character hex salt for a rotated password. */
function randomSaltHex() {
  if (!globalThis.crypto?.getRandomValues) throw new Error('This browser cannot generate a secure password salt.');
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return digestHex(bytes);
}

function hashPasswordWithSalt(salt, password) {
  return sha256Hex(`${salt}:${password}`);
}

function emptyAdminAccountForm() {
  return { username: '', password: '', confirmPassword: '', masterPassword: '', confirmMasterPassword: '' };
}

function clipboardWrite(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const input = document.createElement('textarea');
  input.value = text;
  input.setAttribute('readonly', '');
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.append(input);
  input.select();
  const ok = document.execCommand('copy');
  input.remove();
  return ok ? Promise.resolve() : Promise.reject(new Error('Clipboard access was denied.'));
}

function buildCounterClient() {
  try {
    return new AbacusCounters({
      baseUrl: SITE_CONFIG.abacus.baseUrl,
      namespace: SITE_CONFIG.abacus.namespace
    });
  } catch {
    return null;
  }
}

function calculateAgeDays(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? Math.max(0, (Date.now() - timestamp) / 86_400_000) : Infinity;
}

function makeDraftPreview(file) {
  if (!file || !['.pdf', '.html', '.htm'].includes(`.${fileExtension(file.name).toLowerCase()}`)) return null;
  try {
    const src = URL.createObjectURL(file);
    const isHtml = ['HTML', 'HTM'].includes(fileExtension(file.name));
    return {
      src,
      sandbox: isHtml ? 'allow-scripts allow-forms' : 'allow-downloads',
      label: `${isHtml ? 'HTML' : 'PDF'} preview of ${file.name}`
    };
  } catch {
    return null;
  }
}

function bytesToFileName(file) {
  return String(file?.name || '').normalize('NFC').trim();
}

function countBy(items, selector) {
  const counts = new Map();
  for (const item of items) {
    const value = selector(item);
    if (value === undefined || value === null || value === '') continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return counts;
}

function currentYearAcademicOptions() {
  const year = new Date().getFullYear();
  return [`${year}`, `${year - 1}/${year}`, `${year}/${year + 1}`];
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isRetryableHttpStatus(status) {
  return FETCH_RETRYABLE_STATUSES.has(Number(status) || 0);
}

function normalizeCachedLibrarySnapshot(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (!Array.isArray(data.manifest)) return null;
  const library = data.library && typeof data.library === 'object' && !Array.isArray(data.library) ? data.library : {};
  const stats = data.stats && typeof data.stats === 'object' && !Array.isArray(data.stats) ? data.stats : null;
  return {
    version: Number(data.version) || 0,
    savedAt: typeof data.savedAt === 'string' ? data.savedAt : '',
    manifest: data.manifest,
    library,
    stats
  };
}

function schoolCloud() {
  return {
    currentView: 'library',
    interfaceMode: 'desktop',
    isAdmin: false,
    showLogin: false,
    loginMode: 'admin',
    loginForm: { username: '', password: '' },
    checkingLogin: false,
    loginError: '',
    loginConfigMissing: !SITE_CONFIG.admin.username || !SITE_CONFIG.admin.passwordHash || !SITE_CONFIG.admin.salt,
    studentGreeting: 'Welcome',
    offline: !navigator.onLine,
    refreshingSite: false,
    showFilters: true,
    filters: { query: '', kind: '', subject: '', year: '', sort: 'newest' },
    errors: { library: '', preview: '' },
    loading: { library: true, preview: false },
    usingCachedLibrary: false,
    libraryCacheSavedAt: '',
    libraryItems: [],
    libraryMetadata: {},
    metadataEntries: 0,
    dataLoadError: '',
    stats: {
      visitors: 0,
      loadingVisitors: true,
      downloads: {},
      loadingDownloads: true,
      online: false,
      backend: 'local',
      updatedAtLabel: 'Not yet refreshed',
      recordUpdatedAt: ''
    },
    downloadStatsRecord: null,
    statsSyncing: false,
    // Administrator sign-in and upload history, plus the cloud-storage facts
    // (size and age of every published file) the dashboard reports.
    adminActivity: emptyAdminActivity(),
    adminActivityStatus: {
      loading: true, syncing: false, source: 'local', error: '',
      githubUpdatedAt: '', pendingCount: 0
    },
    cloudDetails: { refreshing: false, refreshedAt: '', message: '', error: '' },
    storageQuotaBytes: Math.max(0, Number(SITE_CONFIG.storage?.quotaBytes) || 0),
    storageQuotaLabel: SITE_CONFIG.storage?.label || 'Cloud allowance',
    storageQuotaNote: SITE_CONFIG.storage?.note || '',
    githubConfig: {
      repo: `${SITE_CONFIG.repository.owner}/${SITE_CONFIG.repository.name}`,
      branch: SITE_CONFIG.repository.branch
    },
    githubAuth: {
      token: '',
      activeToken: '',
      connected: false,
      login: '',
      showToken: false,
      verifying: false,
      cloudSecretSaved: false,
      cloudSecretAlreadySaved: false,
      remembered: false,
      error: '',
      // Store the token in the website itself (encrypted) as well as on this
      // device, so other computers inherit it after signing in.
      storeOnWebsite: true,
      website: {
        status: 'unknown',
        saved: false,
        savedAt: '',
        slots: [],
        stale: false,
        busy: false,
        message: '',
        commitUrl: ''
      }
    },
    syncing: false,
    deletingAppId: '',
    dashboardResourceQuery: '',
    dashboardResourceType: 'all',
    statsAgeBucketOpen: '',
    statsCleanupMinAgeDays: 365,
    statsCleanupMaxDownloads: 3,
    ageBuckets: ['recent', 'quarter', 'half-year', 'year-plus'],
    ageBucketLabels: {
      recent: 'Last 30 days', quarter: '31–90 days',
      'half-year': '91–180 days', 'year-plus': 'More than 180 days'
    },
    draft: emptyDraft(),
    draftFile: null,
    draftFilePreview: null,
    draftErrors: { file: '', title: '', subject: '', years: '', owner: '' },
    uploadMessage: '',
    uploadMessageTone: 'info',
    submitting: false,
    // Upload progress and the safety report for the chosen file. The
    // administrator always sees which step is running, how far it has got and
    // what was inspected, so a slow connection is never mistaken for a hang.
    uploadStage: '',
    uploadStageLabel: '',
    uploadPercent: 0,
    uploadDetail: '',
    uploadElapsedSeconds: 0,
    uploadChecks: [],
    uploadWarnings: [],
    uploadResult: null,
    uploadAcknowledgedWarnings: false,
    uploadVerify: true,
    // Live administrator presence: time-bucket heartbeats only, never a name.
    presence: {
      live: false, unknown: true, label: 'Checking…',
      detail: 'Checking whether an administrator is online…',
      tone: 'unknown', checkedAt: 0, lastSeenAt: 0, source: ''
    },
    rateLimit: { blocked: {}, message: '', tone: 'info' },
    verifyingAppId: '',
    formOptions: {
      subjects: [...SUBJECTS],
      yearLevels: YEAR_LEVELS.map(String),
      departments: [...SUBJECTS],
      resourceTypes: ['Worksheet', 'Notes', 'Revision', 'Assessment', 'Interactive mini app', 'Other'],
      languages: ['English', 'Arabic', 'Bengali', 'Chinese', 'Hindi', 'Other'],
      visibilities: [
        { value: 'public', label: 'Public', hint: 'Available to anyone with the website link.' },
        { value: 'school', label: 'School only', hint: 'This is a label only; public-site files are not access restricted.' },
        { value: 'class', label: 'Class only', hint: 'This is a label only; public-site files are not access restricted.' }
      ],
      licences: ['All rights reserved', 'Creative Commons BY', 'Creative Commons BY-SA', 'Public domain', 'Permission granted']
    },
    academicYears: currentYearAcademicOptions(),
    preview: { open: false, item: null, descriptor: null, objectUrl: '' },
    toast: { message: '', tone: 'info', visible: false },
    _toastTimer: null,
    _counterClient: buildCounterClient(),
    _visitorOnline: false,
    _visitorSessionCounted: false,
    _visitorCountPromise: null,
    _downloadCountersOnline: false,
    _counterReadStarted: [],
    _counterReadInFlight: [],
    _counterReadAt: {},
    _loadSequence: 0,
    _loadPromise: null,
    _limiter: new RateLimiter({ limits: ADMIN_ACTION_LIMITS }),
    _exclusive: createExclusiveRunner(),
    _presenceBeacon: null,
    _presenceTimer: null,
    _presenceHeartbeatTimer: null,
    _presenceReadAt: 0,
    _presenceReadPromise: null,
    _rateLimitTimer: null,
    _uploadUnloadHandler: null,
    _uploadSlowTimer: null,
    _uploadStartedAt: 0,
    _inspectSequence: 0,
    _draftBytes: null,
    _draftDigest: '',
    _initialized: false,
    // The administrator passwords typed during this visit. They stay in memory
    // for this page only — never in storage, never in a repository file — and
    // are what locks and unlocks the encrypted token stored in the website.
    _sessionSecrets: { admin: '', master: '' },
    _websiteVault: null,
    _websiteTokenPromise: null,
    _lastCrashNoticeAt: 0,
    _dismissedIntegrityIssueIds: [],
    localDrafts: [],
    adminAccount: {
      unlocked: false,
      checking: false,
      unlockAttempt: 0,
      saving: false,
      showMasterPassword: false,
      masterPassword: '',
      focusAccountOnUnlock: false,
      error: '',
      notice: '',
      noticeUrl: '',
      form: emptyAdminAccountForm()
    },
    integrityUi: {
      running: false,
      repairing: false,
      troubleshooterOpen: false,
      hideIssues: false,
      ranAt: null,
      summary: '',
      log: []
    },
    integrityReport: emptyIntegrityReport(),
    integrityDiagnosis: null,

    get isStaff() { return this.isAdmin; },
    get apps() { return this.libraryItems; },
    get miniApps() { return this.apps.filter(item => ['html', 'htm'].includes(fileExtension(item).toLowerCase())); },
    get resources() { return this.apps.filter(item => !['html', 'htm'].includes(fileExtension(item).toLowerCase())); },
    get localAppCount() { return this.localDrafts.length; },
    get cloudAppCount() { return this.apps.length; },
    get recentUploadCount() { return this.apps.filter(item => calculateAgeDays(item?.addedAt || item?.meta?.addedAt) <= 30).length; },
    get autoPublishReady() { return this.githubAuth.connected && Boolean(this.githubAuth.activeToken); },
    /** True once the website itself carries an encrypted copy of the token. */
    get websiteTokenSaved() { return Boolean(this.githubAuth.website.saved); },
    get websiteTokenStatusLabel() {
      const site = this.githubAuth.website;
      if (site.busy || site.status === 'saving') return 'Saving to the website…';
      if (site.status === 'checking') return 'Checking the website…';
      if (site.status === 'saved') return site.stale ? 'Saved — needs re-saving' : 'Stored in this website';
      if (site.status === 'locked') return 'Stored, but locked';
      if (site.status === 'error') return 'Website save failed';
      if (site.status === 'unavailable') return 'Not stored yet';
      if (site.status === 'missing') return 'Not stored in this website';
      return 'Not checked yet';
    },
    get websiteTokenStatusClass() {
      const site = this.githubAuth.website;
      if (site.status === 'saved' && !site.stale) return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
      if (site.status === 'error') return 'bg-rose-50 text-rose-700 ring-rose-200';
      if (['locked', 'saved', 'unavailable'].includes(site.status)) return 'bg-amber-50 text-amber-800 ring-amber-200';
      return 'bg-slate-100 text-slate-500 ring-slate-200';
    },
    get websiteTokenSlotLabel() {
      const slots = this.githubAuth.website.slots || [];
      if (!slots.length) return '';
      return slots.map(slot => TOKEN_VAULT_SLOT_LABELS[slot] || slot).join(' or the ');
    },
    /**
     * What to tell an administrator who tries to publish without a token.
     * When the website is carrying an encrypted copy, the answer is to unlock
     * it rather than to go and create another token.
     */
    get tokenMissingMessage() {
      if (this.githubAuth.website.status === 'locked' || this.githubAuth.website.saved) {
        return 'This website already stores your publishing token, but it is still locked on this computer. Open Cloud Settings, enter the master password, and publishing reconnects automatically.';
      }
      return 'Connect a GitHub Personal Access Token in Settings first. It needs Contents: Read and write access to this repository. Saving it there also stores it in the website, so other computers will not ask again.';
    },
    get adminPresenceLive() { return Boolean(this.presence.live); },
    get presenceDotClass() {
      if (this.presence.tone === 'online') return 'bg-emerald-500';
      if (this.presence.tone === 'unknown') return 'bg-slate-400';
      return 'bg-slate-300';
    },
    get presencePillClass() {
      if (this.presence.tone === 'online') return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
      if (this.presence.tone === 'unknown') return 'bg-slate-100 text-slate-500 ring-slate-200';
      return 'bg-slate-100 text-slate-500 ring-slate-200';
    },
    get uploadProgressLabel() {
      if (this.uploadStageLabel) return this.uploadStageLabel;
      return this.submitting ? 'Publishing…' : '';
    },
    get uploadNeedsAcknowledgement() {
      return this.uploadWarnings.length > 0 && !this.uploadAcknowledgedWarnings;
    },
    get uploadDigestLabel() {
      return this.uploadResult?.sha256 ? formatDigest(this.uploadResult.sha256, 16) : '';
    },
    get fingerprintedFileCount() {
      return this.apps.filter(item => String(item?.meta?.sha256 || '')).length;
    },
    get repositoryTarget() {
      return parseRepoName(this.githubConfig.repo, SITE_CONFIG.repository.owner, SITE_CONFIG.repository.name);
    },
    get hasActiveFilters() {
      return Boolean(this.filters.query || this.filters.kind || this.filters.subject || this.filters.year);
    },
    get yearLevels() { return [...YEAR_LEVELS]; },
    get subjectOptions() {
      const seen = new Set(this.apps.map(item => item.meta.subject).filter(Boolean));
      return [...seen].sort((a, b) => a.localeCompare(b));
    },
    get yearOptions() {
      const values = new Set(this.apps.flatMap(item => item.meta.years || []).map(Number));
      return [...values].sort((a, b) => a - b);
    },
    get facets() {
      const subjects = countBy(this.apps, item => item.meta.subject);
      const years = new Map();
      for (const item of this.apps) for (const year of item.meta.years || []) years.set(Number(year), (years.get(Number(year)) || 0) + 1);
      return { subjects, years, apps: this.miniApps.length, documents: this.resources.length };
    },
    get subjectShortcuts() {
      const popular = [...this.facets.subjects.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      return popular.map(([subject, count]) => ({ subject, count }));
    },
    sortByLiveState(items) {
      // `sortResources` works on stored fields only. The download totals live
      // in reactive counter state (Abacus / GitHub record / local fallback),
      // and the "Name (A–Z)" option maps to the shared title sort.
      if (this.filters.sort === 'downloads') {
        const title = item => String(item.name || item.fileName || '').toLocaleLowerCase('en-AU');
        return [...items].sort((a, b) =>
          this.downloadsOf(b) - this.downloadsOf(a) || title(a).localeCompare(title(b)));
      }
      return sortResources(items, this.filters.sort === 'name' ? 'title' : this.filters.sort);
    },
    get filteredMiniApps() {
      let result = searchResources(this.miniApps, this.filters.query);
      if (this.filters.kind === 'document') return [];
      if (this.filters.subject) result = result.filter(item => item.meta.subject === this.filters.subject);
      if (this.filters.year) result = result.filter(item => (item.meta.years || []).map(String).includes(String(this.filters.year)));
      return this.sortByLiveState(result);
    },
    get filteredResources() {
      let result = searchResources(this.resources, this.filters.query);
      if (this.filters.kind === 'app') return [];
      if (this.filters.subject) result = result.filter(item => item.meta.subject === this.filters.subject);
      if (this.filters.year) result = result.filter(item => (item.meta.years || []).map(String).includes(String(this.filters.year)));
      return this.sortByLiveState(result);
    },
    get resultCount() { return this.filteredMiniApps.length + this.filteredResources.length; },
    get filterSummary() {
      const parts = [];
      if (this.filters.kind) parts.push(this.filters.kind === 'app' ? 'Mini apps' : 'Documents');
      if (this.filters.subject) parts.push(this.filters.subject);
      if (this.filters.year) parts.push(`Year ${this.filters.year}`);
      if (this.filters.query) parts.push(`“${this.filters.query}”`);
      return parts.length ? `Filtered by ${parts.join(' · ')}` : 'All learning resources';
    },
    get latestCount() { return this.apps.filter(item => this.isLatest(item)).length; },
    get totalDownloads() { return Object.values(this.stats.downloads).reduce((sum, value) => sum + (Number(value) || 0), 0); },
    get rankedMiniApps() { return [...this.miniApps].sort((a, b) => this.downloadsOf(b) - this.downloadsOf(a)); },
    get topResources() { return [...this.apps].sort((a, b) => this.downloadsOf(b) - this.downloadsOf(a)).slice(0, 6); },
    get reviewDueApps() { return this.apps.filter(item => isReviewDue(item.meta.reviewDate)); },
    get dashboardResourceCounts() {
      const count = (fn) => this.resources.filter(fn).length;
      return {
        all: this.resources.length,
        pdf: count(item => fileExtension(item).toLowerCase() === 'pdf'),
        word: count(item => ['doc', 'docx'].includes(fileExtension(item).toLowerCase())),
        excel: count(item => ['xls', 'xlsx'].includes(fileExtension(item).toLowerCase())),
        ppt: count(item => ['ppt', 'pptx'].includes(fileExtension(item).toLowerCase())),
        cloud: count(item => item.source === 'github')
      };
    },
    get filteredDashboardResources() {
      let result = searchResources(this.resources, this.dashboardResourceQuery);
      const type = this.dashboardResourceType;
      if (type === 'pdf') result = result.filter(item => fileExtension(item).toLowerCase() === 'pdf');
      if (type === 'word') result = result.filter(item => ['doc', 'docx'].includes(fileExtension(item).toLowerCase()));
      if (type === 'excel') result = result.filter(item => ['xls', 'xlsx'].includes(fileExtension(item).toLowerCase()));
      if (type === 'ppt') result = result.filter(item => ['ppt', 'pptx'].includes(fileExtension(item).toLowerCase()));
      if (type === 'cloud') result = result.filter(item => item.source === 'github');
      return sortResources(result, 'title');
    },
    /**
     * Cloud storage measured against the hosting allowance: total size used by
     * every published file, the space still available, the allowance itself
     * and how full it is. `totalBytes`/`knownCount`/`unknownCount` keep their
     * original names for the existing cards.
     */
    get cloudStorageStatistics() {
      const files = this.apps.filter(item => item.source === 'github');
      const summary = storageSummary({
        items: files,
        quotaBytes: this.storageQuotaBytes,
        downloadsOf: item => this.downloadsOf(item)
      });
      const tone = summary.overQuota ? 'over' : summary.percentUsed >= 90 ? 'high' : summary.percentUsed >= 70 ? 'medium' : 'low';
      return {
        ...summary,
        totalBytes: summary.usedBytes,
        totalCount: summary.fileCount,
        knownCount: summary.knownSizeCount,
        unknownCount: summary.unknownSizeCount,
        usedLabel: formatBytes(summary.usedBytes) || '0 B',
        availableLabel: summary.hasQuota ? (formatBytes(summary.availableBytes) || '0 B') : 'Unknown',
        quotaLabel: summary.hasQuota ? (formatBytes(summary.quotaBytes) || '0 B') : 'Not configured',
        usedDetail: `${summary.knownSizeCount} of ${summary.fileCount} file${summary.fileCount === 1 ? '' : 's'} measured`,
        percentLabel: summary.hasQuota ? `${summary.percentUsed}% of ${this.storageQuotaLabel} used` : 'No allowance configured',
        tone
      };
    },
    get averageFileSizeLabel() {
      const stats = this.cloudStorageStatistics;
      if (!stats.fileCount) return 'No files stored yet';
      if (!stats.averageBytes) return 'No size recorded yet';
      return `Average file size ${formatBytes(stats.averageBytes)}`;
    },
    get cloudStorageBarClass() {
      const tone = this.cloudStorageStatistics.tone;
      if (tone === 'over' || tone === 'high') return 'bg-rose-500';
      if (tone === 'medium') return 'bg-amber-500';
      return 'bg-emerald-500';
    },
    get cloudStorageStatusClass() {
      const tone = this.cloudStorageStatistics.tone;
      if (tone === 'over' || tone === 'high') return 'bg-rose-50 text-rose-700 ring-rose-200';
      if (tone === 'medium') return 'bg-amber-50 text-amber-800 ring-amber-200';
      return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
    },
    get cloudStorageStatusLabel() {
      const stats = this.cloudStorageStatistics;
      if (!stats.hasQuota) return 'Allowance not configured';
      if (stats.overQuota) return 'Over the allowance';
      if (stats.tone === 'high') return 'Almost full';
      if (stats.tone === 'medium') return 'Filling up';
      return 'Plenty of room';
    },
    /** Per-file size and storage age, largest first — the cloud inventory. */
    get cloudFileInventory() { return this.cloudStorageStatistics.files; },
    get cloudStorageOldestLabel() {
      const file = this.cloudStorageStatistics.oldestFile;
      if (!file) return 'No published file has a recorded upload date yet.';
      return `Longest-stored file: ${file.name} — ${file.storedLabel}.`;
    },
    /** Whole days a single resource has been in the cloud (null when unknown). */
    storedAgeDays(item) { return storedDays(item?.addedAt || item?.meta?.addedAt); },
    storedAgeLabel(item) { return formatStoredDays(this.storedAgeDays(item)); },
    /** Compact storage age for table cells: "Today", "12 days", "Unknown". */
    storedAgeShort(item) {
      const days = this.storedAgeDays(item);
      if (days === null) return 'Unknown';
      if (days === 0) return 'Today';
      return `${days} day${days === 1 ? '' : 's'}`;
    },
    storedAgeTitle(item) {
      const addedAt = item?.addedAt || item?.meta?.addedAt || '';
      const when = addedAt ? formatDateTime(addedAt) : '';
      if (!when) return 'No upload date is recorded for this file yet. Use “Refresh file details” to read it from the repository history.';
      return `Uploaded ${when} — stored in the GitHub cloud since then.`;
    },
    sizeLabel(item) {
      const bytes = Number(item?.size) || 0;
      if (bytes > 0) return formatBytes(bytes);
      return this.cloudDetails.refreshing ? 'Checking…' : 'Size unknown';
    },
    /* ---------------------------------------------------------------------
     * Administrator sign-ins and uploads
     *
     * The record lives in stats/admin-activity.json, so "how many sign-ins
     * today, this week and this month" and "the latest sign-in" are the same
     * numbers on every computer that opens this dashboard.
     * ------------------------------------------------------------------- */
    get adminLoginStats() {
      return adminLoginStatistics(this.adminActivity, Date.now(), { seriesDays: ADMIN_ACTIVITY_SERIES_DAYS });
    },
    get latestAdminLogin() {
      const stats = this.adminLoginStats;
      if (!stats.lastLoginAt) return null;
      return {
        at: stats.lastLoginAt,
        user: stats.lastLoginUser || 'Administrator',
        when: formatDateTime(stats.lastLoginAt),
        relative: formatRelativeTime(stats.lastLoginAt) || formatDate(stats.lastLoginAt)
      };
    },
    get adminLoginSeriesMax() {
      return this.adminLoginStats.perDay.reduce((best, day) => Math.max(best, day.count), 0);
    },
    /** Bar height in percent (a zero-count day still shows a thin baseline). */
    loginBarHeight(day) {
      const max = this.adminLoginSeriesMax;
      if (!max) return 4;
      return Math.max(4, Math.round((Number(day?.count) || 0) / max * 100));
    },
    get recentAdminLogins() { return recentAdminLogins(this.adminActivity, 6); },
    get recentAdminUploads() {
      // A fresh installation has no log yet, so the library's own upload dates
      // stand in until the first publish is recorded here.
      const logged = recentAdminUploads(this.adminActivity, 8);
      const entries = logged.length ? logged : [...this.apps]
        .filter(item => item.addedAt || item.meta?.addedAt)
        .sort((left, right) => Date.parse(right.addedAt || right.meta?.addedAt) - Date.parse(left.addedAt || left.meta?.addedAt))
        .slice(0, 8)
        .map(item => ({
          at: item.addedAt || item.meta?.addedAt,
          path: item.path,
          name: item.fileName,
          title: item.name,
          bytes: Number(item.size) || 0,
          subject: item.meta?.subject || '',
          years: item.meta?.years || [],
          owner: item.meta?.owner || ''
        }));
      return entries.map(entry => {
        const item = this.apps.find(app => app.path.toLowerCase() === entry.path.toLowerCase());
        const days = storedDays(entry.at);
        return {
          ...entry,
          sizeLabel: formatBytes(entry.bytes) || 'Size unknown',
          when: formatRelativeTime(entry.at) || formatDate(entry.at),
          exactWhen: formatDateTime(entry.at),
          storedLabel: days === null ? 'In the cloud' : formatStoredDays(days),
          presentInLibrary: Boolean(item),
          downloads: item ? this.downloadsOf(item) : 0
        };
      });
    },
    /** Published files that still need a size or an upload date resolved. */
    get cloudDetailsMissingCount() {
      return this.apps.filter(item => item.source === 'github' && (!(item.size > 0) || !(item.addedAt || item.meta?.addedAt))).length;
    },
    get adminActivityPendingLabel() {
      const pending = Number(this.adminActivityStatus.pendingCount) || 0;
      if (!pending) return '';
      return `${pending} entr${pending === 1 ? 'y' : 'ies'} waiting to be saved to the repository`;
    },
    get adminActivitySourceLabel() {
      const status = this.adminActivityStatus;
      if (status.loading) return 'Loading the administrator activity record…';
      if (status.error) return status.error;
      if (status.source === 'github') {
        const when = status.githubUpdatedAt ? formatRelativeTime(status.githubUpdatedAt) : '';
        return `Shared record from ${ADMIN_ACTIVITY_PATH}${when ? ` — last written ${when}` : ''}.`;
      }
      if (status.source === 'cache') return 'Showing the copy saved on this device. The shared copy refreshes when GitHub is reachable.';
      return 'Showing the sign-in and upload activity recorded on this device. Connect publishing to share it with every computer.';
    },
    get yearLevelStatistics() {
      const counts = Object.fromEntries(YEAR_LEVELS.map(year => [year, 0]));
      let unclassified = 0;
      for (const item of this.apps) {
        const years = item.meta.years || [];
        if (!years.length) unclassified += 1;
        for (const year of years) if (year in counts) counts[year] += 1;
      }
      return { counts, unclassified };
    },
    get subjectStatistics() {
      const map = new Map();
      for (const item of this.apps) {
        const subject = item.meta.subject || 'Unclassified';
        const entry = map.get(subject) || { subject, count: 0, totalSize: 0 };
        entry.count += 1;
        entry.totalSize += item.size || 0;
        map.set(subject, entry);
      }
      return [...map.values()].sort((a, b) => b.count - a.count || a.subject.localeCompare(b.subject));
    },
    get teacherStatistics() {
      const owners = new Map();
      for (const item of this.apps) {
        const owner = item.meta.owner || item.teacherName || 'Unattributed';
        const row = owners.get(owner) || {
          owner, uploads: 0, yearCounts: Object.fromEntries(YEAR_LEVELS.map(year => [year, 0])),
          subjectCounts: {}, totalSize: 0, lastUploadAt: '', lastUploadDaysAgo: Infinity
        };
        row.uploads += 1;
        row.totalSize += item.size || 0;
        for (const year of item.meta.years || []) row.yearCounts[Number(year)] = (row.yearCounts[Number(year)] || 0) + 1;
        row.subjectCounts[item.meta.subject || 'Unclassified'] = (row.subjectCounts[item.meta.subject || 'Unclassified'] || 0) + 1;
        if (item.addedAt && (!row.lastUploadAt || Date.parse(item.addedAt) > Date.parse(row.lastUploadAt))) row.lastUploadAt = item.addedAt;
        row.lastUploadDaysAgo = row.lastUploadAt ? calculateAgeDays(row.lastUploadAt) : Infinity;
        owners.set(owner, row);
      }
      return [...owners.values()].sort((a, b) => b.uploads - a.uploads || a.owner.localeCompare(b.owner));
    },
    get resourcesByAgeBucket() {
      const result = Object.fromEntries(this.ageBuckets.map(bucket => [bucket, []]));
      for (const item of this.apps) {
        const age = calculateAgeDays(item.addedAt || item.meta.addedAt);
        const bucket = age <= 30 ? 'recent' : age <= 90 ? 'quarter' : age <= 180 ? 'half-year' : 'year-plus';
        result[bucket].push({
          id: item.id, title: item.name, owner: item.meta.owner, subject: item.meta.subject,
          uploadedAt: item.addedAt, downloads: this.downloadsOf(item), fileName: item.fileName
        });
      }
      return result;
    },
    get cleanupCandidates() {
      return this.apps
        .map(item => ({
          id: item.id, title: item.name, owner: item.meta.owner, subject: item.meta.subject,
          uploadedAt: item.addedAt || item.meta.addedAt,
          ageDays: calculateAgeDays(item.addedAt || item.meta.addedAt),
          downloads: this.downloadsOf(item), fileName: item.fileName
        }))
        .filter(item => item.ageDays >= Number(this.statsCleanupMinAgeDays) && item.downloads <= Number(this.statsCleanupMaxDownloads))
        .sort((a, b) => b.ageDays - a.ageDays);
    },
    get integrityStatusClass() {
      if (this.integrityReport.status === 'error') return 'bg-rose-50 text-rose-700 ring-rose-200';
      if (this.integrityReport.status === 'warning') return 'bg-amber-50 text-amber-700 ring-amber-200';
      return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
    },
    get integrityIssueCount() { return this.integrityReport.issues.length; },
    get dismissedIntegrityCount() { return this._dismissedIntegrityIssueIds.length; },
    get visibleIntegrityIssues() {
      if (this.integrityUi.hideIssues) return [];
      return this.integrityReport.issues.filter(issue => !this._dismissedIntegrityIssueIds.includes(issue.id));
    },
    get dashboardAttentionCount() { return this.managementAlerts.length; },
    get managementAlerts() {
      const alerts = [];
      if (!this.githubAuth.connected) alerts.push({
        id: 'github-token', tone: 'amber', icon: 'key-round', label: 'GitHub upload is not connected',
        description: this.githubAuth.website.saved || this.githubAuth.website.status === 'locked'
          ? 'This website stores your token. Open Settings and enter the master password to unlock it on this computer.'
          : 'Paste the repository token in Settings to publish files directly. It is stored in the website, so other computers inherit it.',
        actionLabel: 'Open Settings', destination: 'settings', count: 1
      });
      if (this.errors.library) alerts.push({
        id: 'library-load', tone: 'rose', icon: 'triangle-alert', label: 'The live library could not be refreshed',
        description: this.errors.library, actionLabel: 'Retry', destination: 'library', count: 1
      });
      if (this.reviewDueApps.length) alerts.push({
        id: 'review-due', tone: 'amber', icon: 'calendar-clock', label: 'Resources need review',
        description: `${this.reviewDueApps.length} file(s) are past their review date.`,
        actionLabel: 'Review files', destination: 'library', count: this.reviewDueApps.length
      });
      return alerts;
    },
    get hasDownloadRecord() { return Boolean(this.downloadStatsRecord); },
    get counterStatusClass() {
      if (this.stats.online) return 'bg-slate-50 border border-slate-200 text-slate-600';
      if (this.hasDownloadRecord) return 'bg-sky-50 border border-sky-200 text-sky-800';
      return 'bg-amber-50 border border-amber-200 text-amber-800';
    },
    get counterStatusIcon() {
      if (this.stats.online) return 'database';
      if (this.hasDownloadRecord) return 'cloud';
      return 'wifi-off';
    },
    githubRecordLabel() {
      if (!this.hasDownloadRecord) return 'No counts have been saved to GitHub yet.';
      const stamp = this.stats.recordUpdatedAt || this.downloadStatsRecord.updatedAt;
      const when = stamp ? formatDate(stamp) : '';
      const count = this.downloadStatsRecord.files.size;
      return `Last saved to GitHub${when ? ` on ${when}` : ''} · ${count} file${count === 1 ? '' : 's'} on record.`;
    },
    get integrityDiagnosis() { return this._integrityDiagnosis || null; },
    set integrityDiagnosis(value) { this._integrityDiagnosis = value; },
    _integrityDiagnosis: null,
    get draftCardMeta() {
      const curated = {
        title: this.draft.title,
        subject: this.draft.subject,
        keywords: String(this.draft.keywords || '').split(',').map(value => value.trim()).filter(Boolean),
        visibility: this.draft.visibility || 'public'
      };
      if (this.draft.years) curated.years = [Number(this.draft.years)];
      const inferred = inferMetadata(this.draftFile?.name || '', curated);
      return {
        subject: this.draft.subject || inferred.subject,
        years: this.draft.years ? [Number(this.draft.years)] : inferred.years,
        visibility: this.draft.visibility || 'public',
        tags: inferred.tags
      };
    },

    syncInterfaceMode() {
      const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
      const nextMode = interfaceModeForViewport(viewportWidth);
      if (this.interfaceMode !== nextMode) this.interfaceMode = nextMode;
    },

    async init() {
      if (this._initialized) return;
      this._initialized = true;
      this.syncInterfaceMode();
      const refreshInterfaceMode = () => this.syncInterfaceMode();
      window.addEventListener('resize', refreshInterfaceMode, { passive: true });
      window.addEventListener('orientationchange', refreshInterfaceMode, { passive: true });
      this.$watch('currentView', (view, previous) => {
        if (previous === 'settings' && view !== 'settings') this.lockAdminAccount();
      });
      // Sign-ins recorded while the token was locked are shared the moment
      // publishing reconnects, on any path (remembered token, website vault or
      // a freshly pasted one).
      const sharePendingAdminActivity = () => this.syncAdminActivityToGitHub({ silent: true });
      this.$watch('githubAuth.connected', connected => {
        if (connected) sharePendingAdminActivity();
      });
      this.$watch('githubAuth.activeToken', token => {
        if (token) sharePendingAdminActivity();
      });
      this.clearLegacyTokens();
      this.githubAuth.storeOnWebsite = this.readWebsiteTokenPreference();
      this.loadSavedRepoSettings();
      // Apply a credential this device rotated before the deployment landed.
      this.restoreAdminCredentials();
      this.isAdmin = false;
      this.githubAuth.token = '';
      this.githubAuth.activeToken = '';
      this.githubAuth.connected = false;
      // Reconnect the token this device remembered, so an administrator who
      // saved it once never has to paste it again on this browser.
      this.restoreSavedGithubToken();
      this.offline = !navigator.onLine;
      window.addEventListener('online', () => { this.offline = false; this.loadLibrary(); });
      window.addEventListener('offline', () => { this.offline = true; });
      this.readSharedFilters();
      // Sign-ins and uploads recorded on this device load before the library,
      // so the dashboard has numbers the moment it opens.
      this.hydrateAdminActivity();
      const cachedLibrary = this.readCachedLibrarySnapshot();
      if (cachedLibrary) this.applyLibrarySnapshot(cachedLibrary, { fromCache: true });
      this.refreshIcons();
      await Promise.allSettled([this.loadLibrary(), this.countVisitor()]);
      this.updateIntegrityReport();
      this.initPresence();
      // A lockout recorded in localStorage is still in force after a reload.
      this.refreshRateLimitState();
      if (Object.keys(this.rateLimit.blocked).length) this.startRateLimitTicker();
      this.refreshIcons();
    },

    clearLegacyTokens() {
      for (const key of LEGACY_TOKEN_KEYS) {
        safeStorageRemove(globalThis.sessionStorage, key);
        safeStorageRemove(globalThis.localStorage, key);
      }
      // The legacy keys above are never read back. The current token is
      // remembered under SAVED_TOKEN_STORAGE_KEY and restored by
      // restoreSavedGithubToken(), so it survives sign-out and reloads.
      this.githubAuth.token = '';
      this.githubAuth.activeToken = '';
    },

    readSavedGithubToken() {
      return String(safeStorageGet(globalThis.localStorage, SAVED_TOKEN_STORAGE_KEY) || '').trim();
    },

    rememberGithubToken(token) {
      const clean = String(token || '').trim();
      if (!clean) return false;
      const stored = safeStorageSet(globalThis.localStorage, SAVED_TOKEN_STORAGE_KEY, clean);
      this.githubAuth.remembered = stored;
      return stored;
    },

    forgetSavedGithubToken() {
      safeStorageRemove(globalThis.localStorage, SAVED_TOKEN_STORAGE_KEY);
      this.githubAuth.remembered = false;
    },

    /**
     * Restore the token this device remembered. The credential is held in
     * browser storage only; it is never written to a repository file, and
     * GitHub never returns the encrypted Actions secret to the website.
     */
    restoreSavedGithubToken() {
      const saved = this.readSavedGithubToken();
      if (!saved) {
        this.githubAuth.remembered = false;
        return false;
      }
      this.githubAuth.activeToken = saved;
      this.githubAuth.connected = true;
      this.githubAuth.remembered = true;
      return true;
    },

    /* ---------------------------------------------------------------------
     * The token stored in the website
     *
     * GitHub's Actions secret store cannot be read back by a static site, and
     * a browser copy only helps the browser that made it. So the verified
     * token is also encrypted with the administrator's own passwords and
     * committed to assets/data/publish-token.json, which GitHub Pages serves
     * as part of this website. Signing in on any computer downloads that file
     * and unlocks it in memory, so the token never has to be pasted twice.
     * ------------------------------------------------------------------- */

    /** Keep a typed password for this page visit only (never stored). */
    rememberSessionPassword(slot, password) {
      if (!this._sessionSecrets) this._sessionSecrets = { admin: '', master: '' };
      if (slot === 'admin' || slot === 'master') this._sessionSecrets[slot] = String(password || '');
    },
    clearSessionPasswords(slot = '') {
      if (!this._sessionSecrets) this._sessionSecrets = { admin: '', master: '' };
      if (slot) this._sessionSecrets[slot] = '';
      else this._sessionSecrets = { admin: '', master: '' };
    },
    sessionPasswords() {
      return {
        admin: String(this._sessionSecrets?.admin || ''),
        master: String(this._sessionSecrets?.master || '')
      };
    },
    /**
     * Fetch the encrypted vault. The deployed website copy is tried first
     * because it is same-origin and free; the GitHub copy is the fallback and
     * is also the fresher one in the minute after a save, before GitHub Pages
     * has rebuilt.
     */
    async readWebsiteTokenVault({ preferGitHub = false } = {}) {
      const target = this.repositoryTarget;
      const branch = this.githubConfig.branch || SITE_CONFIG.repository.branch;
      const fromSite = async () => {
        try {
          const data = await this.fetchJson(`./${TOKEN_VAULT_PATH}?v=${Date.now()}`, { retries: 0 });
          return isTokenVault(data) ? data : null;
        } catch {
          return null;
        }
      };
      const fromGitHub = async () => {
        try {
          return await readTokenVaultFromGitHub({
            owner: target.owner, repo: target.name, branch,
            token: this.githubAuth.activeToken || ''
          });
        } catch {
          return null;
        }
      };
      return preferGitHub ? ((await fromGitHub()) || (await fromSite())) : ((await fromSite()) || (await fromGitHub()));
    },

    applyWebsiteVaultState(vault) {
      const site = this.githubAuth.website;
      const summary = describeTokenVault(vault);
      this._websiteVault = summary.present ? vault : null;
      site.saved = summary.present;
      site.slots = summary.slots;
      site.savedAt = summary.updatedAt;
      site.stale = summary.present && summary.slots.every(slot => tokenVaultSlotIsStale(
        vault, slot, slot === 'master' ? readMasterGate().salt : readAdminGate().salt
      ));
      if (!summary.present) {
        site.status = 'missing';
        site.message = 'No publishing token is stored in this website yet. Save one below and every computer you sign in on will have it.';
      } else if (site.stale) {
        site.status = 'saved';
        site.message = 'The stored token was locked with an older password. Save it again so it opens with the current one.';
      } else {
        site.status = 'saved';
        site.message = 'This website carries the publishing token, encrypted. Signing in on another computer unlocks it automatically.';
      }
      return summary.present;
    },

    /** Look up what the website currently stores, without unlocking it. */
    async refreshWebsiteTokenStatus({ preferGitHub = false } = {}) {
      const site = this.githubAuth.website;
      if (site.busy) return site.saved;
      site.status = 'checking';
      const vault = await this.readWebsiteTokenVault({ preferGitHub });
      const present = this.applyWebsiteVaultState(vault);
      this.refreshIcons();
      return present;
    },

    /**
     * Unlock the stored token with a password the administrator has just
     * typed, and connect it. Returns true when publishing is ready.
     */
    async unlockTokenFromWebsite({ slot = 'admin', password = '', announce = false } = {}) {
      const secret = String(password || '');
      if (!this.isAdmin || !secret) return false;
      const site = this.githubAuth.website;
      const attempt = async preferGitHub => {
        const vault = await this.readWebsiteTokenVault({ preferGitHub });
        if (!this.applyWebsiteVaultState(vault)) return { done: false, retry: false };
        try {
          return { done: true, opened: await openTokenVault(vault, { password: secret, slot }) };
        } catch {
          return { done: false, retry: !preferGitHub };
        }
      };

      let result = await attempt(false);
      // A vault saved minutes ago, or re-locked by a password rotation, can
      // still be mid-deployment on the website: the repository copy is the
      // authoritative one, so try it before giving up.
      if (!result.done && result.retry) result = await attempt(true);
      if (!result.done) {
        if (site.saved) {
          site.status = 'locked';
          site.message = `The token stored in this website did not open with your ${TOKEN_VAULT_SLOT_LABELS[slot] || 'password'}. Save it again from Cloud Settings on a computer that is already connected.`;
        }
        this.refreshIcons();
        return false;
      }

      const token = result.opened.token;
      const target = this.repositoryTarget;
      try {
        const verified = await verifyGitHubToken({ token, owner: target.owner, repo: target.name });
        this.githubAuth.login = verified.login || '';
      } catch (error) {
        if (error?.status === 401 || error?.status === 403) {
          site.status = 'error';
          site.message = 'GitHub rejected the token stored in this website — it has probably expired or been revoked. Paste a replacement below and save it again.';
          this.githubAuth.error = site.message;
          if (announce) this.notify(site.message, 'error');
          this.refreshIcons();
          return false;
        }
        // Offline or rate-limited: trust the stored token and let the next
        // check confirm it rather than locking the administrator out.
      }

      this.githubAuth.activeToken = token;
      this.githubAuth.connected = true;
      this.githubAuth.error = '';
      this.rememberGithubToken(token);
      site.status = 'saved';
      site.message = 'The publishing token stored in this website was unlocked on this computer.';
      if (announce) {
        this.notify('Publishing is ready: the access token stored in this website was unlocked for this computer.', 'success');
      }
      this.refreshIcons();
      return true;
    },

    /**
     * Encrypt the connected token with the administrator passwords typed this
     * visit and commit it to the repository, so the website carries it.
     */
    async saveTokenToWebsite({ token = '', announce = true } = {}) {
      const site = this.githubAuth.website;
      const active = String(token || this.githubAuth.activeToken || '').trim();
      if (!active) {
        site.status = 'unavailable';
        site.message = 'Connect a token first; there is nothing to store in the website yet.';
        return false;
      }
      const passwords = this.sessionPasswords();
      if (!passwords.admin && !passwords.master) {
        site.status = 'unavailable';
        site.message = 'Sign in again (and unlock Cloud Settings) so the token can be locked with your passwords before it is stored in the website.';
        if (announce) this.notify(site.message, 'error');
        return false;
      }

      site.busy = true;
      site.status = 'saving';
      const target = this.repositoryTarget;
      try {
        const vault = await createTokenVault({
          token: active,
          passwords,
          repository: `${target.owner}/${target.name}`,
          gates: { admin: readAdminGate().salt, master: readMasterGate().salt }
        });
        const result = await saveTokenVaultToGitHub({
          owner: target.owner,
          repo: target.name,
          branch: this.githubConfig.branch || SITE_CONFIG.repository.branch,
          token: active,
          vault
        });
        this._websiteVault = vault;
        site.saved = true;
        site.status = 'saved';
        site.stale = false;
        site.slots = tokenVaultSlots(vault);
        site.savedAt = vault.updatedAt || '';
        site.commitUrl = result.commitUrl || '';
        site.message = `The token is stored in this website, encrypted with your ${this.websiteTokenSlotLabel || 'administrator password'}. Sign in on any computer and publishing reconnects by itself.`;
        if (announce) this.notify('The access token is now stored in this website. Signing in on another computer will connect it automatically.', 'success');
        return true;
      } catch (error) {
        site.status = 'error';
        site.message = error?.message || 'The token could not be stored in the website.';
        if (announce) this.notify(`The token is connected here, but storing it in the website failed: ${site.message}`, 'error');
        return false;
      } finally {
        site.busy = false;
        this.refreshIcons();
      }
    },

    /** The Cloud Settings button: store the connected token in the website. */
    async saveTokenToWebsiteNow() {
      if (!this.isAdmin) return this.openLogin('admin');
      if (this.githubAuth.website.busy) return;
      if (!this.guardAction('token')) {
        this.githubAuth.website.message = this.rateLimit.message;
        this.notify(this.rateLimit.message, 'error');
        return;
      }
      this.githubAuth.storeOnWebsite = true;
      this.rememberWebsiteTokenPreference(true);
      await this.saveTokenToWebsite({ announce: true });
    },

    /** Remove the stored copy, leaving the device copy and GitHub untouched. */
    async removeTokenFromWebsite() {
      if (!this.isAdmin) return this.openLogin('admin');
      const site = this.githubAuth.website;
      if (site.busy) return;
      const token = String(this.githubAuth.activeToken || '').trim();
      if (!token) {
        site.message = 'Connect a token first: changing the website copy is a repository change and needs write access.';
        this.notify(site.message, 'error');
        return;
      }
      if (!this.guardAction('token')) {
        this.notify(this.rateLimit.message, 'error');
        return;
      }
      const confirmed = typeof window.confirm !== 'function' || window.confirm(
        'Remove the encrypted token stored in this website? Other computers will have to paste a token again. Revoke the token on GitHub as well if it may have been exposed.'
      );
      if (!confirmed) return;
      site.busy = true;
      site.status = 'saving';
      const target = this.repositoryTarget;
      try {
        await clearTokenVaultOnGitHub({
          owner: target.owner,
          repo: target.name,
          branch: this.githubConfig.branch || SITE_CONFIG.repository.branch,
          token
        });
        this._websiteVault = null;
        this.githubAuth.storeOnWebsite = false;
        this.rememberWebsiteTokenPreference(false);
        site.saved = false;
        site.slots = [];
        site.stale = false;
        site.savedAt = '';
        site.status = 'missing';
        site.message = 'The stored token was removed from the website. This computer is still connected.';
        this.notify('The token stored in the website was removed. Other computers will need a token again.', 'success');
      } catch (error) {
        site.status = 'error';
        site.message = error?.message || 'The stored token could not be removed.';
        this.notify(site.message, 'error');
      } finally {
        site.busy = false;
        this.refreshIcons();
      }
    },

    readWebsiteTokenPreference() {
      const saved = safeStorageGet(globalThis.localStorage, STORE_TOKEN_ON_WEBSITE_KEY);
      return saved === null ? true : saved !== 'off';
    },
    rememberWebsiteTokenPreference(enabled) {
      safeStorageSet(globalThis.localStorage, STORE_TOKEN_ON_WEBSITE_KEY, enabled ? 'on' : 'off');
    },
    toggleStoreTokenOnWebsite() {
      this.githubAuth.storeOnWebsite = !this.githubAuth.storeOnWebsite;
      this.rememberWebsiteTokenPreference(this.githubAuth.storeOnWebsite);
      this.refreshIcons();
    },

    /**
     * Re-check a remembered token after sign-in. Only a credential GitHub
     * rejects (HTTP 401) is forgotten; an offline or rate-limited check leaves
     * the saved token in place for the next attempt.
     */
    async verifySavedGithubToken() {
      if (!this.isAdmin) return;
      const token = String(this.githubAuth.activeToken || '').trim();
      if (!token || this.githubAuth.verifying) return;
      this.githubAuth.verifying = true;
      try {
        const target = this.repositoryTarget;
        const result = await verifyGitHubToken({ token, owner: target.owner, repo: target.name });
        if (this.githubAuth.activeToken !== token) return;
        this.githubAuth.connected = true;
        this.githubAuth.login = result.login;
        this.githubAuth.error = '';
      } catch (error) {
        if (this.githubAuth.activeToken !== token) return;
        if (error?.status === 401) {
          this.forgetSavedGithubToken();
          this.githubAuth.activeToken = '';
          this.githubAuth.connected = false;
          this.githubAuth.error = 'The GitHub token saved on this device was rejected. Paste a replacement token and connect again.';
          this.notify(this.githubAuth.error, 'error');
          // The website may already carry a newer token saved from another
          // computer; unlocking it silently repairs this device.
          const passwords = this.sessionPasswords();
          if (passwords.admin || passwords.master) {
            const slot = passwords.admin ? 'admin' : 'master';
            this._websiteTokenPromise = this.unlockTokenFromWebsite({
              slot, password: passwords[slot], announce: true
            }).catch(() => false);
          }
        } else {
          this.githubAuth.error = error?.message || 'The saved GitHub token could not be checked.';
        }
      } finally {
        this.githubAuth.verifying = false;
        this.refreshIcons();
      }
    },

    loadSavedRepoSettings() {
      try {
        const saved = localStorage.getItem('schoolcloud.repository');
        if (saved) {
          const repo = parseRepoName(saved, SITE_CONFIG.repository.owner, SITE_CONFIG.repository.name);
          this.githubConfig.repo = `${repo.owner}/${repo.name}`;
        }
      } catch { /* Defaults are fine when storage is blocked. */ }
    },

    readSharedFilters() {
      try {
        const params = new URLSearchParams(window.location.search);
        if (params.has('q')) this.filters.query = params.get('q') || '';
        if (params.has('subject')) this.filters.subject = params.get('subject') || '';
        if (params.has('year')) this.filters.year = params.get('year') || '';
        if (params.has('kind')) this.filters.kind = params.get('kind') || '';
      } catch { /* Ignore malformed share links. */ }
    },

    readCachedLibrarySnapshot() {
      const raw = safeStorageGet(globalThis.localStorage, LIBRARY_CACHE_STORAGE_KEY);
      if (!raw) return null;
      try { return normalizeCachedLibrarySnapshot(JSON.parse(raw)); }
      catch { return null; }
    },
    saveCachedLibrarySnapshot(snapshot) {
      const normalized = normalizeCachedLibrarySnapshot(snapshot);
      if (!normalized) return false;
      const payload = {
        version: LIBRARY_CACHE_VERSION,
        savedAt: new Date().toISOString(),
        manifest: normalized.manifest,
        library: normalized.library,
        stats: normalized.stats
      };
      const stored = safeStorageSet(globalThis.localStorage, LIBRARY_CACHE_STORAGE_KEY, JSON.stringify(payload));
      if (stored) this.libraryCacheSavedAt = payload.savedAt;
      return stored;
    },
    clearCachedLibrarySnapshot() {
      safeStorageRemove(globalThis.localStorage, LIBRARY_CACHE_STORAGE_KEY);
      this.libraryCacheSavedAt = '';
    },
    applyLibrarySnapshot(snapshot, { fromCache = false, sequence = this._loadSequence } = {}) {
      const normalizedSnapshot = normalizeCachedLibrarySnapshot(snapshot);
      if (!normalizedSnapshot) return false;
      const { manifest, library, stats, savedAt } = normalizedSnapshot;
      const metaByPath = metadataFromLibrary(library);
      const normalized = manifest
        .map(file => normalizeLibraryEntry(file, metaByPath.get(file.path) || metaByPath.get(file.name) || {}))
        .filter(Boolean);
      if (sequence !== this._loadSequence) return false;
      this.libraryMetadata = library;
      this.metadataEntries = Object.keys(library).filter(key => !key.startsWith('_')).length;
      if (stats && typeof stats === 'object') {
        this.downloadStatsRecord = normalizeStatsRecord(stats);
        this.stats.recordUpdatedAt = this.downloadStatsRecord.updatedAt || '';
      } else {
        this.downloadStatsRecord = null;
        this.stats.recordUpdatedAt = '';
      }
      this.libraryItems = sortResources(normalized, 'newest');
      this.usingCachedLibrary = fromCache;
      this.loading.library = false;
      if (savedAt) {
        this.libraryCacheSavedAt = savedAt;
        this.stats.updatedAtLabel = new Date(savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      }
      this.reseedVisitorFromRecord();
      this.updateCounterStatus();
      this.updateIntegrityReport();
      this.prepareDownloadCounters();
      this.refreshIcons();
      return true;
    },

    shareFilters() {
      const params = new URLSearchParams();
      if (this.filters.query) params.set('q', this.filters.query);
      if (this.filters.subject) params.set('subject', this.filters.subject);
      if (this.filters.year) params.set('year', this.filters.year);
      if (this.filters.kind) params.set('kind', this.filters.kind);
      const suffix = params.size ? `?${params}` : window.location.pathname;
      history.replaceState(null, '', suffix);
      this.notify('A shareable library link has been copied to the address bar.', 'success');
    },

    async fetchJson(url, { retries = FETCH_RETRY_DELAYS_MS.length } = {}) {
      let lastError = null;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const response = await fetch(url, {
            cache: 'no-store',
            credentials: 'same-origin',
            headers: { Accept: 'application/json' }
          });
          if (!response.ok) {
            const error = new Error(`Could not load ${url} (HTTP ${response.status}).`);
            error.status = response.status;
            throw error;
          }
          return await response.json();
        } catch (error) {
          lastError = error;
          const retryable = isTransientNetworkError(error) || isRetryableHttpStatus(error?.status);
          if (!retryable || attempt >= retries) throw error;
          await sleep(FETCH_RETRY_DELAYS_MS[Math.min(attempt, FETCH_RETRY_DELAYS_MS.length - 1)]);
        }
      }
      throw lastError || new Error(`Could not load ${url}.`);
    },

    async loadLibrary({ force = false } = {}) {
      if (this._loadPromise && !force) return this._loadPromise;
      const run = async () => {
        const sequence = ++this._loadSequence;
        const cachedSnapshot = this.readCachedLibrarySnapshot();
        this.loading.library = true;
        this.errors.library = '';
        this.usingCachedLibrary = false;
        try {
          let manifest = null;
          let library = {};
          let stats = null;
          let activity = null;
          const [manifestResult, metadataResult, statsResult, activityResult] = await Promise.allSettled([
            this.fetchJson(`./apps.json?v=${Date.now()}`),
            this.fetchJson(`./library.json?v=${Date.now()}`),
            this.fetchJson(`./stats/downloads.json?v=${Date.now()}`),
            this.fetchJson(`./${ADMIN_ACTIVITY_PATH}?v=${Date.now()}`, { retries: 0 })
          ]);
          if (manifestResult.status === 'fulfilled' && Array.isArray(manifestResult.value)) manifest = manifestResult.value;
          if (metadataResult.status === 'fulfilled') library = metadataResult.value || {};
          if (statsResult.status === 'fulfilled' && statsResult.value && typeof statsResult.value === 'object') stats = statsResult.value;
          if (activityResult.status === 'fulfilled' && activityResult.value && typeof activityResult.value === 'object') activity = activityResult.value;

          if (!manifest) {
            const target = this.repositoryTarget;
            const files = await readPublicRepositoryFiles({
              owner: target.owner, repo: target.name, branch: this.githubConfig.branch || SITE_CONFIG.repository.branch
            });
            manifest = files.map(file => ({
              type: 'file', name: file.name, path: file.path, sha: file.sha,
              size: file.size, download_url: file.download_url
            }));
          }

          if (sequence !== this._loadSequence) return;
          const snapshot = { manifest, library, stats };
          this.applyLibrarySnapshot(snapshot, { fromCache: false, sequence });
          this.saveCachedLibrarySnapshot(snapshot);
          this.stats.updatedAtLabel = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
          if (activity) {
            this.absorbAdminActivity(activity, { source: 'github', updatedAt: activity.updatedAt || '' });
          } else {
            this.adminActivityStatus.source = 'cache';
            this.adminActivityStatus.loading = false;
          }
          // Sizes and storage ages are the only dashboard facts `apps.json`
          // cannot carry, so they are resolved in the background, once the
          // page is already usable.
          if (this.cloudDetailsMissingCount > 0) this.refreshCloudFileDetails({ silent: true });
          this.refreshIcons();
        } catch (error) {
          if (sequence !== this._loadSequence) return;
          const restored = cachedSnapshot ? this.applyLibrarySnapshot(cachedSnapshot, { fromCache: true, sequence }) : false;
          this.loading.library = false;
          this.usingCachedLibrary = restored;
          this.errors.library = isTransientNetworkError(error)
            ? (restored
              ? 'The live library is temporarily unavailable. The last saved copy is still open below.'
              : 'The library is temporarily unavailable. Check the connection and try again.')
            : (error?.message || 'The library could not be loaded.');
          this.stats.loadingDownloads = false;
          this.updateIntegrityReport();
          this.refreshIcons();
        }
      };
      let tracked = null;
      tracked = run().finally(() => {
        if (this._loadPromise === tracked) this._loadPromise = null;
      });
      this._loadPromise = tracked;
      return tracked;
    },

    countVisitor() {
      if (this._visitorCountPromise) return this._visitorCountPromise;
      const request = this.updateVisitorCounter();
      const trackedRequest = request.finally(() => {
        if (this._visitorCountPromise === trackedRequest) this._visitorCountPromise = null;
      });
      this._visitorCountPromise = trackedRequest;
      return trackedRequest;
    },

    async updateVisitorCounter() {
      this.stats.loadingVisitors = true;
      const key = SITE_CONFIG.abacus.visitorKey;
      const sessionHitKey = `${SITE_CONFIG.abacus.namespace}:${key}`;
      const claimedSessionHit = claimSessionCounterHit(sessionHitKey);
      const isNewSession = claimedSessionHit === null
        ? !this._visitorSessionCounted
        : claimedSessionHit;
      // Remember the attempt before making a request. A refresh during a slow
      // response must read the counter, not risk replaying the visitor hit.
      this._visitorSessionCounted = true;
      this._visitorOnline = false;
      const local = readLocalCounter(key);
      const recorded = Number(this.downloadStatsRecord?.visitors) || 0;

      if (!this._counterClient) {
        this.stats.visitors = writeLocalCounter(key, maxCounter(recorded, isNewSession ? local + 1 : local));
        this.stats.loadingVisitors = false;
        this.updateCounterStatus();
        return;
      }
      try {
        // A reload within the same tab session reads the current total without
        // incrementing it. Only a newly claimed session sends an Abacus hit.
        const value = isNewSession
          ? await this._counterClient.hit(key)
          : await this._counterClient.get(key);
        this.stats.visitors = writeLocalCounter(key, maxCounter(recorded, value));
        this._visitorOnline = true;
      } catch {
        this.stats.visitors = writeLocalCounter(key, maxCounter(recorded, isNewSession ? local + 1 : local));
      } finally {
        this.stats.loadingVisitors = false;
        // The GitHub record loads concurrently with this request and may have
        // arrived mid-flight; re-apply it last so the badge never settles
        // below the highest known value regardless of completion order.
        this.reseedVisitorFromRecord();
        this.updateCounterStatus();
      }
    },

    reseedVisitorFromRecord() {
      if (!this.downloadStatsRecord) return;
      const key = SITE_CONFIG.abacus.visitorKey;
      this.stats.visitors = writeLocalCounter(key, maxCounter(
        this.stats.visitors,
        Number(this.downloadStatsRecord.visitors) || 0
      ));
    },

    prepareDownloadCounters() {
      window.__schoolCloudCounterObserver?.disconnect();
      this._counterReadStarted = [];
      this._counterReadInFlight = [];
      for (const item of this.apps) {
        item.counterKey = downloadCounterKey(item.path);
        // Seed every card from the highest known value so the GitHub-saved
        // record shows immediately, even where Abacus is blocked. Live reads
        // can only raise these baselines, never lower them.
        this.stats.downloads[item.id] = maxCounter(
          readLocalCounter(item.counterKey),
          downloadsFromRecord(this.downloadStatsRecord, item.path)
        );
      }
      this.stats.loadingDownloads = false;
      this.updateCounterStatus();
      if (this.isAdmin && this.currentView === 'dashboard') this.loadDownloadCounters();
    },

    observeDownloadCounter(item, element) {
      if (!item || !element) return;
      item.counterKey ||= downloadCounterKey(item.path);
      if (this.stats.downloads[item.id] === undefined) {
        this.stats.downloads[item.id] = readLocalCounter(item.counterKey);
      }
      if (!this._counterClient || this._counterReadStarted.includes(item.id)) return;

      // Keep Abacus reads below its per-IP rate limit: fetch counts when cards
      // approach the viewport instead of requesting every file on every visit.
      if (typeof window.IntersectionObserver === 'function') {
        let observer = window.__schoolCloudCounterObserver;
        if (!observer) {
          observer = new window.IntersectionObserver(entries => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              observer.unobserve(entry.target);
              const state = entry.target._schoolCloudCounterState;
              const file = entry.target._schoolCloudCounterItem;
              if (state && file) state.readDownloadCounter(file);
            }
          }, { rootMargin: '120px 0px' });
          window.__schoolCloudCounterObserver = observer;
        }
        element._schoolCloudCounterState = this;
        element._schoolCloudCounterItem = item;
        observer.observe(element);
        return;
      }

      // Older browsers without IntersectionObserver read a small first batch;
      // clicking any other file still increments that file's Abacus counter.
      if (this._counterReadStarted.length < 8) this.readDownloadCounter(item);
    },

    async readDownloadCounter(item, force = false) {
      if (!item || !this._counterClient) return;
      if (this._counterReadInFlight.includes(item.id)) return;
      if (!force && this._counterReadStarted.includes(item.id)) return;
      if (!this._counterReadStarted.includes(item.id)) this._counterReadStarted.push(item.id);
      this._counterReadInFlight.push(item.id);
      this._counterReadAt[item.id] = Date.now();
      const key = item.counterKey || downloadCounterKey(item.path);
      item.counterKey = key;
      try {
        const value = await this._counterClient.get(key);
        const total = maxCounter(this.downloadsOf(item), value, downloadsFromRecord(this.downloadStatsRecord, item.path));
        this.stats.downloads[item.id] = total;
        writeLocalCounter(key, total);
        this._downloadCountersOnline = true;
        this.updateCounterStatus();
      } catch {
        this.stats.downloads[item.id] = Math.max(this.downloadsOf(item), readLocalCounter(key));
      } finally {
        this._counterReadInFlight = this._counterReadInFlight.filter(id => id !== item.id);
      }
    },

    async loadDownloadCounters(items = this.apps, force = true) {
      const now = Date.now();
      const queue = [...items].filter(item => {
        if (!force) return !this._counterReadStarted.includes(item.id);
        return now - (Number(this._counterReadAt[item.id]) || 0) >= 10_000;
      });
      if (!items.length) {
        this._downloadCountersOnline = false;
        this.stats.loadingDownloads = false;
        this.updateCounterStatus();
        return;
      }
      if (!queue.length) {
        this.stats.loadingDownloads = false;
        return;
      }
      this.stats.loadingDownloads = true;
      this._downloadCountersOnline = false;
      this.updateCounterStatus();
      const worker = async () => {
        while (queue.length) {
          const item = queue.shift();
          await this.readDownloadCounter(item, force);
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
      this.stats.loadingDownloads = false;
      this.updateCounterStatus(this._downloadCountersOnline);
      this.refreshIcons();
    },

    updateCounterStatus(downloadCountersOnline) {
      if (downloadCountersOnline !== undefined) this._downloadCountersOnline = Boolean(downloadCountersOnline);
      this.stats.online = Boolean(this._visitorOnline || this._downloadCountersOnline) && Boolean(this._counterClient);
      // Three layers, best first: live Abacus totals shared across devices,
      // the last GitHub-saved record served from this same origin, and finally
      // per-browser fallback values.
      this.stats.backend = this.stats.online ? 'abacus' : (this.hasDownloadRecord ? 'github' : 'local');
    },

    async syncDownloadStatsToGitHub() {
      if (!this.isAdmin) return this.openLogin('admin');
      if (!this.githubAuth.connected || !this.githubAuth.activeToken) {
        this.notify('Connect a GitHub token in Settings before saving counts. It needs Contents: Read and write access.', 'error');
        this.openCloudSettings();
        return;
      }
      if (this.statsSyncing) {
        this.notify('The counts are already being saved. Please wait for that save to finish.', 'info');
        return;
      }
      if (!this.guardAction('sync')) {
        this.notify(this.rateLimit.message, 'error');
        return;
      }
      this.statsSyncing = true;
      try {
        // Refresh both the site-wide visitor total and per-file totals before
        // saving. Reads are best-effort; the save merges max-wins, so an
        // unreachable Abacus can never drag the GitHub record backwards.
        await Promise.all([
          this.countVisitor(),
          this.loadDownloadCounters(this.apps, true)
        ]);
        const files = {};
        for (const item of this.apps) {
          files[item.path] = {
            downloads: this.downloadsOf(item),
            key: item.counterKey || downloadCounterKey(item.path)
          };
        }
        const target = this.repositoryTarget;
        const record = {
          namespace: SITE_CONFIG.abacus.namespace,
          updatedAt: new Date().toISOString(),
          visitors: this.stats.visitors,
          files
        };
        const result = await saveDownloadStatsToGitHub({
          owner: target.owner,
          repo: target.name,
          branch: this.githubConfig.branch || SITE_CONFIG.repository.branch,
          token: this.githubAuth.activeToken,
          stats: record
        });
        this.downloadStatsRecord = normalizeStatsRecord(record);
        this.stats.recordUpdatedAt = record.updatedAt;
        this.updateCounterStatus();
        this.notify(`Download counts saved to GitHub (${result.fileCount} file${result.fileCount === 1 ? '' : 's'}). The website record refreshes after GitHub Pages finishes deploying.`, 'success');
      } catch (error) {
        this.notify(error?.message || 'The counts could not be saved to GitHub.', 'error');
      } finally {
        this.statsSyncing = false;
      }
    },

    /* ---------------------------------------------------------------------
     * Administrator sign-in and upload record
     *
     * Sign-ins and uploads are appended to one small JSON document in the
     * repository (stats/admin-activity.json) through the connected token, and
     * cached on this device. A device that cannot write to GitHub keeps its
     * entries queued and flushes them on the next successful connection, so a
     * sign-in is never lost and the statistics stay identical on every
     * computer. Nothing but timestamps and the public admin username is kept.
     * ------------------------------------------------------------------- */

    readLocalAdminActivity() {
      const raw = safeStorageGet(globalThis.localStorage, ADMIN_ACTIVITY_STORAGE_KEY);
      if (!raw) return emptyAdminActivity();
      try { return normalizeAdminActivity(JSON.parse(raw)); }
      catch { return emptyAdminActivity(); }
    },
    writeLocalAdminActivity(activity) {
      const normalized = normalizeAdminActivity(activity);
      safeStorageSet(globalThis.localStorage, ADMIN_ACTIVITY_STORAGE_KEY, JSON.stringify(normalized));
      return normalized;
    },
    readPendingAdminActivity() {
      const raw = safeStorageGet(globalThis.localStorage, ADMIN_ACTIVITY_PENDING_KEY);
      if (!raw) return emptyAdminActivity();
      try { return normalizeAdminActivity(JSON.parse(raw)); }
      catch { return emptyAdminActivity(); }
    },
    writePendingAdminActivity(activity) {
      const normalized = normalizeAdminActivity(activity);
      if (normalized.logins.length || normalized.uploads.length) {
        safeStorageSet(globalThis.localStorage, ADMIN_ACTIVITY_PENDING_KEY, JSON.stringify(normalized));
      } else {
        safeStorageRemove(globalThis.localStorage, ADMIN_ACTIVITY_PENDING_KEY);
      }
      this.adminActivityStatus.pendingCount = normalized.logins.length + normalized.uploads.length;
      return normalized;
    },
    /** Load this device's copy, plus anything still waiting to be shared. */
    hydrateAdminActivity() {
      const local = this.readLocalAdminActivity();
      const pending = this.readPendingAdminActivity();
      const merged = mergeAdminActivity(local, pending, this.adminActivity);
      this.adminActivity = merged;
      this.writeLocalAdminActivity(merged);
      this.writePendingAdminActivity(pending);
      this.adminActivityStatus.loading = false;
      return merged;
    },
    /**
     * Absorb a record read from the website or GitHub. The union is kept, so a
     * record that is a few minutes behind a deployment can never remove a
     * sign-in this device already knows about.
     */
    absorbAdminActivity(activity, { source = 'local', updatedAt = '' } = {}) {
      const normalized = normalizeAdminActivity(activity);
      if (!normalized.logins.length && !normalized.uploads.length && !normalized.updatedAt) return this.adminActivity;
      const merged = mergeAdminActivity(this.adminActivity, normalized);
      this.adminActivity = merged;
      this.writeLocalAdminActivity(merged);
      this.adminActivityStatus.loading = false;
      this.adminActivityStatus.source = source;
      this.adminActivityStatus.error = '';
      if (updatedAt || normalized.updatedAt) this.adminActivityStatus.githubUpdatedAt = updatedAt || normalized.updatedAt;
      return merged;
    },
    recordAdminActivityEntry(kind, entry) {
      const next = kind === 'upload'
        ? withAdminUpload(this.adminActivity, entry)
        : withAdminLogin(this.adminActivity, entry);
      const normalizedEntry = kind === 'upload'
        ? normalizeUploadEntry(entry)
        : normalizeLoginEntry(entry);
      if (!normalizedEntry) return;
      this.adminActivity = { ...next, updatedAt: new Date().toISOString() };
      this.writeLocalAdminActivity(this.adminActivity);
      // Queue the entry for the shared record. It stays queued until a write
      // to GitHub succeeds, so a locked token delays sharing but never loses
      // the sign-in.
      const pending = this.readPendingAdminActivity();
      const queued = kind === 'upload'
        ? withAdminUpload(pending, normalizedEntry)
        : withAdminLogin(pending, normalizedEntry);
      this.writePendingAdminActivity(queued);
      this.adminActivityStatus.source = this.adminActivityStatus.source === 'github' ? 'github' : 'local';
      this.syncAdminActivityToGitHub({ silent: true });
    },
    /** Remember that the administrator signed in, on this device and shared. */
    recordAdminLogin() {
      this.recordAdminActivityEntry('login', {
        at: new Date().toISOString(),
        user: SITE_CONFIG.admin.username || 'administrator'
      });
    },
    /** Remember a published file, so the dashboard can list the latest uploads. */
    recordAdminUpload(item) {
      if (!item) return;
      this.recordAdminActivityEntry('upload', {
        at: new Date().toISOString(),
        path: item.path || '',
        name: item.fileName || '',
        title: item.name || item.fileName || '',
        bytes: Number(item.size) || 0,
        subject: item.meta?.subject || '',
        years: item.meta?.years || [],
        owner: item.meta?.owner || ''
      });
    },
    /**
     * Merge queued and local entries into stats/admin-activity.json. Silent by
     * default: signing in or publishing never fails because the activity
     * record could not be written, and the entries simply stay queued.
     */
    async syncAdminActivityToGitHub({ silent = false } = {}) {
      if (this.adminActivityStatus.syncing) return false;
      if (!this.githubAuth.connected || !this.githubAuth.activeToken) {
        if (!silent) this.notify('Connect a GitHub token in Settings to share administrator activity with every computer.', 'info');
        return false;
      }
      const pending = this.readPendingAdminActivity();
      if (!pending.logins.length && !pending.uploads.length) {
        if (!silent) this.notify('Every administrator sign-in and upload is already saved to the repository.', 'success');
        return true;
      }
      this.adminActivityStatus.syncing = true;
      try {
        const target = this.repositoryTarget;
        const result = await mergeAdminActivityIntoGitHub({
          owner: target.owner,
          repo: target.name,
          branch: this.githubConfig.branch || SITE_CONFIG.repository.branch,
          token: this.githubAuth.activeToken,
          activity: pending
        });
        // Only the entries that were actually written are cleared from the
        // queue; a new sign-in recorded during the request is kept.
        const stillPending = mergeAdminActivity(this.readPendingAdminActivity());
        const writtenKeys = new Set([
          ...pending.logins.map(entry => activityEntryKey('login', entry)),
          ...pending.uploads.map(entry => activityEntryKey('upload', entry))
        ]);
        this.writePendingAdminActivity({
          logins: stillPending.logins.filter(entry => !writtenKeys.has(activityEntryKey('login', entry))),
          uploads: stillPending.uploads.filter(entry => !writtenKeys.has(activityEntryKey('upload', entry)))
        });
        this.adminActivityStatus.source = 'github';
        this.adminActivityStatus.githubUpdatedAt = new Date().toISOString();
        this.adminActivityStatus.error = '';
        if (!silent) {
          this.notify(`Administrator activity saved to ${ADMIN_ACTIVITY_PATH} (${result.logins} sign-in${result.logins === 1 ? '' : 's'}, ${result.uploads} upload${result.uploads === 1 ? '' : 's'} in this save).`, 'success');
        }
        return true;
      } catch (error) {
        this.adminActivityStatus.error = `The shared activity record could not be updated (${error?.message || 'unknown error'}). Entries stay queued and are sent on the next successful save.`;
        if (!silent) this.notify(this.adminActivityStatus.error, 'error');
        return false;
      } finally {
        this.adminActivityStatus.syncing = false;
        this.refreshIcons();
      }
    },
    /** Re-read the website's copy and share anything still queued. */
    async refreshAdminActivity({ announce = true } = {}) {
      this.adminActivityStatus.loading = true;
      try {
        const data = await this.fetchJson(`./${ADMIN_ACTIVITY_PATH}?v=${Date.now()}`, { retries: 0 });
        this.absorbAdminActivity(data, { source: 'github', updatedAt: data?.updatedAt || '' });
      } catch {
        this.adminActivityStatus.source = 'cache';
      } finally {
        this.adminActivityStatus.loading = false;
      }
      await this.syncAdminActivityToGitHub({ silent: !announce });
      if (announce) this.notify(this.adminActivityPendingLabel || 'Administrator activity refreshed.', 'success');
      this.refreshIcons();
    },
    async syncAdminActivityFromButton() {
      if (!this.guardAction('sync')) {
        this.notify(this.rateLimit.message, 'error');
        return;
      }
      await this.refreshAdminActivity({ announce: true });
    },

    /* ---------------------------------------------------------------------
     * Cloud file details: size and storage age
     *
     * `apps.json` carries no size, and older uploads have no `addedAt`, so the
     * dashboard reads both from GitHub when it needs them: one directory
     * listing for sizes and one commit lookup per file that has no recorded
     * date. Resolved dates are cached on this device so the API is not asked
     * twice.
     * ------------------------------------------------------------------- */

    readCachedCloudFileDates() {
      const raw = safeStorageGet(globalThis.localStorage, CLOUD_FILE_DATES_STORAGE_KEY);
      if (!raw) return {};
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const result = {};
        for (const [path, value] of Object.entries(parsed)) {
          if (!/^apps\/[^/]+$/.test(path) || !Number.isFinite(Date.parse(String(value)))) continue;
          result[path] = new Date(Date.parse(String(value))).toISOString();
        }
        return result;
      } catch {
        return {};
      }
    },
    saveCachedCloudFileDates(dates) {
      if (dates && typeof dates === 'object' && Object.keys(dates).length) {
        safeStorageSet(globalThis.localStorage, CLOUD_FILE_DATES_STORAGE_KEY, JSON.stringify(dates));
      }
    },
    /** Apply resolved sizes and upload dates to the live library items. */
    applyCloudFileDetails({ sizes = {}, addedAt = {} } = {}) {
      let changed = 0;
      const items = this.libraryItems.map(item => {
        const size = Number(sizes[item.path]);
        const date = addedAt[item.path];
        const nextSize = Number.isFinite(size) && size > 0 ? size : item.size;
        const nextAddedAt = Number.isFinite(Date.parse(String(date || ''))) ? date : (item.addedAt || item.meta?.addedAt || '');
        if (nextSize === item.size && nextAddedAt === (item.addedAt || '')) return item;
        changed += 1;
        return { ...item, size: nextSize, addedAt: nextAddedAt, meta: { ...item.meta, bytes: nextSize || item.meta?.bytes || 0, addedAt: nextAddedAt || item.meta?.addedAt || '' } };
      });
      if (changed) this.libraryItems = items;
      return changed;
    },
    /**
     * Ask GitHub for the missing sizes and upload dates. Best effort: a failed
     * or rate-limited lookup reports what went wrong and leaves the dashboard
     * fully usable.
     */
    async refreshCloudFileDetails({ silent = false, maxDateLookups = CLOUD_FILE_DATE_LOOKUP_BUDGET } = {}) {
      if (this.cloudDetails.refreshing) return false;
      const files = this.apps.filter(item => item.source === 'github');
      if (!files.length) {
        if (!silent) this.notify('There are no published files to measure yet.', 'info');
        return false;
      }
      this.cloudDetails.refreshing = true;
      this.cloudDetails.message = 'Reading file sizes and upload dates from GitHub…';
      this.cloudDetails.error = '';
      try {
        const target = this.repositoryTarget;
        // A date recorded in library.json at upload time is authoritative and
        // free; only files without one cost a commit lookup. Recorded dates are
        // folded into the device cache so they are available offline too.
        const knownDates = { ...this.readCachedCloudFileDates() };
        for (const item of files) {
          const recorded = item.addedAt || item.meta?.addedAt || '';
          if (recorded && Number.isFinite(Date.parse(recorded))) knownDates[item.path] = recorded;
        }
        const needsDates = files
          .filter(item => !(item.addedAt || item.meta?.addedAt))
          .map(item => item.path);
        const details = await readCloudFileDetails({
          owner: target.owner,
          repo: target.name,
          branch: this.githubConfig.branch || SITE_CONFIG.repository.branch,
          paths: needsDates,
          knownDates,
          maxDateLookups
        });
        const mergedDates = { ...knownDates, ...details.addedAt };
        this.saveCachedCloudFileDates(mergedDates);
        const changed = this.applyCloudFileDetails({ sizes: details.sizes, addedAt: mergedDates });
        this.cloudDetails.refreshedAt = new Date().toISOString();
        if (details.warnings.length && !Object.keys(details.sizes).length) {
          this.cloudDetails.error = details.warnings[0];
          this.cloudDetails.message = '';
          if (!silent) this.notify(details.warnings[0], 'error');
        } else {
          this.cloudDetails.message = `Checked ${changed} file${changed === 1 ? '' : 's'} — sizes and storage ages are up to date.`;
          if (!silent) this.notify(this.cloudDetails.message, 'success');
        }
        return true;
      } catch (error) {
        this.cloudDetails.error = error?.message || 'GitHub could not be reached to read file details.';
        this.cloudDetails.message = '';
        if (!silent) this.notify(this.cloudDetails.error, 'error');
        return false;
      } finally {
        this.cloudDetails.refreshing = false;
        this.refreshIcons();
      }
    },

    async refreshStats() {
      if (this.stats.loadingDownloads) return;
      if (!this.guardAction('refresh')) {
        this.notify(this.rateLimit.message, 'error');
        return;
      }
      await Promise.all([
        this.countVisitor(),
        this.loadDownloadCounters(this.apps, true)
      ]);
      this.stats.updatedAtLabel = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      // Sizes and storage ages come from GitHub rather than the counters, so
      // they are refreshed alongside the totals but never block them.
      if (this.cloudDetailsMissingCount > 0) this.refreshCloudFileDetails({ silent: true });
      this.refreshAdminActivity({ announce: false });
    },

    async retryLoad() { await this.loadLibrary({ force: true }); },
    async syncFromGithub() {
      this.syncing = true;
      try {
        await this.loadLibrary({ force: true });
        this.notify(this.errors.library ? 'Library refresh failed.' : 'Library refreshed from the published site.', this.errors.library ? 'error' : 'success');
      } finally {
        this.syncing = false;
      }
    },

    refreshIcons() {
      requestAnimationFrame(() => {
        try { window.lucide?.createIcons?.(); } catch { /* Icons are decorative. */ }
      });
    },

    refreshWebsite() {
      this.refreshingSite = true;
      const registration = navigator.serviceWorker?.getRegistration?.();
      Promise.resolve(registration).then(reg => reg?.update?.()).catch(() => {}).finally(() => {
        window.setTimeout(() => window.location.reload(), 150);
      });
    },

    openDashboard() {
      if (!this.isAdmin) return;
      this.currentView = 'dashboard';
      this.refreshIcons();
      // The dashboard is a reporting view: refresh stale per-file values from
      // Abacus instead of only loading counters not seen on the student page.
      if (!this.stats.loadingDownloads) this.loadDownloadCounters(this.apps, true);
    },
    openUpload() {
      if (!this.isAdmin) return this.openLogin('admin');
      this.uploadMessage = '';
      this.draftErrors = { file: '', title: '', subject: '', years: '', owner: '' };
      this.currentView = 'upload';
      this.refreshIcons();
    },
    openAdminWorkspace(destination) {
      if (!this.isAdmin) return;
      if (destination === 'upload') return this.openUpload();
      if (destination === 'account') return this.openAdminAccountSettings();
      if (destination === 'settings') return this.openCloudSettings();
      if (destination === 'library') return this.currentView = 'library';
      this.currentView = destination || 'dashboard';
    },
    /**
     * Open Cloud Settings behind the master-password gate. Every entry point
     * starts locked, including clicking the settings icon a second time.
     */
    openCloudSettings({ focusAccount = false } = {}) {
      if (!this.isAdmin) return this.openLogin('admin');
      this.lockAdminAccount();
      this.adminAccount.focusAccountOnUnlock = Boolean(focusAccount);
      this.currentView = 'settings';
      this.refreshIcons();
      this.$nextTick(() => document.getElementById('master-password')?.focus({ preventScroll: true }));
    },
    /** Open Cloud Settings and scroll to the Administrator account after unlock. */
    openAdminAccountSettings() {
      this.openCloudSettings({ focusAccount: true });
    },

    openLogin() {
      this.loginMode = 'admin';
      this.loginError = '';
      this.loginForm.username = '';
      this.loginForm.password = '';
      this.showLogin = true;
      this.$nextTick(() => document.getElementById('login-user')?.focus());
      this.refreshIcons();
    },
    async login() {
      if (this.checkingLogin) return;
      if (!this.guardAction('login')) {
        this.loginError = this.rateLimit.message;
        return;
      }
      this.checkingLogin = true;
      this.loginError = '';
      try {
        const result = await verifyConfiguredAdmin(this.loginForm.username, this.loginForm.password);
        if (result.configurationMissing) {
          this.loginError = 'Administrator sign-in is not configured on this deployment. Set the username, salt and SHA-256 digest in assets/js/config.js — never the plain password.';
          return;
        }
        if (!result.ok) {
          // Wrong passwords get slower every time, and repeated guessing is
          // locked out by the rate limiter above.
          const delay = this.registerFailedAttempt('login');
          if (delay > 0) await sleep(delay);
          this.loginError = 'The username or password is incorrect.';
          return;
        }
        this.clearRateLimit('login');
        this.isAdmin = true;
        // Held in memory for this visit only: it is the key that opens the
        // token this website stores for every computer.
        const signInPassword = String(this.loginForm.password || '');
        this.rememberSessionPassword('admin', signInPassword);
        try { sessionStorage.setItem(ADMIN_LOGIN_SESSION_KEY, SITE_CONFIG.admin.username); } catch { /* Current tab stays signed in. */ }
        // Reconnect the token saved on this device (and quietly re-check it)
        // so returning administrators start ready to publish. On a computer
        // that has never been used before there is nothing saved locally, so
        // the encrypted copy carried by the website is unlocked instead.
        if (this.restoreSavedGithubToken()) this.verifySavedGithubToken();
        else {
          this._websiteTokenPromise = this.unlockTokenFromWebsite({
            slot: 'admin', password: signInPassword, announce: true
          }).catch(() => false);
        }
        this.showLogin = false;
        this.loginForm.password = '';
        // Announce presence straight away so the indicator lights up for
        // students and other administrators without waiting for the interval.
        this.startAdminPresenceHeartbeat();
        // Record the sign-in for the dashboard statistics — today, this week,
        // this month and the latest sign-in — on this device and in the shared
        // record every other computer reads.
        this.recordAdminLogin();
        this.openDashboard();
      } catch (error) {
        this.loginError = error?.message || 'Could not check the admin sign-in.';
      } finally {
        this.checkingLogin = false;
      }
    },
    logout() {
      this.stopAdminPresenceHeartbeat();
      this.isAdmin = false;
      // The passwords that unlock the stored token leave memory with the
      // session; the encrypted copy in the website is untouched.
      this.clearSessionPasswords();
      this.githubAuth.activeToken = '';
      this.githubAuth.token = '';
      this.githubAuth.connected = false;
      this.githubAuth.login = '';
      this.githubAuth.cloudSecretSaved = false;
      this.githubAuth.cloudSecretAlreadySaved = false;
      this.githubAuth.error = '';
      this.loginForm.password = '';
      this.lockAdminAccount();
      safeStorageRemove(globalThis.sessionStorage, ADMIN_LOGIN_SESSION_KEY);
      // Signing out ends this session but keeps the remembered token saved on
      // this device, so the next sign-in reconnects without pasting it again.
      this.githubAuth.remembered = Boolean(this.readSavedGithubToken());
      this.currentView = 'library';
      this.showLogin = false;
      this.notify(
        this.githubAuth.website.saved
          ? 'You have signed out. The encrypted token stays stored in the website, so signing in on any computer reconnects publishing.'
          : this.githubAuth.remembered
            ? 'You have signed out. The GitHub token stays saved on this device and reconnects the next time you sign in.'
            : 'You have signed out. The repository Actions secret remains in GitHub.',
        'success'
      );
    },

    focusLibrarySearch() {
      this.currentView = 'library';
      this.$nextTick(() => document.getElementById('library-search')?.focus());
    },
    browseLatest() {
      this.clearFilters();
      this.filters.sort = 'newest';
      this.currentView = 'library';
    },
    browseSubject(subject) {
      this.filters.subject = subject;
      this.currentView = 'library';
      document.getElementById('library-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    setKind(kind) { this.filters.kind = this.filters.kind === kind ? '' : kind; },
    setSubject(subject) { this.filters.subject = this.filters.subject === subject ? '' : subject; },
    setYear(year) { this.filters.year = String(this.filters.year) === String(year) ? '' : String(year); },
    clearFilters() { this.filters = { ...this.filters, query: '', kind: '', subject: '', year: '' }; },
    openPreview(item) {
      const descriptor = previewDescriptor(item);
      if (!descriptor) {
        this.notify('A preview is not available for this file type. Use Download instead.', 'info');
        return;
      }
      this.preview.item = item;
      this.preview.descriptor = descriptor;
      this.preview.open = true;
      this.loading.preview = true;
      this.errors.preview = '';
      this.$nextTick(() => document.getElementById('preview-close')?.focus());
      window.setTimeout(() => {
        if (this.preview.open && this.loading.preview) this.onPreviewLoad();
      }, 9000);
    },
    downloadApp(item) {
      const href = resolveFileUrl(item);
      if (!href) {
        this.notify('This file has no safe download link. Refresh the library and try again.', 'error');
        return;
      }
      const key = item.counterKey || downloadCounterKey(item.path);
      const current = this.downloadsOf(item);
      this.stats.downloads[item.id] = current + 1;
      writeLocalCounter(key, current + 1);
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.target = '_blank';
      anchor.rel = 'noopener noreferrer';
      anchor.download = item.fileName || '';
      anchor.setAttribute('aria-hidden', 'true');
      anchor.style.position = 'fixed';
      anchor.style.left = '-9999px';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      this.notify(`Download started successfully for “${item.name}”.`, 'success');

      // Do not block the student's download on analytics. Abacus is contacted
      // exactly once per click; a failure falls back to a per-browser count.
      if (this._counterClient) {
        this._counterClient.hit(key).then(value => {
          const total = Math.max(this.downloadsOf(item), value);
          this.stats.downloads[item.id] = total;
          writeLocalCounter(key, total);
          this._downloadCountersOnline = true;
          this.updateCounterStatus();
        }).catch(() => {
          this.updateCounterStatus();
        });
      }
    },
    confirmDeleteApp(item) {
      if (!this.isAdmin) return this.openLogin('admin');
      if (!item || item.source !== 'github') {
        this.notify('Only GitHub-published files can be deleted from the repository.', 'info');
        return;
      }
      if (!this.githubAuth.connected || !this.githubAuth.activeToken) {
        this.notify('Connect a GitHub token in Settings before deleting a repository file.', 'error');
        this.openCloudSettings();
        return;
      }
      if (this.deletingAppId) return;
      if (!window.confirm(`Delete “${item.name}” from GitHub (file, library metadata and saved download counts) and the public library? This cannot be undone.`)) return;
      this.deleteGithubResource(item);
    },
    async deleteGithubResource(item) {
      if (this.deletingAppId) return;
      if (!this.guardAction('delete')) {
        this.notify(this.rateLimit.message, 'error');
        return;
      }
      this.deletingAppId = item.id;
      const target = this.repositoryTarget;
      const branch = this.githubConfig.branch || SITE_CONFIG.repository.branch;
      try {
        await deleteResourceFromGitHub({
          owner: target.owner, repo: target.name, branch,
          token: this.githubAuth.activeToken, path: item.path
        });
        // Drop the file's saved download total from the shared GitHub record
        // so it stops appearing in statistics after the next Pages deploy.
        // The live Abacus counter itself cannot be deleted: counters created
        // by anonymous hits have no admin key, and Abacus expires idle
        // counters automatically after 6 months.
        let statsWarning = '';
        try {
          await removeDownloadStatsForPath({
            owner: target.owner, repo: target.name, branch,
            token: this.githubAuth.activeToken, path: item.path
          });
        } catch (error) {
          statsWarning = ' Its saved download total in stats/downloads.json still needs cleanup.';
        }
        this.forgetDeletedResource(item);
        this.notify(
          `“${item.name}” was deleted from GitHub (file, library metadata and saved download counts) and removed from this website. Other devices update after GitHub Pages finishes deploying.${statsWarning}`,
          statsWarning ? 'error' : 'success'
        );
        // Jekyll regenerates apps.json during the Pages build; re-read after a
        // short delay so the current browser converges to the published list.
        window.setTimeout(() => this.loadLibrary(), 15_000);
      } catch (error) {
        if (error.deletedPath) this.forgetDeletedResource(item);
        this.notify(error.deletedPath
          ? 'The file was deleted, but its library metadata still needs cleanup. Check library.json in GitHub.'
          : (error.message || 'The file could not be deleted.'), 'error');
      } finally {
        this.deletingAppId = '';
        this.updateIntegrityReport();
        this.refreshIcons();
      }
    },
    forgetDeletedResource(item) {
      if (!item) return;
      this.libraryItems = this.libraryItems.filter(entry => entry.id !== item.id);
      delete this.stats.downloads[item.id];
      this._counterReadStarted = this._counterReadStarted.filter(id => id !== item.id);
      this._counterReadInFlight = this._counterReadInFlight.filter(id => id !== item.id);
      delete this._counterReadAt[item.id];
      try {
        this.downloadStatsRecord?.files?.delete(String(item.path || '').normalize('NFC').toLowerCase());
      } catch {
        // The GitHub-saved record is advisory; a failed cleanup must not
        // break deletion.
      }
      this.purgeDeletedFileFromCache(item);
    },
    async purgeDeletedFileFromCache(item) {
      // Fire-and-forget: every failure path is swallowed so cache quirks can
      // never break (or un-delete) a resource removal.
      try {
        if (!('caches' in globalThis)) return;
        const base = globalThis.location?.href || 'https://schoolcloud.invalid/';
        const candidates = [item?.path, item?.downloadUrl, item?.url]
          .filter(value => typeof value === 'string' && value)
          .map(value => {
            try {
              return new URL(value, base).href;
            } catch {
              return '';
            }
          })
          .filter(Boolean);
        // The library manifests are re-fetched with a cache-busting query on
        // every load, but purge their canonical keys too so no stale entry
        // can outlive the deleted file.
        for (const manifest of ['apps.json', 'library.json', 'stats/downloads.json']) {
          try {
            candidates.push(new URL(`./${manifest}`, base).href);
          } catch {
            // Ignore unresolvable manifest URLs.
          }
        }
        const names = await caches.keys();
        await Promise.all(names.map(async name => {
          if (!String(name).startsWith('schoolcloud-')) return;
          try {
            const cache = await caches.open(name);
            await Promise.all(candidates.map(url => cache.delete(url).catch(() => false)));
          } catch {
            // A locked cache must not break deletion.
          }
        }));
      } catch {
        // The Cache API may be unavailable (private browsing, old browsers).
      }
    },

    downloadsOf(item) { return Math.max(0, Number(this.stats.downloads[item?.id]) || 0); },
    downloadLabel(item) { return `Download count: ${formatCount(this.downloadsOf(item))}`; },
    isLatest(item) { return calculateAgeDays(item?.addedAt || item?.meta?.addedAt) < 1; },
    freshness(item) { return freshness(item); },
    isReviewDue(value) { return isReviewDue(value); },
    formatCount(value) { return formatCount(value); },
    formatDate(value) { return formatDate(value); },
    formatDateTime(value) { return formatDateTime(value); },
    formatRelativeTime(value) { return formatRelativeTime(value); },
    formatStoredDays(value) { return formatStoredDays(value); },
    formatBytes(value) { return formatBytes(value); },
    formatYears(value) { return formatYears(value); },
    formatDownloadCount(value) { return formatDownloadCount(value); },
    fileExtension(item) { return fileExtension(item); },
    fileIcon(item) { return fileIcon(item); },
    kindLabel(item) { return kindLabel(item); },
    subjectAccent(subject) { return subjectAccent(subject); },
    visibilityAccent(value) { return visibilityAccent(value); },
    visibilityLabel(value) { return visibilityLabel(value); },
    sharePercent(item) { return this.totalDownloads ? Math.round(this.downloadsOf(item) / this.totalDownloads * 100) : 0; },
    canPreview(item) { return canPreviewItem(item); },
    titlePlaceholder() { return this.draftFile ? `A clear title for ${titleFromFilename(this.draftFile.name)}` : 'e.g. Year 12 HSC Mathematics — Revision'; },

    setDraftFile(file) {
      this.draftErrors.file = '';
      this.uploadMessage = '';
      this.uploadChecks = [];
      this.uploadWarnings = [];
      this.uploadAcknowledgedWarnings = false;
      this.uploadResult = null;
      this._draftBytes = null;
      this._draftDigest = '';
      this._inspectSequence += 1;
      if (!file) return;
      if (!isSupportedFile(file.name)) {
        this.draftErrors.file = 'Use an HTML, PDF, Word, Excel or PowerPoint file.';
        return;
      }
      if (file.size > SITE_CONFIG.maxUploadBytes) {
        this.draftErrors.file = `Files must be 50 MB or smaller. This file is ${formatBytes(file.size)}.`;
        return;
      }
      if (this.draftFilePreview?.src?.startsWith('blob:')) URL.revokeObjectURL(this.draftFilePreview.src);
      this.draftFile = file;
      this.draftFilePreview = makeDraftPreview(file);
      if (!this.draft.title) this.draft.title = titleFromFilename(file.name);
      const guessed = inferMetadata(file.name);
      if (!this.draft.subject && guessed.subject !== 'Others') this.draft.subject = guessed.subject;
      if (!this.draft.years && guessed.years.length) this.draft.years = String(guessed.years[0]);
      // Inspect the bytes for real type, embedded programs and unsafe HTML. The
      // report is ready before the administrator reaches the publish button.
      this.inspectSelectedFile();
      this.refreshIcons();
    },
    handleFileChange(event) { this.setDraftFile(event?.target?.files?.[0] || null); },
    handleFileDrop(event) { this.setDraftFile(event?.dataTransfer?.files?.[0] || null); },
    suggestedSubject() {
      if (!this.draftFile) return '';
      const subject = inferMetadata(this.draftFile.name).subject;
      return SUBJECTS.includes(subject) && subject !== 'Others' ? subject : '';
    },
    suggestedYearsLabel() {
      if (!this.draftFile) return '';
      const years = inferMetadata(this.draftFile.name).years;
      return years.length ? `Year ${years[0]}` : '';
    },
    applySuggestedSubject() { this.draft.subject = this.suggestedSubject(); },
    applySuggestedYears() {
      const year = inferMetadata(this.draftFile?.name || '').years[0];
      if (year) this.draft.years = String(year);
    },

    async submitResource() {
      if (!this.isAdmin) return this.openLogin('admin');
      // A second click while an upload is running must never start a second
      // upload of the same file.
      if (this.submitting) return;
      this.draftErrors = { file: '', title: '', subject: '', years: '', owner: '' };
      this.uploadMessage = '';
      if (!this.draftFile) this.draftErrors.file = 'Choose a file to publish.';
      if (!this.draft.title.trim()) this.draftErrors.title = 'Enter a clear title for students.';
      if (!SUBJECTS.includes(this.draft.subject)) this.draftErrors.subject = 'Choose one of the listed subjects.';
      if (!VALID_YEAR_LEVELS.has(String(this.draft.years))) this.draftErrors.years = 'Choose a year level from 9 to 12.';
      if (!this.draft.owner.trim()) this.draftErrors.owner = 'Enter the resource owner or department contact.';
      if (this.draft.description.length > MAX_DESCRIPTION_LENGTH) {
        this.uploadMessage = 'The description must be 3,000 characters or fewer.';
        this.uploadMessageTone = 'error';
      }
      const invalid = Object.values(this.draftErrors).some(Boolean) || Boolean(this.uploadMessage);
      if (invalid) return;
      if (this.uploadNeedsAcknowledgement) {
        this.uploadMessageTone = 'error';
        this.uploadMessage = 'Review the safety findings for this file and tick the acknowledgement before publishing.';
        return;
      }
      if (!this.githubAuth.connected || !this.githubAuth.activeToken) {
        this.uploadMessage = this.tokenMissingMessage;
        this.uploadMessageTone = 'error';
        return;
      }
      if (!this.draftFile || this.draftFile.size > SITE_CONFIG.maxUploadBytes) {
        this.draftErrors.file = 'Files must be 50 MB or smaller.';
        return;
      }
      // Repeated-click and rate protection: the attempt is recorded before any
      // work starts, so double-clicking or clicking again after a failure
      // cannot queue up several publishes.
      if (!this.guardAction('upload')) {
        this.uploadMessageTone = 'error';
        this.uploadMessage = this.rateLimit.message;
        return;
      }
      if (!this._exclusive.begin('upload')) {
        this.uploadMessageTone = 'info';
        this.uploadMessage = 'An upload is already running. Wait for it to finish before starting another.';
        return;
      }

      this.submitting = true;
      this.uploadMessage = '';
      this.uploadResult = null;
      this.uploadPercent = 0;
      this.uploadStage = 'reading';
      this.uploadStageLabel = UPLOAD_STAGE_LABELS.reading;
      this.uploadDetail = 'Reading the file from this device…';
      this.uploadAcknowledgedWarnings = false;
      this.armUploadUnloadGuard();
      this.startUploadTimer();

      const keywords = String(this.draft.keywords || '').split(',').map(value => value.trim()).filter(Boolean);
      const metadata = {
        title: this.draft.title.trim(),
        description: this.draft.description.trim(),
        topic: this.draft.topic.trim(),
        subject: this.draft.subject,
        years: [Number(this.draft.years)],
        tags: keywords,
        keywords,
        owner: this.draft.owner.trim(),
        department: this.draft.department.trim(),
        academicYear: this.draft.academicYear.trim(),
        resourceType: this.draft.resourceType,
        language: this.draft.language,
        visibility: this.draft.visibility,
        version: this.draft.version.trim(),
        reviewDate: this.draft.reviewDate,
        licence: this.draft.licence,
        accessibility: this.draft.accessibility.trim(),
        addedAt: new Date().toISOString()
      };
      const target = this.repositoryTarget;
      try {
        const bytes = this._draftBytes instanceof Uint8Array
          ? this._draftBytes
          : await readFileBytes(this.draftFile, {
            onProgress: ({ loaded, total }) => {
              if (total > 0) this.uploadDetail = `Reading the selected file… ${Math.round(loaded / total * 100)}%`;
            }
          });
        this._draftBytes = bytes;

        // Everything sent to GitHub is re-checked against the exact bytes held
        // in memory: nothing is published that has not just passed the scan.
        const report = await inspectUpload({ name: this.draftFile.name, bytes });
        this.uploadChecks = report.checks;
        this.uploadWarnings = report.warnings;
        if (!report.ok) {
          this.draftErrors.file = report.errors.join(' ');
          throw new Error('The file did not pass the safety checks, so nothing was sent to GitHub.');
        }
        if (report.warnings.length && !this.uploadAcknowledgedWarnings) {
          throw new Error('The safety scan found something to review. Check the findings below, tick the acknowledgement, then publish again.');
        }
        const digest = report.digest || this._draftDigest || await sha256HexBytes(bytes);
        this._draftDigest = digest;

        const result = await uploadResourceToGitHub({
          owner: target.owner,
          repo: target.name,
          branch: this.githubConfig.branch || SITE_CONFIG.repository.branch,
          token: this.githubAuth.activeToken,
          file: this.draftFile,
          metadata,
          fileBytes: bytes,
          bytes: bytes.length,
          sha256: digest,
          verify: this.uploadVerify !== false,
          onProgress: progress => this.applyUploadProgress(progress)
        });
        this.uploadResult = { ...result, fileSize: bytes.length };

        // Show the new resource on this device immediately; the published
        // manifest follows when GitHub Pages finishes deploying.
        const item = normalizeLibraryEntry({
          type: 'file', name: result.name, path: result.path,
          download_url: result.downloadUrl, size: bytes.length
        }, { ...metadata, sha256: result.sha256, bytes: result.bytes });
        if (item && !this.libraryItems.some(existing => existing.id === item.id)) {
          item.counterKey = downloadCounterKey(item.path);
          this.libraryItems = [...this.libraryItems, item];
          this.stats.downloads[item.id] = 0;
        }
        // Log the upload so "latest uploads" and the cloud inventory show what
        // arrived, how big it is and how long it has been stored.
        this.recordAdminUpload(item || {
          path: result.path, fileName: result.name, name: result.name, size: bytes.length, meta: { subject: metadata.subject, years: metadata.years, owner: metadata.owner }
        });
        this.notify(
          `“${item?.name || result.name}” was stored in GitHub cloud storage and published successfully.${this.uploadVerificationNote(result)}`,
          'success'
        );
        this.resetDraft();
        this.currentView = 'library';
        this.updateIntegrityReport();
        this.refreshIcons();
        // Jekyll regenerates apps.json during the Pages build; re-read after a
        // short delay so the current browser converges to the published list.
        window.setTimeout(() => this.loadLibrary(), 15_000);
      } catch (error) {
        this.uploadMessageTone = 'error';
        this.uploadMessage = error.uploadedPath
          ? `The file was uploaded to ${error.uploadedPath}, but library metadata could not be updated: ${error.message}`
          : `${error.message || 'The upload failed.'} Your file is still selected, so nothing needs re-entering — check the connection (and that you are still online) and press Publish again.`;
        this.uploadDetail = '';
      } finally {
        this.submitting = false;
        this._exclusive.end('upload');
        this.stopUploadTimer();
        this.releaseUploadUnloadGuard();
        this.uploadStage = '';
        this.uploadStageLabel = '';
        this.refreshRateLimitState();
        this.refreshIcons();
      }
    },

    resetDraft() {
      if (this.draftFilePreview?.src?.startsWith('blob:')) URL.revokeObjectURL(this.draftFilePreview.src);
      this.draft = emptyDraft();
      this.draftFile = null;
      this.draftFilePreview = null;
      this.draftErrors = { file: '', title: '', subject: '', years: '', owner: '' };
      // The uploaded bytes and safety report describe the file that was just
      // published; `uploadResult` is kept as the verification receipt.
      this.uploadChecks = [];
      this.uploadWarnings = [];
      this.uploadAcknowledgedWarnings = false;
      this.uploadPercent = 0;
      this._draftBytes = null;
      this._draftDigest = '';
      this._inspectSequence += 1;
      const input = document.getElementById('resource-file');
      if (input) input.value = '';
    },

    async saveSettings() {
      if (!this.isAdmin) return this.openLogin('admin');
      if (!this.guardAction('settings')) {
        this.notify(this.rateLimit.message, 'error');
        return;
      }
      const target = parseRepoName(this.githubConfig.repo, '', '');
      if (!target.owner || !target.name) {
        this.notify('Enter the repository as owner/name, for example Petgabs/HSC.', 'error');
        return;
      }
      this.githubConfig.repo = `${target.owner}/${target.name}`;
      this.githubConfig.branch = this.githubConfig.branch || SITE_CONFIG.repository.branch;
      try { localStorage.setItem('schoolcloud.repository', this.githubConfig.repo); } catch { /* Browser-only convenience. */ }
      await this.loadLibrary({ force: true });
      // A token remembered for the previous repository is re-checked against
      // the newly saved one so the Connected state stays truthful.
      if (this.githubAuth.connected && this.githubAuth.activeToken) this.verifySavedGithubToken();
      this.notify('Repository settings saved and the published library refreshed.', this.errors.library ? 'error' : 'success');
    },
    async connectGithub() {
      if (!this.isAdmin) return this.openLogin('admin');
      if (this.githubAuth.verifying) return;
      if (!this.guardAction('token')) {
        this.githubAuth.error = this.rateLimit.message;
        return;
      }
      this.githubAuth.error = '';
      const token = String(this.githubAuth.token || '').trim();
      if (!token) {
        this.githubAuth.error = 'Paste the new fine-grained GitHub token first.';
        return;
      }
      this.githubAuth.verifying = true;
      try {
        const target = this.repositoryTarget;
        const result = await verifyGitHubToken({ token, owner: target.owner, repo: target.name });
        this.githubAuth.activeToken = token;
        this.githubAuth.token = '';
        this.githubAuth.connected = true;
        this.githubAuth.login = result.login;
        this.githubAuth.error = '';
        const remembered = this.rememberGithubToken(token);
        const rememberNote = remembered
          ? ' The token is saved on this device, so you will not need to paste it again.'
          : '';
        // Engrave the token into the website itself: encrypted with the
        // administrator passwords and committed to the repository, so every
        // other computer inherits it the moment the administrator signs in.
        let websiteNote = '';
        if (this.githubAuth.storeOnWebsite) {
          const storedOnWebsite = await this.saveTokenToWebsite({ token, announce: false });
          websiteNote = storedOnWebsite
            ? ' It is also stored in the website, so any other computer that signs in gets it automatically.'
            : ` It is not stored in the website yet: ${this.githubAuth.website.message}`;
        } else {
          websiteNote = ' It was not stored in the website, so other computers will still need their own copy.';
        }
        try {
          const cloudSave = await savePublishingTokenToGitHub({ token, owner: target.owner, repo: target.name });
          this.githubAuth.cloudSecretSaved = true;
          this.githubAuth.cloudSecretAlreadySaved = cloudSave.alreadySaved;
          this.notify(
            cloudSave.alreadySaved
              ? `Connected to ${result.repository}. Its ${cloudSave.secretName} Actions secret already exists and was left unchanged.${rememberNote}${websiteNote}`
              : `Connected to ${result.repository}. The token was encrypted and saved once as a GitHub Actions secret.${rememberNote}${websiteNote}`,
            'success'
          );
        } catch (error) {
          this.githubAuth.cloudSecretSaved = false;
          this.githubAuth.cloudSecretAlreadySaved = false;
          this.githubAuth.error = error?.message || 'The token is connected on this device, but it could not be saved as a GitHub Actions secret.';
          this.notify(`Connected on this device, but the GitHub cloud save failed: ${this.githubAuth.error}${websiteNote}`, 'error');
        }
      } catch (error) {
        this.githubAuth.error = error?.message || 'The token could not be verified.';
        this.githubAuth.activeToken = '';
        this.githubAuth.connected = false;
      } finally {
        this.githubAuth.verifying = false;
        this.refreshIcons();
      }
    },
    async saveGithubSecret() {
      if (!this.isAdmin) return this.openLogin('admin');
      if (this.githubAuth.verifying) return;
      if (!this.guardAction('token')) {
        this.githubAuth.error = this.rateLimit.message;
        return;
      }
      const token = String(this.githubAuth.activeToken || '').trim();
      if (!this.githubAuth.connected || !token) {
        this.githubAuth.error = 'Connect a GitHub token on this device before saving the cloud secret.';
        return;
      }
      this.githubAuth.verifying = true;
      this.githubAuth.error = '';
      try {
        const target = this.repositoryTarget;
        const result = await savePublishingTokenToGitHub({ token, owner: target.owner, repo: target.name });
        this.githubAuth.cloudSecretSaved = true;
        this.githubAuth.cloudSecretAlreadySaved = result.alreadySaved;
        this.notify(
          result.alreadySaved
            ? `${result.secretName} is already saved in GitHub Actions and was not changed.`
            : `The token was encrypted and saved once as ${result.secretName}.`,
          'success'
        );
      } catch (error) {
        this.githubAuth.error = error?.message || 'The token could not be saved as a GitHub Actions secret.';
        this.notify(this.githubAuth.error, 'error');
      } finally {
        this.githubAuth.verifying = false;
        this.refreshIcons();
      }
    },
    disconnectGithub() {
      this.githubAuth.token = '';
      this.githubAuth.activeToken = '';
      this.githubAuth.connected = false;
      this.githubAuth.login = '';
      this.githubAuth.cloudSecretSaved = false;
      this.githubAuth.cloudSecretAlreadySaved = false;
      this.githubAuth.error = '';
      this.forgetSavedGithubToken();
      this.notify(
        this.githubAuth.website.saved
          ? 'The GitHub token was forgotten on this device. The encrypted copy stored in the website was not changed — use “Remove from this website” as well to stop sharing it.'
          : 'The GitHub token was forgotten on this device. The saved Actions secret in GitHub was not changed.',
        'success'
      );
    },
    toggleGithubToken() { this.githubAuth.showToken = !this.githubAuth.showToken; },
    githubUploadUrl() {
      const target = this.repositoryTarget;
      return `https://github.com/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}/new/${encodeURIComponent(this.githubConfig.branch || 'main')}?filename=apps/`;
    },
    githubTokenUrl() { return 'https://github.com/settings/personal-access-tokens'; },

    setDashboardResourceType(type) { this.dashboardResourceType = type; },
    setStatsAgeBucket(bucket) { this.statsAgeBucketOpen = this.statsAgeBucketOpen === bucket ? '' : bucket; },
    deleteCloudResourceById(id) {
      const item = this.apps.find(resource => resource.id === id);
      if (item) this.confirmDeleteApp(item);
    },
    openResourceInLibrary(item) {
      this.currentView = 'library';
      this.filters.query = item?.fileName || item?.name || '';
      document.getElementById('library-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    /**
     * Unlock the entire Cloud Settings page with the configured master
     * password. Administrator credentials remain unavailable until this
     * check succeeds. Rotations are committed as salted digests in config.js.
     */
    async unlockAdminAccount() {
      if (this.adminAccount.checking) return;
      this.adminAccount.error = '';
      if (!this.isAdmin) {
        this.adminAccount.error = 'You are not signed in as the administrator.';
        return;
      }
      const password = String(this.adminAccount.masterPassword || '');
      if (!password) {
        this.adminAccount.error = 'Enter the master password to open Cloud Settings.';
        return;
      }
      if (!this.guardAction('master')) {
        this.adminAccount.error = this.rateLimit.message;
        return;
      }
      this.adminAccount.checking = true;
      const attempt = ++this.adminAccount.unlockAttempt;
      try {
        const result = await verifyConfiguredMaster(password);
        if (attempt !== this.adminAccount.unlockAttempt) return;
        if (result.configurationMissing) {
          this.adminAccount.error = 'No master password is configured on this deployment. Set the master salt and digest in assets/js/config.js.';
          return;
        }
        if (!result.ok) {
          const delay = this.registerFailedAttempt('master');
          if (delay > 0) await sleep(delay);
          if (attempt !== this.adminAccount.unlockAttempt) return;
          this.adminAccount.error = 'The master password is incorrect.';
          this.adminAccount.masterPassword = '';
          this.$nextTick(() => document.getElementById('master-password')?.focus());
          return;
        }
        this.clearRateLimit('master');
        // Cloud Settings is open, so the master password can now unlock (or
        // re-lock) the token this website stores for every computer.
        this.rememberSessionPassword('master', password);
        this._websiteTokenPromise = (async () => {
          if (!this.githubAuth.connected || !this.githubAuth.activeToken) {
            return this.unlockTokenFromWebsite({ slot: 'master', password, announce: true });
          }
          return this.refreshWebsiteTokenStatus();
        })().catch(() => false);
        const focusAccount = this.adminAccount.focusAccountOnUnlock;
        this.adminAccount.masterPassword = '';
        this.adminAccount.showMasterPassword = false;
        this.adminAccount.unlocked = true;
        this.adminAccount.focusAccountOnUnlock = false;
        this.adminAccount.error = '';
        this.adminAccount.notice = '';
        this.adminAccount.noticeUrl = '';
        this.adminAccount.form = { ...emptyAdminAccountForm(), username: readAdminGate().username };
        this.refreshIcons();
        this.$nextTick(() => {
          if (focusAccount) {
            document.getElementById('admin-account-section')?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
          }
          const target = focusAccount ? 'admin-username' : 'github-repository';
          document.getElementById(target)?.focus?.({ preventScroll: true });
        });
      } catch (error) {
        if (attempt === this.adminAccount.unlockAttempt) {
          this.adminAccount.error = error?.message || 'The master password could not be checked.';
        }
      } finally {
        if (attempt === this.adminAccount.unlockAttempt) {
          this.adminAccount.checking = false;
          this.refreshIcons();
        }
      }
    },
    lockAdminAccount({ announce = false } = {}) {
      this.adminAccount.unlockAttempt += 1;
      this.adminAccount.unlocked = false;
      // The master password is only held while the settings page is open.
      this.clearSessionPasswords('master');
      this.adminAccount.checking = false;
      this.adminAccount.masterPassword = '';
      this.adminAccount.showMasterPassword = false;
      this.adminAccount.focusAccountOnUnlock = false;
      this.adminAccount.error = '';
      this.adminAccount.notice = '';
      this.adminAccount.noticeUrl = '';
      this.adminAccount.form = emptyAdminAccountForm();
      this.refreshIcons();
      if (announce) this.notify('Cloud Settings were locked again.', 'success');
    },
    toggleMasterPasswordVisibility() {
      this.adminAccount.showMasterPassword = !this.adminAccount.showMasterPassword;
      this.refreshIcons();
    },
    async saveAdminAccount() {
      if (!this.isAdmin) return this.openLogin('admin');
      if (!this.adminAccount.unlocked || this.adminAccount.saving) return;
      const state = this.adminAccount;
      const form = state.form;
      state.error = '';
      state.notice = '';
      state.noticeUrl = '';

      const username = String(form.username || '').trim();
      if (!USERNAME_PATTERN.test(username)) {
        state.error = 'Use 3–64 characters for the username: letters, numbers and . _ @ + -';
        return;
      }
      const wantsNewPassword = Boolean(form.password || form.confirmPassword);
      if (wantsNewPassword && String(form.password).length < MIN_PASSWORD_LENGTH) {
        state.error = `The administrator password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
        return;
      }
      if (wantsNewPassword && form.password !== form.confirmPassword) {
        state.error = 'The two administrator password entries do not match.';
        return;
      }
      const wantsNewMaster = Boolean(form.masterPassword || form.confirmMasterPassword);
      if (wantsNewMaster && String(form.masterPassword).length < MIN_PASSWORD_LENGTH) {
        state.error = `The master password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
        return;
      }
      if (wantsNewMaster && form.masterPassword !== form.confirmMasterPassword) {
        state.error = 'The two master password entries do not match.';
        return;
      }
      const currentAdmin = readAdminGate();
      if (username === currentAdmin.username && !wantsNewPassword && !wantsNewMaster) {
        state.error = 'Nothing to change: the username is the same and no new password was entered.';
        return;
      }

      const token = String(this.githubAuth.activeToken || '').trim();
      if (!this.githubAuth.connected || !token) {
        state.error = 'Connect a GitHub token in the section above first. The new credentials are committed to assets/js/config.js so they apply to every device.';
        return;
      }

      // Hash before anything is sent: only the salt and the digest ever leave
      // this browser, never the typed passwords.
      const admin = { username, salt: currentAdmin.salt, passwordHash: currentAdmin.passwordHash };
      if (wantsNewPassword) {
        admin.salt = randomSaltHex();
        admin.passwordHash = await hashPasswordWithSalt(admin.salt, form.password);
      }
      let master = null;
      if (wantsNewMaster) {
        const salt = randomSaltHex();
        master = { salt, passwordHash: await hashPasswordWithSalt(salt, form.masterPassword) };
      }

      const signatureBefore = gateSignature();
      state.saving = true;
      try {
        const target = this.repositoryTarget;
        const result = await saveAdminCredentialsToGitHub({
          owner: target.owner,
          repo: target.name,
          branch: this.githubConfig.branch || SITE_CONFIG.repository.branch,
          token,
          admin,
          master
        });
        if (!result.changed) {
          state.error = 'The repository already holds these credentials. Nothing was changed.';
          return;
        }
        // Use the new credential here immediately, and remember it until the
        // GitHub Pages deployment of config.js replaces it.
        this.rememberAdminCredentials({ replaces: signatureBefore, admin, master });
        applyAdminGate(admin);
        if (master) applyMasterGate(master);
        try { sessionStorage.setItem(ADMIN_LOGIN_SESSION_KEY, username); } catch { /* Current tab stays signed in. */ }
        // The stored token is locked with these passwords, so a rotation has
        // to re-lock it — otherwise the website copy would stop opening on
        // the next computer.
        if (wantsNewPassword) this.rememberSessionPassword('admin', form.password);
        if (wantsNewMaster) this.rememberSessionPassword('master', form.masterPassword);
        let websiteNote = '';
        if (this.githubAuth.website.saved || this.githubAuth.website.status === 'locked') {
          const relocked = await this.saveTokenToWebsite({ announce: false });
          websiteNote = relocked
            ? ' The publishing token stored in this website was re-locked with the new password.'
            : ' Important: the publishing token stored in this website could not be re-locked, so save it again from the GitHub upload access section.';
        }
        state.notice = (wantsNewMaster ? 'The administrator sign-in and the master password were updated' : 'The administrator sign-in was updated')
          + ' and committed to assets/js/config.js. It is already active here and reaches every other device once GitHub Pages finishes deploying (usually within a minute).'
          + websiteNote;
        state.noticeUrl = result.commitUrl || '';
        state.form = { ...emptyAdminAccountForm(), username };
        this.notify(wantsNewMaster ? 'Administrator sign-in and master password updated.' : 'Administrator sign-in updated.', 'success');
      } catch (error) {
        state.error = error?.message || 'The administrator credentials could not be updated.';
        this.notify(state.error, 'error');
      } finally {
        state.saving = false;
        this.refreshIcons();
      }
    },
    rememberAdminCredentials(record) {
      const payload = { ...record, savedAt: new Date().toISOString() };
      safeStorageSet(globalThis.localStorage, SAVED_ADMIN_CREDENTIALS_KEY, JSON.stringify(payload));
    },
    /**
     * Re-apply a credential this device rotated while the GitHub Pages
     * deployment was still pending. The moment the deployed config.js changes,
     * it becomes the source of truth again and this copy is discarded.
     */
    restoreAdminCredentials() {
      const raw = safeStorageGet(globalThis.localStorage, SAVED_ADMIN_CREDENTIALS_KEY);
      if (!raw) return;
      const drop = () => safeStorageRemove(globalThis.localStorage, SAVED_ADMIN_CREDENTIALS_KEY);
      let record = null;
      try { record = JSON.parse(raw); } catch { drop(); return; }
      if (!record?.admin?.passwordHash || !record.replaces) { drop(); return; }
      if (record.replaces !== gateSignature()) { drop(); return; }
      applyAdminGate(record.admin);
      if (record.master?.passwordHash) applyMasterGate(record.master);
    },

    updateIntegrityReport() {
      const issues = [];
      if (this.errors.library) issues.push({ id: 'library-load', title: 'Library could not be loaded', detail: this.errors.library, action: 'Retry the library load.', severity: 'error' });
      const staleMetadata = this.metadataEntries > this.apps.length;
      if (staleMetadata) issues.push({ id: 'metadata-extra', title: 'Some metadata entries do not match published files', detail: 'Review library.json against the files currently in apps/.', action: 'Check library.json in GitHub.', severity: 'warning' });
      const fingerprinted = this.apps.filter(item => String(item?.meta?.sha256 || '')).length;
      const missingFingerprints = this.apps.length - fingerprinted;
      if (missingFingerprints > 0) issues.push({
        id: 'digest-missing',
        title: `${missingFingerprints} published file${missingFingerprints === 1 ? '' : 's'} without a fingerprint`,
        detail: 'Files uploaded before SHA-256 fingerprints were recorded cannot be checked byte-for-byte against the published copy.',
        action: 'Verify a file from the dashboard, or re-upload it to record a fresh fingerprint.',
        severity: 'warning'
      });
      this.integrityReport = {
        status: issues.some(issue => issue.severity === 'error') ? 'error' : issues.length ? 'warning' : 'ok',
        statusLabel: issues.some(issue => issue.severity === 'error') ? 'Check needed' : issues.length ? 'Review suggested' : 'Library healthy',
        issues,
        counts: {
          publishedFiles: this.apps.length,
          fingerprintedFiles: fingerprinted,
          metadataEntries: this.metadataEntries,
          errors: issues.filter(issue => issue.severity === 'error').length,
          warnings: issues.filter(issue => issue.severity === 'warning').length
        }
      };
    },
    async runIntegrityTroubleshooter() {
      if (this.integrityUi.running) return;
      if (!this.guardAction('verify')) {
        this.notify(this.rateLimit.message, 'error');
        return;
      }
      this.integrityUi.running = true;
      this.integrityUi.troubleshooterOpen = true;
      this.integrityUi.log = [];
      await sleep(50);
      const findings = [];
      if (this.errors.library) findings.push({
        id: 'library-load', label: 'Published library could not be loaded', count: 1,
        state: 'failed', autoFixable: false,
        cause: this.offline ? 'This device is offline.' : this.errors.library,
        remedy: 'Reconnect and use Retry, then reload the library.'
      });
      if (this.metadataEntries > this.apps.length) findings.push({
        id: 'stale-metadata', label: 'Extra metadata entries', count: this.metadataEntries - this.apps.length,
        state: 'warning', autoFixable: false,
        cause: 'library.json includes keys which are not in the live apps/ file list.',
        remedy: 'Review library.json in GitHub; this browser does not silently rewrite repository data.'
      });
      if (!this.githubAuth.connected) findings.push({
        id: 'github-disconnected', label: 'Repository write access is not connected', count: 1,
        state: 'info', autoFixable: false,
        cause: this.githubAuth.website.saved
          ? 'The token stored in this website has not been unlocked on this computer yet.'
          : 'No GitHub token is saved on this device or in this website.',
        remedy: this.githubAuth.website.saved
          ? 'Open Cloud Settings and enter the master password; the stored token then connects itself.'
          : 'Paste the token in Settings when ready — saving it also stores it in the website for every other computer.'
      });
      this.integrityDiagnosis = {
        headline: findings.length ? `${findings.length} item(s) need attention` : 'The published library looks consistent.',
        findings,
        autoFixable: 0,
        manualOnly: findings.filter(item => !item.autoFixable).length,
        canRepair: false
      };
      this.integrityUi.ranAt = new Date().toISOString();
      this.integrityUi.summary = findings.length ? 'No repository changes were made.' : 'No problems found.';
      this.integrityUi.running = false;
      this.refreshIcons();
    },
    async repairIntegrityIssues() {
      this.integrityUi.log = [{ state: 'info', message: 'No safe automatic repairs are available. Review the findings and make any repository edits explicitly.' }];
      this.notify('No automatic repair was applied; repository files are left unchanged.', 'info');
    },
    async copyIntegrityReport() { await this.copyText(JSON.stringify(this.integrityReport, null, 2), 'Integrity report copied.'); },
    async copyIntegrityDiagnosis() { await this.copyText(JSON.stringify(this.integrityDiagnosis || {}, null, 2), 'Troubleshooter report copied.'); },
    closeIntegrityTroubleshooter() { this.integrityUi.troubleshooterOpen = false; },
    restoreIntegrityIssues() { this._dismissedIntegrityIssueIds = []; this.integrityUi.hideIssues = false; },
    toggleIntegrityIssues() { this.integrityUi.hideIssues = !this.integrityUi.hideIssues; },
    dismissIntegrityIssue(issue) { if (issue?.id && !this._dismissedIntegrityIssueIds.includes(issue.id)) this._dismissedIntegrityIssueIds.push(issue.id); },
    integrityFindingClass(finding) { return finding?.state === 'failed' ? 'border-rose-200 bg-rose-50 text-rose-900' : finding?.state === 'warning' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-slate-200 bg-white text-slate-800'; },
    integrityIssueClass(issue) { return issue?.severity === 'error' ? 'border-rose-200 bg-rose-50' : 'border-amber-200 bg-amber-50'; },
    async copyText(value, successMessage) {
      try { await clipboardWrite(value); this.notify(successMessage, 'success'); }
      catch { this.notify('Could not copy to clipboard. Select and copy the text manually.', 'error'); }
    },

    async clearLocalDrafts() {
      if (!this.guardAction('settings')) {
        this.notify(this.rateLimit.message, 'error');
        return;
      }
      this.localDrafts = [];
      this.notify('Browser-only draft files were cleared.', 'success');
    },
    async clearGithubCache() {
      if (!this.guardAction('settings')) {
        this.notify(this.rateLimit.message, 'error');
        return;
      }
      try {
        const names = await caches.keys();
        await Promise.all(names.filter(name => name.startsWith('schoolcloud-data-') || name.startsWith('schoolcloud-files-')).map(name => caches.delete(name)));
      } catch { /* Cache API may be unavailable. */ }
      this.clearCachedLibrarySnapshot();
      await this.loadLibrary({ force: true });
      this.notify('The local cloud-file cache was cleared.', 'success');
    },
    async clearData() {
      if (!window.confirm('Clear School Cloud settings and cached data from this browser? This forgets the saved GitHub token on this device. GitHub files will not be deleted.')) return;
      this._limiter.clear();
      try {
        for (const key of Object.keys(localStorage)) if (key.startsWith('schoolcloud.')) localStorage.removeItem(key);
      } catch { /* Ignore locked-down storage. */ }
      this.disconnectGithub();
      this.filters = { query: '', kind: '', subject: '', year: '', sort: 'newest' };
      await this.loadLibrary({ force: true });
      this.notify('Local settings, counters and the saved GitHub token were cleared. GitHub files remain unchanged.', 'success');
    },

    closePreview() {
      this.preview.open = false;
      this.loading.preview = false;
      this.errors.preview = '';
      this.preview.item = null;
      this.preview.descriptor = null;
      if (this.preview.objectUrl) URL.revokeObjectURL(this.preview.objectUrl);
      this.preview.objectUrl = '';
    },
    onPreviewLoad() { this.loading.preview = false; this.errors.preview = ''; },
    onPreviewError() { this.loading.preview = false; this.errors.preview = 'The file preview could not be shown. Download the file instead.'; },
    /* ---------------------------------------------------------------------
     * Repeated-click and rate-limit protection
     * ------------------------------------------------------------------- */

    /**
     * Check a rate limit before an administrator action runs. An allowed call
     * is recorded immediately, so double-clicking a button cannot start two
     * uploads, two deletes or two token checks.
     */
    guardAction(action) {
      const verdict = this._limiter.attempt(action);
      if (verdict.allowed) {
        this.refreshRateLimitState();
        return true;
      }
      const label = this._limiter.label(action);
      this.rateLimit.message = verdict.reason === 'limit'
        ? `Too many ${label} attempts. For safety this is paused for ${formatRetryAfter(verdict.retryAfterMs)}.`
        : `The previous ${label} attempt was just made. Please wait ${formatRetryAfter(verdict.retryAfterMs)} before trying again.`;
      this.rateLimit.tone = 'error';
      this.refreshRateLimitState();
      this.startRateLimitTicker();
      this.notify(this.rateLimit.message, 'error');
      return false;
    },

    /** Record a failed password attempt and return the delay to apply. */
    registerFailedAttempt(action) {
      const delay = this._limiter.penalize(action);
      this.refreshRateLimitState();
      return delay;
    },

    /** A successful action clears its failure history. */
    clearRateLimit(action) {
      this._limiter.reset(action);
      if (this.rateLimit.message) this.rateLimit.message = '';
      this.refreshRateLimitState();
    },

    blockedSeconds(action) {
      const live = this._limiter.blockedFor(action);
      const rendered = Number(this.rateLimit.blocked[action]) || 0;
      return Math.ceil(Math.max(live, rendered) / 1000);
    },

    /** Button label that counts down while an action is rate limited. */
    blockedButtonLabel(action, fallback) {
      const seconds = this.blockedSeconds(action);
      return seconds > 0 ? `Please wait ${seconds}s` : fallback;
    },

    actionBlocked(action, busy = false) {
      return Boolean(busy) || this.blockedSeconds(action) > 0;
    },

    refreshRateLimitState() {
      this.rateLimit = { ...this.rateLimit, blocked: this._limiter.blockedActions() };
    },

    startRateLimitTicker() {
      if (this._rateLimitTimer) return;
      this._rateLimitTimer = setInterval(() => {
        this.refreshRateLimitState();
        if (!Object.keys(this.rateLimit.blocked).length) {
          clearInterval(this._rateLimitTimer);
          this._rateLimitTimer = null;
        }
      }, 1_000);
      this._rateLimitTimer?.unref?.();
    },

    /* ---------------------------------------------------------------------
     * Live administrator presence
     * ------------------------------------------------------------------- */

    initPresence() {
      if (!this._presenceBeacon) {
        this._presenceBeacon = new AdminPresenceBeacon({
          client: this._counterClient,
          onChange: state => this.applyPresenceState(state)
        });
        document.addEventListener?.('visibilitychange', () => {
          if (!document.hidden) {
            this.refreshAdminPresence();
            if (this.isAdmin) this.announceAdminPresence();
          }
        });
        this._presenceTimer = setInterval(() => this.refreshAdminPresence(), PRESENCE_REFRESH_MS);
        this._presenceTimer?.unref?.();
      }
      this.applyPresenceState(this._presenceBeacon.snapshot());
      this.refreshAdminPresence({ force: true });
      if (this.isAdmin) this.startAdminPresenceHeartbeat();
    },

    applyPresenceState(state) {
      const described = describePresence({ ...state, at: Date.now() });
      this.presence = {
        live: Boolean(state?.live) || described.tone === 'online',
        unknown: Boolean(state?.unknown),
        label: described.label,
        detail: described.detail,
        tone: described.tone,
        checkedAt: Number(state?.checkedAt) || 0,
        lastSeenAt: Number(state?.lastSeenAt) || 0,
        source: String(state?.source || '')
      };
    },

    async refreshAdminPresence({ force = false } = {}) {
      if (!this._presenceBeacon) return;
      if (this._presenceReadPromise) return this._presenceReadPromise;
      const now = Date.now();
      if (!force && now - this._presenceReadAt < PRESENCE_REFRESH_MS) return;
      this._presenceReadAt = now;
      const request = this._presenceBeacon.read();
      this._presenceReadPromise = request;
      try {
        await request;
      } catch {
        // A failed presence read keeps the last known state on screen.
      } finally {
        if (this._presenceReadPromise === request) this._presenceReadPromise = null;
        this.applyPresenceState(this._presenceBeacon.snapshot());
      }
    },

    /** One heartbeat: publishes "an administrator is here" for about a minute. */
    async announceAdminPresence() {
      if (!this._presenceBeacon) return;
      try {
        await this._presenceBeacon.announce();
      } finally {
        this.applyPresenceState(this._presenceBeacon.snapshot());
      }
    },

    startAdminPresenceHeartbeat() {
      if (!this._presenceBeacon) return;
      this.announceAdminPresence();
      if (this._presenceHeartbeatTimer) return;
      this._presenceHeartbeatTimer = setInterval(() => {
        if (this.isAdmin) this.announceAdminPresence();
      }, PRESENCE_HEARTBEAT_MS);
      this._presenceHeartbeatTimer?.unref?.();
    },

    stopAdminPresenceHeartbeat() {
      if (this._presenceHeartbeatTimer) clearInterval(this._presenceHeartbeatTimer);
      this._presenceHeartbeatTimer = null;
      // Leave the device's own last-seen mark in place: signing out should not
      // instantly claim no administrator was ever online here, and it expires
      // on its own after the presence window.
      this.refreshAdminPresence({ force: true });
    },

    presenceIsLocal() {
      return localPresenceIsLive(this._presenceBeacon?.snapshot?.()?.lastSeenAt || 0, Date.now());
    },

    /* ---------------------------------------------------------------------
     * Upload safety and accuracy helpers
     * ------------------------------------------------------------------- */

    async inspectSelectedFile() {
      const file = this.draftFile;
      if (!file) return;
      const token = ++this._inspectSequence;
      try {
        const bytes = await readFileBytes(file, {
          onProgress: ({ loaded, total }) => {
            if (total > 0) this.uploadDetail = `Reading the selected file… ${Math.round(loaded / total * 100)}%`;
          }
        });
        if (token !== this._inspectSequence || this.draftFile !== file) return;
        this._draftBytes = bytes;
        const report = await inspectUpload({ name: file.name, bytes });
        if (token !== this._inspectSequence || this.draftFile !== file) return;
        this.uploadChecks = report.checks;
        this.uploadWarnings = [...report.warnings];
        this._draftDigest = report.digest;
        this.uploadDetail = '';

        const publishedNames = this.apps.map(item => item.fileName || item.name || '');
        const nameTaken = publishedNames.some(name => String(name).trim().toLowerCase() === file.name.trim().toLowerCase());
        if (nameTaken) {
          const suggestion = suggestAvailableFileName(file.name, publishedNames);
          this.draftErrors.file = `“${file.name}” is already published, and existing files are never overwritten.${suggestion ? ` Rename this copy to “${suggestion}” (or give it a different version) before uploading.` : ' Rename it before uploading.'}`;
        } else if (!report.ok) {
          this.draftErrors.file = report.errors.join(' ');
        } else {
          this.draftErrors.file = '';
          const duplicate = findDigestMatch(this.libraryMetadata, report.digest);
          if (duplicate) {
            this.uploadWarnings = [
              ...this.uploadWarnings,
              `These exact bytes are already published as “${String(duplicate).split('/').pop()}”. Publishing a duplicate is allowed but students will see the same file twice.`
            ];
          }
        }
      } catch (error) {
        if (token !== this._inspectSequence) return;
        this.uploadChecks = [];
        this.draftErrors.file = error?.message || 'The selected file could not be inspected.';
      } finally {
        if (token === this._inspectSequence) this.refreshIcons();
      }
    },

    applyUploadProgress({ stage, percent, detail } = {}) {
      if (stage) this.uploadStage = stage;
      if (stage) this.uploadStageLabel = UPLOAD_STAGE_LABELS[stage] || 'Publishing…';
      const value = Number(percent);
      if (Number.isFinite(value)) this.uploadPercent = Math.max(this.uploadPercent, Math.min(100, Math.round(value)));
      if (detail) this.uploadDetail = detail;
    },

    armUploadUnloadGuard() {
      if (this._uploadUnloadHandler) return;
      this._uploadUnloadHandler = event => {
        if (!this.submitting) return undefined;
        const message = 'An upload is still running. Leaving now can leave the resource half-published.';
        event.preventDefault();
        event.returnValue = message;
        return message;
      };
      window.addEventListener('beforeunload', this._uploadUnloadHandler);
    },

    releaseUploadUnloadGuard() {
      if (!this._uploadUnloadHandler) return;
      window.removeEventListener('beforeunload', this._uploadUnloadHandler);
      this._uploadUnloadHandler = null;
    },

    startUploadTimer() {
      const started = Date.now();
      this._uploadStartedAt = started;
      this.uploadElapsedSeconds = 0;
      clearInterval(this._uploadSlowTimer);
      this._uploadSlowTimer = setInterval(() => {
        if (!this.submitting) return;
        this.uploadElapsedSeconds = Math.floor((Date.now() - started) / 1000);
      }, 1_000);
      this._uploadSlowTimer?.unref?.();
    },

    stopUploadTimer() {
      clearInterval(this._uploadSlowTimer);
      this._uploadSlowTimer = null;
    },

    get uploadSlow() {
      return this.submitting && this.uploadElapsedSeconds * 1000 >= UPLOAD_SLOW_NOTICE_MS;
    },

    uploadVerificationNote(result) {
      if (!result) return '';
      if (result.recovered) return ' The interrupted upload was confirmed as stored, so it was not sent twice.';
      if (result.verified) return ` Verified: the published bytes match this device${result.sha256 ? ` (SHA-256 ${formatDigest(result.sha256, 16)})` : ''}.`;
      if (result.verificationSkipped) return ` ${result.verificationMessage || 'The byte-for-byte check was skipped.'}`;
      return '';
    },

    /**
     * Re-read one published file and compare it with the fingerprint recorded
     * at upload time. This is the accuracy counterpart to the pre-upload scan:
     * it proves the file students download is the file the administrator
     * approved.
     */
    async verifyPublishedFile(item) {
      if (!this.isAdmin) return this.openLogin('admin');
      if (!item) return;
      if (item.source !== 'github') {
        this.notify('Only files published to GitHub can be verified.', 'info');
        return;
      }
      const expected = String(item.meta?.sha256 || '').toLowerCase();
      if (!expected) {
        this.notify(`“${item.name}” was published before fingerprints were recorded, so there is nothing to compare. Re-upload the file to record one.`, 'info');
        return;
      }
      if (!this.guardAction('verify')) return;
      this.verifyingAppId = item.id;
      try {
        const href = resolveFileUrl(item);
        if (!href) throw new Error('This file has no readable published address.');
        const url = new URL(href, window.location.href);
        if (url.origin !== window.location.origin) {
          throw new Error('The published copy is served from another host, which this page does not read. Verify again once GitHub Pages has deployed the file.');
        }
        const response = await fetch(`${url.href}${url.search ? '&' : '?'}v=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin' });
        if (!response.ok) throw new Error(`The published file could not be read (HTTP ${response.status}). GitHub Pages may still be deploying it — try again in a minute.`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const digest = await sha256HexBytes(bytes);
        if (!digest) throw new Error('This browser cannot compute SHA-256, so the file cannot be verified here.');
        if (digest === expected) {
          this.notify(`Verified “${item.name}”: the published file matches its recorded fingerprint (SHA-256 ${formatDigest(digest, 16)}).`, 'success');
        } else {
          this.notify(`“${item.name}” does NOT match the fingerprint recorded when it was published. Delete it in GitHub and upload a fresh copy.`, 'error');
        }
      } catch (error) {
        this.notify(error?.message || 'The published file could not be verified.', 'error');
      } finally {
        this.verifyingAppId = '';
        this.refreshIcons();
      }
    },

    notify(message, tone = 'info') {
      clearTimeout(this._toastTimer);
      this.toast = { message: String(message || ''), tone, visible: Boolean(message) };
      this._toastTimer = setTimeout(() => { this.toast.visible = false; }, 6500);
    }
  };
}

// Register the data provider before Alpine scans the markup. Importing
// Alpine's ESM build avoids the CDN build's eager auto-start race and gives us
// a predictable bootstrap order; no credentials or access tokens are global.
Alpine.data('schoolCloud', schoolCloud);
window.Alpine = Alpine;
Alpine.start();

function surfaceUnexpectedClientError(label, detail) {
  console.error(`[School Cloud] Unhandled ${label}:`, detail);
  const state = document.body?._x_dataStack?.[0];
  if (!state?.notify) return;
  const now = Date.now();
  if (now - (state._lastCrashNoticeAt || 0) < CRASH_NOTICE_THROTTLE_MS) return;
  state._lastCrashNoticeAt = now;
  state.notify('The website recovered from an unexpected problem. Please retry the last action if needed.', 'error');
}

window.addEventListener('error', event => {
  if (event.error?.name === 'AbortError') return;
  surfaceUnexpectedClientError('error', event.error || event.message || event);
});

window.addEventListener('unhandledrejection', event => {
  if (event.reason?.name === 'AbortError') return;
  surfaceUnexpectedClientError('promise', event.reason);
});
