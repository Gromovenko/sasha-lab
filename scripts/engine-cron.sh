#!/bin/bash
# Напоминания по сделкам, если фоновая служба движка не поднята (нет каналов с
# приёмом — только форма сайта). Каждые 15 минут:
#   */15 * * * * /opt/sasha-lab/scripts/engine-cron.sh
#
# Когда работает pm2-процесс sasha-lab-engine, эта задача не нужна: он гоняет
# тот же цикл у себя. Запускать обе одновременно безопасно — назревшее
# напоминание помечается отправленным в той же транзакции.
set -u
cd /opt/sasha-lab || exit 1
LOG=/var/log/sashalab-engine.log
exec >> "$LOG" 2>&1
echo "=== $(TZ=Europe/Moscow date '+%F %H:%M МСК') напоминания"
timeout 300 node engine/cli.js followups || echo '  ! напоминания не доехали'
