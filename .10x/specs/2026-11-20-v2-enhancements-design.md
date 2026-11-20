# Ridgetech Feud v2 — Enhancements Spec

**Date:** 2026-11-20 · **Feature slug:** `v2-enhancements` · **Status:** Approved (brainstorm Q1–Q3)
**Base:** `.10x/specs/2026-11-20-ridgetech-feud-design.md` (v1). Everything in v1 still holds unless changed here. ADR-002.

## 1. Requests → decisions
| # | Request | Decision |
|---|---|---|
| 1 | Players select team name | New phase `team_naming` (30 s) right after random team draw. Each team's **captain** types a name + 🎲 random suggestion; teammates see it live; captain "Lock in". All locked or timer → game continues. Unnamed → default name. |
| 2 | Own team list right, opponents left | 3-column game layout: LEFT = opponent teams (stacked cards), CENTER = board, RIGHT = your team + ridge climb. |
| 3 | More funny questions, US/India/Argentina | +90 questions (q161–q250), new category `culture-clash` + culturally flavored entries across categories. Affectionate teasing, never mocking. |
| 4 | Game fits 5–10 min, host decides | Host picks `gameMinutes` ∈ {5, 7, 10} (default 7). Visible game clock. Fixed fast timers. Rounds are clock-driven (§3). |
| 5 | No scrolling, great interactive UI | Every view fits in 100dvh; no page scroll at ≥ 1024×640 desktop and on phones (panels collapse). Internal lists may scroll only inside their own panel if >12 members. |
| 6 | Who's up next / who's answering | Per-team `nextTyperId`; ✍️ ANSWERING tag (glowing), UP NEXT tag, turn banner in active team's color, full-width "YOUR TURN!" banner for the typer. |
| 7 | No team confusion | Team color everywhere: player chips have team-color ring/initial avatar; "YOUR TEAM" header + "(you)"; opponent cards labeled with team name & color; banner/status text uses team-colored chip; board frame glows in the active team's color. |

## 2. Server changes (`server/game.js`)
### Settings
`settings = { teamCount: 'auto'|2|3|4, gameMinutes: 5|7|10 }` (default `{teamCount:'auto', gameMinutes:7}`). Remove `answerSeconds/stealSeconds/bonusSeconds/rounds` from settings & `host:settings` validation (ignore unknown keys).

### Fixed timers (constants)
| Timer | Value |
|---|---|
| TEAM_NAMING_MS | 30000 |
| COUNTDOWN_MS (faceoff) | 2000, then random 500–1500 ms to GO |
| NO_BUZZ_MS | 8000 |
| ANSWER_MS | 12000 |
| STEAL_MS (buzz window and answer) | 8000 |
| ROUND_END_AUTO_MS | 5000 (auto `next`; host can press earlier) |
| BET_MS | 15000 |
| BET_REVEAL_MS | 3000 |
| BONUS_MS | 30000 |
| BONUS_RESERVE_MS | 90000 |
| FINAL_ROUND_THRESHOLD_MS | 165000 |

