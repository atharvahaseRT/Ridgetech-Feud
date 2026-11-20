'use strict';
// Pure game state machine (spec §3, §6). No socket code: time comes from injected now()/schedule().

const { match, closest } = require('./matcher');

const TEAM_NAMES = ['Ridge Runners', 'Summit Seekers', 'Peak Performers', 'Basecamp Bandits'];
const TEAM_COLORS = ['#ff6b35', '#2ec4b6', '#e9c46a', '#c77dff'];
const GAME_MINUTES = [5, 7, 10];
// Fixed timers (v2 spec §2, ADR-002).
const TEAM_NAMING_MS = 30000;
const COUNTDOWN_MS = 2000;
const BUZZ_WINDOW_MS = 250;
const NO_BUZZ_MS = 8000;
const ANSWER_MS = 12000;
const STEAL_MS = 8000;
const ROUND_END_AUTO_MS = 5000;
const FALSE_START_MS = 1000;
const BET_MS = 15000;
const BET_REVEAL_MS = 3000;
const BONUS_MS = 30000;
const BONUS_RESERVE_MS = 90000;
const FINAL_ROUND_THRESHOLD_MS = 165000;
const MAX_ROUNDS = 12;
const MIN_DECK = 15;
const HOST_GRACE_MS = 30000;
const MAX_PLAYERS = 30;
const MAX_CUSTOM = 50;
const TIMED_PHASES = ['team_naming', 'faceoff', 'play', 'steal', 'round_end', 'bonus_bet', 'bonus_play'];
const ROUND_PHASES = ['faceoff', 'play', 'steal'];

const OK = { ok: true };
const fail = (error) => ({ ok: false, error });

function defaultSchedule(ms, fn) {
  // A throwing timer callback must not crash the process (and every other room with it).
  const t = setTimeout(() => {
    try { fn(); } catch (e) { console.error('timer callback error:', e); }
  }, ms);
  return () => clearTimeout(t);
}

function createRoom({ code, questions = [], now = Date.now, schedule = defaultSchedule, onChange = () => {}, random = Math.random }) {
  const categoryCounts = {};
  for (const q of questions) categoryCounts[q.category] = (categoryCounts[q.category] || 0) + 1;
  return {
    code, questions, now, schedule, onChange, random, categoryCounts,
    phase: 'lobby', paused: false, hostId: null,
    settings: { teamCount: 'auto', gameMinutes: 7, categories: Object.keys(categoryCounts) },
    players: [], teams: [], pairs: [],
    customQuestions: [], nextCustomId: 1, nextPlayerId: 1,
    pool: [], deck: [], bonusQuestion: null, round: null, bonus: null,
    timer: null, clock: null, undo: null,
    lastEvent: null, eventId: 0, updatedAt: now(),
  };
}

// ---------- helpers ----------

const byId = (room, id) => room.players.find((p) => p.id === id);
const teamById = (room, id) => room.teams.find((t) => t.id === id);

function emit(room, type, data = {}) {
  room.lastEvent = { id: ++room.eventId, type, data };
  room.updatedAt = room.now();
  room.onChange(room);
}

