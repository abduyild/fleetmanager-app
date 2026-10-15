// App aktivieren (#/aktivieren): der Kunde schickt die Gerätekennung dieses Geräts an den Anbieter und tippt den Aktivierungscode ein, den er dafür erhält, bevor die
// Oberfläche der App erscheint. Ohne gültigen Code oder Schlüssel leitet der Router jede Seite hierher um (router.js); abgelaufene Lizenzen führen von den Hinweisen
// mit „Code eingeben“ hierher. Gestaltung wie der Login (screens/login.js): zentrierte Karte ≤ 400 px, Logo, Titel, keine Leiste – darin drei Schritte als Karten:
//   Schritt 1  App installieren: die Schritte für das erkannte Gerät (install.js), bei Chromium der Knopf „Installieren“; läuft die App schon installiert, nur eine Zeile
//              „Installiert“. Auf iPhone/iPad und im Safari am Mac hat die installierte App einen eigenen Speicher – dort steht die Warnung „Code erst in der installierten
//              App eingeben“, und die Gerätekennung des Browsers tritt zurück (Schritt 2), weil sie in der installierten App eine andere ist.
//   Schritt 2  Gerätekennung an den Anbieter senden (groß, mit „Kopieren“)
//   Schritt 3  Code eingeben: Feld, Fehler UNTER dem Feld, ein Button
// Darunter ein Aufklappfeld für den langen Lizenzschlüssel (cmd/license) und der Link zur Datenschutzerklärung.
// Der Code ist an die Gerätekennung gebunden (codes.js) und gilt nur auf diesem Gerät: er wird in localStorage des Geräts gespeichert (license.js: saveDeviceCode), nicht
// in den Einstellungen – auch im Hub-Betrieb aktiviert sich jedes Gerät einmal selbst. Der lange Schlüssel dagegen ist an kein Gerät gebunden und liegt in den
// Einstellungen (im Hub-Betrieb gilt er für alle Geräte am Laptop). Prüfen und Speichern gehen denselben Weg wie die Karte „Lizenz“ der Einstellungen
// (license.js: checkActivationCode / checkLicenseKey).
import { register, takeAfterActivate } from "../router.js";
import { html, raw, render, logo, on, $, flash, flashNext, formatCodeField, copyText } from "../ui.js";
import { icon } from "../icons.js";
import { store } from "../store.js";
import { deDay } from "../model.js";
import { deviceId, localStorageFailed } from "../codes.js";
import { licenseInfo, writeAllowed, checkActivationCode, checkLicenseKey, saveDeviceCode } from "../license.js";
import { currentPlatform, platformLabel } from "../install.js";
import { installBody, wirePrompt } from "./install.js";

// Zeile „Aktuell: Aktivierungscode · Kunde Nr. 7 · abgelaufen am 19.10.2026“, wenn schon etwas gespeichert ist (Link „Code eingeben“ aus
// einem Hinweis); leer bei einem frischen Gerät. data-license-source nennt die Quelle (code, key; leer, wenn die gespeicherte Lizenz nicht mehr taugt).
function currentLine(st) {
  if (st.state === "none") return "";
  if (st.state === "invalid") {
    return html`<p class="act-current" data-license-source="" data-license-state="invalid">${st.reason === "code" ? "Der bisher gespeicherte Aktivierungscode gilt nicht mehr." : "Der bisher gespeicherte Lizenzschlüssel ist ungültig."}</p>`;
  }
  const what = st.source === "code" ? "Aktivierungscode" : "Lizenzschlüssel";
  const when = st.state === "expired" ? `abgelaufen am ${deDay(st.exp)}` : st.state === "not_yet_valid" ? `gilt erst ab ${deDay(st.nb)}` : `gültig bis ${deDay(st.exp)}`;
  return html`<p class="act-current" data-license-source="${st.source}" data-license-state="${st.state}">Aktuell: ${what} · ${st.customer} · ${when}</p>`;
}

// Der Browser lässt kein Speichern zu (privates Fenster, gesperrter Speicher): Kennung und Code gingen beim Schließen verloren
const storageWarning = () => (localStorageFailed()
  ? html`<p class="banner warn" id="activate-storage">${icon("alert")}<span>Dieser Browser speichert keine Daten (privates Fenster?). Bitte ein normales Fenster verwenden – sonst ist die Aktivierung nach dem Schließen weg und die Gerätekennung ändert sich.</span></p>`
  : "");

// Kopf eines Schritts: „Schritt 2“ klein, darunter der Titel
const stepHead = (n, title) => html`<h2 class="act-step-h"><span class="act-step-no">Schritt ${n}</span><span class="act-step-ttl">${title}</span></h2>`;

