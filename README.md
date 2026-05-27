# BEAMFORM — Multi-Domain Phased Array Simulator

> A real-time 2D simulator for **ultrasound imaging**, **5G beamforming**, and **radar detection** — built on unified phased array physics.

![BEAMFORM Home](Beam%20Images/Home%20page/home.png)

---

## 📋 Overview

**BEAMFORM** is a multi-purpose simulator that combines advanced physics with interactive graphics for deep understanding of phased array systems across 4 specialized modes:

- 🌊 **Generic Beamforming** — Interactive interference field, Cartesian & polar beam profiles
- 🔊 **Ultrasound** — Medical ultrasound imaging with realistic Shepp-Logan phantom
- 📡 **5G Beamforming** — Multi-tower network with massive MIMO and handover logic
- 🎯 **Radar** — Phased array radar with dynamic target tracking and PPI display

![Application Modes](Beam%20Images/Home%20page/application%20modes.png)

![Live Preview](Beam%20Images/Home%20page/stimulator.png)

---

## 📁 Project Structure

```
beamform/
├── app.py                      # Flask backend server
├── requirements.txt
├── data/
│   └── scenarios.json          # Saved scenarios (auto-created)
└── frontend/
    ├── index.html              # Landing page
    ├── simulator.html          # Main simulator UI
    ├── sim.css                 # Unified styling
    │
    ├── app.js                  # Main application manager
    ├── renderer.js             # 2D/3D rendering engine
    ├── physics.js              # General physics engine
    ├── system.js               # System management
    │
    ├── beamforming.js          # Core beamforming engine
    ├── entities.js             # Data objects
    │
    ├── radar.js                # 🎯 Radar mode
    ├── ultrasound.js           # 🔊 Ultrasound mode
    ├── fiveg.js                # 📡 5G mode
    │
    ├── api-client.js           # HTTP client
    └── scenarios.js            # Scenario manager
```

---

## 🔌 REST API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check |
| `GET` | `/api/scenarios` | List all saved scenarios |
| `GET` | `/api/scenarios/<key>` | Get a specific scenario |
| `POST` | `/api/scenarios` | Save a scenario |
| `DELETE` | `/api/scenarios/<key>` | Delete a scenario |
| `POST` | `/api/physics/beam-pattern` | Compute beam pattern (360 points) |
| `POST` | `/api/physics/steering-delays` | Compute steering delays |
| `POST` | `/api/physics/focusing-delays` | Compute focusing delays |
| `GET` | `/api/physics/window` | Get apodization weights |

---

## 📡 Simulation Modes

### 🌊 Generic Beamforming — `beamforming.js`

Phased array theory with 3 synchronized interactive visualizations.

![Generic Beamforming Mode](Beam%20Images/Generic%20mode/Generic%20Mode.png)

**Three Synchronized Views:**
1. **2D Interference Field** (55% height) — Colored radiation field, main & sidelobes
2. **Cartesian Beam Profile** (bottom left) — dB scale (-70 to 0), beamwidth readout
3. **Polar Radiation Pattern** (bottom right) — Classic polar plot with circular lobes

**Design Parameters:**

| Parameter | Range | Description |
|-----------|-------|-------------|
| `numElements` | 2–256 | Number of elements |
| `spacing` | 0.1–2.0 | Relative spacing (d/λ) |
| `frequency` | 100 MHz–100 GHz | Operating frequency |
| `steerAngle` | −90 to 90° | Beam steering angle |
| `windowType` | none/hamming/hanning/blackman/kaiser | Apodization window |
| `kaiserBeta` | 1–20 | Kaiser window parameter |

**Key Equations:**
```
Wave Vector:       k = 2π/λ = 2πf/c
Phase Progression: Δφ = k·d·sin(θ_steer)
Field at Point:    E(r) = Σ wₙ · (A/√r) · cos(k·r - n·Δφ + φ₀)
Main Lobe Width:   BW₋₃dB ≈ 0.886λ / (d·N·cos(θ))
```

**Available Windows:**

| Window | SLL Suppression | Use Case |
|--------|-----------------|----------|
| **None** | 13 dB | Theoretical ideal |
| **Hamming** | 43 dB | General purpose |
| **Hanning** | 32 dB | General purpose |
| **Blackman** | 58 dB | High performance |
| **Kaiser** | 30–120 dB | Research / adjustable |

**Window Comparison — Same Array (N=99, f=2.7 GHz):**

