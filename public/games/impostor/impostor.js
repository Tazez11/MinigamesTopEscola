(function () {
  const ICONS = {
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>'
  };

  function icon(name) {
    return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + ICONS[name] + '</svg>';
  }

  const MODES = [
    ['classic', 'Clássico', 'O impostor vê só a categoria e precisa blefar.'],
    ['different', 'Palavra diferente', 'O impostor recebe uma palavra parecida e nem sabe que é o impostor.']
  ];

  const TIMED = ['role', 'clues', 'discussion', 'voting', 'reveal'];

  let socket = null;
  let root = null;
  let els = {};
  let phase = 'idle';
  let localEnd = 0;
  let duration = 1;
  let tick = null;
  let shownRound = 0;
  let seenClues = new Set();

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

  function send(action) {
    socket.emit('game:action', action, (res) => {
      if (res && !res.ok) showToast(res.error, 'error');
    });
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

  /* ---------- Montagem ---------- */

  function build(stage) {
    root = el('div', 'imp');
    root.innerHTML = `
      <div class="imp-top">
        <div>
          <span class="muted-left">Rodada</span>
          <strong class="imp-round"></strong>
        </div>
        <div class="imp-time"><span class="imp-seconds"></span>s</div>
      </div>
      <div class="imp-bar"><div class="imp-bar-fill"></div></div>
      <div class="imp-body"></div>
    `;
    stage.append(root);

    els = {
      top: root.querySelector('.imp-top'),
      round: root.querySelector('.imp-round'),
      seconds: root.querySelector('.imp-seconds'),
      bar: root.querySelector('.imp-bar'),
      fill: root.querySelector('.imp-bar-fill'),
      body: root.querySelector('.imp-body')
    };
  }

  function renderTime() {
    const remaining = Math.max(0, localEnd - Date.now());
    const secs = Math.ceil(remaining / 1000);
    els.seconds.textContent = secs;
    els.fill.style.transform = 'scaleX(' + remaining / duration + ')';
    root.classList.toggle('urgent', (phase === 'clues' || phase === 'voting') && secs <= 5);
  }

  /* ---------- Peças de tela ---------- */

  // Lembrete do seu papel, sempre visível durante a rodada.
  function reminder(state) {
    const box = el('div', 'imp-reminder ' + (state.you.role === 'impostor' ? 'impostor' : 'crew'));
    if (state.you.role === 'impostor') {
      box.append(
        el('span', 'imp-reminder-label', 'Você é o IMPOSTOR · categoria: ' + state.category),
        el('span', 'imp-reminder-hint', 'Descubra a palavra pelas dicas e disfarce.')
      );
    } else {
      box.append(
        el('span', 'imp-reminder-label', 'Sua palavra · ' + state.category),
        el('strong', 'imp-reminder-word', state.you.word)
      );
    }
    return box;
  }

  // Um cartão por jogador, com as dicas de cada volta.
  // opts.pick: função chamada ao clicar num jogador (votação)
  // opts.myVote: id em quem eu votei · opts.voted: ids de quem já votou
  function wall(state, opts = {}) {
    const grid = el('div', 'imp-wall');

    state.players.forEach((p) => {
      const active = state.turn && state.turn.id === p.id;
      const isMe = p.username === myName();
      const votable = Boolean(opts.pick) && !isMe;

      const card = el(
        'div',
        'imp-card' +
          (active ? ' active' : '') +
          (isMe ? ' me' : '') +
          (votable ? ' votable' : '') +
          (opts.myVote === p.id ? ' voted' : '')
      );

      if (votable) {
        card.tabIndex = 0;
        card.setAttribute('role', 'button');
        card.setAttribute('aria-label', 'Votar em ' + p.username);
        card.addEventListener('click', () => opts.pick(p.id));
        card.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            opts.pick(p.id);
          }
        });
      }

      const head = el('div', 'imp-card-head');
      head.append(avatarFor(p), el('span', 'imp-card-name', p.username + (isMe ? ' (você)' : '')));
      if (opts.voted && opts.voted.includes(p.id)) head.append(el('span', 'imp-badge', '✓ votou'));
      card.append(head);

      for (let lap = 1; lap <= state.laps; lap++) {
        const clue = state.clues.find((c) => c.playerId === p.id && c.lap === lap);
        const key = p.id + ':' + lap;
        const waiting = active && state.turn.lap === lap;

        const line = el('div', 'imp-clue' + (clue ? ' filled' : '') + (waiting ? ' writing' : ''));
        if (clue && !seenClues.has(key)) line.classList.add('new');
        if (clue) seenClues.add(key);

        line.append(
          el('span', 'imp-clue-lap', lap + 'ª'),
          el('span', 'imp-clue-text', clue ? clue.text : waiting ? 'escrevendo…' : '…')
        );
        card.append(line);
      }
      grid.append(card);
    });
    return grid;
  }

  function scoreList(scoreboard) {
    const list = el('ol', 'imp-score');
    scoreboard.forEach((p) => {
      const mine = p.username === myName();
      const li = el('li', 'imp-rank' + (mine ? ' me' : ''));
      li.append(
        el('span', 'imp-rank-pos', p.rank + 'º'),
        avatarFor(p),
        el('span', 'imp-rank-name', p.username + (mine ? ' (você)' : '')),
        el('span', 'imp-rank-total', p.total + ' pts')
      );
      list.append(li);
    });
    return list;
  }

  /* ---------- Telas ---------- */

  function renderSetup(state) {
    const isHost = state.hostName === myName();
    const { mode, categories } = state.settings;

    const modes = el('div', 'imp-modes');
    MODES.forEach(([id, title, description]) => {
      const button = el('button', 'imp-mode');
      button.type = 'button';
      button.disabled = !isHost;
      button.setAttribute('aria-pressed', mode === id);
      button.append(el('strong', '', (mode === id ? '✓ ' : '') + title), el('span', '', description));
      button.addEventListener('click', () => send({ type: 'set-mode', mode: id }));
      modes.append(button);
    });

    const chips = el('div', 'imp-cats');
    categories.forEach((c) => {
      const chip = el('button', 'imp-chip', (c.selected ? '✓ ' : '') + c.name + ' · ' + c.count);
      chip.type = 'button';
      chip.disabled = !isHost;
      chip.setAttribute('aria-pressed', c.selected);
      chip.addEventListener('click', () => send({ type: 'toggle-category', id: c.id }));
      chips.append(chip);
    });

    els.body.replaceChildren(
      el('h2', 'imp-heading', 'Modo de jogo'),
      modes,
      el('h2', 'imp-heading', 'Categorias de palavras'),
      el('p', 'imp-note', 'De onde saem as palavras secretas. Deixe pelo menos uma marcada.'),
      chips,
      isHost
        ? actionButton('Começar jogo', 'btn-primary', { type: 'begin' })
        : el('p', 'imp-note', 'Aguardando o anfitrião configurar o jogo…')
    );
  }

  function renderRole(state) {
    const impostor = state.you.role === 'impostor';
    const card = el('div', 'imp-role ' + (impostor ? 'impostor' : 'crew'));

    if (impostor) {
      card.append(
        el('span', 'imp-role-label', 'Seu papel'),
        el('h2', 'imp-role-title', 'Você é o impostor'),
        el('p', 'imp-role-text', 'Categoria: ' + state.category),
        el('p', 'imp-role-text', 'Você não sabe a palavra. Ouça as dicas dos outros e disfarce.')
      );
    } else {
      card.append(
        el('span', 'imp-role-label', 'Sua palavra · ' + state.category),
        el('h2', 'imp-role-word', state.you.word),
        el('p', 'imp-role-text', 'Alguém aqui NÃO sabe a palavra. Dê dicas sem entregar demais.')
      );
    }
    els.body.replaceChildren(card, el('p', 'imp-note', 'Guarde isso em segredo. A rodada de dicas já vai começar.'));
  }

  function renderClues(state) {
    const children = [reminder(state)];
    const mine = state.turn && state.turn.username === myName();

   if (mine) {
  const panel = el('div', 'imp-turn');
  const form = el('form', 'imp-clue-form');

  const field = el('div', 'imp-clue-field');
  const input = el('input', 'imp-clue-input');
  input.maxLength = 20;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = 'Digite uma palavra…';
  input.setAttribute('aria-label', 'Sua dica');
  const count = el('span', 'imp-clue-count', '0/20');
  input.addEventListener('input', () => {
    count.textContent = input.value.length + '/20';
  });
  field.append(input, count);

  const button = el('button', 'imp-send');
  button.type = 'submit';
  button.innerHTML = icon('send') + '<span>Enviar</span>';
  button.setAttribute('aria-label', 'Enviar dica');

  form.append(field, button);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    button.disabled = true;
    socket.emit('game:action', { type: 'clue', text }, (res) => {
      button.disabled = false;
      if (res && !res.ok) {
        showToast(res.error, 'error');
        form.classList.remove('shake');
        void form.offsetWidth;
        form.classList.add('shake');
      }
    });
  });

  panel.append(
    el('h2', 'imp-turn-title', 'É a sua vez! 🎯'),
    el('p', 'imp-turn-hint', 'Volta ' + state.turn.lap + ' · uma palavra só, sem dizer a palavra secreta.'),
    form
  );
  children.push(panel);
  setTimeout(() => input.focus(), 0);
}

    children.push(wall(state));
    els.body.replaceChildren(...children);
  }

  function renderDiscussion(state) {
    els.body.replaceChildren(
      reminder(state),
      el('h2', 'imp-heading', 'Discussão: quem parece o impostor?'),
      wall(state),
      el('p', 'imp-note', 'Converse com o grupo e decidam em quem votar. A votação começa em instantes.')
    );
  }

  function renderVoting(state) {
    const pick = (id) => send({ type: 'vote', target: id });
    const voted = state.voted || [];

    els.body.replaceChildren(
      reminder(state),
      el(
        'h2',
        'imp-heading',
        state.myVote ? 'Voto registrado. Pode mudar até o tempo acabar.' : 'Quem é o impostor? Clique em um jogador.'
      ),
      wall(state, { pick, myVote: state.myVote, voted }),
      el('p', 'imp-note', voted.length + ' de ' + state.players.length + ' votaram')
    );
  }

  function renderReveal(state) {
    const r = state.reveal;
    const nameOf = (id) => {
      const p = state.players.find((x) => x.id === id);
      return p ? p.username : '?';
    };

    const box = el('div', 'imp-reveal ' + (r.caught ? 'caught' : 'escaped'));
    box.append(
      el('span', 'imp-role-label', 'O impostor era'),
      el('h2', 'imp-role-title', nameOf(r.impostorId)),
      el('p', 'imp-role-text', r.caught ? 'Foi pego! 🎉' : 'Escapou! 😈'),
      el('p', 'imp-role-text', 'Palavra: ' + r.word + (r.decoy ? ' · o impostor recebeu: ' + r.decoy : ''))
    );

    const list = el('ul', 'imp-tally');
    r.votes.forEach((v) => list.append(el('li', '', nameOf(v.voterId) + ' votou em ' + nameOf(v.targetId))));
    if (!r.votes.length) list.append(el('li', '', 'Ninguém votou.'));

    els.body.replaceChildren(
      box,
      list,
      el('p', 'imp-note', r.gained.map((g) => nameOf(g.id) + ' +' + g.points).join(' · ') || 'Ninguém pontuou.')
    );
  }

  function renderFinal(state) {
    const isHost = state.hostName === myName();
    const best = state.scoreboard.length ? state.scoreboard[0].total : 0;
    const children = [el('h2', 'imp-heading', 'Fim de jogo')];

    if (state.notice) children.push(el('p', 'imp-note', state.notice));
    if (best > 0) {
      const winners = state.scoreboard.filter((p) => p.rank === 1);
      children.push(
        el(
          'p',
          'imp-winner',
          winners.length === 1
            ? '🏆 ' + winners[0].username + ' venceu!'
            : '🏆 Empate entre ' + winners.map((w) => w.username).join(' e ') + '!'
        )
      );
    }
    children.push(
      scoreList(state.scoreboard),
      isHost
        ? actionButton('Jogar de novo', 'btn-primary', { type: 'restart' })
        : el('p', 'imp-note', 'Aguardando o anfitrião: jogar de novo ou encerrar a partida.')
    );
    els.body.replaceChildren(...children);
  }

  /* ---------- Eventos do servidor ---------- */

  function onState(state) {
    if (!root) return;

    phase = state.phase;
    duration = state.durationMs || 1;
    localEnd = Date.now() + state.remainingMs;

    const timed = TIMED.includes(phase);
    els.top.hidden = !timed;
    els.bar.hidden = !timed;
    els.round.textContent = state.round + ' de ' + state.totalRounds;

    if (phase === 'role' && state.round !== shownRound) {
      shownRound = state.round;
      seenClues = new Set();
    }
    if (!timed) shownRound = 0;

    if (phase === 'setup') renderSetup(state);
    else if (phase === 'role') renderRole(state);
    else if (phase === 'clues') renderClues(state);
    else if (phase === 'discussion') renderDiscussion(state);
    else if (phase === 'voting') renderVoting(state);
    else if (phase === 'reveal') renderReveal(state);
    else if (phase === 'final') renderFinal(state);

    clearInterval(tick);
    renderTime();
    if (timed) tick = setInterval(renderTime, 250);
  }

  function mount(stage, sock) {
    socket = sock;
    build(stage);
    socket.on('impostor:state', onState);
  }

  function unmount() {
    if (socket) socket.off('impostor:state', onState);
    clearInterval(tick);
    root = null;
    phase = 'idle';
    shownRound = 0;
    seenClues = new Set();
  }

  window.gameUIs = window.gameUIs || {};
  window.gameUIs.impostor = { mount, unmount };
})();