// Board: canvas drawing engine + realtime sync over WebSocket.
(() => {
"use strict";
const { api, toast, store, openShareDialog, setTheme, getTheme } = window.T;
const $ = id => document.getElementById(id);

// ---------- constants ----------
const SQ = 20;                    // one notebook square (5 mm) in world units
const UNIT = SQ * 2;              // 1 unit of the coordinate system = 2 squares
const INKS = 6;
const WIDTHS = [2, 4, 8];
const TOOL_KEYS = { p: "pen", m: "marker", l: "line", a: "arrow", r: "rect", o: "ellipse", t: "text", v: "move", e: "eraser", h: "hand" };
const BGS = ["kratka", "uklad", "linie", "gladka"];
const SRC_RE = /^\/uploads\/[a-f0-9]{32}\.(png|jpg|gif|webp)$/;
const BOARD = decodeURIComponent(location.pathname.split("/")[2] || "");
const SHARE = new URLSearchParams(location.search).get("s") || "";

// ---------- state ----------
const cv = $("board");
const ctx = cv.getContext("2d");
const S = {
  tool: "pen", ink: 0, width: 1,
  view: { x: 0, y: 0, z: 1 },     // screen = (world - view.xy) * z
  page: null,
  pages: new Map(),               // id -> {name, ord, bg}
  store: new Map(),               // pageId -> Map(itemId -> item)
  peers: new Map(),               // peer -> {peer, name, color, guest, role, presence}
  me: null, user: null, board: null, role: null,
  follow: null, draft: null, moving: null, erasing: null,
  undo: [], redo: [],
};
const canWrite = () => S.role === "owner" || S.role === "edit";
const pageItems = (p = S.page) => { let m = S.store.get(p); if (!m) { m = new Map(); S.store.set(p, m); } return m; };
let dirty = true, spaceDown = false;
const imgCache = new Map();

// Committed items live in an offscreen layer: a finished stroke is drawn onto it once, and each
// frame only blits the layer and draws what is in motion (drafts, cursors). Rebuilt on change or view change.
const layer = document.createElement("canvas");
const lctx = layer.getContext("2d");
const L = { ready: false, dirty: true, settle: false, timer: null, view: null, page: null, w: 0, h: 0, pending: [] };
function invalidate() { L.dirty = true; dirty = true; }

const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
let palette = {};
function readPalette() {
  palette = { paper: css("--paper"), grid: css("--grid"), gridStrong: css("--grid-strong"), axis: css("--axis"), muted: css("--muted"), accent: css("--accent"),
    fontBoard: css("--font-board") || "serif", fontUi: css("--font-ui") || "sans-serif", fontMono: css("--font-mono") || "monospace" };
  palette.inks = Array.from({ length: INKS }, (_, i) => css("--ink-" + i));
  invalidate();
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", readPalette);
new MutationObserver(readPalette).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

// ---------- geometry ----------
const toWorld = (sx, sy) => ({ x: sx / S.view.z + S.view.x, y: sy / S.view.z + S.view.y });
const r1 = n => Math.round(n * 10) / 10;
const num = v => typeof v === "number" && isFinite(v);
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function measureText(it) {
  ctx.save(); ctx.font = `${it.size}px ${palette.fontBoard}`;
  const lines = String(it.text).split("\n");
  const w = Math.max(...lines.map(l => ctx.measureText(l).width), 4);
  ctx.restore();
  return { w, h: lines.length * it.size * 1.25 };
}
const boxCache = new WeakMap();
function cachedBox(it) { let b = boxCache.get(it); if (!b) { b = bbox(it); boxCache.set(it, b); } return b; }
function bbox(it) {
  const tx = it.tx || 0, ty = it.ty || 0;
  if (it.type === "stroke") {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (let i = 0; i < it.pts.length; i += 2) { a = Math.min(a, it.pts[i]); c = Math.max(c, it.pts[i]); b = Math.min(b, it.pts[i + 1]); d = Math.max(d, it.pts[i + 1]); }
    const h = it.w / 2;
    return { x1: a + tx - h, y1: b + ty - h, x2: c + tx + h, y2: d + ty + h };
  }
  if (it.type === "shape") return { x1: Math.min(it.x1, it.x2) + tx, y1: Math.min(it.y1, it.y2) + ty, x2: Math.max(it.x1, it.x2) + tx, y2: Math.max(it.y1, it.y2) + ty };
  if (it.type === "text") { const m = measureText(it); return { x1: it.x + tx, y1: it.y + ty, x2: it.x + tx + m.w, y2: it.y + ty + m.h }; }
  if (it.type === "image") return { x1: it.x + tx, y1: it.y + ty, x2: it.x + tx + it.w, y2: it.y + ty + it.h };
  return { x1: 0, y1: 0, x2: 0, y2: 0 };
}
function unionBox(items) {
  let bb = null;
  for (const it of items) { const b = bbox(it); bb = bb ? { x1: Math.min(bb.x1, b.x1), y1: Math.min(bb.y1, b.y1), x2: Math.max(bb.x2, b.x2), y2: Math.max(bb.y2, b.y2) } : b; }
  return bb;
}
function hit(it, x, y, tol) {
  const bb = cachedBox(it);
  if (x < bb.x1 - tol || x > bb.x2 + tol || y < bb.y1 - tol || y > bb.y2 + tol) return false;
  const px = x - (it.tx || 0), py = y - (it.ty || 0);
  const t = tol + (it.w || 2) / 2;
  if (it.type === "stroke") {
    const p = it.pts;
    if (p.length === 2) return Math.hypot(px - p[0], py - p[1]) < t;
    for (let i = 0; i + 3 < p.length; i += 2) if (distToSeg(px, py, p[i], p[i + 1], p[i + 2], p[i + 3]) < t) return true;
    return false;
  }
  if (it.type === "shape") {
    const { x1, y1, x2, y2 } = it;
    if (it.kind === "line" || it.kind === "arrow") return distToSeg(px, py, x1, y1, x2, y2) < t;
    if (it.kind === "rect") return distToSeg(px, py, x1, y1, x2, y1) < t || distToSeg(px, py, x2, y1, x2, y2) < t || distToSeg(px, py, x2, y2, x1, y2) < t || distToSeg(px, py, x1, y2, x1, y1) < t;
    if (it.kind === "ellipse") {
      const cx = (x1 + x2) / 2, cy = (y1 + y2) / 2, rx = Math.abs(x2 - x1) / 2 || 1, ry = Math.abs(y2 - y1) / 2 || 1;
      return Math.abs(Math.hypot((px - cx) / rx, (py - cy) / ry) - 1) * Math.min(rx, ry) < t;
    }
  }
  return true; // text, image: inside bbox
}

// ---------- validation of shared data ----------
function sanitizeItem(d) {
  if (!d || typeof d !== "object") return null;
  const base = { t: num(d.t) ? d.t : 0, tx: num(d.tx) ? d.tx : 0, ty: num(d.ty) ? d.ty : 0, ink: num(d.ink) ? Math.abs(d.ink | 0) % INKS : 0 };
  if (d.type === "stroke" && Array.isArray(d.pts) && d.pts.length >= 2 && d.pts.length <= 40000 && d.pts.every(num))
    return { ...base, type: "stroke", pts: d.pts.length % 2 ? d.pts.slice(0, -1) : d.pts, w: num(d.w) ? Math.min(Math.max(d.w, 0.5), 80) : 2, marker: !!d.marker };
  if (d.type === "shape" && ["line", "arrow", "rect", "ellipse"].includes(d.kind) && [d.x1, d.y1, d.x2, d.y2].every(num))
    return { ...base, type: "shape", kind: d.kind, x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2, w: num(d.w) ? Math.min(Math.max(d.w, 0.5), 40) : 2 };
  if (d.type === "text" && typeof d.text === "string" && num(d.x) && num(d.y))
    return { ...base, type: "text", text: d.text.slice(0, 2000), x: d.x, y: d.y, size: num(d.size) ? Math.min(Math.max(d.size, 8), 200) : 24 };
  if (d.type === "image" && typeof d.src === "string" && SRC_RE.test(d.src) && [d.x, d.y, d.w, d.h].every(num))
    return { ...base, type: "image", src: d.src, x: d.x, y: d.y, w: Math.min(Math.abs(d.w), 5000), h: Math.min(Math.abs(d.h), 5000) };
  return null;
}
function sanitizePage(p) {
  if (!p || typeof p.id !== "string") return null;
  return { id: p.id, name: typeof p.name === "string" && p.name ? p.name.slice(0, 40) : "Strona", ord: num(p.ord) ? p.ord : 1, bg: BGS.includes(p.bg) ? p.bg : "kratka" };
}

// ---------- rendering ----------
function resize() {
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(cv.clientWidth * dpr); cv.height = Math.round(cv.clientHeight * dpr);
  dirty = true;
}
function drawBackground(c, w, h, view, bg) {
  c.fillStyle = palette.paper; c.fillRect(0, 0, w, h);
  if (bg === "gladka") return;
  const z = view.z, x0 = view.x, y0 = view.y, x1 = x0 + w / z, y1 = y0 + h / z;
  c.lineWidth = 1;
  if (bg === "linie") {
    let step = SQ * 1.6; while (step * z < 8) step *= 4;
    c.strokeStyle = palette.grid; c.beginPath();
    for (let y = Math.floor(y0 / step) * step; y < y1; y += step) { const sy = Math.round((y - y0) * z) + .5; c.moveTo(0, sy); c.lineTo(w, sy); }
    c.stroke(); return;
  }
  let step = SQ; while (step * z < 7) step *= 5;
  c.strokeStyle = palette.grid; c.beginPath();
  for (let x = Math.floor(x0 / step) * step; x < x1; x += step) { const sx = Math.round((x - x0) * z) + .5; c.moveTo(sx, 0); c.lineTo(sx, h); }
  for (let y = Math.floor(y0 / step) * step; y < y1; y += step) { const sy = Math.round((y - y0) * z) + .5; c.moveTo(0, sy); c.lineTo(w, sy); }
  c.stroke();
  if (bg !== "uklad") return;
  // axes through world origin, ticks every unit (2 squares)
  const ox = -x0 * z, oy = -y0 * z;
  c.strokeStyle = palette.axis; c.fillStyle = palette.axis; c.lineWidth = 1.5;
  c.beginPath(); c.moveTo(0, oy); c.lineTo(w, oy); c.moveTo(ox, 0); c.lineTo(ox, h); c.stroke();
  c.beginPath(); c.moveTo(w - 2, oy); c.lineTo(w - 12, oy - 5); c.lineTo(w - 12, oy + 5); c.fill();
  c.beginPath(); c.moveTo(ox, 2); c.lineTo(ox - 5, 12); c.lineTo(ox + 5, 12); c.fill();
  c.font = `italic 15px ${palette.fontBoard}`;
  c.fillText("x", w - 16, oy - 10); c.fillText("y", ox + 10, 18);
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500];
  const every = steps.find(s => UNIT * z * s >= 28) || 1000;
  const st = UNIT * every;
  c.font = `11px ${palette.fontMono}`; c.textAlign = "center"; c.textBaseline = "top";
  for (let x = Math.ceil(x0 / st) * st; x < x1; x += st) {
    const n = Math.round(x / UNIT); if (!n) continue;
    const sx = (x - x0) * z; c.beginPath(); c.moveTo(sx, oy - 4); c.lineTo(sx, oy + 4); c.stroke();
    c.fillText(String(n), sx, Math.min(Math.max(oy + 6, 4), h - 16));
  }
  c.textAlign = "right"; c.textBaseline = "middle";
  for (let y = Math.ceil(y0 / st) * st; y < y1; y += st) {
    const n = -Math.round(y / UNIT); if (!n) continue;
    const sy = (y - y0) * z; c.beginPath(); c.moveTo(ox - 4, sy); c.lineTo(ox + 4, sy); c.stroke();
    c.fillText(String(n), Math.min(Math.max(ox - 7, 24), w - 4), sy);
  }
  c.textBaseline = "top"; c.fillText("0", ox - 5, oy + 5);
  c.textAlign = "left"; c.textBaseline = "alphabetic";
}
const inkColor = i => palette.inks[(i | 0) % INKS] || palette.inks[0];
function drawItem(c, it) {
  c.save();
  c.translate(it.tx || 0, it.ty || 0);
  const col = inkColor(it.ink);
  c.strokeStyle = col; c.fillStyle = col; c.lineCap = "round"; c.lineJoin = "round";
  if (it.type === "stroke") {
    const p = it.pts;
    c.lineWidth = it.w;
    if (it.marker) { c.globalAlpha *= 0.32; c.lineCap = "square"; }
    if (p.length === 2) { c.beginPath(); c.arc(p[0], p[1], it.w / 2, 0, Math.PI * 2); c.fill(); }
    else {
      c.beginPath(); c.moveTo(p[0], p[1]);
      for (let i = 2; i + 3 < p.length; i += 2) c.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
      c.lineTo(p[p.length - 2], p[p.length - 1]); c.stroke();
    }
  } else if (it.type === "shape") {
    const { x1, y1, x2, y2 } = it; c.lineWidth = it.w; c.beginPath();
    if (it.kind === "line" || it.kind === "arrow") {
      c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke();
      if (it.kind === "arrow") {
        const a = Math.atan2(y2 - y1, x2 - x1), L = 10 + it.w * 2.2;
        c.beginPath(); c.moveTo(x2, y2); c.lineTo(x2 - L * Math.cos(a - 0.42), y2 - L * Math.sin(a - 0.42));
        c.moveTo(x2, y2); c.lineTo(x2 - L * Math.cos(a + 0.42), y2 - L * Math.sin(a + 0.42)); c.stroke();
      }
    } else if (it.kind === "rect") c.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    else if (it.kind === "ellipse") { c.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, Math.PI * 2); c.stroke(); }
  } else if (it.type === "text") {
    c.font = `${it.size}px ${palette.fontBoard}`; c.textBaseline = "top";
    String(it.text).split("\n").forEach((l, i) => c.fillText(l, it.x, it.y + i * it.size * 1.25));
  } else if (it.type === "image") {
    const im = getImage(it.src);
    if (im && im.complete && im.naturalWidth) c.drawImage(im, it.x, it.y, it.w, it.h);
    else {
      c.strokeStyle = palette.muted; c.setLineDash([6, 6]); c.lineWidth = 1; c.strokeRect(it.x, it.y, it.w, it.h); c.setLineDash([]);
      c.fillStyle = palette.muted; c.font = `13px ${palette.fontUi}`; c.fillText(im && im.failed ? "Zdjęcie niedostępne" : "Wczytywanie zdjęcia…", it.x + 10, it.y + 22);
    }
  }
  c.restore();
}
function getImage(src) {
  if (!SRC_RE.test(src || "")) return null;
  let im = imgCache.get(src);
  if (!im) { im = new Image(); im.onload = invalidate; im.onerror = () => { im.failed = true; invalidate(); }; im.src = src; imgCache.set(src, im); }
  return im;
}
// Drawing order is insertion order (the server sends items oldest first; new ones are appended).
function sortedItems() { return [...pageItems().entries()]; }
function pageBg() { const p = S.pages.get(S.page); return p ? p.bg : "kratka"; }
const sameView = (a, b) => a && a.x === b.x && a.y === b.y && a.z === b.z;
function rebuildLayer() {
  const dpr = window.devicePixelRatio || 1, v = S.view;
  if (layer.width !== cv.width || layer.height !== cv.height) { layer.width = cv.width; layer.height = cv.height; }
  lctx.setTransform(1, 0, 0, 1, 0, 0); lctx.clearRect(0, 0, layer.width, layer.height);
  lctx.setTransform(dpr * v.z, 0, 0, dpr * v.z, -v.x * v.z * dpr, -v.y * v.z * dpr);
  const x1 = v.x, y1 = v.y, x2 = v.x + cv.width / dpr / v.z, y2 = v.y + cv.height / dpr / v.z;
  const skip = S.moving && S.moving.id;
  for (const [id, it] of pageItems()) {
    if (id === skip) continue;
    const b = cachedBox(it);
    if (b.x2 < x1 || b.x1 > x2 || b.y2 < y1 || b.y1 > y2) continue;
    lctx.globalAlpha = S.erasing && S.erasing.has(id) ? 0.25 : 1;
    drawItem(lctx, it);
  }
  lctx.globalAlpha = 1;
  Object.assign(L, { ready: true, dirty: false, settle: false, view: { ...v }, page: S.page, w: cv.width, h: cv.height, pending: [] });
}
function render() {
  const dpr = window.devicePixelRatio || 1, w = cv.width / dpr, h = cv.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBackground(ctx, w, h, S.view, pageBg());
  const fits = L.ready && !L.dirty && L.page === S.page && L.w === cv.width && L.h === cv.height;
  const same = fits && sameView(L.view, S.view);
  if (!fits || (!same && (L.settle || L.pending.length))) rebuildLayer();
  else if (!same) {
    // panning or zooming: stretch the last layer now, redraw it sharply a moment later
    if (!L.timer) L.timer = setTimeout(() => { L.timer = null; L.settle = true; dirty = true; }, 120);
  } else if (L.pending.length) { for (const it of L.pending) drawItem(lctx, it); L.pending = []; }
  const k = S.view.z / L.view.z;
  ctx.setTransform(k, 0, 0, k, (L.view.x - S.view.x) * S.view.z * dpr, (L.view.y - S.view.y) * S.view.z * dpr);
  ctx.drawImage(layer, 0, 0);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!sameView(L.view, S.view)) dirty = true; // keep frames coming until the sharp redraw
  ctx.save(); ctx.scale(S.view.z, S.view.z); ctx.translate(-S.view.x, -S.view.y);
  if (S.moving) drawItem(ctx, S.moving.item);
  for (const p of S.peers.values()) {
    const pr = p.presence || {};
    if (p.peer !== S.me?.peer && p.live && pr.page === S.page) { const it = sanitizeItem(p.live); if (it) drawItem(ctx, it); }
  }
  if (S.draft) drawItem(ctx, S.draft);
  if (S.moving) {
    const bb = bbox(S.moving.item), z = S.view.z;
    ctx.strokeStyle = palette.accent; ctx.lineWidth = 1 / z; ctx.setLineDash([5 / z, 4 / z]);
    ctx.strokeRect(bb.x1 - 4, bb.y1 - 4, bb.x2 - bb.x1 + 8, bb.y2 - bb.y1 + 8); ctx.setLineDash([]);
  }
  ctx.restore();
  drawCursors();
  let someoneDrawing = !!S.draft;
  for (const p of S.peers.values()) if (p.live && p.presence && p.presence.page === S.page) someoneDrawing = true;
  $("hint").hidden = !S.page || pageItems().size > 0 || someoneDrawing || !canWrite();
}
function drawCursors() {
  for (const p of S.peers.values()) {
    if (p.peer === S.me?.peer) continue;
    const pr = p.presence || {}, cur = pr.cursor;
    if (!cur || pr.page !== S.page || !num(cur.x) || !num(cur.y)) continue;
    const sx = (cur.x - S.view.x) * S.view.z, sy = (cur.y - S.view.y) * S.view.z;
    ctx.save(); ctx.translate(sx, sy); ctx.fillStyle = p.color; ctx.strokeStyle = palette.paper; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, 16); ctx.lineTo(4.5, 12); ctx.lineTo(8, 19); ctx.lineTo(10.5, 18); ctx.lineTo(7, 11); ctx.lineTo(12.5, 11); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.font = `12px ${palette.fontUi}`; const tw = ctx.measureText(p.name).width;
    ctx.fillStyle = p.color; roundRect(ctx, 12, 18, tw + 12, 20, 6); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.textBaseline = "middle"; ctx.fillText(p.name, 18, 28.5);
    ctx.restore();
  }
}
function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
function loop() { if (dirty) { dirty = false; render(); } requestAnimationFrame(loop); }

