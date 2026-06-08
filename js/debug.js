/**
 * debug.js
 * Tiny in-page debug logger. Exposed as window.DebugLog.
 *
 *   DebugLog.log(level, message, data?)   // level: 'info' | 'warn' | 'error'
 *
 * Entries buffer until the Vue panel attaches a reactive array via
 * DebugLog.attach(arr); after that, pushes land in the reactive array and the
 * on-page panel updates live. Everything is also mirrored to the console.
 */
(function () {
  const MAX = 600;

  window.DebugLog = {
    _arr: null,
    _buffer: [],
    seq: 0,

    attach(arr) {
      this._arr = arr;
      this._buffer.forEach((e) => arr.push(e));
      this._buffer.length = 0;
    },

    log(level, message, data) {
      const entry = {
        id: (this.seq += 1),
        t: new Date().toLocaleTimeString('en-GB', { hour12: false }) +
          '.' + String(Date.now() % 1000).padStart(3, '0'),
        level: level || 'info',
        message: String(message),
        data: data === undefined ? null : safe(data),
      };
      const sink = this._arr || this._buffer;
      sink.push(entry);
      while (sink.length > MAX) sink.shift();
      const fn = console[level] || console.log;
      fn.call(console, `[dbg] ${entry.message}`, data === undefined ? '' : data);
      return entry;
    },

    info(m, d) { return this.log('info', m, d); },
    warn(m, d) { return this.log('warn', m, d); },
    error(m, d) { return this.log('error', m, d); },

    clear() {
      if (this._arr) this._arr.length = 0;
      this._buffer.length = 0;
    },
  };

  // Make data safe/compact for display (avoid huge dumps / circular refs).
  function safe(data) {
    try {
      if (typeof data === 'string') return data;
      return JSON.parse(JSON.stringify(data, replacer));
    } catch (e) {
      return String(data);
    }
  }
  function replacer(key, value) {
    if (Array.isArray(value) && value.length > 12) {
      return value.slice(0, 12).concat([`…(+${value.length - 12} more)`]);
    }
    return value;
  }

  // Capture uncaught errors so they show in the on-page log too.
  window.addEventListener('error', (e) => {
    window.DebugLog.error('Uncaught error: ' + (e.message || e.error), {
      source: e.filename, line: e.lineno,
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    window.DebugLog.error('Unhandled promise rejection', {
      reason: e.reason && (e.reason.message || String(e.reason)),
    });
  });
})();
