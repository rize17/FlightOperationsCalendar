# Flight Operations Calendar

A shared month calendar of flight bookings (mission type, up to two pilots, times,
notes). It replaces a ChatGPT-built Next.js/D1 site with the same layout; this
repo shares no code with that or with the other offshore tools. See README.md
for the Cloudflare setup.

## Layout

`index.html` is the whole page. `worker/flightops-api.js` is a Cloudflare
Worker with one KV namespace bound as `FLIGHTOPS`, holding the whole calendar
as one JSON value under `calendar:v1`. The page is on GitHub Pages; the worker
is deployed separately by Workers Builds from the same repo.

## Conventions that matter

- **The page holds no data and no keys.** Everything comes from the worker,
  and only with a key in the `X-API-Key` header. The page is public and its
  source is readable.
- **Two keys, both dashboard secrets.** `EDIT_KEY` (required) reads and
  writes; `VIEW_KEY` (optional) only reads. The worker fails shut (503) if
  `EDIT_KEY` is unset. Never put either in `wrangler.toml`. KV `auth:edit` /
  `auth:view` are a fallback only, for the case Ship ETA hit where secrets
  couldn't be set on the worker.
- **The key is remembered, never expired.** It's in localStorage until the
  person chooses *Forget key* or the key stops working (401). Don't add
  timeouts or sessions: avoiding logging in is the reason this isn't a login.
- **Every write names one record.** `PUT`/`DELETE` on `/bookings/<id>`,
  `/pilots/<id>` or `/types/<id>`; the worker merges it into the stored
  calendar and returns the whole calendar. There is no endpoint that replaces
  the calendar, so a stale tab can't revert anyone's work.
- **Times are SAST wall-clock strings, `YYYY-MM-DDTHH:mm`.** South Africa has
  no daylight saving, so plain strings sort and compare correctly. The page
  reads them as if UTC (`at()`) and formats with `timeZone: "UTC"`, so the
  device's zone never shifts a booking. Don't introduce `Date` parsing in
  local time.
- **The worker is the judge of a booking.** The page checks the same rules
  first for a friendly message, but the worker refuses anything invalid: real
  dates, end after start, a known mission type, and pilots that are on the
  list and not the same person twice. Pilots are optional on every booking
  (often nobody's chosen yet); don't make them required again. A pilot
  double-booked is only a warning in the form, never a refusal.
- **Month layout is in `layoutWeek()`.** A bar spans the booking's exact
  times; a fixed 254px card sits centred under it. Bars and cards are packed
  into lanes separately and the week row grows to fit. Card positions depend
  on the grid's pixel width, so the month re-renders on resize.
- **Works with no signal.** The last calendar is kept on the device and shown
  immediately, then refreshed in the background, every minute while visible.
- **Bump the version on every functional change**, in all four places: the
  `<title>`, the `.version` span, `CACHE` in `sw.js`, and *Current* in README.
