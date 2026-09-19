const KEY = "lxst.v6";
const CHAT_KEY = "lxst.chats.v1";
const FLAGS_KEY = "lxst.flags.v1";
const CHANNELS = [
  { id: "calling", name: "Calling", aspect: "lxst.ptt.calling" },
  { id: "tactical", name: "Tactical", aspect: "lxst.ptt.tactical" },
  { id: "logistics", name: "Logistics", aspect: "lxst.ptt.logistics" },
  { id: "night", name: "Night Watch", aspect: "lxst.ptt.nightwatch" },
];
const BROKERS = [
  "wss://broker.emqx.io:8084/mqtt",
  "wss://broker.hivemq.com:8884/mqtt",
];
const RADIO_RATE = 8000;
const FRAME_SAMPLES = 320;
const STALE_MS = 22000;
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  ready: false,
  onboarded: false,
  callsign: "",
  hash: "",
  dest: "",
  peerId: "",
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
  meshUp: false,
  channelMeta: {},
};

let actx,
  osc,
  gain,
  vuTimer,
  mesh,
  micStream,
  captureNode,
  pendingPcm = new Int16Array(0),
  audioSeq = 0,
  nextPlayAt = 0,
  rxTimer = null;

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

function remaining(len) {
  const out = [];
  do {
    let d = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) d |= 0x80;
    out.push(d);
  } while (len > 0);
  return out;
}
function encodeStr(s) {
  const bytes = [...new TextEncoder().encode(s)];
  return [(bytes.length >> 8) & 255, bytes.length & 255, ...bytes];
}
function mqttPacket(type, flags, body) {
  return Uint8Array.from([(type << 4) | flags, ...remaining(body.length), ...body]);
}
function readStr(buf, i) {
  const len = (buf[i] << 8) | buf[i + 1];
  return [new TextDecoder().decode(buf.subarray(i + 2, i + 2 + len)), i + 2 + len];
}

class MqttLite {
  constructor(opts) {
    this.opts = opts;
    this.ws = null;
    this.ping = null;
    this.closed = false;
    this.brokerIndex = 0;
    this.pendingSub = [];
    this.pendingPub = [];
  }
  start() {
    this.closed = false;
    this.open();
  }
  subscribe(topic) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingSub.push(topic);
      return;
    }
    this.sendSub(topic);
  }
  publish(topic, payload, retain) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.pendingPub.push({ topic, payload, retain: !!retain });
      if (this.pendingPub.length > 24) this.pendingPub.shift();
      return;
    }
    this.sendPub(topic, payload, !!retain);
  }
  close() {
    this.closed = true;
    if (this.ping) clearInterval(this.ping);
    this.ping = null;
    try {
      this.ws && this.ws.close();
    } catch {}
    this.ws = null;
  }
  open() {
    if (this.closed) return;
    const url = BROKERS[this.brokerIndex % BROKERS.length];
    let ws;
    try {
      ws = new WebSocket(url, "mqtt");
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onopen = () => this.sendConnect();
    ws.onmessage = (ev) => this.onBytes(new Uint8Array(ev.data));
    ws.onerror = () => {};
    ws.onclose = () => {
      if (this.ping) clearInterval(this.ping);
      this.ping = null;
      this.opts.onClose && this.opts.onClose();
      if (!this.closed) this.retry();
    };
  }
  retry() {
    this.brokerIndex += 1;
    setTimeout(() => this.open(), 800 + Math.random() * 800);
  }
  sendConnect() {
    const proto = encodeStr("MQTT");
    const flags = this.opts.willTopic ? 0x26 : 0x02;
    const id = encodeStr(this.opts.clientId.slice(0, 60));
    const will = this.opts.willTopic
      ? [...encodeStr(this.opts.willTopic), ...encodeStr(this.opts.willPayload || "")]
      : [];
    this.ws.send(mqttPacket(1, 0, [...proto, 4, flags, 0, 30, ...id, ...will]));
  }
  sendSub(topic) {
    this.ws.send(mqttPacket(8, 2, [0, 1, ...encodeStr(topic), 0]));
  }
  sendPub(topic, payload, retain) {
    const body = [...encodeStr(topic), ...new TextEncoder().encode(payload)];
    this.ws.send(mqttPacket(3, retain ? 1 : 0, body));
  }
  onBytes(buf) {
    let i = 0;
    while (i < buf.length) {
      const type = buf[i] >> 4;
      let len = 0;
      let mul = 1;
      let j = i + 1;
      if (j >= buf.length) break;
      for (;;) {
        if (j >= buf.length) return;
        const d = buf[j++];
        len += (d & 127) * mul;
        mul *= 128;
        if ((d & 128) === 0) break;
      }
      if (j + len > buf.length) return;
      const payload = buf.subarray(j, j + len);
      i = j + len;
      if (type === 2) {
        if ((payload[1] || 0) !== 0) {
          try {
            this.ws.close();
          } catch {}
          return;
        }
        this.opts.onConnect && this.opts.onConnect();
        if (this.ping) clearInterval(this.ping);
        this.ping = setInterval(() => this.ws && this.ws.send(Uint8Array.from([0xc0, 0])), 20000);
        const subs = this.pendingSub.splice(0);
        for (const t of subs) this.sendSub(t);
        const pubs = this.pendingPub.splice(0);
        for (const p of pubs) this.sendPub(p.topic, p.payload, p.retain);
      } else if (type === 3) {
        const [topic, k] = readStr(payload, 0);
        this.opts.onMessage && this.opts.onMessage(topic, new TextDecoder().decode(payload.subarray(k)));
      }
    }
  }
}

