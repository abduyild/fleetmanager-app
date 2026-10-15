// Render-Helfer der Standalone-App: HTML-Escaping, Rendern, Ereignis-Delegation, Toast, Admin-Rahmen, Sheets, PIN-Sperre.
import { store } from "./store.js";
import { t, fill, sha256Hex } from "./model.js";
import { formatCode, normalizeCode } from "./codes.js";
import { icon } from "./icons.js";
import { accentVars, isHexColor, DEFAULT_ACCENT } from "./color.js";
import { licenseInfo, writeAllowed, licenseHeadline, licenseDetail, licenseNotice } from "./license.js";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// html`…${wert}…`: Werte werden escaped; mit raw(str) eingefügtes HTML nicht. Arrays werden verbunden.
export function html(strings, ...values) {
  let out = "";
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) {
      const v = values[i];
      if (v instanceof Raw) out += v.s;
      else if (Array.isArray(v)) out += v.map((x) => (x instanceof Raw ? x.s : esc(x))).join("");
      else if (v === null || v === undefined || v === false) out += "";
      else out += esc(v);
    }
  });
  return new Raw(out);
}
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function render(el, content) { el.innerHTML = String(content); }

// Ereignis-Delegation: on(root, "click", ".btn", (ev, el) => …). Liefert eine Abmelde-Funktion;
// optional {signal} eines AbortControllers. Der Router gibt jedem Screen einen frischen Wurzelknoten,
// Listener darauf verschwinden also mit dem Screen.
export function on(root, type, selector, handler, { signal } = {}) {
  const fn = (ev) => {
    const el = ev.target.closest(selector);
    if (el && root.contains(el)) handler(ev, el);
  };
  root.addEventListener(type, fn, { signal });
  return () => root.removeEventListener(type, fn);
}
// Eingabefeld für Aktivierungscodes und Gerätekennungen: beim Tippen Großbuchstaben, ein Strich nach dem dritten Zeichen (Code: höchstens sechs Zeichen)
// bzw. nach dem vierten (Gerätekennung: formatCodeField(input, formatDeviceId), höchstens acht). Der Cursor bleibt hinter dem Zeichen, das man gerade
// getippt hat (auch beim Ändern mitten im Text). Aufruf im input-Ereignis: formatCodeField(input).
export function formatCodeField(input, format = formatCode) {
  const caret = input.selectionStart;
  const symbolsBefore = caret === null || caret === undefined ? null : normalizeCode(input.value.slice(0, caret)).length;
  const formatted = format(input.value);
  if (formatted === input.value) return;
  input.value = formatted;
  if (symbolsBefore === null) return;
  let at = 0, seen = 0;
  while (at < formatted.length && seen < symbolsBefore) { if (formatted[at] !== "-") seen++; at++; }
  try { input.setSelectionRange(at, at); } catch (_) { /* Feld ohne Auswahl: der Cursor bleibt am Ende */ }
}
// Formularwerte als Objekt (Mehrfachfelder als Array)
export function formData(form) {
  const out = {};
  for (const [k, v] of new FormData(form)) {
    if (k in out) out[k] = [].concat(out[k], v);
    else out[k] = v;
  }
  return out;
}
export const formList = (form, name) => [...form.querySelectorAll(`[name="${name}"]:checked`)].map((i) => i.value);

// --- Navigation ---------------------------------------------------------------------------------
export const go = (route) => { location.hash = "#" + route; };

// --- Toast (flüchtige Rückmeldung unten; die Id #app-flash bleibt, Tests und Screens kennen sie) -------------------------
// cat: "success" (Standard), "error" (mit Symbol, 10 s), "warn" oder "" – ein neuer Toast ersetzt den alten.
// button: { label, onClick } als Aktion rechts im Toast (z. B. „Nr. 15 aufrufen“).
let flashTimer = null;
export function flash(text, cat = "success", { button = null, ms = cat === "error" ? 10000 : 6000 } = {}) {
  let el = $("#app-flash");
  if (!el) { el = document.createElement("div"); el.id = "app-flash"; el.setAttribute("role", "status"); document.body.appendChild(el); }
  clearTimeout(flashTimer);
  el.className = ("toast " + cat).trim();
  el.replaceChildren();
  if (cat === "error") el.insertAdjacentHTML("beforeend", String(icon("alert")));
  const msg = document.createElement("span");
  msg.className = "toast-text";
  msg.textContent = text;
  el.appendChild(msg);
  if (button) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "btn"; b.textContent = button.label;
    b.addEventListener("click", () => { hideFlash(); button.onClick(); });
    el.appendChild(b);
  }
  el.hidden = false;
  flashTimer = setTimeout(hideFlash, ms);
}
export function hideFlash() { const el = $("#app-flash"); if (el) el.hidden = true; }

