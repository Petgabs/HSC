/**
 * Upload safety and accuracy checks.
 *
 * Every file an administrator publishes is the file a student will later open
 * on a school device, so the bytes are inspected *before* anything is sent to
 * GitHub:
 *
 *   Safety   — the bytes really are the file type the extension claims (a
 *              renamed executable or a document that is actually HTML is
 *              refused), archives are listed so an Office file cannot smuggle
 *              an executable, macro or script payload, and HTML resources are
 *              scanned for code the site's Content Security Policy will not
 *              run.
 *   Accuracy — the exact size and SHA-256 digest are recorded with the
 *              metadata, so the upload can be verified against what GitHub
 *              stored and later re-checked from the dashboard.
 *
 * Findings are graded `ok`, `warn` or `block`. Warnings are surfaced in the
 * admin interface and must be acknowledged; blocks stop the upload with an
 * explanation instead of publishing a file that will not work (or should not
 * be trusted) in the classroom.
 */
import { SUPPORTED_EXTENSIONS, SITE_CONFIG } from '../config.js';

/** Extensions that were never going to be a school resource. */
const RISKY_EXTENSIONS = [
  'exe', 'dll', 'com', 'scr', 'pif', 'msi', 'msp', 'bat', 'cmd', 'ps1', 'psm1',
  'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'jar', 'lnk', 'reg', 'sh',
  'app', 'apk', 'dmg', 'iso', 'img', 'cpl', 'sys', 'drv', 'bin', 'deb', 'rpm'
];

const RISKY_ENTRY_PATTERN = new RegExp(`\\.(${RISKY_EXTENSIONS.join('|')})$`, 'i');
const MACRO_ENTRY_PATTERN = /(?:^|\/)(?:vbaProject\.bin|_VBA_PROJECT|macros?\/|xl\/vbaProject\.bin|word\/vbaProject\.bin|ppt\/vbaProject\.bin)$/i;

const OLE_HEADER = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP_LOCAL_HEADER = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY_HEADER = [0x50, 0x4b, 0x05, 0x06];
const PDF_HEADER = '%PDF-';

const KIND_BY_EXTENSION = {
  pdf: 'pdf',
  html: 'html',
  htm: 'html',
  docx: 'zip-office',
  xlsx: 'zip-office',
  pptx: 'zip-office',
  doc: 'ole',
  xls: 'ole',
  ppt: 'ole'
};

const MAX_ARCHIVE_ENTRIES = 500;

