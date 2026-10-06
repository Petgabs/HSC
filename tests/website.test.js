import { readFile, access } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

describe('School Cloud release configuration', () => {
  it('removes teacher sign-in, saves the publisher secret in GitHub and remembers the token on the device', async () => {
    const [html, app, publisher] = await Promise.all([
      read('../index.html'), read('../assets/js/app.js'), read('../assets/js/lib/githubPublish.js')
    ]);
    expect(html).not.toContain('Teacher Login');
    expect(html).not.toContain("openLogin('teacher')");
    expect(html).not.toContain('Teacher Access');
    expect(html).toContain('SCHOOLCLOUD_PUBLISH_TOKEN');
    expect(html).toContain('Secrets: Read and write');
    expect(html).toContain('@click="saveGithubSecret()"');
    expect(app).toContain('savePublishingTokenToGitHub');
    expect(publisher).toContain('crypto_box_seal');
    expect(publisher).toContain('alreadySaved: true');
    expect(html).toContain('Administrator Sign In');
    expect(html).toContain('Publish to GitHub &amp; Website');
    // A verified token is remembered once on the device, survives sign-out,
    // and can be forgotten explicitly.
    expect(app).toContain("schoolcloud.github.token.v1");
    expect(app).toContain('restoreSavedGithubToken');
    expect(app).toContain('rememberGithubToken');
    expect(app).toContain('forgetSavedGithubToken');
    // Signing in restores the remembered token and re-checks it with GitHub.
    expect(app).toMatch(/if \(this\.restoreSavedGithubToken\(\)\) this\.verifySavedGithubToken\(\)/);
    expect(html).toContain('Forget token on this device');
    expect(html).not.toContain('Clear token from this tab');
  });

  it('ships with no GitHub credential and allows only the Abacus counter origin', async () => {
    const [config, html, headers] = await Promise.all([
      read('../assets/js/config.js'), read('../index.html'), read('../_headers')
    ]);
    expect(config).toContain("baseUrl: 'https://abacus.jasoncameron.dev'");
    // The admin gate ships a username, a salt and a SHA-256 digest only — never a plain password.
    expect(config).toMatch(/username:\s*'hsc-admin'/);
    expect(config).toMatch(/salt:\s*'[0-9a-f]{16,}'/);
    expect(config).toMatch(/passwordHash:\s*'[0-9a-f]{64}'/);
    expect(config).not.toMatch(/\bpassword\s*:\s*'/i);
    expect(config).not.toMatch(/(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/);
    expect(html).toContain('https://abacus.jasoncameron.dev');
    expect(html).not.toContain('supabase.co');
    expect(headers).not.toContain('supabase.co');
  });

  it('has every first-party asset referenced by the page and the token-encryption runtime', async () => {
    const [html, publisher] = await Promise.all([read('../index.html'), read('../assets/js/lib/githubPublish.js')]);
    const paths = [...html.matchAll(/(?:src|href)="\.\/([^"#?]+)"/g)].map(match => match[1]);
    paths.push('assets/vendor/libsodium-wrappers.mjs', 'assets/vendor/libsodium.mjs');
    for (const path of paths) await expect(access(new URL(`../${path}`, import.meta.url))).resolves.toBeUndefined();
    expect(publisher).toContain('../../vendor/libsodium-wrappers.mjs');
  });

  it('generates apps.json with precedence-safe Liquid and baseurl-proof URLs', async () => {
    const template = await read('../apps.json');
    // Liquid gives and/or no precedence in one condition, so the path and
    // extension checks must live in nested blocks with a pure `or` chain.
    expect(template).toContain("{% if file.path contains '/apps/' %}");
    expect(template).not.toMatch(/{% if [^%]*\band\b[^%]*\bor\b[^%]*%}/);
    expect(template).toMatch(/{% if extension == '\.html' or extension == '\.htm' or .*\.pptx' %}/);
    // Repository-relative URLs resolve under project Pages, custom domains and localhost.
    expect(template).toContain('"download_url": {{ file.path | remove_first: "/" | jsonify }}');
    expect(template).not.toContain('site.baseurl');
  });

  it('ships a durable GitHub download-count record served to every visitor', async () => {
    const record = JSON.parse(await read('../stats/downloads.json'));
    expect(record.namespace).toBe('petgabs-hsc-schoolcloud');
    expect(typeof record.updatedAt).toBe('string');
    expect(record.files).toBeTypeOf('object');
    for (const [path, entry] of Object.entries(record.files)) {
      expect(path).toMatch(/^apps\/[^/]+$/);
      expect(entry.downloads).toBeGreaterThanOrEqual(0);
      expect(entry.key).toMatch(/^download-[a-f0-9]{8}$/);
    }
    const worker = await read('../sw.js');
    expect(worker).toContain('/stats/downloads.json');
  });

  it('wires automatic GitHub counter snapshots, the admin sync, and one release version', async () => {
    const [html, app, pkg, worker, workflow, syncScript] = await Promise.all([
      read('../index.html'), read('../assets/js/app.js'), read('../package.json'), read('../sw.js'),
      read('../.github/workflows/sync-abacus-stats.yml'), read('../scripts/sync-abacus-stats.mjs')
    ]);
    expect(html).toContain('@click="syncDownloadStatsToGitHub()"');
    expect(html).toContain('Save counts to GitHub');
    expect(html).toContain('automatically every 15 minutes');
    expect(app).toContain('async syncDownloadStatsToGitHub()');
    expect(app).toContain('saveDownloadStatsToGitHub');
    expect(workflow).toContain("cron: '*/15 * * * *'");
    expect(workflow).toContain('contents: write');
    expect(workflow).toContain('GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}');
    expect(syncScript).toContain('collectAbacusSnapshot');
    expect(syncScript).toContain('saveDownloadStatsToGitHub');
    const version = JSON.parse(pkg).version;
    expect(html).toContain(`>v${version}<`);
    expect(worker).toContain(`VERSION = 'v${version}'`);
  });
});
