# School Cloud System

**powered by Petgabs**

Public library of classroom mini apps and resources, published with GitHub Pages.

Students browse, preview and download files. Teachers sign in with the shared
staff account and upload resources through a guided workflow; an administrator
reviews each submission. There is no server to run and no secret to manage.

## Reliability, scale and safe publishing

Version 1.7 makes the dashboard's **Library data safety** panel actionable.
Every error or warning message now has a **delete** button that removes just
that message from the list, and one **Hide all error messages** switch collapses
the whole section (the Errors and Warnings tiles keep counting, and **Restore
hidden** brings everything back — dismissing is a per-device view preference,
never a change to the library). A **Troubleshoot** button diagnoses minor
problems instead of only reporting them: it names the likely cause of each
finding — including connection-level causes such as being offline, a cached
library or a failed `library.json` load — and then repairs the ones that are
safe to repair automatically: removing orphaned `library.json` entries, adding a
starter curated entry for a file published outside the workflow, deleting
leftover staged uploads, and correcting review-queue records that claim a file
is published when it is not. Repairs run queue-first, are listed for
confirmation before anything is committed, write an on-screen repair log, and
never delete a published file that students can open. Repairs that touch the
repository need GitHub Auto-Publish connected in Settings; the troubleshooter
says so instead of failing, and it refuses to repair at all while the device is
offline or the live file list failed to load.

Version 1.6 adds safety checks on top of the busy-session resilience layer.
The Admin Dashboard now compares the live `apps/` files, `library.json` and
`submissions/queue.json` on every load, then flags stale metadata, published
queue records whose files are missing, pending submissions with no staged file,
and live files that still need curated metadata. The upload form also makes the
public-resource rule explicit: visibility is an intended-audience label in this
static site, not private access control.

Version 1.5 added a resilience layer for busy school sessions. GitHub Pages
serves the public shell and files from its CDN, while the browser protects the
experience when a backend is slow or temporarily unavailable:

* The service worker uses stale-while-revalidate for the shell, network-first
  data loading with a cache-busting-safe key, and a bounded cache for published
  downloads. It times out stalled requests and coalesces duplicate requests for
  the same file, so repeated downloads do not multiply bandwidth or memory.
* Counter reads use the managed Supabase batch endpoint when configured, fall
  back in small concurrent batches, and use a short circuit breaker plus a
  local mirror when a provider is down. A counter outage never blocks the
  library or a download.
* GitHub upload and queue operations have bounded timeouts, exponential
  backoff for transient failures and optimistic-concurrency retries for
  `queue.json` and `library.json`. Two teachers can submit at once without one
  overwriting the other's queue entry or metadata.
* The browser applies a content-security policy, sandboxed previews,
  path-traversal checks, no-cache handling for tokens/review data, and secure
  response headers on hosts that support `_headers`. Publishing tokens remain
  session-only or encrypted at rest; they are never committed as plaintext.

A static site cannot provide server-side authentication or hide a token from a
person who is already authorised to use the browser. For stronger staff
identity, use an identity-aware upload service in front of GitHub rather than
sharing the teacher password. The safeguards here prevent accidental exposure
and transient failures; they do not turn client-side login into server-side
access control. A concrete server-side upgrade path lives in
[`docs/PRODUCTION_SECURITY_BLUEPRINT.md`](docs/PRODUCTION_SECURITY_BLUEPRINT.md).

### Automatic validation, merge and deployment

Every pull request and branch update runs `.github/workflows/quality.yml`
(syntax checks, the full test suite, a production asset build and a production
dependency audit). The `pages.yml` workflow builds and deploys the site after a
commit reaches `main`; its concurrency policy cancels obsolete deployments so
an older build cannot overwrite a newer one.

After a maintainer reviews an internal pull request, adding the `automerge`
label enables GitHub auto-merge. GitHub waits for the quality check, squashes
the change into `main`, and the Pages workflow publishes it. Fork pull
requests are deliberately excluded from this write-capable automation.

