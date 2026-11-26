/* Purchasing — screens and flows, on the Site Checks skeleton: one <section> per screen, shown by show(), and every
 * user-supplied string enters the DOM as text. Two suppliers:
 *   Urban Plus: each site fills its column of the month's tab in the Urban Plus sheet; Jona marks the month as sent.
 *   Popular: each site sends a PO; Jona combines the waiting POs into one Popular order, then packs and sends each
 *   site its PO when the delivery comes in. */
"use strict";

const $ = id => document.getElementById(id);
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat(Infinity)) if (k != null && k !== false && k !== "") n.append(k.nodeType ? k : String(k));
  return n;
}
let toastTimer = null;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3000); }
function show(id) { document.querySelectorAll(".screen").forEach(s => { s.hidden = s.id !== id; }); window.scrollTo(0, 0); }
function initials(name) { return name.split(/\s+/).slice(0, 2).map(w => w[0] || "").join("").toUpperCase(); }
async function guard(fn) { try { await fn(); } catch (e) { if (e.auth) { session.clear(); loadLogin(); } toast(e.message || String(e)); } }
const money = n => "$" + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
const GST = 0.09;
function fmtWhen(iso) { // "3:05pm" today, "26 Nov, 3:05pm" otherwise
  const d = new Date(iso); if (!iso || isNaN(d)) return "";
  const t = d.toLocaleTimeString("en-SG", { hour: "numeric", minute: "2-digit" }).replace(/\s/g, "").toLowerCase();
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString("en-SG", { day: "numeric", month: "short" })}, ${t}`;
}
function monthAfter(key) { const [y, m] = key.split("-").map(Number); return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`; }
function monthLabel(key) { const [y, m] = key.split("-").map(Number); return new Date(y, m - 1, 15).toLocaleDateString("en-SG", { month: "long", year: "numeric" }); }
const thisMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; };

const App = { meta: null, home: null, tab: "order", names: [], urban: null, cart: null, view: null, sel: null, q: "", cat: "" };
const cached = k => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } };
const remember = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
const siteName = code => { const s = (App.meta ? App.meta.sites : []).find(s => s.code === code); return s ? s.name : ""; };
const siteLabel = code => `${code} ${siteName(code)}`.trim();
const mySite = () => { const s = localStorage.getItem("pu.site") || ""; return App.meta && App.meta.sites.some(x => x.code === s) ? s : ""; };
const status = s => (App.meta.statuses || {})[s] || s;
const BADGE = { submitted: "soon", ordered: "draft", sent: "draft", received: "done", cancelled: "" };
const item = code => App.meta.catalog.find(c => c.code === code);

/* ---------- login ---------- */
async function loadLogin() {
  show("scr-login");
  $("pin-panel").hidden = true; $("login-pick").hidden = false;
  if (!App.names.length) {
    $("login-list").replaceChildren(el("p", { class: "empty" }, "Loading names…"));
    try { App.names = (await api("roster")).names; }
    catch (e) { $("login-list").replaceChildren(el("button", { class: "row", type: "button", onclick: () => guard(loadLogin) }, "Could not load the names. Tap to retry.")); throw e; }
  }
  renderNames($("login-search").value);
}
function renderNames(q) {
  const list = $("login-list"); list.replaceChildren();
  App.names.filter(n => n.toLowerCase().includes(q.trim().toLowerCase())).forEach(n => list.append(
    el("button", { class: "row", type: "button", onclick: () => pickName(n) }, el("span", { class: "avatar" }, initials(n)), el("span", { class: "row-title" }, n))));
}
function pickName(name) {
  $("login-pick").hidden = true; $("pin-panel").hidden = false;
  $("pin-name").textContent = name;
  const pin = $("pin"); pin.value = ""; pin.focus();
  const btn = $("pin-panel").querySelector("button[type=submit]");
  $("pin-panel").onsubmit = ev => {
    ev.preventDefault();
    busyBtn(btn, "Checking PIN…", async () => { const a = await api("login", { name, pin: pin.value }); session.save(a); await enterApp(a); });
  };
}
// a second tap within a few seconds confirms; pop-up confirm() boxes are blocked on some phones and the tap then does nothing
function sure(btn, label) {
  if (btn.dataset.sure) { delete btn.dataset.sure; btn.textContent = btn.dataset.was || btn.textContent; delete btn.dataset.was; return true; }
  const was = btn.textContent; btn.dataset.sure = "1"; btn.dataset.was = was; btn.textContent = label;
  setTimeout(() => { if (btn.dataset.sure) { delete btn.dataset.sure; delete btn.dataset.was; btn.textContent = was; } }, 5000);
  return false;
}
function busyBtn(btn, label, fn) { // a tapped button says what it is doing until the call returns
  const was = btn.textContent; btn.disabled = true; btn.textContent = label;
  return guard(async () => { try { await fn(); } finally { btn.disabled = false; btn.textContent = was; } });
}
$("login-search").oninput = e => renderNames(e.target.value);
$("pin-back").onclick = () => guard(loadLogin);

