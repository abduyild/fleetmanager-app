// Warteschlange (Admin): /admin/warteschlange. Die Anmeldung der Besucher (Probefahrt-Option, Ticket mit Nummer) ist Teil des
// Kundenformulars: screens/form.js. Hier: Liste, Aufrufen, Fahrt starten/beenden, Fahrzeug-Leiste, Export, Tagesabschluss.
// Standalone: kein Server, keine Statusseite – Aufrufen heißt Anruf/SMS/WhatsApp (und die Aufruf-Anzeige, screens/display.js).
// Markup folgt den Go-Templates partials/_queue_list.html, _vehicle_strip.html, _start_panel.html, _end_panel.html;
// Daten wie queueContext in internal/app/queue_admin.go.
import { register } from "../router.js";
import { html, render, $, $$, formData, formList, flash, ask, adminShell, shellKey, openSheet } from "../ui.js";
import { icon } from "../icons.js";
import { store } from "../store.js";
import * as model from "../model.js";
import * as actions from "../actions.js";
import { safeCell, downloadCSV, downloadXLSX } from "../export.js";

const S = model.STATUS;
const ADMIN = "/admin/warteschlange";

// Ereignis-Delegation mit Aufräumen: Screens werden mehrfach gerendert, Listener dürfen sich nicht stapeln.
function delegate(el, signal) {
  return (type, selector, handler) => el.addEventListener(type, (ev) => {
    const target = ev.target instanceof Element ? ev.target.closest(selector) : null;
    if (target && el.contains(target)) handler(ev, target);
  }, { signal });
}
// Wartezeit minutengenau (ruhiger als tickende Sekunden); im selben Tick wie alle Laufzeiten, ohne Neu-Rendern
const waitText = (sec) => { const min = Math.floor(Math.max(0, sec) / 60); return min < 1 ? "< 1 Min." : `${min} Min.`; };

// --- Admin: Daten (wie queueContext in queue_admin.go) ------------------------------------------
// vehicleText baut „2 · T10X Weiß · S-TG 101“ aus aktuellem Kürzel und Snapshot ohne Kürzel.
function vehicleText(code, snapshot) {
  if (!code || !snapshot) return snapshot || "";
  const i = snapshot.indexOf(" · ");
  if (i >= 0) return code + " · " + snapshot.slice(i + 3);
  return snapshot === code ? code : code + " · " + snapshot;
}

// Kurzname eines Fahrzeugs ohne Kürzel und Kennzeichen („T10X Weiß“ aus dem Snapshot „1 · T10X Weiß · S-TG 101“)
const shortOf = (snapshot) => String(snapshot || "").split(" · ")[1] || "";

function queueContext(d, cfg) {
  const st = model.queueState(d.queue, d.vehicles, cfg);
  const nowD = new Date();
  const day = model.today(nowD);
  const tracking = !!cfg.tracking_enabled;
  const maxSec = (parseInt(cfg.max_drive_minutes, 10) || 45) * 60;
  const byId = Object.fromEntries(d.vehicles.map((v) => [v.id, v]));
  const view = (e) => {
    let since = e.called_at;
    if (e.status === S.DRIVING) since = e.started_at; else if (!since) since = e.created_at;
    const v = byId[e.vehicle_id];
    const code = v ? v.code : "";
    const elapsed = model.elapsedSince(since, nowD);
    return {
      entry: e, elapsed, links: model.contactLinks(e, cfg), label: model.statusLabel(e.status),
      duration: model.fmtDuration(model.durationSeconds(e)),
      vehicleCode: code, vehicleText: vehicleText(code, e.vehicle), vehicleShort: v ? model.shortLabel(v) : shortOf(e.vehicle),
      late: e.status === S.DRIVING && elapsed > maxSec,
    };
  };
  const byKey = (rows, key) => [...rows].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0));
  const called = byKey(model.byStatus(d.queue, S.CALLED), "called_at").map(view);
  const onRoad = byKey(model.byStatus(d.queue, S.DRIVING), "started_at").map(view);
  const late = onRoad.filter((v) => v.late), driving = onRoad.filter((v) => !v.late);
  const drivesToday = d.queue.filter((e) => e.day === day && e.status === S.DONE);
  const endKey = (e) => e.ended_at || e.created_at;
  const finished = d.queue
    .filter((e) => e.day === day && [S.DONE, S.NO_SHOW, S.CANCELLED].includes(e.status))
    .sort((a, b) => (endKey(a) > endKey(b) ? -1 : endKey(a) < endKey(b) ? 1 : 0)).map(view);
  // je Wartendem die geschätzte Restwartezeit (Minuten bis zum Aufruf, 0 = sofort); gezeigt nur mit show_eta
  const waiting = st.waiting.map((e, i) => ({ ...view(e), eta: cfg.show_eta ? st.eta(i) : 0 }));
  const secs = drivesToday.map(model.durationSeconds).filter((s) => s);
  const infos = model.vehicleStates(d.vehicles, d.queue, d.damages, cfg);
  const freeInfos = model.sortByCode(infos.filter((v) => v.state === model.V.AVAILABLE));
  const hasVehicles = infos.length > 0;
  // Aufruf möglich: ein Fahrzeug (ohne Fahrzeuge: ein Platz laut Einstellung) ist frei und nicht schon für einen Aufgerufenen vorgesehen
  const slots = tracking && hasVehicles ? freeInfos.length : Math.max(0, st.cars - onRoad.length);
  const canCall = waiting.length > 0 && slots - called.length > 0;
  let nextLabel = "Als Nächstes";
  if (canCall && tracking && hasVehicles) {
    const spare = freeInfos.length - called.length;
    nextLabel = (called.length ? `Noch ${spare} ${spare === 1 ? "Fahrzeug" : "Fahrzeuge"} frei`
      : freeInfos.length === 1 ? `Fahrzeug ${freeInfos[0].code} ist frei` : `${freeInfos.length} Fahrzeuge frei`) + " · als Nächstes";
  }
  return {
    waiting, called, driving, late, finished, tracking, hasVehicles, canCall, nextLabel,
    eta: st.eta(waiting.length), done: drivesToday.length,
    avg: secs.length ? Math.round(secs.reduce((a, b) => a + b, 0) / secs.length / 60) : 0,
    vstrip: model.sortByCode(infos), freeCount: model.freeCount(infos), vehicleCount: infos.length,
    startVehicles: model.sortForStart(infos), startChecks: model.startCheckList(cfg), staff: model.staffList(cfg),
    preselect: freeInfos.length === 1 ? freeInfos[0].id : "",
    hasEntries: d.queue.length > 0,
  };
}

