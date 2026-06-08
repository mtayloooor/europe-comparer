/**
 * models.js
 * Data models, factories and pure helpers for the trip comparator.
 * Exposed globally as window.Models.
 *
 * ── Data model overview ────────────────────────────────────────────────
 *
 * Place        { id, name, lat, lng, color? }
 * Flight       { cost:Number, duration:Number }            // hours
 * DayTrip      { id, destinationId, name, lat, lng,
 *                cost:Number, duration:Number, oneWay:Boolean }
 *
 * LegData      { cost:Number, duration:Number }            // shared estimate
 * legLibrary   { [methodKey]: LegData }                    // GLOBAL, inherited
 *                methodKey = "<sortedPairKey>::<method>"
 *                pairKey   = [fromId,toId].sort().join('-')  (direction-agnostic)
 *
 * Variant      { id, name,
 *                order:   [destId, ...],                   // sequence of key dests
 *                methods: { [pairKey]: method },           // travel method per pair
 *                overrides:{ [methodKey]: LegData } }       // per-variant exceptions
 *
 * State        { origin:Place, destination:Place,
 *                flightIn:Flight, flightOut:Flight,
 *                destinations:[Place], dayTrips:[DayTrip],
 *                legLibrary:{}, variants:[Variant], activeVariantId }
 *
 * Inheritance: leg estimates live in the GLOBAL legLibrary keyed by
 * methodKey, so any variant using the same pair + method automatically
 * shares the cost/duration. A variant may carry a local `override` to
 * break from the global value (chosen via the "update globally?" prompt).
 * ───────────────────────────────────────────────────────────────────────
 */