/* ---------- home ---------- */
async function enterApp(meta) { // login carries the sites and the catalog; a resumed session paints from the cached copy, then refreshes
  const fromCache = !(meta && meta.catalog) && cached("pu.meta");
  App.meta = meta && meta.catalog ? meta : (fromCache || await api("meta"));
  if (!App.meta.catalog) throw new Error("Could not load the app settings. Try again.");
  remember("pu.meta", App.meta);
  await loadHome();
  if (fromCache) api("meta").then(m => { if (m.catalog) { App.meta = m; remember("pu.meta", m); if (!$("scr-home").hidden) renderHome(); } }).catch(() => {});
}
async function loadHome() {
  show("scr-home");
  $("home-user").textContent = session.name + (App.meta.purchaser ? " · purchaser" : "");
  const snap = cached("pu.home");
  if (snap && snap.urban && Array.isArray(snap.pos)) { App.home = snap; renderHome(); }
  else $("home-body").replaceChildren(el("p", { class: "empty" }, "Loading…"));
  App.home = await api("home");
  remember("pu.home", App.home);
  renderHome();
}
function renderHome() {
  const tabs = $("home-tabs"), buyer = App.meta.purchaser;
  $("home-user").textContent = session.name + (buyer ? " · purchaser" : "");
  tabs.hidden = !buyer;
  if (!buyer) App.tab = "order";
  tabs.replaceChildren(...[["order", "Order"], ["buy", "Purchasing"]].map(([k, label]) =>
    el("button", { class: "seg-btn" + (App.tab === k ? " on" : ""), type: "button", onclick: () => { App.tab = k; renderHome(); } }, label)));
  $("home-body").replaceChildren(...(App.tab === "buy" ? buyHome() : orderHome()));
}
const poRow = (p, sub) => el("button", { class: "row po", type: "button", onclick: () => openView(p) },
  el("div", { class: "row-main" },
    el("div", { class: "row-title" }, `${siteLabel(p.site)} · ${p.items} item${p.items === "1" ? "" : "s"}`),
    el("div", { class: "row-sub" }, sub || `${p.by} · ${fmtWhen(p.created_at)}`)),
  el("span", { class: "badge " + (BADGE[p.status] || "") }, status(p.status)));

