# SDE — ridgetech-feud (built 2026-11-20)
Built by 3 parallel subagents + lead integration.
- server/game.js — pure state machine (lobby→faceoff→play→steal→round_end→bonus_bet→bonus_play→bonus_reveal→game_over), host controls, reconnect, host transfer.
- server/matcher.js — normalize/levenshtein/match/closest.
- server/index.js — Express static + Socket.IO, room registry (max 200 rooms, 30 players), GC, /healthz.
- server/questions.json — 160 original questions, 12 categories.
- public/ — index.html, app.js, fx.js (WebAudio + animations), styles.css (Summit Showdown).
Deviations from spec: `npm test` = `node --test server/*.test.js`; extra lastEvent type `update`; 3 s pause after betsRevealed; bonus question reserved at game start; host:accept = snapshot/undo + replay as hit; reactionMs clamped 80–10000; bonus delta reports actual applied change after 0-floor.
Lead fixes: horizontal overflow (overflow-x: clip), mobile header overlap, timer-callback try/catch so one bad room can't crash the process.
Tech debt: client-reported reaction time is spoofable; single instance in-memory state; no "leave room" button.
