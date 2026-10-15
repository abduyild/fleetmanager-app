// Fahrzeuge (SPEZIFIKATION B6/B7, ui-review.md §5.5): Liste (/admin/fahrzeuge), Anlegen (/admin/fahrzeuge/neu),
// Detail mit Schäden, Fahrten des Tages und Stammdaten (/admin/fahrzeuge/:id), Excel-Exporte.
// Alle Datenänderungen laufen über actions.* in store.update; nach jeder Änderung rendern sich die Screens neu (store.subscribe).
// Liste: eine Karte je Fahrzeug (der Name ist der Link und deckt die Karte ab, Knöpfe liegen darüber), Zusammenfassungszeile statt
// Kacheln, Archiviertes hinter einer Aufklapp-Zeile, Sperren über ein Sheet mit Gründen. Die Liste erneuert nur ihren Inhalt
// (#v-live; Leiste und Scroll-Position bleiben), auch bei Änderungen anderer Geräte (Hub); dazu ein Tick alle 30 s für Laufzeiten
// und Überfälligkeit. Fremde Änderungen und der Tick warten, solange ein Sheet offen ist oder ein Feld den Fokus hat.
// Detail: erst die Aktionen, dann Schäden, Fahrten heute, Stammdaten (Aufklapp-Zeile mit eigenem Speichern), rote Aktionen zuletzt.
import { register } from "../router.js";
import { html, render, formData, go, flash, flashNext, adminShell, ask, shellKey, openSheet, $ } from "../ui.js";
import { icon } from "../icons.js";
import { store } from "../store.js";
import * as m from "../model.js";
import * as actions from "../actions.js";
import { safeCell, downloadXLSX } from "../export.js";

const LIST = "/admin/fahrzeuge";
const QUEUE = "/admin/warteschlange";
const TICK_MS = 30000;

