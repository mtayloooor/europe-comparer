/**
 * place-search.js
 * Reusable Vue autocomplete for picking a real map location. Registered on the
 * app as <place-search>. Exposed globally as window.PlaceSearchComponent.
 *
 * Usage:  <place-search :place="dest" placeholder="Search a place…" />
 *
 * It mutates the bound `place` object in place, setting:
 *   place.name, place.lat, place.lng
 * on selection. Typing triggers a debounced GeoSearch query; selecting a
 * result fills coordinates. If the user types a name and moves on without
 * picking, the field resolves to the best match on blur.
 */
(function () {
  window.PlaceSearchComponent = {
    props: {
      place: { type: Object, required: true },
      placeholder: { type: String, default: 'Search a place…' },
      compact: { type: Boolean, default: false },
    },
    data() {
      return {
        results: [],
        open: false,
        loading: false,
        active: -1,
        timer: null,
        seq: 0,
        flipUp: false, // open the dropdown above the field when space below is tight
        // Name the current coordinates correspond to (assume existing ones valid).
        resolvedName: this.place.name || '',
      };
    },
    methods: {
      onInput(e) {
        this.place.name = e.target.value;
        this.schedule(e.target.value);
      },
      // Decide whether the results panel should drop down or flip up.
      recalcFlip() {
        const rect = this.$el && this.$el.getBoundingClientRect();
        if (!rect) return;
        const spaceBelow = window.innerHeight - rect.bottom;
        const PANEL = 248; // ≈ max-h-60 (240px) + margin
        this.flipUp = spaceBelow < PANEL && rect.top > spaceBelow;
      },
      schedule(q) {
        clearTimeout(this.timer);
        if (!q || q.trim().length < 2) {
          this.results = [];
          this.open = false;
          return;
        }
        this.recalcFlip();
        this.open = true;
        this.loading = true;
        this.timer = setTimeout(() => this.run(q.trim()), 280); // debounce
      },
      async run(q) {
        const mySeq = (this.seq += 1);
        const res = await window.GeoSearch.search(q);
        if (mySeq !== this.seq) return; // a newer query superseded this one
        this.results = res;
        this.loading = false;
        this.active = -1;
        this.recalcFlip();
      },
      choose(r) {
        this.place.name = r.name;
        this.place.lat = r.lat;
        this.place.lng = r.lng;
        this.resolvedName = r.name;
        this.results = [];
        this.open = false;
      },
      onFocus() {
        if (this.results.length) {
          this.recalcFlip();
          this.open = true;
        }
      },
      async onBlur() {
        // Let a result mousedown register first.
        setTimeout(() => {
          this.open = false;
        }, 120);
        // Resolve free-typed text that wasn't explicitly selected.
        const name = (this.place.name || '').trim();
        if (name && name !== this.resolvedName) {
          const res = await window.GeoSearch.search(name);
          if (res.length) {
            this.place.lat = res[0].lat;
            this.place.lng = res[0].lng;
            this.resolvedName = name;
          }
        }
      },
      move(d) {
        if (!this.open || !this.results.length) return;
        this.active = (this.active + d + this.results.length) % this.results.length;
      },
      enter() {
        if (this.open && this.active >= 0 && this.results[this.active]) {
          this.choose(this.results[this.active]);
        }
      },
    },
    template: `
      <div class="relative">
        <input
          :value="place.name"
          @input="onInput"
          @focus="onFocus"
          @blur="onBlur"
          @keydown.down.prevent="move(1)"
          @keydown.up.prevent="move(-1)"
          @keydown.enter.prevent="enter"
          @keydown.esc="open=false"
          :class="compact ? 'city-input !mt-0' : 'city-input'"
          :placeholder="placeholder"
          autocomplete="off" />
        <span v-if="place.lat==null && place.name"
              class="absolute right-2 top-1.5 text-amber-500" title="No map location yet — pick a result">
          <app-icon name="lucide:triangle-alert" :size="13" />
        </span>
        <div v-if="open"
             class="absolute z-[1500] left-0 right-0 bg-white border border-slate-200 rounded-md shadow-lg max-h-60 overflow-auto text-sm"
             :class="flipUp ? 'bottom-full mb-1' : 'top-full mt-1'">
          <div v-if="loading" class="px-3 py-2 text-slate-400 text-xs">Searching…</div>
          <template v-else>
            <button v-for="(r, i) in results" :key="i"
                    type="button"
                    @mousedown.prevent="choose(r)"
                    class="w-full text-left px-3 py-1.5 hover:bg-indigo-50 flex flex-col"
                    :class="{ 'bg-indigo-50': i===active }">
              <span class="font-medium text-slate-700">📍 {{ r.label }}</span>
              <span v-if="r.detail" class="text-[11px] text-slate-400">{{ r.detail }}</span>
            </button>
            <div v-if="!results.length" class="px-3 py-2 text-slate-400 text-xs">No matches — try a different spelling.</div>
          </template>
        </div>
      </div>
    `,
  };
})();