---

## Phase 2 — teacher upload workflow

Teachers publish resources themselves, through the browser, without touching
GitHub:

| Step | What happens |
| --- | --- |
| 1. Sign in | Separate **Teacher Login** button (shared staff account, kept in `assets/js/config.js` as a salted SHA-256 digest). Teachers can upload but never delete. |
| 2. Upload resource | Any supported classroom file — PDF, Word, Excel, PowerPoint or HTML, up to 50 MB. |
| 3. Classify it | **Subject** and **Year Level** are two required dropdowns with a fixed vocabulary (below) — nothing reaches the library unclassified. |
| 4. Add the remaining metadata | Title, description, topic, resource type, language, owner, department, academic year, keywords, visibility, version, review date, licence, accessibility notes. Subject/year suggestions are offered automatically. |
| 5. Automatic preview | A live card preview (exactly how the resource will appear) plus a sandboxed file preview for PDFs and HTML. |
| 6. Submit for publication | The file is uploaded to the school cloud at once — into `submissions/pending/`, **not** the library — and joins the shared review queue with status *pending*. |
| 7. Administrator approves | One click in **Review Submissions**, from any device. Approving moves the file into `apps/`; declines record a reason for the teacher and delete the staged copy. |
| 8. Publish everywhere | **Automatic with GitHub Auto-Publish** (Settings): approval commits the file to `apps/` and merges the curated metadata into `library.json` via the GitHub Contents API, and the submission is marked published with a link to the commit. Without a connected token, the manual flow remains: copy the generated `library.json` metadata and upload the file on GitHub. |

### Classification vocabulary

The **Classify it** step is deliberately just two dropdowns, because a free-text
subject box produces “Maths”, “mathematics” and “MATHS” as three different
facets:

| Field | Options |
| --- | --- |
| **Subject** | Mathematics · EALD/English · CAL · BS · VA · PHY · MEX · Others |
| **Year Level** | Year 9 · Year 10 · Year 11 · Year 12 |

Both are required. They live in `SUBJECT_OPTIONS` and `YEAR_LEVEL_OPTIONS` in
[`assets/js/lib/submissions.js`](assets/js/lib/submissions.js) — add a line
there to add an option site-wide. The suggestion chip beside each dropdown only
ever proposes a value the dropdown actually contains; when the inferred subject
has no equivalent in the school's list, no suggestion is offered at all.

Topic moved to *Describe the resource*; resource type and language moved to
*Publication details*. No metadata field was lost.

**The file name is never the primary title.** `16G.pdf` tells a student far
less than “Continuous Probability Distributions — Exercise 16G Solutions”, so
the title is always curated — by the teacher or in `library.json` — and the
file name is kept as secondary, searchable text.

### Roles

| | Teacher (`Teacher Login`) | Administrator (`Admin`) |
| --- | --- | --- |
| Upload resources with metadata | ✔ | ✔ |
| Preview own submissions and their status | ✔ | ✔ |
| Delete files or submissions | ✖ | ✔ |
| Approve / decline submissions | ✖ | ✔ |
| Dashboard, settings, repository sync | ✖ | ✔ |
| Save / change / delete the shared publishing token | ✖ | ✔ |

Both accounts are gated client-side (salted SHA-256 digests, no plaintext
password in the repository). The teacher role has no destructive action at
all — deletion is always an administrator action.

### Deleting files (library cards, dashboard tables, submissions)

Every file the administrator can see — browser-only drafts, approved teacher
submissions, and anything already published to the public repository — has a
**Delete** control right next to it: on each library card, in both tables on
the **Admin Dashboard** (Downloads by Mini App / Documents & Resources), and
next to each reviewed submission.

* **Browser-only files** are removed immediately from this device.
* **Files already in the GitHub repository** are deleted for real with one
  click, in-app, via the Contents API (`assets/js/lib/githubPublish.js`):
  the file is removed from `apps/` and its entry is dropped from
  `library.json`, as up to two commits — using the same GitHub Auto-Publish
  token connected in Settings. No trip to github.com is needed. Without a
  connected token, the button falls back to opening the manual delete page
  on github.com instead.

