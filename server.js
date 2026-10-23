const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const db = require('./server/db');
const { rooms, createRoom, publicRoom } = require('./server/rooms');
const games = require('./server/games');
const { createLimiter } = require('./server/rate-limit');
const gameModules = require('./server/games/modules');

const RECONNECT_GRACE_MS = 30000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dev-secret-troque-em-producao',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 7 }
});

app.use(express.json());
app.use(sessionMiddleware);
app.use(express.static('public'));
app.use('/api/auth', require('./server/auth'));
app.get('/api/games', (req, res) => res.json(games));

io.engine.use(sessionMiddleware);

io.use((socket, next) => {
  const userId = socket.request.session && socket.request.session.userId;
  if (!userId) return next(new Error('Não autenticado'));

  const user = db
    .prepare('SELECT id, username, avatar_url FROM users WHERE id = ?')
    .get(userId);
  if (!user) return next(new Error('Não autenticado'));

  socket.user = { id: user.id, username: user.username, avatarUrl: user.avatar_url };
  next();
});

function removePlayer(room, userId) {
  const player = room.players.get(userId);
  if (player) clearTimeout(player.timer);
  room.players.delete(userId);

  if (room.players.size === 0) {
    if (room.game) room.game.destroy();
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === userId) {
    const next = [...room.players.values()].find((p) => p.connected) || [...room.players.values()][0];
    room.hostId = next.id;
  }
  io.to(room.code).emit('room:update', publicRoom(room));
}

function leaveCurrentRoom(socket) {
  const code = socket.data.roomCode;
  if (!code) return;

  socket.leave(code);
  socket.data.roomCode = null;

  const room = rooms.get(code);
  if (room) removePlayer(room, socket.user.id);
}

function markDisconnected(socket) {
  const room = rooms.get(socket.data.roomCode);
  if (!room) return;

  const player = room.players.get(socket.user.id);
  if (!player || player.socketId !== socket.id) return;

  player.connected = false;
  player.timer = setTimeout(() => removePlayer(room, socket.user.id), RECONNECT_GRACE_MS);
  io.to(room.code).emit('room:update', publicRoom(room));
}

function rejoinIfPlaying(socket) {
  for (const room of rooms.values()) {
    const player = room.players.get(socket.user.id);
    if (!player) continue;

    clearTimeout(player.timer);
    player.connected = true;
    player.socketId = socket.id;
    socket.join(room.code);
    socket.data.roomCode = room.code;
    io.to(room.code).emit('room:update', publicRoom(room));
    if (room.game && room.game.sendStateTo) room.game.sendStateTo(socket);
    return;
  }
}

