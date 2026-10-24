(() => {
  "use strict";
  const KEY = "hypertrophy-tracker-v1";
  const WORK_MET = 6.0, REST_MET = 1.75;
  const EMPTY_SESSION = { running: false, accMs: 0, startAt: 0, workMs: 0, restMs: 0 };
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  let S = {
    week: 1, day: 1, bwLb: "140", logs: {}, history: [], last: {},
    session: { ...EMPTY_SESSION }, active: null, rest: null,
  };
  let focus = -1, confirmReset = false, confirmClear = false;

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) S = Object.assign(S, JSON.parse(raw));
    } catch (e) { console.warn("load failed", e); }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { console.warn("save failed", e); }
  }
  // Ask the browser to keep our storage (helps against eviction)
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) {}

  const fmt = (ms) => {
    const t = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    const p = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  };
  const setsFor = (w, idx, base) => base + (w === 3 && idx === 0 ? 1 : 0);
  const ytUrl = (name) => "https://www.youtube.com/results?search_query=" + encodeURIComponent(name.replace(/[()"]/g, "") + " form tutorial");
  const W = () => S.week - 1, D = () => S.day - 1;
  const slots = () => PLAN[W()][D()];
  const prefix = () => `${S.week}-${S.day}-`;
  const logOf = (k) => S.logs[k] || { done: false, w: "", r: "", dur: 0 };

  // ---- Audio (iOS needs unlock in a user gesture) ----
  let actx = null;
  function unlockAudio() {
    try {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return;
      if (!actx) actx = new C();
      if (actx.state === "suspended") actx.resume();
      // silent blip to fully unlock on iOS
      const o = actx.createOscillator(), g = actx.createGain(); g.gain.value = 0; o.connect(g); g.connect(actx.destination); o.start(); o.stop(actx.currentTime + 0.01);
    } catch (e) {}
  }
  function alertRestDone() {
    try {
      if (actx) {
        if (actx.state === "suspended") actx.resume();
        [0, 0.25, 0.5].forEach((off) => {
          const o = actx.createOscillator(), g = actx.createGain();
          o.frequency.value = 880; g.gain.value = 0.25; o.connect(g); g.connect(actx.destination);
          o.start(actx.currentTime + off); o.stop(actx.currentTime + off + 0.15);
        });
      }
    } catch (e) {}
    try { const ua = navigator.userActivation; if (navigator.vibrate && (!ua || ua.hasBeenActive)) navigator.vibrate([200, 100, 200]); } catch (e) {} // Android only; iOS ignores
    const f = $("flash"); f.classList.remove("go"); void f.offsetWidth; f.classList.add("go");
  }

  // ---- Session logic ----
  const ensureRunning = (ts) => { if (!S.session.running) { S.session.running = true; S.session.startAt = ts; } };
  function closeRest(ts) { if (S.rest) { S.session.restMs += ts - S.rest.startAt; S.rest = null; } }
  function closeActive(ts) { let ms = 0; if (S.active) { ms = ts - S.active.startAt; S.session.workMs += ms; } const k = S.active && S.active.key; S.active = null; return { ms, k }; }

  function startSet(key) {
    const ts = Date.now();
    ensureRunning(ts); closeRest(ts); closeActive(ts);
    S.active = { key, startAt: ts };
    save(); renderExercises(); tick();
  }
  function checkSet(key, exId) {
    const cur = logOf(key);
    if (cur.done) { S.logs[key] = { ...cur, done: false }; save(); renderExercises(); renderProgress(); return; }
    const ts = Date.now();
    ensureRunning(ts);
    const { ms, k } = closeActive(ts);
    closeRest(ts);
    S.logs[key] = { ...cur, done: true, dur: k === key ? ms : 0 };
    const ex = LIB[exId];
    S.rest = { startAt: ts, target: ex.rest, label: ex.n, alerted: false };
    save(); renderExercises(); renderProgress(); tick();
  }
  function toggleSession() {
    const ts = Date.now();
    if (S.session.running) {
      S.session.accMs += ts - S.session.startAt; S.session.running = false;
      closeActive(ts); closeRest(ts);
    } else { S.session.running = true; S.session.startAt = ts; }
    save(); renderExercises(); tick();
  }
  function clearDay() {
    const p = prefix();
    Object.keys(S.logs).forEach((k) => { if (k.indexOf(p) === 0) delete S.logs[k]; });
    S.session = { ...EMPTY_SESSION }; S.active = null; S.rest = null;
  }
  function liveTotals(now) {
    const sess = S.session.accMs + (S.session.running ? now - S.session.startAt : 0);
    const work = S.session.workMs + (S.active ? now - S.active.startAt : 0);
    const rest = S.session.restMs + (S.rest ? now - S.rest.startAt : 0);
    const kg = (Number(S.bwLb) || 140) * 0.45359;
    const kcal = kg * (WORK_MET * work + REST_MET * Math.max(0, sess - work)) / 3600000;
    return { sess, work, rest, kcal };
  }
  function counts() {
    let total = 0, done = 0, vol = 0;
    slots().forEach((sl, i) => {
      for (let k = 0; k < setsFor(W(), i, sl[1]); k++) {
        total++;
        const lg = S.logs[`${prefix()}${i}-${k}`];
        if (lg && lg.done) { done++; vol += (Number(lg.w) || 0) * (Number(lg.r) || 0); }
      }
    });
    return { total, done, vol };
  }
  function finish() {
    const c = counts(); if (!c.done) return;
    const t = liveTotals(Date.now());
    slots().forEach((sl, i) => {
      const parts = [];
      for (let k = 0; k < setsFor(W(), i, sl[1]); k++) {
        const lg = S.logs[`${prefix()}${i}-${k}`];
        if (lg && lg.done && (lg.w || lg.r)) parts.push(`${lg.w || "BW"}×${lg.r || "?"}`);
      }
      if (parts.length) S.last[sl[0]] = `${parts.join(", ")} (W${S.week})`;
    });
    S.history.unshift({ date: new Date().toLocaleDateString(), ts: Date.now(), label: `W${S.week} D${S.day} ${DAYS[D()].name}`,
      sets: `${c.done}/${c.total}`, volume: Math.round(c.vol), mins: Math.round(t.sess / 60000), kcal: Math.round(t.kcal) });
    clearDay(); save(); renderAll();
  }

  // ---- Rendering ----
  function renderSelectors() {
    $("weekSeg").innerHTML = [1, 2, 3, 4].map((w) => `<button data-act="week" data-v="${w}" class="${S.week === w ? "on" : ""}">Week ${w}</button>`).join("");
    $("daySeg").innerHTML = DAYS.map((d, i) => `<button data-act="day" data-v="${i + 1}" class="${S.day === i + 1 ? "on" : ""}">D${i + 1} ${d.name}</button>`).join("");
    $("dayText").textContent = `Day ${S.day}: ${DAYS[D()].name} (${DAYS[D()].focus}). ${WEEK_NOTE[W()]}`;
    $("bw").value = S.bwLb;
  }
  function renderMap() {
    let prim = [], sec = [];
    const sl = slots();
    if (focus >= 0 && focus < sl.length) { prim = LIB[sl[focus][0]].p; sec = LIB[sl[focus][0]].s; }
    else {
      sl.forEach((s) => LIB[s[0]].p.forEach((m) => { if (!prim.includes(m)) prim.push(m); }));
      sl.forEach((s) => LIB[s[0]].s.forEach((m) => { if (!prim.includes(m) && !sec.includes(m)) sec.push(m); }));
    }
    const fig = (ox) => `<circle cx="${70 + ox}" cy="20" r="13"/><rect x="${50 + ox}" y="38" width="40" height="98" rx="14"/><rect x="${33 + ox}" y="44" width="14" height="86" rx="7"/><rect x="${93 + ox}" y="44" width="14" height="86" rx="7"/><rect x="${51 + ox}" y="130" width="18" height="108" rx="8"/><rect x="${71 + ox}" y="130" width="18" height="108" rx="8"/>`;
    const shapes = SHAPES.map(([m, cx, cy, rx, ry]) => {
      const c = prim.includes(m) ? "#4f8cff" : sec.includes(m) ? "#f2c14e" : "#3a404d";
      return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${c}"><title>${MUSCLE_NAME[m]}</title></ellipse>`;
    }).join("");
    $("bodyMap").innerHTML = `<svg viewBox="0 0 280 262" role="img" aria-label="Muscles worked"><g fill="#1e222b" stroke="#2a2f3a">${fig(0)}${fig(140)}</g>${shapes}<text x="70" y="256" text-anchor="middle" fill="#9aa3b2" font-size="11">Front</text><text x="210" y="256" text-anchor="middle" fill="#9aa3b2" font-size="11">Back</text></svg>`;
    $("mapText").textContent = focus >= 0 && focus < sl.length ? `Showing ${LIB[sl[focus][0]].n}. Tap "Show on map" again to see the whole day.` : `Showing all of today's ${DAYS[D()].name} session. Tap "Show on map" on an exercise to see just that lift.`;
  }
  function renderExercises() {
    const now = Date.now();
    $("exList").innerHTML = slots().map((sl, i) => {
      const ex = LIB[sl[0]], n = setsFor(W(), i, sl[1]);
      const tags = ex.p.map((m) => `<span><i class="dot p"></i>${MUSCLE_NAME[m]}</span>`).join("") + ex.s.map((m) => `<span><i class="dot s"></i>${MUSCLE_NAME[m]}</span>`).join("");
      let rows = "";
      for (let k = 0; k < n; k++) {
        const key = `${prefix()}${i}-${k}`, lg = logOf(key), act = S.active && S.active.key === key;
        const mid = lg.done ? `<div class="dur">${lg.dur ? fmt(lg.dur) + " set" : "Logged"}</div>`
          : `<button class="btn timebtn ${act ? "running" : ""}" data-act="${act ? "check" : "start"}" data-key="${key}" data-ex="${sl[0]}" ${act ? 'data-live="1"' : ""}>${act ? fmt(now - S.active.startAt) : "Start"}</button>`;
        rows += `<div class="setrow ${lg.done ? "done" : ""}"><div class="sl">Set ${k + 1}</div>
          <input type="number" inputmode="decimal" placeholder="lb" aria-label="Weight set ${k + 1}" data-key="${key}" data-f="w" value="${esc(lg.w)}">
          <input type="number" inputmode="numeric" placeholder="reps" aria-label="Reps set ${k + 1}" data-key="${key}" data-f="r" value="${esc(lg.r)}">
          ${mid}
          <button class="btn check ${lg.done ? "on" : ""}" data-act="check" data-key="${key}" data-ex="${sl[0]}" aria-label="${lg.done ? "Undo set" : "Complete set"}">${lg.done ? "✓" : ""}</button></div>`;
      }
      return `<div class="ex ${focus === i ? "focus" : ""}">
        <div class="name">${i + 1}. ${esc(ex.n)}</div>
        <div class="meta">${n} × ${sl[2]} reps · rest ${fmt(ex.rest * 1000)} · ${esc(ex.eq)}</div>
        <div class="tags">${tags}</div>
        <div class="cue">${esc(ex.cue)}</div>
        ${S.last[sl[0]] ? `<div class="last">Last time: ${esc(S.last[sl[0]])}</div>` : ""}
        <div class="row"><a class="btn" href="${ytUrl(ex.n)}" target="_blank" rel="noopener noreferrer">Watch tutorial ↗</a>
        <button class="btn" data-act="focus" data-i="${i}">${focus === i ? "Hide on map" : "Show on map"}</button></div>
        ${rows}</div>`;
    }).join("");
  }
  function renderProgress() {
    const c = counts(), pct = c.total ? Math.round(c.done / c.total * 100) : 0;
    $("progFill").style.width = pct + "%";
    $("progText").textContent = `${c.done} of ${c.total} sets`;
    $("progPct").textContent = pct + "%";
    $("btnFinish").disabled = c.done === 0;
  }
  function renderHistory() {
    if (!S.history.length) { $("histWrap").innerHTML = `<p class="muted small">Finished sessions show up here after you tap Finish &amp; log.</p>`; return; }
    $("histWrap").innerHTML = `<div class="tablewrap"><table><thead><tr><th>Session</th><th>Date</th><th>Sets</th><th>Volume (lb)</th><th>Min</th><th>kcal</th></tr></thead><tbody>${
      S.history.map((h) => `<tr><td>${esc(h.label)}</td><td>${esc(h.date)}</td><td>${esc(h.sets)}</td><td>${Number(h.volume).toLocaleString()}</td><td>${h.mins}</td><td>${h.kcal}</td></tr>`).join("")}</tbody></table></div>`;
  }
  function renderVolume() {
    const v = {};
    PLAN[W()].forEach((ds) => ds.forEach((sl, i) => {
      const n = setsFor(W(), i, sl[1]);
      LIB[sl[0]].p.forEach((m) => { v[m] = (v[m] || 0) + n; });
      LIB[sl[0]].s.forEach((m) => { v[m] = (v[m] || 0) + n * 0.5; });
    }));
    const arr = Object.keys(v).map((k) => [MUSCLE_NAME[k], v[k]]).sort((a, b) => b[1] - a[1]);
    const max = arr[0][1];
    $("volCaption").textContent = `Week ${S.week}. Direct sets count 1; sets where the muscle assists count 0.5.`;
    $("volChart").innerHTML = arr.map(([l, n]) => `<div class="bar"><span class="bl">${l}</span><span class="bt"><span class="bf" style="display:block;width:${n / max * 100}%"></span></span><span class="bv">${n} sets</span></div>`).join("");
  }
  function renderAll() { renderSelectors(); renderMap(); renderExercises(); renderProgress(); renderHistory(); renderVolume(); tick(); }

  function tick() {
    const now = Date.now(), t = liveTotals(now);
    $("stSession").textContent = fmt(t.sess);
    $("stWork").textContent = fmt(t.work);
    $("stRest").textContent = fmt(t.rest);
    $("stKcal").textContent = Math.round(t.kcal);
    $("btnSession").textContent = S.session.running ? "Pause" : t.sess > 0 ? "Resume" : "Start session";
    const rb = $("restBanner");
    if (S.rest) {
      const el = now - S.rest.startAt, tgt = S.rest.target * 1000, done = el >= tgt;
      rb.classList.remove("hidden"); rb.classList.toggle("done", done);
      $("restLabel").textContent = done ? "Rest done. Start your next set." : `Resting after ${S.rest.label}`;
      $("restClock").textContent = done ? "+" + fmt(el - tgt) : fmt(tgt - el);
      $("restTarget").textContent = "/ " + fmt(tgt);
      if (done && !S.rest.alerted) { S.rest.alerted = true; save(); alertRestDone(); }
    } else rb.classList.add("hidden");
    const an = $("activeNote");
    if (S.active && !S.rest) { an.classList.remove("hidden"); an.textContent = `Set in progress: ${fmt(now - S.active.startAt)}. Tap the check when you rack it.`; }
    else an.classList.add("hidden");
    document.querySelectorAll('[data-live="1"]').forEach((b) => { if (S.active) b.textContent = fmt(now - S.active.startAt); });
  }

  // ---- Export / import ----
  function exportData() {
    const blob = new Blob([JSON.stringify({ app: "hypertrophy-tracker", version: 1, exportedAt: new Date().toISOString(), history: S.history, last: S.last, bwLb: S.bwLb }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = url; a.download = `hypertrophy-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    $("ioMsg").textContent = "Backup file created. On iPhone choose Save to Files.";
  }
  function importData(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (!d || !Array.isArray(d.history)) throw new Error("Not a tracker backup");
        const seen = new Set(S.history.map((h) => (h.ts || "") + h.label + h.date));
        d.history.forEach((h) => { if (!seen.has((h.ts || "") + h.label + h.date)) S.history.push(h); });
        S.history.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        if (d.last) S.last = Object.assign({}, d.last, S.last);
        save(); renderAll();
        $("ioMsg").textContent = `Imported ${d.history.length} sessions.`;
      } catch (e) { $("ioMsg").textContent = "That file isn't a valid backup."; }
    };
    r.readAsText(file);
  }

  // ---- Events ----
  document.addEventListener("click", (e) => {
    unlockAudio();
    const b = e.target.closest("[data-act]"); if (!b) return;
    const a = b.dataset.act;
    if (a !== "reset") confirmReset = false;
    if (a !== "clearHist") confirmClear = false;
    switch (a) {
      case "week": S.week = Number(b.dataset.v); focus = -1; save(); renderAll(); break;
      case "day": S.day = Number(b.dataset.v); focus = -1; save(); renderAll(); break;
      case "start": startSet(b.dataset.key); break;
      case "check": checkSet(b.dataset.key, b.dataset.ex); break;
      case "focus": { const i = Number(b.dataset.i); focus = focus === i ? -1 : i; renderMap(); renderExercises(); if (focus >= 0) $("bodyMap").scrollIntoView({ behavior: "smooth", block: "center" }); break; }
      case "toggleSession": toggleSession(); break;
      case "skipRest": closeRest(Date.now()); save(); tick(); break;
      case "rest30": if (S.rest) { S.rest.target += 30; S.rest.alerted = false; save(); tick(); } break;
      case "finish": finish(); break;
      case "reset": if (confirmReset) { clearDay(); confirmReset = false; save(); renderAll(); } else { confirmReset = true; } break;
      case "clearHist": if (confirmClear) { S.history = []; S.last = {}; confirmClear = false; save(); renderAll(); } else { confirmClear = true; } break;
      case "export": exportData(); break;
      case "import": $("importFile").click(); break;
    }
    $("btnReset").textContent = confirmReset ? "Tap again to reset" : "Reset";
    $("btnClearHist").textContent = confirmClear ? "Tap again to clear" : "Clear history";
  });
  $("exList").addEventListener("input", (e) => {
    const el = e.target; if (!el.dataset || !el.dataset.key) return;
    const cur = logOf(el.dataset.key); cur[el.dataset.f] = el.value; S.logs[el.dataset.key] = cur; save();
  });
  $("bw").addEventListener("input", (e) => { S.bwLb = e.target.value; save(); tick(); });
  $("importFile").addEventListener("change", (e) => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ""; });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });

  load(); renderAll();
  setInterval(tick, 250);

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js", { scope: "./" }).then((r) => { window.__swRegistered = true; console.log("SW registered", r.scope); })
        .catch((err) => console.error("SW registration failed", err));
    });
  }
})();
