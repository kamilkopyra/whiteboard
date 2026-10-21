#!/usr/bin/env python3
"""Tablica: wspólna tablica online do korepetycji.

Serwer HTTP + WebSocket (aiohttp) z bazą SQLite.
  - konta nauczycieli (e-mail + hasło), sesje w ciasteczku
  - wiele tablic na konto, każda z wieloma stronami
  - udostępnianie linkiem bez logowania (podgląd albo rysowanie)
  - zmiany i kursory przesyłane na żywo przez WebSocket

Uruchomienie:     python server.py
Administracja:    python server.py --help   (konta: list-users, add-user, reset-password, delete-user)
Konfiguracja przez zmienne środowiskowe, patrz README.md.
"""
import argparse
import asyncio
import getpass
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import shutil
import socket
import sqlite3
import sys
import time
import webbrowser
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout, TCPConnector, WSMsgType, web
from aiohttp.abc import AbstractResolver

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA_DIR = Path(os.environ.get("DATA_DIR", ROOT / "data"))
UPLOADS = DATA_DIR / "uploads"
PORT = int(os.environ.get("PORT", "8080"))
HOST = os.environ.get("HOST", "0.0.0.0")
# "first": only the first account can sign up (default), "open": anyone, "closed": nobody (use add-user)
REGISTRATION = os.environ.get("REGISTRATION", "first").strip().lower()
# Trust X-Forwarded-For / X-Forwarded-Proto: "auto" = only from a proxy on this machine (Caddy, nginx,
# cloudflared), "1" = always (proxy on another host), "0" = never.
TRUST_PROXY = os.environ.get("TRUST_PROXY", "auto").strip().lower()

