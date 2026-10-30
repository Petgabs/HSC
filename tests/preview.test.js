import { describe, expect, it } from 'vitest';
import { canPreviewItem, previewDescriptor } from '../assets/js/lib/preview.js';

describe('resource previews', () => {
  it('uses a native video player for MP4 resources', () => {
    const item = { name: 'Lesson video', fileName: 'lesson.mp4', downloadUrl: 'apps/lesson.mp4' };
    expect(previewDescriptor(item)).toMatchObject({
      type: 'video',
      src: expect.stringContaining('/apps/lesson.mp4'),
      label: 'Video preview: Lesson video'
    });
    expect(canPreviewItem(item)).toBe(true);
  });

  it('keeps existing document and mini-app preview behavior', () => {
    expect(previewDescriptor({ name: 'Notes', fileName: 'notes.pdf', downloadUrl: 'apps/notes.pdf' }))
      .toMatchObject({ sandbox: 'allow-downloads', label: 'PDF preview: Notes' });
    expect(previewDescriptor({ name: 'Quiz', fileName: 'quiz.html', downloadUrl: 'apps/quiz.html' }))
      .toMatchObject({ sandbox: 'allow-scripts allow-forms', label: 'Mini app preview: Quiz' });
    expect(canPreviewItem({ name: 'Archive', fileName: 'archive.zip', downloadUrl: 'apps/archive.zip' })).toBe(false);
  });
});
