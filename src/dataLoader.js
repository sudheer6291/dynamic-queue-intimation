// Loads a vertical's static JSON bundle. This is the only place that knows
// the six files exist; everything downstream just gets a plain object back.

export async function loadVertical(basePath) {
  const files = ["config", "stations", "resources", "routes", "entities", "events"];
  const results = await Promise.all(
    files.map((f) =>
      fetch(`${basePath}/${f}.json`, { cache: "no-store" }).then((r) => {
        if (!r.ok) throw new Error(`Failed to load ${basePath}/${f}.json: ${r.status}`);
        return r.json();
      })
    )
  );
  const [config, stations, resources, routes, entities, seedEvents] = results;
  return { config, stations, resources, routes, entities, seedEvents, basePath };
}

export async function listVerticals() {
  const res = await fetch("data/verticals.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load data/verticals.json");
  return res.json();
}