SESSION_SECONDS = 60 * 24 * 3600
MAX_IMAGE_BYTES = 10 * 1024 * 1024
UPLOAD_QUOTA_BYTES = int(float(os.environ.get("UPLOAD_QUOTA_MB", "500")) * 1024 * 1024)  # per account
MAX_ITEMS_PER_PAGE = int(os.environ.get("MAX_ITEMS_PER_PAGE", "20000"))
MAX_PEERS_PER_BOARD = int(os.environ.get("MAX_PEERS_PER_BOARD", "50"))
MAX_ITEM_JSON = 400_000
MAX_PRESENCE_JSON = 6_000
ORPHAN_UPLOAD_SECONDS = 24 * 3600

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$")
SRC_RE = re.compile(r"^/uploads/[a-f0-9]{32}\.(png|jpg|gif|webp)$")
UPLOAD_NAME_RE = re.compile(r"^[a-f0-9]{32}\.(png|jpg|gif|webp)$")
BGS = {"kratka", "uklad", "linie", "gladka"}
ITEM_TYPES = {"stroke", "shape", "text", "image"}
SHARE_MODES = {"off", "view", "edit"}
IMG_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}
COLORS = ["#2346b8", "#c62828", "#1f7a43", "#b8590b", "#7b3fb3", "#00796b", "#ad1457", "#5d4037"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  pw_hash TEXT NOT NULL, pw_salt TEXT NOT NULL, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS boards(
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, share_token TEXT NOT NULL, share_mode TEXT NOT NULL DEFAULT 'edit',
  created REAL NOT NULL, updated REAL NOT NULL);
CREATE TABLE IF NOT EXISTS pages(
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE, id TEXT NOT NULL,
  name TEXT NOT NULL, ord REAL NOT NULL, bg TEXT NOT NULL, PRIMARY KEY(board_id, id));
CREATE TABLE IF NOT EXISTS items(
  board_id TEXT NOT NULL, page_id TEXT NOT NULL, id TEXT NOT NULL,
  data TEXT NOT NULL, t REAL NOT NULL, PRIMARY KEY(board_id, page_id, id),
  FOREIGN KEY(board_id, page_id) REFERENCES pages(board_id, id) ON DELETE CASCADE);
CREATE TABLE IF NOT EXISTS visits(
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  token TEXT NOT NULL, last REAL NOT NULL, PRIMARY KEY(user_id, board_id));
CREATE TABLE IF NOT EXISTS uploads(
  name TEXT PRIMARY KEY, board_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  size INTEGER NOT NULL, created REAL NOT NULL);
CREATE INDEX IF NOT EXISTS uploads_owner ON uploads(owner_id);
"""


def db_connect():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOADS.mkdir(exist_ok=True)
    con = sqlite3.connect(DATA_DIR / "tablica.db", isolation_level=None)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")  # safe with WAL, avoids a disk flush on every stroke
    con.execute("PRAGMA foreign_keys=ON")
    con.executescript(SCHEMA)
    return con


db = db_connect()


# ---------- helpers ----------
def now():
    return time.time()


def new_id(n=12):
    return secrets.token_urlsafe(n)[:n]


def hash_pw(password, salt_hex):
    return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), n=2**14, r=8, p=1, dklen=32).hex()


def color_for(key):
    return COLORS[int(hashlib.sha1(key.encode()).hexdigest(), 16) % len(COLORS)]


def clean_text(value, limit):
    if not isinstance(value, str):
        return ""
    value = re.sub(r"[\x00-\x1f\x7f]", "", value).strip()
    return value[:limit]


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) < 1e9


def behind_proxy(request):
    if TRUST_PROXY in ("1", "true", "yes"):
        return True
    if TRUST_PROXY != "auto":
        return False
    try:
        return ipaddress.ip_address(request.remote or "").is_loopback
    except ValueError:
        return False


def client_ip(request):
    """The visitor's address for rate limits. Forwarding headers are only believed from a trusted proxy,
    and then the right-most X-Forwarded-For entry (the one our proxy added) is used: earlier entries
    are whatever the client sent and could be forged to dodge the limits."""
    if behind_proxy(request):
        cf = request.headers.get("CF-Connecting-IP", "").strip()
        if cf:
            return cf
        hops = [h.strip() for h in request.headers.get("X-Forwarded-For", "").split(",") if h.strip()]
        if hops:
            return hops[-1]
    return request.remote or "?"


def is_https(request):
    return request.secure or (behind_proxy(request) and request.headers.get("X-Forwarded-Proto") == "https")


_attempts = {}


def prune_attempts():
    t = now()
    for key in [k for k, v in _attempts.items() if not v or t - v[-1] > 3600]:
        del _attempts[key]


def rate_ok(key, limit=10, window=300):
    t = now()
    recent = [x for x in _attempts.get(key, []) if t - x < window]
    ok = len(recent) < limit
    recent.append(t)
    _attempts[key] = recent
    return ok


def err(status, message):
    return web.json_response({"error": message}, status=status)


def current_user(request):
    token = request.cookies.get("sid")
    if not token:
        return None
    row = db.execute(
        "SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.token = ? AND s.expires > ?", (token, now())).fetchone()
    return dict(row) if row else None


def start_session(request, resp, user_id):
    token = secrets.token_urlsafe(32)
    db.execute("INSERT INTO sessions(token, user_id, expires) VALUES(?,?,?)", (token, user_id, now() + SESSION_SECONDS))
    resp.set_cookie("sid", token, max_age=SESSION_SECONDS, httponly=True, samesite="Lax", secure=is_https(request), path="/")


def get_board(board_id):
    if not ID_RE.match(board_id or ""):
        return None
    row = db.execute("SELECT * FROM boards WHERE id = ?", (board_id,)).fetchone()
    return dict(row) if row else None


def board_role(board, user, share):
    """'owner', 'edit', 'view' or None."""
    if user and board["owner_id"] == user["id"]:
        return "owner"
    if share and board["share_mode"] != "off" and hmac.compare_digest(share, board["share_token"]):
        return board["share_mode"]
    return None


def create_board(owner_id, title):
    bid = new_id(10)
    t = now()
    db.execute("INSERT INTO boards(id, owner_id, title, share_token, share_mode, created, updated) VALUES(?,?,?,?,?,?,?)",
               (bid, owner_id, title, secrets.token_urlsafe(16), "edit", t, t))
    db.execute("INSERT INTO pages(board_id, id, name, ord, bg) VALUES(?,?,?,?,?)", (bid, "p1", "Strona 1", 1, "kratka"))
    return bid


def board_summary(b, include_share):
    pages = db.execute("SELECT COUNT(*) FROM pages WHERE board_id = ?", (b["id"],)).fetchone()[0]
    out = {"id": b["id"], "title": b["title"], "updated": b["updated"], "pages": pages,
           "share_mode": b["share_mode"], "live": len(rooms.get(b["id"], {}))}
    if include_share:
        out["share_token"] = b["share_token"]
    return out


async def read_json(request):
    if request.content_type != "application/json":
        raise web.HTTPUnsupportedMediaType(text="JSON required")
    try:
        data = await request.json()
    except Exception:
        raise web.HTTPBadRequest(text="Bad JSON")
    if not isinstance(data, dict):
        raise web.HTTPBadRequest(text="Bad JSON")
    return data


# ---------- middleware ----------
CSP = ("default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
       "font-src 'self'; connect-src 'self' ws: wss:; script-src 'self'; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'self'")


@web.middleware
async def security(request, handler):
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.path.startswith("/api/"):
        origin = request.headers.get("Origin")
        if origin and origin.split("://", 1)[-1] != request.host:
            return err(403, "Niedozwolone źródło żądania.")
    resp = await handler(request)
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "no-referrer")
    resp.headers.setdefault("Content-Security-Policy", CSP)
    return resp


# ---------- pages ----------
async def page_index(request):
    return web.FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})


async def page_board(request):
    return web.FileResponse(STATIC / "board.html", headers={"Cache-Control": "no-cache"})


async def serve_upload(request):
    name = request.match_info["name"]
    path = UPLOADS / name
    if not UPLOAD_NAME_RE.match(name) or not path.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(path, headers={"Cache-Control": "public, max-age=31536000, immutable"})


# ---------- auth API ----------
def registration_open():
    if REGISTRATION == "open":
        return True
    if REGISTRATION == "first":
        return db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
    return False


async def api_config(request):
    no_users = db.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0
    return web.json_response({"registration": registration_open(), "setup": no_users})


def add_user(email, name, password):
    salt = secrets.token_hex(16)
    uid = new_id(16)
    db.execute("INSERT INTO users(id, email, name, pw_hash, pw_salt, created) VALUES(?,?,?,?,?,?)",
               (uid, email, name, hash_pw(password, salt), salt, now()))
    create_board(uid, "Moja pierwsza tablica")
    return uid


async def api_register(request):
    if not registration_open():
        return err(403, "Zakładanie kont jest wyłączone na tym serwerze. Konto może dodać administrator.")
    if not rate_ok("reg:" + client_ip(request), limit=8, window=3600):
        return err(429, "Za dużo prób. Spróbuj ponownie za godzinę.")
    data = await read_json(request)
    email = clean_text(data.get("email"), 254).lower()
    name = clean_text(data.get("name"), 40)
    password = data.get("password") if isinstance(data.get("password"), str) else ""
    if not EMAIL_RE.match(email):
        return err(400, "Podaj poprawny adres e-mail.")
    if not name:
        return err(400, "Podaj imię, które zobaczą uczniowie.")
    if len(password) < 8 or len(password) > 200:
        return err(400, "Hasło musi mieć co najmniej 8 znaków.")
    if db.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
        return err(409, "Konto z tym adresem już istnieje. Zaloguj się.")
    uid = add_user(email, name, password)
    resp = web.json_response({"user": {"id": uid, "email": email, "name": name}})
    start_session(request, resp, uid)
    return resp


async def api_login(request):
    data = await read_json(request)
    email = clean_text(data.get("email"), 254).lower()
    password = data.get("password") if isinstance(data.get("password"), str) else ""
    if not rate_ok("login:" + client_ip(request)) or not rate_ok("login:" + email):
        return err(429, "Za dużo prób logowania. Odczekaj 5 minut.")
    row = db.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if not row or not hmac.compare_digest(hash_pw(password, row["pw_salt"]), row["pw_hash"]):
        return err(401, "Nieprawidłowy e-mail lub hasło.")
    resp = web.json_response({"user": {"id": row["id"], "email": row["email"], "name": row["name"]}})
    start_session(request, resp, row["id"])
    return resp


async def api_logout(request):
    token = request.cookies.get("sid")
    if token:
        db.execute("DELETE FROM sessions WHERE token = ?", (token,))
    resp = web.json_response({"ok": True})
    resp.del_cookie("sid", path="/")
    return resp


async def api_me(request):
    return web.json_response({"user": current_user(request)})


async def api_update_me(request):
    user = current_user(request)
    if not user:
        return err(401, "Zaloguj się.")
    data = await read_json(request)
    name = clean_text(data.get("name"), 40)
    if not name:
        return err(400, "Imię nie może być puste.")
    db.execute("UPDATE users SET name = ? WHERE id = ?", (name, user["id"]))
    return web.json_response({"user": {**user, "name": name}})


# ---------- boards API ----------
async def api_boards(request):
    user = current_user(request)
    if not user:
        return err(401, "Zaloguj się.")
    mine = [board_summary(dict(b), True) for b in
            db.execute("SELECT * FROM boards WHERE owner_id = ? ORDER BY updated DESC", (user["id"],))]
    shared = []
    for r in db.execute(
            "SELECT b.*, v.token AS seen_token, u.name AS owner_name FROM visits v "
            "JOIN boards b ON b.id = v.board_id JOIN users u ON u.id = b.owner_id "
            "WHERE v.user_id = ? ORDER BY v.last DESC", (user["id"],)):
        r = dict(r)
        if r["share_mode"] != "off" and hmac.compare_digest(r["seen_token"], r["share_token"]):
            s = board_summary(r, True)
            s["owner_name"] = r["owner_name"]
            s["role"] = r["share_mode"]
            shared.append(s)
    return web.json_response({"mine": mine, "shared": shared})


async def api_create_board(request):
    user = current_user(request)
    if not user:
        return err(401, "Zaloguj się.")
    data = await read_json(request)
    title = clean_text(data.get("title"), 80) or "Nowa tablica"
    if db.execute("SELECT COUNT(*) FROM boards WHERE owner_id = ?", (user["id"],)).fetchone()[0] >= 500:
        return err(400, "Masz już 500 tablic. Usuń stare, żeby dodać nową.")
    bid = create_board(user["id"], title)
    return web.json_response({"board": board_summary(get_board(bid), True)})


def owned_board(request):
    user = current_user(request)
    if not user:
        raise web.HTTPUnauthorized(text="Zaloguj się.")
    board = get_board(request.match_info["bid"])
    if not board or board["owner_id"] != user["id"]:
        raise web.HTTPNotFound(text="Nie ma takiej tablicy.")
    return user, board


async def api_update_board(request):
    _, board = owned_board(request)
    data = await read_json(request)
    fields = {}
    if "title" in data:
        title = clean_text(data.get("title"), 80)
        if not title:
            return err(400, "Nazwa tablicy nie może być pusta.")
        fields["title"] = title
    if "share_mode" in data:
        if data["share_mode"] not in SHARE_MODES:
            return err(400, "Nieznany tryb udostępniania.")
        fields["share_mode"] = data["share_mode"]
    for key, value in fields.items():
        db.execute(f"UPDATE boards SET {key} = ? WHERE id = ?", (value, board["id"]))
    board.update(fields)
    if "title" in fields:
        await broadcast(board["id"], {"type": "meta", "title": board["title"]})
    if "share_mode" in fields:
        await apply_share_change(board)
    return web.json_response({"board": board_summary(board, True)})


async def api_reset_share(request):
    _, board = owned_board(request)
    board["share_token"] = secrets.token_urlsafe(16)
    db.execute("UPDATE boards SET share_token = ? WHERE id = ?", (board["share_token"], board["id"]))
    await apply_share_change(board, token_changed=True)
    return web.json_response({"board": board_summary(board, True)})


def image_names(where="1=1", args=()):
    """Upload file names referenced by image items matching the condition."""
    names = set()
    for r in db.execute(f"SELECT data FROM items WHERE {where} AND data LIKE '%\"image\"%'", args):
        src = json.loads(r["data"]).get("src")
        if isinstance(src, str) and SRC_RE.match(src):
            names.add(src.rsplit("/", 1)[1])
    return names


def remove_uploads(names):
    for name in names:
        db.execute("DELETE FROM uploads WHERE name = ?", (name,))
        try:
            (UPLOADS / name).unlink()
        except OSError:
            pass


def delete_board(board_id):
    names = image_names("board_id = ?", (board_id,))
    names |= {r["name"] for r in db.execute("SELECT name FROM uploads WHERE board_id = ?", (board_id,))}
    db.execute("DELETE FROM boards WHERE id = ?", (board_id,))
    remove_uploads(names)


async def api_delete_board(request):
    _, board = owned_board(request)
    delete_board(board["id"])
    for c in list(rooms.get(board["id"], {}).values()):
        await c.ws.close(code=4004, message=b"deleted")
    return web.json_response({"ok": True})


async def api_board_meta(request):
    board = get_board(request.match_info["bid"])
    user = current_user(request)
    share = request.query.get("s", "")
    role = board_role(board, user, share) if board else None
    if not role:
        return err(404, "Ta tablica nie istnieje albo link do niej przestał działać.")
    if user and role != "owner":
        db.execute("INSERT INTO visits(user_id, board_id, token, last) VALUES(?,?,?,?) "
                   "ON CONFLICT(user_id, board_id) DO UPDATE SET token = excluded.token, last = excluded.last",
                   (user["id"], board["id"], share, now()))
    owner = db.execute("SELECT name FROM users WHERE id = ?", (board["owner_id"],)).fetchone()
    out = {"id": board["id"], "title": board["title"], "role": role, "owner_name": owner["name"] if owner else "",
           "share_mode": board["share_mode"], "user": user}
    if role == "owner":
        out["share_token"] = board["share_token"]
    return web.json_response(out)


async def api_upload_image(request):
    board = get_board(request.match_info["bid"])
    role = board_role(board, current_user(request), request.query.get("s", "")) if board else None
    if role not in ("owner", "edit"):
        return err(403, "Nie masz prawa dodawać zdjęć na tej tablicy.")
    if not rate_ok("img:" + client_ip(request), limit=60, window=600):
        return err(429, "Za dużo zdjęć naraz. Odczekaj chwilę.")
    ext = IMG_TYPES.get(request.content_type)
    if not ext:
        return err(415, "Obsługiwane są zdjęcia PNG, JPG, GIF i WebP.")
    if request.content_length and request.content_length > MAX_IMAGE_BYTES:
        return err(413, "Zdjęcie jest za duże (limit 10 MB).")
    used = db.execute("SELECT COALESCE(SUM(size), 0) FROM uploads WHERE owner_id = ?", (board["owner_id"],)).fetchone()[0]
    if used + (request.content_length or 0) > UPLOAD_QUOTA_BYTES:
        return err(507, "Na zdjęcia tego nauczyciela nie ma już miejsca. Usuń stare tablice ze zdjęciami.")
    body = await request.read()
    if len(body) > MAX_IMAGE_BYTES:
        return err(413, "Zdjęcie jest za duże (limit 10 MB).")
    if used + len(body) > UPLOAD_QUOTA_BYTES:
        return err(507, "Na zdjęcia tego nauczyciela nie ma już miejsca. Usuń stare tablice ze zdjęciami.")
    name = f"{secrets.token_hex(16)}.{ext}"
    (UPLOADS / name).write_bytes(body)
    db.execute("INSERT INTO uploads(name, board_id, owner_id, size, created) VALUES(?,?,?,?,?)",
               (name, board["id"], board["owner_id"], len(body), now()))
    return web.json_response({"src": f"/uploads/{name}"})


def sweep_orphan_uploads():
    """Deletes uploaded images no board uses any more (erased, cleared, or never placed), after a grace day."""
    used = image_names()
    cutoff = now() - ORPHAN_UPLOAD_SECONDS
    stale = {r["name"] for r in db.execute("SELECT name FROM uploads WHERE created < ?", (cutoff,))} - used
    known = {r["name"] for r in db.execute("SELECT name FROM uploads")}
    for path in UPLOADS.iterdir():  # files from before the uploads table existed
        if UPLOAD_NAME_RE.match(path.name) and path.name not in known and path.name not in used and path.stat().st_mtime < cutoff:
            stale.add(path.name)
    remove_uploads(stale)
    return len(stale)


# ---------- realtime ----------
class Client:
    __slots__ = ("ws", "peer", "name", "color", "role", "user_id", "guest", "presence")

    def __init__(self, ws, peer, name, color, role, user_id):
        self.ws, self.peer, self.name, self.color, self.role, self.user_id = ws, peer, name, color, role, user_id
        self.guest = user_id is None
        self.presence = {}

    def info(self):
        return {"peer": self.peer, "name": self.name, "color": self.color, "guest": self.guest,
                "role": self.role, "presence": self.presence}


rooms = {}  # board_id -> {peer: Client}


async def send(c, msg):
    try:
        await c.ws.send_str(msg if isinstance(msg, str) else json.dumps(msg))
    except (ConnectionResetError, RuntimeError):
        pass


async def broadcast(board_id, msg, exclude=None):
    text = json.dumps(msg)
    targets = [c for c in rooms.get(board_id, {}).values() if c is not exclude]
    if targets:
        await asyncio.gather(*(send(c, text) for c in targets))


async def apply_share_change(board, token_changed=False):
    for c in list(rooms.get(board["id"], {}).values()):
        if c.role == "owner":
            continue
        if board["share_mode"] == "off" or token_changed:
            await c.ws.close(code=4003, message=b"access")
        elif c.role != board["share_mode"]:
            c.role = board["share_mode"]
            await send(c, {"type": "role", "role": c.role})
            await broadcast(board["id"], {"type": "peer", "peer": c.info()}, exclude=c)


def valid_item(item):
    if not isinstance(item, dict) or item.get("type") not in ITEM_TYPES:
        return False
    if item["type"] == "image" and not (isinstance(item.get("src"), str) and SRC_RE.match(item["src"])):
        return False
    return len(json.dumps(item)) <= MAX_ITEM_JSON


def page_exists(bid, pid):
    return db.execute("SELECT 1 FROM pages WHERE board_id = ? AND id = ?", (bid, pid)).fetchone() is not None


_counts = {}  # (board, page) -> (item count, time counted); recounted at most every few seconds


def page_item_count(bid, page):
    hit = _counts.get((bid, page))
    if hit and now() - hit[1] < 5:
        return hit[0]
    n = db.execute("SELECT COUNT(*) FROM items WHERE board_id = ? AND page_id = ?", (bid, page)).fetchone()[0]
    _counts[(bid, page)] = (n, now())
    return n


def page_item_added(bid, page):
    hit = _counts.get((bid, page))
    if hit:
        _counts[(bid, page)] = (hit[0] + 1, hit[1])


_touched = {}


def touch(bid):
    # "last changed" only feeds the board list, so update it at most every 10 s per board
    t = now()
    if t - _touched.get(bid, 0) > 10:
        _touched[bid] = t
        db.execute("UPDATE boards SET updated = ? WHERE id = ?", (t, bid))


async def handle_message(c, bid, m):
    kind = m.get("type")
    if kind == "presence":
        data = m.get("data")
        if isinstance(data, dict) and len(json.dumps(data)) <= MAX_PRESENCE_JSON:
            c.presence = data
            await broadcast(bid, {"type": "presence", "peer": c.peer, "data": data}, exclude=c)
        return
    if kind == "hello":
        if c.guest:
            name = clean_text(m.get("name"), 40)
            if name:
                c.name = name
                await broadcast(bid, {"type": "peer", "peer": c.info()})
        return
    if c.role not in ("owner", "edit"):
        await send(c, {"type": "error", "code": "read_only"})
        return

    page = m.get("page")
    if kind == "put":
        iid, item = m.get("id"), m.get("item")
        if not (isinstance(page, str) and ID_RE.match(page) and isinstance(iid, str) and ID_RE.match(iid) and valid_item(item)):
            return
        if not page_exists(bid, page):
            return
        exists = db.execute("SELECT 1 FROM items WHERE board_id = ? AND page_id = ? AND id = ?", (bid, page, iid)).fetchone()
        if not exists:
            if page_item_count(bid, page) >= MAX_ITEMS_PER_PAGE:
                await send(c, {"type": "error", "code": "page_full"})
                return
            page_item_added(bid, page)
        relay = asyncio.ensure_future(broadcast(bid, {"type": "put", "page": page, "id": iid, "item": item}, exclude=c))
        db.execute("INSERT OR REPLACE INTO items(board_id, page_id, id, data, t) VALUES(?,?,?,?,?)",
                   (bid, page, iid, json.dumps(item), now() * 1000))
        touch(bid)
        await relay
    elif kind == "del":
        ids = m.get("ids")
        if not (isinstance(page, str) and isinstance(ids, list) and len(ids) <= 5000):
            return
        ids = [i for i in ids if isinstance(i, str) and ID_RE.match(i)]
        db.executemany("DELETE FROM items WHERE board_id = ? AND page_id = ? AND id = ?", [(bid, page, i) for i in ids])
        _counts.pop((bid, page), None)
        touch(bid)
        await broadcast(bid, {"type": "del", "page": page, "ids": ids}, exclude=c)
    elif kind == "patch":
        iid, patch = m.get("id"), m.get("patch")
        if not (isinstance(page, str) and isinstance(iid, str) and isinstance(patch, dict)):
            return
        patch = {k: patch[k] for k in ("tx", "ty") if is_num(patch.get(k))}
        row = db.execute("SELECT data FROM items WHERE board_id = ? AND page_id = ? AND id = ?", (bid, page, iid)).fetchone()
        if not row or not patch:
            return
        item = {**json.loads(row["data"]), **patch}
        db.execute("UPDATE items SET data = ? WHERE board_id = ? AND page_id = ? AND id = ?", (json.dumps(item), bid, page, iid))
        touch(bid)
        await broadcast(bid, {"type": "patch", "page": page, "id": iid, "patch": patch}, exclude=c)
    elif kind == "clear":
        if not isinstance(page, str):
            return
        db.execute("DELETE FROM items WHERE board_id = ? AND page_id = ?", (bid, page))
        _counts.pop((bid, page), None)
        touch(bid)
        await broadcast(bid, {"type": "clear", "page": page}, exclude=c)
    elif kind == "page":
        p = m.get("data") or {}
        pid = p.get("id")
        name = clean_text(p.get("name"), 40)
        if not (isinstance(pid, str) and ID_RE.match(pid) and name and is_num(p.get("ord")) and p.get("bg") in BGS):
            return
        if not page_exists(bid, pid) and db.execute("SELECT COUNT(*) FROM pages WHERE board_id = ?", (bid,)).fetchone()[0] >= 100:
            await send(c, {"type": "error", "code": "too_many_pages"})
            return
        page_row = {"id": pid, "name": name, "ord": p["ord"], "bg": p["bg"]}
        db.execute("INSERT INTO pages(board_id, id, name, ord, bg) VALUES(?,?,?,?,?) "
                   "ON CONFLICT(board_id, id) DO UPDATE SET name = excluded.name, ord = excluded.ord, bg = excluded.bg",
                   (bid, pid, name, p["ord"], p["bg"]))
        touch(bid)
        await broadcast(bid, {"type": "page", "data": page_row}, exclude=c)
    elif kind == "pagedel":
        pid = m.get("id")
        if not isinstance(pid, str):
            return
        if db.execute("SELECT COUNT(*) FROM pages WHERE board_id = ?", (bid,)).fetchone()[0] <= 1:
            return
        db.execute("DELETE FROM pages WHERE board_id = ? AND id = ?", (bid, pid))
        touch(bid)
        await broadcast(bid, {"type": "pagedel", "id": pid}, exclude=c)


async def ws_board(request):
    board = get_board(request.match_info["bid"])
    user = current_user(request)
    role = board_role(board, user, request.query.get("s", "")) if board else None
    if not role:
        raise web.HTTPForbidden()
    ws = web.WebSocketResponse(heartbeat=25, max_msg_size=2 * 1024 * 1024)
    await ws.prepare(request)
    if len(rooms.get(board["id"], {})) >= MAX_PEERS_PER_BOARD:
        await ws.close(code=4029, message=b"full")
        return ws

    bid = board["id"]
    peer = secrets.token_hex(6)
    if user:
        name, color = user["name"], color_for(user["id"])
    else:
        name, color = clean_text(request.query.get("name"), 40) or "Gość", color_for(peer)
    c = Client(ws, peer, name, color, role, user["id"] if user else None)
    room = rooms.setdefault(bid, {})

    pages = [dict(r) for r in db.execute("SELECT id, name, ord, bg FROM pages WHERE board_id = ? ORDER BY ord", (bid,))]
    items = [{"page": r["page_id"], "id": r["id"], "item": json.loads(r["data"])}
             for r in db.execute("SELECT page_id, id, data FROM items WHERE board_id = ? ORDER BY t", (bid,))]
    owner = db.execute("SELECT name FROM users WHERE id = ?", (board["owner_id"],)).fetchone()
    await send(c, {"type": "init", "you": c.info(),
                   "board": {"id": bid, "title": board["title"], "owner_name": owner["name"] if owner else ""},
                   "pages": pages, "items": items, "peers": [p.info() for p in room.values()]})
    room[peer] = c
    await broadcast(bid, {"type": "join", "peer": c.info()}, exclude=c)
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except ValueError:
                    continue
                if isinstance(data, dict):
                    await handle_message(c, bid, data)
            elif msg.type == WSMsgType.ERROR:
                break
    finally:
        room.pop(peer, None)
        if not room:
            rooms.pop(bid, None)
        await broadcast(bid, {"type": "leave", "peer": peer})
    return ws


async def housekeeping(app):
    async def loop():
        while True:
            try:
                db.execute("DELETE FROM sessions WHERE expires < ?", (now(),))
                prune_attempts()
                _counts.clear()
                sweep_orphan_uploads()
            except Exception as e:  # never let cleanup take the server down
                print("Sprzątanie nie powiodło się:", e, file=sys.stderr)
            await asyncio.sleep(3600)
    app["housekeeping"] = asyncio.create_task(loop())


# ---------- public link through a Cloudflare quick tunnel ----------
def find_cloudflared():
    candidates = [shutil.which("cloudflared")]
    if os.name == "nt":  # a fresh winget install is not on this window's PATH yet
        for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles")):
            if base:
                candidates.append(os.path.join(base, "cloudflared", "cloudflared.exe"))
        if os.environ.get("LOCALAPPDATA"):
            candidates.append(os.path.join(os.environ["LOCALAPPDATA"], "Microsoft", "WinGet", "Links", "cloudflared.exe"))
    return next((c for c in candidates if c and os.path.isfile(c)), None)


def local_addresses():
    """This computer's addresses in the home network, for devices on the same Wi-Fi."""
    found = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))  # no packet is sent; only picks the outgoing interface
        found.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return sorted(a for a in found if not a.startswith("127."))