| Rect (No Window) | Hamming |
|:---:|:---:|
| ![Rect](Beam%20Images/Generic%20mode/Rect.png) | ![Hamming](Beam%20Images/Generic%20mode/Hamm.png) |
| **Hanning** | **Blackman** |
| ![Hanning](Beam%20Images/Generic%20mode/Hann.png) | ![Blackman](Beam%20Images/Generic%20mode/black.png) |

**Kaiser (β = 6.0) — Tradeoff between Rect and Blackman:**

![Kaiser](Beam%20Images/Generic%20mode/kaiser.png)

---

### 🎯 Radar Simulator — `radar.js`

Professional radar simulation with phased array and accurate physics modeling.

**Key Features:**
- ✅ **Dynamic Detection** — Detection probability linked to SNR
- ✅ **Smart Tracking** — Automatic target tracking mode
- ✅ **Target Management** — Add / delete / drag targets with mouse
- ✅ **Noise Modeling** — False alarms at low SNR
- ✅ **PPI Display** — Classic phosphor sweep with echo persistence

![Radar Mode](Beam%20Images/Radar%20mode/Radar.png)

**Tracking Mode** — beam locks onto a selected target and follows it continuously instead of full 360° scan:

![Track in Radar](Beam%20Images/Radar%20mode/Track%20in%20radar.png)

![Radar Beam Analysis](Beam%20Images/Radar%20mode/Radar%20Beam%20Analysis.png)

**Simulation Parameters:**

| Parameter | Range | Description |
|-----------|-------|-------------|
| `numElements` | 1–128 | Array elements |
| `frequency` | 1–100 GHz | Operating frequency (C/X/Ku band) |
| `scanSpeed` | 0.1–2.0 rad/s | Rotation / steering speed |
| `scanRange` | 50–500 m | Maximum scan range |
| `beamWidthDeg` | 1–15° | Main lobe width |
| `snr` | 0–1000 | Signal-to-Noise ratio |
| `windowType` | none/hamming/hanning/blackman/kaiser | Apodization |
| `trackingMode` | true/false | Enable auto-tracking |

**Physics Equations:**
```
Detection Probability: P_det = (SNR/100)^1.8
False Alarm Rate:      P_fa ∝ max(0, 40 - SNR)
Effective Beam Width:  BW_eff = BW_base × Window_factor
```

**User Interaction:**
- 🖱️ **Left-click scope** — Add target
- 🖱️ **Drag** — Move target
- ⌨️ **Delete** — Remove selected target
- 🎛️ **Sliders** — Real-time parameter adjustment

---

### 🔊 Ultrasound Simulator — `ultrasound.js`

Medical ultrasound simulation with realistic tissue phantom (Shepp-Logan).

![Ultrasound Mode](Beam%20Images/Ultrasound%20mode/ultrasound.png)

#### Interference Field (Beam Mode)

The **Beam mode** renders the raw acoustic interference field produced by the phased array probe in real time. This is the foundational view that shows exactly how the wavefronts from each element combine:

- **Constructive interference** along the steering direction forms the main lobe — a bright focused beam
- **Destructive interference** on either side creates the characteristic dark nulls between sidelobes
- The **focal point** (orange dot) marks where all element delays converge — maximum pressure concentration
- Dragging the canvas steers the beam laterally; the focal depth slider moves the convergence point axially

![interference](Beam%20Images/Ultrasound%20mode/interference.png)

The interference pattern is computed element-by-element using:
```
Pressure at point P:  p(P) = Σ wₙ · (1/√r_n) · cos(k·r_n - ω·τ_n)
Steering delay:       τ_n = (n·d·sin θ) / c
Focusing delay:       τ_n = (max(dist) - dist_n) / c
```
Where `wₙ` = apodization weight, `r_n` = distance from element n to point P, `τ_n` = applied time delay.

**Scanning Modes:**

| Mode | Dimensions | FPS | Clinical Use |
|------|-----------|-----|--------------|
| **Beam** | Interference field | 60 | Teaching / visualization |
| **A-Mode** | 1D | 60 | Quick distance measurement |
| **B-Mode** | 2D | 10 | Full tissue cross-section |
| **Doppler** | 2D + Time | 30 | Blood flow & vessels |

#### A-Mode (Amplitude Mode)

Displays echo amplitude vs depth along a single beam line — the simplest and fastest scan mode.

- X-axis = depth (mm), Y-axis = echo amplitude (0–1)
- Two traces rendered simultaneously: **RF signal** (raw) and **Log envelope** (processed)
- Each peak corresponds to a tissue interface; peak height reflects impedance mismatch
- Useful for measuring exact distances to structures (e.g. skull thickness, lesion depth)

![A-Mode](Beam%20Images/Ultrasound%20mode/A%20mode.png)

#### B-Mode (Brightness Mode)

