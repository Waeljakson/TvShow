const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const ADMIN_PIN = String(process.env.ADMIN_PIN || "2468");

const ROOT = __dirname;
const RUNTIME_DIR = path.join(ROOT, "runtime");
const CONFIG_FILE = path.join(RUNTIME_DIR, "config.json");
const DEFAULT_MEDIA_DIR = path.join(ROOT, "media");

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

fs.mkdirSync(RUNTIME_DIR, { recursive: true });
fs.mkdirSync(DEFAULT_MEDIA_DIR, { recursive: true });

function loadConfig() {
  const base = {
    mediaDir: DEFAULT_MEDIA_DIR,
    imageDuration: 10,
    order: [],
    imageDurations: {}
  };
  try {
    if (!fs.existsSync(CONFIG_FILE)) return base;
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return {
      ...base,
      ...parsed,
      imageDurations: parsed.imageDurations || {},
      order: Array.isArray(parsed.order) ? parsed.order : []
    };
  } catch {
    return base;
  }
}

let config = loadConfig();

function saveConfig() {
  const tmp = CONFIG_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
  fs.renameSync(tmp, CONFIG_FILE);
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

  for (const id of config.order) {
    if (byId.has(id)) {
      ordered.push(byId.get(id));
      byId.delete(id);
    }
  }

  const newItems = [...byId.values()].sort((a, b) =>
    a.id.localeCompare(b.id, "ar", { numeric: true, sensitivity: "base" })
  );
  ordered.push(...newItems);

  const mergedOrder = ordered.map(x => x.id);
  if (JSON.stringify(mergedOrder) !== JSON.stringify(config.order)) {
    config.order = mergedOrder;
    saveConfig();
  }

  return ordered.map((item, index) => ({
    ...item,
    index,
    duration: item.type === "image"
      ? Number(config.imageDurations[item.id] || config.imageDuration || 10)
      : null,
    mediaUrl: "/media?file=" + encodeURIComponent(item.id)
  }));
}

let lastSignature = "";
let displayState = {
  lastSeen: 0,
  currentId: null,
  currentName: null,
  status: "unknown",
  position: 0
};

function playlistSignature(items) {
  return items.map(x => `${x.id}:${x.size}:${x.mtimeMs}:${x.duration}`).join("|");
}

const clients = new Set();

function sseSend(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(event, payload) {
  for (const res of clients) {
    try { sseSend(res, event, payload); } catch {}
  }
}

function refreshAndBroadcast(force = false) {
  try {
    const items = buildPlaylist();
    const sig = playlistSignature(items);
    if (force || sig !== lastSignature) {
      lastSignature = sig;
      broadcast("playlist", { count: items.length, ts: Date.now() });
    }
  } catch (err) {
    broadcast("server-error", { message: err.message });
  }
}

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ROOT, "public"), {
  etag: true,
  maxAge: 0
}));

app.get("/", (_req, res) => res.redirect("/display"));
app.get("/admin", (_req, res) => res.sendFile(path.join(ROOT, "public", "admin.html")));
app.get("/display", (_req, res) => res.sendFile(path.join(ROOT, "public", "display.html")));

app.get("/api/playlist", (_req, res) => {
  try {
    res.json({
      mediaDirReady: fs.existsSync(config.mediaDir),
      items: buildPlaylist()
    });
  } catch (err) {
    res.status(500).json({ error: err.message, items: [] });
  }
});

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  clients.add(res);
  sseSend(res, "connected", { ok: true, ts: Date.now() });
  const heartbeat = setInterval(() => {
    try { res.write(": keepalive\n\n"); } catch {}
  }, 20000);
  req.on("close", () => {
    clearInterval(heartbeat);
    clients.delete(res);
  });
});

app.post("/api/display/state", (req, res) => {
  const body = req.body || {};
  displayState = {
    lastSeen: Date.now(),
    currentId: typeof body.currentId === "string" ? body.currentId : null,
    currentName: typeof body.currentName === "string" ? body.currentName : null,
    status: typeof body.status === "string" ? body.status : "playing",
    position: Number.isFinite(Number(body.position)) ? Number(body.position) : 0
  };
  res.json({ ok: true });
});

