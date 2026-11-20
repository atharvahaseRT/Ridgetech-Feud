# QA — v2-enhancements
- Unit: 26/26 pass (naming, clock, categories, nextTyperId, auto-advance, plus v1 suite).
- Timing: real-time 5-min game, 10 bots + 4 browsers, 4 s answer pace: final x2 round at 115 s left, bonus at 242 s, game over at 287 s. PASS (target 5 min).
- Fast-bot run: 12-round cap → bonus → game over. PASS.
- No-scroll: 1440x900, 1280x720, 1024x640, 390x844 across naming/faceoff/play/steal/round_end/bonus_bet/bonus_play/bonus_reveal/game_over: max overflow 1 px (sub-pixel, overflow hidden, not scrollable). Lobby verified via client agent's screenshots. PASS.
- Bugs: empty-guess toast (fixed). Earlier "hang after bonus" was a test-harness timeout, not a game bug.
- Not covered: real phones/Safari, real 20-person session.