def port_taken():
    try:
        with socket.create_connection(("127.0.0.1", PORT), timeout=0.5):
            return True
    except OSError:
        return False


def already_running():
    """True when what listens on PORT is this board (answers /api/config)."""
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/api/config", timeout=2) as r:
            return "registration" in json.loads(r.read())
    except (OSError, ValueError):
        return False


class _PinnedResolver(AbstractResolver):
    """Resolves one host to a fixed address, so a check does not go through (and poison) the OS DNS cache."""
    def __init__(self, host, ip):
        self.host, self.ip = host, ip

    async def resolve(self, host, port=0, family=socket.AF_INET):
        if host != self.host:
            raise OSError(f"unexpected host {host}")
        return [{"hostname": host, "host": self.ip, "port": port, "family": socket.AF_INET, "proto": 0, "flags": 0}]

    async def close(self):
        pass


async def wait_until_reachable(url, timeout=120):
    """Polls the tunnel until the board answers through it. Public DNS is asked over HTTPS and the
    request is pinned to that address: an early lookup through Windows would cache 'no such address'
    for minutes and the browser would keep showing an error."""
    host = url.split("//", 1)[1]
    deadline = time.monotonic() + timeout
    async with ClientSession(timeout=ClientTimeout(total=5)) as doh:
        while time.monotonic() < deadline:
            try:
                async with doh.get("https://cloudflare-dns.com/dns-query", params={"name": host, "type": "A"},
                                   headers={"accept": "application/dns-json"}) as r:
                    answers = [a["data"] for a in (await r.json(content_type=None)).get("Answer", []) if a.get("type") == 1]
                if answers:
                    conn = TCPConnector(resolver=_PinnedResolver(host, answers[0]))
                    async with ClientSession(connector=conn, timeout=ClientTimeout(total=5)) as s:
                        async with s.get(url + "/api/config") as r:
                            if r.status == 200:
                                return True
            except Exception:
                pass
            await asyncio.sleep(1)
    return False


