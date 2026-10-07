const express = require("express");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const ADMIN_PIN = String(process.env.ADMIN_PIN || "2468");
const AGENT_KEY = String(process.env.AGENT_KEY || "change-me-agent-key");

const ROOT = __dirname;

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(ROOT, "public"), { etag: true, maxAge: 0 }));

app.get("/", (_req, res) => res.redirect("/display"));
app.get("/admin", (_req, res) => res.sendFile(path.join(ROOT, "public", "admin.html")));
app.get("/display", (_req, res) => res.sendFile(path.join(ROOT, "public", "display.html")));

let agentSocket = null;
let agentMeta = {
  connected: false,
  lastSeen: 0,
  hostname: null,
  version: null,
  mediaDir: "",
  imageDuration: 10
};
let playlist = [];
let schedules = [];

let displayState = {
  lastSeen: 0,
  currentId: null,
  currentName: null,
  status: "unknown",
  position: 0
};

const sseClients = new Set();
const pendingCommands = new Map();
const pendingMedia = new Map();

function id() {
  return crypto.randomUUID();
}

function isAgentOnline() {
  return Boolean(agentSocket && agentSocket.readyState === 1 && Date.now() - agentMeta.lastSeen < 20000);
}

function isDisplayOnline() {
  return Date.now() - displayState.lastSeen < 15000;
}

