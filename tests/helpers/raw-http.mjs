// Raw-socket HTTP client (design.md section 7.4, NFR-09). Writes the request-target as exact bytes
// so that nothing normalizes it (fetch/URL would collapse `..`, convert `\` and encode bytes).
import net from 'node:net';

// target: string (written as latin1, one char = one byte) or Buffer.
// Returns { raw, statusLine, status, headers (lower-case names, last wins), body (Buffer) }.
export function rawRequest({ port, host = '127.0.0.1', method = 'GET', target, headers = {}, hostHeader = 'localhost', body, timeoutMs = 3000 }) {
  const targetBuf = Buffer.isBuffer(target) ? target : Buffer.from(target, 'latin1');
  const lines = [`Host: ${hostHeader}`, 'Connection: close', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
  if (body !== undefined) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
  const request = Buffer.concat([
    Buffer.from(`${method} `, 'latin1'),
    targetBuf,
    Buffer.from(` HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`, 'latin1'),
    body === undefined ? Buffer.alloc(0) : Buffer.from(body),
  ]);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host });
    const chunks = [];
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`raw request timed out: ${targetBuf.toString('latin1')}`)); }, timeoutMs);
    socket.on('connect', () => socket.write(request));
    socket.on('data', (d) => chunks.push(d));
    socket.on('error', (e) => { clearTimeout(timer); reject(e); });
    socket.on('close', () => { clearTimeout(timer); resolve(parseResponse(Buffer.concat(chunks))); });
  });
}

function parseResponse(raw) {
  const sep = raw.indexOf('\r\n\r\n');
  const head = (sep === -1 ? raw : raw.subarray(0, sep)).toString('latin1');
  const [statusLine = '', ...headerLines] = head.split('\r\n');
  const headers = {};
  for (const l of headerLines) {
    const i = l.indexOf(':');
    if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
  return { raw, statusLine, status: m ? Number(m[1]) : 0, headers, body: sep === -1 ? Buffer.alloc(0) : raw.subarray(sep + 4) };
}
