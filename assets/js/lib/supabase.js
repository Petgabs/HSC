/**
 * Supabase backend for School Cloud System (HSC).
 *
 * This module talks to Supabase PostgREST via plain fetch (no SDK bundle required).
 * The anon/publishable key is public; RLS policies enforce access.
 * When Supabase is unavailable or disabled, callers fall back to GitHub/Abacus.
 *
 * Project: Year 11 Report (sdjuojttlxciispgttwx) — tables use hsc_ prefix
 *   hsc_resources, hsc_counters, hsc_visits, hsc_downloads,
 *   hsc_file_totals, hsc_admin_logins, hsc_admin_uploads, hsc_presence_buckets
 *   + RPC: hsc_increment_counter, hsc_record_download, hsc_heartbeat_presence
 */

import { SITE_CONFIG } from '../config.js';

const SUPABASE = SITE_CONFIG.supabase || {};
const TIMEOUT_MS = 6500;

function supabaseConfig() {
  const url = String(SUPABASE.url || '').trim().replace(/\/+$/, '');
  const anonKey = String(SUPABASE.anonKey || SUPABASE.publishableKey || '').trim();
  // In unit tests (vitest/jsdom) external Supabase should be disabled — mocks
  // for GitHub/Abacus would otherwise intercept the URL and break offline logic.
  const isTestEnv = Boolean(
    typeof globalThis !== 'undefined' && (
      globalThis.__vitest_worker__ ||
      globalThis.__VITEST__ ||
      globalThis.process?.env?.VITEST ||
      globalThis.process?.env?.NODE_ENV === 'test' ||
      (globalThis.navigator && String(globalThis.navigator.userAgent || '').includes('jsdom'))
    )
  );
  const enabled = Boolean(SUPABASE.enabled && url && anonKey && !isTestEnv);
  return { url, anonKey, enabled };
}

export function isSupabaseEnabled() {
  return supabaseConfig().enabled;
}

export function getSupabaseConfig() {
  return supabaseConfig();
}

function supabaseHeaders(extra = {}) {
  const { anonKey } = supabaseConfig();
  return {
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra
  };
}

