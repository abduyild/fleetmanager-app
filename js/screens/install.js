// App installieren (#/installieren): die Anleitung für jedes Gerät und jeden Browser. Oben das erkannte Gerät (hervorgehoben, mit dem Installieren-Knopf, wo der Browser ihn
// anbietet), darunter aufklappbar iPhone / iPad, Android, Windows und Mac mit allen Browsern und dem Satz zum Speicher: Auf iPhone/iPad und im Safari am Mac hat die
// installierte App einen eigenen Speicher und damit eine eigene Gerätekennung – dort erst installieren, dann den Code in der installierten App eingeben (install.js).
// Die Seite läuft auch ohne Lizenz (router.js: gateFree), hat keine Admin-Leiste und kommt aus der Aktivierung (Schritt 1), dem Start, den Einstellungen und der Anleitung.
// Dieses Modul liefert außerdem die Bausteine, die Schritt 1 der Aktivierung (screens/activate.js) mit der Seite teilt: installBody() und wirePrompt().
import { register } from "../router.js";
import { html, raw, render, on, $, go } from "../ui.js";
import { icon } from "../icons.js";
import { store } from "../store.js";
import { licenseInfo } from "../license.js";
import { currentPlatform, installSteps, INSTALL_GROUPS, platformLabel, canPrompt, installPrompt, justInstalled, onInstallChange, SEPARATE_WARNING } from "../install.js";

// Schritte als nummerierte Liste (leer, wenn es keine gibt: Firefox am Computer)
export const stepList = (steps, cls = "inst-steps") => (steps.length ? html`<ol class="${cls}">${steps.map((s) => html`<li>${s}</li>`)}</ol>` : "");

// Hinweis nach dem Installieren: am Computer öffnet sich die App in einem eigenen Fenster, auf dem Handy liegt sie auf dem Startbildschirm
const afterText = (platform) => (platform.os === "windows" || platform.os === "mac"
  ? "Jetzt die installierte App öffnen: Sie startet in einem eigenen Fenster."
  : "Jetzt vom Startbildschirm öffnen.");

// Der Knopf „Installieren“ (nur wo der Browser den Dialog anbietet: Chromium, beforeinstallprompt) samt Hinweis danach. Der Bereich #install-prompt ist immer da und
// versteckt, solange es nichts anzuzeigen gibt; den Knopf selbst gibt es nur, solange der Browser den Dialog anbietet (wirePrompt() setzt ihn ein, wenn der Browser den
// Dialog meldet – oft erst nach dem ersten Zeichnen –, und nimmt ihn danach wieder heraus). So steht auf einer Seite ohne Dialog keine zweite gefüllte Hauptaktion im Quelltext (R1).
const installButton = () => html`<button type="button" class="btn primary lg block" data-install-now>${icon("download")}Installieren</button>`;
function promptView(platform) {
  const can = canPrompt(), done = justInstalled();
  return html`<div class="inst-prompt" id="install-prompt"${raw(can || done ? "" : " hidden")}>${can ? installButton() : ""}<p class="inst-after" id="install-after" role="status"${raw(done ? "" : " hidden")}>${icon("check")}<span>${afterText(platform)}</span></p></div>`;
}

// Der Inhalt von „App installieren“ für dieses Gerät: Installieren-Knopf, Schritte (#install-steps), Besonderheit des Browsers und der Satz zum Speicher –
// bei eigenem Speicher als Warnung, sonst als ruhiger Hinweis. Kann der Browser nichts installieren (Firefox am Computer), steht dort statt der Schritte der Hinweis.
export function installBody(platform) {
  const guide = installSteps(platform);
  return html`
    ${platform.canInstall ? promptView(platform) : ""}
    <div class="inst-body" id="install-steps" data-can-install="${String(platform.canInstall)}">
      ${platform.canInstall ? stepList(guide.steps) : ""}
      ${guide.extra ? html`<p class="inst-extra">${guide.extra}</p>` : ""}
    </div>
    ${platform.canInstall && platform.separateStorage
      ? html`<p class="banner warn inst-warn" data-install-warning>${icon("alert")}<span><strong>Wichtig:</strong> ${SEPARATE_WARNING}</span></p>`
      : platform.canInstall && guide.storage ? html`<p class="inst-extra" data-storage="shared">${guide.storage}</p>` : ""}`;
}

