# School Cloud System

**Powered by Petgabs**

A public school resource library. Students can search, filter, preview and
download classroom mini apps, worksheets, notes and revision files. The
administrator can publish resources directly from the website to the GitHub
repository; GitHub Pages then makes them available to students.

## What this version does

- Keeps the existing student library, resource cards, search, subject/year
  filters, previews, download links, dashboard, resource statistics and offline
  support.
- Removes the separate teacher login and teacher credential management. The
  website has one administrator sign-in; admin uploads publish directly rather
  than entering a teacher review queue.
- Uploads supported files to `apps/` and updates `library.json` with their
  metadata through GitHub's Contents API. New files are not silently allowed to
  overwrite an existing file with the same name.
- Uses Abacus for the site-visit counter and a separate download counter for
  every published file. Every Download click sends one Abacus `hit`; each new
  browser-tab session sends one visitor `hit`. A GitHub Actions workflow copies
  the shared visitor and per-file totals into `stats/downloads.json` every 15
  minutes (and when the published library changes), so the GitHub record stays
  current without exposing a write token to visitors.
- Keeps a publishing token out of the source and repository. An administrator
  enters it in **Cloud Settings** when ready. It is verified by GitHub and held
  only in application memory in that tab; it is never stored in localStorage,
  sessionStorage, or a repository file. Signing out clears it.

## Admin publishing setup

1. Sign in with the administrator account (`hsc-admin`). The password is shared
   with the administrator out of band; it is not stored in this repository.
2. Open **Cloud Settings** and confirm the repository is `Petgabs/HSC`.
3. When ready, paste a **fine-grained GitHub Personal Access Token** scoped to
   this repository and grant **Contents: Read and write**. The site checks the
   token before enabling uploads.
4. Use **Upload Resource**, select an HTML, PDF, Word, Excel or PowerPoint file
   (up to 50 MB), add the metadata, preview it and choose **Publish to GitHub &
   Website**. The file is committed into `apps/`; its metadata is merged into
   `library.json`.
5. GitHub Pages must be configured to publish this repository's `main` branch
   (root). Its next deployment updates `apps.json` and serves the download. A
   Pages build/deployment can take a little while after an upload.
6. In **Settings → Actions → General**, allow GitHub Actions to have write
   permissions for repository contents. The counter-sync workflow uses the
   built-in `GITHUB_TOKEN` to commit the shared totals; it does not need a
   personal token or any added secret.

The client-side admin password check is only a convenience gate for the admin
controls: a static GitHub Pages site cannot provide server-side authentication.
The GitHub token is the actual write credential, and GitHub enforces its
permissions. Because this repository is public, the stored digest can be
downloaded and attacked offline, so the sign-in must not be treated as
protection for anything sensitive — pick a password that is not reused
elsewhere, and keep the GitHub token scoped to this repository only. Do not
upload private student or staff information to a public repository.

### Administrator credentials

The administrator identity lives in `SITE_CONFIG.admin` in
`assets/js/config.js`. It contains three values and nothing secret:

- `username` — `hsc-admin`.
- `salt` — a random 32-character hex string.
- `passwordHash` — lowercase hex SHA-256 of `<salt>:<password>`.

The plain password is never committed. Sign-in compares the digest of the
entered password against `passwordHash`, so the current password is only known
to whoever was given it out of band.

To rotate the password, generate a new salt and recompute the digest, then
replace both values in `assets/js/config.js`:

```sh
salt=$(openssl rand -hex 16)
password='<new password>'
printf 'salt: %s\npasswordHash: %s\n' "$salt" \
  "$(printf '%s' "$salt:$password" | sha256sum | cut -d' ' -f1)"
```

Publishing that change and reloading the site is enough — no database or server
deployment step is involved. Blank out the three fields to disable admin sign-in
completely.

## Counters: live Abacus totals plus a GitHub-saved record

Every download total is counted live by the Abacus API at
`https://abacus.jasoncameron.dev` with the namespace
`petgabs-hsc-schoolcloud`:

