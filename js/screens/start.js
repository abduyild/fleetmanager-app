// Start-Screen (#/ und #/start): Stand-Übersicht als Link-Hub für den Vertreter am Stand (ui-review.md §5.2).
// Zeigt, wo was ist: Kunden-Bildschirme zum Weitergeben des Tablets (Kunden-Formular, Aufruf-Anzeige), die Bereiche des Standteams
// mit Live-Zahlen als Textzeile, den Speicherort der Daten bzw. die Verbindung zum Stand-Laptop und – im Hub-Modus – Link und QR-Code
// für weitere Geräte. Geschützt wie der Admin (Stand-PIN). Die Kunden-Kacheln öffnen Kiosk-Routen und sperren den Admin damit wieder.
// Offene Einrichtung (Stand-PIN, Datenschutztext) zeigt der Rahmen hier als EIN gebündeltes Banner (ui.adminShell); unter den
// Kunden-Kacheln steht EIN Hinweis für die ganze Gruppe (Admin wird gesperrt bzw. bleibt offen).
// Läuft die App nur im Browser (nicht als installierte App), hat das Standteam die Zeile „App installieren“ (#/installieren, screens/install.js) und darüber – bis zum
// Schließen, einmal je Gerät – einen ruhigen Hinweis dazu (install.js: fm_install_hint); auf iPhone/iPad und im Safari am Mac nennt er ehrlich die neue Aktivierung.
// Der Screen hat keine Eingaben; bei jeder Datenänderung (store.subscribe) wird er komplett neu gerendert, sofern sich
// das Markup wirklich geändert hat (sonst gingen Markierung und Fokus im Link-Feld bei jedem Verbindungs-Ping verloren).
import { register } from "../router.js";
import { html, render, on, flash, adminShell, hasPin, setupIssues, $ } from "../ui.js";
import { icon } from "../icons.js";
import { store } from "../store.js";
import * as model from "../model.js";
import { licenseInfo, writeAllowed } from "../license.js";
import { isStandalone, currentPlatform, installHintMode, installHintText, dismissInstallHint } from "../install.js";

const SETTINGS = "/admin/einstellungen";
const OFF_TEXT = "in den Einstellungen ausgeschaltet";

// --- Zahlen und Zustand -------------------------------------------------------------------------
// Warteschlange wie in der Admin-Warteschlange; Fahrzeuge ohne archivierte; Interessenten „heute“ wie im Admin.
function figures(d, cfg) {
  const infos = model.vehicleStates(d.vehicles, d.queue, d.damages, cfg);
  const day = model.today();
  return {
    queue: {
      waiting: model.queueState(d.queue, d.vehicles, cfg).waiting.length,
      called: model.byStatus(d.queue, model.STATUS.CALLED).length,
      driving: model.byStatus(d.queue, model.STATUS.DRIVING).length,
    },
    vehicles: { free: model.freeCount(infos), total: infos.length },
    leads: { today: d.leads.filter((l) => String(l.created_at || "").startsWith(day)).length, total: d.leads.length },
  };
}

// Hub-Zustand (Vertrag mit dem Hub-Sync): store.hub ist null im lokalen Betrieb, sonst { online, url, version, needsPin }.
// Das Feld kann fehlen (ältere Speicher-Version) – dann gilt „lokal“.
function hubInfo() {
  const hub = store.hub;
  if (!hub) return null;
  const url = String(hub.url || "").replace(/\/+$/, "");
  return { online: !!hub.online, url, appUrl: url ? url + "/app/" : "" };
}

