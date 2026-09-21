#!/usr/bin/env bash
# ship.sh — контракт «Тест | Прод» даша (system.manifest.yaml → release_rules.contract).
#   bash infra/deploy/ship.sh eu ["сообщение"]  # коммит → пуш → тест EU (scripts/deploy-eu.sh)
#   bash infra/deploy/ship.sh ru                # пуш main → ПРОД 77.105.168.153 (scripts/ship.sh)
# Ветка одна (main). Строки итога — с ✓/✗/⚠/=. Незакоммиченное на прод не едет.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$REPO"
TARGET="${1:-}"; MSG="${2:-}"
fail() { echo "✗ $*" >&2; exit 1; }
[ "$TARGET" = eu ] || [ "$TARGET" = ru ] || fail "цель: eu или ru (получено «$TARGET»)"
[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || fail "рабочее дерево не на main"
echo "═══ sasha-lab · ship → $TARGET · $(TZ=Europe/Moscow date '+%d.%m %H:%M МСК')"
if [ "$TARGET" = eu ]; then
  git add -u
  if git diff --cached --quiet; then echo "= нечего коммитить — выкатываю текущий HEAD"
  else
    FILES=$(git diff --cached --name-only); N=$(echo "$FILES" | wc -l)
    [ -n "$MSG" ] || MSG="update: $(echo "$FILES" | head -3 | xargs -n1 basename | paste -sd, -)$([ "$N" -gt 3 ] && echo " и ещё $((N-3))" || true)"
    git commit -q -m "$MSG" -m "Коммит кнопкой «Тест: выкат» в gromdash ($N файлов)."
    echo "✓ коммит $(git log --oneline -1)"
  fi
else
  [ -z "$(git status --porcelain -- ':!*.md' | grep -v '^??' || true)" ] || { echo "⚠ незакоммиченные правки на прод НЕ поедут:"; git status --short | head -10; }
fi
git fetch -q origin main || fail "git fetch не прошёл"
if [ "$(git rev-list --count HEAD..origin/main)" -gt 0 ]; then
  git pull -q --rebase --autostash origin main || { git rebase --abort 2>/dev/null || true; fail "rebase на origin/main с конфликтом — ничего не выкачено"; }
  echo "✓ подтянуто, HEAD $(git log --oneline -1)"
fi
git push -q origin main && echo "✓ push origin/main $(git rev-parse --short HEAD)" || fail "push не прошёл"
if [ "$TARGET" = eu ]; then bash scripts/deploy-eu.sh; else bash scripts/ship.sh; fi \
  && echo "✓ выкат $TARGET готов, коммит $(git rev-parse --short HEAD)" || fail "выкат $TARGET упал"