// Einmalige Meldung für die nächste Seite (z. B. nach Speichern + Navigation)
let pending = null;
export const flashNext = (text, cat = "success") => { pending = { text, cat }; };
export function showPendingFlash() { if (pending) { flash(pending.text, pending.cat); pending = null; } }

// --- Sheet: <dialog class="sheet|confirm|privacy-dialog"> modal öffnen --------------------------------------------------
// Behandelt Öffnen, Escape (nativ), Tipp auf das Scrim und die Fokusrückgabe an den Auslöser. Liefert ein Promise, das beim
// Schließen mit dialog.returnValue erfüllt wird: "" = Escape/Schließen ohne Wert, "backdrop" = Scrim-Tipp, sonst der value
// des Buttons (<button value="ok" formmethod="dialog"> in einem <form method="dialog">). Fokus zuerst auf [autofocus], sonst
// auf das erste Bedienelement im Inhalt (.sheet-b bzw. den Dialog selbst), nicht auf das Schließen-Kreuz im Kopf.
export function openSheet(dialog, { opener = document.activeElement } = {}) {
  return new Promise((resolve) => {
    if (!dialog || typeof dialog.showModal !== "function" || dialog.open) { resolve(""); return; }   // schon offen (Doppeltipp): nichts doppelt anhängen
    const finish = () => {
      dialog.removeEventListener("click", onBackdrop);
      dialog.removeEventListener("close", finish);
      if (opener && opener.isConnected && typeof opener.focus === "function") { try { opener.focus({ preventScroll: true }); } catch (_) { /* Auslöser weg */ } }
      resolve(dialog.returnValue || "");
    };
    const onBackdrop = (ev) => {
      if (ev.target !== dialog) return;            // das Scrim (::backdrop) gehört zum Dialog-Element …
      const r = dialog.getBoundingClientRect();    // … Klicks daneben liegen außerhalb seines Kastens
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) dialog.close("backdrop");
    };
    dialog.addEventListener("click", onBackdrop);
    dialog.addEventListener("close", finish);
    dialog.returnValue = "";
    dialog.showModal();
    const first = dialog.querySelector("[autofocus]") || dialog.querySelector(".sheet-b :is(input, select, textarea, button, a[href]):not([disabled])");
    if (first) first.focus({ preventScroll: true });
  });
}

// --- Marke: Logo, Farbe, Titel -------------------------------------------------------------------
export function logoURL(cfg = store.settings) { return cfg.logo || "./icons/oifach-logo.svg"; }   // ohne eigenes Logo: das Logo des Anbieters (Marke + Wortmarke, SVG)
// Setzt --accent und die abgeleiteten lesbaren Varianten (--on-accent, --accent-ink, --accent-tint, --live…, siehe color.js)
export function applyBrand(cfg = store.settings) {
  const vars = accentVars(isHexColor(cfg.accent_color) ? cfg.accent_color : DEFAULT_ACCENT);
  const style = document.documentElement.style;
  for (const [name, value] of Object.entries(vars)) style.setProperty(name, value);
}
export const logo = (cfg = store.settings) => html`<span class="logo"><img src="${logoURL(cfg)}" alt="${cfg.brand_name}"></span>`;
export const T = (key, extra) => t(store.settings, key, extra);
export const F = (text, extra) => fill(store.settings, text, extra);

// --- Admin-Sperre (Stand-PIN) ---------------------------------------------------------------------
// Entsperrt gilt für die Browser-Sitzung; Kiosk-/Kundenansichten sperren wieder (lock()), damit ein
// weitergereichtes Tablet keinen Admin-Zugang mehr hat.
const UNLOCK_KEY = "fm_admin_unlocked";
export const hasPin = () => !!store.settings.admin_pin_hash;
export const unlocked = () => !hasPin() || sessionStorage.getItem(UNLOCK_KEY) === "1";
export const unlock = () => sessionStorage.setItem(UNLOCK_KEY, "1");
export const lock = () => sessionStorage.removeItem(UNLOCK_KEY);
export async function hashPin(pin, salt = null) {
  salt = salt || [...crypto.getRandomValues(new Uint8Array(8))].map((x) => x.toString(16).padStart(2, "0")).join("");
  return "sha256:" + salt + ":" + (await sha256Hex(salt + ":" + pin));
}
export async function checkPin(pin) {
  const stored = store.settings.admin_pin_hash;
  if (!stored) return true;
  const [, salt] = stored.split(":");
  return (await hashPin(pin, salt)) === stored;
}

