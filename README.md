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
- Protects the entire **Cloud Settings** page with the master password each
  time it is opened, including the header settings icon and dashboard links.
  Once unlocked, its **Administrator account** section can change the admin
  username, admin password and master password. Saving commits fresh salts and
  SHA-256 digests into `assets/js/config.js` on GitHub so rotations reach every
  device after deployment (and work immediately on the device that made them).
- Remembers the administrator's verified GitHub token on the device after the
  first save. Reloading the page, opening a new tab, closing the browser or
  signing out never asks for the token again; **Forget token on this device**
  removes it.
- **Stores that token in the website itself, not only in one browser.** Saving
  a token also encrypts it with the administrator and master passwords and
  commits the ciphertext to `assets/data/publish-token.json`, which GitHub
  Pages serves with the site. Signing in on another computer or laptop unlocks
  it automatically, so **Publish to GitHub & Website** works everywhere without
  pasting the token again. **Remove from this website** takes it back out.
- Shows a **live administrator-online indicator** in the header for everyone.
  While an administrator is signed in, that browser sends one anonymous
  heartbeat per minute into a time-bucket counter
  (`.../admin-online-<minute>`); the indicator lights up whenever the current
  or previous bucket has been hit, which means "an administrator was here
  within about two minutes". No name, account or device detail is ever sent,
  and the same-device tab/storage layers keep the indicator accurate and
  instant even when the counter service is blocked.
- Reports **cloud storage** and **administrator activity** on the dashboard.
  Every published file shows its size and how many days it has been stored in
  the cloud, and the storage cards total what is used, what is still available
  and how full the hosting allowance is (`storage.quotaBytes` in
  `assets/js/config.js`, 1 GB by default because that is GitHub Pages' published
  site limit). Sign-in statistics cover today, the last 7 days and the last 30
  days, with the latest sign-in, a 14-day chart, and a list of the latest
  uploaded files with their sizes. Sign-ins and uploads are recorded in
  `stats/admin-activity.json`, which travels with the website, so the numbers
  are the same on every computer; a device that cannot write to GitHub yet
  keeps its entries queued and shares them as soon as publishing reconnects.
  No name, device, network or location detail is recorded beyond the
  administrator username that is already public in `config.js`.
- Protects every administrator action against repeated clicks. Publish, delete,
  count-sync, settings save, token connect and verification each run at most
  once at a time, and each has its own sliding-window rate limit with a visible
  countdown on the button (**Please wait 12s**). A limiter that trips is
  remembered in `localStorage`, so a reload does not clear a lockout. Wrong
  administrator or master passwords get a growing delay per attempt and a
  5-attempts-per-10-minutes lockout, which slows guessing without ever blocking
  the correct password.
- Checks every upload before it is sent, then verifies it after it lands.
  **Safety:** the bytes must really be the type the extension claims (a renamed
  executable or a document that is actually HTML is refused), Office containers
  are listed so a file cannot smuggle an executable or macro payload, and HTML
  resources are scanned for code the site's security policy will not run
  (`javascript:` and `data:` scripts are blocked; remote scripts, external
  frames, embedded objects and storage access must be acknowledged). Empty
  files, oversized files and duplicates of an existing file name are refused
  with a suggested free name. **Accuracy:** the SHA-256 fingerprint and byte
  count are recorded in `library.json`, the published bytes are re-read from
  GitHub and compared with the file on the device (a mismatch rolls the upload
  back), and the metadata entry is confirmed. A dashboard **Verify** button
  re-checks any published file against its recorded fingerprint later.
- Avoids and survives upload failures instead of reporting them wrongly.
  Transient network failures and 5xx replies are retried with backoff, a write
  that times out is resolved by comparing the stored digest (so a landed upload
  is recognised, never doubled, and never reported as "already exists"), large
  files get a much longer request budget, and the upload dialog names every
  stage (reading, preparing, uploading, metadata, verifying), shows a progress
  bar and elapsed seconds, warns against closing the tab mid-upload, and keeps
  the file selected so a retry needs no re-entering.
- Uploads supported files to `apps/` and updates `library.json` with their
  metadata through GitHub's Contents API. New files are not silently allowed to
  overwrite an existing file with the same name.
- Gives every file row in the admin dashboard (mini-app table, documents
  table, most-used list, review-due list, upload-age groups and cleanup
  candidates) its own delete button. The Documents & Resources table can be
  filtered by subject, so administrators can narrow the list before choosing
  one specific file to delete. One confirmation removes the file from `apps/`,
  its metadata from `library.json` and its saved total from
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
- Never puts a readable publishing token in a source file or in public
  repository content. In **Cloud Settings**, the administrator saves it once as
  the private `SCHOOLCLOUD_PUBLISH_TOKEN` GitHub Actions repository secret. The
  browser encrypts it with GitHub's repository public key before sending it to
  GitHub; if the secret already exists, the site will not overwrite it. For
  direct website publishing the verified token is kept in three places, none of
  them in the clear: this browser's storage on that device
  (`schoolcloud.github.token.v1` in `localStorage`), GitHub's write-only Actions
  secret store, and — encrypted with the administrator and master passwords —
  `assets/data/publish-token.json` in the repository, which is what makes the
  token available on every other computer. **Forget token on this device**,
  **Remove from this website** and **Clear local settings** each undo one of
  those copies.

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
   this device so it never has to be pasted again here. Leave **Store this
   token in the website as well** ticked (the default) and the same save also
   commits an encrypted copy to `assets/data/publish-token.json`, so the next
   computer the administrator signs in on is ready to publish immediately. The
   **Website token storage** panel shows the current state and can save or
   remove that copy at any time.
