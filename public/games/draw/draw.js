(function () {
  // Ícones (traçado simples, herdam a cor do texto). Só os "caminhos" do SVG.
  const ICONS = {
    pen: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
    eraser:
      '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21"/><path d="M22 21H7"/><path d="m5 11 9 9"/>',
    ruler:
      '<path d="M21.3 15.3a2.4 2.4 0 0 1 0 3.4l-2.6 2.6a2.4 2.4 0 0 1-3.4 0L2.7 8.7a2.41 2.41 0 0 1 0-3.4l2.6-2.6a2.41 2.41 0 0 1 3.4 0Z"/><path d="m14.5 12.5 2-2"/><path d="m11.5 9.5 2-2"/><path d="m8.5 6.5 2-2"/><path d="m17.5 15.5 2-2"/>',
    circle: '<circle cx="12" cy="12" r="9"/>',
    trash:
      '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M10 11v6"/><path d="M14 11v6"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    check: '<path d="M20 6 9 17l-5-5"/>'
  };

  function icon(name) {
    return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + ICONS[name] + '</svg>';
  }

  // Atalhos de cor (além do seletor livre "Mais cores").
  const COLORS = [
    ['#111111', 'Preto'],
    ['#8A8A8A', 'Cinza'],
    ['#E53935', 'Vermelho'],
    ['#FB8C00', 'Laranja'],
    ['#FDD835', 'Amarelo'],
    ['#43A047', 'Verde'],
    ['#29B6F6', 'Azul'],
    ['#8E24AA', 'Roxo'],
    ['#EC407A', 'Rosa'],
    ['#6D4C41', 'Marrom']
  ];

  // O quadro tem resolução fixa; as coordenadas enviadas ao servidor são proporções (0 a 1).
  const BOARD_W = 1000;
  const BOARD_H = 750;
  const LOGICAL_W = 800;
  const SEND_EVERY_MS = 70;
  const MAX_MESSAGES = 60;

  let socket = null;
  let root = null;
  let els = {};
  let phase = 'idle';
  let localEnd = 0;
  let duration = 1;
  let tick = null;
  let guessAllowed = false;

  let ctx = null;
  let previewCtx = null;
  let canDraw = false;
  let tool = 'pen';
  let color = COLORS[0][0];
  let thickness = 12;
  let current = null;
  let shapeDrag = null;
  let sendTimer = null;
  const lastPoints = new Map();

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

  /* ---------- Quadro (canvas) ---------- */

  function clearCanvas() {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, BOARD_W, BOARD_H);
    lastPoints.clear();
  }

  function clearPreview() {
    previewCtx.clearRect(0, 0, BOARD_W, BOARD_H);
  }

  // Desenha pontos de um traço livre, ligando cada ponto ao anterior do mesmo traço.
  function paint(id, strokeColor, size, points) {
    const px = (size * BOARD_W) / LOGICAL_W;
    ctx.strokeStyle = strokeColor;
    ctx.fillStyle = strokeColor;
    ctx.lineWidth = px;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    let prev = lastPoints.get(id);
    for (const p of points) {
      const x = p[0] * BOARD_W;
      const y = p[1] * BOARD_H;
      ctx.beginPath();
      if (prev) {
        ctx.moveTo(prev[0], prev[1]);
        ctx.lineTo(x, y);
        ctx.stroke();
      } else {
        ctx.arc(x, y, px / 2, 0, Math.PI * 2);
        ctx.fill();
      }
      prev = [x, y];
    }
    lastPoints.set(id, prev);
  }

  // Desenha uma reta ou um círculo (no quadro principal ou na prévia).
  function paintShape(g, s) {
    g.strokeStyle = s.color;
    g.lineWidth = (s.size * BOARD_W) / LOGICAL_W;
    g.lineCap = 'round';
    g.beginPath();
    if (s.kind === 'line') {
      g.moveTo(s.a[0] * BOARD_W, s.a[1] * BOARD_H);
      g.lineTo(s.b[0] * BOARD_W, s.b[1] * BOARD_H);
    } else {
      g.arc(s.c[0] * BOARD_W, s.c[1] * BOARD_H, s.r * BOARD_W, 0, Math.PI * 2);
    }
    g.stroke();
  }

  function toPoint(e) {
    const rect = els.canvas.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    return [x, y];
  }

  function round4(n) {
    return +n.toFixed(4);
  }

  /* Traço livre (lápis e borracha) */

  function flush() {
    clearTimeout(sendTimer);
    sendTimer = null;
    if (!current) return;
    while (current.pending.length > 0) {
      socket.emit('game:action', {
        type: 'stroke',
        id: current.id,
        color: current.color,
        size: current.size,
        points: current.pending.splice(0, 200)
      });
    }
  }

  function addPoint(p) {
    if (current.last && Math.hypot(p[0] - current.last[0], p[1] - current.last[1]) < 0.002) return;
    current.last = p;
    paint(current.id, current.color, current.size, [p]);
    current.pending.push([round4(p[0]), round4(p[1])]);
    if (!sendTimer) sendTimer = setTimeout(flush, SEND_EVERY_MS);
  }

  function endStroke() {
    if (!current) return;
    flush();
    current = null;
  }

  /* Formas (reta e círculo): aparecem como prévia enquanto você arrasta */

  function buildShape(drag) {
    if (drag.kind === 'line') {
      return { kind: 'line', color, size: thickness, a: drag.start, b: drag.end };
    }
    const dx = (drag.end[0] - drag.start[0]) * BOARD_W;
    const dy = (drag.end[1] - drag.start[1]) * BOARD_H;
    return { kind: 'circle', color, size: thickness, c: drag.start, r: Math.hypot(dx, dy) / BOARD_W };
  }

  function drawPreview() {
    clearPreview();
    paintShape(previewCtx, buildShape(shapeDrag));
  }

  function commitShape() {
    const shape = buildShape(shapeDrag);
    shapeDrag = null;
    clearPreview();

    const tooSmall =
      shape.kind === 'line'
        ? Math.hypot((shape.b[0] - shape.a[0]) * BOARD_W, (shape.b[1] - shape.a[1]) * BOARD_H) < 3
        : shape.r * BOARD_W < 2;
    if (tooSmall) return;

    shape.id = Date.now();
    paintShape(ctx, shape);

    const action = { type: 'shape', shape: shape.kind, id: shape.id, color: shape.color, size: shape.size };
    if (shape.kind === 'line') {
      action.a = shape.a.map(round4);
      action.b = shape.b.map(round4);
    } else {
      action.c = shape.c.map(round4);
      action.r = round4(shape.r);
    }
    socket.emit('game:action', action);
  }

  function cancelShape() {
    shapeDrag = null;
    clearPreview();
  }

  function attachDrawing() {
    const canvas = els.canvas;

    canvas.addEventListener('pointerdown', (e) => {
      if (!canDraw) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      const p = toPoint(e);

      if (tool === 'line' || tool === 'circle') {
        shapeDrag = { kind: tool, start: p, end: p };
        drawPreview();
        return;
      }

      current = {
        id: Date.now(),
        color: tool === 'eraser' ? '#FFFFFF' : color,
        size: thickness,
        pending: [],
        last: null
      };
      addPoint(p);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (shapeDrag) {
        shapeDrag.end = toPoint(e);
        drawPreview();
      } else if (current) {
        addPoint(toPoint(e));
      }
    });

    canvas.addEventListener('pointerup', () => {
      if (shapeDrag) commitShape();
      else endStroke();
    });

    canvas.addEventListener('pointercancel', () => {
      cancelShape();
      endStroke();
    });
  }

  /* ---------- Ferramentas ---------- */

  function refreshTools() {
    els.colors.querySelectorAll('.draw-color').forEach((b) => {
      b.setAttribute('aria-pressed', tool !== 'eraser' && b.dataset.color === color);
    });
    els.picker.value = color.toLowerCase();
    els.toolButtons.forEach((b) => b.setAttribute('aria-pressed', b.dataset.tool === tool));

    els.thickLabel.textContent = thickness + ' px';
    els.thickRange.value = thickness;
    els.thickDot.style.width = els.thickDot.style.height = Math.max(3, Math.round(thickness * 0.38)) + 'px';
  }

  function setColor(hex) {
    color = hex.toUpperCase();
    if (tool === 'eraser') tool = 'pen';
    refreshTools();
  }

  function buildTools() {
    COLORS.forEach(([hex, name]) => {
      const button = el('button', 'draw-color');
      button.type = 'button';
      button.style.setProperty('--swatch', hex);
      button.dataset.color = hex;
      button.title = name;
      button.setAttribute('aria-label', name);
      button.addEventListener('click', () => setColor(hex));
      els.colors.insertBefore(button, els.pickerWrap);
    });

    els.picker.addEventListener('input', () => setColor(els.picker.value));

    els.toolButtons.forEach((b) => {
      b.addEventListener('click', () => {
        tool = b.dataset.tool;
        refreshTools();
      });
    });

    els.thickRange.addEventListener('input', () => {
      thickness = Number(els.thickRange.value);
      refreshTools();
    });

    els.clearBtn.addEventListener('click', () => {
      clearCanvas();
      send({ type: 'clear' });
    });

    refreshTools();
  }

  /* ---------- Chat de palpites ---------- */

  function addMessage(message) {
    const list = els.messages;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;

    const li = el('li', 'draw-msg ' + message.kind);
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
    const node = el('span', 'draw-badge');
    node.innerHTML = icon(iconName);
    node.append(el('span', '', label));
    return node;
  }

  function scoreList(scoreboard) {
    const list = el('ol', 'draw-score');

    scoreboard.forEach((p) => {
      const mine = p.username === myName();
      const li = el('li', 'draw-rank' + (mine ? ' me' : ''));
      li.append(
        el('span', 'draw-rank-pos', p.rank + 'º'),
        avatarFor(p),
        el('span', 'draw-rank-name', p.username + (mine ? ' (você)' : ''))
      );

      if (p.isDrawer) li.append(badge('pen', 'Desenhando'));
      else if (p.guessed) li.append(badge('check', 'Acertou'));

      if (p.gain > 0) li.append(el('span', 'draw-rank-gain', '+' + p.gain));
      li.append(el('span', 'draw-rank-total', p.total + ' pts'));
      list.append(li);
    });
    return list;
  }

  /* ---------- Montagem ---------- */

  function build(stage) {
    root = el('div', 'draw');
    root.innerHTML = `
      <div class="draw-top">
        <div>
          <span class="muted-left">Rodada</span>
          <strong class="draw-round"></strong>
        </div>
        <div class="draw-time"><span class="draw-seconds"></span>s</div>
      </div>
      <div class="draw-bar"><div class="draw-bar-fill"></div></div>
      <div class="draw-body"></div>
      <div class="draw-play">
        <div class="draw-board-wrap" hidden>
          <div class="draw-tools" hidden>
            <div class="draw-colors" role="group" aria-label="Cores">
              <label class="draw-picker-wrap">
                <input type="color" class="draw-picker" value="#111111" aria-label="Escolher outra cor">
                <span>Mais cores</span>
              </label>
            </div>
            <div class="draw-tool-row" role="group" aria-label="Ferramentas">
              <button type="button" class="draw-tool" data-tool="pen" aria-label="Lápis" title="Lápis">${icon('pen')}<span class="draw-tool-label">Lápis</span></button>
              <button type="button" class="draw-tool" data-tool="eraser" aria-label="Borracha" title="Borracha">${icon('eraser')}<span class="draw-tool-label">Borracha</span></button>
              <button type="button" class="draw-tool" data-tool="line" aria-label="Reta" title="Reta">${icon('ruler')}<span class="draw-tool-label">Reta</span></button>
              <button type="button" class="draw-tool" data-tool="circle" aria-label="Círculo" title="Círculo">${icon('circle')}<span class="draw-tool-label">Círculo</span></button>
              <button type="button" class="draw-tool draw-clear" aria-label="Limpar quadro" title="Limpar quadro">${icon('trash')}<span class="draw-tool-label">Limpar</span></button>
            </div>
            <div class="draw-thickness">
              <span class="draw-thick-box"><i class="draw-thick-dot"></i></span>
              <input type="range" class="draw-range" min="1" max="100" step="1" value="12" aria-label="Espessura da linha">
              <output class="draw-thick-label"></output>
            </div>
          </div>
          <div class="draw-canvas-wrap">
            <canvas class="draw-canvas" width="${BOARD_W}" height="${BOARD_H}" aria-label="Quadro de desenho"></canvas>
            <canvas class="draw-preview" width="${BOARD_W}" height="${BOARD_H}" aria-hidden="true"></canvas>
          </div>
        </div>
        <aside class="draw-side" hidden>
          <div class="draw-score-box"></div>
          <section class="draw-chat" aria-label="Palpites" hidden>
            <ol class="draw-messages" role="log" aria-live="polite"></ol>
            <form class="draw-guess-form">
              <input class="draw-guess" maxlength="40" autocomplete="off" spellcheck="false" aria-label="Seu palpite">
              <button type="submit" class="draw-send" aria-label="Enviar palpite" title="Enviar palpite">${icon('send')}</button>
            </form>
          </section>
        </aside>
      </div>
    `;
    stage.append(root);

    els = {
      top: root.querySelector('.draw-top'),
      round: root.querySelector('.draw-round'),
      seconds: root.querySelector('.draw-seconds'),
      bar: root.querySelector('.draw-bar'),
      fill: root.querySelector('.draw-bar-fill'),
      body: root.querySelector('.draw-body'),
      play: root.querySelector('.draw-play'),
      boardWrap: root.querySelector('.draw-board-wrap'),
      tools: root.querySelector('.draw-tools'),
      colors: root.querySelector('.draw-colors'),
      pickerWrap: root.querySelector('.draw-picker-wrap'),
      picker: root.querySelector('.draw-picker'),
      toolButtons: [...root.querySelectorAll('[data-tool]')],
      clearBtn: root.querySelector('.draw-clear'),
      thickDot: root.querySelector('.draw-thick-dot'),
      thickRange: root.querySelector('.draw-range'),
      thickLabel: root.querySelector('.draw-thick-label'),
      canvas: root.querySelector('.draw-canvas'),
      side: root.querySelector('.draw-side'),
      score: root.querySelector('.draw-score-box'),
      chat: root.querySelector('.draw-chat'),
      messages: root.querySelector('.draw-messages'),
      guessForm: root.querySelector('.draw-guess-form'),
      guess: root.querySelector('.draw-guess'),
      sendBtn: root.querySelector('.draw-send')
    };

    ctx = els.canvas.getContext('2d');
    previewCtx = root.querySelector('.draw-preview').getContext('2d');
    clearCanvas();
    buildTools();
    buildChat();
    attachDrawing();
  }

  function renderTime() {
    const remaining = Math.max(0, localEnd - Date.now());
    const secs = Math.ceil(remaining / 1000);
    els.seconds.textContent = secs;
    els.fill.style.transform = 'scaleX(' + remaining / duration + ')';
    root.classList.toggle('urgent', phase === 'drawing' && secs <= 10);
  }

  /* ---------- Telas de texto ---------- */

  function renderSetup(state) {
    const isHost = state.hostName === myName();
    const chips = el('div', 'draw-cats');

    state.categories.forEach((c) => {
      const chip = el('button', 'draw-chip', (c.selected ? '✓ ' : '') + c.name + ' · ' + c.count);
      chip.type = 'button';
      chip.disabled = !isHost;
      chip.setAttribute('aria-pressed', c.selected);
      chip.addEventListener('click', () => send({ type: 'toggle-category', id: c.id }));
      chips.append(chip);
    });

    els.body.replaceChildren(
      el('h2', 'draw-heading', 'Categorias de palavras'),
      el('p', 'draw-note', 'De onde saem as palavras para desenhar. Deixe pelo menos uma marcada.'),
      chips,
      isHost
        ? actionButton('Começar jogo', 'btn-primary', { type: 'begin' })
        : el('p', 'draw-note', 'Aguardando o anfitrião escolher as categorias…')
    );
  }

  function renderChoosing(state) {
    if (!state.isDrawer) {
      els.body.replaceChildren(
        el('h2', 'draw-heading', state.drawerName + ' está escolhendo a palavra…'),
        el('p', 'draw-note', 'Preparem-se: ele vai desenhar e vocês tentam adivinhar.')
      );
      return;
    }

    const options = el('div', 'draw-options');
    state.options.forEach((option, index) => {
      const button = el('button', 'draw-option');
      button.type = 'button';
      button.append(el('strong', '', option.text), el('span', 'draw-option-cat', option.category));
      button.addEventListener('click', () => {
        options.querySelectorAll('button').forEach((b) => {
          b.disabled = true;
        });
        send({ type: 'choose', index });
      });
      options.append(button);
    });

    els.body.replaceChildren(
      el('h2', 'draw-heading', 'Sua vez de desenhar! Escolha uma palavra'),
      options,
      el('p', 'draw-note', 'Se o tempo acabar, a primeira palavra é escolhida por você.')
    );
  }

  function renderDrawing(state) {
    if (state.isDrawer) {
      els.body.replaceChildren(
        el('p', 'draw-note', 'Você está desenhando · ' + state.category),
        el('div', 'draw-word', state.word)
      );
    } else {
      els.body.replaceChildren(
        el('p', 'draw-note', state.drawerName + ' está desenhando · ' + state.category),
        el('div', 'draw-pattern', state.pattern)
      );
    }
  }

  function renderReveal(state) {
    els.body.replaceChildren(
      el('p', 'draw-note', 'A palavra era'),
      el('div', 'draw-word', state.word)
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
      el('h2', 'draw-heading', 'Fim de jogo'),
      el('p', 'draw-winner', headline),
      scoreList(state.scoreboard),
      isHost
        ? actionButton('Jogar de novo', 'btn-primary', { type: 'restart' })
        : el('p', 'draw-note', 'Aguardando o anfitrião: jogar de novo ou encerrar a partida.')
    );
  }

  /* ---------- Eventos do servidor ---------- */

  function onState(state) {
    if (!root) return;

    phase = state.phase;
    duration = state.durationMs || 1;
    localEnd = Date.now() + state.remainingMs;

    const timed = phase === 'choosing' || phase === 'drawing' || phase === 'reveal';
    const showBoard = phase === 'drawing' || phase === 'reveal';
    const showChat = showBoard;

    canDraw = state.isDrawer && phase === 'drawing';
    if (!canDraw) {
      clearTimeout(sendTimer);
      sendTimer = null;
      current = null;
      cancelShape();
    }
    if (!showBoard) clearCanvas();
    if (phase === 'setup' || phase === 'choosing') els.messages.replaceChildren();

    els.top.hidden = !timed;
    els.bar.hidden = !timed;
    els.boardWrap.hidden = !showBoard;
    els.tools.hidden = !canDraw;
    els.canvas.classList.toggle('can-draw', canDraw);
    els.play.classList.toggle('has-board', showBoard);
    els.side.hidden = !timed;
    els.chat.hidden = !showChat;
    els.round.textContent = state.round + ' de ' + state.totalRounds;

    if (timed) els.score.replaceChildren(scoreList(state.scoreboard));

    if (phase === 'drawing') {
      if (state.isDrawer) setGuessEnabled(false, 'Você está desenhando');
      else if (state.youGuessed) setGuessEnabled(false, 'Você acertou! Aguarde os outros');
      else setGuessEnabled(true, 'Digite seu palpite…');
    } else {
      setGuessEnabled(false, 'Aguarde a próxima rodada');
    }

    if (phase === 'setup') renderSetup(state);
    else if (phase === 'choosing') renderChoosing(state);
    else if (phase === 'drawing') renderDrawing(state);
    else if (phase === 'reveal') renderReveal(state);
    else if (phase === 'final') renderFinal(state);

    clearInterval(tick);
    renderTime();
    if (timed) tick = setInterval(renderTime, 250);
  }

  function onStroke(stroke) {
    if (root) paint(stroke.id, stroke.color, stroke.size, stroke.points);
  }

  function onShape(shape) {
    if (root) paintShape(ctx, shape);
  }

  function onClear() {
    if (root) clearCanvas();
  }

  function onSync(data) {
    if (!root) return;
    clearCanvas();
    data.strokes.forEach((s) => {
      if (s.kind === 'line' || s.kind === 'circle') paintShape(ctx, s);
      else paint(s.id, s.color, s.size, s.points);
    });
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
    socket.on('draw:state', onState);
    socket.on('draw:stroke', onStroke);
    socket.on('draw:shape', onShape);
    socket.on('draw:clear', onClear);
    socket.on('draw:sync', onSync);
    socket.on('draw:chat', onChat);
    socket.on('draw:chat-sync', onChatSync);
  }

  function unmount() {
    if (socket) {
      socket.off('draw:state', onState);
      socket.off('draw:stroke', onStroke);
      socket.off('draw:shape', onShape);
      socket.off('draw:clear', onClear);
      socket.off('draw:sync', onSync);
      socket.off('draw:chat', onChat);
      socket.off('draw:chat-sync', onChatSync);
    }
    clearInterval(tick);
    clearTimeout(sendTimer);
    sendTimer = null;
    current = null;
    shapeDrag = null;
    root = null;
    phase = 'idle';
  }

  window.gameUIs = window.gameUIs || {};
  window.gameUIs.draw = { mount, unmount };
})();