// Einstellungen (/admin/einstellungen): Formular aus model.SETTINGS_SCHEMA, gruppiert statt einer langen Liste (ui-review.md §5.7).
// Täglich zuerst: Stand-PIN (#pin), Daten & Backup (#daten), Vor der Fahrt prüfen (#checks). Dann Module (Schalter speichern sofort),
// dann die einmalige Einrichtung: Marke (Karte) sowie Texte und Rechtliches (#rechtliches) hinter Aufklapp-Zeilen. Alles außer den
// Schaltern ändert EIN Formular (#settings-form); der feste Fuß „Speichern“ erscheint, sobald ein Feld geändert ist, und schreibt nur
// die geänderten Felder zurück (im Hub-Betrieb hat ein anderes Gerät die übrigen vielleicht inzwischen geändert).
// Standalone: Logo als data:-URL im Speicher, alles bleibt auf diesem Gerät (IndexedDB) – im Hub-Betrieb liegt es auf dem Laptop.
// Karte „Lizenz“ (#lizenz, Sprungmarke ?zu=lizenz) in „Sicherheit & Daten“: Zustand der Lizenz (Quelle, Kunde, gültig bis), die Gerätekennung dieses Geräts
// und ein Feld für einen neuen Aktivierungscode – derselbe Prüfweg wie auf #/aktivieren (license.js). Ein langer Lizenzschlüssel wird nur dort eingegeben.
// Die Karte „Daten & Backup“ verweist, solange die App nur im Browser läuft, auf die Anleitung zum Installieren (#/installieren, screens/install.js).
import { register } from "../router.js";
import { html, render, $, flash, adminShell, logoURL, applyBrand, hasPin, hashPin, unlock, ask, formatCodeField, copyText } from "../ui.js";
import { icon } from "../icons.js";
import { store } from "../store.js";
import { SETTINGS_SCHEMA, DEFAULT_SETTINGS, intRange, lines, deDay } from "../model.js";
import { downloadJSON } from "../export.js";
import { deviceId } from "../codes.js";
import { licenseInfo, checkActivationCode, saveDeviceCode, licenseAfterRestore } from "../license.js";
import { isStandalone } from "../install.js";

const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];
const LOGO_EXT_RE = /\.(png|jpe?g|webp|svg)$/i; // Rückfall, wenn der Browser keinen MIME-Typ liefert
const COLOR_RE = /^#[0-9a-f]{6}$/;
const PIN_MIN = 4, PIN_MAX = 12;
// Vorschläge unter „Vor der Fahrt prüfen“: ein Tipp hängt die Zeile an (sofern sie noch nicht dasteht)
const CHECK_SUGGESTIONS = ["Führerschein gesehen", "Ausweis gesehen", "Einweisung erfolgt", "Fahrzeug gesichtet", "Probefahrtvereinbarung unterschrieben", "Begleiter dabei"];
const CHECK_KEYS = ["start_checks", "staff"];   // gehören in die Karte #checks, nicht in die Faltgruppe „Zeiten und Nachricht“

// --- Ansicht ------------------------------------------------------------------------------------
const help = (text) => (text ? html`<small class="help">${text}</small>` : "");
const defOf = (key) => SETTINGS_SCHEMA.flatMap(([, fields]) => fields).find(([k]) => k === key);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// Ein Feld nach Schema-Art. Schalter (bool) sind Zeilen mit Schalter rechts und speichern sofort (data-live).
// opts: hideLabel (Beschriftung nur für Screenreader), showHint (Hilfetext unter dem Feld), rows (Höhe von Textfeldern)
function field(cfg, [key, label, kind, hint], { hideLabel = false, showHint = true, rows = 0 } = {}) {
  const value = cfg[key] ?? "";
  const lbl = hideLabel ? html`<span class="sr-only">${label}</span>` : html`<span class="lbl">${label}</span>`;
  const note = showHint ? help(hint) : "";
  switch (kind) {
    case "bool":
      return html`
      <label class="setrow">
        <span class="grow"><span class="ttl">${label}</span>${hint ? html`<span class="desc">${hint}</span>` : ""}</span>
        <input type="checkbox" role="switch" name="${key}" data-live${value ? " checked" : ""}>
        <span class="sw"></span>
      </label>`;
    case "file":
      return html`
      <div class="field">
        <span class="lbl">${label}</span>
        <div class="s-logo">
          <img class="preview ${key}" src="${key === "logo" ? logoURL(cfg) : value}" alt="">
          <label class="btn secondary">${label} wählen …<input type="file" name="${key}" accept="${LOGO_TYPES.join(",")}" class="sr-only"></label>
        </div>
        ${value ? html`<label class="inline-check"><input type="checkbox" name="${key}_reset"> Standard wiederherstellen</label>` : ""}
        ${note}
      </div>`;
    case "color":
      return html`
      <div class="field">
        <label class="lbl" for="f-${key}">${label}</label>
        <div class="s-color">
          <input type="color" id="f-${key}" name="${key}" value="${value}">
          <input type="text" class="s-hex" id="${key}-hex" value="${value}" maxlength="7" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="${label} als Hex-Wert">
        </div>
        ${note}
      </div>`;
    case "int": {
      const [lo, hi] = intRange(key);
      return html`
      <label class="field small-field">
        ${lbl}
        <input type="number" name="${key}" value="${value}" min="${lo}" max="${hi}">
        ${note}
      </label>`;
    }
    case "textarea":
    case "lines":
      return html`
      <label class="field">
        ${lbl}
        <textarea name="${key}" rows="${rows || (kind === "lines" ? 3 : 4)}">${value}</textarea>
        ${note}
      </label>`;
    default:
      return html`
      <label class="field">
        ${lbl}
        <input name="${key}" value="${value}">
        ${note}
      </label>`;
  }
}