function orderHome() {
  const site = mySite(), out = [];
  const pick = el("select", { id: "site-pick", onchange: e => { localStorage.setItem("pu.site", e.target.value); renderHome(); } },
    el("option", { value: "" }, "Pick your site"), App.meta.sites.map(s => el("option", { value: s.code, selected: s.code === site }, `${s.code} ${s.name}`)));
  out.push(el("label", { class: "field site-field" }, el("span", { class: "label" }, "Ordering for"), pick));
  if (!site) { out.push(el("p", { class: "empty" }, "Pick your site to order. The phone remembers it.")); return out; }

  // Urban Plus: this month's cleaning supplies, one column per site in the Urban Plus sheet
  const u = App.home.urban || {}, r = u.round, mine = (u.sites || []).find(s => s.code === site);
  const card = el("div", { class: "card supplier" }, el("div", { class: "sup-head" }, el("h2", {}, "Urban Plus"), el("span", { class: "muted small" }, "Cleaning supplies, monthly")));
  if (!r) card.append(el("p", { class: "muted" }, "No Urban Plus order is open. The purchaser opens one at the start of each month."));
  else if (!mine) card.append(el("p", { class: "muted" }, `${site} has no column in the ${r.label} Urban Plus tab. Ask the purchaser to add one.`));
  else {
    const open = r.status === "open";
    card.append(el("div", { class: "sup-state" },
      el("div", {}, el("div", { class: "row-title" }, r.label),
        el("div", { class: "row-sub" }, mine.by ? `Sent by ${mine.by} · ${fmtWhen(mine.at)} · ${mine.items} item${mine.items === 1 ? "" : "s"} · ${money(mine.total)}` : "Not sent yet")),
      el("span", { class: "badge " + (open ? (mine.by ? "done" : "soon") : "draft") }, open ? (mine.by ? "Sent" : "To do") : "With Urban Plus")));
    if (!open) card.append(el("p", { class: "muted small" }, `The purchaser sent this month's order to Urban Plus on ${fmtWhen(r.sent_at)}. To change it, ask them.`));
    card.append(el("button", { class: "btn " + (open && !mine.by ? "primary" : "ghost"), type: "button", onclick: () => guard(() => openUrban(site)) },
      open ? (mine.by ? "Change the order" : "Fill in the order") : "See what was ordered"));
  }
  out.push(card);

  // Popular: this site's POs, newest first
  const pos = App.home.pos.filter(p => p.site === site);
  const pc = el("div", { class: "card supplier" }, el("div", { class: "sup-head" }, el("h2", {}, "Popular"), el("span", { class: "muted small" }, "Stationery, pantry, ink and more")),
    el("button", { class: "btn primary", type: "button", onclick: () => openPO(null) }, cached("pu.cart") && cached("pu.cart").site === site ? "Carry on with the order" : "New Popular order"));
  const live = pos.filter(p => p.status !== "received" && p.status !== "cancelled"), past = pos.filter(p => !live.includes(p));
  if (live.length) pc.append(el("div", { class: "listhead" }, "On the way"), ...live.map(p => poRow(p)));
  if (past.length) pc.append(el("details", { class: "group sub" }, el("summary", {}, "Earlier orders", el("span", { class: "count" }, past.length)), past.slice(0, 30).map(p => poRow(p))));
  if (!pos.length) pc.append(el("p", { class: "muted small" }, "No Popular orders from this site yet."));
  out.push(pc);
  return out;
}

