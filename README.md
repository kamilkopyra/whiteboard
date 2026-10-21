# Tablica

Wspólna tablica do korepetycji online. Ty i uczeń piszecie na niej jednocześnie, a uczeń nie musi zakładać konta, wystarczy mu link.

## Jak uruchomić (Windows)

1. Zainstaluj Pythona ze strony [python.org/downloads](https://www.python.org/downloads/). W instalatorze **zaznacz „Add python.exe to PATH”**.
2. Na tej stronie kliknij zielony przycisk **Code**, a potem **Download ZIP**. Rozpakuj pobrany plik.
3. W rozpakowanym folderze kliknij dwa razy **`start.bat`**. Jeśli wolisz PowerShell, wpisz `.\start.bat`, z kropką i ukośnikiem na początku.
   Jeśli Windows pokaże okno „System Windows ochronił komputer”, kliknij **Więcej informacji**, a potem **Uruchom mimo to**.
4. Za pierwszym razem przygotowanie potrwa około minuty. Potem sama otworzy się przeglądarka z twoją tablicą. **Załóż konto.**
5. Na tablicy kliknij **Udostępnij**, potem **Kopiuj**, i wyślij link uczniowi.

**Okno, które się otworzyło, zostaw włączone, dopóki trwa lekcja.** Zamknięcie okna wyłącza tablicę, ale twoje rysunki zostają zapisane. Przy następnym uruchomieniu adres tablicy będzie inny, więc wyślij uczniowi nowy link.

**Mac:** zainstaluj [Homebrew](https://brew.sh), a w Terminalu w folderze tablicy wpisz `./start.sh`.

## Jak się pisze

- **Rysik (iPad, tablet):** po prostu piszesz. Dłoń oparta o ekran nie rysuje. Dwa szybkie stuknięcia palcem przełączają na gumkę i z powrotem.
- **Palec albo myszka:** piszesz jednym palcem albo myszką, a dwoma palcami przesuwasz i przybliżasz widok.
- **Tekst z klawiatury:** narzędzie **T**, kliknij w tablicę i pisz. Enter zatwierdza.
- **Zdjęcie zadania:** wklej je (Ctrl+V) albo przeciągnij plik na tablicę.
- **Tło:** w menu **⋯** wybierasz kratkę, układ współrzędnych, linie albo gładkie tło. Tam też zapiszesz stronę jako obraz PNG.

## Gdy coś nie działa

- **„Nie znalazłem Pythona”:** zainstaluj Pythona jeszcze raz i tym razem zaznacz „Add python.exe to PATH”.
- **„Port 8080 jest zajęty”:** tablica już działa w innym oknie. Zamknij je albo używaj tamtego.
- **Uczeń nie może wejść:** sprawdź, czy okno tablicy jest otwarte i czy wysłałeś link z dzisiejszego uruchomienia.
- **Zapomniałeś hasła:** w folderze tablicy otwórz PowerShell (Shift + prawy przycisk myszy na pustym miejscu w folderze, potem „Otwórz w terminalu”) i wpisz `.\start.bat reset-password twoj@email.pl`.

Wszystkie twoje dane (konto, tablice, zdjęcia) są w folderze `data`. Żeby zrobić kopię zapasową, skopiuj go w bezpieczne miejsce, gdy tablica jest wyłączona.

---

<details>
<summary>Dla zaawansowanych</summary>

**Polecenia** (w PowerShell w folderze tablicy: `.\start.bat …`; na Macu i Linuxie: `./start.sh …`):

```
list-users                      lista kont
add-user email "Imię"           nowe konto (np. dla drugiego nauczyciela)
reset-password email            nowe hasło
delete-user email               usuwa konto razem z tablicami i zdjęciami
cleanup                         usuwa nieużywane zdjęcia (robi się też samo co godzinę)
serve [--tunnel] [--open]       sam serwer; --tunnel wystawia go przez Cloudflare, --open otwiera przeglądarkę
```

**Ustawienia** (zmienne środowiskowe):

| zmienna | domyślnie | znaczenie |
|---|---|---|
| `PORT` | `8080` | port |
| `HOST` | `0.0.0.0` | adres nasłuchu |
| `DATA_DIR` | `./data` | folder z danymi |
| `REGISTRATION` | `first` | `first`: konto może założyć tylko pierwsza osoba, `open`: każdy, `closed`: nikt (konta dodajesz przez `add-user`) |
| `TRUST_PROXY` | `auto` | czy wierzyć nagłówkom `X-Forwarded-*`: `auto` tylko od proxy na tym samym komputerze, `1` zawsze, `0` nigdy |
| `UPLOAD_QUOTA_MB` | `500` | miejsce na zdjęcia dla jednego konta |
| `MAX_ITEMS_PER_PAGE` | `20000` | limit elementów na stronie |
| `MAX_PEERS_PER_BOARD` | `50` | ile osób naraz na tablicy |

**Docker z własną domeną:** wpisz domenę w `Caddyfile` i uruchom `docker compose up -d`. HTTPS ustawi się sam.

**Jak to działa:** jeden plik Pythona (`server.py`, aiohttp + SQLite), bez zewnętrznych usług. Publiczny adres zapewnia darmowy tunel Cloudflare (`cloudflared`), który `start.bat` instaluje sam. Hasła są hashowane scryptem. Link do tablicy zawiera losowy klucz, a nowy link unieważnia stary.

</details>

## Licencja

Kod: MIT ([LICENSE](LICENSE)). Czcionki: SIL Open Font License 1.1 ([static/fonts/OFL.txt](static/fonts/OFL.txt)).
