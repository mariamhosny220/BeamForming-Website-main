// ============================================================
// RADAR SIMULATOR — extends BaseSimulator
// Polymorphism: overrides compute() + _renderScene()
// Uses RadarTarget entities from entity layer
// Private state via # fields
//
// CHANGES vs original:
//   • Added TargetDragManager (Abstraction/Encapsulation) —
//     handles mousedown / mousemove / mouseup for drag-to-move.
//   • _bindInput() split into _bindClickInput() + _bindDragInput()
//     to keep each responsibility small (Single Responsibility).
//   • Delete key removes selected target.
//   • Cursor changes to 'grab'/'grabbing'/'crosshair' based on state.
//   • Hit-test radius unified (uses target visual size, same as click).
//   • Right-click hit radius now also uses size-aware formula (no more
//     hardcoded 15 px mismatch).
//   • No logic duplicated — all shared math still goes through MathUtils.
// ============================================================

// ─── TARGET DRAG MANAGER ─────────────────────────────────────
/**
 * Encapsulates all drag-to-move logic for RadarTarget objects.
 * Abstraction: RadarSimulator calls only start/update/end —
 *              never touches raw mouse coordinates directly.
 */
class TargetDragManager {
  // Private fields — full Encapsulation
  #target = null;   // RadarTarget being dragged
  #offsetX = 0;
  #offsetY = 0;
  #isDragging = false;

