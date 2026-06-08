/**
 * angle-dial.js
 * A small radial dial for picking a compass bearing (0° = north, clockwise).
 * Registered on the app as <angle-dial>. Exposed as window.AngleDialComponent.
 *
 *   <angle-dial :model-value="v.trailAngleIn" @update:model-value="v.trailAngleIn = $event" label="Arrival" />
 *
 * modelValue is degrees (Number) or null = "auto". Drag the handle (or click)
 * to set; double-click resets to auto (emits null).
 */
(function () {
  const R = 18;
  const C = 24; // centre of the 48px dial

  window.AngleDialComponent = {
    props: {
      modelValue: { type: [Number, null], default: null },
      label: { type: String, default: '' },
    },
    emits: ['update:modelValue'],
    data() {
      return { dragging: false };
    },
    computed: {
      angle() {
        return this.modelValue == null ? 0 : this.modelValue;
      },
      handle() {
        const r = (this.angle * Math.PI) / 180;
        return { x: C + R * Math.sin(r), y: C - R * Math.cos(r) };
      },
    },
    methods: {
      fromEvent(e) {
        const rect = this.$refs.svg.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        let deg = (Math.atan2(e.clientX - cx, -(e.clientY - cy)) * 180) / Math.PI;
        deg = Math.round((deg + 360) % 360);
        this.$emit('update:modelValue', deg);
      },
      start(e) {
        this.dragging = true;
        this.$refs.svg.setPointerCapture && this.$refs.svg.setPointerCapture(e.pointerId);
        this.fromEvent(e);
      },
      move(e) {
        if (this.dragging) this.fromEvent(e);
      },
      end() {
        this.dragging = false;
      },
      reset() {
        this.$emit('update:modelValue', null);
      },
    },
    template: `
      <div class="flex flex-col items-center select-none">
        <svg ref="svg" width="48" height="48" style="touch-action:none;cursor:pointer"
             @pointerdown="start" @pointermove="move" @pointerup="end" @pointerleave="end"
             @dblclick="reset" :title="(label ? label + ' trail — ' : '') + 'drag to aim, double-click for auto'">
          <circle :cx="24" :cy="24" r="22" fill="#f1f5f9" stroke="#cbd5e1" stroke-width="1"></circle>
          <line :x1="24" :y1="24" :x2="handle.x" :y2="handle.y"
                :stroke="modelValue == null ? '#cbd5e1' : '#4f46e5'" stroke-width="2"></line>
          <circle :cx="handle.x" :cy="handle.y" r="4" :fill="modelValue == null ? '#cbd5e1' : '#4f46e5'"></circle>
          <circle :cx="24" :cy="24" r="2" fill="#64748b"></circle>
        </svg>
        <div class="text-[10px] text-slate-400 leading-tight">{{ label }}</div>
        <div class="text-[10px] font-medium" :class="modelValue == null ? 'text-slate-400' : 'text-brand'">
          {{ modelValue == null ? 'auto' : modelValue + '°' }}
        </div>
      </div>
    `,
  };
})();
