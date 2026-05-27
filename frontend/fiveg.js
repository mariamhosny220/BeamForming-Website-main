// ============================================================
// SIMULATION LAYER — Polymorphism + Inheritance
// BaseSimulator (abstract) → FiveGSimulator
// Private state via # fields (ES2022 private class fields)
// ============================================================

// ─── BASE SIMULATOR (ABSTRACT) ───────────────────────────────
/**
 * Abstract base for all simulation modes.
 * Provides: render loop, start/stop, getState/setState, params management.
 * Subclasses MUST implement: compute(), _renderScene()
 */
class BaseSimulator {
  // Private fields
  #animFrame = null;
  #time = 0;

  constructor(canvas, uiCallbacks = {}) {
    if (new.target === BaseSimulator) throw new TypeError('BaseSimulator is abstract');
    this.renderer    = new Renderer(canvas);
    this.canvas      = canvas;
    this.ui          = uiCallbacks;
    this._state      = new StateManager();
  }

  get time() { return this.#time; }

  // ---- Abstract interface (polymorphic contract) ----
  compute()       { throw new Error(`${this.constructor.name} must implement compute()`); }
  _renderScene()  { throw new Error(`${this.constructor.name} must implement _renderScene()`); }

  // ---- Animation loop (shared — zero duplication) ----
  start() {
    const loop = (ts) => {
      this.#time = ts ? Math.floor(ts / 16) : 0;
      this.compute();
      this.renderer.clear();
      this._renderScene();
      this.#animFrame = requestAnimationFrame(loop);
    };
    this.#animFrame = requestAnimationFrame(loop);
  }

  stop() {
    if (this.#animFrame) { cancelAnimationFrame(this.#animFrame); this.#animFrame = null; }
    this._onStop();
  }

  get animFrame() { return this.#animFrame; } // read-only for subclass checks

  /** Override for cleanup on stop */
  _onStop() {}

  // ---- State serialization ----
  getState()      { return JSON.parse(JSON.stringify(this._buildState())); }
  setState(state) { this._applyState(state); }
  _buildState()   { return { params: this.params }; }
  _applyState(s)  { if (s.params) Object.assign(this.params, s.params); }

  setParams(p) {
    Object.assign(this.params, p);
    Bus.emit('params:changed', { mode: this.constructor.name, params: this.params });
  }

  /** Helper: emit UI feedback */
  _toast(msg) { Bus.emit('ui:toast', msg); }
}

// ─── 5G SIMULATOR ─────────────────────────────────────────────
class FiveGSimulator extends BaseSimulator {
  // Private state
  #placingTower  = false;
  #placingUser   = false;
  #waves         = [];
  #selectedUser  = null;
  #selectedTower = null;
  #mouseX        = 0;
  #mouseY        = 0;

  constructor(canvas, uiCallbacks) {
    super(canvas, uiCallbacks);

    this.params = {
      numElements:  16,
      frequency:    28e9,
      range:        250,
      snr:          100,
      windowType:   'hamming',  // apodization: none | hanning | hamming | blackman | kaiser
      showBeams:    true,
      showCoverage: true,
      showElements: true,
      showInfoBoxes: true
    };

    this.towers = [];   // Tower[]
    this.users  = [];   // MobileUser[]

    this._bindInput();

    // Defer scenario apply until canvas has real pixel dimensions.
    // Guard with try/catch so a bad scenario never crashes the whole sim.
    const tryApplyDefault = () => {
      try {
        if (this.renderer.width > 0 && this.renderer.height > 0) {
          const sc = ScenarioManager.load('fiveg_urban');
          this._applyScenario(sc);
        } else {
          requestAnimationFrame(tryApplyDefault);
        }
      } catch (err) {
        console.warn('[5G] _applyScenario error (ignored):', err);
      }
    };
    requestAnimationFrame(tryApplyDefault);
  }

  // ── Public API ──────────────────────────────────────────────

  get selectedUser()  { return this.#selectedUser; }
  get selectedTower() { return this.#selectedTower; }

  /**
   * Update a single tower's params independently (does not touch other towers).
   * @param {Tower} tower
   * @param {{ numElements?: number, frequency?: number, range?: number, snr?: number }} params
   */
  updateTower(tower, params = {}) {
    if (!tower || !this.towers.includes(tower)) return;
    if (params.numElements !== undefined) tower.numElements = params.numElements;
    if (params.frequency   !== undefined) tower.frequency   = params.frequency;
    if (params.range       !== undefined) tower.range       = params.range;
    if (params.snr         !== undefined) tower.snr         = params.snr;
    if (params.windowType  !== undefined) tower.windowType  = params.windowType;
    this._updateConnections();
    Bus.emit('fiveg:tower_updated', tower);
  }

  selectTower(tower) {
    this.#selectedTower = tower || null;
    Bus.emit('fiveg:tower_selected', this.#selectedTower);
  }

  addTower(x, y, opts = {}) {
    if (this.towers.length >= 5) { this._toast('Max 5 towers'); return null; }
    const t = new Tower(x, y, {
      numElements: opts.numElements || this.params.numElements,
      frequency:   opts.frequency   || this.params.frequency,
      range:       opts.range       || this.params.range,
      snr:         opts.snr         !== undefined ? opts.snr        : this.params.snr,
      windowType:  opts.windowType  !== undefined ? opts.windowType : this.params.windowType
    });
    this.towers.push(t);
    this._updateConnections();
    Bus.emit('fiveg:tower_added', t);
    return t;
  }

  removeTower(tower) {
    this.towers = this.towers.filter(t => t !== tower);
    if (this.#selectedTower === tower) this.#selectedTower = null;
    this._updateConnections();
  }

  addUser(x, y) {
    if (this.users.length >= 8) { this._toast('Max 8 users'); return null; }
    const u = new MobileUser(x, y);
    this.users.push(u);
    this._updateConnections();
    Bus.emit('fiveg:user_added', u);
    return u;
  }

  removeUser(user) {
    this.users = this.users.filter(u => u !== user);
    if (this.#selectedUser === user) this.#selectedUser = null;
    this._updateConnections();
  }

  startPlacingTower() { this.#placingTower = true; this.canvas.style.cursor = 'crosshair'; }
  startPlacingUser()  { this.#placingUser  = true; this.canvas.style.cursor = 'crosshair'; }
  removeSelectedUser(){ if (this.#selectedUser) this.removeUser(this.#selectedUser); }

  // ── Core simulation ─────────────────────────────────────────

  compute() {
    if (this.time % 5 === 0) this._updateConnections();
    this._spawnWaves();
  }

  /** Assign each user to nearest in-range tower (with hysteresis handover) */
  _updateConnections() {
    // Helper: compute per-tower SNR normalised value using the same logic as the global SNR slider.
    // Each tower uses its own tower.snr (0-1000), falling back to this.params.snr if not set.
    // snrN=1 (snr=1000): full quality  |  snrN=0 (snr=0): no link
    const getTowerSNR = (tower) => {
      const towerSnr = tower.snr !== undefined ? tower.snr : this.params.snr;
      return MathUtils.clamp(towerSnr / 1000, 0, 1);
    };
    // Minimum signal quality threshold — rises as SNR falls.
    // At snr=1000: threshold=0 (any signal works), at snr=400: threshold≈0.18, at snr=0: threshold=0.6
    const getMinQThreshold = (snrN) => MathUtils.clamp((1 - snrN) * 0.6, 0, 0.6);

    this.users.forEach(user => {
      let best = null, bestQ = 0, bestSnrN = 1;
      this.towers.forEach(tower => {
        const rawQ        = tower.signalQuality(user);
        const snrN        = getTowerSNR(tower);
        const minQThresh  = getMinQThreshold(snrN);
        // SNR scales effective quality — low SNR degrades the link
        const q = rawQ * snrN;
        // Only connect if effective quality clears this tower's SNR threshold
        if (q > bestQ && rawQ > minQThresh) { bestQ = q; best = tower; bestSnrN = snrN; }
      });
      // Hysteresis: keep current tower if still good enough (using that tower's own SNR)
      if (user.connectedTower && user.connectedTower !== best) {
        const curSnrN    = getTowerSNR(user.connectedTower);
        const curMinQThr = getMinQThreshold(curSnrN);
        const curRawQ    = user.connectedTower.signalQuality(user);
        const curQ       = curRawQ * curSnrN;
        if (curQ > bestQ * 0.85 && curRawQ > curMinQThr) { best = user.connectedTower; bestSnrN = curSnrN; }
      }
      user.connectedTower = best;
      user.inRange = best !== null;
      // Store effective quality on user so renderers can read it without re-computing
      user.effectiveQuality = best ? best.signalQuality(user) * bestSnrN : 0;
    });

    // Distribute array elements per user per tower
    this.towers.forEach(tower => {
      const connected = this.users.filter(u => u.connectedTower === tower);
      tower.activeUsers = connected;
      const allocs = tower.allocateBeams(connected);
      allocs.forEach(({ user, elements, angle }) => {
        user.assignedElements = elements;
        user.beamAngle = angle;
      });
    });

    Bus.emit('fiveg:connections_updated', { towers: this.towers, users: this.users });
  }

  _spawnWaves() {
    if (this.time % 3 !== 0) return;
    this.towers.forEach(tower => {
      tower.activeUsers.forEach(user => {
        this.#waves.push({
          cx: tower.x, cy: tower.y,
          radius: 0,
          maxRadius: MathUtils.distance(tower, user) + 30,
          color: user.color
        });
      });
    });
    this.#waves = this.#waves.filter(w => w.radius < w.maxRadius + 10);
  }

  _applyScenario(scenario) {
    if (!scenario) return;

    // Support both { params: { towers, users } } and flat { towers, users }
    const data = (scenario.params && (scenario.params.towers || scenario.params.users))
      ? scenario.params
      : scenario;

    const towersArr = Array.isArray(data.towers) ? data.towers : [];
    const usersArr  = Array.isArray(data.users)  ? data.users  : [];

    this.towers = [];
    this.users  = [];

    // Scenario positions were authored for a 760×540 reference canvas.
    // Scale proportionally to the actual canvas so nothing lands at (0,0).
    const REF_W = 760, REF_H = 540;
    const W = this.renderer.width  || REF_W;
    const H = this.renderer.height || REF_H;
    const scaleX = W / REF_W;
    const scaleY = H / REF_H;

    towersArr.forEach(t => this.addTower(t.x * scaleX, t.y * scaleY, t));
    usersArr.forEach(u  => this.addUser(u.x  * scaleX, u.y  * scaleY));

    this._updateConnections();
  }

  // ── Analysis data for modal viewers ─────────────────────────

  /**
   * Compute interference heatmap on a coarse grid.
   * Returns { width, height, cells } where cells[y][x] = amplitude -1..1
   * (+ve = constructive, -ve = destructive)
   */
  getInterferenceData(gridW = 80, gridH = 60) {
    const W = this.renderer.width  || 760;
    const H = this.renderer.height || 540;
    const cells = [];
    for (let gy = 0; gy < gridH; gy++) {
      const row = [];
      for (let gx = 0; gx < gridW; gx++) {
        const px = (gx + 0.5) * (W / gridW);
        const py = (gy + 0.5) * (H / gridH);
        let sumRe = 0, sumIm = 0;
        this.towers.forEach(tower => {
          const dist = MathUtils.distance(tower, { x: px, y: py });
          if (dist < 1) return;
          const lam = MathUtils.wavelength(tower.frequency, SPEED_OF_LIGHT) * 1e6; // scale px
          const phase = (2 * Math.PI * dist) / Math.max(lam, 8);
          const effectiveRange = tower.effectiveRange || tower.range;
          const amp   = Math.exp(-2.2 * (dist / Math.max(effectiveRange, 1)) ** 1.45);
          sumRe += amp * Math.cos(phase);
          sumIm += amp * Math.sin(phase);
        });
        row.push(Math.sqrt(sumRe * sumRe + sumIm * sumIm) * Math.sign(sumRe));
      }
      cells.push(row);
    }
    return { width: gridW, height: gridH, cells };
  }

  /**
   * Generate per-element apodization weights for a given window type.
   * Matches the radar.js applyWindow() logic so sidelobe behaviour is consistent.
   */
  _applyWindow(n, windowType) {
    // Edge case: single element — no windowing possible
    if (n <= 1) return [1.0];

    // Modified Bessel function I₀(x) via Taylor series — needed for Kaiser window.
    const _i0 = (x) => {
      let sum = 1, term = 1;
      const x2 = (x / 2) ** 2;
      for (let k = 1; k <= 20; k++) {
        term *= x2 / (k * k);
        sum  += term;
        if (term < 1e-10 * sum) break;
      }
      return sum;
    };

    const w = [];
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1); // 0 → 1
      switch (windowType) {
        case 'hanning':
          w.push(0.5 * (1 - Math.cos(2 * Math.PI * x)));
          break;
        case 'hamming':
          w.push(0.54 - 0.46 * Math.cos(2 * Math.PI * x));
          break;
        case 'blackman':
          w.push(0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x));
          break;
        case 'kaiser': {
          // Correct formula: w[i] = I₀(β √(1 − r²)) / I₀(β),  r ∈ [−1, +1]
          const beta = 6;
          const r = (2 * i / (n - 1)) - 1;
          w.push(_i0(beta * Math.sqrt(Math.max(0, 1 - r * r))) / _i0(beta));
          break;
        }
        default:
          w.push(1.0); // rectangular — no windowing
      }
    }

    // Normalise so peak weight = 1
    const maxW = Math.max(...w);
    return maxW > 0 ? w.map(v => v / maxW) : w.map(() => 1.0);
  }

  /**
   * Compute beam radiation pattern for each tower (polar).
   * Returns array of { tower, towerIdx, steerAngle, windowType, points: [{angle, gain}] }
   * Applies apodization windowing to suppress sidelobes when windowType is set.
   */
  getBeamProfiles(steps = 360) {
    return this.towers.map((tower, towerIdx) => {
      // Each tower uses its own windowType, falling back to global param
      const windowType = tower.windowType !== undefined ? tower.windowType : (this.params.windowType || 'none');
      const points = [];
      const n   = tower.numElements;
      const lam = MathUtils.wavelength(tower.frequency, SPEED_OF_LIGHT) * 1e6;
      const d   = MathUtils.fiveGElementSpacing ? MathUtils.fiveGElementSpacing() : lam * 0.5;

      // Per-element apodization weights
      const weights = this._applyWindow(n, windowType);

      // Steering angle: towards first connected user, or 0
      const steerUser  = tower.activeUsers[0];
      const steerAngle = steerUser ? MathUtils.angleTo(tower, steerUser) : 0;

      for (let i = 0; i < steps; i++) {
        const theta = (i / steps) * 2 * Math.PI - Math.PI;
        // Weighted array factor — sum complex phasors with apodization
        let re = 0, im = 0, wSum = 0;
        for (let el = 0; el < n; el++) {
          const psi  = (2 * Math.PI * d / lam) * el * (Math.cos(theta) - Math.cos(steerAngle));
          re   += weights[el] * Math.cos(psi);
          im   += weights[el] * Math.sin(psi);
          wSum += weights[el];
        }
        const gain = (re * re + im * im) / (wSum * wSum);
        points.push({ angle: theta, gain });
      }
      return { tower, towerIdx, steerAngle, windowType, points };
    });
  }

  _buildState() {
    return {
      params: { ...this.params },
      towers: this.towers.map(t => t.serialize()),
      users:  this.users.map(u => u.serialize())
    };
  }

  _applyState(s) {
    if (!s) return;
    super._applyState(s);   // handles params — no duplication
    if (Array.isArray(s.towers)) {
      this.towers = [];
      s.towers.forEach(t => this.addTower(t.x, t.y, t));
    }
    if (Array.isArray(s.users)) {
      this.users = [];
      s.users.forEach(u => this.addUser(u.x, u.y));
    }
    this._updateConnections();
  }

  // ── Rendering ───────────────────────────────────────────────

  _renderScene() {
    this._drawBackground();
    if (this.params.showCoverage) this._drawCoverage();
    this._advanceWaves();
    if (this.params.showBeams)    this._drawBeams();
    this._drawTowers();
    this._drawUsers();
    // NEW: per-tower live info boxes
    if (this.params.showInfoBoxes) this._drawTowerInfoBoxes();
    // NEW: selected tower editor overlay
    this._drawTowerEditor();
    this._drawStats();
  }

  _drawBackground() {
    const { ctx, width: W, height: H } = this.renderer;
    ctx.fillStyle = '#070d1a';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(30,60,120,0.2)';
    ctx.lineWidth = 0.5;
    for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
    for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }
  }

  _drawCoverage() {
    const { ctx } = this.renderer;
    this.towers.forEach(tower => {
      const effectiveRange = tower.effectiveRange || tower.range;
      const grad = ctx.createRadialGradient(tower.x, tower.y, 0, tower.x, tower.y, effectiveRange);
      grad.addColorStop(0,   'rgba(0,150,255,0.08)');
      grad.addColorStop(0.7, 'rgba(0,100,200,0.04)');
      grad.addColorStop(1,   'rgba(0,80,180,0)');
      ctx.beginPath(); ctx.arc(tower.x, tower.y, effectiveRange, 0, Math.PI*2);
      ctx.fillStyle = grad; ctx.fill();
      ctx.strokeStyle = 'rgba(0,150,255,0.15)';
      ctx.lineWidth = 1; ctx.setLineDash([5,5]); ctx.stroke(); ctx.setLineDash([]);
    });
  }

  _advanceWaves() {
    const { ctx } = this.renderer;
    this.#waves.forEach(w => {
      w.radius += 2.5;
      const alpha = Math.max(0, 0.5 * (1 - w.radius / w.maxRadius));
      ctx.save(); ctx.globalAlpha = alpha;
      ctx.beginPath(); ctx.arc(w.cx, w.cy, w.radius, 0, Math.PI*2);
      ctx.strokeStyle = w.color; ctx.lineWidth = 1; ctx.stroke();
      ctx.restore();
    });
  }

  _drawBeams() {
    const { ctx } = this.renderer;
    // Windowing widens the main beam (trade-off: lower sidelobes = wider beam)
    const bwFactors = { none: 1.0, hanning: 1.5, hamming: 1.3, blackman: 1.7, kaiser: 1.4 };
    this.towers.forEach(tower => {
      // Each tower uses its own windowType, falling back to global param
      const windowType = tower.windowType !== undefined ? tower.windowType : (this.params.windowType || 'none');
      const bwFactor   = bwFactors[windowType] ?? 1.0;
      // Each tower uses its own SNR for the warning label
      const towerSnr   = tower.snr !== undefined ? tower.snr : this.params.snr;
      tower.activeUsers.forEach(user => {
        const angle   = MathUtils.angleTo(tower, user);
        const dist    = MathUtils.distance(tower, user);
        const n       = user.assignedElements ? user.assignedElements.count : tower.numElements;
        const wl      = MathUtils.wavelength(tower.frequency, SPEED_OF_LIGHT);
        const spacing = MathUtils.fiveGElementSpacing ? MathUtils.fiveGElementSpacing() : 0.5 * wl;
        const bw      = Math.max(0.025, MathUtils.beamwidth3dB(n, spacing, wl)) * bwFactor;
        // Read pre-computed SNR-scaled quality from user (set by _updateConnections)
        const quality = user.effectiveQuality ?? 0;
        const halfW   = dist * Math.tan(bw / 2);
        const px      = Math.cos(angle + Math.PI/2), py = Math.sin(angle + Math.PI/2);
        const pts = [
          tower,
          { x: user.x + px*halfW, y: user.y + py*halfW },
          { x: user.x - px*halfW, y: user.y - py*halfW }
        ];
        const grad = ctx.createLinearGradient(tower.x, tower.y, user.x, user.y);
        grad.addColorStop(0, user.color + 'aa');
        grad.addColorStop(1, user.color + '11');
        ctx.save();
        ctx.globalAlpha = 0.4 + quality * 0.5;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        ctx.lineTo(pts[1].x, pts[1].y);
        ctx.lineTo(pts[2].x, pts[2].y);
        ctx.closePath();
        ctx.fillStyle = grad; ctx.fill();
        ctx.beginPath(); ctx.moveTo(tower.x, tower.y); ctx.lineTo(user.x, user.y);
        ctx.strokeStyle = user.color; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.8 * quality;
        ctx.stroke();
        ctx.restore();
        // Signal quality label — uses this tower's SNR + its window type
        const snrLabel = towerSnr >= 700 ? '' : ` ⚠${towerSnr < 400 ? '⛔' : ''}`;
        const winLabel = windowType !== 'none' ? ` [${windowType}]` : '';
        ctx.fillStyle = user.color;
        ctx.font = '9px monospace'; ctx.textAlign = 'center';
        ctx.fillText(`${(quality*100).toFixed(0)}%${snrLabel}`, (tower.x+user.x)/2, (tower.y+user.y)/2 - 4);
        if (winLabel) {
          ctx.fillStyle = 'rgba(150,220,255,0.6)';
          ctx.font = '8px monospace';
          ctx.fillText(winLabel, (tower.x+user.x)/2, (tower.y+user.y)/2 + 7);
        }
      });
    });
  }

  _drawTowers() {
    const { ctx } = this.renderer;
    this.towers.forEach(tower => {
      const isSelected = tower === this.#selectedTower;
      ctx.save();

      // ── Selection ring ───────────────────────────────────────
      if (isSelected) {
        ctx.beginPath();
        ctx.arc(tower.x, tower.y - 12, 28, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,200,50,0.7)';
        ctx.lineWidth   = 2;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.fillStyle   = isSelected ? '#2a6aaa' : '#1a4a7a';
      ctx.strokeStyle = isSelected ? '#ffcc33' : '#2288cc';
      ctx.lineWidth   = 2;
      ctx.beginPath();
      ctx.moveTo(tower.x, tower.y - 24);
      ctx.lineTo(tower.x - 10, tower.y);
      ctx.lineTo(tower.x + 10, tower.y);
      ctx.closePath();
      ctx.fill(); ctx.stroke();

      if (this.params.showElements) {
        const n = Math.min(8, tower.numElements);
        for (let i = 0; i < n; i++) {
          const py = tower.y - 22 + i * (22/n);
          ctx.beginPath(); ctx.moveTo(tower.x-6, py); ctx.lineTo(tower.x+6, py);
          ctx.strokeStyle = tower.activeUsers.length > 0 ? '#00ff88' : '#224466';
          ctx.lineWidth = 1.5; ctx.stroke();
        }
      }
      ctx.fillStyle = '#66aaff'; ctx.font = '10px monospace'; ctx.textAlign = 'center';
      ctx.fillText(`${tower.numElements}T`, tower.x, tower.y + 14);
      ctx.fillText(`${(tower.frequency/1e9).toFixed(0)}GHz`, tower.x, tower.y + 24);

      const pulse = (this.time * 0.02) % 1;
      for (let ring = 0; ring < 3; ring++) {
        const rp = (pulse + ring * 0.33) % 1;
        ctx.save(); ctx.globalAlpha = (1-rp)*0.3;
        ctx.beginPath(); ctx.arc(tower.x, tower.y-24, rp*35, 0, Math.PI*2);
        ctx.strokeStyle = '#00aaff'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
    });
  }

  _drawUsers() {
    const { ctx } = this.renderer;
    this.users.forEach(user => {
      const selected = user === this.#selectedUser;
      const conn     = user.inRange;

      if (conn) {
        ctx.save();
        ctx.globalAlpha = 0.3 + ((Math.sin(this.time*0.06)+1)/2)*0.3;
        ctx.beginPath(); ctx.arc(user.x, user.y, 18, 0, Math.PI*2);
        ctx.strokeStyle = user.color; ctx.lineWidth = 2; ctx.stroke();
        ctx.restore();
      }

      ctx.save();
      ctx.fillStyle   = conn ? user.color : '#444';
      ctx.strokeStyle = selected ? '#fff' : (conn ? user.color : '#666');
      ctx.lineWidth   = selected ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.roundRect(user.x-7, user.y-12, 14, 22, 3);
      ctx.fill(); ctx.stroke();

      ctx.fillStyle = conn ? 'rgba(255,255,255,0.3)' : 'rgba(100,100,100,0.3)';
      ctx.fillRect(user.x-5, user.y-10, 10, 14);
      ctx.restore();

      if (conn) {
        // Use effectiveQuality (SNR-scaled) so bars reflect actual link quality
        const quality = user.effectiveQuality !== undefined ? user.effectiveQuality
          : (user.connectedTower ? user.connectedTower.signalQuality(user) : 0);
        const bars = Math.ceil(quality * 4);
        for (let b = 0; b < 4; b++) {
          ctx.fillStyle = b < bars ? user.color : 'rgba(255,255,255,0.15)';
          ctx.fillRect(user.x-7+b*4, user.y+12-b*2, 3, 4+b*2);
        }
      }
    });
  }

  /**
   * Draw live info cards next to each tower with:
   * - Tower index + frequency header (with gradient)
   * - Per-user steering angle, phase shift, signal quality bar
   * - Animated quality indicator
   */
  _drawTowerInfoBoxes() {
    const { ctx, width: W, height: H } = this.renderer;

    this.towers.forEach((tower, tIdx) => {
      const connUsers = tower.activeUsers;
      const lineH = 14, padX = 10, padY = 8;

      // ── Measure box ──────────────────────────────────────────
      const userRows  = Math.max(1, connUsers.length);
      const rowCount  = 2 + userRows * 3;   // header(2) + per-user(3 lines each)
      const boxW      = 192;
      const boxH      = 26 + rowCount * lineH + padY;

      // Position (avoid overflow)
      let bx = tower.x + 18, by = tower.y - 36;
      if (bx + boxW > W - 6) bx = tower.x - boxW - 18;
      if (by + boxH > H - 6) by = H - boxH - 6;
      if (by < 6) by = 6;

      ctx.save();

      // ── Connector line ───────────────────────────────────────
      ctx.beginPath();
      ctx.moveTo(tower.x, tower.y - 24);
      ctx.lineTo(bx + (tower.x < bx ? 0 : boxW), by + 26);
      ctx.strokeStyle = connUsers.length > 0 ? 'rgba(0,180,255,0.3)' : 'rgba(60,80,100,0.2)';
      ctx.lineWidth   = 0.8;
      ctx.setLineDash([3, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // ── Card shadow ──────────────────────────────────────────
      ctx.shadowColor  = 'rgba(0,150,255,0.18)';
      ctx.shadowBlur   = 10;
      ctx.shadowOffsetX = 2;
      ctx.shadowOffsetY = 2;

      // ── Card background ──────────────────────────────────────
      const bgGrad = ctx.createLinearGradient(bx, by, bx, by + boxH);
      bgGrad.addColorStop(0, 'rgba(4,14,36,0.97)');
      bgGrad.addColorStop(1, 'rgba(2,8,22,0.97)');
      this._roundRect(ctx, bx, by, boxW, boxH, 7);
      ctx.fillStyle = bgGrad;
      ctx.fill();

      ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;

      // ── Card border ──────────────────────────────────────────
      const borderCol = connUsers.length > 0 ? 'rgba(0,180,255,0.5)' : 'rgba(40,70,110,0.4)';
      this._roundRect(ctx, bx, by, boxW, boxH, 7);
      ctx.strokeStyle = borderCol;
      ctx.lineWidth   = 1;
      ctx.stroke();

      // ── Header gradient band ─────────────────────────────────
      const hdrGrad = ctx.createLinearGradient(bx, by, bx + boxW, by);
      hdrGrad.addColorStop(0, connUsers.length > 0 ? 'rgba(0,100,200,0.35)' : 'rgba(20,40,70,0.3)');
      hdrGrad.addColorStop(1, 'rgba(0,0,0,0)');
      this._roundRect(ctx, bx, by, boxW, 24, 7, true);   // top only
      ctx.fillStyle = hdrGrad;
      ctx.fill();

      // ── Header text ──────────────────────────────────────────
      // Tower icon dot
      ctx.beginPath();
      ctx.arc(bx + 10, by + 12, 4, 0, Math.PI * 2);
      ctx.fillStyle = connUsers.length > 0 ? '#00aaff' : '#335566';
      ctx.fill();
      // Pulse ring on active tower
      if (connUsers.length > 0) {
        const pulse = (this.time * 0.04) % 1;
        ctx.beginPath();
        ctx.arc(bx + 10, by + 12, 4 + pulse * 6, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(0,150,255,${(1 - pulse) * 0.5})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      ctx.fillStyle = '#aad4ff';
      ctx.font      = 'bold 10px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`TOWER ${tIdx + 1}`, bx + 20, by + 15);

      ctx.fillStyle = '#336688';
      ctx.font      = '9px monospace';
      ctx.fillText(`${(tower.frequency/1e9).toFixed(0)} GHz  ·  ${tower.numElements} elements`, bx + padX, by + 26);

      // ── Separator ────────────────────────────────────────────
      ctx.strokeStyle = 'rgba(0,100,180,0.2)';
      ctx.lineWidth   = 0.5;
      ctx.beginPath();
      ctx.moveTo(bx + 6, by + 30);
      ctx.lineTo(bx + boxW - 6, by + 30);
      ctx.stroke();

      // ── User rows ────────────────────────────────────────────
      let ry = by + 34;

      if (connUsers.length === 0) {
        ctx.fillStyle = '#2a4455';
        ctx.font      = '9px monospace';
        ctx.fillText('No users in range', bx + padX, ry + 11);
      } else {
        connUsers.forEach((user, uIdx) => {
          const angle    = MathUtils.angleTo(tower, user);
          const angleDeg = (angle * 180 / Math.PI).toFixed(1);
          const phDelta  = (Math.PI * Math.sin(angle)).toFixed(2);
          // Read pre-computed SNR-scaled quality from user (set by _updateConnections)
          const quality  = user.effectiveQuality ?? 0;
          // Use this tower's own SNR value (same as what _updateConnections uses per tower)
          const towerSnr = tower.snr !== undefined ? tower.snr : this.params.snr;
          const snrEst   = (quality * towerSnr).toFixed(0);
          const bars     = Math.round(quality * 5);

          // User colour stripe on left
          ctx.fillStyle = user.color + '33';
          ctx.fillRect(bx + 4, ry - 1, 3, lineH * 3 + 2);
          ctx.fillStyle = user.color;
          ctx.fillRect(bx + 4, ry - 1, 3, 6);

          // User label
          ctx.fillStyle = user.color;
          ctx.font      = 'bold 9px monospace';
          ctx.fillText(`U${uIdx + 1}`, bx + 12, ry + 10);

          // Angle + phase
          ctx.fillStyle = 'rgba(180,220,255,0.85)';
          ctx.font      = '9px monospace';
          ctx.fillText(`θ = ${angleDeg}°  Δφ = ${phDelta} rad`, bx + 26, ry + 10);
          ry += lineH;

          // SNR
          ctx.fillStyle = quality > 0.5 ? '#44ff99' : quality > 0.25 ? '#ffcc44' : '#ff6644';
          ctx.fillText(`SNR ≈ ${snrEst}  Sig: ${(quality * 100).toFixed(0)}%`, bx + 26, ry + 10);
          ry += lineH;

          // Quality bar (5-segment)
          ctx.fillStyle = '#0d2030';
          ctx.fillRect(bx + 26, ry + 2, 80, 7);
          for (let b = 0; b < 5; b++) {
            const filled  = b < bars;
            const barCol  = filled
              ? (b < 2 ? '#ff5533' : b < 4 ? '#ffcc33' : '#33ff99')
              : 'rgba(255,255,255,0.06)';
            ctx.fillStyle = barCol;
            ctx.fillRect(bx + 27 + b * 16, ry + 3, 14, 5);
          }
          ctx.fillStyle = 'rgba(150,200,255,0.45)';
          ctx.font      = '8px monospace';
          ctx.fillText(`${(quality * 100).toFixed(0)}%`, bx + 115, ry + 10);

          ry += lineH + 2;

          // Row separator between users
          if (uIdx < connUsers.length - 1) {
            ctx.strokeStyle = 'rgba(0,80,140,0.15)';
            ctx.lineWidth   = 0.5;
            ctx.beginPath();
            ctx.moveTo(bx + 10, ry);
            ctx.lineTo(bx + boxW - 6, ry);
            ctx.stroke();
            ry += 3;
          }
        });
      }

      ctx.restore();
    });
  }

  /**
   * Draw a lightweight "selected tower" badge near the tower.
   * The actual editable panel is emitted via Bus so the UI layer can render
   * a proper HTML panel — keeping canvas logic clean.
   * This method draws only a compact canvas indicator.
   */
  _drawTowerEditor() {
    if (!this.#selectedTower) return;
    const tower = this.#selectedTower;
    const { ctx, width: W, height: H } = this.renderer;

    const boxW = 170, boxH = 34;
    let bx = tower.x - boxW / 2;
    let by = tower.y - 68;
    bx = Math.max(6, Math.min(bx, W - boxW - 6));
    if (by < 6) by = tower.y + 30;

    ctx.save();

    // Background
    this._roundRect(ctx, bx, by, boxW, boxH, 6);
    ctx.fillStyle = 'rgba(40,28,4,0.96)';
    ctx.fill();

    this._roundRect(ctx, bx, by, boxW, boxH, 6);
    ctx.strokeStyle = 'rgba(255,200,50,0.8)';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    // Star / pencil icon
    ctx.fillStyle = '#ffcc33';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('✎ EDITING TOWER', bx + 10, by + 14);

    ctx.fillStyle = 'rgba(255,200,100,0.7)';
    ctx.font = '9px monospace';
    const effectiveRange = Math.round(tower.effectiveRange || tower.range);
    ctx.fillText(`${tower.numElements} ant  ·  ${(tower.frequency/1e9).toFixed(0)} GHz  ·  ${effectiveRange}m`, bx + 10, by + 27);

    ctx.restore();
  }

  /** Helper: draw a rounded rectangle path; topOnly clips bottom corners to a flat edge */
  _roundRect(ctx, x, y, w, h, r, topOnly = false) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    if (topOnly) {
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x, y + h);
    } else {
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    }
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  _drawStats() {
    const { ctx, width: W, height: H } = this.renderer;
    ctx.fillStyle = 'rgba(0,8,20,0.85)';
    ctx.fillRect(8, 8, 200, 110);
    ctx.strokeStyle = 'rgba(0,150,255,0.3)'; ctx.lineWidth = 1;
    ctx.strokeRect(8, 8, 200, 110);
    const lines = [
      `Towers: ${this.towers.length}  |  Users: ${this.users.length}`,
      `Connected: ${this.users.filter(u => u.inRange).length}`,
      `Active beams: ${this.towers.reduce((s,t) => s+t.activeUsers.length, 0)}`,
      `f = ${(this.params.frequency/1e9).toFixed(0)} GHz (mmWave)`,
      `SNR = ${this.params.snr}  ${this.params.snr>=700?'✓ good':this.params.snr>=400?'⚠ degraded':'⛔ noisy'}`,
      `Win: ${this.params.windowType || 'none'}`
    ];
    lines.forEach((l, i) => {
      ctx.fillStyle = [1].includes(i) ? '#00ff88' : '#66ccff';
      ctx.font = '11px monospace'; ctx.textAlign = 'left';
      ctx.fillText(l, 14, 24 + i*15);
    });
    ctx.fillStyle = 'rgba(0,150,255,0.5)';
    ctx.font = '10px monospace'; ctx.textAlign = 'right';
    ctx.fillText('T: tower  U: user  1-8: select user  Arrows: move  Shift+Click: remove', W-8, H-8);
  }

  _onStop() {
    this._unbindInput();
    this.#waves = [];
    this.#placingTower = false;
    this.#placingUser  = false;
    this.canvas.style.cursor = 'default';
  }

  // ── Input binding ─────────────────────────────────────────────

  _bindInput() {
    // Store bound handlers so we can removeEventListener properly (OOP cleanup)
    this._clickHandler     = e => this._onClick(e);
    this._keyHandler       = e => this._onKey(e);
    this._mouseMoveHandler = e => this._onMouseMove(e);
    this.canvas.addEventListener('click',     this._clickHandler);
    this.canvas.addEventListener('mousemove', this._mouseMoveHandler);
    document.addEventListener('keydown', this._keyHandler);
  }

  _unbindInput() {
    if (this._clickHandler) {
      this.canvas.removeEventListener('click',     this._clickHandler);
      this.canvas.removeEventListener('mousemove', this._mouseMoveHandler);
      document.removeEventListener('keydown', this._keyHandler);
      this._clickHandler     = null;
      this._keyHandler       = null;
      this._mouseMoveHandler = null;
    }
  }

  _onClick(e) {
    if (!this.animFrame) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;

    if (this.#placingTower) {
      this.addTower(x, y);
      this.#placingTower = false;
      this.canvas.style.cursor = 'default';
      this._toast('📡 Tower placed');
      return;
    }
    if (this.#placingUser) {
      this.addUser(x, y);
      this.#placingUser = false;
      this.canvas.style.cursor = 'default';
      this._toast('📱 User added');
      return;
    }

    // Shift+click to remove
    if (e.shiftKey) {
      const hitUser  = this.users.find(u => MathUtils.distance(u, {x,y}) < 20);
      const hitTower = this.towers.find(t => MathUtils.distance(t, {x,y}) < 20);
      if (hitUser)  { this.removeUser(hitUser);   return; }
      if (hitTower) { this.removeTower(hitTower); return; }
    }

    // Select tower (click on it)
    const clickedTower = this.towers.find(t => MathUtils.distance(t, {x,y}) < 20);
    if (clickedTower) {
      this.selectTower(clickedTower === this.#selectedTower ? null : clickedTower);
      this.#selectedUser = null;
      return;
    }

    // Select user (click anywhere else deselects tower)
    this.selectTower(null);
    this.#selectedUser = this.users.find(u => MathUtils.distance(u, {x,y}) < 20) || null;
  }

  _onMouseMove(e) {
    const rect = this.canvas.getBoundingClientRect();
    this.#mouseX = e.clientX - rect.left;
    this.#mouseY = e.clientY - rect.top;
  }

  _onKey(e) {
    if (!this.animFrame) return;
    const speed = 4;
    const b = { minX:10, maxX:this.renderer.width-10, minY:10, maxY:this.renderer.height-10 };

    // Number keys 1-8 — select user by index directly from keyboard
    const num = parseInt(e.key);
    if (!isNaN(num) && num >= 1 && num <= 8) {
      const target = this.users[num - 1] || null;
      if (target) {
        this.#selectedUser = target;
        this.selectTower(null);
        this._toast(`User ${num} selected — use arrows to move`);
      }
      return;
    }

    // Arrow keys — move selected user
    if (this.#selectedUser) {
      if (e.key === 'ArrowLeft')  { e.preventDefault(); this.#selectedUser.move(-speed, 0, b); }
      if (e.key === 'ArrowRight') { e.preventDefault(); this.#selectedUser.move( speed, 0, b); }
      if (e.key === 'ArrowUp')    { e.preventDefault(); this.#selectedUser.move(0, -speed, b); }
      if (e.key === 'ArrowDown')  { e.preventDefault(); this.#selectedUser.move(0,  speed, b); }
    }

    const mx = this.#mouseX, my = this.#mouseY;
    const hitTower = () => this.towers.find(t => MathUtils.distance(t, {x:mx, y:my}) < 24);
    const hitUser  = () => this.users.find(u  => MathUtils.distance(u, {x:mx, y:my}) < 20);

    // T — place tower at cursor position directly (no click needed)
    if (e.key === 't' || e.key === 'T') {
      if (mx > 0 || my > 0) {
        const t = this.addTower(mx, my);
        if (t) this._toast('📡 Tower placed');
      } else {
        this.startPlacingTower();   // fallback if mouse never entered canvas
      }
      return;
    }

    // U — add user (keep original placing mode)
    if (e.key === 'u' || e.key === 'U') { this.startPlacingUser(); return; }

    // E — add one antenna element to the tower under cursor
    if (e.key === 'e' || e.key === 'E') {
      const tower = hitTower();
      if (tower) {
        this.updateTower(tower, { numElements: Math.min(64, tower.numElements + 1) });
        this._toast(`📶 ${tower.numElements} elements`);
        Bus.emit('fiveg:tower_updated', tower);
      }
      return;
    }

    // R — remove tower or user under cursor
    if (e.key === 'r' || e.key === 'R') {
      const tower = hitTower();
      if (tower) { this.removeTower(tower); this._toast('🗑 Tower removed'); return; }
      const user = hitUser();
      if (user)  { this.removeUser(user);   this._toast('🗑 User removed');  return; }
    }
  }
}
// ── Class alias — app.js refers to these names
const FiveGMode = FiveGSimulator;