// ---------- network ----------
const net = { ws: null, open: false, outbox: [], retry: 0, fatal: false };
function wsUrl() {
  const q = new URLSearchParams();
  if (SHARE) q.set("s", SHARE);
  if (!S.user) q.set("name", guestName());
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/${encodeURIComponent(BOARD)}?${q}`;
}
function connect() {
  if (net.fatal) return;
  const ws = new WebSocket(wsUrl());
  net.ws = ws;
  ws.onmessage = ev => { let m; try { m = JSON.parse(ev.data); } catch { return; } onMessage(m); };
  ws.onclose = ev => {
    if (net.ws !== ws) return;
    net.open = false; setConn();
    if (ev.code === 4003) return fatal("Link przestał działać", "Właściciel tablicy wyłączył ten link albo utworzył nowy. Poproś go o aktualny link.");
    if (ev.code === 4004) return fatal("Tablica została usunięta", "Właściciel usunął tę tablicę.");
    if (ev.code === 4029) return fatal("Tablica jest pełna", "Na tej tablicy jest teraz za dużo osób naraz. Spróbuj za chwilę.");
    const delay = Math.min(10000, 500 * 2 ** net.retry++) + Math.random() * 400;
    setTimeout(async () => { if (await checkAccess()) connect(); }, delay);
  };
}
function send(m) {
  if (net.open && net.ws && net.ws.readyState === 1) net.ws.send(JSON.stringify(m));
  else if (m.type !== "presence" && m.type !== "hello") net.outbox.push(m);
}
function setConn() {
  const c = $("conn"), others = [...S.peers.values()].filter(p => p.peer !== S.me?.peer).length;
  c.classList.toggle("live", net.open);
  c.querySelector("span").textContent = !net.open ? "Łączenie…" : others ? `${others + 1} na tablicy` : "Tylko ty";
  c.title = net.open ? "Połączono z serwerem" : "Brak połączenia. Zmiany zapiszą się po powrocie połączenia.";
}
function fatal(title, text) {
  net.fatal = true;
  $("fatalTitle").textContent = title; $("fatalText").textContent = text; $("fatal").hidden = false;
  document.title = title;
}

function onMessage(m) {
  switch (m.type) {
    case "init": {
      S.me = m.you; S.role = m.you.role;
      S.board = { ...(S.board || {}), ...m.board };
      S.pages = new Map(); for (const p of m.pages || []) { const sp = sanitizePage(p); if (sp) S.pages.set(sp.id, sp); }
      S.store = new Map();
      for (const r of m.items || []) { const it = sanitizeItem(r.item); if (it && typeof r.id === "string") pageItems(r.page).set(r.id, it); }
      S.peers = new Map(); for (const p of m.peers || []) S.peers.set(p.peer, p);
      S.peers.set(S.me.peer, { ...S.me, presence: {} });
      net.open = true; net.retry = 0;
      const queued = net.outbox; net.outbox = [];
      for (const q of queued) { applyRemote(q); send(q); }
      if (!S.page || !S.pages.has(S.page)) S.page = firstPage();
      L.dirty = true;
      applyRole(); setTitle(); renderPages(); renderPeople(); setConn(); sendPresence(); dirty = true;
      break;
    }
    case "role": S.role = m.role; applyRole(); break;
    case "meta": if (typeof m.title === "string") { S.board.title = m.title; setTitle(); } break;
    case "join": case "peer": if (m.peer && m.peer.peer) { const prev = S.peers.get(m.peer.peer); S.peers.set(m.peer.peer, { ...m.peer, presence: (prev && prev.presence) || m.peer.presence || {}, live: prev ? prev.live : null }); if (m.peer.peer === S.me?.peer) S.me = { ...S.me, ...m.peer }; renderPeople(); setConn(); dirty = true; } break;
    case "leave": S.peers.delete(m.peer); if (S.follow === m.peer) stopFollow(); renderPeople(); setConn(); dirty = true; break;
    case "presence": {
      const p = S.peers.get(m.peer); if (!p || !m.data || typeof m.data !== "object") break;
      p.presence = m.data; mergeDraft(p, m.data.draft); dirty = true;
      if (S.follow === m.peer) applyFollow();
      break;
    }
    case "error":
      if (m.code === "read_only") toast("Masz dostęp tylko do podglądu.");
      if (m.code === "too_many_pages") toast("Tablica może mieć najwyżej 100 stron.");
      if (m.code === "page_full") toast("Ta strona jest pełna. Dodaj nową stronę przyciskiem +.");
      break;
    default: applyRemote(m);
  }
}
// Applies a change message (from others, or replayed from our outbox) to local state.
function applyRemote(m) {
  const here = m.page === S.page;
  if (m.type === "put") {
    const it = sanitizeItem(m.item); if (!it) return;
    const items = pageItems(m.page), fresh = !items.has(m.id);
    items.set(m.id, it);
    if (here) { if (fresh) L.pending.push(it); else L.dirty = true; }
  }
  else if (m.type === "del") { const items = pageItems(m.page); for (const id of m.ids || []) items.delete(id); if (here) L.dirty = true; }
  else if (m.type === "patch") { const items = pageItems(m.page), cur = items.get(m.id); if (cur && m.patch) { items.set(m.id, { ...cur, tx: num(m.patch.tx) ? m.patch.tx : cur.tx, ty: num(m.patch.ty) ? m.patch.ty : cur.ty }); if (here) L.dirty = true; } }
  else if (m.type === "clear") { pageItems(m.page).clear(); if (here) L.dirty = true; }
  else if (m.type === "page") { const sp = sanitizePage(m.data); if (sp) { S.pages.set(sp.id, sp); renderPages(); } }
  else if (m.type === "pagedel") { S.pages.delete(m.id); S.store.delete(m.id); if (S.page === m.id) gotoPage(firstPage(), true); renderPages(); }
  dirty = true;
}
function emit(m) { applyRemote(m); send(m); }

// ---------- local edits ----------
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const putItem = (id, item, page = S.page) => emit({ type: "put", page, id, item });
const removeItems = (ids, page = S.page) => ids.length && emit({ type: "del", page, ids });
const patchItem = (id, patch, page = S.page) => emit({ type: "patch", page, id, patch });
function savePage(id, fields) {
  const p = { ...(S.pages.get(id) || { id, name: "Strona", ord: 1, bg: "kratka" }), ...fields, id };
  emit({ type: "page", data: p });
}

// ---------- undo / redo ----------
// entries: {op:"add", id, page, item} | {op:"del", list:[{id,item}], page} | {op:"move", id, page, from, to}
function pushUndo(e) { S.undo.push(e); if (S.undo.length > 200) S.undo.shift(); S.redo = []; syncUndo(); }
function syncUndo() { $("undoBtn").disabled = !S.undo.length || !canWrite(); $("redoBtn").disabled = !S.redo.length || !canWrite(); }
function applyEntry(e, dir) {
  if (!S.pages.has(e.page)) return false;
  if (e.page !== S.page) gotoPage(e.page);
  if (e.op === "add") dir < 0 ? removeItems([e.id], e.page) : putItem(e.id, e.item, e.page);
  else if (e.op === "del") { if (dir < 0) e.list.forEach(({ id, item }) => putItem(id, item, e.page)); else removeItems(e.list.map(x => x.id), e.page); }
  else if (e.op === "move") patchItem(e.id, dir < 0 ? e.from : e.to, e.page);
  return true;
}
function undo() { if (!canWrite()) return; const e = S.undo.pop(); if (!e) return; if (applyEntry(e, -1)) S.redo.push(e); syncUndo(); }
function redo() { if (!canWrite()) return; const e = S.redo.pop(); if (!e) return; if (applyEntry(e, 1)) S.undo.push(e); syncUndo(); }

// ---------- pages ----------
function orderedPages() { return [...S.pages.values()].sort((a, b) => a.ord - b.ord || (a.id < b.id ? -1 : 1)); }
function firstPage() { const l = orderedPages(); return l.length ? l[0].id : null; }
function renderPages() {
  const nav = $("pages"); nav.textContent = "";
  for (const p of orderedPages()) {
    const b = document.createElement("button"); b.className = "pg"; b.textContent = p.name;
    b.setAttribute("aria-current", String(p.id === S.page)); b.onclick = () => gotoPage(p.id); nav.appendChild(b);
  }
  if (canWrite()) {
    const add = document.createElement("button"); add.className = "pg add"; add.textContent = "+"; add.title = "Nowa strona"; add.setAttribute("aria-label", "Dodaj stronę");
    add.onclick = addPage; nav.appendChild(add);
  }
  const cur = S.pages.get(S.page), inp = $("pageName");
  if (cur && document.activeElement !== inp) inp.value = cur.name;
  document.querySelectorAll("#bgRow .chip-btn").forEach(c => c.setAttribute("aria-pressed", String(c.dataset.bg === pageBg())));
  $("delPageBtn").disabled = S.pages.size <= 1;
}
function addPage() {
  const list = orderedPages(), ord = (list.length ? list[list.length - 1].ord : 0) + 1;
  if (list.length >= 100) { toast("Tablica może mieć najwyżej 100 stron."); return; }
  const id = "p" + newId();
  savePage(id, { name: "Strona " + (list.length + 1), ord, bg: pageBg() });
  gotoPage(id);
}
const views = new Map();
function gotoPage(id, force) {
  if (!id || (id === S.page && !force)) return;
  closeTextEditor(true);
  if (S.page) views.set(S.page, { ...S.view });
  S.page = id; S.draft = null; S.moving = null; S.erasing = null;
  S.view = views.get(id) || centeredView();
  updateZoomLabel(); renderPages(); dirty = true; sendPresence();
}
function centeredView() { return { x: -cv.clientWidth / 2 + 40, y: -cv.clientHeight / 2 + 20, z: 1 }; }

// ---------- presence / people ----------
// Presence (cursor, view, the stroke being drawn) goes out at most ~30 times a second. A stroke in
// progress is sent as increments: each message carries only the points added since the previous one.
const pres = { page: null, cursor: null, draft: null, view: null, follow: null };
const PRESENCE_MS = 33;
let presTimer = null, presLast = 0;
function sendPresence(patch) {
  if (patch) Object.assign(pres, patch);
  if (presTimer) return;
  presTimer = setTimeout(flushPresence, Math.max(0, PRESENCE_MS - (performance.now() - presLast)));
}
function flushPresence() {
  presTimer = null; presLast = performance.now();
  pres.page = S.page;
  pres.view = { x: r1(S.view.x), y: r1(S.view.y), z: Math.round(S.view.z * 1000) / 1000, w: cv.clientWidth, h: cv.clientHeight };
  pres.draft = draftChunk();
  if (net.open) send({ type: "presence", data: pres });
}
const sentDraft = { did: null, n: 0 };
function draftChunk() {
  const d = S.draft;
  if (!d) return null;
  if (d.type === "shape") return d;
  if (d.type !== "stroke") return null;
  if (sentDraft.did !== d.did) { sentDraft.did = d.did; sentDraft.n = 0; }
  const from = sentDraft.n;
  if (net.open) sentDraft.n = d.pts.length;
  return { did: d.did, type: "stroke", w: d.w, ink: d.ink, marker: d.marker, t: d.t, from, pts: d.pts.slice(from) };
}
// Rebuilds another person's in-progress stroke from the increments.
function mergeDraft(p, d) {
  if (!d || typeof d !== "object") { p.live = null; return; }
  if (d.type !== "stroke") { p.live = d; return; }
  if (!Array.isArray(d.pts) || d.pts.length > 4000 || !num(d.from)) return;
  const cur = p.live;
  if (d.from === 0) p.live = { ...d, pts: d.pts.slice() };
  else if (cur && cur.did === d.did && d.from === cur.pts.length) { for (const v of d.pts) cur.pts.push(v); }
  else if (!cur || cur.did !== d.did) p.live = null; // joined mid-stroke: wait for the next one
}
function initials(name) { return (name || "?").trim().split(/\s+/).slice(0, 2).map(s => s[0]).join("").toUpperCase() || "?"; }
function renderPeople() {
  const box = $("avatars"); box.textContent = "";
  const list = [...S.peers.values()].sort((a, b) => (a.peer === S.me?.peer ? -1 : b.peer === S.me?.peer ? 1 : 0));
  for (const p of list.slice(0, 6)) {
    const mine = p.peer === S.me?.peer;
    const b = document.createElement("button"); b.className = "av" + (S.follow === p.peer ? " following" : "");
    b.style.background = p.color; b.textContent = initials(p.name);
    const label = mine ? `Ty (${p.name})` : S.follow === p.peer ? `${p.name}: przestań śledzić widok` : `${p.name}: śledź widok tej osoby`;
    b.title = label + (p.role === "view" ? " · tylko podgląd" : ""); b.setAttribute("aria-label", b.title);
    b.onclick = mine ? () => { if (!S.user) openNameModal(true); } : () => toggleFollow(p.peer);
    box.appendChild(b);
  }
  if (list.length > 6) { const m = document.createElement("span"); m.className = "av more"; m.textContent = "+" + (list.length - 6); box.appendChild(m); }
}
function toggleFollow(peer) {
  S.follow = S.follow === peer ? null : peer;
  sendPresence({ follow: S.follow ? { of: S.follow } : null });
  toast(S.follow ? "Śledzisz widok tej osoby. Przesuń tablicę, żeby przestać." : "Nie śledzisz już niczyjego widoku.");
  applyFollow(); renderPeople();
}
function stopFollow() { if (S.follow) { S.follow = null; sendPresence({ follow: null }); renderPeople(); } }
function applyFollow() {
  if (!S.follow) return;
  const p = S.peers.get(S.follow); if (!p) { stopFollow(); return; }
  const pr = p.presence || {}, v = pr.view;
  if (typeof pr.page === "string" && pr.page !== S.page && S.pages.has(pr.page)) gotoPage(pr.page);
  if (v && num(v.x) && num(v.y) && num(v.z) && num(v.w) && num(v.h) && v.z > 0) {
    const z = clampZ(Math.min(cv.clientWidth / (v.w / v.z), cv.clientHeight / (v.h / v.z)));
    const cx = v.x + v.w / v.z / 2, cy = v.y + v.h / v.z / 2;
    S.view = { z, x: cx - cv.clientWidth / 2 / z, y: cy - cv.clientHeight / 2 / z };
    updateZoomLabel(); dirty = true;
  }
}

// ---------- input ----------
// One pointer draws at a time (`active`). Touches are tracked separately so that a palm resting on
// the screen never blocks or cancels the stylus: once a pen has been seen, fingers only move the view.
const touches = new Map();        // pointerId -> screen point, touch contacts only
let active = null;                // {id, type} of the pointer currently drawing / panning
let penSeen = false, gesture = null, panStart = null, lastCursor = null;
function screenPt(e) { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
const clampZ = z => Math.min(8, Math.max(0.1, z));
function zoomAt(sx, sy, factor) {
  const w = toWorld(sx, sy), z = clampZ(S.view.z * factor);
  S.view = { z, x: w.x - sx / z, y: w.y - sy / z }; updateZoomLabel(); dirty = true; sendPresence();
}
function updateZoomLabel() { $("zoomReset").textContent = Math.round(S.view.z * 100) + "%"; }

function startGesture() {
  const [a, b] = [...touches.values()];
  gesture = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
}
function abandonActive() { // a second finger turned a one-finger stroke into a pinch
  if (S.moving) { pageItems().set(S.moving.id, S.moving.orig); S.moving = null; }
  S.draft = null; S.erasing = null; panStart = null; active = null; L.dirty = true; dirty = true;
  cv.classList.remove("dragging"); sendPresence();
}
function beginPan(sp) { panStart = { sx: sp.x, sy: sp.y, vx: S.view.x, vy: S.view.y }; cv.classList.add("dragging"); stopFollow(); }

function onDown(e) {
  if (!S.page || e.button === 2) return;
  if (e.pointerType !== "mouse") e.preventDefault(); // no pen/touch gestures, selection or press-and-hold menu
  const sp = screenPt(e);
  if (e.pointerType === "touch") {
    if (active && active.type === "pen") return;      // palm or finger while writing: ignore
    touches.set(e.pointerId, sp);
    try { cv.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    if (touches.size >= 2) { if (active) abandonActive(); if (touches.size === 2) startGesture(); stopFollow(); return; }
    if (penSeen || !canWrite()) { active = { id: e.pointerId, type: "touch", t0: performance.now(), x0: sp.x, y0: sp.y }; beginPan(sp); return; }
  } else {
    if (e.pointerType === "pen" && !penSeen) {
      penSeen = true;
      if (canWrite() && !store.get("tablica.tapHint")) { store.set("tablica.tapHint", "1"); toast("Wskazówka: stuknij dwa razy palcem w ekran, żeby przełączyć się na gumkę i z powrotem.", 6000); }
    }
    if (active) finishActive();                       // previous pen-up never arrived: close it, start fresh
    if (gesture) { gesture = null; touches.clear(); } // pen wins over a pinch in progress
    try { cv.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
  }
  active = { id: e.pointerId, type: e.pointerType };
  const wp = toWorld(sp.x, sp.y);
  const tool = (spaceDown || e.button === 1 || !canWrite()) ? "hand" : S.tool;
  if (tool === "hand") { beginPan(sp); return; }
  if (tool === "pen" || tool === "marker") {
    const w = WIDTHS[S.width] * (tool === "marker" ? 4 : 1);
    S.draft = { type: "stroke", pts: [r1(wp.x), r1(wp.y)], w, ink: S.ink, marker: tool === "marker", t: Date.now(), did: newId() };
  } else if (["line", "arrow", "rect", "ellipse"].includes(tool)) {
    S.draft = { type: "shape", kind: tool, x1: r1(wp.x), y1: r1(wp.y), x2: r1(wp.x), y2: r1(wp.y), w: WIDTHS[S.width], ink: S.ink, t: Date.now() };
  } else if (tool === "eraser") {
    S.erasing = new Map(); eraseAt(wp);
  } else if (tool === "move") {
    const found = topHit(wp, 6 / S.view.z);
    if (found) { const [id, it] = found; S.moving = { id, orig: it, item: { ...it }, from: { tx: it.tx || 0, ty: it.ty || 0 }, start: wp }; L.dirty = true; }
  } else if (tool === "text") {
    e.preventDefault(); // otherwise the mouse's default action blurs the editor we are about to focus
    active = null; openTextEditor(wp); return;
  }
  dirty = true;
}
cv.addEventListener("pointerdown", onDown);
cv.addEventListener("pointermove", e => {
  const sp = screenPt(e);
  if (touches.has(e.pointerId)) {
    touches.set(e.pointerId, sp);
    if (gesture && touches.size >= 2) {
      const [a, b] = [...touches.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      S.view.x -= (cx - gesture.cx) / S.view.z; S.view.y -= (cy - gesture.cy) / S.view.z;
      zoomAt(cx, cy, d / gesture.d); gesture = { d, cx, cy }; return;
    }
  }
  const mine = active && active.id === e.pointerId;
  if (!mine && e.pointerType === "touch") return;
  // Some pens re-touch so quickly that the browser never sends pointerdown, only moves with the
  // tip pressed. Treat the first such move as the start of a new stroke instead of losing it.
  if (!mine && !active && (e.buttons & 1) && e.pointerType !== "mouse") { onDown(e); return; }
  const wp = toWorld(sp.x, sp.y);
  $("coords").textContent = `x ${(wp.x / UNIT).toFixed(1)} · y ${(-wp.y / UNIT).toFixed(1)}`;
  lastCursor = { x: Math.round(wp.x), y: Math.round(wp.y) };
  if (!mine) { sendPresence({ cursor: lastCursor }); return; }
  if (panStart) { S.view.x = panStart.vx - (sp.x - panStart.sx) / S.view.z; S.view.y = panStart.vy - (sp.y - panStart.sy) / S.view.z; dirty = true; sendPresence(); return; }
  const d = S.draft;
  if (d && d.type === "stroke") {
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of evs.length ? evs : [e]) {
      const s = screenPt(ev), q = toWorld(s.x, s.y);
      const lx = d.pts[d.pts.length - 2], ly = d.pts[d.pts.length - 1];
      if (Math.hypot(q.x - lx, q.y - ly) * S.view.z > 1) d.pts.push(r1(q.x), r1(q.y));
    }
  } else if (d && d.type === "shape") {
    let x2 = wp.x, y2 = wp.y;
    if (e.shiftKey) {
      if (d.kind === "rect" || d.kind === "ellipse") { const s = Math.max(Math.abs(x2 - d.x1), Math.abs(y2 - d.y1)); x2 = d.x1 + Math.sign(x2 - d.x1 || 1) * s; y2 = d.y1 + Math.sign(y2 - d.y1 || 1) * s; }
      else { const a = Math.round(Math.atan2(y2 - d.y1, x2 - d.x1) / (Math.PI / 12)) * (Math.PI / 12), L = Math.hypot(x2 - d.x1, y2 - d.y1); x2 = d.x1 + L * Math.cos(a); y2 = d.y1 + L * Math.sin(a); }
    }
    if (e.altKey) { d.x1 = Math.round(d.x1 / SQ) * SQ; d.y1 = Math.round(d.y1 / SQ) * SQ; x2 = Math.round(x2 / SQ) * SQ; y2 = Math.round(y2 / SQ) * SQ; }
    d.x2 = r1(x2); d.y2 = r1(y2);
  } else if (S.erasing) eraseAt(wp);
  else if (S.moving) {
    const m = S.moving; m.item.tx = r1(m.from.tx + wp.x - m.start.x); m.item.ty = r1(m.from.ty + wp.y - m.start.y);
    pageItems().set(m.id, m.item);
  }
  dirty = true;
  sendPresence({ cursor: lastCursor });
});
function finishActive() {
  active = null;
  if (panStart) { panStart = null; cv.classList.remove("dragging"); }
  if (S.draft) {
    const d = S.draft; S.draft = null; delete d.did;
    let ok = true;
    if (d.type === "shape" && Math.hypot(d.x2 - d.x1, d.y2 - d.y1) < 2) ok = false;
    if (d.type === "stroke" && d.pts.length > 4) d.pts = simplify(d.pts, 0.35);
    if (ok) { const id = newId(); putItem(id, d); pushUndo({ op: "add", id, page: S.page, item: d }); }
    sendPresence();
  }
  if (S.erasing) {
    const list = [...S.erasing.entries()].map(([id, item]) => ({ id, item }));
    S.erasing = null; L.dirty = true;
    if (list.length) { removeItems(list.map(x => x.id)); pushUndo({ op: "del", list, page: S.page }); }
  }
  if (S.moving) {
    const m = S.moving; S.moving = null; L.dirty = true;
    const to = { tx: m.item.tx || 0, ty: m.item.ty || 0 };
    if (to.tx !== m.from.tx || to.ty !== m.from.ty) { patchItem(m.id, to); pushUndo({ op: "move", id: m.id, page: S.page, from: m.from, to }); }
  }
  dirty = true;
}
function endPointer(e) {
  if (touches.delete(e.pointerId) && gesture) { if (touches.size < 2) gesture = null; return; }
  if (active && active.id === e.pointerId) {
    const a = active; finishActive();
    if (a.type === "touch" && a.t0 && e.type === "pointerup") fingerTap(a, screenPt(e));
  }
}
// With a stylus in use, a quick finger double-tap toggles the eraser (like double-tapping the Apple Pencil).
let lastTap = null, toolBeforeEraser = "pen";
function fingerTap(a, sp) {
  const now = performance.now();
  if (now - a.t0 > 250 || Math.hypot(sp.x - a.x0, sp.y - a.y0) > 12) { lastTap = null; return; }
  if (lastTap && now - lastTap.t < 400 && Math.hypot(sp.x - lastTap.x, sp.y - lastTap.y) < 60) { lastTap = null; toggleEraser(); }
  else lastTap = { t: now, x: sp.x, y: sp.y };
}
const TOOL_NAMES = { pen: "Pióro", marker: "Zakreślacz", line: "Odcinek", arrow: "Wektor", rect: "Prostokąt", ellipse: "Okrąg", text: "Tekst", move: "Przesuwanie", eraser: "Gumka", hand: "Przesuwanie widoku" };
function toggleEraser() {
  if (!canWrite()) return;
  if (S.tool === "eraser") setTool(toolBeforeEraser === "eraser" ? "pen" : toolBeforeEraser);
  else { toolBeforeEraser = S.tool; setTool("eraser"); }
  toast(TOOL_NAMES[S.tool] || S.tool, 1200);
}
cv.addEventListener("pointerup", endPointer);
cv.addEventListener("pointercancel", endPointer);
// iOS/iPadOS: without this, quick successive pen or finger taps wait for the double-tap-zoom and
// magnifier recognisers before pointer events are delivered.
for (const type of ["touchstart", "touchmove", "touchend"]) cv.addEventListener(type, e => e.preventDefault(), { passive: false });
for (const type of ["gesturestart", "gesturechange", "dblclick", "selectstart"]) cv.addEventListener(type, e => e.preventDefault());
cv.addEventListener("pointerleave", () => sendPresence({ cursor: null }));
cv.addEventListener("contextmenu", e => e.preventDefault());
cv.addEventListener("wheel", e => {
  e.preventDefault(); stopFollow();
  const sp = screenPt(e);
  if (e.ctrlKey || e.metaKey) zoomAt(sp.x, sp.y, Math.exp(-e.deltaY * 0.01));
  else { S.view.x += e.deltaX / S.view.z; S.view.y += e.deltaY / S.view.z; dirty = true; sendPresence(); }
}, { passive: false });

function topHit(wp, tol) { const all = sortedItems(); for (let i = all.length - 1; i >= 0; i--) if (hit(all[i][1], wp.x, wp.y, tol)) return all[i]; return null; }
function eraseAt(wp) {
  const tol = 8 / S.view.z;
  for (const [id, it] of pageItems()) if (!S.erasing.has(id) && hit(it, wp.x, wp.y, tol)) { S.erasing.set(id, it); L.dirty = true; }
}
// Ramer–Douglas–Peucker on flat [x,y,...]
function simplify(p, eps) {
  const n = p.length / 2; if (n < 3) return p;
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let md = 0, mi = -1;
    for (let i = a + 1; i < b; i++) { const d = distToSeg(p[2 * i], p[2 * i + 1], p[2 * a], p[2 * a + 1], p[2 * b], p[2 * b + 1]); if (d > md) { md = d; mi = i; } }
    if (md > eps) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  const out = []; for (let i = 0; i < n; i++) if (keep[i]) out.push(p[2 * i], p[2 * i + 1]); return out;
}

// ---------- text ----------
let editor = null;
function openTextEditor(wp) {
  closeTextEditor(true);
  const size = [20, 28, 44][S.width];
  const ta = document.createElement("textarea"); ta.id = "textEditor"; ta.rows = 1; ta.spellcheck = false;
  ta.setAttribute("aria-label", "Wpisz tekst. Enter zatwierdza, Shift+Enter dodaje nową linię.");
  ta.style.left = (wp.x - S.view.x) * S.view.z + "px"; ta.style.top = (wp.y - S.view.y) * S.view.z + "px";
  ta.style.fontSize = size * S.view.z + "px"; ta.style.color = inkColor(S.ink);
  const grow = () => { ta.style.height = "auto"; ta.style.width = "auto"; ta.style.height = ta.scrollHeight + "px"; ta.style.width = Math.max(40, ta.scrollWidth + 8) + "px"; };
  $("app").appendChild(ta);
  editor = { ta, wp: { x: r1(wp.x), y: r1(wp.y) }, size, ink: S.ink, page: S.page };
  ta.addEventListener("input", grow);
  ta.addEventListener("keydown", ev => {
    ev.stopPropagation();
    if (ev.key === "Escape") closeTextEditor(false);
    else if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); closeTextEditor(true); }
  });
  ta.addEventListener("blur", () => setTimeout(() => { if (editor && editor.ta === ta) closeTextEditor(true); }, 0));
  grow(); ta.focus(); setTimeout(() => ta.focus(), 0); // focus inside the tap so phones open the keyboard
}
function closeTextEditor(commit) {
  if (!editor) return; const ed = editor; editor = null;
  const text = ed.ta.value.replace(/\s+$/, ""); ed.ta.remove();
  if (commit && text && canWrite()) {
    const it = { type: "text", text, x: ed.wp.x, y: ed.wp.y, size: ed.size, ink: ed.ink, t: Date.now() };
    const id = newId(); putItem(id, it, ed.page); pushUndo({ op: "add", id, page: ed.page, item: it });
  }
}

// ---------- images ----------
async function insertImage(blob) {
  if (!canWrite()) return;
  if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(blob.type)) { toast("Obsługiwane są zdjęcia PNG, JPG, GIF i WebP."); return; }
  if (blob.size > 10 * 1024 * 1024) { toast("Zdjęcie jest za duże (limit 10 MB)."); return; }
  toast("Wysyłanie zdjęcia…", 15000);
  try {
    const dims = await new Promise((res, rej) => { const u = URL.createObjectURL(blob), im = new Image(); im.onload = () => { res({ w: im.naturalWidth, h: im.naturalHeight }); URL.revokeObjectURL(u); }; im.onerror = rej; im.src = u; });
    const q = SHARE ? "?s=" + encodeURIComponent(SHARE) : "";
    const up = await api("POST", `/api/boards/${encodeURIComponent(BOARD)}/images${q}`, blob);
    const maxW = Math.min(560, cv.clientWidth * 0.7) / S.view.z, sc = Math.min(1, maxW / dims.w);
    const w = r1(dims.w * sc), h = r1(dims.h * sc);
    const c = toWorld(cv.clientWidth / 2, cv.clientHeight / 2);
    const it = { type: "image", src: up.src, x: r1(c.x - w / 2), y: r1(c.y - h / 2), w, h, ink: 0, t: Date.now() };
    const id = newId(); putItem(id, it); pushUndo({ op: "add", id, page: S.page, item: it });
    toast("Zdjęcie dodane. Przesuniesz je narzędziem V.");
  } catch (e) { toast(e.message || "Nie udało się dodać zdjęcia. Spróbuj ponownie."); }
}
window.addEventListener("paste", e => {
  if (editor || (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName))) return;
  const f = [...(e.clipboardData ? e.clipboardData.files : [])].find(f => f.type.startsWith("image/"));
  if (f) { e.preventDefault(); insertImage(f); }
});
cv.addEventListener("dragover", e => e.preventDefault());
cv.addEventListener("drop", e => { e.preventDefault(); const f = [...e.dataTransfer.files].find(f => f.type.startsWith("image/")); if (f) insertImage(f); });
$("file").addEventListener("change", e => { const f = e.target.files[0]; if (f) insertImage(f); e.target.value = ""; });

// ---------- export / fit / clear ----------
async function exportPng() {
  closeMenu();
  const list = sortedItems().map(x => x[1]);
  if (!list.length) { toast("Ta strona jest pusta, nie ma czego zapisać."); return; }
  const bb = unionBox(list), pad = 40, w = bb.x2 - bb.x1 + pad * 2, h = bb.y2 - bb.y1 + pad * 2;
  const k = Math.min(2, 8000 / Math.max(w, h));
  const c = document.createElement("canvas"); c.width = Math.ceil(w * k); c.height = Math.ceil(h * k);
  const g = c.getContext("2d"); g.scale(k, k);
  const view = { x: bb.x1 - pad, y: bb.y1 - pad, z: 1 };
  drawBackground(g, w, h, view, pageBg());
  g.translate(-view.x, -view.y);
  for (const it of list) drawItem(g, it);
  const blob = await new Promise(r => c.toBlob(r, "image/png"));
  const name = [S.board?.title, S.pages.get(S.page)?.name].filter(Boolean).join(" - ").replace(/[^\p{L}\p{N} _-]/gu, "").trim() || "tablica";
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name + ".png";
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function fitContent() {
  closeMenu(); stopFollow();
  const list = [...pageItems().values()];
  if (!list.length) { S.view = centeredView(); updateZoomLabel(); dirty = true; return; }
  const bb = unionBox(list), W = cv.clientWidth, H = cv.clientHeight, pad = 80;
  const z = clampZ(Math.min((W - pad * 2) / Math.max(bb.x2 - bb.x1, 1), (H - pad * 2) / Math.max(bb.y2 - bb.y1, 1), 2));
  S.view = { z, x: (bb.x1 + bb.x2) / 2 - W / 2 / z, y: (bb.y1 + bb.y2) / 2 - H / 2 / z };
  updateZoomLabel(); dirty = true; sendPresence();
}
function clearPage() {
  const list = [...pageItems().entries()].map(([id, item]) => ({ id, item }));
  closeMenu(); if (!list.length) return;
  emit({ type: "clear", page: S.page });
  pushUndo({ op: "del", list, page: S.page });
  toast("Wyczyszczono stronę. Możesz to cofnąć (Ctrl+Z).");
}
function deletePage() {
  closeMenu();
  if (S.pages.size <= 1) return;
  const id = S.page, name = S.pages.get(id)?.name || "Strona";
  emit({ type: "pagedel", id });
  S.undo = S.undo.filter(e => e.page !== id); S.redo = S.redo.filter(e => e.page !== id); syncUndo();
  toast("Usunięto „" + name + "”.");
}

// ---------- UI wiring ----------
function setTool(t) {
  closeTextEditor(true);
  S.tool = t;
  document.querySelectorAll(".tool").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tool === t)));
  cv.className = "t-" + (canWrite() ? t : "hand");
}
document.querySelectorAll(".tool").forEach(b => b.addEventListener("click", () => setTool(b.dataset.tool)));
const sw = $("swatches");
const inkNames = ["Czarny / kreda", "Niebieski", "Czerwony", "Zielony", "Pomarańczowy", "Fioletowy"];
function setInk(i) { S.ink = i; sw.querySelectorAll(".sw").forEach((x, j) => x.setAttribute("aria-pressed", String(j === i))); }
for (let i = 0; i < INKS; i++) {
  const b = document.createElement("button"); b.className = "sw"; b.style.background = `var(--ink-${i})`;
  b.title = inkNames[i] + " (Alt+" + (i + 1) + ")"; b.setAttribute("aria-label", "Kolor: " + inkNames[i]);
  b.setAttribute("aria-pressed", String(i === S.ink)); b.onclick = () => setInk(i);
  sw.appendChild(b);
}
const wd = $("widths");
["Cienka", "Średnia", "Gruba"].forEach((label, i) => {
  const b = document.createElement("button"); b.className = "wd"; b.title = "Grubość: " + label; b.setAttribute("aria-label", "Grubość: " + label);
  const s = document.createElement("span"); s.style.height = [2, 4, 7][i] + "px"; b.appendChild(s);
  b.setAttribute("aria-pressed", String(i === S.width));
  b.onclick = () => { S.width = i; wd.querySelectorAll(".wd").forEach((x, j) => x.setAttribute("aria-pressed", String(j === i))); };
  wd.appendChild(b);
});
$("undoBtn").onclick = undo;
$("redoBtn").onclick = redo;
$("zoomIn").onclick = () => zoomAt(cv.clientWidth / 2, cv.clientHeight / 2, 1.25);
$("zoomOut").onclick = () => zoomAt(cv.clientWidth / 2, cv.clientHeight / 2, 0.8);
$("zoomReset").onclick = () => zoomAt(cv.clientWidth / 2, cv.clientHeight / 2, 1 / S.view.z);

const menu = $("menu"), menuBtn = $("menuBtn");
let confirmAction = null;
function closeMenu() { menu.hidden = true; menuBtn.setAttribute("aria-expanded", "false"); $("confirm").hidden = true; confirmAction = null; }
function askConfirm(text, yes, action) { $("confirmText").textContent = text; $("confirmYes").textContent = yes; confirmAction = action; $("confirm").hidden = false; }
function syncTheme() { document.querySelectorAll("#themeRow .chip-btn").forEach(c => c.setAttribute("aria-pressed", String(c.dataset.themeOpt === getTheme()))); }
menuBtn.onclick = () => { const open = menu.hidden; closeMenu(); if (open) { menu.hidden = false; menuBtn.setAttribute("aria-expanded", "true"); renderPages(); syncTheme(); } };
document.addEventListener("pointerdown", e => { if (!menu.hidden && !menu.contains(e.target) && !menuBtn.contains(e.target)) closeMenu(); });
document.querySelectorAll("#bgRow .chip-btn").forEach(c => c.onclick = () => { if (canWrite()) savePage(S.page, { bg: c.dataset.bg }); });
document.querySelectorAll("#themeRow .chip-btn").forEach(c => c.onclick = () => { setTheme(c.dataset.themeOpt); syncTheme(); });
$("renameBtn").onclick = () => { const v = $("pageName").value.trim().slice(0, 40); if (v && canWrite()) { savePage(S.page, { name: v }); toast("Zmieniono nazwę strony."); } };
$("pageName").addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") $("renameBtn").click(); });
$("imgBtn").onclick = () => { closeMenu(); $("file").click(); };
$("exportBtn").onclick = exportPng;
$("fitBtn").onclick = fitContent;
$("clearBtn").onclick = () => askConfirm("Usunąć wszystko z tej strony? Zmiana dotyczy wszystkich osób na tablicy.", "Wyczyść", clearPage);
$("delPageBtn").onclick = () => askConfirm("Usunąć stronę „" + (S.pages.get(S.page)?.name || "") + "” razem z zawartością? Tego nie da się cofnąć.", "Usuń stronę", deletePage);
$("confirmNo").onclick = () => { $("confirm").hidden = true; confirmAction = null; };
$("confirmYes").onclick = () => { const a = confirmAction; confirmAction = null; if (a) a(); };
$("nameBtn").onclick = () => { closeMenu(); openNameModal(true); };
$("shareBtn").onclick = () => openShareDialog(S.board, b => { S.board = b; });

window.addEventListener("keydown", e => {
  if (editor || /^(INPUT|TEXTAREA)$/.test(e.target.tagName) || !$("nameModal").hidden) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); return; }
  if (e.altKey && k >= "1" && k <= String(INKS)) { e.preventDefault(); setInk(+k - 1); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === "Space") { if (!spaceDown) { spaceDown = true; cv.classList.add("t-hand"); } e.preventDefault(); return; }
  if (canWrite() && TOOL_KEYS[k]) { setTool(TOOL_KEYS[k]); return; }
  if (k === "1") fitContent();
  if (k === "escape") closeMenu();
});
window.addEventListener("keyup", e => { if (e.code === "Space") { spaceDown = false; setTool(S.tool); } });
window.addEventListener("resize", () => { resize(); applyFollow(); sendPresence(); });

// ---------- role / title / name ----------
function banner(msg) { const b = $("banner"); b.textContent = msg || ""; b.hidden = !msg; }
function applyRole() {
  const w = canWrite();
  $("rail").hidden = !w; $("bottomLeft").hidden = !w; $("editMenu").hidden = !w;
  $("shareBtn").hidden = S.role !== "owner";
  $("boardTitle").classList.toggle("editable", S.role === "owner");
  $("nameBtn").hidden = !!S.user;
  banner(w ? "" : "Tryb podglądu: widzisz tablicę na żywo, ale nie możesz rysować.");
  setTool(S.tool); syncUndo(); renderPages();
}
function setTitle() {
  const t = S.board?.title || "Tablica";
  $("boardTitle").textContent = t; $("boardTitle").title = S.role === "owner" ? "Kliknij, żeby zmienić nazwę" : t;
  document.title = t;
}
$("boardTitle").onclick = () => {
  if (S.role !== "owner") return;
  const btn = $("boardTitle"), input = document.createElement("input");
  input.className = "input"; input.id = "titleInput"; input.value = S.board.title; input.maxLength = 80; input.setAttribute("aria-label", "Nazwa tablicy");
  btn.hidden = true; btn.after(input); input.focus(); input.select();
  let done = false;
  const finish = async save => {
    if (done) return; done = true;
    const v = input.value.trim(); input.remove(); btn.hidden = false;
    if (!save || !v || v === S.board.title) return;
    try { const r = await api("PATCH", "/api/boards/" + encodeURIComponent(BOARD), { title: v }); S.board = { ...S.board, ...r.board }; setTitle(); }
    catch (er) { toast(er.message); }
  };
  input.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
  input.addEventListener("blur", () => finish(true));
};
function guestName() { return (store.get("tablica.name") || "").slice(0, 40); }
let nameResolve = null;
function openNameModal(change) {
  $("nameTitle").textContent = change ? "Zmień swoje imię" : "Jak się nazywasz?";
  $("guestName").value = guestName();
  $("nameModal").hidden = false; setTimeout(() => $("guestName").focus(), 0);
  return new Promise(r => { nameResolve = r; });
}
$("nameForm").addEventListener("submit", e => {
  e.preventDefault();
  const v = $("guestName").value.trim().slice(0, 40);
  if (!v) { $("guestName").focus(); return; }
  store.set("tablica.name", v);
  $("nameModal").hidden = true;
  if (net.open) send({ type: "hello", name: v });
  if (nameResolve) { nameResolve(v); nameResolve = null; }
});

// ---------- boot ----------
async function checkAccess() {
  try {
    const q = SHARE ? "?s=" + encodeURIComponent(SHARE) : "";
    const meta = await api("GET", `/api/boards/${encodeURIComponent(BOARD)}/meta${q}`);
    S.user = meta.user; S.role = S.role || meta.role;
    S.board = { ...(S.board || {}), id: meta.id, title: meta.title, share_mode: meta.share_mode, ...(meta.share_token ? { share_token: meta.share_token } : {}) };
    return true;
  } catch (e) {
    if (e.status === 404) {
      fatal("Nie ma takiej tablicy", SHARE ? "Link jest nieaktualny albo tablica została usunięta. Poproś o nowy link." : "Ta tablica nie istnieje albo należy do innej osoby. Jeśli dostałeś link, otwórz go dokładnie w takiej postaci, w jakiej go otrzymałeś.");
      return false;
    }
    return true; // network trouble: keep retrying the socket
  }
}
readPalette(); resize(); S.view = centeredView(); updateZoomLabel(); requestAnimationFrame(loop);
if (document.fonts) document.fonts.ready.then(invalidate);
(async () => {
  if (!(await checkAccess())) return;
  setTitle();
  if (!S.user) {
    $("backLink").href = "/"; $("backLink").title = "Strona główna"; $("backLink").setAttribute("aria-label", "Strona główna");
    if (!guestName()) await openNameModal(false);
  }
  connect();
})();
})();
