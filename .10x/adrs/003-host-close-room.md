# ADR-003: Host can close a room

**Status:** Accepted
**Date:** 2026-11-20
**Feature:** v2-enhancements

## Context
Hosts had "End game" (→ results) but no way to shut a room; rooms lingered until GC (15 min all-gone / 3 h idle) and players stayed attached.

## Decision
New socket event `host:closeRoom` handled in `server/index.js` (it owns the room registry; game.js stays pure). Host-only. Server acks first, then emits `roomClosed` to every socket in the room, disconnects them, disposes timers and deletes the room. Clients return to landing with a message, clear the stored token, and reconnect the socket (server-initiated disconnects don't auto-reconnect) so they can create/join another room.

## Alternatives Considered
| Alternative | Why Not |
|---|---|
| Reuse `host:end` to also delete the room | Loses the results/podium screen everyone wants to see |
| Route through game.js as a phase | game.js has no access to sockets or the room registry |

## Consequences
+ Clean shutdown, frees memory immediately. − Irreversible for that room code (confirm dialog guards it).

## Addendum (2026-11-20): player leave
`player:leave` (any player) goes through game.js (`removePlayer`, shared with kick). If the host leaves, host passes immediately to the longest-connected remaining player (no 30 s grace — leaving is explicit). index.js detaches the leaver's sockets without disconnecting (so they can join/host again) and closes the room when the last player leaves. A removed current typer simply times out, as with kick.