function buyHome() {
  const out = [], u = App.home.urban || {}, r = u.round;
  // Urban Plus: who has sent this month's quantities, the month's total, and sending it
  const card = el("div", { class: "card supplier" }, el("div", { class: "sup-head" }, el("h2", {}, "Urban Plus"), r ? el("span", { class: "badge " + (r.status === "open" ? "soon" : "done") }, r.status === "open" ? `${r.label} · open` : `${r.label} · sent`) : null));
  if (r) {
    const sites = u.sites || [], sent = sites.filter(s => s.by), sub = sites.reduce((a, s) => a + (Number(s.total) || 0), 0);
    card.append(el("p", { class: "muted small" }, `${sent.length} of ${sites.length} sites have sent their order.`));
    card.append(el("div", { class: "sum" }, sites.map(s => el("div", { class: "sum-row" + (s.by ? "" : " none") },
      el("span", { class: "sum-site" }, s.code), el("span", { class: "sum-who" }, s.by ? `${s.by} · ${fmtWhen(s.at)}` : "Not sent"), el("span", { class: "sum-amt" }, s.total ? money(s.total) : "–"))),
      el("div", { class: "sum-row foot" }, el("span", {}, "Before GST"), el("span", { class: "sum-amt" }, money(sub))),
      el("div", { class: "sum-row foot" }, el("span", {}, "With 9% GST"), el("span", { class: "sum-amt" }, money(sub * (1 + GST))))));
    if (r.status === "open") card.append(el("button", { class: "btn primary", type: "button", onclick: ev => {
      if (!sure(ev.target, `Tap again: lock ${r.label} for every site`)) return;
      busyBtn(ev.target, "Saving…", async () => { await api("up_sent"); toast(`${r.label} marked as sent to Urban Plus.`); await loadHome(); }); } }, "Mark as sent to Urban Plus"));
    else card.append(el("p", { class: "muted small" }, `Sent by ${r.sent_by} · ${fmtWhen(r.sent_at)}.`));
  } else card.append(el("p", { class: "muted" }, "No month is open in the app yet."));
  if (!r || r.status !== "open") {
    const next = r ? [monthAfter(r.round), thisMonth()].sort().pop() : thisMonth();
    card.append(el("button", { class: "btn " + (r ? "ghost" : "primary"), type: "button", onclick: ev => {
      if (!sure(ev.target, `Tap again: open ${monthLabel(next)} for the sites`)) return;
      busyBtn(ev.target, "Opening…", async () => { const a = await api("up_open", { month: next }); toast(`Opened. The sites fill in the tab "${a.tab}".`); await loadHome(); }); } }, `Open ${monthLabel(next)}`));
  }
  if (App.meta.urban_sheet) card.append(el("a", { class: "linkbtn", href: `https://docs.google.com/spreadsheets/d/${App.meta.urban_sheet}/edit`, target: "_blank", rel: "noopener" }, "Open the Urban Plus sheet"));
  out.push(card);

  // Popular: waiting POs to combine, then ordered ones to pack and send each site
  const pos = App.home.pos, by = s => pos.filter(p => p.status === s);
  const waiting = by("submitted"), ordered = by("ordered"), sent = by("sent"), done = by("received");
  const pc = el("div", { class: "card supplier" }, el("div", { class: "sup-head" }, el("h2", {}, "Popular"), el("span", { class: "muted small" }, `${waiting.length} waiting`)));
  pc.append(el("div", { class: "listhead" }, "Waiting for you"));
  if (waiting.length) pc.append(...waiting.map(p => poRow(p)),
    el("button", { class: "btn primary", type: "button", onclick: () => openCombine() }, `Combine ${waiting.length} order${waiting.length === 1 ? "" : "s"} for Popular`));
  else pc.append(el("p", { class: "muted small" }, "No site is waiting."));
  if (ordered.length) pc.append(el("div", { class: "listhead" }, "Ordered: pack and send when it arrives"), ...ordered.map(p => poRow(p, `${p.by} · ordered ${fmtWhen(p.ordered_at)}${p.popular_ref ? " · " + p.popular_ref : ""}`)));
  if (sent.length) pc.append(el("div", { class: "listhead" }, "Sent to the sites"), ...sent.map(p => poRow(p, `sent ${fmtWhen(p.sent_at)}`)));
  if (done.length) pc.append(el("details", { class: "group sub" }, el("summary", {}, "Received", el("span", { class: "count" }, done.length)), done.slice(0, 40).map(p => poRow(p, `received by ${p.received_by} · ${fmtWhen(p.received_at)}`))));
  out.push(pc);
  return out;
}
$("btn-lock").onclick = () => { session.clear(); localStorage.removeItem("pu.cart"); guard(loadLogin); };

/* ---------- a stepper: − qty + ---------- */
function stepper(qty, onChange, opts) {
  opts = opts || {};
  const input = el("input", { class: "qty", inputmode: "numeric", pattern: "[0-9]*", value: qty ? String(qty) : "", placeholder: "0", disabled: opts.disabled, "aria-label": "Quantity" });
  const set = n => {
    n = Math.max(0, Math.min(999, Math.floor(Number(n) || 0))); input.value = n ? String(n) : "";
    box.classList.toggle("has", n > 0); if (box.parentElement) box.parentElement.classList.toggle("on", n > 0); // the row lights up without a redraw
    onChange(n);
  };
  input.addEventListener("change", () => set(input.value));
  input.addEventListener("focus", () => input.select());
  const box = el("div", { class: "stepper" + (qty ? " has" : "") },
    el("button", { type: "button", class: "step", disabled: opts.disabled, "aria-label": "One less", onclick: () => set((Number(input.value) || 0) - 1) }, "−"),
    input,
    el("button", { type: "button", class: "step", disabled: opts.disabled, "aria-label": "One more", onclick: () => set((Number(input.value) || 0) + 1) }, "+"));
  return box;
}

