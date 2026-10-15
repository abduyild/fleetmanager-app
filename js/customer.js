// Bausteine der Kundenseiten (Kundenformular, Ticket, Danke, Datenschutz – alle in screens/form.js): Überschrift, Eingabefeld mit
// Hilfe/Fehler, Datenschutz-Dialog, Mitarbeiter-Zugang. Die Kundenseiten sind das freundliche Register der App (weißer Grund,
// linksbündig, große Felder, ein fester Button unten, ui-review.md §5.8).
import { html, raw, $, T, openSheet } from "./ui.js";
import { icon } from "./icons.js";

// Überschrift als EIN Text: der frühere „farbige Teil“ (headline_accent, queue_headline_accent, thanks_title_accent) wird angehängt.
// Die Einstellungen bleiben gespeichert, die Oberfläche setzt aber keinen Akzent-Span mehr (kein Werbe-Hero, ui-review.md §1.1).
export const headlineText = (key) => [T(key), T(key + "_accent")].filter(Boolean).join(" ");

// Dezenter Weg zurück in den Admin – unten auf jeder Kundenseite (13 px, 44 px Trefferfläche). Führt zum Start (#/) und verlangt dort die Stand-PIN.
export const adminLink = (href = "/") => html`<p class="kiosk-admin-link"><a href="#${href}">Mitarbeiter-Zugang</a></p>`;

// Fehlermeldung UNTER dem Feld: rote Schrift mit Warn-Symbol (R2: nie nur Farbe). Der Text steht in einem <span>, damit er sich
// austauschen lässt, ohne das Symbol zu verlieren. help = Hilfetext, den die Meldung ersetzt (kommt zurück, wenn der Fehler verschwindet).
export const errMsg = (text, id, help = "") => (text ? html`<p class="err errmsg" id="${id}" data-help="${help}">${icon("alert")}<span>${text}</span></p>` : "");

// Formularfeld: Label oben, freiwillige Felder tragen „(optional)“ im Label (kein Pflicht-Stern), Hilfetext oder Fehler darunter.
// control(attrs) liefert das Eingabeelement; attrs (id, aria-describedby, bei Fehler class="invalid" aria-invalid) gehören an dieses Element.
// Für Felder, die gemeinsam geprüft werden (Telefon ODER E-Mail): invalid markiert das Feld ohne eigene Meldung, describedBy verweist
// auf die gemeinsame Meldung; cls hängt eine Klasse an das Feld (z. B. small-field für eine schmale Eingabe).
export function field({ id, label, optional = false, help = "", error = "", invalid = false, describedBy = "", cls = "" }, control) {
  const own = error || help ? `${id}-msg` : describedBy;
  const described = own ? ` aria-describedby="${own}"` : "";
  const attrs = raw(`id="${id}"${described}${error || invalid ? ' class="invalid" aria-invalid="true"' : ""}`);
  return html`<div class="field${cls ? " " + cls : ""}">
    <label class="lbl" for="${id}">${label}${optional ? html` <small>(optional)</small>` : ""}</label>
    ${control(attrs)}
    ${error ? errMsg(error, `${id}-msg`, help) : help ? html`<p class="help" id="${id}-msg">${help}</p>` : ""}
  </div>`;
}

// Der Fehler eines Feldes (Eingabe, Auswahlgruppe, Einwilligung, Feldpaar) verschwindet, sobald der Nutzer es ändert – ohne Neu-Rendern,
// damit Fokus und Tastatur bleiben. Die Meldung steht immer unmittelbar hinter dem Feld bzw. der Gruppe (field(), errMsg()).
// Ein Feldpaar (.contact-pair, Telefon ODER E-Mail) hat eine gemeinsame Meldung hinter dem Paar; ein eigener Fehler eines der beiden
// Felder (z. B. ungültige E-Mail) verschwindet für sich.
export function clearFieldError(input) {
  const group = input.closest(".opt-picks, label.consent, .contact-pair");
  const scope = group && group.classList.contains("invalid") ? group : input;
  if (!scope.classList.contains("invalid")) return;
  for (const el of [scope, ...scope.querySelectorAll("input")]) { el.classList.remove("invalid"); el.removeAttribute("aria-invalid"); }
  const msg = scope.nextElementSibling;
  if (!msg || !msg.classList.contains("errmsg")) return;
  if (msg.dataset.help) {                      // der Hilfetext war nur durch den Fehler verdrängt
    const help = document.createElement("p");
    help.className = "help";
    help.id = msg.id;
    help.textContent = msg.dataset.help;
    msg.replaceWith(help);
  } else {
    for (const el of [input, ...scope.querySelectorAll("input")]) if (el.getAttribute("aria-describedby") === msg.id) el.removeAttribute("aria-describedby");
    msg.remove();
    // Felder des Kontaktpaars verweisen danach wieder auf die gemeinsame Hilfezeile hinter dem Paar
    const shared = input.closest(".contact-pair") && input.closest(".contact-pair").nextElementSibling;
    if (shared && shared.id) input.setAttribute("aria-describedby", shared.id);
  }
}

// Datenschutz als Dialog statt Routenwechsel: das Formular bleibt stehen, Eingaben gehen nicht verloren (F3). Der Link trägt id und
// data-privacy; wer ihn einbaut, bindet mit openPrivacy(root, button) den Klick.
export const privacyLink = (label = "Datenschutzerklärung") => html`<button type="button" class="link" id="privacy-open" data-privacy>${label}</button>`;
export const privacyDialog = () => html`<dialog class="privacy-dialog" id="privacy-dialog" aria-labelledby="privacy-title">
    <h2 id="privacy-title">Datenschutzerklärung</h2>
    <div class="pre">${T("privacy_text")}</div>
    <form method="dialog"><button class="btn secondary">Schließen</button></form>
  </dialog>`;
// Öffnet den Dialog innerhalb von root; das Promise ist beim Schließen erfüllt (Escape, Scrim-Tipp, „Schließen“); der Fokus kehrt zum Auslöser zurück.
export const openPrivacy = (root, opener) => openSheet($("#privacy-dialog", root), { opener });
