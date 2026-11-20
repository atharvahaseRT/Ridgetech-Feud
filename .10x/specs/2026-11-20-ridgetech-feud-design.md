# Ridgetech Feud — Design Spec

**Date:** 2026-11-20 · **Feature slug:** `ridgetech-feud` · **Status:** Approved (brainstorm Q1–Q7 + architecture)

## 1. Summary
Browser-based, real-time, survey-style party game for 8–25 coworkers ("Summit Showdown" theme, Ridgetech-branded).
One link, no installs. Host also plays. 3–4 teams (auto). Typed answers with fuzzy matching. Score currency: **Ridgetech Bucks (RB$)**. Final bonus round with secret bets paying 1.5×.

## 2. Decisions from brainstorming
| # | Decision |
|---|----------|
| Q1 | Host also plays. No separate board — every screen shows the full board. Host gets extra controls. |
| Q2 | ~150 built-in questions (`server/questions.json`) + host can add custom questions in lobby (in-memory). Nobody picks the next question — random draw, no repeats within a game. Difficulty: 10th-grade/high-school everyday knowledge. |
| Q3 | Humor: PG-13 cheeky. Innuendo OK, nothing explicit. Work-event safe. |
| Q4 | Rotating typer per team — only the current typer can submit. |
| Q5 | 2-player face-off (team pairs rotate fairly); on 3 strikes, steal opens to **all** other teams via buzz race. Team count: `auto` (≤8 players→2, 9–18→3, ≥19→4), host can override 2/3/4. |
| Q6 | Bonus payout: win = +1.5×bet, lose = −bet. Win = ≥2 of 3 guesses on the board. |
| Q7 | Visual: "Summit Showdown" — classic game-show board (gold trim, marquee bulbs, flipping brass tiles) on dusk sky + ridge silhouettes + rotating sunburst; scoreboard = climbers on a ridge track. |
| Arch | Node + Express + Socket.IO, vanilla HTML/CSS/JS, single Railway service, in-memory state. No DB. |

## 3. Game flow (server phases)
```
lobby -> faceoff -> play -> (steal) -> round_end -> ... (N rounds) -> bonus_bet -> bonus_play -> bonus_reveal -> game_over
```
- **lobby**: players join by name. Instructions panel. Host settings: `teamCount` ('auto'|2|3|4), `answerSeconds` (10–60, default 20), `stealSeconds` (5–30, default 15), `bonusSeconds` (30–120, default 60), `rounds` (3–8, default 5). Host adds custom questions. Host presses Start (min 2 players). Server shuffles players and deals round-robin into teams. Team names in order: "Ridge Runners", "Summit Seekers", "Peak Performers", "Basecamp Bandits"; colors `#ff6b35`, `#2ec4b6`, `#e9c46a`, `#c77dff`.
- **Round multiplier**: last regular round ×2, others ×1.
- **faceoff**: question shown, board tiles hidden. Team pair for round r = rotating pairs over all team combinations (round-robin over C(n,2) pairs). One player from each team = that team's next person in its `faceoffRotation`. Sub-status:
  - `countdown` (3 s) then `go` after an extra random 0.5–2 s delay (server schedules). 
  - Only the two face-off players may buzz. Client measures `reactionMs` from receiving `go` to keypress (Space) / tap. Server collects buzzes for 250 ms after the first arrives, winner = lowest `reactionMs` (cap ≥ 80ms to discard nonsense, ≤ 10000). A buzz sent while status=`countdown` = false start: that player gets +1000 ms penalty added to their eventual reaction.
  - If nobody buzzes in 10 s after go: random of the two wins.
  - `answering`: buzz winner types answer (timer = answerSeconds). Hit → reveal, points go to pot, winner's team gets control. Miss/timeout → other face-off player answers. Hit → their team gets control. Miss → control goes to buzz winner's team (no strikes added).