### Refreshing the site (app name + dashboard)

Clicking the **School Cloud System** name in the header — or the **Refresh
Site** button at the top of the Admin Dashboard — reloads the whole website.
Because the service worker serves the app shell from cache
(stale-while-revalidate, see [Offline behaviour](#offline-behaviour)), a plain
reload can still show the previous deploy for one more load. The refresh
therefore asks the service worker to update first: if a newer version has been
deployed, it is told to skip waiting, takes over at once and the page reloads
itself with the fresh shell. With no update available (or no service worker)
it is simply a normal reload — the library data is always fetched
network-first anyway. A stalled install can never swallow the click: if the
new worker has not taken over within a few seconds, the page reloads
regardless.

*(Refresh Stats, next to it in the dashboard, stays a lighter action: it only
re-reads the download counters without reloading the page.)*

### Resource Statistics (Admin Dashboard)

The **Admin Dashboard** has a **Resource Statistics** section, built entirely
from data the site already has — every file currently published in
`apps/`, enriched with the matching record from the cross-device review queue
(`submissions/queue.json`, see [below](#the-review-queue-cross-device)) when
one exists. Nothing new is stored anywhere; it is a live read of the library,
the queue and the download counters (`assets/js/lib/resourceStats.js`).

| What it shows | Where it comes from |
| --- | --- |
| **Teacher Activity** — resources uploaded, year/subject spread, total storage, last upload per teacher | `owner` on the matching submission (falls back to the curated `owner` in `library.json`) |
| **Resources by Year Level** — Year 9 / 10 / 11 / 12 counts | the `years` classification on each published resource |
| **Resources by Subject** — count and storage per subject | the `subject` classification on each published resource |
| **Cloud Storage Used** — total bytes occupied in the GitHub cloud, and how many files that total covers | file size recorded at upload time (submissions always know it; a file published by hand with no submission record is counted as "unknown size" rather than guessed) |
| **How Long Resources Have Been in the Cloud** — grouped into *this week*, *1–2 weeks ago*, *about a month ago* and *over a month ago* | each submission's `submittedAt` timestamp |
| **Resources to Review for Deletion** — old files with few or no downloads, oldest first, with a one-click delete | the same storage data crossed with the existing download counters (Settings → thresholds are adjustable: minimum age and maximum downloads) |

**"Last upload" stands in for "last login".** This site has no server-side
session log — teachers share one login (see [Roles](#roles)) — so the closest
honest signal to "when a teacher was last active" is the most recent
timestamp on anything they uploaded. The dashboard labels it as such rather
than claiming to know a real sign-in time.

A resource published directly on github.com (not through the upload
workflow) has no submission record, so its upload date and exact size are
unknown; it still counts in the per-teacher/year/subject totals (using the
owner/subject/years curated in `library.json`) but is excluded from the age
buckets and the cleanup list, since "unknown" is not evidence of staleness.

### Auto-publish on approval (one click, straight to GitHub)

With a GitHub Auto-Publish token connected (Settings → GitHub Auto-Publish),
**Approve & Publish** is a single click: the teacher's submission is approved
*and* committed straight to the public repository (`apps/` + `library.json`)
in the same action — it is marked `published` and the temporary local/browser
copy is dropped, so the repository stays the one canonical copy. Every other
device picks it up once GitHub Pages redeploys (usually 1–2 minutes).
Without a connected token, approval still publishes to the library
immediately on that device, with the manual copy/paste flow offered as the
fallback to reach every device.

### One shared publishing token, saved in the repository

Pasting a token into every tab, on every device, every day does not scale. So
the administrator can save **one** fine-grained token into the repository
itself and let the teacher login unlock it everywhere.

**Settings → GitHub Auto-Publish → Token saved in GitHub Cloud**

| Button | What it commits |
| --- | --- |
| **Save Token to GitHub Cloud** | Verifies the token against the repository, encrypts it with the current teacher password, and commits `assets/data/cloud-token.json`. |
| **Change to a new token** | Same thing over the top of the old file — one commit, the previous token is gone from the repository. |
| **Delete from GitHub Cloud** | Deletes the file in one commit and disconnects this session immediately. |
| **Unlock** | Decrypts the saved token on a device that has it locked (administrators enter the teacher password). |

Everything is a real commit through the Contents API, so the repository, the
GitHub Pages site and every other browser converge on the same answer as soon
as the deploy lands (usually 1–2 minutes). The service worker never caches
that file, so a deletion is never served from a stale cache.

#### Why the committed file is safe to publish

**A raw Personal Access Token must never be committed to a public
repository.** GitHub's secret scanning revokes a plaintext PAT within seconds
of it appearing in a public repo, and until it does, anyone who can read the
repository can write to it.

So the file that is committed never contains the token. It contains
AES-256-GCM ciphertext whose key is derived from the shared teacher password:

```
teacher password ──PBKDF2-SHA256, 310 000 rounds, 16-byte salt──▶ AES-256 key
                                                                      │
       assets/data/cloud-token.json  ──(12-byte IV, AES-GCM)──────────┴──▶ token
```

```jsonc
{
  "version": 1,
  "cipher": "AES-GCM-256",
  "kdf": "PBKDF2-SHA256",
  "iterations": 310000,
  "salt": "…", "iv": "…", "ciphertext": "…",
  "fingerprint": "9f2c41ab77e0",   // first 12 hex of SHA-256(token), one-way
  "savedAt": "2026-10-01T08:30:00.000Z"
}
```

The file holds no `github_pat_` prefix for a scanner to match and no fragment
of the token — the `fingerprint` is a one-way hash, shown in Settings purely so
an administrator can confirm *which* token is live without the site ever
displaying it. The decryption helpers refuse a tampered ciphertext, an unknown
cipher, a future file version, and a file whose `iterations` have been lowered
to make it brute-forceable (`assets/js/lib/tokenVault.js`).

#### What this does and does not protect

* **It does** mean the published file is useless on its own, that GitHub will
  not revoke the token, and that access is gated by the same teacher login
  that already gates uploads.
* **It does not** make the token secret from people who know the teacher
  password. Anyone who can sign in as a teacher holds, in that browser
  session, a token that can write to the repository. Treat the teacher
  password as what it now is: the key to the repository. Use a strong one,
  rotate it when staff leave, and keep the token scoped to **this repository
  only** with the single permission **Contents: Read and write** — nothing
  else is needed, and nothing else should be granted.
* Prefer the per-tab **“Use in this tab only”** button instead if you would
  rather no token were ever stored anywhere.

#### Rotating and revoking

Changing the teacher password in **Settings → Teacher Access** automatically
re-encrypts the saved token with the new password, in the same action, so
teachers keep publishing without interruption. If the token is not unlocked in
that session the site says so loudly, and the vault must be saved again.

Deleting the file stops any device from unlocking the token — it does **not**
revoke the token. Revoke it on
[github.com](https://github.com/settings/personal-access-tokens) as well; the
Settings panel links straight there.

#### Where teacher uploads go

A teacher's upload is sent **straight to GitHub** — into a staging folder, not
into the library — so an administrator sees it from any device. See
[The review queue](#the-review-queue-cross-device) below.

Setting `PUBLISH_TEACHER_UPLOADS_IMMEDIATELY = true` in `assets/js/config.js`
skips review entirely: a submission then commits to `apps/` + `library.json`
the moment it is made. It is `false` by default, and the default is the
recommended setting — approval is what keeps the public library curated.

### The review queue (cross-device)

Before this, a submission lived only in the browser that made it: an
administrator could approve what *they* had uploaded and nothing else. A
teacher uploading on a classroom laptop was invisible to the administrator at
home.

Now every upload goes to the repository the moment it is submitted:

```
submissions/
  queue.json              metadata + review status of every submission
  pending/<id>__<file>    the uploaded bytes, waiting for a decision
```

**This is not the library.** `apps.json` is generated from `apps/` alone, so a
staged upload is never listed on the dashboard, never searchable, never
counted and never linked. Approval is the only thing that moves a file into
`apps/`.

| Action | Repository effect |
| --- | --- |
| Teacher submits | file → `submissions/pending/`, entry → `queue.json` as `pending` |
| Administrator approves | file → `apps/`, metadata → `library.json`, staged copy deleted, entry marked `approved` + `published` |
| Administrator declines | staged copy deleted, entry kept as `rejected` with the reason, so the teacher can see why |
| Administrator deletes | staged copy and entry both removed |

Both halves need the shared token to be unlocked, which is the whole reason it
is stored in the repository: a teacher signing in unlocks it automatically, so
their upload can reach GitHub without anyone pasting a token.

* **Review Submissions** merges the repository's queue with anything stored in
  this browser and labels each record *In GitHub Cloud* or *This device*. The
  banner at the top says which mode you are in, and **Refresh queue** re-reads
  `submissions/queue.json`.
* The repository wins on workflow state (status, who reviewed it, whether it
  is published); the browser wins on where the file bytes are, so a teacher
  who uploaded on this device keeps a local preview. An administrator
  reviewing someone else's upload streams the bytes back from the repository
  for the preview and download buttons.
* Writes to `queue.json` are read-modify-write with a retry on conflict
  (`commitJsonWithRetry`), so two teachers submitting at the same moment
  cannot overwrite each other.
* With no token unlocked (or no connection), submitting still works — the
  resource is kept in that browser and reviewable there, exactly as before —
  and the teacher is told so.
* `submissions/` is never cached by the service worker: a stale queue would
  resurrect submissions that another device had already dealt with.

> ⚠️ **The repository is public.** A file in `submissions/pending/` is
> fetchable by anyone who knows its URL before it has been approved. Approval
> controls whether a resource is *listed in the library*, not whether its
> bytes are secret. Do not upload anything confidential — the same caveat as
> [Visibility](#visibility) below.

### Changing the teacher login

The administrator rotates the shared teacher username and password in
**Settings → Teacher Access** (admins only; teachers never see that screen):

1. Enter a new username and password (confirmed twice, minimum 8 characters,
   validated by `assets/js/lib/credentials.js`). Only a salted SHA-256 digest
   is ever stored — never the plaintext password.
2. **Update on this device** applies the change immediately in that browser:
   the old login stops working there, the new one works straight away.
3. To roll it out to **every** teacher, use **Copy config lines for GitHub**
   (or the *Edit assets/js/config.js on GitHub* link), replace the
   `TEACHER_USERNAME` / `TEACHER_PASSWORD_SHA256` lines, and commit. After the
   next deploy the new login works everywhere; the device override keeps
   matching, so nothing breaks.

Until step 3, other devices continue to use the credentials published in
`config.js`. **Restore repository default on this device** reverts the local
override at any time.

### Where the data lives (static-site limits)

This is a GitHub Pages site, so there is no server-side account or database:

* Submission **files** are stored as Blobs in the browser's IndexedDB
  (`assets/js/lib/fileStore.js`), with a base64-in-localStorage fallback for
  locked-down browsers. Metadata lives in localStorage — *and*, when a token
  is unlocked, a copy is staged in the repository so other devices can review
  it (see [The review queue](#the-review-queue-cross-device)).
* Approved submissions are searchable **immediately on that device** and
  survive reloads.
* To reach *every* device, the administrator publishes through GitHub — after
  which the repository copy becomes canonical. Two ways:
  * **GitHub Auto-Publish** (Settings → GitHub Auto-Publish): connect a
    fine-grained Personal Access Token scoped to this repository with the
    single permission **Contents: Read and write**. Approving a submission
    then commits the file to `apps/` and merges its metadata into
    `library.json` automatically (`assets/js/lib/githubPublish.js`). The
    token lives in `sessionStorage` only — never in the site, never in
    localStorage — and is forgotten when the tab closes or the
    administrator signs out. **Save Token to GitHub Cloud** additionally
    stores it in the repository as encrypted bytes so every device shares
    one token; see
    [One shared publishing token](#one-shared-publishing-token-saved-in-the-repository).
  * **Manual fallback**: the “Copy metadata” / “Upload to GitHub” /
    “Done — published” buttons, exactly as before.

### Visibility

`public`, `school-only` and `class-only` are recorded as metadata, badged on
the card and searchable. On a public static site they describe the intended
audience rather than enforcing access control; if a resource must stay
private, do not publish it to the repository.

---

## Phase 1 — strengthened public library

| Area | What changed |
| --- | --- |
| Search & metadata | Full-text search, subject / year / type facets, sortable results, shareable filter URLs |
| Previews | In-browser preview for PDFs, mini apps and Office documents; richer resource cards |
| Dependencies | Alpine, Lucide and Tailwind are bundled locally — no CDN at runtime |
| States | Skeleton loaders, explicit error + retry, offline banner, service-worker caching |
| Quality | Automated tests including axe-core accessibility checks (291 in total) |
| Counters | Pluggable backend with a managed Postgres (Supabase) adapter |

---

## Local development

```bash
npm install          # install build + test tooling
npm run build        # vendor dependencies and compile CSS
npm test             # unit, integration and accessibility tests
npm run lint:js      # node --check on every first-party script
npm run dev          # serve the site on http://localhost:8080 (no caching)
```

`npm run watch:css` rebuilds the stylesheet while you edit.

Prefer `npm run dev` over `npx serve .` while working: the dev server sends
`Cache-Control: no-store` on every response, so a refresh always shows your
current files. Generic static servers omit cache headers, and browsers then
heuristic-cache the scripts — which looks exactly like "my changes did not
deploy".

### Committed build output

`assets/css/app.css` and `assets/vendor/*.js` are **committed on purpose**.
GitHub Pages serves this repository directly and does not run a build step, so
the compiled artefacts must be in the tree.

Re-run `npm run build` and commit the result whenever you change markup,
Tailwind config, or a pinned dependency version. Pinned versions are recorded
in `assets/vendor/versions.json`.

---

## Adding files to the library

Drop the file into `apps/`. Supported types: `.html`, `.pdf`, `.doc(x)`,
`.xls(x)`, `.ppt(x)`.

Jekyll regenerates `apps.json` on every deployment and the site reads that
manifest, so nothing else is required.

### Curating metadata

Subject, year group and tags are **inferred from the file name** — for example
`Year 10 & 11  class schedule.pdf` becomes *Administration, Years 10 & 11*.

To override the guess, add an entry to `library.json`:

```json
{
  "apps/Year 9 algebra.pdf": {
    "title": "Year 9 Algebra — Practice Worksheet",
    "subject": "Mathematics",
    "years": [9],
    "tags": ["revision", "worksheet"],
    "description": "Practice questions covering linear equations."
  }
}
```

Keys are the repository path or the bare file name. Every field is optional;
anything omitted falls back to inference. A curated `description` always wins
over the placeholder generated during sync.

The full curated vocabulary (any of which can also be produced automatically
by the teacher workflow's “Copy metadata” button): `title`, `description`,
`subject`, `years`, `tags`/`keywords`, `topic`, `resourceType`, `language`,
`owner`, `department`, `academicYear`, `visibility` (`public` | `school` |
`class`), `version`, `reviewDate`, `licence`, `accessibility`.

---

## Counters: moving to the managed database

Counts previously lived in a free, anonymous third-party counter with no
owner, no backups and no recovery path. Phase 1 adds a Supabase adapter and
keeps the old service only as a transitional fallback.

The client tries each backend in order and never lets a failure break the page:

```
supabase  ->  managed Postgres, the source of truth
abacus    ->  legacy shared counter (transitional)
local     ->  per-browser mirror in localStorage
```

### Switching over

1. Create a Supabase project (the free tier is sufficient).
2. Run [`db/schema.sql`](db/schema.sql) in the SQL editor. It creates the
   `counters` table, the atomic `increment_counter()` function, and the
   row-level-security policies.
3. Put the project URL and the **anon / publishable** key into
   `assets/js/config.js`:

   ```js
   export const COUNTER_CONFIG = {
     supabase: {
       url: 'https://YOUR-PROJECT.supabase.co',
       anonKey: 'eyJ...',
       timeoutMs: 6000
     },
     ...
   };
   ```

4. Commit and push. The dashboard reports which backend served the numbers.

Leaving `url` empty keeps the legacy behaviour, so the switch is reversible.

**On exposing the anon key:** it ships to the browser by design and is safe to
publish. Row-level security grants it `SELECT` on `counters` and `EXECUTE` on
`increment_counter()` and nothing else — it cannot set arbitrary values,
delete rows, or create keys outside `^[a-z0-9][a-z0-9-]*$`. Never put the
`service_role` key in this repository.

---

## Offline behaviour

`sw.js` caches with a strategy per resource class:

- **App shell** — stale-while-revalidate, so the site opens instantly.
- **`apps.json` / `library.json`** — network-first, cache fallback.
- **Files in `apps/`** — cache-first once fetched, so a file opened at school
  is still available at home.
- **Counter and GitHub API traffic** — never cached.

`offline.html` is shown when a navigation fails with nothing cached.

---

## Testing

```bash
npm test
```

| Suite | Covers |
| --- | --- |
| `tests/metadata.test.js` | Subject/year inference, curated overrides |
| `tests/submissions.test.js` | Draft validation, the subject/year vocabulary, publishing shapes |
| `tests/tokenVault.test.js` | Token encryption: no plaintext published, wrong/tampered input refused |
| `tests/reviewQueue.test.js` | Staging paths, `queue.json` transforms, the local ↔ repository merge rule |
| `tests/githubPublish.test.js` | The Contents API client, conflict retries and the publish pipeline |
| `tests/search.test.js` | Query parsing, ranking, facets, sorting |
| `tests/counters.test.js` | All three backends and the fallback chain |
| `tests/format.test.js` | Display formatting |
| `tests/preview.test.js` | Preview strategy and iframe sandboxing |
| `tests/accessibility.test.js` | axe-core over the expanded markup |
| `tests/integration.test.js` | Real Alpine + real `index.html` in jsdom: the shared token's save → unlock → replace → delete cycle, and a two-device run of the review queue (teacher submits here, administrator approves from a browser that never saw the file) |

The accessibility suite expands `<template x-for>` blocks and resolves Alpine
bindings before running axe, so it checks the DOM users actually get rather
than the un-hydrated template. A guard test fails if that expansion ever stops
working, so the suite cannot pass vacuously.

`color-contrast` and `region` are disabled: the first needs the compiled
stylesheet loaded in a real renderer, and the second is asserted directly
instead.

---

## Security notes

- **No token is embedded in the site's source.** A token only exists in the
  repository if an administrator deliberately saves one, and then only as
  AES-256-GCM ciphertext behind a PBKDF2-SHA256 key — never in the clear. See
  [One shared publishing token](#one-shared-publishing-token-saved-in-the-repository)
  for exactly what that protects and what it does not.
- A token held in a browser lives in `sessionStorage` only, is sent only to
  `api.github.com`, and is forgotten when the tab closes or staff sign out.
- The admin and teacher passwords are stored only as salted SHA-256 digests.
- The teacher password is also the key to the saved publishing token, so it is
  a repository credential: make it strong and rotate it when staff leave.
- Mini-app previews run in an iframe **without** `allow-same-origin`, so
  third-party HTML cannot reach this site's storage or admin session.