/* ---------- Urban Plus: the site's quantities for the month ---------- */
async function openUrban(site) {
  const r = await api("up_get", { site });
  if (!r.round) throw new Error("No Urban Plus order is open.");
  App.urban = r; App.urban.was = r.items.map(it => it.qty);
  show("scr-urban"); renderUrban();
}
function renderUrban() {
  const u = App.urban, open = u.round.status === "open";
  $("urban-sub").textContent = `${siteLabel(u.site)} · ${u.round.label}`;
  const total = () => u.items.reduce((a, it) => a + it.qty * it.price, 0);
  const btn = $("btn-urban-save");
  const sync = () => { const n = u.items.filter(it => it.qty > 0).length;
    btn.textContent = n ? `Send order · ${n} item${n === 1 ? "" : "s"} · ${money(total())}` : (u.by ? "Send order · nothing" : "Send order"); };
  const body = $("urban-body"); body.replaceChildren();
  body.append(el("p", { class: "muted small" }, open
    ? (u.by ? `Last sent by ${u.by} · ${fmtWhen(u.at)}. Change the numbers and send again; it replaces what was there.` : "Put how many of each your site needs this month, then send. Prices are before GST.")
    : `This month's order went to Urban Plus. To change it, ask the purchaser.`));
  u.items.forEach(it => body.append(el("div", { class: "line" + (it.qty ? " on" : "") },
    el("div", { class: "row-main" }, el("div", { class: "row-title" }, it.name), el("div", { class: "row-sub" }, money(it.price))),
    stepper(it.qty, n => { it.qty = n; sync(); }, { disabled: !open }))));
  $("urban-bar").hidden = !open;
  sync();
}
$("btn-urban-save").onclick = ev => {
  const u = App.urban;
  if (!u.items.some((it, i) => it.qty !== u.was[i])) { toast(u.by ? "Nothing has changed." : "Put a quantity first."); return; }
  busyBtn(ev.target, "Sending…", async () => {
    const a = await api("up_save", { site: u.site, lines: u.items.map(it => ({ row: it.row, name: it.name, qty: it.qty })) });
    toast(`Sent to the Urban Plus sheet: ${a.items} item${a.items === 1 ? "" : "s"}, ${money(a.total)} before GST.`);
    await loadHome();
  });
};
$("urban-back").onclick = () => guard(loadHome);

