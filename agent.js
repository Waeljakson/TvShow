const fs = require("fs");
const path = require("path");
const os = require("os");
const { WebSocket } = require("ws");

const ROOT = __dirname;
const CONFIG_FILE = path.join(ROOT, "agent-config.json");
const EXAMPLE_FILE = path.join(ROOT, "agent-config.example.json");

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".m4v"]);
const MIME = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif"
};

function ensureConfig() {
  if (fs.existsSync(CONFIG_FILE)) return;
  const base = {
    serverUrl: "https://YOUR-TVSHOW-SERVER.onrender.com",
    agentKey: "CHANGE_THIS_AGENT_KEY",
    mediaDir: path.join(ROOT, "media"),
    imageDuration: 10,
    order: [],
    imageDurations: {},
    reconnectSeconds: 5
  };
  if (fs.existsSync(EXAMPLE_FILE)) {
    fs.copyFileSync(EXAMPLE_FILE, CONFIG_FILE);
  } else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(base, null, 2), "utf8");
  }
}

function loadConfig() {
  ensureConfig();
  const text = fs.readFileSync(CONFIG_FILE, "utf8").replace(/^\uFEFF/, "");
  const raw = JSON.parse(text);
  return {
    serverUrl: String(raw.serverUrl || "").replace(/\/$/, ""),
    agentKey: String(raw.agentKey || ""),
    mediaDir: path.resolve(String(raw.mediaDir || path.join(ROOT, "media"))),
    imageDuration: Math.min(3600, Math.max(1, Number(raw.imageDuration || 10))),
    order: Array.isArray(raw.order) ? raw.order.map(String) : [],
    imageDurations: raw.imageDurations && typeof raw.imageDurations === "object" ? raw.imageDurations : {},
    reconnectSeconds: Math.min(60, Math.max(2, Number(raw.reconnectSeconds || 5)))
  };
}

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error("");
  console.error("[CONFIG ERROR] Could not read agent-config.json");
  console.error(err.message);
  console.error("Delete agent-config.json and run start.bat again.");
  console.error("");
  process.exit(1);
}
let ws = null;
let reconnectTimer = null;
let lastSignature = "";
const activeStreams = new Map();

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

function normalizeRel(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

function resolveMediaFile(rel) {
  const root = path.resolve(config.mediaDir);
  const target = path.resolve(root, normalizeRel(rel).split("/").join(path.sep));
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

function walk(dir, base = dir, output = []) {
  if (!fs.existsSync(dir)) return output;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, output);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (!IMAGE_EXTS.has(ext) && !VIDEO_EXTS.has(ext)) continue;
    const stat = fs.statSync(full);
    const rel = path.relative(base, full).split(path.sep).join("/");
    output.push({
      id: rel,
      name: entry.name,
      folder: path.dirname(rel) === "." ? "" : path.dirname(rel).split(path.sep).join("/"),
      type: IMAGE_EXTS.has(ext) ? "image" : "video",
      ext,
      size: stat.size,
      mtimeMs: stat.mtimeMs
    });
  }
  return output;
}

function buildPlaylist() {
  const scanned = walk(config.mediaDir);
  const byId = new Map(scanned.map(item => [item.id, item]));
  const ordered = [];

  for (const mediaId of config.order) {
    if (byId.has(mediaId)) {
      ordered.push(byId.get(mediaId));
      byId.delete(mediaId);
    }
  }

  const rest = [...byId.values()].sort((a, b) =>
    a.id.localeCompare(b.id, "ar", { numeric: true, sensitivity: "base" })
  );
  ordered.push(...rest);

  config.order = ordered.map(item => item.id);

  return ordered.map((item, index) => ({
    ...item,
    index,
    duration: item.type === "image"
      ? Number(config.imageDurations[item.id] || config.imageDuration)
      : null,
    mediaUrl: "/media?file=" + encodeURIComponent(item.id)
  }));
}

function signature(items) {
  return items.map(x => `${x.id}:${x.size}:${x.mtimeMs}:${x.duration}`).join("|");
}

function send(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function sendPlaylist(force = false) {
  const items = buildPlaylist();
  const sig = signature(items);
  if (!force && sig === lastSignature) return;
  lastSignature = sig;
  saveConfig();
  send({
    type: "playlist",
    items,
    settings: {
      mediaDir: config.mediaDir,
      imageDuration: config.imageDuration
    }
  });
}

function toWebSocketUrl() {
  const base = config.serverUrl;
  if (!/^https?:\/\//i.test(base)) throw new Error("serverUrl must start with http:// or https://");
  const wsBase = base.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:");
  return `${wsBase}/agent?key=${encodeURIComponent(config.agentKey)}`;
}

function parseRange(rangeHeader, size) {
  if (!rangeHeader) return { status: 200, start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(rangeHeader).trim());
  if (!match) return null;
  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) return null;
  end = Math.min(end, size - 1);
  return { status: 206, start, end };
}

async function streamMedia(msg) {
  const requestId = String(msg.requestId || "");
  const mediaId = normalizeRel(msg.id);
  if (!requestId || !mediaId) return;

  const file = resolveMediaFile(mediaId);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    send({ type: "media-error", requestId, status: 404, error: "file_not_found" });
    return;
  }

  const ext = path.extname(file).toLowerCase();
  const mime = MIME[ext];
  if (!mime) {
    send({ type: "media-error", requestId, status: 415, error: "unsupported_media" });
    return;
  }

  const stat = fs.statSync(file);
  const range = parseRange(msg.range, stat.size);
  if (!range) {
    send({ type: "media-error", requestId, status: 416, error: "invalid_range" });
    return;
  }

  const contentLength = range.end - range.start + 1;
  send({
    type: "media-meta",
    requestId,
    status: range.status,
    mime,
    contentLength,
    contentRange: range.status === 206 ? `bytes ${range.start}-${range.end}/${stat.size}` : null,
    acceptRanges: "bytes"
  });

  const stream = fs.createReadStream(file, {
    start: range.start,
    end: range.end,
    highWaterMark: 192 * 1024
  });

  activeStreams.set(requestId, { stream, waitingAck: false });

  stream.on("data", chunk => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      stream.destroy();
      return;
    }
    stream.pause();
    const state = activeStreams.get(requestId);
    if (state) state.waitingAck = true;
    const push = () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        stream.destroy();
        return;
      }
      if (ws.bufferedAmount > 2 * 1024 * 1024) {
        setTimeout(push, 20);
        return;
      }
      send({ type: "media-chunk", requestId, data: chunk.toString("base64") });
    };
    push();
  });

  stream.on("end", () => {
    activeStreams.delete(requestId);
    send({ type: "media-end", requestId });
  });

  stream.on("error", err => {
    activeStreams.delete(requestId);
    send({ type: "media-error", requestId, status: 500, error: err.message });
  });
}

