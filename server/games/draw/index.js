const { randomInt } = require('crypto');
const data = require('./words.json');

const CHOOSE_SECONDS = 12;
const DRAW_SECONDS = 90;
const REVEAL_SECONDS = 6;
const OPTIONS_COUNT = 3;

// Pontuação (tudo calculado aqui no servidor)
const MAX_POINTS = 100; // quem acerta no primeiro instante
const MIN_POINTS = 10; // quem acerta no último instante
const DRAWER_POINTS = 25; // o desenhista ganha isso por cada pessoa que acertou

// Palpites e chat
const MAX_GUESS_LENGTH = 40;
const MAX_MESSAGES = 60;

// Limites do quadro: o servidor valida tudo que vem do navegador.
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const MIN_SIZE = 1;
const MAX_SIZE = 100;
const MAX_POINTS_PER_CHUNK = 200;
const MAX_POINTS_TOTAL = 30000;
const MAX_STROKES = 1500;
const MAX_RADIUS = 2;

// "Homem-Aranha", "homem aranha" e "HOMEM ARANHA" viram a mesma coisa: "homemaranha".
function compact(text) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

module.exports = {
  createGame({ room, io }) {
    const selected = new Set(data.categories.map((c) => c.id));
    const usedWords = new Set();
    const totals = new Map();
    const guessed = new Map(); // quem já acertou nesta rodada -> pontos ganhos
    const roundGains = new Map(); // pontos ganhos por cada um nesta rodada
    const state = {
      phase: 'idle',
      round: 0,
      drawerId: null,
      options: [],
      word: null,
      endsAt: 0
    };
    let order = [];
    let turn = -1;
    let timer = null;
    let messages = [];
    let chatSeq = 0;

    // Desenho da rodada atual, na ordem em que foi feito. Cada item é um destes:
    //   { kind: 'pen',    id, color, size, points: [[x, y], ...] }
    //   { kind: 'line',   id, color, size, a: [x, y], b: [x, y] }
    //   { kind: 'circle', id, color, size, c: [x, y], r }
    // As coordenadas vão de 0 a 1 (proporção do quadro), então servem em qualquer tela.
    let strokes = [];
    let totalPoints = 0;

    function resetRound() {
      strokes = [];
      totalPoints = 0;
      guessed.clear();
      roundGains.clear();
      messages = [];
    }

    function pushChat(message) {
      message.id = ++chatSeq;
      messages.push(message);
      if (messages.length > MAX_MESSAGES) messages.shift();
      io.to(room.code).emit('draw:chat', message);
    }

    // Palavras ainda não usadas nas categorias marcadas pelo anfitrião.
    function pool() {
      const list = [];
      for (const cat of data.categories) {
        if (!selected.has(cat.id)) continue;
        for (const w of cat.words) {
          const entry = typeof w === 'string' ? { text: w, aliases: [] } : w;
          const key = cat.id + ':' + entry.text;
          if (!usedWords.has(key)) {
            list.push({ key, text: entry.text, aliases: entry.aliases || [], category: cat.name });
          }
        }
      }
      if (list.length < OPTIONS_COUNT && usedWords.size > 0) {
        usedWords.clear();
        return pool();
      }
      return list;
    }

    function pickOptions() {
      const list = pool();
      const picked = [];
      while (picked.length < OPTIONS_COUNT && list.length > 0) {
        picked.push(list.splice(randomInt(list.length), 1)[0]);
      }
      return picked;
    }

    function phaseSeconds() {
      if (state.phase === 'choosing') return CHOOSE_SECONDS;
      if (state.phase === 'drawing') return DRAW_SECONDS;
      if (state.phase === 'reveal') return REVEAL_SECONDS;
      return 0;
    }

    // Placar: pontos totais, ganho da rodada e quem já acertou, com posição (empates dividem).
    function scoreboard() {
      const inRound = ['choosing', 'drawing', 'reveal'].includes(state.phase);
      const list = [...room.players.values()]
        .map((p) => ({
          id: p.id,
          username: p.username,
          avatarUrl: p.avatarUrl,
          total: totals.get(p.id) || 0,
          gain: roundGains.get(p.id) || 0,
          guessed: guessed.has(p.id),
          isDrawer: inRound && p.id === state.drawerId
        }))
        .sort((a, b) => b.total - a.total);

      list.forEach((p, i) => {
        p.rank = i > 0 && p.total === list[i - 1].total ? list[i - 1].rank : i + 1;
      });
      return list;
    }

    // Cada jogador recebe uma versão diferente do estado:
    // a palavra secreta só vai para o desenhista (e para todos na revelação).
    function snapshotFor(playerId) {
      const host = room.players.get(room.hostId);
      const drawer = room.players.get(state.drawerId);
      const isDrawer = playerId === state.drawerId;
      const drawing = state.phase === 'drawing' && state.word;

      return {
        phase: state.phase,
        round: state.round,
        totalRounds: order.length,
        hostName: host ? host.username : null,
        drawerName: drawer ? drawer.username : null,
        isDrawer,
        youGuessed: guessed.has(playerId),
        remainingMs: Math.max(0, state.endsAt - Date.now()),
        durationMs: phaseSeconds() * 1000,
        scoreboard: state.phase === 'setup' || state.phase === 'idle' ? null : scoreboard(),
        categories:
          state.phase === 'setup'
            ? data.categories.map((c) => ({
                id: c.id,
                name: c.name,
                count: c.words.length,
                selected: selected.has(c.id)
              }))
            : null,
        options:
          state.phase === 'choosing' && isDrawer
            ? state.options.map((o) => ({ text: o.text, category: o.category }))
            : null,
        category: drawing ? state.word.category : null,
        pattern: drawing && !isDrawer ? state.word.text.replace(/[\p{L}\p{N}]/gu, '_') : null,
        word: (drawing && isDrawer) || state.phase === 'reveal' ? state.word.text : null
      };
    }

    function broadcast() {
      for (const player of room.players.values()) {
        if (player.socketId) io.to(player.socketId).emit('draw:state', snapshotFor(player.id));
      }
    }

    // Envia um evento para todos, menos para quem desenhou.
    function sendToOthers(event, payload, exceptId) {
      for (const player of room.players.values()) {
        if (player.id !== exceptId && player.socketId) io.to(player.socketId).emit(event, payload);
      }
    }

    function nextTurn() {
      clearTimeout(timer);

      do {
        turn += 1;
      } while (turn < order.length && !room.players.has(order[turn]));

      resetRound();

      if (turn >= order.length) {
        state.phase = 'final';
        state.endsAt = 0;
        state.drawerId = null;
        state.word = null;
        return broadcast();
      }

      state.round += 1;
      state.drawerId = order[turn];
      state.options = pickOptions();
      state.word = null;
      state.phase = 'choosing';
      state.endsAt = Date.now() + CHOOSE_SECONDS * 1000;

      timer = setTimeout(() => chooseWord(0), CHOOSE_SECONDS * 1000);
      broadcast();
    }

    function chooseWord(index) {
      clearTimeout(timer);
      state.word = state.options[index];
      usedWords.add(state.word.key);
      state.phase = 'drawing';
      state.endsAt = Date.now() + DRAW_SECONDS * 1000;

      timer = setTimeout(endRound, DRAW_SECONDS * 1000);
      broadcast();
    }

    function endRound() {
      clearTimeout(timer);
      state.phase = 'reveal';
      state.endsAt = Date.now() + REVEAL_SECONDS * 1000;

      timer = setTimeout(nextTurn, REVEAL_SECONDS * 1000);
      broadcast();
    }

    // Quanto mais cedo acerta, mais pontos: cai em linha reta de MAX_POINTS até MIN_POINTS.
    function guessPoints() {
      const total = DRAW_SECONDS * 1000;
      const left = Math.min(total, Math.max(0, state.endsAt - Date.now()));
      return Math.round(MIN_POINTS + (MAX_POINTS - MIN_POINTS) * (left / total));
    }

    // A rodada acaba antes do tempo quando todos os jogadores conectados já acertaram.
    function everyoneGuessed() {
      const guessers = [...room.players.values()].filter((p) => p.id !== state.drawerId && p.connected !== false);
      return guessers.length > 0 && guessers.every((p) => guessed.has(p.id));
    }

    function addScore(playerId, points) {
      totals.set(playerId, (totals.get(playerId) || 0) + points);
      roundGains.set(playerId, (roundGains.get(playerId) || 0) + points);
    }

    function validPoint(p) {
      return Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
    }

    function clamp01(n) {
      return Math.min(1, Math.max(0, n));
    }

    function clampPoint(p) {
      return [clamp01(p[0]), clamp01(p[1])];
    }

    function validStyle(id, color, size) {
      return (
        Number.isSafeInteger(id) &&
        typeof color === 'string' &&
        COLOR_RE.test(color) &&
        Number.isInteger(size) &&
        size >= MIN_SIZE &&
        size <= MAX_SIZE
      );
    }

    function canDraw(user) {
      return state.phase === 'drawing' && user.id === state.drawerId;
    }

    return {
      start() {
        state.phase = 'setup';
        broadcast();
      },

      sendStateTo(socket) {
        socket.emit('draw:state', snapshotFor(socket.user.id));
        // Quem entra/reconecta no meio da rodada recebe o desenho e o chat.
        if (['choosing', 'drawing', 'reveal'].includes(state.phase)) {
          socket.emit('draw:chat-sync', { messages });
        }
        if (state.phase === 'drawing' || state.phase === 'reveal') {
          socket.emit('draw:sync', { strokes });
        }
      },

      onAction(user, action, reply) {
        const isHost = user.id === room.hostId;

        if (action.type === 'toggle-category') {
          if (!isHost) return reply({ ok: false, error: 'Só o anfitrião escolhe as categorias.' });
          if (state.phase !== 'setup') return reply({ ok: false, error: 'A partida já começou.' });
          if (!data.categories.some((c) => c.id === action.id)) {
            return reply({ ok: false, error: 'Categoria inválida.' });
          }

          if (selected.has(action.id)) {
            if (selected.size <= 1) return reply({ ok: false, error: 'Deixe pelo menos uma categoria marcada.' });
            selected.delete(action.id);
          } else {
            selected.add(action.id);
          }
          broadcast();
          return reply({ ok: true });
        }

        if (action.type === 'begin') {
          if (!isHost) return reply({ ok: false, error: 'Só o anfitrião inicia o jogo.' });
          if (state.phase !== 'setup') return reply({ ok: false, error: 'A partida já começou.' });

          order = [...room.players.keys()];
          turn = -1;
          state.round = 0;
          usedWords.clear();
          totals.clear();
          nextTurn();
          return reply({ ok: true });
        }

        if (action.type === 'choose') {
          if (state.phase !== 'choosing') return reply({ ok: false, error: 'Não dá para escolher agora.' });
          if (user.id !== state.drawerId) return reply({ ok: false, error: 'Não é a sua vez de desenhar.' });
          if (!Number.isInteger(action.index) || action.index < 0 || action.index >= state.options.length) {
            return reply({ ok: false, error: 'Palavra inválida.' });
          }
          chooseWord(action.index);
          return reply({ ok: true });
        }

        // Palpite de quem está adivinhando.
        if (action.type === 'guess') {
          if (state.phase !== 'drawing' || Date.now() >= state.endsAt) {
            return reply({ ok: false, error: 'Não dá para palpitar agora.' });
          }
          if (user.id === state.drawerId) return reply({ ok: false, error: 'Quem desenha não palpita.' });
          if (guessed.has(user.id)) return reply({ ok: false, error: 'Você já acertou! Aguarde os outros.' });

          const text = typeof action.text === 'string' ? action.text.trim().replace(/\s+/g, ' ') : '';
          if (!text || text.length > MAX_GUESS_LENGTH) {
            return reply({ ok: false, error: 'Escreva um palpite de até ' + MAX_GUESS_LENGTH + ' caracteres.' });
          }

          const guess = compact(text);
          if (!guess) return reply({ ok: false, error: 'Escreva um palpite com letras ou números.' });

          const answers = [state.word.text, ...state.word.aliases].map(compact);

          if (answers.includes(guess)) {
            const points = guessPoints();
            guessed.set(user.id, points);
            addScore(user.id, points);
            addScore(state.drawerId, DRAWER_POINTS);
            // A palavra NÃO vai para o chat: só aparece "fulano acertou".
            pushChat({ kind: 'correct', name: user.username, points });
            reply({ ok: true, correct: true, points });

            if (everyoneGuessed()) endRound();
            else broadcast();
            return;
          }

          // Frases que contêm a resposta (ex.: "é pizza") revelariam a palavra para todos no chat.
          if (answers.some((a) => a.length >= 3 && guess.includes(a))) {
            return reply({ ok: false, error: 'Escreva só o palpite, sem frases.' });
          }

          pushChat({ kind: 'guess', name: user.username, text });
          return reply({ ok: true, correct: false });
        }

        // Um pedaço de traço livre: o navegador manda vários pontos de uma vez (em lotes).
        if (action.type === 'stroke') {
          if (!canDraw(user)) return reply({ ok: false, error: 'Só o desenhista pode desenhar agora.' });

          const { id, color, size, points } = action;
          if (!validStyle(id, color, size)) return reply({ ok: false, error: 'Traço inválido.' });
          if (!Array.isArray(points) || points.length === 0 || points.length > MAX_POINTS_PER_CHUNK) {
            return reply({ ok: false, error: 'Traço inválido.' });
          }
          if (!points.every(validPoint)) return reply({ ok: false, error: 'Traço inválido.' });
          if (totalPoints + points.length > MAX_POINTS_TOTAL) {
            return reply({ ok: false, error: 'O quadro está cheio. Limpe para continuar.' });
          }

          const clean = points.map(clampPoint);

          // Mesmo id do último traço = continuação dele; id novo = traço novo.
          let stroke = strokes[strokes.length - 1];
          if (!stroke || stroke.id !== id) {
            if (strokes.length >= MAX_STROKES) {
              return reply({ ok: false, error: 'O quadro está cheio. Limpe para continuar.' });
            }
            stroke = { kind: 'pen', id, color, size, points: [] };
            strokes.push(stroke);
          }
          stroke.points.push(...clean);
          totalPoints += clean.length;

          sendToOthers('draw:stroke', { id, color: stroke.color, size: stroke.size, points: clean }, user.id);
          return reply({ ok: true });
        }

        // Uma forma pronta (reta ou círculo): chega inteira, de uma vez.
        if (action.type === 'shape') {
          if (!canDraw(user)) return reply({ ok: false, error: 'Só o desenhista pode desenhar agora.' });

          const { id, shape, color, size } = action;
          if (!validStyle(id, color, size)) return reply({ ok: false, error: 'Forma inválida.' });
          if (strokes.length >= MAX_STROKES) {
            return reply({ ok: false, error: 'O quadro está cheio. Limpe para continuar.' });
          }

          let entry;
          if (shape === 'line') {
            if (!validPoint(action.a) || !validPoint(action.b)) return reply({ ok: false, error: 'Forma inválida.' });
            entry = { kind: 'line', id, color, size, a: clampPoint(action.a), b: clampPoint(action.b) };
          } else if (shape === 'circle') {
            if (!validPoint(action.c) || !Number.isFinite(action.r) || action.r <= 0 || action.r > MAX_RADIUS) {
              return reply({ ok: false, error: 'Forma inválida.' });
            }
            entry = { kind: 'circle', id, color, size, c: clampPoint(action.c), r: action.r };
          } else {
            return reply({ ok: false, error: 'Forma inválida.' });
          }

          strokes.push(entry);
          sendToOthers('draw:shape', entry, user.id);
          return reply({ ok: true });
        }

        if (action.type === 'clear') {
          if (!canDraw(user)) return reply({ ok: false, error: 'Só o desenhista pode limpar o quadro.' });
          strokes = [];
          totalPoints = 0;
          sendToOthers('draw:clear', {}, user.id);
          return reply({ ok: true });
        }

        if (action.type === 'restart') {
          if (!isHost) return reply({ ok: false, error: 'Só o anfitrião reinicia a partida.' });
          if (state.phase !== 'final') return reply({ ok: false, error: 'A partida ainda não terminou.' });
          state.phase = 'setup';
          state.round = 0;
          totals.clear();
          resetRound();
          broadcast();
          return reply({ ok: true });
        }

        reply({ ok: false, error: 'Ação desconhecida.' });
      },

      destroy() {
        clearTimeout(timer);
      }
    };
  }
};