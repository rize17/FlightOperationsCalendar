/* Flight Operations Calendar API — Cloudflare Worker.
 *
 * Holds the calendar: pilots, mission types (each with a colour) and
 * bookings. The page is public on GitHub Pages and holds no data of its
 * own; everything it shows comes from here, and only with a key.
 *
 * Two keys, both sent in the X-API-Key header:
 *   edit key   — read everything, and add, change and remove bookings,
 *                pilots and mission types. Ops use this one.
 *   view key   — optional. Read only, for crew who just need to see the
 *                schedule. Leave VIEW_KEY unset and only the edit key works.
 *
 * The Offshore Tools keys work here too, so one key opens every tool:
 * OFFSHORE_ADMIN_KEY gets edit, OFFSHORE_VIEW_KEY gets view. Both are
 * optional, and set to the same values as the offshoretools-api worker.
 * The header rather than the query string keeps keys out of Cloudflare's
 * request logs and out of browser history.
 *
 * Bindings this expects:
 *   FLIGHTOPS  KV namespace (from wrangler.toml)
 *   EDIT_KEY   secret, set in the dashboard (required)
 *   VIEW_KEY   secret, set in the dashboard (optional)
 *   OFFSHORE_ADMIN_KEY, OFFSHORE_VIEW_KEY   secrets (optional)
 *
 * Every write names one record and the worker merges it into the stored
 * calendar. There is no endpoint that replaces the whole calendar, so a tab
 * left open for a week cannot revert anyone's changes.
 *
 * Times are South Africa local time (SAST, UTC+2, no daylight saving) as
 * "YYYY-MM-DDTHH:mm" strings. With one fixed zone, plain strings compare and
 * sort correctly and nobody's browser zone can shift a booking.
 */

const STORE = "calendar:v1";
const MAX_BOOKINGS = 5000;
const MAX_LIST = 100;             // pilots, and mission types, each
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d$/;
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const COLOUR = /^#[0-9a-fA-F]{6}$/;

/* A new calendar starts with the four mission types the old site had, so it
   is usable before anyone opens Manage lists. Pilots start empty. */
const DEFAULT_TYPES = [
  { id: "crew-change", name: "Crew change", color: "#9169b0" },
  { id: "medivac", name: "Medivac", color: "#c85b5b" },
  { id: "petrosa", name: "PetroSA", color: "#398da5" },
  { id: "maintenance", name: "Maintenance", color: "#d39e4b" }
];

/* Keys prefer runtime secrets and fall back to values in KV under auth:edit
   and auth:view. Ship ETA once lost the ability to set secrets after an
   accidental static-assets deploy; the fallback is the way back in if that
   ever happens here. It costs a KV read only when a secret is missing. */
async function keys(env) {
  return {
    edit: env.EDIT_KEY || await env.FLIGHTOPS.get("auth:edit"),
    view: env.VIEW_KEY || await env.FLIGHTOPS.get("auth:view")
  };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
  "Access-Control-Max-Age": "86400"
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS }
  });

/* Constant time, so the response can't be timed to guess a key a character
   at a time. */