function commandResult(requestId, ok, data = {}, error = null) {
  send({ type: "command-result", requestId, ok, data, error });
}

function handleCommand(msg) {
  const requestId = String(msg.requestId || "");
  const action = String(msg.action || "");
  const data = msg.data || {};

  try {
    if (action === "set-settings") {
      if (typeof data.mediaDir === "string" && data.mediaDir.trim()) {
        const resolved = path.resolve(data.mediaDir.trim());
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
          return commandResult(requestId, false, {}, "folder_not_found");
        }
        config.mediaDir = resolved;
        config.order = [];
      }
      if (Number.isFinite(Number(data.imageDuration))) {
        config.imageDuration = Math.min(3600, Math.max(1, Math.round(Number(data.imageDuration))));
      }
      saveConfig();
      lastSignature = "";
      sendPlaylist(true);
      return commandResult(requestId, true, {
        mediaDir: config.mediaDir,
        imageDuration: config.imageDuration
      });
    }

    if (action === "set-order") {
      const known = new Set(buildPlaylist().map(item => item.id));
      const order = Array.isArray(data.order) ? data.order.map(normalizeRel) : [];
      if (order.some(x => !known.has(x))) return commandResult(requestId, false, {}, "unknown_item");
      config.order = [...new Set(order)];
      saveConfig();
      lastSignature = "";
      sendPlaylist(true);
      return commandResult(requestId, true);
    }

    if (action === "set-image-duration") {
      const mediaId = normalizeRel(data.id);
      const duration = Number(data.duration);
      if (!mediaId || !Number.isFinite(duration)) return commandResult(requestId, false, {}, "invalid_data");
      config.imageDurations[mediaId] = Math.min(3600, Math.max(1, Math.round(duration)));
      saveConfig();
      lastSignature = "";
      sendPlaylist(true);
      return commandResult(requestId, true);
    }

    return commandResult(requestId, false, {}, "unknown_command");
  } catch (err) {
    return commandResult(requestId, false, {}, err.message);
  }
}

function connect() {
  clearTimeout(reconnectTimer);
  try {
    config = loadConfig();
  } catch (err) {
    console.error("[CONFIG ERROR]", err.message);
    reconnectTimer = setTimeout(connect, 10000);
    return;
  }

  if (!config.serverUrl || config.serverUrl.includes("YOUR-TVSHOW-SERVER") || !config.agentKey || config.agentKey.includes("CHANGE_THIS")) {
    console.error("");
    console.error("TvShow Agent is not configured yet.");
    console.error("Edit agent-config.json and set serverUrl + agentKey.");
    console.error("");
    reconnectTimer = setTimeout(connect, 10000);
    return;
  }

  let url;
  try {
    url = toWebSocketUrl();
  } catch (err) {
    console.error(err.message);
    reconnectTimer = setTimeout(connect, 10000);
    return;
  }

  console.log(`Connecting to ${config.serverUrl} ...`);
  ws = new WebSocket(url);

  ws.on("open", () => {
    console.log("TvShow Agent connected.");
    send({
      type: "hello",
      hostname: os.hostname(),
      version: "2.0.0"
    });
    lastSignature = "";
    sendPlaylist(true);
  });

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "command") {
      handleCommand(msg);
      return;
    }

    if (msg.type === "media-request") {
      streamMedia(msg);
      return;
    }

    if (msg.type === "media-ack") {
      const state = activeStreams.get(String(msg.requestId || ""));
      if (state?.stream && state.waitingAck) {
        state.waitingAck = false;
        state.stream.resume();
      }
      return;
    }

    if (msg.type === "media-cancel") {
      const state = activeStreams.get(String(msg.requestId || ""));
      if (state?.stream) {
        state.stream.destroy();
        activeStreams.delete(String(msg.requestId || ""));
      }
    }
  });

  ws.on("close", () => {
    console.log("Agent disconnected. Reconnecting...");
    for (const state of activeStreams.values()) {
      try { state.stream?.destroy(); } catch {}
    }
    activeStreams.clear();
    reconnectTimer = setTimeout(connect, config.reconnectSeconds * 1000);
  });

  ws.on("error", err => {
    console.error("Connection error:", err.message);
  });
}

setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) send({ type: "heartbeat", ts: Date.now() });
}, 5000);

setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) {
    try { sendPlaylist(false); } catch (err) { console.error("Scan error:", err.message); }
  }
}, 3000);

connect();