function meshBase(room) {
  const r = room.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "calling";
  return "lxst/6/" + r;
}

class MqttMesh {
  constructor(opts) {
    this.base = meshBase(opts.room);
    this.selfId = opts.selfId;
    this.onPacket = opts.onPacket;
    this.onStatus = opts.onStatus;
    this.onLeave = opts.onLeave;
    this.client = null;
    this.up = false;
  }
  start() {
    const presence = this.base + "/p/" + this.selfId;
    const client = new MqttLite({
      clientId: ("lx" + this.selfId).slice(0, 60),
      willTopic: presence,
      willPayload: "",
      onConnect: () => {
        this.up = true;
        this.onStatus(true);
        client.subscribe(this.base + "/p/+");
        client.subscribe(this.base + "/m");
      },
      onClose: () => {
        this.up = false;
        this.onStatus(false);
      },
      onMessage: (topic, payload) => this.handle(topic, payload),
    });
    this.client = client;
    client.start();
  }
  send(packet, retain) {
    const json = JSON.stringify({ f: this.selfId, d: packet });
    if (packet.k === "ann") this.client && this.client.publish(this.base + "/p/" + this.selfId, json, true);
    this.client && this.client.publish(this.base + "/m", json, !!retain);
  }
  close() {
    try {
      this.client && this.client.publish(this.base + "/p/" + this.selfId, "", true);
    } catch {}
    this.client && this.client.close();
    this.client = null;
    this.up = false;
  }
  handle(topic, payload) {
    const parts = topic.split("/");
    if (parts[3] === "p") {
      const from = parts[4] || "";
      if (!from || from === this.selfId) return;
      if (!payload) {
        this.onLeave(from);
        return;
      }
    }
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (!parsed || typeof parsed.f !== "string" || !parsed.d || !parsed.d.k) return;
    if (parsed.f === this.selfId) return;
    this.onPacket(parsed.f, parsed.d);
  }
}

function sessionId() {
  let s = sessionStorage.getItem("lxst.session");
  if (s && /^[a-z0-9]+$/i.test(s)) return s.slice(0, 8);
  s = hex(crypto.getRandomValues(new Uint8Array(3)));
  sessionStorage.setItem("lxst.session", s);
  return s;
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
  state.peerId = ("i" + state.hash.slice(0, 24) + sessionId()).slice(0, 64);
  state.callsign = (persisted.callsign || "OP-" + state.hash.slice(0, 4).toUpperCase()).slice(0, 16);
  state.onboarded = Boolean(persisted.onboarded);
  state.channelId = persisted.channelId || "calling";
  state.vol = typeof persisted.vol === "number" ? persisted.vol : 0.88;
  state.stations = [];
  state.chats = loadJson(CHAT_KEY, {});
  state.flags = loadJson(FLAGS_KEY, {});
  for (const c of CHANNELS) {
    const destHash = await sha16(c.aspect);
    state.channelMeta[c.id] = {
      destHash,
      room: "ch" + destHash.slice(0, 30),
      freq: freqFrom(destHash),
    };
  }
  state.ready = true;
}

