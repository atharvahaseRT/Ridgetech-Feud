# EM — ridgetech-feud
Parallel tracks (subagents):
1. Server: matcher.js + game.js + index.js + tests (critical path).
2. Client: public/* against spec §6 contract.
3. Content: questions.json (150+) + validation test.
Then (lead): integration smoke test, QA + security review, Railway config, PR.
Risk: contract drift between server and client → spec §6 is the single source of truth.
