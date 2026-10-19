#!/usr/bin/env node
// Example: seed Supabase hsc_* tables from local JSON using @supabase/supabase-js + service_role
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/supabase-seed.mjs
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL || 'https://sdjuojttlxciispgttwx.supabase.co';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!serviceKey) {
  console.error('Set SUPABASE_SERVICE_ROLE_KEY (service_role, server-only) to run this script.');
  process.exit(1);
}
const supabase = createClient(url, serviceKey);

const library = JSON.parse(await readFile('library.json', 'utf8'));
const downloads = JSON.parse(await readFile('stats/downloads.json', 'utf8'));
const activity = JSON.parse(await readFile('stats/admin-activity.json', 'utf8'));

console.log(`Seeding ${Object.keys(library).filter(k=>!k.startsWith('_')).length} resources...`);
for (const [path, meta] of Object.entries(library)) {
  if (path.startsWith('_')) continue;
  const { error } = await supabase.from('hsc_resources').upsert({
    path,
    title: meta.title || path.split('/').pop(),
    description: meta.description || '',
    subject: meta.subject || 'Others',
    years: meta.years || [],
    keywords: meta.keywords || meta.tags || [],
    language: meta.language || 'English',
    owner: meta.owner || '',
    department: meta.department || '',
    resource_type: meta.resourceType || '',
    visibility: meta.visibility || 'public',
    version: meta.version || '1.0',
    topic: meta.topic || '',
    licence: meta.licence || '',
    academic_year: meta.academicYear || '',
    added_at: meta.addedAt || null,
    file_size: 0,
    sha256: '',
    download_url: path,
  }, { onConflict: 'path' });
  if (error) console.warn('resource upsert failed', path, error.message);
}
console.log('Resources seeded.');

for (const [path, entry] of Object.entries(downloads.files || {})) {
  await supabase.from('hsc_counters').upsert({ key: entry.key, value: entry.downloads }, { onConflict: 'key' });
  await supabase.from('hsc_file_totals').upsert({ resource_path: path, resource_key: entry.key, total: entry.downloads }, { onConflict: 'resource_path' });
}
await supabase.from('hsc_counters').upsert({ key: 'visitors', value: downloads.visitors || 0 }, { onConflict: 'key' });
console.log('Counters seeded.');

for (const e of activity.logins || []) await supabase.from('hsc_admin_logins').insert({ at: e.at, user_name: e.user });
for (const e of activity.uploads || []) await supabase.from('hsc_admin_uploads').insert({ at: e.at, path: e.path, name: e.name, title: e.title, bytes: e.bytes, subject: e.subject, years: e.years, owner: e.owner });
console.log('Admin activity seeded. DONE');
