# HSC student visit tracking

The production backend is the dedicated Supabase project `HSC Student Visits` (`ifnimguckfueeribokps`). It is intentionally separate from the unrelated MAdv project.

## Data and access

- `hsc_visits` stores one visit per browser-tab session. Students may opt in with an English name and class/section, or skip; skipped rows contain no identifying fields.
- `hsc_visit_activities` stores download and video-play-start events only when the student opted in.
- `hsc_active_sessions` backs the live-user indicator. A session counts as active for two minutes after its last heartbeat.
- `hsc_daily_visits` is an aggregate updated by a database trigger; its day boundary is UTC.
- RLS is enabled and `anon`/`authenticated` have no direct table access. The Edge Function uses the server-provided service-role key. Never add that key to the website, this repository, or a client-side environment file.
- The Edge Function returns aggregate-only data to public requests. Admin list/reset actions verify a GitHub token has write permission on `Petgabs/HSC` before accessing identifiable rows.
- The UI explains what is recorded and that records remain until an administrator resets them. Reset clears visitor rows, linked activities, daily totals, and active sessions; existing Abacus resource/download counters are separate.

## Deploying changes

Migrations are in `migrations/`. The deployed function source is in `functions/hsc-visitor-data/index.ts`; deploy it to the same project with the Supabase CLI after logging in and linking the project. The function uses the standard `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` Edge Function environment variables and does not require a secret to be checked into the repository.

The browser config contains only the project URL and publishable key in `assets/js/config.js`. The static site CSP allowlists this project URL for the Edge Function request.
