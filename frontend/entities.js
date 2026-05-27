// ============================================================
// ENTITY LAYER
// Inheritance hierarchy:  BaseEntity → Tower / MobileUser / Probe / RadarTarget
// Composition:  Tower owns a BeamformingEngine (which owns a Params)
// ============================================================

// ─── BASE ENTITY ─────────────────────────────────────────────
/**
 * Root of the entity inheritance tree.
 * Holds position and provides the contract that all entities share.
 */
class BaseEntity {
  constructor(x, y) {
    this._x  = x;
    this._y  = y;
    this._id = BaseEntity._nextId++;
  }

  // ---- Position (encapsulated with validation) ----
  get x()  { return this._x; }
  get y()  { return this._y; }
  set x(v) { this._x = v;   }
  set y(v) { this._y = v;   }
  get id() { return this._id; }

  getPosition()        { return { x: this._x, y: this._y }; }
  setPosition(x, y)    { this._x = x; this._y = y; }

  /** Override in subclasses for per-frame logic */
  update(dt) {}

  /** Serialize to plain object for save/export */
  serialize()          { return { x: this._x, y: this._y }; }
}
BaseEntity._nextId = 1;

// ─── TOWER ───────────────────────────────────────────────────
/**
 * 5G base station.
 * Composition: owns a BeamformingEngine (which owns a Params).
 * Association: maintains references to connected MobileUser instances.
 */
class Tower extends BaseEntity {
  // ---- Private encapsulated state (Encapsulation pillar) ----
  #range       = 250;
  #activeUsers = [];   // association — managed via setActiveUsers()

  constructor(x, y, opts = {}) {
    super(x, y);
    // Composition: Tower owns a Params + BeamformingEngine
    this._params = new Params({
      numElements: opts.numElements || 16,
      frequency:   opts.frequency   || 28e9,
      snr:         opts.snr         || 100
    });
    this._engine = new BeamformingEngine(this._params);
  }

  // ---- Delegated accessors — Params encapsulation ----
  get numElements() { return this._params.numElements; }
  get frequency()   { return this._params.frequency;   }
  get snr()         { return this._params.snr;         }

  set numElements(v) { this._params.setNumElements(v); }
  set frequency(v)   { this._params.setFrequency(v);   }
  set snr(v)         { this._params.setSNR(v);         }

