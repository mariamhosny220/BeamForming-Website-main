"""
BEAMFORM — Backend (Flask)
===========================
تشغيل:
    pip install flask flask-cors
    python app.py

افتح المتصفح على: http://localhost:5000
"""

import json
import math
import os
import time
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS

# ── مسارات المشروع ────────────────────────────────────────────
BASE_DIR       = Path(__file__).parent          # مكان app.py
FRONTEND_DIR   = BASE_DIR / "frontend"          # مجلد الفرونت اند
DATA_DIR       = BASE_DIR / "data"              # مجلد البيانات
SCENARIOS_FILE = DATA_DIR / "scenarios.json"    # ملف السيناريوهات

DATA_DIR.mkdir(exist_ok=True)

app = Flask(__name__)
CORS(app)

# ═══════════════════════════════════════════════════════════════
# Helpers — Scenarios
# ═══════════════════════════════════════════════════════════════

def load_scenarios() -> dict:
    try:
        if SCENARIOS_FILE.exists():
            return json.loads(SCENARIOS_FILE.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}


def save_scenarios(data: dict):
    SCENARIOS_FILE.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
    )


# ═══════════════════════════════════════════════════════════════
# Helpers — Physics
# ═══════════════════════════════════════════════════════════════

def _bessel_i0(x: float) -> float:
    s, t = 1.0, 1.0
    for k in range(1, 21):
        t *= (x / 2 / k) ** 2
        s += t
    return s


def _window(n: int, window_type: str, kaiser_beta: float) -> list:
    N = n - 1 or 1
    out = []
    for i in range(n):
        if window_type == "hanning":
            w = 0.5 - 0.5 * math.cos(2 * math.pi * i / N)
        elif window_type == "hamming":
            w = 0.54 - 0.46 * math.cos(2 * math.pi * i / N)
        elif window_type == "blackman":
            w = (0.42
                 - 0.5  * math.cos(2 * math.pi * i / N)
                 + 0.08 * math.cos(4 * math.pi * i / N))
        elif window_type == "kaiser":
            r = 2 * i / N - 1
            w = _bessel_i0(kaiser_beta * math.sqrt(max(0.0, 1 - r**2))) / _bessel_i0(kaiser_beta)
        else:
            w = 1.0
        out.append(w)
    return out


def _beam_pattern(num_el, spacing, freq, steer=0.0,
                  win="hamming", beta=6.0, speed=3e8) -> list:
    lam     = speed / freq
    d       = spacing * lam
    weights = _window(num_el, win, beta)
    out = []
    for i in range(360):
        theta = (i / 360) * 2 * math.pi - math.pi
        re = im = 0.0
        for n in range(num_el):
            ph = (2 * math.pi * d / lam) * n * (math.sin(theta) - math.sin(steer))
            re += weights[n] * math.cos(ph)
            im += weights[n] * math.sin(ph)
        out.append(math.sqrt(re**2 + im**2) / num_el)
    return out


def _steering_delays(positions, steer, speed=1540.0) -> list:
    dx, dy = math.sin(steer), math.cos(steer)
    projs  = [p["x"] * dx + p["y"] * dy for p in positions]
    mx     = max(projs)
    return [(mx - p) / speed for p in projs]


def _focusing_delays(positions, focal, speed=1540.0) -> list:
    fx, fy = focal["x"], focal["y"]
    dists  = [math.hypot(p["x"] - fx, p["y"] - fy) for p in positions]
    mx     = max(dists)
    return [(mx - d) / speed for d in dists]


# ═══════════════════════════════════════════════════════════════
# Frontend — بيخدم كل ملفات الـ frontend/
# ═══════════════════════════════════════════════════════════════

@app.route("/")
def root():
    return send_from_directory(FRONTEND_DIR, "simulator.html")

@app.route("/<path:filename>")
def frontend(filename):
    # أي مسار مش /api يروح للفرونت اند
    if filename.startswith("api/"):
        return jsonify({"error": "Not found"}), 404
    return send_from_directory(FRONTEND_DIR, filename)


# ═══════════════════════════════════════════════════════════════
# API — Health
# ═══════════════════════════════════════════════════════════════

@app.route("/api/health")
def health():
    return jsonify({"status": "ok", "time": time.time()})


# ═══════════════════════════════════════════════════════════════
# API — Physics
# ═══════════════════════════════════════════════════════════════

@app.route("/api/physics/beam-pattern", methods=["POST"])
def api_beam_pattern():
    b = request.get_json(force=True)
    try:
        pattern = _beam_pattern(
            num_el  = int(b["numElements"]),
            spacing = float(b["spacing"]),
            freq    = float(b["frequency"]),
            steer   = float(b.get("steerAngle", 0)),
            win     = str(b.get("windowType", "hamming")),
            beta    = float(b.get("kaiserBeta", 6)),
            speed   = float(b.get("waveSpeed", 3e8)),
        )
        return jsonify({"pattern": pattern})
    except (KeyError, ValueError) as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/physics/steering-delays", methods=["POST"])
def api_steering_delays():
    b = request.get_json(force=True)
    try:
        delays = _steering_delays(
            positions = b["elementPositions"],
            steer     = float(b["steerAngle"]),
            speed     = float(b.get("waveSpeed", 1540)),
        )
        return jsonify({"delays": delays})
    except (KeyError, ValueError) as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/physics/focusing-delays", methods=["POST"])
def api_focusing_delays():
    b = request.get_json(force=True)
    try:
        delays = _focusing_delays(
            positions = b["elementPositions"],
            focal     = b["focalPoint"],
            speed     = float(b.get("waveSpeed", 1540)),
        )
        return jsonify({"delays": delays})
    except (KeyError, ValueError) as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/physics/window")
def api_window():
    try:
        weights = _window(
            n           = int(request.args.get("numElements", 32)),
            window_type = str(request.args.get("windowType", "hamming")),
            kaiser_beta = float(request.args.get("kaiserBeta", 6)),
        )
        return jsonify({"weights": weights})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


# ═══════════════════════════════════════════════════════════════
# API — Scenarios
# ═══════════════════════════════════════════════════════════════

@app.route("/api/scenarios", methods=["GET"])
def scenarios_list():
    return jsonify(load_scenarios())


@app.route("/api/scenarios/<key>", methods=["GET"])
def scenario_get(key):
    data = load_scenarios()
    if key not in data:
        return jsonify({"error": "Not found"}), 404
    return jsonify(data[key])


@app.route("/api/scenarios", methods=["POST"])
def scenario_save():
    b        = request.get_json(force=True)
    key      = b.get("key", "").strip()
    scenario = b.get("scenario", {})
    if not key or not scenario.get("mode") or not scenario.get("name"):
        return jsonify({"error": "key و scenario.mode و scenario.name مطلوبين"}), 400
    data = load_scenarios()
    data[key] = {**scenario, "custom": True,
                 "savedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ")}
    save_scenarios(data)
    return jsonify({"ok": True, "key": key})


@app.route("/api/scenarios/<key>", methods=["DELETE"])
def scenario_delete(key):
    data = load_scenarios()
    if key not in data:
        return jsonify({"error": "Not found"}), 404
    del data[key]
    save_scenarios(data)
    return jsonify({"ok": True})


# ═══════════════════════════════════════════════════════════════
# تشغيل
# ═══════════════════════════════════════════════════════════════

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
