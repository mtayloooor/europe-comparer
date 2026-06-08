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

      // ── In-page debug log ──────────────────────────────────────────
      const debugEntries = reactive([]);
      const showDebug = ref(false);
      window.DebugLog.attach(debugEntries);
      window.DebugLog.info('App initialised');
      function clearDebug() {
        window.DebugLog.clear();
      }
      async function copyDebug() {
        const text = debugEntries
          .map((e) => `${e.t} [${e.level}] ${e.message}` + (e.data ? ' ' + JSON.stringify(e.data) : ''))
          .join('\n');
        try {
          await navigator.clipboard.writeText(text);
          window.DebugLog.info('Debug log copied to clipboard');
        } catch (e) {
          window.DebugLog.warn('Clipboard copy failed: ' + e.message);
        }
      }

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

      // Best railway station per place id, resolved during map render (train legs).
      const stationByPlace = reactive({});

      const activeLegs = computed(() => {
        if (!activeVariant.value) return [];
        return M.variantLegs(state, activeVariant.value).map((leg) => ({
          ...leg,
          shared: variantsUsing(leg.mk).length > 1,
          fromStation: stationByPlace[leg.fromId] || null,
          toStation: stationByPlace[leg.toId] || null,
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
        v.origin = M.clonePlaceFreshId(src.origin);
        v.destination = M.clonePlaceFreshId(src.destination);
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
      // Drag-and-drop reordering of the key destinations.
      const dragIndex = ref(null);
      const dragOverIndex = ref(null);
      function onDragStart(idx) {
        dragIndex.value = idx;
      }
      function onDragEnter(idx) {
        if (dragIndex.value !== null) dragOverIndex.value = idx;
      }
      function onDrop(idx) {
        const from = dragIndex.value;
        dragOverIndex.value = null;
        dragIndex.value = null;
        if (from === null || from === idx) return;
        const arr = activeVariant.value.order;
        const [moved] = arr.splice(from, 1);
        arr.splice(idx, 0, moved);
      }
      function onDragEnd() {
        dragIndex.value = null;
        dragOverIndex.value = null;
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
        // The copy got fresh endpoint ids; remap any leg keys that reference the
        // source endpoints so the duplicate keeps its endpoint-leg config.
        const idMap = {
          [src.origin.id]: copy.origin.id,
          [src.destination.id]: copy.destination.id,
        };
        const remap = (key, isMethodKey) => {
          let pk = key;
          let suffix = '';
          if (isMethodKey) {
            const i = key.indexOf('::');
            pk = key.slice(0, i);
            suffix = key.slice(i);
          }
          const parts = pk.split('-').map((id) => idMap[id] || id).sort();
          return parts.join('-') + suffix;
        };
        copy.methods = {};
        Object.keys(src.methods || {}).forEach((k) => {
          copy.methods[remap(k, false)] = src.methods[k];
        });
        copy.overrides = {};
        Object.keys(src.overrides || {}).forEach((k) => {
          copy.overrides[remap(k, true)] = M.clone(src.overrides[k]);
        });
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

        // Every segment is now a leg with its own method (the external flights
        // into/out of the endpoints have no geometry on this map).
        const seq = [v.origin, ...stops, v.destination];
        const segments = [];
        for (let i = 0; i < seq.length - 1; i += 1) {
          const from = seq[i];
          const to = seq[i + 1];
          const method = (v.methods && v.methods[M.pairKey(from.id, to.id)]) || 'train';
          segments.push({ from, to, method });
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
        window.DebugLog.info(
          `Render "${activeVariant.value.name}": ${segments.length} legs [${segments.map((s) => s.method).join(', ')}]`
        );

        const legs = await Promise.all(
          segments.map(async (seg) => {
            const res = await window.RouteService.getLeg(seg.from, seg.to, seg.method);
            if (seg.method === 'train') {
              // Record the resolved station for each endpoint (for the leg planner).
              stationByPlace[seg.from.id] = res.fromStation || null;
              stationByPlace[seg.to.id] = res.toStation || null;
            }
            return {
              coords: res.coords,
              color: TRAVEL[seg.method].color,
              dashed: res.approximate || seg.method === 'flight' || seg.method === 'ferry',
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
        debugEntries,
        showDebug,
        clearDebug,
        copyDebug,
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
        dragIndex,
        dragOverIndex,
        onDragStart,
        onDragEnter,
        onDrop,
        onDragEnd,
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

  // Treat the Iconify web component as a native custom element so Vue doesn't
  // try to resolve it as a Vue component (it renders its own shadow DOM).
  app.config.compilerOptions.isCustomElement = (tag) => tag === 'iconify-icon';

  // Tiny wrapper to keep icon markup terse and consistently sized. Colour is
  // inherited via currentColor, so Tailwind text-* classes on the parent work.
  app.component('app-icon', {
    props: { name: { type: String, required: true }, size: { type: [String, Number], default: 16 } },
    template:
      '<iconify-icon :icon="name" :width="size" :height="size" style="vertical-align:-0.15em"></iconify-icon>',
  });

  app.component('place-search', window.PlaceSearchComponent);
  app.mount('#app');
})();
