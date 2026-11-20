/* Ridgetech Feud client. Contract: .10x/specs/2026-11-20-ridgetech-feud-design.md §6.
 * SECURITY: user-provided strings are only ever written with textContent. */
(function () {
  'use strict';

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = String(text);
    return e;
  }
  const rb = (n) => 'RB$ ' + Math.round(n || 0).toLocaleString();
  const setText = (node, t) => { const s = t == null ? '' : String(t); if (node.textContent !== s) node.textContent = s; };
  const show = (node, on) => { node.hidden = !on; };
  const isField = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

  const store = {
    get(code) { try { return JSON.parse(localStorage.getItem('rtf:' + code)); } catch (e) { return null; } },
    set(code, v) { try { localStorage.setItem('rtf:' + code, JSON.stringify(v)); } catch (e) { /* ignore */ } },
    del(code) { try { localStorage.removeItem('rtf:' + code); } catch (e) { /* ignore */ } },
  };

  let toastTimer = null;
  function toast(msg, kind) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show' + (kind ? ' ' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = 'toast'; }, 2600);
  }
  const announce = (msg) => { $('live').textContent = ''; setTimeout(() => { $('live').textContent = msg; }, 30); };

  // ---------- socket ----------
  const socket = io();
  let S = null;            // latest state snapshot
  let offset = 0;          // serverNow - Date.now()
  let session = null;      // { code, token, playerId, name }
  let lastFxId = null;
  let gotFirstState = false;

  function emit(ev, payload) {
    return new Promise((resolve) => {
      socket.timeout(8000).emit(ev, payload || {}, (err, res) => {
        resolve(err ? { ok: false, error: 'Server did not respond' } : (res || { ok: false, error: 'No response' }));
      });
    });
  }
  async function cmd(ev, payload) {
    const res = await emit(ev, payload);
    if (!res.ok) toast(res.error || 'Action failed', 'bad');
    return res;
  }

  const P = (id) => (S && S.players.find((p) => p.id === id)) || null;
  const pname = (id) => (P(id) ? P(id).name : 'Someone');
  const T = (id) => (S && S.teams.find((t) => t.id === id)) || null;
  const tname = (id) => (T(id) ? T(id).name : 'A team');
  const me = () => S && S.you;

  // ---------- session / landing ----------
  const urlMatch = location.pathname.match(/^\/r\/([A-Za-z0-9]{4})\/?$/);
  const urlCode = urlMatch ? urlMatch[1].toUpperCase() : null;
  if (urlCode) {
    $('join-code').value = urlCode;
    const saved = store.get(urlCode);
    if (saved && saved.token) session = Object.assign({ code: urlCode }, saved);
    $('join-form').classList.add('featured');
  }

  function enterRoom(code, res, name) {
    session = { code, token: res.token, playerId: res.playerId, name };
    store.set(code, { token: res.token, playerId: res.playerId, name });
    if (location.pathname !== '/r/' + code) history.pushState(null, '', '/r/' + code);
    setText($('landing-error'), '');
  }

  function leaveRoom(msg) {
    if (session) store.del(session.code);
    session = null;
    S = null;
    if (location.pathname !== '/') history.pushState(null, '', '/');
    render();
    setText($('landing-error'), msg || '');
  }

  async function rejoin() {
    if (!session) return;
    const res = await emit('room:join', { code: session.code, name: session.name || '', token: session.token });
    if (!res.ok) { leaveRoom(res.error || 'That room is no longer available.'); return; }
    if (res.token && res.token !== session.token) enterRoom(session.code, res, session.name);
  }

  $('host-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('host-name').value.trim();
    if (!name) return;
    const res = await emit('room:create', { name });
    if (!res.ok) { setText($('landing-error'), res.error || 'Could not create room'); return; }
    enterRoom(res.code, res, name);
  });

  $('join-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('join-code').value.trim().toUpperCase();
    const name = $('join-name').value.trim();
    if (!code || !name) return;
    const saved = store.get(code);
    const res = await emit('room:join', { code, name, token: saved && saved.token ? saved.token : undefined });
    if (!res.ok) { setText($('landing-error'), res.error || 'Could not join'); return; }
    enterRoom(code, res, name);
  });
  $('join-code').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase(); });

  socket.on('connect', () => { show($('conn'), false); rejoin(); });
  socket.on('disconnect', () => { if (session) show($('conn'), true); });

  socket.on('state', (st) => {
    offset = st.serverNow - Date.now();
    if (!st.you) { leaveRoom('You were removed from the room.'); return; }
    S = st;
    render();
    fireFx(st);
    gotFirstState = true;
  });

  // ---------- mute ----------
  function renderMute() {
    const m = FX.isMuted();
    setText($('mute'), m ? 'Sound off' : 'Sound on');
    $('mute').setAttribute('aria-pressed', String(m));
  }
  $('mute').addEventListener('click', () => { FX.setMuted(!FX.isMuted()); renderMute(); });
  renderMute();

  // ---------- render root ----------
  function render() {
    const ph = S ? S.phase : null;
    const view = !S ? 'landing' : ph === 'lobby' ? 'lobby' : ph === 'game_over' ? 'over' : 'game';
    ['landing', 'lobby', 'game', 'over'].forEach((v) => show($('v-' + v), v === view));
    document.body.classList.toggle('night', !!ph && ph.indexOf('bonus') === 0);
    show($('hdr-code'), !!S);
    if (S) setText($('hdr-code'), S.code);
    if (view === 'lobby') renderLobby();
    else if (view === 'game') renderGame();
    else if (view === 'over') renderOver();
  }

  // ---------- lobby ----------
  const shareUrl = () => location.origin + '/r/' + S.code;

  function rosterItem(p, compact) {
    const li = el('li', 'roster-item' + (p.connected ? '' : ' away'));
    const dot = li.appendChild(el('span', 'dot'));
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', p.connected ? 'connected' : 'disconnected');
    const t = T(p.teamId);
    if (t && p.connected) dot.style.background = t.color;
    li.appendChild(el('span', 'rname', p.name));
    if (p.isHost) li.appendChild(el('span', 'tag', 'HOST'));
    if (p.id === me().id) li.appendChild(el('span', 'tag you', 'YOU'));
    if (me().isHost && p.id !== me().id) {
      const b = el('button', 'btn tiny danger', compact ? 'Kick' : 'Remove');
      b.type = 'button';
      b.setAttribute('aria-label', 'Remove ' + p.name);
      b.addEventListener('click', () => { if (confirm('Remove ' + p.name + ' from the room?')) cmd('host:kick', { playerId: p.id }); });
      li.appendChild(b);
    }
    return li;
  }

  function renderLobby() {
    const host = me().isHost;
    setText($('lobby-code'), S.code);
    const link = shareUrl();
    if ($('share-link').value !== link) $('share-link').value = link;

    setText($('roster-count'), '(' + S.players.length + ')');
    $('roster').replaceChildren(...S.players.map((p) => rosterItem(p, false)));

    document.querySelectorAll('#v-lobby .host-only').forEach((n) => show(n, host));
    show($('start-btn'), host);
    $('start-btn').disabled = S.players.length < 2;
    setText($('start-hint'), host
      ? (S.players.length < 2 ? 'Need at least 2 players to start.' : 'Everyone in? Hit start.')
      : 'Waiting for ' + pname(S.hostId) + ' to start the game…');

    if (host) {
      const f = $('settings-form');
      if (!f.contains(document.activeElement)) {
        for (const k of ['teamCount', 'answerSeconds', 'stealSeconds', 'bonusSeconds', 'rounds']) {
          if (S.settings[k] != null) f.elements[k].value = String(S.settings[k]);
        }
      }
      $('cq-list').replaceChildren(...S.customQuestions.map((q) => {
        const li = el('li', 'cq-item');
        li.appendChild(el('span', 'cq-q', q.q));
        li.appendChild(el('span', 'muted mono', q.answerCount + ' ans'));
        const b = el('button', 'btn tiny danger', 'Remove');
        b.type = 'button';
        b.addEventListener('click', () => cmd('host:removeQuestion', { id: q.id }));
        li.appendChild(b);
        return li;
      }));
    }
  }

  $('copy-link').addEventListener('click', async () => {
    const input = $('share-link');
    try { await navigator.clipboard.writeText(input.value); toast('Link copied!'); } catch (e) { input.select(); toast('Press Ctrl/Cmd+C to copy'); }
  });
  $('start-btn').addEventListener('click', () => cmd('host:start'));

  $('settings-form').addEventListener('change', (e) => {
    const f = e.currentTarget;
    if (!f.reportValidity()) return;
    const tc = f.elements.teamCount.value;
    cmd('host:settings', {
      teamCount: tc === 'auto' ? 'auto' : Number(tc),
      answerSeconds: Number(f.elements.answerSeconds.value),
      stealSeconds: Number(f.elements.stealSeconds.value),
      bonusSeconds: Number(f.elements.bonusSeconds.value),
      rounds: Number(f.elements.rounds.value),
    });
  });

  // custom question rows
  function addCqRow() {
    const rows = $('cq-rows');
    if (rows.children.length >= 8) return;
    const n = rows.children.length + 1;
    const row = el('div', 'cq-row');
    const text = el('input'); text.maxLength = 40; text.placeholder = 'Answer ' + n; text.setAttribute('aria-label', 'Answer ' + n);
    const pts = el('input', 'mono'); pts.type = 'number'; pts.min = '1'; pts.max = '100'; pts.placeholder = 'pts'; pts.setAttribute('aria-label', 'Points for answer ' + n);
    const rm = el('button', 'btn tiny ghost', '✕'); rm.type = 'button'; rm.setAttribute('aria-label', 'Remove answer row');
    rm.addEventListener('click', () => { if (rows.children.length > 2) row.remove(); });
    row.append(text, pts, rm);
    rows.appendChild(row);
  }
  function resetCq() { $('cq-q').value = ''; $('cq-rows').replaceChildren(); for (let i = 0; i < 4; i++) addCqRow(); }
  resetCq();
  $('cq-add-row').addEventListener('click', addCqRow);
  $('cq-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('cq-q').value.trim();
    const answers = [...$('cq-rows').children].map((r) => {
      const [t, p] = r.querySelectorAll('input');
      return { text: t.value.trim(), points: Math.round(Number(p.value)) };
    }).filter((a) => a.text);
    let err = '';
    if (!q) err = 'Enter a question.';
    else if (answers.length < 2) err = 'Add at least 2 answers.';
    else if (answers.some((a) => !(a.points >= 1 && a.points <= 100))) err = 'Each answer needs 1–100 points.';
    setText($('cq-error'), err);
    if (err) return;
    answers.sort((a, b) => b.points - a.points);
    const res = await emit('host:addQuestion', { q, answers });
    if (!res.ok) { setText($('cq-error'), res.error || 'Could not add question'); return; }
    resetCq();
    toast('Question added');
  });

  // ---------- game view ----------
  let boardKey = null;
  function currentBoard() {
    const bonus = S.phase.indexOf('bonus') === 0;
    if (bonus) return S.bonus ? { key: 'bonus:' + S.bonus.question, tiles: S.bonus.board || [] } : { key: 'bonus', tiles: [] };
    return S.round ? { key: S.round.number + ':' + S.round.question, tiles: S.round.board || [] } : { key: 'none', tiles: [] };
  }

  function renderBoard() {
    const { key, tiles } = currentBoard();
    const board = $('board');
    if (key !== boardKey || board.children.length !== tiles.length) {
      boardKey = key;
      board.classList.add('no-anim');
      board.replaceChildren(...tiles.map((_, i) => {
        const tile = el('div', 'tile');
        tile.setAttribute('role', 'listitem');
        const inner = el('div', 'tile-inner');
        const front = el('div', 'face front');
        front.appendChild(el('span', 'rank', i + 1));
        const back = el('div', 'face back');
        back.append(el('span', 'ans'), el('span', 'pts mono'));
        inner.append(front, back);
        tile.appendChild(inner);
        return tile;
      }));
      requestAnimationFrame(() => requestAnimationFrame(() => board.classList.remove('no-anim')));
    }
    board.classList.toggle('two-col', tiles.length > 4);
    board.style.setProperty('--rows', String(tiles.length > 4 ? Math.ceil(tiles.length / 2) : tiles.length));
    tiles.forEach((t, i) => {
      const tile = board.children[i];
      const shown = !!t.revealed && t.text != null;
      tile.classList.toggle('revealed', shown);
      tile.classList.toggle('missed', !!t.missed);
      setText(tile.querySelector('.ans'), shown ? t.text : '');
      setText(tile.querySelector('.pts'), shown && t.points != null ? t.points : '');
      setText(tile.querySelector('.rank'), t.rank || i + 1);
      tile.setAttribute('aria-label', shown ? `Answer ${i + 1}: ${t.text}, ${t.points} points${t.missed ? ' (not found)' : ''}` : `Answer ${i + 1}: hidden`);
    });
  }

  let roundEndInfo = null;
  function statusText() {
    const r = S.round, b = S.bonus;
    if (S.paused) return 'Paused by the host';
    if (!r && S.phase.indexOf('bonus') !== 0) return '';
    switch (S.phase) {
      case 'faceoff': {
        const f = r && r.faceoff;
        if (!f) return 'Face-off!';
        if (f.status === 'countdown') return 'Waiting for GO…';
        if (f.status === 'go') return 'GO! Hit the buzzer!';
        if (f.status === 'answering') return pname(f.answeringId) + ' is answering';
        return 'Face-off decided';
      }
      case 'play':
        return tname(r.controlTeamId) + ' has control · ' + pname(r.currentTyperId) + ' is answering';
      case 'steal': {
        const st = r.steal;
        if (st && st.status === 'answering') {
          const sp = P(st.stealerId);
          return tname(sp && sp.teamId) + ' is stealing! ' + pname(st.stealerId) + ' answers';
        }
        return (st ? st.teamIds.map(tname).join(' & ') : 'Other teams') + ': race to steal!';
      }
      case 'round_end':
        if (roundEndInfo && roundEndInfo.teamId) return tname(roundEndInfo.teamId) + ' banks ' + rb(roundEndInfo.points != null ? roundEndInfo.points : r.pot * r.multiplier) + '!';
        return 'Round complete';
      case 'bonus_bet': return b && b.betsRevealed ? 'Bets are in!' : 'Captains are placing secret bets…';
      case 'bonus_play': return 'Bonus round: 3 guesses per team. Land 2 on the board!';
      case 'bonus_reveal': return 'The bonus board is revealed!';
      default: return '';
    }
  }

  function renderVs() {
    const r = S.round;
    const on = S.phase === 'faceoff' && r && r.faceoff;
    show($('vs'), !!on);
    if (!on) return;
    const f = r.faceoff;
    const card = (pid, tid) => {
      const d = el('div', 'vs-card' + (f.buzzWinnerId === pid ? ' won' : '') + (pid === me().id ? ' mine' : ''));
      const t = T(tid);
      if (t) d.style.setProperty('--team', t.color);
      d.append(el('span', 'vs-name', pname(pid)), el('span', 'vs-team', tname(tid)));
      return d;
    };
    $('vs').replaceChildren(card(f.playerIds[0], f.teamIds[0]), el('span', 'vs-x', 'VS'), card(f.playerIds[1], f.teamIds[1]));
  }

  function renderStrikesPot() {
    const r = S.round;
    const bonus = S.phase.indexOf('bonus') === 0;
    show($('under-board'), !bonus && !!r);
    if (bonus || !r) return;
    const box = $('strikes');
    if (box.children.length !== 3) box.replaceChildren(el('span', 'x', '✕'), el('span', 'x', '✕'), el('span', 'x', '✕'));
    [...box.children].forEach((x, i) => x.classList.toggle('on', i < r.strikes));
    box.setAttribute('aria-label', r.strikes + ' of 3 strikes');
    setText($('pot'), rb(r.pot) + (r.multiplier > 1 ? ' ×' + r.multiplier : ''));
  }

  // --- buzzer ---
  const buzz = { key: null, goAt: null, early: false, pressed: false };
  function buzzContext() {
    const r = S && S.round;
    if (!r || S.paused) return null;
    const f = r.faceoff;
    if (S.phase === 'faceoff' && f && f.playerIds.indexOf(me().id) !== -1 && (f.status === 'countdown' || f.status === 'go')) {
      return { key: 'f:' + r.number + ':' + r.question, status: f.status };
    }
    const st = r.steal;
    if (S.phase === 'steal' && st && st.status === 'go' && st.teamIds.indexOf(me().teamId) !== -1) {
      return { key: 's:' + r.number + ':' + r.question, status: 'go' };
    }
    return null;
  }

  function pressBuzz() {
    const ctx = S && buzzContext();
    if (!ctx || ctx.key !== buzz.key || buzz.pressed) return;
    if (ctx.status === 'countdown') {
      if (buzz.early) return;
      buzz.early = true;
      emit('buzz', { early: true, reactionMs: 0 });
      toast('Too early! +1s penalty', 'bad');
    } else {
      buzz.pressed = true;
      const ms = Math.max(0, Math.round(performance.now() - (buzz.goAt != null ? buzz.goAt : performance.now())));
      emit('buzz', { reactionMs: ms });
    }
    FX.play('buzz');
    renderAction();
  }
  $('buzz').addEventListener('pointerdown', (e) => { e.preventDefault(); pressBuzz(); });
  $('buzz').addEventListener('click', (e) => { if (e.detail === 0) pressBuzz(); }); // keyboard activation only
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || isField(e.target)) return;
    if (!S || !buzzContext()) return;
    e.preventDefault();
    pressBuzz();
  });

  let answerWasShown = false;
  function renderAction() {
    const r = S.round;
    const ctx = buzzContext();
    if (ctx && ctx.key !== buzz.key) Object.assign(buzz, { key: ctx.key, goAt: null, early: false, pressed: false });
    if (ctx && ctx.status === 'go' && buzz.goAt == null) buzz.goAt = performance.now(); // first render of GO
    const bz = $('buzz');
    show(bz, !!ctx);
    bz.disabled = !ctx || buzz.pressed || (buzz.early && ctx.status === 'countdown');
    bz.classList.toggle('live', !!ctx && ctx.status === 'go' && !buzz.pressed);
    setText(bz.querySelector('.buzz-sub'), buzz.pressed ? 'Locked in' : buzz.early && ctx && ctx.status === 'countdown' ? 'Too early! Wait…' : 'Space / tap');

    const answerPhase = ['faceoff', 'play', 'steal'].indexOf(S.phase) !== -1;
    const typer = answerPhase && r ? r.currentTyperId : null;
    const mine = !!typer && typer === me().id && !S.paused;
    show($('answer-form'), mine);
    if (mine && !answerWasShown) { $('answer-input').value = ''; setTimeout(() => $('answer-input').focus(), 0); }
    answerWasShown = mine;
    setText($('typing'), typer && !mine ? pname(typer) + ' is typing…' : '');
  }

  $('answer-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('answer-input').value.trim().slice(0, 60);
    if (!text) return;
    $('answer-input').value = '';
    cmd('answer', { text });
  });

  // --- bonus ---
  let betInitFor = null;
  let bguessWasShown = false;
  function renderBonus() {
    const b = S.bonus;
    const bonus = S.phase.indexOf('bonus') === 0 && !!b;
    show($('bonus-panel'), bonus);
    if (!bonus) return;
    const myTeam = me().teamId;

    // chips: one per team
    $('chips').replaceChildren(...S.teams.map((t) => {
      const v = b.bets ? b.bets[t.id] : null;
      const c = el('div', 'bet-chip' + (b.betsRevealed ? ' glow' : '') + (t.id === myTeam ? ' mine' : ''));
      c.style.setProperty('--team', t.color);
      c.append(el('span', 'chip-team', t.name), el('span', 'chip-val mono', v != null ? rb(v) : '?'));
      c.appendChild(el('span', 'chip-cap', 'Capt. ' + pname(b.captains ? b.captains[t.id] : null)));
      return c;
    }));

    // betting
    const betting = S.phase === 'bonus_bet';
    show($('bet-area'), betting);
    if (betting) {
      const captain = b.captains && b.captains[myTeam] === me().id;
      const t = T(myTeam);
      const max = Math.max(t ? t.score : 0, 100);
      show($('bet-form'), captain && !b.betsRevealed);
      if (captain) {
        $('bet-range').max = String(max);
        $('bet-num').max = String(max);
        if (betInitFor !== b.question) {
          betInitFor = b.question;
          const start = b.bets && b.bets[myTeam] != null ? b.bets[myTeam] : 0;
          $('bet-range').value = $('bet-num').value = String(start);
        }
      }
      const mineBet = b.bets ? b.bets[myTeam] : null;
      setText($('bet-note'), captain
        ? (mineBet != null ? 'Locked: ' + rb(mineBet) + ' (you can change it until bets are revealed)' : 'Max ' + rb(max) + '. Win 1.5× if 2+ guesses hit; lose it otherwise.')
        : 'Captain ' + pname(b.captains ? b.captains[myTeam] : null) + ' is betting…' + (mineBet != null ? ' Bet: ' + rb(mineBet) : ''));
    }

    // guessing
    const playing = S.phase === 'bonus_play';
    show($('bguess-area'), playing);
    const bt = b.teams ? b.teams[myTeam] : null;
    if (playing && bt) {
      $('bguess-list').replaceChildren(...(bt.guesses || []).map((g) => {
        const li = el('li', g.correct === true ? 'hit' : g.correct === false ? 'miss' : '');
        li.appendChild(el('span', null, g.text));
        if (typeof g.correct === 'boolean') li.appendChild(el('span', 'mark', g.correct ? '✓' : '✕'));
        return li;
      }));
      const mine = bt.currentTyperId === me().id && bt.guessCount < 3 && !S.paused;
      show($('bguess-form'), mine);
      if (mine && !bguessWasShown) setTimeout(() => $('bguess-input').focus(), 0);
      bguessWasShown = mine;
      setText($('bguess-note'), bt.guessCount >= 3 ? 'All 3 guesses in. Fingers crossed.'
        : mine ? 'Your turn! Guess ' + (bt.guessCount + 1) + ' of 3.'
        : bt.currentTyperId ? pname(bt.currentTyperId) + ' is typing…' : '');
      $('bother').replaceChildren(...S.teams.filter((t) => t.id !== myTeam).map((t) => {
        const o = b.teams[t.id];
        const li = el('li', null, t.name + ': ' + (o ? o.guessCount : 0) + '/3 guesses');
        li.style.setProperty('--team', t.color);
        return li;
      }));
    } else {
      bguessWasShown = false;
    }

    // results
    const res = S.phase === 'bonus_reveal' && b.results;
    show($('bresults'), !!res);
    if (res) {
      $('bresults').replaceChildren(...S.teams.map((t) => {
        const r = res[t.id];
        if (!r) return el('li', null, t.name + ': no bet');
        const li = el('li', r.won ? 'won' : 'lost');
        li.style.setProperty('--team', t.color);
        li.append(el('span', null, t.name + ' · ' + r.hits + '/3 on the board'),
          el('b', 'mono', (r.delta >= 0 ? '+' : '−') + rb(Math.abs(r.delta))));
        return li;
      }));
    }
  }

  $('bet-range').addEventListener('input', () => { $('bet-num').value = $('bet-range').value; });
  $('bet-num').addEventListener('input', () => { $('bet-range').value = $('bet-num').value; });
  $('bet-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const max = Number($('bet-num').max) || 100;
    const amount = Math.min(max, Math.max(0, Math.round(Number($('bet-num').value) || 0)));
    const res = await cmd('bonus:bet', { amount });
    if (res.ok) { FX.play('chip'); toast('Bet locked: ' + rb(amount)); }
  });
  $('bguess-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('bguess-input').value.trim().slice(0, 60);
    if (!text) return;
    $('bguess-input').value = '';
    cmd('bonus:answer', { text });
  });

  // --- scoreboard: ridge climb ---
  let climberSig = '';
  function renderScores() {
    const teams = S.teams || [];
    const leader = Math.max(1, ...teams.map((t) => t.score));
    const top = Math.max(0, ...teams.map((t) => t.score));
    const path = $('ridge-path');
    const len = path.getTotalLength();
    const g = $('climbers');
    const sig = teams.map((t) => t.id).join(',');
    if (sig !== climberSig) {
      climberSig = sig;
      g.replaceChildren(...teams.map((t) => {
        const c = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        c.setAttribute('class', 'climber');
        c.dataset.team = t.id;
        c.innerHTML = '<path class="flag" d="M0 -12 V-30 L14 -25 L0 -20"/><circle r="8"/><circle class="head" cy="-11" r="3.5"/>'; // static markup, no user data
        return c;
      }));
    }
    teams.forEach((t, i) => {
      const c = g.querySelector('[data-team="' + CSS.escape(String(t.id)) + '"]');
      if (!c) return;
      const pt = path.getPointAtLength((t.score / leader) * len);
      c.style.transform = 'translate(' + pt.x.toFixed(1) + 'px,' + (pt.y - i * 3).toFixed(1) + 'px)';
      c.style.setProperty('--team', t.color);
      c.classList.toggle('leader', top > 0 && t.score === top);
      c.classList.toggle('mine', t.id === me().teamId);
    });

    const sorted = teams.slice().sort((a, b) => b.score - a.score);
    $('scores').replaceChildren(...sorted.map((t) => {
      const li = el('li', 'score' + (t.id === me().teamId ? ' mine' : '') + (r0(t) ? ' control' : ''));
      li.style.setProperty('--team', t.color);
      li.append(el('span', 'sw'), el('span', 'sname', t.name), el('span', 'sval mono', rb(t.score)));
      return li;
    }));
  }
  const r0 = (t) => S.round && S.round.controlTeamId === t.id && ['play', 'steal'].indexOf(S.phase) !== -1;

  // --- host bar ---
  function renderHostbar() {
    const host = me().isHost;
    show($('hostbar'), host);
    if (!host) return;
    const ph = S.phase;
    const live = ['faceoff', 'play', 'steal', 'bonus_bet', 'bonus_play'].indexOf(ph) !== -1;
    show($('h-pause'), live);
    setText($('h-pause'), S.paused ? 'Resume' : 'Pause');
    show($('h-skip'), ['faceoff', 'play', 'steal'].indexOf(ph) !== -1);
    show($('h-accept'), !!(S.round && S.round.canAccept) && ['faceoff', 'play', 'steal'].indexOf(ph) !== -1);
    show($('h-next'), ph === 'round_end' || ph === 'bonus_reveal');
    $('h-roster').replaceChildren(...S.players.map((p) => rosterItem(p, true)));
  }
  $('h-pause').addEventListener('click', () => cmd(S.paused ? 'host:resume' : 'host:pause'));
  $('h-skip').addEventListener('click', () => { if (confirm('Skip this question? No points are awarded.')) cmd('host:skip'); });
  $('h-accept').addEventListener('click', () => cmd('host:accept'));
  $('h-next').addEventListener('click', () => cmd('host:next'));
  $('h-end').addEventListener('click', () => { if (confirm('End the game now and go to final scores?')) cmd('host:end'); });

  // --- last guess toast ---
  let lastGuessKey = null;
  function renderLastGuess() {
    const g = S.round && S.round.lastGuess;
    const k = g ? [S.round.number, S.round.question, g.playerId, g.text, g.correct, g.rank].join('|') : null;
    if (k === lastGuessKey) return;
    const first = lastGuessKey === null && !gotFirstState;
    lastGuessKey = k;
    if (!g || first) return;
    toast((g.correct ? '✓ ' : '✕ ') + pname(g.playerId) + ': “' + g.text + '”', g.correct ? 'good' : 'bad');
  }

  function renderGame() {
    const bonus = S.phase.indexOf('bonus') === 0;
    const r = S.round, b = S.bonus;
    if (bonus) {
      setText($('q-cat'), 'Bonus round');
      setText($('q-round'), 'Final climb');
      show($('q-mult'), false);
      setText($('q-text'), b ? b.question : '');
    } else {
      setText($('q-cat'), r ? r.category : '');
      setText($('q-round'), r ? 'Round ' + r.number + '/' + r.total : '');
      show($('q-mult'), !!r && r.multiplier > 1);
      setText($('q-text'), r ? r.question : '');
    }
    setText($('status'), statusText());
    renderBoard();
    renderVs();
    renderStrikesPot();
    renderAction();
    renderBonus();
    renderScores();
    renderHostbar();
    renderLastGuess();
  }

  // ---------- timer (rAF) ----------
  const ARC = 2 * Math.PI * 19;
  $('timer-arc').style.strokeDasharray = String(ARC);
  function tickTimer() {
    requestAnimationFrame(tickTimer);
    const t = S && S.timer;
    const on = !!t && !!S && ['lobby', 'game_over'].indexOf(S.phase) === -1;
    const box = $('timer');
    if (box.hidden === on) box.hidden = !on;
    if (!on) return;
    const rem = Math.max(0, S.paused ? t.endsAt - S.serverNow : t.endsAt - (Date.now() + offset));
    const frac = t.duration > 0 ? Math.min(1, rem / t.duration) : 0;
    $('timer-arc').style.strokeDashoffset = (ARC * (1 - frac)).toFixed(2);
    setText($('timer-num'), S.paused ? 'II' : Math.ceil(rem / 1000));
    box.classList.toggle('urgent', rem < 5000 && !S.paused);
  }
  requestAnimationFrame(tickTimer);

  // ---------- game over ----------
  function renderOver() {
    const sorted = S.teams.slice().sort((a, b) => b.score - a.score);
    const places = ['1st', '2nd', '3rd'];
    $('podium').replaceChildren(...sorted.slice(0, 3).map((t, i) => {
      const d = el('div', 'step p' + (i + 1) + (t.id === me().teamId ? ' mine' : ''));
      d.style.setProperty('--team', t.color);
      d.append(el('span', 'step-name', t.name), el('span', 'step-score mono', rb(t.score)), el('span', 'step-place', places[i]));
      return d;
    }));
    $('final-list').replaceChildren(...sorted.slice(3).map((t) => el('li', null, t.name + ' · ' + rb(t.score))));

    const ps = S.players || [];
    const hitter = ps.slice().sort((a, b) => (b.hits || 0) - (a.hits || 0))[0];
    const fast = ps.filter((p) => p.bestReactionMs != null).sort((a, b) => a.bestReactionMs - b.bestReactionMs)[0];
    const card = (label, p, val) => {
      const d = el('div', 'mvp');
      d.append(el('span', 'mvp-label', label), el('span', 'mvp-name', p ? p.name : '—'), el('span', 'mvp-val mono', p ? val : ''));
      const t = p && T(p.teamId);
      if (t) d.style.setProperty('--team', t.color);
      return d;
    };
    $('mvps').replaceChildren(
      card('Most hits', hitter && hitter.hits ? hitter : null, hitter ? hitter.hits + ' answers' : ''),
      card('Fastest buzz', fast, fast ? fast.bestReactionMs + ' ms' : ''));

    show($('again-btn'), me().isHost);
    setText($('again-hint'), me().isHost ? '' : 'Waiting for ' + pname(S.hostId) + ' to start a rematch…');
  }
  $('again-btn').addEventListener('click', () => cmd('host:playAgain'));

  // ---------- FX per lastEvent.id ----------
  function fireFx(st) {
    const ev = st.lastEvent;
    if (!ev || ev.id === lastFxId) return;
    lastFxId = ev.id;
    if (!gotFirstState) return; // don't replay an old event on join/reconnect
    const d = ev.data || {};
    switch (ev.type) {
      case 'reveal': {
        FX.play('ding');
        const rank = d.rank != null ? d.rank : st.round && st.round.lastGuess && st.round.lastGuess.rank;
        const tile = rank ? $('board').children[rank - 1] : null;
        FX.flare(tile);
        FX.chase($('marquee'));
        const t = rank && currentBoard().tiles[rank - 1];
        if (t && t.text != null) announce('Revealed: ' + t.text + ', ' + t.points + ' points');
        break;
      }
      case 'strike': {
        FX.play('strike');
        FX.stamp();
        FX.shake();
        announce('Strike ' + (st.round ? st.round.strikes : ''));
        break;
      }
      case 'buzz': if (d.playerId !== me().id) FX.play('buzz'); break;
      case 'countdown': FX.play('countdown'); break;
      case 'go': FX.play('go'); break;
      case 'steal': FX.play('alarm'); announce('Steal! Other teams, buzz in!'); break;
      case 'control': FX.play('tick'); break;
      case 'stealResult': FX.play(d.correct ? 'ding' : 'strike'); break;
      case 'roundEnd':
        roundEndInfo = d;
        setText($('status'), statusText());
        FX.chase($('marquee'));
        FX.play('chip');
        break;
      case 'start': case 'teams': FX.play('go'); roundEndInfo = null; break;
      case 'betsRevealed': FX.play('chip'); announce('Bets revealed'); break;
      case 'bonusGuess': FX.play('tick'); break;
      case 'bonusReveal': FX.play('drumroll'); setTimeout(() => FX.chase($('marquee')), 2000); break;
      case 'gameOver': FX.play('fanfare'); FX.confetti(); announce('Game over'); break;
      case 'kicked': if (d.playerId === me().id) leaveRoom('You were removed by the host.'); break;
      case 'hostChanged': toast(pname(st.hostId) + ' is now the host'); break;
      case 'join': if (d.playerId && d.playerId !== me().id && st.phase === 'lobby') FX.play('tick'); break;
      default: break;
    }
    if (ev.type !== 'roundEnd' && st.phase !== 'round_end') roundEndInfo = null;
  }

  render();
})();