def banner(lines):
    width = max(len(l) for l in lines) + 4
    print("\n" + "=" * width)
    for l in lines:
        print("  " + l)
    print("=" * width + "\n", flush=True)


def tunnel_and_browser(open_browser, use_tunnel):
    state = {}  # tunnel process and tasks (kept here, not on the app, which is frozen once started)
    async def start(app):
        local = f"http://localhost:{PORT}"
        lan = [f"http://{a}:{PORT}" for a in local_addresses()]
        exe = find_cloudflared() if use_tunnel else None
        if not exe:
            lines = [f"Tablica działa: {local}"] + [f"W tym samym Wi-Fi: {u}" for u in lan]
            if use_tunnel:
                lines += ["", "Brak programu cloudflared, więc uczniowie spoza domu nie wejdą.",
                          "Zainstaluj go (Windows: winget install Cloudflare.cloudflared) i uruchom ponownie."]
            lines += ["", "Nie zamykaj tego okna, dopóki trwa lekcja."]
            banner(lines)
            if open_browser:
                webbrowser.open(local)
            return
        print("Łączę z internetem. Zwykle trwa to od kilkunastu sekund do minuty, przeglądarka otworzy się sama...", flush=True)
        proc = await asyncio.create_subprocess_exec(exe, "tunnel", "--no-autoupdate", "--url", local,
                                                    stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        state["proc"] = proc

        async def announce(url):
            # cloudflared prints the address before it is reachable; opening it too early makes
            # Windows remember "no such address" for minutes.
            if not await wait_until_reachable(url):
                print("Adres jeszcze nie odpowiada. Jeśli strona się nie otworzy, odczekaj chwilę i odśwież ją.", flush=True)
            await asyncio.sleep(1)
            banner([f"Twoja tablica w internecie: {url}", "",
                    "Otwórz ten adres, zaloguj się i kliknij „Udostępnij” na tablicy,",
                    "żeby skopiować link dla ucznia. Adres zmienia się przy każdym uruchomieniu.",
                    "", "Nie zamykaj tego okna, dopóki trwa lekcja."])
            if open_browser:
                webbrowser.open(url)

        async def watch():
            url = None
            async for raw in proc.stderr:  # keep reading, or cloudflared stalls on a full pipe
                m = re.search(rb"https://[a-z0-9-]+\.trycloudflare\.com", raw)
                if m and not url:
                    url = m.group(0).decode()
                    state["announce"] = asyncio.create_task(announce(url))
            if not url:
                banner([f"Nie udało się połączyć z internetem. Tablica działa tylko tu: {local}"])
        state["watch"] = asyncio.create_task(watch())

    async def stop(app):
        proc = state.get("proc")
        if proc and proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), 5)
            except asyncio.TimeoutError:
                proc.kill()
    return start, stop


