import { fileExtension } from './format.js';

export function previewDescriptor(item) {
  if (!item?.downloadUrl) return null;
  const extension = fileExtension(item).toLowerCase();
  const source = new URL(item.downloadUrl, globalThis.location?.href || 'https://schoolcloud.invalid/');
  if (extension === 'pdf') {
    return { src: source.href, sandbox: 'allow-downloads', label: `PDF preview: ${item.name}` };
  }
  if (['html', 'htm'].includes(extension)) {
    return { src: source.href, sandbox: 'allow-scripts allow-forms', label: `Mini app preview: ${item.name}` };
  }
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(extension)) {
    const viewer = new URL('https://view.officeapps.live.com/op/embed.aspx');
    viewer.searchParams.set('src', source.href);
    return { src: viewer.href, sandbox: 'allow-scripts allow-forms', label: `Office preview: ${item.name}` };
  }
  return null;
}

export function canPreviewItem(item) {
  return Boolean(previewDescriptor(item));
}