function shuffle(room, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(room.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Index of the next player in a team rotation, skipping disconnected players (falls back to anyone).
function rotationIdx(room, team, key) {
  const ids = team.playerIds;
  if (!ids.length) return -1;
  for (let k = 0; k < ids.length; k++) {
    const i = (team[key] + k) % ids.length;
    if (byId(room, ids[i])?.connected) return i;
  }
  return team[key] % ids.length;
}

function take(room, team, key) {
  const i = rotationIdx(room, team, key);
  if (i < 0) return null;
  team[key] = i + 1;
  return team.playerIds[i];
}

// Same rotation as take() without advancing it, so "up next" can't drift from who actually types.
function peek(room, team, key) {
  const i = rotationIdx(room, team, key);
  return i < 0 ? null : team.playerIds[i];
}

// Captain is fixed at the draw; while they're disconnected the next connected teammate acts for them.
function actingCaptain(room, team) {
  const ids = team.playerIds;
  const start = Math.max(0, ids.indexOf(team.captainId));
  for (let k = 0; k < ids.length; k++) {
    const id = ids[(start + k) % ids.length];
    if (byId(room, id)?.connected) return id;
  }
  return ids.includes(team.captainId) ? team.captainId : ids[0] ?? null;
}

const cleanText = (s, max) => (typeof s === 'string' && s.trim().length >= 1 && s.trim().length <= max ? s.trim() : null);

// ---------- timer (one per room; pause freezes it) ----------

function arm(room, t, ms) {
  t.endsAt = room.now() + ms;
  t.remaining = null;
  t.cancel = room.schedule(ms, () => {
    if (room.timer !== t) return;
    room.timer = null;
    t.fn();
  });
}

function setTimer(room, ms, fn, visible = true) {
  clearTimer(room);
  const t = { duration: ms, visible, fn, endsAt: null, remaining: null, cancel: null };
  room.timer = t;
  if (room.paused) { t.remaining = ms; t.endsAt = room.now() + ms; } else arm(room, t, ms);
}

function clearTimer(room) {
  if (room.timer?.cancel) room.timer.cancel();
  room.timer = null;
}

// ---------- game clock (informational; never interrupts a round) ----------

function startClock(room) {
  const durationMs = room.settings.gameMinutes * 60000;
  room.clock = { durationMs, endsAt: room.now() + durationMs, remainingMs: room.paused ? durationMs : null };
}

function clockRemaining(room) {
  const c = room.clock;
  if (!c) return 0;
  return c.remainingMs !== null ? c.remainingMs : Math.max(0, c.endsAt - room.now());
}

// ---------- players ----------

function addPlayer(room, { name, token } = {}) {
  const clean = cleanText(name, 20);
  if (!clean) return fail('Name must be 1-20 characters');
  if (room.players.length >= MAX_PLAYERS) return fail('Room is full');
  if (room.players.some((p) => p.name.toLowerCase() === clean.toLowerCase())) return fail('Name already taken');
  const player = {
    id: 'p' + room.nextPlayerId++, token, name: clean, teamId: null, connected: true,
    hits: 0, bestReactionMs: null, connectedSince: room.now(), disconnectedAt: null,
  };
  room.players.push(player);
  if (!room.hostId) room.hostId = player.id;
  if (room.teams.length) {
    const team = room.teams.reduce((a, b) => (b.playerIds.length < a.playerIds.length ? b : a));
    team.playerIds.push(player.id);
    player.teamId = team.id;
  }
  emit(room, 'join', { playerId: player.id, name: player.name, teamId: player.teamId });
  return { ok: true, player };
}

function reconnect(room, token) {
  const p = token && room.players.find((x) => x.token === token);
  if (!p) return null;
  if (!p.connected) { p.connected = true; p.connectedSince = room.now(); p.disconnectedAt = null; }
  checkHost(room) || emit(room, 'update', { reason: 'reconnect', playerId: p.id });
  return p;
}

// ponytail: a removed current typer/faceoff player just times out (counts as a miss).
function removePlayer(room, target) {
  room.players = room.players.filter((x) => x !== target);
  for (const t of room.teams) t.playerIds = t.playerIds.filter((id) => id !== target.id);
}

function disconnect(room, playerId) {
  const p = byId(room, playerId);
  if (!p || !p.connected) return;
  p.connected = false;
  p.disconnectedAt = room.now();
  if (room.hostId === p.id) room.schedule(HOST_GRACE_MS, () => checkHost(room));
  emit(room, 'update', { reason: 'disconnect', playerId });
}

// Transfer host if the current host has been gone >= 30 s. Returns true if it emitted.
function checkHost(room) {
  const host = byId(room, room.hostId);
  if (host?.connected || (host && room.now() - host.disconnectedAt < HOST_GRACE_MS)) return false;
  const next = room.players.filter((p) => p.connected).sort((a, b) => a.connectedSince - b.connectedSince)[0];
  if (!next) return false;
  room.hostId = next.id;
  emit(room, 'hostChanged', { hostId: next.id });
  return true;
}

// ---------- game start / rounds ----------

function teamCountFor(room) {
  const n = room.players.length;
  const count = room.settings.teamCount === 'auto' ? (n <= 8 ? 2 : n <= 18 ? 3 : 4) : room.settings.teamCount;
  return Math.min(count, n);
}

// Built-in questions from the selected categories + all custom questions.
const poolFor = (room) => [...room.customQuestions, ...room.questions.filter((q) => room.settings.categories.includes(q.category))];

function startGame(room) {
  const count = teamCountFor(room);
  room.teams = Array.from({ length: count }, (_, i) => ({
    id: 't' + (i + 1), name: TEAM_NAMES[i], color: TEAM_COLORS[i], score: 0, playerIds: [], typerIdx: 0, faceoffIdx: 0,
    captainId: null, nameLocked: false,
  }));
  shuffle(room, [...room.players]).forEach((p, i) => {
    const team = room.teams[i % count];
    team.playerIds.push(p.id);
    p.teamId = team.id;
  });
  for (const t of room.teams) t.captainId = t.playerIds[0];
  room.pairs = [];
  for (let a = 0; a < count; a++) for (let b = a + 1; b < count; b++) room.pairs.push([a, b]);

  room.pool = poolFor(room);
  const all = shuffle(room, [...room.pool]);
  const bi = all.findIndex((q) => q.answers.length >= 5);
  room.bonusQuestion = bi >= 0 ? all.splice(bi, 1)[0] : null;
  room.deck = all;
  room.bonus = null;
  room.round = null;
  room.clock = null;
  room.phase = 'team_naming';
  setTimer(room, TEAM_NAMING_MS, () => finishNaming(room));
  emit(room, 'start');
  emit(room, 'teams', { teams: room.teams.map((t) => ({ id: t.id, playerIds: [...t.playerIds] })) });
}

function finishNaming(room) {
  clearTimer(room);
  for (const t of room.teams) t.nameLocked = true;
  emit(room, 'namingDone');
  startClock(room);
  startRound(room, 1, false);
}

// Clock-driven scheduling: < 90 s left -> bonus; < 165 s left -> final x2 round; hard cap 12 rounds.
function nextRound(room) {
  const r = room.round;
  room.undo = null;
  const rem = clockRemaining(room);
  if (r.isFinal || r.number >= MAX_ROUNDS || rem < BONUS_RESERVE_MS) return startBonus(room);
  const number = r.number + 1;
  startRound(room, number, number === MAX_ROUNDS || rem < FINAL_ROUND_THRESHOLD_MS);
}

function drawQuestion(room) {
  if (!room.deck.length) {
    // ponytail: bank exhausted -> reshuffle everything; repeats only once all questions are used.
    room.deck = shuffle(room, room.pool.filter((q) => q !== room.bonusQuestion));
  }
  return room.deck.pop();
}

function startRound(room, number, isFinal) {
  const q = drawQuestion(room);
  if (!q) return startBonus(room);
  const [ta, tb] = room.pairs[(number - 1) % room.pairs.length].map((i) => room.teams[i]);
  room.phase = 'faceoff';
  room.undo = null;
  room.round = {
    number, total: null, isFinal, multiplier: isFinal ? 2 : 1,
    category: q.category || 'custom', question: q.q,
    answers: [...q.answers].sort((a, b) => b.points - a.points).map((a) => ({ text: a.text, points: a.points, aliases: a.aliases || [], revealed: false, missed: false })),
    strikes: 0, pot: 0, controlTeamId: null,
    faceoff: { playerIds: [take(room, ta, 'faceoffIdx'), take(room, tb, 'faceoffIdx')], teamIds: [ta.id, tb.id], status: 'countdown', buzzWinnerId: null, answeringId: null },
    typerId: null, steal: null, lastGuess: null, buzzes: [], penalties: {},
  };
  setTimer(room, COUNTDOWN_MS, () => setTimer(room, 500 + room.random() * 1000, () => faceoffGo(room), false));
  emit(room, 'countdown', { round: number });
}

function faceoffGo(room) {
  const r = room.round;
  r.faceoff.status = 'go';
  r.buzzes = [];
  setTimer(room, NO_BUZZ_MS, () => {
    const ids = r.faceoff.playerIds.filter(Boolean);
    const winner = ids[Math.floor(room.random() * ids.length)];
    r.faceoff.buzzWinnerId = winner;
    faceoffAnswerer(room, winner);
    emit(room, 'buzz', { playerId: winner, reactionMs: null });
  });
  emit(room, 'go');
}

function faceoffAnswerer(room, playerId) {
  const r = room.round;
  r.faceoff.status = 'answering';
  r.faceoff.answeringId = playerId;
  r.typerId = playerId;
  setTimer(room, ANSWER_MS, () => applyAnswer(room, playerId, ''));
}

function startPlay(room, teamId) {
  const r = room.round;
  room.phase = 'play';
  r.faceoff.status = 'done';
  r.controlTeamId = teamId;
  nextTyper(room);
  emit(room, 'control', { teamId });
}

function nextTyper(room) {
  const r = room.round;
  const team = teamById(room, r.controlTeamId);
  r.typerId = team ? take(room, team, 'typerIdx') : null;
  const id = r.typerId;
  setTimer(room, ANSWER_MS, () => applyAnswer(room, id, ''));
}

function startSteal(room) {
  const r = room.round;
  room.phase = 'steal';
  r.typerId = null;
  r.buzzes = [];
  r.steal = { teamIds: room.teams.filter((t) => t.id !== r.controlTeamId).map((t) => t.id), status: 'go', stealerId: null, stealerTeamId: null };
  setTimer(room, STEAL_MS, () => {
    emit(room, 'stealResult', { teamId: null, success: false, correct: false });
    endRound(room, r.controlTeamId);
  });
  emit(room, 'steal', { teamIds: r.steal.teamIds });
}

function resolveBuzz(room) {
  const r = room.round;
  const best = r.buzzes.reduce((a, b) => (b.effective < a.effective ? b : a));
  if (room.phase === 'faceoff') {
    r.faceoff.buzzWinnerId = best.playerId;
    faceoffAnswerer(room, best.playerId);
  } else {
    r.steal.status = 'answering';
    r.steal.stealerId = best.playerId;
    r.steal.stealerTeamId = byId(room, best.playerId)?.teamId ?? null;
    r.typerId = best.playerId;
    setTimer(room, STEAL_MS, () => applyAnswer(room, best.playerId, ''));
  }
  emit(room, 'buzz', { playerId: best.playerId, reactionMs: best.reactionMs });
}

function reveal(room, idx, playerId) {
  const r = room.round;
  const a = r.answers[idx];
  a.revealed = true;
  r.pot += a.points;
  const p = byId(room, playerId);
  if (p) p.hits++;
  return { rank: idx + 1, text: a.text, points: a.points, playerId };
}

// Core answer handling for faceoff/play/steal. text '' = timeout. forcedIdx = host accept.
function applyAnswer(room, playerId, text, forcedIdx = null) {
  const r = room.round;
  const phase = room.phase;
  clearTimer(room);
  if (text && forcedIdx === null) {
    room.undo = {
      playerId, text, phase,
      round: structuredClone(r),
      teams: structuredClone(room.teams),
      hits: Object.fromEntries(room.players.map((p) => [p.id, p.hits])),
    };
  }
  const idx = forcedIdx ?? (text ? match(text, r.answers, r.answers.map((a) => a.revealed)) : -1);
  const correct = idx >= 0;
  if (correct || !text) room.undo = null;
  r.lastGuess = { playerId, text, correct, rank: correct ? idx + 1 : null };
  const hit = correct ? reveal(room, idx, playerId) : null;
  const allRevealed = r.answers.every((a) => a.revealed);

  if (phase === 'faceoff') {
    const f = r.faceoff;
    const teamOf = (id) => f.teamIds[f.playerIds.indexOf(id)];
    if (hit) {
      emit(room, 'reveal', hit);
      if (allRevealed) { r.controlTeamId = teamOf(playerId); return endRound(room, r.controlTeamId); }
      return startPlay(room, teamOf(playerId));
    }
    if (f.answeringId === f.buzzWinnerId) {
      faceoffAnswerer(room, f.playerIds.find((id) => id !== f.buzzWinnerId));
      return emit(room, 'strike', { playerId, strikes: 0, faceoff: true });
    }
    emit(room, 'strike', { playerId, strikes: 0, faceoff: true });
    return startPlay(room, teamOf(f.buzzWinnerId));
  }

  if (phase === 'play') {
    if (hit) {
      if (allRevealed) { emit(room, 'reveal', hit); return endRound(room, r.controlTeamId); }
      nextTyper(room);
      return emit(room, 'reveal', hit);
    }
    r.strikes++;
    if (r.strikes >= 3) {
      emit(room, 'strike', { playerId, strikes: r.strikes });
      return startSteal(room);
    }
    nextTyper(room);
    return emit(room, 'strike', { playerId, strikes: r.strikes });
  }

  if (phase === 'steal') {
    const teamId = r.steal.stealerTeamId;
    if (hit) {
      emit(room, 'reveal', hit);
      emit(room, 'stealResult', { teamId, success: true, correct: true });
      return endRound(room, teamId);
    }
    emit(room, 'stealResult', { teamId, success: false, correct: false });
    return endRound(room, r.controlTeamId);
  }
}

function endRound(room, winnerTeamId) {
  const r = room.round;
  clearTimer(room);
  for (const a of r.answers) if (!a.revealed) { a.revealed = true; a.missed = true; }
  const points = r.pot * r.multiplier;
  const team = teamById(room, winnerTeamId);
  if (team) team.score += points;
  r.winnerTeamId = winnerTeamId;
  r.typerId = null;
  room.phase = 'round_end';
  setTimer(room, ROUND_END_AUTO_MS, () => nextRound(room));
  emit(room, 'roundEnd', { teamId: winnerTeamId, winnerTeamId, points, pot: r.pot, multiplier: r.multiplier });
}

// ---------- bonus ----------

function startBonus(room) {
  const q = room.bonusQuestion;
  if (!q) return gameOver(room);
  room.round = null;
  room.undo = null;
  room.phase = 'bonus_bet';
  const answers = [...q.answers].sort((a, b) => b.points - a.points).slice(0, 5)
    .map((a) => ({ text: a.text, points: a.points, aliases: a.aliases || [], revealed: false, missed: false }));
  room.bonus = { captains: {}, bets: {}, betsRevealed: false, question: q.q, answers, teams: {}, results: null };
  for (const t of room.teams) {
    room.bonus.captains[t.id] = take(room, t, 'typerIdx');
    room.bonus.bets[t.id] = null;
    room.bonus.teams[t.id] = { guesses: [], typerId: null };
  }
  setTimer(room, BET_MS, () => revealBets(room));
  emit(room, 'update', { reason: 'bonus' });
}

function revealBets(room) {
  const b = room.bonus;
  for (const id of Object.keys(b.bets)) if (b.bets[id] === null) b.bets[id] = 0;
  b.betsRevealed = true;
  setTimer(room, BET_REVEAL_MS, () => startBonusPlay(room), false);
  emit(room, 'betsRevealed', { bets: { ...b.bets } });
}

function startBonusPlay(room) {
  room.phase = 'bonus_play';
  for (const t of room.teams) room.bonus.teams[t.id].typerId = take(room, t, 'typerIdx');
  setTimer(room, BONUS_MS, () => bonusReveal(room));
  emit(room, 'update', { reason: 'bonusPlay' });
}

function bonusReveal(room) {
  const b = room.bonus;
  clearTimer(room);
  room.phase = 'bonus_reveal';
  b.answers.forEach((a, i) => {
    a.revealed = true;
    a.missed = !Object.values(b.teams).some((t) => t.guesses.some((g) => g.idx === i));
  });
  b.results = {};
  for (const t of room.teams) {
    const hits = b.teams[t.id].guesses.filter((g) => g.correct).length;
    const bet = b.bets[t.id] || 0;
    const won = hits >= 2;
    const before = t.score;
    t.score = Math.max(0, t.score + (won ? Math.round(1.5 * bet) : -bet));
    b.results[t.id] = { hits, won, delta: t.score - before };
  }
  for (const t of Object.values(b.teams)) t.typerId = null;
  emit(room, 'bonusReveal', { results: b.results });
}

function gameOver(room) {
  clearTimer(room);
  room.phase = 'game_over';
  room.paused = false;
  room.undo = null;
  room.clock = null;
  if (room.round) room.round.typerId = null;
  const best = (key, cmp) => room.players.filter((p) => p[key] !== null && p[key] > 0).sort(cmp)[0]?.id ?? null;
  emit(room, 'gameOver', {
    standings: [...room.teams].sort((a, b) => b.score - a.score).map((t) => ({ teamId: t.id, score: t.score })),
    mvp: {
      hits: best('hits', (a, b) => b.hits - a.hits),
      fastest: best('bestReactionMs', (a, b) => a.bestReactionMs - b.bestReactionMs),
    },
  });
}

// ---------- event handlers ----------

const handlers = {
  'host:settings'(room, p, d) {
    if (room.phase !== 'lobby') return fail('Settings only in lobby');
    const next = { ...room.settings };
    if (d.teamCount !== undefined) {
      if (!['auto', 2, 3, 4].includes(d.teamCount)) return fail('Invalid teamCount');
      next.teamCount = d.teamCount;
    }
    if (d.gameMinutes !== undefined) {
      if (!GAME_MINUTES.includes(d.gameMinutes)) return fail('gameMinutes must be 5, 7 or 10');
      next.gameMinutes = d.gameMinutes;
    }
    if (d.categories !== undefined) {
      if (!Array.isArray(d.categories) || !d.categories.every((c) => typeof c === 'string' && Object.hasOwn(room.categoryCounts, c))) return fail('Invalid categories');
      if (!d.categories.length) return fail('Pick at least one category');
      next.categories = [...new Set(d.categories)];
    }
    room.settings = next;
    emit(room, 'update', { reason: 'settings' });
  },

  'host:addQuestion'(room, p, d) {
    if (room.phase !== 'lobby') return fail('Questions only in lobby');
    if (room.customQuestions.length >= MAX_CUSTOM) return fail('Too many custom questions');
    const q = cleanText(d.q, 140);
    if (!q) return fail('Question must be 1-140 characters');
    if (!Array.isArray(d.answers) || d.answers.length < 2 || d.answers.length > 8) return fail('Need 2-8 answers');
    const answers = [];
    for (const a of d.answers) {
      const text = cleanText(a?.text, 40);
      if (!text) return fail('Answer text must be 1-40 characters');
      if (!Number.isInteger(a.points) || a.points < 1 || a.points > 100) return fail('Points must be 1-100');
      answers.push({ text, points: a.points, aliases: [] });
    }
    answers.sort((a, b) => b.points - a.points);
    const question = { id: 'c' + room.nextCustomId++, category: 'custom', q, answers };
    room.customQuestions.push(question);
    emit(room, 'update', { reason: 'questions' });
    return { ok: true, id: question.id };
  },

  'host:removeQuestion'(room, p, d) {
    if (room.phase !== 'lobby') return fail('Questions only in lobby');
    const i = room.customQuestions.findIndex((q) => q.id === d.id);
    if (i < 0) return fail('No such question');
    room.customQuestions.splice(i, 1);
    emit(room, 'update', { reason: 'questions' });
  },

  'host:start'(room) {
    if (room.phase !== 'lobby') return fail('Already started');
    if (room.players.length < 2) return fail('Need at least 2 players');
    const pool = poolFor(room);
    if (pool.length < MIN_DECK) return fail(`Selected categories have only ${pool.length} questions — pick more (min ${MIN_DECK})`);
    if (!pool.some((q) => q.answers.length >= 5)) return fail('Selected categories have no bonus question (5+ answers) — pick more');
    startGame(room);
  },

  'host:next'(room) {
    if (room.phase === 'team_naming') return finishNaming(room);
    if (room.phase === 'round_end') return nextRound(room);
    if (room.phase === 'bonus_reveal') return gameOver(room);
    return fail('Nothing to advance');
  },

  'host:pause'(room) {
    if (!TIMED_PHASES.includes(room.phase) || room.paused) return fail('Cannot pause now');
    room.paused = true;
    const t = room.timer;
    if (t) {
      t.remaining = Math.max(0, t.endsAt - room.now());
      t.cancel?.();
      t.cancel = null;
    }
    if (room.clock) room.clock.remainingMs = clockRemaining(room);
    emit(room, 'update', { reason: 'pause' });
  },

  'host:resume'(room) {
    if (!room.paused) return fail('Not paused');
    room.paused = false;
    if (room.timer) arm(room, room.timer, room.timer.remaining);
    if (room.clock) { room.clock.endsAt = room.now() + room.clock.remainingMs; room.clock.remainingMs = null; }
    emit(room, 'update', { reason: 'resume' });
  },

  'host:skip'(room) {
    if (!ROUND_PHASES.includes(room.phase)) return fail('Nothing to skip');
    startRound(room, room.round.number, room.round.isFinal);
  },

  'host:accept'(room) {
    const u = room.undo;
    if (!ROUND_PHASES.concat('round_end').includes(room.phase) || !u || room.round?.lastGuess?.correct !== false) return fail('Nothing to accept');
    const idx = closest(u.text, u.round.answers, u.round.answers.map((a) => a.revealed));
    if (idx < 0) return OK;
    clearTimer(room);
    room.phase = u.phase;
    room.round = u.round;
    room.teams = u.teams;
    for (const pl of room.players) if (u.hits[pl.id] !== undefined) pl.hits = u.hits[pl.id];
    room.undo = null;
    applyAnswer(room, u.playerId, u.text, idx);
  },

  'host:kick'(room, p, d) {
    const target = byId(room, d.playerId);
    if (!target) return fail('No such player');
    if (target.id === p.id) return fail('Cannot kick yourself');
    removePlayer(room, target);
    emit(room, 'kicked', { playerId: target.id, name: target.name });
  },

  // A player leaves voluntarily. If the host leaves, host passes on immediately.
  'player:leave'(room, p) {
    removePlayer(room, p);
    emit(room, 'left', { playerId: p.id, name: p.name });
    if (room.hostId === p.id && room.players.length) {
      const next = [...room.players].sort((a, b) => (b.connected - a.connected) || (a.connectedSince - b.connectedSince))[0];
      room.hostId = next.id;
      emit(room, 'hostChanged', { hostId: next.id });
    }
  },

  'host:end'(room) {
    if (room.phase === 'lobby' || room.phase === 'game_over') return fail('No game running');
    gameOver(room);
  },

  'host:playAgain'(room) {
    if (room.phase !== 'game_over') return fail('Game not over');
    clearTimer(room);
    Object.assign(room, { phase: 'lobby', paused: false, teams: [], round: null, bonus: null, pool: [], deck: [], bonusQuestion: null, undo: null, clock: null });
    for (const pl of room.players) { pl.teamId = null; pl.hits = 0; pl.bestReactionMs = null; }
    emit(room, 'update', { reason: 'playAgain' });
  },

  'team:name'(room, p, d) {
    if (room.paused) return fail('Paused');
    if (room.phase !== 'team_naming') return fail('Not naming teams now');
    const team = teamById(room, p.teamId);
    if (!team || actingCaptain(room, team) !== p.id) return fail('Only your captain can name the team');
    if (team.nameLocked) return fail('Name already locked');
    const name = cleanText(d.name, 24);
    if (!name) return fail('Team name must be 1-24 characters');
    if (room.teams.some((t) => t !== team && t.name.toLowerCase() === name.toLowerCase())) return fail('Another team has that name');
    team.name = name;
    emit(room, 'teamName', { teamId: team.id, name });
  },

  'team:lock'(room, p) {
    if (room.paused) return fail('Paused');
    if (room.phase !== 'team_naming') return fail('Not naming teams now');
    const team = teamById(room, p.teamId);
    if (!team || actingCaptain(room, team) !== p.id) return fail('Only your captain can lock the name');
    if (team.nameLocked) return fail('Name already locked');
    team.nameLocked = true;
    emit(room, 'teamLocked', { teamId: team.id });
    if (room.teams.every((t) => t.nameLocked)) finishNaming(room);
  },

  buzz(room, p, d) {
    const r = room.round;
    if (room.paused) return fail('Paused');
    if (room.phase === 'faceoff') {
      const f = r.faceoff;
      if (!f.playerIds.includes(p.id)) return fail('Not your face-off');
      if (f.status === 'countdown' || (d.early === true && f.status === 'go')) {
        r.penalties[p.id] = FALSE_START_MS;
        return { ok: true, falseStart: true };
      }
      if (f.status !== 'go') return fail('Too late');
    } else if (room.phase === 'steal') {
      if (r.steal.status !== 'go') return fail('Too late');
      if (!r.steal.teamIds.includes(p.teamId)) return fail('Your team cannot steal');
    } else {
      return fail('No buzzing now');
    }
    if (typeof d.reactionMs !== 'number' || !Number.isFinite(d.reactionMs)) return fail('Invalid reactionMs');
    if (r.buzzes.some((b) => b.playerId === p.id)) return fail('Already buzzed');
    const reactionMs = Math.min(10000, Math.max(80, Math.round(d.reactionMs)));
    const penalty = r.penalties[p.id] || 0;
    r.buzzes.push({ playerId: p.id, reactionMs, effective: reactionMs + penalty });
    if (!penalty && (p.bestReactionMs === null || reactionMs < p.bestReactionMs)) p.bestReactionMs = reactionMs;
    if (r.buzzes.length === 1) setTimer(room, BUZZ_WINDOW_MS, () => resolveBuzz(room), false);
  },

  answer(room, p, d) {
    if (room.paused) return fail('Paused');
    if (!ROUND_PHASES.includes(room.phase) || room.round.typerId !== p.id) return fail('Not your turn');
    const text = cleanText(d.text, 60);
    if (!text) return fail('Answer must be 1-60 characters');
    applyAnswer(room, p.id, text);
  },

  'bonus:bet'(room, p, d) {
    const b = room.bonus;
    if (room.paused) return fail('Paused');
    if (room.phase !== 'bonus_bet' || b.betsRevealed) return fail('Not betting now');
    if (b.captains[p.teamId] !== p.id) return fail('Only your captain can bet');
    const max = Math.max(teamById(room, p.teamId).score, 100);
    if (!Number.isInteger(d.amount) || d.amount < 0 || d.amount > max) return fail(`Bet must be 0-${max}`);
    b.bets[p.teamId] = d.amount;
    if (Object.values(b.bets).every((v) => v !== null)) return revealBets(room);
    emit(room, 'update', { reason: 'bet', teamId: p.teamId });
  },

  'bonus:answer'(room, p, d) {
    const b = room.bonus;
    if (room.paused) return fail('Paused');
    if (room.phase !== 'bonus_play') return fail('Not bonus time');
    const bt = b.teams[p.teamId];
    if (!bt || bt.typerId !== p.id || bt.guesses.length >= 3) return fail('Not your turn');
    const text = cleanText(d.text, 60);
    if (!text) return fail('Answer must be 1-60 characters');
    const already = b.answers.map((_, i) => bt.guesses.some((g) => g.idx === i));
    const idx = match(text, b.answers, already);
    bt.guesses.push({ text, correct: idx >= 0, idx });
    if (idx >= 0) p.hits++;
    bt.typerId = bt.guesses.length < 3 ? take(room, teamById(room, p.teamId), 'typerIdx') : null;
    emit(room, 'bonusGuess', { teamId: p.teamId, guessCount: bt.guesses.length });
    if (Object.values(b.teams).every((t) => t.guesses.length >= 3)) bonusReveal(room);
  },
};

function handle(room, playerId, type, payload) {
  const p = byId(room, playerId);
  if (!p) return fail('Not in room');
  const fn = Object.hasOwn(handlers, type) ? handlers[type] : null;
  if (!fn) return fail('Unknown event');
  const data = payload ?? {};
  if (typeof data !== 'object' || Array.isArray(data)) return fail('Invalid payload');
  if (type.startsWith('host:') && room.hostId !== playerId) return fail('Host only');
  return fn(room, p, data) || OK;
}

function dispose(room) {
  clearTimer(room);
}

// ---------- snapshot ----------

const boardOf = (answers) => answers.map((a, i) => ({
  rank: i + 1, text: a.revealed ? a.text : null, points: a.revealed ? a.points : null, revealed: a.revealed, missed: a.missed,
}));

function snapshotFor(room, playerId) {
  const me = byId(room, playerId);
  const isHost = !!me && room.hostId === me.id;
  const serverNow = room.now();
  const t = room.timer;
  const r = room.round;
  const b = room.bonus;
  const c = room.clock;
  return {
    code: room.code, phase: room.phase, paused: room.paused, serverNow,
    you: { id: playerId, name: me?.name ?? null, teamId: me?.teamId ?? null, isHost },
    hostId: room.hostId,
    settings: { ...room.settings, categories: [...room.settings.categories] },
    categoryCounts: { ...room.categoryCounts },
    players: room.players.map((p) => ({
      id: p.id, name: p.name, teamId: p.teamId, connected: p.connected, isHost: p.id === room.hostId, hits: p.hits, bestReactionMs: p.bestReactionMs,
    })),
    teams: room.teams.map((x) => ({
      id: x.id, name: x.name, color: x.color, score: x.score, playerIds: [...x.playerIds],
      captainId: actingCaptain(room, x), nameLocked: x.nameLocked, nextTyperId: peek(room, x, 'typerIdx'),
    })),
    customQuestions: isHost ? room.customQuestions.map((q) => ({ id: q.id, q: q.q, answerCount: q.answers.length })) : [],
    timer: t && t.visible ? { endsAt: room.paused ? serverNow + t.remaining : t.endsAt, duration: t.duration } : null,
    gameClock: c ? { endsAt: serverNow + clockRemaining(room), durationMs: c.durationMs } : null,
    round: r && ROUND_PHASES.concat('round_end').includes(room.phase) ? {
      number: r.number, total: r.total, isFinal: r.isFinal, multiplier: r.multiplier, category: r.category, question: r.question,
      board: boardOf(r.answers),
      strikes: r.strikes, pot: r.pot, controlTeamId: r.controlTeamId,
      faceoff: { playerIds: [...r.faceoff.playerIds], teamIds: [...r.faceoff.teamIds], status: r.faceoff.status, buzzWinnerId: r.faceoff.buzzWinnerId, answeringId: r.faceoff.answeringId },
      currentTyperId: r.typerId,
      activeTeamId: r.typerId ? byId(room, r.typerId)?.teamId ?? null : null,
      steal: r.steal ? { teamIds: [...r.steal.teamIds], status: r.steal.status, stealerId: r.steal.stealerId } : null,
      lastGuess: r.lastGuess ? { ...r.lastGuess } : null,
      canAccept: isHost && !!room.undo && r.lastGuess?.correct === false,
    } : null,
    bonus: b ? {
      captains: { ...b.captains },
      bets: Object.fromEntries(Object.entries(b.bets).map(([id, v]) => [id, b.betsRevealed || id === me?.teamId ? v : null])),
      betsRevealed: b.betsRevealed,
      question: b.question,
      board: boardOf(b.answers),
      teams: Object.fromEntries(Object.entries(b.teams).map(([id, bt]) => [id, {
        guessCount: bt.guesses.length,
        currentTyperId: bt.typerId,
        guesses: id === me?.teamId ? bt.guesses.map((g) => ({ text: g.text, correct: g.correct })) : [],
      }])),
      results: b.results,
    } : null,
    lastEvent: room.lastEvent,
  };
}

module.exports = { createRoom, addPlayer, reconnect, disconnect, handle, snapshotFor, dispose, MAX_PLAYERS };
