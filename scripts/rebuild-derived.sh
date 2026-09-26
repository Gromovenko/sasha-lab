#!/bin/bash
# Пересборка производных слоёв базы авто в правильном порядке (от sashaweb):
#   carbase → carmap → links → catalog, счётчики после каждого шага.
# facts-backlog.sh НЕ запускается (facts.js не менялся).
# Отвязанный запуск:  setsid scripts/rebuild-derived.sh >/var/log/sashalab-harvest/rebuild-derived.log 2>&1 &
set -u
cd /opt/sasha-lab 2>/dev/null || cd "$(dirname "$0")/.." || exit 1
msg() { echo "$(TZ=Europe/Moscow date '+%F %H:%M МСК') $*"; }
for step in carbase carmap links catalog; do
  msg "шаг $step"
  node harvest/run.js "$step" || { msg "шаг $step упал (код $?) — стоп"; exit 1; }
done
msg "готово; сравнение Camry 2012 / Seltos 2021: curl -s 'http://127.0.0.1:3060/karta/api?make=toyota&model=camry&year=2012'"