/* ---------- Popular: building a PO ---------- */
function openPO(po) { // po: an order still waiting for the purchaser, to change it; null: a new one (the unsent one is kept on the phone)
  const site = po ? po.site : mySite();
  const draft = cached("pu.cart");
  App.cart = po ? { id: po.id, site, note: po.note || "", lines: po.lines.map(l => ({ code: l.code, name: l.name, qty: Number(l.qty) })) }
    : draft && draft.site === site ? draft : { id: "", site, note: "", lines: [] };
  App.q = ""; App.cat = ""; $("po-search").value = "";
  $("po-title").textContent = po ? "Change the order" : "Popular order";
  $("po-sub").textContent = siteLabel(site) + (po ? ` · ${po.id}` : "");
  $("btn-po-send").textContent = po ? "Save the changes" : "Send order";
  $("po-other").open = false; $("other-code").value = ""; $("other-name").value = "";
  show("scr-po"); renderCart(); renderCats(); renderCatalog();
}
const keep = () => { if (!App.cart.id) remember("pu.cart", App.cart); };
function setQty(code, name, n) {
  const c = App.cart, l = c.lines.find(x => x.code === code);
  if (l) { if (n > 0) l.qty = n; else c.lines.splice(c.lines.indexOf(l), 1); }
  else if (n > 0) c.lines.push({ code, name, qty: n });
  keep(); renderCart(); renderCatalog();
}
function renderCart() {
  const c = App.cart, box = $("po-cart"); box.replaceChildren();
  const card = el("div", { class: "card cart" }, el("div", { class: "sup-head" }, el("h2", {}, "In this order"), el("span", { class: "muted small" }, `${c.lines.length} item${c.lines.length === 1 ? "" : "s"}`)));
  if (!c.lines.length) card.append(el("p", { class: "muted small" }, "Nothing yet. Tap items below to add them."));
  let est = 0, unpriced = 0;
  c.lines.forEach(l => {
    const it = item(l.code) || {}, p = Number(it.price) || 0;
    if (p) est += p * l.qty; else unpriced++;
    card.append(el("div", { class: "line on" },
      el("div", { class: "row-main" }, el("div", { class: "row-title" }, l.name), el("div", { class: "row-sub" }, [l.code, it.unit, p ? "last " + money(p) : ""].filter(Boolean).join(" · "))),
      stepper(l.qty, n => setQty(l.code, l.name, n))));
  });
  if (c.lines.length) card.append(el("p", { class: "muted small est" }, `About ${money(est)} before GST at the last prices paid` + (unpriced ? ` (${unpriced} item${unpriced === 1 ? "" : "s"} with no price yet)` : "") + "."));
  const note = el("textarea", { id: "po-note", rows: "2", maxlength: "500", placeholder: "A note for the purchaser (optional)" });
  note.value = c.note || ""; note.addEventListener("input", () => { c.note = note.value; keep(); });
  card.append(note);
  if (!c.id && c.lines.length) card.append(el("button", { class: "link", type: "button", onclick: ev => { if (!sure(ev.target, "Tap again to clear the order")) return; App.cart.lines = []; App.cart.note = ""; localStorage.removeItem("pu.cart"); renderCart(); renderCatalog(); } }, "Clear the order"));
  box.append(card);
}
function renderCats() {
  const chip = (k, label) => el("button", { class: "chip" + (App.cat === k ? " on" : ""), type: "button", onclick: () => { App.cat = k; renderCats(); renderCatalog(); } }, label);
  $("po-cats").replaceChildren(chip("", "All"), ...App.meta.categories.map(k => chip(k, k)));
}
function renderCatalog() {
  const q = App.q.trim().toLowerCase(), words = q.split(/\s+/).filter(Boolean);
  const hits = App.meta.catalog.filter(c => (!App.cat || c.category === App.cat) && words.every(w => `${c.name} ${c.code}`.toLowerCase().includes(w)));
  const list = $("po-list"); list.replaceChildren();
  if (!hits.length) { list.append(el("p", { class: "empty" }, q ? "Nothing matches. Add it by its order code below." : "No items here.")); return; }
  hits.slice(0, 200).forEach(c => {
    const inCart = App.cart.lines.find(l => l.code === c.code);
    list.append(el("button", { class: "row item" + (inCart ? " on" : ""), type: "button", onclick: () => { setQty(c.code, c.name, (inCart ? inCart.qty : 0) + 1); toast(`Added ${c.name}`); } },
      el("div", { class: "row-main" }, el("div", { class: "row-title" }, c.name),
        el("div", { class: "row-sub" }, [c.code, c.unit, Number(c.price) ? "last " + money(c.price) : ""].filter(Boolean).join(" · "))),
      el("span", { class: "badge " + (inCart ? "done" : "add") }, inCart ? `${inCart.qty} in order` : "Add")));
  });
}
$("po-search").oninput = e => { App.q = e.target.value; renderCatalog(); };
$("other-add").onclick = () => {
  const code = $("other-code").value.replace(/\s/g, ""), name = $("other-name").value.trim();
  if (!/^\d{3,12}$/.test(code)) { toast("The order code is the number on the item's Popular page."); return; }
  if (!name) { toast("Put the item's name too, so the purchaser knows what it is."); return; }
  const l = App.cart.lines.find(x => x.code === code);
  setQty(code, l ? l.name : name, (l ? l.qty : 0) + 1);
  $("other-code").value = ""; $("other-name").value = ""; $("po-other").open = false;
  toast(`Added ${name}`);
};
$("btn-po-send").onclick = ev => {
  const c = App.cart;
  if (!c.lines.length) { toast("Add at least one item."); return; }
  busyBtn(ev.target, "Sending…", async () => {
    const a = c.id ? await api("po_update", { id: c.id, lines: c.lines, note: c.note }) : await api("po_submit", { site: c.site, lines: c.lines, note: c.note });
    if (!c.id) localStorage.removeItem("pu.cart");
    toast(c.id ? "Changes saved." : "Sent. The purchaser can see it now.");
    await refreshHome(); openView(a.item);
  });
};
$("po-back").onclick = () => guard(loadHome);
async function refreshHome() { App.home = await api("home"); remember("pu.home", App.home); }

