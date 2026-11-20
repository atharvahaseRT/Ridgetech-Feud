'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createRoom, addPlayer, reconnect, disconnect, handle, snapshotFor } = require('./game');

// Regular questions have <5 answers so the cheese question is always the bonus.
const QS = [
  { id: 'q1', category: 'zoo', q: 'Name a zoo animal', answers: [{ text: 'Wombat', points: 50 }, { text: 'Narwhal', points: 30 }, { text: 'Platypus', points: 20 }] },
  { id: 'q2', category: 'gems', q: 'Name a gem', answers: [{ text: 'Sapphire', points: 45 }, { text: 'Emerald', points: 35 }, { text: 'Topaz', points: 20 }] },
  { id: 'q3', category: 'space', q: 'Name a planet', answers: [{ text: 'Jupiter', points: 40 }, { text: 'Saturn', points: 30 }, { text: 'Neptune', points: 20 }, { text: 'Mercury', points: 10 }] },
  { id: 'q4', category: 'music', q: 'Name an instrument', answers: [{ text: 'Violin', points: 50 }, { text: 'Trombone', points: 30 }, { text: 'Xylophone', points: 20 }] },
  { id: 'q5', category: 'food', q: 'Name a cheese', answers: [
    { text: 'Cheddar', points: 30 }, { text: 'Brie', points: 25 }, { text: 'Gouda', points: 20 },
    { text: 'Mozzarella', points: 15 }, { text: 'Parmesan', points: 7 }, { text: 'Feta', points: 3 },
  ] },
  // Filler so the bank meets the 15-question minimum; own category so tests can deselect it.
  ...Array.from({ length: 12 }, (_, i) => ({ id: 'f' + i, category: 'filler', q: 'Filler question ' + i, answers: [
    { text: 'Fillanswer' + i + 'a', points: 40 }, { text: 'Fillanswer' + i + 'b', points: 30 },
    { text: 'Fillanswer' + i + 'c', points: 20 }, { text: 'Fillanswer' + i + 'd', points: 10 },
  ] })),
];
const ALL_TEXTS = QS.flatMap((q) => q.answers.map((a) => a.text));

function fakeClock() {
  let t = 1000;
  const queue = [];
  return {
    now: () => t,
    schedule(ms, fn) {
      const e = { at: t + ms, fn, on: true };
      queue.push(e);
      return () => { e.on = false; };
    },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = queue.filter((e) => e.on && e.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        t = due.at;
        due.on = false;
        due.fn();
      }
      t = end;
    },
  };
}

function seeded(seed) {
  return () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
}

function setup(n, settings) {
  const clock = fakeClock();
  const events = [];
  const room = createRoom({ code: 'TEST', questions: QS, now: clock.now, schedule: clock.schedule, random: seeded(7), onChange: (r) => events.push(r.lastEvent) });
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(addPlayer(room, { name: 'P' + i, token: 'tok' + i }).player.id);
  if (settings) ok(handle(room, room.hostId, 'host:settings', settings));
  return { room, clock, ids, events };
}

function ok(res) { assert.strictEqual(res.ok, true, res.error); return res; }
function bad(res) { assert.strictEqual(res.ok, false); return res; }
const unrevealed = (room) => room.round.answers.filter((a) => !a.revealed).map((a) => a.text);
const teamOf = (room, id) => room.players.find((p) => p.id === id).teamId;
const typer = (room) => snapshotFor(room, room.hostId).round.currentTyperId;
const toGo = (clock) => clock.advance(3500); // 2 s countdown + 0.5-1.5 s random delay
const clockLeft = (room) => { const s = snapshotFor(room, room.hostId); return s.gameClock.endsAt - s.serverNow; };
// host:start then skip team naming -> round 1 faceoff.
function begin(room) {
  ok(handle(room, room.hostId, 'host:start', {}));
  assert.strictEqual(room.phase, 'team_naming');
  ok(handle(room, room.hostId, 'host:next', {}));
  assert.strictEqual(room.phase, 'faceoff');
}
function advanceUntil(clock, pred, maxMs = 600000) {
  for (let t = 0; t < maxMs && !pred(); t += 250) clock.advance(250);
  assert.ok(pred(), 'condition never reached');
}

// Faceoff: player at index `who` buzzes first and hits -> their team controls.
function winFaceoff(room, clock, who = 0) {
  toGo(clock);
  const pid = room.round.faceoff.playerIds[who];
  ok(handle(room, pid, 'buzz', { reactionMs: 200 }));
  clock.advance(250);
  ok(handle(room, pid, 'answer', { text: unrevealed(room)[0] }));
  assert.strictEqual(room.phase, 'play');
  return teamOf(room, pid);
}

