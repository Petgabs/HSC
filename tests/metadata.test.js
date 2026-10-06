import { describe, expect, it } from 'vitest';
import { inferMetadata, isSupportedFile, metadataFromLibrary, normalizeLibraryEntry } from '../assets/js/lib/metadata.js';

describe('library metadata', () => {
  it('infers school subject and years from file names', () => {
    expect(inferMetadata('Year 12 Mathematics Advanced Revision.pdf')).toMatchObject({
      subject: 'Mathematics', years: [12], kind: 'pdf'
    });
  });

  it('prefers curated metadata and keeps arrays normalized', () => {
    expect(inferMetadata('Year 9 English.docx', {
      title: 'HSC English Notes', subject: 'EALD/English', years: ['11', '12'], keywords: ['  essay ', 'revision']
    })).toMatchObject({
      title: 'HSC English Notes', subject: 'EALD/English', years: [11, 12], tags: ['essay', 'revision']
    });
  });

  it('accepts supported classroom file extensions only', () => {
    for (const file of ['a.html', 'a.htm', 'a.pdf', 'a.docx', 'a.xlsx', 'a.ppt']) expect(isSupportedFile(file)).toBe(true);
    for (const file of ['a.exe', 'a.zip', 'a.pdf.exe', '../secret.pdf']) expect(isSupportedFile(file)).toBe(false);
  });

  it('normalizes a published file and rejects unsafe paths and URLs', () => {
    const item = normalizeLibraryEntry({
      name: 'Year 12.pdf', path: 'apps/Year 12.pdf', download_url: 'https://raw.githubusercontent.com/Petgabs/HSC/main/apps/Year%2012.pdf'
    }, { title: 'HSC Paper', years: [12] });
    expect(item).toMatchObject({ name: 'HSC Paper', path: 'apps/Year 12.pdf', source: 'github', meta: { years: [12] } });
    expect(normalizeLibraryEntry({ name: 'x.pdf', path: 'apps/../secret.pdf', download_url: 'https://raw.githubusercontent.com/Petgabs/HSC/main/secret.pdf' })).toBeNull();
    expect(normalizeLibraryEntry({ name: 'x.pdf', path: 'apps/x.pdf', download_url: 'javascript:alert(1)' })).toBeNull();
  });

  it('maps path and bare-filename library keys', () => {
    const metadata = metadataFromLibrary({ 'apps/a.pdf': { title: 'A' }, 'b.pdf': { title: 'B' }, _comment: [] });
    expect(metadata.get('apps/a.pdf').title).toBe('A');
    expect(metadata.get('b.pdf').title).toBe('B');
    expect(metadata.has('_comment')).toBe(false);
  });

  it('returns an empty Map for a missing or malformed library', () => {
    for (const bad of [null, undefined, 42, 'nope', [], '[]']) {
      const metadata = metadataFromLibrary(bad);
      expect(metadata).toBeInstanceOf(Map);
      expect(metadata.size).toBe(0);
      expect(metadata.get('apps/a.pdf')).toBeUndefined();
    }
  });
});
