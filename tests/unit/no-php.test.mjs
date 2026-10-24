// T-08: the migrated site is 100 % static, with no PHP and no application backend (FR-29, DD-20,
// NFR-03). Checks package.json and the lockfile, then the built output.
//
// Seams used by the falsifier runs (T-08): NO_PHP_DIST_DIR points the output checks at an existing
// folder instead of a fresh build; NO_PHP_ROOT points the package checks at a folder holding a
// package.json and package-lock.json. Both default to the real project.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runBuild, tempDir, cleanupTemp, ROOT } from '../helpers/build-run.mjs';

const PHP_NAME = /php|composer|slim|apache|laravel|symfony|xampp|wamp/i;
// Exactly the extensions FR-29 lists (requirements.md, static artifact scenario).
const STATIC_EXT = new Set(['.html', '.js', '.css', '.svg', '.png', '.jpg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.csv', '.json']);
const FORBIDDEN_FILES = new Set(['settings.php', 'index.php', '.htaccess']);
const FORBIDDEN_EXT = new Set(['.php', '.phtml', '.twig', '.shtml']);
const FORBIDDEN_DIRS = new Set(['vendor', 'node_modules']);

const pkgRoot = process.env.NO_PHP_ROOT || ROOT;
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package-lock.json'), 'utf8'));

let outDir;
after(cleanupTemp);
before(() => {
  if (process.env.NO_PHP_DIST_DIR) {
    outDir = process.env.NO_PHP_DIST_DIR;
  } else {
    const r = runBuild();
    assert.equal(r.status, 0, r.stderr);
    outDir = r.outDir;
  }
});

// Returns the list of problems of an output folder (empty = static and clean).
function scanDist(dir) {
  const problems = [];
  const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(e.parentPath, e.name);
    const rel = path.relative(dir, abs).replace(/\\/g, '/');
    if (e.isDirectory()) {
      if (FORBIDDEN_DIRS.has(e.name)) problems.push(`${rel}: forbidden folder`);
      continue;
    }
    const ext = path.extname(e.name).toLowerCase();
    if (FORBIDDEN_FILES.has(e.name.toLowerCase()) || e.name.toLowerCase().startsWith('composer.') || FORBIDDEN_EXT.has(ext)) problems.push(`${rel}: forbidden file`);
    else if (!STATIC_EXT.has(ext)) problems.push(`${rel}: extension ${ext || '(none)'} is not in the static allowlist`);
    if (['.html', '.js', '.css', '.svg', '.json', '.csv'].includes(ext)) {
      const text = fs.readFileSync(abs, 'utf8');
      if (text.includes('<?php') || text.includes('<?=')) problems.push(`${rel}: PHP open tag`);
      if (/<!--#(include|exec|echo|config)/.test(text)) problems.push(`${rel}: server-side include`);
      if (/[\w\-./%]+\.php(?=[?#"'\s<>)\]]|$)/i.test(text)) problems.push(`${rel}: .php URL`);
      if (text.includes('192.0.2.50')) problems.push(`${rel}: internal address 192.0.2.50`);
      if (/\blocalhost\b/i.test(text) || /\b127\.0\.0\.1\b/.test(text) || /https?:\/\/[\w.-]+:\d{2,5}\b/.test(text)) problems.push(`${rel}: localhost or port`);
    }
  }
  return problems;
}

test('package.json: no PHP-related dependency, script name or script command (FR-29)', () => {
  const names = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {}),
    ...Object.keys(pkg.optionalDependencies || {}), ...Object.keys(pkg.peerDependencies || {})];
  assert.deepEqual(names.filter((n) => PHP_NAME.test(n)), []);
  assert.deepEqual(Object.keys(pkg.scripts).filter((n) => PHP_NAME.test(n)), []);
  assert.deepEqual(Object.values(pkg.scripts).filter((c) => PHP_NAME.test(c)), []);
  assert.ok(names.length > 0, 'the check must see the dependencies');
});

test('package.json: every dependency is a devDependency and there are no install hooks (NFR-03, DD-20)', () => {
  for (const key of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies']) {
    assert.deepEqual(Object.keys(pkg[key] || {}), [], `${key} must be empty`);
  }
  assert.ok(Object.keys(pkg.devDependencies).length >= 6);
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) assert.equal(pkg.scripts[hook], undefined, hook);
});

test('package-lock.json: no PHP-related package and every locked package is dev-only (FR-29)', () => {
  const entries = Object.entries(lock.packages).filter(([k]) => k !== '');
  assert.ok(entries.length > 10);
  assert.deepEqual(entries.map(([k]) => k).filter((k) => PHP_NAME.test(k)), []);
  assert.deepEqual(entries.filter(([, v]) => !v.dev).map(([k]) => k), []);
  assert.deepEqual(Object.keys(lock.packages[''].dependencies || {}), []);
});

test('output: only static-allowlist extensions, no forbidden files or folders, no PHP, no SSI, no .php URL, no 192.0.2.50, no localhost or port', () => {
  assert.deepEqual(scanDist(outDir), []);
});

test('output: 55 HTML files are present, so the scan above is not vacuous', () => {
  const html = fs.readdirSync(outDir, { recursive: true }).filter((n) => String(n).endsWith('.html'));
  assert.equal(html.length, 55);
});

test('the scan detects each kind of violation (self-check of the checks above)', () => {
  const inject = (rel, text) => {
    const dir = tempDir('rd-nophp-');
    fs.writeFileSync(path.join(dir, 'ok.html'), '<html></html>');
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
    return scanDist(dir);
  };
  assert.deepEqual(inject('test.php', 'x'), ['test.php: forbidden file']);
  assert.deepEqual(inject('page.html', '<?php echo 1;'), ['page.html: PHP open tag']);
  assert.deepEqual(inject('page.html', '<?= $x ?>'), ['page.html: PHP open tag']);
  assert.deepEqual(inject('page.html', '<!--#include virtual="/a" -->'), ['page.html: server-side include']);
  assert.deepEqual(inject('a.js', 'fetch("./api/x.php?y=1")'), ['a.js: .php URL']);
  assert.deepEqual(inject('a.js', 'var h="http://192.0.2.50/x"'), ['a.js: internal address 192.0.2.50']);
  assert.deepEqual(inject('a.js', 'var h="http://localhost:8080/x"'), ['a.js: localhost or port']);
  assert.deepEqual(inject('third-party/lib/x.js', 'var u="http://localhost:8080"'), ['third-party/lib/x.js: localhost or port']);
  assert.deepEqual(inject('js/libs/y.js', 'x="127.0.0.1"'), ['js/libs/y.js: localhost or port']);
  assert.deepEqual(inject('notes.txt', 'x'), ['notes.txt: extension .txt is not in the static allowlist']);
  assert.deepEqual(inject('composer.xml', 'x'), ['composer.xml: forbidden file']);
  assert.deepEqual(inject('vendor/x.js', ''), ['vendor: forbidden folder']);
  assert.deepEqual(inject('node_modules/x.js', ''), ['node_modules: forbidden folder']);
  assert.deepEqual(inject('.htaccess', 'x'), ['.htaccess: forbidden file']);
  assert.deepEqual(inject('run.sh', 'x'), ['run.sh: extension .sh is not in the static allowlist']);
});
