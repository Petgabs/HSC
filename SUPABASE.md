# Supabase Integration — HSC School Cloud

This repository is now connected to **Supabase** for live counters, presence, admin activity, **and server-side admin authentication + file storage**, while keeping GitHub Pages + GitHub Contents API as the file-store/ deploy fallback.

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

Created via migrations `create_hsc_tables` + `create_hsc_admin_accounts` (2026-10-19):

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
| **`hsc_admin_accounts`** | **Server-side admin/master credentials (username, role, salt, password_hash)** | **`assets/js/config.js` admin/master gates** |
| Storage bucket `hsc-files` (public) | Website cloud files mirror (`apps/` → `storage/v1/object/public/hsc-files/...`) | GitHub `apps/` |
| RPC: `hsc_increment_counter(counter_key)` | Atomic counter increment, returns new value | — |
| RPC: `hsc_record_download(p_path,p_key,p_device)` | Inserts download + increments totals/counters | — |
| RPC: `hsc_heartbeat_presence(p_bucket_key,p_bucket_index)` | Heartbeat insert/update | — |
| RPC: `hsc_verify_admin(p_username,p_password)` | Verify `SHA-256(salt:password)` server-side (SECURITY DEFINER) | client SHA check |
| RPC: `hsc_authenticate(p_username,p_password)` | Returns `{success, username, role}` | — |
| RPC: `hsc_rotate_password(p_username,p_current_password,p_new_salt,p_new_hash)` | Rotate credential after verifying current password | GitHub commit only |
| Trigger: `hsc_touch_updated_at()` | Auto-updates `updated_at` on `hsc_resources` + `hsc_admin_accounts` | — |

All tables have RLS enabled with permissive `anon`/`authenticated` policies for the static site where needed; **`hsc_admin_accounts` has RLS enabled with *no* anonymous SELECT — hashes are only readable via `SECURITY DEFINER` RPCs** (`extensions.digest` + `pgcrypto`, `encode(...,'hex')`). Seeded with 2 accounts:

- `hsc-admin` / `admin` (salt `38db6ef…`, hash `da1e56…`) — from `config.js`
- `master` / `master` (salt `23fd39…`, hash `e5286e…`) — from `config.js`

Verified: `select hsc_verify_admin('hsc-admin','wrong')` → `false`; test account `TestPass123!` → `true`.

Storage buckets have permissive `hsc anon read/insert/update/delete` policies for `hsc-files` (public mirror).

Seeded with existing content:

- **24** resources from `library.json`
- **5** counters (visitors=52 + 4 per-file)
- **4** file totals, **15** logins, **6** uploads
- **2** admin accounts

## Admin Password & Website Cloud — Now in Supabase ✅

- **Admin password:** Lives **both** in Supabase `hsc_admin_accounts` (source of truth, `SECURITY DEFINER` RPC) **and** in `config.js` (offline fallback). Login flow (`verifyConfiguredAdmin`/`verifyConfiguredMaster` in `app.js`) tries `hsc_authenticate` first via `authenticateSupabaseAdmin`/`authenticateSupabaseMaster`; on `success:false` it rejects; on network failure it falls back to the shipped SHA-256 salt/hash. Rotation in Cloud Settings (`saveAdminAccount`) commits to GitHub `config.js` **and** best-effort calls `rotateSupabasePassword` using the in-memory session password (`rememberSessionPassword('admin'/'master')`) to keep Supabase in sync. `assets/data/publish-token.json` (AES-256-GCM wrapped by both passwords) still protects the GitHub publishing token — Supabase never sees that token.
- **Website cloud:** Primary still **GitHub Pages static** + `apps/` via Contents API (Jekyll builds `apps.json`), but every publish now also `upsertSupabaseResource` + `uploadSupabaseFile(path, bytes)` to `hsc-files` bucket (public `storage/v1/object/public/hsc-files/...`). Delete also `deleteSupabaseResource` + `deleteSupabaseFile`. `loadLibrary` merges `fetchSupabaseResources` → `resourcesToLibrary` so the library is readable even if GitHub is down. `storage.note` in `config.js` documents the mirror.

## Frontend Wiring

### Files added/modified

