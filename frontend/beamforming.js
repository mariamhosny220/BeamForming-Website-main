// ============================================================
// modes/beamforming.js  —  v5
// Fixes: proper curved interference fringes, cyan palette,
//        frequency / amplitude / phase all visually reactive
// ============================================================

class BeamformingGenericMode {

  constructor(canvas, cbs = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cbs = cbs;
    this._rafId = null;
    this._dirty = true;
    this._tick = 0;
    this._c2d = document.createElement('canvas');
    this._cCart = document.createElement('canvas');
    this._cPolar = document.createElement('canvas');

    this.params = {
      numElements: 16,
      spacing: 0.5,    // d/λ
      frequency: 2.4e9,  // Hz
      steerAngle: 0,       // °
      amplitude: 1.0,
      phase: 0,       // ° global offset
      windowType: 'none',
      kaiserBeta: 6,
      txPower: 30,
      snr: 100,
    };
  }

  start() {
    this._dirty = true;
    if (!this._rafId) this._rafId = requestAnimationFrame(() => this._loop());
  }

  stop() {
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
  }

  setParams(p) {
    Object.assign(this.params, p);
    this._dirty = true;
    if (!this._rafId) this._render();
  }

  getState() { return { mode: 'beamforming', params: { ...this.params } }; }

  _loop() {
    this._tick++;
    if (this._dirty || this._tick % 3 === 0) {
      this._render();
      this._dirty = false;
    }
    this._rafId = requestAnimationFrame(() => this._loop());
  }

  // ── Master render ──────────────────────────────────────────

  _render() {
    const W = this.canvas.width = this.canvas.offsetWidth;
    const H = this.canvas.height = this.canvas.offsetHeight;
    if (W < 10 || H < 10) return;

    const h2d = Math.floor(H * 0.55);
    const hB = H - h2d;
    const wL = Math.floor(W / 2);
    const wR = W - wL;

    this._draw2DField(this._c2d, W, h2d);
    this._drawCartesian(this._cCart, wL, hB);
    this._drawPolar(this._cPolar, wR, hB);

    const ctx = this.ctx;
    ctx.drawImage(this._c2d, 0, 0);
    ctx.drawImage(this._cCart, 0, h2d);
    ctx.drawImage(this._cPolar, wL, h2d);

    // dividers — cyan tint
    ctx.strokeStyle = 'rgba(0,220,255,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h2d); ctx.lineTo(W, h2d); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(wL, h2d); ctx.lineTo(wL, H); ctx.stroke();

    this._drawStatusBar(ctx, W, h2d);
  }