function assertNoHiddenLeaks(room) {
  const hidden = ALL_TEXTS.filter((t) => !(room.round?.answers || []).some((a) => a.revealed && a.text === t)
    && !(room.bonus?.answers || []).some((a) => a.revealed && a.text === t));
  for (const p of room.players) {
    const json = JSON.stringify(snapshotFor(room, p.id));
    for (const t of hidden) assert.ok(!json.includes(t), `snapshot for ${p.id} leaks "${t}" in ${room.phase}`);
  }
}

test('full game: faceoff fairness, play, steal, scoring, bonus, game over', () => {
  const { room, clock, ids, events } = setup(4, { gameMinutes: 5, teamCount: 2 });
  begin(room);
  assert.strictEqual(room.teams.length, 2);
  assert.deepStrictEqual(room.teams.map((t) => t.playerIds.length), [2, 2]);
  assert.strictEqual(room.round.isFinal, false);
  assert.strictEqual(snapshotFor(room, ids[0]).round.total, null);
  assert.ok(events.some((e) => e.type === 'start') && events.some((e) => e.type === 'teams'));
  assertNoHiddenLeaks(room);

  // ---- Round 1: false start + 250 ms buzz window, then steal succeeds ----
  const [a, b] = room.round.faceoff.playerIds;
  const outsider = ids.find((id) => id !== a && id !== b);
  bad(handle(room, outsider, 'buzz', { reactionMs: 100 }));
  assert.strictEqual(ok(handle(room, a, 'buzz', { reactionMs: 100 })).falseStart, true);
  toGo(clock);
  assert.strictEqual(room.round.faceoff.status, 'go');
  assert.strictEqual(events.at(-1).type, 'go');
  ok(handle(room, a, 'buzz', { reactionMs: 100 })); // effective 1100 after penalty
  ok(handle(room, b, 'buzz', { reactionMs: 300 }));
  clock.advance(250);
  assert.strictEqual(room.round.faceoff.buzzWinnerId, b);
  assert.strictEqual(room.round.faceoff.answeringId, b);
  bad(handle(room, a, 'answer', { text: 'Wombat' })); // not a's turn yet
  ok(handle(room, b, 'answer', { text: 'nonsense guess' }));
  assert.strictEqual(room.round.faceoff.answeringId, a);
  assert.strictEqual(room.round.strikes, 0);
  ok(handle(room, a, 'answer', { text: unrevealed(room)[0] }));
  const control = teamOf(room, a);
  assert.strictEqual(room.phase, 'play');
  assert.strictEqual(room.round.controlTeamId, control);
  assertNoHiddenLeaks(room);

  const t1 = typer(room);
  const nonTyper = ids.find((id) => id !== t1);
  bad(handle(room, nonTyper, 'answer', { text: 'whatever' }));
  ok(handle(room, t1, 'answer', { text: unrevealed(room)[0] }));
  assert.strictEqual(events.at(-1).type, 'reveal');
  assert.notStrictEqual(typer(room), t1); // rotated within team
  assert.strictEqual(teamOf(room, typer(room)), control);
  for (let i = 1; i <= 3; i++) {
    ok(handle(room, typer(room), 'answer', { text: 'zzzz' + i }));
    if (i < 3) assert.strictEqual(room.round.strikes, i);
  }
  assert.strictEqual(room.phase, 'steal');
  const stealer = ids.find((id) => teamOf(room, id) !== control);
  bad(handle(room, ids.find((id) => teamOf(room, id) === control), 'buzz', { reactionMs: 200 }));
  ok(handle(room, stealer, 'buzz', { reactionMs: 400 }));
  clock.advance(250);
  assert.strictEqual(room.round.steal.stealerId, stealer);
  const pot1 = room.round.pot;
  const left = unrevealed(room)[0];
  const leftPts = room.round.answers.find((x) => x.text === left).points;
  ok(handle(room, stealer, 'answer', { text: left }));
  assert.strictEqual(room.phase, 'round_end');
  const stealTeam = teamOf(room, stealer);
  const score = (id) => room.teams.find((t) => t.id === id).score;
  assert.strictEqual(score(stealTeam), pot1 + leftPts);
  assert.strictEqual(score(control), 0);
  assert.ok(events.some((e) => e.type === 'stealResult' && e.data.success === true));

  // ---- Round 2: nobody buzzes (8 s fallback), steal fails ----
  bad(handle(room, ids[1], 'host:next', {}));
  ok(handle(room, room.hostId, 'host:next', {}));
  assert.strictEqual(room.round.number, 2);
  assert.strictEqual(room.round.multiplier, 1);
  const before = room.teams.map((t) => t.score);
  toGo(clock);
  clock.advance(8000);
  const w = room.round.faceoff.buzzWinnerId;
  assert.ok(room.round.faceoff.playerIds.includes(w));
  ok(handle(room, w, 'answer', { text: unrevealed(room)[0] }));
  const control2 = room.round.controlTeamId;
  for (let i = 0; i < 3; i++) ok(handle(room, typer(room), 'answer', { text: 'nope' + i }));
  const stealer2 = ids.find((id) => teamOf(room, id) !== control2);
  ok(handle(room, stealer2, 'buzz', { reactionMs: 500 }));
  clock.advance(250);
  ok(handle(room, stealer2, 'answer', { text: 'still wrong' }));
  assert.strictEqual(room.phase, 'round_end');
  assert.ok(room.round.answers.every((x) => x.revealed));
  assert.ok(room.round.answers.some((x) => x.missed));
  const pot2 = room.round.pot;
  room.teams.forEach((t, i) => assert.strictEqual(t.score, before[i] + (t.id === control2 ? pot2 : 0)));

  // ---- Round 3: < 165 s left -> final x2 round, control clears the board ----
  room.clock.endsAt = clock.now() + 120000;
  ok(handle(room, room.hostId, 'host:next', {}));
  assert.strictEqual(room.round.isFinal, true);
  assert.strictEqual(room.round.multiplier, 2);
  const before3 = room.teams.map((t) => t.score);
  const control3 = winFaceoff(room, clock);
  while (room.phase === 'play') ok(handle(room, typer(room), 'answer', { text: unrevealed(room)[0] }));
  assert.strictEqual(room.phase, 'round_end');
  const total3 = room.round.answers.reduce((s, x) => s + x.points, 0);
  room.teams.forEach((t, i) => assert.strictEqual(t.score, before3[i] + (t.id === control3 ? total3 * 2 : 0)));

  // ---- Bonus ----
  const [ta, tb] = room.teams;
  tb.score = 40; // force a floor-at-0 case
  const scoreA = ta.score;
  ok(handle(room, room.hostId, 'host:next', {}));
  assert.strictEqual(room.phase, 'bonus_bet');
  assertNoHiddenLeaks(room);
  const capA = room.bonus.captains[ta.id];
  const capB = room.bonus.captains[tb.id];
  const memberA = ta.playerIds.find((id) => id !== capA);
  bad(handle(room, memberA, 'bonus:bet', { amount: 10 }));
  bad(handle(room, capB, 'bonus:bet', { amount: 101 })); // max(40, 100)
  bad(handle(room, capB, 'bonus:bet', { amount: 1.5 }));
  const betA = Math.max(scoreA, 100);
  ok(handle(room, capA, 'bonus:bet', { amount: betA }));
  assert.strictEqual(snapshotFor(room, capA).bonus.bets[ta.id], betA);
  assert.strictEqual(snapshotFor(room, capB).bonus.bets[ta.id], null); // hidden from other team
  ok(handle(room, capB, 'bonus:bet', { amount: 100 }));
  assert.strictEqual(room.bonus.betsRevealed, true);
  assert.strictEqual(snapshotFor(room, capB).bonus.bets[ta.id], betA);
  clock.advance(3000);
  assert.strictEqual(room.phase, 'bonus_play');
  assertNoHiddenLeaks(room);

  const bonusTyper = (t) => room.bonus.teams[t.id].typerId;
  bad(handle(room, ta.playerIds.find((id) => id !== bonusTyper(ta)), 'bonus:answer', { text: 'Brie' }));
  ok(handle(room, bonusTyper(ta), 'bonus:answer', { text: 'cheddar' }));
  ok(handle(room, bonusTyper(ta), 'bonus:answer', { text: 'brie' }));
  const snapB = JSON.stringify(snapshotFor(room, tb.playerIds[0]));
  assert.ok(!snapB.includes('cheddar') && !snapB.includes('brie'), 'other team sees guess texts');
  assert.strictEqual(snapshotFor(room, tb.playerIds[0]).bonus.teams[ta.id].guessCount, 2);
  assert.strictEqual(snapshotFor(room, ta.playerIds[0]).bonus.teams[ta.id].guesses[0].text, 'cheddar');
  ok(handle(room, bonusTyper(ta), 'bonus:answer', { text: 'velveeta' }));
  for (const g of ['swiss', 'american', 'string']) ok(handle(room, bonusTyper(tb), 'bonus:answer', { text: g }));
  assert.strictEqual(room.phase, 'bonus_reveal');
  assert.deepStrictEqual(room.bonus.results[ta.id], { hits: 2, won: true, delta: Math.round(1.5 * betA) });
  assert.strictEqual(ta.score, scoreA + Math.round(1.5 * betA));
  assert.deepStrictEqual(room.bonus.results[tb.id], { hits: 0, won: false, delta: -40 });
  assert.strictEqual(tb.score, 0);
  assert.ok(snapshotFor(room, capB).bonus.board.every((t) => t.revealed && t.text));

  ok(handle(room, room.hostId, 'host:next', {}));
  assert.strictEqual(room.phase, 'game_over');
  const over = events.at(-1);
  assert.strictEqual(over.type, 'gameOver');
  assert.strictEqual(over.data.standings[0].teamId, ta.id);
  assert.ok(over.data.mvp.hits && over.data.mvp.fastest);
  assert.ok(events.every((e, i) => i === 0 || e.id > events[i - 1].id));

  ok(handle(room, room.hostId, 'host:playAgain', {}));
  assert.strictEqual(room.phase, 'lobby');
  assert.strictEqual(room.teams.length, 0);
  assert.ok(room.players.every((p) => p.teamId === null && p.hits === 0));
});

