// Hash-Router: Routen registrieren sich mit Muster und Screen-Funktion. Ein Screen bekommt
// { params, query, el } und rendert sich in `el`; optional liefert er eine Aufräumfunktion zurück
// (z. B. zum Stoppen von Timern), die beim Verlassen der Route aufgerufen wird.
//
//   register("/admin/fahrzeuge/:id", ({ params, query, el }) => { … ; return () => clearInterval(timer); });
//
// Routen mit admin: true verlangen die Stand-PIN (siehe ui.unlocked); kiosk: true sperrt den Admin (ui.lock).
// Im Hub-Betrieb (store.hub) leitet der Router auf /verbinden um, solange das Gerät die Stand-PIN des Laptops braucht.
// Lizenz (license.js): Ohne gültige Lizenz zeigen alle Kunden-Routen (kiosk: true) statt des Screens die Seite „Derzeit keine Anmeldung
// möglich.“ – außer der Aufruf-Anzeige (zeigt dann einen neutralen Text, siehe display.js) und dem Ticket (der Kunde sieht seine
// Nummer weiter). Das hier ist die EINE Stelle dafür; die Kunden-Screens selbst wissen nichts von der Lizenz.
// Davor kommt die Aktivierung: Gibt es gar keine brauchbare Lizenz (weder einen gültigen Aktivierungscode FÜR DIESES GERÄT noch einen gültigen Schlüssel:
// Zustand none oder invalid), leitet der Router jede Route außer #/aktivieren, #/installieren (die Anleitung zum Installieren), #/anbieter (und darunter, auch
// #/anbieter/kunden) und #/datenschutz auf #/aktivieren um – die Oberfläche der App lädt erst nach der Eingabe eines Codes. Der Code liegt im Gerätespeicher (license.js), auch im Hub-Betrieb
// aktiviert sich also jedes Gerät einmal selbst. Abgelaufen (expired) ist etwas anderes: dann bleibt der Admin erreichbar (Export, Backup, Löschen), und
// die Hinweise führen mit „Code eingeben“ zu #/aktivieren.
import { html, lock, unlocked, showPendingFlash, hideFlash, applyBrand, logo } from "./ui.js";
import { store } from "./store.js";
import { licenseInfo, licenseSignature, writeAllowed } from "./license.js";

const routes = [];
let cleanup = null;
let current = "";
let currentRoute = null;
let restricted = false;   // zeigt der Screen gerade die Sperrseite?
const LICENSE_FREE = new Set(["/anzeige", "/warteschlange/ticket/:id"]);   // Kunden-Routen, die auch ohne Lizenz laufen
const LICENSE_CHECK_MS = 30000;                                           // Datumswechsel um Mitternacht erkennen, ohne dass jemand tippt
const AFTER_ACTIVATE = "fm_after_activate";                               // sessionStorage: wohin es nach der Aktivierung geht (die ursprüngliche Adresse)
// Diese Routen laufen auch ganz ohne Lizenz: die Aktivierung selbst, die Installationsanleitung, der Anbieter-Bereich und die Datenschutzerklärung
const gateFree = (path) => path === "/aktivieren" || path === "/installieren" || path === "/datenschutz" || path === "/anbieter" || path.startsWith("/anbieter/");
const gated = (st) => st.state === "none" || st.state === "invalid";

