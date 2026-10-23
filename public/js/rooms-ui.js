const homeView = document.getElementById('home-view');
const roomView = document.getElementById('room-view');
const playersList = document.getElementById('room-players');
const roomGames = document.getElementById('room-games');
const connBanner = document.getElementById('conn-banner');
const userChipEl = document.getElementById('user-chip');
const gameStage = document.getElementById('game-stage');
let mountedGameId = null;

let socket = null;
let currentRoom = null;
let gamesCatalog = [];

fetch('/api/games')
  .then((res) => res.json())
  .then((list) => {
    gamesCatalog = list;
    if (currentRoom) renderRoom(currentRoom);
  });

function isLoggedIn() {
  return !userChipEl.hidden;
}

function syncGameUI(room) {
  const wanted = room.state === 'playing' ? room.gameId : null;
  if (wanted === mountedGameId) return;

  if (mountedGameId && window.gameUIs[mountedGameId]) window.gameUIs[mountedGameId].unmount();
  gameStage.replaceChildren();

  mountedGameId = wanted;
  if (wanted && window.gameUIs && window.gameUIs[wanted]) {
    window.gameUIs[wanted].mount(gameStage, getSocket());
  }
}


function showHome() {
  currentRoom = null;
    syncGameUI({ state: 'lobby' });
  roomView.hidden = true;
  homeView.hidden = false;
}

function closeSocket() {
  if (socket) {
    socket.close();
    socket = null;
  }
  connBanner.hidden = true;
}

function getSocket() {
  if (socket) return socket;

  socket = io();
  socket.on('room:update', renderRoom);
  socket.on('connect', () => {
    connBanner.hidden = true;
  });
  socket.on('disconnect', (reason) => {
    if (reason !== 'io client disconnect') connBanner.hidden = false;
  });
  socket.on('connect_error', (err) => {
    if (err.message === 'Não autenticado') {
      showToast('Sua sessão expirou. Entre novamente.', 'error');
      closeSocket();
      showHome();
      renderUser(null);
    } else {
      connBanner.hidden = false;
    }
  });
  return socket;
}

new MutationObserver(() => {
  if (isLoggedIn()) {
    getSocket();
  } else {
    closeSocket();
    showHome();
  }
}).observe(userChipEl, { attributes: true, attributeFilter: ['hidden'] });

function renderRoom(room) {
  currentRoom = room;

  const host = room.players.find((p) => p.id === room.hostId);
  const myName = document.getElementById('user-name').textContent;
  const isHost = host.username === myName;

  document.getElementById('room-title').textContent = room.name || 'Sala de ' + host.username;
  document.getElementById('room-code').textContent = room.code;
  document.getElementById('room-count').textContent = room.players.length + ' de ' + room.maxPlayers + ' jogadores';

  playersList.replaceChildren(
    ...room.players.map((player) => {
      const li = document.createElement('li');
      li.className = 'player' + (player.connected ? '' : ' offline');

      const avatar = document.createElement('div');
      avatar.className = 'avatar';
      setAvatar(avatar, player);

      const name = document.createElement('span');
      name.textContent = player.username + (player.username === myName ? ' (você)' : '');

      li.append(avatar, name);

      if (player.id === room.hostId) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = 'Anfitrião';
        li.append(badge);
      }
      if (!player.connected) {
        const badge = document.createElement('span');
        badge.className = 'badge badge-muted';
        badge.textContent = 'Reconectando…';
        li.append(badge);
      }
      return li;
    })
  );

  roomGames.replaceChildren(
    ...gamesCatalog.map((game) => {
      const selected = room.gameId === game.id;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'game-option' + (selected ? ' selected' : '');
      button.style.setProperty('--game-color', game.color);
      button.disabled = !isHost;
      button.setAttribute('aria-pressed', selected);
      button.textContent = (selected ? '✓ ' : '') + game.name;
      button.addEventListener('click', () => {
        getSocket().emit('room:set-game', { gameId: game.id }, (res) => {
          if (res && !res.ok) showToast(res.error, 'error');
        });
      });
      return button;
    })
  );

  document.getElementById('room-game-hint').textContent = isHost
    ? 'Escolha o jogo da partida.'
    : room.gameId
      ? 'Aguardando o anfitrião iniciar.'
      : 'O anfitrião está escolhendo o jogo.';

  const selectedGame = gamesCatalog.find((g) => g.id === room.gameId);
  const playing = room.state === 'playing';
    syncGameUI(room);

  document.getElementById('room-lobby').hidden = playing;
  document.getElementById('room-game').hidden = !playing;
  document.getElementById('room-game-title').textContent = selectedGame ? selectedGame.name : '';
  document.getElementById('room-end-game').hidden = !isHost;

  const startBtn = document.getElementById('room-start');
  startBtn.hidden = !isHost;
  startBtn.disabled = !selectedGame || room.players.length < selectedGame.minPlayers;

  if (isHost && selectedGame) {
    document.getElementById('room-game-hint').textContent =
      room.players.length < selectedGame.minPlayers
        ? 'Convide mais jogadores: ' + selectedGame.name + ' precisa de pelo menos ' + selectedGame.minPlayers + '.'
        : 'Tudo pronto! Clique em Iniciar partida.';
  }


  homeView.hidden = true;
  roomView.hidden = false;
}

