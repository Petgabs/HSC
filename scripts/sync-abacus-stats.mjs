import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { SITE_CONFIG, SUPPORTED_EXTENSIONS } from '../assets/js/config.js';
import {
  AbacusCounters,
  downloadCounterKey,
  downloadsFromRecord,
  maxCounter,
  normalizeStatsRecord
} from '../assets/js/lib/counters.js';
import { saveDownloadStatsToGitHub } from '../assets/js/lib/githubPublish.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const STATS_PATH = 'stats/downloads.json';
const ABACUS_REQUEST_INTERVAL_MS = 400;

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));

/** List the same supported, top-level apps/ files that the public library exposes. */
export function listTrackedAppPaths(root = REPO_ROOT) {
  const output = execFileSync('git', ['ls-files', '-z', '--', 'apps/'], {
    cwd: root,
    encoding: 'utf8'
  });
  return [...new Set(output.split('\0').filter(path => {
    if (!/^apps\/[^/]+$/.test(path)) return false;
    return SUPPORTED_EXTENSIONS.includes(extname(path).toLowerCase());
  }))].sort((left, right) => left.localeCompare(right));
}

/**
 * Read the Abacus snapshot used by the automated GitHub sync. Requests are
 * spaced below Abacus' per-IP rate limit, and a failed read falls back to the
 * saved total rather than lowering or losing the shared count.
 */
export async function collectAbacusSnapshot({
  paths,
  counters,
  previousRecord,
  namespace = SITE_CONFIG.abacus.namespace,
  visitorKey = SITE_CONFIG.abacus.visitorKey,
  requestIntervalMs = ABACUS_REQUEST_INTERVAL_MS,
  wait = delay,
  onReadError = () => {}
}) {
  const saved = normalizeStatsRecord(previousRecord);
  let lastRequestAt = 0;

  const get = async key => {
    const remaining = requestIntervalMs - (Date.now() - lastRequestAt);
    if (remaining > 0) await wait(remaining);
    lastRequestAt = Date.now();
    try {
      return await counters.get(key);
    } catch (error) {
      onReadError(key, error);
      return null;
    }
  };

  const liveVisitors = await get(visitorKey);
  const visitors = maxCounter(saved.visitors, liveVisitors);
  const files = {};

  for (const path of paths) {
    const key = downloadCounterKey(path);
    const savedDownloads = downloadsFromRecord(saved, path);
    const liveDownloads = await get(key);
    files[path] = {
      downloads: maxCounter(savedDownloads, liveDownloads),
      key
    };
  }

  return {
    namespace,
    updatedAt: new Date().toISOString(),
    visitors,
    files
  };
}

/** Return true only when the totals or current library keys need a GitHub update. */
export function snapshotHasChanges(previousRecord, snapshot) {
  const previous = normalizeStatsRecord(previousRecord);
  if (previous.visitors < maxCounter(snapshot?.visitors)) return true;
  if (previousRecord?.namespace !== snapshot?.namespace) return true;

  const files = snapshot?.files && typeof snapshot.files === 'object' && !Array.isArray(snapshot.files)
    ? snapshot.files
    : {};
  for (const [path, entry] of Object.entries(files)) {
    const old = previous.files.get(path.toLowerCase());
    if (!old) return true;
    if (old.downloads < maxCounter(entry?.downloads) || old.key !== entry?.key) return true;
  }
  return false;
}

async function readPreviousRecord(root) {
  const text = await readFile(resolve(root, STATS_PATH), 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${STATS_PATH} is not valid JSON; refusing to overwrite the saved counters.`);
  }
}

function repositoryTarget() {
  const configured = SITE_CONFIG.repository;
  const slug = String(process.env.GITHUB_REPOSITORY || `${configured.owner}/${configured.name}`);
  const match = slug.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match) throw new Error('GITHUB_REPOSITORY must be set to owner/repository.');
  return { owner: match[1], repo: match[2] };
}

export async function main() {
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  if (!token) throw new Error('GITHUB_TOKEN is required to save Abacus totals to GitHub.');

  const branch = String(process.env.GITHUB_REF_NAME || SITE_CONFIG.repository.branch);
  if (branch !== SITE_CONFIG.repository.branch) {
    throw new Error(`Counter snapshots may only be written to ${SITE_CONFIG.repository.branch}.`);
  }

  const { owner, repo } = repositoryTarget();
  const paths = listTrackedAppPaths();
  const previousRecord = await readPreviousRecord(REPO_ROOT);
  const readErrors = [];
  const counters = new AbacusCounters({
    baseUrl: SITE_CONFIG.abacus.baseUrl,
    namespace: SITE_CONFIG.abacus.namespace
  });
  const snapshot = await collectAbacusSnapshot({
    paths,
    counters,
    previousRecord,
    onReadError(key, error) {
      readErrors.push(key);
      console.warn(`Abacus read failed for ${key}: ${error?.message || 'unknown error'}`);
    }
  });

  if (!snapshotHasChanges(previousRecord, snapshot)) {
    console.log(`GitHub counter record is current (${snapshot.visitors} visitors, ${paths.length} files).`);
    if (readErrors.length) console.warn(`${readErrors.length} Abacus read(s) failed; saved totals were kept.`);
    return { changed: false, snapshot, readErrors };
  }

  const result = await saveDownloadStatsToGitHub({
    owner,
    repo,
    branch,
    token,
    stats: snapshot
  });
  console.log(`Saved ${result.fileCount} file counter(s) and ${result.visitors} visitor(s) to ${owner}/${repo}:${result.path}.`);
  if (result.commitUrl) console.log(`GitHub commit: ${result.commitUrl}`);
  if (readErrors.length) console.warn(`${readErrors.length} Abacus read(s) failed; saved totals were kept.`);
  return { changed: true, result, snapshot, readErrors };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch(error => {
    console.error(error?.message || error);
    process.exitCode = 1;
  });
}
