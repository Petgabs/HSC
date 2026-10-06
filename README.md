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
- Gives every file row in the admin dashboard (mini-app table, documents
  table, most-used list, review-due list, upload-age groups and cleanup
  candidates) its own delete button. One confirmation removes the file from
  `apps/`, its metadata from `library.json` and its saved total from
  `stats/downloads.json` in the GitHub repository, clears it from the current
  browser's library view, download counts and offline cache, and the file
  disappears from the public website everywhere once GitHub Pages finishes its
  next deployment.
- Uses Abacus for the site-visit counter and a separate download counter for
  every published file. Every Download click sends one Abacus `hit`; each new
  browser-tab session sends one visitor `hit`. A GitHub Actions workflow copies
  the shared visitor and per-file totals into `stats/downloads.json` every 15
  minutes (and when the published library changes), so the GitHub record stays
  current without exposing a write token to visitors.
- Keeps the publishing token out of source files and public repository content.
  In **Cloud Settings**, the administrator can save it once as the private
  `SCHOOLCLOUD_PUBLISH_TOKEN` GitHub Actions repository secret. The browser
  encrypts it with GitHub's repository public key before sending it to GitHub;
  if the secret already exists, the site will not overwrite it. For direct
  website publishing, the token is also held only in memory in the current tab
  and is cleared on sign-out or tab close. It is never placed in localStorage,
  sessionStorage, or a repository file.

## Admin publishing setup

1. Sign in with the administrator account (`hsc-admin`). The password is shared
   with the administrator out of band; it is not stored in this repository.
2. Open **Cloud Settings** and confirm the repository is `Petgabs/HSC`.
3. When ready, paste a **fine-grained GitHub Personal Access Token** scoped to
   this repository and grant **Contents: Read and write** plus **Secrets: Read
   and write**. The site checks repository access, then encrypts and saves the
   token once as the private `SCHOOLCLOUD_PUBLISH_TOKEN` GitHub Actions secret.
   If that secret already exists, it is left unchanged. Direct uploads are
   enabled in the current tab after verification.
4. Use **Upload Resource**, select an HTML, PDF, Word, Excel or PowerPoint file
   (up to 50 MB), add the metadata, preview it and choose **Publish to GitHub &
   Website**. The file is committed into `apps/`; its metadata is merged into
   `library.json`.
5. GitHub Pages must be configured to publish this repository's `main` branch
   (root). Its next deployment updates `apps.json` and serves the download. A
   Pages build/deployment can take a little while after an upload.
6. To remove a resource, use any delete button in the admin dashboard and
   confirm. The site deletes the file from `apps/`, its metadata from
   `library.json` and its saved total from `stats/downloads.json`, then clears
   it from the current tab and the offline cache. Other devices stop listing
   it after the next GitHub Pages deployment. Deletion needs the same
   connected token as uploading (Contents: Read and write) and cannot be
   undone.
7. In **Settings → Actions → General**, allow GitHub Actions to have write
   permissions for repository contents. The counter-sync workflow uses the
   built-in `GITHUB_TOKEN`; it does not need the saved publisher secret. The
   saved token lives only in GitHub's private Actions secret store and can be
   used by explicitly configured repository workflows.

The client-side admin password check is only a convenience gate for the admin
controls: a static GitHub Pages site cannot provide server-side authentication.
The GitHub token is the actual write credential, and GitHub enforces its
permissions. Because this repository is public, the stored digest can be
downloaded and attacked offline, so the sign-in must not be treated as
protection for anything sensitive — pick a password that is not reused
elsewhere, and keep the GitHub token scoped to this repository only. Do not
upload private student or staff information to a public repository.

GitHub Actions secrets are write-only: GitHub never lets the static website
retrieve their values, and GitHub Pages does not receive the secret at runtime.
The saved secret is therefore a secure cloud copy for repository workflows; it
does not automatically reconnect a new browser tab. To publish from another
session, the administrator must paste a token again (the site will detect the
existing secret and will not overwrite it). To rotate it, revoke the old token,
delete `SCHOOLCLOUD_PUBLISH_TOKEN` in **Settings → Secrets and variables →
Actions**, then save the replacement from Cloud Settings.

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

New files start at zero downloads: Abacus creates each counter on its first
`hit` (first visit for the visitor total, first download for a file), so an
upload never sends a phantom increment. Deleting a file removes its entry from
`stats/downloads.json` alongside the repository file and its metadata; the
live Abacus counter itself cannot be deleted (counters created by anonymous
hits have no admin key) and Abacus expires idle counters automatically after 6
months.

The `Sync Abacus counters to GitHub` workflow reads the current visitor and
per-file Abacus totals every 15 minutes, and after changes to the published
library. It commits only when a total or file key changes. The workflow uses
GitHub Actions' short-lived `GITHUB_TOKEN` with Contents write permission; no
GitHub credential is shipped to or requested from visitors. If Abacus is
unreachable, each failed read keeps the previous GitHub value, and every update
merges max-wins so saved totals never move backwards. GitHub Pages serves the
updated record after its next deployment. The dashboard's **Save counts to
GitHub** button remains available for an immediate admin sync and uses the
in-memory token from **Cloud Settings** (Contents: Read and write). Apart from
explicit admin deletions, old entries for removed files are retained rather
than discarded automatically.

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
`assets/css/app.css` and the locally vendored runtime libraries are committed
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