def make_app(open_browser=False, use_tunnel=False):
    app = web.Application(middlewares=[security], client_max_size=MAX_IMAGE_BYTES + 1024)
    app.on_startup.append(housekeeping)
    if open_browser or use_tunnel:
        start, stop = tunnel_and_browser(open_browser, use_tunnel)
        app.on_startup.append(start)
        app.on_cleanup.append(stop)
    r = app.router
    r.add_get("/", page_index)
    r.add_get("/b/{bid}", page_board)
    r.add_get("/api/config", api_config)
    r.add_get("/uploads/{name}", serve_upload)
    r.add_get("/ws/{bid}", ws_board)
    r.add_post("/api/register", api_register)
    r.add_post("/api/login", api_login)
    r.add_post("/api/logout", api_logout)
    r.add_get("/api/me", api_me)
    r.add_patch("/api/me", api_update_me)
    r.add_get("/api/boards", api_boards)
    r.add_post("/api/boards", api_create_board)
    r.add_patch("/api/boards/{bid}", api_update_board)
    r.add_delete("/api/boards/{bid}", api_delete_board)
    r.add_post("/api/boards/{bid}/share-reset", api_reset_share)
    r.add_get("/api/boards/{bid}/meta", api_board_meta)
    r.add_post("/api/boards/{bid}/images", api_upload_image)
    r.add_static("/static/", STATIC)
    return app


