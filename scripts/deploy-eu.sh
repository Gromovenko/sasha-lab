#!/usr/bin/env bash
# deploy-eu.sh — выкат ТЕСТА sasha-lab на EU: pm2 `test-sasha-lab` :3060 (репо = рабочее дерево).
#   scripts/deploy-eu.sh
# Прод (77.105.168.153) не трогает — он выкатывается отдельно: scripts/ship.sh.
# Тест: своя база (docker sashalab-test-pg :5446, без данных живых людей), seo/.env со
# всеми каналами выключенными, SITE_NOINDEX=1, снаружи basic-auth. Кроны на тесте НЕ заводим.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO"
NAME="${SASHALAB_TEST_PM2:-test-sasha-lab}"; URL=https://sashalabtest.130-17-14-158.sslip.io
git diff --quiet HEAD -- . ':!*.md' || { echo "дерево грязное — сначала коммит"; exit 1; }
npm install --omit=dev --silent
node db/migrate.js
node content/build.js
if pm2 describe "$NAME" >/dev/null 2>&1; then pm2 restart "$NAME" --update-env >/dev/null
else pm2 start server.js --name "$NAME" --cwd "$REPO" >/dev/null; pm2 save >/dev/null; fi
sleep 2
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3060/)
[ "$code" = 200 ] || { echo "[deploy-eu] локально / → $code"; exit 1; }
"$REPO/../gromdash/ops/ship-stamp.sh" "$REPO" eu
echo "[deploy-eu] OK: $URL (basic-auth), проверка: node /root/gromovenko/gromdash/ops/ship-verify.mjs sasha-lab"