app.get("/api/status", (_req, res) => {
  res.json({
    online: Date.now() - displayState.lastSeen < 15000,
    display: displayState,
    mediaDir: config.mediaDir,
    defaultImageDuration: config.imageDuration,
    itemCount: buildPlaylist().length
  });
});

function requirePin(req, res, next) {
  const pin = String(req.get("x-admin-pin") || "");
  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ error: "invalid_pin" });
  }
  next();
}

app.post("/api/admin/verify", (req, res) => {
  const pin = String(req.body?.pin || "");
  res.status(pin === ADMIN_PIN ? 200 : 401).json({ ok: pin === ADMIN_PIN });
});

app.post("/api/admin/settings", requirePin, (req, res) => {
  const mediaDir = typeof req.body?.mediaDir === "string" ? req.body.mediaDir.trim() : "";
  const duration = Number(req.body?.imageDuration);

  if (mediaDir) {
    const resolved = path.resolve(mediaDir);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return res.status(400).json({ error: "folder_not_found" });
    }
    config.mediaDir = resolved;
    config.order = [];
  }

  if (Number.isFinite(duration)) {
    config.imageDuration = Math.min(3600, Math.max(1, Math.round(duration)));
  }

  saveConfig();
  refreshAndBroadcast(true);
  res.json({ ok: true, mediaDir: config.mediaDir, imageDuration: config.imageDuration });
});

app.post("/api/admin/order", requirePin, (req, res) => {
  const order = Array.isArray(req.body?.order) ? req.body.order.map(normalizeRel) : null;
  if (!order) return res.status(400).json({ error: "invalid_order" });
  const known = new Set(buildPlaylist().map(x => x.id));
  if (order.some(id => !known.has(id))) {
    return res.status(400).json({ error: "unknown_item" });
  }
  config.order = [...new Set(order)];
  saveConfig();
  refreshAndBroadcast(true);
  res.json({ ok: true });
});

app.post("/api/admin/image-duration", requirePin, (req, res) => {
  const id = normalizeRel(req.body?.id);
  const duration = Number(req.body?.duration);
  if (!id || !Number.isFinite(duration)) {
    return res.status(400).json({ error: "invalid_data" });
  }
  config.imageDurations[id] = Math.min(3600, Math.max(1, Math.round(duration)));
  saveConfig();
  refreshAndBroadcast(true);
  res.json({ ok: true });
});

app.post("/api/admin/control", requirePin, (req, res) => {
  const allowed = new Set(["play", "pause", "next", "previous", "reload", "show"]);
  const action = String(req.body?.action || "");
  if (!allowed.has(action)) return res.status(400).json({ error: "invalid_action" });

  const payload = { action };
  if (action === "show") {
    const id = normalizeRel(req.body?.id);
    if (!buildPlaylist().some(x => x.id === id)) {
      return res.status(404).json({ error: "item_not_found" });
    }
    payload.id = id;
  }

  broadcast("control", payload);
  res.json({ ok: true });
});

app.get("/media", (req, res) => {
  const rel = normalizeRel(req.query.file);
  const file = resolveMediaFile(rel);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return res.sendStatus(404);
  }

  const ext = path.extname(file).toLowerCase();
  if (!MIME[ext]) return res.sendStatus(415);

  const stat = fs.statSync(file);
  const range = req.headers.range;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", MIME[ext]);
  res.setHeader("Cache-Control", "no-cache");

  if (!range || !VIDEO_EXTS.has(ext)) {
    res.setHeader("Content-Length", stat.size);
    return fs.createReadStream(file).pipe(res);
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) return res.sendStatus(416);

  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : stat.size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= stat.size) {
    return res.sendStatus(416);
  }

  end = Math.min(end, stat.size - 1);
  const chunkSize = end - start + 1;
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
  res.setHeader("Content-Length", chunkSize);
  fs.createReadStream(file, { start, end }).pipe(res);
});

setInterval(() => refreshAndBroadcast(false), 3000);
setInterval(() => {
  broadcast("status", { online: Date.now() - displayState.lastSeen < 15000 });
}, 5000);

refreshAndBroadcast(true);

app.listen(PORT, HOST, () => {
  console.log("");
  console.log("TvShow is running");
  console.log(`Admin:   http://localhost:${PORT}/admin`);
  console.log(`Display: http://localhost:${PORT}/display`);
  console.log(`Media:   ${config.mediaDir}`);
  console.log("");
});
