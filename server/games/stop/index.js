const { randomInt } = require('crypto');

const ROUND_SECONDS = 90;
const STOP_COUNTDOWN_SECONDS = 3;
const RESULTS_SECONDS = 15;
const VOTING_SECONDS = 25;
const LATE_GRACE_MS = 1500;
const TOTAL_ROUNDS = 5;
const POINTS_UNIQUE = 10;
const POINTS_REPEATED = 5;
const MAX_ANSWER_LENGTH = 30;
const DEFAULT_CATEGORIES = ['Nome', 'Animal', 'Cor', 'Cidade ou país', 'Fruta', 'Objeto'];
const LETTERS = 'ABCDEFGHIJLMNOPQRSTUV'.split('');
const MIN_CATEGORIES = 3;
const MAX_CATEGORIES = 12;
const MAX_CATEGORY_LENGTH = 24;

function normalize(text) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = {
  createGame({ room, io }) {
    const used = [];
    const categories = [...DEFAULT_CATEGORIES];
    const answers = new Map();
    const totals = new Map();
    const state = {
      round: 0,
      letter: null,
      phase: 'idle',
      endsAt: 0,
      stoppedByName: null,
      results: null
    };
    let votes = new Map();
    let candidates = [];
    let timer = null;

    function ranking() {
      const list = [...room.players.values()]
        .map((p) => ({
          id: p.id,
          username: p.username,
          avatarUrl: p.avatarUrl,
          totalPoints: totals.get(p.id) || 0
        }))
        .sort((a, b) => b.totalPoints - a.totalPoints);

      list.forEach((p, i) => {
        p.rank = i > 0 && p.totalPoints === list[i - 1].totalPoints ? list[i - 1].rank : i + 1;
      });
      return list;
    }

    function phaseSeconds() {
      if (state.phase === 'results') return RESULTS_SECONDS;
      if (state.phase === 'voting') return VOTING_SECONDS;
      return ROUND_SECONDS;
    }

    function snapshot() {
      const host = room.players.get(room.hostId);
      const showRanking = state.phase === 'results' || state.phase === 'final';
      return {
        round: state.round,
        totalRounds: TOTAL_ROUNDS,
        letter: state.letter,
        phase: state.phase,
        categories,
        remainingMs: Math.max(0, state.endsAt - Date.now()),
        durationMs: phaseSeconds() * 1000,
        candidates:
          state.phase === 'voting'
            ? candidates.map((c) => ({ ...c, category: categories[c.index] }))
            : null,
        stoppedByName: state.stoppedByName,
        hostName: host ? host.username : null,
        results: state.phase === 'results' ? state.results : null,
        ranking: showRanking ? ranking() : null
      };
    }

    function broadcast() {
      io.to(room.code).emit('stop:state', snapshot());
    }

    // Calcula os pontos da rodada. NÃO soma nos totais (isso é feito em applyTotals).
    // "rejected" guarda as respostas derrubadas na votação, no formato "idDoJogador:indiceDaCategoria".
    function computeResults(rejected = new Set()) {
      const isRejected = (playerId, i) => rejected.has(playerId + ':' + i);
      const letter = state.letter.toLowerCase();
      const players = [...room.players.values()];

      const counts = categories.map((_, i) => {
        const map = new Map();
        for (const player of players) {
          if (isRejected(player.id, i)) continue;
          const key = normalize((answers.get(player.id) || [])[i] || '');
          if (key && key.startsWith(letter)) map.set(key, (map.get(key) || 0) + 1);
        }
        return map;
      });

      return players
        .map((player) => {
          const mine = answers.get(player.id) || [];
          let roundPoints = 0;

          const items = categories.map((_, i) => {
            const text = mine[i] || '';
            const key = normalize(text);
            let status = 'unique';
            let points = POINTS_UNIQUE;

            if (!key) {
              status = 'blank';
              points = 0;
            } else if (!key.startsWith(letter)) {
              status = 'invalid';
              points = 0;
            } else if (isRejected(player.id, i)) {
              status = 'rejected';
              points = 0;
            } else if (counts[i].get(key) > 1) {
              status = 'repeated';
              points = POINTS_REPEATED;
            }

            roundPoints += points;
            return { text, status, points };
          });

          return {
            id: player.id,
            username: player.username,
            avatarUrl: player.avatarUrl,
            items,
            roundPoints
          };
        })
        .sort((a, b) => b.roundPoints - a.roundPoints);
    }

    function applyTotals(results) {
      for (const r of results) {
        totals.set(r.id, (totals.get(r.id) || 0) + r.roundPoints);
      }
    }

    function startRound() {
      const pool = LETTERS.filter((letter) => !used.includes(letter));
      state.round += 1;
      state.letter = pool[randomInt(pool.length)];
      used.push(state.letter);
      state.phase = 'playing';
      state.stoppedByName = null;
      state.results = null;
      state.endsAt = Date.now() + ROUND_SECONDS * 1000;
      answers.clear();

      timer = setTimeout(endRound, ROUND_SECONDS * 1000 + LATE_GRACE_MS);
      broadcast();
    }

    // Fim da rodada: separa as respostas que podem ser contestadas e abre a votação.
    function endRound() {
      clearTimeout(timer);
      candidates = [];
      votes = new Map();

      computeResults().forEach((r) =>
        r.items.forEach((item, i) => {
          if (item.status === 'unique' || item.status === 'repeated') {
          candidates.push({ id: r.id, username: r.username, avatarUrl: r.avatarUrl, index: i, text: item.text });
          }
        })
      );

      if (candidates.length === 0) return finishVoting();

      state.phase = 'voting';
      state.endsAt = Date.now() + VOTING_SECONDS * 1000;
      timer = setTimeout(finishVoting, VOTING_SECONDS * 1000);
      broadcast();
    }

    // Fim da votação: derruba as respostas contestadas pela maioria e fecha a pontuação.
    function finishVoting() {
      clearTimeout(timer);
      const rejected = new Set();

      for (const c of candidates) {
        const key = c.id + ':' + c.index;
        const voters = [...room.players.keys()].filter((id) => id !== c.id).length;
        const contests = [...(votes.get(key) || [])].filter((id) => room.players.has(id)).length;
        if (contests > voters / 2) rejected.add(key);
      }

      state.results = computeResults(rejected);
      applyTotals(state.results);
      state.phase = 'results';
      state.endsAt = Date.now() + RESULTS_SECONDS * 1000;
      timer = setTimeout(advance, RESULTS_SECONDS * 1000);
      broadcast();
    }

    function advance() {
      clearTimeout(timer);
      if (state.round < TOTAL_ROUNDS) return startRound();

      state.phase = 'final';
      state.endsAt = 0;
      state.results = null;
      broadcast();
    }

    function restart() {
      used.length = 0;
      totals.clear();
      state.round = 0;
      startRound();
    }

    return {
      start() {
        state.phase = 'setup';
        broadcast();
      },

      sendStateTo(socket) {
        const myContests = candidates
          .filter((c) => (votes.get(c.id + ':' + c.index) || new Set()).has(socket.user.id))
          .map((c) => c.id + ':' + c.index);

        socket.emit('stop:state', {
          ...snapshot(),
          answers: answers.get(socket.user.id) || null,
          myContests
        });
      },

      onAction(user, action, reply) {
        const active = state.phase === 'playing' || state.phase === 'stopping';
        const isHost = user.id === room.hostId;

        if (['category-add', 'category-remove', 'begin'].includes(action.type)) {
          if (!isHost) return reply({ ok: false, error: 'Só o anfitrião configura o jogo.' });
          if (state.phase !== 'setup') return reply({ ok: false, error: 'A partida já começou.' });

          if (action.type === 'begin') {
            startRound();
            return reply({ ok: true });
          }

          if (action.type === 'category-add') {
            const name = typeof action.name === 'string' ? action.name.trim().replace(/\s+/g, ' ') : '';
            if (name.length < 2 || name.length > MAX_CATEGORY_LENGTH) {
              return reply({ ok: false, error: 'O nome deve ter de 2 a ' + MAX_CATEGORY_LENGTH + ' caracteres.' });
            }
            if (categories.length >= MAX_CATEGORIES) {
              return reply({ ok: false, error: 'Máximo de ' + MAX_CATEGORIES + ' categorias.' });
            }
            if (categories.some((c) => normalize(c) === normalize(name))) {
              return reply({ ok: false, error: 'Essa categoria já existe.' });
            }
            categories.push(name);
          } else {
            if (categories.length <= MIN_CATEGORIES) {
              return reply({ ok: false, error: 'Mínimo de ' + MIN_CATEGORIES + ' categorias.' });
            }
            if (!Number.isInteger(action.index) || action.index < 0 || action.index >= categories.length) {
              return reply({ ok: false, error: 'Categoria inválida.' });
            }
            categories.splice(action.index, 1);
          }

          broadcast();
          return reply({ ok: true });
        }

        if (action.type === 'answers') {
          if (!active) return reply({ ok: false, error: 'A rodada já terminou.' });

          const list = action.answers;
          if (!Array.isArray(list) || list.length !== categories.length || list.some((a) => typeof a !== 'string')) {
            return reply({ ok: false, error: 'Respostas inválidas.' });
          }

          answers.set(user.id, list.map((a) => a.trim().slice(0, MAX_ANSWER_LENGTH)));
          return reply({ ok: true });
        }

        if (action.type === 'stop') {
          if (state.phase !== 'playing' || Date.now() >= state.endsAt) {
            return reply({ ok: false, error: 'Não dá para apertar STOP agora.' });
          }

          const mine = answers.get(user.id);
          if (!mine || mine.some((a) => a === '')) {
            return reply({ ok: false, error: 'Preencha todas as categorias para apertar STOP.' });
          }

          state.phase = 'stopping';
          state.stoppedByName = user.username;
          state.endsAt = Date.now() + STOP_COUNTDOWN_SECONDS * 1000;

          clearTimeout(timer);
          timer = setTimeout(endRound, STOP_COUNTDOWN_SECONDS * 1000 + LATE_GRACE_MS);

          broadcast();
          return reply({ ok: true });
        }

        if (action.type === 'contest') {
          if (state.phase !== 'voting') return reply({ ok: false, error: 'A votação não está aberta.' });

          const cand = candidates.find((c) => c.id === action.playerId && c.index === action.index);
          if (!cand) return reply({ ok: false, error: 'Resposta inválida.' });
          if (cand.id === user.id) {
            return reply({ ok: false, error: 'Você não pode contestar a própria resposta.' });
          }

          const key = cand.id + ':' + cand.index;
          const set = votes.get(key) || new Set();
          if (set.has(user.id)) set.delete(user.id);
          else set.add(user.id);
          votes.set(key, set);

          return reply({ ok: true, contested: set.has(user.id) });
        }

        if (action.type === 'skip-vote') {
          if (!isHost) return reply({ ok: false, error: 'Só o anfitrião encerra a votação.' });
          if (state.phase !== 'voting') return reply({ ok: false, error: 'A votação não está aberta.' });
          finishVoting();
          return reply({ ok: true });
        }

        if (action.type === 'next') {
          if (!isHost) return reply({ ok: false, error: 'Só o anfitrião avança a rodada.' });
          if (state.phase !== 'results') return reply({ ok: false, error: 'Não dá para avançar agora.' });
          advance();
          return reply({ ok: true });
        }

        if (action.type === 'restart') {
          if (!isHost) return reply({ ok: false, error: 'Só o anfitrião reinicia a partida.' });
          if (state.phase !== 'final') return reply({ ok: false, error: 'A partida ainda não terminou.' });
          restart();
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