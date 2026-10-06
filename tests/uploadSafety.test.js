import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  detectFileKind, expectedKind, findDigestMatch, formatDigest, inspectArchiveEntries, inspectUpload,
  readFileBytes, scanHtmlSource, sha256Hex, suggestAvailableFileName
} from '../assets/js/lib/uploadSafety.js';

const text = value => new TextEncoder().encode(value);
const bytesOf = (...values) => new Uint8Array(values);

/* --- a tiny ZIP writer, so the Office container checks are tested for real -- */

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value) { return [value & 0xff, (value >>> 8) & 0xff]; }
function uint32(value) { return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]; }

function makeZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const nameBytes = text(name);
    const data = text(content);
    const crc = crc32(data);
    const header = Uint8Array.from([
      0x50, 0x4b, 0x03, 0x04, ...uint16(20), ...uint16(0), ...uint16(0), ...uint16(0), ...uint16(0),
      ...uint32(crc), ...uint32(data.length), ...uint32(data.length), ...uint16(nameBytes.length), ...uint16(0)
    ]);
    local.push(header, nameBytes, data);
    central.push(Uint8Array.from([
      0x50, 0x4b, 0x01, 0x02, ...uint16(20), ...uint16(20), ...uint16(0), ...uint16(0), ...uint16(0), ...uint16(0),
      ...uint32(crc), ...uint32(data.length), ...uint32(data.length), ...uint16(nameBytes.length), ...uint16(0),
      ...uint16(0), ...uint16(0), ...uint16(0), ...uint32(0), ...uint32(offset)
    ]), nameBytes);
    offset += header.length + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const eocd = Uint8Array.from([
    0x50, 0x4b, 0x05, 0x06, ...uint16(0), ...uint16(0), ...uint16(Object.keys(entries).length),
    ...uint16(Object.keys(entries).length), ...uint32(centralSize), ...uint32(offset), ...uint16(0)
  ]);
  const parts = [...local, ...central, eocd];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) { output.set(part, cursor); cursor += part.length; }
  return output;
}

const docxBytes = makeZip({
  '[Content_Types].xml': '<Types/>',
  'word/document.xml': '<w:document>Hello</w:document>',
  'docProps/core.xml': '<coreProperties/>'
});

describe('file type verification', () => {
  it('recognises the real container behind each extension', () => {
    expect(detectFileKind(text('%PDF-1.7\nrest'))).toBe('pdf');
    expect(detectFileKind(docxBytes)).toBe('zip');
    expect(detectFileKind(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]))).toBe('ole');
    expect(detectFileKind(text('<html><body>hi</body></html>'))).toBe('text');
    expect(detectFileKind(new Uint8Array(0))).toBe('empty');
    expect(detectFileKind(bytesOf(0x00, 0x01, 0x02, 0x03))).toBe('binary');
    expect(expectedKind('Notes.PDF')).toBe('pdf');
    expect(expectedKind('sheet.xlsx')).toBe('zip-office');
    expect(expectedKind('notes.txt')).toBe('');
  });

  it('accepts a real PDF', async () => {
    const report = await inspectUpload({ name: 'Notes.pdf', bytes: text('%PDF-1.4\n%âãÏÓ\nbody') });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(report.checks.map(check => check.id)).toContain('digest');
  });

  it('refuses a file whose bytes do not match its extension', async () => {
    const report = await inspectUpload({ name: 'Notes.pdf', bytes: docxBytes });
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toContain('not PDF');
    expect(report.errors.join(' ')).toContain('extension and the actual file type must agree');
  });

  it('refuses an empty file and one over the size limit', async () => {
    const empty = await inspectUpload({ name: 'Notes.pdf', bytes: new Uint8Array(0) });
    expect(empty.ok).toBe(false);
    expect(empty.errors.join(' ')).toContain('empty');

    const large = await inspectUpload({ name: 'Notes.pdf', bytes: text('%PDF-1.4 too big'), maxBytes: 4 });
    expect(large.ok).toBe(false);
    expect(large.errors.join(' ')).toContain('MB or smaller');
  });

  it('refuses an unsupported extension', async () => {
    const report = await inspectUpload({ name: 'installer.exe', bytes: text('MZ') });
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toContain('not an HTML, PDF, Word, Excel or PowerPoint file');
  });
});