// --- Admin: Zustand der Auf-/Zuklapp-Zeilen (sessionStorage; ohne Speicher gilt der Standard) --------
const SS_DONE = "fm_queue_done_open", SS_MORE = "fm_queue_more_open";
const readFlag = (key, dflt) => { try { const v = sessionStorage.getItem(key); return v === null ? dflt : v === "1"; } catch (_) { return dflt; } };
const writeFlag = (key, on) => { try { sessionStorage.setItem(key, on ? "1" : "0"); } catch (_) { /* privater Modus */ } };
const MAX_ROWS = 8;        // ab mehr Wartenden: die ersten acht Einträge, der Rest hinter „Weitere … anzeigen“
const DONE_OPEN_MAX = 5;   // „Heute abgeschlossen“ ist ab mehr Einträgen zunächst zugeklappt
const CHECKS_HREF = "#/admin/einstellungen?zu=checks";

// --- Admin: Markup (Zielbild ui-review.md §5.4) ----------------------------------------------------------
// Aktionen sind Formulare mit data-action/data-id (perform() unten); Sheets öffnen über data-open (Dialog außerhalb der Liste).
const actionForm = (e, name, content, cls, { confirm = "", form = "q-form", label = "" } = {}) =>
  html`<form class="${form}" data-action="${name}" data-id="${e.id}"${confirm ? html` data-confirm="${confirm}"` : ""}><button class="${cls}"${label ? html` aria-label="${label}"` : ""}>${content}</button></form>`;

const contacts = (links) => html`<div class="seg contact-row">
      <a href="${links.tel}">${icon("phone")}Anrufen</a>
      <a href="${links.sms}">${icon("sms")}SMS</a>
      <a href="${links.whatsapp}" target="_blank" rel="noopener">${icon("chat")}WhatsApp</a>
    </div>`;

const moreButton = (e, cls = "btn secondary icon") =>
  html`<button type="button" class="${cls}" data-open="actions" data-id="${e.id}" aria-label="Weitere Aktionen" aria-haspopup="dialog">${icon("more")}</button>`;

// Start: mit Tracking und Fahrzeugen öffnet das Start-Sheet; mit Tracking ohne Fahrzeuge startet es direkt (wie startBlock früher);
// ohne Tracking heißt es „Erledigt“ und schließt direkt. Immer eine flexible Zelle in .q-actions.
function startTrigger(e, q, { primary, label }) {
  const cls = `btn ${primary ? "primary" : "secondary"}`;
  if (q.tracking && q.hasVehicles) return html`<button type="button" class="${cls} grow" data-open="start" data-id="${e.id}" aria-haspopup="dialog">${label}</button>`;
  return html`<form class="q-form grow" data-action="start" data-id="${e.id}"><button class="${cls} block">${q.tracking ? label : html`${icon("check")}Erledigt`}</button></form>`;
}

const secHead = (title, count, { cls = "", aside = "" } = {}) =>
  html`<div class="sec${cls ? " " + cls : ""}"><h2>${title}</h2>${count === "" ? "" : html`<span class="n">${count}</span>`}${aside ? html`<span class="aside">${aside}</span>` : ""}</div>`;

const timeBox = (secs, label, unit = "") =>
  html`<div class="q-time"><strong data-elapsed="${secs}"${unit ? html` data-unit="${unit}"` : ""}>–</strong><small>${label}</small></div>`;

// Fahrzeug-Leiste: nach Kürzel sortiert (stabile Plätze); Tipp: frei → Start-Sheet, unterwegs → zur Karte, gesperrt → Fahrzeug
function vehicleStrip(q) {
  if (!q.tracking || !q.hasVehicles) return "";
  const item = (v) => {
    const top = (status) => html`<span class="t"><b>${v.code}</b>${status}</span><span class="m">${[v.model, v.color].filter(Boolean).join(" ")}</span>`;
    if (v.state === model.V.AVAILABLE) return html`<a class="vitem free" href="#${ADMIN}" data-start-vehicle="${v.id}" data-code="${v.code}">${top(html`<span class="status free">frei</span>`)}</a>`;
    if (v.state === model.V.DRIVING || v.state === model.V.LATE) {
      const status = html`<span class="status ${v.late ? "late icon" : "driving"}">${v.late ? icon("alert") : ""}<span data-elapsed="${v.elapsed}">–</span><span class="sr-only"> ${v.late ? "überfällig" : "unterwegs"}</span></span>`;
      return html`<a class="vitem ${v.late ? "late" : "driving"}" href="#${ADMIN}" data-target="q-${v.entry.id}">${top(status)}</a>`;
    }
    return html`<a class="vitem blocked" href="#/admin/fahrzeuge/${v.id}">${top(html`<span class="status blocked icon">${icon("lock")}<span class="cut">${v.blocked_reason}</span></span>`)}</a>`;
  };
  return html`<p class="vlabel" id="vstrip-label">Fahrzeuge<span class="aside"><b data-count="free">${q.freeCount}</b> von ${q.vehicleCount} frei</span></p>
  <nav class="vstrip" aria-labelledby="vstrip-label">${q.vstrip.map(item)}</nav>`;
}

// Karten: genau eine gefüllte Hauptaktion; alles Weitere sekundär oder im Überlauf-Sheet
const calledCard = (v, q) => html`<article class="card q-card called" id="q-${v.entry.id}">
    <div class="q-top">
      <span class="num called">${v.entry.number}</span>
      <div class="q-who"><h3 class="q-name">${v.entry.name}</h3><p class="q-meta">${v.entry.phone}</p></div>
      ${timeBox(v.elapsed, "aufgerufen")}
    </div>
    <div class="q-actions">
      ${startTrigger(v.entry, q, { primary: true, label: "Fahrt starten" })}
      ${moreButton(v.entry)}
    </div>
    ${contacts(v.links)}
  </article>`;

