# Supabase Integration — HSC School Cloud

This repository is now connected to **Supabase** for live counters, presence and admin activity, while keeping GitHub Pages + GitHub Contents API as the file-store fallback.

## Connection Status

- **Organization:** Petgabs's Org (`wyvdmbtczfhmmwfnjeqn`)
- **Project wired (Year 11 Report / HSC):** `sdjuojttlxciispgttwx` — `https://sdjuojttlxciispgttwx.supabase.co`
- **Region:** us-east-1 · **Status:** ACTIVE_HEALTHY
- **Plan:** Free (2 active project limit — new project creation blocked, so HSC tables live in the existing Year 11 Report project with `hsc_` prefix)
- **Fallback project:** MAdv `oingpzfpxcoshbytqevx` (not wired, kept for isolation)

Credentials are valid via the connected Supabase connector; `validate_credential` succeeds.

## Supabase URL & Keys (public anon)

These live in `assets/js/config.js` (`SITE_CONFIG.supabase`) — the anon/publishable key is public by design (RLS policies enforce access). Never commit a `service_role` key.

```js
supabase: {
  url: 'https://sdjuojttlxciispgttwx.supabase.co',
  anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…', // full in config.js
  publishableKey: 'sb_publishable_zOoQK2V55OEwCyt3fmRJFQ_PmQWmmFJ',
  enabled: true
}
```

Override via local `localStorage` for dev (optional):

```js
localStorage.setItem('schoolcloud.supabase.url', 'https://…supabase.co')
localStorage.setItem('schoolcloud.supabase.anonKey', '…')
```

## Database Tables (hsc_ prefix, isolated)

Created via migration `create_hsc_tables` (2026-10-19):

| Table | Purpose | Replaces |
|---|---|---|
| `hsc_resources` | Library metadata per `apps/` file (title, subject, years, owner, sha256, size, addedAt, visibility, etc.) | `library.json` + `apps.json` |
| `hsc_counters` | `key → value` counters (e.g., `visitors`, `download-1649f138`) | Abacus |
| `hsc_visits` | Per-visit log (day, device_hash) | Abacus visitor hits |
| `hsc_downloads` | Per-download log (resource_path, resource_key) | Abacus download hits |
| `hsc_file_totals` | Aggregated per-file totals cache | `stats/downloads.json` |
| `hsc_admin_logins` | Sign-in history (at, user_name) | `stats/admin-activity.json` logins |
| `hsc_admin_uploads` | Upload history (at, path, title, bytes, subject, years, owner) | `stats/admin-activity.json` uploads |
| `hsc_presence_buckets` | Admin-online heartbeats (bucket_key, bucket_index, hits) | Abacus time-bucket counters |
| RPC: `hsc_increment_counter(counter_key)` | Atomic counter increment, returns new value | — |
| RPC: `hsc_record_download(p_path,p_key,p_device)` | Inserts download + increments totals/counters | — |
| RPC: `hsc_heartbeat_presence(p_bucket_key,p_bucket_index)` | Heartbeat insert/update | — |
| Trigger: `hsc_touch_updated_at()` | Auto-updates `updated_at` on `hsc_resources` | — |

All tables have RLS enabled with permissive `anon`/`authenticated` policies for the static site (`select`/`insert`/`update` where needed, `service_role` bypasses RLS). Indexes on `subject`, `added_at`, `day`, `resource_path`, `at`, etc.

Seeded with existing content:

- **24** resources from `library.json`
- **5** counters (visitors=52 + 4 per-file)
- **4** file totals, **15** logins, **6** uploads

## Frontend Wiring

### Files added/modified

