#!/usr/bin/env bash
# deploy.sh — обновление PhoneDrop на сервере.
#
# Кто запускает: робот GitHub (CD) по SSH, после того как тесты прошли и образ собран.
# Робот передаёт номер версии (коммита). Его ключ на сервере умеет запускать ТОЛЬКО этот скрипт.
# Можно запустить и вручную:  /opt/phonedrop/deploy.sh            — последняя версия
#                             /opt/phonedrop/deploy.sh <коммит>   — конкретная (откат назад)

set -euo pipefail
cd /opt/phonedrop

REPO="romantmo/phonedrop"
VERSION="${1:-${SSH_ORIGINAL_COMMAND:-latest}}"

# Принимаем только «latest» или 40-значный номер коммита — никаких других команд.
if [[ ! "$VERSION" =~ ^([0-9a-f]{40}|latest)$ ]]; then
  echo "Ошибка: неверная версия «$VERSION»" >&2
  exit 1
fi
# Робот (ключ из GitHub) может выкатить ТОЛЬКО последний коммит ветки main. Даже если ключ украдут,
# им не выкатить старую версию или чужой коммит из форка (аудит v2.5, №2).
# Вручную из своей SSH-сессии (/opt/phonedrop/deploy.sh <коммит>) откат по-прежнему работает.
if [[ -z "${1:-}" && -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  HEAD_MAIN="$(curl -fsSL -H "Accept: application/vnd.github.sha" \
                "https://api.github.com/repos/$REPO/commits/main" || true)"
  if [[ "$VERSION" != "$HEAD_MAIN" ]]; then
    echo "Ошибка: $VERSION — не последний коммит main (${HEAD_MAIN:-GitHub не ответил}). Выкладка отменена." >&2
    exit 1
  fi
fi

REF="main"
[[ "$VERSION" != "latest" ]] && REF="$VERSION"

# Запоминаем, что работает сейчас: если новая версия не поднимется — вернём старую.
PREV_IMAGE="$(docker inspect --format '{{.Config.Image}}' phonedrop-app-1 2>/dev/null || true)"
PREV_TAG="${PREV_IMAGE##*:}"
cp -f compose.yaml compose.yaml.prev 2>/dev/null || true
cp -f Caddyfile Caddyfile.prev 2>/dev/null || true

echo "==> 1/5 Скачиваю настройки сервера с GitHub (версия $REF)"
for f in compose.yaml Caddyfile deploy.sh; do
  curl -fsSL "https://raw.githubusercontent.com/$REPO/$REF/deploy/$f" -o "$f.new"
done
mv compose.yaml.new compose.yaml
mv Caddyfile.new Caddyfile
chmod +x deploy.sh.new && mv deploy.sh.new deploy.sh   # скрипт обновляет сам себя

echo "==> 2/5 Скачиваю новую версию приложения"
export APP_TAG="$VERSION"
docker compose pull --quiet
# Помечаем выложенную версию как «latest» и на самом сервере. Тогда ручной
# «docker compose up -d» (без APP_TAG) запустит ЭТУ версию, а не старый образ.
if [[ "$VERSION" != "latest" ]]; then
  docker tag "ghcr.io/$REPO:$VERSION" "ghcr.io/$REPO:latest"
fi

echo "==> 3/5 Перезапускаю приложение (база и файлы остаются в томе)"
docker compose up -d --remove-orphans
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true

echo "==> 4/5 Проверяю, что новая версия отвечает"
for i in $(seq 1 30); do
  if docker compose exec -T app python -c "
import sys, urllib.request
data = urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3).read().decode()
sys.exit(0 if '$VERSION' == 'latest' or '$VERSION' in data else 1)
" >/dev/null 2>&1; then
    echo "    Приложение отвечает: $VERSION"
    echo "==> 5/5 Удаляю старые версии образов, чтобы не занимали диск"
    docker image prune -f >/dev/null
    echo "Готово ✅"
    exit 0
  fi
  sleep 2
done

echo "Ошибка: новая версия не ответила за 60 секунд. Журнал приложения:" >&2
docker compose logs --tail 50 app >&2
# Откат: прежние настройки и прежняя версия приложения — сайт продолжает работать.
if [[ "$PREV_TAG" =~ ^([0-9a-f]{40}|latest)$ && -f compose.yaml.prev ]]; then
  echo "==> Возвращаю предыдущую версию: $PREV_TAG" >&2
  cp -f compose.yaml.prev compose.yaml
  [[ -f Caddyfile.prev ]] && cp -f Caddyfile.prev Caddyfile
  APP_TAG="$PREV_TAG" docker compose up -d --remove-orphans >&2 || true
  [[ "$PREV_TAG" != "latest" ]] && docker tag "ghcr.io/$REPO:$PREV_TAG" "ghcr.io/$REPO:latest" || true
  docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1 || true
fi
exit 1
