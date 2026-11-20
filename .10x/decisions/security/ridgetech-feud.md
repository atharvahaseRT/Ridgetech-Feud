# Security — ridgetech-feud
Threat model: internal party game; attackers = curious players with DevTools, or randoms who find the URL.
Controls: unrevealed answers never sent to any client (verified by tests + sim); bonus guesses only to own team; host-only actions checked server-side; payload type/length validation; 16 KB socket message cap; all user text rendered with textContent (only innerHTML is static SVG); tokens = crypto.randomUUID; npm audit 0 vulnerabilities; deps limited to express + socket.io.
Accepted risks: spoofable reaction time (client-measured); room-code guessing (4 chars, 31^4 ≈ 923k) lets a stranger join a lobby — host can kick; room-creation flooding capped at 200 rooms (DoS of game creation possible). No auth by design.
Review: .10x/reviews/2026-11-20-security-review.md