function sseSend(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(event, payload) {
  for (const res of sseClients) {
    try { sseSend(res, event, payload); } catch {}
  }
}

function safeSendAgent(payload) {
  if (!agentSocket || agentSocket.readyState !== 1) return false;
  try {
    agentSocket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function requirePin(req, res, next) {
  const pin = String(req.get("x-admin-pin") || "");
  if (pin !== ADMIN_PIN) return res.status(401).json({ error: "invalid_pin" });
  next();
}

function sendAgentCommand(action, data = {}, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    if (!isAgentOnline()) return reject(new Error("agent_offline"));
    const requestId = id();
    const timer = setTimeout(() => {
      pendingCommands.delete(requestId);
      reject(new Error("agent_timeout"));
    }, timeoutMs);
    pendingCommands.set(requestId, { resolve, reject, timer });
    if (!safeSendAgent({ type: "command", requestId, action, data })) {
      clearTimeout(timer);
      pendingCommands.delete(requestId);
      reject(new Error("agent_offline"));
    }
  });
}

app.post("/api/admin/verify", (req, res) => {
  const pin = String(req.body?.pin || "");
  res.status(pin === ADMIN_PIN ? 200 : 401).json({ ok: pin === ADMIN_PIN });
});

app.get("/api/status", (_req, res) => {
  res.json({
    agentOnline: isAgentOnline(),
    displayOnline: isDisplayOnline(),
    agent: agentMeta,
    display: displayState,
    itemCount: playlist.length,
    scheduleCount: schedules.length
  });
});

app.get("/api/playlist", (_req, res) => {
  res.json({
    agentOnline: isAgentOnline(),
    items: playlist,
    mediaDir: agentMeta.mediaDir,
    imageDuration: agentMeta.imageDuration,
    schedules
  });
});

app.get("/api/schedules", (_req, res) => {
  res.json({ schedules });
});

app.get("/api/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  sseClients.add(res);
  sseSend(res, "connected", {
    ok: true,
    agentOnline: isAgentOnline(),
    displayOnline: isDisplayOnline(),
    ts: Date.now()
  });
  const heartbeat = setInterval(() => {
    try { res.write(": keepalive\n\n"); } catch {}
  }, 20000);
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
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

app.post("/api/admin/settings", requirePin, async (req, res) => {
  try {
    const data = await sendAgentCommand("set-settings", {
      mediaDir: typeof req.body?.mediaDir === "string" ? req.body.mediaDir.trim() : "",
      imageDuration: Number(req.body?.imageDuration)
    });
    res.json({ ok: true, ...data });
  } catch (err) {
    const code = err.message === "agent_offline" ? 503 : 502;
    res.status(code).json({ error: err.message });
  }
});

app.post("/api/admin/order", requirePin, async (req, res) => {
  try {
    const order = Array.isArray(req.body?.order) ? req.body.order : [];
    const data = await sendAgentCommand("set-order", { order });
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(err.message === "agent_offline" ? 503 : 502).json({ error: err.message });
  }
});

app.post("/api/admin/image-duration", requirePin, async (req, res) => {
  try {
    const data = await sendAgentCommand("set-image-duration", {
      id: String(req.body?.id || ""),
      duration: Number(req.body?.duration)
    });
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(err.message === "agent_offline" ? 503 : 502).json({ error: err.message });
  }
});

app.post("/api/admin/schedules", requirePin, async (req, res) => {
  try {
    const incoming = Array.isArray(req.body?.schedules) ? req.body.schedules : null;
    if (!incoming) return res.status(400).json({ error: "invalid_schedules" });
    const data = await sendAgentCommand("set-schedules", { schedules: incoming });
    res.json({ ok: true, schedules: data.schedules || [] });
  } catch (err) {
    res.status(err.message === "agent_offline" ? 503 : 502).json({ error: err.message });
  }
});

app.post("/api/admin/control", requirePin, (req, res) => {
  const allowed = new Set(["play", "pause", "next", "previous", "reload", "show"]);
  const action = String(req.body?.action || "");
  if (!allowed.has(action)) return res.status(400).json({ error: "invalid_action" });
  const payload = { action };
  if (action === "show") {
    const mediaId = String(req.body?.id || "");
    if (!playlist.some(item => item.id === mediaId)) {
      return res.status(404).json({ error: "item_not_found" });
    }
    payload.id = mediaId;
  }
  broadcast("control", payload);
  res.json({ ok: true });
});

app.get("/media", (req, res) => {
  const mediaId = String(req.query.file || "");
  if (!mediaId || !playlist.some(item => item.id === mediaId)) {
    return res.sendStatus(404);
  }
  if (!isAgentOnline()) {
    return res.status(503).send("Laptop agent is offline");
  }

  const requestId = id();
  let started = false;
  let finished = false;

  const cleanup = () => {
    const pending = pendingMedia.get(requestId);
    if (pending?.timer) clearTimeout(pending.timer);
    pendingMedia.delete(requestId);
  };

  const resetTimer = () => {
    const pending = pendingMedia.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (!res.headersSent) res.status(504).send("Media source timeout");
      else {
        try { res.end(); } catch {}
      }
      cleanup();
      safeSendAgent({ type: "media-cancel", requestId });
    }, 30000);
  };

  pendingMedia.set(requestId, {
    res,
    timer: setTimeout(() => {
      if (!res.headersSent) res.status(504).send("Media source timeout");
      cleanup();
      safeSendAgent({ type: "media-cancel", requestId });
    }, 15000),
    onMeta(meta) {
      if (finished) return;
      started = true;
      clearTimeout(pendingMedia.get(requestId)?.timer);
      const status = Number(meta.status || 200);
      res.status(status);
      if (meta.mime) res.setHeader("Content-Type", meta.mime);
      if (meta.contentLength != null) res.setHeader("Content-Length", String(meta.contentLength));
      if (meta.contentRange) res.setHeader("Content-Range", meta.contentRange);
      if (meta.acceptRanges) res.setHeader("Accept-Ranges", meta.acceptRanges);
      res.setHeader("Cache-Control", "no-store");
      resetTimer();
    },
    onChunk(base64) {
      if (finished) return;
      if (!started) {
        res.status(502).end();
        finished = true;
        cleanup();
        return;
      }
      resetTimer();
      const buffer = Buffer.from(base64, "base64");
      const acknowledge = () => safeSendAgent({ type: "media-ack", requestId });
      const canContinue = res.write(buffer);
      if (canContinue) acknowledge();
      else res.once("drain", acknowledge);
    },
    onEnd() {
      if (finished) return;
      finished = true;
      try { res.end(); } catch {}
      cleanup();
    },
    onError(message, status = 502) {
      if (finished) return;
      finished = true;
      if (!res.headersSent) res.status(Number(status) || 502).send(message || "Media error");
      else {
        try { res.end(); } catch {}
      }
      cleanup();
    }
  });

  res.on("close", () => {
    if (!finished && !res.writableEnded) {
      finished = true;
      safeSendAgent({ type: "media-cancel", requestId });
      cleanup();
    }
  });

  const sent = safeSendAgent({
    type: "media-request",
    requestId,
    id: mediaId,
    range: req.headers.range || null
  });

  if (!sent) {
    cleanup();
    return res.status(503).send("Laptop agent is offline");
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname !== "/agent") return socket.destroy();
    const key = String(url.searchParams.get("key") || "");
    console.log("[AGENT UPGRADE]", new Date().toISOString());
    if (!AGENT_KEY || key !== AGENT_KEY) {
      console.log("[AGENT REJECTED] invalid key");
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
    console.log("[AGENT ACCEPTED]");
    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req);
    });
  } catch (err) {
    console.log("[AGENT UPGRADE ERROR]", err.message);
    socket.destroy();
  }
});