// Schritt 1: App installieren. Installiert und gestartet als App: eine Zeile mit Haken. Sonst die Schritte für dieses Gerät (screens/install.js) und der Weg zu den
// Anleitungen für alle anderen Geräte und Browser (#/installieren).
function installStep(platform) {
  if (platform.standalone) {
    return html`<li class="act-step done" data-install-step="1" data-state="installed">
      ${stepHead(1, "App installieren")}
      <span class="status free icon">${icon("check", "sm")}Installiert</span>
    </li>`;
  }
  const label = platformLabel(platform);
  return html`<li class="act-step" data-install-step="1" data-state="${platform.canInstall ? "open" : "unavailable"}">
      ${stepHead(1, "App installieren")}
      ${label ? html`<p class="act-detect" data-detected>Erkannt: ${label}</p>` : ""}
      ${installBody(platform)}
      <a class="btn quiet act-more" href="#/installieren" data-install-more>Andere Geräte / alle Anleitungen</a>
    </li>`;
}

// Die Gerätekennung mit „Kopieren“ (Hooks: #device-id, [data-copy-device])
const deviceBlock = (device) => html`<div class="act-device">
        <p class="act-device-lbl">Ihre Gerätekennung</p>
        <p class="act-device-id" id="device-id">${device}</p>
        <button type="button" class="btn secondary" data-copy-device="${device}">${icon("copy")}Kopieren</button>
      </div>`;

// Schritt 2: Gerätekennung senden. Auf Geräten mit eigenem Speicher (iPhone/iPad, Safari am Mac) gehört die Kennung der installierten App, nicht dieses Browser-Tabs:
// Solange nicht installiert ist, steht dort der Hinweis, sie in der App abzulesen; die Kennung des Browsers bleibt hinter einem Aufklappfeld erreichbar (für alle, die
// bewusst im Browser bleiben).
function deviceStep(platform, device) {
  const deferred = platform.separateStorage && platform.canInstall && !platform.standalone;
  return html`<li class="act-step" data-install-step="2" data-state="${deferred ? "deferred" : "ready"}">
      ${stepHead(2, "Gerätekennung an den Anbieter senden")}
      ${deferred
        ? html`<p class="act-defer" data-device-deferred>${icon("info")}<span>Kennung nach der Installation in der App ablesen</span></p>
      <details class="act-browser-id" id="activate-browser-id">
        <summary class="disclosure"><span class="d-ttl">Kennung dieses Browsers anzeigen</span>${icon("chevD")}</summary>
        ${deviceBlock(device)}
        <p class="help">Diese Kennung gilt nur in diesem Browser, nicht in der installierten App.</p>
      </details>`
        : html`${deviceBlock(device)}
      <p class="act-step-sub">Senden Sie diese Kennung an den Anbieter. Er schickt Ihnen dafür den Aktivierungscode.</p>`}
    </li>`;
}

