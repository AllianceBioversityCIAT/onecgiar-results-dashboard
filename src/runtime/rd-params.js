// Runtime parameters (design.md 6, 8; DD-15). Classic script in <head>, after legacy-compat.js.
// Resolves the five query keys with URLSearchParams + lastValue and defines window.appConfig
// with the same keys and types as the original inline block, strings HTML-escaped like Twig.
//
// Pure part: rdComputeParams(search, data). `data` is the DOMStringMap of this script tag
// (data-rd-production, -tableau-view, -tableau-view-new, -force-refresh).
// Returns the literal (unescaped) values for titles/links plus the escaped appConfig.
function rdComputeParams(search, data) {
  var q = new URLSearchParams(search);
  var year = lastValue(q, 'year');
  var entity = lastValue(q, 'entity');
  var origin = lastValue(q, 'hostOrigin');
  var embed = lastValue(q, 'embed') === 'true';
  // Absent year defaults to 2021; a present value, "" included, is kept literally.
  year = year === null ? '2021' : year;
  entity = entity === null ? '' : entity;
  origin = origin === null ? '' : origin; // PHP null is rendered by Twig as ""
  return {
    year: year,
    entity: entity,
    hostOrigin: origin,
    embed: embed,
    displayNav: embed ? lastValue(q, 'displayNav') === 'true' : true,
    appConfig: {
      production: data.rdProduction === 'true',
      tableauView: twigEscapeHtml(data.rdTableauView || ''),
      tableauViewNew: twigEscapeHtml(data.rdTableauViewNew || ''),
      hostOrigin: twigEscapeHtml(origin),
      entitySelected: twigEscapeHtml(entity),
      yearSelected: twigEscapeHtml(year),
      forceRefresh: data.rdForceRefresh === 'true'
    }
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.currentScript) {
  window.appConfig = rdComputeParams(window.location.search, document.currentScript.dataset).appConfig;
}
