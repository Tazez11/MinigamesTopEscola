const { randomInt } = require('crypto');
const sharp = require('sharp');

// ---------- Configurações do jogo (fáceis de ajustar) ----------
const TOTAL_ROUNDS = 8;
const ROUND_SECONDS = 45;
const REVEAL_SECONDS = 7;
const PIXEL_WIDTHS = [6, 10, 16, 26, 42]; // quanto maior o número, mais nítida a imagem
const HINT_AT = 0.5; // a dica do anime aparece na metade do tempo
const MAX_POINTS = 100; // acerto no primeiro instante
const MIN_POINTS = 10; // acerto no último instante
const MAX_GUESS_LENGTH = 40;
const MAX_MESSAGES = 60;
const SPARE_CHARACTERS = 6; // reservas, caso alguma imagem falhe

// ---------- AniList ----------
const API_URL = 'https://graphql.anilist.co';
const POOL_PAGES = 4; // 4 páginas x 50 = os 200 personagens mais populares
const POOL_TTL_MS = 6 * 60 * 60 * 1000; // a lista fica guardada por 6 horas

const QUERY = `
query ($page: Int) {
  Page(page: $page, perPage: 50) {
    characters(sort: FAVOURITES_DESC) {
      id
      name { full alternative }
      image { large }
      media(perPage: 1, sort: POPULARITY_DESC) {
        nodes { title { romaji english } }
      }
    }
  }
}`;

// "Satoru Gojo", "satoru-gojo" e "SATORU GOJO" viram a mesma coisa: "satorugojo".
function compact(text) {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// Respostas aceitas: nome completo, nomes alternativos e partes curtas do nome (ex.: "Naruto").
function buildAnswers(name) {
  const set = new Set();
  const add = (text, minLength) => {
    const key = compact(text);
    if (key.length >= minLength) set.add(key);
  };

  const names = [name.full, ...(name.alternative || [])].filter(Boolean);
  for (const n of names) {
    add(n, 3);
    const words = n.trim().split(/\s+/);
    if (words.length <= 2) for (const word of words) add(word, 4);
  }
  return [...set];
}

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function fetchPool() {
  const list = [];

  for (let page = 1; page <= POOL_PAGES; page++) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { page } })
    });
    if (!res.ok) throw new Error('A AniList respondeu com status ' + res.status);

    const json = await res.json();
    if (json.errors) throw new Error(json.errors[0].message);

    for (const c of json.data.Page.characters) {
      const node = c.media && c.media.nodes[0];
      const hasImage = c.image && c.image.large && !/default/i.test(c.image.large);
      if (!c.name || !c.name.full || !node || !hasImage) continue;

      // Dica: título em inglês quando existir; tira o ano no fim, ex.: "(2011)".
      const anime = (node.title.english || node.title.romaji).replace(/\s*\(\d{4}\)\s*$/, '');
      list.push({ id: c.id, name: c.name.full, anime, imageUrl: c.image.large, answers: buildAnswers(c.name) });
    }
  }

  if (list.length < TOTAL_ROUNDS + SPARE_CHARACTERS) throw new Error('A AniList devolveu poucos personagens.');
  return list;
}

// A lista de personagens é compartilhada entre todas as salas (evita pedir à AniList toda hora).
const poolCache = { at: 0, list: [], promise: null };

function loadPool() {
  if (poolCache.list.length > 0 && Date.now() - poolCache.at < POOL_TTL_MS) {
    return Promise.resolve(poolCache.list);
  }
  if (!poolCache.promise) {
    poolCache.promise = fetchPool()
      .then((list) => {
        poolCache.list = list;
        poolCache.at = Date.now();
        return list;
      })
      .finally(() => {
        poolCache.promise = null;
      });
  }
  return poolCache.promise;
}

// Baixa a imagem e cria as versões pixeladas + a original. Tudo vira "data URL" (texto),
// então o navegador nunca recebe o endereço da imagem nítida antes da hora.
async function buildImages(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('imagem respondeu ' + res.status);
  const original = Buffer.from(await res.arrayBuffer());
  const meta = await sharp(original).metadata();

  const images = [];
  for (const width of PIXEL_WIDTHS) {
    const tiny = await sharp(original).resize(width, null, { kernel: 'nearest' }).toBuffer();
    const pixelated = await sharp(tiny)
      .resize(meta.width, meta.height, { fit: 'fill', kernel: 'nearest' })
      .jpeg({ quality: 80 })
      .toBuffer();
    images.push('data:image/jpeg;base64,' + pixelated.toString('base64'));
  }

  const full = await sharp(original).jpeg({ quality: 88 }).toBuffer();
  images.push('data:image/jpeg;base64,' + full.toString('base64'));
  return images; // posições 0..4 = pixeladas, posição 5 = original
}

