/* Ridgetech Feud client. Contract: .10x/specs/2026-11-20-ridgetech-feud-design.md §6 + v2 spec §2/§3.
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
  const initials = (name) => {
    const w = String(name || '?').trim().split(/\s+/);
    const a = Array.from(w[0] || '?');
    const b = w[1] ? Array.from(w[1]) : [];
    return ((a[0] || '?') + (b[0] || a[1] || '')).toUpperCase();
  };
  const pretty = (cat) => String(cat).split(/[-_\s]+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  const ANSWER_PHASES = ['faceoff', 'play', 'steal'];
  const TURN_PHASES = ['faceoff', 'play', 'steal', 'round_end', 'bonus_play'];
  const MIN_QUESTIONS = 15;
  const FUN_NAMES = [
    'Chai & Chill', 'Mate Masters', 'Taco Tuesday Titans', 'Masala Mavericks', 'Dulce de Leche Dynasty',
    'Bagel Bandits', 'Biryani Bosses', 'Tango Troopers', 'Samosa Squad', 'Gaucho Gang',
    'Empanada Empire', 'Butter Chicken Bunch', 'Freedom Fries', 'Pani Puri Posse', 'Asado All-Stars',
    'Curry Crusaders', 'Mango Lassi Legends', 'Alfajor Avengers', 'Bollywood Buzzers', 'Messi Business',
    'Cricket Crickets', 'Tailgate Titans', 'Jalebi Jammers', 'Chimichurri Champs', 'Pancake Posse',
    'Diwali Dazzlers', 'Thanksgiving Turkeys', 'Ahorita Allstars', 'Desi Dynamos', 'Yerba Yankees',
    'Holi Hustlers', 'Tea Time Tigers', 'Bombay Bombers', 'Pampas Panthers', 'Hot Dog Heroes',
    'Naan Stop Ninjas', 'Mate & Memes', 'Dosa Dynasty', 'Fernet Friends', 'Apple Pie Avengers',
  ];

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

  // Themed replacement for window.confirm(). Resolves true only on the confirm button.
  // Esc, Cancel and a backdrop click all resolve false. Text is set via textContent.
  let cfResolve = null;
  function askConfirm({ title, body, ok = 'OK', icon = '❓', danger = false }) {
    const d = $('confirm-dialog');
    if (cfResolve) { cfResolve(false); cfResolve = null; }
    if (d.open) d.close('cancel');
    setText($('cf-icon'), icon);
    setText($('cf-title'), title);
    setText($('cf-body'), body);
    setText($('cf-ok'), ok);
    d.classList.toggle('danger', danger);
    $('cf-ok').className = 'btn ' + (danger ? 'danger' : 'gold');
    d.returnValue = '';
    d.showModal();
    (danger ? $('cf-cancel') : $('cf-ok')).focus(); // destructive actions default to Cancel
    return new Promise((resolve) => { cfResolve = resolve; });
  }
  $('confirm-dialog').addEventListener('close', () => {
    const r = cfResolve;
    cfResolve = null;
    if (r) r($('confirm-dialog').returnValue === 'ok');
  });
  $('confirm-dialog').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close('cancel'); });

  const P = (id) => (S && S.players.find((p) => p.id === id)) || null;
  const pname = (id) => (P(id) ? P(id).name : 'Someone');
  const T = (id) => (S && S.teams.find((t) => t.id === id)) || null;
  const tname = (id) => (T(id) ? T(id).name : 'A team');
  const me = () => S && S.you;

  // Acting captain: captainId, or the next connected teammate in rotation if the captain is away.
  function captainOf(t) {
    if (!t) return null;
    const ids = t.playerIds || [];
    const c = P(t.captainId);
    if (!c || c.connected || !ids.length) return t.captainId || null;
    const start = Math.max(0, ids.indexOf(t.captainId));
    for (let k = 1; k <= ids.length; k++) {
      const p = P(ids[(start + k) % ids.length]);
      if (p && p.connected) return p.id;
    }
    return t.captainId;
  }

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
    if ($('confirm-dialog').open) $('confirm-dialog').close('cancel'); // a pending confirm is moot now
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
  socket.on('disconnect', (reason) => {
    if (session) show($('conn'), true);
    // Server-initiated disconnects (kick / room closed) don't auto-reconnect; reconnect so the
    // landing page can create or join another room.
    if (reason === 'io server disconnect') socket.connect();
  });
  socket.on('roomClosed', () => {
    const wasHost = !!(S && S.you && S.you.isHost);
    show($('conn'), false);
    $('join-code').value = ''; // the closed room's code is dead
    leaveRoom(wasHost ? 'You closed the room.' : 'The host closed the room. Thanks for playing!');
  });
  $('leave-room').addEventListener('click', async () => {
    const host = !!(S && S.you && S.you.isHost);
    const others = S ? S.players.length - 1 : 0;
    const body = host && others > 0
      ? 'Host passes to another player and the game carries on without you.'
      : 'You can rejoin later with the room code, as a new player.';
    if (!(await askConfirm({ title: 'Leave the room?', body, ok: 'Leave', icon: '↩' }))) return;
    const res = await cmd('player:leave');
    if (res.ok) leaveRoom('You left the room.');
  });
  $('close-room').addEventListener('click', async () => {
    if (await askConfirm({ title: 'Close the room?', body: 'Everyone is sent back to the start screen and this room code stops working.', ok: 'Close room', icon: '✕', danger: true })) cmd('host:closeRoom');
  });

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
  function viewFor(ph) {
    if (!ph) return 'landing';
    if (ph === 'lobby') return 'lobby';
    if (ph === 'team_naming') return 'naming';
    if (ph === 'game_over') return 'over';
    return 'game';
  }

  function render() {
    const ph = S ? S.phase : null;
    const view = viewFor(ph);
    ['landing', 'lobby', 'naming', 'game', 'over'].forEach((v) => show($('v-' + v), v === view));
    document.body.classList.toggle('night', !!ph && ph.indexOf('bonus') === 0);
    show($('hdr-code'), !!S);
    if (S) setText($('hdr-code'), S.code);
    show($('close-room'), !!(S && S.you && S.you.isHost));
    show($('leave-room'), !!(S && S.you));
    renderRoundChip();
    if (view !== 'lobby' && $('cq-dialog').open) $('cq-dialog').close();
    if (view !== 'game') closeSheet();
    if (view === 'lobby') renderLobby();
    else if (view === 'naming') renderNaming();
    else if (view === 'game') renderGame();
    else if (view === 'over') renderOver();
  }

  function renderRoundChip() {
    const chip = $('hdr-round');
    const ph = S && S.phase;
    let text = '';
    let final = false;
    if (ph === 'team_naming') text = 'Team naming';
    else if (ph && ph.indexOf('bonus') === 0) text = 'Bonus round';
    else if (S && S.round && ['faceoff', 'play', 'steal', 'round_end'].indexOf(ph) !== -1) {
      final = !!S.round.isFinal;
      text = final ? 'FINAL ROUND ×2' : 'Round ' + S.round.number;
    }
    show(chip, !!text);
    setText(chip, text);
    chip.classList.toggle('final', final);
  }

  // ---------- shared team UI ----------
  function playerStatus(p, t) {
    const r = S.round, b = S.bonus, ph = S.phase;
    let answering = false;
    if (r && ANSWER_PHASES.indexOf(ph) !== -1) answering = r.currentTyperId === p.id;
    if (ph === 'bonus_play' && b && b.teams && b.teams[p.teamId]) {
      const bt = b.teams[p.teamId];
      answering = bt.currentTyperId === p.id && bt.guessCount < 3;
    }
    const faceoff = ph === 'faceoff' && !!r && !!r.faceoff && r.faceoff.playerIds.indexOf(p.id) !== -1;
    const next = !answering && !!t && t.nextTyperId === p.id && TURN_PHASES.indexOf(ph) !== -1;
    return { answering, faceoff, next };
  }

  function memberChip(p, t) {
    const st = S.phase === 'lobby' ? {} : playerStatus(p, t);
    const li = el('li', 'member' + (p.connected ? '' : ' away') + (st.answering ? ' answering' : '') + (st.faceoff ? ' faceoff' : '') + (p.id === me().id ? ' me' : ''));
    if (t) li.style.setProperty('--team', t.color);
    li.appendChild(el('span', 'av', initials(p.name)));
    const nm = li.appendChild(el('span', 'mname', p.name));
    if (p.id === me().id) nm.appendChild(el('span', 'you', ' (you)'));
    if (t && captainOf(t) === p.id) {
      const s = li.appendChild(el('span', 'star', '★'));
      s.title = 'Captain';
      s.setAttribute('aria-label', 'captain');
    }
    const tag = (cls, icon, label) => { const s = el('span', 'tag ' + cls, icon); s.appendChild(el('span', 'tl', ' ' + label)); s.title = label; li.appendChild(s); };
    if (st.answering) tag('answering', '✍️', 'ANSWERING');
    else if (st.faceoff) tag('fo', '⚡', 'FACE-OFF');
    else if (st.next) li.appendChild(el('span', 'tag next', 'UP NEXT'));
    if (!p.connected) li.title = p.name + ' (disconnected)';
    return li;
  }

  // Lobby / host roster chip (no team yet): avatar, name, HOST/YOU, kick.
  function rosterChip(p) {
    const li = el('li', 'member' + (p.connected ? '' : ' away'));
    const t = T(p.teamId);
    if (t) li.style.setProperty('--team', t.color);
    li.appendChild(el('span', 'av', initials(p.name)));
    li.appendChild(el('span', 'mname', p.name));
    if (p.isHost) li.appendChild(el('span', 'tag', 'HOST'));
    if (p.id === me().id) li.appendChild(el('span', 'tag you', 'YOU'));
    if (me().isHost && p.id !== me().id) {
      const b = el('button', 'btn tiny danger', '✕');
      b.type = 'button';
      b.setAttribute('aria-label', 'Remove ' + p.name);
      b.addEventListener('click', async () => {
        if (await askConfirm({ title: 'Remove ' + p.name + '?', body: 'They leave the room and their team. They can rejoin with the room code.', ok: 'Remove', icon: '🚪', danger: true })) cmd('host:kick', { playerId: p.id });
      });
      li.appendChild(b);
    }
    return li;
  }

  const r0 = (t) => S.round && S.round.controlTeamId === t.id && ['play', 'steal'].indexOf(S.phase) !== -1;

  function activeTeamId() {
    if (!S) return null;
    const r = S.round;
    if (r && ANSWER_PHASES.indexOf(S.phase) !== -1) {
      if (r.activeTeamId) return r.activeTeamId;
      const p = P(r.currentTyperId);
      return p ? p.teamId : null;
    }
    if (S.phase === 'round_end' && roundEndInfo) return roundEndInfo.teamId || null;
    if (S.phase === 'bonus_play') return me().teamId;
    return null;
  }

  function teamCard(t) {
    const mine = t.id === me().teamId;
    const card = el('section', 'tcard' + (mine ? ' mine' : '') + (activeTeamId() === t.id ? ' active' : ''));
    card.style.setProperty('--team', t.color);
    const head = card.appendChild(el('div', 'tc-head'));
    if (mine) head.appendChild(el('span', 'tc-kicker', 'YOUR TEAM'));
    head.append(el('span', 'tc-name', t.name), el('span', 'tc-score mono', rb(t.score)));
    if (r0(t)) head.appendChild(el('span', 'tc-ctrl', '◆ IN CONTROL'));
    const ul = card.appendChild(el('ul', 'members'));
    ul.dataset.team = t.id;
    ul.append(...(t.playerIds || []).map(P).filter(Boolean).map((p) => memberChip(p, t)));
    return card;
  }

  // Re-render team cards but keep each member list's internal scroll position.
  function renderTeamCards(box, teams) {
    const keep = {};
    box.querySelectorAll('.members').forEach((u) => { keep[u.dataset.team] = u.scrollTop; });
    box.replaceChildren(...teams.map(teamCard));
    box.querySelectorAll('.members').forEach((u) => { if (keep[u.dataset.team]) u.scrollTop = keep[u.dataset.team]; });
  }

  // ---------- lobby ----------
  const shareUrl = () => location.origin + '/r/' + S.code;
  let catDraft = null; // host's pending category selection (null = use server's)

  function allCats() { return Object.keys(S.categoryCounts || {}).sort(); }
  function selectedCats() {
    if (catDraft) return catDraft;
    const c = S.settings && S.settings.categories;
    return Array.isArray(c) ? c : allCats();
  }

  function renderLobby() {
    const host = me().isHost;
    setText($('lobby-code'), S.code);
    const link = shareUrl();
    if ($('share-link').value !== link) $('share-link').value = link;

    setText($('roster-count'), '(' + S.players.length + ')');
    $('roster').replaceChildren(...S.players.map(rosterChip));

    document.querySelectorAll('#v-lobby .host-only').forEach((n) => show(n, host));
    const settings = S.settings || {};
    const seg = (box, val) => box.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.v === String(val)));
      b.disabled = !host;
    });
    seg($('seg-teams'), settings.teamCount != null ? settings.teamCount : 'auto');
    seg($('seg-minutes'), settings.gameMinutes != null ? settings.gameMinutes : 7);

    // question mix
    const counts = S.categoryCounts || {};
    const sel = selectedCats();
    const mix = $('mix');
    if (host) {
      mix.replaceChildren(...allCats().map((c) => {
        const b = el('button', null, pretty(c));
        b.type = 'button';
        b.dataset.cat = c;
        b.setAttribute('aria-pressed', String(sel.indexOf(c) !== -1));
        b.appendChild(el('b', null, counts[c]));
        return b;
      }));
    } else {
      mix.replaceChildren(...sel.map((c) => { const s = el('span', null, pretty(c)); s.appendChild(el('b', null, counts[c] != null ? counts[c] : '')); return s; }));
    }
    const custom = (S.customQuestions || []).length;
    const total = sel.reduce((n, c) => n + (counts[c] || 0), 0) + custom;
    const haveCounts = allCats().length > 0;
    setText($('mix-total'), haveCounts ? total + ' questions selected' + (custom ? ' (incl. ' + custom + ' custom)' : '') : '');
    const tooFew = haveCounts && (sel.length === 0 || total < MIN_QUESTIONS);
    $('mix-total').classList.toggle('bad', tooFew);

    show($('start-btn'), host);
    $('start-btn').disabled = S.players.length < 2 || tooFew;
    setText($('start-hint'), host
      ? (S.players.length < 2 ? 'Need at least 2 players to start.'
        : sel.length === 0 ? 'Pick at least one category.'
          : tooFew ? 'Pick at least ' + MIN_QUESTIONS + ' questions.' : 'Everyone in? Hit start.')
      : 'Waiting for ' + pname(S.hostId) + ' to start the game…');

    if (host) {
      setText($('cq-open'), 'Custom questions' + (custom ? ' (' + custom + ')' : ''));
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

  $('seg-teams').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    cmd('host:settings', { teamCount: b.dataset.v === 'auto' ? 'auto' : Number(b.dataset.v) });
  });
  $('seg-minutes').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    cmd('host:settings', { gameMinutes: Number(b.dataset.v) });
  });

  async function setCats(list) {
    catDraft = list;
    renderLobby();
    if (!list.length) return; // server rejects empty; keep it as a local draft until one is picked
    const res = await cmd('host:settings', { categories: list });
    if (catDraft === list) catDraft = null;
    if (S && S.phase === 'lobby') renderLobby();
    return res;
  }
  $('mix').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b || !me().isHost) return;
    const c = b.dataset.cat;
    const sel = selectedCats();
    setCats(sel.indexOf(c) !== -1 ? sel.filter((x) => x !== c) : sel.concat(c));
  });
  $('mix-all').addEventListener('click', () => setCats(allCats()));
  $('mix-none').addEventListener('click', () => setCats([]));

  // how to play tabs (+ overlay on narrower screens)
  const tabs = [...document.querySelectorAll('.tabs [data-step]')];
  const panels = [...document.querySelectorAll('.step-panel')];
  tabs.forEach((tb) => tb.addEventListener('click', () => {
    const i = Number(tb.dataset.step);
    tabs.forEach((x, k) => x.setAttribute('aria-selected', String(k === i)));
    panels.forEach((p, k) => show(p, k === i));
  }));
  $('howto-open').addEventListener('click', () => $('howto').classList.add('open'));
  $('howto-close').addEventListener('click', () => $('howto').classList.remove('open'));

  // custom questions modal
  $('cq-open').addEventListener('click', () => { if (!$('cq-dialog').open) $('cq-dialog').showModal(); });
  $('cq-close').addEventListener('click', () => $('cq-dialog').close());
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

  // ---------- team naming ----------
  let nmTimer = null;
  function myTeam() { return S && T(me().teamId); }

  function renderNaming() {
    const t = myTeam();
    const box = $('my-naming');
    if (t) box.style.setProperty('--team', t.color);
    const cap = captainOf(t);
    const amCap = !!t && cap === me().id;
    const locked = !!(t && t.nameLocked);
    setText($('nm-name'), t ? t.name : '');
    $('nm-name').classList.toggle('locked', locked);
    show($('nm-form'), amCap && !locked);
    const input = $('nm-input');
    if (amCap && !locked && document.activeElement !== input && !nmTimer && input.value !== t.name) input.value = t.name;
    setText($('nm-note'), !t ? '' : amCap
      ? (locked ? 'Locked in! Waiting for the other teams…' : 'You’re the captain ★ Pick a name, then lock it in.')
      : 'Captain ' + pname(cap) + (locked ? ' locked in your team name ✓' : ' is naming your team…'));
    $('nm-members').replaceChildren(...(t ? t.playerIds : []).map(P).filter(Boolean).map((p) => memberChip(p, t)));

    $('nm-others').replaceChildren(...S.teams.filter((o) => !t || o.id !== t.id).map((o) => {
      const d = el('div', 'nm-other' + (o.nameLocked ? ' locked' : ''));
      d.style.setProperty('--team', o.color);
      d.append(el('span', 'o-name', o.name), el('span', 'o-state', (o.nameLocked ? '✓ Locked' : 'Naming…') + ' · Capt. ' + pname(captainOf(o))));
      return d;
    }));
    show($('nm-skip'), me().isHost);
  }

  function sendTeamName(force) {
    clearTimeout(nmTimer);
    nmTimer = null;
    const t = myTeam();
    const name = $('nm-input').value.trim().slice(0, 24);
    if (!t || !name || (!force && name === t.name)) return Promise.resolve({ ok: true });
    return cmd('team:name', { name });
  }
  $('nm-input').addEventListener('input', () => {
    clearTimeout(nmTimer);
    nmTimer = setTimeout(() => sendTeamName(false), 300);
  });
  $('nm-input').addEventListener('focus', (e) => e.target.select());
  $('nm-dice').addEventListener('click', () => {
    const taken = S.teams.map((t) => t.name.toLowerCase());
    const pool = FUN_NAMES.filter((n) => taken.indexOf(n.toLowerCase()) === -1);
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (!pick) return;
    $('nm-input').value = pick;
    FX.play('tick');
    sendTeamName(false);
  });
  $('nm-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const res = await sendTeamName(false);
    if (!res.ok) return;
    const lock = await cmd('team:lock');
    if (lock.ok) FX.play('chip');
  });
  $('nm-skip').addEventListener('click', () => cmd('host:next'));

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
    board.style.setProperty('--rows', String(Math.max(1, tiles.length > 4 ? Math.ceil(tiles.length / 2) : tiles.length)));
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
    const at = T(activeTeamId());
    $('marquee').style.setProperty('--glow', at ? at.color : 'transparent');
  }

  // --- turn banner ---
  let roundEndInfo = null;
  function tchip(teamId, text) {
    const s = el('span', 'tchip', text != null ? text : tname(teamId));
    const t = T(teamId);
    if (t) s.style.setProperty('--team', t.color);
    return s;
  }
  const pchip = (pid) => tchip(P(pid) ? P(pid).teamId : null, pname(pid));
  const txt = (s, cls) => el('span', cls || null, s);
  function joinNodes(nodes, sep) {
    const out = [];
    nodes.forEach((n, i) => { if (i) out.push(txt(sep)); out.push(n); });
    return out;
  }

  function turnNodes() {
    const r = S.round, b = S.bonus;
    if (S.paused) return [txt('⏸ Paused by the host')];
    switch (S.phase) {
      case 'faceoff': {
        const f = r && r.faceoff;
        if (!f) return [txt('⚡ Face-off!')];
        if (f.status === 'answering') return [pchip(f.answeringId), txt(' buzzed first · answering')];
        const base = [pchip(f.playerIds[0]), txt(' vs ', 'dim'), pchip(f.playerIds[1])];
        if (f.status === 'countdown') return base.concat(txt(' — wait for GO', 'dim'));
        if (f.status === 'go') return base.concat(txt(' — GO! BUZZ!'));
        return base;
      }
      case 'play': {
        const tid = r.activeTeamId || r.controlTeamId;
        return [tchip(tid, tname(tid) + '’s turn'), txt(' · ' + pname(r.currentTyperId) + ' is answering')];
      }
      case 'steal': {
        const st = r.steal;
        if (st && st.status === 'answering') {
          const sp = P(st.stealerId);
          return [tchip(sp && sp.teamId, tname(sp && sp.teamId) + ' steals!'), txt(' · ' + pname(st.stealerId) + ' is answering')];
        }
        return [txt('🚨 STEAL! ')].concat(joinNodes((st ? st.teamIds : []).map((id) => tchip(id)), ' & '), txt(' buzz in!'));
      }
      case 'round_end':
        if (roundEndInfo && roundEndInfo.teamId) return [tchip(roundEndInfo.teamId), txt(' banks ' + rb(roundEndInfo.points != null ? roundEndInfo.points : r.pot * r.multiplier) + '!')];
        return [txt('Round complete')];
      case 'bonus_bet': return [txt(b && b.betsRevealed ? 'Bets are in!' : '🤫 Captains are placing secret bets…')];
      case 'bonus_play': {
        const my = me().teamId;
        const bt = b && b.teams ? b.teams[my] : null;
        if (!bt) return [txt('Bonus round: 3 guesses per team')];
        if (bt.guessCount >= 3) return [tchip(my), txt(' · all 3 guesses in. Fingers crossed!')];
        if (myTurn()) return [tchip(my), txt(' · your guess! ' + (bt.guessCount + 1) + ' of 3')];
        return [tchip(my), txt(' · ' + pname(bt.currentTyperId) + ' is guessing (' + (bt.guessCount + 1) + '/3)')];
      }
      case 'bonus_reveal': return [txt('🌙 The bonus board is revealed!')];
      default: return [];
    }
  }

  function renderTurn() {
    const at = T(activeTeamId());
    const bar = $('turn');
    if (at) bar.style.setProperty('--team', at.color); else bar.style.removeProperty('--team');
    $('turn-text').replaceChildren(...turnNodes());
  }

  function myTurn() {
    if (!S || S.paused) return false;
    if (ANSWER_PHASES.indexOf(S.phase) !== -1 && S.round) return S.round.currentTyperId === me().id;
    if (S.phase === 'bonus_play' && S.bonus && S.bonus.teams) {
      const bt = S.bonus.teams[me().teamId];
      return !!bt && bt.currentTyperId === me().id && bt.guessCount < 3;
    }
    return false;
  }
  let wasMyTurn = false;
  function renderYourTurn() {
    const on = myTurn();
    const t = myTeam();
    const bar = $('yourturn');
    if (t) bar.style.setProperty('--team', t.color);
    show(bar, on);
    if (on && !wasMyTurn) { FX.play('turn'); announce('Your turn!'); }
    wasMyTurn = on;
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
    if (e.key === 'Escape') { closeSheet(); $('howto').classList.remove('open'); }
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

    const answerPhase = ANSWER_PHASES.indexOf(S.phase) !== -1;
    const mine = answerPhase && !!r && r.currentTyperId === me().id && !S.paused;
    show($('answer-form'), mine);
    if (mine && !answerWasShown) { $('answer-input').value = ''; setTimeout(() => $('answer-input').focus(), 0); }
    answerWasShown = mine;
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
    const myTeamId = me().teamId;

    $('chips').replaceChildren(...S.teams.map((t) => {
      const v = b.bets ? b.bets[t.id] : null;
      const c = el('div', 'bet-chip' + (b.betsRevealed ? ' glow' : '') + (t.id === myTeamId ? ' mine' : ''));
      c.style.setProperty('--team', t.color);
      c.append(el('span', 'chip-team', t.name), el('span', 'chip-val mono', v != null ? rb(v) : '?'));
      c.appendChild(el('span', 'chip-cap', 'Capt. ' + pname(b.captains ? b.captains[t.id] : null)));
      return c;
    }));

    const betting = S.phase === 'bonus_bet';
    show($('bet-area'), betting);
    if (betting) {
      const captain = b.captains && b.captains[myTeamId] === me().id;
      const t = T(myTeamId);
      const max = Math.max(t ? t.score : 0, 100);
      show($('bet-form'), captain && !b.betsRevealed);
      if (captain) {
        $('bet-range').max = String(max);
        $('bet-num').max = String(max);
        if (betInitFor !== b.question) {
          betInitFor = b.question;
          const start = b.bets && b.bets[myTeamId] != null ? b.bets[myTeamId] : 0;
          $('bet-range').value = $('bet-num').value = String(start);
        }
      }
      const mineBet = b.bets ? b.bets[myTeamId] : null;
      setText($('bet-note'), captain
        ? (mineBet != null ? 'Locked: ' + rb(mineBet) + ' (change it until bets are revealed)' : 'Max ' + rb(max) + '. Land 2+ guesses to win +1.5×; miss and lose it.')
        : 'Captain ' + pname(b.captains ? b.captains[myTeamId] : null) + ' is betting…' + (mineBet != null ? ' Bet: ' + rb(mineBet) : ''));
    }

    const playing = S.phase === 'bonus_play';
    show($('bguess-area'), playing);
    const bt = b.teams ? b.teams[myTeamId] : null;
    if (playing && bt) {
      const gs = bt.guesses || [];
      const slots = [0, 1, 2].map((i) => {
        const g = gs[i];
        if (!g) return el('li', 'empty', 'Guess ' + (i + 1));
        const li = el('li', g.correct === true ? 'hit' : g.correct === false ? 'miss' : '');
        li.appendChild(el('span', null, g.text));
        if (typeof g.correct === 'boolean') li.appendChild(el('span', 'mark', g.correct ? '✓' : '✕'));
        return li;
      });
      $('bguess-list').replaceChildren(...slots);
      const mine = myTurn();
      show($('bguess-form'), mine);
      if (mine && !bguessWasShown) setTimeout(() => $('bguess-input').focus(), 0);
      bguessWasShown = mine;
      $('bother').replaceChildren(...S.teams.filter((t) => t.id !== myTeamId).map((t) => {
        const o = b.teams[t.id];
        const li = el('li', null, t.name + ': ' + (o ? o.guessCount : 0) + '/3');
        li.style.setProperty('--team', t.color);
        return li;
      }));
    } else {
      bguessWasShown = false;
    }

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

  // --- side panels: opponents (left), your team + ridge climb (right), phone pills ---
  let sheetTeam = null;
  function renderSides() {
    const my = me().teamId;
    renderTeamCards($('opponents'), S.teams.filter((t) => t.id !== my));
    renderTeamCards($('myteam'), S.teams.filter((t) => t.id === my));

    const at = activeTeamId();
    const ordered = S.teams.filter((t) => t.id === my).concat(S.teams.filter((t) => t.id !== my));
    $('pills').replaceChildren(...ordered.map((t) => {
      const b = el('button', 'pill' + (t.id === my ? ' mine' : '') + (t.id === at ? ' active' : ''));
      b.type = 'button';
      b.style.setProperty('--team', t.color);
      b.setAttribute('aria-label', t.name + ', ' + rb(t.score) + (t.id === my ? ', your team' : '') + '. Show members');
      b.append(el('span', 'sw'), el('span', 'pname', t.name), el('span', 'pval', rb(t.score)));
      if (t.id === my) b.appendChild(el('span', 'tag you', 'YOU'));
      b.addEventListener('click', () => { sheetTeam = t.id; renderSheet(); });
      return b;
    }));
    renderSheet();
  }
  function renderSheet() {
    const t = sheetTeam && S && T(sheetTeam);
    show($('sheet'), !!t);
    if (t) renderTeamCards($('sheet-body'), [t]);
  }
  function closeSheet() { sheetTeam = null; show($('sheet'), false); }
  $('sheet-close').addEventListener('click', closeSheet);
  $('sheet').addEventListener('click', (e) => { if (e.target === e.currentTarget) closeSheet(); });

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
      const pt = path.getPointAtLength((Math.max(0, t.score) / leader) * len);
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

  // --- host bar ---
  function renderHostbar() {
    const host = me().isHost;
    show($('hostbar'), host);
    if (!host) return;
    const ph = S.phase;
    const live = ['faceoff', 'play', 'steal', 'bonus_bet', 'bonus_play'].indexOf(ph) !== -1;
    show($('h-pause'), live);
    setText($('h-pause'), S.paused ? 'Resume' : 'Pause');
    show($('h-skip'), ANSWER_PHASES.indexOf(ph) !== -1);
    show($('h-accept'), !!(S.round && S.round.canAccept) && ANSWER_PHASES.indexOf(ph) !== -1);
    show($('h-next'), ph === 'round_end' || ph === 'bonus_reveal');
    $('h-roster').replaceChildren(...S.players.map(rosterChip));
  }
  $('h-pause').addEventListener('click', () => cmd(S.paused ? 'host:resume' : 'host:pause'));
  $('h-skip').addEventListener('click', async () => {
    if (await askConfirm({ title: 'Skip this question?', body: 'A new question is drawn for this round. No points are awarded.', ok: 'Skip', icon: '⏭' })) cmd('host:skip');
  });
  $('h-accept').addEventListener('click', () => cmd('host:accept'));
  $('h-next').addEventListener('click', () => cmd('host:next'));
  $('h-end').addEventListener('click', async () => {
    if (await askConfirm({ title: 'End the game?', body: 'Jump straight to the final scores and podium. This can’t be undone.', ok: 'End game', icon: '🏁', danger: true })) cmd('host:end');
  });

  // --- last guess toast ---
  let lastGuessKey = null;
  function renderLastGuess() {
    const g = S.round && S.round.lastGuess;
    const k = g ? [S.round.number, S.round.question, g.playerId, g.text, g.correct, g.rank].join('|') : null;
    if (k === lastGuessKey) return;
    const first = lastGuessKey === null && !gotFirstState;
    lastGuessKey = k;
    if (!g || first) return;
    const said = g.text ? ': “' + g.text + '”' : ' ran out of time ⏱';
    toast((g.correct ? '✓ ' : '✕ ') + pname(g.playerId) + said, g.correct ? 'good' : 'bad');
  }

  function renderGame() {
    $('v-game').dataset.phase = S.phase;
    const bonus = S.phase.indexOf('bonus') === 0;
    const r = S.round, b = S.bonus;
    if (bonus) {
      setText($('q-cat'), 'Bonus round');
      show($('q-mult'), false);
      setText($('q-text'), b ? b.question : '');
    } else {
      setText($('q-cat'), r ? pretty(r.category || '') : '');
      show($('q-mult'), !!r && r.multiplier > 1);
      setText($('q-text'), r ? r.question : '');
    }
    renderBoard();
    renderStrikesPot();
    renderTurn();
    renderAction();
    renderBonus();
    renderYourTurn();
    renderSides();
    renderScores();
    renderHostbar();
    renderLastGuess();
  }

  // ---------- timers + game clock (rAF) ----------
  const ARC = 2 * Math.PI * 19;
  const rings = [...document.querySelectorAll('[data-timer]')];
  rings.forEach((r) => { r.querySelector('.t-arc').style.strokeDasharray = String(ARC); });
  const remOf = (endsAt) => Math.max(0, S.paused ? endsAt - S.serverNow : endsAt - (Date.now() + offset));
  function tickTimer() {
    requestAnimationFrame(tickTimer);
    const t = S && S.timer;
    const on = !!t && ['lobby', 'game_over'].indexOf(S.phase) === -1;
    const rem = on ? remOf(t.endsAt) : 0;
    const dur = on ? (t.duration || t.durationMs || 0) : 0;
    const frac = dur > 0 ? Math.min(1, rem / dur) : 0;
    for (const box of rings) {
      if (box.hidden === on) box.hidden = !on;
      if (!on || box.offsetParent === null) continue;
      box.querySelector('.t-arc').style.strokeDashoffset = (ARC * (1 - frac)).toFixed(2);
      setText(box.querySelector('.t-num'), S.paused ? 'II' : Math.ceil(rem / 1000));
      box.classList.toggle('urgent', rem < 5000 && !S.paused);
    }

    const gc = S && S.gameClock;
    const clk = $('hdr-clock');
    const showClock = !!gc && ['lobby', 'game_over'].indexOf(S.phase) === -1;
    if (clk.hidden === showClock) clk.hidden = !showClock;
    if (!showClock) return;
    const left = remOf(gc.endsAt);
    const s = Math.ceil(left / 1000);
    setText(clk, Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'));
    clk.classList.toggle('low', left < 60000 && !S.paused);
    clk.classList.toggle('paused', !!S.paused);
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
        if (st.phase === 'round_end') { renderTurn(); renderBoard(); }
        FX.chase($('marquee'));
        FX.play('chip');
        break;
      case 'start': case 'teams': FX.play('go'); roundEndInfo = null; break;
      case 'teamName': if (d.teamId !== me().teamId) FX.play('tick'); break;
      case 'teamLocked': FX.play('chip'); announce(tname(d.teamId) + ' locked in'); break;
      case 'namingDone': FX.play('go'); break;
      case 'betsRevealed': FX.play('chip'); announce('Bets revealed'); break;
      case 'bonusGuess': FX.play('tick'); break;
      case 'bonusReveal': FX.play('drumroll'); setTimeout(() => FX.chase($('marquee')), 2000); break;
      case 'gameOver': FX.play('fanfare'); FX.confetti(); announce('Game over'); break;
      case 'kicked': if (d.playerId === me().id) leaveRoom('You were removed by the host.'); break;
      case 'left': if (d.name) toast(d.name + ' left the room'); break;
      case 'hostChanged': toast(pname(st.hostId) + ' is now the host'); break;
      case 'join': if (d.playerId && d.playerId !== me().id && st.phase === 'lobby') FX.play('tick'); break;
      default: break;
    }
    if (ev.type !== 'roundEnd' && st.phase !== 'round_end') roundEndInfo = null;
  }

  render();
})();
