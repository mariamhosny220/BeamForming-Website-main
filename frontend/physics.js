// ============================================================
// BEAMFORMING PHYSICS ENGINE
// OOP Design: Params (Encapsulation) + BeamformingEngine (Abstraction)
// ============================================================

// ─── CONSTANTS ───────────────────────────────────────────────
const SPEED_OF_SOUND = 1540;   // m/s  (ultrasound in tissue)
const SPEED_OF_LIGHT = 3e8;    // m/s  (radar / 5G)
const REFERENCE_5G_FREQUENCY = 28e9;

// ─── MATH UTILS (pure functions, no duplication) ─────────────
const MathUtils = Object.freeze({
  distance(a, b) { const dx = b.x - a.x, dy = b.y - a.y; return Math.sqrt(dx * dx + dy * dy); },
  angleTo(a, b) { return Math.atan2(b.y - a.y, b.x - a.x); },
  clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; },
  normalizeAngle(a) { return ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); },
  angleDiff(a, b) { return ((a - b + 3 * Math.PI) % (2 * Math.PI)) - Math.PI; },
  polarToCart(r, th) { return { x: r * Math.cos(th), y: r * Math.sin(th) }; },
  wavelength(f, speed) { return speed / f; },
  fiveGElementSpacing(fRef = REFERENCE_5G_FREQUENCY) {
    return 0.5 * SPEED_OF_LIGHT / fRef;
  },
  beamwidth3dB(N, d, lam) { return 0.886 * lam / (N * d); },
  /** Bessel I0 for Kaiser window */
  besselI0(x) {
    let s = 1, t = 1;
    for (let k = 1; k <= 20; k++) { t *= (x / 2 / k) ** 2; s += t; }
    return s;
  }
});

// ─── PARAMS ──────────────────────────────────────────────────
/**
 * Encapsulates all beamforming parameters with validation.
 * Every setter validates the value; getParams() returns a frozen snapshot.
 */
class Params {
  constructor(overrides = {}) {
    this._frequency = 1e9;
    this._numElements = 8;
    this._spacing = 0.5;      // wavelengths
    this._steerAngle = 0;        // radians
    this._amplitude = 1.0;
    this._snr = 100;      // linear (0–1000)
    this._windowType = 'hamming';
    this._kaiserBeta = 6;
    Object.entries(overrides).forEach(([k, v]) => {
      const setter = 'set' + k.charAt(0).toUpperCase() + k.slice(1);
      if (typeof this[setter] === 'function') this[setter](v);
    });
  }

  // ---- Setters with validation ----
  setFrequency(f) { if (f > 0) this._frequency = f; else throw new RangeError('frequency must be > 0'); }
  setNumElements(n) { if (n >= 1) this._numElements = Math.round(n); else throw new RangeError('numElements >= 1'); }
  setSpacing(d) { if (d > 0) this._spacing = d; else throw new RangeError('spacing must be > 0'); }
  setSteerAngle(a) { this._steerAngle = MathUtils.clamp(a, -Math.PI / 2, Math.PI / 2); }
  setAmplitude(a) { if (a >= 0) this._amplitude = a; else throw new RangeError('amplitude >= 0'); }
  setSNR(snr) { this._snr = MathUtils.clamp(snr, 0, 1000); }
  setWindow(type) {
    const valid = ['none', 'hanning', 'hamming', 'blackman', 'kaiser'];
    if (valid.includes(type)) this._windowType = type;
    else throw new RangeError(`Unknown window: ${type}`);
  }
  setKaiserBeta(b) { this._kaiserBeta = MathUtils.clamp(b, 0.5, 20); }

  // ---- Getters ----
  get frequency() { return this._frequency; }
  get numElements() { return this._numElements; }
  get spacing() { return this._spacing; }
  get steerAngle() { return this._steerAngle; }
  get amplitude() { return this._amplitude; }
  get snr() { return this._snr; }
  get windowType() { return this._windowType; }
  get kaiserBeta() { return this._kaiserBeta; }

  /** Returns a frozen plain-object snapshot for export / serialization */
  getParams() {
    return Object.freeze({
      frequency: this._frequency,
      numElements: this._numElements,
      spacing: this._spacing,
      steerAngle: this._steerAngle,
      amplitude: this._amplitude,
      snr: this._snr,
      windowType: this._windowType,
      kaiserBeta: this._kaiserBeta
    });
  }

  /** Clone with optional overrides */
  clone(overrides = {}) { return new Params({ ...this.getParams(), ...overrides }); }
}

// ─── BEAMFORMING ENGINE ───────────────────────────────────────
/**
 * Core physics computation engine.
 * Composed inside entities (Tower, Probe) — never subclassed.
 * All methods are pure (no side-effects on external state).
 */
