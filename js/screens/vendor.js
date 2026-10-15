// Anbieter-Bereich (#/anbieter): hier erzeugt der Anbieter der App den Aktivierungscode (codes.js) für ein Gerät eines Kunden und merkt sich, was er ausgegeben hat.
// Der Bereich ist in jeder Kopie der App versteckt (kein Link, keine Kachel) und nur über die Adresse erreichbar; ein Zugangscode (VENDOR_PIN in codes.js)
// schützt ihn – er hält Neugierige fern, nicht Entwickler (der Quelltext ist öffentlich). Entsperrt gilt für die Browser-Sitzung (sessionStorage "fm_vendor").
// Der Bereich läuft auch ohne Lizenz (der Router lässt ihn durch).
//
// Zwei Seiten, beide nur für den Anbieter allein:
//  • #/anbieter – ein kleines Start-Dashboard, möglichst ohne Scrollen: oben drei große Knöpfe („Code erzeugen“ springt zum Formular auf derselben Seite,
//    „Kundenliste“ öffnet #/anbieter/kunden, „CSV exportieren“ lädt die Liste), darunter die Karte „Code für ein Gerät“ (Kundennummer – Vorschlag: höchste
//    gemerkte + 1 –, optional der Kundenname, Gerätekennung), die Karte „Links“ (App und Anleitung zum Kopieren) und „Zuletzt erzeugt“ (die letzten fünf).
//  • #/anbieter/kunden – die ganze Liste, nach Kunden gruppiert (Nr., Name; darunter je Gerät Gerätekennung, Code, erstellt, „Kopieren“, „Löschen“), mit Suche,
//    „CSV exportieren“ und dem Weg zurück zum Dashboard.
// Ein Code gilt nur für EIN Gerät: dieselbe Kundennummer mit einer anderen Gerätekennung ergibt einen anderen Code und eine eigene Zeile. Dieselbe Kombination
// ergibt immer denselben Code (kein Zufall, kein Datum) – „Code anzeigen“ legt dann keine zweite Zeile an.
// Die Liste liegt ausschließlich in localStorage dieses Browsers ("fm_vendor_customers", eine Zeile je Gerät: { number, name, device, code, created_at }), NIE im
// Datenspeicher der App (store.js): der würde im Hub-Betrieb an die Geräte der Kunden weitergegeben. Der Code ergibt sich aus Nummer und Kennung und wird beim Lesen neu
// gerechnet (nach einem Wechsel von VENDOR_SECRET zeigt die Liste also gleich die neuen Codes). Ein Code lässt sich nicht widerrufen (ohne Server geht das nicht):
// „Löschen“ entfernt nur den Eintrag in dieser Liste, der Code bleibt auf dem Gerät bis LICENSE_END gültig.
import { register } from "../router.js";
import { html, raw, esc, render, logo, on, $, flash, ask, formatCodeField, copyText } from "../ui.js";
import { icon } from "../icons.js";
import { store } from "../store.js";
import { now, deDay, deDate, cut } from "../model.js";
import { downloadCSV, safeCell } from "../export.js";
import { VENDOR_PIN, LICENSE_END, MAX_CUSTOMER, APP_URL, makeCode, formatDeviceId, normalizeDeviceId } from "../codes.js";

const LIST_KEY = "fm_vendor_customers";   // localStorage: [{ number, name, device, code, created_at }] – eine Zeile je Gerät
const OPEN_KEY = "fm_vendor";             // sessionStorage: "1" = entsperrt
const MAX_NAME = 80;
const RECENT = 5;                         // „Zuletzt erzeugt“ zeigt so viele Zeilen
const GUIDE_URL = APP_URL + "anleitung/";
const DOWNLOAD_URL = "https://github.com/abduyild/fleetmanager-app/releases/latest";   // Programm für den Stand-Laptop (Release im öffentlichen App-Repo)
const DEVICE_EMPTY = "Bitte die Gerätekennung eingeben, zum Beispiel ABCD-EFGH.";
const DEVICE_BAD = "Die Gerätekennung besteht aus 8 Zeichen, zum Beispiel ABCD-EFGH (nur Buchstaben und Ziffern, ohne 0, 1, I und O).";

