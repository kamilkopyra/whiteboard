# Tablica

Wspólna tablica do korepetycji online, którą stawiasz u siebie. Nauczyciel ma konto i dowolnie wiele tablic, a uczeń dostaje link i od razu pisze razem z nim, **bez zakładania konta**.

- kratka, linie albo układ współrzędnych z podziałką, kilka stron na tablicy
- pióro, zakreślacz, odcinek, wektor, prostokąt, okrąg, tekst, gumka, przesuwanie elementów
- zdjęcie zadania wklejasz przez Ctrl+V albo przeciągasz plik
- zmiany i kursory na żywo, śledzenie widoku drugiej osoby (kliknij jej awatar)
- link do tablicy: „może rysować”, „może oglądać” albo wyłączony; można go w każdej chwili wymienić na nowy
- działa z rysikiem (iPad z Apple Pencil, tablety z Androidem, Windows), palcem i myszką; dłoń oparta o ekran nie rysuje
- przy pisaniu rysikiem dwa stuknięcia palcem przełączają na gumkę i z powrotem
- cofnij/ponów, zapis strony do PNG, jasny „zeszyt” albo ciemna „tablica kredowa”

Całość to jeden plik Pythona (`server.py`) z bazą SQLite. Nie potrzebuje żadnych zewnętrznych usług ani kont w chmurze.

## Szybki start

Potrzebujesz Pythona 3.10 lub nowszego.

**Windows:** kliknij dwa razy `start.bat`.

**Linux / macOS:**
```sh
./start.sh
```

**Docker:**
```sh
docker build -t tablica .
docker run -d -p 8080:8080 -v ./data:/data --restart unless-stopped tablica
```

Otwórz http://localhost:8080. Przy pierwszym uruchomieniu załóż konto: to będzie konto właściciela, a potem rejestracja sama się zamknie (zmienisz to zmienną `REGISTRATION`).

Tablica działa też w sieci domowej. Uczeń albo twój tablet w tym samym Wi-Fi wchodzi na `http://ADRES-IP-KOMPUTERA:8080`.

## Jak dać dostęp uczniowi przez internet

### Szybko i za darmo, z własnego komputera (tunel Cloudflare)

```sh
cloudflared tunnel --url http://localhost:8080
```
(instalacja na Windows: `winget install Cloudflare.cloudflared`)

Program wypisze adres `https://….trycloudflare.com`. Wejdź na niego, zaloguj się i stamtąd kopiuj linki dla uczniów. Tablica działa, dopóki komputer jest włączony, a adres zmienia się przy każdym uruchomieniu tunelu. Stały adres dostaniesz po założeniu darmowego konta Cloudflare i nazwanego tunelu.

### Na stałe: własny serwer z domeną

Na dowolnym serwerze z Dockerem (VPS za kilkanaście–kilkadziesiąt zł miesięcznie):

1. Ustaw rekord A domeny (np. `tablica.twojadomena.pl`) na adres IP serwera.
2. Wpisz tę domenę w pliku `Caddyfile`.
3. Uruchom `docker compose up -d`.

Caddy sam załatwi certyfikat HTTPS. Dane trafiają do folderu `data/` obok pliku `docker-compose.yml`.

Darmowe hostingi, które kasują pliki przy restarcie (np. darmowy plan Render), się nie nadają, bo razem z plikami znikną wszystkie tablice.

## Konfiguracja

Ustawiasz ją zmiennymi środowiskowymi:

| zmienna | domyślnie | znaczenie |
|---|---|---|
| `PORT` | `8080` | port serwera |
| `HOST` | `0.0.0.0` | adres nasłuchu; `127.0.0.1`, jeśli tablica ma być dostępna tylko przez proxy |
| `DATA_DIR` | `./data` | gdzie trzymać bazę i zdjęcia |
| `REGISTRATION` | `first` | `first`: tylko pierwsze konto, `open`: każdy może założyć konto, `closed`: konta dodajesz poleceniem `add-user` |
| `TRUST_PROXY` | `auto` | czy wierzyć nagłówkom `X-Forwarded-*`. `auto`: tylko od proxy na tym samym komputerze (Caddy, nginx, cloudflared), `1`: zawsze (proxy na innym hoście lub w innym kontenerze), `0`: nigdy |
| `UPLOAD_QUOTA_MB` | `500` | miejsce na zdjęcia dla jednego konta |
| `MAX_ITEMS_PER_PAGE` | `20000` | maksymalna liczba elementów na jednej stronie |
| `MAX_PEERS_PER_BOARD` | `50` | ile osób naraz może być na jednej tablicy |

Stałe limity: zdjęcie do 10 MB (PNG, JPG, GIF, WebP), 100 stron na tablicę, 500 tablic na konto.

## Zarządzanie kontami

Polecenia uruchamiasz na serwerze, w folderze tablicy:

```sh
python server.py list-users                    # lista kont, tablic i zajętego miejsca
python server.py add-user ania@szkola.pl "Ania"  # nowe konto (zapyta o hasło)
python server.py reset-password ania@szkola.pl # nowe hasło i wylogowanie wszystkich urządzeń
python server.py delete-user ania@szkola.pl    # usuwa konto razem z tablicami i zdjęciami
python server.py cleanup                       # sprząta nieużywane zdjęcia (robi to też samo co godzinę)
```

Na Windowsie zamiast `python` użyj `.venv\Scripts\python`, a w Dockerze: `docker compose exec tablica python server.py list-users`.

## Kopie zapasowe i aktualizacja

Wszystkie dane są w folderze `data/`: baza `tablica.db` i zdjęcia w `uploads/`. Kopia zapasowa to skopiowanie tego folderu, najlepiej przy wyłączonej tablicy. Jeśli tablica działa, skopiuj także pliki `tablica.db-wal` i `tablica.db-shm`.

Aktualizacja: podmień pliki programu na nowe (folderu `data/` nie ruszaj) i uruchom tablicę ponownie. Baza dostosuje się sama.

## Bezpieczeństwo i prywatność

- Hasła są hashowane scryptem z losową solą. Sesja to ciasteczko HttpOnly ważne 60 dni.
- Logowanie i rejestracja mają limit prób na adres IP.
- Link do tablicy zawiera losowy klucz. Bez niego tablicy nie da się otworzyć, a „Utwórz nowy link” unieważnia stary.
- Zdjęcia mają losowe adresy i każdy, kto zna adres, może je obejrzeć. Nie wgrywaj niczego poufnego.
- Uczniowie nie mają kont. Ich imię zostaje tylko w ich przeglądarce i nie jest zapisywane na serwerze.
- Strona nie ładuje nic z zewnątrz (czcionki są w paczce), więc działa też bez internetu, w sieci lokalnej.
- Wystawiając tablicę do internetu, używaj HTTPS (Caddy albo tunel Cloudflare robią to automatycznie).

To ty jesteś administratorem danych na swoim serwerze. Przy kilku nauczycielach w szkole to zwykle formalność, ale przy publicznej rejestracji (`REGISTRATION=open`) przyda się polityka prywatności.

## Licencja

Kod: MIT, patrz [LICENSE](LICENSE). Czcionki Atkinson Hyperlegible, STIX Two Text i JetBrains Mono: SIL Open Font License 1.1, patrz [static/fonts/OFL.txt](static/fonts/OFL.txt).
