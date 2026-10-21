#!/bin/sh
# Uruchamia tablicę na http://localhost:8080 (przy pierwszym uruchomieniu instaluje aiohttp).
set -e
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "Pierwsze uruchomienie: instaluję zależności..."
  python3 -m venv .venv
  .venv/bin/python -m pip install -q -r requirements.txt
fi
exec .venv/bin/python server.py "$@"
