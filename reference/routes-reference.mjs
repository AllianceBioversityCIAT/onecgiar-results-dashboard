// R1 reference route (FR-23, DD-09). Written ONLY from the original
// resultsDashboard-prod/resultsDashboard/app/routes.php, the `/[{actionName}]` route (lines 6-45 of
// the route body). It shares no code with the migrated side: no import from src/ and none from
// scripts/ (this file imports nothing at all; the Twig engine is configured by the caller through
// scripts/twig-config.mjs, the only shared piece, DD-09).
//
// The values that routes.php takes from ControlListService / settings (sections, crps, years,
// chartsInfo, messages, dataUrl, appConfig) are DATA, supplied by the caller in `data`.
//
// Declared assumptions (design 10.2 "declared R1 limit"):
//  - `$yearSelected > 2017` follows PHP 7 loose comparison (non-numeric string -> its leading
//    numeric prefix, else 0). It agrees with PHP 8 for numeric strings; for `abc` and `""` PHP 8
//    behavior is not settled by the manuals (P-20, D19), and this oracle uses the PHP 7 result,
//    which equals decision D19 (legacy variant) on the matrix values.
//  - Query parsing follows parse_str for plain keys (last duplicate wins, `+` is a space,
//    percent-decoding). Bracketed keys (`year[]`) are not modeled; the matrix has none.
//  - The widget route and the 404 page are not part of R1 (the original has no 404 page).

// parse_str subset: plain keys only; invalid percent escapes stay literal like PHP's urldecode.
function urldecode(s) {
  return s.replace(/\+/g, ' ').replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function utf8Decode(s) {
  // urldecode above yields one char per byte; re-read the bytes as UTF-8 (PHP strings are bytes).
  const bytes = Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return s;
  }
}

function decodeComponent(raw) {
  // Only percent-escapes can produce bytes above 0x7f; literal non-ASCII input is kept as is.
  if (/[^\x00-\x7f]/.test(raw)) return urldecode(raw);
  return utf8Decode(urldecode(raw));
}

export function parseQuery(query) {
  const out = {};
  for (const part of String(query || '').split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const key = decodeComponent(eq === -1 ? part : part.slice(0, eq));
    const value = eq === -1 ? '' : decodeComponent(part.slice(eq + 1));
    if (key.includes('[')) continue; // arrays are not modeled
    out[key] = value;
  }
  return out;
}

// PHP 7 `$value > 2017` for an int or a string.
function phpGreaterThan2017(value) {
  if (typeof value === 'number') return value > 2017;
  const m = /^[ \t\n\r\v\f]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(value);
  const n = m ? Number(m[0]) : 0;
  return n > 2017;
}

/**
 * @param {{path: string, query: string, data: object}} request  raw path ("/innovations") and raw query
 * @returns {{template: string, context: object}}
 */
export function routeReference({ path, query, data }) {
  const params = parseQuery(query);
  const get = (k) => (Object.prototype.hasOwnProperty.call(params, k) ? params[k] : null);

  const entityParam = get('entity');
  const entitySelected = entityParam !== null ? entityParam : '';

  const yearParam = get('year');
  const yearSelected = yearParam !== null ? yearParam : 2021;

  const sections = data.sections;
  const segment = path.replace(/^\/+/, '');
  const currentSection = segment !== '' ? segment : sections[0].action;
  let currentView = currentSection;
  let forceRefresh = false;
  if (currentSection === 'partnerships') {
    if (phpGreaterThan2017(yearSelected)) currentView = currentSection + '-2018';
    forceRefresh = true;
  }
  const glossarySection = currentSection === 'glossary';

  const embed = get('embed') === 'true';
  const hostOrigin = get('hostOrigin'); // null when absent: Twig prints it as ""
  let queryParams = '';
  let displayNav = true;
  if (embed) {
    displayNav = get('displayNav') === 'true';
    queryParams = 'embed=true&hostOrigin=' + (hostOrigin === null ? '' : hostOrigin)
      + '&displayNav=' + (displayNav ? 'true' : 'false');
  }

  return {
    template: currentView + '.twig',
    context: {
      sections,
      crps: data.crps,
      years: data.years,
      chartsInfo: data.chartsInfo,
      messagesArray: data.messages,
      dataUrl: data.dataUrl,
      currentSection,
      entitySelected,
      yearSelected,
      forceRefresh,
      embed,
      displayNav,
      hostOrigin,
      appConfig: data.appConfig,
      queryParams,
      glossarySection,
    },
  };
}
