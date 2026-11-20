# SDE — v2-enhancements (2026-11-20)
Built by 4 subagents (server, client, questions, question audit) + lead integration.
- Server: team_naming phase, 5/7/10 min game clock driving rounds (final x2 < 165 s, bonus < 90 s, cap 12), fixed timers, round_end auto-advance, category selection (min 15), turn info (captainId, nextTyperId, activeTeamId).
- Client: 100dvh no-scroll shell; opponents left / your team right; team colours, ANSWERING / UP NEXT / FACE-OFF tags, turn banner, YOUR TURN banner; header clock; lobby game length + category chips; phone team-pill strip with bottom sheet.
- Questions: 250 total (culture-clash 30, remote-work 20); audited so every question is guessable from US, India and Argentina.
Deviations: pause allowed in team_naming/round_end; acting captain shown when captain disconnected; distinct error when no bonus-capable question; gameClock null at game over.
Lead fixes: empty-guess toast now says "ran out of time".
Tech debt: phone landscape (844x390) is cramped but usable; client-reported buzz timing still spoofable.
- Added (user request): host "Close room" button (header, every phase, confirm) → `host:closeRoom` (ADR-003). Players land on start screen with "The host closed the room." Also fixed: after any server-initiated disconnect (kick/close) the client reconnects so it can join or create a new room (previously a kicked player's socket stayed dead).
- Added (user request): "Leave" header button for every player (confirm). `player:leave` → removed from roster/team, others get "<name> left the room" toast; host leaving passes host immediately; last player leaving deletes the room. Kick now shares removePlayer().
- UI rule (user request): no browser-native popups. All 5 confirm() calls (leave, close room, kick, skip question, end game) replaced by a themed `<dialog id="confirm-dialog">` via `askConfirm({title, body, ok, icon, danger})` → Promise<bool>. Esc / Cancel / backdrop = false; destructive dialogs are red and focus Cancel by default; a pending dialog closes if the player leaves the room. Never reintroduce alert/confirm/prompt.
