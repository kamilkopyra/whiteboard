@echo off
chcp 65001 >nul
rem Uruchamia tablice i wystawia ja do internetu. Przy pierwszym uruchomieniu wszystko doinstalowuje.
rem Z argumentami uruchamia polecenia administracyjne, np.: start.bat list-users
cd /d "%~dp0"
title Tablica

python --version >nul 2>nul || (
  echo Nie znalazlem Pythona.
  echo Zainstaluj go ze strony https://www.python.org/downloads/
  echo i przy instalacji zaznacz "Add python.exe to PATH". Potem uruchom ten plik jeszcze raz.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo Pierwsze uruchomienie: przygotowuje tablice, to potrwa okolo minuty...
  python -m venv .venv || goto :error
  ".venv\Scripts\python.exe" -m pip install -q --disable-pip-version-check -r requirements.txt || goto :error
)

if not "%~1"=="" (
  ".venv\Scripts\python.exe" server.py %*
  goto :eof
)

where cloudflared >nul 2>nul || if not exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" if not exist "%ProgramFiles%\cloudflared\cloudflared.exe" (
  echo Instaluje program do udostepniania tablicy w internecie ^(cloudflared^)...
  winget install --id Cloudflare.cloudflared -e --silent --accept-source-agreements --accept-package-agreements >nul 2>nul
)

".venv\Scripts\python.exe" server.py serve --tunnel --open
pause
goto :eof

:error
echo.
echo Nie udalo sie przygotowac tablicy. Sprawdz polaczenie z internetem i uruchom ten plik jeszcze raz.
pause
exit /b 1