const groupHead = (title, aside = "") => html`<div class="sec small"><h2>${title}</h2>${aside ? html`<span class="aside">${aside}</span>` : ""}</div>`;
const placeholderHint = () => html`<p class="help s-ph">Platzhalter in Texten: <code>{marke}</code> <code>{firma}</code> <code>{adresse}</code> <code>{email}</code>
  – so musst du für eine andere Marke nur Name, Logo, Farbe und Firma ändern.</p>`;
// Aufklapp-Zeile (zu, solange niemand sie öffnet): Titel, optional ein Wert rechts, darunter eine Karte mit den Feldern
function fold(id, title, body, { value = "", open = false } = {}) {
  return html`
    <details class="s-fold" id="${id}"${open ? " open" : ""}>
      <summary class="disclosure"><span class="d-ttl">${title}</span>${value}${icon("chevD")}</summary>
      <div class="card s-fold-body">${body}</div>
    </details>`;
}

function pinCard() {
  const set = hasPin();
  return html`
    <fieldset class="card settings-card" id="pin">
      <legend>Stand-PIN</legend>
      <span class="s-state">${set ? html`<span class="status free">Gesetzt</span>` : html`<span class="tag warn">Nicht gesetzt</span>`}</span>
      <p class="help s-lead">Schützt den Admin-Bereich auf diesem Gerät. 4–12 Zeichen. Leer lassen = keine Änderung.</p>
      <div class="s-pair">
        <label class="field"><span class="lbl">Neue PIN</span><input type="password" name="new_pin" inputmode="numeric" autocomplete="new-password"></label>
        <label class="field"><span class="lbl">Wiederholen</span><input type="password" name="new_pin2" inputmode="numeric" autocomplete="new-password"></label>
      </div>
      ${set ? html`<button type="button" class="btn danger" id="pin-remove">PIN entfernen</button>` : ""}
    </fieldset>`;
}

function dataCard(d) {
  const n = (count, one, many, key) => html`<span class="s-count"><b data-count="${key}">${count}</b> ${count === 1 ? one : many}</span>`;
  return html`
    <fieldset class="card settings-card" id="daten">
      <legend>Daten &amp; Backup</legend>
      <p class="sub" id="daten-counts">${n(d.leads.length, "Interessent", "Interessenten", "leads")} · ${n(d.queue.length, "Eintrag", "Einträge", "queue")} · ${n(d.vehicles.length, "Fahrzeug", "Fahrzeuge", "vehicles")} · ${n(d.damages.length, "Schaden", "Schäden", "damages")}</p>
      <p class="help">${store.hub
        ? "Die Daten liegen auf dem Stand-Laptop und sind auf allen verbundenen Geräten gleich; dieses Gerät merkt sich den letzten Stand. Ein Backup sichert den Stand des Laptops."
        : "Die Daten liegen nur auf diesem Gerät. Vor dem Löschen der App oder einem Gerätewechsel ein Backup sichern."}</p>
      <p class="help" id="storage-state">${store.persistent
        ? "Speicher ist als dauerhaft markiert – der Browser räumt die Daten nicht automatisch auf."
        : "Speicher ist nicht als dauerhaft markiert – bei Platzmangel könnte der Browser die Daten löschen. App zum Home-Bildschirm hinzufügen und regelmäßig ein Backup sichern."}</p>
      <div class="s-actions">
        <button type="button" class="btn secondary" id="backup-download">${icon("download")}Backup sichern</button>
        <label class="btn secondary">${icon("undo")}Backup wiederherstellen …<input type="file" id="backup-file" accept="application/json,.json" class="sr-only"></label>
      </div>
      ${isStandalone() ? "" : html`<div class="install-hint">
        <p class="help">Zum Home-Bildschirm hinzufügen: Die App startet dann wie jede andere App und läuft auch ohne Internet.</p>
        <a class="btn secondary" href="#/installieren" data-install-link>${icon("download")}Anleitung zum Installieren</a>
      </div>`}
      <p class="group-lbl">Zurücksetzen</p>
      <div class="s-actions">
        <button type="button" class="btn danger" id="settings-reset">${icon("undo")}Einstellungen auf Standard</button>
        <button type="button" class="btn danger" id="data-clear">${icon("trash")}Alle Daten löschen …</button>
      </div>
    </fieldset>`;
}

