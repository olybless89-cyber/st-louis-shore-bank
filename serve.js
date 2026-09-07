#!/usr/bin/env node
// Self-contained St Louis Shore Bank server (no npm deps, no PHP).
//
// - Serves the static site from public/ with the clean-URL rewrites from
//   vercel.json (/login -> /login.html, /admin -> /admin.html, etc.).
// - Rewrites every served .html page at request time so the embedded Supabase
//   client points at the /supa proxy below (not the hosted project), using the
//   local stack's anon key.
// - Proxies /supa/* -> the local self-hosted Supabase API (GoTrue + PostgREST
//   + storage) so auth, REST, and storage calls work from the browser.
//
// Usage:  node serve.js            (port from PORT env, default 12000)
//
// Point this server at YOUR Supabase project by setting two environment
// variables (e.g. in Railway -> Variables):
//   SUPABASE_API_URL   = https://YOUR-PROJECT-REF.supabase.co
//   SUPABASE_ANON_KEY  = <the anon/publishable key from that project>
// Until both are set, the server falls back to the same placeholder values
// baked into the committed HTML, so it will run but auth/data calls will
// fail loudly (by design — it will never silently talk to someone else's
// database).

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PUBLIC = path.resolve(__dirname, 'public');
const PORT = Number(process.env.PORT || 12000);
const SUPABASE_API_URL = (process.env.SUPABASE_API_URL || 'https://YOUR-PROJECT-REF.supabase.co').replace(/\/$/, '');

// Anon key for your Supabase project. Set via the SUPABASE_ANON_KEY env var.
const LOCAL_ANON_KEY = process.env.SUPABASE_ANON_KEY
  || 'YOUR_SUPABASE_ANON_KEY';

// These are the literal placeholder strings baked into every committed HTML
// page's `const SUPA_URL` / `const SUPA_KEY`. At request time we swap them
// for the real values above (env vars, or these same placeholders if unset)
// so the browser talks to the /supa proxy instead of a hardcoded project.
// Do not change these two constants without also changing the matching
// SUPA_URL / SUPA_KEY placeholder text in every .html file — they must be
// byte-identical for the swap to find anything.
const HOSTED_URL = 'https://YOUR-PROJECT-REF.supabase.co';
const HOSTED_KEY = 'YOUR_SUPABASE_ANON_KEY';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4',
};

// Clean-URL rewrites (mirrors vercel.json): /login -> /login.html, etc.
const REWRITES = {
  '/': '/index.html',
  '/business': '/business.html',
  '/personal': '/personal.html',
  '/cards': '/cards.html',
  '/loans': '/loans.html',
  '/contact': '/contact.html',
  '/login': '/login.html',
  '/register': '/register.html',
  '/forgot-password': '/forgot-password.html',
  '/reset-password': '/reset-password.html',
  '/about': '/about.html',
  '/faq': '/faq.html',
  '/apps': '/apps.html',
  '/privacy-policy': '/privacy-policy.html',
  '/terms-of-service': '/terms-of-service.html',
  '/dashboard': '/dashboard.html',
  '/admin-login': '/admin-login.html',
  '/admin/login': '/admin-login.html',
  '/admin': '/admin.html',
};