Sweeps the beam across the full aperture to reconstruct a 2D grayscale cross-section of the phantom.

- Supports both **linear probe** (rectangular FOV) and **curved probe** (wide-angle sector)
- Pixel brightness encodes echo intensity after attenuation correction
- Rendered at ~10 FPS to allow real-time steering & focusing updates

**Linear probe:**

![B-Mode Linear Probe](Beam%20Images/Ultrasound%20mode/B%20mode%20of%20linear%20probe.png)

**Curved probe:**

![B-Mode Curved Probe](Beam%20Images/Ultrasound%20mode/B%20mode%20of%20curved%20probe.png)

#### Doppler Mode

Measures blood flow velocity using the frequency shift of the returning echo from the moving vessel.

- Left panel: phantom view with beam steered toward the blood vessel (orange dot = sample gate)
- Top right: **Doppler Power Spectrum** — frequency shift peak in kHz
- Bottom right: **Pulsatile Waterfall** — scrolling time–frequency display at 60 BPM showing pulsatile cardiac rhythm

```
Doppler Shift: f_d = (2 · v · cos θ) / c × f₀
```
Where `v` = blood velocity, `θ` = beam–vessel angle, `c` = 1540 m/s, `f₀` = probe frequency.

![Doppler Mode](Beam%20Images/Ultrasound%20mode/doppler%20effect.png)

**Shepp-Logan Phantom (Key Tissues):**

| Tissue | Impedance (MRayl) | Speed (m/s) | Notes |
|--------|-------------------|-------------|-------|
| **Skull** | 7.8 | 3500 | Strong reflector |
| **Brain** | 1.62 | 1560 | Base tissue |
| **Lesion** | 1.70 | 1570 | 🔴 Diagnostic indicator |
| **Calcification** | 7.0 | 3000 | High reflectivity |
| **Blood Vessel** | 1.61 | 1570 | Dynamic (Doppler) |

**Focusing & Steering Parameters:**

| Parameter | Range | Description |
|-----------|-------|-------------|
| `numElements` | 1–64 | Probe elements |
| `frequency` | 2–15 MHz | Operating frequency |
| `spacing` | 0.5–3.0 mm | Element pitch |
| `arrayType` | linear / curved | Probe geometry |
| `steerAngle` | −60 to 60° | Lateral steering |
| `focalDepth` | 1–500 mm | Dynamic focal depth |
| `apodization` | none/hanning/hamming/kaiser | Window function |
| `bloodVelocity` | 0–2 m/s | Blood flow speed (Doppler) |

**Acoustic Physics:**
```
Impedance:            Z = ρ × c
Reflection:           R = (Z₂ - Z₁) / (Z₂ + Z₁)
Attenuation:          A(f,d) = e^(-2αfd)
Doppler Shift:        f_d = (2v·cos θ / c) × f₀
```

---

### 📡 5G Beamforming Simulator — `fiveg.js`

5G cellular network simulation with multiple towers and mobile users.

![5G Beamforming Mode](Beam%20Images/5G%20mode/5G%20mode.png)

![5G Tower Detail](Beam%20Images/5G%20mode/scenario%203.png)

**Key Features:**
- ✅ **Massive MIMO** — Up to 256 elements per tower
- ✅ **Beam Steering** — Per-user efficient steering
- ✅ **Handover Logic** — Smart tower switching with hysteresis
- ✅ **Coverage Maps** — Real-time signal quality visualization
- ✅ **mmWave** — 28–39 GHz simulation

**Tower Parameters:**

| Parameter | Range | Description |
|-----------|-------|-------------|
| `numElements` | 4–256 | MIMO array size |
| `frequency` | 10–100 GHz | Operating frequency |
| `range` | 50–1000 m | Maximum coverage range |
| `snr` | 0–1000 | Signal quality |

**Signal Model:**
```
Signal Quality:      Q(d) = (1 - d/R) × SNR_factor × Steering_gain
Handover Threshold:  Th = (1 - SNR_normalized) × 0.6
```

**UI Interaction:**
- 🖱️ **Add Tower** — Press "Add Tower" then click map
- 🖱️ **Add User** — Press "Add User" then click map
- 🖱️ **Move Objects** — Drag towers or users
- 🗑️ **Delete** — Press Delete on selected object

---

#### 🗼 Tower Control Panel

Each tower is independently configurable. Click any tower to open its control panel:

![Tower Control](Beam%20Images/5G%20mode/tower%20control.png)

