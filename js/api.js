/* Backend client: where the API lives, the session, and a demo mode used when no API URL is configured. The demo
 * runs the backend's own helpers (parseUrbanTab, cleanLines, combine, the seed catalog) from backend/Code.gs, so it
 * cannot drift from the server's rules. */
"use strict";

// The deployed Apps Script web app: paste its /exec URL here. While it is blank the app runs the demo. A phone can be
// pointed at a test deployment with localStorage.setItem("pu.api", url). ?demo=1 always runs the demo (PIN 1234).
const LIVE_URL = "https://script.google.com/macros/s/AKfycbzSumrT4WpeyEeyBrfmZ8-U1DveDvA8QA-I97HzZy_Bncf8IC2ozjEXgqXmvAzXNtcOtQ/exec";
const API_URL = new URLSearchParams(location.search).get("demo") ? "" : localStorage.getItem("pu.api") || LIVE_URL;

const session = {
  get token() { return localStorage.getItem("pu.token") || ""; },
  get name() { return localStorage.getItem("pu.name") || ""; },
  save(a) { localStorage.setItem("pu.token", a.token); localStorage.setItem("pu.name", a.name); },
  clear() { ["pu.token", "pu.name", "pu.meta", "pu.home"].forEach(k => localStorage.removeItem(k)); }, // the remembered site stays: it is the phone's, not the person's
};

let inflight = 0;
// Apps Script sometimes answers with its ping page or an HTML error although the script ran, so only reads are retried by themselves
const RETRY_SAFE = ["roster", "meta", "home", "up_get", "po_get"];
async function api(action, payload, attempt) {
  attempt = attempt || 0;
  try { return await apiOnce(action, payload); }
  catch (e) {
    if (!(e.retry && RETRY_SAFE.includes(action) && attempt < 2)) throw e;
    await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
    return api(action, payload, attempt + 1);
  }
}
async function apiOnce(action, payload) {
  const body = Object.assign({ action, token: session.token }, payload || {});
  inflight++; document.body.classList.add("busy");
  try {
    let data;
    if (!API_URL) data = await mock(body);
    else {
      // text/plain keeps the request "simple": Apps Script cannot answer a CORS preflight
      const res = await fetch(API_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body) });
      const text = await res.text();
      try { data = JSON.parse(text); } catch (e) { const err = new Error("The server is busy. Try again in a moment."); err.retry = true; throw err; }
      if (data.app === "purchasing" && action !== "ping") { const err = new Error("The server is busy. Try again in a moment."); err.retry = true; throw err; } // a POST Google turned into a GET
    }
    if (data.error) { const e = new Error(data.error); e.auth = !!data.auth; throw e; }
    return data;
  } finally { if (--inflight === 0) document.body.classList.remove("busy"); }
}