(function () {
  const STORAGE_KEY = 'europe-comparator-state-v1';
  const SCHEMA_VERSION = 2;

  // Travel methods with visual identity. `lucide` is an Iconify icon name.
  const TRAVEL = {
    flight: { label: 'Flight', lucide: 'lucide:plane', color: '#0ea5e9' },
    train: { label: 'Train', lucide: 'lucide:train-front', color: '#16a34a' },
    bus: { label: 'Bus', lucide: 'lucide:bus', color: '#f59e0b' },
    car: { label: 'Car', lucide: 'lucide:car', color: '#ef4444' },
    ferry: { label: 'Ferry', lucide: 'lucide:ship', color: '#8b5cf6' },
  };

  // Rough but real cost/time estimates per method, from leg distance.
  //  rate  $/km on adjusted distance   kmh  average speed
  //  base  fixed $ (e.g. flight)       overheadH  fixed hours (airport, port)
  //  detour  straight→actual distance multiplier
  const ESTIMATE = {
    car: { rate: 0.13, kmh: 90, base: 0, overheadH: 0, detour: 1.3, note: 'petrol ≈7 L/100 km @ ~$1.85/L' },
    bus: { rate: 0.1, kmh: 65, base: 0, overheadH: 0, detour: 1.3, note: 'coach fare ≈$0.10/km' },
    train: { rate: 0.18, kmh: 110, base: 0, overheadH: 0, detour: 1.2, note: 'rail fare ≈$0.18/km' },
    flight: { rate: 0.1, kmh: 700, base: 40, overheadH: 2, detour: 1.0, note: 'base $40 + $0.10/km, +2 h airport' },
    ferry: { rate: 0.15, kmh: 35, base: 20, overheadH: 0.5, detour: 1.0, note: 'base $20 + $0.15/km' },
  };

  function estimateLeg(method, distKm) {
    const e = ESTIMATE[method] || ESTIMATE.train;
    const d = (distKm || 0) * e.detour;
    return {
      cost: Math.round(e.base + d * e.rate),
      duration: Math.round((e.overheadH + d / e.kmh) * 4) / 4, // nearest quarter hour
    };
  }

  // [costMin, costMax, hoursMin, hoursMax]
  const MOCK_RANGES = {
    flight: [60, 220, 1.5, 4],
    train: [30, 140, 2, 6],
    bus: [15, 70, 3, 9],
    car: [25, 90, 2, 7],
    ferry: [20, 110, 1, 5],
  };

  const DEST_COLORS = [
    '#6366f1', '#ec4899', '#14b8a6', '#f97316',
    '#8b5cf6', '#0891b2', '#84cc16', '#e11d48',
  ];

  let _idCounter = 0;
  function uid(prefix) {
    _idCounter += 1;
    return `${prefix}_${Date.now().toString(36)}_${_idCounter}`;
  }

  function place(name, extra = {}) {
    const coords = window.CITIES.lookup(name) || {};
    return Object.assign({ id: uid('p'), name: name || '', lat: coords.lat ?? null, lng: coords.lng ?? null }, extra);
  }

  function destination(name, idx) {
    return place(name, { color: DEST_COLORS[idx % DEST_COLORS.length] });
  }

  function dayTrip(destinationId, name) {
    const coords = window.CITIES.lookup(name) || {};
    return {
      id: uid('dt'),
      destinationId,
      name: name || '',
      lat: coords.lat ?? null,
      lng: coords.lng ?? null,
      cost: 0,
      duration: 0,
      oneWay: true, // input is one-way; round-trip doubles it
    };
  }

  function clone(obj) {
    return obj ? JSON.parse(JSON.stringify(obj)) : obj;
  }

  function emptyFlight() {
    return { cost: 0, duration: 0 };
  }

  // Endpoints & flights now live ON the variant (they may differ per variant).
  // `endpoints` (optional) seeds origin/destination/flightIn/flightOut.
  // Clone a place but give it a fresh id, so each variant's endpoints have
  // their own identity (editing one variant's endpoint can't collide with
  // another's leg keys).
  function clonePlaceFreshId(p) {
    return p ? Object.assign(clone(p), { id: uid('p') }) : place('');
  }

  function variant(name, order, endpoints) {
    const ep = endpoints || {};
    return {
      id: uid('v'),
      name,
      origin: clonePlaceFreshId(ep.origin),
      destination: clonePlaceFreshId(ep.destination),
      flightIn: ep.flightIn ? clone(ep.flightIn) : emptyFlight(),
      flightOut: ep.flightOut ? clone(ep.flightOut) : emptyFlight(),
      order: order.slice(),
      methods: {},
      overrides: {},
      extraCosts: [], // [{ id, label, amount }] — variant-specific costs (e.g. car hire)
      railEnabled: {}, // { [legKey]: true } — train legs the user has fetched rail detail for
      trailAngleIn: null, // override bearing (deg) for the arrival trail; null = auto
      trailAngleOut: null, // override bearing (deg) for the departure trail; null = auto
    };
  }

  function extraCost(label, amount) {
    return { id: uid('ec'), label: label || '', amount: amount || 0 };
  }

  // ── Key helpers ──────────────────────────────────────────────────────
  // Direction-agnostic pair key so A→B and B→A share an estimate.
  function pairKey(a, b) {
    return [a, b].sort().join('-');
  }
  function methodKey(a, b, method) {
    return `${pairKey(a, b)}::${method}`;
  }

  // ── Default seed state ───────────────────────────────────────────────
  function defaultState() {
    const dests = [
      destination('Paris', 0),
      destination('Amsterdam', 1),
      destination('Berlin', 2),
      destination('Prague', 3),
    ];
    const order = dests.map((d) => d.id);
    const endpoints = { origin: place('London'), destination: place('Lisbon') };
    const v1 = variant('Variant A', order, endpoints);
    const v2 = variant('Variant B', [order[0], order[2], order[1], order[3]], endpoints);
    return {
      version: SCHEMA_VERSION,
      destinations: dests,
      dayTrips: [],
      legLibrary: {},
      variants: [v1, v2],
      activeVariantId: v1.id,
      mapProvider: 'leaflet', // 'leaflet' (OSM) | 'mapkit' (Apple Maps)
      mapkitToken: '',
      travelColors: {}, // per-method colour overrides, e.g. { train: '#0a0' }
      railCache: {}, // persisted fetched rail geometry, keyed by leg coords
    };
  }

  // Migrate older persisted/imported state to the current schema in place.
  function migrate(state) {
    if (!state || typeof state !== 'object') return state;
    if (!state.version || state.version < 2) {
      // v1 held endpoints/flights globally; move them onto every variant.
      const g = {
        origin: state.origin,
        destination: state.destination,
        flightIn: state.flightIn,
        flightOut: state.flightOut,
      };
      (state.variants || []).forEach((v) => {
        if (!v.origin) v.origin = clone(g.origin) || place('');
        if (!v.destination) v.destination = clone(g.destination) || place('');
        if (!v.flightIn) v.flightIn = clone(g.flightIn) || emptyFlight();
        if (!v.flightOut) v.flightOut = clone(g.flightOut) || emptyFlight();
        if (!Array.isArray(v.extraCosts)) v.extraCosts = [];
        if (!v.railEnabled) v.railEnabled = {};
        if (v.trailAngleIn === undefined) v.trailAngleIn = null;
        if (v.trailAngleOut === undefined) v.trailAngleOut = null;
      });
      delete state.origin;
      delete state.destination;
      delete state.flightIn;
      delete state.flightOut;
      state.version = SCHEMA_VERSION;
    }
    if (state.mapProvider == null) state.mapProvider = 'leaflet';
    if (state.mapkitToken == null) state.mapkitToken = '';
    if (!state.travelColors) state.travelColors = {};
    if (!state.railCache) state.railCache = {};
    return state;
  }

  // ── Persistence ──────────────────────────────────────────────────────
  function save(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn('Could not persist state:', e);
    }
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return migrate(JSON.parse(raw));
    } catch (e) {
      console.warn('Could not load state:', e);
      return null;
    }
  }

  // ── Computation helpers (pure) ───────────────────────────────────────

  // Resolve a leg's estimate: variant override wins over global library.
  function getLegData(state, vrt, fromId, toId, method) {
    const mk = methodKey(fromId, toId, method);
    if (vrt.overrides && vrt.overrides[mk]) return vrt.overrides[mk];
    if (state.legLibrary[mk]) return state.legLibrary[mk];
    return { cost: 0, duration: 0 };
  }

  // The ordered place nodes a variant travels through:
  // arrival endpoint (Origin) → key destinations (in order) → departure
  // endpoint (Final). Endpoints are the cities flown into / out of.
  function variantNodes(state, vrt) {
    const mid = vrt.order
      .map((id) => state.destinations.find((d) => d.id === id))
      .filter(Boolean);
    return [vrt.origin, ...mid, vrt.destination];
  }

  // Build the ordered list of travel legs for a variant. This now spans the
  // whole journey: Origin → first destination, the inter-destination legs, and
  // last destination → Final. Each leg has its own method/cost/time.
  function variantLegs(state, vrt) {
    const nodes = variantNodes(state, vrt);
    const legs = [];
    for (let i = 0; i < nodes.length - 1; i += 1) {
      const from = nodes[i];
      const to = nodes[i + 1];
      const method = (vrt.methods && vrt.methods[pairKey(from.id, to.id)]) || 'train';
      const data = getLegData(state, vrt, from.id, to.id, method);
      legs.push({
        key: pairKey(from.id, to.id),
        mk: methodKey(from.id, to.id, method),
        fromId: from.id,
        toId: to.id,
        fromName: from.name || 'Unnamed',
        toName: to.name || 'Unnamed',
        method,
        cost: data.cost || 0,
        duration: data.duration || 0,
        // 'origin' = arrival→first stop, 'final' = last stop→departure, else 'mid'
        kind: i === 0 ? 'origin' : i === nodes.length - 2 ? 'final' : 'mid',
      });
    }
    return legs;
  }

  // Round-trip cost/time for a day trip (one-way inputs are doubled).
  function dayTripCost(dt) {
    return (dt.cost || 0) * (dt.oneWay ? 2 : 1);
  }
  function dayTripTime(dt) {
    return (dt.duration || 0) * (dt.oneWay ? 2 : 1);
  }

  // Total price & time for a variant. Endpoints/flights and extra costs are
  // now per-variant; day trips remain a global setup tool shared by all.
  function variantTotals(state, vrt) {
    let price = (vrt.flightIn.cost || 0) + (vrt.flightOut.cost || 0);
    let time = (vrt.flightIn.duration || 0) + (vrt.flightOut.duration || 0);

    variantLegs(state, vrt).forEach((leg) => {
      price += leg.cost;
      time += leg.duration;
    });

    state.dayTrips.forEach((dt) => {
      price += dayTripCost(dt);
      time += dayTripTime(dt);
    });

    (vrt.extraCosts || []).forEach((c) => {
      price += c.amount || 0;
    });

    return { price: Math.round(price), time };
  }

  function randIn([min, max]) {
    return min + Math.random() * (max - min);
  }
  function mockFor(method) {
    const r = MOCK_RANGES[method] || MOCK_RANGES.train;
    return {
      cost: Math.round(randIn([r[0], r[1]])),
      duration: Math.round(randIn([r[2], r[3]]) * 4) / 4, // quarter-hour
    };
  }

  window.Models = {
    STORAGE_KEY,
    TRAVEL,
    MOCK_RANGES,
    DEST_COLORS,
    uid,
    clone,
    clonePlaceFreshId,
    place,
    destination,
    dayTrip,
    variant,
    extraCost,
    pairKey,
    methodKey,
    defaultState,
    migrate,
    save,
    load,
    getLegData,
    variantNodes,
    variantLegs,
    dayTripCost,
    dayTripTime,
    variantTotals,
    mockFor,
    ESTIMATE,
    estimateLeg,
  };
})();
