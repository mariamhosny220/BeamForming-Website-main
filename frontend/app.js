// ============================================================
// MAIN APPLICATION CONTROLLER
// BeamformingApp orchestrates all simulator modes.
// Pure OOP: owns simulator instances, delegates all physics
// to the simulator layer — no physics logic here.
// ============================================================

class BeamformingApp {
  // Private fields
  #currentSim = null;
  #currentModeName = null;
  #canvas = null;
  #sims = {};

  constructor() {
    this.#canvas = document.getElementById('sim-canvas');

    this._initTopActions();
    this._initModeTabs();
    this._handleResize();
    window.addEventListener('resize', () => this._handleResize());

    // Bus listener: toast relay from simulators
    Bus.on('ui:toast', msg => showToast(msg));
  }

  // ── Public API ────────────────────────────────────────────────

  /** Switch to a named mode. Idempotent: no-op if already active. */
  switchMode(modeName) {
    // Stop radar live viewers if we're leaving radar mode
    this._stopRadarLiveViewers();

    if (this.#currentSim) this.#currentSim.stop();

    document.querySelectorAll('[data-mode]').forEach(b =>
      b.classList.toggle('active', b.dataset.mode === modeName)
    );
    document.querySelectorAll('.ctrl-panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`ctrl-${modeName}`)?.classList.add('active');

    // Ensure canvas is properly sized BEFORE creating the simulator,
    // so entity positions are calculated against real dimensions.
    this._handleResize();

    if (!this.#sims[modeName]) {
      this.#sims[modeName] = this._createSim(modeName);
    }

    this.#currentSim = this.#sims[modeName];
    this.#currentModeName = modeName;

    this._buildControls(modeName);
    this.#currentSim.start();
    this._buildScenarioList(modeName);

    // Start radar live viewers when entering radar mode
    if (modeName === 'radar') {
      // Small delay to let the canvas settle after start()
      setTimeout(() => this._startRadarLiveViewers(), 200);
    }
  }

  // Expose for simulator.html patch
  get currentSim() { return this.#currentSim; }
  get currentModeName() { return this.#currentModeName; }

  // ── Private: simulator factory ────────────────────────────────

  _createSim(modeName) {
    const cbs = {
      onParamChange: (p) => this._onParamChange(modeName, p),
      onEvent: (e) => this._onSimEvent(modeName, e)
    };
    switch (modeName) {
      case 'beamforming': return new BeamformingGenericMode(this.#canvas, cbs);
      case 'ultrasound': return new UltrasoundMode(this.#canvas, cbs);
      case 'fiveg': return new FiveGMode(this.#canvas, cbs);
      case 'radar': return new RadarMode(this.#canvas, cbs);
      default: throw new Error(`Unknown mode: ${modeName}`);
    }
  }

  // ── Private: event handlers ───────────────────────────────────

  _onParamChange(modeName, params) {
    // 1. التحديث الخاص بمود البيم فورمينج (الجديد)
    if (modeName === 'beamforming') {
      _setSliderVal('bf-steer', params.steerAngle, '°');
      // بنحول التردد لـ GHz عشان السلايدر يفهمه
      _setSliderVal('bf-freq', (params.frequency / 1e9).toFixed(1), 'GHz');
      _setSliderVal('bf-elements', params.numElements);
      _setSliderVal('bf-spacing', params.spacing);
      _setSliderVal('bf-amp', params.amplitude.toFixed(1));
    }

    // 2. التحديث الخاص بمود الـ Ultrasound (القديم)
    if (modeName === 'ultrasound') {
      _setSliderVal('us-steer', params.steerAngle, '°');
      _setSliderVal('us-focal', Math.round(params.focalDepth), 'mm');
    }
  }

  _onSimEvent(modeName, evt) {
    const messages = {
      placed_tower: '📡 Tower placed',
      placed_user: '📱 User added',
      removed: '🗑 Removed'
    };
    if (messages[evt]) showToast(messages[evt]);
  }

  // ── Private: resize ───────────────────────────────────────────

  _handleResize() {
    const wrap = this.#canvas.parentElement;
    this.#canvas.style.width = wrap.clientWidth + 'px';
    this.#canvas.style.height = wrap.clientHeight + 'px';
    if (this.#currentSim?.renderer) {
      this.#currentSim.renderer.resize();
      if (this.#currentModeName === 'ultrasound') {
        this.#currentSim._rebuildArray();
      }
    }
  }

  // ── Private: tab init ─────────────────────────────────────────

  _initModeTabs() {
    document.querySelectorAll('[data-mode]').forEach(btn =>
      btn.addEventListener('click', () => this.switchMode(btn.dataset.mode))
    );
  }

  // ── Private: top-bar actions ──────────────────────────────────

  _initTopActions() {
    // Save scenario
    document.getElementById('btn-save-scenario')?.addEventListener('click', async () => {
      if (!this.#currentSim || !this.#currentModeName) return;
      const name = prompt('Scenario name:');
      if (!name) return;
      const key = `custom_${name.replace(/\s+/g, '_').toLowerCase()}_${Date.now()}`;

      let scenarioParams = { ...this.#currentSim.params };
      const mode = this.#currentModeName;
      if (mode === 'fiveg') {
        scenarioParams.towers = this.#currentSim.towers.map(t => t.serialize());
        scenarioParams.users = this.#currentSim.users.map(u => u.serialize());
      } else if (mode === 'radar') {
        scenarioParams.targets = this.#currentSim.targets.map(t => t.serialize());
      }

      await ScenarioManager.save(key, {
        mode, name,
        description: 'Custom saved scenario',
        params: scenarioParams
      });
      this._buildScenarioList(mode);
      showToast('💾 Scenario saved!');
    });

    // Export JSON
    document.getElementById('btn-export')?.addEventListener('click', () => {
      if (!this.#currentSim) return;
      const state = this.#currentSim.getState();
      const data = JSON.stringify(state, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `bf_state_${this.#currentModeName}.json`; a.click();
      URL.revokeObjectURL(url);
      showToast('📥 JSON exported');
    });
  }

  // ── Radar Live Overlay Viewers ────────────────────────────────

  _startRadarLiveViewers() {
    const rd = this.#sims.radar;
    if (!rd) return;

    // Remove any stale panel
    document.getElementById('rd-live-panel')?.remove();

    const panel = document.createElement('div');
    panel.id = 'rd-live-panel';
    panel.style.cssText = `
      position:absolute; bottom:12px; left:32px;
      display:flex; gap:8px; pointer-events:none; z-index:10;
    `;
    panel.innerHTML = `
      <div style="background:rgba(2,12,6,0.88);border:1px solid rgba(0,255,120,0.25);
                  border-radius:5px;padding:4px 6px;display:flex;flex-direction:column;gap:3px;">
        <div style="color:#00cc66;font:8px monospace;text-align:center;letter-spacing:.5px;">
          INTERFERENCE MAP
        </div>
        <canvas id="rd-live-heatmap" width="160" height="130"
                style="display:block;border-radius:3px;"></canvas>
      </div>
      <div style="background:rgba(2,12,6,0.88);border:1px solid rgba(0,255,120,0.25);
                  border-radius:5px;padding:4px 6px;display:flex;flex-direction:column;gap:3px;">
        <div style="color:#00cc66;font:8px monospace;text-align:center;letter-spacing:.5px;">
          POLAR BEAM PROFILE
        </div>
        <canvas id="rd-live-polar" width="130" height="130"
                style="display:block;border-radius:3px;"></canvas>
      </div>`;

    // Attach to the canvas wrapper so it overlays the radar canvas
    const wrap = this.#canvas.parentElement;
    wrap.style.position = 'relative';
    wrap.appendChild(panel);

    const drawFrame = () => {
      const hmCanvas = document.getElementById('rd-live-heatmap');
      const poCanvas = document.getElementById('rd-live-polar');
      if (!hmCanvas || !poCanvas) return;
      this._drawRadarHeatmap(hmCanvas, rd);
      this._drawRadarBeamPolar(poCanvas, rd);
    };

    drawFrame();
    this._rdLiveInterval = setInterval(drawFrame, 300);
  }

  _stopRadarLiveViewers() {
    if (this._rdLiveInterval) {
      clearInterval(this._rdLiveInterval);
      this._rdLiveInterval = null;
    }
    document.getElementById('rd-live-panel')?.remove();
  }

  // ── Private: control panel builders ──────────────────────────

  _buildControls(modeName) {
    switch (modeName) {
      case 'beamforming': this._buildBeamformingControls(); break; // 👈 ضيفي دي
      case 'ultrasound': this._buildUltrasoundControls(); break;
      case 'fiveg': this._build5GControls(); break;
      case 'radar': this._buildRadarControls(); break;
    }
  }
  _buildBeamformingControls() {
    const panel = document.getElementById('ctrl-beamforming');
    if (!panel || panel.dataset.built) return;
    panel.dataset.built = 'true';

    // 1. حقن الـ HTML الخاص بالسلايدرز
    panel.innerHTML = `
    <div class="ctrl-section">
      <h3 class="ctrl-title">GENERAL ARRAY SPECS</h3>
      ${_slider('bf-elements', 'Elements', 2, 128, 16, 1)}
      ${_slider('bf-spacing', 'd/λ Spacing', 0.1, 1, 0.5, 0.01)}
      ${_slider('bf-freq', 'Frequency', 1, 10, 2.4, 0.1, 'GHz')}

      <h3 class="ctrl-title">SIGNAL CONTROL</h3>
      ${_slider('bf-steer', 'Steering Angle', -90, 90, 0, 1, '°')}
      ${_slider('bf-amp', 'Amplitude', 0, 2, 1, 0.1)}
      ${_slider('bf-phase', 'Phase Offset', -180, 180, 0, 1, '°')}

      <h3 class="ctrl-title">APODIZATION</h3>
      <div class="btn-group">
        <button class="btn-sm active" data-bf-win="none">Rect</button>
        <button class="btn-sm" data-bf-win="hanning">Hann</button>
        <button class="btn-sm" data-bf-win="hamming">Hamm</button>
        <button class="btn-sm" data-bf-win="blackman">Black</button>
        <button class="btn-sm" data-bf-win="kaiser">Kaiser</button>
      </div>
      ${_slider('bf-kaiser', 'Kaiser β', 1, 15, 6, 0.5)}

      <h3 class="ctrl-title">NOISE</h3>
      ${_slider('bf-snr', 'SNR', 0, 1000, 100, 10)}
    </div>
  `;

    // 2. ربط الـ Event Listeners (السر هنا!)
    // بنستخدم الدوال المساعدة اللي إنتي كاتباها في آخر الملف
    _bindSlider('bf-elements', v => this.currentSim?.setParams({ numElements: +v }));
    _bindSlider('bf-spacing', v => this.currentSim?.setParams({ spacing: parseFloat(v) }));
    _bindSlider('bf-freq', v => this.currentSim?.setParams({ frequency: parseFloat(v) * 1e9 }));
    _bindSlider('bf-steer', v => this.currentSim?.setParams({ steerAngle: parseFloat(v) }));
    _bindSlider('bf-amp', v => this.currentSim?.setParams({ amplitude: parseFloat(v) }));
    _bindSlider('bf-phase', v => this.currentSim?.setParams({ phase: parseFloat(v) }));
    _bindSlider('bf-kaiser', v => this.currentSim?.setParams({ kaiserBeta: parseFloat(v) }));
    _bindSlider('bf-snr', v => this.currentSim?.setParams({ snr: parseFloat(v) }));

    // ربط أزرار الـ Apodization
    panel.querySelectorAll('[data-bf-win]').forEach(btn => {
      btn.addEventListener('click', () => {
        panel.querySelectorAll('[data-bf-win]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentSim?.setParams({ windowType: btn.dataset.bfWin });
      });
    });
  }
  _buildUltrasoundControls() {
    const panel = document.getElementById('ctrl-ultrasound');
    if (!panel || panel.dataset.built) return;
    panel.dataset.built = 'true';

    panel.innerHTML = `
      <div class="ctrl-section">

        <h3 class="ctrl-title">🩻 SCAN MODE</h3>
        <div class="ctrl-group">
          <div class="btn-group">
            <button class="btn-sm active" data-us-mode="beamform">Beam</button>
            <button class="btn-sm" data-us-mode="amode">A-Mode</button>
            <button class="btn-sm" data-us-mode="bmode">B-Mode</button>
            <button class="btn-sm" data-us-mode="doppler">Doppler</button>
            <button class="btn-sm" style="color:#ffaa00; border-color:rgba(255,170,0,0.4);" data-us-mode="interf">~ Interf.</button>
          </div>
          <p class="hint">Drag canvas to steer beam</p>
        </div>

        <h3 class="ctrl-title">🔊 ARRAY SETUP</h3>
        ${_slider('us-elements', 'Elements', 4, 128, 32, 4)}
        ${_slider('us-freq', 'Frequency', 1, 15, 5, 0.5, 'MHz')}
        ${_slider('us-spacing', 'Spacing', 0.1, 1.5, 0.25, 0.05, 'mm')}
        ${_slider('us-steer', 'Steer Angle', -60, 60, 0, 1, '°')}
        ${_slider('us-focal', 'Focal Depth', 20, 200, 100, 5, 'mm')}
        <div class="ctrl-group">
          <label class="ctrl-label">Array Type</label>
          <div class="btn-group">
            <button class="btn-sm active" data-us-array="linear">Linear</button>
            <button class="btn-sm" data-us-array="curved">Curved</button>
          </div>
        </div>
        ${_slider('us-curv', 'Curve Radius', 30, 150, 70, 5, 'mm')}

        <h3 class="ctrl-title">🪟 APODIZATION</h3>
        <div class="ctrl-group">
          <label class="ctrl-label">Window Function</label>
          <div class="btn-group" style="flex-wrap:wrap;gap:3px">
            <button class="btn-sm active" data-us-apod="none">Rect</button>
            <button class="btn-sm" data-us-apod="hanning">Hann</button>
            <button class="btn-sm" data-us-apod="hamming">Hamm</button>
            <button class="btn-sm" data-us-apod="blackman">Black</button>
            <button class="btn-sm" data-us-apod="kaiser">Kaiser</button>
          </div>
          <p class="hint">Reduces sidelobes at cost of main-lobe width</p>
        </div>
        ${_slider('us-kaiser', 'Kaiser β', 1, 15, 6, 0.5, '')}

        <h3 class="ctrl-title">📶 SIGNAL</h3>
        ${_slider('us-snr', 'SNR', 0, 1000, 100, 10, '')}

        <h3 class="ctrl-title">🩸 DOPPLER / VESSEL</h3>
        ${_slider('us-bloodvel', 'Blood Velocity', 0, 2, 0.5, 0.05, 'm/s')}
        ${_slider('us-vesselangle', 'Vessel Angle', 0, 90, 30, 1, '°')}

        <h3 class="ctrl-title">👁 DISPLAY</h3>
        <div class="ctrl-group">
          <div class="toggle-row">
            ${_toggle('us-indiv', 'Individual Waves', true)}
            ${_toggle('us-beam', 'Beam Profile', true)}
            ${_toggle('us-heatmap', 'Heatmap', true)}
            ${_toggle('us-focus', 'Focusing', true)}
            ${_toggle('us-phantom', 'Show Phantom', true)}
            ${_toggle('us-vessel', 'Show Vessel', true)}
          </div>
        </div>
      </div>`;

    panel.querySelectorAll('[data-us-mode]').forEach(b =>
      b.addEventListener('click', () => {
        panel.querySelectorAll('[data-us-mode]').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        const sim = this.#sims.ultrasound;
        if (!sim) return;
        sim.setScanMode(b.dataset.usMode);
        if (b.dataset.usMode === 'bmode') showToast('Building B-Mode scan…');
      })
    );

    _bindSlider('us-elements', v => this.#currentSim?.setParams({ numElements: +v }));
    _bindSlider('us-freq', v => this.#currentSim?.setParams({ frequency: parseFloat(v) * 1e6 }));
    _bindSlider('us-spacing', v => this.#currentSim?.setParams({ spacing: parseFloat(v) }));
    _bindSlider('us-steer', v => this.#currentSim?.setParams({ steerAngle: parseFloat(v) }));
    _bindSlider('us-focal', v => this.#currentSim?.setParams({ focalDepth: parseFloat(v) }));
    _bindSlider('us-curv', v => this.#currentSim?.setParams({ curvatureRadius: parseFloat(v) }));

    panel.querySelectorAll('[data-us-array]').forEach(b =>
      b.addEventListener('click', () => {
        panel.querySelectorAll('[data-us-array]').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        this.#currentSim?.setParams({ arrayType: b.dataset.usArray });
      })
    );

    panel.querySelectorAll('[data-us-apod]').forEach(b =>
      b.addEventListener('click', () => {
        panel.querySelectorAll('[data-us-apod]').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        this.#currentSim?.setParams({ apodization: b.dataset.usApod });
        showToast(`Window: ${b.dataset.usApod}`);
      })
    );
    _bindSlider('us-kaiser', v => this.#currentSim?.setParams({ kaiserBeta: parseFloat(v) }));
    _bindSlider('us-snr', v => this.#currentSim?.setParams({ snr: parseFloat(v) }));
    _bindSlider('us-bloodvel', v => this.#currentSim?.setParams({ bloodVelocity: parseFloat(v) }));
    _bindSlider('us-vesselangle', v => this.#currentSim?.setParams({ vesselAngle: parseFloat(v) }));

    _bindToggle('us-indiv', v => this.#currentSim?.setParams({ showIndividual: v }));
    _bindToggle('us-beam', v => this.#currentSim?.setParams({ showBeam: v }));
    _bindToggle('us-heatmap', v => this.#currentSim?.setParams({ showHeatmap: v }));
    _bindToggle('us-focus', v => this.#currentSim?.setParams({ focusing: v }));
    _bindToggle('us-phantom', v => this.#currentSim?.setParams({ showPhantom: v }));
    _bindToggle('us-vessel', v => this.#currentSim?.setParams({ showVessel: v }));
  }

  _build5GControls() {
    const panel = document.getElementById('ctrl-fiveg');
    if (!panel || panel.dataset.built) return;
    panel.dataset.built = 'true';

    panel.innerHTML = `
      <div class="ctrl-section">
        <h3 class="ctrl-title">📡 5G BASE STATION</h3>

        <!-- ── Tower Editor (shown only when a tower is selected) ── -->
        <div class="ctrl-group tower-editor" id="fg-tower-editor" style="display:none;">
          <div class="tower-editor-header">
            <span id="fg-tower-editor-title">✎ TOWER 1</span>
            <button class="tower-editor-close" id="fg-tower-editor-close" title="Deselect">✕</button>
          </div>
          ${_slider('fg-t-elements', 'Antenna Elements', 4, 64, 16, 4)}
          ${_slider('fg-t-freq',     'Frequency',        1, 60, 28, 1, 'GHz')}
          <p class="hint">Coverage is calculated from frequency</p>
          ${_slider('fg-t-snr',      'SNR',              0, 1000, 100, 10)}
          ${_slider('fg-t-range',    'Coverage Range',   50, 500, 250, 10, 'px')}
          <label class="ctrl-label" style="margin-top:6px;">Apodization Window</label>
          <div class="btn-group" id="fg-t-win-group">
            <button class="btn-sm active" data-fg-t-win="none">None</button>
            <button class="btn-sm" data-fg-t-win="hanning">Hanning</button>
            <button class="btn-sm" data-fg-t-win="hamming">Hamming</button>
            <button class="btn-sm" data-fg-t-win="blackman">Blackman</button>
            <button class="btn-sm" data-fg-t-win="kaiser">Kaiser</button>
          </div>
          <button class="btn-action danger" id="fg-t-remove" style="margin-top:6px;">🗑 Remove This Tower</button>
        </div>

        <!-- ── Global defaults (all towers) ── -->
        <div class="ctrl-group" id="fg-global-section">
          <label class="ctrl-label" style="opacity:0.5; font-size:9px; letter-spacing:.08em;">DEFAULT FOR NEW TOWERS</label>
          ${_slider('fg-elements', 'Antenna Elements', 4, 64, 16, 4)}
          ${_slider('fg-freq', 'Frequency', 1, 60, 28, 1, 'GHz')}
          <p class="hint">Coverage follows frequency</p>
          ${_slider('fg-snr', 'SNR', 0, 1000, 100, 10)}
          ${_slider('fg-range', 'Coverage Range', 50, 500, 250, 10, 'px')}
          <label class="ctrl-label" style="margin-top:6px;">Apodization Window</label>
          <div class="btn-group" id="fg-win-group">
            <button class="btn-sm active" data-fg-win="none">None</button>
            <button class="btn-sm" data-fg-win="hanning">Hanning</button>
            <button class="btn-sm" data-fg-win="hamming">Hamming</button>
            <button class="btn-sm" data-fg-win="blackman">Blackman</button>
            <button class="btn-sm" data-fg-win="kaiser">Kaiser</button>
          </div>
        </div>

        <div class="ctrl-group">
          <label class="ctrl-label">Placement</label>
          <div class="btn-group-v">
            <button class="btn-action" id="fg-add-tower">📡 Add Tower (T)</button>
            <button class="btn-action" id="fg-add-user">📱 Add User (U)</button>
            <button class="btn-action danger" id="fg-rem-user">🗑 Remove Selected (Shift+Click)</button>
          </div>
        </div>

        <div class="ctrl-group">
          <label class="ctrl-label">Move Selected User</label>
          <div class="dpad" id="fg-dpad">
            <div></div><button data-dir="up">▲</button><div></div>
            <button data-dir="left">◄</button><div></div><button data-dir="right">►</button>
            <div></div><button data-dir="down">▼</button><div></div>
          </div>
          <p class="hint">Select user then arrow keys or D-pad</p>
        </div>

        <div class="ctrl-group">
          <label class="ctrl-label">Display</label>
          <div class="toggle-row">
            ${_toggle('fg-beams', 'Show Beams', true)}
            ${_toggle('fg-coverage', 'Coverage Area', true)}
            ${_toggle('fg-elems', 'Antenna Elements', true)}
            ${_toggle('fg-infoboxes', 'Tower Info Boxes', true)}
          </div>
        </div>

        <div class="ctrl-group">
          <button class="btn-action" id="fg-analysis-btn" style="width:100%;background:rgba(0,180,255,0.12);border-color:rgba(0,180,255,0.4);">📊 Analysis View</button>
        </div>
      </div>`;

    const fg = () => this.#sims.fiveg;

    _bindSlider('fg-elements', v => {
      const n = +v;
      fg()?.setParams({ numElements: n });
      fg()?.towers.forEach(t => { t.numElements = n; });
    });
    _bindSlider('fg-freq', v => {
      const f = parseFloat(v) * 1e9;
      fg()?.setParams({ frequency: f });
      fg()?.towers.forEach(t => { t.frequency = f; });
    });
    _bindSlider('fg-snr', v => {
      const s = parseFloat(v);
      fg()?.setParams({ snr: s });
      fg()?.towers.forEach(t => { t.snr = s; });
    });
    _bindSlider('fg-range', v => {
      const r = parseFloat(v);
      fg()?.setParams({ range: r });
      fg()?.towers.forEach(t => { t.range = r; });
      fg()?.updateTower && fg()?._updateConnections?.();
    });
    panel.querySelectorAll('[data-fg-win]').forEach(b =>
      b.addEventListener('click', () => {
        panel.querySelectorAll('[data-fg-win]').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        const wt = b.dataset.fgWin;
        fg()?.setParams({ windowType: wt });
        showToast('Window: ' + wt);
      })
    );

    document.getElementById('fg-add-tower')?.addEventListener('click', () => fg()?.startPlacingTower());
    document.getElementById('fg-add-user')?.addEventListener('click', () => fg()?.startPlacingUser());
    document.getElementById('fg-rem-user')?.addEventListener('click', () => fg()?.removeSelectedUser());

    _bindToggle('fg-beams', v => fg()?.setParams({ showBeams: v }));
    _bindToggle('fg-coverage', v => fg()?.setParams({ showCoverage: v }));
    _bindToggle('fg-elems', v => fg()?.setParams({ showElements: v }));
    _bindToggle('fg-infoboxes', v => fg()?.setParams({ showInfoBoxes: v }));

    document.getElementById('fg-dpad')?.addEventListener('mousedown', e => {
      const btn = e.target.closest('[data-dir]');
      const u = fg()?.selectedUser;
      if (!btn || !u) return;
      const spd = 6;
      const map = { up: [0, -spd], down: [0, spd], left: [-spd, 0], right: [spd, 0] };
      const [dx, dy] = map[btn.dataset.dir] || [0, 0];
      u.move(dx, dy);
    });

    // ── Tower Editor: show/hide + populate on tower selection ─────
    const editorEl  = document.getElementById('fg-tower-editor');
    const globalEl  = document.getElementById('fg-global-section');
    const titleEl   = document.getElementById('fg-tower-editor-title');

    const _setSliderVal = (id, val) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.value = val;
      el.dispatchEvent(new Event('input'));          // update displayed value label
      el.dispatchEvent(new Event('_label_only'));    // in case _bindSlider uses a separate label
      // Manually update sibling value display (pattern used by _slider helper)
      const lbl = el.closest('.ctrl-group, .slider-row')?.querySelector('.slider-val, .val-label, output');
      if (lbl) lbl.textContent = val;
    };

    const showTowerEditor = (tower, towerIndex) => {
      if (!tower) {
        editorEl.style.display  = 'none';
        globalEl.style.display  = '';
        return;
      }
      editorEl.style.display  = '';
      globalEl.style.display  = 'none';
      titleEl.textContent = `✎ TOWER ${towerIndex + 1}`;

      // Populate sliders with this tower's current values
      _setSliderVal('fg-t-elements', tower.numElements);
      _setSliderVal('fg-t-freq',     (tower.frequency / 1e9).toFixed(0));
      _setSliderVal('fg-t-snr',      tower.snr ?? fg()?.params.snr ?? 100);
      _setSliderVal('fg-t-range',    tower.range ?? fg()?.params.range ?? 250);
      // Sync window buttons to this tower's windowType
      const tWin = tower.windowType ?? fg()?.params.windowType ?? 'none';
      panel.querySelectorAll('[data-fg-t-win]').forEach(b => {
        b.classList.toggle('active', b.dataset.fgTWin === tWin);
      });
    };

    // Listen for tower selection from canvas click
    Bus.on('fiveg:tower_selected', tower => {
      const idx = tower ? fg()?.towers.indexOf(tower) : -1;
      showTowerEditor(tower, idx);
    });

    // Tower editor slider bindings — affect ONLY the selected tower
    _bindSlider('fg-t-elements', v => {
      const t = fg()?.selectedTower; if (!t) return;
      fg()?.updateTower(t, { numElements: +v });
    });
    _bindSlider('fg-t-freq', v => {
      const t = fg()?.selectedTower; if (!t) return;
      fg()?.updateTower(t, { frequency: parseFloat(v) * 1e9 });
    });
    _bindSlider('fg-t-snr', v => {
      const t = fg()?.selectedTower; if (!t) return;
      fg()?.updateTower(t, { snr: parseFloat(v) });
    });
    _bindSlider('fg-t-range', v => {
      const t = fg()?.selectedTower; if (!t) return;
      fg()?.updateTower(t, { range: parseFloat(v) });
    });
    panel.querySelectorAll('[data-fg-t-win]').forEach(b =>
      b.addEventListener('click', () => {
        panel.querySelectorAll('[data-fg-t-win]').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        const t = fg()?.selectedTower; if (!t) return;
        t.windowType = b.dataset.fgTWin;
        fg()?._updateConnections?.();
        showToast('Tower window: ' + b.dataset.fgTWin);
      })
    );

    document.getElementById('fg-tower-editor-close')?.addEventListener('click', () => {
      fg()?.selectTower(null);
    });

    document.getElementById('fg-t-remove')?.addEventListener('click', () => {
      const t = fg()?.selectedTower;
      if (t) { fg()?.removeTower(t); fg()?.selectTower(null); }
    });

    document.getElementById('fg-analysis-btn')?.addEventListener('click', () => {
      this._openAnalysisModal();
    });
  }

  // ── Analysis Modal (5G) ────────────────────────────────────────
  _openAnalysisModal() {
    const fg = this.#sims.fiveg;
    if (!fg || fg.towers.length === 0) {
      Bus.emit('ui:toast', 'Add at least one tower first');
      return;
    }

    // Remove existing modal if open
    document.getElementById('fg-analysis-modal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'fg-analysis-modal';
    modal.innerHTML = `
      <div class="analysis-overlay" id="fg-analysis-overlay"></div>
      <div class="analysis-panel">
        <div class="analysis-header">
          <span>📊 Beam Analysis</span>
          <button class="analysis-close" id="fg-analysis-close">✕</button>
        </div>
        <div class="analysis-body" id="fg-analysis-body"></div>
      </div>`;
    document.body.appendChild(modal);

    document.getElementById('fg-analysis-overlay')?.addEventListener('click', () => modal.remove());
    document.getElementById('fg-analysis-close')?.addEventListener('click',   () => modal.remove());

    this._renderAnalysisViewers(fg);

    // Live update loop — redraws every 200ms while modal is open
    const interval = setInterval(() => {
      if (!document.getElementById('fg-analysis-modal')) { clearInterval(interval); return; }
      this._renderAnalysisViewers(fg);
    }, 200);
  }

  _renderAnalysisViewers(fg) {
    const body = document.getElementById('fg-analysis-body');
    if (!body) return;

    // Rebuild tower viewers
    body.innerHTML = '';
    fg.towers.forEach((tower, tIdx) => {
      const wrap = document.createElement('div');
      wrap.className = 'analysis-tower-wrap';
      const steerUser = tower.activeUsers[0];
      const steerAngle = steerUser ? MathUtils.angleTo(tower, steerUser) : 0;
      const wl = SPEED_OF_LIGHT / tower.frequency;
      const spacing = MathUtils.fiveGElementSpacing();
      const bwDeg = MathUtils.beamwidth3dB(tower.numElements, spacing, wl) * 180 / Math.PI;
      const effectiveRange = Math.round(tower.effectiveRange || tower.range);
      wrap.innerHTML = `
        <div class="analysis-tower-title">
          <span class="analysis-dot ${tower.activeUsers.length > 0 ? 'active' : ''}"></span>
          TOWER ${tIdx + 1} — ${(tower.frequency/1e9).toFixed(0)} GHz · ${tower.numElements} ant · ${effectiveRange}px coverage · ${bwDeg.toFixed(1)}° beam
        </div>
        <div class="analysis-canvases">
          <div class="analysis-viewer">
            <div class="analysis-viewer-label">2D Interference Map</div>
            <canvas class="analysis-heatmap" width="220" height="220" data-tower="${tIdx}"></canvas>
          </div>
          <div class="analysis-viewer">
            <div class="analysis-viewer-label">Beam Profile</div>
            <canvas class="analysis-polar" width="220" height="220" data-tower="${tIdx}"></canvas>
          </div>
          <div class="analysis-viewer">
            <div class="analysis-viewer-label">AF vs Angle</div>
            <canvas class="analysis-linear" width="300" height="220" data-tower="${tIdx}"></canvas>
          </div>
          <div class="analysis-viewer">
            <div class="analysis-viewer-label">Field Map</div>
            <canvas class="analysis-fieldmap" width="300" height="220" data-tower="${tIdx}"></canvas>
          </div>
        </div>`;
      body.appendChild(wrap);

      // Draw immediately
      this._drawHeatmap(wrap.querySelector('.analysis-heatmap'), tower, fg);
      this._drawPolar(wrap.querySelector('.analysis-polar'), tower, fg);
      this._drawLinear(wrap.querySelector('.analysis-linear'), tower, fg);
      this._drawFieldMap(wrap.querySelector('.analysis-fieldmap'), tower, fg);
    });
  }

  _drawHeatmap(canvas, tower, fg) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const img = ctx.createImageData(W, H);
    const cx = W / 2, cy = H / 2;
    const effectiveRange = tower.effectiveRange || tower.range;
    const scale = (effectiveRange * 2) / W;   // world-px per canvas-px

    const wl  = SPEED_OF_LIGHT / tower.frequency;
    const d   = MathUtils.fiveGElementSpacing();
    const N   = tower.numElements;

    const steerAngle = tower.activeUsers.length > 0
      ? MathUtils.angleTo(tower, tower.activeUsers[0])
      : 0;
    const visualLambdaPx = Math.max(6, effectiveRange / 18);

    // For each canvas pixel, compute signed constructive/destructive field.
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const wx = (px - cx) * scale;
        const wy = (py - cy) * scale;
        const dist = Math.sqrt(wx*wx + wy*wy);
        const theta = Math.atan2(wy, wx);
        const sinDiff = Math.sin(theta) - Math.sin(steerAngle);
        let re = 0, im = 0;
        for (let n = 0; n < N; n++) {
          const arrayPhase = (2 * Math.PI * d / wl) * n * sinDiff;
          const radialPhase = (2 * Math.PI * dist) / visualLambdaPx;
          const phase = arrayPhase + radialPhase;
          re += Math.cos(phase);
          im += Math.sin(phase);
        }
        const fade = Math.exp(-2.2 * (dist / Math.max(effectiveRange, 1)) ** 1.45);
        const signedField = (re / N) * fade;       // -1..1
        const af = Math.abs(signedField);          // 0..1

        const i4 = (py * W + px) * 4;
        if (signedField >= 0) {
          const t = Math.min(1, af / 0.8);
          img.data[i4]   = Math.round(5 + t * 190);
          img.data[i4+1] = Math.round(30 + t * 220);
          img.data[i4+2] = Math.round(70 + t * 185);
        } else {
          const t = Math.min(1, af / 0.8);
          img.data[i4]   = Math.round(30 + t * 225);
          img.data[i4+1] = Math.round(20 + t * 95);
          img.data[i4+2] = Math.round(55 - t * 35);
        }
        img.data[i4+3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // Draw tower center dot
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI*2);
    ctx.fillStyle = '#ffcc33';
    ctx.fill();

    // Draw steering direction and effective coverage ring.
    ctx.save();
    ctx.strokeStyle = 'rgba(255,200,50,0.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(steerAngle) * (W / 2 - 8), cy + Math.sin(steerAngle) * (H / 2 - 8));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.beginPath();
    ctx.arc(cx, cy, W / 2 - 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Draw user positions relative to tower
    tower.activeUsers.forEach(user => {
      const ux = cx + (user.x - tower.x) / scale;
      const uy = cy + (user.y - tower.y) / scale;
      ctx.beginPath();
      ctx.arc(ux, uy, 4, 0, Math.PI*2);
      ctx.fillStyle = user.color;
      ctx.fill();
    });

    ctx.fillStyle = 'rgba(180,220,255,0.55)';
    ctx.font = '8px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('+ constructive', 6, 12);
    ctx.fillStyle = 'rgba(255,150,80,0.65)';
    ctx.fillText('- destructive', 6, 22);
  }

  _drawPolar(canvas, tower, fg) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#05101f';
    ctx.fillRect(0, 0, W, H);

    const cx = W / 2, cy = H / 2;
    const R  = W / 2 - 14;

    const wl = SPEED_OF_LIGHT / tower.frequency;
    const d  = MathUtils.fiveGElementSpacing();
    const N  = tower.numElements;
    const beamwidth = MathUtils.beamwidth3dB(N, d, wl);
    const beamwidthDeg = beamwidth * 180 / Math.PI;
    const steerAngle = tower.activeUsers.length > 0
      ? MathUtils.angleTo(tower, tower.activeUsers[0])
      : 0;

    // Grid rings
    ctx.strokeStyle = 'rgba(0,150,255,0.15)';
    ctx.lineWidth   = 0.5;
    [0.25, 0.5, 0.75, 1].forEach(r => {
      ctx.beginPath();
      ctx.arc(cx, cy, R * r, 0, Math.PI*2);
      ctx.stroke();
    });
    // Spokes
    for (let a = 0; a < Math.PI*2; a += Math.PI/6) {
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a)*R, cy + Math.sin(a)*R);
      ctx.stroke();
    }

    // Beam pattern
    const steps = 360;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const theta = (i / steps) * Math.PI * 2 - Math.PI;
      const sinDiff = Math.sin(theta) - Math.sin(steerAngle);
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) {
        const phase = (2 * Math.PI * d / wl) * n * sinDiff;
        re += Math.cos(phase);
        im += Math.sin(phase);
      }
      const af = Math.sqrt(re*re + im*im) / N;
      const r  = af * R;
      const px = cx + Math.cos(theta) * r;
      const py = cy + Math.sin(theta) * r;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    }
    ctx.closePath();
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    grad.addColorStop(0,   'rgba(0,200,255,0.5)');
    grad.addColorStop(0.6, 'rgba(0,150,255,0.3)');
    grad.addColorStop(1,   'rgba(0,100,200,0.1)');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = '#00ccff';
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // Steer direction line
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(steerAngle)*R, cy + Math.sin(steerAngle)*R);
    ctx.strokeStyle = 'rgba(255,200,50,0.6)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([3,3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Approximate -3 dB beam edges.
    ctx.strokeStyle = 'rgba(255,200,50,0.35)';
    ctx.lineWidth = 0.8;
    ctx.setLineDash([2, 4]);
    [-0.5, 0.5].forEach(sign => {
      const edge = steerAngle + sign * beamwidth;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(edge) * R, cy + Math.sin(edge) * R);
      ctx.stroke();
    });
    ctx.setLineDash([]);

    // Labels
    ctx.fillStyle   = 'rgba(100,180,255,0.5)';
    ctx.font        = '9px monospace';
    ctx.textAlign   = 'center';
    ctx.fillText('0°',  cx,      cy - R - 4);
    ctx.fillText('180°', cx,     cy + R + 12);
    ctx.fillText('90°',  cx + R + 4, cy + 3);
    ctx.fillText('-90°', cx - R - 4, cy + 3);
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,220,120,0.75)';
    ctx.fillText(`BW ${beamwidthDeg.toFixed(1)}°`, 8, 14);
  }

  _drawLinear(canvas, tower, fg) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#05101f';
    ctx.fillRect(0, 0, W, H);

    const PAD_L = 36, PAD_R = 10, PAD_T = 12, PAD_B = 28;
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;

    const wl = SPEED_OF_LIGHT / tower.frequency;
    const d  = MathUtils.fiveGElementSpacing();
    const N  = tower.numElements;
    const steerAngle = tower.activeUsers.length > 0
      ? MathUtils.angleTo(tower, tower.activeUsers[0])
      : 0;

    const steps = 360;
    const afs = [];
    for (let i = 0; i <= steps; i++) {
      const theta = ((i / steps) * 180 - 90) * Math.PI / 180;
      const sinDiff = Math.sin(theta) - Math.sin(steerAngle);
      let re = 0, im = 0;
      for (let n = 0; n < N; n++) {
        const phase = (2 * Math.PI * d / wl) * n * sinDiff;
        re += Math.cos(phase);
        im += Math.sin(phase);
      }
      afs.push(Math.sqrt(re * re + im * im) / N);
    }

    ctx.strokeStyle = 'rgba(0,150,255,0.12)';
    ctx.lineWidth = 0.5;
    [0, 0.25, 0.5, 0.75, 1].forEach(v => {
      const y = PAD_T + plotH * (1 - v);
      ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + plotW, y); ctx.stroke();
      ctx.fillStyle = 'rgba(100,180,255,0.45)';
      ctx.font = '9px monospace'; ctx.textAlign = 'right';
      ctx.fillText((v * 100).toFixed(0) + '%', PAD_L - 3, y + 3);
    });
    [-90, -60, -30, 0, 30, 60, 90].forEach(a => {
      const x = PAD_L + ((a + 90) / 180) * plotW;
      ctx.strokeStyle = 'rgba(0,150,255,0.12)';
      ctx.beginPath(); ctx.moveTo(x, PAD_T); ctx.lineTo(x, PAD_T + plotH); ctx.stroke();
      ctx.fillStyle = 'rgba(100,180,255,0.45)';
      ctx.font = '9px monospace'; ctx.textAlign = 'center';
      ctx.fillText(a + '°', x, PAD_T + plotH + 14);
    });

    ctx.beginPath();
    ctx.moveTo(PAD_L, PAD_T + plotH);
    afs.forEach((af, i) => {
      const x = PAD_L + (i / steps) * plotW;
      const y = PAD_T + plotH * (1 - af);
      ctx.lineTo(x, y);
    });
    ctx.lineTo(PAD_L + plotW, PAD_T + plotH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(0,200,255,0.07)';
    ctx.fill();

    ctx.beginPath();
    afs.forEach((af, i) => {
      const x = PAD_L + (i / steps) * plotW;
      const y = PAD_T + plotH * (1 - af);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'rgba(0,200,255,0.9)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    const steerDeg = steerAngle * 180 / Math.PI;
    const sx = PAD_L + ((steerDeg + 90) / 180) * plotW;
    ctx.strokeStyle = 'rgba(255,200,50,0.7)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(sx, PAD_T); ctx.lineTo(sx, PAD_T + plotH); ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(100,180,255,0.55)';
    ctx.font = '9px monospace'; ctx.textAlign = 'center';
    ctx.fillText('Angle →', PAD_L + plotW / 2, H - 2);
  }

  _drawFieldMap(canvas, tower, fg) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const wl = SPEED_OF_LIGHT / tower.frequency;
    const d  = MathUtils.fiveGElementSpacing();
    const N  = tower.numElements;
    const steerAngle = tower.activeUsers.length > 0
      ? MathUtils.angleTo(tower, tower.activeUsers[0])
      : 0;

    // Array is at bottom-center; field fans upward (like image 1)
    const originX = W / 2;
    const originY = H;
    const maxDist = Math.sqrt(W * W + H * H);

    const img = ctx.createImageData(W, H);

    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const dx = px - originX;
        const dy = originY - py;   // flip Y so up = positive
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1) { continue; }

        // Only draw the forward half-space (above the array)
        if (dy < 0) {
          const i4 = (py * W + px) * 4;
          img.data[i4] = img.data[i4+1] = img.data[i4+2] = 5;
          img.data[i4+3] = 255;
          continue;
        }

        const theta = Math.atan2(dx, dy);   // angle from broadside (up)
        const sinDiff = Math.sin(theta) - Math.sin(steerAngle);
        let re = 0, im = 0;
        for (let n = 0; n < N; n++) {
          const phase = (2 * Math.PI * d / wl) * n * sinDiff;
          re += Math.cos(phase);
          im += Math.sin(phase);
        }
        const af = Math.sqrt(re * re + im * im) / N;  // 0..1

        // Distance fade
        const fade = Math.max(0.2, 1 - dist / maxDist * 0.7);

        const i4 = (py * W + px) * 4;
        if (af > 0.55) {
          // Constructive — cyan/white
          const t = (af - 0.55) / 0.45;
          img.data[i4]   = Math.round(fade * (t * 180));
          img.data[i4+1] = Math.round(fade * (120 + t * 135));
          img.data[i4+2] = Math.round(fade * 255);
        } else if (af > 0.2) {
          // Transition — orange/amber like image 1
          const t = (af - 0.2) / 0.35;
          img.data[i4]   = Math.round(fade * (120 + t * 80));
          img.data[i4+1] = Math.round(fade * (40 + t * 60));
          img.data[i4+2] = Math.round(fade * 20);
        } else {
          // Destructive — deep blue/dark
          const t = af / 0.2;
          img.data[i4]   = Math.round(fade * 5);
          img.data[i4+1] = Math.round(fade * (t * 30));
          img.data[i4+2] = Math.round(fade * (15 + t * 60));
        }
        img.data[i4+3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    // Draw array elements along bottom
    const elSpacing = Math.min(W / (N + 1), 12);
    const arrayW = elSpacing * (N - 1);
    for (let n = 0; n < N; n++) {
      const ex = originX - arrayW / 2 + n * elSpacing;
      ctx.beginPath();
      ctx.arc(ex, H - 3, 2, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,220,255,0.8)';
      ctx.fill();
    }

    // Steer direction line
    const sx = originX + Math.sin(steerAngle) * (H - 10);
    const sy = originY - Math.cos(steerAngle) * (H - 10);
    ctx.strokeStyle = 'rgba(255,200,50,0.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(originX, H);
    ctx.lineTo(Math.max(0, Math.min(W, sx)), Math.max(0, sy));
    ctx.stroke();
    ctx.setLineDash([]);

    // Label
    ctx.fillStyle = 'rgba(100,180,255,0.5)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('constructive/destructive', 5, 12);
  }

  // ════════════════════════════════════════════════════════════
  // ── RADAR CONTROLS ──────────────────────────────────────────
  // ════════════════════════════════════════════════════════════

  _buildRadarControls() {
    const panel = document.getElementById('ctrl-radar');
    if (!panel || panel.dataset.built) return;
    panel.dataset.built = 'true';

    panel.innerHTML = `
      <div class="ctrl-section">
        <h3 class="ctrl-title">🎯 RADAR SYSTEM</h3>
        ${_slider('rd-elements', 'Array Elements', 4, 64, 24, 4)}
        ${_slider('rd-freq', 'Frequency', 1, 30, 9, 0.5, 'GHz')}
        ${_slider('rd-speed', 'Scan Speed', 0.1, 3, 0.5, 0.05, 'rad/s')}
        ${_slider('rd-range', 'Range', 100, 500, 280, 10, 'px')}
        ${_slider('rd-bw', 'Beam Width', 1, 30, 5, 0.5, '°')}
        ${_slider('rd-snr', 'SNR', 0, 1000, 100, 10)}

        <div class="ctrl-group">
          <label class="ctrl-label">Target Size (selected)</label>
          ${_slider('rd-tsize', 'RCS / Size', 1, 30, 8, 0.5, 'm²')}
          <p class="hint" id="rd-tsize-hint">Click a target on scope to select it</p>
        </div>

        <div class="ctrl-group">
          <label class="ctrl-label">Scan Mode</label>
          <div class="btn-group">
            <button class="btn-sm active" data-rd-mode="scan">360° Scan</button>
            <button class="btn-sm" data-rd-mode="track">Track</button>
          </div>
        </div>

        <h3 class="ctrl-title">🪟 APODIZATION</h3>
        <div class="ctrl-group">
          <label class="ctrl-label">Window Function</label>
          <div class="btn-group" style="flex-wrap:wrap;gap:3px">
            <button class="btn-sm" data-rd-win="none">Rect</button>
            <button class="btn-sm" data-rd-win="hanning">Hann</button>
            <button class="btn-sm active" data-rd-win="hamming">Hamm</button>
            <button class="btn-sm" data-rd-win="blackman">Black</button>
            <button class="btn-sm" data-rd-win="kaiser">Kaiser</button>
          </div>
        </div>

        <div class="ctrl-group">
          <label class="ctrl-label">Targets (≤5)</label>
          <p class="hint">Click scope → add · Drag target → move · Right-click → remove · Del key → remove selected</p>
          <div class="btn-group-v">
            <button class="btn-action danger" id="rd-delete-selected">🗑 Delete Selected Target</button>
            <button class="btn-action danger" id="rd-clear">🗑 Clear All Targets</button>
          </div>
        </div>

        <div class="ctrl-group">
          <label class="ctrl-label">Display</label>
          <div class="toggle-row">
            ${_toggle('rd-sidelobes', 'Show Sidelobes', true)}
            ${_toggle('rd-compare', 'Classic vs BF', false)}
            ${_toggle('rd-live-viewers', 'Live Viewers', true)}
          </div>
        </div>

        <div class="ctrl-group">
          <button class="btn-action" id="rd-analysis-btn"
            style="width:100%;background:rgba(0,255,120,0.08);border-color:rgba(0,255,120,0.35);color:#00ff88;">
            📊 Analysis View
          </button>
        </div>
      </div>`;

    _bindSlider('rd-elements', v => {
      const n = +v;
      this.#currentSim?.setParams({ numElements: n });
      // Internal mathematical link: N dictates Beam Width
      const spacing = this.#currentSim?.params.spacing || 0.5;
      const bwRad = 0.886 / (n * spacing);
      const bwDeg = Math.max(1, Math.min(30, bwRad * 180 / Math.PI));
      this.#currentSim?.setParams({ beamWidthDeg: bwDeg });
      // Note: per requirements, do NOT update the rd-bw slider visually
    });

    let lastFreq = this.#currentSim?.params.frequency || 9e9;
    _bindSlider('rd-freq', v => {
      const newFreq = parseFloat(v) * 1e9;
      this.#currentSim?.setParams({ frequency: newFreq });

      // Internal mathematical link: Frequency changes Beam Width
      const currentBw = this.#currentSim?.params.beamWidthDeg || 5;
      let newBw = currentBw * (lastFreq / newFreq);
      newBw = Math.max(1, Math.min(30, newBw));

      this.#currentSim?.setParams({ beamWidthDeg: newBw });
      lastFreq = newFreq;

      // Note: per requirements, do NOT update rd-bw slider visually, and do NOT change scan speed
    });
    _bindSlider('rd-speed', v => this.#currentSim?.setParams({ scanSpeed: parseFloat(v) }));
    _bindSlider('rd-range', v => this.#currentSim?.setParams({ scanRange: parseFloat(v) }));
    _bindSlider('rd-bw', v => this.#currentSim?.setParams({ beamWidthDeg: parseFloat(v) }));
    _bindSlider('rd-snr', v => this.#currentSim?.setParams({ snr: parseFloat(v) }));

    // Target size slider — modifies selected target
    _bindSlider('rd-tsize', v => {
      const rd = this.#sims.radar;
      if (rd?.selectedTarget) {
        rd.selectedTarget.rcs = parseFloat(v);
        rd.selectedTarget.size = parseFloat(v);
      }
    });

    panel.querySelectorAll('[data-rd-mode]').forEach(b =>
      b.addEventListener('click', () => {
        panel.querySelectorAll('[data-rd-mode]').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        this.#currentSim?.setParams({ trackingMode: b.dataset.rdMode === 'track' });
      })
    );

    panel.querySelectorAll('[data-rd-win]').forEach(b =>
      b.addEventListener('click', () => {
        panel.querySelectorAll('[data-rd-win]').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        this.#currentSim?.setParams({ windowType: b.dataset.rdWin });
        showToast(`Window: ${b.dataset.rdWin}`);
      })
    );

    document.getElementById('rd-delete-selected')?.addEventListener('click', () => {
      const rd = this.#sims.radar;
      if (rd?.selectedTarget) {
        rd.removeTarget(rd.selectedTarget);
        showToast('🗑 Target removed');
      } else {
        showToast('⚠️ No target selected');
      }
    });

    document.getElementById('rd-clear')?.addEventListener('click', () => {
      this.#sims.radar?.clearTargets();
      showToast('🗑 Targets cleared');
    });

    _bindToggle('rd-sidelobes', v => this.#currentSim?.setParams({ showSidelobes: v }));
    _bindToggle('rd-compare', v => this.#currentSim?.setParams({ showComparison: v }));
    _bindToggle('rd-live-viewers', v => {
      if (v) {
        this._startRadarLiveViewers();
      } else {
        this._stopRadarLiveViewers();
      }
    });

    // ── Analysis View button ──────────────────────────────────
    document.getElementById('rd-analysis-btn')?.addEventListener('click', () => {
      this._openRadarAnalysisModal();
    });

    // Listen for target selection from radar mode
    Bus.on('radar:target_selected', t => {
      if (t) {
        _setSliderVal('rd-tsize', t.rcs.toFixed(1), 'm²');
        const el = document.getElementById('rd-tsize');
        if (el) el.value = t.rcs;
        const hint = document.getElementById('rd-tsize-hint');
        if (hint) hint.textContent = `Target selected — RCS = ${t.rcs.toFixed(0)} m²`;
      } else {
        const hint = document.getElementById('rd-tsize-hint');
        if (hint) hint.textContent = 'Click a target on scope to select it';
      }
    });
  }

  // ── Radar Analysis Modal ──────────────────────────────────────

  _openRadarAnalysisModal() {
    const rd = this.#sims.radar;
    if (!rd) { showToast('⚠️ Radar not initialised'); return; }

    // Close any existing modal
    document.getElementById('rd-analysis-modal')?.remove();

    const modal = document.createElement('div');
    modal.id = 'rd-analysis-modal';
    modal.innerHTML = `
      <div class="analysis-overlay" id="rd-analysis-overlay"></div>
      <div class="analysis-panel" style="max-width:960px;">
        <div class="analysis-header" style="border-color:rgba(0,255,120,0.2);">
          <span style="color:#00ff88;">📡 Radar Beam Analysis</span>
          <button class="analysis-close" id="rd-analysis-close">✕</button>
        </div>
        <div class="analysis-body" id="rd-analysis-body"></div>
      </div>`;
    document.body.appendChild(modal);

    document.getElementById('rd-analysis-overlay')?.addEventListener('click', () => modal.remove());
    document.getElementById('rd-analysis-close')?.addEventListener('click',   () => modal.remove());

    this._renderRadarAnalysisViewers(rd);

    // Live refresh every 250 ms — re-reads live simulator state
    const interval = setInterval(() => {
      if (!document.getElementById('rd-analysis-modal')) { clearInterval(interval); return; }
      this._renderRadarAnalysisViewers(rd);
    }, 250);
  }

  _renderRadarAnalysisViewers(rd) {
    const body = document.getElementById('rd-analysis-body');
    if (!body) return;

    const { numElements, frequency, windowType, beamWidthDeg, snr, scanRange } = rd.params;
    const targetCount = rd.targets.length;
    const detectedCount = rd.targets.filter(t => t.lastDetected && rd.time - t.lastDetected < 60).length;

    // ── SNR quality label ─────────────────────────────────────
    const snrN = Math.min(100, snr / 10);
    const snrLabel = snr >= 1000 ? '✓ Perfect' : snr >= 700 ? 'Good' : snr >= 400 ? '⚠ Degraded' : '⛔ Noisy';
    const snrColor = snr >= 700 ? '#00ff88' : snr >= 400 ? '#ffcc00' : '#ff4444';

    body.innerHTML = `
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px;padding:8px 12px;
                  background:rgba(0,30,15,0.7);border:1px solid rgba(0,255,100,0.15);border-radius:4px;">
        <span style="color:#00cc66;font:10px monospace;">${numElements} elements</span>
        <span style="color:#00cc66;font:10px monospace;">${(frequency/1e9).toFixed(1)} GHz</span>
        <span style="color:#00cc66;font:10px monospace;">Win: ${windowType}</span>
        <span style="color:#00cc66;font:10px monospace;">BW: ${beamWidthDeg}°</span>
        <span style="color:${snrColor};font:10px monospace;">SNR: ${snr} — ${snrLabel}</span>
        <span style="color:#ffff44;font:10px monospace;">Targets: ${targetCount} | Detected: ${detectedCount}</span>
      </div>
      <div id="rd-viewers-wrap" style="display:flex;flex-wrap:wrap;gap:12px;"></div>`;

    const wrap = document.getElementById('rd-viewers-wrap');
    if (!wrap) return;

    // ── Viewer 1: Interference / Echo Intensity Heatmap ───────
    const hmWrap = document.createElement('div');
    hmWrap.className = 'analysis-viewer';
    hmWrap.innerHTML = `
      <div class="analysis-viewer-label" style="color:#00ff88;">Echo Intensity Map</div>
      <canvas width="260" height="260" id="rd-canvas-heatmap"></canvas>`;
    wrap.appendChild(hmWrap);

    // ── Viewer 2: Polar Beam Profile (scan beam + per-target) ─
    const polarWrap = document.createElement('div');
    polarWrap.className = 'analysis-viewer';
    polarWrap.innerHTML = `
      <div class="analysis-viewer-label" style="color:#00ff88;">Beam Profile (Polar)</div>
      <canvas width="260" height="260" id="rd-canvas-polar"></canvas>`;
    wrap.appendChild(polarWrap);

    // ── Viewer 3: Array Factor vs Angle (linear) ──────────────
    const linWrap = document.createElement('div');
    linWrap.className = 'analysis-viewer';
    linWrap.innerHTML = `
      <div class="analysis-viewer-label" style="color:#00ff88;">Array Factor vs Angle</div>
      <canvas width="320" height="260" id="rd-canvas-linear"></canvas>`;
    wrap.appendChild(linWrap);

    // ── Viewer 4: Window Weight Comparison ────────────────────
    const winWrap = document.createElement('div');
    winWrap.className = 'analysis-viewer';
    winWrap.innerHTML = `
      <div class="analysis-viewer-label" style="color:#00ff88;">Apodization Weights</div>
      <canvas width="260" height="260" id="rd-canvas-window"></canvas>`;
    wrap.appendChild(winWrap);

    // ── Viewer 5: SNR Effect Analysis ─────────────────────────
    const snrWrap = document.createElement('div');
    snrWrap.className = 'analysis-viewer';
    snrWrap.innerHTML = `
      <div class="analysis-viewer-label" style="color:#00ff88;">SNR Effect on Detection</div>
      <canvas width="320" height="260" id="rd-canvas-snr"></canvas>`;
    wrap.appendChild(snrWrap);

    // ── Viewer 6: Beam Width vs Size Accuracy ─────────────────
    const bwWrap = document.createElement('div');
    bwWrap.className = 'analysis-viewer';
    bwWrap.innerHTML = `
      <div class="analysis-viewer-label" style="color:#00ff88;">Beam Width vs Accuracy</div>
      <canvas width="320" height="260" id="rd-canvas-bwaccuracy"></canvas>`;
    wrap.appendChild(bwWrap);

    // Draw all viewers
    this._drawRadarHeatmap(document.getElementById('rd-canvas-heatmap'), rd);
    this._drawRadarBeamPolar(document.getElementById('rd-canvas-polar'), rd);
    this._drawRadarBeamLinear(document.getElementById('rd-canvas-linear'), rd);
    this._drawRadarWindowWeights(document.getElementById('rd-canvas-window'), rd);
    this._drawRadarSNRAnalysis(document.getElementById('rd-canvas-snr'), rd);
    this._drawRadarBWAccuracy(document.getElementById('rd-canvas-bwaccuracy'), rd);
  }

  /**
   * Viewer 1 — Echo Intensity / Interference Map
   * Uses rd.getInterferenceData() from شهد_رادار.js to get the
   * physics-computed constructive/destructive amplitude grid.
   */
  _drawRadarHeatmap(canvas, rd) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;

    // Use the simulator's own interference computation
    const { width: gW, height: gH, cells } = rd.getInterferenceData(80, 60);

    const cellW = W / gW;
    const cellH = H / gH;

    for (let gy = 0; gy < gH; gy++) {
      for (let gx = 0; gx < gW; gx++) {
        const v = cells[gy][gx];   // -1..1 signed field
        const av = Math.abs(v);
        const px = gx * cellW, py = gy * cellH;

        if (v === 0) {
          ctx.fillStyle = '#030a08';
        } else if (v > 0) {
          // Constructive — green glow
          const t = Math.min(1, av / 0.6);
          const r = Math.round(t * 20);
          const g = Math.round(60 + t * 195);
          const b = Math.round(t * 80);
          ctx.fillStyle = `rgb(${r},${g},${b})`;
        } else {
          // Destructive — dim red/orange
          const t = Math.min(1, av / 0.6);
          const r = Math.round(80 + t * 175);
          const g = Math.round(t * 60);
          const b = Math.round(t * 20);
          ctx.fillStyle = `rgb(${r},${g},${b})`;
        }
        ctx.fillRect(px, py, Math.ceil(cellW) + 1, Math.ceil(cellH) + 1);
      }
    }

    // Overlay target blips
    const cx = W / 2, cy = H / 2;
    const { scanRange } = rd.params;
    rd.targets.forEach(target => {
      const tx = cx + (target.x - rd.renderer.width / 2) / scanRange * (W / 2 - 4);
      const ty = cy + (target.y - rd.renderer.height / 2) / scanRange * (H / 2 - 4);
      const recent = target.lastDetected && rd.time - target.lastDetected < 60;
      ctx.beginPath();
      ctx.arc(tx, ty, 5, 0, Math.PI * 2);
      ctx.fillStyle = recent ? '#ffff44' : 'rgba(255,255,100,0.3)';
      ctx.fill();
      if (recent) {
        ctx.beginPath();
        ctx.arc(tx, ty, 10, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,100,0.4)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    });

    // Center mark + scope ring
    ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#00ff88'; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, W / 2 - 4, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(0,200,100,0.3)'; ctx.lineWidth = 1; ctx.stroke();

    // Legend
    ctx.font = '8px monospace'; ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(0,255,100,0.6)';  ctx.fillText('+ constructive', 5, 12);
    ctx.fillStyle = 'rgba(255,100,50,0.6)'; ctx.fillText('- destructive',  5, 22);
  }

  /**
   * Viewer 2 — Polar Beam Profile
   * Uses rd.getBeamProfiles() — returns ONE profile object with
   * points[{angleDeg 0..360, gain}] + pointsRect for comparison.
   */
  _drawRadarBeamPolar(canvas, rd) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#030a08';
    ctx.fillRect(0, 0, W, H);

    const cx = W / 2, cy = H / 2;
    const R = W / 2 - 18;

    // Grid rings
    ctx.strokeStyle = 'rgba(0,150,80,0.18)';
    ctx.lineWidth = 0.5;
    [0.25, 0.5, 0.75, 1].forEach(r => {
      ctx.beginPath(); ctx.arc(cx, cy, R * r, 0, Math.PI * 2); ctx.stroke();
    });
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 6) {
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); ctx.stroke();
    }

    // Get profile (single object, not array)
    const profile = rd.getBeamProfiles(360);
    if (!profile || !profile.points) return;

    const drawCurve = (points, color, lw, alpha) => {
      ctx.beginPath();
      points.forEach((p, i) => {
        const angleRad = (p.angleDeg / 180) * Math.PI;  // 0..360° → 0..2π
        const gain = Math.sqrt(Math.max(0, p.gain));
        const r = gain * R;
        const px = cx + Math.cos(angleRad) * r;
        const py = cy + Math.sin(angleRad) * r;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      });
      ctx.closePath();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.stroke();
      ctx.fillStyle = color.replace(')', ',0.06)').replace('#', 'rgba(').replace('rgba(', 'rgba(').replace('ff88', '255,136,0,').replace('ffff', '255,255,0,');
      ctx.globalAlpha = alpha * 0.12;
      ctx.fill();
      ctx.globalAlpha = 1;
    };

    // Rectangular (no-window) baseline — dim grey
    if (profile.pointsRect) drawCurve(profile.pointsRect, '#aaaaaa', 1, 0.35);
    // Current window — bright green
    drawCurve(profile.points, '#00ff88', 1.8, 1.0);

    // Scan-angle indicator line
    const scanRad = (profile.scanAngleDeg / 180) * Math.PI;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(scanRad) * R, cy + Math.sin(scanRad) * R);
    ctx.strokeStyle = 'rgba(255,255,100,0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    // Angle labels (cardinal)
    ctx.fillStyle = 'rgba(0,200,100,0.45)';
    ctx.font = '8px monospace'; ctx.textAlign = 'center';
    ctx.fillText('0°',    cx,      cy - R - 5);
    ctx.fillText('180°',  cx,      cy + R + 12);
    ctx.fillText('90°',   cx + R + 14, cy + 3);
    ctx.fillText('270°',  cx - R - 14, cy + 3);

    // Legend
    ctx.font = '8px monospace'; ctx.textAlign = 'left';
    ctx.fillStyle = '#00ff88'; ctx.fillText(`${profile.windowType.toUpperCase()} win`, 6, 12);
    ctx.fillStyle = '#888888'; ctx.fillText('Rect (ref)', 6, 22);
    ctx.fillStyle = 'rgba(255,255,100,0.7)'; ctx.fillText(`Scan: ${profile.scanAngleDeg.toFixed(1)}°`, 6, 32);
  }

  /**
   * Viewer 3 — Array Factor vs Angle (0°→360°, linear chart)
   * Shows windowed beam vs rectangular baseline + -3 dB threshold.
   */
  _drawRadarBeamLinear(canvas, rd) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#030a08';
    ctx.fillRect(0, 0, W, H);

    const PAD_L = 38, PAD_R = 12, PAD_T = 14, PAD_B = 30;
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;

    // Grid lines
    ctx.strokeStyle = 'rgba(0,150,80,0.15)';
    ctx.lineWidth = 0.5;
    [0, 0.25, 0.5, 0.75, 1].forEach(v => {
      const y = PAD_T + plotH * (1 - v);
      ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + plotW, y); ctx.stroke();
      ctx.fillStyle = 'rgba(0,200,100,0.4)';
      ctx.font = '8px monospace'; ctx.textAlign = 'right';
      ctx.fillText((v * 100).toFixed(0) + '%', PAD_L - 3, y + 3);
    });
    // X-axis ticks: 0°, 60°, 120°, 180°, 240°, 300°, 360°
    [0, 60, 120, 180, 240, 300, 360].forEach(a => {
      const x = PAD_L + (a / 360) * plotW;
      ctx.strokeStyle = 'rgba(0,150,80,0.1)';
      ctx.beginPath(); ctx.moveTo(x, PAD_T); ctx.lineTo(x, PAD_T + plotH); ctx.stroke();
      ctx.fillStyle = 'rgba(0,200,100,0.35)';
      ctx.font = '8px monospace'; ctx.textAlign = 'center';
      ctx.fillText(a + '°', x, PAD_T + plotH + 14);
    });

    // -3 dB threshold line
    const threshY = PAD_T + plotH * (1 - 0.707);
    ctx.strokeStyle = 'rgba(255,200,50,0.25)';
    ctx.lineWidth = 0.8;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(PAD_L, threshY); ctx.lineTo(PAD_L + plotW, threshY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,200,50,0.45)';
    ctx.font = '8px monospace'; ctx.textAlign = 'left';
    ctx.fillText('−3dB', PAD_L + 2, threshY - 3);

    const profile = rd.getBeamProfiles(360);
    if (!profile || !profile.points) return;

    const drawLine = (points, color, lw, alpha) => {
      ctx.beginPath();
      points.forEach((p, i) => {
        const x = PAD_L + (p.angleDeg / 360) * plotW;
        const gain = Math.sqrt(Math.max(0, p.gain));
        const y = PAD_T + plotH * (1 - gain);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.globalAlpha = alpha;
      ctx.stroke();
      ctx.globalAlpha = 1;
    };

    // Rectangular baseline
    if (profile.pointsRect) drawLine(profile.pointsRect, '#555555', 1, 0.5);
    // Windowed beam
    drawLine(profile.points, '#00ff88', 1.8, 1.0);

    // Scan angle vertical marker
    const scanX = PAD_L + (profile.scanAngleDeg / 360) * plotW;
    ctx.strokeStyle = 'rgba(255,255,100,0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(scanX, PAD_T); ctx.lineTo(scanX, PAD_T + plotH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,100,0.7)';
    ctx.font = '8px monospace'; ctx.textAlign = 'center';
    ctx.fillText(`${profile.scanAngleDeg.toFixed(0)}°`, scanX, PAD_T + 10);

    // Legend
    ctx.font = '8px monospace'; ctx.textAlign = 'left';
    ctx.fillStyle = '#00ff88'; ctx.fillText(`${profile.windowType.toUpperCase()} win`, PAD_L + 2, PAD_T + 12);
    ctx.fillStyle = '#555555'; ctx.fillText('Rect (ref)', PAD_L + 2, PAD_T + 22);

    // Axis label
    ctx.fillStyle = 'rgba(0,200,100,0.45)';
    ctx.font = '8px monospace'; ctx.textAlign = 'center';
    ctx.fillText('Angle (0° → 360°) →', PAD_L + plotW / 2, H - 4);
  }

  /**
   * Viewer 4 — Apodization Window Weights
   * Shows current window function shape (amplitude weights per element)
   * compared to rectangular (no windowing) baseline.
   */
  _drawRadarWindowWeights(canvas, rd) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#030a08';
    ctx.fillRect(0, 0, W, H);

    const PAD = { l: 32, r: 12, t: 24, b: 28 };
    const plotW = W - PAD.l - PAD.r;
    const plotH = H - PAD.t - PAD.b;
    const { numElements, windowType } = rd.params;

    // Grid
    ctx.strokeStyle = 'rgba(0,150,80,0.12)';
    ctx.lineWidth = 0.5;
    [0, 0.25, 0.5, 0.75, 1].forEach(v => {
      const y = PAD.t + plotH * (1 - v);
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(PAD.l + plotW, y); ctx.stroke();
      ctx.fillStyle = 'rgba(0,200,100,0.35)';
      ctx.font = '8px monospace'; ctx.textAlign = 'right';
      ctx.fillText(v.toFixed(2), PAD.l - 3, y + 3);
    });

    // Rectangular baseline (grey dashed)
    ctx.strokeStyle = 'rgba(150,150,150,0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    ctx.moveTo(PAD.l, PAD.t);
    ctx.lineTo(PAD.l + plotW, PAD.t);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(150,150,150,0.35)';
    ctx.font = '8px monospace'; ctx.textAlign = 'right';
    ctx.fillText('Rect', PAD.l + plotW, PAD.t - 4);

    // Current window weights (from simulator's own _applyWindow)
    const weights = rd._applyWindow(numElements, windowType);
    ctx.beginPath();
    weights.forEach((w, i) => {
      const x = PAD.l + (i / (numElements - 1)) * plotW;
      const y = PAD.t + plotH * (1 - w);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = '#00ff88';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Element dots
    weights.forEach((w, i) => {
      const x = PAD.l + (i / (numElements - 1)) * plotW;
      const y = PAD.t + plotH * (1 - w);
      ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#00ff88'; ctx.fill();
    });

    // Title + window name
    ctx.fillStyle = '#00ff88';
    ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center';
    ctx.fillText(`${windowType.toUpperCase()} window  (${numElements} elements)`, W / 2, PAD.t - 8);

    // Axis label
    ctx.fillStyle = 'rgba(0,200,100,0.4)';
    ctx.font = '8px monospace';
    ctx.fillText('Element index →', W / 2, H - 5);

    // Sidelobe suppression info
    const sllMap = { none: '0 dB (no suppression)', hanning: '~32 dB', hamming: '~43 dB', blackman: '~58 dB', kaiser: '~40–80 dB (β-dep.)' };
    ctx.fillStyle = 'rgba(255,200,80,0.6)';
    ctx.font = '8px monospace'; ctx.textAlign = 'left';
    ctx.fillText(`SLL: ${sllMap[windowType] || '—'}`, PAD.l + 2, H - PAD.b + 14);
  }

  /**
   * Viewer 5 — SNR Effect on Detection
   * Shows Det. Probability, False-Alarm Rate, and Position Jitter
   * as functions of SNR (0–1000). Marks the current operating point.
   */
  _drawRadarSNRAnalysis(canvas, rd) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#030a08';
    ctx.fillRect(0, 0, W, H);

    const PAD_L = 38, PAD_R = 12, PAD_T = 20, PAD_B = 30;
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;

    const data = rd.getSNRAnalysis();
    const pts  = data.points;
    const cur  = data.current;

    // Grid
    ctx.strokeStyle = 'rgba(0,150,80,0.12)';
    ctx.lineWidth = 0.5;
    [0, 0.25, 0.5, 0.75, 1].forEach(v => {
      const y = PAD_T + plotH * (1 - v);
      ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + plotW, y); ctx.stroke();
      ctx.fillStyle = 'rgba(0,200,100,0.35)';
      ctx.font = '8px monospace'; ctx.textAlign = 'right';
      ctx.fillText((v * 100).toFixed(0) + '%', PAD_L - 3, y + 3);
    });
    [0, 250, 500, 750, 1000].forEach(snrV => {
      const x = PAD_L + (snrV / 1000) * plotW;
      ctx.strokeStyle = 'rgba(0,150,80,0.08)';
      ctx.beginPath(); ctx.moveTo(x, PAD_T); ctx.lineTo(x, PAD_T + plotH); ctx.stroke();
      ctx.fillStyle = 'rgba(0,200,100,0.3)';
      ctx.font = '8px monospace'; ctx.textAlign = 'center';
      ctx.fillText(snrV, x, PAD_T + plotH + 14);
    });

    const drawCurve = (key, color, scale) => {
      ctx.beginPath();
      pts.forEach((p, i) => {
        const x = PAD_L + (p.snr / 1000) * plotW;
        const v = Math.min(1, p[key] / (scale || 1));
        const y = PAD_T + plotH * (1 - v);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    };

    // Detection probability — green
    drawCurve('detProb', '#00ff88', 1);
    // False alarm rate (scale 0–0.04 → 0–1) — red
    drawCurve('falseRate', '#ff4444', 0.04);
    // Jitter (scale 0–40px → 0–1) — yellow
    drawCurve('jitter', '#ffcc00', 40);

    // Current operating point markers
    const curX = PAD_L + (cur.snr / 1000) * plotW;
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(curX, PAD_T); ctx.lineTo(curX, PAD_T + plotH); ctx.stroke();
    ctx.setLineDash([]);

    const dotY = (val, scale) => PAD_T + plotH * (1 - Math.min(1, val / (scale || 1)));
    [[cur.detProb, 1, '#00ff88'], [cur.falseRate, 0.04, '#ff4444'], [cur.jitter, 40, '#ffcc00']].forEach(([val, sc, col]) => {
      ctx.beginPath(); ctx.arc(curX, dotY(val, sc), 4, 0, Math.PI * 2);
      ctx.fillStyle = col; ctx.fill();
    });

    // SNR quality label at marker
    ctx.fillStyle = cur.snr >= 700 ? '#00ff88' : cur.snr >= 400 ? '#ffcc00' : '#ff4444';
    ctx.font = '8px monospace'; ctx.textAlign = 'center';
    ctx.fillText(cur.quality, curX, PAD_T - 5);

    // Legend
    ctx.font = '8px monospace'; ctx.textAlign = 'left';
    ctx.fillStyle = '#00ff88'; ctx.fillText('Det. Prob.', PAD_L + 2, PAD_T + 10);
    ctx.fillStyle = '#ff4444'; ctx.fillText('False Alarm ×25', PAD_L + 65, PAD_T + 10);
    ctx.fillStyle = '#ffcc00'; ctx.fillText('Jitter/40px', PAD_L + 180, PAD_T + 10);

    // Axis label
    ctx.fillStyle = 'rgba(0,200,100,0.4)';
    ctx.textAlign = 'center';
    ctx.fillText('SNR (0 → 1000) →', PAD_L + plotW / 2, H - 4);
  }

  /**
   * Viewer 6 — Beam Width vs Size-Estimation Accuracy
   * Curve shows how error % changes with beam width.
   * Vertical marker = current effective BW. Per-target accuracy shown.
   */
  _drawRadarBWAccuracy(canvas, rd) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#030a08';
    ctx.fillRect(0, 0, W, H);

    const PAD_L = 40, PAD_R = 12, PAD_T = 20, PAD_B = 30;
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;

    const bwData = rd.getBeamWidthAccuracyData();
    const { widthCurve, currentBw, targetStats, scenario } = bwData;
    const maxBW = 20, maxErr = 200;

    // Grid
    ctx.strokeStyle = 'rgba(0,150,80,0.12)';
    ctx.lineWidth = 0.5;
    [0, 0.25, 0.5, 0.75, 1].forEach(v => {
      const y = PAD_T + plotH * (1 - v);
      ctx.beginPath(); ctx.moveTo(PAD_L, y); ctx.lineTo(PAD_L + plotW, y); ctx.stroke();
      ctx.fillStyle = 'rgba(0,200,100,0.35)';
      ctx.font = '8px monospace'; ctx.textAlign = 'right';
      ctx.fillText((v * maxErr).toFixed(0) + '%', PAD_L - 3, y + 3);
    });
    [0, 5, 10, 15, 20].forEach(bw => {
      const x = PAD_L + (bw / maxBW) * plotW;
      ctx.strokeStyle = 'rgba(0,150,80,0.08)';
      ctx.beginPath(); ctx.moveTo(x, PAD_T); ctx.lineTo(x, PAD_T + plotH); ctx.stroke();
      ctx.fillStyle = 'rgba(0,200,100,0.3)';
      ctx.font = '8px monospace'; ctx.textAlign = 'center';
      ctx.fillText(bw + '°', x, PAD_T + plotH + 14);
    });

    // Error curve — gradient: green (narrow/accurate) → red (wide/rough)
    ctx.beginPath();
    widthCurve.forEach((p, i) => {
      const x = PAD_L + (p.bwDeg / maxBW) * plotW;
      const y = PAD_T + plotH * (1 - Math.min(1, p.sizeErrPct / maxErr));
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    const grad = ctx.createLinearGradient(PAD_L, 0, PAD_L + plotW, 0);
    grad.addColorStop(0,   '#00ff88');
    grad.addColorStop(0.4, '#ffcc00');
    grad.addColorStop(1,   '#ff4444');
    ctx.strokeStyle = grad;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Current BW marker
    const curX = PAD_L + (Math.min(currentBw, maxBW) / maxBW) * plotW;
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(curX, PAD_T); ctx.lineTo(curX, PAD_T + plotH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = currentBw < 4 ? '#00ff88' : currentBw > 8 ? '#ff4444' : '#ffcc00';
    ctx.font = '8px monospace'; ctx.textAlign = 'center';
    ctx.fillText(`${currentBw.toFixed(1)}°`, curX, PAD_T - 5);

    // Per-target dots (if any)
    targetStats.forEach((t, i) => {
      if (!t.detected || t.errPct === undefined) return;
      const x = PAD_L + (Math.min(currentBw, maxBW) / maxBW) * plotW + (i - targetStats.length / 2) * 6;
      const y = PAD_T + plotH * (1 - Math.min(1, t.errPct / maxErr));
      ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = t.errPct < 20 ? '#00ff88' : t.errPct < 60 ? '#ffcc00' : '#ff4444';
      ctx.fill();
      ctx.fillStyle = '#000';
      ctx.font = 'bold 7px monospace'; ctx.textAlign = 'center';
      ctx.fillText(t.label, x, y + 3);
    });

    // Scenario description
    ctx.fillStyle = 'rgba(200,230,255,0.55)';
    ctx.font = '8px monospace'; ctx.textAlign = 'center';
    ctx.fillText(scenario, PAD_L + plotW / 2, PAD_T + 10);

    // Axis labels
    ctx.fillStyle = 'rgba(0,200,100,0.4)';
    ctx.textAlign = 'center';
    ctx.fillText('Effective Beam Width (°) →', PAD_L + plotW / 2, H - 4);
    ctx.save();
    ctx.translate(10, PAD_T + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Size Error %', 0, 0);
    ctx.restore();
  }

  // ── Private: scenario panel ───────────────────────────────────

  async _buildScenarioList(modeName) {
    const list = document.getElementById('scenario-list');
    if (!list) return;
    list.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:4px 0">Loading…</div>';

    // getByMode may be sync (before api-client patch) or async (after patch)
    // Await handles both cases safely
    let scenarios = {};
    try {
      const result = ScenarioManager.getByMode(modeName);
      scenarios = (result && typeof result.then === 'function') ? await result : result;
    } catch (e) {
      console.warn('ScenarioManager.getByMode error:', e);
    }
    list.innerHTML = '';

    Object.entries(scenarios).forEach(([key, s]) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative;margin-bottom:3px';

      const btn = document.createElement('button');
      btn.className = 'scenario-btn';
      const isCustom = !!s.custom;
      btn.innerHTML = `<strong>${s.name}${isCustom ? ' ✎' : ''}</strong><span>${s.description}</span>`;
      btn.style.paddingRight = isCustom ? '30px' : '';
      btn.addEventListener('click', () => {
        list.querySelectorAll('.scenario-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this._loadScenario(key, modeName);
      });
      wrap.appendChild(btn);

      if (isCustom) {
        const del = document.createElement('button');
        del.title = 'Delete scenario';
        del.textContent = '✕';
        del.style.cssText = 'position:absolute;top:50%;right:6px;transform:translateY(-50%);background:rgba(255,60,60,0.1);border:1px solid rgba(255,60,60,0.25);color:#ff6666;border-radius:3px;width:18px;height:18px;cursor:pointer;font-size:10px;display:flex;align-items:center;justify-content:center;padding:0;font-family:monospace;line-height:1';
        del.addEventListener('click', async e => {
          e.stopPropagation();
          if (confirm(`Delete "${s.name}"?`)) {
            await ScenarioManager.remove(key);
            this._buildScenarioList(modeName);
            showToast('🗑 Scenario deleted');
          }
        });
        wrap.appendChild(del);
      }
      list.appendChild(wrap);
    });
  }

  async _loadScenario(key, modeName) {
    const scenario = await ScenarioManager.loadAsync(key);
    if (!scenario) { showToast('⚠️ Scenario not found'); return; }

    if (modeName === 'beamforming') {
      this.#sims.beamforming?.setParams(scenario.params);
    }
    if (modeName === 'ultrasound') {
      this.#sims.ultrasound?.setParams(scenario.params);
    } else if (modeName === 'fiveg') {
      this.#sims.fiveg?._applyScenario(scenario);
    } else if (modeName === 'radar') {
      const p = { ...scenario.params };
      if (p.beamWidth !== undefined && p.beamWidthDeg === undefined) {
        p.beamWidthDeg = p.beamWidth; delete p.beamWidth;
      }
      this.#sims.radar?.setParams(p);
      if (scenario.params.targets) {
        this.#sims.radar.clearTargets();
        scenario.params.targets.forEach(t => this.#sims.radar.addTarget(t));
      }
      // Update UI sliders so they match the loaded scenario
      if (p.numElements !== undefined) _setSliderVal('rd-elements', p.numElements, '');
      if (p.beamWidthDeg !== undefined) _setSliderVal('rd-bw', p.beamWidthDeg, '°');
      if (p.scanSpeed !== undefined) _setSliderVal('rd-speed', p.scanSpeed, 'rad/s');
      if (p.scanRange !== undefined) _setSliderVal('rd-range', p.scanRange, 'px');
      if (p.frequency !== undefined) _setSliderVal('rd-freq', p.frequency / 1e9, 'GHz');
      if (p.snr !== undefined) _setSliderVal('rd-snr', p.snr, '');
    }
    showToast(`📂 Loaded: ${scenario.name}`);
  }
}

// ============================================================
// MODULE-PRIVATE UI HELPERS
// ============================================================

function _slider(id, label, min, max, def, step, unit = '') {
  const vid = `${id}-val`;
  const disp = step < 1 ? parseFloat(def).toFixed(1) : def;
  return `
    <div class="ctrl-group">
      <div class="ctrl-row">
        <label class="ctrl-label" for="${id}">${label}</label>
        <span class="ctrl-val" id="${vid}">${disp}${unit}</span>
      </div>
      <input type="range" class="ctrl-slider" id="${id}"
             min="${min}" max="${max}" value="${def}" step="${step}">
    </div>`;
}

function _toggle(id, label, defaultOn) {
  return `
    <label class="toggle-item">
      <input type="checkbox" id="${id}" ${defaultOn ? 'checked' : ''}>
      <span class="toggle-track"><span class="toggle-thumb"></span></span>
      <span class="toggle-label">${label}</span>
    </label>`;
}

function _bindSlider(id, cb) {
  const el = document.getElementById(id);
  const valEl = document.getElementById(`${id}-val`);
  if (!el) return;
  el.addEventListener('input', () => {
    cb(el.value);
    if (valEl) {
      const decimals = parseFloat(el.step) < 1 ? 1 : 0;
      const unit = valEl.textContent.replace(/[\d.\-]/g, '');
      valEl.textContent = parseFloat(el.value).toFixed(decimals) + unit;
    }
  });
}

function _setSliderVal(id, val, unit = '') {
  const el = document.getElementById(id);
  const valEl = document.getElementById(`${id}-val`);
  if (el) el.value = val;
  if (valEl) valEl.textContent = val + unit;
}

function _bindToggle(id, cb) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('change', () => cb(el.checked));
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('show'), 2500);
}


// ── Boot ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  window._app = new BeamformingApp();
  window._app.switchMode('ultrasound');
});