# ---------- command line ----------
def ask_password(prompt="Nowe hasło (min. 8 znaków): "):
    while True:
        pw = getpass.getpass(prompt)
        if len(pw) < 8:
            print("Hasło musi mieć co najmniej 8 znaków.")
        elif getpass.getpass("Powtórz hasło: ") != pw:
            print("Hasła się różnią, spróbuj jeszcze raz.")
        else:
            return pw


def find_user(email):
    row = db.execute("SELECT * FROM users WHERE email = ?", (email.strip().lower(),)).fetchone()
    if not row:
        sys.exit(f"Nie ma konta z adresem {email}.")
    return row


def cli(argv):
    for stream in (sys.stdout, sys.stderr):  # an old console code page must not crash the server on "ą" or "„"
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    p = argparse.ArgumentParser(prog="server.py", description="Tablica: serwer i zarządzanie kontami.")
    sub = p.add_subparsers(dest="cmd")
    s = sub.add_parser("serve", help="uruchom serwer (domyślnie)")
    s.add_argument("--tunnel", action="store_true", help="wystaw tablicę do internetu przez tunel Cloudflare")
    s.add_argument("--open", action="store_true", help="otwórz tablicę w przeglądarce")
    sub.add_parser("list-users", help="pokaż konta")
    a = sub.add_parser("add-user", help="dodaj konto (działa też przy wyłączonej rejestracji)")
    a.add_argument("email"); a.add_argument("name")
    r = sub.add_parser("reset-password", help="ustaw nowe hasło i wyloguj wszystkie sesje konta")
    r.add_argument("email")
    d = sub.add_parser("delete-user", help="usuń konto razem z jego tablicami i zdjęciami")
    d.add_argument("email"); d.add_argument("--yes", action="store_true", help="bez pytania o potwierdzenie")
    sub.add_parser("cleanup", help="usuń nieużywane zdjęcia i wygasłe sesje")
    args = p.parse_args(argv)

    if args.cmd in (None, "serve"):
        mode = {"first": "tylko pierwsze konto", "open": "otwarta", "closed": "wyłączona"}.get(REGISTRATION, REGISTRATION)
        use_tunnel, open_browser = getattr(args, "tunnel", False), getattr(args, "open", False)
        if port_taken():
            # Check before starting a tunnel, so a second start does not open a link to nothing.
            if already_running():
                banner(["Tablica już działa w innym oknie.",
                        "Używaj tamtego okna: jest w nim adres dla uczniów.",
                        "Jeśli chcesz uruchomić ją od nowa, zamknij tamto okno i uruchom start.bat ponownie."])
                if open_browser:
                    webbrowser.open(f"http://localhost:{PORT}")
                return
            sys.exit(f"Port {PORT} zajmuje inny program. Zamknij go albo uruchom tablicę na innym porcie (zmienna PORT).")
        print(f"Uruchamiam tablicę (rejestracja: {mode}, dane: {DATA_DIR})", flush=True)
        try:
            web.run_app(make_app(open_browser, use_tunnel), host=HOST, port=PORT, print=None)
        except OSError as e:
            if getattr(e, "errno", None) in (98, 10048):
                sys.exit(f"Port {PORT} jest zajęty. Tablica chyba już działa w innym oknie; zamknij je albo ustaw inny PORT.")
            raise
    elif args.cmd == "list-users":
        rows = db.execute("SELECT u.email, u.name, u.created, (SELECT COUNT(*) FROM boards b WHERE b.owner_id = u.id) AS boards, "
                          "(SELECT COALESCE(SUM(size), 0) FROM uploads x WHERE x.owner_id = u.id) AS bytes FROM users u ORDER BY u.created").fetchall()
        if not rows:
            print("Brak kont.")
        for u in rows:
            print(f"{u['email']:<36} {u['name']:<24} tablice: {u['boards']:<4} zdjęcia: {u['bytes'] / 1048576:.1f} MB  "
                  f"od {time.strftime('%Y-%m-%d', time.localtime(u['created']))}")
    elif args.cmd == "add-user":
        email, name = args.email.strip().lower(), clean_text(args.name, 40)
        if not EMAIL_RE.match(email) or not name:
            sys.exit("Podaj poprawny e-mail i imię.")
        if db.execute("SELECT 1 FROM users WHERE email = ?", (email,)).fetchone():
            sys.exit("Konto z tym adresem już istnieje.")
        add_user(email, name, ask_password("Hasło dla nowego konta (min. 8 znaków): "))
        print(f"Dodano konto {email}.")
    elif args.cmd == "reset-password":
        u = find_user(args.email)
        salt = secrets.token_hex(16)
        db.execute("UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?", (hash_pw(ask_password(), salt), salt, u["id"]))
        db.execute("DELETE FROM sessions WHERE user_id = ?", (u["id"],))
        print(f"Zmieniono hasło dla {u['email']}. Wszystkie sesje tego konta zostały wylogowane.")
    elif args.cmd == "delete-user":
        u = find_user(args.email)
        if not args.yes and input(f"Usunąć {u['email']} razem z tablicami i zdjęciami? Wpisz TAK: ").strip() != "TAK":
            sys.exit("Anulowano.")
        for b in db.execute("SELECT id FROM boards WHERE owner_id = ?", (u["id"],)).fetchall():
            delete_board(b["id"])
        remove_uploads({r["name"] for r in db.execute("SELECT name FROM uploads WHERE owner_id = ?", (u["id"],))})
        db.execute("DELETE FROM users WHERE id = ?", (u["id"],))
        print(f"Usunięto konto {u['email']}.")
    elif args.cmd == "cleanup":
        db.execute("DELETE FROM sessions WHERE expires < ?", (now(),))
        print(f"Usunięto nieużywanych zdjęć: {sweep_orphan_uploads()}.")


if __name__ == "__main__":
    cli(sys.argv[1:])
