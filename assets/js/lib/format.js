export function formatCount(value) {
  const number = Number(value);
  return new Intl.NumberFormat('en-AU', { maximumFractionDigits: 0 }).format(
    Number.isFinite(number) && number > 0 ? Math.floor(number) : 0
  );
}

export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
}

export function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

export function formatYears(years) {
  const values = (Array.isArray(years) ? years : [])
    .map(Number)
    .filter(year => Number.isInteger(year))
    .sort((a, b) => a - b);
  return values.map(year => `Year ${year}`).join(', ');
}

export function formatDownloadCount(value) {
  const number = Number(value) || 0;
  return `${formatCount(number)} download${number === 1 ? '' : 's'}`;
}

export function fileExtension(itemOrName) {
  const filename = typeof itemOrName === 'string'
    ? itemOrName
    : itemOrName?.fileName || itemOrName?.path || '';
  const match = String(filename).match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toUpperCase() : 'FILE';
}

export function fileIcon(itemOrName) {
  const ext = fileExtension(itemOrName).toLowerCase();
  if (ext === 'html' || ext === 'htm') return 'code-2';
  if (ext === 'pdf') return 'file-text';
  if (['doc', 'docx'].includes(ext)) return 'file-text';
  if (['xls', 'xlsx'].includes(ext)) return 'table-2';
  if (['ppt', 'pptx'].includes(ext)) return 'presentation';
  return 'file';
}

export function kindLabel(itemOrName) {
  const ext = fileExtension(itemOrName).toLowerCase();
  const labels = {
    html: 'Interactive mini app', htm: 'Interactive mini app', pdf: 'PDF document',
    doc: 'Word document', docx: 'Word document', xls: 'Excel workbook',
    xlsx: 'Excel workbook', ppt: 'PowerPoint presentation', pptx: 'PowerPoint presentation'
  };
  return labels[ext] || 'Learning resource';
}

export function visibilityLabel(value) {
  return ({ public: 'Public', school: 'School only', class: 'Class only', 'school-only': 'School only', 'class-only': 'Class only' })[value] || 'Public';
}

export function visibilityAccent(value) {
  if (value === 'class' || value === 'class-only') return 'bg-rose-50 text-rose-700 ring-rose-200';
  if (value === 'school' || value === 'school-only') return 'bg-amber-50 text-amber-700 ring-amber-200';
  return 'bg-slate-50 text-slate-600 ring-slate-200';
}

export function subjectAccent(subject) {
  const colors = {
    Mathematics: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
    'EALD/English': 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    CAL: 'bg-amber-50 text-amber-700 ring-amber-200',
    BS: 'bg-sky-50 text-sky-700 ring-sky-200',
    VA: 'bg-rose-50 text-rose-700 ring-rose-200',
    PHY: 'bg-violet-50 text-violet-700 ring-violet-200',
    MEX: 'bg-teal-50 text-teal-700 ring-teal-200'
  };
  return colors[subject] || 'bg-slate-50 text-slate-700 ring-slate-200';
}

export function freshness(item, now = Date.now()) {
  const timestamp = Date.parse(item?.addedAt || item?.meta?.addedAt || '');
  if (!Number.isFinite(timestamp)) {
    return {
      label: 'In the library', detail: '', title: 'Published resource',
      badgeClass: 'bg-slate-50 text-slate-600 ring-slate-200', iconName: 'library'
    };
  }
  const days = Math.floor((now - timestamp) / 86_400_000);
  if (days < 1) {
    return {
      label: 'Latest', detail: 'Added today', title: 'Added in the last 24 hours',
      badgeClass: 'bg-emerald-50 text-emerald-700 ring-emerald-200', iconName: 'sparkles'
    };
  }
  if (days === 1) {
    return {
      label: 'Yesterday', detail: 'Added yesterday', title: 'Added yesterday',
      badgeClass: 'bg-emerald-50 text-emerald-700 ring-emerald-200', iconName: 'clock-3'
    };
  }
  return {
    label: formatDate(timestamp), detail: `${days} days ago`, title: `Added ${formatDate(timestamp)}`,
    badgeClass: 'bg-slate-50 text-slate-600 ring-slate-200', iconName: 'calendar-days'
  };
}

export function isReviewDue(value) {
  if (!value) return false;
  const due = Date.parse(`${value}T23:59:59`);
  return Number.isFinite(due) && due < Date.now();
}

/**
 * Short "how long ago" wording for dashboards: "just now", "12 minutes ago",
 * "3 hours ago", "2 days ago", and a plain date once a timestamp is more than
 * about two weeks old. An unusable value returns '' so callers can hide the
 * line instead of printing "Invalid Date".
 */
export function formatRelativeTime(value, now = Date.now()) {
  const timestamp = typeof value === 'number' ? value : Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) return '';
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const seconds = Math.round((nowMs - timestamp) / 1000);
  if (seconds < 45) return seconds <= 5 ? 'just now' : `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor((nowMs - timestamp) / 86_400_000);
  if (days <= 14) return `${days} day${days === 1 ? '' : 's'} ago`;
  return formatDate(timestamp);
}

/** Full date and local time, e.g. "6 Oct 2026, 9:15 pm". */
export function formatDateTime(value) {
  const timestamp = typeof value === 'number' ? value : Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) return '';
  return new Intl.DateTimeFormat('en-AU', {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit'
  }).format(new Date(timestamp));
}