test('non-host cannot use host controls; validation', () => {
  const { room, ids } = setup(3);
  for (const t of ['host:settings', 'host:addQuestion', 'host:removeQuestion', 'host:start', 'host:next', 'host:pause',
    'host:resume', 'host:skip', 'host:accept', 'host:kick', 'host:end', 'host:playAgain']) {
    assert.strictEqual(handle(room, ids[1], t, { playerId: ids[2] }).error, 'Host only');
  }
  assert.deepStrictEqual(room.settings, { teamCount: 'auto', gameMinutes: 7, categories: ['zoo', 'gems', 'space', 'music', 'food', 'filler'] });
  bad(handle(room, ids[0], 'host:settings', { gameMinutes: 6 }));
  bad(handle(room, ids[0], 'host:settings', { gameMinutes: '7' }));
  bad(handle(room, ids[0], 'host:settings', { teamCount: 5 }));
  ok(handle(room, ids[0], 'host:settings', { teamCount: 3, gameMinutes: 10, answerSeconds: 5, rounds: 8 })); // unknown keys ignored
  assert.deepStrictEqual(snapshotFor(room, ids[1]).settings.gameMinutes, 10);
  assert.strictEqual(snapshotFor(room, ids[1]).settings.teamCount, 3);
  bad(handle(room, ids[0], 'nope', {}));
  bad(handle(room, 'ghost', 'buzz', {}));
  bad(handle(room, ids[0], 'host:settings', 'string'));

  bad(handle(room, ids[0], 'host:addQuestion', { q: 'x', answers: [{ text: 'a', points: 1 }] }));
  bad(handle(room, ids[0], 'host:addQuestion', { q: 'x', answers: [{ text: 'a', points: 0 }, { text: 'b', points: 5 }] }));
  bad(handle(room, ids[0], 'host:addQuestion', { q: 'x'.repeat(141), answers: [{ text: 'a', points: 1 }, { text: 'b', points: 5 }] }));
  const { id } = ok(handle(room, ids[0], 'host:addQuestion', { q: 'Name a Secretquestion', answers: [{ text: 'Hushanswer', points: 60 }, { text: 'b', points: 40 }] }));
  assert.strictEqual(snapshotFor(room, ids[0]).customQuestions.length, 1);
  assert.deepStrictEqual(snapshotFor(room, ids[1]).customQuestions, []);
  assert.ok(!JSON.stringify(snapshotFor(room, ids[0])).includes('Hushanswer'));
  assert.strictEqual(snapshotFor(room, ids[1]).round, null);

  bad(addPlayer(room, { name: 'p1' })); // case-insensitive duplicate
  bad(addPlayer(room, { name: '   ' }));
  bad(addPlayer(room, { name: 'x'.repeat(21) }));
  ok(handle(room, ids[0], 'host:removeQuestion', { id }));
  assert.strictEqual(room.customQuestions.length, 0);
});