function dateLabel(d = new Date()) {
  try {
    return new Intl.DateTimeFormat("de-DE", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(d);
  } catch (_) {
    return model.deDay(model.today(d));
  }
}

// --- Bausteine ----------------------------------------------------------------------------------
// Kachel: Symbol-Quadrat links, Name (= der Link, deckt per ::after die ganze Fläche ab), Zeile darunter, Pfeil rechts.
// cls "customer" = Karte mit Akzent-Symbol (Kunden-Gruppe), cls "row" = Zeile in einer ul.list (Standteam).
// sub = Satz, line = Live-Zeile mit Zahlen (fig) oder Fakten, tag = kleiner Hinweis („1 offen“) hinter dem Namen.
function tile({ id, href, name, symbol, sub = "", line = null, tag = "", cls = "" }) {
  return html`
    <li class="tile ${cls}" data-tile="${id}">
      <span class="tile-ic">${icon(symbol)}</span>
      <div class="tile-body">
        <div class="tile-head">
          <h3 class="tile-name"><a class="tile-link" href="${href}">${name}</a></h3>
          ${tag ? html`<span class="tag warn">${tag}</span>` : ""}
        </div>
        ${sub ? html`<p class="tile-sub">${sub}</p>` : ""}
        ${line ? html`<p class="tile-line">${line}</p>` : ""}
      </div>
      ${icon("chevR", "chev")}
    </li>`;
}
// Modul ausgeschaltet: Kachel bleibt an ihrem Platz (gestrichelt), führt aber in die Einstellungen
const offTile = (id, name, symbol, cls = "") => html`
    <li class="tile off ${cls}" data-tile="${id}">
      <span class="tile-ic">${icon(symbol)}</span>
      <div class="tile-body">
        <h3 class="tile-name"><a class="tile-link" href="#${SETTINGS}">${name}</a></h3>
        <p class="tile-sub">${OFF_TEXT}</p>
      </div>
      ${icon("chevR", "chev")}
    </li>`;
// Zahl in der Live-Zeile: Zahl fett, Wort normal – Text, keine Kennzahlkachel
const fig = (key, n, label = "") => html`<span class="fig" data-fig="${key}"><strong>${n}</strong>${label ? html` <small>${label}</small>` : ""}</span>`;

function statusView() {
  const hub = hubInfo();
  if (!hub) return html`<span class="start-status local" data-status="local">Daten liegen nur auf diesem Gerät</span>`;
  if (hub.online) return html`<span class="start-status online" data-status="online">Verbunden mit dem Stand-Laptop${hub.url ? ` · ${hub.url}` : ""}</span>`;
  return html`<span class="start-status offline" data-status="offline">Keine Verbindung zum Laptop</span>`;
}

// Satz unter „Kunden-Formular“: je nach Modulen, was das EINE Formular anbietet (Probefahrt mit Nummer, Interessen oder beides)
function formSub(cfg) {
  if (cfg.module_leads && cfg.module_queue) return "Probefahrt-Anmeldung und Interessen – Besucher bekommen eine Nummer";
  if (cfg.module_queue) return "Probefahrt-Anmeldung – Besucher bekommen eine Nummer";
  return "Besucher hinterlassen Name, Kontakt und Interesse";
}

function customerSection(cfg) {
  // Ein Hinweis für die ganze Gruppe: mit PIN sperrt das Öffnen den Admin (kiosk: true in der Route); ohne PIN gibt es nichts zu sperren.
  const note = hasPin()
    ? html`${icon("lock")}<span>Beim Öffnen wird der Admin gesperrt.</span>`
    : html`${icon("info")}<span>Admin bleibt offen –</span> <a href="#${SETTINGS}?zu=pin">Stand-PIN setzen</a>`;
  return html`
  <section class="start-section" data-section="customers">
    <h2>Für Kunden – Tablet weitergeben</h2>
    <ul class="tiles">
      ${cfg.module_leads || cfg.module_queue
        ? tile({ id: "form", href: "#/formular", name: "Kunden-Formular", symbol: "form", sub: formSub(cfg), cls: "customer" })
        : offTile("form", "Kunden-Formular", "form")}
      ${cfg.module_queue
        ? tile({ id: "display", href: "#/anzeige", name: "Aufruf-Anzeige", symbol: "bell", sub: "Großanzeige der aufgerufenen Nummern für TV oder Zweit-Tablet.", cls: "customer" })
        : offTile("display", "Aufruf-Anzeige", "bell")}
    </ul>
    ${cfg.module_leads || cfg.module_queue ? html`<p class="group-note" data-note="customers">${note}</p>` : ""}
  </section>`;
}

function teamSection(cfg, d) {
  const f = figures(d, cfg);
  const open = setupIssues(cfg).length;
  return html`
  <section class="start-section" data-section="team">
    <h2>Für das Standteam</h2>
    <ul class="list">
      ${cfg.module_queue
        ? tile({ id: "queue", href: "#/admin/warteschlange", name: "Warteschlange", symbol: "list", cls: "row",
          line: html`${fig("waiting", f.queue.waiting, "wartend")} · ${fig("called", f.queue.called, "aufgerufen")} · ${fig("driving", f.queue.driving, "unterwegs")}` })
        : offTile("queue", "Warteschlange", "list", "row")}
      ${cfg.module_queue
        ? tile({ id: "vehicles", href: "#/admin/fahrzeuge", name: "Fahrzeuge", symbol: "car", cls: "row",
          ...(f.vehicles.total
            ? { line: html`${fig("free", f.vehicles.free)} von ${fig("total", f.vehicles.total)} frei` }
            : { sub: "Noch keine Fahrzeuge angelegt." }) })
        : offTile("vehicles", "Fahrzeuge", "car", "row")}
      ${cfg.module_leads
        ? tile({ id: "leads", href: "#/admin/interessenten", name: "Interessenten", symbol: "user", cls: "row",
          line: html`${fig("today", f.leads.today, "heute")} · ${fig("total", f.leads.total, "gesamt")}` })
        : offTile("leads", "Interessenten", "user", "row")}
      ${tile({ id: "settings", href: "#" + SETTINGS, name: "Einstellungen", symbol: "sliders", cls: "row", tag: open ? `${open} offen` : "",
        line: html`<span data-fact="brand">Marke <strong>${cfg.brand_name}</strong></span> · <span data-fact="pin">Stand-PIN <strong>${hasPin() ? "gesetzt" : "nicht gesetzt"}</strong></span>` })}
      ${tile({ id: "guide", href: "./anleitung/", name: "Anleitung", symbol: "doc", cls: "row", sub: "So läuft ein Tag am Stand mit der App." })}
      ${isStandalone() ? "" : tile({ id: "install", href: "#/installieren", name: "App installieren", symbol: "download", cls: "row", sub: "Anleitung für iPhone, iPad, Android, Windows und Mac." })}
    </ul>
  </section>`;
}

// Einmaliger Hinweis nach der Aktivierung, solange die App nur im Browser läuft und installierbar ist; schließbar, danach nie wieder (install.js: fm_install_hint).
// Kein .banner: das gebündelte Einrichtungs-Banner ist der eine Hinweis dieser Seite, der Installationshinweis ist ruhiger. Mit gesperrter Lizenz entfällt er.
function installNote() {
  const platform = currentPlatform();
  const mode = installHintMode(platform);
  if (!mode || !writeAllowed(licenseInfo(store.settings))) return "";
  return html`
  <aside class="install-note" id="install-note" data-hint="install" data-mode="${mode}">
    <span class="install-note-ic">${icon("download")}</span>
    <div class="install-note-body">
      <p class="install-note-text">${installHintText(platform)}</p>
      <a class="btn secondary" href="#/installieren">Anleitung ansehen</a>
    </div>
    <button type="button" class="btn quiet icon" data-install-dismiss aria-label="Hinweis schließen" title="Schließen">${icon("x")}</button>
  </aside>`;
}

function devicesSection(cfg) {
  const hub = hubInfo();
  if (!hub) {
    return html`
  <section class="start-section" data-section="devices">
    <h2>Weitere Geräte verbinden</h2>
    <div class="card devices local">
      ${icon("wifi", "lg")}
      <div class="devices-text">
        <h3 class="devices-title">Mehrere Geräte nutzen</h3>
        <p class="devices-note">App auf dem Laptop starten (FleetManager.exe), dann diese Seite dort öffnen.<br>Tablet und Handys zeigen dann dieselben Listen.</p>
        <a class="btn secondary" href="./anleitung/">So geht’s</a>
      </div>
    </div>
  </section>`;
  }
  return html`
  <section class="start-section" data-section="devices">
    <h2>Weitere Geräte verbinden</h2>
    <div class="card devices hub">
      ${hub.online ? html`<img class="devices-qr" src="/qr.png?p=/app/" alt="QR-Code" width="160" height="160">` : ""}
      <div class="devices-text">
        <h3 class="devices-title">Auf Tablet oder Handy im selben WLAN öffnen</h3>
        <p class="devices-note">Weitere Geräte zeigen danach dieselben Listen wie dieses Gerät.</p>
        ${hub.appUrl ? html`<div class="link-row">
          <input type="text" id="hub-link" class="link-field" readonly value="${hub.appUrl}" aria-label="Link zur App">
          <button type="button" class="btn secondary icon" data-copy aria-label="Link kopieren" title="Link kopieren">${icon("copy")}</button>
        </div>` : ""}
        ${cfg.module_queue ? html`<p class="devices-hint" data-hint="display">Für die Anzeige am TV: dieselbe Adresse dort öffnen, mit der Stand-PIN verbinden und „Aufruf-Anzeige“ wählen.</p>` : ""}
      </div>
    </div>
  </section>`;
}

function content(cfg, d) {
  return html`
  <div class="page-head"><h1 class="title">Stand-Übersicht</h1></div>
  <p class="sub start-meta"><span class="start-date">${[cfg.brand_name, dateLabel()].filter(Boolean).join(" · ")}</span>${statusView()}</p>
  ${installNote()}
  ${customerSection(cfg)}
  ${teamSection(cfg, d)}
  ${devicesSection(cfg)}`;
}

// --- Link kopieren ------------------------------------------------------------------------------
// navigator.clipboard gibt es nur in sicheren Kontexten (https, localhost) – im Stand-WLAN über http nicht.
// Dann bleibt der Link im Feld markiert (und wird per execCommand kopiert, wo der Browser es erlaubt).
async function copyLink(el) {
  const input = $("#hub-link", el);
  if (!input) return;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(input.value);
      flash("Link kopiert.");
      return;
    }
  } catch (_) { /* Rückfall */ }
  input.focus();
  input.select();
  try { input.setSelectionRange(0, input.value.length); } catch (_) {}
  let copied = false;
  try { copied = document.execCommand("copy"); } catch (_) {}
  if (copied) flash("Link kopiert.");
  else flash("Link markiert – jetzt „Kopieren“ wählen.", "warn");
}

// --- Screen -------------------------------------------------------------------------------------
function startScreen({ el }) {
  let last = "";
  const draw = () => {
    const markup = String(adminShell("start", content(store.settings, store.data), { title: "Stand-Übersicht" }));
    if (markup === last) return;
    last = markup;
    const y = window.scrollY;
    render(el, markup);
    window.scrollTo(0, y);
  };
  draw();
  on(el, "click", "[data-copy]", () => copyLink(el));
  on(el, "click", "[data-install-dismiss]", () => { dismissInstallHint(); draw(); });
  on(el, "focusin", "#hub-link", (ev, input) => input.select());
  const unsub = store.subscribe(draw);
  return () => { unsub(); };
}

register("/", startScreen, { admin: true, bodyClass: "admin" });
register("/start", startScreen, { admin: true, bodyClass: "admin" });
