// Local static server (design.md section 7.4, DD-06): `npm run serve`.
// Dependency-free node:http. Serves only paths found in an in-memory, case-sensitive index of the
// roots (NFR-05, NFR-09), so there is no path traversal and no directory listing. The rules core
// (src/routing/rules.core.js) decides rewrite / redirect / 400 / 405 / 404 / pass; this file only
// materializes its result (section 7.3, "Adapters").
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCore } from './load-core.mjs';
import { loadSite, rdData, REPO_ROOT } from './site-data.mjs';

export const DEFAULT_PORT = 8080;

const TEXT = '; charset=utf-8';
export const CONTENT_TYPES = {
  '.html': 'text/html' + TEXT,
  '.js': 'text/javascript' + TEXT,
  '.css': 'text/css' + TEXT,
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.csv': 'text/csv' + TEXT,
  '.json': 'application/json' + TEXT,
};

// NFR-06. No X-Frame-Options on purpose (the widget is embedded from other origins).
export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy-Report-Only': [
    "default-src 'self'",
    "frame-src 'self' https://tableau-core.cgiar.org https://public.tableau.com",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
  ].join('; '),
  'Cache-Control': 'no-store',
};

export function contentTypeOf(file) {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

// Exact, case-sensitive index: '/relative/path.ext' -> absolute file. First root wins. Symbolic
// links and anything that is not a regular file or directory are not indexed.
export function buildIndex(roots) {
  const index = new Map();
  const walk = (rootDir, rel) => {
    for (const entry of fs.readdirSync(path.join(rootDir, rel), { withFileTypes: true })) {
      const relPath = rel === '' ? entry.name : rel + '/' + entry.name;
      if (entry.isDirectory()) walk(rootDir, relPath);
      else if (entry.isFile()) {
        const key = '/' + relPath;
        if (!index.has(key)) index.set(key, path.join(rootDir, relPath));
      }
    }
  };
  for (const root of roots) walk(path.resolve(root), '');
  return index;
}

function splitTarget(url) {
  const i = url.indexOf('?');
  return i === -1 ? { path: url, query: '' } : { path: url.slice(0, i), query: url.slice(i + 1) };
}

function hostOf(header) {
  if (!header) return '';
  const h = header.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  const c = h.indexOf(':');
  return c === -1 ? h : h.slice(0, c);
}

// RD_CANONICAL_HOST is '' here: the local server never runs rule 1 (mode 'local') and has no canonical host.
function loadRules() {
  const RD_DATA = rdData(loadSite());
  return loadCore({ RD_DATA, RD_CANONICAL_HOST: '' }, 'src/runtime/legacy-compat.core.js', 'src/routing/rules.core.js');
}

// Returns { handler, index }. `rules: false` is the plain static server (--no-rules).
export function createHandler({ roots, rules = true, log = () => {} }) {
  const index = buildIndex(roots);
  const core = rules ? loadRules() : null;

  function send(res, req, status, headers, body, ruleResult) {
    const buf = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
    res.writeHead(status, { ...SECURITY_HEADERS, ...headers, 'Content-Length': buf.length });
    res.end(req.method === 'HEAD' ? undefined : buf);
    log(`${req.method} ${req.url} ${status} ${ruleResult}`);
  }

  function sendFile(res, req, status, key, ruleResult) {
    const file = index.get(key);
    let data;
    try { data = file === undefined ? null : fs.readFileSync(file); } catch { data = null; }
    if (data === null) return false;
    send(res, req, status, { 'Content-Type': contentTypeOf(key) }, data, ruleResult);
    return true;
  }

  function notFound(res, req, ruleResult) {
    if (!sendFile(res, req, 404, '/404.html', ruleResult)) {
      send(res, req, 404, { 'Content-Type': 'text/plain' + TEXT }, 'Not Found', ruleResult);
    }
  }

  function badRequest(res, req, ruleResult) {
    send(res, req, 400, { 'Content-Type': 'text/plain' + TEXT, Connection: 'close' }, 'Bad Request', ruleResult);
  }

  function methodNotAllowed(res, req, ruleResult) {
    send(res, req, 405, { 'Content-Type': 'text/plain' + TEXT, Allow: 'GET, HEAD', Connection: 'close' }, 'Method Not Allowed', ruleResult);
  }

  function serveStatic(res, req, rawPath, ruleResult) {
    let decoded;
    try { decoded = decodeURIComponent(rawPath); } catch { return badRequest(res, req, ruleResult); }
    let key = decoded;
    if (!rules && key.endsWith('/')) key += 'index.html';
    if (!sendFile(res, req, 200, key, ruleResult)) notFound(res, req, ruleResult);
  }

  function handler(req, res) {
    const { path: rawPath, query } = splitTarget(req.url);
    if (!rules) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, req, 'static');
      if (!rawPath.startsWith('/')) return badRequest(res, req, 'static');
      return serveStatic(res, req, rawPath, 'static');
    }
    const sp = new URLSearchParams(query);
    const params = {};
    for (const k of new Set(sp.keys())) params[k] = core.lastValue(sp, k);
    const result = core.resolve(
      { method: req.method, host: hostOf(req.headers.host), path: rawPath, query, params },
      'local'
    );
    switch (result.type) {
      case 'rewrite':
        if (!sendFile(res, req, 200, '/' + result.file, 'rewrite')) notFound(res, req, 'rewrite-missing');
        return;
      case 'redirect':
        return send(res, req, 301, { Location: result.location }, undefined, 'redirect');
      case 'badRequest':
        return badRequest(res, req, 'badRequest');
      case 'methodNotAllowed':
        return methodNotAllowed(res, req, 'methodNotAllowed');
      case 'notFound':
        return notFound(res, req, 'notFound');
      default:
        return serveStatic(res, req, rawPath, 'pass');
    }
  }

  return { handler, index };
}

