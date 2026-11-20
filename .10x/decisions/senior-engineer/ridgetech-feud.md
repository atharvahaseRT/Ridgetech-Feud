# Senior Engineer — ridgetech-feud
- game.js takes `now()` and `schedule(ms, fn)` injectables so tests run with fake clock.
- Every mutation bumps `lastEvent` and calls `room.onChange()`; index.js emits personalized snapshots to each socket.
- Timers: store `endsAt`; one active timeout per room; pause stores remaining ms.
- Buzz window: first buzz schedules 250 ms resolve; collect `{playerId, reactionMs}`.
- Tricky: faceoff two-chance logic, steal eligibility, bonus privacy in snapshot, rotation skipping disconnected players.
