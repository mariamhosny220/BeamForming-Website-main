// ============================================================
// ULTRASOUND SIMULATOR — extends BaseSimulator
// Uses Probe entity (which owns BeamformingEngine + Params)
// A-Mode, B-Mode, Doppler, Shepp-Logan Phantom
// ============================================================

// ─── SHEPP-LOGAN PHANTOM ─────────────────────────────────────
const SHEPP_LOGAN_ELLIPSES = [
  { cx:0,    cy:0,      a:0.72,  b:0.92,  angle:0,   intensity:1.0,  name:'Skull / Outer boundary', density:1.8,  attenuation:0.5,  color:'rgba(180,160,120,1)'   },
  { cx:0,    cy:-0.018, a:0.662, b:0.874, angle:0,   intensity:0.8, name:'Brain tissue',            density:1.0,  attenuation:0.3,  color:'rgba(90,60,50,1)'      },
  { cx:0.22, cy:0,      a:0.11,  b:0.31,  angle:-18, intensity:0.2, name:'Right ventricle',         density:1.05, attenuation:0.2,  color:'rgba(70,50,40,1)'      },
  { cx:-0.22,cy:0,      a:0.16,  b:0.41,  angle:18,  intensity:0.2, name:'Left ventricle',          density:1.05, attenuation:0.2,  color:'rgba(70,50,40,1)'      },
  { cx:0,    cy:0.35,   a:0.21,  b:0.25,  angle:0,   intensity:0.1,  name:'White matter',            density:1.02, attenuation:0.25, color:'rgba(110,90,75,1)'     },
  { cx:0,    cy:0.1,    a:0.046, b:0.046, angle:0,   intensity:0.1,  name:'Gray matter patch',       density:1.03, attenuation:0.28, color:'rgba(100,80,65,1)'     },
  { cx:0,    cy:-0.1,   a:0.046, b:0.046, angle:0,   intensity:0.1,  name:'Gray matter patch 2',     density:1.03, attenuation:0.28, color:'rgba(100,80,65,1)'     },
  { cx:-0.08,cy:-0.605, a:0.046, b:0.023, angle:0,   intensity:0.1,  name:'Lesion (small)',           density:1.1,  attenuation:0.4,  color:'rgba(140,100,60,1)'    },
  { cx:0,    cy:-0.605, a:0.023, b:0.023, angle:0,   intensity:0.1,  name:'Micro lesion',             density:1.12, attenuation:0.45, color:'rgba(150,110,70,1)'    },
  { cx:0.06, cy:-0.605, a:0.023, b:0.046, angle:0,   intensity:0.1,  name:'Calcification',            density:1.9,  attenuation:0.8,  color:'rgba(200,180,140,1)'   },
  { cx:-0.25,cy:0.2,    a:0.07,  b:0.04,  angle:30,  intensity:0.5, name:'Blood vessel (artery)',    density:1.06, attenuation:0.1,  color:'rgba(180,30,30,0.85)', isVessel:true }
];

const TISSUE_PROPS = {
  'Skull / Outer boundary': { impedance:7.8,  c:3500 },
  'Brain tissue':           { impedance:1.62, c:1560 },
  'Right ventricle':        { impedance:1.64, c:1565 },
  'Left ventricle':         { impedance:1.64, c:1565 },
  'White matter':           { impedance:1.63, c:1558 },
  'Gray matter patch':      { impedance:1.62, c:1553 },
  'Gray matter patch 2':    { impedance:1.62, c:1553 },
  'Lesion (small)':         { impedance:1.70, c:1570 },
  'Micro lesion':           { impedance:1.72, c:1572 },
  'Calcification':          { impedance:7.0,  c:3000 },
  'Blood vessel (artery)':  { impedance:1.61, c:1570 }
};

// ─── UNIFIED SPATIAL SCALE ───────────────────────────────────
// Single source of truth: all pixel<->physical conversions use these.
const SCALE_PX_PER_MM = 3.5;   // pixels per mm
const PHYS_SPACING_MM = 2.5;   // element pitch in mm (spacing_wl * 10)

// ─── ULTRASOUND SIMULATOR ────────────────────────────────────
class UltrasoundSimulator extends BaseSimulator {
  constructor(canvas, uiCallbacks) {
    super(canvas, uiCallbacks);

    // ── Frame-independent simulation clock ────────────────────
    this._simTime     = 0;      // accumulated physics seconds
    this._lastFrameMs = null;   // wall-clock timestamp of last tick

    // High-level params (UI-facing)
    this.params = {
      arrayType:       'linear',
      curvatureRadius: 70,
      arcAngle:        1.2,
      steerAngle:      0,
      focalDepth:      100,
      focusing:        true,
      apodization:     'none',
      kaiserBeta:      6,
      snr:             40,
      bloodVelocity:   0.5,
      vesselAngle:     30,
      showIndividual:  true,
      showBeam:        true,
      showHeatmap:     true,
      showPhantom:     true,
      showVessel:      true
    };

    // ── Probe entity ── snr mirrors params.snr (40) so both stay in sync
    this._probe = new Probe(0, 0, {
      numElements: 32, frequency: 5e6, spacing: 0.25, snr: 40
    });

    // ── Phantom state ──
    this.phantomEllipses = SHEPP_LOGAN_ELLIPSES.map(e => ({ ...e }));
    this.hoveredEllipse  = null;
    this.editingEllipse  = null;

    // ── Scan sub-mode ──
    this.scanMode = 'beamform';

    // ── Computed arrays ──
    this._elementPositions = [];
    this._delays           = [];
    this._phases           = [];
    this._focalPoint       = null;

    // ── A-Mode ──
    this._amodeData = new Float32Array(512);

    // ── B-Mode ──
    this._bmodeScanLines = [];
    this._lastBmodeBuild = 0;
    this._bmodeGlobalMax = 1e-9;

    // ── Doppler ──
    this._dopplerHistory = [];
    this._dopplerTime    = 0;

    // ── Probe animation ──
    this._probeAnimAngle = 0;   // rocking animation (radians)
    this._probeOrbitAngle = -Math.PI / 2; // orbit position around phantom (default: top = -90°)
    this._probeDragging   = false;        // true while user drags the probe

    // ── Waves ──
    this._waves     = [];
    this._lastSpawn = 0;

    // ── Layout ──
    this._layout = { mainFrac: 0.6 };

    this._rebuildArray();
    this._computeAMode();
    this._bindInput();
  }

  // ── Params override ──────────────────────────────────────────
// ── Params override ──────────────────────────────────────────
  setParams(p) {
    super.setParams(p);
    // Validate + mirror into Probe — guard missing engine
    if (p.numElements      !== undefined) this._probe.numElements    = Math.max(1, Math.round(p.numElements));
    if (p.frequency        !== undefined) this._probe.frequency      = Math.max(0.1e6, p.frequency);
    // spacing from slider is in mm; convert to wavelengths (λ = c/f)
    if (p.spacing          !== undefined) {
      const spacingMm = Math.max(0.01, p.spacing);
      const lam = SPEED_OF_SOUND / this._probe.frequency; // metres
      this._probe.spacing = spacingMm / (lam * 1000);     // mm / mm_per_wl
    }
    if (p.snr              !== undefined) this._probe.snr            = MathUtils.clamp(p.snr, 0, 1000);
    if (p.steerAngle       !== undefined) this._probe.steerAngle     = p.steerAngle;
    if (p.focalDepth       !== undefined) this._probe.focalDepth     = MathUtils.clamp(p.focalDepth, 1, 500);
    if (p.curvatureRadius  !== undefined) this._probe.curvatureRadius = Math.max(10, p.curvatureRadius);
    if (p.arcAngle         !== undefined) this._probe.arcAngle       = MathUtils.clamp(p.arcAngle, 0.1, Math.PI);
    if (p.arrayType        !== undefined) this._probe.arrayType      = p.arrayType;

    // 💡 التعديل هنا: نربط قيمة السلايدر الجديدة بزاوية الوعاء الدموي جوه الرسمة
    if (p.vesselAngle !== undefined) {
      const vessel = this.phantomEllipses.find(e => e.isVessel);
      if (vessel) vessel.angle = p.vesselAngle;
    }

    if (p.apodization !== undefined && this._probe.engine) {
      try { this._probe.engine.params.setWindow(p.apodization); } catch(e) {}
    }
    if (p.kaiserBeta !== undefined && this._probe.engine) {
      try { this._probe.engine.params.setKaiserBeta(p.kaiserBeta); } catch(e) {}
    }
    this._rebuildArray();
    this._computeAMode();
  }
  setScanMode(mode) {
    this.scanMode = mode;
    if (mode === 'amode')   { /* nothing extra — A-mode is always live */ }
    if (mode === 'bmode')   { this._bmodeScanLines = []; this._buildBMode(); }
    if (mode === 'doppler') { this._dopplerHistory = []; this._dopplerTime = 0; }
  }

  // ── Frame-independent clock ───────────────────────────────────
  _tickClock() {
    const now = performance.now();
    if (this._lastFrameMs === null) { this._lastFrameMs = now; return 0.016; }
    const dt = Math.min((now - this._lastFrameMs) / 1000, 0.05); // cap 50 ms
    this._lastFrameMs = now;
    this._simTime += dt;
    return dt;
  }

  // ── Core compute ─────────────────────────────────────────────
  compute() {
    const dt = this._tickClock();
    // Probe rocks gently at 0.6 Hz — amplitude scales with mode
    this._probeAnimAngle = Math.sin(this._simTime * 2 * Math.PI * 0.6) * 0.04;
    if (this.scanMode === 'doppler') this._computeDoppler(dt);
    // Rebuild B-mode every 0.5 s so it stays live with current params
    if (this.scanMode === 'bmode' && this._simTime - this._lastBmodeBuild > 0.1) {
      this._buildBMode();
      this._lastBmodeBuild = this._simTime;
    }
    this._spawnWaves(dt);
  }