4. Use **Upload Resource**, select an HTML, PDF, Word, Excel or PowerPoint file
   (up to 50 MB), add the metadata, preview it and choose **Publish to GitHub &
   Website**. The file is inspected first — real file type, embedded programs or
   macros, unsafe HTML, size and duplicate names — and the findings appear as a
   checklist on the upload page. Anything with a warning must be acknowledged
   before the publish button unlocks, and anything unsafe is refused before a
   single byte reaches GitHub. The file is then committed into `apps/`, its
   metadata (including the SHA-256 fingerprint and byte count) is merged into
   `library.json`, and the published copy is re-read from GitHub to confirm the
   bytes match the file on the device. A mismatch rolls the upload back.
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

The client-side admin password check and the master password that guards all
of Cloud Settings are only convenience gates for the admin controls: a static
GitHub Pages site cannot provide server-side authentication.
The GitHub token is the actual write credential, and GitHub enforces its
permissions. Because this repository is public, the stored digest can be
downloaded and attacked offline, so the sign-in must not be treated as
protection for anything sensitive — pick a password that is not reused
elsewhere, and keep the GitHub token scoped to this repository only. Do not
upload private student or staff information to a public repository.

GitHub Actions secrets are write-only: GitHub never lets the static website
retrieve their values, and GitHub Pages does not receive the secret at runtime.
The saved secret is therefore a secure cloud copy for repository workflows.
It cannot reconnect the website by itself, so the verified token is also
remembered in this browser's storage on the device where it was entered, and
stored in the website as described below. Because a remembered token can
publish to this repository from that browser profile, use **Forget token on
this device** on any shared or public computer, and revoke the token on GitHub
if the device is lost. To rotate the token, revoke the old one, delete
`SCHOOLCLOUD_PUBLISH_TOKEN` in **Settings → Secrets and variables → Actions**,
then save the replacement from Cloud Settings — that also re-locks the website
copy with the new token.

### The token stored in the website

A browser copy only helps the browser that made it, and GitHub's secret store
cannot be read back, so a second computer used to ask for the token again. The
site therefore keeps the token *in the website*:

1. On save, the browser generates a random 256-bit data key and encrypts the
   token with it (AES-256-GCM).
2. The data key is wrapped twice — once with a key derived from the
   administrator sign-in password and once from the master password, each via
   PBKDF2-HMAC-SHA-256 with 310,000 iterations and its own random salt.
3. Only the ciphertext, salts and IVs are committed to
   `assets/data/publish-token.json` (`assets/js/lib/tokenVault.js` does the
   cryptography; nothing readable is ever written).

Signing in downloads that file and unwraps it with the password just typed, so
publishing reconnects with no extra step. Opening Cloud Settings does the same
with the master password, which is the fallback when a device signed in before
the token was stored. The site reads the deployed website copy first and the
repository copy second, so a save made a minute ago still works while GitHub
Pages is rebuilding.

Rotating the administrator or master password in Cloud Settings re-locks the
stored copy automatically with the new password; the notice after saving says
so. If a rotation happens on a device that cannot reach GitHub, the stored copy
stays locked with the previous password — the token section then says so and
asks for one more save.

**What this means for security.** The file is public, and it is only as strong
as the two passwords that open it (which, as above, also ship as salted
digests). Use long, unique administrator and master passwords, keep the token
fine-grained and limited to this repository's Contents and Secrets, and press
**Remove from this website** plus revoke the token on GitHub if a password is
ever exposed. Removing the stored copy blanks the file but cannot erase it from
the Git history, so revoking the token is the reliable remedy.

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
required to open the entire **Cloud Settings** page. It is stored the same way
— a `salt` and a `passwordHash`, never the plain password — and its shipped
default is shared with the administrator out of band.

### Changing the administrator account from Cloud Settings

1. Sign in as the administrator and open **Cloud Settings**. The page shows
   only the master-password prompt until it is unlocked.
2. Enter the master password and choose **Unlock Cloud Settings**. This is not
   the administrator sign-in password. The settings page is locked again when
   you leave it, sign out, or open it again from the settings icon.
3. In **Administrator account**, set the new username and/or password. Leave a
   password blank to keep the current one. Passwords must be at least 8
   characters and be typed twice. The master password can be rotated in the
   same save.
