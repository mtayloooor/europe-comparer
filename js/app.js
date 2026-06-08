/**
 * app.js
 * Vue 3 application root. Binds the data model (models.js), map abstraction
 * (map.js) and city gazetteer (cities.js) to the UI defined in index.html.
 */
(function () {
  const { createApp, reactive, ref, computed, watch, onMounted, nextTick } = Vue;
  const M = window.Models;

  createApp({
    setup() {
      // ── State ──────────────────────────────────────────────────────
      const loaded = M.load();
      const state = reactive(loaded || M.defaultState());

      // Make sure an active variant always exists.
      if (!state.variants.find((v) => v.id === state.activeVariantId)) {
        state.activeVariantId = state.variants[0] ? state.variants[0].id : null;
      }

      const editingVariantId = ref(null);
      const syncPrompt = ref(null); // { mk, label, others, newData }
      let mapCtl = null;

      const TRAVEL = M.TRAVEL;
      const CITY_NAMES = Object.keys(window.CITIES).filter((k) => k !== 'lookup');

      // ── Lookups ────────────────────────────────────────────────────
      const destById = (id) => state.destinations.find((d) => d.id === id);
      const destLabel = (id) => {
        const i = state.destinations.findIndex((d) => d.id === id);
        return i >= 0 ? String(i + 1) : '?';
      };

      const activeVariant = computed(
        () => state.variants.find((v) => v.id === state.activeVariantId) || null
      );

      // Count how many variants route through a given methodKey.
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
          const routeText = [state.origin.name || 'A', ...names, state.destination.name || 'B'].join(' → ');
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

      // ── Places ─────────────────────────────────────────────────────
      function onPlaceName(p) {
        const coords = window.CITIES.lookup(p.name);
        if (coords) {
          p.lat = coords.lat;
          p.lng = coords.lng;
        }
      }

      // ── Destinations ───────────────────────────────────────────────
      function addDestination() {
        const dest = M.destination('', state.destinations.length);
        state.destinations.push(dest);
        // Append to every variant's order so it participates everywhere.
        state.variants.forEach((v) => v.order.push(dest.id));
      }
      function removeDestination(id) {
        state.destinations = state.destinations.filter((d) => d.id !== id);
        state.dayTrips = state.dayTrips.filter((dt) => dt.destinationId !== id);
        state.variants.forEach((v) => {
          v.order = v.order.filter((x) => x !== id);
        });
      }

      // ── Day trips ──────────────────────────────────────────────────
      function addDayTrip() {
        if (!state.destinations.length) return;
        state.dayTrips.push(M.dayTrip(state.destinations[0].id, ''));
      }
      function removeDayTrip(id) {
        state.dayTrips = state.dayTrips.filter((dt) => dt.id !== id);
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

      // Edit a leg estimate. If the same leg (pair + method) is used by other
      // variants, prompt whether to apply globally or only here.
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
          // No conflict — store in the global library so it inherits later.
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
        const order = activeVariant.value
          ? activeVariant.value.order.slice()
          : state.destinations.map((d) => d.id);
        const v = M.variant(nextVariantName(), order);
        state.variants.push(v);
        state.activeVariantId = v.id;
      }
      function duplicateVariant() {
        if (!activeVariant.value) return;
        const src = activeVariant.value;
        const copy = M.variant(`${src.name} (copy)`, src.order);
        copy.methods = JSON.parse(JSON.stringify(src.methods));
        copy.overrides = JSON.parse(JSON.stringify(src.overrides || {}));
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
        if (isEmpty(state.flightIn)) Object.assign(state.flightIn, M.mockFor('flight'));
        if (isEmpty(state.flightOut)) Object.assign(state.flightOut, M.mockFor('flight'));

        state.variants.forEach((v) => {
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
            const data = JSON.parse(reader.result);
            Object.keys(state).forEach((k) => delete state[k]);
            Object.assign(state, data);
            if (!state.variants.find((v) => v.id === state.activeVariantId)) {
              state.activeVariantId = state.variants[0]?.id || null;
            }
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
      }

      // ── Map ────────────────────────────────────────────────────────
      const mapProviderLabel = computed(() =>
        mapCtl && mapCtl._impl === 'mapkit'
          ? 'Apple MapKit JS'
          : 'Map: Leaflet / OpenStreetMap (swappable for Apple MapKit JS)'
      );

      function renderMap() {
        if (!mapCtl || !activeVariant.value) return;
        const stops = activeVariant.value.order.map((id) => destById(id)).filter(Boolean);
        const dayTrips = state.dayTrips
          .map((dt) => {
            const parent = destById(dt.destinationId);
            return {
              name: dt.name,
              lat: dt.lat,
              lng: dt.lng,
              parentLat: parent?.lat,
              parentLng: parent?.lng,
            };
          })
          .filter((dt) => dt.lat != null);
        mapCtl.render({
          origin: state.origin,
          destination: state.destination,
          stops,
          dayTrips,
        });
      }

      onMounted(() => {
        mapCtl = window.MapController.create('map', {
          provider: 'leaflet', // change to 'mapkit' + supply token to use Apple Maps
          mapkitToken: window.MAPKIT_TOKEN,
        });
        renderMap();
      });

      // ── Reactive side-effects: persist + re-render map ─────────────
      watch(
        state,
        () => {
          M.save(state);
          nextTick(renderMap);
        },
        { deep: true }
      );

      return {
        state,
        TRAVEL,
        CITY_NAMES,
        editingVariantId,
        syncPrompt,
        activeVariant,
        activeLegs,
        variantSummaries,
        minPrice,
        mapProviderLabel,
        destById,
        destLabel,
        fmtH,
        dayTripCost,
        dayTripTime,
        onPlaceName,
        addDestination,
        removeDestination,
        addDayTrip,
        removeDayTrip,
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
      };
    },
  }).mount('#app');
})();