function resolveFile(reqPath) {
  let p = decodeURIComponent(reqPath.split('?')[0]);
  // Admin sub-paths all serve admin.html (matches /admin/(.*) in vercel.json).
  if (p.startsWith('/admin/') && p !== '/admin/login') p = '/admin.html';
  if (REWRITES[p]) p = REWRITES[p];
  if (p === '/' || p === '') p = '/index.html';
  // Strip the leading slash for filesystem path.
  let rel = p.replace(/^\//, '');
  let fp = path.join(PUBLIC, rel);
  // Prevent path traversal.
  if (!fp.startsWith(PUBLIC)) fp = path.join(PUBLIC, 'index.html');
  // If directory, look for index.html; if no extension and a .html sibling exists, use it.
  try {
    const st = fs.statSync(fp);
    if (st.isDirectory()) {
      const idx = path.join(fp, 'index.html');
      if (fs.existsSync(idx)) return idx;
    }
    return fp;
  } catch (e) {
    // Try adding .html (clean URL form like /login.html already handled; bare names)
    if (!path.extname(fp)) {
      const withHtml = fp + '.html';
      if (fs.existsSync(withHtml)) return withHtml;
    }
    return null;
  }
}

function rewriteHtml(content, origin) {
  // The Supabase JS SDK rejects relative URLs (it enforces ^https?://), so we
  // must hand it an absolute URL. Build it from the request's own origin so it
  // resolves to the /supa proxy on whatever host/proxy serves the site.
  const supaUrl = origin + '/supa';
  // Serve the Supabase JS SDK from a local vendored copy so the page does not
  // depend on an external CDN (which may be unreachable from the browser).
  const cdnSdk = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
  const localSdk = '/vendor/supabase.js';
  return content
    .split(HOSTED_URL).join(supaUrl)
    .split(HOSTED_KEY).join(LOCAL_ANON_KEY)
    .split(cdnSdk).join(localSdk);
}

function serveStatic(req, res, reqPath) {
  const fp = resolveFile(reqPath);
  if (!fp || !fs.existsSync(fp)) {
    // SPA-ish fallback: index.html (last rewrite in vercel.json).
    const idx = path.join(PUBLIC, 'index.html');
    if (fs.existsSync(idx)) {
      const body = fs.readFileSync(idx);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(rewriteHtml(body.toString('utf8'), originFor(req)));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const ext = path.extname(fp).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  // The chat widget also embeds the hosted Supabase URL/anon key, so rewrite
  // it the same way as the HTML pages or it would keep talking to the hosted
  // project in self-hosted mode.
  if (ext === '.js' && path.basename(fp) === 'chat-widget.js') {
    let body;
    try { body = fs.readFileSync(fp); } catch (e) { res.writeHead(500); res.end('read error'); return; }
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(rewriteHtml(body.toString('utf8'), originFor(req)));
    return;
  }
  if (ext === '.html') {
    let body;
    try { body = fs.readFileSync(fp); } catch (e) { res.writeHead(500); res.end('read error'); return; }
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    res.end(rewriteHtml(body.toString('utf8'), originFor(req)));
    return;
  }
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' });
    res.end(data);
  });
}

function originFor(req) {
  const host = req.headers['host'] || ('localhost:' + PORT);
  // Honour the reverse proxy's scheme (work hosts are https).
  const fwdProto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = fwdProto || (req.socket.encrypted ? 'https' : 'http');
  return proto + '://' + host;
}

function proxySupabase(req, res, reqPath) {
  // reqPath begins with /supa; map to the local API.
  let target = SUPABASE_API_URL + reqPath.replace(/^\/supa/, '');
  const parsed = url.parse(target, true);
  const upstream = parsed;
  // Support https upstreams too (e.g. proxying straight at a hosted project).
  const transport = upstream.protocol === 'https:' ? require('https') : http;
  const payload = [];
  req.on('data', c => payload.push(c));
  req.on('end', () => {
    const body = Buffer.concat(payload);
    const headers = { ...req.headers };
    delete headers['host'];
    delete headers['content-length'];
    if (body.length) headers['content-length'] = body.length;
    const proxyReq = transport.request(
      {
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
        path: upstream.path,
        method: req.method,
        headers,
      },
      proxyRes => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );
    proxyReq.on('error', err => {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Supabase proxy error', message: err.message }));
    });
    if (body.length) proxyReq.write(body);
    proxyReq.end();
  });
}

const server = http.createServer((req, res) => {
  const reqPath = req.url || '/';
  if (reqPath.startsWith('/supa/') || reqPath === '/supa') {
    return proxySupabase(req, res, reqPath);
  }
  serveStatic(req, res, reqPath);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`St Louis Shore Bank server listening on http://0.0.0.0:${PORT}`);
  console.log(`  static root: ${PUBLIC}`);
  console.log(`  supabase proxy: /supa -> ${SUPABASE_API_URL}`);
});