| Parameter | Description |
|-----------|-------------|
| **Antenna Elements** | Number of MIMO elements — more elements = narrower, sharper beam |
| **Frequency** | Operating frequency; coverage range scales inversely with frequency |
| **SNR** | Signal quality budget for this tower |
| **Coverage Range** | Maximum radius the tower serves |
| **Apodization Window** | None / Hanning / Hamming / Blackman — controls beam sidelobe suppression |

---

#### 👤 User Controls & Display Options

![User Control](Beam%20Images/5G%20mode/user%20control%20.png)

The sidebar controls let you manage the full simulation layout:

- **Add Tower (T)** / **Add User (U)** — keyboard shortcuts for fast placement
- **Remove Selected (Shift+Click)** — remove any tower or user
- **Move Selected User** — D-pad for precise user repositioning
- **Display toggles** — Show/hide Beams, Coverage Area, Antenna Elements, Tower Info Boxes
- **Analysis View** — opens the per-tower beam analysis panel (see below)

---

#### 📊 5G Analysis View — Beam Analysis Panel

Clicking **"Analysis View"** opens a dedicated **Beam Analysis** modal for the selected tower. It provides four synchronized visualizations that together give a complete picture of the tower's radiation behavior:

<<<<<<< HEAD
![5G Analysis](Beam%20Images/5G%20mode/5G%20Analysis.png)
=======
![5G Analysis](Beam%20Images/5G%20mode/5GAnalysis%20.png)
>>>>>>> 7d9e33437bc7dc269118697a641e5f09d70fa43b

---

##### 🗺️ 2D Interference Map (Top Left)

A top-down spatial heatmap showing the full interference field radiated from the tower across the coverage area.

- **Cyan/white regions** — constructive interference zones where signal adds up coherently (main lobe + sidelobes)
- **Dark regions** — destructive interference nulls where signals cancel out
- The **yellow dot** marks the tower position (phase center of the array)
- The **red dot** marks the steered user location — the beam is maximally focused toward it
- The circular boundary represents the tower's configured **coverage range**
- The fan-shaped bright wedge pointing toward the user is the **main beam**; the narrower faint lines on either side are **sidelobes**

> This view shows *where* the energy goes in 2D space — useful for spotting interference hotspots and null zones.

---

##### 📡 Beam Profile — Polar Pattern (Top Right)

A polar (rose) diagram showing radiated gain as a function of angle, from −90° to +90°.

- The **sharp central peak** (at 0° axis) represents the **main lobe** — the direction of maximum gain where the beam is steered
- The **symmetric side wings** are **sidelobes** — lower-amplitude secondary radiation that cannot be fully eliminated
- The plot uses a **linear amplitude scale** (not dB), so the main lobe is visually dominant
- **Beamwidth** is annotated (e.g., `BW 6.3°`) — the angular width between the −3 dB half-power points
- The pattern is rendered in **cyan** against a dark polar grid for clarity

> A narrow beamwidth means higher spatial selectivity — the tower can precisely target a user while minimizing interference to neighbors.

---

##### 📈 Array Factor vs Angle — AF Plot (Bottom Left)

A Cartesian line chart plotting the **Array Factor (AF)** — the normalized beamforming gain — as a continuous function of steering angle from −90° to +90°.

- **Y-axis**: Amplitude from 0% to 100% (normalized to peak = 1)
- **X-axis**: Angle in degrees
- The **tall central spike** is the main lobe peak, reaching 100% at the steered direction (dashed line)
- The **oscillating ripples** on both sides are sidelobes — their number and amplitude depend on the element count and apodization window
- More antenna elements → narrower spike, lower sidelobes
- A dashed vertical line marks the exact **steering angle** for quick reference

> This is the most precise view for reading exact beamwidth and sidelobe levels (SLL) numerically.

---

##### 🌈 Field Map — Constructive/Destructive Heatmap (Bottom Right)

A fan-shaped 2D false-color map showing the signed interference pattern — distinguishing constructive from destructive zones with a diverging color scale.

- **Blue/cyan tones** — constructive interference (signals add, field is positive)
- **Orange/amber tones** — destructive interference (signals cancel, field is negative)
- **White** — transition zone near zero crossing
- The radiating fan shape traces the beam from the tower outward across the coverage sector
- Individual antenna element positions are shown as **white dots** along the bottom arc
- The bright central white streak is the **main lobe axis**; the alternating color bands on either side are successive sidelobe peaks and nulls

> Unlike the interference map, this view encodes **phase sign** — it reveals the full wave structure of the field, not just amplitude intensity.

---

##### 📋 Per-User Signal Table

Below the header, each active user connected to this tower is listed with real-time metrics:

