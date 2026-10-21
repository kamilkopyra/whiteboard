@echo off
rem Uruchamia tablice na http://localhost:8080 (przy pierwszym uruchomieniu instaluje aiohttp).
rem Dodatkowe argumenty trafiaja do server.py, np.: start.bat list-users
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Pierwsze uruchomienie: instaluje zaleznosci...
  python -m venv .venv || goto :error
  ".venv\Scripts\python.exe" -m pip install -q -r requirements.txt || goto :error
)
if "%~1"=="" start "" http://localhost:8080
".venv\Scripts\python.exe" server.py %*
goto :eof
:error
echo Nie udalo sie przygotowac srodowiska. Sprawdz, czy Python 3.10+ jest zainstalowany.
pause
