const { randomInt } = require('crypto');

const rooms = new Map();
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom(user, name, socketId) {
  const room = {
    code: generateCode(),
    name,
    hostId: user.id,
    state: 'lobby',
    gameId: null,
    maxPlayers: 8,
    players: new Map([[user.id, { ...user, connected: true, socketId }]])
  };
  rooms.set(room.code, room);
  return room;
}

function publicRoom(room) {
  return {
    code: room.code,
    name: room.name,
    hostId: room.hostId,
    state: room.state,
    gameId: room.gameId,
    maxPlayers: room.maxPlayers,
    players: [...room.players.values()].map(({ id, username, avatarUrl, connected }) => ({
      id,
      username,
      avatarUrl,
      connected
    }))
  };
}

module.exports = { rooms, createRoom, publicRoom };