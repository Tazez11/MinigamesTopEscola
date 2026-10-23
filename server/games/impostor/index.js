const { randomInt } = require('crypto');
const data = require('../draw/words.json'); // mesma lista de palavras do Desenhe e adivinhe

// ---------- Configurações do jogo (fáceis de ajustar) ----------
const TOTAL_ROUNDS = 5;
const LAPS = 2; // quantas voltas de dicas por rodada
const ROLE_SECONDS = 8; // tempo para ler o seu papel
const CLUE_SECONDS = 20; // tempo de cada dica
const DISCUSSION_SECONDS = 30; // discussão antes da votação
const VOTE_SECONDS = 20; // tempo para votar
const REVEAL_SECONDS = 10; // tempo mostrando o resultado
const POINTS_CATCH = 100; // inocente que votou no impostor
const POINTS_ESCAPE = 200; // impostor que escapou
const MAX_CLUE_LENGTH = 20;
const MIN_PLAYERS = 3;

// "Homem-Aranha", "homem aranha" e "HOMEM ARANHA" viram a mesma coisa: "homemaranha".
function compact(text) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function textOf(word) {
  return typeof word === 'string' ? word : word.text;
}

module.exports = {
  createGame({ room, io }) {
    const selected = new Set(data.categories.map((c) => c.id));
    const usedWords = new Set();
    const impostorPast = new Set(); // quem já foi impostor (para revezar)
    const totals = new Map();
    const votes = new Map(); // voterId -> targetId
    const state = {
      phase: 'idle', // setup | role | clues | discussion | voting | reveal | final
      mode: 'classic', // classic | different
      round: 0,
      impostorId: null,
      category: null,
      word: null,
      decoy: null, // palavra "parecida" que o impostor recebe no modo "different"
      turn: -1,
      endsAt: 0,
      notice: null,
      reveal: null
    };
    let order = [];
    let clues = [];
    let timers = [];

    function later(fn, ms) {
      timers.push(setTimeout(fn, ms));
    }

    function clearTimers() {
      timers.forEach(clearTimeout);
      timers = [];
    }

    function phaseSeconds() {
      if (state.phase === 'role') return ROLE_SECONDS;
      if (state.phase === 'clues') return CLUE_SECONDS;
      if (state.phase === 'discussion') return DISCUSSION_SECONDS;
      if (state.phase === 'voting') return VOTE_SECONDS;
      if (state.phase === 'reveal') return REVEAL_SECONDS;
      return 0;
    }

    function scoreboard() {
      const list = [...room.players.values()]
        .map((p) => ({
          id: p.id,
          username: p.username,
          avatarUrl: p.avatarUrl,
          total: totals.get(p.id) || 0
        }))
        .sort((a, b) => b.total - a.total);

      list.forEach((p, i) => {
        p.rank = i > 0 && p.total === list[i - 1].total ? list[i - 1].rank : i + 1;
      });
      return list;
    }

    // O que ESTE jogador vê sobre o seu papel. Nunca revela o papel dos outros.
    //  - inocente: vê a palavra
    //  - impostor (modo clássico): vê só a categoria
    //  - impostor (modo "diferente"): recebe uma palavra parecida e acha que é inocente
    function youFor(playerId) {
      if (playerId === state.impostorId) {
        if (state.mode === 'different') return { role: 'crew', word: state.decoy };
        return { role: 'impostor', word: null };
      }
      return { role: 'crew', word: state.word };
    }

    function currentPlayerId() {
      return order[state.turn % order.length];
    }

    function lapOf(turn) {
      return Math.floor(turn / order.length) + 1;
    }

    function connectedIds() {
      return order.filter((id) => {
        const p = room.players.get(id);
        return p && p.connected !== false;
      });
    }

    function snapshotFor(playerId) {
      const host = room.players.get(room.hostId);
      const inRound = ['role', 'clues', 'discussion', 'voting', 'reveal'].includes(state.phase);
      const current = state.phase === 'clues' ? room.players.get(currentPlayerId()) : null;

      return {
        phase: state.phase,
        round: state.round,
        totalRounds: TOTAL_ROUNDS,
        hostName: host ? host.username : null,
        remainingMs: Math.max(0, state.endsAt - Date.now()),
        durationMs: phaseSeconds() * 1000,
        notice: state.notice,
        settings:
          state.phase === 'setup'
            ? {
                mode: state.mode,
                categories: data.categories.map((c) => ({
                  id: c.id,
                  name: c.name,
                  count: c.words.length,
                  selected: selected.has(c.id)
                }))
              }
            : null,
        category: inRound ? state.category : null,
        you: inRound ? youFor(playerId) : null,
        laps: LAPS,
        players: inRound
          ? order
              .map((id) => {
                const p = room.players.get(id);
                return p ? { id: p.id, username: p.username, avatarUrl: p.avatarUrl } : null;
              })
              .filter(Boolean)
          : null,
        turn: current ? { id: current.id, username: current.username, lap: lapOf(state.turn) } : null,
        clues: inRound ? clues : null,
        // Votação: todos veem QUEM já votou, só você vê EM QUEM votou.
        voted: state.phase === 'voting' ? [...votes.keys()] : null,
        myVote: state.phase === 'voting' ? votes.get(playerId) || null : null,
        reveal: state.phase === 'reveal' ? state.reveal : null,
        scoreboard: state.phase === 'final' ? scoreboard() : null
      };
    }

    function broadcast() {
      for (const player of room.players.values()) {
        if (player.socketId) io.to(player.socketId).emit('impostor:state', snapshotFor(player.id));
      }
    }

    // Sorteia a palavra da rodada (e a "parecida", no modo diferente).
    function pickWords() {
      const pool = [];
      for (const cat of data.categories) {
        if (!selected.has(cat.id)) continue;
        for (const w of cat.words) {
          const key = cat.id + ':' + textOf(w);
          if (!usedWords.has(key)) pool.push({ cat, text: textOf(w), key });
        }
      }
      if (pool.length === 0 && usedWords.size > 0) {
        usedWords.clear();
        return pickWords();
      }

      const pick = pool[randomInt(pool.length)];
      usedWords.add(pick.key);

      let decoy = null;
      if (state.mode === 'different') {
        const others = pick.cat.words.map(textOf).filter((t) => t !== pick.text);
        decoy = others[randomInt(others.length)];
      }
      return { category: pick.cat.name, word: pick.text, decoy };
    }

    function pickImpostor() {
      let candidates = order.filter((id) => !impostorPast.has(id));
      if (candidates.length === 0) {
        impostorPast.clear();
        candidates = [...order];
      }
      const id = candidates[randomInt(candidates.length)];
      impostorPast.add(id);
      return id;
    }

    function finishGame(notice) {
      clearTimers();
      state.phase = 'final';
      state.endsAt = 0;
      state.notice = notice || null;
      broadcast();
    }

    function nextRound() {
      clearTimers();
      if (state.round >= TOTAL_ROUNDS) return finishGame();

      // Só joga quem está conectado agora.
      order = [...room.players.values()].filter((p) => p.connected !== false).map((p) => p.id);
      if (order.length < MIN_PLAYERS) return finishGame('Jogadores insuficientes para continuar.');

      const words = pickWords();
      state.round += 1;
      state.category = words.category;
      state.word = words.word;
      state.decoy = words.decoy;
      state.impostorId = pickImpostor();
      clues = [];
      votes.clear();
      state.reveal = null;
      state.turn = -1;

      state.phase = 'role';
      state.endsAt = Date.now() + ROLE_SECONDS * 1000;
      later(startClues, ROLE_SECONDS * 1000);
      broadcast();
    }

    function startClues() {
      clearTimers();
      state.phase = 'clues';
      state.turn = -1;
      nextTurn();
    }

    // Passa para a próxima pessoa que vai dar dica (pula quem saiu ou está desconectado).
    function nextTurn() {
      clearTimers();

      while (true) {
        state.turn += 1;
        if (state.turn >= order.length * LAPS) return startDiscussion();

        const id = currentPlayerId();
        const player = room.players.get(id);
        if (player && player.connected !== false) break;
        clues.push({ playerId: id, lap: lapOf(state.turn), text: '—' });
      }

      state.endsAt = Date.now() + CLUE_SECONDS * 1000;
      later(() => {
        clues.push({ playerId: currentPlayerId(), lap: lapOf(state.turn), text: '—' });
        nextTurn();
      }, CLUE_SECONDS * 1000);
      broadcast();
    }

    function startDiscussion() {
      clearTimers();
      state.phase = 'discussion';
      state.endsAt = Date.now() + DISCUSSION_SECONDS * 1000;
      later(startVoting, DISCUSSION_SECONDS * 1000);
      broadcast();
    }

    function startVoting() {
      clearTimers();
      votes.clear();
      state.phase = 'voting';
      state.endsAt = Date.now() + VOTE_SECONDS * 1000;
      later(finishVoting, VOTE_SECONDS * 1000);
      broadcast();
    }

    // Conta os votos, dá os pontos e mostra o resultado.
    function finishVoting() {
      if (state.phase !== 'voting') return;
      clearTimers();

      const tally = new Map();
      for (const target of votes.values()) tally.set(target, (tally.get(target) || 0) + 1);

      let top = 0;
      let leaders = [];
      for (const [id, n] of tally) {
        if (n > top) {
          top = n;
          leaders = [id];
        } else if (n === top) {
          leaders.push(id);
        }
      }
      // Só é "pego" se o impostor foi o mais votado sozinho (empate = escapa).
      const caught = leaders.length === 1 && leaders[0] === state.impostorId;

      const gained = [];
      if (caught) {
        for (const [voter, target] of votes) {
          if (target === state.impostorId) gained.push({ id: voter, points: POINTS_CATCH });
        }
      } else {
        gained.push({ id: state.impostorId, points: POINTS_ESCAPE });
      }
      gained.forEach((g) => totals.set(g.id, (totals.get(g.id) || 0) + g.points));

      state.reveal = {
        impostorId: state.impostorId,
        word: state.word,
        decoy: state.mode === 'different' ? state.decoy : null,
        caught,
        votes: [...votes].map(([voterId, targetId]) => ({ voterId, targetId })),
        gained
      };
      state.phase = 'reveal';
      state.endsAt = Date.now() + REVEAL_SECONDS * 1000;
      later(nextRound, REVEAL_SECONDS * 1000);
      broadcast();
    }

    return {
      start() {
        state.phase = 'setup';
        broadcast();
      },

      sendStateTo(socket) {
        socket.emit('impostor:state', snapshotFor(socket.user.id));
      },

      onAction(user, action, reply) {
        const isHost = user.id === room.hostId;

        if (action.type === 'toggle-category') {
          if (!isHost) return reply({ ok: false, error: 'Só o anfitrião configura o jogo.' });
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

        if (action.type === 'set-mode') {
          if (!isHost) return reply({ ok: false, error: 'Só o anfitrião configura o jogo.' });
          if (state.phase !== 'setup') return reply({ ok: false, error: 'A partida já começou.' });
          if (action.mode !== 'classic' && action.mode !== 'different') {
            return reply({ ok: false, error: 'Modo inválido.' });
          }
          state.mode = action.mode;
          broadcast();
          return reply({ ok: true });
        }

        if (action.type === 'begin') {
          if (!isHost) return reply({ ok: false, error: 'Só o anfitrião inicia o jogo.' });
          if (state.phase !== 'setup') return reply({ ok: false, error: 'A partida já começou.' });
          if (room.players.size < MIN_PLAYERS) {
            return reply({ ok: false, error: 'Precisa de pelo menos ' + MIN_PLAYERS + ' jogadores.' });
          }

          usedWords.clear();
          impostorPast.clear();
          totals.clear();
          state.round = 0;
          state.notice = null;
          nextRound();
          return reply({ ok: true });
        }

        // Dica de uma palavra, só na vez de quem está jogando.
        if (action.type === 'clue') {
          if (state.phase !== 'clues' || Date.now() >= state.endsAt) {
            return reply({ ok: false, error: 'Não dá para dar dica agora.' });
          }
          if (user.id !== currentPlayerId()) return reply({ ok: false, error: 'Não é a sua vez.' });

          const text = typeof action.text === 'string' ? action.text.trim() : '';
          if (!text) return reply({ ok: false, error: 'Escreva a sua dica.' });
          if (text.length > MAX_CLUE_LENGTH) {
            return reply({ ok: false, error: 'A dica pode ter até ' + MAX_CLUE_LENGTH + ' caracteres.' });
          }
          if (/\s/.test(text)) return reply({ ok: false, error: 'A dica deve ser uma palavra só.' });

          const key = compact(text);
          if (!key) return reply({ ok: false, error: 'Escreva uma dica com letras ou números.' });

          // Não vale dizer a própria palavra secreta (inocentes e, no modo diferente, o impostor também).
          const mine = youFor(user.id).word;
          if (mine && key.includes(compact(mine))) {
            return reply({ ok: false, error: 'Não vale dizer a palavra! Dê uma dica.' });
          }
          if (clues.some((c) => compact(c.text) === key)) {
            return reply({ ok: false, error: 'Essa dica já foi usada. Tente outra.' });
          }

          clues.push({ playerId: user.id, lap: lapOf(state.turn), text });
          reply({ ok: true });
          return nextTurn();
        }

        // Voto no suspeito. Pode trocar o voto enquanto a votação estiver aberta.
        if (action.type === 'vote') {
          if (state.phase !== 'voting' || Date.now() >= state.endsAt) {
            return reply({ ok: false, error: 'Não dá para votar agora.' });
          }
          if (!order.includes(user.id)) return reply({ ok: false, error: 'Você não está nesta rodada.' });
          if (action.target === user.id) return reply({ ok: false, error: 'Você não pode votar em si mesmo.' });
          if (!order.includes(action.target)) return reply({ ok: false, error: 'Jogador inválido.' });

          votes.set(user.id, action.target);
          reply({ ok: true });

          // Se todos os conectados já votaram, encerra sem esperar o tempo.
          if (connectedIds().every((id) => votes.has(id))) return finishVoting();
          return broadcast();
        }

        if (action.type === 'restart') {
          if (!isHost) return reply({ ok: false, error: 'Só o anfitrião reinicia a partida.' });
          if (state.phase !== 'final') return reply({ ok: false, error: 'A partida ainda não terminou.' });
          clearTimers();
          state.phase = 'setup';
          state.round = 0;
          state.notice = null;
          totals.clear();
          broadcast();
          return reply({ ok: true });
        }

        reply({ ok: false, error: 'Ação desconhecida.' });
      },

      destroy() {
        clearTimers();
      }
    };
  }
};
