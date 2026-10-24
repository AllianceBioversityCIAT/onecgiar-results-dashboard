// Legacy compatibility core (design.md 7.7, 8). Plain declarations, no exports.
// Last value of a key from a URLSearchParams-like object (getAll), or null (P-24).
function lastValue(params, key) {
  var all = params.getAll(key);
  return all.length > 0 ? all[all.length - 1] : null;
}

// Numeric string: optional PHP whitespace, sign, digits with optional fraction
// (or leading-dot fraction), optional exponent. No hex. Empty string is false (P-23).
/* @edge */
function isNumericYear(v) {
  return typeof v === 'string' &&
    /^[ \t\n\r\v\f]*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?[ \t\n\r\v\f]*$/.test(v);
}

/* @edge */
function yearAfter2017(v) {
  return isNumericYear(v) && Number(v) > 2017;
}

// Year radio check: "" entry matches only ""; integer entry matches a numeric string of equal value.
function yearMatches(siteValue, selected) {
  if (siteValue === '') { return selected === ''; }
  return isNumericYear(selected) && Number(selected) === siteValue;
}

// Twig 1.35 html strategy: htmlspecialchars(ENT_QUOTES | ENT_SUBSTITUTE) (P-22).
function twigEscapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