/* ---------- one PO ---------- */
function openView(p) { App.view = p; show("scr-view"); renderView(); }
function renderView() {
  const p = App.view, me = session.name, buyer = App.meta.purchaser, body = $("view-body");
  $("view-title").textContent = `${siteLabel(p.site)}`;
  $("view-sub").textContent = p.id;
  const steps = [["Sent by " + p.by, p.created_at], p.ordered_at && [`Ordered from Popular by ${p.ordered_by}` + (p.popular_ref ? ` (${p.popular_ref})` : ""), p.ordered_at],
    p.sent_at && ["Sent to the site by " + p.sent_by, p.sent_at], p.received_at && ["Received by " + p.received_by, p.received_at], p.cancelled_at && ["Cancelled by " + p.cancelled_by, p.cancelled_at]].filter(Boolean);
  body.replaceChildren(
    el("div", { class: "card" }, el("div", { class: "sup-head" }, el("h2", {}, "Popular order"), el("span", { class: "badge " + (BADGE[p.status] || "") }, status(p.status))),
      el("ul", { class: "steps" }, steps.map(([t, at]) => el("li", {}, el("span", {}, t), el("span", { class: "muted" }, fmtWhen(at))))),
      p.note ? el("p", { class: "note" }, p.note) : null),
    el("div", { class: "card" }, el("div", { class: "sup-head" }, el("h2", {}, "Items"), el("span", { class: "muted small" }, `${p.lines.length}`)),
      p.lines.map(l => el("div", { class: "line" }, el("span", { class: "q" }, `${l.qty} ×`), el("div", { class: "row-main" }, el("div", { class: "row-title" }, l.name), el("div", { class: "row-sub" }, l.code))))));
  const acts = el("div", { class: "actions" });
  const act = (label, cls, fn, ask) => acts.append(el("button", { class: "btn " + cls, type: "button", onclick: ev => { if (ask && !sure(ev.target, ask)) return; busyBtn(ev.target, "Saving…", fn); } }, label));
  const move = (action, msg) => async () => { const a = await api(action, { id: p.id }); App.view = a.item; toast(msg); await refreshHome(); renderView(); };
  if (p.status === "submitted" && (p.by === me || buyer)) {
    act("Change the order", "ghost", async () => openPO(p));
    act("Cancel the order", "danger", move("po_cancel", "Cancelled."), "Tap again to cancel it");
  }
  if (p.status === "ordered" && buyer) act("Packed and sent to the site", "primary", move("po_sent", "Marked as sent to the site."), `Tap again: sent to ${p.site}`);
  if (p.status === "ordered" || p.status === "sent") act("We received it", p.status === "sent" ? "primary" : "ghost", move("po_received", "Marked as received."), "Tap again: everything arrived");
  if (acts.childNodes.length) body.append(acts);
}
$("view-back").onclick = () => guard(loadHome);