- `assets/js/config.js` — `SITE_CONFIG.supabase` (url, anonKey, publishableKey, enabled)
- `assets/js/lib/supabase.js` — lightweight PostgREST client (no SDK bundle needed; uses `fetch` + anon headers). Provides: `isSupabaseEnabled`, `fetchSupabaseResources`, `getSupabaseCounters`, `recordSupabaseVisit`, `recordSupabaseDownload`, `heartbeatSupabasePresence`, `readSupabasePresence`, `recordSupabaseLogin/Upload`, `getSupabaseAdminActivity`, `resourcesToLibrary`, `countersToStatsRecord`, RPC helpers, RLS-friendly headers, 6.5s timeout, test-env guard (disabled in vitest/jsdom).
- `assets/js/app.js` — imports Supabase helpers; `loadLibrary` now merges Supabase resources/counters/file_totals into library/stats snapshot and manifests; `updateVisitorCounter` tries Supabase `recordSupabaseVisit`/`getSupabaseCounters` before Abacus; `readDownloadCounter` tries Supabase counters/file_totals; `downloadApp` calls `recordSupabaseDownload` first then Abacus; presence `announceAdminPresence`/`refreshAdminPresence` also heartbeat/read Supabase buckets; `recordAdminLogin`/`recordAdminUpload`/`hydrateAdminActivity` mirror to Supabase.
- `index.html` + `_headers` — CSP `connect-src` now allows `https://*.supabase.co https://*.supabase.in` (and `api.github.com`, `abacus.jasoncameron.dev`, `view.officeapps.live.com` unchanged).
- `sw.js` — precaches `supabase.js`, network-only for `supabase.co`/`supabase.in` (no cache).
- `scripts/vendor.mjs` + `assets/vendor/supabase.mjs` + `package.json` (`@supabase/supabase-js@2.118.0` devDependency, vendored) — optional SDK for Node seeding; frontend uses plain fetch.

### Offline / fallback strategy

- If Supabase URL/anon missing or `enabled:false`, or fetch fails/timeouts, the app falls back to Abacus → GitHub `stats/downloads.json` → `localStorage` (existing `maxCounter` logic unchanged).
- If Supabase succeeds, it becomes the primary source (`stats.backend='supabase'`), but `library.json`/`apps.json` are still merged so GitHub files never disappear.
- Writes are best-effort: failures log `[supabase] ... failed` but never block UI, publishing or download.

### CSP

```http
connect-src 'self' https://api.github.com https://abacus.jasoncameron.dev https://*.supabase.co https://*.supabase.in
```

## Local Development

```bash
npm install
npm run vendor   # copies alpine, lucide, libsodium + supabase.mjs
npm run dev      # http://0.0.0.0:8080
```

To test Supabase locally (browser):

1. Open DevTools → Application → Local Storage: verify `SITE_CONFIG.supabase.url` matches your project.
2. Publish a file via Dashboard → Upload Resource; check Network tab for `POST https://…supabase.co/rest/v1/hsc_resources` (201) and `rpc/hsc_increment_counter`.
3. Download a file; check `hsc_downloads` + `hsc_file_totals` increments.
4. Sign in as `hsc-admin`; check `hsc_admin_logins` row.

To disable Supabase temporarily (use Abacus/GitHub only):

```js
SITE_CONFIG.supabase.enabled = false; // in console, or edit config.js
localStorage.setItem('schoolcloud.supabase.disabled','1')
```

## Seeding & Management

Seed script used management API (`execute_query` via Supabase connector) — see `/tmp/hsc_seed.sql` batches (24 resources, 5 counters, 4 file_totals, 15 logins, 6 uploads). To re-seed:

```bash
node scripts/supabase-seed.mjs  # if you add one using @supabase/supabase-js + service_role (server-only)
```

Or via SQL in Supabase Dashboard → SQL Editor:

```sql
select count(*) from public.hsc_resources; -- should be 24
select * from public.hsc_counters order by key;
select * from public.hsc_file_totals;
```

Add new tables/columns via `supabase__create_migration` (prefix `hsc_` to avoid colliding with `report_files` / `madv_*`).

## Security Notes

- The `anon`/`publishable` key is **not secret** — it ships in `config.js` and is limited by RLS. The `service_role` key must never be committed; it bypasses RLS and is server-only.
- The stored GitHub publishing token (`assets/data/publish-token.json`, AES-256-GCM + PBKDF2 310k) is unrelated to Supabase; keep admin/master passwords long and unique.
- CSP now allows `*.supabase.co`; narrow to your exact ref (`https://sdjuojttlxciispgttwx.supabase.co`) if you want stricter policy.

## Free Plan Limits

Your org hit the 2 active free-project limit (`Petgabs (2 project limit)`). To create a dedicated HSC project you must pause/delete one or upgrade. Current workaround uses the existing Year 11 Report project with `hsc_` isolation — no data collision.

## Next Steps

- Optionally enable Realtime on `hsc_counters`, `hsc_file_totals`, `hsc_presence_buckets` for live dashboard updates (uncomment `alter publication supabase_realtime` in migration).
- Add Supabase Storage bucket `hsc-files` if you want to move `apps/` out of GitHub.
- Wire Supabase Auth to replace the static `admin`/`master` SHA-256 gates for real server-side auth (keep SHA gates as convenient client-side fallback).