// Karte „Lizenz“: Zustand (Punkt + Wort), Quelle, Kunde, Ende der Lizenz und die Gerätekennung dieses Geräts (zum Schicken an den Anbieter, mit „Kopieren“),
// darunter das Feld für einen neuen Aktivierungscode. Das Feld hat keinen name – es gehört nicht zum Einstellungsformular (kein Fuß „Speichern“); die Karte
// prüft und speichert selbst (saveLicenseCode). Der Code gilt nur für dieses Gerät und liegt in dessen Gerätespeicher, nicht in den Einstellungen.
const LICENSE_STATE = {   // Zustand → [Wort, Punktfarbe von .status]
  valid: ["Gültig", "free"], expiring: ["Läuft bald ab", "called"], grace: ["Kulanzfrist", "called"], expired: ["Abgelaufen", "late"],
  not_yet_valid: ["Noch nicht gültig", "wait"], invalid: ["Ungültig", "late"], none: ["Keine Lizenz", "late"],
};
const LICENSE_SOURCE = { code: "Aktivierungscode", key: "Lizenzschlüssel", hub: "Aktivierung des Stand-Laptops (geteilt)" };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function licenseCard(cfg) {
  const st = licenseInfo(cfg);
  const [word, dot] = LICENSE_STATE[st.state];
  const device = deviceId();
  const deviceRow = html`<dt>Gerätekennung</dt><dd class="lic-device"><span class="lic-device-id" id="device-id">${device}</span><button type="button" class="btn secondary sm" data-copy-device="${device}">${icon("copy")}Kopieren</button></dd>`;
  let facts;
  if (st.state === "invalid" || st.state === "none") {
    facts = html`<p class="help s-lead" data-license="reason">${st.state === "none" ? "Es ist keine Lizenz hinterlegt." : "Die gespeicherte Lizenz ist ungültig."} Bitte unten einen gültigen Code eingeben.</p>
      <dl class="lic-facts" data-license="facts">${deviceRow}</dl>`;
  } else {
    const left = st.daysLeft === null ? "" : st.state === "grace"
      ? ` · ${st.daysLeft === 0 ? "Kulanzfrist endet heute" : `noch ${plural(st.daysLeft, "Tag", "Tage")} Kulanz`}`
      : st.daysLeft === 0 ? " · endet heute" : ` · noch ${plural(st.daysLeft, "Tag", "Tage")}`;
    facts = html`<dl class="lic-facts" data-license="facts">
      <dt>Quelle</dt><dd>${LICENSE_SOURCE[st.source] || ""}</dd>
      <dt>Kunde</dt><dd>${st.brand ? `${st.customer} · ${st.brand}` : st.customer}</dd>
      <dt>${st.state === "grace" || st.state === "expired" ? "Abgelaufen am" : "Gültig bis"}</dt><dd>${deDay(st.exp)}${left}</dd>
      ${deviceRow}
    </dl>`;
  }
  return html`
    <fieldset class="card settings-card" id="lizenz" data-license-state="${st.state}" data-license-source="${st.source}">
      <legend>Lizenz</legend>
      <span class="s-state"><span class="status ${dot}" data-license="state">${word}</span></span>
      ${facts}
      <label class="field">
        <span class="lbl">Neuer Aktivierungscode</span>
        <input type="text" id="license-code-input" class="code-input" placeholder="XXX-XXX" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" aria-describedby="license-code-help">
        <small class="help" id="license-code-help">Gilt nur für die Gerätekennung oben – diese schicken Sie dem Anbieter, um einen Code zu erhalten.</small>
      </label>
      <div id="license-code-msg" aria-live="polite"></div>
      <div class="s-actions"><button type="button" class="btn primary" id="license-code-save">Code prüfen und speichern</button></div>
    </fieldset>`;
}

