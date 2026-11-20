# Architect — ridgetech-feud
See ADR-001. Components: server/index.js (HTTP+socket wiring, room registry, GC), server/game.js (pure state machine, injected clock/timers), server/matcher.js (fuzzy match), server/questions.json, public/ (index.html, app.js, fx.js, styles.css).
Boundary: game.js exposes `createRoom`, `handle(room, playerId, action)`, `snapshotFor(room, playerId)`, `tick` via scheduled callbacks; index.js only routes.
Failure modes: disconnect (timer runs, rotation skips), host leave (transfer after 30s), restart (games lost — accepted), latency (reaction-time buzzer).
Contract: spec §6.