  // ══════════════════════════════════════════════════════════
  // 1.  2D INTERFERENCE FIELD
  //
  //  HOW THE ARCS APPEAR:
  //  Each element emits a cylindrical wave.  We evaluate the
  //  *instantaneous* real part of the total field at t=0.
  //  The result is ±fringes; we map |field| to brightness so
  //  both constructive (bright) and destructive (dark) bands
  //  are visible as curved stripes — exactly like the reference.
  //
  //  KEY PARAMETER EFFECTS:
  //  • frequency  → px_per_lam: more Hz = shorter λ = tighter fringes
  //  • amplitude  → scales peak brightness
  //  • phase      → shifts all wavefronts → pattern translates
  //  • steerAngle → progressive delay per element → tilts cone
  //  • spacing    → changes d_px → fringe spacing changes
  //  • windowType → modifies per-element weights → fringe depth
  //  • N          → more sources → sharper main lobe
  // ══════════════════════════════════════════════════════════
  _draw2DField(c, W, H) {
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const p = this.params;

    const N = p.numElements;
    const th0 = p.steerAngle * Math.PI / 180;
    const A = p.amplitude;
    const phi0 = p.phase * Math.PI / 180; // الفيز أوفسيت

    const PX_REF = Math.max(50, H / 6);
    const px_lam = PX_REF * (2.4e9 / p.frequency); // التردد بيتحكم في طول الموجة هنا
    const d_px = p.spacing * px_lam;
    const k = 2 * Math.PI / px_lam;
    const dphi = k * d_px * Math.sin(th0);
    const y_arr = H - 10;

    const imgData = ctx.createImageData(W, H);
    const data = imgData.data;
    const raw = new Float32Array(W * H);

    // حساب الأوزان عشان الويندو يسمع في الماب
    const W2 = this._windowWeights(N, p.windowType, p.kaiserBeta);

    for (let py = 0; py < H; py++) {
      const dy = y_arr - py;
      // إصلاح: السماح بانتشار الموجات في كل الاتجاهات
      // استخدام المسافة الفعلية بدون تخطي المنطقة تحت الـ array
      const distFactor = Math.max(1, Math.abs(dy));
      for (let px = 0; px < W; px++) {
        let field = 0;
        for (let n = 0; n < N; n++) {
          const ex = (n - (N - 1) / 2) * d_px;
          const dx = px - (W / 2 + ex);
          const r = Math.sqrt(dx * dx + dy * dy);
          // إصلاح: استخدام formula أدق للـ wave propagation
          // مع proper far-field approximation
          const phase = k * r - n * dphi + phi0;
          // استخدام 1/sqrt(r) للـ cylindrical wave + windowing
          const amplitudeFactor = W2[n] * A / Math.sqrt(r + 1);
          field += amplitudeFactor * Math.cos(phase);
        }
        raw[py * W + px] = field;
      }
    }

    const brightness = 18 / Math.sqrt(N);
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const i = py * W + px;
        let v = Math.abs(raw[i] * brightness);
        v = Math.pow(Math.min(v, 1.0), 0.8);

        // إضافة نمنمة الـ SNR
        const r_n = Math.sqrt((px - W / 2) ** 2 + (y_arr - py) ** 2);
        const noise = (Math.random() - 0.5) * (2 / (Math.sqrt(p.snr) + 1)) * (r_n / H);
        v = Math.max(0, Math.min(1, v + noise));

        const idx = i * 4;
        data[idx] = v * 30; data[idx + 1] = v * 220; data[idx + 2] = v * 255; data[idx + 3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
  }



  // ══════════════════════════════════════════════════════════
  // 2.  BEAM PROFILE — CARTESIAN (dB)
  // ══════════════════════════════════════════════════════════

  _drawCartesian(c, W, H) {
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const p = this.params;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    const PL = 38, PR = 6, PT = 22, PB = 20;
    const pw = W - PL - PR;
    const ph = H - PT - PB;
    const DB_MIN = -70, DB_MAX = 0;
    const yDB = db => PT + ph * (1 - (db - DB_MIN) / (DB_MAX - DB_MIN));

    // grid
    ctx.lineWidth = 0.5;
    ctx.font = '8px monospace';
    for (let db = DB_MIN; db <= DB_MAX; db += 10) {
      const y = yDB(db);
      ctx.strokeStyle = 'rgba(0,220,255,0.07)';
      ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(PL + pw, y); ctx.stroke();
      ctx.fillStyle = 'rgba(0,220,255,0.45)';
      ctx.fillText(db + 'dB', 0, y + 3);
    }
    for (let deg = -90; deg <= 90; deg += 30) {
      const x = PL + pw * (deg + 90) / 180;
      ctx.strokeStyle = 'rgba(0,220,255,0.06)';
      ctx.beginPath(); ctx.moveTo(x, PT); ctx.lineTo(x, PT + ph); ctx.stroke();
      ctx.fillStyle = 'rgba(0,220,255,0.45)';
      ctx.fillText(deg + '°', x - 8, H - 3);
    }

    // –3 dB line
    ctx.strokeStyle = 'rgba(255,255,0,0.18)';
    ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(PL, yDB(-3)); ctx.lineTo(PL + pw, yDB(-3)); ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(0,220,255,0.65)';
    ctx.font = '9px monospace';
    ctx.fillText('◆ BEAM PROFILE — CARTESIAN', PL + 2, 13);

    // AF trace
    const STEPS = 700;
    const af = this._afSeriesDB(STEPS, p);

    ctx.shadowColor = '#00e8ff';
    ctx.shadowBlur = 4;
    ctx.strokeStyle = '#00e8ff';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i <= STEPS; i++) {
      const x = PL + pw * i / STEPS;
      const y = yDB(Math.max(DB_MIN, af[i]));
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // steering marker
    const sx = PL + pw * (p.steerAngle + 90) / 180;
    ctx.strokeStyle = 'rgba(255,100,0,0.55)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(sx, PT); ctx.lineTo(sx, PT + ph); ctx.stroke();
    ctx.setLineDash([]);
  }

  // ══════════════════════════════════════════════════════════
  // 3.  BEAM PROFILE — POLAR
  // ══════════════════════════════════════════════════════════

  _drawPolar(c, W, H) {
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const p = this.params;

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    const cx = W / 2;
    const cy = H * 0.60;
    const R = Math.min(W * 0.43, H * 0.54);
    const DB_FLOOR = -50;

    const rOfDB = db => R * (Math.max(DB_FLOOR, db) - DB_FLOOR) / (-DB_FLOOR);

    // rings
    [-50, -40, -30, -20, -10, 0].forEach(db => {
      const r = rOfDB(db);
      if (r < 1) return;
      ctx.strokeStyle = `rgba(0,220,255,${db === 0 ? 0.2 : 0.09})`;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.arc(cx, cy, r, Math.PI, 0, false);
      ctx.stroke();
      if (db < 0 && r > 8) {
        ctx.fillStyle = 'rgba(0,220,255,0.3)';
        ctx.font = '7px monospace';
        ctx.fillText(db + 'dB', cx + r + 2, cy);
      }
    });

    // spokes
    for (let deg = -90; deg <= 90; deg += 30) {
      const rad = deg * Math.PI / 180;
      const ex = cx + R * Math.sin(rad);
      const ey = cy - R * Math.cos(rad);
      ctx.strokeStyle = 'rgba(0,220,255,0.1)';
      ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.fillStyle = 'rgba(0,220,255,0.45)';
      ctx.font = '8px monospace';
      const lx = deg < 0 ? ex - 22 : (deg === 0 ? ex - 6 : ex + 2);
      ctx.fillText(deg + '°', lx, ey - 2);
    }

    // baseline
    ctx.strokeStyle = 'rgba(0,220,255,0.13)';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.stroke();

    // AF trace
    const STEPS = 800;
    const afDB = this._afSeriesDB(STEPS, p);

    ctx.shadowColor = '#00e8ff';
    ctx.shadowBlur = 5;
    ctx.strokeStyle = '#00e8ff';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i <= STEPS; i++) {
      const theta = (-90 + 180 * i / STEPS) * Math.PI / 180;
      const r = rOfDB(afDB[i]);
      const x = cx + r * Math.sin(theta);
      const y = cy - r * Math.cos(theta);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // close to baseline
    const r0 = rOfDB(afDB[0]);
    const rN = rOfDB(afDB[STEPS]);
    ctx.strokeStyle = 'rgba(0,220,255,0.18)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(cx - r0, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx + rN, cy);
    ctx.stroke();

    // steering
    const stRad = p.steerAngle * Math.PI / 180;
    ctx.strokeStyle = 'rgba(255,100,0,0.55)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * Math.sin(stRad), cy - R * Math.cos(stRad));
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(0,220,255,0.65)';
    ctx.font = '9px monospace';
    ctx.fillText('◆ BEAM PROFILE — POLAR', 8, 13);
  }

  // ── Status bar ─────────────────────────────────────────────

  _drawStatusBar(ctx, W, h2d) {
    const p = this.params;
    const snrDB = p.snr > 0 ? (10 * Math.log10(p.snr)).toFixed(1) : '-∞';
    const freq = p.frequency >= 1e9
      ? (p.frequency / 1e9).toFixed(2) + 'GHz'
      : (p.frequency / 1e6).toFixed(0) + 'MHz';
    const txt = `● LIVE   N=${p.numElements}  f=${freq}  θ=${p.steerAngle.toFixed(0)}°  SNR=${snrDB}dB  A=${p.amplitude.toFixed(1)}  φ=${p.phase.toFixed(0)}°  win=${p.windowType}`;

    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, h2d - 20, W, 20);
    ctx.fillStyle = 'rgba(0,220,255,0.7)';
    ctx.font = '9px monospace';
    ctx.fillText(txt, 10, h2d - 5);
  }