function sameKey(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const empty = () => ({ pilots: [], types: DEFAULT_TYPES.slice(), bookings: [], updated: 0 });

async function load(env) {
  const raw = await env.FLIGHTOPS.get(STORE);
  if (!raw) return empty();
  try {
    const v = JSON.parse(raw);
    return {
      pilots: Array.isArray(v.pilots) ? v.pilots : [],
      types: Array.isArray(v.types) ? v.types : [],
      bookings: Array.isArray(v.bookings) ? v.bookings : [],
      updated: v.updated || 0
    };
  } catch (_) {
    return empty();
  }
}

async function save(env, cal) {
  cal.updated = Date.now();
  await env.FLIGHTOPS.put(STORE, JSON.stringify(cal));
  return cal;
}

const text = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const byName = (a, b) => a.name.localeCompare(b.name);

/* A real calendar time, not just the right shape: 2026-02-30 is refused. */
function validTime(v) {
  if (typeof v !== "string" || !TIME.test(v)) return false;
  const d = new Date(v + ":00Z");
  return !isNaN(d) && d.toISOString().slice(0, 16) === v;
}

/* Returns the booking to store, or a string saying what's wrong. */
function cleanBooking(body, id, cal) {
  const start = body.start, end = body.end;
  if (!validTime(start) || !validTime(end)) return "the start and end must be real dates and times";
  if (end <= start) return "the end must be later than the start";

  const type = cal.types.find(t => t.id === body.typeId);
  if (!type) return "choose a mission type";

  const p1 = typeof body.pilot1Id === "string" ? body.pilot1Id : "";
  const p2 = typeof body.pilot2Id === "string" ? body.pilot2Id : "";
  for (const p of [p1, p2]) if (p && !cal.pilots.some(x => x.id === p)) return "that pilot is no longer on the list";
  if (p1 && p1 === p2) return "the two pilots must be different people";
  // Either pilot may be left blank: a booking is often made before anyone
  // knows who's flying it.

  return {
    id,
    title: text(body.title, 160) || type.name,
    start, end,
    typeId: type.id,
    pilot1Id: p1, pilot2Id: p2,
    notes: text(body.notes, 2000)
  };
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const path = new URL(req.url).pathname.replace(/\/+$/, "");

    /* Plain text and before the key check, so a phone can tell a broken
       deploy from a working one. Says what is wired up, never what a key is. */
    if (path === "/health") {
      const kv = !!env.FLIGHTOPS;
      const k = kv ? await keys(env) : { edit: env.EDIT_KEY, view: env.VIEW_KEY };
      let held = "?";
      if (kv) {
        try {
          const c = await load(env);
          held = c.bookings.length + " bookings, " + c.pilots.length + " pilots, " + c.types.length + " mission types";
        } catch (_) { held = "unreadable"; }
      }
      return new Response(
        "flightops-api is running\n" +
        "KV bound:    " + (kv ? "yes" : "NO - bind the namespace as FLIGHTOPS") + "\n" +
        "edit key:    " + (k.edit ? "set" : "NOT SET - add the EDIT_KEY secret") + "\n" +
        "view key:    " + (k.view ? "set" : "not set (optional - only the edit key works)") + "\n" +
        "offshore:    " + (env.OFFSHORE_ADMIN_KEY ? "admin key set" : "admin key not set") + ", " +
                          (env.OFFSHORE_VIEW_KEY ? "view key set" : "view key not set") + " (optional)\n" +
        "holding:     " + held + "\n",
        { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...CORS } });
    }

    /* An unset key must fail shut. Treating "no key configured" as "no key
       required" is how a private calendar quietly becomes a public one. */
    if (!env.FLIGHTOPS) return json({ error: "no KV namespace bound as FLIGHTOPS" }, 503);
    const k = await keys(env);
    if (!k.edit) return json({ error: "the edit key isn't configured on the worker" }, 503);

    const given = req.headers.get("X-API-Key") || "";
    // An empty key never matches, even against an empty or unset secret.
    const role = !given ? null
      : sameKey(given, k.edit) || sameKey(given, env.OFFSHORE_ADMIN_KEY) ? "edit"
      : sameKey(given, k.view) || sameKey(given, env.OFFSHORE_VIEW_KEY) ? "view" : null;
    if (!role) return json({ error: "bad or missing key" }, 401);

    const reply = cal => json({ ...cal, role });

    if (path === "/calendar" && req.method === "GET") return reply(await load(env));

    const m = /^\/(bookings|pilots|types)\/([^/]+)$/.exec(path);
    if (!m || (req.method !== "PUT" && req.method !== "DELETE")) return json({ error: "not found" }, 404);
    if (role !== "edit") return json({ error: "the edit key is needed to make changes" }, 403);

    const kind = m[1];
    const id = decodeURIComponent(m[2]);
    if (!ID.test(id)) return json({ error: "bad id" }, 400);

    const cal = await load(env);
    const list = cal[kind];
    const at = list.findIndex(x => x && x.id === id);

    if (req.method === "DELETE") {
      if (at < 0) return reply(cal);                 // already gone; not an error
      if (kind === "pilots" && cal.bookings.some(b => b.pilot1Id === id || b.pilot2Id === id))
        return json({ error: list[at].name + " is on bookings - change those first" }, 409);
      if (kind === "types" && cal.bookings.some(b => b.typeId === id))
        return json({ error: "bookings use " + list[at].name + " - change those first" }, 409);
      list.splice(at, 1);
      return reply(await save(env, cal));
    }

    let body;
    try { body = await req.json(); } catch (_) { return json({ error: "bad json" }, 400); }
    if (!body || typeof body !== "object") return json({ error: "expected an object" }, 400);

    if (kind === "bookings") {
      const b = cleanBooking(body, id, cal);
      if (typeof b === "string") return json({ error: b }, 400);
      if (at < 0 && list.length >= MAX_BOOKINGS) return json({ error: "the calendar is full" }, 413);
      if (at >= 0) list[at] = b; else list.push(b);
      list.sort((a, b) => a.start.localeCompare(b.start));
      return reply(await save(env, cal));
    }

    const name = text(body.name, 60);
    if (!name) return json({ error: "a name is needed" }, 400);
    if (list.some(x => x.id !== id && sameName(x.name, name))) return json({ error: name + " is already on the list" }, 409);
    if (at < 0 && list.length >= MAX_LIST) return json({ error: "the list is full" }, 413);

    let row;
    if (kind === "pilots") {
      row = { id, name };
    } else {
      const color = typeof body.color === "string" ? body.color.toLowerCase() : "";
      if (!COLOUR.test(color)) return json({ error: "pick a colour" }, 400);
      row = { id, name, color };
    }
    if (at >= 0) list[at] = row; else list.push(row);
    list.sort(byName);
    return reply(await save(env, cal));
  }
};