// --- Speicher: localStorage -----------------------------------------------------------------------------------------------------------
// Ein Eintrag aus dem Speicher: Kundennummer und Gerätekennung sind die Wahrheit, der Code ergibt sich aus beiden und wird NEU gerechnet (so zeigt die Liste nach
// einem Wechsel von VENDOR_SECRET die neuen Codes statt veralteter), der Name ist Beschriftung. null = unbrauchbar – auch Einträge aus der Zeit vor der Gerätebindung
// (ohne Gerätekennung).
function cleanEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const device = normalizeDeviceId(raw.device);
  const number = typeof raw.number === "string" && /^\d+$/.test(raw.number) ? Number(raw.number) : raw.number;
  if (!device || !Number.isInteger(number) || number < 1 || number > MAX_CUSTOMER) return null;
  return {
    number,
    name: cut(String(raw.name ?? "").trim(), MAX_NAME),
    device: formatDeviceId(device),
    code: makeCode({ customer: number, device }),
    created_at: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(raw.created_at)) ? String(raw.created_at) : "",
  };
}
function readList() {
  let raw = null;
  try { raw = localStorage.getItem(LIST_KEY); } catch (_) { return []; }
  if (!raw) return [];
  try {
    const rows = JSON.parse(raw);
    if (Array.isArray(rows)) {
      const list = rows.map(cleanEntry).filter(Boolean);
      // Einträge ohne passende Gerätekennung (der Stand vor der Gerätebindung) fallen weg – das Original bleibt einmal unter …_alt erhalten
      if (list.length < rows.length) { try { if (localStorage.getItem(LIST_KEY + "_alt") === null) localStorage.setItem(LIST_KEY + "_alt", raw); } catch (_) {} }
      return list;
    }
  } catch (_) { /* unlesbar: unten sichern */ }
  try { localStorage.setItem(LIST_KEY + "_unlesbar", raw); } catch (_) {}   // das Original bleibt erhalten, auch wenn gleich eine neue Liste entsteht
  return [];
}
function writeList(list) {
  try { localStorage.setItem(LIST_KEY, JSON.stringify(list)); return true; } catch (_) { return false; }
}

const isOpen = () => { try { return sessionStorage.getItem(OPEN_KEY) === "1"; } catch (_) { return false; } };
const setOpen = (open) => { try { if (open) sessionStorage.setItem(OPEN_KEY, "1"); else sessionStorage.removeItem(OPEN_KEY); } catch (_) { /* dann fragt jede Seite neu */ } };

// --- Hilfen ---------------------------------------------------------------------------------------------------------------------------------
const nextNumber = (list) => Math.min(list.reduce((m, e) => Math.max(m, e.number), 0) + 1, MAX_CUSTOMER);
const byNumber = (list) => [...list].sort((a, b) => a.number - b.number);   // stabil: innerhalb eines Kunden bleibt die Reihenfolge des Erzeugens
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// Nach Kunden gruppiert: [{ number, name, entries }] nach Nummern; der Name ist der erste vorhandene der Geräte
function groupsOf(list) {
  const map = new Map();
  for (const e of byNumber(list)) {
    if (!map.has(e.number)) map.set(e.number, { number: e.number, name: "", entries: [] });
    const g = map.get(e.number);
    g.entries.push(e);
    if (!g.name && e.name) g.name = e.name;
  }
  return [...map.values()];
}
// Suche über Nummer, Name, Gerätekennung und Code (Schreibweise egal: mit/ohne Strich, groß/klein)
function matches(e, text) {
  const q = text.trim().toLowerCase();
  if (!q) return true;
  const hay = [String(e.number), e.name, e.device, e.device.replace("-", ""), e.code, e.code.replace("-", "")].join(" ").toLowerCase();
  return hay.includes(q) || hay.includes(q.replace(/[\s-]+/g, ""));
}

