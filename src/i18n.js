// Looks up UI strings from config.locale.strings. All vertical vocabulary
// (station names, resource names, action phrasing) lives in config — never
// hardcoded here, so a vertical swap only ever touches config + seed data.

export function makeTranslator(config, locale) {
  const loc = locale || (config.locale && config.locale.default) || "en";
  const strings = (config.locale && config.locale.strings) || {};
  return function t(key, vars) {
    const entry = strings[key];
    let text = entry ? entry[loc] || entry.en || key : key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) {
        text = text.replace(new RegExp(`\\{${k}\\}`, "g"), v);
      }
    }
    return text;
  };
}

// Resolve a name_key (from stations.json / resources.json / routes.json)
// through the same locale string table.
export function nameOf(config, locale, nameKey) {
  return makeTranslator(config, locale)(nameKey);
}