// Vorschläge, die noch nicht in der Liste stehen (Groß-/Kleinschreibung egal)
function suggestionChips(text) {
  const have = new Set(lines(text).map((l) => l.toLowerCase()));
  const open = CHECK_SUGGESTIONS.filter((s) => !have.has(s.toLowerCase()));
  if (!open.length) return "";
  return html`<p class="group-lbl">Vorschläge</p>
    <div class="suggest">${open.map((s) => html`<button type="button" class="btn secondary sm" data-check="${s}">${icon("plus")}${s}</button>`)}</div>`;
}
// Karte „Vor der Fahrt prüfen“: die Prüfliste (start_checks) samt Vorschlägen und die Begleiter (staff)
function checksCard(cfg) {
  const checks = defOf("start_checks"), staff = defOf("staff");
  if (!checks) return "";
  return html`
    <fieldset class="card settings-card" id="checks">
      <legend>Vor der Fahrt prüfen</legend>
      <p class="help s-lead">${checks[3]}</p>
      ${field(cfg, checks, { hideLabel: true, showHint: false, rows: 4 })}
      <div id="check-suggest">${suggestionChips(cfg.start_checks)}</div>
      ${staff ? html`<div class="s-split">${field(cfg, staff)}</div>` : ""}
    </fieldset>`;
}

function view(openGroups) {
  const cfg = store.settings;
  const sec = new Map(SETTINGS_SCHEMA);
  const take = (title) => { const fields = sec.get(title) || []; sec.delete(title); return fields; };
  const brand = take("Marke"), modules = take("Module"), probe = take("Probefahrt"), legal = take("Rechtliches");
  const texts = [...sec];   // übrige Abschnitte in Schema-Reihenfolge („Texte – …“, später hinzukommende erscheinen hier von selbst)
  const times = probe.filter(([key]) => !CHECK_KEYS.includes(key));
  const placeholderLegal = String(cfg.privacy_text || "").includes("Platzhalter");
  const isOpen = (id) => openGroups.has(id);
  const texted = (fields) => html`${placeholderHint()}${fields.map((f) => field(cfg, f))}`;
  return html`
  <div class="page-head"><h1 class="title">Einstellungen</h1></div>

  <form id="settings-form" class="settings-form" data-action="save" novalidate autocomplete="off">
    <section class="s-group">
      ${groupHead("Sicherheit & Daten")}
      <div class="s-stack">${pinCard()}${dataCard(store.data)}${licenseCard(cfg)}</div>
    </section>

    ${probe.length ? html`
    <section class="s-group">
      ${groupHead("Probefahrt")}
      <div class="s-stack">
        ${checksCard(cfg)}
        ${times.length ? fold("zeiten", "Zeiten und Nachricht", html`${times.map((f) => field(cfg, f))}`, {
          open: isOpen("zeiten"), value: html`<span class="d-val">überfällig ab ${cfg.max_drive_minutes} Min.</span>` }) : ""}
      </div>
    </section>` : ""}

    ${modules.length ? html`
    <section class="s-group">
      ${groupHead("Module")}
      <div class="list s-mod">${modules.map((f) => field(cfg, f))}</div>
    </section>` : ""}

    <section class="s-group">
      ${groupHead("Marke & Texte", "einmalige Einrichtung")}
      <div class="s-stack">
        ${brand.length ? html`
        <fieldset class="card settings-card" id="marke">
          <legend>Marke</legend>
          ${brand.map((f) => field(cfg, f))}
        </fieldset>` : ""}
        ${texts.map(([title, fields]) => fold(slug(title), title, texted(fields), { open: isOpen(slug(title)) }))}
        ${legal.length ? fold("rechtliches", "Rechtliches", texted(legal), {
          open: isOpen("rechtliches"), value: placeholderLegal ? html`<span class="tag warn d-tag">Platzhalter</span>` : "" }) : ""}
      </div>
    </section>

    <div class="sticky-save" hidden><button type="submit" class="btn primary lg block">Speichern</button></div>
  </form>`;
}

// --- Speichern ----------------------------------------------------------------------------------
// Hat der Nutzer dieses Feld seit dem Rendern verändert? (defaultValue/defaultChecked = Stand beim Rendern)
function changed(input) {
  if (!input.name) return false;
  if (input.type === "file") return !!(input.files && input.files.length);
  if (input.type === "checkbox" || input.type === "radio") return input.checked !== input.defaultChecked;
  return input.value !== input.defaultValue;
}
const isDirty = (form) => [...form.elements].some(changed);
// Der Fuß „Speichern“ ist nur da, solange etwas ungespeichert ist
function syncSave(form) {
  const bar = $(".sticky-save", form);
  if (bar) bar.hidden = !isDirty(form);
}
const readDataURL = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(r.error || new Error("Lesefehler"));
  r.readAsDataURL(file);
});
const isLogoType = (f) => LOGO_TYPES.includes(f.type) || (!f.type && LOGO_EXT_RE.test(f.name || ""));