const roadCard = (v) => {
  const e = v.entry;
  return html`<article class="card q-card driving${v.late ? " late" : ""}" id="q-${e.id}">
    <div class="q-top">
      <span class="num ${v.late ? "late" : "driving"}">${e.number}</span>
      <div class="q-who">
        <h3 class="q-name">${e.name}</h3>
        ${v.vehicleCode ? html`<p class="q-meta">${icon("car")}<span>Fahrzeug ${v.vehicleCode}${v.vehicleShort ? " · " + v.vehicleShort : ""}</span></p>` : ""}
        <p class="q-meta small">Start ${model.deTime(e.started_at)}${e.staff ? ` · Begleiter ${e.staff}` : ""}</p>
      </div>
      ${timeBox(v.elapsed, v.late ? "überfällig" : "unterwegs")}
    </div>
    <div class="q-actions">
      <form class="q-form grow" data-action="end" data-id="${e.id}"><input type="hidden" name="end_condition" value="ok"><button class="btn primary block">${icon("check")}Fahrt beenden</button></form>
      <button type="button" class="btn secondary" data-open="end" data-id="${e.id}" aria-haspopup="dialog">Auffälligkeit</button>
    </div>
    ${v.late ? html`<div class="q-actions"><a class="btn secondary grow wrap" href="${v.links.tel}">${icon("phone")}<span>${e.name} anrufen</span></a></div>` : ""}
  </article>`;
};

// Der Erste in der Schlange: Karte „Als Nächstes“; Aufruf ist die Hauptaktion nur, solange ein Fahrzeug übrig ist
const nextCard = (v, q) => {
  const e = v.entry, call = q.canCall;
  return html`<article class="card q-card${call ? " next" : ""}" id="q-${e.id}">
    <p class="next-label">${q.nextLabel}</p>
    <div class="q-top">
      <span class="num">${e.number}</span>
      <div class="q-who"><h3 class="q-name">${e.name}</h3><p class="q-meta">${e.phone}${v.eta > 0 ? html` · dran in ca. <b data-eta>${v.eta} Min.</b>` : ""}</p></div>
      ${timeBox(v.elapsed, "wartet", "min")}
    </div>
    <div class="q-actions">
      ${actionForm(e, "call", html`${icon("bell")}Nr. ${e.number} aufrufen`, `btn ${call ? "primary" : "secondary"} block`, { form: "q-form grow" })}
      ${moreButton(e)}
    </div>
    ${call ? html`<div class="q-actions">${startTrigger(e, q, { primary: false, label: "Direkt starten" })}</div>` : ""}
  </article>`;
};

// Weitere Wartende: jede Zeile hat ihren eigenen Knopf „Aufrufen“ (beschriftet, sekundär – jede Person ist direkt aufrufbar,
// nicht nur die erste) und den Überlauf (ruhig); die Wartezeit steht fett in der Zeile und tickt mit (data-elapsed, Minuten).
const waitRow = (v) => {
  const e = v.entry;
  return html`<div class="row q-card" id="q-${e.id}">
    <span class="num sm">${e.number}</span>
    <div class="grow"><div class="ttl">${e.name}</div><div class="desc small">${e.phone} · wartet <strong data-elapsed="${v.elapsed}" data-unit="min">–</strong>${v.eta > 0 ? html` · dran in ca. <strong data-eta>${v.eta} Min.</strong>` : ""}</div></div>
    ${actionForm(e, "call", html`${icon("bell")}Aufrufen`, "btn secondary", { label: `Nr. ${e.number} aufrufen` })}
    ${moreButton(e, "btn quiet icon")}
  </div>`;
};

// Abgeschlossene: Zeile → Detail-Sheet
const finishedRow = (v, q) => {
  const e = v.entry;
  const bits = [];
  if (q.tracking && e.started_at) { bits.push(v.duration); if (v.vehicleCode) bits.push(`Fz. ${v.vehicleCode}`); }
  else if (e.ended_at) bits.push(model.deTime(e.ended_at));
  return html`<button type="button" class="row q-card" id="q-${e.id}" data-open="detail" data-id="${e.id}" aria-haspopup="dialog">
    <span class="num sm">${e.number}</span>
    <span class="grow"><span class="ttl">${e.name}</span><span class="desc small"><span class="status ${e.status === S.DONE ? "done" : "wait"}">${v.label}</span>${bits.length ? " · " + bits.join(" · ") : ""}</span></span>
    ${e.end_condition === model.END_CONSPICUOUS ? html`<span class="tag warn" title="${e.end_note}" role="img" aria-label="Auffälligkeit: ${e.end_note}">${icon("alert")}</span>` : ""}
    ${icon("chevR", "chev")}
  </button>`;
};

function waitingSection(q) {
  const w = q.waiting;
  const aside = q.eta > 0 ? `Neue warten ca. ${q.eta} Min.` : "Neue kommen sofort dran";
  const shown = w.length > MAX_ROWS ? w.slice(0, MAX_ROWS) : w, rest = w.length > MAX_ROWS ? w.slice(MAX_ROWS) : [];
  const moreOpen = readFlag(SS_MORE, false);
  return html`<section class="q-sec" data-section="waiting">
    ${secHead("Wartend", w.length, { aside })}
    ${w.length ? html`${nextCard(w[0], q)}
    ${shown.length > 1 ? html`<div class="list">${shown.slice(1).map(waitRow)}</div>` : ""}
    ${rest.length ? html`<button type="button" class="disclosure" data-toggle="more" data-n="${rest.length}" aria-expanded="${moreOpen ? "true" : "false"}" aria-controls="q-more"><span class="dl">${moreOpen ? "Weniger anzeigen" : `Weitere ${rest.length} anzeigen`}</span>${icon("chevD")}</button>
    <div class="list" id="q-more"${moreOpen ? "" : html` hidden`}>${rest.map(waitRow)}</div>` : ""}`
      : html`<div class="card"><div class="empty compact"><h3>Niemand wartet</h3><p>Neue Anmeldungen erscheinen hier.</p></div></div>`}
  </section>`;
}

function doneSection(q) {
  if (!q.finished.length) return "";
  const open = readFlag(SS_DONE, q.finished.length <= DONE_OPEN_MAX);
  return html`<section class="q-done" data-section="finished">
    <button type="button" class="disclosure" data-toggle="done" aria-expanded="${open ? "true" : "false"}" aria-controls="q-done-body">Heute abgeschlossen <span class="n">${q.finished.length}</span>${icon("chevD")}</button>
    <div id="q-done-body"${open ? "" : html` hidden`}>
      <p class="q-balance"><b data-count="done">${q.done}</b> erledigt${q.tracking && q.avg ? ` · Ø Fahrzeit ${q.avg} Min.` : ""}</p>
      <div class="list">${q.finished.map((v) => finishedRow(v, q))}</div>
    </div>
  </section>`;
}

