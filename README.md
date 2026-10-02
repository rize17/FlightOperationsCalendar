# Flight Operations Calendar

A shared month calendar of flight operations: each booking has a mission type
(with its own colour), two pilots, start and end times, and notes. Each day is
drawn as a 24-hour strip with the night hours (18:00–06:00) shaded, so a
booking's bar shows its exact times across midnight and across days. On a
phone the **List** view shows the month as a list of bookings by day.

All times are South Africa time (SAST, UTC+2), whatever zone the device is in.

The page is public, but it shows nothing until a key is entered. The key is
typed once per device and remembered: there's no login and no timeout.

- **Edit key**: add, change and remove bookings, and manage the pilot and
  mission-type lists. Give this to ops.
- **View key** (optional): see the calendar and open bookings, but change
  nothing. Give this to crew.

⚙️ Settings changes the key or forgets it on that device.

## Rules the calendar keeps

- Every booking needs a mission type and an end later than its start.
- Every mission type except **Maintenance** needs two different pilots.
- A pilot already on an overlapping booking is pointed out in the form, but
  not refused.
- A pilot or mission type that's on a booking can't be removed until those
  bookings are changed.
- A new calendar starts with Crew change, Medivac, PetroSA and Maintenance.
  Add pilots in **Manage lists**.

## Files

```
index.html             the whole page - UI, storage and API calls
sw.js                  offline shell cache
manifest.webmanifest   home-screen install metadata
favicon.svg icon-192.png icon-512.png
worker/flightops-api.js   Cloudflare Worker holding the calendar (KV)
wrangler.toml worker/wrangler.toml   deploy config for the worker
```

No build step and no package manager.

## One-off Cloudflare setup

1. **KV namespace**: Cloudflare dashboard → Storage & Databases → Workers KV →
   *Create* → name it `flightops`. Copy its **ID** into *both*
   `wrangler.toml` and `worker/wrangler.toml` in place of
   `PASTE_KV_NAMESPACE_ID_HERE`, and push.
2. **Worker**: Workers & Pages → *Create* → *Import a repository* →
   `rize17/FlightOperationsCalendar`, root directory `/` (or `worker`). The
   name must be `flightops-api`, so that it is served at
   `https://flightops-api.ryantholliday.workers.dev` (the address
   `index.html` calls). A push then deploys it.
3. **Keys**: the worker → Settings → Variables and Secrets → add the
   **Secret** `EDIT_KEY`, and optionally `VIEW_KEY`. Make them different.
   Never put them in the repo.
4. **Check**: open `https://flightops-api.ryantholliday.workers.dev/health`.
   It should say KV bound: yes, and the edit key set.

Changing a key later is just editing the secret. Devices holding the old
key are sent back to the key screen on their next load.

## Deploying the page

Push to the branch GitHub Pages serves (Settings → Pages → *Deploy from a
branch*, root). `.nojekyll` keeps the files out of Jekyll.

Bump the version on every functional change, in all four places at once: the
`<title>`, the `.version` span, `CACHE` in `sw.js`, and *Current* below.

Current: **v1.0**.