/* ---------- the purchaser's combined Popular order ---------- */
function openCombine() {
  const waiting = App.home.pos.filter(p => p.status === "submitted");
  App.sel = new Set(waiting.map(p => p.id));
  $("combine-ref") && ($("combine-ref").value = "");
  show("scr-combine"); renderCombine();
}
function combine(pos) { // as combine() in Code.gs: every line of these POs added up by order code
  const by = {};
  pos.forEach(p => p.lines.forEach(l => { const t = by[l.code] || (by[l.code] = { code: l.code, name: l.name, qty: 0, sites: [] }); t.qty += Number(l.qty) || 0; t.sites.push(`${p.site} ${l.qty}`); }));
  return Object.values(by).sort((a, b) => a.name.localeCompare(b.name));
}
function renderCombine() {
  const waiting = App.home.pos.filter(p => p.status === "submitted"), picked = waiting.filter(p => App.sel.has(p.id)), lines = combine(picked);
  const ref = $("combine-ref") ? $("combine-ref").value : "";
  $("combine-sub").textContent = `${picked.length} of ${waiting.length} orders · ${lines.length} items`;
  const body = $("combine-body"); body.replaceChildren();
  body.append(el("p", { class: "muted small" }, "Untick an order to leave it for the next Popular order."));
  body.append(el("div", { class: "card" }, waiting.map(p => {
    const box = el("input", { type: "checkbox", checked: App.sel.has(p.id), onchange: e => { e.target.checked ? App.sel.add(p.id) : App.sel.delete(p.id); renderCombine(); } });
    return el("label", { class: "line pick" }, box, el("div", { class: "row-main" }, el("div", { class: "row-title" }, `${siteLabel(p.site)} · ${p.items} item${p.items === "1" ? "" : "s"}`),
      el("div", { class: "row-sub" }, `${p.by} · ${fmtWhen(p.created_at)}` + (p.note ? ` · “${p.note}”` : ""))));
  })));
  let est = 0;
  const card = el("div", { class: "card" }, el("div", { class: "sup-head" }, el("h2", {}, "To order"), el("span", { class: "muted small" }, "added up by order code")));
  lines.forEach(l => { const p = Number((item(l.code) || {}).price) || 0; est += p * l.qty;
    card.append(el("div", { class: "line" }, el("span", { class: "q" }, `${l.qty} ×`),
      el("div", { class: "row-main" }, el("div", { class: "row-title" }, l.name), el("div", { class: "row-sub" }, `${l.code} · ${l.sites.join(", ")}`)))); });
  if (!lines.length) card.append(el("p", { class: "muted small" }, "Tick at least one order."));
  else card.append(el("p", { class: "muted small est" }, `About ${money(est)} before GST, ${money(est * (1 + GST))} with GST, at the last prices paid.`));
  const text = lines.map(l => `${l.code}\t${l.qty}\t${l.name}`).join("\n");
  card.append(el("div", { class: "actions" },
    el("button", { class: "btn ghost", type: "button", disabled: !lines.length, onclick: () => copy(text) }, "Copy the list"),
    el("a", { class: "btn ghost", href: "https://os.popular.com.sg/", target: "_blank", rel: "noopener" }, "Open Popular")));
  body.append(card);
  const field = el("label", { class: "field" }, el("span", { class: "label" }, "Popular order number (optional)"), el("input", { id: "combine-ref", autocomplete: "off", placeholder: "from Popular's confirmation" }));
  body.append(field); $("combine-ref").value = ref;
  $("btn-ordered").textContent = `Mark ${picked.length} order${picked.length === 1 ? "" : "s"} as ordered`;
  $("btn-ordered").disabled = !picked.length;
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch (e) { const t = el("textarea", {}); t.value = text; document.body.append(t); t.select(); document.execCommand("copy"); t.remove(); }
  toast("Copied: order code, quantity and name, one item a line.");
}
$("btn-ordered").onclick = ev => {
  const ids = [...App.sel]; if (!ids.length) return;
  if (!sure(ev.target, `Tap again: the order is placed with Popular`)) return;
  busyBtn(ev.target, "Saving…", async () => {
    const a = await api("po_order", { ids, ref: $("combine-ref").value.trim() });
    toast(`${a.ordered} order${a.ordered === 1 ? "" : "s"} marked as ordered. When it arrives, pack each site's order and mark it sent.`);
    await loadHome();
  });
};
$("combine-back").onclick = () => guard(loadHome);

/* ---------- boot ---------- */
(async () => {
  if (!API_URL) $("demo-banner").hidden = false;
  // the demo and the real app share this origin's storage: switching between them starts clean, so demo rows never paint over real ones
  const mode = API_URL ? "live" : "demo";
  if (localStorage.getItem("pu.mode") !== mode) {
    Object.keys(localStorage).filter(k => k.startsWith("pu.") && !["pu.api", "pu.site"].includes(k)).forEach(k => localStorage.removeItem(k));
    localStorage.setItem("pu.mode", mode);
  }
  if (session.token) { // stays signed in until Lock is tapped or the server session ends
    try { await enterApp(); return; }
    catch (e) {
      if (e.auth) session.clear();
      else { toast(e.message); if (App.meta) return; }
    }
  }
  guard(loadLogin);
})();