test('custom questions are mixed into the deck without repeats', () => {
  const { room, ids } = setup(2);
  ok(handle(room, ids[0], 'host:addQuestion', { q: 'Name a custom thing', answers: [{ text: 'Alpha', points: 60 }, { text: 'Beta', points: 40 }] }));
  begin(room);
  const seen = [];
  const n = QS.length; // all regular questions + 1 custom - 1 bonus
  for (let r = 0; r < n; r++) {
    seen.push(room.round.question);
    if (r < n - 1) ok(handle(room, ids[0], 'host:skip', {}));
  }
  assert.strictEqual(new Set(seen).size, n);
  assert.ok(seen.includes('Name a custom thing'));
  assert.ok(!seen.includes('Name a cheese'));
});

test('team count auto, mid-game join goes to smallest team', () => {
  for (const [n, teams] of [[2, 2], [8, 2], [9, 3], [18, 3], [19, 4]]) {
    const { room, ids } = setup(n);
    ok(handle(room, ids[0], 'host:start', {}));
    assert.strictEqual(room.phase, 'team_naming');
    assert.strictEqual(room.teams.length, teams, `${n} players`);
    assert.deepStrictEqual(room.teams.map((t) => t.name), ['Ridge Runners', 'Summit Seekers', 'Peak Performers', 'Basecamp Bandits'].slice(0, teams));
  }
  const { room, ids } = setup(5);
  ok(handle(room, ids[0], 'host:start', {}));
  const small = room.teams.reduce((a, b) => (b.playerIds.length < a.playerIds.length ? b : a));
  const late = ok(addPlayer(room, { name: 'Late' })).player;
  assert.strictEqual(late.teamId, small.id);
  assert.strictEqual(small.playerIds.at(-1), late.id);
});