class BeamformingEngine {
  constructor(params) {
    if (!(params instanceof Params)) throw new TypeError('BeamformingEngine requires a Params instance');
    this.params = params;
  }

  /** Update the steering angle (delegates to Params) */
  steer(angleRad) { this.params.setSteerAngle(angleRad); }

  /** Per-element apodization weights (no duplication across modes) */
  applyWindow(N = this.params.numElements) {
    const { windowType, kaiserBeta } = this.params;
    return Array.from({ length: N }, (_, i) => {
      switch (windowType) {
        case 'hanning': return 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
        case 'hamming': return 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (N - 1));
        case 'blackman': return 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)) + 0.08 * Math.cos(4 * Math.PI * i / (N - 1));
        case 'kaiser': return this._kaiser(i, N, kaiserBeta);
        default: return 1.0;  // rectangular
      }
    });
  }

  _kaiser(n, N, beta) {
    const alpha = (N - 1) / 2;
    return MathUtils.besselI0(beta * Math.sqrt(1 - ((n - alpha) / alpha) ** 2)) / MathUtils.besselI0(beta);
  }

  /**
   * Add noise to a Float32Array based on SNR parameter.
   * SNR is linear (0–1000); SNR=0 → heavy noise, SNR=1000 → noiseless.
   * Uses correct formula: noise_power = signal_power / max(SNR, 1)
   * so that SNR=1 produces noise amplitude equal to signal RMS.
   */
  addNoise(signal) {
    const snr = this.params.snr;
    if (snr >= 1000) return signal;          // effectively noiseless
    const power = signal.reduce((s, v) => s + v * v, 0) / signal.length;
    // Clamp SNR to minimum of 0.1 to avoid division-by-zero explosion at SNR=0
    const snrClamped = Math.max(snr, 0.1);
    const noisePow = power / snrClamped;
    const noiseAmp = Math.sqrt(Math.max(0, noisePow));
    for (let i = 0; i < signal.length; i++) signal[i] += noiseAmp * (Math.random() * 2 - 1);
    return signal;
  }

  /** Steering vector phases for a linear array */
  computeSteeringVector(theta, waveSpeed) {
    const { numElements, spacing, frequency } = this.params;
    const lam = MathUtils.wavelength(frequency, waveSpeed);
    return Array.from({ length: numElements }, (_, n) =>
      (2 * Math.PI * n * spacing * Math.sin(theta)) / lam
    );
  }

  /** Array factor magnitude at evalAngle */
  computeArrayFactor(evalAngle, waveSpeed) {
    const { numElements, spacing, frequency, steerAngle } = this.params;
    const lam = MathUtils.wavelength(frequency, waveSpeed);
    const weights = this.applyWindow(numElements);
    let re = 0, im = 0;
    for (let n = 0; n < numElements; n++) {
      const phase = (2 * Math.PI * n * spacing / lam) * (Math.sin(evalAngle) - Math.sin(steerAngle));
      re += weights[n] * Math.cos(phase);
      im += weights[n] * Math.sin(phase);
    }
    const wSum = weights.reduce((a, b) => a + b, 0) || 1;
    return Math.sqrt(re * re + im * im) / wSum;
  }

  /**
   * Full beam pattern across [-π/2, π/2].
   * Returns [{angle, magnitude}] where magnitude is 0..1.
   */
  computeBeamPattern(waveSpeed, resolution = 360) {
    return Array.from({ length: resolution + 1 }, (_, i) => {
      const angle = -Math.PI / 2 + (Math.PI * i) / resolution;
      return { angle, magnitude: this.computeArrayFactor(angle, waveSpeed) };
    });
  }

  /**
   * Field intensity at a single point from element positions.
   * Uses delay + apodization. SNR noise applied to result.
   */
  computeFieldIntensity(elementPositions, delays, evalPoint, time, waveSpeed) {
    const { frequency, amplitude } = this.params;
    const omega = 2 * Math.PI * frequency;
    const k = omega / waveSpeed;
    const weights = this.applyWindow(elementPositions.length);
    let re = 0, im = 0;
    for (let i = 0; i < elementPositions.length; i++) {
      const dist = MathUtils.distance(elementPositions[i], evalPoint);
      if (dist < 1e-10) continue;
      const att = amplitude / (1 + dist * 0.005);
      const ph = omega * time - k * dist - omega * (delays[i] || 0);
      re += weights[i] * att * Math.cos(ph);
      im += weights[i] * att * Math.sin(ph);
    }
    const raw = Math.sqrt(re * re + im * im);
    // Apply SNR: scale noise contribution — SNR 1000=noiseless, 0=heavily degraded
    // Map [0,1000] → [0.1, 1.0] so SNR=0 still shows faint signal (not blank)
    const snrFactor = 0.1 + 0.9 * Math.min(1, this.params.snr / 1000);
    return raw * snrFactor;
  }

  // ── Delay computation helpers (shared by all modes) ──

  /** Focusing delays: delay each element to converge at focalPoint */
  computeFocusingDelays(elementPositions, focalPoint, waveSpeed) {
    const dists = elementPositions.map(p => MathUtils.distance(p, focalPoint));
    const maxD = Math.max(...dists);
    return dists.map(d => (maxD - d) / waveSpeed);
  }

  /** Steering delays: plane-wave steering toward theta */
  computeSteeringDelays(elementPositions, theta, waveSpeed) {
    const projs = elementPositions.map(p => p.x * Math.sin(theta) + p.y * Math.cos(theta));
    const maxP = Math.max(...projs);
    return projs.map(p => (maxP - p) / waveSpeed);
  }
}