  _rebuildArray() {
    const { mainW } = this._layout_dims();
    const isCurved  = this.params.arrayType === 'curved';

    // Probe position from orbit
    const probeP    = this._probePos();
    const cx        = probeP.x;
    const cy        = probeP.y;

    // Direction: probe always aims toward phantom center
    const phantomC  = this._phantomCenter();
    const toCenter  = Math.atan2(phantomC.y - cy, phantomC.x - cx); // angle toward center
    // "inward" normal angle (perpendicular to probe face, pointing into phantom)
    const inward    = toCenter; // probe face perpendicular = this direction
    // Probe face tangent (elements lie along this)
    const tangent   = toCenter + Math.PI / 2;

    // ── Unified pixel scale for spacing ──────────────────────
    const spacingPx = this._probe.spacing * PHYS_SPACING_MM * SCALE_PX_PER_MM;

    if (isCurved) {
      const N        = this._probe.numElements;
      const radiusPx = this._probe.curvatureRadius * SCALE_PX_PER_MM;
      const arc      = this._probe.arcAngle;
      const half     = arc / 2;
      // Arc centred on probe position, opening toward phantom
      this._elementPositions = Array.from({ length: N }, (_, i) => {
        const th = inward - half + (i / (N - 1)) * arc;
        return {
          x: cx + radiusPx * Math.cos(th),
          y: cy + radiusPx * Math.sin(th),
          normal: th
        };
      });
    } else {
      // Linear: elements spread along tangent axis
      const total   = (this._probe.numElements - 1) * spacingPx;
      const tx      = Math.cos(tangent), ty = Math.sin(tangent);
      this._elementPositions = Array.from({ length: this._probe.numElements }, (_, i) => {
        const off = -total / 2 + i * spacingPx;
        return { x: cx + tx * off, y: cy + ty * off };
      });
    }

    // ── Focal point — steer relative to inward normal ─────────
    const steerRad = this._probe.steerAngle * Math.PI / 180;
    const beamDir  = inward + steerRad;          // absolute beam direction
    if (this.params.focusing) {
      const depthPx = this._probe.focalDepth * SCALE_PX_PER_MM;
      this._focalPoint = {
        x: cx + depthPx * Math.cos(beamDir),
        y: cy + depthPx * Math.sin(beamDir)
      };
    } else {
      this._focalPoint = null;
    }

    this._delays = this._probe.computeDelays(this._elementPositions, this._focalPoint, this.params.focusing);
    const omega  = 2 * Math.PI * this._probe.frequency;
    this._phases = this._delays.map(d => omega * d);
  }

_computeAMode() {
    const N        = 512;
    const steerRad = this._probe.steerAngle * Math.PI / 180;
    const probePos = this._probePos();

    const phantomC  = this._phantomCenter();
    const inward = probePos.orbitAngle + Math.PI;
    const beamAngle = inward + steerRad;

    const distToCenter = Math.sqrt((phantomC.x - probePos.x)**2 + (phantomC.y - probePos.y)**2);
    const r = this._phantomRadius();
    const maxDepth = Math.min(
      distToCenter + Math.max(r.rx, r.ry) * 1.4,
      Math.max(this.renderer.width, this.renderer.height) * 0.9
    );

    this._amodeData = new Float32Array(N);
    const dx = Math.cos(beamAngle), dy = Math.sin(beamAngle);
    const interfaces = [];

    for (const ell of this.phantomEllipses) {
      const ctr  = this._normToCanvas(ell.cx, ell.cy);
      const r    = this._phantomRadius();
      const cosA = Math.cos(ell.angle * Math.PI/180), sinA = Math.sin(ell.angle * Math.PI/180);
      const a    = ell.a * r.rx, b = ell.b * r.ry;
      const ox   = probePos.x - ctr.x, oy = probePos.y - ctr.y;
      const lx   = ox*cosA+oy*sinA,    ly = -ox*sinA+oy*cosA;
      const ldx  = dx*cosA+dy*sinA,    ldy = -dx*sinA+dy*cosA;
      const A2   = (ldx/a)**2 + (ldy/b)**2;
      const B2   = 2*((lx*ldx)/(a*a) + (ly*ldy)/(b*b));
      const C2   = (lx/a)**2 + (ly/b)**2 - 1;
      const disc = B2*B2 - 4*A2*C2;
      if (disc >= 0 && A2 > 1e-12) {
        const sqD = Math.sqrt(Math.max(0, disc));
        const t1  = (-B2 - sqD) / (2*A2);
        const t2  = (-B2 + sqD) / (2*A2);
        if (t1 > 5) interfaces.push({ t:t1, ellipse:ell, entry:true  });
        if (t2 > 5) interfaces.push({ t:t2, ellipse:ell, entry:false });
      }
    }
    interfaces.sort((a,b) => a.t - b.t);

    const freqMHz   = this._probe.frequency / 1e6;
    const pxPerCm   = SCALE_PX_PER_MM * 10;
    let   cumAttDb  = 0;
    let   prevT     = 0;

    // 💡 التعديل الأول: حساب عرض النبضة بناءً على التردد الفعلي
    const fs = 40e6;
    const fc = this._probe.frequency;
    const cycles = 2.5; // النبضة بتتكون من 2.5 دورة
    const period = 1 / fc;
    const sigma_samples = ((cycles * period) / 4) * fs;
    const k_extent = Math.max(2, Math.ceil(3 * sigma_samples));
// 💡 نحسب زاوية الميل بالراديان (بالموجب)
    const absSteerRad = Math.abs(this._probe.steerAngle * Math.PI / 180);
    const steerFactor = Math.pow(Math.cos(absSteerRad), 1.5);

    for (const iface of interfaces) {
      if (iface.t > maxDepth) continue;
      const sIdx = Math.round((iface.t / maxDepth) * (N - 1));
      if (sIdx < 0 || sIdx >= N) continue;

      const z1 = iface.entry ? 1.6 : (TISSUE_PROPS[iface.ellipse.name]?.impedance || 1.6);
      const z2 = iface.entry ? (TISSUE_PROPS[iface.ellipse.name]?.impedance || 1.6) : 1.6;
      const R  = Math.abs((z2 - z1) / (z2 + z1));

      const incrCm  = (iface.t - prevT) / pxPerCm;
      prevT = iface.t;
      const attCoeff = iface.ellipse.attenuation || 0.3;
      cumAttDb      += attCoeff * freqMHz * incrCm;
      const attFactor = Math.pow(10, -cumAttDb * 2 / 20);

      // تأثير الفوكس
      let focusFactor = 1.0;
      let localSigma = sigma_samples; // 💡 عرض النبضة هيفضل ثابت كأساس

      if (this.params.focusing) {
        const focalDepthPx = this._probe.focalDepth * SCALE_PX_PER_MM;
        const distFromFocus = Math.abs(iface.t - focalDepthPx);
        const dofPx = 40 * SCALE_PX_PER_MM;

        // 💡 بنقلل الـ Amplitude بس بره الفوكس (ده التصرف الفيزيائي السليم للـ 1D Scanline)
        focusFactor = 0.35 + 0.65 * Math.exp(-(distFromFocus * distFromFocus) / (2 * dofPx * dofPx));

        // ❌ شيلنا السطر اللي كان بيمط الـ localSigma هنا تماماً
      }

      // 💡 تأثير الـ Steer على الدقة مستمر، لأن زاوية الميل بتقلل الـ Effective Aperture فعلاً
      localSigma = localSigma / Math.max(0.3, Math.cos(absSteerRad));

      // حساب السعة النهائية مضروبة في الفوكس ومعامل الميل
      const amp = R * attFactor * Math.abs(iface.ellipse.intensity) * focusFactor * steerFactor;
      const local_k_extent = Math.max(2, Math.ceil(3 * localSigma));

      for (let k = -local_k_extent; k <= local_k_extent; k++) {
        const idx = sIdx + k;
        if (idx < 0 || idx >= N) continue;
        const t_s    = k / fs;
        const env    = amp * Math.exp(-(k * k) / (2 * localSigma * localSigma));
        const carrier = Math.cos(2 * Math.PI * fc * t_s);
        this._amodeData[idx] += env * carrier;
      }
        }
    if (this._probe.engine) this._probe.engine.addNoise(this._amodeData);
  }

  _buildBMode() {
      this._bmodeScanLines = [];
      const nLines = 64;
      const isLinear = this.params.arrayType === 'linear';

      const savedSteer = this._probe.steerAngle;
      const savedParamSteer = this.params.steerAngle;
      const originalProbePos = this._probePos.bind(this);

      const baseProbeP = originalProbePos();
      const phantomC   = this._phantomCenter();
      const inwardAngle = Math.atan2(phantomC.y - baseProbeP.y, phantomC.x - baseProbeP.x);
      const tangentAngle = inwardAngle + Math.PI / 2;
      const tx = Math.cos(tangentAngle), ty = Math.sin(tangentAngle);

      const sPx = this._probe.spacing * PHYS_SPACING_MM * SCALE_PX_PER_MM;

      for (let i = 0; i < nLines; i++) {
        if (isLinear) {
          const sweepWidth = this._probe.numElements * sPx;
          const off = -sweepWidth/2 + (i / (nLines - 1)) * sweepWidth;
          this._probePos = () => ({
            x: baseProbeP.x + tx * off,
            y: baseProbeP.y + ty * off,
            orbitAngle: baseProbeP.orbitAngle
          });
          this._probe.steerAngle = savedParamSteer;
        } else {
          const range = 60;
          const angle = -range/2 + (i / (nLines - 1)) * range;
          this._probe.steerAngle = angle + savedParamSteer;
        }

        this._computeAMode();

        const raw = this._amodeData;
        const N = raw.length;
        const env = new Float32Array(N);

        const fc = this._probe.frequency;
        const fs = 40e6;
        const period = 1 / fc;
        const sigma_samples = ((2.5 * period) / 4) * fs;
        const smoothW = Math.max(1, Math.round(sigma_samples * 0.8));

        for (let s = smoothW; s < N - smoothW; s++) {
          let sum = 0;
          for(let w = -smoothW; w <= smoothW; w++) {
             sum += Math.abs(raw[s+w]);
          }
          let val = sum / (2 * smoothW + 1);
          let tgc = 1 + (s / N) * 2.5;
          env[s] = val * tgc;
        }

        this._bmodeScanLines.push({
          angle: this._probe.steerAngle,
          env: env
        });
      }

      this._probePos = originalProbePos;
      this._probe.steerAngle = savedSteer;
      this.params.steerAngle = savedParamSteer;
      this._rebuildArray();
      this._computeAMode();

      let globalMax = 1e-9;
      for (const line of this._bmodeScanLines) {
        for (let s = 0; s < line.env.length; s++) {
          if (line.env[s] > globalMax) globalMax = line.env[s];
        }
      }
      this._bmodeGlobalMax = globalMax;
    }
  _drawBModePanel(ctx, secW, H) {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, secW, H);
      ctx.fillStyle = '#00d4ff'; ctx.font = 'bold 11px monospace';
      ctx.fillText('B-MODE  (2D Grayscale Scan)', 8, 18);

      if (!this._bmodeScanLines.length) return;

      const isLinear = this.params.arrayType === 'linear';
      const plotLeft = 28, plotTop = 40, plotW = secW - plotLeft - 6, plotH = H - 60;
      const nLines = this._bmodeScanLines.length;
      const nS = this._bmodeScanLines[0].env.length;
      const globalMax = Math.max(this._bmodeGlobalMax || 1e-9, 1e-9);
      const dynamicRange = 50;
      const steerRad = this.params.steerAngle * Math.PI / 180;
      const tanSteer = Math.tan(steerRad);

      ctx.save();

      // ── 1. عمل Clipping لمتوازي الأضلاع (لإخفاء الأجزاء السوداء الزائدة) ──
      ctx.beginPath();
      if (isLinear) {
        const shiftBottom = plotH * tanSteer;
        ctx.moveTo(plotLeft, plotTop);
        ctx.lineTo(plotLeft + plotW, plotTop);
        ctx.lineTo(plotLeft + plotW + shiftBottom, plotTop + plotH);
        ctx.lineTo(plotLeft + shiftBottom, plotTop + plotH);
      } else {
        ctx.rect(plotLeft, plotTop, plotW, plotH);
      }
      ctx.closePath();
      ctx.clip();