document.getElementById('btn-criar-sala').addEventListener('click', () => {
  if (!isLoggedIn()) {
    document.getElementById('btn-entrar').click();
    return;
  }
  getSocket().emit('room:create', {}, (res) => {
    if (!res.ok) return showToast(res.error, 'error');
    renderRoom(res.room);
  });
});

document.getElementById('room-leave').addEventListener('click', () => {
  if (socket) socket.emit('room:leave');
  showHome();
});

document.getElementById('room-copy').addEventListener('click', async () => {
  const code = document.getElementById('room-code').textContent;
  try {
    await navigator.clipboard.writeText(code);
    showToast('Código copiado!', 'success');
  } catch {
    showToast('Não foi possível copiar. Selecione o código e copie manualmente.', 'error');
  }
});

/* ---------- Entrar com código ---------- */

const joinModal = document.getElementById('join-modal');
const joinForm = document.getElementById('join-form');
const joinCode = document.getElementById('join-code');
const joinMsg = document.getElementById('join-msg');
const joinSubmit = document.getElementById('join-submit');

function joinError(text) {
  joinMsg.textContent = '✕ ' + text;
  joinMsg.className = 'form-msg error';
}

document.getElementById('btn-entrar-codigo').addEventListener('click', () => {
  if (!isLoggedIn()) {
    document.getElementById('btn-entrar').click();
    return;
  }
  joinCode.value = '';
  joinMsg.textContent = '';
  joinMsg.className = 'form-msg';
  joinModal.showModal();
});

document.getElementById('join-cancel').addEventListener('click', () => joinModal.close());

joinCode.addEventListener('input', () => {
  joinCode.value = joinCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const code = joinCode.value;
  if (code.length !== 5) return joinError('O código tem 5 caracteres.');

  joinSubmit.disabled = true;
  getSocket().timeout(5000).emit('room:join', { code }, (err, res) => {
    joinSubmit.disabled = false;
    if (err) return joinError('O servidor não respondeu. Tente de novo.');
    if (!res.ok) return joinError(res.error);
    joinModal.close();
    renderRoom(res.room);
  });
});

document.getElementById('room-start').addEventListener('click', () => {
  getSocket().emit('room:start', {}, (res) => {
    if (res && !res.ok) showToast(res.error, 'error');
  });
});

document.getElementById('room-end-game').addEventListener('click', () => {
  getSocket().emit('room:end-game', {}, (res) => {
    if (res && !res.ok) showToast(res.error, 'error');
  });
});