4. Choose **Save account changes**. A connected GitHub token (Contents: Read
   and write) is required, because the site rewrites `assets/js/config.js` in
   the repository: it generates a fresh random salt, hashes the new password
   with it in the browser, and commits only the username, the salt and the
   digest. The typed passwords are never written to a file, a commit or browser
   storage.
5. The new credential is active on that device immediately. Every other device
   picks it up when GitHub Pages finishes deploying `assets/js/config.js`
   (usually within a minute). Until then, the device that made the change keeps
   a copy in `localStorage` under `schoolcloud.admin.credentials.v1`; that copy
   is discarded automatically once the deployed config.js changes, and **Clear
   local settings** also removes it. It holds a digest, never a password.
6. If the publishing token is stored in the website, the same save re-encrypts
   it with the new password so other computers keep working. The notice
   confirms it; if it could not be re-locked, save the token again from the
   **GitHub upload access** section.
7. Choose **Lock Cloud Settings**, leave the page, or sign out to close it again.

Only the digest is stored anywhere, so a forgotten password cannot be recovered
from the website: rotate it again from Cloud Settings while still signed in, or
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

## Administrator presence and the counter namespace

The header's **Admin online** pill shares the same Abacus namespace as the
counters, but never the same kind of key: presence uses a *time bucket*
(`admin-online-<floor(epochMinutes)>`). An administrator's browser sends one
`hit` per minute and also records the time in `localStorage`, which other tabs
on that device pick up through a `BroadcastChannel`. A visitor reads the
current bucket, falls back to the previous one, and shows **Admin online** when
either has been hit; otherwise the pill reads **No admin online**, or **Admin
status unknown** when the counter service cannot be reached. Presence costs at
most a few tiny requests per minute, never exposes who is signed in, and a
blocked counter service degrades to "unknown" instead of a false negative.

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

## Dashboard storage, sign-in statistics and the activity record

The administrator dashboard answers four questions that a static GitHub Pages
site has no server to compute:

1. **How big is each uploaded file?** The byte count recorded in `library.json`
   when a file was published is authoritative (the Jekyll-generated `apps.json`
   carries no size). A file published before byte counts were recorded is
   measured from GitHub's directory listing by **Refresh file details**, which
   runs automatically when a size or upload date is missing. A size that no
   layer can confirm is shown as *Size unknown*, never as zero.
2. **How much cloud storage is used, and how much is left?** The storage cards
   add up every published file and compare the total with
   `SITE_CONFIG.storage.quotaBytes` (1 GB by default — GitHub Pages' published
   site limit; set it to `0` to hide the remaining figure). The bar turns amber
   at 70% and red at 90% or over the allowance.
3. **How many days has each file been stored?** `addedAt` in `library.json`
   gives the upload date; a file without one has its first commit read from
   GitHub's commit history, and the result is cached in the browser
   (`schoolcloud.cloud.file-dates.v1`) so the API is asked once per file.
4. **How many administrator sign-ins in a day, a week and a month, and what was
   uploaded last?** Every successful sign-in and every publish appends one
   entry to `stats/admin-activity.json` through the connected token. The file is
   public, capped at 400 entries per list, merged by timestamp, and contains
   only timestamps plus the public administrator username and the upload's
   metadata — no device, network or personal detail. A device whose token is
   locked (or not yet connected) keeps its entries in
   `schoolcloud.admin.activity.pending.v1`, shows them immediately, and pushes
   them to the shared record as soon as publishing reconnects, so a sign-in is
   never lost. `stats/admin-activity.json` ships with the upload history of the
   files currently in `apps/`, and the dashboard falls back to the library's own
   upload dates if the record is ever empty.

"Today" means the local calendar day on the administrator's own computer. The
activity record is deliberately not used for security decisions: it is
audit-style information for the administrator, and signing in is still checked
by the salted digest in `assets/js/config.js`.

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
- `stats/admin-activity.json` — durable record of administrator sign-ins and
  published uploads behind the dashboard's sign-in statistics and latest-upload
  list. Timestamps, the public administrator username and upload metadata only;
  written through the connected token and served with the website.
- `.github/workflows/sync-abacus-stats.yml` — scheduled Abacus-to-GitHub
  snapshot workflow (with a manual workflow-dispatch option).
- `index.html` — the student library, admin dashboard, upload form, settings
  and preview UI.
- `assets/js/` — application, Abacus counters, GitHub publishing, token-vault,
  administrator activity (`lib/adminActivity.js`) and metadata code. No readable
  publishing token is stored here.
- `assets/data/publish-token.json` — the publishing token encrypted with the
  administrator and master passwords, so any computer the administrator signs
  in on can publish. Ciphertext only; empty until the first token is saved.
- `sw.js` — offline shell/data/download caching. Abacus and GitHub API traffic
  is always network-only.

Supported extensions: `.html`, `.htm`, `.pdf`, `.doc`, `.docx`, `.xls`,
`.xlsx`, `.ppt`, `.pptx`.
