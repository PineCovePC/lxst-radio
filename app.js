const KEY = "lxst.v5";
const CHAT_KEY = "lxst.chats.v1";
const FLAGS_KEY = "lxst.flags.v1";
const GHOSTS = ["NETTLE", "BRAMBLE", "FEN", "CAIRN", "SKERRY", "MOSS"];
const CHANNELS = [
  { id: "calling", name: "Calling", aspect: "lxst.ptt.calling" },
  { id: "tactical", name: "Tactical", aspect: "lxst.ptt.tactical" },
  { id: "logistics", name: "Logistics", aspect: "lxst.ptt.logistics" },
  { id: "night", name: "Night Watch", aspect: "lxst.ptt.nightwatch" },
];
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  ready: false,
  onboarded: false,
  callsign: "",
  hash: "",
  dest: "",
  tab: "radio",
  channelId: "calling",
  stations: [],
  selected: null,
  directed: null,
  chats: {},
  flags: {},
  tx: false,
  latch: false,
  sweep: 0,
  hits: [],
  vol: 0.88,
  chatPeer: null,
};

let actx, osc, gain, vuTimer;
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const pretty = (h) => `<${(h || "").slice(0, 16)}>`;
const grouped = (h) => (h || "").replace(/(.{4})/g, "$1 ").trim();

function hashNum(s, salt = 0) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}
function angleFor(id) {
  return hashNum(id, 9) * Math.PI * 2;
}
async function sha16(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return hex(new Uint8Array(buf)).slice(0, 32);
}
function freqFrom(hexStr) {
  const n = parseInt((hexStr || "0").slice(0, 6), 16);
  if (!Number.isFinite(n)) return "7.074";
  return (7 + (n / 0xffffff) * 21).toFixed(3);
}
function loadJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function save() {
  localStorage.setItem(
    KEY,
    JSON.stringify({
      seed: state.seed,
      callsign: state.callsign,
      onboarded: state.onboarded,
      channelId: state.channelId,
      vol: state.vol,
    }),
  );
}
function seedGhosts(identity) {
  return GHOSTS.map((name, i) => ({
    id: "ghost-" + name.toLowerCase(),
    name,
    hash: (identity.slice(0, 8) + name.toLowerCase()).slice(0, 32),
    ghost: true,
    rtt: Math.round(40 + hashNum(identity, i + 3) * 180),
  }));
}

async function bootIdentity() {
  let persisted = loadJson(KEY, null);
  if (!persisted || !persisted.seed) {
    const seed = hex(crypto.getRandomValues(new Uint8Array(16)));
    persisted = { seed, callsign: "", onboarded: false, channelId: "calling", vol: 0.88 };
  }
  state.seed = persisted.seed;
  state.hash = await sha16("lxst:id:" + persisted.seed);
  state.dest = await sha16("lxst.ptt:" + state.hash);
  state.callsign = (persisted.callsign || "OP-" + state.hash.slice(0, 4).toUpperCase()).slice(0, 16);
  state.onboarded = Boolean(persisted.onboarded);
  state.channelId = persisted.channelId || "calling";
  state.vol = typeof persisted.vol === "number" ? persisted.vol : 0.88;
  state.stations = seedGhosts(state.hash);
  state.chats = loadJson(CHAT_KEY, {});
  state.flags = loadJson(FLAGS_KEY, {});
  state.ready = true;
}

function flag(id) {
  return state.flags[id] || { pin: false, mute: false };
}
function setFlag(id, key) {
  const cur = flag(id);
  cur[key] = !cur[key];
  state.flags[id] = cur;
  localStorage.setItem(FLAGS_KEY, JSON.stringify(state.flags));
  if (key === "mute" && cur.mute && state.selected === id) select(null);
  renderSheet();
}
function channel() {
  return CHANNELS.find((c) => c.id === state.channelId) || CHANNELS[0];
}
function station(id) {
  return state.stations.find((s) => s.id === id);
}
function visibleStations() {
  return state.stations.filter((s) => !flag(s.id).mute);
}