test('pause/resume preserves remaining time', () => {
  const { room, clock, ids } = setup(4);
  begin(room);
  winFaceoff(room, clock);
  const t = typer(room);
  clock.advance(5000);
  bad(handle(room, ids[0], 'host:resume', {}));
  ok(handle(room, room.hostId, 'host:pause', {}));
  bad(handle(room, t, 'answer', { text: 'x' }));
  clock.advance(60000);
  const snap = snapshotFor(room, ids[0]);
  assert.strictEqual(snap.paused, true);
  assert.strictEqual(snap.timer.endsAt - snap.serverNow, 7000);
  assert.strictEqual(room.round.strikes, 0);
  ok(handle(room, room.hostId, 'host:resume', {}));
  clock.advance(6999);
  assert.strictEqual(room.round.strikes, 0);
  clock.advance(1);
  assert.strictEqual(room.round.strikes, 1);
  assert.notStrictEqual(typer(room), t);
});

test('reconnect by token keeps team; host passes after 30 s', () => {
  const { room, clock, ids, events } = setup(4);
  begin(room);
  const team = teamOf(room, ids[2]);
  disconnect(room, ids[2]);
  assert.strictEqual(room.players.find((p) => p.id === ids[2]).connected, false);
  assert.strictEqual(reconnect(room, 'tok2').id, ids[2]);
  assert.strictEqual(teamOf(room, ids[2]), team);
  assert.strictEqual(reconnect(room, 'bogus'), null);

  disconnect(room, ids[0]);
  clock.advance(29000);
  assert.strictEqual(room.hostId, ids[0]);
  clock.advance(1000);
  assert.strictEqual(room.hostId, ids[1]); // longest connected
  assert.strictEqual(events.at(-1).type, 'hostChanged');
  assert.strictEqual(snapshotFor(room, ids[1]).you.isHost, true);
});

test('host accept, skip and kick', () => {
  const { room, clock, ids, events } = setup(4);
  begin(room);
  winFaceoff(room, clock);
  const t = typer(room);
  const target = unrevealed(room)[0];
  ok(handle(room, t, 'answer', { text: target.slice(0, 2) + 'qq' }));
  assert.strictEqual(room.round.strikes, 1);
  assert.strictEqual(snapshotFor(room, room.hostId).round.canAccept, true);
  assert.strictEqual(snapshotFor(room, ids.find((id) => id !== room.hostId)).round.canAccept, false);
  ok(handle(room, room.hostId, 'host:accept', {}));
  assert.strictEqual(room.round.strikes, 0);
  assert.ok(room.round.answers.find((a) => a.text === target).revealed);
  assert.strictEqual(room.round.lastGuess.correct, true);
  bad(handle(room, room.hostId, 'host:accept', {}));

  const n = room.round.number;
  const q = room.round.question;
  ok(handle(room, room.hostId, 'host:skip', {}));
  assert.strictEqual(room.round.number, n);
  assert.notStrictEqual(room.round.question, q);
  assert.strictEqual(room.round.pot, 0);
  assert.strictEqual(room.phase, 'faceoff');

  bad(handle(room, room.hostId, 'host:kick', { playerId: room.hostId }));
  ok(handle(room, room.hostId, 'host:kick', { playerId: ids[3] }));
  assert.strictEqual(events.at(-1).type, 'kicked');
  assert.ok(!room.teams.some((tm) => tm.playerIds.includes(ids[3])));
  assert.strictEqual(snapshotFor(room, ids[3]).you.name, null);
  bad(handle(room, ids[3], 'buzz', { reactionMs: 200 }));
  ok(handle(room, room.hostId, 'host:end', {}));
  assert.strictEqual(room.phase, 'game_over');
});

// ---------- v2: team naming ----------

