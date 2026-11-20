# Ridgetech Feud — Summit Showdown

A browser-based, real-time survey-style party game for 8–25 Ridgetech coworkers. One link, no installs. Scores are in **Ridgetech Bucks (RB$)**.

## Play
1. Host opens the site, enters a name, clicks **Host a game**, and shares the `/r/CODE` link.
2. Everyone joins with a name and reads the rules while waiting.
3. Host tweaks settings (teams, timers, rounds), optionally adds custom questions, and clicks **Start** — teams are randomly assigned.
4. Rounds: two-player face-off (wait for GO, hit **Space**), rotating typers, 3 strikes → every other team races to steal. Final regular round pays double.
5. Bonus round: each team's captain secretly bets RB$. Get ≥2 of 3 guesses on the board for **+1.5× bet**, otherwise lose the bet.

## Develop
```bash
npm install
npm start        # http://localhost:3000
npm test         # node --test
```
Questions live in `server/questions.json` (schema in `.10x/specs/`).

## Deploy (Railway)
Railway service connected to this GitHub repo, auto-deploying `main` on every merge. Health check: `GET /healthz`. `railway.json` holds the config. Game state is in memory — **don't merge while a game is in progress** (a redeploy ends live games).

Project design/decision history: `.10x/`.
