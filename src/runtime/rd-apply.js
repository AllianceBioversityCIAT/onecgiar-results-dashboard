// Runtime DOM adjustments (design.md 8). Classic script at the end of <body>, before jQuery,
// after rd-params.js (uses rdComputeParams) and legacy-compat.js (yearMatches).
// Creates and removes no elements. Values are only ever assigned through textContent and
// setAttribute, never parsed as HTML (FR-07).

// Replace every sentinel with the literal hostOrigin. split/join is not a pattern replacement,
// so `$&`, `$'` and the backtick pattern in hostOrigin stay literal (X-8).
function rdReplaceSentinel(href, hostOrigin) {
  return href.split('RDHOSTORIGINSENTINEL').join(hostOrigin);
}

function rdApply(doc, p) {
  var i;
  var years = doc.querySelectorAll('input[name="years"]');
  for (i = 0; i < years.length; i++) {
    // The "All Years" entry keeps "", the others are integers (types as in site.json).
    var siteYear = years[i].value === '' ? '' : Number(years[i].value);
    years[i].checked = yearMatches(siteYear, p.year);
  }
  var crps = doc.querySelectorAll('input[name="crps"]');
  for (i = 0; i < crps.length; i++) {
    crps[i].checked = crps[i].value === p.entity;
  }
  var titleY = doc.querySelector('#filtertitley');
  if (titleY) { titleY.textContent = p.year === '' ? 'All Years' : p.year; }
  var titleC = doc.querySelector('#filtertitlec');
  if (titleC) { titleC.textContent = p.entity === '' ? 'Research Programs' : p.entity; }
  if (p.embed) {
    var links = doc.querySelectorAll('a[href*="RDHOSTORIGINSENTINEL"]');
    for (i = 0; i < links.length; i++) {
      links[i].setAttribute('href', rdReplaceSentinel(links[i].getAttribute('href'), p.hostOrigin));
    }
  }
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  rdApply(document, rdComputeParams(window.location.search, {}));
}
