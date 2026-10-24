// Twig engine configuration shared by the build (build.mjs) and the reference
// render (reference-render.mjs). DD-05 / FR-02 / FR-05 / FR-07.
//
// twig.js is configured to reproduce the semantics of PHP Twig 1.35.4, which
// the original application used. The facts are pinned in tests/golden/twig.json
// (each row cites the Twig 1.35.4 source line) and checked by
// tests/unit/twig-semantics.test.mjs. The deviations of twig.js 3.0.0 that
// the spike found (evidence/T-02-twig-spike.md) are fixed here, once:
//
//   1. autoescape is off by default in twig.js; Twig 1.35 defaults to `html`.
//   2. `./x` template names resolve against the including template, but the
//      PHP loader resolves every name from the templates root.
//   3. booleans print as `true`/`false`; PHP prints `1` and the empty string.
//   4. the `default` filter ignores `false` and empty arrays; Twig's does not.
//   5. a template error is only logged unless `rethrow` is on.
//   6. the Twig lexer swallows one newline after a comment close (Lexer.php:69);
//      twig.js keeps it. Only a newline directly after a `{# ... #}` comment is
//      dropped. Comment whitespace control (`{#-`, `-#}`) is NOT supported; the
//      18 active templates do not use it, so this is not exact lexer parity.
//
// The patches rely on twig.js 3.0.0 internals (T.output, T.path.relativePath,
// Templates.parsers.twig), so the module refuses to load on any other version.
//
// twig.js already emits `&#039;` for `'` (same as htmlspecialchars with
// ENT_QUOTES), so no escape override is needed (X-9: not required).
import { createRequire } from 'node:module';
import { join, normalize, sep } from 'node:path';

const require = createRequire(import.meta.url);
const EXPECTED_TWIG_VERSION = '3.0.0';
const installedVersion = require('twig/package.json').version;
if (installedVersion !== EXPECTED_TWIG_VERSION) {
  throw new Error(
    `twig-config.mjs patches twig.js ${EXPECTED_TWIG_VERSION} internals; found ${installedVersion}. `
    + 'Re-verify the patches and tests/golden/twig.json before changing the version.',
  );
}
const Twig = require('twig');

export const TWIG_OPTIONS = Object.freeze({
  autoescape: 'html',
  strict_variables: false,
  rethrow: true,
});

const PATCHED = Symbol.for('results-dashboard.twig-config.patched');

// Twig_Extension_Core `_twig_default_filter` / `twig_test_empty`
// (lib/Twig/Extension/Core.php:800-807, 1459-1470).
function isTwigEmpty(value) {
  if (value === undefined || value === null || value === '' || value === false) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (value instanceof String) return value.length === 0; // empty Twig_Markup is Countable, count 0
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.keys(value).length === 0; // empty Twig hash = PHP array()
  }
  return false;
}

function applyPatches() {
  if (Twig[PATCHED]) return;
  Twig.cache(false);
  Twig.extend((T) => {
    // (3) PHP `echo`: true -> "1", false -> "" (PHP manual, language.types.string).
    const output = T.output;
    T.output = function phpEchoOutput(parts) {
      return output.call(this, parts.map((p) => (p === true ? '1' : p === false ? '' : p)));
    };

    // (2) Every template name resolves from the templates root (the PHP
    // Twig_Loader_Filesystem looks into `$path.'/'.$shortname`, Filesystem.php:212-223).
    const relativePath = T.path.relativePath;
    T.path.relativePath = function rootRelativePath(template, file) {
      if (template.path && template.base !== undefined) {
        const name = String(file || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
        const resolved = normalize(join(template.base, name));
        const root = normalize(template.base + sep);
        if (!resolved.startsWith(root)) {
          throw new T.Error(`Template name escapes the templates root: ${file}`);
        }
        return resolved;
      }
      return relativePath.call(this, template, file);
    };

    // (6) Twig_Lexer `lex_comment` ends with an optional newline: the newline
    // after a comment close is dropped (Lexer.php:69).
    const parseTwig = T.Templates.parsers.twig;
    T.Templates.registerParser('twig', (params) => parseTwig(
      typeof params.data === 'string'
        ? { ...params, data: params.data.replace(/\{#[\s\S]*?#\}\n/g, (m) => m.slice(0, -1)) }
        : params,
    ));
  });

  // (4) Twig `default`: '' , false, null, undefined and empty arrays; not "0" or 0.
  Twig.extendFilter('default', (value, params) => {
    if (params !== undefined && params.length > 1) {
      throw new Error('default filter expects one argument');
    }
    if (isTwigEmpty(value)) return params === undefined ? '' : params[0];
    return value;
  });

  Twig[PATCHED] = true;
}

/**
 * Create a renderer for one templates root (e.g. `src/templates` or
 * `reference/templates-original`). Names are given relative to that root.
 */
export function createRenderer({ templatesRoot }) {
  applyPatches();
  return {
    render(name, context = {}) {
      const template = Twig.twig({
        path: join(templatesRoot, name),
        base: templatesRoot,
        async: false,
        ...TWIG_OPTIONS,
      });
      return template.render(context);
    },
    renderString(source, context = {}) {
      return Twig.twig({ data: source, ...TWIG_OPTIONS }).render(context);
    },
  };
}

export { Twig };
