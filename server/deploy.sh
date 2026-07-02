#!/usr/bin/env bash
# Apply the latest backend code on THIS machine (the one running the tunnel).
#
# Cross-machine workflow: develop the backend anywhere, `git push` to main, then
# run this on the fileserver box to pull + restart the service. See README.md.
#
# Usage:  ./deploy.sh          (from server/, or anywhere — it cd's to the repo)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE="toolbox-backend.service"
HEALTH="http://127.0.0.1:8787/health"

echo "==> Pulling latest in $REPO"
git -C "$REPO" pull --ff-only

echo "==> Restarting $SERVICE"
sudo systemctl restart "$SERVICE"

echo "==> Waiting for health"
for i in $(seq 1 10); do
  if curl -fsS "$HEALTH" >/dev/null 2>&1; then
    echo "==> Healthy: $(curl -fsS "$HEALTH")"
    exit 0
  fi
  sleep 1
done

echo "!! Backend did not report healthy after restart. Check: journalctl -u $SERVICE -n 50" >&2
exit 1