  // ---- Range encapsulated ----
  get range()  { return this.#range; }
  set range(v) { this.#range = Math.max(50, v); }

  get effectiveRange() {
    const freqRatio = REFERENCE_5G_FREQUENCY / this.frequency;
    const freqRangeFactor = MathUtils.clamp(freqRatio ** 1.25, 0.28, 3.4);
    return this.#range * freqRangeFactor;
  }

  // ---- activeUsers encapsulated (read-only externally; set via setActiveUsers) ----
  get activeUsers() { return this.#activeUsers; }
  set activeUsers(arr) { this.#activeUsers = Array.isArray(arr) ? arr : []; }

  /** Steer beam toward a target entity */
  steerTo(entity) {
    const angle = MathUtils.angleTo(this, entity);
    this._engine.steer(angle);
    return angle;
  }

  /** Compute beam pattern aimed at this tower's current steering angle */
  getBeamPattern() {
    return this._engine.computeBeamPattern(SPEED_OF_LIGHT);
  }

  /**
   * Return per-user element allocation and beam angle.
   * Called by FiveGSimulator.updateBeamSteering().
   */
  allocateBeams(users) {
    if (!users.length) return [];
    const elemsPerUser = Math.floor(this._params.numElements / users.length);
    return users.map((u, idx) => ({
      user:     u,
      elements: { start: idx * elemsPerUser, count: elemsPerUser },
      angle:    MathUtils.angleTo(this, u)
    }));
  }

  /**
   * Compute signal quality to a user (0..1), affected by distance, SNR,
   * array gain, and the frequency-dependent free-space path loss.
   */
  signalQuality(user) {
    const dist      = MathUtils.distance(this, user);
    const effectiveRange = this.effectiveRange;
    const snrFactor = Math.min(1, this._params.snr / 100);
    const arrayGain = Math.sqrt(this.numElements / 16);
    const normalizedDistance = Math.max(dist, 1) / effectiveRange;
    const normalizedFrequency = this.frequency / REFERENCE_5G_FREQUENCY;
    const distanceFalloff = Math.exp(-2.8 * normalizedDistance ** 1.55);
    const highFreqPenalty = 1 / (1 + 0.55 * Math.max(0, normalizedFrequency - 1) ** 2);
    const wl = MathUtils.wavelength(this.frequency, SPEED_OF_LIGHT);
    const spacing = MathUtils.fiveGElementSpacing();
    const beamElements = user.assignedElements?.count || this.numElements;
    const beamwidth = Math.max(0.025, MathUtils.beamwidth3dB(beamElements, spacing, wl));
    const steerAngle = user.connectedTower === this ? user.beamAngle : MathUtils.angleTo(this, user);
    const angleError = Math.abs(MathUtils.angleDiff(MathUtils.angleTo(this, user), steerAngle));
    const beamFactor = Math.exp(-0.5 * (angleError / Math.max(beamwidth / 2, 0.0125)) ** 2);
    const quality = snrFactor * arrayGain * distanceFalloff * highFreqPenalty * beamFactor;
    return quality < 0.015 ? 0 : MathUtils.clamp(quality, 0, 1);
  }

  serialize() {
    return { ...super.serialize(), numElements: this.numElements, frequency: this.frequency };
  }
}

// ─── MOBILE USER ─────────────────────────────────────────────
/**
 * 5G end device.
 * Inherits position from BaseEntity.
 * Association: connectedTower points to a Tower instance (set externally).
 */
class MobileUser extends BaseEntity {
  static _colors = ['#ff4466','#44ffaa','#ffaa00','#aa44ff','#00ccff','#ff8844'];
  static _colorIdx = 0;

  // ---- Private encapsulated state ----
  #connectedTower  = null;
  #inRange         = false;
  #beamAngle       = 0;
  #assignedElements = null;

  constructor(x, y, opts = {}) {
    super(x, y);
    this.color = opts.color || MobileUser._colors[MobileUser._colorIdx++ % MobileUser._colors.length];
  }

  // ---- Encapsulated getters/setters ----
  get connectedTower()     { return this.#connectedTower; }
  set connectedTower(v)    { this.#connectedTower = v; }

  get inRange()            { return this.#inRange; }
  set inRange(v)           { this.#inRange = !!v; }

  get beamAngle()          { return this.#beamAngle; }
  set beamAngle(v)         { this.#beamAngle = v; }

  get assignedElements()   { return this.#assignedElements; }
  set assignedElements(v)  { this.#assignedElements = v; }

  /** Move by delta, clamped to bounds */
  move(dx, dy, bounds = null) {
    this._x += dx;
    this._y += dy;
    if (bounds) {
      this._x = MathUtils.clamp(this._x, bounds.minX || 0, bounds.maxX || Infinity);
      this._y = MathUtils.clamp(this._y, bounds.minY || 0, bounds.maxY || Infinity);
    }
  }

  /** Disconnect from tower cleanly */
  disconnect() {
    this.#connectedTower  = null;
    this.#inRange         = false;
    this.#assignedElements = null;
  }

  serialize() {
    return { ...super.serialize(), color: this.color };
  }
}

// ─── PROBE ───────────────────────────────────────────────────
/**
 * Ultrasound transducer probe.
 * Composition: owns a BeamformingEngine for delay/apodization computation.
 */
class Probe extends BaseEntity {
  constructor(x, y, opts = {}) {
    super(x, y);
    this._params  = new Params({
      numElements: opts.numElements || 32,
      frequency:   opts.frequency   || 5e6,
      spacing:     opts.spacing     || 0.25,
      snr:         opts.snr         || 100
    });
    this._engine   = new BeamformingEngine(this._params);
    this._steerDeg = 0;
    this._focalDepth = 100;  // mm
    this.arrayType   = opts.arrayType || 'linear';
    this.curvatureRadius = opts.curvatureRadius || 70;
    this.arcAngle        = opts.arcAngle || 1.2;
  }

  // ---- Param delegation ----
  get numElements() { return this._params.numElements; }
  get frequency()   { return this._params.frequency;   }
  get spacing()     { return this._params.spacing;     }
  get snr()         { return this._params.snr;         }
  get steerAngle()  { return this._steerDeg;           }
  get focalDepth()  { return this._focalDepth;         }

  set numElements(v)  { this._params.setNumElements(v); }
  set frequency(v)    { this._params.setFrequency(v);   }
  set spacing(v)      { this._params.setSpacing(v);     }
  set snr(v)          { this._params.setSNR(v);         }
  set steerAngle(deg) { this._steerDeg = MathUtils.clamp(deg, -60, 60); this._params.setSteerAngle(deg * Math.PI / 180); }
  set focalDepth(mm)  { this._focalDepth = MathUtils.clamp(mm, 5, 300); }

  get engine() { return this._engine; }

  /** Build element positions for current array geometry */
  buildElementPositions(cx, cy, scalePx) {
    const spacingPx = this.spacing * scalePx;
    if (this.arrayType === 'curved') {
      return ArrayGeometry.curved(this.numElements, this.curvatureRadius * scalePx * 0.3, this.arcAngle, cx, cy, Math.PI/2);
    }
    return ArrayGeometry.linear(this.numElements, spacingPx, cx, cy, 0);
  }

  /** Compute delays for the current steering + focusing state */
  computeDelays(elementPositions, focalPoint, focusing) {
    const steerRad = this._steerDeg * Math.PI / 180;
    if (focusing && focalPoint) {
      return this._engine.computeFocusingDelays(elementPositions, focalPoint, SPEED_OF_SOUND);
    }
    return this._engine.computeSteeringDelays(elementPositions, steerRad, SPEED_OF_SOUND);
  }

  /** Apodization weights */
  getWeights() { return this._engine.applyWindow(this.numElements); }

  serialize() {
    return { ...super.serialize(), numElements: this.numElements, frequency: this.frequency,
             spacing: this.spacing, arrayType: this.arrayType };
  }
}

// ─── RADAR TARGET ────────────────────────────────────────────
/**
 * Solid body in the radar field.
 * Inherits position from BaseEntity.
 */
class RadarTarget extends BaseEntity {
  constructor(opts = {}) {
    super(opts.x || 300, opts.y || 300);
    this._rcs     = opts.rcs     || 10;   // radar cross-section (m²)
    this._size    = opts.size    || this._rcs;
    this.speed    = opts.speed   || 1.5;
    this.heading  = opts.heading || 0;
    this.detected      = false;
    this.lastDetected  = null;
  }

  get rcs()  { return this._rcs;  }
  get size() { return this._size; }
  set rcs(v)  { this._rcs  = Math.max(0.1, v); this._size = this._rcs; }
  set size(v) { this._size = Math.max(1,   v); this._rcs  = this._size; }

  /** Physics: compute echo power from this target */
  computeEcho(radarPos, beamwidthRad, waveSpeed) {
    const dist   = MathUtils.distance(radarPos, this);
    const angDiff = Math.abs(MathUtils.angleTo(radarPos, this));
    const beamGain = Math.max(0, 1 - angDiff / (beamwidthRad / 2));
    return (this._rcs * beamGain) / (dist * dist + 1);
  }

  /** Move by velocity × heading each frame */
  update(dt) {
    this._x += Math.cos(this.heading) * this.speed;
    this._y += Math.sin(this.heading) * this.speed;
  }

  /** Bounce off rectangular bounds */
  bounceInBounds(w, h, margin = 10) {
    if (this._x < margin || this._x > w - margin) this.heading = Math.PI - this.heading;
    if (this._y < margin || this._y > h - margin) this.heading = -this.heading;
  }

  serialize() {
    return { ...super.serialize(), rcs: this._rcs, speed: this.speed, heading: this.heading };
  }
}