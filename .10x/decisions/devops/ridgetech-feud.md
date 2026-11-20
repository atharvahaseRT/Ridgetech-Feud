# DevOps — ridgetech-feud
Railway service linked to GitHub atharvahaseRT/Ridgetech-Feud, branch `main`, auto-deploy on merge. Nixpacks build, `npm start`, healthcheck GET /healthz, restart ON_FAILURE ×5 (railway.json). PORT injected by Railway.
Flow: feature branch → PR → merge to main → Railway deploys. No direct pushes to main (org policy).
Rollback: Railway dashboard → Deployments → redeploy previous, or `git revert` + merge.
Rule: don't merge during a live game (in-memory state is lost on redeploy).
