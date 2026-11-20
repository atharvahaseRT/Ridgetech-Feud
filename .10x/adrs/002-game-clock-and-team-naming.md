# ADR-002: Clock-driven rounds, fixed fast timers, and a team-naming phase

**Status:** Accepted
**Date:** 2026-11-20
**Feature:** v2-enhancements
**Author:** 10x-Team (Architect + Staff Engineer)

## Context
After first play-test: games must fit 5–10 minutes (host decides), teams want to name themselves, and the UI must never scroll. v1 used a fixed round count and host-tunable timers, so game length varied widely.

## Decision
- Host chooses `gameMinutes` (5/7/10). A server game clock starts at round 1; before each new round the server checks remaining time: < 90 s → bonus; < 165 s → this round is the final ×2 round. Rounds are never interrupted by the clock.
- Timers become fixed constants tuned for pace (answer 12 s, steal 8 s, bonus 30 s, bets 15 s, round_end auto-advance 5 s). Host timer settings removed.
- New `team_naming` phase (30 s) between team draw and round 1; captain-only naming with live updates.
- Snapshot grows: `gameClock`, `teams[].captainId/nameLocked/nextTyperId`, `round.isFinal/activeTeamId`, `round.total = null`.

## Alternatives Considered
| Alternative | Pros | Cons | Why Not |
|---|---|---|---|
| Length preset → fixed rounds & timers (no clock) | Simpler | ±2 min drift | User chose clock (Q2) |
| Clock + host-tunable timers | Flexible | Lobby clutter, easy to break pacing | Rejected in Q2 |
| Hard-stop rounds at clock 0 | Exact length | Unfair mid-round cut | Bad UX |
| Players self-select teams | Social | Stacked teams; replaces random draw | User chose captain naming (Q1) |

## Consequences
### Positive
- Predictable 5–10 min games; consistent pacing; clearer identity per team.
### Negative
- Breaking snapshot/settings contract change (client + server ship together in one PR).
- Number of rounds unknown upfront (UI shows "Round n" / "FINAL ROUND").
### Risks
- Slow typers stretch rounds → final round may overrun by ~1 min. Mitigation: 12 s answer timer, auto-advance round_end.

## Dependencies
- Supersedes the settings/timers parts of v1 spec §3 (ADR-001 still holds).