export function register(pattern, screen, opts = {}) {
  const keys = [];
  const re = new RegExp("^" + pattern.replace(/\//g, "\\/").replace(/:(\w+)/g, (_, k) => { keys.push(k); return "([^/]+)"; }) + "$");
  routes.push({ re, keys, screen, opts, pattern });
}

// Kunden-Seite ohne Lizenz: Logo, ein Satz, der Zugang für das Standpersonal. Kein Wort über Schlüssel oder Ablauf – das gehört in den Admin.
function restrictedPage(el, st) {
  const cfg = store.settings;
  document.title = cfg.brand_name;
  el.innerHTML = String(html`<main class="page cust center stage restricted" data-license-state="${st.state}">
  <div class="stage-body">
    <header class="brand">${logo(cfg)}</header>
    <h1>Derzeit keine Anmeldung möglich.</h1>
    <p class="lead">Bitte wenden Sie sich an das Standpersonal.</p>
  </div>
  <p class="kiosk-admin-link"><a href="#/">Mitarbeiter-Zugang</a> · <a href="#/aktivieren" data-activate>Code eingeben</a></p>
</main>`);
}
const needsLicense = (route) => !!route && !!route.opts.kiosk && !LICENSE_FREE.has(route.pattern);

export function parseHash() {
  const h = (location.hash || "#/").slice(1);
  const [path, qs = ""] = h.split("?");
  const query = Object.fromEntries(new URLSearchParams(qs));
  return { path: path || "/", query };
}

// Hub-Wächter: Braucht dieses Gerät die PIN des Laptops (store.hub.needsPin), geht alles außer /verbinden dorthin.
function hubGuard(path) {
  if (!store.hub || !store.hub.needsPin || path === "/verbinden") return false;
  try { sessionStorage.setItem("fm_after_connect", location.hash); } catch (_) {}
  location.replace("#/verbinden");
  return true;
}

// Muss diese Adresse erst aktiviert werden? Ja, wenn es keine brauchbare Lizenz gibt (none/invalid) und die Adresse nicht zu den gateFree-Routen
// gehört. Ein Gerät, das noch die PIN des Laptops braucht (Hub-Wächter, #/verbinden), kennt einen langen Schlüssel des Laptops noch nicht – er liegt im
// Datendokument –: erst verbinden, dann gilt, was der Laptop hat; danach fragt dieses Gerät, wenn nötig, nach seinem eigenen Aktivierungscode.
function needsActivation(path) {
  if (gateFree(path) || (store.hub && store.hub.needsPin)) return false;
  return gated(licenseInfo(store.settings));
}
// Aktivierungs-Wächter (nach dem Hub-Wächter): ohne Lizenz geht alles außer den gateFree-Routen zu #/aktivieren. Die gewünschte Adresse merkt sich
// die Sitzung; nach der Aktivierung geht es dorthin weiter (takeAfterActivate).
function licenseGate(path) {
  if (!needsActivation(path)) return false;
  try { sessionStorage.setItem(AFTER_ACTIVATE, location.hash || "#/"); } catch (_) {}
  location.replace("#/aktivieren");
  return true;
}
// Wohin nach einer Aktivierung: zur Adresse, von der der Wächter umgeleitet hat, sonst zum Start (und nie zurück in Aktivierung oder Anbieter-Bereich)
export function takeAfterActivate() {
  let target = "#/";
  try { target = sessionStorage.getItem(AFTER_ACTIVATE) || target; sessionStorage.removeItem(AFTER_ACTIVATE); } catch (_) {}
  return /^#\/(aktivieren|anbieter)(\/|\?|$)/.test(target) ? "#/" : target;
}

export function navigate() {
  const { path, query } = parseHash();
  if (hubGuard(path) || licenseGate(path)) return;
  const el = document.getElementById("app");
  if (cleanup) { try { cleanup(); } catch (e) { console.error(e); } cleanup = null; }
  hideFlash();
  applyBrand(store.settings);
  for (const r of routes) {
    const m = r.re.exec(path);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    if (r.opts.kiosk) lock();
    if (r.opts.admin && !unlocked()) {
      sessionStorage.setItem("fm_after_login", location.hash);
      location.replace("#/admin/login");
      return;
    }
    current = path;
    currentRoute = r;
    window.scrollTo(0, 0);
    document.body.className = r.opts.bodyClass || "";
    // Jeder Screen bekommt einen frischen Wurzelknoten: Listener (ui.on) verschwinden mit ihm,
    // nichts stapelt sich bei wiederholten Besuchen.
    const root = document.createElement("div");
    root.className = "screen " + (r.opts.bodyClass || "");
    el.replaceChildren(root);
    const st = licenseInfo(store.settings);
    restricted = needsLicense(r) && !writeAllowed(st);
    if (restricted) { restrictedPage(root, st); showPendingFlash(); return; }
    const result = r.screen({ params, query, el: root });
    if (typeof result === "function") cleanup = result;
    showPendingFlash();
    return;
  }
  currentRoute = null;
  restricted = false;
  el.innerHTML = `<main class="page center"><h1 class="title">Seite nicht gefunden</h1><p><a href="#/">Zum Start</a></p></main>`;
}

// Sperren-Button der Admin-Leiste (ein Listener für alle Screens)
document.addEventListener("click", (ev) => {
  if (ev.target.closest("#admin-lock")) {
    ev.preventDefault();
    lock();
    location.hash = "#/admin/login";
  }
});

// Lizenz-Wächter: ändert sich der Zustand (anderes Gerät trägt einen Schlüssel ein, Mitternacht, Datum wird umgestellt), muss eine
// offene Kunden-Seite sofort zwischen Formular und Sperrseite wechseln. Admin-Seiten zeichnen ihre Hinweise selbst neu (shellKey);
// der Zeitgeber stößt sie über store.notify() an.
let licenseSeen = "";
function checkLicense(fromTimer) {
  const sig = licenseSignature(store.settings);
  if (sig === licenseSeen) return;
  licenseSeen = sig;
  const st = licenseInfo(store.settings);
  if (needsActivation(current)) navigate();                                           // die Lizenz ist weg (anderes Gerät, Backup): zur Aktivierung
  else if (needsLicense(currentRoute) && restricted === writeAllowed(st)) navigate();   // Zustand der Seite ≠ Zustand der Lizenz
  else if (fromTimer) store.notify();
}

export function start() {
  window.addEventListener("hashchange", navigate);
  store.subscribe(() => { hubGuard(parseHash().path); checkLicense(false); });
  licenseSeen = licenseSignature(store.settings);
  setInterval(() => checkLicense(true), LICENSE_CHECK_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkLicense(true); });   // Tablet aus dem Ruhezustand: gleich prüfen
  navigate();
}

export const currentPath = () => current;