// --- Ansicht ----------------------------------------------------------------------------------------------------------------------------------
function pinView(cfg) {
  return html`
<main class="page center narrow gate" data-screen="vendor-pin">
  <header class="brand">${logo(cfg)}</header>
  <div class="gate-ic">${icon("lock", "lg")}</div>
  <h1 class="title">Anbieter-Bereich</h1>
  <p class="gate-sub">Nur für den Anbieter dieser App.</p>
  <form class="lead-form gate-form" id="vendor-pin-form" autocomplete="off" novalidate>
    <div class="field">
      <label class="lbl" for="vendor-pin">Zugangscode</label>
      <input type="password" id="vendor-pin" name="pin" class="pin-input" inputmode="numeric" autofocus autocomplete="off" aria-describedby="vendor-pin-error">
      <p class="err errmsg" id="vendor-pin-error" role="alert" hidden>${icon("alert")}<span>Falscher Zugangscode.</span></p>
    </div>
    <button type="submit" class="btn primary lg block">Öffnen</button>
  </form>
</main>`;
}

// Kopfzeile beider Seiten: Logo, Titel, Sperren
const barView = (cfg, title) => html`
<header class="vendor-bar">
  <span class="logo-link">${logo(cfg)}</span>
  <h1 class="vendor-title">${title}</h1>
  <button type="button" class="btn quiet icon" id="vendor-lock" title="Sperren" aria-label="Sperren">${icon("lock")}</button>
</header>`;

const nameOrNone = (name) => (name || html`<span class="muted">ohne Namen</span>`);

const resultView = (e) => html`
<div class="vendor-result" data-code="${e.code}">
  <p class="vendor-result-for">Kunde Nr. ${e.number}${e.name ? ` · ${e.name}` : ""}</p>
  <p class="vendor-result-device">Gerät ${e.device}</p>
  <p class="vendor-code-big" id="vendor-code">${e.code}</p>
  <div class="vendor-actions"><button type="button" class="btn secondary" data-vendor-copy="${e.code}">${icon("copy")}Kopieren</button></div>
  <p class="vendor-result-note">Gilt nur für dieses Gerät bis ${deDay(LICENSE_END)}.</p>
</div>`;

// Dashboard: eine Zeile je zuletzt erzeugtem Code – Kunde, Gerät, Code, „Kopieren“
const recentRow = (e) => html`
<li class="vendor-row" data-code="${e.code}">
  <div class="vendor-row-main">
    <p class="vendor-name"><span class="vendor-no">Nr. ${e.number}</span> ${nameOrNone(e.name)}</p>
    <p class="vendor-ids"><span class="vendor-id-lbl">Gerät</span> <span class="vendor-mono">${e.device}</span> <span class="vendor-id-lbl">Code</span> <strong class="vendor-mono">${e.code}</strong></p>
  </div>
  <button type="button" class="btn secondary" data-vendor-copy="${e.code}">${icon("copy")}Kopieren</button>
</li>`;
const recentView = (list) => (list.length
  ? html`${list.slice(-RECENT).reverse().map(recentRow)}`
  : html`<li class="vendor-empty">Noch keine Codes erzeugt. Oben die Gerätekennung des Kunden eintragen.</li>`);

// Adresse mit Umbruchstellen hinter den Schrägstrichen (nicht mitten im Wort); das Kopieren und Markieren bleibt davon unberührt
function breakable(url) {
  const [scheme, rest] = url.includes("://") ? url.split("://") : ["", url];
  return raw((scheme ? `${esc(scheme)}://<wbr>` : "") + rest.split("/").map(esc).join("/<wbr>"));
}
const linkRow = (name, url) => html`
<li class="vendor-link">
  <div class="vendor-link-main">
    <p class="vendor-link-name">${name}</p>
    <p class="vendor-url">${breakable(url)}</p>
  </div>
  <button type="button" class="btn secondary" data-vendor-copy="${url}" data-what="Link">${icon("copy")}Kopieren</button>
</li>`;