// Fuß: Export (Sheet) und Tagesabschluss (rot, mit Rückfrage); Tagesabschluss nur, solange Wartende/Aufgerufene da sind
const footSection = (q) => (!q.hasEntries ? "" : html`<div class="q-foot">
    <button type="button" class="btn secondary block" data-open="export" aria-haspopup="dialog">${icon("download")}Exportieren …</button>
    ${q.waiting.length + q.called.length ? html`<form class="card day-close" data-action="clear" data-confirm="Alle Wartenden und Aufgerufenen als „abgesagt“ markieren?">
      <div class="grow"><b>Tagesabschluss</b><p>Markiert Wartende und Aufgerufene als abgesagt.</p></div>
      <button class="btn danger">Leeren …</button>
    </form>` : ""}
  </div>`);

function queueList(q, cfg) {
  const idle = !q.waiting.length && !q.called.length && !q.driving.length && !q.late.length && !q.finished.length;
  const toTablet = "#/formular";
  const head = html`<div class="page-head"><h1 class="title">Warteschlange</h1>${idle ? "" : html`<div class="actions"><a class="btn secondary has-lbl" href="${toTablet}" aria-label="Tablet weitergeben – Admin wird gesperrt" title="Tablet weitergeben – Admin wird gesperrt">${icon("tablet")}<span class="lbl">Tablet weitergeben</span></a></div>`}</div>
  <p class="sub summary"><b data-count="waiting">${q.waiting.length}</b> wartend · <b data-count="called">${q.called.length}</b> aufgerufen${q.tracking ? html` · <b data-count="driving">${q.driving.length + q.late.length}</b> unterwegs` : ""}</p>`;
  if (idle) {
    return html`${head}<div class="card"><div class="empty">${icon("list")}<h3>Niemand wartet</h3><p>Gib das Tablet an Kunden weiter, damit sie sich für eine Probefahrt eintragen.</p><a class="btn primary" href="${toTablet}">${icon("tablet")}Tablet weitergeben</a></div></div>
    ${footSection(q)}`;
  }
  const strip = vehicleStrip(q);
  const section = (key, title, rows, cls = "") => (rows.length ? html`<section class="q-sec" data-section="${key}">
      ${secHead(title, rows.length, { cls })}
      <div class="cards">${rows.map((v) => (key === "called" ? calledCard(v, q) : roadCard(v)))}</div>
    </section>` : "");
  const colA = html`${strip}${section("late", "Überfällig", q.late, "alert")}${section("called", "Aufgerufen", q.called)}${section("driving", "Unterwegs", q.driving)}`;
  const hasA = !!(String(strip) || q.late.length || q.called.length || q.driving.length);
  return html`${head}<div class="cols${hasA ? "" : " solo"}">
    ${hasA ? html`<div class="col-a">${colA}</div>` : ""}
    <div class="col-b">${waitingSection(q)}${doneSection(q)}${footSection(q)}</div>
  </div>`;
}

// --- Admin: Sheets (ein <dialog class="sheet"> außerhalb der Liste, Inhalt je nach Auslöser data-open) ----------------
// Kopf (Titel + Unterzeile + Schließen) · Inhalt (scrollt) · Fuß mit festem Button. Fehler stehen als Banner im Sheet (.sheet-err).
const sheetHead = (title, sub) => html`<div class="sheet-h"><h2 id="sheet-title">${title}${sub ? html`<small>${sub}</small>` : ""}</h2><button type="button" class="btn quiet icon" data-close aria-label="Schließen">${icon("x")}</button></div>`;
const errBox = html`<div class="sheet-err" role="alert"></div>`;

// Zeilen im Aktions-/Detail-Sheet (56 px, Symbol links, Text 17/600); Formular-Zeilen laufen über perform()
const rowForm = (e, action, icn, text, { confirm = "", cls = "" } = {}) =>
  html`<form data-action="${action}" data-id="${e.id}"${confirm ? html` data-confirm="${confirm}"` : ""}><button class="row${cls ? " " + cls : ""}">${icon(icn)}<span class="grow ttl">${text}</span></button></form>`;
const rowLink = (icn, text, href, external = false) =>
  html`<a class="row" href="${href}"${external ? html` target="_blank" rel="noopener"` : ""}>${icon(icn)}<span class="grow ttl">${text}</span></a>`;
const rowStart = (e, q) => (q.tracking && q.hasVehicles
  ? html`<button type="button" class="row" data-open="start" data-id="${e.id}">${icon("car")}<span class="grow ttl">Fahrt direkt starten …</span></button>`
  : rowForm(e, "start", q.tracking ? "car" : "check", q.tracking ? "Fahrt direkt starten" : "Erledigt"));

// Fahrzeugwahl im Start-Sheet: Radio-Zeile; nicht frei (unterwegs, gesperrt) gestrichelt mit Grund – die Rückfrage (Übernahme/Sperre) kommt beim Wählen
function vehicleChoice(v, pre) {
  const avail = v.state === model.V.AVAILABLE;
  let sub;
  if (v.state === model.V.DRIVING || v.state === model.V.LATE) sub = `unterwegs · Nr. ${v.entry.number} · seit ${model.deTime(v.entry.started_at)}${v.late ? " · überfällig" : ""}${v.blocked_after ? " · danach gesperrt" : ""}`;
  else if (v.state === model.V.BLOCKED) sub = `gesperrt: ${v.blocked_reason}`;
  else sub = [v.plate, v.sub].filter(Boolean).join(" · ");
  return html`<label class="choice option ${v.state}" data-known="${v.known}">
      <input type="radio" name="vehicle_id" value="${v.id}" data-code="${v.code}"${avail ? "" : html` data-state="${v.state}" data-msg="${v.msg}" data-number="${v.entry ? v.entry.number : ""}"`}${pre === v.id ? " checked" : ""}>
      <span class="box"></span>
      <span class="grow"><span class="ttl"><b>${v.code}</b> · ${[v.model, v.color].filter(Boolean).join(" ")}</span>${sub ? html`<span class="desc">${v.state === model.V.BLOCKED ? icon("lock") : ""}${sub}</span>` : ""}</span>
    </label>`;
}