// Ereignis-Delegation mit Aufräumen: `el` (#app) bleibt über alle Routen bestehen, deshalb werden die
// Listener beim Verlassen der Route über den AbortController wieder entfernt (ui.on kann das nicht).
function delegate(el, type, selector, handler, signal) {
  el.addEventListener(type, (ev) => {
    const target = ev.target.closest(selector);
    if (target && el.contains(target)) handler(ev, target);
  }, { signal });
}
const newestFirst = (key) => (a, b) => (a[key] < b[key] ? 1 : a[key] > b[key] ? -1 : 0);
const joinNonEmpty = (sep, ...parts) => parts.filter(Boolean).join(sep);
const vehicleById = (id) => store.data.vehicles.find((v) => v.id === id);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// Ein Sheet ist offen oder ein Feld hat den Fokus → kein automatisches Neu-Rendern
function busy(el) {
  const a = document.activeElement;
  return !!el.querySelector("dialog[open]") || !!(a && el.contains(a) && ["INPUT", "TEXTAREA", "SELECT"].includes(a.tagName));
}
// „14.10. 19:20“ (anderes Jahr: „14.10.2025 19:20“)
function shortDate(ts) {
  const d = m.parseTS(ts);
  if (!d) return ts || "";
  const p = (n) => String(n).padStart(2, "0");
  const year = d.getFullYear() === new Date().getFullYear() ? "" : String(d.getFullYear());
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${year} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// --- Ansichtsdaten ---------------------------------------------------------------------------------
// Zustand → .status (Wort + Punkt, gesperrt mit Schloss) und .num-Farbe; „Frei“ statt „Verfügbar“ (wie in der Fahrzeug-Leiste)
function stateView(info) {
  let cls = "", text, ic = "";
  switch (info.state) {
    case m.V.AVAILABLE: cls = "free"; text = "Frei"; break;
    case m.V.DRIVING: cls = "driving"; text = `Unterwegs · Nr. ${info.entry.number} · seit ${m.deTime(info.entry.started_at)}`; break;
    case m.V.LATE: cls = "late"; text = `Überfällig · Nr. ${info.entry.number} · ${Math.floor(info.elapsed / 60)} Min.`; break;
    case m.V.BLOCKED: cls = "blocked"; text = "Gesperrt: " + info.blocked_reason; ic = "lock"; break;
    default: text = "Archiviert";
  }
  if (info.blocked_after) text += " · danach gesperrt";
  return { cls, text, ic, num: info.state === m.V.DRIVING ? " driving" : info.state === m.V.LATE ? " late" : "" };
}
const status = (sv) => html`<span class="status ${sv.cls}${sv.ic ? " icon" : ""}">${sv.ic ? icon(sv.ic) : ""}${sv.text}</span>`;
// Heute-Zeile der Karte: bei laufender Fahrt „Heute 0 abgeschlossen · 1 läuft“ (statt „noch keine Fahrt“)
function todayLine(info) {
  const s = info.stats;
  const avg = s.today_avg > 0 ? ` · Ø ${s.today_avg} Min.` : "";
  if (info.entry) return `Heute ${s.today_count} abgeschlossen · 1 läuft${avg}`;
  if (!s.today_count) return "Heute noch keine Fahrt";
  const last = m.deTime(s.last_end);
  return `Heute ${plural(s.today_count, "Fahrt", "Fahrten")}${avg}${last ? " · letzte " + last : ""}`;
}
const metaLine = (v) => joinNonEmpty(" · ", v.plate, v.trim);
// Daten für Schäden und Fahrten heute (B7, A6)
function detail(d, cfg, v) {
  const today = m.today();
  const entries = new Map(d.queue.map((e) => [e.id, e]));
  const damages = d.damages.filter((x) => x.vehicle_id === v.id).map((x) => {
    const e = entries.get(x.entry_id); // Vorschaden: kein Eintrag → keine Nummer, kein Link
    return { ...x, number: e ? e.number : "", today: !!e && e.day === today };
  }).sort(newestFirst("created_at"));
  const drives = d.queue.filter((e) => e.vehicle_id === v.id && e.day === today).sort(newestFirst("started_at"));
  const info = m.vehicleStates([v], d.queue, d.damages, cfg, true)[0];
  return {
    info, sv: stateView(info), open: damages.filter((x) => !x.resolved_at), resolved: damages.filter((x) => x.resolved_at),
    drives, driving: !!info.entry, referenced: m.isReferenced(v.id, d.queue, d.damages),
  };
}

// --- Exporte (A7) ---------------------------------------------------------------------------------
// Blatt „Fahrzeuge“ (inkl. archivierter) und Blatt „Schäden“ (neueste zuerst)
function exportVehicles(d) {
  const cfg = d.settings;
  const infos = m.sortForPage(m.vehicleStates(d.vehicles, d.queue, d.damages, cfg, true));
  const labels = {};
  const rows = infos.map((v) => {
    labels[v.id] = v.label;
    return [safeCell(v.code), safeCell(v.model), safeCell(v.color), safeCell(v.plate), safeCell(v.trim),
      v.state === m.V.BLOCKED ? `Gesperrt: ${v.blocked_reason}` : v.state_label,
      v.stats.today_count, v.stats.total_count, v.stats.total_avg > 0 ? v.stats.total_avg : "", v.open_damages.length];
  });
  const numbers = Object.fromEntries(d.queue.map((e) => [e.id, m.num(e)]));
  const drows = [...d.damages].sort(newestFirst("created_at")).map((x) => [
    safeCell(labels[x.vehicle_id] || ""), m.deDate(x.created_at), safeCell(x.text),
    numbers[x.entry_id] > 0 ? numbers[x.entry_id] : "", m.deDate(x.resolved_at),
  ]);
  downloadXLSX("fahrzeuge", [
    { title: "Fahrzeuge", header: ["Code", "Modell", "Farbe", "Kennzeichen", "Ausstattung", "Status", "Fahrten heute", "Fahrten gesamt", "Ø Dauer (Min)", "Offene Schäden"], rows },
    { title: "Schäden", header: ["Fahrzeug", "Datum", "Text", "nach Fahrt Nr.", "behoben am"], rows: drows },
  ], cfg.accent_color);
}
// Alle Fahrten eines Fahrzeugs – Spalten wie der Warteschlangen-Export (queueExportRows in queue_admin.go)
function exportDrives(d, v) {
  const header = ["Datum", "Nr.", "Name", "Telefon", "E-Mail", "Status", "Angemeldet", "Aufgerufen", "Fahrt Start", "Fahrt Ende", "Dauer",
    "Fahrzeug", "Kennzeichen", "Prüfungen", "Begleiter", "Zustand Ende", "Bemerkung", "Kanal", "Notiz", "Einwilligung (Version)"];
  const plates = Object.fromEntries(d.vehicles.map((x) => [x.id, x.plate]));
  const rows = m.sortQueue(d.queue).filter((e) => e.vehicle_id === v.id).map((e) => {
    const sec = m.durationSeconds(e);
    const condition = e.end_condition === m.END_OK ? "in Ordnung" : e.end_condition === m.END_CONSPICUOUS ? "Auffälligkeit" : "";
    return [
      m.deDay(e.day), /^\d+$/.test(e.number) ? parseInt(e.number, 10) : safeCell(e.number), safeCell(e.name), safeCell(e.phone), safeCell(e.email),
      m.statusLabel(e.status), m.deTime(e.created_at), m.deTime(e.called_at), m.deTime(e.started_at), e.started_at ? m.deTime(e.ended_at) : "",
      sec === null ? "" : m.fmtDuration(sec), safeCell(e.vehicle), safeCell(plates[e.vehicle_id] || ""), safeCell(m.splitPipe(e.checks).join(", ")),
      safeCell(e.staff), condition, safeCell(e.end_note), e.source, safeCell(e.note), e.consent_ref,
    ];
  });
  downloadXLSX(`probefahrten-${String(v.code).toLowerCase()}`, [{ title: "Probefahrten", header, rows }], d.settings.accent_color);
}

// --- Aktionen: Fahrt beenden, Freigeben (Formulare in Karte und Detail) und Sperren (Sheet) ------------------------
async function runAction(form) {
  const { action, id } = form.dataset;
  if (action !== "end" && action !== "unblock") return;
  const btn = form.querySelector("button");
  if (btn) btn.disabled = true;
  try {
    let r, msg = "";
    if (action === "end") {
      r = await store.update((d) => actions.endDrive(d, id, { end_condition: m.END_OK, end_note: "", block_vehicle: false }));
      msg = r.hint || "Fahrt beendet.";
    } else {
      r = await store.update((d) => actions.unblockVehicle(d, id));
      const v = vehicleById(id);
      msg = v ? `Fahrzeug ${v.code} freigegeben.` : "";
    }
    if (r.error) flash(r.error, "error");
    else if (msg) flash(msg);
  } finally {
    if (btn) btn.disabled = false;
  }
}
// Ein Sheet je Seite (außerhalb der neu gezeichneten Bereiche); die Gründe sind ein Auswahl-Segment und füllen das Textfeld
const blockSheet = () => html`
<dialog class="sheet" id="block-sheet" aria-labelledby="block-title">
  <div class="sheet-h">
    <h2 id="block-title">Fahrzeug sperren<small id="block-sub"></small></h2>
    <form method="dialog"><button class="btn quiet icon" value="x" aria-label="Schließen">${icon("x")}</button></form>
  </div>
  <div class="sheet-b">
    <p class="banner error" id="block-error" role="alert" hidden>${icon("alert")}<span></span></p>
    <form id="block-form" data-action="block" novalidate autocomplete="off">
      <p class="lbl">Warum ist das Fahrzeug nicht verfügbar?</p>
      <div class="seg pick v-reasons" role="radiogroup" aria-label="Grund">
        ${m.BLOCK_REASONS.map((r) => html`<label><input type="radio" name="reason_chip" value="${r}">${r}</label>`)}
      </div>
      <label class="field v-reason">
        <span class="lbl">Eigener Grund <small>(optional)</small></span>
        <input type="text" name="reason" maxlength="60">
      </label>
    </form>
  </div>
  <div class="sheet-f"><button type="submit" form="block-form" class="btn primary lg block">Sperren</button></div>
</dialog>`;
function bindBlockSheet(el, signal) {
  delegate(el, "click", "[data-action=block-open]", (ev, btn) => {
    const v = vehicleById(btn.dataset.id);
    const dlg = $("#block-sheet", el);
    if (!v || !dlg) return;
    const form = $("#block-form", dlg);
    form.reset();
    form.dataset.id = v.id;
    $("#block-sub", dlg).textContent = `Fahrzeug ${v.code} · ${m.shortLabel(v)}`;
    $("#block-error", dlg).hidden = true;
    openSheet(dlg, { opener: btn });
  }, signal);
  delegate(el, "change", "#block-form input[name=reason_chip]", (ev, chip) => { chip.form.elements.reason.value = chip.value; }, signal);
  delegate(el, "input", "#block-form input[name=reason]", (ev, field) => {
    for (const r of field.form.querySelectorAll("input[name=reason_chip]")) r.checked = r.value === field.value.trim();
  }, signal);
  delegate(el, "submit", "#block-form", async (ev, form) => {
    ev.preventDefault();
    const dlg = form.closest("dialog");
    const submit = $("button[type=submit]", dlg), banner = $("#block-error", dlg);
    submit.disabled = true;
    try {
      const r = await store.update((d) => actions.blockVehicle(d, form.dataset.id, form.elements.reason.value));
      if (r.error) { banner.querySelector("span").textContent = r.error; banner.hidden = false; return; }   // Fehler im Sheet, nicht dahinter
      const v = vehicleById(form.dataset.id);
      dlg.close("ok");
      // Der Auslöser („Sperren …“) ist nach dem Neuzeichnen weg: der Fokus geht an die Karte bzw. an „Freigeben“, nicht ins Leere
      const next = $(`#v-${form.dataset.id} .v-link`, el) || $("form[data-action=unblock] button", el);
      if (next) next.focus({ preventScroll: true });
      if (v) flash(`Fahrzeug ${v.code} gesperrt: ${v.blocked_reason}.`);
    } finally {
      submit.disabled = false;
    }
  }, signal);
}

// --- Liste -----------------------------------------------------------------------------------------
// Karte: Zeile 1 Nummer · Name (Link) · Meta · Zustand (+ Schäden-Tag) · Pfeil; Zeile 2 Heute-Meta; Zeile 3 genau eine Aktion
function card(info) {
  const sv = stateView(info);
  const n = info.open_damages.length;
  let act = "";
  if (info.entry) {
    act = html`
      <form class="end-ok" data-action="end" data-id="${info.entry.id}">
        <button class="btn primary block">${icon("check")}Fahrt beenden</button>
      </form>
      <a class="btn secondary" href="#${QUEUE}">Zur Fahrt</a>`;
  } else if (info.state === m.V.AVAILABLE) {
    act = html`<button type="button" class="btn secondary block" data-action="block-open" data-id="${info.id}">${icon("lock")}Sperren …</button>`;
  } else if (info.state === m.V.BLOCKED) {
    act = html`<form data-action="unblock" data-id="${info.id}"><button class="btn secondary block">Freigeben</button></form>`;
  }
  const today = info.entry || info.stats.today_count || info.state === m.V.AVAILABLE ? todayLine(info) : "";   // „noch keine Fahrt“ nur bei freien Fahrzeugen
  return html`
<article class="card v-card${sv.num}" id="v-${info.id}">
  <div class="v-top">
    <span class="num v-code${sv.num}">${info.code}</span>
    <div class="v-who">
      <h3 class="v-name"><a class="v-link" href="#${LIST}/${info.id}">${m.shortLabel(info)}</a></h3>
      ${metaLine(info) ? html`<p class="v-meta">${metaLine(info)}</p>` : ""}
      <p class="v-state">${status(sv)}${n ? html`<span class="tag warn">${icon("alert")}${plural(n, "Schaden", "Schäden")}</span>` : ""}</p>
    </div>
    ${icon("chevR", "chev")}
  </div>
  ${today ? html`<p class="v-today">${today}</p>` : ""}
  ${act ? html`<div class="v-actions">${act}</div>` : ""}
</article>`;
}
// Archivierte: kompakte Zeilen, Tipp → Detail (dort „Wiederherstellen“)
const archivedRow = (info) => html`
  <a class="row v-arow" id="v-${info.id}" href="#${LIST}/${info.id}">
    <span class="num sm v-code">${info.code}</span>
    <div class="grow">
      <div class="ttl">${m.shortLabel(info)}</div>
      ${metaLine(info) ? html`<div class="v-sub">${metaLine(info)}</div>` : ""}
    </div>
    ${icon("chevR", "chev")}
  </a>`;

function listScreen({ query, el }) {
  const ac = new AbortController();
  let archOpen = query.archiv === "1";   // Archiv-Aufklappzeile: Zustand überlebt das Neu-Zeichnen (der Link ?archiv=1 öffnet sie)
  let shellSig = "";   // Rahmen (Tabs, Marke, Hinweise) beim letzten vollen Zeichnen
  let listSig = "";    // zuletzt gezeichneter Inhalt: unverändert → nichts neu zeichnen
  let dirty = false;   // fremde Änderung liegt vor, Neu-Rendern wurde wegen offenem Sheet/Fokus verschoben

  // Alles, was sich mit den Daten ändert: Kopf (Knopf „Fahrzeug“ nur mit Fahrzeugen), Zusammenfassung, Karten, Archiv, Export
  const parts = () => {
    const d = store.data;
    const all = m.sortForPage(m.vehicleStates(d.vehicles, d.queue, d.damages, d.settings, true));
    const active = all.filter((v) => v.state !== m.V.ARCHIVED), archived = all.filter((v) => v.state === m.V.ARCHIVED);
    const none = !active.length;
    const head = html`
  <div class="page-head">
    <h1 class="title">Fahrzeuge</h1>
    ${none ? "" : html`<div class="actions"><a class="btn primary" href="#${LIST}/neu" aria-label="Fahrzeug anlegen">${icon("plus")}Fahrzeug</a></div>`}
  </div>
  ${none ? "" : html`<p class="sub count" id="v-count"><b data-count="free">${m.countState(active, m.V.AVAILABLE)}</b> von <b data-count="total">${active.length}</b> frei · <b data-count="driving">${m.countState(active, m.V.DRIVING, m.V.LATE)}</b> unterwegs · <b data-count="blocked">${m.countState(active, m.V.BLOCKED)}</b> gesperrt</p>`}`;
    const cards = none ? html`
    <div class="empty">
      ${icon("car", "lg")}
      <h3>${archived.length ? "Keine aktiven Fahrzeuge" : "Noch keine Fahrzeuge"}</h3>
      <p>${archived.length ? "Alle Fahrzeuge sind archiviert. Lege ein neues an oder stelle ein archiviertes wieder her." : "Lege dein erstes Testfahrzeug an, um Fahrten zu starten."}</p>
      <a class="btn primary" href="#${LIST}/neu">${icon("plus")}Fahrzeug anlegen</a>
    </div>` : html`<div class="cards">${active.map(card)}</div>`;
    const more = (open) => (all.length ? html`
    ${archived.length ? html`
    <details class="v-fold v-archive"${open ? " open" : ""}>
      <summary class="disclosure"><span class="d-ttl">Archiviert</span><span class="n">${archived.length}</span>${icon("chevD")}</summary>
      <div class="list">${archived.map(archivedRow)}</div>
    </details>` : ""}
    <button type="button" class="btn secondary block v-export" data-action="export">${icon("download")}Als Excel exportieren</button>` : "");
    return { head, cards, more };
  };
  const signature = (p) => String(p.head) + "|" + String(p.cards) + "|" + String(p.more(false));   // ohne Aufklapp-Zustand
  const markup = (p) => html`${p.head}<section id="v-list">${p.cards}</section><div id="v-more">${p.more(archOpen)}</div>`;
  const draw = () => {
    const p = parts();
    render(el, adminShell("vehicles", html`<div id="v-live">${markup(p)}</div>${blockSheet()}`, { title: "Fahrzeuge" }));
    shellSig = shellKey();
    listSig = signature(p);
  };
  // Nur den Inhalt erneuern: Leiste, Tab-Leiste und Scroll-Position bleiben unberührt
  const drawList = () => {
    const p = parts(), sig = signature(p);
    if (sig === listSig) return;   // nichts Sichtbares hat sich geändert
    listSig = sig;
    const y = window.scrollY;
    render($("#v-live", el), markup(p));
    window.scrollTo(0, y);
  };
  function redraw(force) {
    if (!force && busy(el)) { dirty = true; return; }
    dirty = false;
    if (shellKey() !== shellSig || !$("#v-live", el)) draw(); else drawList();
  }
  draw();
  // Eigene Änderungen sofort zeigen; fremde (anderes Gerät, anderer Tab) erst, wenn kein Sheet offen ist und kein Feld Fokus hat
  const unsub = store.subscribe((_, info) => { if (!(info && info.hub)) redraw(!(info && info.remote)); });
  const timer = setInterval(() => redraw(false), TICK_MS);
  // Sheet geschlossen (close blubbert nicht → Capture) bzw. Feld verlassen: aufgeschobenes Rendern nachholen
  el.addEventListener("close", () => { if (dirty) redraw(false); }, { capture: true, signal: ac.signal });
  el.addEventListener("focusout", () => { if (dirty) setTimeout(() => { if (dirty) redraw(false); }, 50); }, { signal: ac.signal });
  el.addEventListener("toggle", (ev) => { if (ev.target instanceof Element && ev.target.classList.contains("v-archive")) archOpen = ev.target.open; }, { capture: true, signal: ac.signal });

  bindBlockSheet(el, ac.signal);
  delegate(el, "click", "[data-action=export]", (ev) => { ev.preventDefault(); exportVehicles(store.data); }, ac.signal);
  delegate(el, "submit", "form[data-action]", (ev, form) => { ev.preventDefault(); runAction(form); }, ac.signal);

  return () => { unsub(); clearInterval(timer); ac.abort(); };
}

// --- Anlegen / Detail (B7) -----------------------------------------------------------------------
// Felder von „Neu“ und „Stammdaten bearbeiten“. Freiwillige Felder tragen „(optional)“, Fehler stehen unter dem Feld.
// Die Farbe ist ein Textfeld mit Schnellwahl (Auswahl-Segment); eigene Farben bleiben möglich.
function vehicleFields({ input, errors, models, isNew }) {
  const err = (k) => (errors[k] ? html`<p class="err errmsg" id="err-${k}">${icon("alert")}<span>${errors[k]}</span></p>` : "");
  const bad = (k) => (errors[k] ? html` class="invalid" aria-invalid="true" aria-describedby="err-${k}"` : "");
  const color = String(input.color || "").trim().toLowerCase();
  return html`
  <label class="field">
    <span class="lbl">Modell</span>
    <input name="model" list="models" value="${input.model}"${isNew ? " autofocus" : ""} autocapitalize="words" maxlength="60" required${bad("model")}>
    ${err("model")}
  </label>
  <datalist id="models">${models.map((x) => html`<option value="${x}">`)}</datalist>

  <div class="field">
    <label class="lbl" for="f-color">Farbe <small>(optional)</small></label>
    <input id="f-color" name="color" value="${input.color}" autocapitalize="words" maxlength="30">
    <div class="seg pick v-colors" role="radiogroup" aria-label="Farbe wählen">
      ${m.VEHICLE_COLORS.map((c) => html`<label><input type="radio" name="color_chip" value="${c}"${c.toLowerCase() === color ? " checked" : ""}>${c}</label>`)}
    </div>
  </div>

  <label class="field">
    <span class="lbl">Kennzeichen <small>(optional)</small></span>
    <input name="plate" value="${input.plate}" placeholder="S-06 1234" autocapitalize="characters" maxlength="15"${bad("plate")}>
    ${err("plate")}
    <small class="help">Auch rotes Händlerkennzeichen.</small>
  </label>

  <label class="field">
    <span class="lbl">Ausstattung / Variante <small>(optional)</small></span>
    <input name="trim" value="${input.trim}" placeholder="V2 Long Range · 20 Zoll" maxlength="80">
  </label>

  <label class="field small-field">
    <span class="lbl">Kürzel</span>
    <input name="code" value="${input.code}" maxlength="3" autocapitalize="characters" required${bad("code")}>
    ${err("code")}
    <small class="help">Steht auf dem Schlüsselanhänger.</small>
  </label>`;
}

function formScreen({ params, el }) {
  const selfId = params.id || "";
  const isNew = !selfId;
  const ac = new AbortController();
  let errors = {};
  let input = null;      // Formularwerte – überleben ein Neu-Rendern (z. B. nach „Hinzufügen“)
  let leaving = false;   // nach dem Löschen nicht mehr rendern (Fahrzeug ist weg, Navigation folgt)
  const open = { edit: false, resolved: false, pre: false };   // Aufklapp-Zeilen: Zustand überlebt das Neu-Zeichnen
  const fold = (key) => (open[key] ? " open" : "");

  const draw = () => {
    if (leaving) return;
    const d = store.data, cfg = d.settings;
    const v = isNew ? null : vehicleById(selfId);
    const back = html`<a class="btn quiet v-back" href="#${LIST}">${icon("chevR", "flip")}Fahrzeuge</a>`;
    if (!isNew && !v) {
      render(el, adminShell("vehicles", html`
  ${back}
  <div class="page-head"><h1 class="title">Fahrzeug</h1></div>
  <p class="banner error">${icon("alert")}<span>Fahrzeug nicht gefunden.</span></p>`, { title: "Fahrzeug" }));
      return;
    }
    const y = window.scrollY;
    const form = $("form.vehicle-form", el);
    if (form) input = { ...input, ...formData(form) };
    if (!input) input = isNew ? { model: "", color: "", plate: "", trim: "", code: m.nextCode(d.vehicles), damages: "" }
      : { model: v.model, color: v.color, plate: v.plate, trim: v.trim, code: v.code };
    const models = [...new Set(d.vehicles.map((x) => x.model).filter(Boolean))].sort((a, b) => a.localeCompare(b, "de"));
    const fields = vehicleFields({ input, errors, models, isNew });

    if (isNew) {
      render(el, adminShell("vehicles", html`
  ${back}
  <div class="page-head"><h1 class="title">Neues Fahrzeug</h1></div>
  <form class="vehicle-form vehicle-new" data-action="save" novalidate autocomplete="off">
    ${fields}
    <details class="v-fold v-pre"${fold("pre")}>
      <summary class="disclosure"><span class="d-ttl">Bekannte Vorschäden</span><span class="n">(optional)</span>${icon("chevD")}</summary>
      <div class="card v-fold-body">
        <label class="field">
          <span class="lbl">Eine pro Zeile</span>
          <textarea name="damages" rows="3" placeholder="Kratzer Heckstoßstange links …">${input.damages}</textarea>
        </label>
      </div>
    </details>
    <div class="sticky-save"><button type="submit" class="btn primary lg block">Fahrzeug speichern</button></div>
  </form>`, { title: "Neues Fahrzeug" }));
      window.scrollTo(0, y);
      return;
    }

    const det = detail(d, cfg, v), sv = det.sv, e = det.info.entry;
    const nOpen = det.open.length;
    const stats = det.info.stats;
    // Aktionen zuerst: je Zustand genau eine Hauptaktion
    let act = "";
    if (e) {
      act = html`
      <form class="end-ok" data-action="end" data-id="${e.id}">
        <button class="btn primary block">${icon("check")}Fahrt beenden</button>
      </form>
      <a class="btn secondary" href="${m.telLink(e.phone)}">${icon("phone")}Anrufen</a>`;
    } else if (det.info.state === m.V.AVAILABLE) {
      act = html`<button type="button" class="btn secondary block" data-action="block-open" data-id="${v.id}">${icon("lock")}Sperren …</button>`;
    } else if (det.info.state === m.V.BLOCKED) {
      act = html`<form data-action="unblock" data-id="${v.id}"><button class="btn secondary block">Freigeben</button></form>`;
    }
    render(el, adminShell("vehicles", html`
  ${back}
  <header class="v-head">
    <span class="num v-code${sv.num}">${v.code}</span>
    <div class="v-who">
      <h1 class="title">${m.shortLabel(v)}</h1>
      ${metaLine(v) ? html`<p class="v-meta">${metaLine(v)}</p>` : ""}
      <p class="v-state">${status(sv)}</p>
      ${e ? html`<p class="v-drive">${joinNonEmpty(" · ", e.name, e.staff ? "Begleiter " + e.staff : "")}</p>` : ""}
    </div>
  </header>
  ${act ? html`<div class="v-actions v-actions-head">${act}</div>` : ""}

  <div class="sec"><h2>Schäden</h2><span class="n">${nOpen}</span></div>
  <div class="list v-damages">
    ${nOpen ? det.open.map((x) => html`
    <div class="row v-damage">
      <div class="grow">
        <div class="ttl">${x.text}</div>
        <div class="v-sub">${shortDate(x.created_at)} · ${x.today ? html`<a href="#${QUEUE}">nach Fahrt Nr. ${x.number}</a>` : x.number ? `nach Fahrt Nr. ${x.number}` : "Vorschaden"}</div>
      </div>
      <button type="button" class="btn quiet" data-action="resolve" data-id="${x.id}">Behoben</button>
      <button type="button" class="btn quiet icon v-del" data-action="delete-damage" data-id="${x.id}" data-text="${x.text}" aria-label="Schaden löschen: ${x.text}">${icon("trash")}</button>
    </div>`) : html`<div class="row v-none"><span>Keine offenen Schäden.</span></div>`}
    <form class="row v-add add-damage" data-action="add-damage">
      <input type="text" name="text" placeholder="Schaden hinzufügen" aria-label="Schaden" required minlength="3" maxlength="300">
      <button class="btn secondary">Hinzufügen</button>
    </form>
  </div>
  ${det.resolved.length ? html`
  <details class="v-fold v-resolved"${fold("resolved")}>
    <summary class="disclosure"><span class="d-ttl">Behoben</span><span class="n">${det.resolved.length}</span>${icon("chevD")}</summary>
    <div class="list">
      ${det.resolved.map((x) => html`
      <div class="row v-damage resolved">
        <div class="grow">
          <div class="ttl">${x.text}</div>
          <div class="v-sub">${shortDate(x.created_at)} · behoben ${shortDate(x.resolved_at)}</div>
        </div>
      </div>`)}
    </div>
  </details>` : ""}

  <div class="sec"><h2>Fahrten heute</h2><span class="n">${det.drives.length}</span>${stats.today_avg > 0 ? html`<span class="aside">Ø ${stats.today_avg} Min.</span>` : ""}</div>
  <div class="list v-drives">
    ${det.drives.length ? det.drives.map((x) => html`
    <div class="row">
      <span class="num sm">${x.number}</span>
      <div class="grow">
        <div class="ttl">${x.name}</div>
        <div class="v-sub">${joinNonEmpty(" · ", x.ended_at ? `${m.deTime(x.started_at)}–${m.deTime(x.ended_at)} · ${m.fmtDuration(m.durationSeconds(x))}` : `Seit ${m.deTime(x.started_at)} · läuft`, x.staff ? "Begleiter " + x.staff : "")}</div>
      </div>
      ${x.end_condition === m.END_CONSPICUOUS ? html`<span class="tag warn" title="${x.end_note}" role="img" aria-label="Auffälligkeit: ${x.end_note}">${icon("alert")}Auffällig</span>` : ""}
    </div>`) : html`<div class="row v-none"><span>Heute noch keine Fahrt.</span></div>`}
  </div>

  <details class="v-fold v-edit" id="stammdaten"${fold("edit")}>
    <summary class="disclosure"><span class="d-ttl">Stammdaten bearbeiten</span>${icon("chevD")}</summary>
    <div class="card v-fold-body">
      <form class="vehicle-form" data-action="save" novalidate autocomplete="off">
        ${fields}
        <button type="submit" class="btn primary block">Speichern</button>
      </form>
    </div>
  </details>

  <div class="sec"><h2>Weitere Aktionen</h2></div>
  <div class="list v-more">
    <button type="button" class="row" data-action="export-drives">${icon("download")}<span class="grow ttl">Alle Fahrten exportieren</span></button>
    ${v.archived_at ? html`<button type="button" class="row" data-action="restore">${icon("undo")}<span class="grow ttl">Wiederherstellen</span></button>`
      : !det.driving ? html`<button type="button" class="row danger" data-action="archive">${icon("trash")}<span class="grow ttl">Archivieren …</span></button>` : ""}
    ${det.referenced ? "" : html`<button type="button" class="row danger" data-action="delete">${icon("trash")}<span class="grow ttl">Löschen …</span></button>`}
  </div>
  ${blockSheet()}`, { title: `Fahrzeug ${v.code}` }));
    window.scrollTo(0, y);
  };
  draw();
  if (isNew) { const f = $("input[name=model]", el); if (f) f.focus(); }
  // Hub-Zustand allein ändert nichts; Änderungen anderer Geräte nicht mitten in der Eingabe einblenden (Fokus!)
  const unsub = store.subscribe((_, info) => {
    if (info && (info.hub || (info.remote && busy(el)))) return;
    draw();
  });
  const timer = setInterval(() => { if (!busy(el)) draw(); }, TICK_MS);
  el.addEventListener("toggle", (ev) => {
    const t = ev.target;
    if (!(t instanceof Element) || !t.classList.contains("v-fold")) return;
    const key = t.classList.contains("v-edit") ? "edit" : t.classList.contains("v-resolved") ? "resolved" : t.classList.contains("v-pre") ? "pre" : "";
    if (key) open[key] = t.open;
  }, { capture: true, signal: ac.signal });

  bindBlockSheet(el, ac.signal);
  // Schnellwahl der Farbe: Auswahl füllt das Textfeld, Tippen im Feld markiert die passende Farbe
  delegate(el, "change", ".v-colors input", (ev, chip) => { chip.form.elements.color.value = chip.value; }, ac.signal);
  delegate(el, "input", "input[name=color]", (ev, field) => {
    for (const r of field.form.querySelectorAll("input[name=color_chip]")) r.checked = r.value.toLowerCase() === field.value.trim().toLowerCase();
  }, ac.signal);

  // Speichern (Inline-Fehler bleiben im Formular), „Hinzufügen“ (Schaden), Fahrt beenden, Freigeben
  delegate(el, "submit", "form[data-action]", async (ev, form) => {
    ev.preventDefault();
    const action = form.dataset.action;
    if (action === "save") {
      input = formData(form);
      const predamages = isNew ? m.lines(input.damages) : [];
      const r = await store.update((d) => actions.saveVehicle(d, d.settings, input, selfId, predamages));
      if (r.errors) {
        errors = r.errors;
        if (!isNew) open.edit = true;
        draw();
        const first = $("input.invalid", el);
        if (first) first.focus();
        return;
      }
      if (r.error) { flash(r.error, "error"); return; }
      const text = `Fahrzeug ${r.vehicle.code} gespeichert.${r.trackingOn ? " Fahrtzeit-Tracking wurde eingeschaltet." : ""}`;
      if (isNew) { leaving = true; flashNext(text); go(LIST); return; }
      errors = {}; input = null; open.edit = false;   // Detail bleibt stehen, der Kopf zeigt die neuen Werte
      draw();
      flash(text);
    } else if (action === "add-damage") {
      const r = await store.update((d) => actions.addDamage(d, selfId, form.elements.text.value));
      if (r.error) flash(r.error, "error");
      else flash("Schaden gespeichert.");
    } else {
      await runAction(form);   // end, unblock (block läuft über das Sheet)
    }
  }, ac.signal);

  // Schäden beheben/löschen, Archivieren, Wiederherstellen, Löschen, Export
  delegate(el, "click", "button[data-action]", async (ev, btn) => {
    const { action, id } = btn.dataset;
    const v = vehicleById(selfId);
    if (!v) return;
    let r, msg = "";
    switch (action) {
      case "resolve":
        r = await store.update((d) => actions.resolveDamage(d, id)); msg = "Schaden als behoben markiert."; break;
      case "delete-damage":
        if (!ask(`Schaden „${btn.dataset.text}“ löschen?`)) return;
        r = await store.update((d) => actions.deleteDamage(d, id)); msg = "Schaden gelöscht."; break;
      case "archive":
        if (!ask(`Fahrzeug ${v.code} archivieren? Fahrten und Schäden bleiben erhalten.`)) return;
        r = await store.update((d) => actions.archiveVehicle(d, d.settings, v.id)); msg = `Fahrzeug ${v.code} archiviert.`; break;
      case "restore":
        r = await store.update((d) => actions.restoreVehicle(d, v.id)); msg = `Fahrzeug ${v.code} wiederhergestellt.`; break;
      case "delete":
        if (!ask(`Fahrzeug ${v.code} endgültig löschen?`)) return;
        leaving = true;
        r = await store.update((d) => actions.deleteVehicle(d, v.id));
        if (r.error) { leaving = false; flash(r.error, "error"); return; }
        flashNext(`Fahrzeug ${v.code} gelöscht.`);
        go(LIST);
        return;
      case "export-drives":
        exportDrives(store.data, v); return;
      default:
        return;   // block-open: eigener Handler
    }
    if (r.error) flash(r.error, "error");
    else flash(msg);
  }, ac.signal);

  return () => { unsub(); clearInterval(timer); ac.abort(); };
}

register(LIST, listScreen, { admin: true, bodyClass: "admin" });
register(`${LIST}/neu`, formScreen, { admin: true, bodyClass: "admin" });
register(`${LIST}/:id`, formScreen, { admin: true, bodyClass: "admin" });