### New phase `team_naming`
Flow: `lobby → (host:start) → team_naming → faceoff (round 1) → …`
- On start: teams drawn as v1; each team gets `captainId` = first player in its rotation (stable for the game; if captain disconnected, the next connected teammate acts as captain). Default names stay v1 list.
- `team:name` `{name}` — captain only, phase team_naming, 1–24 chars after trim, must not equal (case-insensitive) another team's current name. Updates `team.name` live (emits). Allowed repeatedly until locked.
- `team:lock` `{}` — captain only; sets `team.nameLocked = true`. When all teams locked → start round 1 immediately. Timer expiry → start round 1.
- `host:next` during team_naming → start round 1 (skip).
- The game clock starts when round 1 starts (naming time doesn't count).

### Game clock
- `room.clock = { endsAt, remainingMs (when paused) }`; started at round 1 with `gameMinutes*60000`. Pause freezes it, resume extends `endsAt`.
- Snapshot top-level `gameClock: { endsAt, durationMs } | null` (paused: `endsAt - serverNow` = frozen remaining, same convention as `timer`).
- **Round scheduling** — when about to start a new round (after round 1): `rem = clock remaining`.
  - `rem < BONUS_RESERVE_MS` → `startBonus`.
  - else start round; if `rem < FINAL_ROUND_THRESHOLD_MS` → this is the **final round** (`isFinal: true`, multiplier 2).
  - Round 1 is never final. Hard cap 12 rounds (12th is final).
  - Clock reaching 0 mid-round does NOT interrupt; the round finishes (then bonus).
- `round.total` = `null` (unknown). New `round.isFinal`.
- `round_end` auto-advances after ROUND_END_AUTO_MS (host:next can advance early).

### Turn info
- `teams[].captainId`, `teams[].nameLocked`, `teams[].nextTyperId` = who will type next for that team (after the current typer if that team is typing; else that team's next in rotation), skipping disconnected.
- `round.currentTyperId` unchanged. Add `round.activeTeamId` = team of current typer (faceoff answering/play/steal answering) or null.

### Snapshot additions summary
```
gameClock: {endsAt, durationMs} | null
settings: {teamCount, gameMinutes}
teams[]: + captainId, nameLocked, nextTyperId
round: + isFinal, activeTeamId ; total = null
phase: + 'team_naming'
lastEvent.type: + 'teamName' (data {teamId, name}), 'teamLocked' (data {teamId}), 'namingDone'
```
Events in: `team:name`, `team:lock` (add to GAME_EVENTS in index.js).

Tests: update existing game.test.js for new settings/timers; add tests for naming (captain-only, uniqueness, lock-all advances, timer advances), clock (final round flag, bonus when < 90 s, pause freezes clock), nextTyperId.

## 3. Client changes (`public/`)
- **Global**: `html, body { height: 100%; overflow: hidden }`; app shell = CSS grid `header / main` filling `100dvh`; all views must fit. Use `clamp()` + container-relative sizes; tiles shrink with available height. Test viewports: 1440×900, 1280×720, 1024×640, 390×844 (phone), 844×390 (phone landscape — may compress).
- **Header**: logo · round chip (“Round 2” / “FINAL ROUND ×2”) · **game clock** (mm:ss, turns red + pulse < 60 s) · room code · mute.
- **Lobby** (fits screen): left = room link + Start + host settings (Teams auto/2/3/4, **Game length 5/7/10 segmented control**) + custom question button (opens modal); center = roster grid (chips w/ initials); right = How to Play as a compact tabbed/stepper card (no scroll). Rules text updated: team naming, game clock, answer 12 s.
- **Team naming view**: big card for your team (team color, members chips). Captain: input (maxlength 24) + 🎲 button (client-side list of ~40 fun names mixing US/India/Argentina vibes e.g. "Chai & Chill", "Mate Masters", "Taco Tuesday Titans", "Masala Mavericks", "Dulce de Leche Dynasty", "Bagel Bandits", "Biryani Bosses", "Tango Troopers", "Samosa Squad", "Gaucho Gang") + Lock in. Non-captains see live name + "Captain X is naming your team". Other teams' cards show their names live + locked ✓. Timer ring.
- **Game layout (faceoff/play/steal/round_end and bonus)**: 3 columns `minmax(200px, 20%) 1fr minmax(220px, 22%)`.
  - LEFT "OPPONENTS": one card per opposing team: color bar, name, RB$, member chips (✍️ ANSWERING / UP NEXT tags; disconnected dimmed).
  - RIGHT "YOUR TEAM": team color border + name + RB$, member chips with "(you)", captain ★, tags; under it compact ridge climb.
  - CENTER: question banner, board (fits height), strikes + pot, **turn banner** (team-colored: "🟧 CHAI & CHILL’S TURN · Priya is answering · 9s" / faceoff: "Priya vs Lucas — wait for GO" / steal: "STEAL! Mate Masters & Taco Titans — buzz in!"), answer input / buzzer area.
  - Board frame glows in active team color. When `round.currentTyperId === you.id`: full-width "YOUR TURN!" banner (team color, pulse) + input autofocus + sound.
  - Faceoff: both players highlighted in their team's side panels with ⚡ FACE-OFF tag.
- **Phone (< 768px)**: header compact; team panels collapse to a horizontal strip of team pills (your team first, outlined) that expand as an overlay sheet on tap; board fills remaining height; no page scroll.
- Bonus/game-over views follow the same no-scroll rule.
- Keep: textContent for all user strings; FX per lastEvent.id; ignore unknown event types.

## 4. Questions (`server/questions.json`)
- Append q161–q250 (90). Categories: `culture-clash` (~30: US vs India vs Argentina habits, festivals — Diwali, Thanksgiving, 4th of July, Holi, Navidad, asado, mate, chai, cricket, fútbol/Messi, desi parents, Argentine "ahorita" time, US tipping, Bollywood, tango), `remote-work` (~20: time zones, standups, Slack, cameras off), plus funny entries in existing categories (~40). PG-13 cheeky allowed. Affectionate, inclusive, no slurs or demeaning stereotypes, no religion mocking, no real private people (public figures like Messi OK as answers).
- Same schema/rules as v1 §5; update questions.test.js minimums (≥ 240 questions, `culture-clash` ≥ 25).

## 5. Out of scope
Per-host timer tuning, player-chosen teams, persistent team names across games.
