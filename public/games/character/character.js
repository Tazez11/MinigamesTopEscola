(function () {
  // Ícones (traçado simples, herdam a cor do texto).
  const ICONS = {
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    check: '<path d="M20 6 9 17l-5-5"/>'
  };

  function icon(name) {
    return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + ICONS[name] + '</svg>';
  }

  const MAX_MESSAGES = 60;

  let socket = null;
  let root = null;
  let els = {};
  let phase = 'idle';
  let localEnd = 0;
  let duration = 1;
  let tick = null;
  let guessAllowed = false;
  let shownRound = 0;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function myName() {
    return document.getElementById('user-name').textContent;
  }

  function avatarFor(user) {
    const node = el('div', 'avatar');
    setAvatar(node, user);
    return node;
  }

  function actionButton(label, className, action) {
    const button = el('button', 'btn ' + className, label);
    button.type = 'button';
    button.addEventListener('click', () => {
      button.disabled = true;
      socket.emit('game:action', action, (res) => {
        if (res && !res.ok) {
          showToast(res.error, 'error');
          button.disabled = false;
        }
      });
    });
    return button;
  }

  /* ---------- Chat de palpites ---------- */

  function addMessage(message) {
    const list = els.messages;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;

    const li = el('li', 'char-msg ' + message.kind);
    if (message.kind === 'correct') {
      li.innerHTML = icon('check');
      li.append(el('span', '', message.name + ' acertou! +' + message.points));
    } else {
      li.append(el('strong', '', message.name), document.createTextNode(' ' + message.text));
    }
    list.append(li);

    while (list.children.length > MAX_MESSAGES) list.firstChild.remove();
    if (nearBottom) list.scrollTop = list.scrollHeight;
  }

  function setGuessEnabled(enabled, placeholder) {
    guessAllowed = enabled;
    els.guess.disabled = !enabled;
    els.sendBtn.disabled = !enabled;
    els.guess.placeholder = placeholder;
  }

  function buildChat() {
    els.guessForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = els.guess.value.trim();
      if (!text || !guessAllowed) return;

      els.sendBtn.disabled = true;
      socket.emit('game:action', { type: 'guess', text }, (res) => {
        els.sendBtn.disabled = !guessAllowed;
        if (!res || !res.ok) {
          showToast(res ? res.error : 'O servidor não respondeu.', 'error');
          return;
        }
        els.guess.value = '';
        if (res.correct) showToast('Você acertou! +' + res.points + ' pontos', 'success');
        else els.guess.focus();
      });
    });
  }

  /* ---------- Placar ---------- */

  function badge(iconName, label) {
    const node = el('span', 'char-badge');
    node.innerHTML = icon(iconName);
    node.append(el('span', '', label));
    return node;
  }

  function scoreList(scoreboard) {
    const list = el('ol', 'char-score');

    scoreboard.forEach((p) => {
      const mine = p.username === myName();
      const li = el('li', 'char-rank' + (mine ? ' me' : ''));
      li.append(
        el('span', 'char-rank-pos', p.rank + 'º'),
        avatarFor(p),
        el('span', 'char-rank-name', p.username + (mine ? ' (você)' : ''))
      );

      if (p.guessed && phase === 'playing') li.append(badge('check', 'Acertou'));
      if (p.gain > 0) li.append(el('span', 'char-rank-gain', '+' + p.gain));
      li.append(el('span', 'char-rank-total', p.total + ' pts'));
      list.append(li);
    });
    return list;
  }

  /* ---------- Montagem ---------- */

  function build(stage) {
    root = el('div', 'char');
    root.innerHTML = `
      <div class="char-top">
        <div>
          <span class="muted-left">Rodada</span>
          <strong class="char-round"></strong>
        </div>
        <div class="char-time"><span class="char-seconds"></span>s</div>
      </div>
      <div class="char-bar"><div class="char-bar-fill"></div></div>
      <div class="char-body"></div>
      <div class="char-play" hidden>
        <div class="char-stage">
          <div class="char-photo-wrap">
            <img class="char-photo pixel" alt="Personagem escondido por pixels">
          </div>
          <div class="char-levels" role="img" aria-label="Nitidez da imagem"></div>
          <p class="char-hint"></p>
        </div>
        <aside class="char-side">
          <div class="char-score-box"></div>
          <section class="char-chat" aria-label="Palpites">
            <ol class="char-messages" role="log" aria-live="polite"></ol>
            <form class="char-guess-form">
              <input class="char-guess" maxlength="40" autocomplete="off" spellcheck="false" aria-label="Seu palpite">
              <button type="submit" class="char-send" aria-label="Enviar palpite" title="Enviar palpite">${icon('send')}</button>
            </form>
          </section>
        </aside>
      </div>
    `;
    stage.append(root);

    els = {
      top: root.querySelector('.char-top'),
      round: root.querySelector('.char-round'),
      seconds: root.querySelector('.char-seconds'),
      bar: root.querySelector('.char-bar'),
      fill: root.querySelector('.char-bar-fill'),
      body: root.querySelector('.char-body'),
      play: root.querySelector('.char-play'),
      photo: root.querySelector('.char-photo'),
      levels: root.querySelector('.char-levels'),
      hint: root.querySelector('.char-hint'),
      score: root.querySelector('.char-score-box'),
      messages: root.querySelector('.char-messages'),
      guessForm: root.querySelector('.char-guess-form'),
      guess: root.querySelector('.char-guess'),
      sendBtn: root.querySelector('.char-send')
    };

    buildChat();
  }

  function renderTime() {
    const remaining = Math.max(0, localEnd - Date.now());
    const secs = Math.ceil(remaining / 1000);
    els.seconds.textContent = secs;
    els.fill.style.transform = 'scaleX(' + remaining / duration + ')';
    root.classList.toggle('urgent', phase === 'playing' && secs <= 10);
  }

  // Segmentos que mostram em que etapa de nitidez a imagem está.
  function renderLevels(level, levels, full) {
    const segments = [];
    for (let i = 0; i < levels; i++) {
      segments.push(el('i', i <= level || full ? 'on' : ''));
    }
    els.levels.replaceChildren(...segments);
    els.levels.setAttribute('aria-label', full ? 'Imagem completa' : 'Nitidez da imagem: etapa ' + (level + 1) + ' de ' + levels);
  }

  /* ---------- Telas ---------- */

  function renderLoading() {
    els.body.replaceChildren(
      el('div', 'char-spinner'),
      el('h2', 'char-heading', 'Buscando personagens…'),
      el('p', 'char-note', 'Preparando as imagens da partida. Só um instante.')
    );
  }

  function renderError(state) {
    const isHost = state.hostName === myName();
    els.body.replaceChildren(
      el('h2', 'char-heading', 'Algo deu errado'),
      el('p', 'char-note', state.error),
      isHost
        ? actionButton('Tentar de novo', 'btn-primary', { type: 'restart' })
        : el('p', 'char-note', 'Aguardando o anfitrião tentar de novo…')
    );
  }

  function renderFinal(state) {
    const isHost = state.hostName === myName();
    const winners = state.scoreboard.filter((p) => p.rank === 1);
    const headline =
      winners.length === 1
        ? '🏆 ' + winners[0].username + ' venceu!'
        : '🏆 Empate entre ' + winners.map((w) => w.username).join(' e ') + '!';

    els.body.replaceChildren(
      el('h2', 'char-heading', 'Fim de jogo'),
      el('p', 'char-winner', headline),
      scoreList(state.scoreboard),
      isHost
        ? actionButton('Jogar de novo', 'btn-primary', { type: 'restart' })
        : el('p', 'char-note', 'Aguardando o anfitrião: jogar de novo ou encerrar a partida.')
    );
  }

  function renderPlaying(state) {
    els.body.replaceChildren();
    els.hint.textContent = state.hint
      ? 'Dica · Anime: ' + state.hint
      : 'A dica do anime aparece na metade do tempo.';
    els.hint.classList.toggle('on', Boolean(state.hint));
  }

  function renderReveal(state) {
    els.body.replaceChildren();
    els.hint.textContent = 'Era ' + state.reveal.name + ' · ' + state.reveal.anime;
    els.hint.classList.add('on');
    els.photo.alt = state.reveal.name;
  }

  /* ---------- Eventos do servidor ---------- */

  function onState(state) {
    if (!root) return;

    phase = state.phase;
    duration = state.durationMs || 1;
    localEnd = Date.now() + state.remainingMs;

    const timed = phase === 'playing' || phase === 'reveal';
    const inRound = timed;

    els.top.hidden = !timed;
    els.bar.hidden = !timed;
    els.play.hidden = !inRound;
    els.round.textContent = state.round + ' de ' + state.totalRounds;

    // Rodada nova: limpa a imagem e o chat da rodada anterior.
    if (phase === 'playing' && state.round !== shownRound) {
      shownRound = state.round;
      els.photo.removeAttribute('src');
      els.photo.alt = 'Personagem escondido por pixels';
      els.messages.replaceChildren();
    }
    if (!inRound) shownRound = 0;

    if (inRound) els.score.replaceChildren(scoreList(state.scoreboard));

    if (phase === 'playing') {
      if (state.youGuessed) setGuessEnabled(false, 'Você acertou! Aguarde os outros');
      else setGuessEnabled(true, 'Quem é o personagem?');
    } else {
      setGuessEnabled(false, 'Aguarde a próxima rodada');
    }

    if (phase === 'loading') renderLoading();
    else if (phase === 'error') renderError(state);
    else if (phase === 'playing') renderPlaying(state);
    else if (phase === 'reveal') renderReveal(state);
    else if (phase === 'final') renderFinal(state);

    clearInterval(tick);
    renderTime();
    if (timed) tick = setInterval(renderTime, 250);
  }

  function onImage(data) {
    if (!root) return;
    els.photo.src = data.src;
    els.photo.classList.toggle('pixel', !data.full);
    renderLevels(data.level, data.levels, data.full);
  }

  function onChat(message) {
    if (root) addMessage(message);
  }

  function onChatSync(data) {
    if (!root) return;
    els.messages.replaceChildren();
    data.messages.forEach(addMessage);
    els.messages.scrollTop = els.messages.scrollHeight;
  }

  function mount(stage, sock) {
    socket = sock;
    build(stage);
    socket.on('character:state', onState);
    socket.on('character:image', onImage);
    socket.on('character:chat', onChat);
    socket.on('character:chat-sync', onChatSync);
  }

  function unmount() {
    if (socket) {
      socket.off('character:state', onState);
      socket.off('character:image', onImage);
      socket.off('character:chat', onChat);
      socket.off('character:chat-sync', onChatSync);
    }
    clearInterval(tick);
    root = null;
    phase = 'idle';
    shownRound = 0;
  }

  window.gameUIs = window.gameUIs || {};
  window.gameUIs.character = { mount, unmount };
})();