// Liest alle Schema-Felder und die PIN aus dem Formular; fehlerhafte Felder werden gemeldet und nicht
// übernommen, die übrigen trotzdem gespeichert (wie die Go-Version). Alles in EINEM store.update.
async function save(form) {
  const updates = {}, errs = [], bad = [];
  const fail = (msg, key) => { errs.push(msg); if (key) bad.push(key); };
  const elem = (name) => form.elements.namedItem(name);
  for (const [, fields] of SETTINGS_SCHEMA) {
    for (const [key, label, kind] of fields) {
      const input = elem(key);
      if (!input) continue;
      // Unveränderte Felder nicht zurückschreiben: ein anderes Gerät kann sie inzwischen geändert haben (Hub)
      if (kind !== "file" && !changed(input)) continue;
      switch (kind) {
        case "bool":
          updates[key] = !!input.checked;
          break;
        case "int": {
          const s = String(input.value).trim();
          if (!/^-?\d+$/.test(s)) { fail(`${label}: bitte eine Zahl eingeben.`, key); break; }
          const [lo, hi] = intRange(key);
          updates[key] = Math.min(Math.max(parseInt(s, 10), lo), hi);
          break;
        }
        case "color": {
          const v = String(input.value).trim().toLowerCase();
          if (COLOR_RE.test(v)) updates[key] = v;
          break;
        }
        case "file": {
          const reset = elem(key + "_reset");
          if (reset && reset.checked) { updates[key] = ""; break; }
          const f = input.files && input.files[0];
          if (!f) break;
          if (f.size > MAX_LOGO_BYTES) { fail("Datei ist zu groß (max. 2 MB).", key); break; }
          if (!isLogoType(f)) { fail(`${label}: Dateityp nicht erlaubt (PNG, JPG, WebP, SVG).`, key); break; }
          try { updates[key] = await readDataURL(f); } catch (e) { fail(`${label}: Datei konnte nicht gelesen werden.`, key); }
          break;
        }
        default: // text, textarea, lines
          updates[key] = String(input.value).replace(/\r\n/g, "\n").trim();
      }
    }
  }
  if (typeof updates.interests === "string" && !lines(updates.interests).length) {
    fail("Bitte mindestens ein Interesse angeben.", "interests");
    delete updates.interests;
  }

  // Stand-PIN: nur über diese beiden Felder, nie über das Schema (admin_pin_hash steht nicht im Schema).
  const pin = elem("new_pin").value, pin2 = elem("new_pin2").value;
  let pinSet = false;
  if (pin || pin2) {
    const len = [...pin].length;
    if (pin !== pin2) fail("Die PINs stimmen nicht überein.", "new_pin");
    else if (len < PIN_MIN || len > PIN_MAX) fail("Die PIN muss 4–12 Zeichen haben.", "new_pin");
    else {
      // crypto.subtle gibt es nur in sicheren Kontexten (https, localhost, file:) – im LAN über http nicht.
      try { updates.admin_pin_hash = await hashPin(pin); pinSet = true; } catch (e) { fail("PIN konnte nicht gesetzt werden – die App bitte über https, localhost oder als installierte App öffnen.", "new_pin"); }
    }
  }

  const r = Object.keys(updates).length ? await store.update((d) => { Object.assign(d.settings, updates); }) : { ok: true };
  if (r.error) { flash(r.error, "error"); return; }
  if (pinSet) unlock(); // wer die PIN gerade gesetzt hat, bleibt in dieser Sitzung entsperrt
  applyBrand(store.settings);
  if (errs.length) {
    flash(errs.join(" "), "error");
    // das erste fehlerhafte Feld zeigen – auch wenn es in einer zugeklappten Gruppe liegt (der Screen wurde nach dem Speichern neu gezeichnet)
    const first = bad.length ? document.querySelector(`#settings-form [name="${bad[0]}"]`) : null;
    if (first) {
      const group = first.closest("details");
      if (group) group.open = true;
      first.focus();
    }
    return;
  }
  flash(pinSet ? "Einstellungen gespeichert. Stand-PIN gesetzt." : "Einstellungen gespeichert.");
}

// --- Backup, Zurücksetzen, Löschen -----------------------------------------------------------------
// Die Lizenz gehört zum Gerät, nicht zu den Daten: der Aktivierungscode liegt im Gerätespeicher (nicht im Backup) und bleibt, wie er ist; ein Backup ersetzt
// nur den langen Schlüssel, und nur wenn es einen echten bringt, der länger schreiben lässt als der des Geräts (sonst sperrte ein altes Backup die App) –
// siehe license.js: licenseAfterRestore.

