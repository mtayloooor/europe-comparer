/**
 * app.js
 * Vue 3 application root. Binds the data model (models.js), routing (routing.js),
 * map abstraction (map.js) and city gazetteer (cities.js) to the UI.
 */
(function () {
  const { createApp, reactive, ref, computed, watch, onMounted, nextTick } = Vue;
  const M = window.Models;

  const app = createApp({
    setup() {
      // ── State ──────────────────────────────────────────────────────
      const loaded = M.load();
      const state = reactive(loaded || M.defaultState());

      if (!state.variants.find((v) => v.id === state.activeVariantId)) {
        state.activeVariantId = state.variants[0] ? state.variants[0].id : null;
      }

      const editingVariantId = ref(null);
      const syncPrompt = ref(null); // { mk, label, others, newData }
      const copySource = ref(''); // selected "copy endpoints from" variant id

      // Collapsible global-setup sections.
      const showDestinations = ref(true);
      const showDayTrips = ref(true);

      let mapCtl = null;

      const TRAVEL = M.TRAVEL;

      // ── Lookups ────────────────────────────────────────────────────
      const destById = (id) => state.destinations.find((d) => d.id === id);
      const destLabel = (id) => {
        const i = state.destinations.findIndex((d) => d.id === id);
        return i >= 0 ? String(i + 1) : '?';
      };

      const activeVariant = computed(
        () => state.variants.find((v) => v.id === state.activeVariantId) || null
      );
      const otherVariants = computed(() =>
        state.variants.filter((v) => v.id !== state.activeVariantId)
      );

      function variantsUsing(mk) {
        return state.variants.filter((v) =>
          M.variantLegs(state, v).some((l) => l.mk === mk)
        );
      }

      const activeLegs = computed(() => {
        if (!activeVariant.value) return [];
        return M.variantLegs(state, activeVariant.value).map((leg) => ({
          ...leg,
          shared: variantsUsing(leg.mk).length > 1,
        }));
      });

      // ── Summaries / dashboard ──────────────────────────────────────
      const variantSummaries = computed(() => {
        const rows = state.variants.map((v) => {
          const totals = M.variantTotals(state, v);
          const names = v.order.map((id) => destById(id)?.name || '?');
          const routeText = [v.origin.name || 'A', ...names, v.destination.name || 'B'].join(' → ');
          return { id: v.id, name: v.name, price: totals.price, time: totals.time, routeText };
        });
        if (rows.length) {
          const minP = Math.min(...rows.map((r) => r.price));
          const minT = Math.min(...rows.map((r) => r.time));
          rows.forEach((r) => {
            r.cheapest = r.price === minP;
            r.fastest = r.time === minT && !r.cheapest;
          });
        }
        return rows;
      });
      const minPrice = computed(() =>
        variantSummaries.value.length ? Math.min(...variantSummaries.value.map((r) => r.price)) : 0
      );

      // ── Formatting ─────────────────────────────────────────────────
      const fmtH = (h) => {
        const hrs = Math.floor(h);
        const mins = Math.round((h - hrs) * 60);
        return mins ? `${hrs}h ${mins}m` : `${hrs}h`;
      };
      const dayTripCost = M.dayTripCost;
      const dayTripTime = M.dayTripTime;

      // ── Destinations (global setup) ────────────────────────────────
      function addDestination() {
        const dest = M.destination('', state.destinations.length);
        state.destinations.push(dest);
        state.variants.forEach((v) => v.order.push(dest.id));
      }
      function removeDestination(id) {
        state.destinations = state.destinations.filter((d) => d.id !== id);
        state.dayTrips = state.dayTrips.filter((dt) => dt.destinationId !== id);
        state.variants.forEach((v) => {
          v.order = v.order.filter((x) => x !== id);
        });
      }

      // ── Day trips (global setup) ───────────────────────────────────
      function addDayTrip() {
        if (!state.destinations.length) return;
        state.dayTrips.push(M.dayTrip(state.destinations[0].id, ''));
      }
      function removeDayTrip(id) {
        state.dayTrips = state.dayTrips.filter((dt) => dt.id !== id);
      }

      // ── Per-variant endpoints & flights ────────────────────────────
      function copyEndpointsFrom(srcId) {
        const src = state.variants.find((v) => v.id === srcId);
        const v = activeVariant.value;
        if (!src || !v) return;
        v.origin = M.clone(src.origin);
        v.destination = M.clone(src.destination);
        v.flightIn = M.clone(src.flightIn);
        v.flightOut = M.clone(src.flightOut);
        copySource.value = '';
      }

      // ── Per-variant extra costs ────────────────────────────────────
      function addExtraCost() {
        activeVariant.value.extraCosts.push(M.extraCost('', 0));
      }
      function removeExtraCost(id) {
        const v = activeVariant.value;
        v.extraCosts = v.extraCosts.filter((c) => c.id !== id);
      }

      // ── Variant legs (order / method / estimates) ──────────────────
      function moveDest(idx, dir) {
        const arr = activeVariant.value.order;
        const j = idx + dir;
        if (j < 0 || j >= arr.length) return;
        [arr[idx], arr[j]] = [arr[j], arr[idx]];
      }
      function setLegMethod(leg, method) {
        activeVariant.value.methods[leg.key] = method;
      }
      function editLeg(leg, field, value) {
        if (Number.isNaN(value)) value = 0;
        const newData = { cost: leg.cost, duration: leg.duration, [field]: value };
        const others = variantsUsing(leg.mk).filter((v) => v.id !== state.activeVariantId);
        if (others.length > 0) {
          syncPrompt.value = {
            mk: leg.mk,
            label: `${destById(leg.fromId)?.name} → ${destById(leg.toId)?.name} (${TRAVEL[leg.method].label})`,
            others: others.length,
            newData,
          };
        } else {
          state.legLibrary[leg.mk] = newData;
        }
      }
      function resolveSync(mode) {
        const { mk, newData } = syncPrompt.value;
        if (mode === 'global') {
          state.legLibrary[mk] = newData;
          if (activeVariant.value.overrides) delete activeVariant.value.overrides[mk];
        } else {
          if (!activeVariant.value.overrides) activeVariant.value.overrides = {};
          activeVariant.value.overrides[mk] = newData;
        }
        syncPrompt.value = null;
      }

      // ── Variants ───────────────────────────────────────────────────
      function nextVariantName() {
        return `Variant ${String.fromCharCode(65 + state.variants.length)}`;
      }
      function addVariant() {
        const base = activeVariant.value;
        const order = base ? base.order.slice() : state.destinations.map((d) => d.id);
        // New variants inherit the current endpoints/flights as a sensible start.
        const v = M.variant(nextVariantName(), order, base || {});
        state.variants.push(v);
        state.activeVariantId = v.id;
      }
      function duplicateVariant() {
        if (!activeVariant.value) return;
        const src = activeVariant.value;
        const copy = M.variant(`${src.name} (copy)`, src.order, src);
        copy.methods = M.clone(src.methods);
        copy.overrides = M.clone(src.overrides || {});
        copy.extraCosts = M.clone(src.extraCosts || []).map((c) => ({ ...c, id: M.uid('ec') }));
        state.variants.push(copy);
        state.activeVariantId = copy.id;
      }
      function removeVariant(id) {
        if (state.variants.length <= 1) return;
        state.variants = state.variants.filter((v) => v.id !== id);
        if (state.activeVariantId === id) state.activeVariantId = state.variants[0].id;
      }
      function startRename(v) {
        editingVariantId.value = v.id;
      }
      function finishRename(v, name) {
        if (name && name.trim()) v.name = name.trim();
        editingVariantId.value = null;
      }

      // ── Autofill (mock estimates) ──────────────────────────────────
      function isEmpty(d) {
        return !d || (!d.cost && !d.duration);
      }
      function autofillAll() {
        state.variants.forEach((v) => {
          if (isEmpty(v.flightIn)) Object.assign(v.flightIn, M.mockFor('flight'));
          if (isEmpty(v.flightOut)) Object.assign(v.flightOut, M.mockFor('flight'));
          M.variantLegs(state, v).forEach((leg) => {
            const existing = state.legLibrary[leg.mk];
            const override = v.overrides && v.overrides[leg.mk];
            if (isEmpty(existing) && isEmpty(override)) {
              state.legLibrary[leg.mk] = M.mockFor(leg.method);
            }
          });
        });
        state.dayTrips.forEach((dt) => {
          if (!dt.cost) dt.cost = Math.round(20 + Math.random() * 80);
          if (!dt.duration) dt.duration = Math.round((1 + Math.random() * 3) * 4) / 4;
        });
      }

      // ── Import / export / reset ────────────────────────────────────
      function exportData() {
        const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `europe-trip-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
      }
      function importData(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try {
            const data = M.migrate(JSON.parse(reader.result));
            Object.keys(state).forEach((k) => delete state[k]);
            Object.assign(state, data);
            if (!state.variants.find((v) => v.id === state.activeVariantId)) {
              state.activeVariantId = state.variants[0]?.id || null;
            }
            recreateMap();
          } catch (err) {
            alert('Could not read that file — is it a valid export?');
          }
        };
        reader.readAsText(file);
        e.target.value = '';
      }
      function resetAll() {
        if (!confirm('Reset everything to the default sample trip?')) return;
        const fresh = M.defaultState();
        Object.keys(state).forEach((k) => delete state[k]);
        Object.assign(state, fresh);
        recreateMap();
      }

      // ── Map provider (OSM ⇄ Apple Maps) ────────────────────────────
      const mapProviderLabel = computed(() =>
        state.mapProvider === 'mapkit'
          ? 'Apple MapKit JS'
          : 'Leaflet / OpenStreetMap'
      );

      function buildMapPayload() {
        const v = activeVariant.value;
        const stops = v.order.map((id) => destById(id)).filter(Boolean);

        const markers = [
          { lat: v.origin.lat, lng: v.origin.lng, label: 'A', color: '#1e293b', name: v.origin.name || 'Origin' },
          ...stops.map((s, i) => ({ lat: s.lat, lng: s.lng, label: String(i + 1), color: s.color, name: s.name || 'Unnamed' })),
          { lat: v.destination.lat, lng: v.destination.lng, label: 'B', color: '#1e293b', name: v.destination.name || 'Destination' },
        ];

        // Ordered node sequence with the travel method for each segment.
        const seq = [v.origin, ...stops, v.destination];
        const segments = [];
        for (let i = 0; i < seq.length - 1; i += 1) {
          let method;
          if (i === 0 || i === seq.length - 2) {
            method = 'flight'; // inbound / outbound flights
          } else {
            const fromId = v.order[i - 1];
            const toId = v.order[i];
            method = (v.methods && v.methods[M.pairKey(fromId, toId)]) || 'train';
          }
          segments.push({ from: seq[i], to: seq[i + 1], method });
        }

        const dayTrips = state.dayTrips
          .map((dt) => {
            const parent = destById(dt.destinationId);
            return { name: dt.name, lat: dt.lat, lng: dt.lng, parentLat: parent?.lat, parentLng: parent?.lng };
          })
          .filter((dt) => dt.lat != null);

        return { markers, segments, dayTrips };
      }

      let renderSeq = 0;
      async function renderMap() {
        if (!mapCtl || !activeVariant.value) return;
        const token = (renderSeq += 1);
        const { markers, segments, dayTrips } = buildMapPayload();

        const legs = await Promise.all(
          segments.map(async (seg) => {
            const { coords, approximate } = await window.RouteService.getLeg(seg.from, seg.to, seg.method);
            return {
              coords,
              color: TRAVEL[seg.method].color,
              dashed: approximate || seg.method === 'flight' || seg.method === 'ferry',
            };
          })
        );

        if (token !== renderSeq) return; // a newer render superseded this one
        mapCtl.render({ markers, legs, dayTrips });
      }

      function createMap() {
        mapCtl = window.MapController.create('map', {
          provider: state.mapProvider,
          mapkitToken: state.mapkitToken,
          onMapKitError: () => {
            alert('Apple Maps could not load (missing/invalid token or MapKit JS unavailable). Falling back to OpenStreetMap.');
            state.mapProvider = 'leaflet';
          },
        });
      }
      function recreateMap() {
        if (mapCtl && mapCtl.destroy) mapCtl.destroy();
        createMap();
        nextTick(renderMap);
      }

      function setMapProvider(provider) {
        if (provider === state.mapProvider) return;
        if (provider === 'mapkit' && !state.mapkitToken) {
          if (!promptForToken()) return; // cancelled — stay on current provider
        }
        state.mapProvider = provider;
        recreateMap();
      }
      function promptForToken() {
        const t = window.prompt(
          'Paste your Apple MapKit JS token (JWT).\n' +
            'Get one at developer.apple.com → Certificates, IDs & Profiles → Maps IDs / Keys.\n' +
            'It is stored locally and included in your export file.',
          state.mapkitToken || ''
        );
        if (t && t.trim()) {
          state.mapkitToken = t.trim();
          return true;
        }
        return false;
      }
      function changeToken() {
        if (promptForToken() && state.mapProvider === 'mapkit') recreateMap();
      }

      // ── Lifecycle + reactive side-effects ──────────────────────────
      onMounted(() => {
        createMap();
        renderMap();
      });

      let renderTimer = null;
      function scheduleRender() {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(renderMap, 350); // debounce network-bound route lookups
      }

      watch(
        state,
        () => {
          M.save(state);
          scheduleRender();
        },
        { deep: true }
      );

      return {
        state,
        TRAVEL,
        editingVariantId,
        syncPrompt,
        copySource,
        showDestinations,
        showDayTrips,
        activeVariant,
        otherVariants,
        activeLegs,
        variantSummaries,
        minPrice,
        mapProviderLabel,
        destById,
        destLabel,
        fmtH,
        dayTripCost,
        dayTripTime,
        addDestination,
        removeDestination,
        addDayTrip,
        removeDayTrip,
        copyEndpointsFrom,
        addExtraCost,
        removeExtraCost,
        moveDest,
        setLegMethod,
        editLeg,
        resolveSync,
        addVariant,
        duplicateVariant,
        removeVariant,
        startRename,
        finishRename,
        autofillAll,
        exportData,
        importData,
        resetAll,
        setMapProvider,
        changeToken,
      };
    },
  });

  app.component('place-search', window.PlaceSearchComponent);
  app.mount('#app');
})();