| Field | Description |
|-------|-------------|
| **θ (angle)** | Current beam steering angle toward the user (degrees) |
| **Δφ (phase step)** | Inter-element phase increment applied (radians) |
| **SNR** | Effective signal-to-noise ratio at the user location |
| **Sig %** | Signal strength as a percentage of maximum |
| **Bar indicator** | Visual signal quality bar — green = strong, red = weak |

The tower simultaneously maintains **independent beams** for each user, each with its own steering angle and phase progression — this is the core of **Massive MIMO** spatial multiplexing.

---

#### 📋 Predefined Scenarios

![5G Scenarios](Beam%20Images/5G%20mode/5G%20scenarios.png)

| Scenario | Description |
|----------|-------------|
| **Urban Dense Deployment** | Three towers with overlapping coverage — models a dense city block with handover zones |
| **Single Tower Multi-User** | One base station steering multiple simultaneous beams — demonstrates spatial multiplexing |
| **Handover Scenario** | Two towers at coverage boundary — user crosses from one cell to another triggering handover logic |

---

## 🔧 Shared Parameters Across All Modes

```javascript
// Array Configuration
numElements    // Number of elements (1–256)
spacing        // d/λ relative spacing
frequency      // Hz (actual frequency)
arrayType      // 'linear' | 'curved' (ultrasound only)

// Signal Processing
windowType     // Apodization: none/hamming/hanning/blackman/kaiser
kaiserBeta     // Kaiser parameter (1–20)
steerAngle     // Steering angle (°)
phase          // Global phase offset (°)
amplitude      // Gain (0–1)

// Performance
snr            // Signal-to-noise ratio (0–1000)
txPower        // Transmit power (dBm)
range          // Maximum range (meters)
```

---

## 💾 Scenario System

Save and restore complete configurations via the UI or API.

**Storage:** `data/scenarios.json` (auto-created)

**Example structure:**
```json
{
  "radar_urban": {
    "mode": "radar",
    "name": "Urban Scan",
    "params": {
      "numElements": 32,
      "frequency": 9e9,
      "scanSpeed": 0.8,
      "snr": 100,
      "trackingMode": true
    }
  },
  "ultrasound_cardiac": {
    "mode": "ultrasound",
    "name": "Cardiac Imaging",
    "params": {
      "arrayType": "curved",
      "frequency": 3.5e6,
      "focalDepth": 80,
      "snr": 60
    }
  }
}
```

---

## 🚀 Quick Start

### Requirements
- **Python** 3.8+
- **Modern browser** (Chrome, Firefox, Edge)

### Installation & Run

```bash
# 1. Install dependencies
pip install -r requirements.txt

# 2. Start the server
python app.py

# 3. Open browser
# Navigate to: http://localhost:5000
```

---

## 🏗️ Architecture

### Backend (Flask)
```
┌─────────────────────────────────────┐
│  Flask Application (app.py)         │
├─────────────────────────────────────┤
│  • Static File Server               │
│  • REST API (Scenarios + Physics)   │
│  • CORS Middleware                  │
│  • JSON Storage (data/scenarios.json)│
└─────────────────────────────────────┘
```

### Frontend (JavaScript MVC)
```
┌──────────────────────────────────────────┐
│         Application Layer (app.js)       │
├──────────────────────────────────────────┤
│  ┌─────────────┬──────────────┬────────┐ │
│  │   Radar     │  Ultrasound  │  5G    │ │
│  │  Simulator  │  Simulator   │  Sim   │ │
│  └─────────────┴──────────────┴────────┘ │
│           ↓ extends BaseSimulator        │
├──────────────────────────────────────────┤
│         Physics Layer (physics.js)       │
│  • Beamforming Engine                    │
│  • Wave Propagation                      │
│  • Signal Processing                     │
├──────────────────────────────────────────┤
│       Rendering Layer (renderer.js)      │
│  • Canvas 2D Drawing                     │
│  • HeatMaps                              │
│  • Real-time Visualization               │
└──────────────────────────────────────────┘
```

---

## 🎮 Advanced Usage Tips

**Generic Beamforming:**
- Start with `spacing = 0.5` as baseline
- Hamming window is a safe default
- Watch polar and Cartesian together for full understanding

**Radar:**
- Set `SNR ≥ 100` for reliable detection
- Enable Tracking Mode for moving targets
- Lower SNR → more false alarms (realistic noise)

**Ultrasound:**
- Use 3–5 MHz for deep tissue imaging
- Set `focalDepth` to half the distance to target
- Kaiser apodization for highest precision

**5G:**
- Place towers in equilateral triangle for uniform coverage
- Use 28–39 GHz for mmWave simulation
- 256 elements gives very sharp beam steering

---

## 📄 License

This project is open source.