// --- Verbindung zum Stand-Laptop (nur im Hub-Betrieb, siehe store.hub) -----------------------------------
// Ruhig im Normalfall: grüner Punkt in der Leiste (Wort „Verbunden“ erst ab 1000 px, mit Adresse ab 1280 px, siehe CSS).
// Laut im Problemfall: roter Punkt + „Offline“ in der Leiste und ein Fehler-Banner oben im Screen. Tipp auf den Punkt → Start.
const hubState = () => (store.hub.online
  ? ["online", "Verbunden · " + String(store.hub.url).replace(/^https?:\/\//, ""), "Verbunden", "Verbunden mit dem Stand-Laptop"]
  : ["offline", "Keine Verbindung zum Laptop", "Offline", "Offline – keine Verbindung zum Stand-Laptop"]);
const hubText = ([, wide, narrow]) => html`<span class="hub-wide">${wide}</span><span class="hub-narrow">${narrow}</span>`;
export const hubBadge = () => {
  if (!store.hub) return "";
  const st = hubState();
  return html`<a class="hub-state ${st[0]}" href="#/" title="${st[3]}" aria-label="${st[3]}">${hubText(st)}</a>`;
};
const connBanner = () => (store.hub && !store.hub.online
  ? html`<p class="banner error">${icon("alert")}<span><strong>Keine Verbindung zum Stand-Laptop.</strong> Du siehst den letzten bekannten Stand. Änderungen sind erst wieder möglich, wenn die Verbindung steht.</span></p>`
  : "");
// Wechselt der Zustand, werden nur Punkt und Banner angepasst – die Seite wird nicht neu gerendert.
store.subscribe(() => {
  if (!store.hub) return;
  const st = hubState();
  for (const el of $$(".hub-state")) {
    el.className = "hub-state " + st[0];
    el.innerHTML = hubText(st);
    el.title = st[3]; el.setAttribute("aria-label", st[3]);
  }
  const box = $("#conn-banner");
  if (box) { const next = String(connBanner()); if (box.innerHTML !== next) box.innerHTML = next; }
});

// --- Einrichtung: was ist offen? ----------------------------------------------------------------------
// Auf Start und in den Einstellungen als EIN Banner gebündelt, überall sonst nur als Punkt am Zahnrad.
export function setupIssues(cfg = store.settings) {
  const out = [];
  if (!hasPin()) {
    out.push({ key: "pin", href: "#/admin/einstellungen?zu=pin",
      text: store.hub ? "Stand-PIN fehlt – im WLAN hat jedes Gerät Zugriff" : "Stand-PIN fehlt" });
  }
  if (String(cfg.privacy_text || "").includes("Platzhalter")) {
    out.push({ key: "privacy", href: "#/admin/einstellungen?zu=rechtliches", text: "Datenschutztext ist noch Platzhalter" });
  }
  return out;
}
// --- Lizenz (license.js) -----------------------------------------------------------------------------
// Gesperrt (abgelaufen, noch nicht gültig): ein Fehler-Banner auf JEDER Admin-Seite – Aufrufen, Starten und Anlegen gehen nicht mehr,
// Export, Backup und Löschen schon. Läuft die Lizenz nur bald ab oder ist in der Kulanzfrist, steht eine Zeile im gebündelten Hinweis auf
// Start und Einstellungen (unten). Der Weg zur Lösung ist immer derselbe: „Code eingeben“ führt zu #/aktivieren (dort auch der lange
// Lizenzschlüssel). Ganz ohne Lizenz (none/invalid) kommt der Admin gar nicht erst zur Anzeige: der Router zeigt dann nur #/aktivieren.
const ACTIVATE_HREF = "#/aktivieren";
const licenseError = () => {
  const st = licenseInfo(store.settings);
  if (writeAllowed(st)) return "";
  return html`<p class="banner error" id="license-banner" data-license-state="${st.state}">${icon("alert")}<span><strong>${licenseHeadline(st)}</strong> – ${licenseDetail(st)} <a href="${ACTIVATE_HREF}" data-activate>Code eingeben</a></span></p>`;
};
// Ein gebündeltes Banner (statt gestapelter Hinweise): Zeile „Einrichtung unvollständig …“ und/oder Zeile zur Lizenz
const setupBanner = () => {
  const issues = setupIssues(), st = licenseInfo(store.settings), note = licenseNotice(st);
  if (!issues.length && !note) return "";
  return html`<p class="banner warn" id="notice-banner">${icon("alert")}<span class="notice-lines">${issues.length
    ? html`<span class="notice-line" data-notice="setup"><strong>Einrichtung unvollständig:</strong> ${issues.map((i, n) => html`${n ? " · " : ""}<a href="${i.href}">${i.text}</a>`)}</span>` : ""}${note
    ? html`<span class="notice-line" data-notice="license" data-license-state="${st.state}">${note} · <a href="${ACTIVATE_HREF}" data-activate>Code eingeben</a></span>` : ""}</span></p>`;
};

// Alles, wovon die Admin-Leiste samt Hinweisen abhängt. Ändert sich der Schlüssel, muss die ganze Seite neu gerendert
// werden; sonst genügt es, Liste und Kacheln zu erneuern (Kopfleiste, Tabs und Scroll-Position bleiben unberührt).
// Der Hub-Zustand (online/offline) gehört NICHT hinein – ihn aktualisiert der subscribe-Handler oben an Ort und Stelle.
export function shellKey() {
  const c = store.settings, logoSrc = String(c.logo || ""), lic = licenseInfo(c);
  return [c.module_queue, c.module_leads, c.brand_name, c.accent_color, logoSrc.length, logoSrc.slice(-24),
    setupIssues(c).map((i) => i.key).join(","), !!store.hub, lic.state, lic.daysLeft].join("|");   // Lizenz: Zustand und Resttage bestimmen die Hinweise
}

// --- Admin-Rahmen: einzeilige Leiste (Logo · Tabs ab 720 px · Verbindung · Tablet · Einstellungen · Sperren), Tab-Leiste unten
// (< 720 px), Hinweise, Inhalt. Das gebündelte Banner (Einrichtung, Lizenz bald zu Ende) steht nur auf Start und Einstellungen
// (active "start" / "settings"); pinBanner: false unterdrückt es dort. Das rote Lizenz-Banner (gesperrt) steht auf JEDER Seite.
// wide: breitere Seite (Warteschlange mit zwei Spalten ab 1000 px).
export function adminShell(active, content, { title = "Admin", pinBanner = true, wide = false } = {}) {
  const cfg = store.settings;
  document.title = `${title} – ${cfg.brand_name}`;
  const tabs = [
    ["start", "/", "Start", "home"],
    ...(cfg.module_queue ? [["queue", "/admin/warteschlange", "Warteschlange", "list"], ["vehicles", "/admin/fahrzeuge", "Fahrzeuge", "car"]] : []),
    ...(cfg.module_leads ? [["leads", "/admin/interessenten", "Interessenten", "user"]] : []),
  ];
  const cur = (key) => (active === key ? "page" : "false");
  const open = setupIssues(cfg).length > 0;
  return html`
<header class="admin-bar">
  <a href="#/" class="logo-link" title="Zum Start">${logo(cfg)}</a>
  <nav class="tabs" aria-label="Bereiche">${tabs.map(([key, href, label]) => html`<a class="${active === key ? "active" : ""}" href="#${href}" aria-current="${cur(key)}">${label}</a>`)}</nav>
  <div class="bar-end bar-actions">
    ${hubBadge()}
    <a class="btn secondary has-lbl bar-kiosk" href="#/formular" title="Tablet an Kunden weitergeben – Admin wird gesperrt" aria-label="Tablet weitergeben – Admin wird gesperrt">${icon("tablet")}<span class="lbl">Tablet weitergeben</span></a>
    <a class="btn quiet icon bar-settings${active === "settings" ? " active" : ""}" href="#/admin/einstellungen" title="Einstellungen" aria-label="${open ? "Einstellungen – Einrichtung unvollständig" : "Einstellungen"}" aria-current="${cur("settings")}">${icon("sliders")}${open ? html`<span class="dot-badge" aria-hidden="true"></span>` : ""}</a>
    <button type="button" class="btn quiet icon" id="admin-lock" title="Sperren" aria-label="Sperren">${icon("lock")}</button>
  </div>
</header>
<main class="admin-main${wide ? " wide" : ""}">
  <div id="conn-banner" aria-live="polite">${connBanner()}</div>
  ${licenseError()}
  ${pinBanner && (active === "start" || active === "settings") ? setupBanner() : ""}
  ${content}
</main>
<nav class="tabbar" aria-label="Bereiche">${tabs.map(([key, href, label, ic]) => html`<a class="${active === key ? "active" : ""}" href="#${href}" aria-current="${cur(key)}">${icon(ic, "lg")}<span>${label}</span></a>`)}</nav>`;
}

// Chip-Zeile für Exporte usw. (alt; neue Screens nehmen .btn bzw. .seg.pick)
export const chip = (href, label, cls = "") => html`<a class="chip ${cls}" href="${href}">${label}</a>`;

// Bestätigungsdialog (Browser-confirm; auf Tablets ausreichend)
export const ask = (text) => window.confirm(text);

// In die Zwischenablage kopieren (Gerätekennung, Codes, Links): navigator.clipboard gibt es nur in sicheren Kontexten (https, localhost); sonst ein
// unsichtbares Feld und execCommand. → true, wenn kopiert wurde; der Aufrufer zeigt den Toast (bei false: „bitte von Hand kopieren“).
export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  } catch (_) { /* Rückfall */ }
  const area = document.createElement("textarea");
  area.value = text;
  area.className = "sr-only";
  area.setAttribute("readonly", "");
  document.body.appendChild(area);
  area.select();
  let copied = false;
  try { copied = document.execCommand("copy"); } catch (_) {}
  area.remove();
  return copied;
}