describe('Office container inspection', () => {
  it('lists document parts without flagging ordinary files', async () => {
    const archive = inspectArchiveEntries(docxBytes);
    expect(archive.readable).toBe(true);
    expect(archive.entries).toContain('word/document.xml');
    expect(archive.risky).toEqual([]);
    expect(archive.macros).toEqual([]);

    const report = await inspectUpload({ name: 'Unit 3 notes.docx', bytes: docxBytes });
    expect(report.ok).toBe(true);
    expect(report.checks.find(check => check.id === 'archive').status).toBe('ok');
  });

  it('blocks a document carrying an executable payload', async () => {
    const evil = makeZip({
      '[Content_Types].xml': '<Types/>',
      'word/document.xml': '<w:document>Hi</w:document>',
      'word/media/payload.exe': 'MZ'
    });
    const report = await inspectUpload({ name: 'Homework.docx', bytes: evil });
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toContain('executable content');
  });

  it('blocks a macro-enabled document', async () => {
    const macro = makeZip({
      '[Content_Types].xml': '<Types/>',
      'word/document.xml': '<w:document>Hi</w:document>',
      'word/vbaProject.bin': 'macro bytes'
    });
    const report = await inspectUpload({ name: 'Homework.docx', bytes: macro });
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toContain('macro');
  });

  it('warns about legacy Office formats instead of refusing them', async () => {
    const ole = Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(64).fill(0)]);
    const report = await inspectUpload({ name: 'Old worksheet.doc', bytes: ole });
    expect(report.ok).toBe(true);
    expect(report.warnings.join(' ')).toContain('Legacy .doc/.xls/.ppt files can carry macros');
  });
});

describe('HTML resource scanning', () => {
  it('blocks javascript: URLs and data: scripts outright', async () => {
    const report = await inspectUpload({
      name: 'Practice.html',
      bytes: text('<html><body><a href="javascript:alert(1)">go</a></body></html>')
    });
    expect(report.ok).toBe(false);
    expect(report.errors.join(' ')).toContain('javascript:');

    const dataScript = await inspectUpload({
      name: 'Practice.html',
      bytes: text('<html><body><script src="data:text/javascript,alert(1)"></script></body></html>')
    });
    expect(dataScript.ok).toBe(false);
    expect(dataScript.errors.join(' ')).toContain('data: URL');
  });

  it('warns about behaviour the site policy will not run, requiring acknowledgement', async () => {
    const report = await inspectUpload({
      name: 'Practice.html',
      bytes: text('<html><body><script src="https://cdn.example.com/chart.js"></script><script>document.cookie = "x";</script></body></html>')
    });
    expect(report.ok).toBe(true);
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.findings.map(finding => finding.id)).toContain('remote-script');
    const inline = report.findings.find(finding => finding.id === 'inline-script');
    expect(inline.severity).toBe('info');
  });

  it('scans the source directly and reports nothing for a clean app', () => {
    expect(scanHtmlSource('<html><body><canvas id="c"></canvas><script>const a = 1;</script></body></html>')
      .map(finding => finding.id)).toEqual(['inline-script']);
    expect(scanHtmlSource('<html><body><p>Notes</p></body></html>')).toEqual([]);
  });

  it('notes a text file that is not really HTML', async () => {
    const report = await inspectUpload({ name: 'Notes.html', bytes: text('just some plain notes, no tags at all') });
    expect(report.ok).toBe(true);
    expect(report.warnings.join(' ')).toContain('no HTML structure');
  });
});

describe('fingerprints, duplicates and names', () => {
  it('computes the SHA-256 digest of the exact bytes', async () => {
    const bytes = text('%PDF-content');
    const expected = createHash('sha256').update(bytes).digest('hex');
    expect(await sha256Hex(bytes)).toBe(expected);
    expect(formatDigest(expected)).toBe(`${expected.slice(0, 12)}…`);
    expect(formatDigest('abc')).toBe('abc');
    expect(formatDigest('')).toBe('');
  });

  it('finds an existing library entry with the same digest', () => {
    const library = {
      _comment: ['ignore me'],
      'apps/Keep.pdf': { sha256: 'a'.repeat(64) },
      'apps/Duplicate.pdf': { sha256: 'b'.repeat(64) }
    };
    expect(findDigestMatch(library, 'B'.repeat(64))).toBe('apps/Duplicate.pdf');
    expect(findDigestMatch(library, 'c'.repeat(64))).toBe('');
    expect(findDigestMatch(library, '')).toBe('');
    expect(findDigestMatch(new Map([['apps/Map.pdf', { sha256: 'd'.repeat(64) }]]), 'd'.repeat(64))).toBe('apps/Map.pdf');
  });

  it('suggests a free file name instead of overwriting', () => {
    expect(suggestAvailableFileName('Notes.pdf', ['Notes.pdf'])).toBe('Notes (2).pdf');
    expect(suggestAvailableFileName('Notes.pdf', ['notes.pdf', 'Notes (2).pdf'])).toBe('Notes (3).pdf');
    expect(suggestAvailableFileName('Notes.pdf', [])).toBe('Notes (2).pdf');
    expect(suggestAvailableFileName('NoExtension', ['NoExtension'])).toBe('NoExtension (2)');
  });

  it('reads file bytes with progress, and falls back without FileReader', async () => {
    const payload = text('fake file body');
    const file = {
      name: 'Notes.pdf',
      arrayBuffer: async () => payload.buffer
    };
    const progress = [];
    const bytes = await readFileBytes(file, { onProgress: event => progress.push(event) });
    expect(Array.from(bytes)).toEqual(Array.from(payload));

    await expect(readFileBytes(null)).rejects.toThrow('Choose a file');
    await expect(readFileBytes({ name: 'broken.pdf' })).rejects.toThrow('cannot read the selected file');
  });
});
