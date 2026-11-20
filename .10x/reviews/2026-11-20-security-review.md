# Security Review — Ridgetech Feud — 2026-11-20
Scope: server/*.js, public/*.js. Verdict: OK for internal use.
- Info disclosure: hidden answers never serialized (tested). Bonus privacy per team (tested). customQuestions/canAccept host-only.
- AuthZ: host:* rejected for non-host server-side; answer/buzz/bet eligibility enforced in game.js.
- Input: payloads coerced to objects; names 1–20, answers ≤60, questions ≤140; socket buffer 16 KB.
- XSS: user text via textContent only.
- Availability: per-event try/catch; timer callbacks now wrapped (fixed in review); room/player caps.
- Deps: npm audit 0 vulns.
Accepted: spoofable buzzer timing, room-code guessability (host can kick), room-creation flood up to cap.
