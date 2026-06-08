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

  // Travel methods with visual identity.
  const TRAVEL = {
    flight: { label: 'Flight', icon: '✈️', color: '#0ea5e9' },
    train: { label: 'Train', icon: '🚆', color: '#16a34a' },
    bus: { label: 'Bus', icon: '🚌', color: '#f59e0b' },
    car: { label: 'Car', icon: '🚗', color: '#ef4444' },
    ferry: { label: 'Ferry', icon: '⛴️', color: '#8b5cf6' },
  };

  // Mock-data ranges per travel type for the "Autofill Estimates" feature.
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

  function variant(name, order) {
    return { id: uid('v'), name, order: order.slice(), methods: {}, overrides: {} };
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
    const v1 = variant('Variant A', order);
    const v2 = variant('Variant B', [order[0], order[2], order[1], order[3]]);
    return {
      origin: place('London'),
      destination: place('Lisbon'),
      flightIn: { cost: 0, duration: 0 },
      flightOut: { cost: 0, duration: 0 },
      destinations: dests,
      dayTrips: [],
      legLibrary: {},
      variants: [v1, v2],
      activeVariantId: v1.id,
    };
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
      return JSON.parse(raw);
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

  // Build the ordered list of inter-destination legs for a variant.
  function variantLegs(state, vrt) {
    const legs = [];
    for (let i = 0; i < vrt.order.length - 1; i += 1) {
      const fromId = vrt.order[i];
      const toId = vrt.order[i + 1];
      const method = (vrt.methods && vrt.methods[pairKey(fromId, toId)]) || 'train';
      const data = getLegData(state, vrt, fromId, toId, method);
      legs.push({
        key: pairKey(fromId, toId),
        mk: methodKey(fromId, toId, method),
        fromId,
        toId,
        method,
        cost: data.cost || 0,
        duration: data.duration || 0,
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

  // Total price & time for a variant.
  function variantTotals(state, vrt) {
    let price = (state.flightIn.cost || 0) + (state.flightOut.cost || 0);
    let time = (state.flightIn.duration || 0) + (state.flightOut.duration || 0);

    variantLegs(state, vrt).forEach((leg) => {
      price += leg.cost;
      time += leg.duration;
    });

    state.dayTrips.forEach((dt) => {
      price += dayTripCost(dt);
      time += dayTripTime(dt);
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
    place,
    destination,
    dayTrip,
    variant,
    pairKey,
    methodKey,
    defaultState,
    save,
    load,
    getLegData,
    variantLegs,
    dayTripCost,
    dayTripTime,
    variantTotals,
    mockFor,
  };
})();