/* ---------- demo mode: the same actions, in memory, PIN 1234. Every name here is invented. ---------- */
let demo = null;
async function mock(b) {
  if (!demo) demo = await demoSeed();
  await new Promise(r => setTimeout(r, 150));
  const C = demo.C, now = () => new Date().toISOString(), user = demo.user;
  const buyer = () => { if (!C.isPurchaser(user, demo.settings.purchasers)) throw new Error("Only the purchaser can do this."); };
  const round = () => demo.rounds.slice().sort((a, c) => c.round.localeCompare(a.round))[0] || null;
  const tabOf = name => { const t = demo.tabs.find(t => t.tab === name); if (!t) throw new Error(`The Urban Plus sheet has no tab "${name}".`); return t; };
  const parsed = name => { const t = tabOf(name); return C.parseUrbanTab(t.values, t.formulas); };
  const po = id => { const p = demo.pos.find(p => p.id === id); if (!p) throw new Error("not found: " + id); return p; };
  const move = (id, to, from, ok, refusal) => { const p = po(id);
    if (p.status === to) return { item: p };
    if (!from.includes(p.status)) throw new Error(`This order is "${C.PO_STATUS[p.status]}" now.`);
    if (ok && !ok(p)) throw new Error(refusal);
    Object.assign(p, { status: to, [to + "_by"]: user, [to + "_at"]: now(), updated_at: now() }); return { item: p }; };
  const learn = lines => lines.forEach(l => { if (l.code && !demo.catalog.some(c => c.code === l.code)) demo.catalog.push({ code: l.code, name: l.name, category: "", unit: "", price: "", price_date: "", frequent: false }); });
  const meta = o => { // as meta() in Code.gs: compact rows and a version for a phone that asks, nothing when it holds that version already
    const base = { sites: demo.sites, categories: C.CATEGORIES, purchaser: C.isPurchaser(demo.user, demo.settings.purchasers), purchasers: demo.settings.purchasers, company: "KitchenBASE (demo)", statuses: C.PO_STATUS, urban_sheet: "" };
    if (!o || !o.compact) return Object.assign(base, { catalog: demo.catalog });
    const rows = C.packCatalog(demo.catalog), json = JSON.stringify(rows); let h = 0; for (let i = 0; i < json.length; i++) h = (h * 31 + json.charCodeAt(i)) | 0;
    const v = "demo" + (h >>> 0).toString(36);
    return Object.assign(base, o.catv === v ? { catalog_version: v } : { catalog_version: v, catalog_rows: rows }); };
  try {
    switch (b.action) {
      case "roster": return { names: demo.names };
      case "login": if (String(b.pin) !== "1234") return { error: "Wrong PIN. The demo PIN is 1234." }; demo.user = b.name; return Object.assign({ token: "demo", name: b.name }, meta(b));
    }
    if (b.token !== "demo" || !demo.user) return { error: "Session expired. Log in again.", auth: true };
    switch (b.action) {
      case "meta": return meta(b);
      case "home": {
        const r = round(), tabs = C.urbanTabs(demo.tabs.map(t => t.tab)), out = { round: r && Object.assign({}, r, { label: C.roundLabel(r.round) }), newest: tabs[0] || null, sites: [] };
        if (r) { const p = parsed(r.tab); out.sites = p.sites.map((s, i) => { const l = demo.log.find(x => x.round === r.round && x.site === s.code) || {};
          return { code: s.code, label: s.label, by: l.by || "", at: l.at || "", items: p.items.filter(it => it.qty[i] > 0).length, total: C.siteTotal(p, s.code) }; }); }
        return { urban: out, pos: demo.pos.slice().sort((a, c) => c.created_at.localeCompare(a.created_at)) };
      }
      case "up_get": { const r = round(); if (!r) return { round: null };
        const p = parsed(r.tab), i = p.sites.findIndex(s => s.code === b.site);
        if (i < 0) throw new Error(`${b.site} has no column in the Urban Plus tab "${r.tab}".`);
        const l = demo.log.find(x => x.round === r.round && x.site === b.site) || {};
        return { round: Object.assign({}, r, { label: C.roundLabel(r.round) }), site: b.site, by: l.by || "", at: l.at || "", items: p.items.map(it => ({ row: it.row, name: it.name, price: it.price, qty: it.qty[i] })) }; }
      case "up_save": { const r = round();
        if (!r) throw new Error("No Urban Plus round is open.");
        if (r.status !== "open") throw new Error(`The ${C.roundLabel(r.round)} order has gone to Urban Plus. Ask the purchaser to change it.`);
        const t = tabOf(r.tab), p = parsed(r.tab), si = p.sites.findIndex(s => s.code === b.site);
        (b.lines || []).forEach(l => { const it = p.items.find(x => x.row === l.row);
          if (!it || it.name !== l.name) throw new Error("The Urban Plus list has changed since you opened it. Go back and open it again.");
          t.values[it.row - 1][p.sites[si].qtyCol - 1] = Number(l.qty) || ""; });
        const after = parsed(r.tab), total = C.siteTotal(after, b.site), items = after.items.filter(it => it.qty[si] > 0).length;
        demo.log = demo.log.filter(x => !(x.round === r.round && x.site === b.site)).concat({ round: r.round, site: b.site, by: user, at: now() });
        return { ok: true, total, items }; }
      case "up_open": { buyer();
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(b.month || "")) throw new Error("Pick the month.");
        if (demo.rounds.some(r => r.round === b.month)) throw new Error(`${C.roundLabel(b.month)} is already open.`);
        const tabs = C.urbanTabs(demo.tabs.map(t => t.tab)), name = C.tabNameFor(b.month);
        if (!tabs.some(t => t.key === b.month)) { const src = tabOf(tabs[0].tab), values = src.values.map(r => r.slice()), p = C.parseUrbanTab(values, src.formulas);
          p.items.forEach(it => p.sites.forEach(s => { values[it.row - 1][s.qtyCol - 1] = ""; }));
          demo.tabs.unshift({ tab: name, values, formulas: src.formulas }); }
        demo.rounds.push({ round: b.month, tab: name, status: "open", opened_by: user, opened_at: now(), sent_by: "", sent_at: "" });
        return { ok: true, tab: name }; }
      case "up_sent": { buyer(); const r = round(); if (!r || r.status !== "open") throw new Error("No open round to mark as sent.");
        Object.assign(r, { status: "sent", sent_by: user, sent_at: now() }); return { ok: true }; }
      case "po_get": return { item: po(b.id) };
      case "po_submit": { if (!demo.sites.some(s => s.code === b.site)) throw new Error("Pick your site.");
        const lines = C.cleanLines(b.lines), at = now(), id = "PO-" + at.slice(0, 10).replace(/-/g, "") + "-" + Math.random().toString(16).slice(2, 6).toUpperCase();
        const p = { id, site: b.site, status: "submitted", by: user, created_at: at, updated_at: at, note: String(b.note || "").trim(), lines, lines_text: C.linesText(lines), items: String(lines.length) };
        demo.pos.push(p); learn(lines); return { item: p }; }
      case "po_update": { const p = po(b.id), lines = C.cleanLines(b.lines);
        if (p.status !== "submitted") throw new Error("This order has been placed with Popular already. Ask the purchaser to change it.");
        Object.assign(p, { lines, lines_text: C.linesText(lines), items: String(lines.length), note: String(b.note || "").trim(), updated_at: now() }); learn(lines); return { item: p }; }
      case "po_cancel": return move(b.id, "cancelled", ["submitted"], p => p.by === user || C.isPurchaser(user, demo.settings.purchasers), "Only whoever sent it, or the purchaser, can cancel it.");
      case "po_order": { buyer(); if (!(b.ids || []).length) throw new Error("Tick the orders that went into the Popular order.");
        b.ids.forEach(id => { const p = po(id); if (p.status === "submitted") Object.assign(p, { status: "ordered", ordered_by: user, ordered_at: now(), popular_ref: String(b.ref || "").trim(), updated_at: now() }); });
        return { ok: true, ordered: b.ids.length }; }
      case "po_code": { buyer(); const code = String(b.code || "").replace(/\s+/g, "");
        if (!/^\d{3,12}$/.test(code)) throw new Error("The order code is the number on the item's Popular page (3 to 12 digits).");
        let changed = 0;
        (b.ids || []).forEach(id => { const p = po(id); if (p.status !== "submitted") return; const out = C.giveCode(p.lines, b.name, code); if (!out) return;
          Object.assign(p, { lines: out, lines_text: C.linesText(out), items: String(out.length), updated_at: now() }); changed++; });
        if (changed) learn([{ code, name: String(b.name).trim() }]);
        return { ok: true, changed }; }
      case "po_sent": buyer(); return move(b.id, "sent", ["ordered"]);
      case "po_received": return move(b.id, "received", ["ordered", "sent"]);
    }
    return { error: "unknown action " + b.action };
  } catch (e) { return { error: e.message }; }
}