async function restoreBackup(file) {
  let obj = null;
  try { obj = JSON.parse(await file.text()); } catch (e) { obj = null; }
  if (!obj || typeof obj !== "object") { flash("Die Datei ist kein gültiges Backup (JSON).", "error"); return; }
  if (!Array.isArray(obj.queue) || !Array.isArray(obj.leads)) { flash("Die Datei ist kein FleetManager-Backup.", "error"); return; }
  if (!ask(store.hub ? "Alle Daten auf dem Stand-Laptop und allen verbundenen Geräten durch das Backup ersetzen?" : "Alle Daten auf diesem Gerät durch das Backup ersetzen?")) return;
  const settings = obj.settings && typeof obj.settings === "object" && !Array.isArray(obj.settings) ? obj.settings : {};
  obj.settings = { ...settings, ...(await licenseAfterRestore(store.settings, settings)) };
  await store.replace(obj);
  unlock(); // die PIN aus dem Backup gilt ab jetzt – wer gerade wiederhergestellt hat, bleibt entsperrt
  applyBrand(store.settings);
  flash("Backup wiederhergestellt.");
}

async function resetSettings() {
  if (!ask("Alle Texte, Logo und Farben auf Standard zurücksetzen? (Daten, Stand-PIN und Lizenz bleiben erhalten)")) return;
  const r = await store.update((d) => { d.settings = { ...DEFAULT_SETTINGS, admin_pin_hash: d.settings.admin_pin_hash || "", license_key: d.settings.license_key || "" }; });   // der Code liegt im Gerätespeicher
  if (r.error) { flash(r.error, "error"); return; }
  applyBrand(store.settings);
  flash("Einstellungen auf Standard zurückgesetzt.");
}

async function clearData() {
  if (!ask(`Alle Interessenten, Warteschlangen-Einträge, Fahrzeuge und Schäden ${store.hub ? "auf dem Stand-Laptop und allen verbundenen Geräten" : "auf diesem Gerät"} löschen? Das lässt sich nicht rückgängig machen – vorher ein Backup sichern. (Einstellungen bleiben erhalten)`)) return;
  const r = await store.update((d) => { d.leads = []; d.queue = []; d.vehicles = []; d.damages = []; });
  if (r.error) { flash(r.error, "error"); return; }
  flash(store.hub ? "Alle Daten gelöscht – auch auf den verbundenen Geräten." : "Alle Daten auf diesem Gerät gelöscht.");
}

async function removePin() {
  if (!ask("Stand-PIN entfernen? Danach kann jeder mit diesem Gerät den Admin-Bereich öffnen.")) return;
  const r = await store.update((d) => { d.settings.admin_pin_hash = ""; });
  if (r.error) { flash(r.error, "error"); return; }
  flash("Stand-PIN entfernt.");
}

// --- Lizenz: Code prüfen und speichern -----------------------------------------------------------------------------
// Geprüft wird in license.js (checkActivationCode), dieselbe Prüfung wie auf #/aktivieren; der Grund einer Ablehnung steht im Kasten der Karte.
// Gespeichert wird im Gerätespeicher (saveDeviceCode), nicht in den Einstellungen: der Code gilt nur auf diesem Gerät. Ein langer Schlüssel bleibt, wie er ist.
async function saveLicenseCode(el) {
  const input = $("#license-code-input", el), box = $("#license-code-msg", el);
  if (!input || !box) return;
  box.replaceChildren();
  const check = checkActivationCode(input.value);
  if (check.error) { render(box, html`<p class="banner error">${icon("alert")}<span>${check.error}</span></p>`); input.focus(); return; }
  const stored = saveDeviceCode(check.code);   // benachrichtigt den Speicher: die Karte zeichnet sich neu
  if (stored) flash(`Aktiviert – gültig bis ${deDay(check.exp)}`);
  else flash("Aktiviert – aber der Browser speichert nichts: nach dem Schließen der Seite ist die Aktivierung weg.", "warn");
}

// Gerätekennung kopieren (Knopf in der Karte)
async function copyDevice(btn) {
  if (await copyText(btn.dataset.copyDevice)) flash("Gerätekennung kopiert.");
  else flash("Kopieren nicht möglich – bitte die Kennung markieren und von Hand kopieren.", "warn");
}