- **play**: controlling team's current typer (`typerRotation` per team, skip disconnected) submits. Hit → reveal, add points to pot, rotate typer. Miss/timeout → strike, rotate typer. 3 strikes → `steal`. All answers revealed → `round_end` with control team winning pot.
- **steal**: all non-controlling teams; immediately `go` (status go). Any connected player on a steal team may buzz; same 250 ms window, lowest reactionMs. Winner gets one answer (stealSeconds). Hit → reveal; their team wins pot (+ that answer's points). Miss/timeout/no buzz within stealSeconds → control team wins pot.
- **round_end**: all unrevealed answers revealed (`revealed:true, missed:true`). Pot × multiplier added to winner team score. Host presses Next.
- **bonus_bet**: each team's captain = next in that team's typerRotation. Captain sets bet 0..max(teamScore, 100) — integer. Timer 30 s; unset → 0. Bets hidden from other teams until all placed or timer ends, then revealed.
- **bonus_play**: one question with ≥5 answers; board = top 5. All teams answer simultaneously, privately. Each team gets 3 guesses within `bonusSeconds`; typers rotate within the team per guess. Other teams see only guess *counts*, not texts or results.
- **bonus_reveal**: full board revealed; per-team results: hits ≥2 → `+round(1.5×bet)`, else `−bet`. Score floors at 0. Host presses Next.
- **game_over**: final standings, podium, MVP stats: most answers hit (`hits`), fastest buzz (`bestReactionMs`). Host can `playAgain` (back to lobby, same players, scores reset, new random teams).

### Host controls
`start`, `next` (round_end/bonus_reveal → next), `pause`/`resume` (freezes timer; stores remaining), `skip` (discard current question, draw new one, same round number, no score), `accept` (override last rejected guess → server reveals closest unrevealed answer by matcher score; if none unrevealed, no-op), `kick`, `end` (→ game_over).
Host disconnected > 30 s → host passes to the longest-connected player.

### Joining rules
- Name 1–20 chars, trimmed, unique per room (case-insensitive). Max 30 players per room.
- Join mid-game → placed in smallest team, appended to rotations.
- Rejoin with stored token → same player record (team, stats).

## 4. Answer matching (`server/matcher.js`)
`normalize(s)`: lowercase, strip accents/punctuation, collapse spaces, drop leading articles (a/an/the/my/your), strip trailing plural `s`/`es` per word.
`match(guess, answers)` → index of best unrevealed answer or -1. Candidate strings = answer.text + answer.aliases. Hit if any:
1. normalized equal;
2. Levenshtein distance ≤ 1 (len 4–7) or ≤ 2 (len ≥ 8);
3. word overlap: a significant word (≥4 chars, not a stopword) of the candidate equals (or is within distance 1 of) a word in the guess, AND the candidate has ≤ 2 significant words.
`closest(guess, answers)` → index of unrevealed answer with lowest normalized-Levenshtein (for host accept).

## 5. Question bank (`server/questions.json`)
```json
[{ "id": "q001", "category": "office", "q": "Name something people pretend to do on a video call", "answers": [
  { "text": "Listen", "points": 38, "aliases": ["paying attention", "pay attention"] },
  { "text": "Work", "points": 22, "aliases": [] }
]}]
```
- 150+ questions, 5–8 answers each, sorted by points desc, points sum 80–100.
- Categories: office, tech, food, school, relationships, pop-culture, hypothetical, cheeky, home, travel, money, sports.
- At least 60 questions have ≥ 5 answers usable for bonus. Custom questions use the same shape (aliases optional).

## 6. Socket contract
Transport: Socket.IO, default namespace. Room code: 4 chars from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`. URL `/r/:code` serves `index.html`.

### Client → server (all with ack callback `(res) => {ok, error?, ...}`)
| Event | Payload | Who |
|---|---|---|
| `room:create` | `{name}` → ack `{ok, code, playerId, token}` | anyone |
| `room:join` | `{code, name, token?}` → ack `{ok, playerId, token}` | anyone |
| `host:settings` | `{teamCount?, answerSeconds?, stealSeconds?, bonusSeconds?, rounds?}` | host, lobby |
| `host:addQuestion` | `{q, answers:[{text, points}]}` (2–8 answers, text ≤ 40, q ≤ 140, points 1–100) | host, lobby (max 50) |
| `host:removeQuestion` | `{id}` | host, lobby |
| `host:start` / `host:next` / `host:pause` / `host:resume` / `host:skip` / `host:accept` / `host:end` / `host:playAgain` | `{}` | host |
| `host:kick` | `{playerId}` | host |
| `buzz` | `{reactionMs, early?:bool}` | eligible players |
| `answer` | `{text}` (≤ 60 chars) | current typer |
| `bonus:bet` | `{amount}` | team captain |
| `bonus:answer` | `{text}` | that team's current bonus typer |

### Server → client
`state` — full snapshot, **personalized per socket**, emitted after every change:
```js
{
  code, phase, paused, serverNow,          // serverNow = Date.now() at emit
  you: { id, name, teamId, isHost },
  hostId,
  settings: { teamCount, answerSeconds, stealSeconds, bonusSeconds, rounds },
  players: [{ id, name, teamId, connected, isHost, hits, bestReactionMs }],
  teams: [{ id, name, color, score, playerIds }],
  customQuestions: [{ id, q, answerCount }],   // host only; [] for others
  timer: { endsAt, duration } | null,          // epoch ms on server clock
  round: null | {
    number, total, multiplier, category, question,
    board: [{ rank, text: string|null, points: number|null, revealed, missed }],
    strikes, pot, controlTeamId,
    faceoff: { playerIds: [a, b], teamIds: [ta, tb], status: 'countdown'|'go'|'answering'|'done', buzzWinnerId, answeringId },
    currentTyperId,          // who may submit `answer` right now (faceoff answering / play / steal)
    steal: null | { teamIds, status: 'go'|'answering', stealerId },
    lastGuess: null | { playerId, text, correct, rank }, // rank of revealed tile if correct
    canAccept               // host only: true when lastGuess incorrect and override allowed
  },
  bonus: null | {
    captains: { [teamId]: playerId },
    bets: { [teamId]: number|null },   // own team always visible; others null until revealed
    betsRevealed,
    question, board,                     // board texts hidden until bonus_reveal
    teams: { [teamId]: { guessCount, currentTyperId, guesses: [{ text, correct }] /* own team only, else [] */ } },
    results: null | { [teamId]: { hits, won, delta } }
  },
  lastEvent: { id, type, data } | null
}
```
`lastEvent.type` ∈ `join, start, teams, countdown, go, buzz, reveal, strike, control, steal, stealResult, roundEnd, betsRevealed, bonusGuess, bonusReveal, gameOver, kicked, hostChanged`. Client uses `id` to fire each FX once.

Hidden answers: server **never** puts unrevealed `text`/`points` in any snapshot.

Clock: client offset = `serverNow - Date.now()` on receive; remaining = `endsAt - (Date.now()+offset)`.

## 7. Client (public/)
Single page, views switched by `phase`: Join → Lobby (instructions, roster, host settings, custom question form) → Board (faceoff / play / steal / round_end) → Bonus (bet / play / reveal) → Game over.
- Token in `localStorage` key `rtf:<code>`; auto-rejoin on load.
- All user strings rendered via `textContent` (never `innerHTML` with user data).
- Space bar = buzz (ignored when focus in input). Big tappable buzzer button too.
- Sounds synthesized via WebAudio (`fx.js`), mute toggle persisted in localStorage.
- Responsive: works 360px → 1920px.
- Theme tokens: sky `#1b1035 → #5b2a86 → #ff7b39`, gold `#f2c14e`, brass tiles `#b8862b → #e8c66a`, strike red `#e63946`, ink `#232323`. Fonts: Google Fonts "Barlow Condensed" (700/800) + "JetBrains Mono" (500/700).

## 8. Ops
- `npm start` → `node server/index.js`; `PORT` from env; `GET /healthz` → `200 ok`.
- Railway: GitHub-connected service, auto-deploy on push to `main` (i.e. PR merge). `railway.json` sets healthcheck.
- Rooms GC: delete room when all players disconnected for 15 min, or idle 3 h.

## 9. Testing
- `node --test` (built-in, zero deps). `server/matcher.test.js`, `server/game.test.js` (full game simulated without sockets, fake clock), `server/questions.test.js` (bank validates schema/counts).
- Manual smoke: 3 browser tabs, full game.

## 10. Out of scope (YAGNI)
Accounts, persistence across restarts, spectators, chat, voice, admin dashboard, multiple languages.