function listen(server, port, host, ipv6Only) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host, ipv6Only }, () => {
      server.off('error', reject);
      resolve(server.address().port);
    });
  });
}

// A TCP connect to loopback succeeds only when something already listens there. On Windows, bind()
// on 127.0.0.1 does not fail when another process holds the wildcard address (0.0.0.0 or ::), so
// the probe is what detects "port in use" (FR-20, design 7.4). It binds nothing.
function probeInUse(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (inUse) => { socket.destroy(); resolve(inUse); };
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

// Binds 127.0.0.1 and ::1 only. Resolves { port, servers, warnings, close() }.
// Rejects with an Error whose `code` is EADDRINUSE when IPv4 loopback (or a fixed IPv6 port) is taken.
export async function startServer({ roots, rules = true, port = DEFAULT_PORT, log = () => {} }) {
  if (port !== 0) {
    for (const host of ['127.0.0.1', '::1']) {
      if (await probeInUse(port, host)) {
        throw Object.assign(new Error(`port ${port} is already in use on ${host}`), { code: 'EADDRINUSE' });
      }
    }
  }
  const { handler, index } = createHandler({ roots, rules, log });
  const warnings = [];
  const v4 = http.createServer(handler);
  const boundPort = await listen(v4, port, '127.0.0.1');
  const servers = [v4];
  const v6 = http.createServer(handler);
  try {
    await listen(v6, boundPort, '::1', true);
    servers.push(v6);
  } catch (e) {
    if (e.code === 'EADDRINUSE' && port !== 0) {
      await new Promise((r) => v4.close(r));
      throw e;
    }
    warnings.push(`IPv6 loopback (::1) unavailable (${e.code || e.message}); serving on IPv4 only`);
  }
  return {
    port: boundPort,
    servers,
    index,
    warnings,
    close: () => Promise.all(servers.map((s) => new Promise((r) => { s.close(r); s.closeAllConnections(); }))),
  };
}

function parseArgs(argv) {
  const opts = { roots: [], rules: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-rules') opts.rules = false;
    else if (a === '--root') {
      if (i + 1 >= argv.length) throw new Error('--root needs a directory');
      opts.roots.push(argv[++i]);
    } else if (a.startsWith('--root=')) opts.roots.push(a.slice('--root='.length));
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(`serve: ${e.message}\nusage: node scripts/serve.mjs [--root <dir>]... [--no-rules]`);
    process.exit(2);
  }
  const rawPort = process.env.PORT === undefined || process.env.PORT === '' ? String(DEFAULT_PORT) : process.env.PORT;
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port > 65535) {
    console.error(`serve: invalid PORT "${rawPort}". Use an integer from 0 to 65535, for example: PORT=8081 npm run serve`);
    process.exit(2);
  }
  const roots = opts.roots.length > 0 ? opts.roots : [path.join(REPO_ROOT, 'dist')];
  for (const r of roots) {
    if (!fs.existsSync(r) || !fs.statSync(r).isDirectory()) {
      console.error(`serve: root "${r}" is not a directory. Run "npm run build" first.`);
      process.exit(2);
    }
  }
  let started;
  try {
    started = await startServer({ roots, rules: opts.rules, port, log: (line) => console.log(line) });
  } catch (e) {
    if (e.code === 'EADDRINUSE') {
      console.error(`serve: port ${port} is already in use (PORT=${port}). Stop the other process or choose another port, for example: PORT=${port + 1} npm run serve (PowerShell: $env:PORT=${port + 1}; npm run serve)`);
    } else {
      console.error(`serve: cannot listen on PORT=${port}: ${e.message}`);
    }
    process.exit(1);
  }
  for (const w of started.warnings) console.warn(`serve: warning: ${w}`);
  const where = started.servers.length === 2 ? '127.0.0.1 and [::1]' : '127.0.0.1';
  console.log(`serve: ${started.index.size} files from ${roots.join(', ')}${opts.rules ? '' : ' (no rules)'}`);
  console.log('serve: the file index is a snapshot taken at start-up; restart the server after a rebuild');
  console.log(`serve: listening on http://localhost:${started.port}/ (${where}); Ctrl+C to stop`);
  const stop = () => { started.close().then(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
