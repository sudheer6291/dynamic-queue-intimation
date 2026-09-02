// Generic time / formatting helpers. No domain words here.

export function parseISOToMin(iso) {
  // "YYYY-MM-DDTHH:MM:SS+05:30" -> minutes since midnight of that date
  const t = iso.split("T")[1];
  const [hh, mm] = t.split(":").map(Number);
  return hh * 60 + mm;
}

export function minToHHMM(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

export function minOfDayToISO(dateStr, min, tz) {
  const m = Math.round(min);
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${dateStr}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00${tz}`;
}

export function fmtDuration(min) {
  if (min == null || Number.isNaN(min)) return "--";
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h} hr` : `${h} hr ${rem} min`;
}

export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}
