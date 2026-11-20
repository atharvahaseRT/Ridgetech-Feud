# QA — ridgetech-feud
Strategy: unit (node:test) + socket-level full-game bot sim + real-browser (Chrome via playwright-core) runs.
Results: 15/15 unit tests; 10-bot full game PASS (faceoff, control, strikes, steal, ×2 final, bets, bonus win/lose, floor 0, game over, no answer leaks in any snapshot); 10 bots + 2 browser players (1440 & 390 widths) full game, 0 JS errors.
Bugs found & fixed: horizontal page overflow (desktop 1716px/mobile 609px), mobile header overlap.
Not covered: real multi-human latency, Safari/iOS, very slow networks, 25 simultaneous browsers.
Gate: PASS for internal game use. Report: .10x/reviews/2026-11-20-qa-report.md
