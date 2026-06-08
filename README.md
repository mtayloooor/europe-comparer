# 🧭 Europe Trip Comparator

A lightweight, responsive single-page app for comparing **variants** of a
multi-city trip by **total cost** and **total travel time**. Build a route once,
spin up alternative orderings / travel methods, and watch the dashboard and map
update instantly.

No build step — open `index.html` in a browser, or serve the folder with any
static server.

```bash
# optional: serve locally (recommended so localStorage + tiles behave)
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Features

- **Trip endpoints & flights** — Origin (A) and Final Destination (B), each with
  a manually editable flight **cost** and **time** into and out of the trip.
- **Key destinations** — define the core cities (4+ recommended) that form the
  body of the trip. Known European cities auto-fill map coordinates.
- **Day trips** — attach a same-day loop to any key destination. Inputs are
  one-way by default and automatically **doubled** for the round trip (toggle off
  if you enter the full loop cost/time yourself).
- **Variant comparison engine**
  - Create / duplicate / rename multiple variants of the same trip.
  - Reorder key destinations per variant (▲ / ▼).
  - Pick a travel **method** per leg (Flight ✈️, Train 🚆, Bus 🚌, Car 🚗, Ferry ⛴️).
  - **Data inheritance:** leg estimates live in a global library keyed by
    `pair + method`, so an identical leg shared across variants carries its
    cost/time over automatically. Editing a shared leg prompts you to apply the
    change **globally** or **only to this variant**.
- **Dashboard** — quick-toggle variant tabs plus a side-by-side comparison grid
  showing total price, total time, the cheapest 💰 / fastest ⚡ badges, and the
  delta vs. the cheapest option.
- **Map** — draws Origin → key destinations (in order) → Final Destination, with
  day trips plotted as dashed branches off their parent city.
- **Autofill Estimates** — fills realistic mock cost/time for every empty leg,
  flight, and day trip based on travel type so you can see the engine work fast.
- **Persistence** — state is saved to `localStorage` on every change, plus JSON
  **Export** / **Import** for sharing or backup.

## Map provider

The map uses **Leaflet + OpenStreetMap** by default (no credentials needed) and
is structured behind a provider-agnostic `MapController` so it can be swapped for
**Apple MapKit JS** with no app changes:

1. Add the MapKit script to `index.html`:
   ```html
   <script src="https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.js"></script>
   ```
2. Expose a MapKit JWT, e.g. `window.MAPKIT_TOKEN = '...'`.
3. In `js/app.js`, set the map config `provider: 'mapkit'`.

The `MapKitAdapter` in `js/map.js` already mirrors the Leaflet adapter
(markers → `MarkerAnnotation`, route → `PolylineOverlay`, day-trip branches →
dashed `PolylineOverlay`).

## Project structure

```
index.html      # markup + CDN deps (Tailwind, Vue 3, Leaflet)
styles.css      # small custom styles on top of Tailwind
js/cities.js    # built-in European city gazetteer (name -> lat/lng)
js/models.js    # data models, factories, leg-key helpers, totals, persistence
js/map.js       # MapController: Leaflet adapter + Apple MapKit JS adapter
js/app.js       # Vue 3 application wiring it all together
```

## Data model

See the header comment in `js/models.js` for the full schema. In brief:

- **Leg estimates** are stored in a global `legLibrary` keyed by
  `"<sortedPair>::<method>"`, which is what enables cross-variant inheritance.
- A **variant** holds an ordered list of destination ids, a method per pair, and
  optional per-variant `overrides` for legs that intentionally diverge from the
  global value.