function flag(id) {
  return state.flags[id] || { pin: false, mute: false };
}
function setFlag(id, key) {
  const cur = { pin: false, mute: false, ...flag(id) };
  cur[key] = !cur[key];
  state.flags[id] = cur;
  localStorage.setItem(FLAGS_KEY, JSON.stringify(state.flags));
  renderSheet();
  renderMesh();
  renderChat();
}
function channel() {
  return CHANNELS.find((c) => c.id === state.channelId) || CHANNELS[0];
}
function meta() {
  return state.channelMeta[state.channelId] || { destHash: state.dest, room: "calling", freq: "7.074" };
}
function station(id) {
  return state.stations.find((s) => s.id === id);
}
function upsertStation(id, patch) {
  const existing = station(id);
  const next = {
    id,
    name: (patch.name || (existing && existing.name) || id.slice(0, 8)).slice(0, 16),
    hash: patch.hash || (existing && existing.hash) || "",
    talking: patch.talking !== undefined ? patch.talking : existing ? existing.talking : false,
    lastHeard: patch.lastHeard || Date.now(),
  };
  if (existing) {
    Object.assign(existing, next);
  } else {
    state.stations.push(next);
  }
  renderHeader();
  renderLcd();
  if (state.tab === "mesh") renderMesh();
  if (state.tab === "chat") renderChat();
}
function dropStation(id) {
  state.stations = state.stations.filter((s) => s.id !== id);
  if (state.selected === id) state.selected = null;
  renderHeader();
  renderLcd();
  renderSheet();
  if (state.tab === "mesh") renderMesh();
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
  const m = meta();
  $("#lcd-freq").textContent = m.freq;
  $("#lcd-aspect").textContent = "MHz · " + ch.aspect;
  $("#lcd-name").textContent = ch.name;
  $("#lcd-dest").textContent = pretty(m.destHash);
  const sel = station(state.selected);
  $("#lcd-status").textContent = state.tx
    ? "TX ON AIR"
    : sel
      ? "TO " + sel.name
      : state.meshUp
        ? "NET OPEN"
        : "SCANNING";
  $("#lcd-status").style.color = state.tx ? "var(--tx)" : "var(--lcd-dim)";
  const live = state.stations.length;
  $("#lcd-count").textContent = live + "/" + live + " lnk";
  $('[data-led="tx"]').classList.toggle("on", state.tx);
  $('[data-led="tx"]').classList.toggle("tx", state.tx);
  $('[data-led="net"]').classList.toggle("on", state.meshUp);
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
  $("#sheet-kind").textContent = f.mute ? "🔇" : "live";
  $("#act-pin").textContent = f.pin ? "Unpin" : "Pin";
  $("#act-mute").textContent = f.mute ? "Unmute" : "Mute";
}