      if (isLinear) {
        // ── 2. رسم الخطي (Linear) باستخدام الربط بين الخطوط (Polygon Filling) ──
        const colW = plotW / (nLines - 1);
        for (let li = 1; li < nLines; li++) {
          const line = this._bmodeScanLines[li];
          const xPrev = plotLeft + (li - 1) * colW;
          const xCurr = plotLeft + li * colW;

          for (let s = 0; s < nS - 1; s++) {
            const y0 = plotTop + (s / nS) * plotH;
            const y1 = plotTop + ((s + 1) / nS) * plotH;

            const shift0 = (y0 - plotTop) * tanSteer;
            const shift1 = (y1 - plotTop) * tanSteer;

            const v = line.env[s] / globalMax;
            if (v < 0.005) continue;

            let logVal = (20 * Math.log10(Math.max(v, 1e-5)) + dynamicRange) / dynamicRange;
            logVal = Math.max(0, Math.min(1, logVal));
            const g = Math.floor(logVal * 255);

            ctx.fillStyle = `rgb(${g},${g},${g})`;
            ctx.beginPath();
            ctx.moveTo(xPrev + shift0, y0);
            ctx.lineTo(xCurr + shift0, y0);
            ctx.lineTo(xCurr + shift1, y1);
            ctx.lineTo(xPrev + shift1, y1);
            ctx.fill();
          }
        }
      } else {
        // ── 3. رسم المروحي (Sector) ──
        const ox = plotLeft + plotW / 2;
        const oy = plotTop;
        const curveOffset = 40;
        const maxR = plotH - curveOffset;
        const dAngle = (60 / (nLines - 1)) * Math.PI / 180;

        for (let li = 0; li < nLines; li++) {
          const line = this._bmodeScanLines[li];
          const aCenter = line.angle * Math.PI / 180;
          const a0 = aCenter - dAngle/2;
          const a1 = aCenter + dAngle/2;

          for (let s = 1; s < nS; s++) {
            const r0 = curveOffset + ((s - 1) / nS) * maxR;
            const r1 = curveOffset + (s / nS) * maxR;

            const v = line.env[s] / globalMax;
            if (v < 0.005) continue;

            let logVal = (20 * Math.log10(Math.max(v, 1e-5)) + dynamicRange) / dynamicRange;
            logVal = Math.max(0, Math.min(1, logVal));
            const g = Math.floor(logVal * 255);

            ctx.fillStyle = `rgb(${g},${g},${g})`;
            ctx.beginPath();
            ctx.moveTo(ox + r0 * Math.sin(a0), oy + r0 * Math.cos(a0));
            ctx.lineTo(ox + r1 * Math.sin(a0), oy + r1 * Math.cos(a0));
            ctx.lineTo(ox + r1 * Math.sin(a1), oy + r1 * Math.cos(a1));
            ctx.lineTo(ox + r0 * Math.sin(a1), oy + r0 * Math.cos(a1));
            ctx.fill();
          }
        }
      }

      // ── 4. رسم خط الـ Steer Angle الأخضر ──
      ctx.strokeStyle = 'rgba(0, 255, 140, 0.6)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.shadowColor = '#00ff88'; ctx.shadowBlur = 4;
      ctx.beginPath();
      if (isLinear) {
        const cx = plotLeft + plotW / 2;
        ctx.moveTo(cx, plotTop);
        ctx.lineTo(cx + plotH * tanSteer, plotTop + plotH);
      } else {
        const ox = plotLeft + plotW / 2;
        const oy = plotTop;
        ctx.moveTo(ox, oy);
        ctx.lineTo(ox + plotH * Math.sin(steerRad), oy + plotH * Math.cos(steerRad));
      }
      ctx.stroke();
      ctx.setLineDash([]); ctx.shadowBlur = 0;

      // ── 5. إضافة مؤشر الـ Focal Point الأصفر ──
      if (this.params.focusing) {
        const maxDepthMm = (this.renderer.height - this._probePos().y - 20) / SCALE_PX_PER_MM;
        const focalY = plotTop + (this.params.focalDepth / maxDepthMm) * plotH;
        if (focalY >= plotTop && focalY <= plotTop + plotH) {
          ctx.fillStyle = 'rgba(255, 200, 0, 0.9)';
          ctx.beginPath();
          ctx.moveTo(plotLeft - 2, focalY);
          ctx.lineTo(plotLeft - 8, focalY - 5);
          ctx.lineTo(plotLeft - 8, focalY + 5);
          ctx.fill();
        }
      }