io.on('connection', (socket) => {
  console.log('Conectado:', socket.user.username);

  const allow = createLimiter();
  socket.use(([event, ...args], next) => {
    const type = event === 'game:action' && typeof args[0]?.type === 'string' ? args[0].type : null;
if (allow(type ? event + ':' + type : event)) return next();

    const ack = args[args.length - 1];
    if (typeof ack === 'function') {
      ack({ ok: false, error: 'Calma! Você está fazendo isso rápido demais.' });
    }
  });

  rejoinIfPlaying(socket);

  socket.on('room:create', (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (socket.data.roomCode) {
      return ack({ ok: false, error: 'Você já está em uma sala.' });
    }
    if (rooms.size >= 200) {
      return ack({ ok: false, error: 'O servidor está cheio. Tente mais tarde.' });
    }

    const name = typeof payload?.name === 'string' ? payload.name.trim().slice(0, 30) : '';
    const room = createRoom(socket.user, name, socket.id);

    socket.join(room.code);
    socket.data.roomCode = room.code;

    ack({ ok: true, room: publicRoom(room) });
  });

  socket.on('room:join', (payload, ack) => {
    if (typeof ack !== 'function') return;
    if (socket.data.roomCode) {
      return ack({ ok: false, error: 'Você já está em uma sala.' });
    }

    const code = typeof payload?.code === 'string' ? payload.code.trim().toUpperCase() : '';
    if (!/^[A-Z0-9]{5}$/.test(code)) {
      return ack({ ok: false, error: 'Código inválido. Ele tem 5 letras ou números.' });
    }

    const room = rooms.get(code);
    if (!room) return ack({ ok: false, error: 'Sala não encontrada.' });
    if (room.state !== 'lobby') return ack({ ok: false, error: 'A partida já começou.' });
    if (room.players.size >= room.maxPlayers) return ack({ ok: false, error: 'A sala está cheia.' });

    room.players.set(socket.user.id, { ...socket.user, connected: true, socketId: socket.id });
    socket.join(code);
    socket.data.roomCode = code;

    io.to(code).emit('room:update', publicRoom(room));
    ack({ ok: true, room: publicRoom(room) });
  });

  socket.on('room:set-game', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};

    const room = rooms.get(socket.data.roomCode);
    if (!room) return reply({ ok: false, error: 'Você não está em uma sala.' });
    if (room.hostId !== socket.user.id) return reply({ ok: false, error: 'Só o anfitrião escolhe o jogo.' });
    if (room.state !== 'lobby') return reply({ ok: false, error: 'A partida já começou.' });

    const game = games.find((g) => g.id === payload?.gameId);
    if (!game) return reply({ ok: false, error: 'Jogo inválido.' });

    room.gameId = game.id;
    io.to(room.code).emit('room:update', publicRoom(room));
    reply({ ok: true });
  });

  socket.on('room:start', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};

    const room = rooms.get(socket.data.roomCode);
    if (!room) return reply({ ok: false, error: 'Você não está em uma sala.' });
    if (room.hostId !== socket.user.id) return reply({ ok: false, error: 'Só o anfitrião inicia a partida.' });
    if (room.state !== 'lobby') return reply({ ok: false, error: 'A partida já começou.' });

    const game = games.find((g) => g.id === room.gameId);
    if (!game) return reply({ ok: false, error: 'Escolha um jogo primeiro.' });
    if (room.players.size < game.minPlayers) {
      return reply({ ok: false, error: game.name + ' precisa de pelo menos ' + game.minPlayers + ' jogadores.' });
    }

    const gameModule = gameModules[game.id];
    if (!gameModule) return reply({ ok: false, error: 'Este jogo ainda não está disponível.' });

    room.state = 'playing';
    room.game = gameModule.createGame({ room, io });
    io.to(room.code).emit('room:update', publicRoom(room));
    room.game.start();
    reply({ ok: true });
  });

  socket.on('room:end-game', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};

    const room = rooms.get(socket.data.roomCode);
    if (!room) return reply({ ok: false, error: 'Você não está em uma sala.' });
    if (room.hostId !== socket.user.id) return reply({ ok: false, error: 'Só o anfitrião encerra a partida.' });
    if (room.state !== 'playing') return reply({ ok: false, error: 'Não há partida em andamento.' });

    if (room.game) room.game.destroy();
    room.game = null;
    room.state = 'lobby';
    io.to(room.code).emit('room:update', publicRoom(room));
    reply({ ok: true });
  });
  
  socket.on('game:action', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};

    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== 'playing' || !room.game || typeof room.game.onAction !== 'function') {
      return reply({ ok: false, error: 'Nenhuma partida em andamento.' });
    }
    if (typeof payload?.type !== 'string') {
      return reply({ ok: false, error: 'Ação inválida.' });
    }

    room.game.onAction(socket.user, payload, reply);
  });

  socket.on('room:leave', () => leaveCurrentRoom(socket));

  socket.on('disconnect', (reason) => {
    console.log('Desconectado:', socket.user.username, '(' + reason + ')');
    if (reason === 'client namespace disconnect') {
      leaveCurrentRoom(socket);
    } else {
      markDisconnected(socket);
    }
  });
});

server.listen(3000, () => {
  console.log('Servidor em http://localhost:3000');
});