// Knopf und Hinweis lebendig machen: Klick löst den Dialog des Browsers aus; meldet der Browser den Dialog später (oder ist die App installiert), passt sich die Anzeige an.
// → Aufräumfunktion für den Router.
export function wirePrompt(root) {
  const box = $("#install-prompt", root);
  if (!box) return () => {};
  const after = $("#install-after", box);
  const sync = () => {
    const can = canPrompt(), done = justInstalled();
    const button = $("[data-install-now]", box);
    if (can && !button) box.insertAdjacentHTML("afterbegin", String(installButton()));
    else if (!can && button) button.remove();
    box.hidden = !(can || done);
    after.hidden = !done;
  };
  const off = on(box, "click", "[data-install-now]", async () => { await installPrompt(); sync(); });
  const unsub = onInstallChange(sync);
  sync();
  return () => { off(); unsub(); };
}

// --- Seite ---------------------------------------------------------------------------------------------------
function hereCard(platform) {
  if (platform.standalone) {
    return html`
  <section class="card inst-here" data-install-here data-state="installed">
    <p class="inst-lbl"><span class="tag accent">Dieses Gerät</span></p>
    <p class="inst-installed"><span class="status free icon">${icon("check", "sm")}Installiert</span></p>
    <p class="inst-extra">Sie arbeiten gerade in der installierten App. Die Anleitungen für andere Geräte stehen darunter.</p>
  </section>`;
  }
  const guide = installSteps(platform);
  const label = platformLabel(platform);
  return html`
  <section class="card inst-here" data-install-here data-state="open" data-os="${platform.os}" data-browser="${platform.browser}" data-can-install="${String(platform.canInstall)}">
    <p class="inst-lbl"><span class="tag accent">Dieses Gerät</span></p>
    <h2 class="inst-ttl">${label || guide.title}</h2>
    ${installBody(platform)}
  </section>`;
}

function groupView(group, hereGroup) {
  return html`
    <details class="inst-group" data-install-group="${group.id}">
      <summary class="disclosure"><span class="d-ttl">${group.name}</span>${hereGroup === group.id ? html`<span class="tag accent d-tag">Dieses Gerät</span>` : ""}${icon("chevD")}</summary>
      <div class="card inst-group-body">
        <p class="inst-extra inst-storage" data-storage="${group.storageKind}">${group.storage}</p>
        ${group.browsers.map((b) => html`
        <section class="inst-browser" data-install-browser="${b.id}">
          <h3>${b.name}</h3>
          ${stepList(b.steps)}
          ${b.extra ? html`<p class="inst-extra">${b.extra}</p>` : ""}
        </section>`)}
      </div>
    </details>`;
}

function installScreen({ el }) {
  const cfg = store.settings;
  const platform = currentPlatform();
  document.title = `App installieren – ${cfg.brand_name}`;
  // Ohne Lizenz führt „Zurück“ zur Aktivierung, sonst zum Start (kam man aus einer anderen Seite der App, geht es dorthin zurück)
  const st = licenseInfo(store.settings);
  const home = st.state === "none" || st.state === "invalid" ? "/aktivieren" : "/";
  const hereGroup = platform.os === "other" ? "" : installSteps(platform).group;
  render(el, html`
<main class="page install" data-screen="install" data-os="${platform.os}" data-browser="${platform.browser}" data-standalone="${String(platform.standalone)}" data-separate-storage="${String(platform.separateStorage)}">
  <a href="#${home}" id="install-back" class="btn quiet back">${icon("chevR", "flip")}Zurück</a>
  <h1 class="title">App installieren</h1>
  <p class="inst-lead">Die installierte App startet vom Home-Bildschirm, öffnet im eigenen Fenster und läuft auch ohne Internet.</p>
  ${hereCard(platform)}
  <div class="sec"><h2>Andere Geräte und Browser</h2></div>
  <div class="stack inst-groups">${INSTALL_GROUPS.map((g) => groupView(g, hereGroup))}</div>
</main>`);
  on(el, "click", "#install-back", (ev) => {
    ev.preventDefault();
    if (history.length > 1) history.back(); else go(home);
  });
  return wirePrompt(el);
}

register("/installieren", installScreen);