test('team naming: captain only, uniqueness, repeatable until locked, lock-all advances', () => {
  const { room, ids, events } = setup(4, { teamCount: 2 });
  bad(handle(room, ids[0], 'team:name', { name: 'Early' })); // lobby
  ok(handle(room, ids[0], 'host:start', {}));
  assert.strictEqual(room.phase, 'team_naming');
  assert.strictEqual(snapshotFor(room, ids[0]).gameClock, null); // naming time doesn't count
  const [ta, tb] = room.teams;
  const snapTeams = snapshotFor(room, ids[0]).teams;
  assert.strictEqual(snapTeams[0].captainId, ta.playerIds[0]);
  assert.strictEqual(snapTeams[0].nameLocked, false);
  const capA = ta.playerIds[0];
  const capB = tb.playerIds[0];

  bad(handle(room, ta.playerIds[1], 'team:name', { name: 'Not Captain' }));
  bad(handle(room, ta.playerIds[1], 'team:lock', {}));
  bad(handle(room, capA, 'team:name', { name: '   ' }));
  bad(handle(room, capA, 'team:name', { name: 'x'.repeat(25) }));
  ok(handle(room, capA, 'team:name', { name: '  Chai & Chill  ' }));
  assert.deepStrictEqual(events.at(-1), { id: events.at(-1).id, type: 'teamName', data: { teamId: ta.id, name: 'Chai & Chill' } });
  assert.strictEqual(snapshotFor(room, capB).teams[0].name, 'Chai & Chill');
  bad(handle(room, capB, 'team:name', { name: 'CHAI & chill' })); // taken, case-insensitive
  ok(handle(room, capA, 'team:name', { name: 'Mate Masters' })); // repeatable
  ok(handle(room, capB, 'team:name', { name: 'Chai & Chill' })); // freed up
  ok(handle(room, capA, 'team:lock', {}));
  assert.strictEqual(events.at(-1).type, 'teamLocked');
  bad(handle(room, capA, 'team:name', { name: 'Too Late' }));
  bad(handle(room, capA, 'team:lock', {}));
  assert.strictEqual(room.phase, 'team_naming');
  ok(handle(room, capB, 'team:lock', {}));
  assert.strictEqual(room.phase, 'faceoff');
  assert.strictEqual(room.round.number, 1);
  assert.ok(events.some((e) => e.type === 'namingDone'));
  assert.deepStrictEqual(room.teams.map((t) => t.name), ['Mate Masters', 'Chai & Chill']);
  assert.strictEqual(clockLeft(room), 7 * 60000);
  bad(handle(room, capA, 'team:name', { name: 'Again' }));
});

test('team naming: timer expiry and host:next start round 1; disconnected captain falls back', () => {
  const a = setup(4, { teamCount: 2 });
  ok(handle(a.room, a.ids[0], 'host:start', {}));
  const team = a.room.teams[0];
  const [cap, mate] = team.playerIds;
  disconnect(a.room, cap);
  assert.strictEqual(snapshotFor(a.room, mate).teams[0].captainId, mate);
  ok(handle(a.room, mate, 'team:name', { name: 'Gaucho Gang' }));
  reconnect(a.room, a.room.players.find((p) => p.id === cap).token);
  bad(handle(a.room, mate, 'team:name', { name: 'Back Off' }));
  a.clock.advance(29999);
  assert.strictEqual(a.room.phase, 'team_naming');
  a.clock.advance(1);
  assert.strictEqual(a.room.phase, 'faceoff');
  assert.ok(a.room.teams.every((t) => t.nameLocked));
  assert.strictEqual(team.name, 'Gaucho Gang');
  assert.deepStrictEqual(a.room.teams.slice(1).map((t) => t.name), ['Summit Seekers']); // unnamed -> default

  const b = setup(3);
  ok(handle(b.room, b.ids[0], 'host:start', {}));
  bad(handle(b.room, b.ids[1], 'host:next', {}));
  ok(handle(b.room, b.room.hostId, 'host:next', {}));
  assert.strictEqual(b.room.phase, 'faceoff');
  b.clock.advance(30000); // stale naming timer must not restart round 1
  assert.strictEqual(b.room.round.number, 1);
});

// ---------- v2: game clock ----------

test('clock: 5-min game of timeouts flags a final x2 round, then bonus', () => {
  const { room, clock } = setup(4, { gameMinutes: 5, teamCount: 2 });
  begin(room);
  const rounds = [];
  advanceUntil(clock, () => {
    if (room.round && room.phase === 'faceoff' && rounds.at(-1)?.number !== room.round.number) {
      rounds.push({ number: room.round.number, isFinal: room.round.isFinal, multiplier: room.round.multiplier, left: clockLeft(room) });
    }
    return room.phase === 'bonus_bet';
  });
  assert.strictEqual(rounds[0].isFinal, false);
  const final = rounds.at(-1);
  assert.ok(rounds.length >= 2);
  assert.strictEqual(final.isFinal, true);
  assert.strictEqual(final.multiplier, 2);
  assert.ok(final.left < 165000 && final.left >= 90000);
  assert.ok(rounds.slice(0, -1).every((r) => !r.isFinal && r.multiplier === 1 && r.left >= 165000));
});