async function supabaseFetch(path, options = {}) {
  const { url, anonKey } = supabaseConfig();
  if (!url || !anonKey) throw new Error('Supabase is not configured.');
  const fullUrl = `${url}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || TIMEOUT_MS);
  try {
    const response = await fetch(fullUrl, {
      ...options,
      headers: { ...supabaseHeaders(options.headers), ...(options.headers || {}) },
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Resources (library) ----------

export async function fetchSupabaseResources() {
  if (!isSupabaseEnabled()) return null;
  try {
    const res = await supabaseFetch('/rest/v1/hsc_resources?select=*', { method: 'GET' });
    if (!res.ok) throw new Error(`Supabase resources GET ${res.status}`);
    const rows = await res.json();
    return Array.isArray(rows) ? rows : [];
  } catch (error) {
    console.warn('[supabase] fetchResources failed', error);
    return null;
  }
}

export async function upsertSupabaseResource(resource) {
  if (!isSupabaseEnabled()) return null;
  try {
    const body = JSON.stringify(resource);
    const res = await supabaseFetch('/rest/v1/hsc_resources', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body
    });
    // PostgREST merge requires on_conflict param; try alternative header if 400
    if (!res.ok && res.status === 400) {
      const res2 = await supabaseFetch('/rest/v1/hsc_resources?on_conflict=path', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates' },
        body
      });
      if (!res2.ok) throw new Error(`upsert ${res2.status}`);
      return await res2.json().catch(() => null);
    }
    if (!res.ok) throw new Error(`upsert ${res.status}`);
    return await res.json().catch(() => null);
  } catch (error) {
    console.warn('[supabase] upsertResource failed', error);
    return null;
  }
}

export async function deleteSupabaseResource(path) {
  if (!isSupabaseEnabled()) return false;
  try {
    const safe = encodeURIComponent(path);
    const res = await supabaseFetch(`/rest/v1/hsc_resources?path=eq.${safe}`, { method: 'DELETE' });
    return res.ok;
  } catch (error) {
    console.warn('[supabase] deleteResource failed', error);
    return false;
  }
}

// ---------- Counters (visitors + downloads) ----------

export async function getSupabaseCounter(key) {
  if (!isSupabaseEnabled()) return null;
  try {
    const safe = encodeURIComponent(key);
    const res = await supabaseFetch(`/rest/v1/hsc_counters?key=eq.${safe}&select=value`, { method: 'GET' });
    if (!res.ok) throw new Error(`getCounter ${res.status}`);
    const rows = await res.json();
    if (Array.isArray(rows) && rows[0] && typeof rows[0].value !== 'undefined') return Number(rows[0].value) || 0;
    return 0;
  } catch (error) {
    console.warn('[supabase] getCounter failed', error);
    return null;
  }
}

export async function getSupabaseCounters() {
  if (!isSupabaseEnabled()) return null;
  try {
    const res = await supabaseFetch('/rest/v1/hsc_counters?select=key,value', { method: 'GET' });
    if (!res.ok) throw new Error(`getCounters ${res.status}`);
    const rows = await res.json();
    const list = Array.isArray(rows) ? rows : [];
    const map = new Map();
    for (const row of list) if (row?.key) map.set(String(row.key), Number(row.value) || 0);
    return map;
  } catch (error) {
    console.warn('[supabase] getCounters failed', error);
    return null;
  }
}

export async function incrementSupabaseCounter(key) {
  if (!isSupabaseEnabled()) return null;
  try {
    const res = await supabaseFetch('/rest/v1/rpc/hsc_increment_counter', {
      method: 'POST',
      body: JSON.stringify({ counter_key: key })
    });
    if (!res.ok) throw new Error(`increment ${res.status}`);
    const value = await res.json();
    // RPC returns bigint directly (e.g., 42) or {value}
    if (typeof value === 'number') return value;
    if (value && typeof value.value === 'number') return value.value;
    return Number(value) || null;
  } catch (error) {
    console.warn('[supabase] incrementCounter failed', error);
    return null;
  }
}

export async function recordSupabaseVisit({ day, deviceHash } = {}) {
  if (!isSupabaseEnabled()) return null;
  try {
    const res = await supabaseFetch('/rest/v1/hsc_visits', {
      method: 'POST',
      body: JSON.stringify({ day: day || new Date().toISOString().slice(0, 10), device_hash: deviceHash || '' })
    });
    if (!res.ok) throw new Error(`visit ${res.status}`);
    // Also increment visitors counter atomically
    const count = await incrementSupabaseCounter('visitors');
    return count;
  } catch (error) {
    console.warn('[supabase] recordVisit failed', error);
    return null;
  }
}

export async function getSupabaseFileTotals() {
  if (!isSupabaseEnabled()) return null;
  try {
    const res = await supabaseFetch('/rest/v1/hsc_file_totals?select=resource_path,resource_key,total,last_download_at,updated_at', { method: 'GET' });
    if (!res.ok) throw new Error(`fileTotals ${res.status}`);
    const rows = await res.json();
    const list = Array.isArray(rows) ? rows : [];
    const map = new Map();
    for (const row of list) {
      if (!row?.resource_path) continue;
      const key = String(row.resource_path).toLowerCase();
      map.set(key, { path: row.resource_path, key: row.resource_key, downloads: Number(row.total) || 0, updatedAt: row.updated_at || row.last_download_at || '' });
    }
    return map;
  } catch (error) {
    console.warn('[supabase] getFileTotals failed', error);
    return null;
  }
}

export async function recordSupabaseDownload({ path, key, deviceHash } = {}) {
  if (!isSupabaseEnabled()) return null;
  try {
    const res = await supabaseFetch('/rest/v1/rpc/hsc_record_download', {
      method: 'POST',
      body: JSON.stringify({ p_path: path, p_key: key, p_device: deviceHash || '' })
    });
    if (!res.ok) throw new Error(`recordDownload ${res.status}`);
    const total = await res.json();
    return typeof total === 'number' ? total : Number(total) || null;
  } catch (error) {
    console.warn('[supabase] recordDownload failed', error);
    // Fallback: try direct insert then increment
    try {
      await supabaseFetch('/rest/v1/hsc_downloads', { method: 'POST', body: JSON.stringify({ resource_path: path, resource_key: key, device_hash: deviceHash || '' }) });
      return await incrementSupabaseCounter(key);
    } catch {}
    return null;
  }
}

// ---------- Presence (admin-online) ----------

export async function heartbeatSupabasePresence(bucketKey, bucketIndex) {
  if (!isSupabaseEnabled()) return false;
  try {
    const res = await supabaseFetch('/rest/v1/rpc/hsc_heartbeat_presence', {
      method: 'POST',
      body: JSON.stringify({ p_bucket_key: bucketKey, p_bucket_index: bucketIndex })
    });
    return res.ok;
  } catch (error) {
    console.warn('[supabase] heartbeatPresence failed', error);
    return false;
  }
}

export async function readSupabasePresence(bucketKeys) {
  if (!isSupabaseEnabled() || !Array.isArray(bucketKeys) || !bucketKeys.length) return [];
  try {
    const inList = bucketKeys.map(k => encodeURIComponent(k)).join(',');
    const res = await supabaseFetch(`/rest/v1/hsc_presence_buckets?bucket_key=in.(${inList})&select=bucket_key,bucket_index,hits,updated_at`, { method: 'GET' });
    if (!res.ok) throw new Error(`readPresence ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch (error) {
    console.warn('[supabase] readPresence failed', error);
    return [];
  }
}