  // ══════════════════════════════════════════════════════════
  // PHYSICS
  // ══════════════════════════════════════════════════════════

  _arrayFactor(thetaRad, p) {
    const N = p.numElements;
    const th0 = p.steerAngle * Math.PI / 180;
    const phi0 = p.phase * Math.PI / 180;
    const W = this._windowWeights(N, p.windowType, p.kaiserBeta);

    // تثبيت المسافة الفيزيقية d عشان التردد يغير الـ Beamwidth
    const d_fixed = p.spacing * (3e8 / 2.4e9);
    const lambda = 3e8 / p.frequency;
    const psi = 2 * Math.PI * (d_fixed / lambda) * (Math.sin(thetaRad) - Math.sin(th0));

    let re = 0, im = 0;
    for (let n = 0; n < N; n++) {
      const ph = n * psi + phi0;
      re += W[n] * Math.cos(ph);
      im += W[n] * Math.sin(ph);
    }
    // ضرب النتيجة في Amplitude
    return Math.sqrt(re * re + im * im) * p.amplitude;
  }

  _afSeriesDB(steps, p) {
    const out = new Float32Array(steps + 1);
    const REF_MAX = 20; // ثابت مرجعي بدل الـ mx
    const noiseStd = p.snr > 0 ? 1.5 / Math.sqrt(p.snr / 10 + 1) : 1.5;

    for (let i = 0; i <= steps; i++) {
      const theta = (-90 + 180 * i / steps) * Math.PI / 180;
      const val = this._arrayFactor(theta, p);
      let db = 20 * Math.log10(val / REF_MAX + 1e-12);

      if (p.snr < 999) db += (Math.random() - 0.5) * noiseStd;
      out[i] = Math.max(-70, db);
    }
    return out;
  }

  _windowWeights(N, type, beta = 6) {
    const w = new Float64Array(N);
    for (let n = 0; n < N; n++) {
      const x = N > 1 ? n / (N - 1) : 0.5;
      switch (type) {
        case 'hanning': w[n] = 0.5 - 0.5 * Math.cos(2 * Math.PI * x); break;
        case 'hamming': w[n] = 0.54 - 0.46 * Math.cos(2 * Math.PI * x); break;
        case 'blackman': w[n] = 0.42 - 0.5 * Math.cos(2 * Math.PI * x)
          + 0.08 * Math.cos(4 * Math.PI * x); break;
        case 'kaiser': w[n] = this._kaiserWeight(x, beta); break;
        default: w[n] = 1.0;
      }
    }
    return w;
  }

  _besselI0(x) {
    let s = 1, t = 1;
    for (let k = 1; k <= 25; k++) {
      t *= (x / 2 / k) ** 2; s += t;
      if (t < 1e-14) break;
    }
    return s;
  }

  _kaiserWeight(x, beta) {
    const t = 2 * x - 1;
    return this._besselI0(beta * Math.sqrt(Math.max(0, 1 - t * t)))
      / this._besselI0(beta);
  }
}