wss.on("connection", ws => {
  console.log("[AGENT CONNECTED]", new Date().toISOString());
  if (agentSocket && agentSocket.readyState === 1) {
    try { agentSocket.close(4001, "Replaced by newer agent connection"); } catch {}
  }
  agentSocket = ws;
  agentMeta.connected = true;
  agentMeta.lastSeen = Date.now();
  broadcast("agent-status", { online: true });

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    agentMeta.lastSeen = Date.now();

    if (msg.type === "hello") {
      agentMeta.hostname = typeof msg.hostname === "string" ? msg.hostname : null;
      agentMeta.version = typeof msg.version === "string" ? msg.version : null;
      return;
    }

    if (msg.type === "heartbeat") return;

    if (msg.type === "playlist") {
      playlist = Array.isArray(msg.items) ? msg.items : [];
      if (msg.settings && typeof msg.settings === "object") {
        if (typeof msg.settings.mediaDir === "string") agentMeta.mediaDir = msg.settings.mediaDir;
        if (Number.isFinite(Number(msg.settings.imageDuration))) {
          agentMeta.imageDuration = Number(msg.settings.imageDuration);
        }
        if (Array.isArray(msg.settings.schedules)) {
          schedules = msg.settings.schedules;
        }
      }
      broadcast("playlist", { count: playlist.length, ts: Date.now() });
      broadcast("schedules", { schedules, ts: Date.now() });
      return;
    }

    if (msg.type === "command-result") {
      const pending = pendingCommands.get(msg.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pendingCommands.delete(msg.requestId);
      if (msg.ok) pending.resolve(msg.data || {});
      else pending.reject(new Error(msg.error || "agent_error"));
      return;
    }

    if (msg.type === "media-meta") {
      pendingMedia.get(msg.requestId)?.onMeta(msg);
      return;
    }

    if (msg.type === "media-chunk") {
      pendingMedia.get(msg.requestId)?.onChunk(msg.data || "");
      return;
    }

    if (msg.type === "media-end") {
      pendingMedia.get(msg.requestId)?.onEnd();
      return;
    }

    if (msg.type === "media-error") {
      pendingMedia.get(msg.requestId)?.onError(msg.error || "Media error", msg.status || 502);
    }
  });

  ws.on("close", () => {
    if (agentSocket === ws) {
      agentSocket = null;
      agentMeta.connected = false;
      console.log("[AGENT DISCONNECTED]", new Date().toISOString());
      broadcast("agent-status", { online: false });
      for (const [requestId, pending] of pendingMedia) {
        pending.onError("Laptop agent disconnected", 503);
        pendingMedia.delete(requestId);
      }
      for (const [requestId, pending] of pendingCommands) {
        clearTimeout(pending.timer);
        pending.reject(new Error("agent_offline"));
        pendingCommands.delete(requestId);
      }
    }
  });

  ws.on("error", () => {});
});

setInterval(() => {
  broadcast("status", {
    agentOnline: isAgentOnline(),
    displayOnline: isDisplayOnline(),
    ts: Date.now()
  });
}, 5000);

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "tvshow", ts: Date.now() });
});

server.listen(PORT, HOST, () => {
  console.log(`TvShow public relay running on port ${PORT}`);
});
