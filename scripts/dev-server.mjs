import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const port = Number(process.env.PORT || 8080);
const host = '0.0.0.0';
const types = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.ico': 'image/x-icon'
};

const server = createServer((request, response) => {
  let pathname;
  let urlObj;
  try {
    urlObj = new URL(request.url || '/', 'http://dev.local');
    pathname = decodeURIComponent(urlObj.pathname);
  } catch {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('Bad request');
    return;
  }

  // Redirect /download to /download.html
  if (pathname === '/download' || pathname === '/download/') {
    response.writeHead(302, { 'Location': '/download.html' });
    response.end();
    return;
  }

  if (pathname === '/') pathname = '/index.html';

  // Dynamic apps.json generator for development mode
  if (pathname === '/apps.json') {
    const appsDir = resolve(root, 'apps');
    const files = existsSync(appsDir) ? readdirSync(appsDir) : [];
    const validExts = new Set(['.html', '.htm', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx']);
    const appList = files
      .filter(f => validExts.has(extname(f).toLowerCase()))
      .map(name => ({
        type: 'file',
        name,
        path: `apps/${name}`,
        sha: `apps/${name}`,
        download_url: `apps/${name}`
      }));
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0'
    });
    response.end(JSON.stringify(appList));
    return;
  }

  const file = resolve(root, `.${pathname}`);
  if (file !== root && !file.startsWith(`${root}${sep}`)) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('Forbidden');
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('Not found');
    return;
  }

  const filename = basename(file);
  const headers = {
    'Content-Type': types[extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  };

  // Force attachment download if requested via ?download or ?download=1
  if (urlObj.searchParams.has('download') || urlObj.searchParams.get('dl') === '1') {
    headers['Content-Disposition'] = `attachment; filename="${filename}"`;
  }

  response.writeHead(200, headers);
  if (request.method === 'HEAD') response.end();
  else createReadStream(file).pipe(response);
});

server.listen(port, host, () => {
  console.log(`School Cloud development site listening on http://${host}:${port}`);
});