// ─── ARRAY GEOMETRY ──────────────────────────────────────────
/** Factory functions for element position arrays — no duplication */
const ArrayGeometry = Object.freeze({
  linear(N, spacingPx, cx, cy, angle = 0) {
    const total = (N - 1) * spacingPx;
    return Array.from({ length: N }, (_, i) => ({
      x: cx + (i * spacingPx - total / 2) * Math.cos(angle + Math.PI / 2),
      y: cy + (i * spacingPx - total / 2) * Math.sin(angle + Math.PI / 2)
    }));
  },
  curved(N, radius, arcAngle, cx, cy, orientation = -Math.PI / 2) {
    const half = arcAngle / 2;
    return Array.from({ length: N }, (_, i) => {
      const th = orientation + half - (i / (N - 1)) * arcAngle;
      return { x: cx + radius * Math.cos(th), y: cy + radius * Math.sin(th), normal: th + Math.PI };
    });
  }
});

// ─── LEGACY SHIM (keeps existing callers working) ─────────────
/**
 * Backward-compatible Physics namespace so existing code in ultrasound.js,
 * fiveg.js, radar.js, scenarios.js doesn't break.
 * All calls delegate to MathUtils or are re-exported constants.
 */
const Physics = Object.freeze({
  SPEED_OF_SOUND,
  SPEED_OF_LIGHT,
  SPEED_OF_EM: SPEED_OF_LIGHT,
  distance: MathUtils.distance,
  angleTo: MathUtils.angleTo,
  clamp: MathUtils.clamp,
  normalizeAngle: MathUtils.normalizeAngle,
  polarToCart: MathUtils.polarToCart,
  wavelength: MathUtils.wavelength,
  beamwidth3dB: MathUtils.beamwidth3dB,
  linearArrayPositions: ArrayGeometry.linear,
  curvedArrayPositions: ArrayGeometry.curved,
  /** Convenience: compute array factor without engine instance */
  arrayFactor(N, d, lam, steer, eval_) {
    const eng = new BeamformingEngine(new Params({ numElements: N, spacing: d / lam, steerAngle: steer }));
    // Override spacing in wavelengths to match raw pixel call
    eng.params._spacing = d;
    const wl = lam;
    let re = 0, im = 0;
    for (let n = 0; n < N; n++) {
      const ph = (2 * Math.PI * n * d / wl) * (Math.sin(eval_) - Math.sin(steer));
      re += Math.cos(ph); im += Math.sin(ph);
    }
    return Math.sqrt(re * re + im * im) / N;
  },
  computeBeamPattern(N, d, lam, steer, res = 360) {
    return Array.from({ length: res + 1 }, (_, i) => {
      const angle = -Math.PI / 2 + (Math.PI * i) / res;
      return { angle, magnitude: Physics.arrayFactor(N, d, lam, steer, angle) };
    });
  },
  waveIntensity(srcPos, delays, phases, freq, speed, evalPt, time) {
    const omega = 2 * Math.PI * freq;
    const k = omega / speed;
    let re = 0, im = 0;
    for (let i = 0; i < srcPos.length; i++) {
      const dist = MathUtils.distance(srcPos[i], evalPt);
      if (dist < 1e-10) continue;
      const att = 1 / (1 + dist * 0.005);
      const ph = omega * time - k * dist - (phases[i] || 0) - omega * (delays[i] || 0);
      re += att * Math.cos(ph); im += att * Math.sin(ph);
    }
    return Math.sqrt(re * re + im * im);
  },
  focusingDelays(pos, focal, speed) {
    const dists = pos.map(p => MathUtils.distance(p, focal));
    const mx = Math.max(...dists);
    return dists.map(d => (mx - d) / speed);
  },
  steeringDelays(pos, theta, speed) {
    const proj = pos.map(p => p.x * Math.sin(theta) + p.y * Math.cos(theta));
    const mx = Math.max(...proj);
    return proj.map(p => (mx - p) / speed);
  }
});