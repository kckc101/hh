// E-Rave Cambodia — realtime festival server.
// Express serves uploads (+ the production build), Socket.io relays presence, chat,
// reactions, DJ playlist state, stage FX and WebRTC signalling for the live DJ mic.

import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { DJController, FX_TYPES } from '../shared/dj.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT) || 3001;
const DJ_PASSWORD = process.env.DJ_PASSWORD || 'erave2026';
// Outside server/ so `node --watch` doesn't restart (and wipe the playlist) on every upload.
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT, 'uploads');
// Optional: serve the built web client (github.com/kckc101/nh) from the same origin,
// e.g. STATIC_DIR=../nh/dist
const DIST_DIR = path.resolve(ROOT, process.env.STATIC_DIR || 'dist');
const AUDIO_EXT = new Set(['mp3', 'ogg', 'oga', 'wav', 'm4a', 'aac', 'flac', 'webm', 'opus']);
const DANCES = new Set(['idle', 'headbang', 'jumpwave', 'shuffle', 'sidestep', 'glowstick', 'dj']);
const REACTIONS = new Set(['heart', 'fire', 'confetti', 'cheer']);

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const players = new Map(); // socket.id -> player
const chatHistory = [];
const dj = new DJController();
let liveMicId = null;

// ---------------------------------------------------------------- HTTP

const app = express();
app.disable('x-powered-by');

// The web client may be hosted on another origin (VITE_SERVER_URL), so the HTTP API and
// uploaded audio allow cross-origin access. Socket.io has its own CORS option below.
app.use(['/api', '/uploads'], (req, res, next) => {
  res.set('Access-Control-Allow-Origin', req.get('origin') || '*');
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Headers', 'content-type, x-dj-key, x-filename');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true, players: players.size }));

app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '1h' }));

app.post('/api/upload', express.raw({ type: () => true, limit: '60mb' }), (req, res) => {
  if (req.get('x-dj-key') !== DJ_PASSWORD) return res.status(403).json({ error: 'DJ key required' });
  let name = 'track.mp3';
  try {
    name = decodeURIComponent(req.get('x-filename') || name);
  } catch {
    /* keep default */
  }
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!AUDIO_EXT.has(ext)) return res.status(400).json({ error: `Unsupported file type .${ext}` });
  if (!req.body?.length) return res.status(400).json({ error: 'Empty upload' });
  const file = `${crypto.randomUUID()}.${ext}`;
  fs.writeFile(path.join(UPLOAD_DIR, file), req.body, (err) => {
    if (err) return res.status(500).json({ error: 'Could not store file' });
    res.json({ url: `/uploads/${file}` });
  });
});

if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR));
  app.use((req, res, next) => {
    if (req.method === 'GET' && req.accepts('html')) return res.sendFile(path.join(DIST_DIR, 'index.html'));
    next();
  });
}

const server = createServer(app);
const io = new Server(server, { cors: { origin: true }, maxHttpBufferSize: 1e6 });

// ---------------------------------------------------------------- helpers

const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);
const num = (v, lim) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(-lim, Math.min(lim, n)) : 0;
};

function sanitizeAvatar(a) {
  const out = {};
  if (a && typeof a === 'object') {
    for (const [k, v] of Object.entries(a).slice(0, 20)) {
      if (typeof v === 'string') out[clean(k, 20)] = clean(v, 24);
    }
  }
  return out;
}

function publicPlayer(p) {
  return { id: p.id, name: p.name, tag: p.tag, avatar: p.avatar, isDJ: p.isDJ, x: p.x, y: p.y, z: p.z, ry: p.ry, dance: p.dance, moving: p.moving };
}

function pushChat(msg) {
  chatHistory.push(msg);
  if (chatHistory.length > 40) chatHistory.shift();
  io.emit('chat', msg);
}

function systemChat(text) {
  pushChat({ id: 'system', name: 'E-RAVE', text, ts: Date.now(), system: true });
}

const broadcastDJ = () => io.emit('dj:state', dj.snapshot());

// ---------------------------------------------------------------- sockets

