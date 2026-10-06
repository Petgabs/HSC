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
  than entering a teacher review queue. The legacy **Review Submissions**
  button and its page are gone with it.
- Adds an **Administrator account** section to **Cloud Settings** for changing
  the administrator username, the administrator password and the master
  password. It is locked until the master password is entered, and saving
  commits a fresh salt and SHA-256 digest into `assets/js/config.js` on GitHub
  so the change reaches every device after the next GitHub Pages deployment
  (and works on the device that made it immediately).
- Remembers the administrator's verified GitHub token on the device after the
  first save. Reloading the page, opening a new tab, closing the browser or
  signing out never asks for the token again; **Forget token on this device**
  removes it.
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
  website publishing, the verified token is saved once in this browser's
  storage on that device (`schoolcloud.github.token.v1` in `localStorage`) and
  restored automatically, so the administrator pastes it one time only — it
  survives reloads, new tabs and sign-out. **Forget token on this device**
  removes it again (as does **Clear local settings**). It is never written to a
  repository file, and GitHub never returns the encrypted Actions secret to the
  website.

## Admin publishing setup

1. Sign in with the administrator account (`hsc-admin`). The password is shared
   with the administrator out of band; it is not stored in this repository.
2. Open **Cloud Settings** and confirm the repository is `Petgabs/HSC`.
3. When ready, paste a **fine-grained GitHub Personal Access Token** scoped to
   this repository and grant **Contents: Read and write** plus **Secrets: Read
   and write**. The site checks repository access, then encrypts and saves the
   token once as the private `SCHOOLCLOUD_PUBLISH_TOKEN` GitHub Actions secret.
   If that secret already exists, it is left unchanged. Direct uploads are
   enabled after verification, and the token is remembered in this browser on
   this device so it never has to be pasted again here.
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

The client-side admin password check — and the master password that guards the
Administrator account section — are only convenience gates for the admin
controls: a static GitHub Pages site cannot provide server-side authentication.
The GitHub token is the actual write credential, and GitHub enforces its
permissions. Because this repository is public, the stored digest can be
downloaded and attacked offline, so the sign-in must not be treated as
protection for anything sensitive — pick a password that is not reused
elsewhere, and keep the GitHub token scoped to this repository only. Do not
upload private student or staff information to a public repository.

GitHub Actions secrets are write-only: GitHub never lets the static website
retrieve their values, and GitHub Pages does not receive the secret at runtime.
The saved secret is therefore a secure cloud copy for repository workflows.
It cannot reconnect the website by itself, so the verified token is instead
remembered in this browser's storage on the device where it was entered: after
the first save, the dashboard reconnects on its own across reloads, new tabs and
sign-out. A different browser or device must paste a token once (the site will
detect the existing secret and will not overwrite it). Because a remembered
token can publish to this repository from that browser profile, use
**Forget token on this device** on any shared or public computer, and revoke
the token on GitHub if the device is lost. To rotate the token, revoke the old
one, delete `SCHOOLCLOUD_PUBLISH_TOKEN` in **Settings → Secrets and variables →
Actions**, then save the replacement from Cloud Settings.

The remembered token is checked against GitHub the next time the administrator
signs in. A token GitHub rejects (HTTP 401) is forgotten and the dashboard asks
for a replacement; a failed check while offline or rate-limited keeps the saved
token in place for the next attempt.

Browser storage is per origin, and GitHub Pages project sites share one origin
(`https://<owner>.github.io`). Any other site published under the same owner
account can therefore read what this site stores in `localStorage`, and a
cross-site scripting bug on this page could too. Keep the remembered token
fine-grained and scoped to this repository's Contents and Secrets (the default
in the setup steps above), prefer a custom domain if other GitHub Pages sites
share the origin, and revoke the token immediately if you suspect exposure.
The website never asks for, or needs, any other GitHub credential.

### Administrator credentials

The administrator identity lives in `SITE_CONFIG.admin` in
`assets/js/config.js`. It contains three values and nothing secret:

- `username` — `hsc-admin`.
- `salt` — a random 32-character hex string.
- `passwordHash` — lowercase hex SHA-256 of `<salt>:<password>`.

The plain password is never committed. Sign-in compares the digest of the
entered password against `passwordHash`, so the current password is only known
to whoever was given it out of band.

A second gate, `SITE_CONFIG.master` in the same file, holds the master password
that unlocks the **Administrator account** section of Cloud Settings. It is
stored the same way — a `salt` and a `passwordHash`, never the plain password —
and its shipped default is shared with the administrator out of band.

### Changing the administrator account from Cloud Settings

1. Sign in as the administrator and open **Cloud Settings → Administrator
   account**. The section is locked and shows nothing but the master-password
   prompt.
2. Enter the master password and choose **Unlock account section**. This is not
   the administrator password: it only opens this section, so a change to the
   administrator sign-in needs both.
3. Set the new username and/or password. Leave a password blank to keep the
   current one. Passwords must be at least 8 characters and be typed twice.
   The master password can be rotated in the same save.
4. Choose **Save account changes**. A connected GitHub token (Contents: Read and
   write) is required, because the site rewrites `assets/js/config.js` in the
   repository: it generates a fresh random salt, hashes the new password with it
   in the browser, and commits only the username, the salt and the digest. The
   typed passwords are never written to a file, a commit or browser storage.
5. The new credential is active on that device immediately. Every other device
   picks it up when GitHub Pages finishes deploying `assets/js/config.js`
   (usually within a minute). Until then, the device that made the change keeps
   a copy in `localStorage` under `schoolcloud.admin.credentials.v1`; that copy
   is discarded automatically once the deployed config.js changes, and **Clear
   local settings** also removes it. It holds a digest, never a password.
6. **Lock this section** closes it again, and signing out locks it too.

Only the digest is stored anywhere, so a forgotten password cannot be recovered
from the website: rotate it again from this section while still signed in, or
edit `assets/js/config.js` in GitHub by hand (below).

### Rotating the credentials by hand

Generate a new salt and recompute the digest, then replace the values in
`assets/js/config.js`:

```sh
salt=$(openssl rand -hex 16)
password='<new password>'
printf 'salt: %s\npasswordHash: %s\n' "$salt" \
  "$(printf '%s' "$salt:$password" | sha256sum | cut -d' ' -f1)"
```

Publishing that change and reloading the site is enough — no database or server
deployment step is involved. Blank out the three fields to disable admin sign-in
completely; blanking `SITE_CONFIG.master` disables the account section instead.

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
connected token from **Cloud Settings** (Contents: Read and write). Apart from
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
