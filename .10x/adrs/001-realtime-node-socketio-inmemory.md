# ADR-001: Server-authoritative Node + Socket.IO game with in-memory state

**Status:** Accepted
**Date:** 2026-11-20
**Feature:** ridgetech-feud
**Author:** 10x-Team (Architect + Staff Engineer)

## Context
20–25 coworkers play a live survey game from their own browsers via one link. Need sub-second sync, fair buzzer, hidden answers that can't be read from DevTools, and deployment on the existing stack (GitHub + Railway). No database available (no Supabase). Delivery target: ~1 hour.

## Decision
Single Node 20+ service: Express serves static vanilla HTML/CSS/JS; Socket.IO carries events. One pure state machine (`server/game.js`) owns all rules; sockets only translate events. Server sends each socket a personalized full snapshot after every change — never unrevealed answers. Buzzer fairness via client-measured reaction time from "GO" plus a 250 ms server collection window. State lives in memory per room.

## Alternatives Considered
| Alternative | Pros | Cons | Why Not |
|---|---|---|---|
| React + Vite client | Component model | Build step, more deps | No gain at this size, slows 1-hr delivery |
| Supabase/Firebase realtime | Managed, persistence | Not in stack, rules split client/cloud, answers harder to hide | Not available; fairness harder |
| Colyseus game framework | Rooms/state sync built-in | Learning curve, schema DSL | Overkill for one game |
| First-arrival buzzer | Trivial | Unfair across varying remote latency | Players are remote |

## Consequences
### Positive
- One deploy unit, zero infra, zero build. Rules unit-testable without sockets.
- Answers secure by construction (never sent).
### Negative
- Server restart/redeploy kills games in progress.
- Single instance only (no horizontal scaling) — fine for one office game.
- Client-reported reaction time is spoofable by a determined player with DevTools.
### Risks
- Redeploy mid-game → don't merge during a game session.
- Corporate proxies blocking websockets → Socket.IO long-poll fallback.

## Dependencies
- Railway service auto-deploying `main`. Future persistence (e.g. leaderboard history) would need a new ADR + DB.
