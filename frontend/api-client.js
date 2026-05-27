// ============================================================
// BEAMFORM — API CLIENT
// بيتكلم مع الباك اند على /api/...
// بيعمل patch على ScenarioManager بعد ما يتحمل system.js
// ============================================================

const API = (() => {
  const BASE = "/api";

  async function post(path, body) {
    const r = await fetch(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  async function get(path) {
    const r = await fetch(BASE + path);
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  async function del(path) {
    const r = await fetch(BASE + path, { method: "DELETE" });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  return { post, get, del };
})();

// ── Patch ScenarioManager بعد تحميل system.js ─────────────────
// القاعدة: load() تفضل SYNC عشان الـ constructors في fiveg.js و radar.js
// بيستخدموها مباشرة. بس نضيف loadAsync() للـ app.js لما يحتاج custom scenarios.
document.addEventListener("DOMContentLoaded", () => {

  const _syncGetByMode = ScenarioManager.getByMode.bind(ScenarioManager);
  const _syncLoad      = ScenarioManager.load.bind(ScenarioManager);
  const _syncSave      = ScenarioManager.save.bind(ScenarioManager);

  // ── getByMode: async — يجمع predefined + remote ──────────
  ScenarioManager.getByMode = async function (mode) {
    const predefined = _syncGetByMode(mode);
    let remote = {};
    try {
      const all = await API.get("/scenarios");
      remote = Object.fromEntries(
        Object.entries(all).filter(([, s]) => s.mode === mode)
      );
    } catch { /* سيرفر مش شغال — predefined بس */ }
    return { ...predefined, ...remote };
  };

  // ── load: يفضل SYNC (predefined فقط) — لازم للـ constructors ──
  // ScenarioManager.load لم يتغير — شغال زي ما هو

  // ── loadAsync: للـ app.js لما يحتاج custom scenarios ────────
  ScenarioManager.loadAsync = async function (key) {
    const local = _syncLoad(key);
    if (local) return local;
    try {
      return await API.get(`/scenarios/${key}`);
    } catch {
      return null;
    }
  };

  // ── save: async — يحفظ في الباك اند ──────────────────────
  ScenarioManager.save = async function (key, scenario) {
    try {
      await API.post("/scenarios", { key, scenario });
      Bus.emit("scenario:saved", key);
    } catch (err) {
      console.warn("Backend save failed, saving locally:", err);
      _syncSave(key, scenario);
    }
  };

  // ── remove: async — يحذف من الباك اند ───────────────────
  ScenarioManager.remove = async function (key) {
    try {
      await API.del(`/scenarios/${key}`);
      Bus.emit("scenario:deleted", key);
    } catch (err) {
      console.warn("Backend delete failed:", err);
    }
  };
});
