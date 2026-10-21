// Shared helpers for the start page and the board: theme, API calls, toast, share dialog.
(() => {
  "use strict";
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage blocked */ } },
  };

  function applyTheme(t) {
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }
  applyTheme(store.get("tablica.theme"));
  function setTheme(t) { store.set("tablica.theme", t === "system" ? null : t); applyTheme(t); }
  function getTheme() { return store.get("tablica.theme") || "system"; }

  async function api(method, url, body) {
    const opts = { method, headers: {}, credentials: "same-origin" };
    if (body instanceof Blob) { opts.body = body; opts.headers["Content-Type"] = body.type; }
    else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
    let res;
    try { res = await fetch(url, opts); }
    catch { throw new Error("Brak połączenia z serwerem. Sprawdź internet i spróbuj ponownie."); }
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = { error: text }; }
    if (!res.ok) { const e = new Error((data && data.error) || "Coś poszło nie tak (" + res.status + ")."); e.status = res.status; throw e; }
    return data;
  }

  let toastT = null;
  function toast(msg, ms = 3200) {
    let t = document.getElementById("toast");
    if (!t) { t = document.createElement("div"); t.id = "toast"; t.className = "panel"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms);
  }

  function timeAgo(sec) {
    const d = Math.max(0, Date.now() / 1000 - sec);
    if (d < 60) return "przed chwilą";
    if (d < 3600) return Math.floor(d / 60) + " min temu";
    if (d < 86400) return Math.floor(d / 3600) + " godz. temu";
    if (d < 86400 * 7) { const n = Math.floor(d / 86400); return n === 1 ? "wczoraj" : n + " dni temu"; }
    return new Date(sec * 1000).toLocaleDateString("pl-PL", { day: "numeric", month: "short", year: "numeric" });
  }

  function shareLink(board) { return location.origin + "/b/" + board.id + "?s=" + encodeURIComponent(board.share_token); }

  async function copyText(text, input) {
    try { await navigator.clipboard.writeText(text); toast("Skopiowano link."); }
    catch { if (input) { input.focus(); input.select(); } toast("Zaznaczyłem link. Skopiuj go skrótem Ctrl+C."); }
  }

  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, "");
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid);
    return n;
  }

  // Share dialog for a board the viewer owns. onChange(board) gets the updated board.
  function openShareDialog(board, onChange) {
    const modes = [
      ["edit", "Każdy z linkiem może rysować", "Uczeń otwiera link i od razu pisze na tablicy, bez zakładania konta."],
      ["view", "Każdy z linkiem może oglądać", "Widzi tablicę na żywo, ale nie może niczego zmienić."],
      ["off", "Link wyłączony", "Tablica jest widoczna tylko dla ciebie."],
    ];
    const linkInput = el("input", { class: "input", readonly: true, "aria-label": "Link do tablicy" });
    const copyBtn = el("button", { class: "btn primary", type: "button" }, "Kopiuj");
    const resetBtn = el("button", { class: "btn small ghost", type: "button" }, "Utwórz nowy link");
    const resetNote = el("p", {}, "Nowy link wyłącza stary. Osoby, które mają stary link, stracą dostęp.");
    const linkBox = el("div", { class: "field" }, el("label", {}, "Link do wysłania uczniowi"), el("div", { class: "linkrow" }, linkInput, copyBtn));
    const opts = el("div", { class: "opts", role: "radiogroup" }, modes.map(([v, title, desc]) =>
      el("label", { class: "opt" }, el("input", { type: "radio", name: "share-mode", value: v, checked: board.share_mode === v }), el("div", {}, el("b", {}, title), el("span", {}, desc)))));
    const closeBtn = el("button", { class: "btn", type: "button" }, "Gotowe");
    const modal = el("div", { class: "modal panel", role: "dialog", "aria-modal": "true", "aria-labelledby": "share-title" },
      el("h2", { id: "share-title" }, "Udostępnij „" + board.title + "”"), opts, linkBox, el("div", { class: "field" }, resetNote, el("div", {}, resetBtn)),
      el("div", { class: "actions" }, closeBtn));
    const back = el("div", { class: "modal-back" }, modal);
    function sync() {
      linkInput.value = shareLink(board);
      const off = board.share_mode === "off";
      linkBox.hidden = off;
      resetBtn.disabled = off;
    }
    sync();
    function close() { back.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e) { if (e.key === "Escape") close(); }
    document.addEventListener("keydown", onKey);
    back.addEventListener("pointerdown", e => { if (e.target === back) close(); });
    closeBtn.onclick = close;
    copyBtn.onclick = () => copyText(linkInput.value, linkInput);
    opts.addEventListener("change", async e => {
      const mode = e.target.value;
      try { const r = await api("PATCH", "/api/boards/" + board.id, { share_mode: mode }); Object.assign(board, r.board); sync(); onChange && onChange(board); toast(mode === "off" ? "Link wyłączony." : "Zapisano ustawienia udostępniania."); }
      catch (er) { toast(er.message); }
    });
    resetBtn.onclick = async () => {
      try { const r = await api("POST", "/api/boards/" + board.id + "/share-reset"); Object.assign(board, r.board); sync(); onChange && onChange(board); toast("Utworzono nowy link. Stary już nie działa."); }
      catch (er) { toast(er.message); }
    };
    document.body.appendChild(back);
    (board.share_mode === "off" ? opts.querySelector("input") : copyBtn).focus();
  }

  window.T = { store, api, toast, timeAgo, shareLink, copyText, el, openShareDialog, setTheme, getTheme };
})();
