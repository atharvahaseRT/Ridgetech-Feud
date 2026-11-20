'use strict';
const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const game = require('./game');

const ROOT = path.join(__dirname, '..');
const QUESTIONS_PATH = path.join(__dirname, 'questions.json');
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_ROOMS = 200;
const ALL_GONE_MS = 15 * 60 * 1000;
const IDLE_MS = 3 * 60 * 60 * 1000;
const GAME_EVENTS = [
  'host:settings', 'host:addQuestion', 'host:removeQuestion', 'host:start', 'host:next', 'host:pause', 'host:resume',
  'host:skip', 'host:accept', 'host:kick', 'host:end', 'host:playAgain', 'team:name', 'team:lock', 'buzz', 'answer',
  'bonus:bet', 'bonus:answer',
];

let questions;
try {
  questions = JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf8'));
  if (!Array.isArray(questions) || !questions.length) throw new Error('expected a non-empty array');
} catch (e) {
  console.error(`FATAL: could not load question bank ${QUESTIONS_PATH}: ${e.message}`);
  process.exit(1);
}

const app = express();
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.get('/r/:code', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
app.use('/brand', express.static(path.join(ROOT, 'brand')));
app.use(express.static(path.join(ROOT, 'public')));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 16 * 1024 });
const rooms = new Map();

function socketsIn(code) {
  return [...(io.sockets.adapter.rooms.get(code) || [])].map((id) => io.sockets.sockets.get(id)).filter(Boolean);
}

function broadcast(room) {
  for (const s of socketsIn(room.code)) s.emit('state', game.snapshotFor(room, s.data.playerId));
}

function closeRoom(room) {
  for (const s of socketsIn(room.code)) {
    s.emit('roomClosed');
    s.data.code = s.data.playerId = null;
    s.leave(room.code);
    s.disconnect(true);
  }
  game.dispose(room);
  rooms.delete(room.code);
}

function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function attach(socket, room, player) {
  if (socket.data.code !== room.code || socket.data.playerId !== player.id) leave(socket);
  socket.data.code = room.code;
  socket.data.playerId = player.id;
  socket.join(room.code);
  socket.emit('state', game.snapshotFor(room, player.id));
}

// Detach a socket from its room; mark the player disconnected if no other socket holds them.
function leave(socket) {
  const { code, playerId } = socket.data;
  socket.data.code = socket.data.playerId = null;
  const room = code && rooms.get(code);
  if (!room || !playerId) return;
  socket.leave(code);
  if (!socketsIn(code).some((s) => s.data.playerId === playerId)) game.disconnect(room, playerId);
}

io.on('connection', (socket) => {
  socket.data.code = null;
  socket.data.playerId = null;

  const on = (event, fn) => socket.on(event, (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      reply(fn(payload && typeof payload === 'object' ? payload : {}));
    } catch (e) {
      console.error(`error handling ${event}:`, e);
      reply({ ok: false, error: 'Server error' });
    }
  });

  on('room:create', ({ name }) => {
    if (rooms.size >= MAX_ROOMS) return { ok: false, error: 'Server is full, try later' };
    const room = game.createRoom({ code: newCode(), questions, onChange: broadcast });
    const token = crypto.randomUUID();
    const res = game.addPlayer(room, { name, token });
    if (!res.ok) return res;
    rooms.set(room.code, room);
    attach(socket, room, res.player);
    return { ok: true, code: room.code, playerId: res.player.id, token };
  });

  on('room:join', ({ code, name, token }) => {
    const room = rooms.get(String(code ?? '').trim().toUpperCase());
    if (!room) return { ok: false, error: 'Room not found' };
    const existing = typeof token === 'string' ? game.reconnect(room, token) : null;
    if (existing) {
      attach(socket, room, existing);
      return { ok: true, playerId: existing.id, token };
    }
    const newToken = crypto.randomUUID();
    const res = game.addPlayer(room, { name, token: newToken });
    if (!res.ok) return res;
    attach(socket, room, res.player);
    return { ok: true, playerId: res.player.id, token: newToken };
  });

  // Host closes the room for everyone: notify, disconnect all sockets, forget the room.
  on('host:closeRoom', () => {
    const room = rooms.get(socket.data.code);
    if (!room || !socket.data.playerId) return { ok: false, error: 'Not in a room' };
    if (room.hostId !== socket.data.playerId) return { ok: false, error: 'Host only' };
    setImmediate(() => closeRoom(room)); // let the ack reach the host before sockets drop
    return { ok: true };
  });

  for (const event of GAME_EVENTS) {
    on(event, (payload) => {
      const room = rooms.get(socket.data.code);
      if (!room || !socket.data.playerId) return { ok: false, error: 'Not in a room' };
      const res = game.handle(room, socket.data.playerId, event, payload);
      if (event === 'host:kick' && res.ok) {
        // Kicked sockets already got their final state (lastEvent kicked) from broadcast.
        for (const s of socketsIn(room.code)) {
          if (s.data.playerId !== payload.playerId) continue;
          s.data.code = s.data.playerId = null;
          s.leave(room.code);
          s.disconnect(true);
        }
      }
      return res;
    });
  }

  socket.on('disconnect', () => leave(socket));
});

// Room GC (spec §8): everyone gone 15 min, or idle 3 h.
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const allGone = room.players.every((p) => !p.connected)
      && now - Math.max(0, ...room.players.map((p) => p.disconnectedAt || 0)) > ALL_GONE_MS;
    if (allGone || now - room.updatedAt > IDLE_MS) {
      game.dispose(room);
      io.in(code).disconnectSockets(true);
      rooms.delete(code);
    }
  }
}, 60 * 1000).unref();

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => console.log(`Ridgetech Feud listening on :${PORT}`));