function renderMesh() {
  const list = $("#mesh-list");
  $("#mesh-blurb").textContent = state.meshUp
    ? "Live peers on this channel. Tap a station for simplex PTT."
    : "Joining destination…";
  if (!state.stations.length) {
    list.innerHTML = `<li><div class="card muted">No live peers yet. Open this page on a second phone, stay on the same channel, and wait for the Net LED.</div></li>`;
    return;
  }
  list.innerHTML = state.stations
    .map((s) => {
      const f = flag(s.id);
      return `<li>
        <button type="button" class="row" data-pick="${s.id}">
          <strong>${escapeHtml(s.name)}${f.mute ? " 🔇" : ""}</strong>
          <span class="preview">${escapeHtml(pretty(s.hash))}${f.pin ? " · pinned" : ""}</span>
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
      last,
      unread: (thread && thread.unread) || 0,
      t: last ? last.t : 0,
      mute: flag(s.id).mute,
    };
  });
  contacts.sort((a, b) => b.t - a.t || a.name.localeCompare(b.name));
  if (!contacts.length) {
    $("#thread-list").innerHTML =
      `<li><div class="card muted">Quiet net. A live station on this channel will show up here.</div></li>`;
    return;
  }
  $("#thread-list").innerHTML = contacts
    .map(
      (r) => `<li>
        <button type="button" class="row" data-open="${r.id}">
          <strong>${escapeHtml(r.name)}${r.mute ? " 🔇" : ""}</strong>
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
    $("#chat-title").textContent = st.name + (flag(st.id).mute ? " 🔇" : "");
    $("#chat-sub").textContent = pretty(st.hash);
    $("#chat-in").placeholder = "Message " + st.name;
    renderMsgs();
  } else {
    state.chatPeer = state.chatPeer && station(state.chatPeer) ? state.chatPeer : null;
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

function sendPacket(packet) {
  const to = state.directed || (packet.k === "lx" ? state.chatPeer : state.selected);
  if (to && packet.k !== "ann") packet.to = to;
  mesh && mesh.send(packet);
}

function announce() {
  sendPacket({ k: "ann", cs: state.callsign, ih: state.hash, dh: state.dest });
}

function startMesh() {
  if (mesh) {
    try {
      mesh.close();
    } catch {}
  }
  const m = meta();
  mesh = new MqttMesh({
    room: m.room,
    selfId: state.peerId,
    onStatus: (up) => {
      state.meshUp = up;
      renderLcd();
      renderBars(up ? Math.min(4, 1 + state.stations.length) : 0);
      if (up) announce();
      if (state.tab === "mesh") renderMesh();
    },
    onLeave: (from) => dropStation(from),
    onPacket: onMeshPacket,
  });
  mesh.start();
}

function onMeshPacket(from, data) {
  if (data.to && data.to !== state.peerId) return;
  const muted = flag(from).mute;
  if (data.k === "ann") {
    upsertStation(from, { name: data.cs, hash: data.ih, lastHeard: Date.now() });
  } else if (data.k === "ptt") {
    upsertStation(from, { name: data.cs, talking: data.on, lastHeard: Date.now() });
    if (data.on && !muted) {
      $('[data-led="rx"]').classList.add("on");
      if (rxTimer) clearTimeout(rxTimer);
      rxTimer = setTimeout(() => $('[data-led="rx"]').classList.remove("on"), 600);
    }
  } else if (data.k === "a") {
    if (muted) return;
    upsertStation(from, { talking: true, lastHeard: Date.now() });
    void playRx(data.p);
    $('[data-led="rx"]').classList.add("on");
    if (rxTimer) clearTimeout(rxTimer);
    rxTimer = setTimeout(() => {
      $('[data-led="rx"]').classList.remove("on");
      upsertStation(from, { talking: false });
    }, 420);
  } else if (data.k === "lx") {
    upsertStation(from, { name: data.cs, lastHeard: Date.now() });
    pushMsg(from, { from: "them", text: data.m, t: Date.now() });
  }
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

function downsample(input, fromRate) {
  const ratio = fromRate / RADIO_RATE;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const sample = input[Math.floor(i * ratio)] || 0;
    const clipped = Math.max(-1, Math.min(1, sample));
    out[i] = clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff;
  }
  return out;
}
function int16ToB64(samples) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
function flushPcm() {
  while (pendingPcm.length >= FRAME_SAMPLES) {
    const frame = pendingPcm.subarray(0, FRAME_SAMPLES);
    pendingPcm = pendingPcm.subarray(FRAME_SAMPLES);
    sendPacket({ k: "a", s: audioSeq++, p: int16ToB64(frame) });
  }
}

async function startMic() {
  const audio = await ensureAudio();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    return;
  }
  const src = audio.createMediaStreamSource(micStream);
  const proc = audio.createScriptProcessor(2048, 1, 1);
  pendingPcm = new Int16Array(0);
  proc.onaudioprocess = (ev) => {
    if (!state.tx) return;
    const ch = ev.inputBuffer.getChannelData(0);
    const down = downsample(ch, audio.sampleRate);
    const merged = new Int16Array(pendingPcm.length + down.length);
    merged.set(pendingPcm);
    merged.set(down, pendingPcm.length);
    pendingPcm = merged;
    flushPcm();
  };
  src.connect(proc);
  const silent = audio.createGain();
  silent.gain.value = 0.00001;
  proc.connect(silent);
  silent.connect(audio.destination);
  captureNode = proc;
}

function stopMic() {
  try {
    captureNode && captureNode.disconnect();
  } catch {}
  captureNode = null;
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  pendingPcm = new Int16Array(0);
}

async function playRx(b64) {
  try {
    const audio = await ensureAudio();
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const samples = new Int16Array(bytes.buffer);
    if (!samples.length) return;
    const pcm = new Float32Array(samples.length);
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i] < 0 ? samples[i] / 0x8000 : samples[i] / 0x7fff;
      pcm[i] = v;
      peak = Math.max(peak, Math.abs(v));
    }
    if (peak < 0.04) return;
    const buffer = audio.createBuffer(1, pcm.length, RADIO_RATE);
    buffer.copyToChannel(pcm, 0);
    const src = audio.createBufferSource();
    const g = audio.createGain();
    g.gain.value = state.vol;
    src.buffer = buffer;
    src.connect(g);
    g.connect(audio.destination);
    const now = audio.currentTime;
    if (nextPlayAt < now + 0.04) nextPlayAt = now + 0.04;
    src.start(nextPlayAt);
    nextPlayAt += buffer.duration;
    renderVu(Math.min(1, peak * 2.2), false);
  } catch {}
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
  sendPacket({ k: "ptt", on: true, cs: state.callsign });
  void startMic();
  let t = 0;
  clearInterval(vuTimer);
  vuTimer = setInterval(() => {
    t += 1;
    renderVu(0.35 + Math.abs(Math.sin(t / 4)) * 0.55, true);
  }, 80);
}
function stopTx() {
  stopTone();
  stopMic();
  if (state.tx) sendPacket({ k: "ptt", on: false, cs: state.callsign });
  state.tx = false;
  $("#ptt").classList.remove("hot");
  $("#ptt-cap").textContent = "Hold";
  $(".ptt .ptt-k").textContent = "PTT";
  clearInterval(vuTimer);
  renderVu(0, false);
  renderLcd();
  renderBars(state.meshUp ? Math.min(4, 1 + state.stations.length) : 0);
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

  const hits = state.stations.map((s) => {
    const a = -Math.PI / 2 + angleFor(s.id);
    const r = radius * (0.78 + angleFor(s.id + "r") * 0.18);
    return { s, x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
  });
  state.hits = hits;
  for (const p of hits) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(p.x, p.y);
    ctx.strokeStyle = p.s.talking || state.tx ? "rgba(126, 201, 154, 0.55)" : "rgba(232, 238, 233, 0.12)";
    ctx.stroke();
  }
  drawNode(ctx, cx, cy, state.tx ? "#c45c4a" : "#7ec99a", state.tx, state.callsign.slice(0, 8), false, false);
  for (const p of hits) {
    const f = flag(p.s.id);
    const sel = state.selected === p.s.id;
    const color = sel ? "#e8eee9" : f.pin ? "#c9a86a" : p.s.talking ? "#c45c4a" : "#7ec99a";
    drawNode(ctx, p.x, p.y, color, sel || p.s.talking, p.s.name.slice(0, 8), sel, f.mute);
  }
}
function drawNode(ctx, x, y, color, pulse, label, selected, muted) {
  if (selected) {
    ctx.beginPath();
    ctx.arc(x, y, 13, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(232, 238, 233, 0.85)";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
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
  if (muted) {
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("🔇", x, y - 12);
  }
  ctx.font = "500 10px 'IBM Plex Mono', monospace";
  ctx.fillStyle = selected ? "rgba(232, 238, 233, 0.95)" : "rgba(232, 238, 233, 0.72)";
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
  renderBars(0);
  $("#vol").value = String(state.vol);
  resizeRadar();
  startMesh();
  try {
    navigator.vibrate?.(12);
  } catch {}
}

async function main() {
  await bootIdentity();
  window.__lxst = state;
  $("#on-hash").textContent = pretty(state.dest);
  $("#on-call").value = state.callsign;
  renderHeader();
  const tick = () => {
    $("#clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  };
  tick();
  setInterval(tick, 10000);
  setInterval(() => {
    if (!state.onboarded) return;
    if (state.meshUp) announce();
    const now = Date.now();
    for (const s of [...state.stations]) {
      if (now - s.lastHeard > STALE_MS) dropStation(s.id);
    }
  }, 3000);

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
    state.stations = [];
    state.selected = null;
    save();
    renderChips();
    renderLcd();
    renderSheet();
    startMesh();
  });
  $("#ch-prev").addEventListener("click", () => stepCh(-1));
  $("#ch-next").addEventListener("click", () => stepCh(1));
  function stepCh(dir) {
    const i = CHANNELS.findIndex((c) => c.id === state.channelId);
    state.channelId = CHANNELS[(i + dir + CHANNELS.length) % CHANNELS.length].id;
    state.stations = [];
    state.selected = null;
    save();
    renderChips();
    renderLcd();
    renderSheet();
    startMesh();
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
    sendPacket({ k: "lx", m: text.slice(0, 240), cs: state.callsign, to: state.chatPeer });
  });
  $("#burst-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("#burst-in").value.trim();
    if (!text) return;
    $("#burst-in").value = "";
    sendPacket({ k: "lx", m: text.slice(0, 240), cs: state.callsign });
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
    if (state.meshUp) announce();
  });
  $("#btn-newid").addEventListener("click", async () => {
    localStorage.removeItem(KEY);
    await bootIdentity();
    state.onboarded = true;
    save();
    renderHeader();
    renderId();
    renderLcd();
    startMesh();
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
    navigator.serviceWorker.register("./sw.js?v=6").catch(() => {});
  });
}

main();
