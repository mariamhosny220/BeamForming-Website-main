// ============================================================
// SYSTEM LAYER
// EventBus  — decoupled pub/sub
// StateManager — global undo/snapshot
// ScenarioManager — save / load / delete / import / export
// ============================================================

// ─── EVENT BUS ───────────────────────────────────────────────
/**
 * Lightweight pub/sub. All cross-layer communication goes through here —
 * no direct references from UI to simulators.
 */
class EventBus {
  constructor() { this._handlers = {}; }

  on(event, fn) {
    (this._handlers[event] = this._handlers[event] || []).push(fn);
    return () => this.off(event, fn);  // returns unsubscribe fn
  }

  emit(event, data) {
    (this._handlers[event] || []).forEach(fn => fn(data));
  }

  off(event, fn) {
    if (!fn) { delete this._handlers[event]; return; }
    this._handlers[event] = (this._handlers[event] || []).filter(h => h !== fn);
  }
}

/** Singleton bus — import-once pattern */
const Bus = new EventBus();

// ─── STATE MANAGER ───────────────────────────────────────────
/**
 * Manages a ring buffer of snapshots for undo/reset.
 */
class StateManager {
  constructor(maxHistory = 20) {
    this._history = [];
    this._maxH = maxHistory;
    this._current = null;
  }

  /** Save a deep-clone snapshot of world state */
  saveState(world) {
    const snap = JSON.parse(JSON.stringify(world));
    this._history.push(snap);
    if (this._history.length > this._maxH) this._history.shift();
    this._current = snap;
    Bus.emit('state:saved', snap);
    return snap;
  }

  /** Restore the most recent snapshot */
  loadState(data) {
    const snap = data || this._history[this._history.length - 1];
    if (snap) { this._current = snap; Bus.emit('state:loaded', snap); }
    return snap || null;
  }

  /** Pop last snapshot (undo one step) */
  undo() {
    if (this._history.length < 2) return null;
    this._history.pop();
    return this.loadState(this._history[this._history.length - 1]);
  }

  reset() { this._history = []; this._current = null; Bus.emit('state:reset'); }

  get current() { return this._current; }
}