test('clock: < 90 s left after a round goes straight to bonus (round never interrupted)', () => {
  const { room, clock } = setup(4, { gameMinutes: 5, teamCount: 2 });
  begin(room);
  advanceUntil(clock, () => room.round?.number === 2);
  assert.strictEqual(room.round.isFinal, false);
  clock.advance(60000);
  ok(handle(room, room.hostId, 'host:skip', {})); // restart round 2 late: stays non-final
  assert.strictEqual(room.round.isFinal, false);
  advanceUntil(clock, () => room.phase === 'round_end');
  assert.ok(clockLeft(room) < 90000);
  ok(handle(room, room.hostId, 'host:next', {}));
  assert.strictEqual(room.phase, 'bonus_bet');
});

test('clock: hits 0 mid-round without interrupting; pause freezes clock', () => {
  const { room, clock } = setup(4, { gameMinutes: 5, teamCount: 2 });
  begin(room);
  assert.deepStrictEqual(snapshotFor(room, room.hostId).gameClock.durationMs, 300000);
  clock.advance(1000);
  assert.strictEqual(clockLeft(room), 299000);
  ok(handle(room, room.hostId, 'host:pause', {}));
  clock.advance(60000);
  assert.strictEqual(clockLeft(room), 299000);
  ok(handle(room, room.hostId, 'host:resume', {}));
  clock.advance(1000);
  assert.strictEqual(clockLeft(room), 298000);
  room.clock.endsAt = clock.now() + 1000;
  const n = room.round.number;
  clock.advance(2000);
  assert.strictEqual(clockLeft(room), 0);
  assert.strictEqual(room.round.number, n);
  assert.ok(['faceoff', 'play', 'steal'].includes(room.phase));
});

test('clock: hard cap of 12 rounds, 12th is final', () => {
  const { room } = setup(4, { gameMinutes: 10, teamCount: 2 });
  begin(room);
  room.round.number = 10;
  ok(handle(room, room.hostId, 'host:end', {}));
  room.phase = 'round_end';
  room.clock = { durationMs: 600000, endsAt: room.now() + 600000, remainingMs: null };
  ok(handle(room, room.hostId, 'host:next', {}));
  assert.strictEqual(room.round.number, 11);
  assert.strictEqual(room.round.isFinal, false);
  room.phase = 'round_end';
  ok(handle(room, room.hostId, 'host:next', {}));
  assert.strictEqual(room.round.number, 12);
  assert.strictEqual(room.round.isFinal, true);
  room.phase = 'round_end';
  ok(handle(room, room.hostId, 'host:next', {}));
  assert.strictEqual(room.phase, 'bonus_bet');
});

// ---------- v2: turn info / round_end ----------

test('nextTyperId predicts the actual next typer, skipping disconnected; activeTeamId', () => {
  const { room, clock, ids } = setup(6, { teamCount: 2 });
  begin(room);
  const control = winFaceoff(room, clock);
  const teamIdx = room.teams.findIndex((t) => t.id === control);
  const snap = () => snapshotFor(room, ids[0]);
  assert.strictEqual(snap().round.activeTeamId, control);
  const cur = typer(room);
  const next = snap().teams[teamIdx].nextTyperId;
  assert.ok(next && next !== cur);
  ok(handle(room, cur, 'answer', { text: 'zzz' }));
  assert.strictEqual(typer(room), next);
  const predicted = snap().teams[teamIdx].nextTyperId;
  disconnect(room, predicted);
  const skipped = snap().teams[teamIdx].nextTyperId;
  assert.notStrictEqual(skipped, predicted);
  ok(handle(room, typer(room), 'answer', { text: 'zzz2' }));
  assert.strictEqual(typer(room), skipped);
  ok(handle(room, typer(room), 'answer', { text: 'zzz3' }));
  assert.strictEqual(room.phase, 'steal');
  assert.strictEqual(snap().round.activeTeamId, null);
});

test('round_end auto-advances after 5 s; early host:next does not double-advance', () => {
  const { room, clock } = setup(4, { teamCount: 2 });
  begin(room);
  winFaceoff(room, clock);
  while (room.phase === 'play') ok(handle(room, typer(room), 'answer', { text: unrevealed(room)[0] }));
  assert.strictEqual(room.phase, 'round_end');
  assert.strictEqual(snapshotFor(room, room.hostId).timer.duration, 5000);
  clock.advance(4999);
  assert.strictEqual(room.phase, 'round_end');
  clock.advance(1);
  assert.strictEqual(room.round.number, 2);
  assert.strictEqual(room.phase, 'faceoff');

  winFaceoff(room, clock);
  while (room.phase === 'play') ok(handle(room, typer(room), 'answer', { text: unrevealed(room)[0] }));
  ok(handle(room, room.hostId, 'host:next', {}));
  assert.strictEqual(room.round.number, 3);
  clock.advance(5000);
  assert.strictEqual(room.round.number, 3);
});