- `assets/js/config.js` — `SITE_CONFIG.supabase` (url, anonKey, publishableKey, enabled) + updated comment noting Supabase mirror + storage note mirroring; `storage.label` stays `GitHub Pages allowance` for test compat.
- `assets/js/lib/supabase.js` — lightweight PostgREST client (no SDK bundle needed; uses `fetch` + anon headers). Provides: `isSupabaseEnabled`, `fetchSupabaseResources`, `getSupabaseCounters`, `recordSupabaseVisit`, `recordSupabaseDownload`, `heartbeatSupabasePresence`, `readSupabasePresence`, `recordSupabaseLogin/Upload`, `getSupabaseAdminActivity`, `resourcesToLibrary`, `countersToStatsRecord`, **`authenticateSupabaseAdmin/Master`, `rotateSupabasePassword`, `createSupabaseAdminAccount`, `uploadSupabaseFile`, `deleteSupabaseFile`, `getSupabaseFilePublicUrl`**, RPC helpers, RLS-friendly headers, 6.5s timeout, test-env guard (disabled in vitest/jsdom).
- `assets/js/app.js` — imports new supabase auth/storage helpers; `verifyConfiguredAdmin/Master` try Supabase RPC first; `loadLibrary` merges Supabase resources/counters/file_totals; `updateVisitorCounter`/`readDownloadCounter`/`downloadApp` prefer Supabase; presence + activity mirror; **`saveAdminAccount` now also `rotateSupabasePassword`/`createSupabaseAdminAccount`; `submitResource` mirrors to `hsc-files` storage; `deleteGithubResource` also cleans Supabase**.
- `index.html` + `_headers` — CSP `connect-src` now allows `https://*.supabase.co https://*.supabase.in` (and `api.github.com`, `abacus.jasoncameron.dev`, `view.officeapps.live.com` unchanged).
- `sw.js` — precaches `supabase.js`, network-only for `supabase.co`/`supabase.in` (no cache).
- `scripts/vendor.mjs` + `assets/vendor/supabase.mjs` + `package.json` (`@supabase/supabase-js@2.118.0` devDependency, vendored) — optional SDK for Node seeding; frontend uses plain fetch.

### Offline / fallback strategy

- If Supabase URL/anon missing or `enabled:false`, or fetch fails/timeouts, the app falls back to Abacus → GitHub `stats/downloads.json` → `localStorage` and to the shipped `config.js` salt/hash for auth.
- If Supabase succeeds, it becomes the primary source (`stats.backend='supabase'`), but `library.json`/`apps.json` are still merged so GitHub files never disappear.
- Writes are best-effort: failures log `[supabase] ... failed` but never block UI, publishing or download.
- Auth: `hsc_authenticate` failure (wrong password) is definitive; network failure is the only case that falls back to local. This keeps Supabase as source of truth while preserving offline login.

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
2. Publish a file via Dashboard → Upload Resource; check Network tab for `POST https://…supabase.co/rest/v1/hsc_resources` (201), `rpc/hsc_increment_counter`, and `storage/v1/object/hsc-files/apps/...` (201).
3. Download a file; check `hsc_downloads` + `hsc_file_totals` increments.
4. Sign in as `hsc-admin` (or `master` for Cloud Settings); check `hsc_admin_logins` row and that wrong password now fails via RPC.
5. In Cloud Settings, change admin/master password; check `hsc_admin_accounts` updated via `hsc_rotate_password` and that new password works on next login (GitHub commit + Supabase in sync).

To disable Supabase temporarily (use Abacus/GitHub + local hash only):

```js
SITE_CONFIG.supabase.enabled = false; // in console, or edit config.js
localStorage.setItem('schoolcloud.supabase.disabled','1')
```

## Seeding & Management

Seed script used management API (`execute_query` via Supabase connector) — see `/tmp/hsc_seed.sql` batches (24 resources, 5 counters, 4 file_totals, 15 logins, 6 uploads, 2 admin accounts). To re-seed:

```bash
node scripts/supabase-seed.mjs  # uses @supabase/supabase-js + service_role (server-only)
# also seeds admin accounts from config.js salts/hashes
```

Or via SQL in Supabase Dashboard → SQL Editor:

```sql
select count(*) from public.hsc_resources; -- 24
select * from public.hsc_counters order by key;
select * from public.hsc_file_totals;
select username, role, created_at from public.hsc_admin_accounts; -- hsc-admin, master
select * from storage.buckets where id='hsc-files';
```

Add new tables/columns via `supabase__create_migration` (prefix `hsc_` to avoid colliding with `report_files` / `madv_*`).

## Security Notes

- The `anon`/`publishable` key is **not secret** — it ships in `config.js` and is limited by RLS. The `service_role` key must never be committed; it bypasses RLS and is server-only. **Password hashes in `hsc_admin_accounts` are never SELECTable by anon** — only `hsc_verify_admin`/`hsc_authenticate` (SECURITY DEFINER) can check them.
- The stored GitHub publishing token (`assets/data/publish-token.json`, AES-256-GCM + PBKDF2 310k) is unrelated to Supabase; keep admin/master passwords long and unique.
- CSP now allows `*.supabase.co`; narrow to your exact ref (`https://sdjuojttlxciispgttwx.supabase.co`) if you want stricter policy.

## Free Plan Limits

Your org hit the 2 active free-project limit (`Petgabs (2 project limit)`). To create a dedicated HSC project you must pause/delete one or upgrade. Current workaround uses the existing Year 11 Report project with `hsc_` isolation — no data collision.

## Next Steps (optional)

- Enable Realtime on `hsc_counters`, `hsc_file_totals`, `hsc_presence_buckets` for live dashboard updates (uncomment `alter publication supabase_realtime` in migration).
- Narrow storage policies (e.g., require JWT) once Supabase Auth is adopted fully.
- Replace shipped `config.js` gates with pure Supabase (remove fallback) once every device has migrated.