// ─── SCENARIO MANAGER ────────────────────────────────────────
const ScenarioManager = (() => {
  // ---- Predefined scenarios (immutable) ----
  const PREDEFINED = {
    // ── ULTRASOUND ──────────────────────────────────────────
    ultrasound_cardiac: {
      mode: 'ultrasound', name: 'Cardiac Imaging',
      description: 'Curved array, wide FOV for heart imaging.',
      params: {
        numElements: 64, spacing: 0.3, frequency: 3.5e6, arrayType: 'curved',
        curvatureRadius: 60, arcAngle: 1.2, steerAngle: 0, focalDepth: 120, focusing: true
      }
    },
    ultrasound_linear: {
      mode: 'ultrasound', name: 'Linear Vascular Probe',
      description: 'High-frequency linear array for superficial vessels.',
      params: {
        numElements: 128, spacing: 0.2, frequency: 7.5e6, arrayType: 'linear',
        steerAngle: 0, focalDepth: 50, focusing: true
      }
    },
    ultrasound_steered: {
      mode: 'ultrasound', name: 'Steered Beam 15°',
      description: 'Phased array steering 15° for off-axis imaging.',
      params: {
        numElements: 32, spacing: 0.25, frequency: 5e6, arrayType: 'linear',
        steerAngle: 15, focalDepth: 80, focusing: true
      }
    },

    // ── 5G ──────────────────────────────────────────────────
    fiveg_urban: {
      mode: 'fiveg', name: 'Urban Dense Deployment',
      description: 'Three towers, overlapping coverage in urban environment.',
      params: {
        towers: [
          { x: 150, y: 200, numElements: 16, frequency: 28e9, range: 200 },
          { x: 450, y: 150, numElements: 16, frequency: 28e9, range: 200 },
          { x: 600, y: 400, numElements: 16, frequency: 28e9, range: 200 }
        ],
        users: [{ x: 300, y: 300 }, { x: 500, y: 300 }, { x: 400, y: 450 }]
      }
    },
    fiveg_single: {
      mode: 'fiveg', name: 'Single Tower Multi-User',
      description: 'One base station managing beams to multiple users.',
      params: {
        towers: [{ x: 380, y: 200, numElements: 32, frequency: 28e9, range: 350 }],
        users: [{ x: 200, y: 400 }, { x: 380, y: 500 }, { x: 560, y: 380 }]
      }
    },
    fiveg_handover: {
      mode: 'fiveg', name: 'Handover Scenario',
      description: 'Two towers at range boundary showing handover.',
      params: {
        towers: [
          { x: 200, y: 300, numElements: 16, frequency: 28e9, range: 280 },
          { x: 560, y: 300, numElements: 16, frequency: 28e9, range: 280 }
        ],
        users: [{ x: 380, y: 300 }]
      }
    },

    // ── RADAR ───────────────────────────────────────────────
    radar_broad_scan: {
      mode: 'radar', name: 'Broad Fast Scan (Detection)',
      description: 'Quick broad scan (15° beam) to quickly detect if anybody is there.',
      params: {
        numElements: 8, spacing: 0.5, frequency: 5e9, scanSpeed: 2.5,
        scanRange: 350, beamWidthDeg: 15, trackingMode: false, smartMode: false,
        targets: [
          { x: 450, y: 280, rcs: 20, speed: 1, heading: 1.2 },
          { x: 350, y: 200, rcs: 5, speed: 0.8, heading: 0.4 }
        ]
      }
    },
    radar_narrow_focus: {
      mode: 'radar', name: 'Narrow Slow Scan (Focus)',
      description: 'Focus with thinner beam (2°) and slow speed to obtain accurate estimation for the body size.',
      params: {
        numElements: 32, spacing: 0.5, frequency: 10e9, scanSpeed: 0.2,
        scanRange: 350, beamWidthDeg: 2, trackingMode: false, smartMode: false,
        targets: [
          { x: 450, y: 280, rcs: 20, speed: 1, heading: 1.2 },
          { x: 350, y: 200, rcs: 5, speed: 0.8, heading: 0.4 }
        ]
      }
    }
  };

  let _custom = {};

  // ---- Load persisted custom scenarios (with validation) ----
  (() => {
    try {
      const raw = localStorage.getItem('bf_scenarios');
      if (raw) {
        const parsed = JSON.parse(raw);
        // Only keep valid scenarios that have mode + params
        Object.entries(parsed).forEach(([k, v]) => {
          if (v && v.mode && (v.params || v.towers)) _custom[k] = v;
        });
      }
    } catch { _custom = {}; }
  })();

  function _persist() {
    try { localStorage.setItem('bf_scenarios', JSON.stringify(_custom)); } catch { }
  }

  return {
    getAll() { return { ...PREDEFINED, ..._custom }; },

    /** Sync version — returns plain object */
    getByMode(m) {
      const all = this.getAll();
      return Object.fromEntries(Object.entries(all).filter(([, s]) => s.mode === m));
    },

    /** Async version — resolves with same result (for callers using await) */
    async getByModeAsync(m) { return this.getByMode(m); },

    save(key, scenario) {
      _custom[key] = { ...scenario, custom: true };
      _persist();
      Bus.emit('scenario:saved', key);
    },

    /** Sync load — validates scenario has required structure */
    load(key) {
      const s = this.getAll()[key];
      if (!s) return null;
      // Ensure scenario has params object (migrate flat structure if needed)
      if (!s.params && (s.towers || s.users)) {
        return { ...s, params: { towers: s.towers || [], users: s.users || [] } };
      }
      return s;
    },

    /** Async load alias — needed by app.js _loadScenario */
    async loadAsync(key) { return this.load(key); },

    remove(key) {
      if (_custom[key]) { delete _custom[key]; _persist(); Bus.emit('scenario:deleted', key); }
    },
    exportJSON(key) { const s = this.load(key); return s ? JSON.stringify(s, null, 2) : null; },
    importJSON(json) {
      try {
        const s = JSON.parse(json);
        if (!s.mode || !s.name) throw new Error('Invalid');
        const key = `custom_${Date.now()}`;
        this.save(key, s);
        return key;
      } catch { return null; }
    },
    list() { return Object.entries(this.getAll()).map(([k, v]) => ({ key: k, ...v })); }
  };
})();