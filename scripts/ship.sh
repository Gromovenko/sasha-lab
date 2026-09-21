#!/usr/bin/env bash
# ship.sh — выкат sasha-lab на прод (77.105.168.153) + отметка сборки для ship-verify.
#   scripts/ship.sh            # rsync кода, migrate + build, pm2 restart, отметка, проверка
# Без --delete: прод-состояние (uploads, seo/data, seo/.env, dist) не трогаем.
# Отметку кладёт ПОСЛЕ успешного рестарта: /opt/sasha-lab/.ship-stamp.json
# (её читает projects.sasha-lab.ship_verify в system.manifest.yaml).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
HOST=root@77.105.168.153; KEY=/root/.ssh/sashalab_new
SSH="ssh -i $KEY"
git -C "$REPO" diff --quiet HEAD -- . ':!*.md' || { echo "дерево грязное — сначала коммит"; exit 1; }
rsync -az -e "$SSH" --exclude .git --exclude node_modules --exclude dist \
  --exclude seo/data --exclude seo/.env --exclude '.harvest-*' --exclude .test-uploads \
  --exclude uploads --exclude .ship-stamp.json "$REPO/" "$HOST:/opt/sasha-lab/"
$SSH $HOST 'chown -R sashaweb:sashaweb /opt/sasha-lab 2>/dev/null; cd /opt/sasha-lab &&
  su sashaweb -c "npm install --omit=dev --silent && set -a && . ./seo/.env && set +a &&
  node db/migrate.js && node content/build.js && pm2 restart sasha-lab --update-env"'
"$REPO/../gromdash/ops/ship-stamp.sh" "$REPO" prod /tmp/sasha-ship-stamp.json
scp -q -i "$KEY" /tmp/sasha-ship-stamp.json "$HOST:/opt/sasha-lab/.ship-stamp.json"
echo "[ship] проверка: node /root/gromovenko/gromdash/ops/ship-verify.mjs sasha-lab"
