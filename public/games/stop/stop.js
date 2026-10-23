(function () {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const STATUS_TEXT = {
    unique: '',
    repeated: ' · repetida',
    invalid: ' · letra errada',
    blank: ' · em branco',
    rejected: ' · contestada'
  };

  let socket = null;
  let root = null;
  let els = {};
  let currentRound = 0;
  let letter = '';
  let phase = 'idle';
  let locked = false;
  let localEnd = 0;
  let duration = 1;
  let tick = null;
  let sendTimer = null;
  let myContests = new Set();

  function isActive() {
    return phase === 'playing' || phase === 'stopping';
  }

  function isTimed() {
    return isActive() || phase === 'results' || phase === 'voting';
  }

  function inputs() {
    return [...els.fields.querySelectorAll('input')];
  }

  function myName() {
    return document.getElementById('user-name').textContent;
  }

  function normalize(text) {
    return text.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function avatarFor(user) {
    const node = el('div', 'avatar');
    setAvatar(node, user);
    return node;
  }

  function send(action) {
    socket.emit('game:action', action, (res) => {
      if (res && !res.ok) showToast(res.error, 'error');
    });
  }

  function build(stage) {
    root = document.createElement('div');
    root.className = 'stop';
    root.innerHTML = `
      <div class="stop-top">
        <div>
          <span class="muted-left">Rodada</span>
          <strong class="stop-round"></strong>
        </div>
        <div class="stop-letter" aria-label="Letra da rodada"></div>
        <div class="stop-time">
          <div><span class="stop-seconds"></span>s</div>
          <span class="muted-left stop-time-caption"></span>
        </div>
      </div>
      <div class="stop-bar"><div class="stop-bar-fill"></div></div>
      <p class="stop-callout" role="status" hidden></p>
      <div class="stop-play">
        <div class="stop-fields"></div>
        <p class="stop-progress"></p>
        <button type="button" class="btn stop-button" disabled>STOP!</button>
        <p class="stop-ended" role="status" hidden>⏱ Conferindo as respostas…</p>
      </div>
      <div class="stop-results" hidden></div>
    `;
    stage.append(root);

    els = {
      top: root.querySelector('.stop-top'),
      round: root.querySelector('.stop-round'),
      letter: root.querySelector('.stop-letter'),
      seconds: root.querySelector('.stop-seconds'),
      caption: root.querySelector('.stop-time-caption'),
      bar: root.querySelector('.stop-bar'),
      fill: root.querySelector('.stop-bar-fill'),
      callout: root.querySelector('.stop-callout'),
      play: root.querySelector('.stop-play'),
      fields: root.querySelector('.stop-fields'),
      progress: root.querySelector('.stop-progress'),
      stopBtn: root.querySelector('.stop-button'),
      ended: root.querySelector('.stop-ended'),
      results: root.querySelector('.stop-results')
    };

    els.fields.addEventListener('input', () => {
      updateFields();
      queueSend();
    });
    els.fields.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const list = inputs();
      const next = list[list.indexOf(e.target) + 1];
      if (next) next.focus();
    });
    els.stopBtn.addEventListener('click', onStopClick);
  }

  function queueSend() {
    clearTimeout(sendTimer);
    sendTimer = setTimeout(sendAnswers, 300);
  }

  function sendAnswers() {
    clearTimeout(sendTimer);
    if (!socket || !isActive()) return;
    socket.emit('game:action', { type: 'answers', answers: inputs().map((input) => input.value.trim()) });
  }

  function onStopClick() {
    els.stopBtn.disabled = true;
    sendAnswers();
    socket.emit('game:action', { type: 'stop' }, (res) => {
      if (res && !res.ok) showToast(res.error, 'error');
    });
  }

  function buildFields(categories) {
    els.fields.replaceChildren(
      ...categories.map((category) => {
        const label = el('label', 'field');
        const wrap = el('div', 'stop-input-wrap');

        const input = document.createElement('input');
        input.maxLength = 30;
        input.autocomplete = 'off';
        input.spellcheck = false;

        wrap.append(input, el('i', 'stop-status'));
        label.append(el('span', '', category), wrap);
        return label;
      })
    );
  }

  function updateFields() {
    const wraps = [...els.fields.querySelectorAll('.stop-input-wrap')];
    let filled = 0;

    wraps.forEach((wrap) => {
      const value = wrap.querySelector('input').value;
      const status = wrap.querySelector('.stop-status');
      status.className = 'stop-status';
      status.textContent = '';
      status.removeAttribute('role');
      status.removeAttribute('aria-label');

      if (value.trim() === '') return;
      filled += 1;

      const ok = normalize(value).startsWith(letter);
      status.classList.add(ok ? 'ok' : 'bad');
      status.textContent = ok ? '✓' : '✕';
      status.setAttribute('role', 'img');
      status.setAttribute('aria-label', ok ? 'Começa com a letra' : 'Não começa com a letra ' + letter);
    });

    els.progress.textContent = filled + ' de ' + wraps.length + ' preenchidas';
    els.stopBtn.disabled = !(phase === 'playing' && !locked && filled === wraps.length);
  }

  function setInputsDisabled(disabled) {
    inputs().forEach((input) => {
      input.disabled = disabled;
    });
  }

  function renderTime() {
    const remaining = Math.max(0, localEnd - Date.now());
    const secs = Math.ceil(remaining / 1000);
    els.seconds.textContent = secs;
    root.classList.toggle('urgent', isActive() && (phase === 'stopping' || secs <= 10));
    if (reducedMotion && isActive()) els.fill.style.transform = 'scaleX(' + remaining / duration + ')';

    if (!locked && isActive() && remaining === 0) {
      locked = true;
      setInputsDisabled(true);
      sendAnswers();
      updateFields();
      els.ended.hidden = false;
    }
  }

  function showRound(state) {
    if (state.round !== currentRound) {
      currentRound = state.round;
      buildFields(state.categories);
      if (!state.answers) els.fields.querySelector('input').focus();
    }
    if (Array.isArray(state.answers)) {
      inputs().forEach((input, i) => {
        input.value = state.answers[i] || '';
      });
    }

    setInputsDisabled(false);
    updateFields();

    if (phase === 'stopping') {
      const who = state.stoppedByName === myName() ? 'Você apertou' : state.stoppedByName + ' apertou';
      els.callout.textContent = '⛔ ' + who + ' STOP! Terminem as respostas!';
      els.callout.hidden = false;
    } else {
      els.callout.hidden = true;
    }

    const fill = els.fill;
    fill.style.transition = 'none';
    fill.style.transform = 'scaleX(' + state.remainingMs / duration + ')';
    void fill.offsetWidth;
    if (!reducedMotion) {
      fill.style.transition = 'transform ' + state.remainingMs + 'ms linear';
      fill.style.transform = 'scaleX(0)';
    }
  }

  function actionButton(label, className, type) {
    const button = el('button', 'btn ' + className, label);
    button.type = 'button';
    button.addEventListener('click', () => {
      button.disabled = true;
      socket.emit('game:action', { type }, (res) => {
        if (res && !res.ok) {
          showToast(res.error, 'error');
          button.disabled = false;
        }
      });
    });
    return button;
  }

  function rankingList(state, withGain) {
    const gains = new Map((state.results || []).map((r) => [r.id, r.roundPoints]));
    const list = el('ol', 'stop-ranking');

    state.ranking.forEach((player) => {
      const mine = player.username === myName();
      const li = el('li', 'stop-rank' + (mine ? ' me' : ''));
      li.append(
        el('span', 'stop-rank-pos', player.rank + 'º'),
        avatarFor(player),
        el('span', 'stop-rank-name', player.username + (mine ? ' (você)' : ''))
      );
      if (withGain) li.append(el('span', 'stop-rank-gain', '+' + (gains.get(player.id) || 0)));
      li.append(el('span', 'stop-rank-total', player.totalPoints + ' pts'));
      list.append(li);
    });
    return list;
  }

  function renderSetup(state) {
    const isHost = state.hostName === myName();
    const list = el('ul', 'stop-categories');

    state.categories.forEach((name, i) => {
      const li = el('li', 'stop-category' + (isHost ? '' : ' readonly'));
      li.append(el('span', '', name));
      if (isHost) {
        const remove = el('button', 'stop-category-remove', '✕');
        remove.type = 'button';
        remove.setAttribute('aria-label', 'Remover ' + name);
        remove.addEventListener('click', () => send({ type: 'category-remove', index: i }));
        li.append(remove);
      }
      list.append(li);
    });

    const children = [
      el('h2', 'stop-results-title', 'Categorias'),
      el('p', 'stop-progress', state.categories.length + ' categorias · mínimo 3, máximo 12'),
      list
    ];

    if (!isHost) {
      children.push(el('p', 'muted-left', 'Aguardando o anfitrião escolher as categorias…'));
    } else {
      const input = document.createElement('input');
      input.maxLength = 24;
      input.placeholder = 'Nova categoria (ex.: Profissão)';
      input.autocomplete = 'off';

      const add = el('button', 'btn btn-ghost', 'Adicionar');
      add.type = 'button';
      const submit = () => {
        if (!input.value.trim()) return;
        send({ type: 'category-add', name: input.value });
        input.value = '';
        input.focus();
      };
      add.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submit();
      });

      const row = el('div', 'field stop-add-row');
      row.append(input, add);
      children.push(row, actionButton('Começar jogo', 'btn-primary', 'begin'));
    }
    els.results.replaceChildren(...children);
  }

  function renderVoting(state) {
  const groups = new Map();
  state.candidates.forEach((c) => {
    if (!groups.has(c.id)) groups.set(c.id, { user: c, items: [] });
    groups.get(c.id).items.push(c);
  });

  const cards = [...groups.values()]
    .sort((a, b) => (a.user.username === myName()) - (b.user.username === myName()))
    .map(({ user, items }, n) => {
      const mine = user.username === myName();
      const card = el('div', 'stop-result-card' + (mine ? ' mine' : ''));
      card.style.animationDelay = n * 80 + 'ms';

      const head = el('div', 'stop-result-head');
      head.append(avatarFor(user), el('span', 'stop-result-name', user.username + (mine ? ' (você)' : '')));
      card.append(head);

      items.forEach((c) => {
        const key = c.id + ':' + c.index;
        const line = el('div', 'stop-vote-line');
        const info = el('div', 'stop-vote-info');
        info.append(el('span', 'stop-line-cat', c.category), el('span', 'stop-vote-text', c.text));
        line.append(info);

        if (!mine) {
          const btn = el('button', 'stop-contest');
          btn.type = 'button';
          const paint = (on) => {
            btn.classList.toggle('on', on);
            btn.setAttribute('aria-pressed', on);
            btn.textContent = on ? '✕ Contestada' : 'Contestar';
          };
          paint(myContests.has(key));
          btn.addEventListener('click', () => {
            socket.emit('game:action', { type: 'contest', playerId: c.id, index: c.index }, (res) => {
              if (!res || !res.ok) return showToast(res ? res.error : 'Erro de conexão.', 'error');
              if (res.contested) myContests.add(key);
              else myContests.delete(key);
              paint(res.contested);
            });
          });
          line.append(btn);
        }
        card.append(line);
      });

      if (mine) card.append(el('p', 'muted-left', 'Só os outros jogadores podem contestar suas respostas.'));
      return card;
    });

  const grid = el('div', 'stop-result-grid');
  grid.append(...cards);

  const children = [
    el('h2', 'stop-results-title', 'Conferência · letra ' + state.letter),
    el('p', 'stop-progress', 'Contestem as palavras que não existem. Vale se mais da metade contestar.'),
    grid
  ];
  if (state.hostName === myName()) children.push(actionButton('Encerrar votação', 'btn-ghost', 'skip-vote'));
  els.results.replaceChildren(...children);
}

  function renderResults(state) {
    const isLast = state.round >= state.totalRounds;
    const children = [
      el('h2', 'stop-results-title', 'Resultado da rodada ' + state.round + ' · letra ' + state.letter),
      rankingList(state, true)
    ];

    const grid = el('div', 'stop-result-grid');
    state.results.forEach((result, i) => {
      const mine = result.username === myName();
      const card = el('div', 'stop-result-card');
      card.style.animationDelay = i * 80 + 'ms';

      const head = el('div', 'stop-result-head');
      head.append(
        avatarFor(result),
        el('span', 'stop-result-name', result.username + (mine ? ' (você)' : '')),
        el('span', 'stop-result-total', '+' + result.roundPoints + ' pts')
      );
      card.append(head);

      result.items.forEach((item, idx) => {
        const line = el('div', 'stop-line ' + item.status);
        line.append(
          el('span', 'stop-line-cat', state.categories[idx]),
          el('span', 'stop-line-answer', item.text || '—'),
          el('span', 'stop-line-points', (item.points > 0 ? '+' : '') + item.points + STATUS_TEXT[item.status])
        );
        card.append(line);
      });
      grid.append(card);
    });
    children.push(grid);

    if (state.hostName === myName()) {
      children.push(actionButton(isLast ? 'Ver resultado final agora' : 'Próxima rodada agora', 'btn-ghost', 'next'));
    }
    els.results.replaceChildren(...children);
  }

  function renderFinal(state) {
    const winners = state.ranking.filter((p) => p.rank === 1);
    const headline = winners.length === 1
      ? '🏆 ' + winners[0].username + ' venceu!'
      : '🏆 Empate entre ' + winners.map((w) => w.username).join(' e ') + '!';

    const children = [
      el('h2', 'stop-results-title', 'Fim de jogo'),
      el('p', 'stop-winner', headline),
      rankingList(state, false)
    ];

    children.push(
      state.hostName === myName()
        ? actionButton('Jogar de novo', 'btn-primary', 'restart')
        : el('p', 'muted-left', 'Aguardando o anfitrião: jogar de novo ou encerrar a partida.')
    );
    els.results.replaceChildren(...children);
  }

  function onState(state) {
    if (!root) return;

    letter = state.letter;
    phase = state.phase;
    duration = state.durationMs;
    localEnd = Date.now() + state.remainingMs;
    locked = false;

    if (phase === 'voting') {
      if (state.myContests) myContests = new Set(state.myContests);
    } else {
      myContests = new Set();
    }

    const active = isActive();
    els.top.hidden = phase === 'final' || phase === 'setup';
    els.bar.hidden = !active;
    els.play.hidden = !active;
    els.results.hidden = active;
    els.ended.hidden = true;

    els.round.textContent = state.round + ' de ' + state.totalRounds;
    els.letter.textContent = state.letter;
    els.caption.textContent = active
      ? 'tempo'
      : phase === 'voting'
        ? 'votação'
        : state.round >= state.totalRounds
          ? 'resultado final'
          : 'próxima rodada';

    if (active) {
      showRound(state);
    } else {
      els.callout.hidden = true;
      if (phase === 'setup') renderSetup(state);
      else if (phase === 'voting') renderVoting(state);
      else if (phase === 'results') renderResults(state);
      else renderFinal(state);
    }

    clearInterval(tick);
    renderTime();
    if (isTimed()) tick = setInterval(renderTime, 250);
  }

  function mount(stage, sock) {
    socket = sock;
    build(stage);
    socket.on('stop:state', onState);
  }

  function unmount() {
    if (socket) socket.off('stop:state', onState);
    clearInterval(tick);
    clearTimeout(sendTimer);
    root = null;
    currentRound = 0;
    phase = 'idle';
    myContests = new Set();
  }

  window.gameUIs = window.gameUIs || {};
  window.gameUIs.stop = { mount, unmount };
})();