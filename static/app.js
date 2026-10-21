// Start page: sign in / sign up, list of boards, create / rename / share / delete.
(() => {
  "use strict";
  const { api, toast, timeAgo, el, openShareDialog, shareLink } = window.T;
  const $ = id => document.getElementById(id);
  let me = null;

  // ---------- auth ----------
  function showTab(reg) {
    $("tabLogin").setAttribute("aria-selected", String(!reg));
    $("tabRegister").setAttribute("aria-selected", String(reg));
    $("loginForm").hidden = reg; $("registerForm").hidden = !reg;
    (reg ? $("regName") : $("loginEmail")).focus();
  }
  $("tabLogin").onclick = () => showTab(false);
  $("tabRegister").onclick = () => showTab(true);

  async function submitAuth(form, url, body, errEl) {
    const btn = form.querySelector("button[type=submit]");
    errEl.textContent = ""; btn.disabled = true;
    try { const r = await api("POST", url, body); me = r.user; await showDash(); }
    catch (e) { errEl.textContent = e.message; }
    finally { btn.disabled = false; }
  }
  $("loginForm").addEventListener("submit", e => {
    e.preventDefault();
    submitAuth(e.target, "/api/login", { email: $("loginEmail").value, password: $("loginPass").value }, $("loginErr"));
  });
  $("registerForm").addEventListener("submit", e => {
    e.preventDefault();
    if ($("regPass").value.length < 8) { $("regErr").textContent = "Hasło musi mieć co najmniej 8 znaków."; return; }
    submitAuth(e.target, "/api/register", { name: $("regName").value, email: $("regEmail").value, password: $("regPass").value }, $("regErr"));
  });
  $("logoutBtn").onclick = async () => { await api("POST", "/api/logout").catch(() => {}); me = null; showWelcome(); };

  function showWelcome() {
    $("welcome").hidden = false; $("dash").hidden = true; $("who").hidden = true; $("logoutBtn").hidden = true;
    document.title = "Tablica do korepetycji";
  }

  // ---------- dashboard ----------
  async function showDash() {
    $("welcome").hidden = true; $("dash").hidden = false;
    $("who").hidden = false; $("who").textContent = me.name; $("logoutBtn").hidden = false;
    $("hello").textContent = "Cześć, " + me.name;
    document.title = "Moje tablice";
    await loadBoards();
  }
  let boards = { mine: [], shared: [] };
  async function loadBoards() {
    try { boards = await api("GET", "/api/boards"); }
    catch (e) { if (e.status === 401) { me = null; showWelcome(); return; } toast(e.message); return; }
    renderBoards();
  }
  function shareChip(b) {
    if (b.share_mode === "edit") return el("span", { class: "chip on" }, "Link: rysowanie");
    if (b.share_mode === "view") return el("span", { class: "chip on" }, "Link: podgląd");
    return el("span", { class: "chip" }, "Prywatna");
  }
  function pagesLabel(n) { return n === 1 ? "1 strona" : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) ? n + " strony" : n + " stron"; }
  function card(b, own) {
    const href = own ? "/b/" + b.id : shareLink(b).replace(location.origin, "");
    const acts = el("div", { class: "acts" });
    const body = el("div", { class: "body" },
      el("div", { class: "title", title: b.title }, b.title),
      el("div", { class: "meta" }, el("span", {}, timeAgo(b.updated)), el("span", {}, "·"), el("span", {}, pagesLabel(b.pages)),
        own ? shareChip(b) : el("span", { class: "chip" }, b.owner_name ? "od " + b.owner_name : "udostępniona"),
        b.live ? el("span", { class: "chip live" }, b.live + " teraz") : null));
    const c = el("article", { class: "card" }, el("a", { class: "sheetpreview", href, "aria-label": "Otwórz " + b.title }, el("span", {}, b.title)), body, acts);
    acts.append(el("a", { class: "btn small primary", href }, "Otwórz"));
    if (own) {
      acts.append(
        el("button", { class: "btn small", onclick: () => openShareDialog(b, renderBoards) }, "Udostępnij"),
        el("button", { class: "btn small ghost", onclick: () => rename(b, c) }, "Zmień nazwę"),
        el("button", { class: "btn small ghost danger", onclick: () => askDelete(b, c) }, "Usuń"));
    }
    return c;
  }
  function renderBoards() {
    const mine = $("mine"); mine.textContent = "";
    if (!boards.mine.length) mine.append(el("div", { class: "empty" }, "Nie masz jeszcze tablic. Wpisz nazwę u góry i kliknij „Nowa tablica”."));
    boards.mine.forEach(b => mine.append(card(b, true)));
    const shared = $("shared"); shared.textContent = "";
    $("sharedSec").hidden = !boards.shared.length;
    boards.shared.forEach(b => shared.append(card(b, false)));
  }
  function rename(b, c) {
    const input = el("input", { class: "input", value: b.title, maxlength: "80", "aria-label": "Nowa nazwa tablicy" });
    const save = async () => {
      const title = input.value.trim(); if (!title || title === b.title) { renderBoards(); return; }
      try { const r = await api("PATCH", "/api/boards/" + b.id, { title }); Object.assign(b, r.board); toast("Zmieniono nazwę."); }
      catch (e) { toast(e.message); }
      renderBoards();
    };
    input.addEventListener("keydown", e => { if (e.key === "Enter") save(); if (e.key === "Escape") renderBoards(); });
    const t = c.querySelector(".title"); t.replaceWith(input); input.focus(); input.select();
    c.querySelector(".acts").replaceChildren(el("button", { class: "btn small primary", onclick: save }, "Zapisz"), el("button", { class: "btn small ghost", onclick: renderBoards }, "Anuluj"));
  }
  function askDelete(b, c) {
    const box = el("div", { class: "inline-confirm" }, el("span", {}, "Usunąć tablicę na zawsze?"),
      el("button", { class: "btn small danger solid", onclick: async () => {
        try { await api("DELETE", "/api/boards/" + b.id); boards.mine = boards.mine.filter(x => x.id !== b.id); renderBoards(); toast("Usunięto tablicę „" + b.title + "”."); }
        catch (e) { toast(e.message); }
      } }, "Usuń"),
      el("button", { class: "btn small ghost", onclick: renderBoards }, "Anuluj"));
    c.querySelector(".acts").replaceWith(box);
  }
  $("newForm").addEventListener("submit", async e => {
    e.preventDefault();
    try {
      const r = await api("POST", "/api/boards", { title: $("newTitle").value.trim() });
      location.href = "/b/" + r.board.id;
    } catch (er) { toast(er.message); }
  });

  // ---------- boot ----------
  function applyConfig(cfg) {
    const tabs = document.querySelector(".tabs");
    if (!cfg.registration) {
      tabs.hidden = true; $("registerForm").hidden = true; $("loginForm").hidden = false;
      $("authNote").textContent = "Nowe konta dodaje administrator tego serwera. Uczniowie nie potrzebują konta, wchodzą przez link.";
    } else if (cfg.setup) {
      $("authNote").textContent = "To pierwsze uruchomienie. Załóż konto właściciela, po tym rejestracja zamknie się sama.";
      showTab(true);
    }
  }
  api("GET", "/api/me").then(r => { me = r.user; me ? showDash() : showWelcome(); }).catch(e => { showWelcome(); toast(e.message); });
  api("GET", "/api/config").then(applyConfig).catch(() => {});
  window.addEventListener("pageshow", e => { if (e.persisted && me) loadBoards(); });
})();