- Visitor count: `GET /hit/<namespace>/visitors` once when a tab first visits
  the site in its browser session. A session-storage marker survives reloads;
  refreshes and later reads use `GET /get/<namespace>/visitors` and do not
  increment the total.
- Per-file count: `GET /get/<namespace>/<stable-file-key>` to display the
  current value and `GET /hit/<namespace>/<stable-file-key>` after a download
  click. Library cards read lazily as they approach the viewport. Opening the
  admin dashboard loads any unread counts and refreshes values older than 10
  seconds; **Refresh Stats** also rereads the visitor total and refreshes
  per-file counts, with each file read rate-limited to once every 10 seconds.

School content filters, ad blockers and Abacus rate limits can all stop a
browser from reaching the counter service, so the site keeps two more layers
and always displays the highest known value (max-wins, so no layer can drag a
total backwards):

1. **GitHub record** — `stats/downloads.json` in this repository, served from
   the same website address as the library itself, so it loads wherever the
   site loads. It holds the last saved visitor total, per-file download totals
   with their Abacus keys, and the save time.
2. **This browser only** — a per-browser local fallback used when both shared
   layers are unreachable.

The `Sync Abacus counters to GitHub` workflow reads the current visitor and
per-file Abacus totals every 15 minutes, and after changes to the published
library. It commits only when a total or file key changes. The workflow uses
GitHub Actions' short-lived `GITHUB_TOKEN` with Contents write permission; no
GitHub credential is shipped to or requested from visitors. If Abacus is
unreachable, each failed read keeps the previous GitHub value, and every update
merges max-wins so saved totals never move backwards. GitHub Pages serves the
updated record after its next deployment. The dashboard's **Save counts to
GitHub** button remains available for an immediate admin sync and uses the
in-memory token from **Cloud Settings** (Contents: Read and write). Old entries
for removed files are retained rather than discarded automatically.

A counter outage never blocks the library or a file download. The site reports
which layer is serving the numbers (Abacus, GitHub record, or this browser
only). It does not retry a timed-out `hit`, because retrying could increment a
count twice. The GitHub snapshot is periodic, so Abacus displays a download
immediately while the durable JSON record may take up to one workflow interval
plus the GitHub Pages deployment to refresh.

The published file list in `apps.json` is generated by Jekyll. Its template
keeps the path check and the extension check in nested `{% if %}` blocks on
purpose: Liquid gives `and`/`or` no precedence inside one condition, so a
mixed single-line condition evaluates in a version-dependent order. Download
URLs are repository-relative (`apps/Name.pdf`) so they resolve under project
Pages (`/HSC/`), a custom domain, or localhost without a configured `baseurl`.

## Local development

```sh
npm ci
npm run build
npm test
npm run lint:js
npm run dev
```

The development server listens on `0.0.0.0:8080` and sends no-cache headers.
`assets/css/app.css` and the two locally vendored runtime scripts are committed
build output so GitHub Pages can serve the site without a build step.

## Repository content

- `apps/` — published downloadable files (created when the first admin upload
  is committed).
- `apps.json` — Jekyll-generated file list used by the student library.
- `library.json` — optional curated titles, descriptions, subjects, years,
  keywords and other metadata.
- `stats/downloads.json` — durable GitHub record of the shared visitor and
  per-file download totals, synchronized automatically by GitHub Actions and
  served to every visitor as the same-origin counter fallback.
- `.github/workflows/sync-abacus-stats.yml` — scheduled Abacus-to-GitHub
  snapshot workflow (with a manual workflow-dispatch option).
- `index.html` — the student library, admin dashboard, upload form, settings
  and preview UI.
- `assets/js/` — application, Abacus counters, GitHub publishing and metadata
  code. No publishing token is stored here.
- `sw.js` — offline shell/data/download caching. Abacus and GitHub API traffic
  is always network-only.

Supported extensions: `.html`, `.htm`, `.pdf`, `.doc`, `.docx`, `.xls`,
`.xlsx`, `.ppt`, `.pptx`.