module.exports = {
  createGame({ room, io }) {
    const totals = new Map();
    const guessed = new Map(); // quem já acertou nesta rodada -> pontos
    const roundGains = new Map(); // pontos ganhos nesta rodada
    const state = {
      phase: 'idle', // loading | playing | reveal | final | error
      round: 0,
      level: 0,
      hintVisible: false,
      endsAt: 0,
      error: null,
      current: null,
      images: []
    };

    let epoch = 0; // muda quando a partida reinicia, para ignorar trabalhos antigos
    let timers = [];
    let candidates = [];
    let upcoming = null;
    let messages = [];
    let chatSeq = 0;

    function later(fn, ms) {
      timers.push(setTimeout(fn, ms));
    }

    function clearTimers() {
      timers.forEach(clearTimeout);
      timers = [];
    }

    function resetRoundData() {
      guessed.clear();
      roundGains.clear();
      messages = [];
    }

    function pushChat(message) {
      message.id = ++chatSeq;
      messages.push(message);
      if (messages.length > MAX_MESSAGES) messages.shift();
      io.to(room.code).emit('character:chat', message);
    }

    function scoreboard() {
      const list = [...room.players.values()]
        .map((p) => ({
          id: p.id,
          username: p.username,
          avatarUrl: p.avatarUrl,
          total: totals.get(p.id) || 0,
          gain: roundGains.get(p.id) || 0,
          guessed: guessed.has(p.id)
        }))
        .sort((a, b) => b.total - a.total);

      list.forEach((p, i) => {
        p.rank = i > 0 && p.total === list[i - 1].total ? list[i - 1].rank : i + 1;
      });
      return list;
    }

    function snapshotFor(playerId) {
      const host = room.players.get(room.hostId);
      const playing = state.phase === 'playing';
      const reveal = state.phase === 'reveal';

      return {
        phase: state.phase,
        round: state.round,
        totalRounds: TOTAL_ROUNDS,
        hostName: host ? host.username : null,
        youGuessed: guessed.has(playerId),
        remainingMs: Math.max(0, state.endsAt - Date.now()),
        durationMs: (reveal ? REVEAL_SECONDS : ROUND_SECONDS) * 1000,
        error: state.phase === 'error' ? state.error : null,
        // O nome só é enviado na revelação. Antes disso, só a dica (o anime) na metade do tempo.
        hint: playing && state.hintVisible ? state.current.anime : null,
        reveal: reveal ? { name: state.current.name, anime: state.current.anime } : null,
        scoreboard: ['playing', 'reveal', 'final'].includes(state.phase) ? scoreboard() : null
      };
    }

    function broadcast() {
      for (const player of room.players.values()) {
        if (player.socketId) io.to(player.socketId).emit('character:state', snapshotFor(player.id));
      }
    }

    function imagePayload() {
      const full = state.phase === 'reveal';
      return {
        level: state.level,
        levels: PIXEL_WIDTHS.length,
        full,
        src: state.images[full ? PIXEL_WIDTHS.length : state.level]
      };
    }

    function sendImage(target) {
      if (state.images.length === 0) return;
      (target || io.to(room.code)).emit('character:image', imagePayload());
    }

    function fail(err) {
      console.error('Adivinhe o personagem:', err.message);
      clearTimers();
      state.phase = 'error';
      state.error = 'Não consegui buscar os personagens. Verifique a internet do servidor e tente de novo.';
      broadcast();
    }

    // Prepara a imagem da PRÓXIMA rodada enquanto a atual acontece.
    function prefetch(myEpoch) {
      upcoming = prepareNext(myEpoch);
      upcoming.catch(() => {}); // evita erro "não tratado" se ninguém estiver esperando
    }

    async function prepareNext(myEpoch) {
      while (candidates.length > 0 && myEpoch === epoch) {
        const character = candidates.shift();
        try {
          return { character, images: await buildImages(character.imageUrl) };
        } catch (err) {
          console.error('Personagem ignorado:', character.name, '-', err.message);
        }
      }
      throw new Error('Não consegui carregar as imagens dos personagens.');
    }

    async function beginGame() {
      const myEpoch = ++epoch;
      clearTimers();
      state.phase = 'loading';
      state.round = 0;
      state.error = null;
      state.current = null;
      state.images = [];
      totals.clear();
      resetRoundData();
      broadcast();

      try {
        const pool = await loadPool();
        if (myEpoch !== epoch) return;
        candidates = shuffle(pool).slice(0, TOTAL_ROUNDS + SPARE_CHARACTERS);
        prefetch(myEpoch);
        await nextRound(myEpoch);
      } catch (err) {
        if (myEpoch === epoch) fail(err);
      }
    }

    async function nextRound(myEpoch) {
      clearTimers();

      if (state.round >= TOTAL_ROUNDS) {
        state.phase = 'final';
        state.endsAt = 0;
        state.current = null;
        state.images = [];
        resetRoundData();
        return broadcast();
      }

      let item;
      try {
        item = await upcoming;
      } catch (err) {
        if (myEpoch === epoch) fail(err);
        return;
      }
      if (myEpoch !== epoch) return;
      startRound(item);
    }

    function startRound(item) {
      const roundMs = ROUND_SECONDS * 1000;
      const stageMs = roundMs / PIXEL_WIDTHS.length;

      state.round += 1;
      state.current = item.character;
      state.images = item.images;
      state.level = 0;
      state.hintVisible = false;
      resetRoundData();
      state.phase = 'playing';
      state.endsAt = Date.now() + roundMs;

      // A imagem fica mais nítida a cada etapa; a dica aparece na metade do tempo.
      for (let k = 1; k < PIXEL_WIDTHS.length; k++) {
        later(() => {
          state.level = k;
          sendImage();
        }, k * stageMs);
      }
      later(() => {
        state.hintVisible = true;
        broadcast();
      }, roundMs * HINT_AT);
      later(endRound, roundMs);

      if (state.round < TOTAL_ROUNDS) prefetch(epoch);

      broadcast();
      sendImage();
    }

    function endRound() {
      clearTimers();
      state.phase = 'reveal';
      state.endsAt = Date.now() + REVEAL_SECONDS * 1000;
      later(() => nextRound(epoch), REVEAL_SECONDS * 1000);
      broadcast();
      sendImage();
    }

    // Quanto mais cedo acerta, mais pontos: cai em linha reta de MAX_POINTS até MIN_POINTS.
    function guessPoints() {
      const total = ROUND_SECONDS * 1000;
      const left = Math.min(total, Math.max(0, state.endsAt - Date.now()));
      return Math.round(MIN_POINTS + (MAX_POINTS - MIN_POINTS) * (left / total));
    }

    function everyoneGuessed() {
      const players = [...room.players.values()].filter((p) => p.connected !== false);
      return players.length > 0 && players.every((p) => guessed.has(p.id));
    }

    return {
      start() {
        beginGame();
      },

      sendStateTo(socket) {
        socket.emit('character:state', snapshotFor(socket.user.id));
        if (state.phase === 'playing' || state.phase === 'reveal') {
          socket.emit('character:chat-sync', { messages });
          sendImage(socket);
        }
      },

      onAction(user, action, reply) {
        const isHost = user.id === room.hostId;

        if (action.type === 'guess') {
          if (state.phase !== 'playing' || Date.now() >= state.endsAt) {
            return reply({ ok: false, error: 'Não dá para palpitar agora.' });
          }
          if (guessed.has(user.id)) return reply({ ok: false, error: 'Você já acertou! Aguarde os outros.' });

          const text = typeof action.text === 'string' ? action.text.trim().replace(/\s+/g, ' ') : '';
          if (!text || text.length > MAX_GUESS_LENGTH) {
            return reply({ ok: false, error: 'Escreva um palpite de até ' + MAX_GUESS_LENGTH + ' caracteres.' });
          }

          const guess = compact(text);
          if (!guess) return reply({ ok: false, error: 'Escreva um palpite com letras ou números.' });

          const answers = state.current.answers;

          if (answers.includes(guess)) {
            const points = guessPoints();
            guessed.set(user.id, points);
            totals.set(user.id, (totals.get(user.id) || 0) + points);
            roundGains.set(user.id, points);
            // O nome NÃO vai para o chat: só aparece "fulano acertou".
            pushChat({ kind: 'correct', name: user.username, points });
            reply({ ok: true, correct: true, points });

            if (everyoneGuessed()) endRound();
            else broadcast();
            return;
          }

          // Frases que contêm a resposta (ex.: "é o gojo") revelariam o nome para todos no chat.
          if (answers.some((a) => guess.includes(a))) {
            return reply({ ok: false, error: 'Escreva só o palpite, sem frases.' });
          }

          pushChat({ kind: 'guess', name: user.username, text });
          return reply({ ok: true, correct: false });
        }

        if (action.type === 'restart') {
          if (!isHost) return reply({ ok: false, error: 'Só o anfitrião reinicia a partida.' });
          if (state.phase !== 'final' && state.phase !== 'error') {
            return reply({ ok: false, error: 'A partida ainda não terminou.' });
          }
          beginGame();
          return reply({ ok: true });
        }

        reply({ ok: false, error: 'Ação desconhecida.' });
      },

      destroy() {
        epoch += 1;
        clearTimers();
      }
    };
  }
};
