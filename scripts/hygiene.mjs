// Output hygiene (design.md 7.1 step 9, FR-03, FR-29, FR-04, Y-5).
// Returns a list of findings; an empty list means the output is clean.
import fs from 'node:fs';
import path from 'node:path';
import { listFiles } from './manifest.mjs';

const FORBIDDEN_EXT = ['.php', '.phtml', '.twig', '.shtml', '.htaccess'];
const FORBIDDEN_NAMES = ['settings.php', 'index.php', 'newRelic.js', '.htaccess'];
const FORBIDDEN_DIRS = ['vendor', 'node_modules'];
const TEXT_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.csv', '.txt', '.xml', '.map', '.md']);

const CONTENT_RULES = [
  { rule: 'php-open-tag', re: /<\?php|<\?=/ },
  { rule: 'server-side-include', re: /<!--#include/ },
  { rule: 'licenseKey', re: /licenseKey/ },
  { rule: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: 'password-literal', re: /\b(?:password|passwd|pwd)\b["']?\s*[:=]\s*["'][^"'\s]{4,}["']/i },
  { rule: 'php-url', re: /[\w\-./%]+\.php(?=[?#"'\s<>)\]]|$)/i },
  { rule: 'internal-ip', re: /192\.0\.2\.50/ },
];
const LOOPBACK_RULES = [
  { rule: 'localhost', re: /\blocalhost\b/i },
  { rule: 'host-port', re: /https?:\/\/[A-Za-z0-9.-]+:\d{2,5}(?=[/?#"'\s<>)]|$)/ },
  { rule: 'loopback-ip', re: /\b127\.0\.0\.1\b/ },
];

export function runHygiene({ outDir, sentinel }) {
  const findings = [];
  const add = (file, rule, detail) => findings.push({ file, rule, detail });
  for (const rel of listFiles(outDir)) {
    const base = path.posix.basename(rel);
    const ext = path.posix.extname(rel).toLowerCase();
    const segments = rel.split('/');
    if (FORBIDDEN_EXT.includes(ext) || FORBIDDEN_EXT.includes(base.toLowerCase())) add(rel, 'forbidden-extension', ext || base);
    if (FORBIDDEN_NAMES.includes(base) || base.toLowerCase().startsWith('composer.')) add(rel, 'forbidden-file', base);
    for (const seg of segments.slice(0, -1)) {
      if (FORBIDDEN_DIRS.includes(seg)) add(rel, 'forbidden-folder', seg);
    }
    if (!TEXT_EXT.has(ext)) continue;
    const text = fs.readFileSync(path.join(outDir, ...segments), 'utf8');
    for (const { rule, re } of CONTENT_RULES) {
      const m = re.exec(text);
      if (m) add(rel, rule, m[0].slice(0, 80));
    }
    for (const { rule, re } of LOOPBACK_RULES) { // FR-04: the whole output, libraries included
      const m = re.exec(text);
      if (m) add(rel, rule, m[0].slice(0, 80));
    }
    const sentinelAllowed = /--embed(-nonav)?\.html$/.test(rel) || rel === 'js/rd-apply.js';
    if (sentinel && !sentinelAllowed && text.includes(sentinel)) add(rel, 'sentinel', `${sentinel} outside embed HTML and js/rd-apply.js`);
  }
  return findings;
}