export function extensionOf(filename) {
  const match = String(filename || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

export function expectedKind(filename) {
  return KIND_BY_EXTENSION[extensionOf(filename)] || '';
}

function startsWithBytes(data, bytes) {
  if (!data || data.length < bytes.length) return false;
  return bytes.every((byte, index) => data[index] === byte);
}

/** Sniff the real file type from its leading bytes (and, for HTML, its content). */
export function detectFileKind(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (!data.length) return 'empty';
  if (startsWithBytes(data, PDF_HEADER.split('').map(character => character.charCodeAt(0)))) return 'pdf';
  if (startsWithBytes(data, ZIP_LOCAL_HEADER) || startsWithBytes(data, ZIP_EMPTY_HEADER)) return 'zip';
  if (startsWithBytes(data, OLE_HEADER)) return 'ole';
  const sample = data.subarray(0, Math.min(data.length, 4096));
  if (sample.includes(0)) return 'binary';
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(sample);
    if (text.trim()) return 'text';
  } catch {
    return 'binary';
  }
  return 'text';
}

/**
 * Read the central directory of a ZIP archive (the container used by .docx,
 * .xlsx and .pptx) and return the entry names. Never throws.
 */
export function inspectArchiveEntries(bytes, { maxEntries = MAX_ARCHIVE_ENTRIES } = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const empty = { readable: false, entries: [], risky: [], macros: [] };
  if (data.length < 22) return empty;

  let eocd = -1;
  const lowest = Math.max(0, data.length - 65_557);
  for (let index = data.length - 22; index >= lowest; index -= 1) {
    if (data[index] === 0x50 && data[index + 1] === 0x4b && data[index + 2] === 0x05 && data[index + 3] === 0x06) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) return empty;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const total = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = [];
  for (let index = 0; index < Math.min(total, maxEntries); index += 1) {
    if (offset + 46 > data.length) break;
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const nameStart = offset + 46;
    if (nameStart + nameLength > data.length) break;
    const name = new TextDecoder('utf-8', { fatal: false }).decode(data.subarray(nameStart, nameStart + nameLength));
    entries.push(name);
    offset = nameStart + nameLength + extraLength + commentLength;
  }
  return {
    readable: entries.length > 0,
    entries,
    risky: entries.filter(name => RISKY_ENTRY_PATTERN.test(name)),
    macros: entries.filter(name => MACRO_ENTRY_PATTERN.test(name))
  };
}

/**
 * Patterns inside an HTML resource. `block` findings are either dangerous or
 * simply cannot work: the site embeds uploaded HTML in a sandboxed frame under
 * a Content Security Policy that permits no remote script, no `object`/`embed`
 * and no external frames. `warn` findings are shown to the administrator so
 * they know exactly what the browser will and will not run.
 */
const HTML_PATTERNS = [
  { id: 'script-src-javascript', severity: 'block', pattern: /<script\b[^>]*\bsrc\s*=\s*["']?\s*javascript:/i, label: 'Script loaded from a javascript: URL' },
  { id: 'script-src-data', severity: 'block', pattern: /<script\b[^>]*\bsrc\s*=\s*["']?\s*data:/i, label: 'Script loaded from a data: URL' },
  { id: 'javascript-url', severity: 'block', pattern: /\b(?:href|src|action)\s*=\s*["']?\s*javascript:/i, label: 'Link that runs javascript:' },
  { id: 'remote-script', severity: 'warn', pattern: /<script\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:)?\/\//i, label: 'Remote script (blocked by the site policy)' },
  { id: 'remote-iframe', severity: 'warn', pattern: /<(?:iframe|frame)\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:)?\/\//i, label: 'External frame (blocked by the site policy)' },
  { id: 'object-embed', severity: 'warn', pattern: /<(?:object|embed)\b/i, label: 'Embedded object or plugin (blocked by the site policy)' },
  { id: 'base-href', severity: 'warn', pattern: /<base\b[^>]*\bhref\s*=\s*["']?\s*(?:https?:)?\/\//i, label: 'External <base> changes every relative link' },
  { id: 'external-form', severity: 'warn', pattern: /<form\b[^>]*\baction\s*=\s*["']?\s*(?:https?:)?\/\//i, label: 'Form posts to another website' },
  { id: 'eval', severity: 'warn', pattern: /\b(?:eval|Function)\s*\(/, label: 'Dynamic code evaluation' },
  { id: 'inline-handler', severity: 'warn', pattern: /\son[a-z]+\s*=\s*["']/i, label: 'Inline event handler attributes' },
  { id: 'cookie-access', severity: 'warn', pattern: /document\.cookie/, label: 'Reads or writes cookies' },
  { id: 'storage-access', severity: 'warn', pattern: /\b(?:localStorage|sessionStorage|indexedDB)\b/, label: 'Uses browser storage' },
  { id: 'websocket', severity: 'warn', pattern: /\b(?:WebSocket|EventSource)\s*\(/, label: 'Opens a live network connection' },
  { id: 'external-fetch', severity: 'warn', pattern: /\b(?:fetch|XMLHttpRequest|importScripts)\s*\(/, label: 'Makes network requests from script' }
];

/** Scan an HTML resource and return only the findings that were actually met. */
export function scanHtmlSource(text) {
  const source = String(text || '');
  const findings = [];
  for (const rule of HTML_PATTERNS) {
    if (rule.pattern.test(source)) findings.push({ id: rule.id, severity: rule.severity, label: rule.label });
  }
  if (/<script\b(?![^>]*\bsrc\s*=)/i.test(source)) {
    findings.push({ id: 'inline-script', severity: 'info', label: 'Inline script (runs sandboxed without same-origin access)' });
  }
  return findings;
}

function looksLikeHtmlDocument(bytes) {
  const sample = new TextDecoder('utf-8', { fatal: false })
    .decode((bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])).subarray(0, 4096));
  return /<\s*(?:!doctype\s+html|html|head|body|script|style|div|table|svg|canvas)\b/i.test(sample);
}

/** SHA-256 of the exact bytes, returned as lowercase hex ('' when unavailable). */
export async function sha256Hex(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return '';
  try {
    const digest = await subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    return '';
  }
}

export function formatDigest(digest, length = 12) {
  const value = String(digest || '');
  if (!value) return '';
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

/**
 * Full upload inspection: reads the bytes, checks the declared type against the
 * real content, lists archive contents, scans HTML resources and produces the
 * SHA-256 digest used for post-upload verification.
 *
 * @returns {Promise<{ok: boolean, kind: string, digest: string, size: number, errors: string[], warnings: string[], checks: object[], findings: object[]}>}
 */
export async function inspectUpload({ name = '', bytes = new Uint8Array(), maxBytes = SITE_CONFIG.maxUploadBytes } = {}) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const filename = String(name || '');
  const extension = extensionOf(filename);
  const kind = expectedKind(filename);
  const errors = [];
  const warnings = [];
  const checks = [];
  const findings = [];
  const limit = Number(maxBytes) > 0 ? Number(maxBytes) : SITE_CONFIG.maxUploadBytes;

  const add = (id, status, label, detail) => checks.push({ id, status, label, detail });
  const fail = (id, label, detail) => { errors.push(detail); add(id, 'block', label, detail); };
  const caution = (id, label, detail) => { warnings.push(detail); add(id, 'warn', label, detail); };

  if (!SUPPORTED_EXTENSIONS.includes(`.${extension}`) || !kind) {
    fail('format', 'Supported format', `“${filename}” is not an HTML, PDF, Word, Excel or PowerPoint file.`);
    return { ok: false, kind, digest: '', size: data.length, errors, warnings, checks, findings };
  }

  if (!data.length) {
    fail('size', 'File is not empty', `“${filename}” is empty (0 bytes), so there is nothing to publish.`);
    return { ok: false, kind, digest: '', size: 0, errors, warnings, checks, findings };
  }
  if (data.length > limit) {
    fail('size', 'Size limit', `Files must be ${Math.round(limit / (1024 * 1024))} MB or smaller. This file is ${(data.length / (1024 * 1024)).toFixed(1)} MB.`);
    return { ok: false, kind, digest: '', size: data.length, errors, warnings, checks, findings };
  }
  add('size', 'ok', 'Size limit', `Within the ${Math.round(limit / (1024 * 1024))} MB limit.`);

  const detected = detectFileKind(data);
  if (detected === 'empty') {
    fail('type', 'Real file type', `“${filename}” has no readable content.`);
  } else if (detected === kind) {
    add('type', 'ok', 'Real file type', `The bytes match the .${extension} extension.`);
  } else if (kind === 'html' && detected === 'text') {
    add('type', 'ok', 'Real file type', 'Plain text HTML resource.');
    if (!looksLikeHtmlDocument(data)) {
      caution('html-shape', 'Looks like plain text', 'The file is text but contains no HTML structure, so it will display as plain text when opened.');
    }
  } else if (kind === 'zip-office' && detected === 'zip') {
    add('type', 'ok', 'Real file type', 'Office (ZIP) container detected.');
  } else {
    const labels = { pdf: 'PDF', zip: 'ZIP/Office', ole: 'legacy Office', text: 'plain text', binary: 'unknown binary' };
    fail(
      'type',
      'Real file type',
      `“${filename}” looks like ${labels[detected] || detected} content, not ${extension.toUpperCase()}. The extension and the actual file type must agree; rename or re-export the file and try again.`
    );
  }

  if (kind === 'zip-office' && detected === 'zip') {
    const archive = inspectArchiveEntries(data);
    if (!archive.readable) {
      caution('archive', 'Archive inspected', 'The Office container contents could not be listed. The file will still be published, but it could not be scanned for embedded programs.');
    } else if (archive.macros.length) {
      fail('archive', 'No macros', `The document contains macro code (${archive.macros.slice(0, 2).join(', ')}). Save it as a plain .docx/.xlsx/.pptx without macros, then upload again.`);
    } else if (archive.risky.length) {
      fail('archive', 'No embedded programs', `The document contains executable content (${archive.risky.slice(0, 3).join(', ')}). Re-export it without embedded programs before publishing.`);
    } else {
      add('archive', 'ok', 'Archive inspected', `${archive.entries.length} document part${archive.entries.length === 1 ? '' : 's'} listed; no programs or macros found.`);
    }
  }

  if (kind === 'ole') {
    caution('legacy-office', 'Legacy Office format', 'Legacy .doc/.xls/.ppt files can carry macros that this website cannot inspect. Publishing the modern .docx/.xlsx/.pptx version is safer.');
  }

  if (kind === 'html') {
    const text = new TextDecoder('utf-8', { fatal: false }).decode(data);
    const htmlFindings = scanHtmlSource(text);
    findings.push(...htmlFindings);
    const blockers = htmlFindings.filter(finding => finding.severity === 'block');
    const warns = htmlFindings.filter(finding => finding.severity === 'warn');
    for (const finding of blockers) fail(`html-${finding.id}`, 'Unsafe HTML', `${finding.label}. Remove it before publishing.`);
    for (const finding of warns) caution(`html-${finding.id}`, 'HTML behaviour', finding.label);
    if (!blockers.length && !warns.length) add('html', 'ok', 'HTML scanned', 'No remote scripts, frames or embedded objects found.');
  }

  const digest = await sha256Hex(data);
  if (digest) add('digest', 'ok', 'Fingerprint', `SHA-256 ${formatDigest(digest, 16)} recorded for verification.`);
  else caution('digest', 'Fingerprint unavailable', 'This browser cannot compute SHA-256, so the upload cannot be verified byte-for-byte.');

  return { ok: errors.length === 0, kind, digest, size: data.length, errors, warnings, checks, findings };
}

/**
 * Read a File into bytes, reporting progress for large files. Uses FileReader
 * where available because it reports bytes read; falls back to `arrayBuffer()`.
 */
export function readFileBytes(file, { onProgress } = {}) {
  if (!file) return Promise.reject(new Error('Choose a file to upload.'));
  const readerFactory = globalThis.FileReader;
  if (typeof readerFactory === 'function') {
    return new Promise((resolve, reject) => {
      const reader = new readerFactory();
      reader.onprogress = event => {
        if (!event?.lengthComputable) return;
        onProgress?.({ loaded: Number(event.loaded) || 0, total: Number(event.total) || 0 });
      };
      reader.onload = () => resolve(new Uint8Array(reader.result));
      reader.onerror = () => reject(reader.error || new Error('The selected file could not be read. It may have been moved or renamed.'));
      reader.onabort = () => reject(new Error('Reading the file was interrupted. Select the file and try again.'));
      try {
        reader.readAsArrayBuffer(file);
      } catch (error) {
        reject(error);
      }
    });
  }
  if (typeof file.arrayBuffer !== 'function') {
    return Promise.reject(new Error('This browser cannot read the selected file.'));
  }
  return Promise.resolve(file.arrayBuffer()).then(buffer => new Uint8Array(buffer));
}

/**
 * Suggest a publishable name when the chosen one is already taken, e.g.
 * `Notes.pdf` -> `Notes (2).pdf`. Returns '' when no free name was found.
 */
export function suggestAvailableFileName(name, existingNames, { attempts = 25 } = {}) {
  const taken = new Set([...existingNames || []].map(value => String(value || '').normalize('NFC').toLowerCase()));
  const clean = String(name || '').normalize('NFC').trim();
  const match = clean.match(/^(.*?)(\.[A-Za-z0-9]+)$/);
  const base = match ? match[1] : clean;
  const extension = match ? match[2] : '';
  for (let index = 2; index <= attempts; index += 1) {
    const candidate = `${base} (${index})${extension}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return '';
}

/** Find an existing library entry whose recorded digest matches. */
export function findDigestMatch(library, digest) {
  const wanted = String(digest || '').toLowerCase();
  if (!wanted) return '';
  if (library instanceof Map) {
    for (const [path, meta] of library) {
      if (String(meta?.sha256 || '').toLowerCase() === wanted) return String(meta?.path || path);
    }
    return '';
  }
  for (const [path, meta] of Object.entries(library || {})) {
    if (!meta || typeof meta !== 'object') continue;
    if (String(meta.sha256 || '').toLowerCase() === wanted) return path;
  }
  return '';
}

export function riskyExtensions() {
  return [...RISKY_EXTENSIONS];
}