function dashView(cfg, list) {
  return html`
${barView(cfg, "Anbieter")}
<main class="vendor-main" data-screen="vendor">
  <nav class="vendor-nav" aria-label="Anbieter">
    <button type="button" class="btn secondary vendor-tile" id="vendor-new">${icon("plus")}Code erzeugen</button>
    <a class="btn secondary vendor-tile" id="vendor-customers" href="#/anbieter/kunden">${icon("list")}Kundenliste</a>
    <button type="button" class="btn secondary vendor-tile" id="vendor-export-csv">${icon("download")}CSV exportieren</button>
  </nav>
  <div class="vendor-grid">
    <section class="card vendor-card" aria-labelledby="vendor-h">
      <h2 class="v-h" id="vendor-h">Code für ein Gerät</h2>
      <form id="vendor-form" novalidate autocomplete="off">
        <div class="fields-2">
          <label class="field">
            <span class="lbl">Kundennummer</span>
            <input name="number" type="number" inputmode="numeric" min="1" max="${MAX_CUSTOMER}" step="1" value="${nextNumber(list)}">
          </label>
          <label class="field">
            <span class="lbl">Kundenname <small>(optional)</small></span>
            <input name="name" maxlength="${MAX_NAME}" autocomplete="off">
          </label>
        </div>
        <label class="field">
          <span class="lbl">Gerätekennung</span>
          <input name="device" id="vendor-device" class="device-input" placeholder="XXXX-XXXX" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" aria-describedby="vendor-error">
        </label>
        <p class="err errmsg" id="vendor-error" role="alert" hidden>${icon("alert")}<span></span></p>
        <button type="submit" class="btn primary lg block">Code anzeigen</button>
      </form>
      <div id="vendor-result" aria-live="polite"></div>
    </section>
    <div class="vendor-side">
      <section class="card" aria-labelledby="vendor-links-h">
        <div class="v-head"><h2 class="v-h" id="vendor-links-h">Links</h2><a class="vendor-dl" href="${DOWNLOAD_URL}" target="_blank" rel="noopener" data-download title="Programm für den Stand-Laptop herunterladen (Windows, Mac)">Laptop-Programm</a></div>
        <ul class="vendor-links">${linkRow("App", APP_URL)}${linkRow("Anleitung", GUIDE_URL)}</ul>
      </section>
      <section class="card" aria-labelledby="vendor-recent-h">
        <div class="vendor-card-head"><h2 class="v-h" id="vendor-recent-h">Zuletzt erzeugt</h2><span class="n" id="vendor-count">${plural(list.length, "Code", "Codes")} gesamt</span></div>
        <ul class="vendor-list" id="vendor-list">${recentView(list)}</ul>
      </section>
    </div>
  </div>
</main>`;
}

// Kundenliste: ein Kasten je Kunde, darunter eine Zeile je Gerät
const deviceRow = (e) => html`
<li class="vendor-row" data-code="${e.code}">
  <div class="vendor-row-main">
    <p class="vendor-ids"><span class="vendor-id-lbl">Gerät</span> <span class="vendor-mono">${e.device}</span></p>
    <p class="vendor-ids"><span class="vendor-id-lbl">Code</span> <strong class="vendor-mono vendor-code-row">${e.code}</strong></p>
    ${e.created_at ? html`<p class="vendor-meta">erstellt ${deDate(e.created_at)}</p>` : ""}
  </div>
  <div class="vendor-row-actions">
    <button type="button" class="btn secondary" data-vendor-copy="${e.code}">${icon("copy")}Kopieren</button>
    <button type="button" class="btn danger" data-vendor-delete="${e.code}" data-device="${e.device}">${icon("trash")}Löschen</button>
  </div>
</li>`;
const groupView = (g) => html`
<section class="card vendor-group" data-number="${g.number}">
  <div class="vendor-group-head">
    <h2 class="vendor-name"><span class="vendor-no">Nr. ${g.number}</span> ${nameOrNone(g.name)}</h2>
    <span class="n">${plural(g.entries.length, "Gerät", "Geräte")}</span>
  </div>
  <ul class="vendor-devices">${g.entries.map(deviceRow)}</ul>
</section>`;
// Gruppen der Liste unter einem Suchtext; leer: ein Satz statt der Liste
function groupsView(list, text) {
  const groups = groupsOf(list.filter((e) => matches(e, text)));
  if (groups.length) return html`${groups.map(groupView)}`;
  return html`<p class="vendor-empty card">${list.length ? "Nichts gefunden." : "Noch keine Codes erzeugt. Auf der Übersicht „Code erzeugen“ – der Kunde erscheint hier."}</p>`;
}
const countText = (list, text) => {
  const shown = list.filter((e) => matches(e, text));
  const customers = new Set(shown.map((e) => e.number)).size;
  return `${plural(shown.length, "Gerät", "Geräte")} bei ${plural(customers, "Kunde", "Kunden")}`;
};