io.on('connection', (socket) => {
  let lastChat = 0;
  let reactBudget = 10;
  const refill = setInterval(() => (reactBudget = Math.min(10, reactBudget + 4)), 1000);

  socket.emit('hello', { dj: dj.snapshot(), online: players.size, serverNow: Date.now() });

  socket.on('time', (cb) => typeof cb === 'function' && cb(Date.now()));

  socket.on('dj:auth', (key, cb) => typeof cb === 'function' && cb(key === DJ_PASSWORD));

  socket.on('join', (data, cb) => {
    if (typeof cb !== 'function') return;
    const isDJ = data?.djKey === DJ_PASSWORD;
    const p = {
      id: socket.id,
      name: clean(data?.name, 18) || 'Raver',
      tag: clean(data?.tag, 18),
      avatar: sanitizeAvatar(data?.avatar),
      isDJ,
      x: 0, y: 0, z: 12, ry: Math.PI, dance: 'idle', moving: false,
    };
    const wasHere = players.has(socket.id);
    players.set(socket.id, p);
    cb({
      id: socket.id,
      isDJ,
      players: [...players.values()].filter((o) => o.id !== socket.id).map(publicPlayer),
      dj: dj.snapshot(),
      chat: chatHistory,
      liveMic: liveMicId,
      serverNow: Date.now(),
    });
    socket.broadcast.emit('player:join', publicPlayer(p));
    io.emit('online', players.size);
    if (!wasHere) systemChat(isDJ ? `🎧 ${p.name} took the decks!` : `${p.name} joined the rave`);
  });

  socket.on('state', (s) => {
    const p = players.get(socket.id);
    if (!p || !Array.isArray(s)) return;
    p.x = num(s[0], 200);
    p.y = num(s[1], 40);
    p.z = num(s[2], 200);
    p.ry = num(s[3], 100);
    p.dance = DANCES.has(s[4]) ? s[4] : 'idle';
    p.moving = !!s[5];
  });

  socket.on('avatar', (data) => {
    const p = players.get(socket.id);
    if (!p) return;
    p.avatar = sanitizeAvatar(data?.avatar);
    p.name = clean(data?.name, 18) || p.name;
    p.tag = clean(data?.tag, 18);
    socket.broadcast.emit('player:avatar', { id: p.id, avatar: p.avatar, name: p.name, tag: p.tag });
  });

  socket.on('emote', (dance) => {
    const p = players.get(socket.id);
    if (!p || !DANCES.has(dance)) return;
    p.dance = dance;
    socket.broadcast.emit('player:emote', { id: p.id, dance });
  });

  socket.on('react', (type) => {
    if (!players.has(socket.id) || !REACTIONS.has(type) || reactBudget <= 0) return;
    reactBudget--;
    socket.broadcast.emit('react', { id: socket.id, type });
  });

  socket.on('chat', (text) => {
    const p = players.get(socket.id);
    const now = Date.now();
    const t = clean(text, 140);
    if (!p || !t || now - lastChat < 600) return;
    lastChat = now;
    pushChat({ id: p.id, name: p.name, color: p.avatar.accent, isDJ: p.isDJ, text: t, ts: now });
  });

  // ---- DJ host controls (server-validated)
  const isDJ = () => players.get(socket.id)?.isDJ === true;

  socket.on('dj', (msg) => {
    if (!isDJ() || !msg) return;
    if (dj.apply(msg.action, msg.arg)) broadcastDJ();
  });

  socket.on('dj:fx', (type) => {
    if (!isDJ() || !FX_TYPES.includes(type)) return;
    io.emit('fx', { type, by: players.get(socket.id).name });
  });

  socket.on('dj:announce', (text) => {
    const t = clean(text, 80);
    if (!isDJ() || !t) return;
    io.emit('announce', { text: t, by: players.get(socket.id).name });
  });

  socket.on('track:ended', (uid) => {
    if (dj.reportEnded(String(uid))) broadcastDJ();
  });

  // ---- WebRTC live mic signalling
  socket.on('rtc:live', (live) => {
    if (!isDJ()) return;
    if (live) liveMicId = socket.id;
    else if (liveMicId === socket.id) liveMicId = null;
    socket.broadcast.emit('rtc:live', { id: socket.id, live: !!live });
  });

  socket.on('rtc:request', (msg) => {
    if (msg?.to && msg.to === liveMicId) io.to(msg.to).emit('rtc:request', { from: socket.id });
  });

  socket.on('rtc:signal', (msg) => {
    if (!msg?.to || !players.has(msg.to)) return;
    io.to(msg.to).emit('rtc:signal', { from: socket.id, data: msg.data });
  });

  socket.on('disconnect', () => {
    clearInterval(refill);
    const p = players.get(socket.id);
    players.delete(socket.id);
    if (liveMicId === socket.id) {
      liveMicId = null;
      io.emit('rtc:live', { id: socket.id, live: false });
    }
    if (p) {
      io.emit('player:leave', socket.id);
      io.emit('online', players.size);
    }
  });
});

// Position snapshots at 10 Hz — compact arrays keep packets small.
setInterval(() => {
  if (!players.size) return;
  const snap = [];
  for (const p of players.values()) {
    snap.push([p.id, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), +p.ry.toFixed(2), p.dance, p.moving ? 1 : 0]);
  }
  io.volatile.emit('players', snap);
}, 100);

// Auto-advance the playlist when a track with a known length finishes.
setInterval(() => dj.tick() && broadcastDJ(), 500);

server.listen(PORT, () => {
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log(`\n  🎧 E-Rave Cambodia server on http://localhost:${PORT}`);
  if (lan.length) console.log(`     LAN: ${lan.map((a) => `http://${a}:${PORT}`).join('  ')}`);
  console.log(`     DJ password: ${DJ_PASSWORD}  (set DJ_PASSWORD env to change)`);
  if (!process.env.DJ_PASSWORD) console.log('     ⚠ Using the default DJ password — set DJ_PASSWORD before deploying publicly.');
  if (fs.existsSync(DIST_DIR)) console.log(`     Serving web client from ${DIST_DIR}`);
  else console.log('     API only — run the web client (kckc101/nh) with `npm run dev`; it proxies here.');
  console.log('');
});