// ---------- Admin auth (passwords now in Supabase) ----------

export async function authenticateSupabaseAdmin(username, password) {
  if (!isSupabaseEnabled()) return null;
  try {
    const res = await supabaseFetch('/rest/v1/rpc/hsc_authenticate', {
      method: 'POST',
      body: JSON.stringify({ p_username: username, p_password: password })
    });
    if (!res.ok) throw new Error(`auth ${res.status}`);
    const data = await res.json();
    // RPC returns jsonb {success, username, role}
    if (data && typeof data.success === 'boolean') return data;
    return null;
  } catch (error) {
    console.warn('[supabase] authenticate failed', error);
    return null;
  }
}

export async function authenticateSupabaseMaster(password) {
  return authenticateSupabaseAdmin('master', password);
}

export async function rotateSupabasePassword(username, currentPassword, newSalt, newHash) {
  if (!isSupabaseEnabled()) return null;
  try {
    const res = await supabaseFetch('/rest/v1/rpc/hsc_rotate_password', {
      method: 'POST',
      body: JSON.stringify({
        p_username: username,
        p_current_password: currentPassword,
        p_new_salt: newSalt,
        p_new_hash: newHash
      })
    });
    if (!res.ok) throw new Error(`rotate ${res.status}`);
    return await res.json();
  } catch (error) {
    console.warn('[supabase] rotatePassword failed', error);
    return null;
  }
}

export async function createSupabaseAdminAccount(username, role, salt, hash) {
  if (!isSupabaseEnabled()) return null;
  try {
    const res = await supabaseFetch('/rest/v1/rpc/hsc_create_admin_account', {
      method: 'POST',
      body: JSON.stringify({ p_username: username, p_role: role, p_salt: salt, p_hash: hash })
    });
    if (!res.ok) throw new Error(`create ${res.status}`);
    return await res.json();
  } catch (error) {
    console.warn('[supabase] createAccount failed', error);
    return null;
  }
}

// ---------- Supabase Storage (website cloud files mirror) ----------

export function getSupabaseFilePublicUrl(path) {
  if (!isSupabaseEnabled()) return null;
  const { url } = supabaseConfig();
  const clean = String(path || '').replace(/^\/+/, '');
  return `${url}/storage/v1/object/public/hsc-files/${encodeURIComponent(clean).replace(/%2F/g, '/')}`;
}

export async function uploadSupabaseFile(path, bytes, contentType = 'application/octet-stream') {
  if (!isSupabaseEnabled()) return null;
  try {
    const clean = String(path || '').replace(/^\/+/, '');
    const res = await supabaseFetch(`/storage/v1/object/hsc-files/${clean}`, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        'x-upsert': 'true',
        // anon key already in supabaseHeaders; storage needs dup headers
        apikey: supabaseConfig().anonKey,
        Authorization: `Bearer ${supabaseConfig().anonKey}`
      },
      body: bytes
    });
    // storage returns {Key} or {path}
    if (!res.ok) throw new Error(`storage upload ${res.status}`);
    return true;
  } catch (error) {
    console.warn('[supabase] uploadFile failed', error);
    return null;
  }
}

export async function deleteSupabaseFile(path) {
  if (!isSupabaseEnabled()) return false;
  try {
    const res = await supabaseFetch('/storage/v1/object/hsc-files', {
      method: 'DELETE',
      body: JSON.stringify({ prefixes: [String(path || '').replace(/^\/+/, '')] })
    });
    return res.ok;
  } catch (error) {
    console.warn('[supabase] deleteFile failed', error);
    return false;
  }
}

// ---------- Admin activity ----------

