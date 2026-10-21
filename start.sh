#!/bin/sh
# Uruchamia tablicę i wystawia ją do internetu (jeśli jest cloudflared). Przy pierwszym uruchomieniu instaluje zależności.
# Z argumentami uruchamia polecenia administracyjne, np.: ./start.sh list-users
set -e
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "Pierwsze uruchomienie: przygotowuję tablicę, to potrwa około minuty..."
  python3 -m venv .venv
  .venv/bin/python -m pip install -q --disable-pip-version-check -r requirements.txt
fi
if [ $# -gt 0 ]; then
  exec .venv/bin/python server.py "$@"
fi
if ! command -v cloudflared >/dev/null 2>&1 && command -v brew >/dev/null 2>&1; then
  echo "Instaluję program do udostępniania tablicy w internecie (cloudflared)..."
  brew install cloudflared >/dev/null 2>&1 || true
fi
exec .venv/bin/python server.py serve --tunnel --open
