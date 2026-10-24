// Routing rules core (design.md 7.3). Plain top-level declarations, no exports, no I/O,
// cloudfront-js-2.0-compatible syntax (ES5 constructs only). Pure: the same request and mode
// always give the same result. Data comes from the global RD_DATA, injected at load time:
//   RD_DATA = { sections: [17 section names], legacyRedirects: { name: '/target' } }
// and the global RD_CANONICAL_HOST (string): rule 1 redirects other hosts to it in 'edge' mode; the empty
// string disables rule 1. Every loader defines it; the generated edge source declares it before this file.
// The year logic is reused from legacy-compat.core.js (yearAfter2017).
//
// resolve(request, mode)
//   request = { method, host, path, query, params }
//     path   raw path component exactly as received (percent-encoded, no query)
//     query  raw query string without '?'
//     params parsed query map { key: lastValue } (string values) built by the adapter
//   mode    'local' | 'edge' (rule 1 is active only in 'edge')
// Result (exactly one): { type: 'rewrite', status: 200, file }
//   { type: 'redirect', status: 301, location } | { type: 'badRequest', status: 400 }
//   { type: 'methodNotAllowed', status: 405 } | { type: 'notFound', status: 404 } | { type: 'pass' }

function rulesHas(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function rulesIsSection(name) {
  var list = RD_DATA.sections;
  for (var i = 0; i < list.length; i++) {
    if (list[i] === name) { return true; }
  }
  return false;
}

function rulesParam(params, key) {
  return params && rulesHas(params, key) ? params[key] : null;
}

function rulesHex2(code) {
  var h = code.toString(16).toUpperCase();
  return h.length < 2 ? '0' + h : h;
}

// Rule 0a: input that cannot be handled safely (400).
function rulesBadPath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.charAt(0) !== '/') { return true; }
  for (var i = 0; i < path.length; i++) {
    var c = path.charCodeAt(i);
    if (c < 0x21 || c > 0x7e) { return true; }
    if (c === 0x23 || c === 0x5e || c === 0x7c) { return true; }
  }
  var decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch (e) {
    return true;
  }
  return decoded.indexOf('\u0000') !== -1;
}

// Rule 0b: open-redirect and dot-segment shapes (404). Expects a path that passed rule 0a.
function rulesTraversal(path) {
  if (path.indexOf('//') === 0 || path.indexOf('\\') !== -1) { return true; }
  if (/%2f|%5c/i.test(path)) { return true; }
  var segs = path.split('/');
  for (var i = 0; i < segs.length; i++) {
    var d = decodeURIComponent(segs[i]);
    if (d === '.' || d === '..') { return true; }
  }
  return false;
}

// Section name of "{section}.html", "{section}--embed.html" or "{section}--embed-nonav.html", else null.
function rulesHtmlSection(name) {
  if (name.length <= 5 || name.substring(name.length - 5) !== '.html') { return null; }
  var base = name.substring(0, name.length - 5);
  if (base.length > 13 && base.substring(base.length - 13) === '--embed-nonav') {
    base = base.substring(0, base.length - 13);
  } else if (base.length > 7 && base.substring(base.length - 7) === '--embed') {
    base = base.substring(0, base.length - 7);
  }
  return rulesIsSection(base) ? base : null;
}

// Mappings of rules 6, 7 and 9 for a decoded one-segment name: a plain ASCII target or null.
function rulesMapName(name) {
  if (name === 'action') { return '/'; }
  if (rulesHas(RD_DATA.legacyRedirects, name)) { return RD_DATA.legacyRedirects[name]; }
  var section = rulesHtmlSection(name);
  return section === null ? null : '/' + section;
}

// The characters of the WHATWG path percent-encode set that rule 0a lets through.
function rulesEncodePath(path) {
  return path.replace(/["<>`{}]/g, function (ch) {
    return '%' + rulesHex2(ch.charCodeAt(0));
  });
}

// Query bytes < 0x21, 0x7F, non-ASCII and '#' become %XX (uppercase); everything else is copied.
function rulesEncodeQuery(query) {
  var out = '';
  for (var i = 0; i < query.length; i++) {
    var c = query.charCodeAt(i);
    if (c < 0x21 || c === 0x7f || c === 0x23) {
      out += '%' + rulesHex2(c);
    } else if (c > 0x7f) {
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < query.length &&
          query.charCodeAt(i + 1) >= 0xdc00 && query.charCodeAt(i + 1) <= 0xdfff) {
        out += encodeURIComponent(query.substring(i, i + 2));
        i++;
      } else if (c >= 0xd800 && c <= 0xdfff) {
        out += '%EF%BF%BD';
      } else {
        out += encodeURIComponent(query.charAt(i));
      }
    } else {
      out += query.charAt(i);
    }
  }
  return out;
}

// Terminal target (Y-1, Z-4): path of a redirect that is already final, plus the encoded query.
function rulesTerminalTarget(rawPath, query) {
  var p = rawPath.replace(/\/+$/, '');
  var target;
  if (p === '') {
    target = '/';
  } else {
    target = null;
    if (p.indexOf('/', 1) === -1) {
      target = rulesMapName(decodeURIComponent(p.substring(1)));
    }
    if (target === null) { target = rulesEncodePath(p); }
  }
  return query.length > 0 ? target + '?' + rulesEncodeQuery(query) : target;
}

function rulesRedirect(location) {
  return { type: 'redirect', status: 301, location: location };
}

// Variant file (7.2): query decides normal / embed / embed-nonav; partnerships picks the year variant.
function rulesVariantFile(name, params) {
  var base = name;
  if (name === 'partnerships') {
    var year = rulesParam(params, 'year');
    if (year !== null && !yearAfter2017(year)) { base = 'partnerships-2017'; }
  }
  var suffix = '';
  if (rulesParam(params, 'embed') === 'true') {
    suffix = rulesParam(params, 'displayNav') === 'true' ? '--embed' : '--embed-nonav';
  }
  return { type: 'rewrite', status: 200, file: base + suffix + '.html' };
}

function resolve(request, mode) {
  var path = request.path;
  var query = typeof request.query === 'string' ? request.query : '';
  if (rulesBadPath(path)) { return { type: 'badRequest', status: 400 }; }
  if (rulesTraversal(path)) { return { type: 'notFound', status: 404 }; }
  if (mode === 'edge' && RD_CANONICAL_HOST !== '' && request.host !== RD_CANONICAL_HOST) {
    return rulesRedirect('https://' + RD_CANONICAL_HOST + rulesTerminalTarget(path, query));
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return { type: 'methodNotAllowed', status: 405 };
  }
  if (path !== '/' && path.charAt(path.length - 1) === '/') {
    return rulesRedirect(rulesTerminalTarget(path, query));
  }
  var decoded = decodeURIComponent(path);
  if (decoded === '/') { return rulesVariantFile('home', request.params); }
  var name = decoded.substring(1);
  if (name.indexOf('/') === -1 && name.indexOf('.') === -1) {
    if (rulesIsSection(name)) { return rulesVariantFile(name, request.params); }
    if (rulesMapName(name) !== null) { return rulesRedirect(rulesTerminalTarget(path, query)); }
    return { type: 'notFound', status: 404 };
  }
  if (name.substring(name.length - 5) === '.html') {
    if (rulesHtmlSection(name) !== null) { return rulesRedirect(rulesTerminalTarget(path, query)); }
    return { type: 'notFound', status: 404 };
  }
  return { type: 'pass' };
}