function show(id) {
  $$(".panel").forEach((p) => p.classList.toggle("on", p.id === id));
}
function setTab(tab) {
  state.tab = tab;
  $$("#nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  const map = { radio: "panel-radio", mesh: "panel-mesh", chat: "panel-chat", id: "panel-id" };
  show(map[tab] || "panel-radio");
  if (tab === "radio") resizeRadar();
  if (tab === "chat") renderChat();
  if (tab === "mesh") renderMesh();
  if (tab === "id") renderId();
}

function renderHeader() {
  $("#hdr-hash").textContent = pretty(state.dest || state.hash);
  $("#hdr-call").textContent = state.callsign || "—";
  $("#hdr-sta").textContent = state.tx ? "latched" : state.stations.length + " sta";
}

function renderLcd() {
  const ch = channel();
  const dest = state.dest;
  $("#lcd-freq").textContent = freqFrom(dest + ch.id);
  $("#lcd-aspect").textContent = "MHz · " + ch.aspect;
  $("#lcd-name").textContent = ch.name;
  $("#lcd-dest").textContent = pretty(dest);
  const sel = station(state.selected);
  $("#lcd-status").textContent = state.tx ? "TX ON AIR" : sel ? "TO " + sel.name : "NET OPEN";
  $("#lcd-status").style.color = state.tx ? "var(--tx)" : "var(--lcd-dim)";
  $("#lcd-count").textContent = "0/" + visibleStations().length + " lnk";
  $('[data-led="tx"]').classList.toggle("on", state.tx);
  $('[data-led="tx"]').classList.toggle("tx", state.tx);
  $("#status-mark").classList.toggle("tx", state.tx);
  $("#status-mark").textContent = state.tx ? "TX" : "LXST";
}

function renderChips() {
  $("#chips").innerHTML = CHANNELS.map(
    (c) =>
      `<button type="button" data-ch="${c.id}" class="${c.id === state.channelId ? "on" : ""}">${c.name}</button>`,
  ).join("");
}

function renderSheet() {
  const st = station(state.selected);
  const sheet = $("#sheet");
  if (!st) {
    sheet.hidden = true;
    return;
  }
  const f = flag(st.id);
  sheet.hidden = false;
  $("#sheet-name").textContent = st.name;
  $("#sheet-kind").textContent = st.ghost ? "sim" : "live";
  $("#act-pin").textContent = f.pin ? "Unpin" : "Pin";
  $("#act-mute").textContent = f.mute ? "Unmute" : "Mute";
}

function renderMesh() {
  const list = $("#mesh-list");
  const rows = visibleStations();
  if (!rows.length) {
    list.innerHTML = `<li><div class="card muted">No stations on this destination.</div></li>`;
    return;
  }
  list.innerHTML = rows
    .map((s) => {
      const f = flag(s.id);
      return `<li>
        <button type="button" class="row" data-pick="${s.id}">
          <strong>${escapeHtml(s.name)}</strong>
          <span class="preview">${s.ghost ? "simulated contact" : escapeHtml(pretty(s.hash))}${f.pin ? " · pinned" : ""}</span>
        </button>
        <button type="button" class="side" data-chat="${s.id}">Chat</button>
      </li>`;
    })
    .join("");
}

function renderThreads() {
  const contacts = state.stations.map((s) => {
    const thread = state.chats[s.id];
    const last = thread && thread.msgs && thread.msgs[thread.msgs.length - 1];
    return {
      id: s.id,
      name: s.name,
      ghost: s.ghost,
      last,
      unread: (thread && thread.unread) || 0,
      t: last ? last.t : 0,
    };
  });
  contacts.sort((a, b) => b.t - a.t || a.name.localeCompare(b.name));
  $("#thread-list").innerHTML = contacts
    .map(
      (r) => `<li>
        <button type="button" class="row" data-open="${r.id}">
          <strong>${escapeHtml(r.name)}${r.ghost ? ' <span class="faint">sim</span>' : ""}</strong>
          <span class="preview">${escapeHtml((r.last && r.last.text) || "No traffic yet")}</span>
        </button>
        ${r.unread ? `<span class="unread">${r.unread}</span>` : ""}
      </li>`,
    )
    .join("");
}

function renderMsgs() {
  const box = $("#msgs");
  const thread = state.chats[state.chatPeer] || { msgs: [] };
  if (!thread.msgs.length) {
    box.innerHTML = `<p class="muted">No traffic yet. Send a short burst.</p>`;
    return;
  }
  box.innerHTML = thread.msgs
    .map(
      (m) =>
        `<div class="bubble ${m.from}"><div>${escapeHtml(m.text)}</div><time>${new Date(m.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>`,
    )
    .join("");
  box.scrollTop = box.scrollHeight;
}

function renderChat() {
  if (state.chatPeer && station(state.chatPeer)) {
    const st = station(state.chatPeer);
    $("#chat-home").hidden = true;
    $("#chat-room").hidden = false;
    $("#chat-title").textContent = st.name;
    $("#chat-sub").textContent = st.ghost ? "simulated contact" : pretty(st.hash);
    $("#chat-in").placeholder = "Message " + st.name;
    renderMsgs();
  } else {
    $("#chat-home").hidden = false;
    $("#chat-room").hidden = true;
    renderThreads();
  }
}

function renderId() {
  $("#id-call").value = state.callsign;
  $("#id-hash").textContent = grouped(state.hash);
  $("#id-dest").textContent = grouped(state.dest);
}

function renderVu(level, tx) {
  const n = 16;
  const lit = Math.round(Math.max(0, Math.min(1, level)) * n);
  $("#vu").innerHTML = Array.from({ length: n }, (_, i) => {
    const on = i < lit;
    const hot = tx && i > n * 0.72;
    return `<i class="${on ? "on" : ""} ${hot ? "hot" : ""}" style="height:${18 + (i / n) * 82}%"></i>`;
  }).join("");
}

function renderBars(n) {
  $("#bars").innerHTML = [0, 1, 2, 3]
    .map((i) => `<i class="${i < n ? "on" : ""}" style="height:${6 + i * 2}px"></i>`)
    .join("");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "\u0026amp;")
    .replace(/</g, "\u0026lt;")
    .replace(/>/g, "\u0026gt;")
    .replace(/"/g, "\u0026quot;")
    .replace(/'/g, "\u0026#39;");
}

function select(id) {
  state.selected = state.selected === id ? null : id;
  renderSheet();
  renderLcd();
}

function openChat(id) {
  const st = station(id);
  if (!st) return;
  if (!state.chats[id]) state.chats[id] = { unread: 0, msgs: [] };
  state.chats[id].unread = 0;
  localStorage.setItem(CHAT_KEY, JSON.stringify(state.chats));
  state.chatPeer = id;
  state.selected = id;
  setTab("chat");
}

function pushMsg(id, msg) {
  if (!state.chats[id]) state.chats[id] = { unread: 0, msgs: [] };
  const thread = state.chats[id];
  if (msg.from === "them" && state.chatPeer !== id) thread.unread += 1;
  thread.msgs = [...thread.msgs, msg].slice(-80);
  localStorage.setItem(CHAT_KEY, JSON.stringify(state.chats));
  if (state.tab === "chat") renderChat();
}

async function ensureAudio() {
  if (!actx) actx = new AudioContext();
  if (actx.state === "suspended") await actx.resume();
  return actx;
}
function stopTone() {
  try {
    osc && osc.stop();
  } catch {}
  try {
    osc && osc.disconnect();
    gain && gain.disconnect();
  } catch {}
  osc = gain = null;
}
async function startTx() {
  const audio = await ensureAudio();
  stopTone();
  gain = audio.createGain();
  gain.gain.value = 0.04 * state.vol;
  gain.connect(audio.destination);
  osc = audio.createOscillator();
  osc.type = "triangle";
  osc.frequency.value = 880;
  osc.connect(gain);
  osc.start();
  state.tx = true;
  $("#ptt").classList.add("hot");
  $("#ptt-cap").textContent = state.latch ? "Latch" : "Live";
  $(".ptt .ptt-k").textContent = "TX";
  renderLcd();
  renderBars(4);
  let t = 0;
  clearInterval(vuTimer);
  vuTimer = setInterval(() => {
    t += 1;
    renderVu(0.35 + Math.abs(Math.sin(t / 4)) * 0.55, true);
  }, 80);
}
function stopTx() {
  stopTone();
  state.tx = false;
  $("#ptt").classList.remove("hot");
  $("#ptt-cap").textContent = "Hold";
  $(".ptt .ptt-k").textContent = "PTT";
  clearInterval(vuTimer);
  renderVu(0, false);
  renderLcd();
  renderBars(1);
  renderHeader();
}

function resizeRadar() {
  const canvas = $("#radar");
  const parent = canvas.parentElement;
  if (!parent) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = parent.clientWidth;
  const h = parent.clientHeight;
  if (w < 2 || h < 2) return;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  canvas._css = { w, h };
}

function drawRadar() {
  const canvas = $("#radar");
  if (!canvas || !canvas._css) return;
  const ctx = canvas.getContext("2d");
  const { w: width, h: height } = canvas._css;
  ctx.clearRect(0, 0, width, height);
  state.sweep += 0.016;
  const cx = width / 2;
  const cy = height / 2 + 4;
  const radius = Math.min(width, height) * 0.34;
  ctx.strokeStyle = "rgba(126, 201, 154, 0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, radius * 0.55, 0, Math.PI * 2);
  ctx.stroke();
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate((state.sweep * 0.55) % (Math.PI * 2));
  const lg = ctx.createLinearGradient(0, 0, radius, 0);
  lg.addColorStop(0, "rgba(126, 201, 154, 0)");
  lg.addColorStop(1, "rgba(126, 201, 154, 0.22)");
  ctx.fillStyle = lg;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, radius, -0.4, 0.05);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  const nodes = visibleStations();
  const hits = nodes.map((s) => {
    const a = -Math.PI / 2 + angleFor(s.id);
    const r = radius * (0.78 + angleFor(s.id + "r") * 0.18);
    return { s, x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
  });
  state.hits = hits;
  for (const p of hits) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = "rgba(232, 238, 233, 0.12)";
    ctx.stroke();
  }
  drawNode(ctx, cx, cy, state.tx ? "#c45c4a" : "#7ec99a", state.tx, state.callsign.slice(0, 8), false);
  for (const p of hits) {
    const f = flag(p.s.id);
    const sel = state.selected === p.s.id;
    const color = sel ? "#e8eee9" : f.pin ? "#c9a86a" : p.s.ghost ? "#8a968e" : "#7ec99a";
    drawNode(ctx, p.x, p.y, color, sel, p.s.name.slice(0, 8), sel);
  }
}
function drawNode(ctx, x, y, color, pulse, label, selected) {
  if (pulse) {
    ctx.beginPath();
    ctx.arc(x, y, selected ? 16 : 14, 0, Math.PI * 2);
    ctx.fillStyle = color + "33";
    ctx.fill();
  }
  ctx.beginPath();
  ctx.arc(x, y, selected ? 7 : 5.5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.font = "500 10px 'IBM Plex Mono', monospace";
  ctx.fillStyle = "rgba(232, 238, 233, 0.72)";
  ctx.textAlign = "center";
  ctx.fillText(label, x, y + 18);
}

function hitTest(ev) {
  const canvas = $("#radar");
  const rect = canvas.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  let best = null;
  let bestD = 40;
  for (const hit of state.hits) {
    const d = Math.hypot(hit.x - x, hit.y - y);
    const label = Math.abs(hit.x - x) < 36 && y > hit.y && y < hit.y + 22;
    if (d < bestD || label) {
      bestD = Math.min(d, bestD);
      best = hit.s;
    }
  }
  return best;
}

function enter() {
  state.onboarded = true;
  save();
  $("#nav").hidden = false;
  setTab("radio");
  renderHeader();
  renderLcd();
  renderChips();
  renderVu(0, false);
  renderBars(1);
  $("#vol").value = String(state.vol);
  resizeRadar();
  try {
    navigator.vibrate?.(12);
  } catch {}
}

async function main() {
  await bootIdentity();
  $("#on-hash").textContent = pretty(state.dest);
  $("#on-call").value = state.callsign;
  renderHeader();
  const tick = () => {
    $("#clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  };
  tick();
  setInterval(tick, 10000);

  if (state.onboarded) enter();
  else show("panel-onboard");

  $("#btn-announce").addEventListener("click", () => {
    const next = $("#on-call").value.replace(/[^\w-]/g, "").slice(0, 16).toUpperCase();
    if (next) state.callsign = next;
    save();
    void ensureAudio();
    enter();
  });

  $$("#nav button").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
  $("#chips").addEventListener("click", (e) => {
    const id = e.target.dataset.ch;
    if (!id) return;
    state.channelId = id;
    save();
    renderChips();
    renderLcd();
  });
  $("#ch-prev").addEventListener("click", () => stepCh(-1));
  $("#ch-next").addEventListener("click", () => stepCh(1));
  function stepCh(dir) {
    const i = CHANNELS.findIndex((c) => c.id === state.channelId);
    state.channelId = CHANNELS[(i + dir + CHANNELS.length) % CHANNELS.length].id;
    save();
    renderChips();
    renderLcd();
  }

  $("#radar").addEventListener("pointerdown", (e) => {
    const st = hitTest(e);
    if (!st) select(null);
    else select(st.id);
    try {
      navigator.vibrate?.(8);
    } catch {}
  });
  $("#sheet-clear").addEventListener("click", () => select(null));
  $("#sheet").addEventListener("click", (e) => {
    const act = e.target.dataset.act;
    const st = station(state.selected);
    if (!act || !st) return;
    if (act === "chat") openChat(st.id);
    else if (act === "direct") {
      state.directed = state.directed === st.id ? null : st.id;
      renderLcd();
    } else if (act === "pin") setFlag(st.id, "pin");
    else if (act === "mute") setFlag(st.id, "mute");
  });

  $("#mesh-list").addEventListener("click", (e) => {
    const chat = e.target.closest("[data-chat]");
    if (chat) {
      openChat(chat.dataset.chat);
      return;
    }
    const pick = e.target.closest("[data-pick]");
    if (pick) {
      select(pick.dataset.pick);
      setTab("radio");
    }
  });
  $("#thread-list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-open]");
    if (btn) openChat(btn.dataset.open);
  });
  $("#chat-back").addEventListener("click", () => {
    state.chatPeer = null;
    renderChat();
  });
  $("#chat-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("#chat-in").value.trim();
    if (!text || !state.chatPeer) return;
    $("#chat-in").value = "";
    pushMsg(state.chatPeer, { from: "me", text, t: Date.now() });
    const st = station(state.chatPeer);
    if (st && st.ghost) {
      setTimeout(() => {
        const replies = ["Copy.", "Stand by.", "On frequency.", "Roger."];
        pushMsg(st.id, { from: "them", text: replies[Math.floor(Math.random() * replies.length)], t: Date.now() });
      }, 500);
    }
  });
  $("#burst-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("#burst-in").value.trim();
    if (!text) return;
    $("#burst-in").value = "";
    const first = visibleStations()[0];
    if (first) {
      pushMsg(first.id, { from: "me", text, t: Date.now() });
      setTimeout(() => pushMsg(first.id, { from: "them", text: "Copy.", t: Date.now() }), 400);
    }
  });
  $("#btn-share").addEventListener("click", async () => {
    const url = location.href;
    try {
      if (navigator.share) await navigator.share({ title: "LXST", url });
      else await navigator.clipboard.writeText(url);
      $("#btn-share").textContent = "Copied";
    } catch {
      try {
        await navigator.clipboard.writeText(url);
        $("#btn-share").textContent = "Copied";
      } catch {}
    }
    setTimeout(() => ($("#btn-share").textContent = "Share"), 1400);
  });
  $("#btn-setcall").addEventListener("click", () => {
    const next = $("#id-call").value.replace(/[^\w-]/g, "").slice(0, 16).toUpperCase();
    if (next) state.callsign = next;
    save();
    renderHeader();
  });
  $("#btn-newid").addEventListener("click", async () => {
    localStorage.removeItem(KEY);
    await bootIdentity();
    state.onboarded = true;
    save();
    renderHeader();
    renderId();
    renderLcd();
  });
  $("#vol").addEventListener("input", (e) => {
    state.vol = Number(e.target.value);
    if (gain) gain.gain.value = 0.04 * state.vol;
    save();
  });

  const ptt = $("#ptt");
  ptt.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    ptt.setPointerCapture(e.pointerId);
    if (state.latch) {
      state.latch = false;
      $("#latch").classList.remove("on");
      $("#latch").textContent = "Latch PTT";
      stopTx();
      return;
    }
    void startTx();
  });
  const endPtt = () => {
    if (!state.latch) stopTx();
  };
  ptt.addEventListener("pointerup", endPtt);
  ptt.addEventListener("pointercancel", endPtt);
  ptt.addEventListener("contextmenu", (e) => e.preventDefault());
  $("#latch").addEventListener("click", () => {
    state.latch = !state.latch;
    $("#latch").classList.toggle("on", state.latch);
    $("#latch").textContent = state.latch ? "Latched — tap pad to drop" : "Latch PTT";
    if (state.latch) void startTx();
    else stopTx();
  });

  window.addEventListener("resize", resizeRadar);
  resizeRadar();
  const loop = () => {
    if (state.tab === "radio" && state.onboarded) drawRadar();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

if ("serviceWorker" in navigator) {
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js?v=5").catch(() => {});
  });
}

main();