function listView(cfg, list) {
  return html`
${barView(cfg, "Kundenliste")}
<main class="vendor-main" data-screen="vendor-customers">
  <div class="vendor-toolbar">
    <a class="btn quiet back" id="vendor-back" href="#/anbieter">${icon("chevR", "flip")}Übersicht</a>
    <button type="button" class="btn secondary" id="vendor-export-csv">${icon("download")}CSV exportieren</button>
  </div>
  <div class="has-ic vendor-search">${icon("search")}<input type="search" id="vendor-search" placeholder="Nummer, Name, Gerät, Code" autocomplete="off" aria-label="Kunden suchen"></div>
  <div class="vendor-head"><span class="n" id="vendor-count">${countText(list, "")}</span><span class="help vendor-saved">Die Liste liegt nur in diesem Browser.</span></div>
  <div id="vendor-list">${groupsView(list, "")}</div>
</main>`;
}

// --- Screens ----------------------------------------------------------------------------------------------------------------------------------
// kind: "dash" = Dashboard (#/anbieter), "list" = Kundenliste (#/anbieter/kunden). Beide teilen Zugangscode, Speicher und Kopieren/CSV; alle Ereignisse hängen
// per Delegation an der Wurzel des Screens und überleben das Neuzeichnen.
function makeScreen(kind) {
  return function screen({ el }) {
    const cfg = store.settings;
    let list = readList();

    const draw = () => {
      if (!isOpen()) { document.title = `Anbieter-Bereich – ${cfg.brand_name}`; render(el, pinView(cfg)); return; }
      document.title = `${kind === "list" ? "Kundenliste" : "Anbieter-Bereich"} – ${cfg.brand_name}`;
      render(el, kind === "list" ? listView(cfg, list) : dashView(cfg, list));
    };
    // Nur die Liste (und den Zähler) neu zeichnen: Eingaben, Suchtext und Fokus bleiben
    const drawList = () => {
      const box = $("#vendor-list", el), count = $("#vendor-count", el);
      if (!box) return;
      if (kind === "list") {
        const text = ($("#vendor-search", el) || { value: "" }).value;
        render(box, groupsView(list, text));
        if (count) count.textContent = countText(list, text);
      } else {
        render(box, recentView(list));
        if (count) count.textContent = `${plural(list.length, "Code", "Codes")} gesamt`;
      }
    };
    const save = () => { if (!writeList(list)) flash("Die Liste konnte nicht gespeichert werden (Browser-Speicher gesperrt) und geht beim Schließen verloren – bitte „CSV exportieren“ wählen.", "warn"); };
    draw();

    // Zugangscode
    on(el, "submit", "#vendor-pin-form", (ev, f) => {
      ev.preventDefault();
      if (f.pin.value.trim() === VENDOR_PIN) { setOpen(true); draw(); return; }
      $("#vendor-pin-error", el).hidden = false;
      f.pin.classList.add("invalid");
      f.pin.setAttribute("aria-invalid", "true");
      f.pin.value = "";
      f.pin.focus();
    });
    on(el, "input", "#vendor-pin", (ev, input) => {
      input.classList.remove("invalid");
      input.removeAttribute("aria-invalid");
      $("#vendor-pin-error", el).hidden = true;
    });
    on(el, "click", "#vendor-lock", () => { setOpen(false); draw(); });

    // Dashboard: „Code erzeugen“ springt zum Formular auf derselben Seite (und setzt den Cursor in die Gerätekennung)
    on(el, "click", "#vendor-new", () => {
      const field = $("#vendor-device", el);
      if (!field) return;
      field.scrollIntoView({ block: "center", behavior: "smooth" });
      field.focus({ preventScroll: true });
    });

    // Formular „Code für ein Gerät“
    on(el, "input", "#vendor-form", (ev) => {
      const box = $("#vendor-error", el);
      if (box) box.hidden = true;
      const t = ev.target;
      if (t.name === "device") formatCodeField(t, formatDeviceId);   // Großbuchstaben, Strich nach dem vierten Zeichen, höchstens acht
      else if (t.name === "name") t.dataset.auto = "";               // selbst getippt: nicht mehr überschreiben
      else if (t.name === "number") {
        // Bekannter Kunde (weiteres Gerät): der Name kommt von selbst, solange man ihn nicht selbst getippt hat
        const nameField = $("input[name=name]", el), known = list.find((e) => e.number === Number(t.value) && e.name);
        if (nameField && (!nameField.value || nameField.dataset.auto === "1")) {
          nameField.value = known ? known.name : "";
          nameField.dataset.auto = known ? "1" : "";
        }
      }
    });
    on(el, "submit", "#vendor-form", (ev, f) => {
      ev.preventDefault();
      $("#vendor-result", el).replaceChildren();     // ein früheres Ergebnis steht nicht neben einer neuen Fehlermeldung
      const fail = (text, field) => {
        const box = $("#vendor-error", el);
        $("span", box).textContent = text;
        box.hidden = false;
        f.elements[field].focus();
      };
      const numberText = f.elements.number.value.trim(), number = /^\d+$/.test(numberText) ? Number(numberText) : NaN;
      if (!(number >= 1 && number <= MAX_CUSTOMER)) return fail(`Die Kundennummer muss zwischen 1 und ${MAX_CUSTOMER} liegen.`, "number");
      const deviceText = f.elements.device.value;
      const device = normalizeDeviceId(deviceText);
      if (!device) return fail(formatDeviceId(deviceText) ? DEVICE_BAD : DEVICE_EMPTY, "device");
      const name = cut(f.elements.name.value.trim(), MAX_NAME);
      const known = list.find((e) => e.number === number && e.name);   // ein Name dieses Kunden (von einem anderen Gerät)
      if (known && name && known.name.toLowerCase() !== name.toLowerCase()) {
        return fail(`Die Kundennummer ${number} gehört schon zu „${known.name}“. Für denselben Kunden bitte denselben Namen verwenden.`, "name");
      }
      const shownDevice = formatDeviceId(device);
      let entry = list.find((e) => e.number === number && e.device === shownDevice);
      if (!entry) {
        entry = { number, name: name || (known ? known.name : ""), device: shownDevice, code: makeCode({ customer: number, device }), created_at: now() };
        list.push(entry);
        save();
      } else if (name && !entry.name) {
        entry.name = name;      // ein Name, der noch fehlte, wird nachgetragen
        save();
      }
      render($("#vendor-result", el), resultView(entry));
      drawList();
      f.elements.name.value = "";
      f.elements.name.dataset.auto = "";
      f.elements.device.value = "";
      f.elements.number.value = nextNumber(list);
      const result = $("#vendor-result", el);
      if (result && result.scrollIntoView) result.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });

    // Kopieren (Code, Links), Löschen (Kundenliste), CSV
    on(el, "click", "[data-vendor-copy]", async (ev, btn) => {
      const what = btn.dataset.what || "Code";
      if (await copyText(btn.dataset.vendorCopy)) flash(`${what} kopiert.`);
      else flash(`Kopieren nicht möglich – bitte den ${what} markieren und von Hand kopieren.`, "warn");
    });
    on(el, "click", "[data-vendor-delete]", (ev, btn) => {
      const entry = list.find((e) => e.code === btn.dataset.vendorDelete && e.device === btn.dataset.device);
      if (!entry) return;
      if (!ask(`Gerät ${entry.device} von Kunde Nr. ${entry.number}${entry.name ? ` („${entry.name}“)` : ""} aus der Liste löschen?\n\nDer Code ${entry.code} bleibt auf diesem Gerät gültig – gelöscht wird nur der Eintrag in dieser Liste.`)) return;
      list = list.filter((e) => e !== entry);
      save();
      drawList();
      flash("Eintrag gelöscht.");
    });
    on(el, "click", "#vendor-export-csv", () => {
      downloadCSV("anbieter-kunden", ["Kundennummer", "Kundenname", "Gerätekennung", "Code", "Erstellt"],
        byNumber(list).map((e) => [e.number, safeCell(e.name), e.device, e.code, e.created_at ? deDate(e.created_at) : ""]));
    });

    // Kundenliste: Suche (zeichnet nur die Liste neu, das Suchfeld behält Fokus und Text)
    on(el, "input", "#vendor-search", () => drawList());

    return () => {};
  };
}

register("/anbieter", makeScreen("dash"), { bodyClass: "vendor" });
register("/anbieter/kunden", makeScreen("list"), { bodyClass: "vendor" });