function startSheet(e, q, vehicleId) {
  let saved = "";
  try { saved = localStorage.getItem("staff") || ""; } catch (_) { /* ohne Speicher keine Vorauswahl */ }
  const pre = vehicleId || q.preselect;
  return html`<form class="start-sheet" data-action="start" data-id="${e.id}">
    ${sheetHead("Fahrt starten", `Nr. ${e.number} · ${e.name}`)}
    <div class="sheet-b">
      ${errBox}
      <p class="group-lbl">Fahrzeug</p>
      <div class="choices">${q.startVehicles.map((v) => vehicleChoice(v, pre))}</div>
      <p class="known" hidden>${icon("alert")}<span><b>Bekannt:</b> <span class="known-text"></span></span></p>
      ${q.startChecks.length ? html`<div class="group-head"><p class="group-lbl">Vor der Fahrt geprüft</p><a class="btn quiet sm" href="${CHECKS_HREF}" data-checks-link>Prüfliste anpassen</a></div>
      <div class="choices">${q.startChecks.map((c) => html`<label class="choice option check"><input type="checkbox" name="checks" value="${c}"><span class="box"></span><span class="grow"><span class="ttl">${c}</span></span></label>`)}</div>`
        : html`<p class="hint no-checks">Keine Prüfungen eingerichtet – <a class="btn quiet sm" href="${CHECKS_HREF}" data-checks-link>Prüfliste anlegen</a></p>`}
      ${q.staff.length ? html`<p class="group-lbl">Begleiter</p>
      <div class="seg pick">${q.staff.map((s) => html`<label><input type="radio" name="staff" value="${s}"${s === saved ? " checked" : ""}>${s}</label>`)}</div>` : ""}
    </div>
    <div class="sheet-f"><p class="why">&nbsp;</p><button class="btn primary lg block wide" disabled>Fahrt starten</button></div>
  </form>`;
}

function endSheet(v) {
  const e = v.entry, code = v.vehicleCode;
  return html`<form class="end-sheet" data-action="end" data-id="${e.id}">
    ${sheetHead("Auffälligkeit melden", `Nr. ${e.number} · ${e.name}${code ? ` · Fahrzeug ${code}` : ""}`)}
    <div class="sheet-b">
      ${errBox}
      <input type="hidden" name="end_condition" value="auffaellig">
      <label class="field"><span class="lbl">Was ist aufgefallen?</span>
        <textarea name="end_note" rows="3" required maxlength="300" placeholder="Kratzer Felge vorne rechts …"></textarea>
        <span class="hint">${e.vehicle_id ? "Wird als Schaden am Fahrzeug gespeichert." : "Wird bei der Fahrt vermerkt."}</span>
      </label>
      ${e.vehicle_id ? html`<label class="setrow sheet-switch"><span class="grow"><span class="ttl">Fahrzeug sperren</span><span class="desc">${code ? `Fahrzeug ${code} bleibt` : "Das Fahrzeug bleibt"} gesperrt, bis es freigegeben wird.</span></span><input type="checkbox" name="block_vehicle" value="1" checked><span class="sw"></span></label>` : ""}
    </div>
    <div class="sheet-f"><button class="btn primary lg block">${e.vehicle_id ? "Beenden & Schaden speichern" : "Beenden & Bemerkung speichern"}</button></div>
  </form>`;
}

function actionsSheet(v, q) {
  const e = v.entry, links = v.links;
  const first = q.waiting.length > 0 && q.waiting[0].entry.id === e.id;   // die Karte „Als Nächstes“ hat Aufrufen (und bei freiem Fahrzeug Direkt starten) schon vorn
  const rows = e.status === S.CALLED
    ? [rowForm(e, "call", "bell", "Erneut aufrufen"), rowForm(e, "requeue", "undo", "Zurück in die Schlange"),
      rowForm(e, "noshow", "x", "Nicht erschienen", { confirm: `Nr. ${e.number} als „nicht erschienen“ markieren?` })]
    : [...(first ? [] : [rowForm(e, "call", "bell", "Aufrufen")]), ...(first && q.canCall ? [] : [rowStart(e, q)]),
      rowLink("phone", "Anrufen", links.tel), rowLink("sms", "SMS senden", links.sms), rowLink("chat", "WhatsApp", links.whatsapp, true),
      rowForm(e, "delete", "trash", "Löschen", { confirm: `Nr. ${e.number} (${e.name}) löschen?`, cls: "danger" })];
  const sub = e.status === S.CALLED ? `${e.phone} · aufgerufen vor ${model.fmtDuration(v.elapsed)}` : `${e.phone} · wartet ${waitText(v.elapsed)}`;
  return html`${sheetHead(`Nr. ${e.number} · ${e.name}`, sub)}<div class="sheet-b flush">${errBox}<div class="sheet-rows">${rows}</div></div>`;
}

function exportSheet(d) {
  const n = d.queue.length;
  return html`${sheetHead("Exportieren", `${n} ${n === 1 ? "Eintrag" : "Einträge"}, alle Tage`)}
    <div class="sheet-b flush">${errBox}<div class="sheet-rows">
      <a class="row" href="#${ADMIN}" data-export="xlsx">${icon("download")}<span class="grow ttl">Excel (.xlsx)</span></a>
      <a class="row" href="#${ADMIN}" data-export="csv">${icon("download")}<span class="grow ttl">CSV</span></a>
    </div></div>`;
}

// Abgeschlossener Eintrag: Zeiten, Fahrzeug, Begleiter, Bemerkung – dazu Wieder einreihen / Fahrt fortsetzen / Löschen
function detailSheet(v, q) {
  const e = v.entry, started = !!e.started_at;
  const facts = [
    ["Telefon", e.phone], ["E-Mail", e.email], ["Angemeldet", model.deTime(e.created_at)], ["Aufgerufen", model.deTime(e.called_at)],
    ["Start", model.deTime(e.started_at)], [started ? "Ende" : "Abgeschlossen", model.deTime(e.ended_at)],
    ["Dauer", started && e.ended_at ? v.duration : ""], ["Fahrzeug", v.vehicleText], ["Begleiter", e.staff],
    ["Bemerkung", e.end_condition === model.END_CONSPICUOUS ? e.end_note : ""],
  ].filter(([, val]) => val);
  const rows = [
    ...(e.status === S.NO_SHOW || e.status === S.CANCELLED ? [rowForm(e, "requeue", "undo", "Wieder einreihen")] : []),
    ...(e.status === S.DONE && started && q.tracking ? [rowForm(e, "reopen", "car", "Fahrt fortsetzen")] : []),
    rowForm(e, "delete", "trash", "Löschen", { confirm: `Eintrag Nr. ${e.number} löschen?`, cls: "danger" }),
  ];
  return html`${sheetHead(`Nr. ${e.number} · ${e.name}`, v.label)}
    <div class="sheet-b">${errBox}
      <dl class="q-kv">${facts.map(([k, val]) => html`<dt>${k}</dt><dd>${val}</dd>`)}</dl>
      <div class="list sheet-rows">${rows}</div>
    </div>`;
}