  /** Begin a drag. Returns true if a target was hit. */
  start(targets, canvasX, canvasY, hitRadius) {
    const hit = TargetDragManager._findTarget(targets, canvasX, canvasY, hitRadius);
    if (!hit) { this.#isDragging = false; return false; }
    this.#target = hit;
    this.#offsetX = canvasX - hit.x;
    this.#offsetY = canvasY - hit.y;
    this.#isDragging = true;
    return true;
  }

  /** Move the dragged target to follow the pointer. */
  update(canvasX, canvasY, bounds) {
    if (!this.#isDragging || !this.#target) return;
    this.#target.setPosition(
      MathUtils.clamp(canvasX - this.#offsetX, bounds.minX, bounds.maxX),
      MathUtils.clamp(canvasY - this.#offsetY, bounds.minY, bounds.maxY)
    );
  }

  /** End a drag. Returns the target that was dragged (or null). */
  end() {
    const t = this.#target;
    this.#isDragging = false;
    this.#target = null;
    return t;
  }

  get isDragging() { return this.#isDragging; }
  get draggedTarget() { return this.#target; }

  /** Static helper — finds the first target within hitRadius of (x,y). */
  static _findTarget(targets, x, y, hitRadius) {
    return targets.find(t => MathUtils.distance(t, { x, y }) < hitRadius(t)) || null;
  }
}

// ─── RADAR SIMULATOR ─────────────────────────────────────────
class RadarSimulator extends BaseSimulator {
  // Private fields
  #engine = null;
  #echoSweep = [];
  #detections = [];
  #scanAngle = -Math.PI / 2;
  #selectedTarget = null;
  #dragManager = new TargetDragManager();   // Composition

  constructor(canvas, uiCallbacks) {
    super(canvas, uiCallbacks);

    this.params = {
      numElements: 24,
      spacing: 0.5,
      frequency: 9e9,
      scanSpeed: 0.5,
      scanRange: 280,
      beamWidthDeg: 5,
      snr: 100,
      windowType: 'hamming',
      showSidelobes: true,
      showComparison: false,
      trackingMode: false
    };

    this.#engine = new BeamformingEngine(new Params({
      numElements: this.params.numElements,
      frequency: this.params.frequency,
      snr: this.params.snr,
      windowType: this.params.windowType
    }));

    this.targets = [];   // RadarTarget[]

    this._loadDefaultScenario();
    this._bindClickInput();
    this._bindDragInput();
    this._bindKeyInput();
  }

  get selectedTarget() { return this.#selectedTarget; }

  // ── Params override — keep engine in sync ───────────────────
  setParams(p) {
    super.setParams(p);
    if (p.numElements !== undefined) this.#engine.params.setNumElements(p.numElements);
    if (p.frequency !== undefined) this.#engine.params.setFrequency(p.frequency);
    if (p.snr !== undefined) this.#engine.params.setSNR(p.snr);
    if (p.windowType !== undefined) this.#engine.params.setWindow(p.windowType);
  }

  // ── Entity management ────────────────────────────────────────

  addTarget(opts = {}) {
    if (this.targets.length >= 5) { this._toast('Max 5 targets'); return null; }
    const t = new RadarTarget(opts);
    this.targets.push(t);
    return t;
  }

  removeTarget(target) {
    this.targets = this.targets.filter(t => t !== target);
    if (this.#selectedTarget === target) this._selectTarget(null);
  }

  clearTargets() {
    this.targets = [];
    this._selectTarget(null);
  }


  // ── Core computation (polymorphic override) ──────────────────

  compute() {
    const dt = 16;
    this._updateScan(dt);
    this._checkDetections();
  }

  _updateScan(dt) {
    const { scanSpeed, trackingMode } = this.params;
    const center = this._center();

    if (trackingMode && this.targets.length > 0) {
      // Track the selected target by the user. If none is selected, fallback to the nearest one.
      let targetToTrack = this.#selectedTarget;
      if (!targetToTrack) {
        targetToTrack = this.targets.reduce((best, t) =>
          MathUtils.distance(center, t) < MathUtils.distance(center, best) ? t : best
        );
      }

      const targetA = MathUtils.angleTo(center, targetToTrack);
      const diff = ((targetA - this.#scanAngle + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
      this.#scanAngle += diff * 0.06;
    } else {
      this.#scanAngle += scanSpeed * dt * 0.001;
    }
    this.#scanAngle = MathUtils.normalizeAngle(this.#scanAngle);
  }

  _checkDetections() {
    const center = this._center();
    const { scanRange, beamWidthDeg, snr, windowType } = this.params;

    // --- APODIZATION (WINDOWING) PHYSICS ---
    // Trade-off: Lower sidelobes comes at the cost of a wider main beam.
    const effectiveBwDeg = (beamWidthDeg || 5) * this._bwFactor(windowType);
    const bwRad   = effectiveBwDeg * Math.PI / 180;
    const safeSnr = (snr !== undefined && !isNaN(snr)) ? snr : 200;

    // Normalise slider range (0–1000) → (0–100) so all physics scales proportionally.
    // slider=1000 → snrN=100 (perfect), slider=400 → snrN=40 (noisy threshold), slider=0 → snrN=0
    const snrN = this._snrN(safeSnr);

    // Exponential detection probability: snrN=100→1.0, snrN=50→~0.5, snrN=20→~0.12, snrN=0→0
    const detProb = MathUtils.clamp((snrN / 100) ** 1.8, 0.0, 1.0);

    // False alarms rise sharply below snrN=40 (i.e. slider < 400)
    const falseProbPerSweepLine = snrN < 40 ? ((40 - snrN) / 40) * 0.04 : 0;

    for (const target of this.targets) {
      const R_dist = MathUtils.distance(center, target);
      if (R_dist > scanRange) continue;

      let targetAngle = Math.atan2(target.y - center.y, target.x - center.x);
      let diff = Math.abs(MathUtils.angleDiff(this.#scanAngle, targetAngle));

      if (diff < bwRad / 2) {
        if (Math.random() < detProb) {
          target.detected     = true;
          target.lastDetected = this.time;

          // --- PHYSICS-BASED SIZE ESTIMATION ---
          // 1. Clutter Volume (Spatial Resolution)
          const clutterDensity = 0.05;
          const illuminatedArc = R_dist * bwRad; // Wider effective beam = more clutter
          const clutterBias    = clutterDensity * illuminatedArc;

          // 2. Receiver Thermal Noise (SNR)
          const snrFactor      = Math.max(1, snrN);
          const noiseAmplitude = 40 / snrFactor;
          const thermalNoise   = (Math.random() * 2 - 1) * noiseAmplitude;

          let estimatedRcs = target.rcs + clutterBias + thermalNoise;
          target.lastEstimatedRcs  = Math.max(0.1, estimatedRcs);
          target.lastDetectionBw   = effectiveBwDeg;

          // 3. Position jitter — low SNR = uncertain where exactly the target is.
          // snrN=100→jitter≈0px,  snrN=40→jitter≈15px,  snrN=0→jitter≈40px
          const jitter = (1 - snrN / 100) * 40;
          const jx = target.x + (Math.random() * 2 - 1) * jitter;
          const jy = target.y + (Math.random() * 2 - 1) * jitter;

          this.#echoSweep.push({ x: jx, y: jy, born: this.time, rcs: target.lastEstimatedRcs });
          this.#detections.push({ x: jx, y: jy, born: this.time, radius: 0 });
        } else {
          target.detected = false;  // missed detection
        }
      } else {
        target.detected = false;
      }
    }

    // Inject false alarm echoes (clutter) at low SNR
    // بيرسم الكور الحمرا لما يكون SNR أصغر من 40 — مش شرط SNR المنخفض يحدد رادار مظبوط
    if (falseProbPerSweepLine > 0 && Math.random() < falseProbPerSweepLine) {
      const r     = Math.random() * (scanRange - 20) + 10;
      const angle = this.#scanAngle + (Math.random() - 0.5) * bwRad;
      const fx    = center.x + r * Math.cos(angle);
      const fy    = center.y + r * Math.sin(angle);
      this.#echoSweep.push({ x: fx, y: fy, born: this.time, rcs: 2, isNoise: true });
      this.#detections.push({ x: fx, y: fy, born: this.time, radius: 0, isNoise: true });
    }

    this.#echoSweep  = this.#echoSweep.filter(e => this.time - e.born < 180);
    this.#detections = this.#detections.filter(d => d.radius < 30);
  }

  _center() { return { x: this.renderer.width / 2, y: this.renderer.height / 2 }; }

  /** Single source of truth for windowing beam-broadening factor. */
  _bwFactor(windowType) {
    return { none: 1.0, hanning: 1.5, hamming: 1.3, blackman: 1.7, kaiser: 1.4 }[windowType ?? 'none'] ?? 1.0;
  }

  /** Normalise raw SNR slider (0-1000) → physics scale (0-100). */
  _snrN(snr) {
    return MathUtils.clamp((snr ?? 200) / 10, 0, 100);
  }

  /** True if target was detected within the last 60 frames. */
  _isRecentDetection(t) {
    return !!(t.lastDetected && (this.time - t.lastDetected) < 60);
  }

  /** Compute all four SNR physics values for a normalised snrN (0-100). */
  _snrPhysics(n) {
    return {
      detProb:   MathUtils.clamp((n / 100) ** 1.8, 0, 1),
      falseRate: n < 40 ? ((40 - n) / 40) * 0.04 : 0,
      jitter:    (1 - n / 100) * 40,
      sizeErr:   n > 0 ? MathUtils.clamp(40 / n, 0, 100) : 100
    };
  }

  // ── Rendering (polymorphic override) ─────────────────────────

  _renderScene() {
    this._drawBackground();
    this._drawScope();
    this._drawSweep();
    this._drawEchoTrails();
    this._drawDetections();
    this._drawTargets();
    this.renderer.ctx.restore();   // close scope clip
    this._drawPhaseArray();
    if (this.params.showComparison) this._drawComparison();
    this._drawStats();
  }

  _drawBackground() {
    const { ctx, width: W, height: H } = this.renderer;
    ctx.fillStyle = '#030a08';
    ctx.fillRect(0, 0, W, H);
  }

  _drawScope() {
    const { ctx } = this.renderer;
    const c = this._center();
    const R = this.params.scanRange;

    const bg = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, R);
    bg.addColorStop(0, 'rgba(0,40,20,0.4)');
    bg.addColorStop(1, 'rgba(0,20,10,0.1)');
    ctx.beginPath(); ctx.arc(c.x, c.y, R, 0, Math.PI * 2);
    ctx.fillStyle = bg; ctx.fill();
    ctx.strokeStyle = 'rgba(0,200,100,0.5)'; ctx.lineWidth = 1.5; ctx.stroke();

    for (let r = R / 4; r <= R; r += R / 4) {
      ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,150,80,0.2)'; ctx.lineWidth = 0.8; ctx.stroke();
      ctx.fillStyle = 'rgba(0,200,100,0.4)'; ctx.font = '9px monospace'; ctx.textAlign = 'left';
      ctx.fillText(`${Math.round(r / R * 100)}%`, c.x + r + 3, c.y - 3);
    }

    for (let deg = 0; deg < 360; deg += 30) {
      const rad = (deg - 90) * Math.PI / 180;
      ctx.beginPath(); ctx.moveTo(c.x, c.y);
      ctx.lineTo(c.x + R * Math.cos(rad), c.y + R * Math.sin(rad));
      ctx.strokeStyle = 'rgba(0,150,80,0.15)'; ctx.lineWidth = 0.5; ctx.stroke();
      ctx.fillStyle = 'rgba(0,200,100,0.4)'; ctx.font = '9px monospace'; ctx.textAlign = 'center';
      ctx.fillText(`${deg}°`, c.x + (R + 14) * Math.cos(rad), c.y + (R + 14) * Math.sin(rad));
    }

    ctx.strokeStyle = 'rgba(0,200,100,0.4)'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(c.x - 8, c.y); ctx.lineTo(c.x + 8, c.y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(c.x, c.y - 8); ctx.lineTo(c.x, c.y + 8); ctx.stroke();

    ctx.save();
    ctx.beginPath(); ctx.arc(c.x, c.y, R, 0, Math.PI * 2); ctx.clip();
  }

  _drawSweep() {
    const { ctx } = this.renderer;
    const c = this._center();
    const R = this.params.scanRange;
    const { beamWidthDeg, numElements } = this.params;
    const bwRad = beamWidthDeg * Math.PI / 180;

    // Phosphor persistence trail
    for (let i = 0; i < 60; i++) {
      const angle = this.#scanAngle - (i * Math.PI / 180);
      const alpha = (1 - i / 60) * 0.15;
      const endX = c.x + R * Math.cos(angle);
      const endY = c.y + R * Math.sin(angle);
      const grad = ctx.createLinearGradient(c.x, c.y, endX, endY);
      grad.addColorStop(0, `rgba(0,255,120,${alpha})`);
      grad.addColorStop(1, 'rgba(0,255,120,0)');
      ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(endX, endY);
      ctx.strokeStyle = grad; ctx.lineWidth = 1.5; ctx.stroke();
    }

    // Apodization-weighted beam cone
    const weights = this.#engine.applyWindow(numElements);
    for (let i = 0; i < numElements; i++) {
      const elemAngle = this.#scanAngle + (i - numElements / 2) * bwRad / numElements;
      const alpha = weights[i] * 0.35;
      const endX = c.x + R * Math.cos(elemAngle);
      const endY = c.y + R * Math.sin(elemAngle);
      ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(endX, endY);
      ctx.strokeStyle = `rgba(0,255,150,${alpha})`; ctx.lineWidth = 2; ctx.stroke();
    }

    // Bright main beam
    const beamX = c.x + R * Math.cos(this.#scanAngle);
    const beamY = c.y + R * Math.sin(this.#scanAngle);
    const grad2 = ctx.createLinearGradient(c.x, c.y, beamX, beamY);
    grad2.addColorStop(0, 'rgba(0,255,150,0.9)');
    grad2.addColorStop(1, 'rgba(0,255,150,0)');
    ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(beamX, beamY);
    ctx.strokeStyle = grad2; ctx.lineWidth = 2; ctx.stroke();

    // Sidelobe overlay
    if (this.params.showSidelobes) {
      const pattern = this.#engine.computeBeamPattern(SPEED_OF_LIGHT, 180);
      ctx.save(); ctx.globalAlpha = 0.15;
      pattern.forEach(p => {
        if (p.magnitude < 0.05) return;
        const ang = this.#scanAngle + p.angle;
        const dist = p.magnitude * R * 0.3;
        ctx.beginPath(); ctx.moveTo(c.x, c.y);
        ctx.lineTo(c.x + dist * Math.cos(ang), c.y + dist * Math.sin(ang));
        ctx.strokeStyle = '#00ff88'; ctx.lineWidth = 0.5; ctx.stroke();
      });
      ctx.restore();
    }
  }

  _drawEchoTrails() {
    const { ctx } = this.renderer;
    this.#echoSweep.forEach(e => {
      const age = this.time - e.born;
      const alpha = Math.max(0, 0.8 * (1 - age / 180));
      const size = Math.sqrt(e.rcs) * 2;
      ctx.save(); ctx.globalAlpha = alpha;
      ctx.beginPath(); ctx.arc(e.x, e.y, size, 0, Math.PI * 2);
      ctx.fillStyle = '#00ff88'; ctx.fill();
      ctx.restore();
    });
  }

  _drawDetections() {
    const { ctx } = this.renderer;
    this.#detections.forEach(d => {
      d.radius += 0.8;
      const alpha = Math.max(0, 0.9 * (1 - d.radius / 30));
      ctx.save(); ctx.globalAlpha = alpha;
      ctx.beginPath(); ctx.arc(d.x, d.y, d.radius, 0, Math.PI * 2);
      // False alarms (noise/clutter) shown in red; real detections in yellow
      ctx.strokeStyle = d.isNoise ? '#ff4444' : '#ffff00';
      ctx.lineWidth = 2; ctx.stroke();
      ctx.restore();
    });
  }

  _drawTargets() {
    const { ctx } = this.renderer;
    this.targets.forEach(target => {
      const recent = this._isRecentDetection(target);
      const selected = target === this.#selectedTarget;
      const dragging = this.#dragManager.isDragging && this.#dragManager.draggedTarget === target;
      const s = Math.max(5, Math.sqrt(target.rcs) * 1.8);

      ctx.save();
      ctx.translate(target.x, target.y);
      ctx.rotate(target.heading);

      // Selection ring
      if (selected || dragging) {
        ctx.beginPath();
        ctx.arc(0, 0, s + 10, 0, Math.PI * 2);
        ctx.strokeStyle = dragging ? '#00ffff' : '#ffffff';
        ctx.lineWidth = dragging ? 2 : 1.2;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Drag hint ring — subtle, always visible so user knows it's draggable
      if (!dragging && !selected) {
        ctx.beginPath();
        ctx.arc(0, 0, s + 6, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,200,100,0.15)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Glow when recently detected
      if (recent) {
        ctx.beginPath();
        ctx.arc(0, 0, s + 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,255,100,0.12)';
        ctx.fill();
      }

      // Aircraft silhouette
      const col = dragging ? '#00ffff' : (recent ? (selected ? '#ffffff' : '#ffff66') : '#446655');
      const colS = dragging ? '#00cccc' : (recent ? (selected ? '#ffffff' : '#ffee00') : '#334444');

      // Fuselage
      ctx.beginPath();
      ctx.ellipse(0, 0, s * 0.35, s, 0, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.strokeStyle = colS;
      ctx.lineWidth = 0.8;
      ctx.fill(); ctx.stroke();

      // Wings
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.1);
      ctx.lineTo(-s * 1.1, s * 0.35);
      ctx.lineTo(-s * 0.9, s * 0.55);
      ctx.lineTo(0, s * 0.25);
      ctx.lineTo(s * 0.9, s * 0.55);
      ctx.lineTo(s * 1.1, s * 0.35);
      ctx.closePath();
      ctx.fillStyle = col + 'cc';
      ctx.fill(); ctx.stroke();

      // Tail
      ctx.beginPath();
      ctx.moveTo(0, s * 0.7);
      ctx.lineTo(-s * 0.5, s * 1.0);
      ctx.lineTo(s * 0.5, s * 1.0);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill(); ctx.stroke();

      ctx.restore();

      // Velocity vector arrow (world-space, not rotated)
      if (!dragging) {
        ctx.save();
        const vx = Math.cos(target.heading) * 22 * (target.speed / 2);
        const vy = Math.sin(target.heading) * 22 * (target.speed / 2);
        ctx.beginPath();
        ctx.moveTo(target.x, target.y);
        ctx.lineTo(target.x + vx, target.y + vy);
        ctx.strokeStyle = recent ? 'rgba(255,255,80,0.6)' : 'rgba(80,120,80,0.3)';
        ctx.lineWidth = 1.2;
        ctx.stroke();
        if (recent) {
          const ah = 6;
          const an = Math.atan2(vy, vx);
          ctx.beginPath();
          ctx.moveTo(target.x + vx, target.y + vy);
          ctx.lineTo(target.x + vx - ah * Math.cos(an - 0.4), target.y + vy - ah * Math.sin(an - 0.4));
          ctx.lineTo(target.x + vx - ah * Math.cos(an + 0.4), target.y + vy - ah * Math.sin(an + 0.4));
          ctx.closePath();
          ctx.fillStyle = 'rgba(255,255,80,0.7)';
          ctx.fill();
        }
        ctx.restore();
      }

      // Label
      if (recent || selected || dragging) {
        ctx.save();
        ctx.font = '9px monospace';
        ctx.textAlign = 'center';

        let displayRcs = target.rcs.toFixed(0);
        let accuracyText = '';
        ctx.fillStyle = dragging ? '#00ffff' : (selected ? '#ffffff' : '#ffff55');

        if (recent && target.lastEstimatedRcs) {
          displayRcs = target.lastEstimatedRcs.toFixed(1);
          if (target.lastDetectionBw > 8) {
            accuracyText = ' (Rough)';
            ctx.fillStyle = '#ff8844'; // Orange for low accuracy
          } else if (target.lastDetectionBw < 4) {
            accuracyText = ' (Accurate)';
            ctx.fillStyle = '#44ff88'; // Green for high accuracy
          } else {
            accuracyText = ' (Avg)';
          }
        }

        ctx.fillText(`Est. Size: ${displayRcs}m²${accuracyText}`, target.x, target.y - s - 8);
        if (selected && !dragging) {
          ctx.fillStyle = '#aaddff';
          ctx.fillText('drag to move · slider to resize · Del to remove', target.x, target.y - s - 20);
        }
        if (dragging) {
          ctx.fillStyle = '#00ffff';
          ctx.fillText('dragging…', target.x, target.y - s - 20);
        }
        ctx.restore();
      }
    });
  }

  _drawPhaseArray() {
    const { ctx, height: H } = this.renderer;
    const { numElements } = this.params;
    const arrY = H / 2;
    const elSp = 6;
    const totalH = numElements * elSp;
    const weights = this.#engine.applyWindow(numElements);

    for (let i = 0; i < numElements; i++) {
      const py = arrY - totalH / 2 + i * elSp;
      const phase = (i / numElements) * Math.sin(this.#scanAngle) * 2 * Math.PI;
      const hue = ((phase * 180 / Math.PI) % 360 + 360) % 360;
      const w = weights[i];
      ctx.fillStyle = `hsl(${hue},100%,${40 + w * 30}%)`;
      ctx.fillRect(10, py - 2, 8, 4);
      const arrowLen = 6 + Math.abs(Math.sin(phase)) * 8 * w;
      ctx.strokeStyle = `hsla(${hue},100%,70%,0.6)`;
      ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(18, py); ctx.lineTo(18 + arrowLen, py); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(0,200,100,0.5)'; ctx.font = '9px monospace';
    ctx.fillText(`${numElements}E`, 10, arrY + totalH / 2 + 14);
    ctx.fillText('PHASED', 10, arrY + totalH / 2 + 24);
  }

  _drawComparison() {
    const { ctx, width: W, height: H } = this.renderer;
    const px = W - 160, py = H - 200, pw = 150, ph = 190;
    ctx.fillStyle = 'rgba(0,8,4,0.92)'; ctx.strokeStyle = 'rgba(0,200,80,0.3)';
    ctx.lineWidth = 1; ctx.fillRect(px, py, pw, ph); ctx.strokeRect(px, py, pw, ph);
    ctx.fillStyle = '#00cc66'; ctx.font = 'bold 10px monospace';
    ctx.fillText('CLASSIC vs BEAMFORMING', px + 6, py + 14);

    const draw_mini_scope = (cx, cy, r, label1, label2, isBF) => {
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,150,60,0.3)'; ctx.lineWidth = 0.8; ctx.stroke();
      if (isBF) {
        const bfw = 0.05;
        ctx.beginPath(); ctx.moveTo(cx, cy);
        ctx.lineTo(cx + r * Math.cos(this.#scanAngle - bfw), cy + r * Math.sin(this.#scanAngle - bfw));
        ctx.lineTo(cx + r * Math.cos(this.#scanAngle + bfw), cy + r * Math.sin(this.#scanAngle + bfw));
        ctx.closePath(); ctx.fillStyle = 'rgba(0,255,120,0.5)'; ctx.fill();
        for (let i = 0; i < 6; i++) { ctx.fillStyle = '#00aa55'; ctx.fillRect(cx - 14 + i * 5, cy + r + 2, 3, 6); }
      } else {
        ctx.beginPath(); ctx.moveTo(cx, cy);
        ctx.lineTo(cx + r * Math.cos(this.#scanAngle), cy + r * Math.sin(this.#scanAngle));
        ctx.strokeStyle = '#00ff80'; ctx.lineWidth = 1.5; ctx.stroke();
      }
      ctx.fillStyle = '#006633'; ctx.font = '8px monospace';
      ctx.fillText(label1, cx - 22, cy + r + 12); ctx.fillText(label2, cx - 25, cy + r + 22);
    };

    draw_mini_scope(px + 40, py + 60, 32, 'Mechanical', 'Rotating', false);
    draw_mini_scope(px + 110, py + 60, 32, 'Electronic', 'Phase steer', true);

    ctx.strokeStyle = 'rgba(0,150,60,0.2)'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(px + pw / 2, py + 20); ctx.lineTo(px + pw / 2, py + 115); ctx.stroke();

    [['Speed', '~6RPM', 'ns agile'], ['Beam', 'Fixed BW', 'Adaptive'], ['Cost', 'Low', 'High'], ['Wear', 'Mech.', 'None']].forEach((row, i) => {
      ctx.fillStyle = '#006633'; ctx.font = '8px monospace'; ctx.fillText(row[0], px + 6, py + 125 + i * 14);
      ctx.fillStyle = '#004422'; ctx.fillText(row[1], px + 52, py + 125 + i * 14);
      ctx.fillStyle = '#00aa55'; ctx.fillText(row[2], px + 100, py + 125 + i * 14);
    });
  }

  _drawStats() {
    const { ctx } = this.renderer;
    const { frequency, numElements, scanRange, beamWidthDeg, trackingMode, snr, windowType } = this.params;
    const detCount = this.targets.filter(t => this._isRecentDetection(t)).length;
    const wl = MathUtils.wavelength(frequency, SPEED_OF_LIGHT);
    const bw3dB = (MathUtils.beamwidth3dB(numElements, 0.5 * wl, wl) * 180 / Math.PI).toFixed(1);
    const scanDeg = ((this.#scanAngle * 180 / Math.PI + 360) % 360).toFixed(1);
    const dragging = this.#dragManager.isDragging;

    ctx.fillStyle = 'rgba(0,8,4,0.85)'; ctx.fillRect(8, 8, 230, 145);
    ctx.strokeStyle = 'rgba(0,200,80,0.3)'; ctx.lineWidth = 1; ctx.strokeRect(8, 8, 230, 145);
    [
      `f = ${(frequency / 1e9).toFixed(1)} GHz`,
      `Elements: ${numElements}  |  BW: ${beamWidthDeg}°`,
      `3dB BW: ${bw3dB}°  |  Win: ${windowType}`,
      `Range: ${scanRange}px  |  SNR: ${snr}  ${snr>=1000?'✓ perfect':snr>=700?'good':snr>=400?'⚠ degraded':'⛔ noisy'}`,
      `Scan angle: ${scanDeg}°`,
      `Targets: ${this.targets.length}/5  |  Detected: ${detCount}`,
      trackingMode ? '⟳ TRACKING MODE' : '⊙ 360° SCAN MODE',
      dragging
        ? '↖ dragging target…'
        : (this.#selectedTarget
          ? `Selected RCS: ${this.#selectedTarget.rcs.toFixed(0)} m²  · Del to remove`
          : 'Click scope → add · Drag target → move')
    ].forEach((l, i) => {
      ctx.fillStyle = i === 5 ? '#ffff44' : i === 6 ? '#00ffaa' : i === 7 ? (this.#selectedTarget || dragging ? '#ffffff' : '#335544') : '#00cc66';
      ctx.font = i === 6 ? 'bold 11px monospace' : '11px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(l, 14, 22 + i * 16);
    });
  }

  _loadDefaultScenario() {
    const s = ScenarioManager.load('radar_airtraffic');
    if (s?.params?.targets) s.params.targets.forEach(t => this.addTarget(t));
    else {
      this.addTarget({ x: 500, y: 200, rcs: 10, speed: 1.5, heading: 2.2 });
      this.addTarget({ x: 300, y: 180, rcs: 8, speed: 1.0, heading: 0.8 });
    }
  }

  // ── Analysis data for modal viewers ─────────────────────────

  /**
   * Compute the phased-array constructive/destructive interference map.
   *
   * Each grid cell receives the coherent sum of all element contributions
   * steered to the current scan angle — exactly the "beam field" the array
   * actually radiates.  Positive values = constructive (main lobe + near
   * sidelobes), negative = destructive (nulls / destructive interference).
   *
   * This matches what MATLAB's phased.ULA beam-pattern tools show and what
   * the assignment asks for (constructive/destructive map, not an echo map).
   *
   * Returns { width, height, cells, scanAngleDeg }
   * cells[y][x] ∈ [-1, 1]
   */
  getInterferenceData(gridW = 80, gridH = 60) {
    const W = this.renderer.width  || 760;
    const H = this.renderer.height || 540;
    const center = this._center();
    const { frequency, numElements, windowType, scanRange } = this.params;

    // Physical spacing: half-wavelength in canvas-pixel units
    // We use a fixed pixel scale (8 px / λ) so the pattern has visible fringes
    const lam  = 8;                    // pixels per wavelength (fixed visual scale)
    const d    = lam * 0.5;            // half-wavelength element spacing (px)
    const weights = this._applyWindow(numElements, windowType ?? 'none');

    // Steer direction in canvas coordinates: scanAngle follows atan2 convention
    const steerAngle = this.#scanAngle;  // radians, canvas atan2

    const cells = [];
    let maxAmp = 0;

    for (let gy = 0; gy < gridH; gy++) {
      const row = [];
      for (let gx = 0; gx < gridW; gx++) {
        const px = (gx + 0.5) * (W / gridW);
        const py = (gy + 0.5) * (H / gridH);

        const dx = px - center.x;
        const dy = py - center.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Only inside scan range
        if (dist > scanRange) { row.push(null); continue; }

        // Direction to this pixel (canvas atan2: right=0, down=π/2)
        const theta = Math.atan2(dy, dx);

        // Array factor: elements along X-axis, phase delay based on
        // sin(θ) projection — standard ULA formula applied to canvas coords
        let re = 0, im = 0;
        for (let n = 0; n < numElements; n++) {
          // Phase difference for element n: steering + observation direction
          const psi = (2 * Math.PI * d / lam) * n *
                      (Math.cos(theta) - Math.cos(steerAngle));
          re += weights[n] * Math.cos(psi);
          im += weights[n] * Math.sin(psi);
        }

        // Normalised amplitude (signed so nulls show as negative)
        const amp = Math.sqrt(re * re + im * im) / numElements;
        const signed = amp * Math.sign(re);   // sign encodes phase polarity
        row.push(signed);
        if (amp > maxAmp) maxAmp = amp;
      }
      cells.push(row);
    }

    // Normalise to [-1, 1]
    const norm = maxAmp > 0 ? 1 / maxAmp : 1;
    const normalised = cells.map(row =>
      row.map(v => v === null ? 0 : MathUtils.clamp(v * norm, -1, 1))
    );

    return {
      width: gridW, height: gridH, cells: normalised,
      scanAngleDeg: ((steerAngle * 180 / Math.PI) + 360) % 360
    };
  }

  /**
   * Per-element apodization weights for an explicit window type.
   * Used when callers need weights for a specific window regardless of
   * the engine's current params (e.g. getInterferenceData, getBeamProfiles).
   * The engine's applyWindow() is used everywhere the current params suffice.
   * @param {number} n
   * @param {string} [windowType]
   * @returns {number[]} normalised weights (max = 1)
   */
  _applyWindow(n, windowType) {
    n          = n          ?? this.params.numElements;
    windowType = windowType ?? this.params.windowType ?? 'none';
    const w = [];
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1);
      switch (windowType) {
        case 'hanning':  w.push(0.5  * (1 - Math.cos(2 * Math.PI * x))); break;
        case 'hamming':  w.push(0.54 - 0.46 * Math.cos(2 * Math.PI * x)); break;
        case 'blackman': w.push(0.42 - 0.5  * Math.cos(2 * Math.PI * x)
                                      + 0.08 * Math.cos(4 * Math.PI * x)); break;
        case 'kaiser': {
          const beta = 6, mid = (n - 1) / 2;
          const r = (i - mid) / mid;
          w.push(Math.exp(-beta * (1 - r * r)) / Math.exp(-beta * 0));
          break;
        }
        default: w.push(1.0);
      }
    }
    const maxW = Math.max(...w);
    return w.map(v => v / maxW);
  }

  /**
   * Compute beam radiation pattern for the radar phased array.
   *
   * Returns ONE profile for the live scan beam (steered to current scanAngle).
   * Angular domain: 0° → 360° (full rotation, matching the radar display).
   * Also returns sidelobe level info and a rectangular (no-window) comparison
   * profile so the viewer can show apodization benefit.
   *
   * @param {number} [steps=360]
   * @returns {{ scanAngleDeg, windowType, mainBeam, points, pointsRect }}
   *   points / pointsRect: [{ angleDeg, gain }]  gain ∈ [0,1]
   */
  getBeamProfiles(steps = 360) {
    const { numElements, frequency, windowType: wt } = this.params;
    const windowType = wt || 'none';
    const lam    = 8;          // fixed visual wavelength (px)  — same as interference map
    const d      = lam * 0.5;  // half-wavelength spacing
    const weights    = this._applyWindow(numElements, windowType);
    const weightsRect = Array(numElements).fill(1);  // rectangular (no window)

    const buildProfile = (w) => {
      const wSum = w.reduce((a, b) => a + b, 0);
      const pts = [];
      for (let i = 0; i < steps; i++) {
        // Map i → 0…2π (full 360°)
        const theta = (i / steps) * 2 * Math.PI;
        let re = 0, im = 0;
        for (let el = 0; el < numElements; el++) {
          const psi = (2 * Math.PI * d / lam) * el *
                      (Math.cos(theta) - Math.cos(this.#scanAngle));
          re += w[el] * Math.cos(psi);
          im += w[el] * Math.sin(psi);
        }
        const gain = Math.sqrt(re * re + im * im) / wSum;
        pts.push({ angleDeg: i, gain: MathUtils.clamp(gain, 0, 1) });
      }
      return pts;
    };

    const scanAngleDeg = ((this.#scanAngle * 180 / Math.PI) + 360) % 360;
    return {
      label: 'Scan beam',
      scanAngleDeg,
      windowType,
      points: buildProfile(weights),
      pointsRect: buildProfile(weightsRect)
    };
  }

  /**
   * SNR effect analysis — returns data for all four effect dimensions:
   *   1. Detection probability vs SNR curve
   *   2. False-alarm rate vs SNR curve
   *   3. Position-jitter (σ in pixels) vs SNR
   *   4. Size-estimation error (%) vs SNR
   *
   * Each array has 101 points for SNR slider values 0…1000 (step 10).
   * Also returns current operating point so the viewer can mark it.
   */
  getSNRAnalysis() {
    const currentSnr = this.params.snr ?? 200;
    const snrN = this._snrN(currentSnr);

    const points = [];
    for (let s = 0; s <= 1000; s += 10) {
      const n = MathUtils.clamp(s / 10, 0, 100);
      points.push({ snr: s, ...this._snrPhysics(n) });
    }

    return {
      points,
      current: {
        snr: currentSnr,
        snrN,
        ...this._snrPhysics(snrN),
        quality: currentSnr >= 1000 ? 'Perfect' : currentSnr >= 700 ? 'Good'
               : currentSnr >= 400 ? 'Degraded' : 'Noisy'
      }
    };
  }

  /**
   * Beam-width vs size-estimation accuracy data.
   *
   * Simulates how the effective beam width (set by beamWidthDeg + window)
   * affects the RCS estimation error across all live targets.
   *
   * Returns:
   *   widthCurve  — [{ bwDeg, sizeErrPct }] for BW 1°…20°
   *   currentBw   — effective BW in degrees (with windowing factor)
   *   targetStats — [{ label, truRcs, estRcs, errPct, bwMode }] per target
   *   scenario    — text description of current mode
   */
  getBeamWidthAccuracyData() {
    const { beamWidthDeg, windowType, snr } = this.params;
    const snrN = this._snrN(snr);

    // Windowing broadens the effective beam (trade-off: lower sidelobes ↔ wider BW)
    const bwFactor  = this._bwFactor(windowType);
    const effectiveBw = (beamWidthDeg || 5) * bwFactor;

    // Curve: sweep BW 1–20° and show size-estimation error
    const widthCurve = [];
    for (let bw = 0.5; bw <= 20; bw += 0.5) {
      const illuminatedArc    = 150 * bw * Math.PI / 180;  // assume 150px avg range
      const clutterBias       = 0.05 * illuminatedArc;
      const noiseAmplitude    = 40 / Math.max(1, snrN);
      const totalError        = Math.abs(clutterBias) + noiseAmplitude;
      const refRcs            = 8;   // reference target
      const sizeErrPct        = MathUtils.clamp((totalError / refRcs) * 100, 0, 200);
      widthCurve.push({ bwDeg: parseFloat(bw.toFixed(1)), sizeErrPct });
    }

    // Per-target stats
    const center = this._center();
    const targetStats = this.targets.map((t, i) => {
      const recent = this._isRecentDetection(t);
      const R = MathUtils.distance(center, t);
      const illuminatedArc = R * effectiveBw * Math.PI / 180;
      const clutterBias    = 0.05 * illuminatedArc;
      const noiseAmp       = 40 / Math.max(1, snrN);
      const errPct = t.rcs > 0
        ? MathUtils.clamp(((Math.abs(clutterBias) + noiseAmp) / t.rcs) * 100, 0, 200)
        : 100;
      const bwMode = effectiveBw < 4  ? 'Narrow — Accurate'
                   : effectiveBw > 8  ? 'Wide — Rough'
                   :                    'Medium';
      return {
        label: `T${i + 1}`,
        trueRcs: t.rcs,
        estRcs: recent && t.lastEstimatedRcs ? t.lastEstimatedRcs : null,
        errPct: parseFloat(errPct.toFixed(1)),
        bwMode,
        detected: recent
      };
    });

    return {
      widthCurve,
      currentBw:  parseFloat(effectiveBw.toFixed(2)),
      rawBw:      beamWidthDeg,
      bwFactor,
      windowType: windowType ?? 'none',
      targetStats,
      scenario: effectiveBw < 4
        ? 'Narrow beam → precise size estimation, slower scan'
        : effectiveBw > 8
        ? 'Wide beam → fast broad scan, rough size estimate'
        : 'Medium beam → balanced detection vs accuracy'
    };
  }


  _applyState(s) { super._applyState(s); if (s.targets) { this.targets = []; s.targets.forEach(t => this.addTarget(t)); } }

  _onStop() {
    this._unbindInput();
    this.#echoSweep = []; this.#detections = [];
    this.canvas.style.cursor = 'default';
  }

  // ── Internal selection helper ─────────────────────────────────
  _selectTarget(t) {
    this.#selectedTarget = t;
    Bus.emit('radar:target_selected', t);
  }

  // ── Hit radius for a target (size-aware, unified) ─────────────
  _hitRadius(t) { return Math.max(15, Math.sqrt(t.rcs) * 1.8 + 6); }

  // ── Canvas coordinates from mouse event ──────────────────────
  _canvasPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ── Cursor management ─────────────────────────────────────────
  _updateCursor(canvasX, canvasY) {
    if (this.#dragManager.isDragging) {
      this.canvas.style.cursor = 'grabbing';
      return;
    }
    const hover = TargetDragManager._findTarget(this.targets, canvasX, canvasY, t => this._hitRadius(t));
    if (hover) {
      this.canvas.style.cursor = 'grab';
    } else if (MathUtils.distance(this._center(), { x: canvasX, y: canvasY }) < this.params.scanRange) {
      this.canvas.style.cursor = 'crosshair';
    } else {
      this.canvas.style.cursor = 'default';
    }
  }

  // ── Input binding — split by responsibility (SRP) ─────────────

  /**
   * All input bindings use named handler references stored on `this`
   * so _unbindInput() can cleanly remove them when the simulator stops.
   */
  _bindClickInput() {
    let mouseDownPos = null;

    this._rd_onMouseDownClick = (e) => {
      if (e.button !== 0) return;
      mouseDownPos = this._canvasPos(e);
    };

    this._rd_onMouseUpClick = (e) => {
      if (e.button !== 0 || !mouseDownPos) return;
      if (this.#dragManager.isDragging) return;
      if (!this.animFrame) return;

      const { x, y } = this._canvasPos(e);
      const moved = Math.hypot(x - mouseDownPos.x, y - mouseDownPos.y);
      mouseDownPos = null;
      if (moved > 5) return;

      const hit = TargetDragManager._findTarget(this.targets, x, y, t => this._hitRadius(t));
      if (hit) { this._selectTarget(this.#selectedTarget === hit ? null : hit); return; }

      if (MathUtils.distance(this._center(), { x, y }) < this.params.scanRange) {
        this._selectTarget(null);
        const newTarget = this.addTarget({ x, y, rcs: 8, speed: 1 + Math.random(), heading: Math.random() * Math.PI * 2 });
        if (newTarget) this._selectTarget(newTarget);
      }
    };

    this._rd_onContextMenu = (e) => {
      e.preventDefault();
      if (!this.animFrame) return;
      const { x, y } = this._canvasPos(e);
      const hit = TargetDragManager._findTarget(this.targets, x, y, t => this._hitRadius(t));
      if (hit) this.removeTarget(hit);
    };

    this.canvas.addEventListener('mousedown', this._rd_onMouseDownClick);
    this.canvas.addEventListener('mouseup', this._rd_onMouseUpClick);
    this.canvas.addEventListener('contextmenu', this._rd_onContextMenu);
  }

  _bindDragInput() {
    const bounds = () => ({ minX: 0, maxX: this.renderer.width, minY: 0, maxY: this.renderer.height });

    this._rd_onMouseDownDrag = (e) => {
      if (e.button !== 0 || !this.animFrame) return;
      const { x, y } = this._canvasPos(e);
      const started = this.#dragManager.start(this.targets, x, y, t => this._hitRadius(t));
      if (started) {
        this._selectTarget(this.#dragManager.draggedTarget);
        this.canvas.style.cursor = 'grabbing';
        e.preventDefault();
      }
    };

    this._rd_onMouseMoveDrag = (e) => {
      const { x, y } = this._canvasPos(e);
      if (this.#dragManager.isDragging) {
        this.#dragManager.update(x, y, bounds());
        this.canvas.style.cursor = 'grabbing';
      } else {
        this._updateCursor(x, y);
      }
    };

    this._rd_onMouseUpDrag = (e) => {
      if (e.button !== 0) return;
      if (this.#dragManager.isDragging) {
        this.#dragManager.end();
        const { x, y } = this._canvasPos(e);
        this._updateCursor(x, y);
      }
    };

    this._rd_onMouseLeave = () => {
      if (this.#dragManager.isDragging) this.#dragManager.end();
      this.canvas.style.cursor = 'default';
    };

    this.canvas.addEventListener('mousedown', this._rd_onMouseDownDrag);
    this.canvas.addEventListener('mousemove', this._rd_onMouseMoveDrag);
    this.canvas.addEventListener('mouseup', this._rd_onMouseUpDrag);
    this.canvas.addEventListener('mouseleave', this._rd_onMouseLeave);
  }

  _bindKeyInput() {
    this._rd_onKeyDown = (e) => {
      if (!this.animFrame) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.#selectedTarget) {
        this.removeTarget(this.#selectedTarget);
        showToast('🗑 Target removed');
      }
    };
    window.addEventListener('keydown', this._rd_onKeyDown);
  }

  /** Remove all event listeners cleanly */
  _unbindInput() {
    if (this._rd_onMouseDownClick) { this.canvas.removeEventListener('mousedown', this._rd_onMouseDownClick); this._rd_onMouseDownClick = null; }
    if (this._rd_onMouseUpClick) { this.canvas.removeEventListener('mouseup', this._rd_onMouseUpClick); this._rd_onMouseUpClick = null; }
    if (this._rd_onContextMenu) { this.canvas.removeEventListener('contextmenu', this._rd_onContextMenu); this._rd_onContextMenu = null; }
    if (this._rd_onMouseDownDrag) { this.canvas.removeEventListener('mousedown', this._rd_onMouseDownDrag); this._rd_onMouseDownDrag = null; }
    if (this._rd_onMouseMoveDrag) { this.canvas.removeEventListener('mousemove', this._rd_onMouseMoveDrag); this._rd_onMouseMoveDrag = null; }
    if (this._rd_onMouseUpDrag) { this.canvas.removeEventListener('mouseup', this._rd_onMouseUpDrag); this._rd_onMouseUpDrag = null; }
    if (this._rd_onMouseLeave) { this.canvas.removeEventListener('mouseleave', this._rd_onMouseLeave); this._rd_onMouseLeave = null; }
    if (this._rd_onKeyDown) { window.removeEventListener('keydown', this._rd_onKeyDown); this._rd_onKeyDown = null; }
  }
}

// ── Class alias — app.js refers to this name
const RadarMode = RadarSimulator;