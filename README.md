# 🧭 Europe Trip Comparator

A lightweight, responsive single-page app for comparing **variants** of a
multi-city trip by **total cost** and **total travel time**. Build the trip
scaffolding once, spin up alternative itineraries, and watch the dashboard and
map update instantly.

No build step — open `index.html` in a browser, or serve the folder with any
static server.

```bash
# optional: serve locally (recommended so map tiles + routing behave)
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Layout

The UI is split into two clearly separated zones:

- **🛠️ Global Setup** (shared by all variants) — collapsible **Key Destinations**
  and **Day Trips** sections. These define the building blocks of the trip.
- **🧩 Variant** (per active variant) — **Endpoints & Flights**, **Legs & Route
  Order**, and **Variant Costs**. Everything here can differ between variants.

## Features

### Place search (geocoding)
Origin, destination, key-destination and day-trip fields are **live search
boxes**, not a fixed list — type any place (e.g. *Sestri Levante*) and pick from
real geocoded results, which sets the map coordinates. Powered by
[Photon](https://photon.komoot.io) (free, CORS, no key) over OpenStreetMap data,
with the built-in gazetteer as an offline fallback. A ⚠ marker shows when a
field has text but no resolved map location yet. See `js/geocode.js` /
`js/place-search.js`.

### Global setup
- **Key destinations** — define the core cities (4+ recommended). Search and
  pick real places; coordinates are filled automatically. Collapsible.
- **Day trips** — attach a same-day loop to any key destination. Inputs are
  one-way by default and automatically **doubled** for the round trip (toggle off
  if you enter the full loop cost/time yourself). Collapsible.

### Per-variant configuration
- **Endpoints & Flights** — the cities you **fly into** (arrival) and **out of**
  (departure), plus the editable **cost + time** of those inbound/outbound
  flights. Endpoints live on the variant, so they can differ between itineraries.
  A **"Copy from…"** dropdown clones another variant's endpoints/flights in one
  click. The inbound/outbound flights are cost/time only — they aren't drawn on
  the map (the home location is outside it).
- **Variant costs** — arbitrary named line items unique to a variant (e.g. car
  hire, rail pass), added to that variant's total only.
- **Legs & route order** — the journey is a chain of legs: **arrival city → first
  destination → … → last destination → departure city**. Travel from an endpoint
  to the nearest destination is a full leg with its own method/cost/time, just
  like the inter-destination legs. Reorder the key destinations by **dragging the
  handle**, and pick a travel **method** per leg (Flight, Train, Bus, Car, Ferry).

### Comparison engine
- Create / duplicate / rename multiple variants via the tabs.
- **Data inheritance:** leg estimates live in a global library keyed by
  `pair + method`, so an identical leg shared across variants carries its
  cost/time over automatically. Editing a shared leg prompts you to apply the
  change **globally** or **only to this variant**.
- **Dashboard** — side-by-side comparison grid showing total price, total time,
  cheapest 💰 / fastest ⚡ badges, and the delta vs. the cheapest option.

### Map
- Draws Origin → key destinations (in variant order) → Final Destination, with
  day trips plotted as dashed branches off their parent city.
- **Lines reflect the travel method:**
  - **Car / Bus** → real driving route via OSRM (follows the road network).
  - **Flight** (in/out and any flight leg) → straight line, dashed.
  - **Train** → straight line for now (see *Transit routing* below).
  - Any leg that can't be routed (e.g. offline) falls back to a dashed straight
    line.
- A legend maps each colour to its travel method.

### Map providers — OpenStreetMap ⇄ Apple Maps
Toggle between **Leaflet/OpenStreetMap** (default, no credentials) and **Apple
MapKit JS** with the header switch.

Apple MapKit JS only renders with a signed developer **JWT token**. The first
time you switch to Apple, the app prompts you to paste one (🔑 button to
replace it later). The token is stored in `localStorage` **and included in
Export/Import** so it travels with your configuration.

> ⚠️ The token is saved in plain text in localStorage and in the exported JSON.
> Treat export files as sensitive and don't commit them to a public repo.

Get a token at *developer.apple.com → Certificates, IDs & Profiles → Maps IDs /
Keys* (requires an Apple Developer account). Tokens expire, so you'll re-enter
periodically.

### Data management
- Every leg / flight / day trip / variant cost has editable cost + duration
  inputs.
- **Autofill Estimates** fills realistic mock values per travel type for any
  empty leg, flight, or day trip.
- State persists to `localStorage` on every change, plus JSON **Export/Import**.

## Icons

UI icons use the free [Lucide](https://lucide.dev) set via the
[Iconify](https://iconify.design) web component (`<iconify-icon icon="lucide:…">`),
registered as a Vue custom element and wrapped by a small `<app-icon>` helper.
Icons are fetched on demand from the Iconify CDN and cached; they can be bundled
for fully offline use later. A few emoji are intentionally kept in the
**Variant Comparison Dashboard** (📊 / 💰 cheapest / ⚡ fastest).

## Transit (Train / public-transport) routing

True rail/PT route geometry isn't available from a free API, and **Apple MapKit
JS has no transit directions** (Automobile/Walking only). **Google Maps can**
return transit polylines (Directions API / Routes API `mode=transit`, or the
Maps JS `DirectionsService` with `travelMode: TRANSIT`), **but**:

1. requires an API key with **billing enabled**;
2. the REST Directions API is **server-side only** (browser CORS) → needs a proxy;
3. Google's ToS requires Google-derived geometry to be displayed **on a Google
   map**, so drawing it on Leaflet/Apple is non-compliant.

So Train legs use straight lines for now. The code is structured for a drop-in
transit provider — assign an async function to `RouteService.transitProvider`
(see `js/routing.js`) and Train/Bus legs will use it.

## Project structure

```
index.html      markup + CDN deps (Tailwind, Vue 3, Leaflet, MapKit JS, Iconify)
styles.css      small custom styles on top of Tailwind
js/cities.js    built-in European city gazetteer (offline geocode fallback)
js/geocode.js   GeoSearch: place search / geocoding via Photon (+ gazetteer fallback)
js/place-search.js  <place-search> Vue autocomplete component (auto-flips up near the bottom)
js/models.js    data models, factories, leg helpers, totals, persistence, migration
js/routing.js   RouteService: per-method leg geometry (OSRM driving / straight / transit hook)
js/map.js       MapController: Leaflet adapter + Apple MapKit JS adapter
js/app.js       Vue 3 application wiring it all together
```

## Data model (schema v2)

See the header comment in `js/models.js` for the full schema. In brief:

- **Endpoints, flights, and extra costs are per-variant.** Day trips, key
  destinations and the leg-estimate library are global.
- **Leg estimates** live in a global `legLibrary` keyed by
  `"<sortedPair>::<method>"`, which enables cross-variant inheritance. A variant
  may carry per-leg `overrides` to intentionally diverge from the global value.
- Older (v1) saved/imported data is migrated automatically on load.
