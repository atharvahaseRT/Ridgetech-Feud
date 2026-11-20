# SRE — ridgetech-feud
SLO (event-scoped): game playable for its ~45 min session; health check green.
Monitoring: Railway healthcheck + deploy logs; server logs `error handling <event>` and `timer callback error`.
Runbook:
- Site down → Railway dashboard → service logs; redeploy last green deployment.
- Players stuck → host uses Skip/Pause; worst case refresh (tokens auto-rejoin).
- Host lost → host passes automatically after 30 s.
- Server restarted mid-game → game lost; create a new room (≈1 min).
Capacity: one instance easily handles 25 players; Socket.IO falls back to long-polling behind strict proxies.