// --- Admin: Export (Spalten wie queueExportRows, SPEZIFIKATION A7) ------------------------------
const EXPORT_HEADER = ["Datum", "Nr.", "Name", "Telefon", "E-Mail", "Status", "Angemeldet", "Aufgerufen", "Fahrt Start", "Fahrt Ende",
  "Dauer", "Fahrzeug", "Kennzeichen", "Prüfungen", "Begleiter", "Zustand Ende", "Bemerkung", "Kanal", "Notiz", "Einwilligung (Version)"];
function exportRows(d) {
  const plates = Object.fromEntries(d.vehicles.map((v) => [v.id, v.plate || ""]));
  return model.sortQueue(d.queue).map((e) => {
    const dur = model.durationSeconds(e);
    const condition = e.end_condition === model.END_OK ? "in Ordnung" : e.end_condition === model.END_CONSPICUOUS ? "Auffälligkeit" : "";
    return [
      model.deDay(e.day), /^\d+$/.test(e.number) ? parseInt(e.number, 10) : safeCell(e.number),
      safeCell(e.name), safeCell(e.phone), safeCell(e.email), model.statusLabel(e.status),
      model.deTime(e.created_at), model.deTime(e.called_at), model.deTime(e.started_at), e.started_at ? model.deTime(e.ended_at) : "",
      dur === null ? "" : model.fmtDuration(dur), safeCell(e.vehicle), safeCell(plates[e.vehicle_id] || ""),
      safeCell(model.splitPipe(e.checks).join(", ")), safeCell(e.staff), condition, safeCell(e.end_note), e.source || "",
      safeCell(e.note), e.consent_ref || "",
    ];
  });
}