// --- Marke: Farbe (Farbfeld + Hex-Feld, Vorschau sofort), Logo-Vorschau -----------------------------------------
// „#f60“, „ff6600“ und „#FF6600“ werden zu „#ff6600“; sonst leer
function normHex(s) {
  let v = String(s).trim().toLowerCase();
  if (!v.startsWith("#")) v = "#" + v;
  if (/^#[0-9a-f]{3}$/.test(v)) v = "#" + [...v.slice(1)].map((c) => c + c).join("");
  return COLOR_RE.test(v) ? v : "";
}
// Die Markenfarbe wirkt schon beim Wählen auf die ganze App (Buttons, Schalter, Auswahl); gespeichert wird erst mit „Speichern“.
// Wer ohne Speichern geht, bekommt die gespeicherte Farbe zurück (Router und Screen-Abbau rufen applyBrand mit dem Speicher auf).
function previewBrand(form) {
  const color = form.elements.namedItem("accent_color");
  if (!color) return;
  applyBrand(changed(color) && COLOR_RE.test(color.value) ? { ...store.settings, accent_color: color.value } : store.settings);
}
function hexTyped(form, text) {
  const v = normHex(text.value);
  text.classList.toggle("invalid", !v && text.value.trim() !== "");
  if (!v) return;
  form.elements.namedItem("accent_color").value = v;
  previewBrand(form);
}
function hexCommitted(form, text) {
  const color = form.elements.namedItem("accent_color");
  const v = normHex(text.value);
  text.value = v || color.value;   // Ungültiges springt zurück auf die gewählte Farbe
  text.classList.remove("invalid");
  if (v) { color.value = v; previewBrand(form); }
}
let previewURL = ""; // Objekt-URL der Logo-Vorschau vor dem Speichern
function logoChosen(form, input) {
  const f = input.files && input.files[0], img = $("img.preview.logo", form);
  if (!f || !img || !isLogoType(f) || f.size > MAX_LOGO_BYTES) return;
  if (previewURL) URL.revokeObjectURL(previewURL);
  previewURL = URL.createObjectURL(f);
  img.src = previewURL;
}

// --- Prüfliste: Vorschläge anhängen ------------------------------------------------------------------------------
function syncSuggestions(form) {
  const box = $("#check-suggest", form), area = form.elements.namedItem("start_checks");
  if (box && area) box.innerHTML = String(suggestionChips(area.value));
}
function addCheck(form, chip, ev) {
  const area = form.elements.namedItem("start_checks");
  if (!area) return;
  const text = chip.dataset.check;
  if (!lines(area.value).some((l) => l.toLowerCase() === text.toLowerCase())) {
    area.value = area.value.replace(/\s+$/, "") + (area.value.trim() ? "\n" : "") + text;
    area.dispatchEvent(new Event("input", { bubbles: true }));   // Fuß „Speichern“ und Vorschlagsliste ziehen nach
  }
  if (ev.detail === 0) ($("#check-suggest [data-check]", form) || area).focus();   // per Tastatur: der Fokus bleibt in der Karte
}

// --- Schalter: speichern sofort --------------------------------------------------------------------------------
async function liveSwitch(input, ctx) {
  const key = input.name, value = input.checked;
  let r;
  try { r = await store.update((d) => { d.settings[key] = value; return { ok: true }; }); } catch (e) { r = { error: (e && e.message) || "Speichern fehlgeschlagen." }; }
  if (r.error) { input.checked = !value; flash(r.error, "error"); syncSave(input.form); return; }
  input.defaultChecked = value;   // ist jetzt gespeichert, zählt nicht mehr als Änderung
  flash("Gespeichert.");
  syncSave(input.form);
  ctx.softPaint();                // Tabs/Hinweise folgen (z. B. Modul aus), das Formular samt ungespeicherter Eingaben bleibt
}

// --- Screen -------------------------------------------------------------------------------------
let busy = false;

// Aktionen laufen nacheinander; ein Speicherfehler (z. B. voller Speicher) wird gemeldet statt verschluckt.
const guarded = (fn) => async (...args) => {
  if (busy) return;
  busy = true;
  try { await fn(...args); } catch (e) { flash("Aktion fehlgeschlagen: " + ((e && e.message) || e), "error"); } finally { busy = false; }
};

// Handler direkt an die (bei jedem Rendern neuen) Elemente – so entstehen beim erneuten Öffnen keine Duplikate.
function bind(el, ctx) {
  const form = $("#settings-form", el);
  form.addEventListener("submit", (ev) => { ev.preventDefault(); guarded(save)(form); });
  form.addEventListener("input", (ev) => {
    const t = ev.target;
    if (t.id === "license-code-input") formatCodeField(t);   // Aktivierungscode: Großbuchstaben, Strich nach dem dritten Zeichen
    else if (t.name === "start_checks") syncSuggestions(form);
    else if (t.name === "accent_color") { $("#accent_color-hex", form).value = t.value; previewBrand(form); }
    else if (t.id === "accent_color-hex") hexTyped(form, t);
    syncSave(form);
  });
  form.addEventListener("change", (ev) => {
    const t = ev.target;
    if (t.matches("[data-live]")) liveSwitch(t, ctx);
    else if (t.id === "accent_color-hex") hexCommitted(form, t);
    else if (t.name === "logo") logoChosen(form, t);
    syncSave(form);
  });
  form.addEventListener("click", (ev) => {
    const chip = ev.target.closest("[data-check]");
    if (chip) addCheck(form, chip, ev);
  });
  $("#backup-download", el).addEventListener("click", () => downloadJSON("fleetmanager-backup", store.backupJSON()));
  $("#backup-file", el).addEventListener("change", (ev) => {
    const f = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (f) guarded(restoreBackup)(f);
  });
  $("#settings-reset", el).addEventListener("click", guarded(resetSettings));
  $("#data-clear", el).addEventListener("click", guarded(clearData));
  const pinRemove = $("#pin-remove", el);
  if (pinRemove) pinRemove.addEventListener("click", guarded(removePin));
  $("#license-code-save", el).addEventListener("click", guarded(() => saveLicenseCode(el)));
  const copyBtn = $("[data-copy-device]", el);
  if (copyBtn) copyBtn.addEventListener("click", guarded(() => copyDevice(copyBtn)));
  syncSave(form);
}

function screen({ el, query }) {
  let alive = true;
  let pending = false;   // fremde Änderung liegt vor, Neu-Rendern wurde wegen laufender Eingabe verschoben
  const ac = new AbortController();
  const openGroups = new Set();   // geöffnete Aufklapp-Zeilen: überleben das Neu-Zeichnen
  if (query.zu) openGroups.add(query.zu);   // ?zu=rechtliches öffnet die Gruppe (Link aus dem Einrichtungs-Hinweis)
  const content = () => html`<div id="settings-root">${view(openGroups)}</div>`;
  const draw = () => {
    const y = window.scrollY;
    render(el, adminShell("settings", content(), { title: "Einstellungen" }));
    bind(el, ctx);
    window.scrollTo(0, y);
  };
  // Nur Leiste, Tab-Leiste und Hinweis erneuern; der Inhalt (mit ungespeicherten Eingaben, Dateiauswahl, Fokus) wird umgezogen
  const softPaint = () => {
    const slot = $("#settings-root", el);
    if (!slot) { draw(); return; }
    const active = document.activeElement, y = window.scrollY;
    render(el, adminShell("settings", html`<div id="settings-root"></div>`, { title: "Einstellungen" }));
    $("#settings-root", el).replaceWith(slot);
    if (active && slot.contains(active) && typeof active.focus === "function") active.focus({ preventScroll: true });
    window.scrollTo(0, y);
  };
  const ctx = { softPaint };
  // Der Nutzer tippt gerade (Feld hat Fokus) oder hat etwas geändert, aber noch nicht gespeichert
  const editing = () => {
    const form = $("#settings-form", el);
    if (!form) return false;
    const a = document.activeElement;
    if (a && form.contains(a) && ["INPUT", "TEXTAREA", "SELECT"].includes(a.tagName)) return true;
    return isDirty(form);
  };
  // Eigene Aktionen (busy) zeichnen sofort neu; Änderungen anderer Geräte warten, bis die Eingabe fertig ist
  const refresh = (_, info) => {
    if (info && info.hub) return;   // Hub-Zustand allein ändert das Formular nicht
    const form = $("#settings-form", el);
    if (form) previewBrand(form);   // main.js setzt die gespeicherte Farbe zurück – eine ungespeicherte Vorschau bleibt
    if (!busy && editing()) { pending = true; return; }
    pending = false;
    draw();
  };
  draw();
  // Sprungmarke wie bei der Datenschutzerklärung: #/admin/einstellungen?zu=pin scrollt zur PIN-Karte (?zu=checks, ?zu=rechtliches ebenso)
  if (query.zu) { const target = document.getElementById(query.zu); if (target) target.scrollIntoView(); }
  const unsub = store.subscribe(refresh);
  el.addEventListener("toggle", (ev) => {
    const t = ev.target;
    if (t instanceof Element && t.classList.contains("s-fold")) { if (t.open) openGroups.add(t.id); else openGroups.delete(t.id); }
  }, { capture: true, signal: ac.signal });
  el.addEventListener("focusout", () => setTimeout(() => { if (alive && pending && !editing()) refresh(); }, 50), { signal: ac.signal });
  return () => {
    alive = false;
    unsub();
    ac.abort();
    applyBrand(store.settings);   // ungespeicherte Farb-Vorschau verwerfen
    if (previewURL) { URL.revokeObjectURL(previewURL); previewURL = ""; }
  };
}
register("/admin/einstellungen", screen, { admin: true, bodyClass: "admin" });