test('playAgain resets naming and clock', () => {
  const { room, ids } = setup(4, { teamCount: 2 });
  begin(room);
  ok(handle(room, room.hostId, 'host:end', {}));
  ok(handle(room, room.hostId, 'host:playAgain', {}));
  assert.strictEqual(snapshotFor(room, ids[0]).gameClock, null);
  ok(handle(room, room.hostId, 'host:start', {}));
  assert.strictEqual(room.phase, 'team_naming');
  assert.ok(room.teams.every((t) => !t.nameLocked && t.captainId));
  assert.strictEqual(snapshotFor(room, ids[0]).gameClock, null);
});

// ---------- v2: categories ----------

test('categories: validation, counts, too-small selection rejects start', () => {
  const { room, ids } = setup(4);
  assert.deepStrictEqual(snapshotFor(room, ids[1]).categoryCounts, { zoo: 1, gems: 1, space: 1, music: 1, food: 1, filler: 12 });
  bad(handle(room, ids[0], 'host:settings', { categories: [] }));
  bad(handle(room, ids[0], 'host:settings', { categories: ['zoo', 'nope'] }));
  bad(handle(room, ids[0], 'host:settings', { categories: 'zoo' }));
  bad(handle(room, ids[0], 'host:settings', { categories: [1] }));
  ok(handle(room, ids[0], 'host:settings', { categories: ['zoo', 'zoo', 'food', 'filler'] }));
  assert.deepStrictEqual(room.settings.categories, ['zoo', 'food', 'filler']);
  const res = bad(handle(room, ids[0], 'host:start', {})); // 14 questions
  assert.strictEqual(res.error, 'Selected categories have only 14 questions — pick more (min 15)');
  ok(handle(room, ids[0], 'host:settings', { categories: ['zoo', 'gems', 'space', 'music', 'filler'] })); // 16, but no bonus question
  assert.match(bad(handle(room, ids[0], 'host:start', {})).error, /bonus/);
  ok(handle(room, ids[0], 'host:addQuestion', { q: 'Name a custom thing', answers: [{ text: 'Alpha', points: 60 }, { text: 'Beta', points: 40 }] }));
  ok(handle(room, ids[0], 'host:settings', { categories: ['zoo', 'food', 'filler'] })); // 14 + 1 custom = 15
  ok(handle(room, ids[0], 'host:start', {}));
});

test('categories: unselected categories never appear in a full game', () => {
  const { room, clock, ids } = setup(4, { teamCount: 2, gameMinutes: 10 });
  ok(handle(room, ids[0], 'host:addQuestion', { q: 'Name a custom thing', answers: [{ text: 'Alpha', points: 60 }, { text: 'Beta', points: 40 }] }));
  ok(handle(room, ids[0], 'host:settings', { categories: ['zoo', 'food', 'filler'] }));
  begin(room);
  const cats = new Set();
  advanceUntil(clock, () => {
    if (room.round && ['faceoff', 'play', 'steal', 'round_end'].includes(room.phase)) cats.add(room.round.category);
    return room.phase === 'bonus_bet';
  });
  assert.ok(cats.size >= 2);
  for (const c of cats) assert.ok(['zoo', 'filler', 'custom'].includes(c), c);
  assert.strictEqual(room.bonus.question, 'Name a cheese');
});

test('player:leave removes the player; host leaving passes host on', () => {
  const { room, ids } = setup(4);
  const host = room.hostId;
  const other = ids.find((id) => id !== host);
  // Non-host leaves in the lobby.
  ok(handle(room, other, 'player:leave', {}));
  assert.ok(!room.players.some((p) => p.id === other));
  assert.strictEqual(room.lastEvent.type, 'left');
  bad(handle(room, other, 'player:leave', {})); // already gone

  // Mid-game: host leaves, is removed from their team, host transfers to a remaining player.
  begin(room);
  const hostTeam = room.teams.find((t) => t.playerIds.includes(host));
  ok(handle(room, host, 'player:leave', {}));
  assert.ok(!hostTeam.playerIds.includes(host));
  assert.notStrictEqual(room.hostId, host);
  assert.ok(room.players.some((p) => p.id === room.hostId));
  assert.strictEqual(room.lastEvent.type, 'hostChanged');
  // The new host can run the game.
  ok(handle(room, room.hostId, 'host:pause', {}));
});