export async function recordSupabaseLogin(userName) {
  if (!isSupabaseEnabled()) return false;
  try {
    const res = await supabaseFetch('/rest/v1/hsc_admin_logins', {
      method: 'POST',
      body: JSON.stringify({ user_name: userName || 'hsc-admin', at: new Date().toISOString() })
    });
    return res.ok;
  } catch (error) {
    console.warn('[supabase] recordLogin failed', error);
    return false;
  }
}

export async function recordSupabaseUpload({ path, name, title, bytes, subject, years, owner, at } = {}) {
  if (!isSupabaseEnabled()) return false;
  try {
    const payload = {
      at: at || new Date().toISOString(),
      path: String(path || ''),
      name: String(name || path || ''),
      title: String(title || name || path || ''),
      bytes: Number(bytes) || 0,
      subject: String(subject || ''),
      years: Array.isArray(years) ? years.map(Number).filter(n => Number.isFinite(n)) : [],
      owner: String(owner || '')
    };
    const res = await supabaseFetch('/rest/v1/hsc_admin_uploads', { method: 'POST', body: JSON.stringify(payload) });
    return res.ok;
  } catch (error) {
    console.warn('[supabase] recordUpload failed', error);
    return false;
  }
}

export async function getSupabaseAdminActivity(limit = 100) {
  if (!isSupabaseEnabled()) return null;
  try {
    const [loginsRes, uploadsRes] = await Promise.all([
      supabaseFetch(`/rest/v1/hsc_admin_logins?select=at,user_name,created_at&order=at.desc&limit=${limit}`, { method: 'GET' }),
      supabaseFetch(`/rest/v1/hsc_admin_uploads?select=at,path,name,title,bytes,subject,years,owner&order=at.desc&limit=${limit}`, { method: 'GET' })
    ]);
    if (!loginsRes.ok || !uploadsRes.ok) throw new Error(`adminActivity ${loginsRes.status}/${uploadsRes.status}`);
    const loginsRaw = await loginsRes.json();
    const uploadsRaw = await uploadsRes.json();
    const logins = Array.isArray(loginsRaw) ? loginsRaw : [];
    const uploads = Array.isArray(uploadsRaw) ? uploadsRaw : [];
    // Normalize to same shape as adminActivity.js expects
    return {
      updatedAt: new Date().toISOString(),
      logins: logins.map(r => ({ at: r.at || r.created_at, user: r.user_name })),
      uploads: uploads.map(r => ({ at: r.at, path: r.path, name: r.name, title: r.title, bytes: r.bytes, subject: r.subject, years: r.years, owner: r.owner }))
    };
  } catch (error) {
    console.warn('[supabase] getAdminActivity failed', error);
    return null;
  }
}

// ---------- Unified helpers for app.js ----------

/**
 * Convert hsc_resources rows into the library.json shape used by metadata.js
 * { "apps/File.pdf": { title, subject, years, ... } }
 */
export function resourcesToLibrary(rows) {
  if (!Array.isArray(rows)) return {};
  const lib = {};
  for (const row of rows) {
    if (!row?.path) continue;
    lib[row.path] = {
      title: row.title || '',
      description: row.description || '',
      subject: row.subject || 'Others',
      years: Array.isArray(row.years) ? row.years : [],
      keywords: Array.isArray(row.keywords) ? row.keywords : [],
      language: row.language || 'English',
      owner: row.owner || '',
      department: row.department || '',
      resourceType: row.resource_type || '',
      visibility: row.visibility || 'public',
      version: row.version || '1.0',
      topic: row.topic || '',
      licence: row.licence || '',
      academicYear: row.academic_year || '',
      addedAt: row.added_at || row.created_at || '',
      fileSize: row.file_size || 0,
      sha256: row.sha256 || '',
      downloadUrl: row.download_url || row.path
    };
  }
  return lib;
}

/**
 * Build a stats/downloads.json-shaped record from Supabase counters + file_totals
 */
export function countersToStatsRecord({ visitors, fileTotals }) {
  const files = {};
  if (fileTotals instanceof Map) {
    for (const [, entry] of fileTotals) {
      const p = entry.path;
      if (!p) continue;
      files[p] = { downloads: entry.downloads || 0, key: entry.key || '' };
    }
  }
  return {
    namespace: SUPABASE.enabled ? 'supabase:hsc' : 'petgabs-hsc-schoolcloud',
    updatedAt: new Date().toISOString(),
    visitors: Number(visitors) || 0,
    files
  };
}