function screen({ el }) {
  const cfg = store.settings;
  const device = deviceId();
  const platform = currentPlatform();
  const st = licenseInfo(cfg);
  document.title = `App aktivieren – ${cfg.brand_name}`;
  // Fokus ins Codefeld, wenn jemand zum Eintippen kommt: in der installierten App und auf einem Gerät mit gespeicherter Lizenz (Link „Code eingeben“ aus einem Hinweis).
  // Auf einem frischen Gerät im Browser-Tab nicht: das Feld läge unter den Schritten 1 und 2, und die Seite spränge beim Laden daran vorbei.
  const autofocus = platform.standalone || st.state !== "none" ? raw(" autofocus") : "";
  render(el, html`
<main class="page center narrow gate act" data-screen="activate" data-os="${platform.os}" data-browser="${platform.browser}" data-standalone="${String(platform.standalone)}" data-separate-storage="${String(platform.separateStorage)}" data-can-install="${String(platform.canInstall)}">
  <header class="brand">${logo(cfg)}</header>
  <h1 class="title">App aktivieren</h1>
  <p class="gate-sub act-sub">In drei Schritten startklar: App installieren, Gerätekennung senden, Code eingeben.</p>
  ${storageWarning()}
  ${currentLine(st)}
  <ol class="act-steps">
    ${installStep(platform)}
    ${deviceStep(platform, device)}
    <li class="act-step" data-install-step="3">
      ${stepHead(3, "Code eingeben")}
      <p class="act-step-sub">Geben Sie den Code ein, den Sie vom Anbieter erhalten haben.</p>
      <form class="lead-form gate-form" id="activate-form" autocomplete="off" novalidate>
        <div class="field">
          <label class="lbl" for="activate-code">Aktivierungscode</label>
          <input type="text" id="activate-code" name="code" class="code-input" placeholder="XXX-XXX"${autofocus} autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" aria-describedby="activate-error">
          <p class="err errmsg" id="activate-error" role="alert" hidden>${icon("alert")}<span></span></p>
        </div>
        <button type="submit" class="btn primary lg block">Aktivieren</button>
      </form>
    </li>
  </ol>
  <details class="act-key" id="activate-key-box">
    <summary class="disclosure"><span class="d-ttl">Lizenzschlüssel (lang) eingeben</span>${icon("chevD")}</summary>
    <div class="card act-key-body">
      <label class="field">
        <span class="lbl">Lizenzschlüssel</span>
        <textarea id="activate-key" rows="4" placeholder="PF1.…" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-describedby="activate-key-error"></textarea>
      </label>
      <p class="err errmsg" id="activate-key-error" role="alert" hidden>${icon("alert")}<span></span></p>
      <button type="button" class="btn secondary block" id="activate-key-save">Schlüssel prüfen und speichern</button>
    </div>
  </details>
  <p class="kiosk-admin-link"><a href="#/datenschutz">Datenschutz</a></p>
</main>`);

  const codeInput = $("#activate-code", el), keyInput = $("#activate-key", el);
  let busy = false;   // eine Prüfung läuft: kein zweites Absenden
  let done = false;   // diese Seite hat selbst aktiviert (oder ist schon auf dem Weg hinaus)

  // Fehler unter dem Feld (roter Rand + Meldung mit Symbol); beim nächsten Tippen wieder weg
  const fail = (input, boxId, text) => {
    const box = $(boxId, el);
    $("span", box).textContent = text;
    box.hidden = false;
    input.classList.add("invalid");
    input.setAttribute("aria-invalid", "true");
    input.focus();
  };
  const clear = (input, boxId) => {
    input.classList.remove("invalid");
    input.removeAttribute("aria-invalid");
    $(boxId, el).hidden = true;
  };
  // Code speichern und weiter: im Gerätespeicher, nicht in den Einstellungen (der Code gilt nur auf diesem Gerät). Der Toast „Aktiviert – gültig bis …“ erscheint
  // auf der nächsten Seite (flashNext). Behält der Browser den Code nicht (gesperrter Speicher), sagt der Toast das.
  function applyCode(r) {
    done = true;   // vor dem Speichern: saveDeviceCode benachrichtigt die Beobachter, auch den unten (am Hub teilt store.js die Aktivierung)
    const stored = saveDeviceCode(r.code);
    if (stored) flashNext(`Aktiviert – gültig bis ${deDay(r.exp)}`);
    else flashNext("Aktiviert – aber der Browser speichert nichts: nach dem Schließen der Seite ist die Aktivierung weg.", "warn");
    location.replace(takeAfterActivate());
  }
  // Langen Schlüssel speichern und weiter: er gehört zu den Einstellungen (kein Gerätebezug; im Hub-Betrieb gilt er für alle Geräte am Laptop). Ein Schlüssel in der
  // Kulanzfrist sagt das im Toast. Misslingt das Speichern (Hub nicht erreichbar), bleibt man hier und sieht den Grund unter dem Feld.
  async function applyKey(r) {
    done = true;
    const res = await store.update((d) => { d.settings.license_key = r.key; return { ok: true }; });
    if (res.error) { done = false; fail(keyInput, "#activate-key-error", res.error); return; }
    const status = r.status;
    if (status.state === "grace") flashNext(`Lizenz gespeichert – abgelaufen am ${deDay(status.exp)}, noch ${status.daysLeft} ${status.daysLeft === 1 ? "Tag" : "Tage"} Kulanz.`, "warn");
    else flashNext(`Aktiviert – gültig bis ${deDay(status.exp)}`);
    location.replace(takeAfterActivate());
  }

  // Gerätekennung kopieren (zum Senden an den Anbieter)
  on(el, "click", "[data-copy-device]", async (ev, btn) => {
    if (await copyText(btn.dataset.copyDevice)) flash("Gerätekennung kopiert.");
    else flash("Kopieren nicht möglich – bitte die Kennung markieren und von Hand kopieren.", "warn");
  });

  // Beim Tippen: Großbuchstaben, Strich nach dem dritten Zeichen, höchstens sechs Zeichen (ui.formatCodeField)
  on(el, "input", "#activate-code", (ev, input) => {
    formatCodeField(input);
    clear(input, "#activate-error");
  });
  on(el, "input", "#activate-key", (ev, input) => clear(input, "#activate-key-error"));

  on(el, "submit", "#activate-form", async (ev) => {
    ev.preventDefault();
    if (busy) return;
    busy = true;
    try {
      const r = checkActivationCode(codeInput.value);
      if (r.error) { fail(codeInput, "#activate-error", r.error); return; }
      applyCode(r);
    } finally {
      busy = false;
    }
  });
  on(el, "click", "#activate-key-save", async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await checkLicenseKey(keyInput.value);
      if (r.error) { fail(keyInput, "#activate-key-error", r.error); return; }
      await applyKey(r);
    } finally {
      busy = false;
    }
  });

  // Aktiviert ein anderer Tab (Code im Gerätespeicher: storage-Ereignis) oder ein anderes Gerät (langer Schlüssel im Hub), während diese Seite offen ist, geht es
  // hier von selbst weiter – ohne Toast
  let wasOk = writeAllowed(licenseInfo(store.settings));
  const unsub = store.subscribe(() => {
    const ok = writeAllowed(licenseInfo(store.settings));
    if (ok && !wasOk && !done) { done = true; location.replace(takeAfterActivate()); }
    wasOk = ok;
  });
  const stopPrompt = wirePrompt(el);   // Knopf „Installieren“ in Schritt 1 (nur Chromium; erscheint, sobald der Browser den Dialog meldet)
  return () => { unsub(); stopPrompt(); };
}

register("/aktivieren", screen);