async function demoSeed() {
  const src = await (async () => { for (const u of ["../backend/Code.gs", "backend/Code.gs"]) { const r = await fetch(u).catch(() => null); if (r && r.ok) return r.text(); }
    throw new Error("Demo mode needs backend/Code.gs served beside the app (run the server from the purchasing folder)."); })();
  const C = new Function("module", src + "\nreturn module.exports;")({ exports: {} });
  // the Urban Plus month tab as it looks in the sheet (items and prices from "Cleaning Supplies 0926")
  const items = [["Multi Purpose Cleaner", 9.5], ["Bleach (5L)", 5.8], ["Glass Cleaner (5L)", 8.8], ["Hand Soap (5L)", 9], ["Stainless Steel Polisher", 39.2], ["Heavy Duty Floor Degreaser (5L)", 13.5],
    ["Drain Free Liquid (5L)", 28], ["Urban GP Clean (5L)", 9.5], ["Oven Cleaner (5L)", 17], ["Nitrile Gloves", 11], ["Mop Head", 4.6], ["Floor Scraper", 11.5], ["Good Morning Towel (12)", 15],
    ["3M scrub sponge - 5 pieces", 5], ["Mop with stick", 8.9], ["Rubber Floor Scrapper with Aluminium Stick", 11.5], ["Soft Hair Broom Set", 10.7], ["Toilet Rolls", 6], ["Toilet brush", 3],
    ["Jumbo Toilet Roll (16/ctn)", 24], ["Black Trash Bags 50\" x 52\" (10)", 6.5], ["Glass Wiper", 4.6], ["Floor cleaner - strawbery/lemon/lavender", 10], ["Microfiber Cleaning Cloth 30 cm x 30 cm", 20],
    ["Large Stainless Steel Metal Wool Sponge", 10], ["Spray Bottle (500ml)", 3], ["Heavy Duty Scrubbing Pad - 10PCS/Bundel", 6]];
  const cols = ["Tampines - S1", "Clementi - S2", "Sembawang-S3", "Bishan-S6", "Serangoon-S7", "Bedok-S8", "Bukit Batok-S9", "Macpherson-S10", "Jurung west-S11", "Mediapolis-S12", "Bedok ii-S13"];
  const head = ["", "Price"].concat(...cols.map(c => [c, "Price"]));
  const blank = () => head.map(() => "");
  const values = [head].concat(items.map(([n, p]) => { const r = blank(); r[0] = n; r[1] = p; return r; }), [blank()]);
  const formulas = values.map(() => head.map(() => "")); formulas.push(head.map((h, c) => c > 2 && c % 2 === 1 ? "=SUM(D2:D29)" : ""));
  values.push(blank());
  const qty = (row, site, n) => { values[row - 1][head.indexOf(cols.find(c => c.endsWith(site))) ] = n; };
  qty(3, "S1", 2); qty(7, "S1", 2); qty(22, "S1", 10); qty(24, "S1", 5); qty(3, "S6", 5); qty(12, "S6", 6); qty(24, "S6", 8);
  const old = values.map(r => r.slice()); // last month, already sent, as a tab made before the app
  const sites = [["S1", "Tampines"], ["S2", "Clementi"], ["S3", "Sembawang"], ["S6", "Bishan"], ["S7", "Serangoon"], ["S8", "Bedok"], ["S9", "Bukit Batok"], ["S10", "Macpherson"], ["S11", "Jurong West"], ["S12", "Mediapolis"], ["S13", "Bedok II"]].map(([code, name]) => ({ code, name }));
  const d = new Date(), month = d.toISOString().slice(0, 7), prev = new Date(d.getFullYear(), d.getMonth() - 1, 15).toISOString().slice(0, 7), ago = h => new Date(Date.now() - h * 36e5).toISOString();
  const cat = code => C.SEED_CATALOG.find(r => r[0] === code);
  const mk = (site, status, by, hours, codes, extra, described) => { const lines = codes.map(([c, q]) => ({ code: c, name: cat(c)[1], qty: q })).concat(described || []);
    return Object.assign({ id: `PO-demo-${site}-${hours}`, site, status, by, created_at: ago(hours), updated_at: ago(hours), note: "", lines, lines_text: C.linesText(lines), items: String(lines.length) }, extra || {}); };
  return {
    C, user: "", names: ["Demo Purchaser", "Demo Supervisor", "Demo Shift Lead"], sites,
    settings: { purchasers: "Demo Purchaser" },
    catalog: C.SEED_CATALOG.map(([code, name, category, unit, price, price_date]) => ({ code, name, category, unit, price, price_date, frequent: !!price })), // priced = on a Popular invoice, as the live sheet's source
    tabs: [{ tab: C.tabNameFor(month), values, formulas }, { tab: C.tabNameFor(prev), values: old, formulas }],
    rounds: [{ round: prev, tab: C.tabNameFor(prev), status: "sent", opened_by: "Demo Purchaser", opened_at: ago(24 * 30), sent_by: "Demo Purchaser", sent_at: ago(24 * 25) },
      { round: month, tab: C.tabNameFor(month), status: "open", opened_by: "Demo Purchaser", opened_at: ago(48), sent_by: "", sent_at: "" }],
    log: [{ round: month, site: "S1", by: "Demo Supervisor", at: ago(20) }, { round: month, site: "S6", by: "Demo Shift Lead", at: ago(5) }],
    pos: [
      mk("S3", "submitted", "Demo Shift Lead", 3, [["2074999", 1], ["1743993", 1], ["2286739", 3], ["2259328", 1]]),
      mk("S12", "submitted", "Demo Supervisor", 6, [["2330883", 1], ["2236437", 1], ["211452", 2], ["2286739", 2]], { note: "Batteries for the door sensor" }, [{ code: "", name: "Whiteboard marker, red", qty: 2 }]),
      mk("S1", "ordered", "Demo Supervisor", 50, [["552309", 3], ["2250337", 4], ["456302", 1]], { ordered_by: "Demo Purchaser", ordered_at: ago(30), popular_ref: "SO-104233" }),
      mk("S9", "sent", "Demo Shift Lead", 120, [["2287116", 1], ["1954966", 1]], { ordered_by: "Demo Purchaser", ordered_at: ago(100), popular_ref: "SO-103981", sent_by: "Demo Purchaser", sent_at: ago(20) }),
      mk("S6", "received", "Demo Shift Lead", 300, [["2373104", 3], ["2250338", 1]], { ordered_by: "Demo Purchaser", ordered_at: ago(280), popular_ref: "SO-103710", sent_by: "Demo Purchaser", sent_at: ago(200), received_by: "Demo Shift Lead", received_at: ago(190) }),
    ],
  };
}