// --- Admin: Screen ------------------------------------------------------------------------------
function adminScreen({ query, el }) {
  const ac = new AbortController();
  const listen = delegate(el, ac.signal);
  let renderedAt = Date.now();
  let dirty = false;       // Datenänderung liegt vor, Neu-Rendern wurde wegen offenem Sheet/Fokus verschoben
  let lateSig = "";        // welche Fahrten überfällig sind – ändert sich mit der Uhr, nicht mit den Daten
  let shellSig = "";       // Rahmen (Tabs, Marke, Hinweise) beim letzten vollen Zeichnen
  let listSig = "";        // zuletzt gezeichnete Liste ohne Laufzeiten: unverändert → nichts neu zeichnen
  let sheetGen = 0;        // zählt Sheet-Öffnungen: das späte „close“ eines älteren Sheets räumt ein neueres nicht ab
  let sheetOpener = null;  // Auslöser in der Liste, zu dem der Fokus nach dem Schließen zurückkehrt (auch bei Sheet → Sheet)
  const stable = (markup) => String(markup).replace(/data-elapsed="\d+"/g, 'data-elapsed=""');

  const lateSignature = () => {
    const maxSec = (parseInt(store.settings.max_drive_minutes, 10) || 45) * 60;
    return store.data.queue.filter((e) => e.status === S.DRIVING && model.elapsedSince(e.started_at) > maxSec).map((e) => e.id).join(",");
  };
  // Der Dialog hängt hinter der Liste (nicht darin): Neu-Rendern der Liste zerstört ein offenes Sheet nie
  const content = () => {
    const cfg = store.settings;
    const list = queueList(queueContext(store.data, cfg), cfg);
    listSig = stable(list);
    return html`
  ${!cfg.module_queue ? html`<p class="banner info">${icon("info")}<span>Die Warteschlange ist in den Einstellungen deaktiviert – Kunden können sich nicht anmelden. <a href="#/admin/einstellungen">Einstellungen</a></span></p>` : ""}
  <div id="queue-list">${list}</div>
  <dialog class="sheet" id="queue-sheet" aria-labelledby="sheet-title"></dialog>`;
  };

  // --- Laufzeiten: nur Text, kein Neu-Rendern -----------------------------------------------------
  const tick = () => {
    const extra = (Date.now() - renderedAt) / 1000;
    for (const x of $$("[data-elapsed]", el)) {
      const sec = Number(x.dataset.elapsed) + extra;
      x.textContent = x.dataset.unit === "min" ? waitText(sec) : model.fmtDuration(sec);   // Wartende: „34 Min.“, sonst „12:12“ (F7)
    }
    const sig = lateSignature();
    if (sig !== lateSig) { lateSig = sig; redraw(false); }
  };

  // --- Sheets ------------------------------------------------------------------------------------------
  const sheet = () => $("#queue-sheet", el);
  const closeSheet = () => new Promise((resolve) => {
    const dlg = sheet();
    if (!dlg || !dlg.open) { resolve(); return; }
    dlg.addEventListener("close", () => resolve(), { once: true });   // nach dem „close“ von openSheet (Fokus, Aufräumen)
    dlg.close();
  });
  const sheetError = (form, text) => {
    const box = form.closest("dialog").querySelector(".sheet-err");
    if (!box) { flash(text, "error"); return; }
    render(box, html`<p class="banner error">${icon("alert")}<span>${text}</span></p>`);
    box.scrollIntoView({ block: "nearest" });
  };
  // Start-Sheet: Button erst mit Fahrzeug und allen Prüfungen; die Zeile darüber nennt, was noch offen ist
  const setHidden = (form, name, value) => {
    let input = form.querySelector(`input[type="hidden"][name="${name}"]`);
    if (!value) { if (input) input.remove(); return; }
    if (!input) { input = document.createElement("input"); input.type = "hidden"; input.name = name; form.appendChild(input); }
    input.value = value;
  };
  const updateStart = (form) => {
    const btn = form.querySelector("button.wide"), why = form.querySelector(".why");
    const vehicle = form.querySelector('input[name="vehicle_id"]:checked');
    const open = [];
    if (!vehicle) open.push("Fahrzeug wählen");
    for (const c of form.querySelectorAll('input[name="checks"]')) if (!c.checked) open.push(c.value);
    if (btn) btn.disabled = open.length > 0;
    if (why) { why.textContent = open.length ? `Noch offen: ${open.join(" · ")}` : " "; why.classList.toggle("done", !open.length); }   // Platz bleibt, damit nichts springt
    const known = form.querySelector(".known");
    if (known) {
      const text = vehicle ? vehicle.closest("label").dataset.known || "" : "";
      known.querySelector(".known-text").textContent = text;
      known.hidden = !text;
    }
  };
  async function openQueueSheet(kind, id, opener, vehicle = "") {
    const dlg = sheet();
    if (!dlg) return;
    if (dlg.open) await closeSheet();                       // Sheet → Sheet (z. B. Aktionen → Fahrt direkt starten)
    const d = store.data, q = queueContext(d, store.settings);
    const v = [...q.late, ...q.called, ...q.driving, ...q.waiting, ...q.finished].find((x) => x.entry.id === id);
    let markup;
    if (kind === "export") markup = exportSheet(d);
    else if (!v) { flash("Eintrag nicht gefunden.", "error"); return; }
    else if (kind === "start") markup = startSheet(v.entry, q, vehicle);
    else if (kind === "end") markup = endSheet(v);
    else if (kind === "actions") markup = actionsSheet(v, q);
    else if (kind === "detail") markup = detailSheet(v, q);
    else return;
    render(dlg, markup);
    const form = dlg.querySelector("form.start-sheet");
    if (form) updateStart(form);
    sheetOpener = opener;
    const od = (opener && opener.dataset) || {};
    const again = od.open ? `[data-open="${od.open}"][data-id="${od.id}"]` : od.startVehicle ? `a.vitem[data-start-vehicle="${od.startVehicle}"]` : "";   // derselbe Auslöser nach einem Neu-Rendern
    const gen = ++sheetGen;
    openSheet(dlg, { opener }).then(() => {
      if (gen !== sheetGen) return;
      dlg.replaceChildren();
      if (dirty) redraw(false);                              // Änderungen anderer Geräte, die während des Sheets eintrafen
      if (opener && !opener.isConnected && again) { const next = $(again, el); if (next) next.focus({ preventScroll: true }); }   // Fokus zurück, auch wenn die Liste inzwischen neu gezeichnet wurde
    });
  }

  // --- Rendern ---------------------------------------------------------------------------------------
  const busy = () => {
    if ($("dialog[open]", el)) return true;                 // offenes Sheet: Liste pausiert
    const list = $("#queue-list", el);
    if (!list) return false;
    const a = document.activeElement;
    return !!a && list.contains(a) && ["SELECT", "INPUT", "TEXTAREA"].includes(a.tagName);
  };
  const draw = () => {   // ganze Seite: beim Öffnen und wenn sich der Rahmen ändert (Tabs, Marke, Hinweise)
    const y = window.scrollY;
    render(el, adminShell("queue", content(), { title: "Warteschlange", wide: true }));
    window.scrollTo(0, y);
    shellSig = shellKey();
    renderedAt = Date.now();
    lateSig = lateSignature();
    tick();
  };
  // Selektor des fokussierten Bedienelements in der Liste (Auslöser, Aktionsknopf, Auf-/Zuklapp-Zeile, Fahrzeug), damit der Fokus ein Neu-Rendern überlebt
  const focusKey = () => {
    const a = document.activeElement, list = $("#queue-list", el);
    if (!a || !a.dataset || !list || !list.contains(a)) return "";
    if (a.dataset.open) return `[data-open="${a.dataset.open}"][data-id="${a.dataset.id}"]`;
    if (a.dataset.toggle) return `[data-toggle="${a.dataset.toggle}"]`;
    if (a.dataset.startVehicle) return `a.vitem[data-start-vehicle="${a.dataset.startVehicle}"]`;
    const form = a.closest("form[data-action]");
    return form && form.dataset.id && a.tagName === "BUTTON" ? `form[data-action="${form.dataset.action}"][data-id="${form.dataset.id}"] button` : "";
  };
  // Nur die Liste erneuern: Leiste, Tabs, offenes Sheet und Scroll-Position bleiben unberührt (auch bei Änderungen anderer Geräte)
  const drawList = () => {
    const list = queueList(queueContext(store.data, store.settings), store.settings);
    const sig = stable(list);
    if (sig === listSig) return;   // nichts Sichtbares hat sich geändert
    listSig = sig;
    const y = window.scrollY, again = focusKey();
    render($("#queue-list", el), list);
    window.scrollTo(0, y);
    if (again) { const next = $(again, el); if (next) next.focus({ preventScroll: true }); }   // Tastatur: der Fokus bleibt am selben Knopf
    renderedAt = Date.now();
    lateSig = lateSignature();
    tick();
  };
  // Neu-Rendern bei Datenänderung – nicht, solange ein Sheet offen ist oder ein Feld Fokus hat (dann später).
  function redraw(force) {
    if (!force && busy()) { dirty = true; return; }
    dirty = false;
    if (shellKey() !== shellSig || !$("#queue-list", el)) draw(); else drawList();
  }
  draw();
  const unsub = store.subscribe((_, info) => { if (!(info && info.hub)) redraw(false); });   // Hub-Zustand allein ändert die Liste nicht
  const timer = setInterval(tick, 1000);
  if (query.q) { const card = document.getElementById("q-" + query.q); if (card) card.scrollIntoView({ block: "center" }); }

  // Feld verlassen: aufgeschobenes Rendern nachholen (das Schließen eines Sheets erledigt openQueueSheet)
  el.addEventListener("focusout", () => { if (dirty) setTimeout(() => { if (dirty) redraw(false); }, 50); }, { signal: ac.signal });

  // --- Aktionen (A5, B4, B5) -------------------------------------------------------------------------
  const perform = (action, id, form) => {
    switch (action) {
      case "call": return store.update((d) => actions.callEntry(d, id));
      case "start": {
        const f = formData(form);
        return store.update((d) => actions.startDrive(d, d.settings, id, {
          vehicle_id: f.vehicle_id || "", checks: formList(form, "checks"), staff: f.staff || "",
          takeover: f.takeover === "1", force: f.force === "1",
        }));
      }
      case "end": {
        const f = formData(form);
        return store.update((d) => actions.endDrive(d, id, { end_condition: f.end_condition || model.END_OK, end_note: f.end_note || "", block_vehicle: f.block_vehicle === "1" }));
      }
      case "noshow": return store.update((d) => actions.noShow(d, id));
      case "requeue": return store.update((d) => actions.requeue(d, id));
      case "reopen": return store.update((d) => actions.reopen(d, id));
      case "delete": return store.update((d) => actions.deleteEntry(d, id));
      case "clear": return store.update((d) => actions.clearDay(d));
      default: return Promise.resolve({ error: "Unbekannte Aktion." });
    }
  };
  const callNext = async (id) => {
    const r = await store.update((d) => actions.callEntry(d, id));
    if (r.error) flash(r.error, "error");
  };
  listen("submit", "form[data-action]", async (ev, form) => {
    ev.preventDefault();
    if (form.dataset.pending) return;                        // Doppeltipp: nur eine Anfrage je Formular
    if (form.dataset.confirm && !ask(form.dataset.confirm)) return;
    const action = form.dataset.action, inSheet = !!form.closest("dialog");
    if (inSheet) { const box = form.closest("dialog").querySelector(".sheet-err"); if (box) box.replaceChildren(); }
    form.dataset.pending = "1";
    let r;
    try { r = await perform(action, form.dataset.id, form); } finally { delete form.dataset.pending; }
    if (r.error) { if (inSheet) sheetError(form, r.error); else flash(r.error, "error"); return; }   // Sheet bleibt stehen, Fehler als Banner darin
    if (inSheet) closeSheet();
    if (action === "end" && r.hint) {
      const next = r.next_id ? model.findById(store.data.queue, r.next_id) : null;
      const base = r.hint.replace(/ · Nächster: .*$/, "");   // „Fahrzeug 1 ist frei“ – den Nächsten nennt die Aktion im Toast
      flash(base === "Fahrt beendet" ? base : `Fahrt beendet · ${base}`, "success", next ? { button: { label: `Nr. ${next.number} aufrufen`, onClick: () => callNext(next.id) } } : {});
    } else if (action === "clear") {
      flash(r.count ? `Warteschlange geleert – ${r.count} ${r.count === 1 ? "Eintrag" : "Einträge"} abgesagt.` : "Die Warteschlange war schon leer.");
    }
    if (dirty) redraw(true);   // erfolgreich → Liste sofort aktuell, auch wenn das Sheet offen war
  });

  listen("click", "[data-open]", (ev, btn) => {
    ev.preventDefault();
    openQueueSheet(btn.dataset.open, btn.dataset.id, btn.closest("dialog") ? sheetOpener : btn);
  });
  listen("click", "[data-close]", () => { closeSheet(); });
  listen("click", ".sheet-rows a.row, [data-checks-link]", () => { closeSheet(); });   // Anrufen/SMS/WhatsApp übernimmt das System; die Links zu den Einstellungen navigieren selbst

  // Start-Sheet: Fahrzeug wählen → Rückfrage bei „unterwegs“ (Übernahme) und „gesperrt“ (Sperre aufheben), B3
  listen("change", "form.start-sheet input", (ev, input) => {
    const form = input.closest("form");
    if (input.name === "vehicle_id") {
      setHidden(form, "takeover", ""); setHidden(form, "force", "");
      const state = input.dataset.state;
      if (state === model.V.DRIVING || state === model.V.LATE) {
        // „Fahrzeug 2 ist noch unterwegs (Nr. 14). Fahrt Nr. 14 jetzt beenden und Fahrzeug 2 nehmen?“ (B3)
        if (ask(`${input.dataset.msg} Fahrt Nr. ${input.dataset.number} jetzt beenden und Fahrzeug ${input.dataset.code} nehmen?`)) setHidden(form, "takeover", "1");
        else input.checked = false;
      } else if (state === model.V.BLOCKED) {
        if (ask(`${input.dataset.msg} Trotzdem starten? Die Sperre wird aufgehoben.`)) setHidden(form, "force", "1");
        else input.checked = false;
      }
    } else if (input.name === "staff") {
      try { localStorage.setItem("staff", input.value); } catch (_) {}
    }
    updateStart(form);
  });

  // Auf-/Zuklapp-Zeilen: „Heute abgeschlossen“ und „Weitere … anzeigen“ (Zustand in sessionStorage, kein Neu-Rendern)
  listen("click", "[data-toggle]", (ev, btn) => {
    const open = btn.getAttribute("aria-expanded") !== "true";
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    const body = document.getElementById(btn.getAttribute("aria-controls"));
    if (body) body.hidden = !open;
    if (btn.dataset.toggle === "more") {
      writeFlag(SS_MORE, open);
      const label = btn.querySelector(".dl");
      if (label) label.textContent = open ? "Weniger anzeigen" : `Weitere ${btn.dataset.n} anzeigen`;
    } else writeFlag(SS_DONE, open);
  });

  // --- Fahrzeug-Leiste (B2) -------------------------------------------------------------------------
  listen("click", "a.vitem[data-start-vehicle]", (ev, a) => {
    ev.preventDefault();
    const q = queueContext(store.data, store.settings);
    const target = q.called[0] || q.waiting[0];              // zuerst der am längsten Aufgerufene, sonst der Erste in der Schlange
    if (!target) { flash(`Niemand wartet – Fahrzeug ${a.dataset.code} ist frei.`, ""); return; }
    openQueueSheet("start", target.entry.id, a, a.dataset.startVehicle);
  });
  listen("click", "a.vitem[data-target]", (ev, a) => {
    ev.preventDefault();
    const card = document.getElementById(a.dataset.target);
    if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  // --- Export ----------------------------------------------------------------------------------------
  listen("click", "a[data-export]", (ev, a) => {
    ev.preventDefault();
    const rows = exportRows(store.data);
    if (a.dataset.export === "xlsx") downloadXLSX("probefahrten", [{ title: "Probefahrten", header: EXPORT_HEADER, rows }], store.settings.accent_color);
    else downloadCSV("probefahrten", EXPORT_HEADER, rows);
    closeSheet();
  });

  return () => { unsub(); clearInterval(timer); ac.abort(); };
}

register("/admin/warteschlange", adminScreen, { admin: true, bodyClass: "admin" });