    ctx.restore();
    this._drawBModeGrid(ctx, secW, H);
  }
  _spawnWaves(dt = 0.016) {
    const SPAWN_INTERVAL = 0.08; // seconds (frame-independent)
    if (this._simTime - this._lastSpawn < SPAWN_INTERVAL) return;
    this._lastSpawn = this._simTime;

    this._elementPositions.forEach((pos, i) => {
      const weights = this._probe.getWeights ? this._probe.getWeights() : [];
      this._waves.push({
        cx: pos.x, cy: pos.y, radius: 0,
        delay: (this._delays[i] || 0) * 1e6 * 0.5,
        born: this._simTime, elementIdx: i,
        weight: (weights[i] !== undefined && isFinite(weights[i])) ? weights[i] : 1
      });
    });

    const maxR = Math.max(this.renderer.width, this.renderer.height);
    this._waves = this._waves.filter(w => (this._simTime - w.born) * 150 < maxR);
  }
  _buildInterferenceMap(W, H) {
    if (!this._probe.engine) return null;
    const pos    = this._probePos();

    // 💡 السر هنا: الدقة كانت 80 (6400 حسبة)، خليناها 40 (1600 حسبة بس = أسرع 4 مرات واللاب مش هيهنج)
    const res    = 40;

    const stepX  = W / res;
    const stepY  = (H - pos.y) / res;
    const imgW   = W, imgH = H;
    const data   = new Uint8ClampedArray(imgW * imgH * 4);

    const omega   = 2 * Math.PI * this._probe.frequency;
    const k       = omega / SPEED_OF_SOUND;
    const weights = this._probe.engine.applyWindow(this._elementPositions.length);

    // الحسابات هتتعمل على شبكة خفيفة جداً
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const px = i * stepX + stepX / 2;
        const py = pos.y + j * stepY + stepY / 2;

        let re = 0, im = 0;
        for (let n = 0; n < this._elementPositions.length; n++) {
          const ep   = this._elementPositions[n];
          const dist = Math.sqrt((ep.x - px) ** 2 + (ep.y - py) ** 2);
          if (dist < 1e-6) continue;
          const att  = 1 / (1 + dist * 0.003);
          const ph   = -k * dist - omega * (this._delays[n] || 0);
          re += weights[n] * att * Math.cos(ph);
          im += weights[n] * att * Math.sin(ph);
        }
        const mag  = Math.sqrt(re * re + im * im);
        const sign = re;

        const x0 = Math.round(i * stepX), y0 = Math.round(j * stepY + pos.y);
        const x1 = Math.round((i + 1) * stepX), y1 = Math.round((j + 1) * stepY + pos.y);

        // تلوين المربعات الكبيرة (عشان نوفر مجهود الرسم)
        for (let py2 = y0; py2 < Math.min(y1, imgH); py2++) {
          for (let px2 = x0; px2 < Math.min(x1, imgW); px2++) {
            const idx = (py2 * imgW + px2) * 4;
            const v   = MathUtils.clamp(mag / (this._elementPositions.length * 0.4), 0, 1);
            if (sign >= 0) {
              data[idx] = Math.round(v * 20); data[idx+1] = Math.round(v * 180); data[idx+2] = Math.round(v * 255);
            } else {
              data[idx] = Math.round(v * 255); data[idx+1] = Math.round(v * 80); data[idx+2] = Math.round(v * 20);
            }
            data[idx+3] = Math.round(v * 200 + 30);
          }
        }
      }
    }
    return new ImageData(data, imgW, imgH);
  }
  // ── Layout helpers ───────────────────────────────────────────
  _layout_dims() {
    const W = this.renderer.width, H = this.renderer.height;
    const mainW = Math.floor(W * this._layout.mainFrac);
    return { W, H, mainW, secW: W - mainW };
  }

  _phantomCenter() {
    const { mainW, H } = this._layout_dims();
    return { x: mainW/2, y: H/2 + 20 };
  }

  _phantomRadius() {
    const { H } = this._layout_dims();
    const r = Math.min(H*0.35, 160);
    return { rx: r*0.78, ry: r };
  }

  _normToCanvas(nx, ny) {
    const c = this._phantomCenter(), r = this._phantomRadius();
    return { x: c.x + nx*r.rx, y: c.y + ny*r.ry };
  }

  _canvasToNorm(cx, cy) {
    const c = this._phantomCenter(), r = this._phantomRadius();
    return { x: (cx - c.x) / r.rx, y: (cy - c.y) / r.ry };
  }

  _probePos() {
    const c   = this._phantomCenter(), r = this._phantomRadius();
    const gap = this.params.arrayType === 'curved' ? 10 : 20;
    // Orbit: probe sits on an ellipse just outside the phantom boundary
    const orbitRx = r.rx + gap;
    const orbitRy = r.ry + gap;
    const a = this._probeOrbitAngle; // radians, -PI/2 = top
    return {
      x: c.x + orbitRx * Math.cos(a),
      y: c.y + orbitRy * Math.sin(a),
      orbitAngle: a   // expose for beam direction
    };
  }

  // ── Rendering ────────────────────────────────────────────────
  _renderScene() {
    const { ctx, width: W, height: H } = this.renderer;
    const { mainW, secW } = this._layout_dims();

    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, mainW, H); ctx.clip();
    this._drawMainPanel(ctx, mainW, H);
    ctx.restore();

    ctx.strokeStyle = 'rgba(0,212,255,0.15)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(mainW,0); ctx.lineTo(mainW,H); ctx.stroke();

    ctx.save();
    ctx.translate(mainW, 0);
    ctx.beginPath(); ctx.rect(0, 0, secW, H); ctx.clip();
    if      (this.scanMode === 'bmode')   this._drawBModePanel(ctx, secW, H);
    else if (this.scanMode === 'doppler') this._drawDopplerPanel(ctx, secW, H);
    else if (this.scanMode === 'interf')  this._drawInterferencePanel(ctx, secW, H);
    else                                  this._drawAModePanel(ctx, secW, H);
    ctx.restore();

    ctx.save(); ctx.beginPath(); ctx.rect(0,0,mainW,H); ctx.clip();
    this._drawWaves(ctx);
    ctx.restore();

    this._drawStats(ctx);
    this._drawModeLabel(ctx, mainW);
  }

  _drawMainPanel(ctx, mainW, H) {
    const grad = ctx.createLinearGradient(0,0,0,H);
    grad.addColorStop(0,'#060e1e'); grad.addColorStop(1,'#030810');
    ctx.fillStyle = grad; ctx.fillRect(0,0,mainW,H);

    const probeY = this._probePos().y;
    for (let d = probeY+30; d < H; d += 40) {
      ctx.strokeStyle = 'rgba(0,150,255,0.05)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0,d); ctx.lineTo(mainW,d); ctx.stroke();
    }
    this._drawPhantomGrid(ctx, mainW, H);
    this._drawProbeOrbitGuide(ctx);
    if (this.params.showHeatmap)  this._drawHeatmap(ctx, mainW, H);
    if (this.params.showPhantom)  this._drawPhantom(ctx);
    this._drawBeam(ctx, mainW, H);
    this._drawProbe(ctx);
    this._drawElements(ctx);
    this._drawBeamPatternInset(ctx, mainW, H);
    if (this.hoveredEllipse)      this._drawTooltip(ctx, mainW, H);
  }

  _drawPhantom(ctx) {
    const r = this._phantomRadius(), c = this._phantomCenter();
    this.phantomEllipses.forEach(ell => {
      const ctr = this._normToCanvas(ell.cx, ell.cy);
      const a   = ell.a * r.rx, b = ell.b * r.ry;
      ctx.save();
      ctx.translate(ctr.x, ctr.y);
      ctx.rotate(ell.angle * Math.PI/180);
      ctx.beginPath(); ctx.ellipse(0,0,a,b,0,0,Math.PI*2);
      const hovered = ell === this.hoveredEllipse;
      ctx.fillStyle   = hovered ? ell.color.replace(/[\d.]+\)$/, '0.75)') : ell.color;
      ctx.strokeStyle = hovered ? '#00eeff' : 'rgba(255,255,255,0.08)';
      ctx.lineWidth   = hovered ? 2 : 0.5;
      ctx.fill(); ctx.stroke();
      if (ell.isVessel && this.params.showVessel) {
        ctx.clip();
        const t = this._simTime * this.params.bloodVelocity * 3;
        for (let d = 0; d < 5; d++) {
          const dotX  = ((t + d*0.2) % 1) * a*2 - a;
          const alpha = 0.6 - Math.abs(dotX/a)*0.4;
          ctx.fillStyle = `rgba(255,80,80,${alpha})`;
          ctx.beginPath(); ctx.arc(dotX,0,3,0,Math.PI*2); ctx.fill();
        }
      }
      ctx.restore();
    });
    ctx.save(); ctx.setLineDash([4,4]);
    ctx.strokeStyle = 'rgba(0,212,255,0.2)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(c.x,c.y,r.rx,r.ry,0,0,Math.PI*2); ctx.stroke();
    ctx.setLineDash([]); ctx.restore();
  }

  // ── Orbit guide: dashed ellipse showing probe travel path ──────
  _drawProbeOrbitGuide(ctx) {
    const c   = this._phantomCenter();
    const r   = this._phantomRadius();
    const gap = this.params.arrayType === 'curved' ? 10 : 20;
    const orbitRx = r.rx + gap;
    const orbitRy = r.ry + gap;

    ctx.save();
    ctx.strokeStyle = this._probeDragging
      ? 'rgba(255,200,0,0.35)'
      : 'rgba(0,180,255,0.10)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, orbitRx, orbitRy, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  // ── Phantom grid — axis-aligned mm grid centred on the phantom ──
  _drawPhantomGrid(ctx, mainW, H) {
  const c   = this._phantomCenter();
  const r   = this._phantomRadius();
  const mmStep = 10;                        // one grid cell = 10 mm
  const stepPx = mmStep * SCALE_PX_PER_MM; // in pixels

  // 💡 السر هنا: نقطة الصفر للعمق هي البروب مش الفانتوم
  const probeY = this._probePos().y;

  // حدود الرسم عشان نحافظ على الجريد محددة حوالين الفانتوم زي ما إنت كنت عاملها
  const yStart = c.y - r.ry - 10;
  const yEnd   = c.y + r.ry + 15;

  ctx.save();
  ctx.strokeStyle = 'rgba(0,180,255,0.13)';
  ctx.lineWidth   = 0.5;
  ctx.setLineDash([2, 5]);

  // ── Minor grid lines (10 mm) ──────────────────────────────
  // X: Lateral (Centered on phantom, unchanged)
  for (let nx = -r.rx; nx <= r.rx + 0.5; nx += stepPx) {
    const x = c.x + nx;
    ctx.beginPath(); ctx.moveTo(x, yStart); ctx.lineTo(x, yEnd); ctx.stroke();
  }
  // Y: Axial Depth (Starts from probeY, but only drawn near the phantom)
  for (let depthPx = 0; probeY + depthPx <= yEnd; depthPx += stepPx) {
    const y = probeY + depthPx;
    if (y < yStart) continue; // Skip lines above the phantom area
    ctx.beginPath(); ctx.moveTo(c.x - r.rx - 6, y); ctx.lineTo(c.x + r.rx + 6, y); ctx.stroke();
  }
  ctx.setLineDash([]);

  // ── Major grid lines (20 mm) — slightly brighter ──────────
  ctx.strokeStyle = 'rgba(0,200,255,0.22)';
  ctx.lineWidth   = 0.7;
  ctx.setLineDash([3, 4]);
  for (let nx = -r.rx; nx <= r.rx + 0.5; nx += stepPx * 2) {
    const x = c.x + nx;
    ctx.beginPath(); ctx.moveTo(x, yStart); ctx.lineTo(x, yEnd); ctx.stroke();
  }
  for (let depthPx = 0; probeY + depthPx <= yEnd; depthPx += stepPx * 2) {
    const y = probeY + depthPx;
    if (y < yStart) continue;
    ctx.beginPath(); ctx.moveTo(c.x - r.rx - 8, y); ctx.lineTo(c.x + r.rx + 8, y); ctx.stroke();
  }
  ctx.setLineDash([]);

  // ── Solid axis lines ───────────────────────
  ctx.strokeStyle = 'rgba(0,220,255,0.45)';
  ctx.lineWidth   = 1;
  // Vertical axis (X=0) - The central line
  ctx.beginPath(); ctx.moveTo(c.x, yStart - 10); ctx.lineTo(c.x, yEnd + 10); ctx.stroke();
  // Note: We removed the Horizontal Solid Axis because 0 Depth is now at the probe, not in the middle.

  // ── Tick marks on axes ────────────────────────────────────
  ctx.strokeStyle = 'rgba(0,220,255,0.55)';
  ctx.lineWidth   = 1;
  for (let nx = -r.rx; nx <= r.rx + 0.5; nx += stepPx) {
    const x = c.x + nx;
    const isM = Math.abs(Math.round(nx / stepPx) % 2) === 0;
    ctx.beginPath(); ctx.moveTo(x, yEnd); ctx.lineTo(x, yEnd + (isM ? 5 : 3)); ctx.stroke();
  }
  for (let depthPx = 0; probeY + depthPx <= yEnd; depthPx += stepPx) {
    const y = probeY + depthPx;
    if (y < yStart) continue;
    const isM = Math.abs(Math.round(depthPx / stepPx) % 2) === 0;
    ctx.beginPath(); ctx.moveTo(c.x - r.rx - (isM ? 5 : 3), y); ctx.lineTo(c.x - r.rx, y); ctx.stroke();
  }

  // ── Axis labels (mm) ───────────────────────
  ctx.font      = '9px monospace';

  // X-axis labels (lateral, below phantom)
  ctx.fillStyle = 'rgba(0,220,255,0.70)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (let nx = -r.rx; nx <= r.rx + 0.5; nx += stepPx) {
    const mm  = Math.round(nx / SCALE_PX_PER_MM);
    if (mm === 0) continue;
    ctx.fillText(`${mm}`, c.x + nx, yEnd + 14);
  }

  // Y-axis labels (depth, left of phantom)
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle'; // Center text nicely with the lines
  for (let depthPx = 0; probeY + depthPx <= yEnd; depthPx += stepPx) {
    const y = probeY + depthPx;
    if (y < yStart) continue;
    const mm  = Math.round(depthPx / SCALE_PX_PER_MM);
    ctx.fillText(`${mm}`, c.x - r.rx - 9, y);
  }

  // ── Origin "0" label (Lateral Only) ──────────────────────
  ctx.fillStyle = 'rgba(0,240,255,0.85)';
  ctx.textAlign = 'center';
  ctx.fillText('0', c.x, yEnd + 14);

  // ── Axis unit labels ──────────────────────────────────────
  ctx.font      = 'bold 9px monospace';
  ctx.fillStyle = 'rgba(0,200,255,0.50)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('Lateral (mm)', c.x, yEnd + 26);

  ctx.save();
  ctx.translate(c.x - r.rx - 24, c.y);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText('Axial Depth (mm)', 0, 0);
  ctx.restore();

  ctx.restore();
}
  _drawProbe(ctx) {
    const pos      = this._probePos();
    const isCurved = this.params.arrayType === 'curved';

    // Probe face always points toward phantom center
    const c        = this._phantomCenter();
    const faceAngle = Math.atan2(c.y - pos.y, c.x - pos.x); // radians toward center
    // Rotate so probe body is perpendicular to the inward direction
    const bodyAngle = faceAngle - Math.PI / 2 + this._probeAnimAngle;

    ctx.save();
    ctx.translate(pos.x, pos.y);
    ctx.rotate(bodyAngle);

    if (isCurved) {
      const radiusPx = this._probe.curvatureRadius * SCALE_PX_PER_MM;
      const arc = this._probe.arcAngle, half = arc/2;
      ctx.fillStyle='#1a3a5a'; ctx.strokeStyle='#00aacc'; ctx.lineWidth=1.5;
      ctx.beginPath(); ctx.roundRect(-28,-18,56,14,4); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(0,0,radiusPx,Math.PI/2-half,Math.PI/2+half);
      ctx.strokeStyle='#00eeff'; ctx.lineWidth=4; ctx.stroke();
      ctx.beginPath(); ctx.arc(0,0,radiusPx,Math.PI/2-half,Math.PI/2+half);
      ctx.strokeStyle='#003a55'; ctx.lineWidth=2; ctx.stroke();
    } else {
      ctx.fillStyle='#1a3a5a'; ctx.strokeStyle='#00aacc'; ctx.lineWidth=1.5;
      ctx.beginPath(); ctx.roundRect(-30,-16,60,16,4); ctx.fill(); ctx.stroke();
      ctx.fillStyle='#005577'; ctx.fillRect(-26,-5,52,5);
    }

    // Drag handle: small glowing circle on probe body
    ctx.beginPath(); ctx.arc(0,-22,5,0,Math.PI*2);
    ctx.fillStyle = this._probeDragging ? 'rgba(255,200,0,0.9)' : 'rgba(0,200,255,0.5)';
    ctx.fill();
    ctx.strokeStyle='rgba(255,255,255,0.4)'; ctx.lineWidth=1; ctx.stroke();

    ctx.restore();
  }

  _drawBeam(ctx, mainW, H) {
  if (!this.params.showBeam) return;
  const isCurved = this.params.arrayType === 'curved';
  const pos      = this._probePos();

  const phantomC = this._phantomCenter();
  const inward   = Math.atan2(phantomC.y - pos.y, phantomC.x - pos.x);
  const steerRad = this._probe.steerAngle * Math.PI / 180;
  const beamDir  = inward + steerRad;

  const origin = isCurved
    ? { x: pos.x + this._probe.curvatureRadius * SCALE_PX_PER_MM * Math.cos(inward),
        y: pos.y + this._probe.curvatureRadius * SCALE_PX_PER_MM * Math.sin(inward) }
    : { x: pos.x, y: pos.y };

  const sPx = this._probe.spacing * PHYS_SPACING_MM * SCALE_PX_PER_MM;
  const apertureWidth = this._probe.numElements * sPx;

  // perpendicular direction
  const px = Math.cos(beamDir + Math.PI / 2);
  const py = Math.sin(beamDir + Math.PI / 2);

  const wl = MathUtils.wavelength(this._probe.frequency, SPEED_OF_SOUND);
  let bw = MathUtils.beamwidth3dB(this._probe.numElements, sPx, wl * SCALE_PX_PER_MM * 1000);

  let broadeningFactor = 1.0;
  switch (this.params.apodization) {
    case 'hanning':  broadeningFactor = 1.44; break;
    case 'hamming':  broadeningFactor = 1.30; break;
    case 'blackman': broadeningFactor = 1.64; break;
    case 'kaiser':   broadeningFactor = 1.0 + (this.params.kaiserBeta * 0.08); break;
    default:         broadeningFactor = 1.0; break;
  }
  bw = bw * broadeningFactor;

  const focalPx  = this._probe.focalDepth * SCALE_PX_PER_MM;
  const tanHalfBw = Math.tan(bw / 2) * (isCurved ? 1.6 : 1.0);

  // نحسب نهاية الشعاع عند حد معقول بصرياً (مش 1.5x الشاشة)
  const beamLen = Math.max(mainW, H) * 0.85;
  const bx2 = origin.x + beamLen * Math.cos(beamDir);
  const by2 = origin.y + beamLen * Math.sin(beamDir);

  ctx.save();

  if (this.params.focusing && this._focalPoint) {
    const fx = this._focalPoint.x, fy = this._focalPoint.y;

    // waist عند الـ focal point = نفس حساب halfBw الفيزيائي
    const waist = Math.max(2, tanHalfBw * focalPx);

    // بعد الـ focal: الشعاع يتوسع بنفس الـ angle
    const distAfterFocal = Math.sqrt((bx2 - fx)**2 + (by2 - fy)**2);
    const endWidth = waist + distAfterFocal * tanHalfBw;

    // قبل الـ focal: يضيق من الـ aperture للـ waist
    ctx.beginPath();
    ctx.moveTo(origin.x + px * (apertureWidth / 2), origin.y + py * (apertureWidth / 2));
    ctx.lineTo(origin.x - px * (apertureWidth / 2), origin.y - py * (apertureWidth / 2));
    ctx.lineTo(fx - px * waist, fy - py * waist);
    // بعد الـ focal: يتوسع
    ctx.lineTo(bx2 - px * endWidth, by2 - py * endWidth);
    ctx.lineTo(bx2 + px * endWidth, by2 + py * endWidth);
    ctx.lineTo(fx + px * waist, fy + py * waist);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0, 220, 255, 0.22)';
    ctx.fill();

  } else {
    // بدون focusing: يتوسع من البروب بشكل مستمر
    const endWidth = Math.max(4, tanHalfBw * beamLen);
    ctx.beginPath();
    ctx.moveTo(origin.x + px * (apertureWidth / 2), origin.y + py * (apertureWidth / 2));
    ctx.lineTo(origin.x - px * (apertureWidth / 2), origin.y - py * (apertureWidth / 2));
    ctx.lineTo(bx2 - px * endWidth, by2 - py * endWidth);
    ctx.lineTo(bx2 + px * endWidth, by2 + py * endWidth);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0, 220, 255, 0.15)';
    ctx.fill();
  }

  // centre line
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.moveTo(origin.x, origin.y);
  ctx.lineTo(bx2, by2);
  ctx.strokeStyle = '#00eeff'; ctx.lineWidth = 1.5; ctx.stroke();

  // focal point dot
  if (this.params.focusing && this._focalPoint) {
    ctx.beginPath();
    ctx.arc(this._focalPoint.x, this._focalPoint.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,200,0,1)'; ctx.fill();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; ctx.stroke();
  }

  ctx.restore();
}
  _drawElements(ctx) {
    const weights  = this._probe.getWeights ? this._probe.getWeights() : [];
    const isCurved = this.params.arrayType === 'curved';

    this._elementPositions.forEach((pos, i) => {
      const w = (weights[i] !== undefined && isFinite(weights[i])) ? weights[i] : 1;
      ctx.save();
      ctx.beginPath(); ctx.arc(pos.x,pos.y,3+w*1.5,0,Math.PI*2);
      ctx.fillStyle=`hsl(${180+w*40},80%,${40+w*40}%)`;
      ctx.fill(); ctx.strokeStyle='rgba(0,230,255,0.5)'; ctx.lineWidth=0.5; ctx.stroke();
      ctx.restore();
    });

    if (this._elementPositions.length >= 2) {
      const f = this._elementPositions[0];
      const l = this._elementPositions[this._elementPositions.length-1];
      ctx.save(); ctx.strokeStyle='#003366'; ctx.lineWidth=5;
      if (isCurved) {
        const radiusPx = this._probe.curvatureRadius * SCALE_PX_PER_MM;
        const arc = this._probe.arcAngle, half = arc/2;
        const pos = this._probePos();
        const c   = this._phantomCenter();
        const inward = Math.atan2(c.y - pos.y, c.x - pos.x);
        ctx.beginPath(); ctx.arc(pos.x, pos.y, radiusPx, inward-half, inward+half); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.moveTo(f.x,f.y); ctx.lineTo(l.x,l.y); ctx.stroke();
      }
      ctx.restore();
    }
  }

  _drawHeatmap(ctx, mainW, H) {
    if (!this._probe.engine) return;
    const pos = this._probePos();
    const c   = this._phantomCenter();
    const r   = this._phantomRadius();
    // Render heatmap over the phantom region regardless of probe orbit
    const startY = c.y - r.ry - 10;
    const res = 60, stepX = mainW/res, stepY = (H - startY)/res;
    const t   = this._simTime;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const px2 = i*stepX, py2 = startY+j*stepY;
        const intensity = this._probe.engine.computeFieldIntensity(
          this._elementPositions, this._delays, {x:px2,y:py2}, t, SPEED_OF_SOUND
        );
        const val = MathUtils.clamp(intensity/4, 0, 1);
        if (val < 0.12) continue;
        const [r,g,b] = Renderer.colormapColor(val,'hot');
        ctx.fillStyle=`rgba(${r},${g},${b},${val*0.18})`;
        ctx.fillRect(i*stepX,py2,stepX+1,stepY+1);
      }
    }

    // --- رسم مفتاح الألوان (Legend) للـ Heatmap ---
    const legX = mainW - 160;
    const legY = 35; // نزلناها شوية عشان متخبطش في اسم الـ Mode

    ctx.fillStyle = 'rgba(0, 8, 22, 0.85)';
    ctx.fillRect(legX, legY, 150, 45);
    ctx.strokeStyle = 'rgba(0, 180, 255, 0.3)';
    ctx.strokeRect(legX, legY, 150, 45);

    ctx.fillStyle = '#00d4ff';
    ctx.font = 'bold 10px monospace';
    ctx.fillText('HEATMAP ENERGY', legX + 8, legY + 14);

    // شريط الألوان المتدرج
    const grad = ctx.createLinearGradient(legX + 8, legY + 20, legX + 142, legY + 20);
    grad.addColorStop(0, 'rgba(0,0,0,0.5)');
    grad.addColorStop(0.33, 'rgb(150,0,0)');
    grad.addColorStop(0.66, 'rgb(255,150,0)');
    grad.addColorStop(1, 'rgb(255,255,255)');
    ctx.fillStyle = grad;
    ctx.fillRect(legX + 8, legY + 20, 134, 8);

    // الكلمات التوضيحية
    ctx.fillStyle = '#aaaaaa';
    ctx.font = '9px monospace';
    ctx.fillText('Low', legX + 8, legY + 40);
    ctx.fillText('High', legX + 88, legY + 40);
  }
  _drawBeamPatternInset(ctx, mainW, H) {
    if (!this._probe.engine) return;
    const px=mainW-125, py=H-125, pw=115, ph=115;
    ctx.fillStyle='rgba(0,8,20,0.88)'; ctx.strokeStyle='rgba(0,150,255,0.35)';
    ctx.lineWidth=1; ctx.fillRect(px,py,pw,ph); ctx.strokeRect(px,py,pw,ph);
    ctx.fillStyle='rgba(0,150,255,0.5)'; ctx.font='9px monospace';
    ctx.fillText('BEAM PATTERN',px+4,py+11);

    const pattern = this._probe.engine.computeBeamPattern(SPEED_OF_SOUND, 180);
    const cx2=px+pw/2, cy2=py+ph/2, rad=46;
    ctx.strokeStyle='rgba(0,80,180,0.2)'; ctx.lineWidth=0.5;
    [0.25,0.5,0.75,1].forEach(g => {
      ctx.beginPath(); ctx.arc(cx2,cy2,rad*g,0,Math.PI*2); ctx.stroke();
    });
    ctx.beginPath(); ctx.moveTo(cx2,cy2-rad); ctx.lineTo(cx2,cy2+rad); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx2-rad,cy2); ctx.lineTo(cx2+rad,cy2); ctx.stroke();

    ctx.beginPath();
    pattern.forEach((p,i) => {
      const mag = isFinite(p.magnitude) ? p.magnitude : 0;
      const x2  = cx2 + rad * mag * Math.sin(p.angle);
      const y2  = cy2 - rad * mag * Math.cos(p.angle);
      i===0 ? ctx.moveTo(x2,y2) : ctx.lineTo(x2,y2);
    });
    ctx.strokeStyle='#00eeff'; ctx.lineWidth=1.5; ctx.stroke();

    if (this.params.apodization !== 'none') {
      ctx.fillStyle='rgba(255,200,0,0.7)'; ctx.font='8px monospace';
      ctx.fillText(this.params.apodization.toUpperCase(),px+4,py+ph-4);
    }
  }

  _drawWaves(ctx) {
    const WAVE_SPEED_PX_S = 150; // visual wave speed px/s
    this._waves.forEach(w => {
      const elapsed = this._simTime - w.born - w.delay * 0.001;
      if (elapsed < 0) return;
      w.radius = elapsed * WAVE_SPEED_PX_S;
      if (!this.params.showIndividual) return;
      const alpha = Math.max(0, 0.5 - w.radius/180) * MathUtils.clamp(w.weight,0,1);
      if (alpha < 0.01) return;
      ctx.save(); ctx.globalAlpha = alpha;
      ctx.beginPath(); ctx.arc(w.cx,w.cy,w.radius,0,Math.PI*2);
      ctx.strokeStyle=`hsl(${185+w.elementIdx*4},80%,65%)`;
      ctx.lineWidth=0.7; ctx.stroke(); ctx.restore();
    });
  }

  _drawAModePanel(ctx, secW, H) {
  ctx.fillStyle = '#030a16'; ctx.fillRect(0, 0, secW, H);

  ctx.fillStyle = '#00d4ff'; ctx.font = 'bold 11px monospace';
  ctx.fillText('A-MODE  (Echo Amplitude vs Depth)', 8, 18);

  const plotLeft = 42, plotTop = 28, plotRight = 8, plotBottom = 32;
  const plotW = secW - plotLeft - plotRight;
  const plotH = H - plotTop - plotBottom;
  const N = this._amodeData.length;

  const maxDepthMm = (this._amodeMaxDepthPx ||
    (this.renderer.height - this._probePos().y - 20)) / SCALE_PX_PER_MM;

  // Envelope
  const rect = new Float32Array(N);
  for (let i = 0; i < N; i++) rect[i] = Math.abs(this._amodeData[i]);
  const envelope = new Float32Array(N);
  for (let i = 2; i < N - 2; i++)
    envelope[i] = (rect[i-2] + rect[i-1] + rect[i] + rect[i+1] + rect[i+2]) / 5;

  let maxEnv = 0;
  for (let i = 0; i < N; i++) if (envelope[i] > maxEnv) maxEnv = envelope[i];
  maxEnv = Math.max(maxEnv, 1e-6);
  const logComp = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const norm = envelope[i] / maxEnv;
    logComp[i] = Math.max(0, 1 + (20 * Math.log10(Math.max(norm, 1e-4))) / 40);
  }

  let maxRF = 0;
  for (let i = 0; i < N; i++) if (Math.abs(this._amodeData[i]) > maxRF) maxRF = Math.abs(this._amodeData[i]);
  maxRF = Math.max(maxRF, 1e-6);

  // Grid
  ctx.save();
  ctx.strokeStyle = 'rgba(0,150,255,0.12)'; ctx.lineWidth = 0.5; ctx.setLineDash([2, 4]);
  for (let mm = 0; mm <= maxDepthMm; mm += 10) {
    const x = plotLeft + (mm / maxDepthMm) * plotW;
    if (x > plotLeft + plotW + 1) break;
    ctx.beginPath(); ctx.moveTo(x, plotTop); ctx.lineTo(x, plotTop + plotH); ctx.stroke();
  }
  for (let i = 0; i <= 4; i++) {
    const y = plotTop + plotH - (i / 4) * plotH;
    ctx.beginPath(); ctx.moveTo(plotLeft, y); ctx.lineTo(plotLeft + plotW, y); ctx.stroke();
  }
  ctx.setLineDash([]); ctx.restore();

  // Clip + draw traces
  ctx.save();
  ctx.beginPath(); ctx.rect(plotLeft, plotTop, plotW, plotH); ctx.clip();

  const baseY = plotTop + plotH;

  // RF trace
  ctx.beginPath(); ctx.strokeStyle = 'rgba(0,200,255,0.30)'; ctx.lineWidth = 0.8;
  for (let i = 0; i < N; i++) {
    const x = plotLeft + (i / N) * plotW;
    const y = baseY - (this._amodeData[i] / maxRF) * (plotH * 0.45);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();

  // Log envelope
  ctx.beginPath(); ctx.strokeStyle = '#00eeff'; ctx.lineWidth = 1.5;
  for (let i = 0; i < N; i++) {
    const x = plotLeft + (i / N) * plotW;
    const y = baseY - logComp[i] * (plotH * 0.90);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();

  // Border
  ctx.strokeStyle = 'rgba(0,180,255,0.25)'; ctx.lineWidth = 1;
  ctx.strokeRect(plotLeft, plotTop, plotW, plotH);

  // X axis labels — Depth
  ctx.fillStyle = 'rgba(0,200,255,0.75)'; ctx.font = '8px monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let mm = 0; mm <= maxDepthMm; mm += 20) {
    const x = plotLeft + (mm / maxDepthMm) * plotW;
    if (x > plotLeft + plotW + 2) break;
    ctx.fillText(`${mm}`, x, plotTop + plotH + 4);
    ctx.strokeStyle = 'rgba(0,200,255,0.35)'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(x, plotTop + plotH); ctx.lineTo(x, plotTop + plotH + 3); ctx.stroke();
  }
  ctx.fillStyle = 'rgba(0,180,255,0.55)'; ctx.font = 'bold 8px monospace';
  ctx.fillText('Depth (mm)', plotLeft + plotW / 2, plotTop + plotH + 18);

  // Y axis labels — Amplitude
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.font = '8px monospace';
  for (const [label, val] of [['0',0],['0.25',0.25],['0.5',0.5],['0.75',0.75],['1.0',1.0]]) {
    const y = plotTop + plotH - val * (plotH * 0.90);
    ctx.fillStyle = 'rgba(0,200,255,0.65)';
    ctx.fillText(label, plotLeft - 3, y);
    ctx.strokeStyle = 'rgba(0,200,255,0.30)'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(plotLeft - 3, y); ctx.lineTo(plotLeft, y); ctx.stroke();
  }
  ctx.save();
  ctx.translate(11, plotTop + plotH / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = 'rgba(0,180,255,0.55)'; ctx.font = 'bold 8px monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('Amplitude', 0, 0);
  ctx.restore();

  // Legend
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(0,200,255,0.45)'; ctx.font = '9px monospace';
  ctx.fillText('── RF signal', plotLeft, H - 14);
  ctx.fillStyle = '#00eeff';
  ctx.fillText('── Log envelope', plotLeft + 82, H - 14);
}


  _drawInterferencePanel(ctx, secW, H) {
      ctx.fillStyle = '#020810'; ctx.fillRect(0, 0, secW, H);
      ctx.fillStyle = '#ffaa00'; ctx.font = 'bold 11px monospace';
      ctx.fillText('INTERFERENCE MAP & BEAM PROFILE', 8, 18);

      // --- إضافة مفتاح الألوان (Color Code Legend) ---
      ctx.font = '10px monospace';
      ctx.fillStyle = '#00d4ff';
      ctx.fillText(' Blue = Constructive', 8, 35);
      ctx.fillStyle = '#ff4444';
      ctx.fillText(' Red =Destructive', 8, 50);

      // 1. رسم خريطة التداخل (فوق)
      const mapTop = 60; // نزلناها لتحت شوية عشان نوسع للشرح
      const mapH = Math.floor(H * 0.55) - mapTop;
      const mapW = Math.floor(secW);

      const imgData = this._buildInterferenceMap(mapW, mapH);
      if (imgData) {
        const tmp = document.createElement('canvas');
        tmp.width = mapW; tmp.height = mapH;
        tmp.getContext('2d').putImageData(imgData, 0, 0);
        ctx.drawImage(tmp, 0, mapTop, mapW, mapH);
      }

      // 2. رسم الـ Beam Profile على شكل دايرة Polar (تحت)
      const plotTop = mapTop + mapH + 10;
      const cx = secW / 2;
      const cy = plotTop + (H - plotTop) / 2 + 10;
      const rad = Math.min(secW, H - plotTop) * 0.4;

      ctx.strokeStyle = 'rgba(255, 170, 0, 0.15)'; ctx.lineWidth = 1;
      [0.25, 0.5, 0.75, 1].forEach(g => {
        ctx.beginPath(); ctx.arc(cx, cy, rad * g, 0, Math.PI * 2); ctx.stroke();
      });
      ctx.beginPath(); ctx.moveTo(cx, cy - rad); ctx.lineTo(cx, cy + rad); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx - rad, cy); ctx.lineTo(cx + rad, cy); ctx.stroke();

      if (this._probe.engine) {
        const pattern = this._probe.engine.computeBeamPattern(SPEED_OF_SOUND, 360);
        ctx.beginPath();
        pattern.forEach((p, i) => {
          const mag = isFinite(p.magnitude) ? p.magnitude : 0;
          const x2 = cx + rad * mag * Math.sin(p.angle);
          const y2 = cy - rad * mag * Math.cos(p.angle);
          i === 0 ? ctx.moveTo(x2, y2) : ctx.lineTo(x2, y2);
        });
        ctx.strokeStyle = '#ffaa00'; ctx.lineWidth = 2; ctx.stroke();
      }
    }
  // ── B-Mode grid ── mm-scale grid drawn over the scan image ──────
  _drawBModeGrid(ctx, secW, H) {
    const plotLeft = 28, plotTop = 40;
    const plotW    = secW - plotLeft - 6;
    const plotH    = H - 60;
    const mmStep   = 10;
    const stepPx   = mmStep * SCALE_PX_PER_MM;

    const maxDepthMm = (this._amodeMaxDepthPx || (this.renderer.height - this._probePos().y - 20)) / SCALE_PX_PER_MM;

    // ── Minor grid lines ────────────────────────────────────────
    ctx.save();
    ctx.strokeStyle = 'rgba(0,180,255,0.15)';
    ctx.lineWidth   = 0.5;
    ctx.setLineDash([2, 5]);
    for (let py = plotTop; py <= plotTop + plotH; py += stepPx) {
      ctx.beginPath(); ctx.moveTo(plotLeft, py); ctx.lineTo(plotLeft + plotW, py); ctx.stroke();
    }
    const nCols = Math.floor(plotW / stepPx);
    for (let ix = 0; ix <= nCols; ix++) {
      const px = plotLeft + ix * stepPx;
      ctx.beginPath(); ctx.moveTo(px, plotTop); ctx.lineTo(px, plotTop + plotH); ctx.stroke();
    }
    ctx.setLineDash([]);

    // ── Major grid lines (every 20 mm) ─────────────────────────
    ctx.strokeStyle = 'rgba(0,200,255,0.25)';
    ctx.lineWidth   = 0.7;
    ctx.setLineDash([3, 4]);
    for (let py = plotTop; py <= plotTop + plotH; py += stepPx * 2) {
      ctx.beginPath(); ctx.moveTo(plotLeft, py); ctx.lineTo(plotLeft + plotW, py); ctx.stroke();
    }
    for (let ix = 0; ix <= nCols; ix += 2) {
      const px = plotLeft + ix * stepPx;
      ctx.beginPath(); ctx.moveTo(px, plotTop); ctx.lineTo(px, plotTop + plotH); ctx.stroke();
    }
    ctx.setLineDash([]);

    // ── Zero / border lines ──────────────────────────────────
    ctx.strokeStyle = 'rgba(0,220,255,0.40)';
    ctx.lineWidth   = 1;
    ctx.strokeRect(plotLeft, plotTop, plotW, plotH);

    // ── Depth labels (left ruler) ────────────────────────────
    ctx.fillStyle = 'rgba(0,210,255,0.75)';
    ctx.font      = '8px monospace';
    ctx.textAlign = 'right';
    for (let py = plotTop; py <= plotTop + plotH + 1; py += stepPx) {
      const mm = Math.round(((py - plotTop) / plotH) * maxDepthMm);
      const isMaj = (Math.round(mm / mmStep) % 2 === 0);
      ctx.fillStyle = isMaj ? 'rgba(0,230,255,0.85)' : 'rgba(0,180,255,0.55)';
      ctx.fillText(`${mm}`, plotLeft - 2, py + 3);
      // tick on left edge
      ctx.strokeStyle = isMaj ? 'rgba(0,230,255,0.6)' : 'rgba(0,180,255,0.35)';
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(plotLeft - (isMaj ? 5 : 3), py); ctx.lineTo(plotLeft, py); ctx.stroke();
    }

    // ── Lateral labels (top axis) ────────────────────────────
    ctx.fillStyle = 'rgba(0,210,255,0.75)';
    ctx.textAlign = 'center';
    ctx.font      = '8px monospace';
    // Compute the physical width of the B-mode image
    const isLinear = this.params.arrayType === 'linear';
    const sPx      = this._probe.spacing * PHYS_SPACING_MM * SCALE_PX_PER_MM;
    const totalMm  = isLinear
      ? (this._probe.numElements * sPx) / SCALE_PX_PER_MM
      : 60; // sector: ±30°

    for (let ix = 0; ix <= nCols; ix++) {
      const px = plotLeft + ix * stepPx;
      const mm = Math.round(-totalMm / 2 + (ix / nCols) * totalMm);
      const isMaj = (Math.round(mm / mmStep) % 2 === 0);
      ctx.fillStyle = isMaj ? 'rgba(0,230,255,0.85)' : 'rgba(0,180,255,0.55)';
      ctx.fillText(`${mm}`, px, plotTop - 3);
      ctx.strokeStyle = isMaj ? 'rgba(0,230,255,0.6)' : 'rgba(0,180,255,0.35)';
      ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(px, plotTop); ctx.lineTo(px, plotTop + (isMaj ? 5 : 3)); ctx.stroke();
    }

    // ── Axis unit labels ─────────────────────────────────────
    ctx.font      = 'bold 8px monospace';
    ctx.fillStyle = 'rgba(0,200,255,0.50)';
    ctx.textAlign = 'center';
    ctx.fillText('Lateral (mm)', plotLeft + plotW / 2, plotTop - 13);

    ctx.save();
    ctx.translate(plotLeft - 18, plotTop + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Depth (mm)', 0, 0);
    ctx.restore();

    ctx.textAlign = 'left';
    ctx.restore();
  }
// ── 1. التحقق من قطع الشعاع للوعاء الدموي ────────────────
  // ── التحقق الهندسي: هل الشعاع يقطع الوعاء الدموي فعلياً؟ ──
  _beamIntersectsVessel() {
    const vessel = this.phantomEllipses.find(e => e.isVessel);
    if (!vessel) return false;

    const probePos = this._probePos();
    const steerRad = this._probe.steerAngle * Math.PI / 180;
    // اتجاه الشعاع المطلق بناءً على وضعية البروب (Orbit) والـ Steering
    const inward = probePos.orbitAngle + Math.PI;
    const beamAngle = inward + steerRad;
    const dx = Math.cos(beamAngle), dy = Math.sin(beamAngle);

    const ctr = this._normToCanvas(vessel.cx, vessel.cy);
    const r = this._phantomRadius();
    const cosA = Math.cos(vessel.angle * Math.PI / 180);
    const sinA = Math.sin(vessel.angle * Math.PI / 180);
    const a = vessel.a * r.rx, b = vessel.b * r.ry;

    // تحويل إحداثيات الشعاع لإحداثيات الوعاء (Ellipse local coordinates)
    const ox = probePos.x - ctr.x, oy = probePos.y - ctr.y;
    const lx = ox * cosA + oy * sinA, ly = -ox * sinA + oy * cosA;
    const ldx = dx * cosA + dy * sinA, ldy = -dx * sinA + dy * cosA;

    const A2 = (ldx / a) ** 2 + (ldy / b) ** 2;
    const B2 = 2 * ((lx * ldx) / (a * a) + (ly * ldy) / (b * b));
    const C2 = (lx / a) ** 2 + (ly / b) ** 2 - 1;
    const disc = B2 * B2 - 4 * A2 * C2;

    if (disc < 0 || A2 < 1e-12) return false;
    const t = (-B2 - Math.sqrt(disc)) / (2 * A2);
    return t > 5; // خبط في الوعاء قدام البروب بمسافة كافية
  }
  // ── 2. حساب الزاوية الفيزيائية الصحيحة ──────────────
  _computeBeamVesselAngle() {
    const probePos = this._probePos();
    const steerRad = this._probe.steerAngle * Math.PI / 180;
    const inward = probePos.orbitAngle + Math.PI;
    const beamAngle = inward + steerRad;
    const vessel = this.phantomEllipses.find(e => e.isVessel);
    const vesselAngleAbs = (vessel?.angle || 30) * Math.PI / 180;
    return beamAngle - vesselAngleAbs;
  }

// ── 3. نسخة محدثة من حساب الدوبلر ──
  _computeDoppler(dt = 0.016) {
      const vessel = this.phantomEllipses.find(e => e.isVessel);
      if (!vessel) return;

      this._dopplerTime += dt;
      const hits = this._beamIntersectsVessel();

      if (!hits) {
        this._dopplerHistory.push({ fd: 0, power: 0, hit: false, t: this._dopplerTime });
      } else {
        // التأكد من قراءة السرعة الأساسية من الإعدادات
        const baseVel = isFinite(this.params.bloodVelocity) ? this.params.bloodVelocity : 0.5;

        const probePos = this._probePos();
        const beamAngle = (probePos.orbitAngle + Math.PI) + (this._probe.steerAngle * Math.PI / 180);
        const vesselAngleAbs = (vessel.angle || 0) * Math.PI / 180;

        // الزاوية الفيزيائية الحقيقية (للحسابات)
        const theta = beamAngle - vesselAngleAbs;
        const cosTheta = Math.cos(theta);

        // تطبيق نبضة القلب على سرعة الدم اللحظية
        const cardiac = Math.pow(Math.max(0, Math.sin(this._dopplerTime * 2 * Math.PI * 1.0)), 2);
        const currentVel = baseVel * (0.2 + 0.8 * cardiac);

        // حساب الـ Shift بالهرتز
        const fd = 2 * currentVel * cosTheta * this._probe.frequency / 1540;

        const snrFactor = 0.05 + 0.95 * MathUtils.clamp(this._probe.snr / 1000, 0, 1);
        const power = snrFactor;

        this._dopplerHistory.push({
          fd,
          power,
          hit: true,
          t: this._dopplerTime,
          cosTheta,
          theta: theta * 180 / Math.PI // تخزين الزاوية الحقيقية بالدرجات
        });
      }
      if (this._dopplerHistory.length > 200) this._dopplerHistory.shift();
    }
  // Replaces lines 1324–1383 in ultrasound.js
// Features: Power Spectrum (top) + Waterfall scrolling (bottom)
// ============================================================
  
  _drawDopplerPanel(ctx, secW, H) {
      ctx.fillStyle = '#020a08'; ctx.fillRect(0, 0, secW, H);

      const history = this._dopplerHistory;
      const lastPt = history.length > 0 ? history[history.length - 1] : null;
      const beamHit = lastPt?.hit ?? false;
      const maxFd = 5000;
      const snrNorm = Math.min(1, Math.max(0, this._probe.snr / 1000));

      const specH = Math.floor(H * 0.45);
      const ML = 36, MR = 12, MT = 25;
      const plotW = secW - ML - MR;
      const spH = specH - MT - 20;

      // 1. عنوان الـ Power Spectrum
      ctx.fillStyle = '#00ff9f'; ctx.font = 'bold 10px monospace';
      ctx.fillText('DOPPLER POWER SPECTRUM', ML, 15);

      // ── Y-axis label (Power Spectrum) ──
      ctx.save();
      ctx.translate(9, MT + spH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = 'rgba(0, 255, 150, 0.7)';
      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Power (dB)', 0, 0);
      ctx.restore();

      // ── رسم الشبكة (Grid) ──
      ctx.strokeStyle = 'rgba(0, 255, 150, 0.1)'; ctx.lineWidth = 0.5;
      for (let i = 0; i <= 5; i++) {
        const gy = MT + (i / 5) * spH;
        ctx.beginPath(); ctx.moveTo(ML, gy); ctx.lineTo(ML + plotW, gy); ctx.stroke();
        ctx.fillStyle = 'rgba(0, 255, 150, 0.5)'; ctx.font = '8px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`${-i * 10}`, 5, gy + 3);
      }

      const kHzTicks = [-4, -3, -2, -1, 0, 1, 2, 3, 4];
      kHzTicks.forEach(k => {
        const gx = ML + plotW / 2 + (k * 1000 / maxFd) * (plotW / 2);
        ctx.beginPath(); ctx.moveTo(gx, MT); ctx.lineTo(gx, MT + spH); ctx.stroke();
        ctx.textAlign = 'center';
        ctx.fillText(k === 0 ? '0' : `${k > 0 ? '+' : ''}${k}k`, gx, MT + spH + 12);
        ctx.textAlign = 'left';
      });

      // ── X-axis label (Power Spectrum) ──
      ctx.fillStyle = 'rgba(0, 255, 150, 0.7)';
      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Frequency (kHz)', ML + plotW / 2, MT + spH + 22);
      ctx.textAlign = 'left';

      if (beamHit) {
        const spectrumSigmaHz = 40 + (1 - snrNorm) * 500;
        const peakFd = lastPt.fd;

        ctx.save();
        ctx.beginPath(); ctx.rect(ML, MT, plotW, spH); ctx.clip();
        ctx.beginPath();
        for (let px = 0; px <= plotW; px++) {
          const fd = -maxFd + (px / plotW) * maxFd * 2;
          const diff = fd - peakFd;
          const g = lastPt.power * Math.exp(-(diff * diff) / (2 * spectrumSigmaHz * spectrumSigmaHz));
          const db = Math.max(-50, g > 0.001 ? 20 * Math.log10(g) : -60);
          const cy = MT + (db / -50) * spH;
          px === 0 ? ctx.moveTo(ML + px, cy) : ctx.lineTo(ML + px, cy);
        }
        ctx.strokeStyle = '#00ffb0'; ctx.lineWidth = 2; ctx.stroke();
        ctx.restore();
      }

      // 2. عنوان الـ Waterfall
      const wfTop = specH + 15;
      ctx.fillStyle = 'rgba(0, 255, 150, 0.7)'; ctx.font = 'bold 9px monospace';
      ctx.textAlign = 'left';
      ctx.fillText('PULSATILE WATERFALL', ML, wfTop);
      ctx.fillStyle = 'rgba(0, 255, 150, 0.4)';
      ctx.fillText('· 60 BPM', ML + 115, wfTop);

      // ── رسم الـ Waterfall ──
      const wfH = H - wfTop - 45;
      ctx.strokeStyle = 'rgba(0, 255, 150, 0.2)';
      ctx.strokeRect(ML, wfTop + 5, plotW, wfH);

      // ── Y-axis label (Waterfall) ──
      ctx.save();
      ctx.translate(9, wfTop + 5 + wfH / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = 'rgba(0, 255, 150, 0.7)';
      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('fd (kHz)', 0, 0);
      ctx.restore();

      if (history.length > 2) {
        const xStep = plotW / history.length;

        history.forEach((pt, i) => {
          if (!pt.hit) return;
          const x = ML + i * xStep;
          const yCenter = wfTop + 5 + wfH / 2;
          const yTrue = yCenter - (pt.fd / maxFd) * (wfH / 2);

          const grad = ctx.createLinearGradient(x, yTrue - 10, x, yTrue + 10);
          grad.addColorStop(0, 'rgba(0,0,0,0)');
          grad.addColorStop(0.5, `rgba(0, 255, 255, ${pt.power * 0.8})`);
          grad.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = grad;
          ctx.fillRect(x, yCenter - (wfH/2), xStep + 1, wfH);
        });
      }

      // ── X-axis label (Waterfall) ──
      ctx.fillStyle = 'rgba(0, 255, 150, 0.7)';
      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Time', ML + plotW / 2, wfTop + 5 + wfH + 12);
      ctx.textAlign = 'left';

      // 3. Stats Bar
      const statsY = H - 30;
      ctx.fillStyle = 'rgba(0,20,10,0.8)'; ctx.fillRect(0, statsY, secW, 30);

      if (beamHit) {
        ctx.fillStyle = '#00ff9f'; ctx.font = '9px monospace';

        let displayTheta = Math.abs(lastPt.theta) % 180;
        if (displayTheta > 90) displayTheta = 180 - displayTheta;

        const angleInfo = `Angle (θ): ${displayTheta.toFixed(1)}°`;
        const fdInfo = `fd: ${lastPt.fd.toFixed(0)} Hz`;

        ctx.fillText(`${fdInfo} | ${angleInfo}`, 10, statsY + 18);
      } else {
        ctx.fillStyle = '#ff4444'; ctx.fillText('BEAM MISS - ADJUST PROBE', 10, statsY + 18);
      }
    }
  _drawTooltip(ctx, mainW, H) {
    const ell=this.hoveredEllipse;
    if (!ell) return;
    const pos=this._normToCanvas(ell.cx,ell.cy);
    const props=TISSUE_PROPS[ell.name]||{};
    const lines=[ell.name,`Density: ${ell.density} g/cm³`,`Atten: ${ell.attenuation} dB/cm`,
                 `Impedance: ${(props.impedance||1.6).toFixed(2)} MRayl`,`Speed: ${props.c||1540} m/s`,
                 `Intensity: ${ell.intensity.toFixed(2)}`,'[Click to edit]'];
    const tw=160,th=lines.length*14+10;
    let tx=pos.x+14,ty=pos.y-th/2;
    if (tx+tw>mainW-5) tx=pos.x-tw-14;
    ty=MathUtils.clamp(ty,5,H-th-5);
    ctx.fillStyle='rgba(0,10,25,0.92)'; ctx.strokeStyle='rgba(0,200,255,0.4)'; ctx.lineWidth=1;
    ctx.fillRect(tx,ty,tw,th); ctx.strokeRect(tx,ty,tw,th);
    lines.forEach((l,i)=>{
      ctx.fillStyle=i===0?'#00eeff':(i===lines.length-1?'rgba(255,220,0,0.6)':'#99ccee');
      ctx.font=i===0?'bold 10px monospace':'9px monospace';
      ctx.fillText(l,tx+6,ty+14+i*14);
    });
  }

  _drawStats(ctx) {
    const {steerAngle,apodization}=this.params;
    const snr = this._probe.snr;   // authoritative SNR lives on the probe
    const wl   =MathUtils.wavelength(this._probe.frequency,SPEED_OF_SOUND);
    const sPx  =this._probe.spacing*PHYS_SPACING_MM*SCALE_PX_PER_MM;
    const bw3dB=(MathUtils.beamwidth3dB(this._probe.numElements,sPx,wl*SCALE_PX_PER_MM*1000)*180/Math.PI).toFixed(1);
    const stats=[
      `f = ${(this._probe.frequency/1e6).toFixed(1)} MHz`,
      `N = ${this._probe.numElements}`,
      `θ = ${steerAngle}°`,
      `BW = ${bw3dB}°`,
      `λ = ${(wl*1000).toFixed(2)} mm`,
      `Win: ${apodization==='none'?'Rect':apodization}`,
      `SNR: ${snr}`
    ];
    ctx.fillStyle='rgba(0,8,22,0.78)'; ctx.fillRect(6,6,155,stats.length*15+8);
    ctx.strokeStyle='rgba(0,180,255,0.2)'; ctx.lineWidth=0.5; ctx.strokeRect(6,6,155,stats.length*15+8);
    stats.forEach((s,i)=>{
      ctx.fillStyle=i===6?(snr<15?'#ff8844':'#66ccff'):'#66ccff';
      ctx.font='10px monospace'; ctx.fillText(s,12,18+i*15);
    });
  }

  _drawModeLabel(ctx, mainW) {
    const labels={beamform:'BEAMFORM',amode:'A-MODE',bmode:'B-MODE',doppler:'DOPPLER', interf:'INTERFERENCE'};
    const colors={beamform:'#00d4ff', amode:'#00d4ff',bmode:'#aaffee',doppler:'#00ff9f', interf:'#ffaa00'};
    ctx.fillStyle=colors[this.scanMode]||'#00d4ff';
    ctx.font='bold 11px monospace'; ctx.textAlign='right';
    ctx.fillText('● '+(labels[this.scanMode]||''),mainW-8,18);
    ctx.textAlign='left';
  }

  // ── Interactions ─────────────────────────────────────────────
  _bindInput() {
    let dragging     = false;
    let mouseDownPos = null;

    // Store named references so _onStop() can removeEventListener properly
    this._us_onMouseDown = (e) => {
      dragging     = false;
      mouseDownPos = this._canvasXY(e);
      // Check if click is near the probe body → start probe drag
      const {x, y} = mouseDownPos;
      const pos = this._probePos();
      const distToProbe = Math.sqrt((x-pos.x)**2 + (y-pos.y)**2);
      this._probeDragging = distToProbe < 28; // 28px hit radius around probe
    };

    this._us_onMouseUp = (e) => {
      if (!this._active) return;   // mode-guard: ignore if simulator stopped
      const {x,y} = this._canvasXY(e);
      const {mainW} = this._layout_dims();
      if (!dragging && mouseDownPos && x < mainW) {
        const dx = x - mouseDownPos.x, dy = y - mouseDownPos.y;
        if (Math.sqrt(dx*dx + dy*dy) < 5) {
          const norm = this._canvasToNorm(x, y);
          const hit  = this._hitEllipse(norm.x, norm.y);
          if (hit) this._openEditor(hit);
        }
      }
      dragging = false; mouseDownPos = null; this._probeDragging = false;
    };

    this._us_onMouseLeave = () => {
      this.hoveredEllipse  = null;
      dragging             = false;
      mouseDownPos         = null;
      this._probeDragging  = false;
    };

  this._us_onMouseMove = (e) => {
        if (!this._active) return;   // mode-guard
        const {x,y}   = this._canvasXY(e);
        const {mainW} = this._layout_dims();
        if (mouseDownPos && x < mainW) {
          const dx = x - mouseDownPos.x, dy = y - mouseDownPos.y;
          if (Math.sqrt(dx*dx + dy*dy) > 4) dragging = true;
        }
        if (dragging && mouseDownPos && x < mainW) {
          if (this._probeDragging) {
            // ── Orbit the probe around the phantom ──────────────
            const c = this._phantomCenter();
            this._probeOrbitAngle = Math.atan2(y - c.y, x - c.x);
            this._rebuildArray();
            this._computeAMode();
          } else {
            // ── Beam steering (original behaviour) ──────────────
            const pos     = this._probePos();
            const phantomC = this._phantomCenter();
            const inward  = Math.atan2(phantomC.y - pos.y, phantomC.x - pos.x);
            const toMouse = Math.atan2(y - pos.y, x - pos.x);
            const relAngle = toMouse - inward;
            const steer   = MathUtils.clamp(Math.round(relAngle * 180 / Math.PI), -60, 60);
            const dist    = Math.sqrt((x-pos.x)**2 + (y-pos.y)**2);
            const depthMm = MathUtils.clamp(Math.round(dist / SCALE_PX_PER_MM), 20, 200);
            this.params.steerAngle  = steer;
            this._probe.steerAngle  = steer;
            this._probe.focalDepth  = depthMm;
            this._rebuildArray();
            this._computeAMode();
            Bus.emit('params:changed', { mode:'ultrasound', params:this.params });
          }
        }
        const norm2 = this._canvasToNorm(x, y);
        this.hoveredEllipse = x < mainW ? this._hitEllipse(norm2.x, norm2.y) : null;
      };
    this.canvas.addEventListener('mousedown',  this._us_onMouseDown);
    this.canvas.addEventListener('mouseup',    this._us_onMouseUp);
    this.canvas.addEventListener('mouseleave', this._us_onMouseLeave);
    this.canvas.addEventListener('mousemove',  this._us_onMouseMove);

    this._active = true;   // mode-guard flag
  }

  _unbindInput() {
    this._active = false;
    if (this._us_onMouseDown)  { this.canvas.removeEventListener('mousedown',  this._us_onMouseDown);  this._us_onMouseDown  = null; }
    if (this._us_onMouseUp)    { this.canvas.removeEventListener('mouseup',    this._us_onMouseUp);    this._us_onMouseUp    = null; }
    if (this._us_onMouseLeave) { this.canvas.removeEventListener('mouseleave', this._us_onMouseLeave); this._us_onMouseLeave = null; }
    if (this._us_onMouseMove)  { this.canvas.removeEventListener('mousemove',  this._us_onMouseMove);  this._us_onMouseMove  = null; }
  }

  _canvasXY(e){
    const r=this.canvas.getBoundingClientRect();
    return {x:e.clientX-r.left,y:e.clientY-r.top};
  }

  _hitEllipse(nx,ny){
    for (let i=this.phantomEllipses.length-1;i>=0;i--){
      const ell=this.phantomEllipses[i];
      const cosA=Math.cos(ell.angle*Math.PI/180),sinA=Math.sin(ell.angle*Math.PI/180);
      const dx=nx-ell.cx,dy=ny-ell.cy;
      const lx=dx*cosA+dy*sinA,ly=-dx*sinA+dy*cosA;
      if ((lx/ell.a)**2+(ly/ell.b)**2<=1) return ell;
    }
    return null;
  }

  _openEditor(ell){
    if (!this._active) return;            // mode-guard: don't open if sim stopped
    if (this.editingEllipse===ell) return;
    this.editingEllipse=ell;
    document.getElementById('us-ell-editor')?.remove();
    const editor=document.createElement('div');
    editor.id='us-ell-editor';
    editor.style.cssText='position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#070d1e;border:1px solid rgba(0,200,255,0.35);border-radius:10px;padding:16px;z-index:999;min-width:260px;font-family:"JetBrains Mono",monospace;color:#e2e8f0;box-shadow:0 4px 30px rgba(0,0,0,0.6)';
    const props=TISSUE_PROPS[ell.name]||{impedance:1.6,c:1540};
    editor.innerHTML=`
      <div style="font-weight:700;font-size:12px;color:#00eeff;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid rgba(0,200,255,0.15)">✏️ Edit: ${ell.name}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:11px;">
        ${this._edRow('ell-intensity','Intensity','0','2','0.05',Math.abs(ell.intensity).toFixed(2),'#00d4ff')}        ${this._edRow('ell-atten','Attenuation (dB/cm)','0','2','0.05',ell.attenuation.toFixed(2),'#00d4ff')}
        ${this._edRow('ell-density','Density (g/cm³)','0.5','3','0.05',ell.density.toFixed(2),'#00d4ff')}
        ${this._edRow('ell-imp','Impedance (MRayl)','1','9','0.1',props.impedance.toFixed(1),'#00d4ff')}
        ${ell.isVessel?`
        <div style="grid-column:span 2">${this._edRow('ell-vel','Blood Velocity (m/s)','0','2','0.05',this.params.bloodVelocity.toFixed(2),'#ff4466')}</div>
        <div style="grid-column:span 2">${this._edRow('ell-vangle','Vessel Angle (°)','0','90','1',this.params.vesselAngle,'#ff4466')}</div>`:''}
      </div>
      <div style="margin-top:12px;display:flex;gap:8px">
        <button id="ell-close"  style="flex:1;background:rgba(0,200,255,0.1);border:1px solid rgba(0,200,255,0.3);color:#00d4ff;border-radius:5px;padding:6px;cursor:pointer;font-family:inherit;font-size:11px">✓ Apply</button>
        <button id="ell-cancel" style="flex:1;background:rgba(255,80,80,0.08);border:1px solid rgba(255,80,80,0.2);color:#ff6666;border-radius:5px;padding:6px;cursor:pointer;font-family:inherit;font-size:11px">✕ Cancel</button>
      </div>`;
    document.body.appendChild(editor);
    const bind=(id,cb)=>{
      const el=document.getElementById(id),vEl=document.getElementById(id+'-val');
      if (!el) return;
      el.addEventListener('input',()=>{const v=parseFloat(el.value);if(vEl)vEl.textContent=v.toFixed(2);cb(v);this._computeAMode();});
    };
    bind('ell-intensity',v=>{ell.intensity=v;});
    bind('ell-atten',    v=>{ell.attenuation=v;});
    bind('ell-density',  v=>{ell.density=v;});
    bind('ell-imp',      v=>{if(!TISSUE_PROPS[ell.name])TISSUE_PROPS[ell.name]={};TISSUE_PROPS[ell.name].impedance=v;});
    if (ell.isVessel){
          bind('ell-vel',   v=>{this.params.bloodVelocity=v;});
          bind('ell-vangle',v=>{
              this.params.vesselAngle = v; // تحديث قيمة الباراميتر
              ell.angle = v;               // 💡 تحديث زاوية الوعاء الفعلية في الـ Phantom
              this._rebuildArray();        // إعادة بناء المصفوفة للتأكد من المزامنة
          });
        }
    document.getElementById('ell-close').addEventListener('click', ()=>{editor.remove();this.editingEllipse=null;});
    document.getElementById('ell-cancel').addEventListener('click',()=>{editor.remove();this.editingEllipse=null;});
  }

  _edRow(id,label,min,max,step,val,color){
    return `<div><label style="color:#666;font-size:9px;text-transform:uppercase;display:block;margin-bottom:3px">${label}</label>
    <input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${val}" style="width:100%;accent-color:${color}">
    <span id="${id}-val" style="color:${color}">${val}</span></div>`;
  }

  _onStop(){
    this._unbindInput();          // remove all canvas event listeners
    this._waves         = [];
    this.hoveredEllipse = null;
    this.editingEllipse = null;
    document.getElementById('us-ell-editor')?.remove();
  }

  _buildState(){
    return {
      params:{...this.params,numElements:this._probe.numElements,frequency:this._probe.frequency,spacing:this._probe.spacing},
      scanMode:this.scanMode
    };
  }
}

// ── Class alias
const UltrasoundMode = UltrasoundSimulator;