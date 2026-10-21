# Tablica

Współdzielona tablica do korepetycji online, hostowana na własnym komputerze. Wiele osób rysuje na niej jednocześnie, uczeń wchodzi przez link bez zakładania konta.

Jeden plik Pythona (aiohttp + SQLite), bez zewnętrznych usług. Publiczny adres zapewnia darmowy tunel Cloudflare.

## Funkcje

- obsługa rysika z odrzucaniem dłoni, gesty dotykowe, mysz
- tekst z klawiatury, wklejanie i przeciąganie obrazów
- tła: kratka, układ współrzędnych, linie, gładkie
- eksport strony do PNG
- dostęp przez link z losowym kluczem; nowy link unieważnia poprzedni

## Uruchomienie

Wymagany Python 3 w `PATH`.

```sh
# Windows
./start.bat

# macOS / Linux
./start.sh
```

Pierwsze uruchomienie instaluje zależności i `cloudflared`, potem otwiera przeglądarkę. Pierwsza osoba zakłada konto, link dla ucznia jest pod **Udostępnij**.

Tablica działa, dopóki otwarte jest okno serwera. Adres tunelu zmienia się przy każdym uruchomieniu.

Na macOS `cloudflared` instalowany jest przez [Homebrew](https://brew.sh).

## Obsługa

| | |
|---|---|
| Rysik | rysowanie; podwójne stuknięcie palcem przełącza gumkę |
| Palec / mysz | jeden palec rysuje, dwa przesuwają i przybliżają |
| `T` | narzędzie tekstu, Enter zatwierdza |
| `Ctrl+V` / drag & drop | wstawienie obrazu |
| menu `⋯` | tło, eksport do PNG |

## Polecenia

```
./start.bat <polecenie>    
```

| Polecenie | Opis |
|---|---|
| `list-users` | lista kont |
| `add-user <email> "<imię>"` | dodaje konto |
| `reset-password <email>` | ustawia nowe hasło |
| `delete-user <email>` | usuwa konto wraz z tablicami i plikami |
| `cleanup` | usuwa nieużywane obrazy (uruchamiane też automatycznie co godzinę) |
| `serve [--tunnel] [--open]` | sam serwer; `--tunnel` wystawia przez Cloudflare, `--open` otwiera przeglądarkę |

## Konfiguracja

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `PORT` | `8080` | port |
| `HOST` | `0.0.0.0` | adres nasłuchu |
| `DATA_DIR` | `./data` | katalog danych |
| `REGISTRATION` | `first` | `first`: tylko pierwsze konto, `open`: każdy, `closed`: tylko przez `add-user` |
| `TRUST_PROXY` | `auto` | zaufanie do `X-Forwarded-*`: `auto` tylko z localhost, `1` zawsze, `0` nigdy |
| `UPLOAD_QUOTA_MB` | `500` | limit miejsca na obrazy na konto |
| `MAX_ITEMS_PER_PAGE` | `20000` | limit elementów na stronie |
| `MAX_PEERS_PER_BOARD` | `50` | limit jednoczesnych użytkowników tablicy |

## Docker

Ustaw domenę w `Caddyfile`, następnie:

```sh
docker compose up -d
```

Caddy sam wystawi certyfikat HTTPS.

## Dane

Wszystko (konta, tablice, obrazy) jest w `DATA_DIR`. Kopię zapasową rób przy wyłączonym serwerze. Hasła są hashowane scryptem.

## Problemy

- **Port 8080 zajęty** — serwer już działa w innym oknie albo ustaw inny `PORT`.
- **Python nie znaleziony** — dodaj go do `PATH` (w instalatorze: „Add python.exe to PATH”).
- **Uczeń nie może wejść** — serwer musi działać, a link musi pochodzić z bieżącego uruchomienia.

## Licencja

Kod: [MIT](LICENSE). Czcionki: [SIL OFL 1.1](static/fonts/OFL.txt).
