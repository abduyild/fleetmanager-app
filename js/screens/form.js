// Kundenseiten: Kundenformular (#/formular, Alias #/warteschlange), Ticket (#/warteschlange/ticket/:id), Danke (#/danke),
// Datenschutz (#/datenschutz). EIN Formular für den Stand: Name, Telefon oder E-Mail, Interessen – und als erste Option die
// Probefahrt (nur bei aktiver Warteschlange). Wer sie ankreuzt, bekommt direkt eine Nummer (Ticket); jedes weitere Interesse landet
// gesondert unter „Interessenten“. Beides entsteht in einem Absenden (actions.submitCustomerForm).
// Standalone: das Formular schreibt direkt in den Speicher dieses Geräts. Gestaltung nach ui-review.md §5.8 (Kundenseiten: linksbündig,
// große Felder, „(optional)“ statt Sternen, ruhige Einwilligung, fester Abschick-Button unten); Bausteine in customer.js.
import { register } from "../router.js";
import { html, render, on, $, go, flash, logo, T, formData, formList } from "../ui.js";
import { icon } from "../icons.js";
import { store } from "../store.js";
import * as model from "../model.js";
import * as actions from "../actions.js";
import { headlineText, adminLink, errMsg, field, clearFieldError, privacyLink, privacyDialog, openPrivacy } from "../customer.js";

// Eigener Wurzelknoten je Screen-Aufruf: Ereignis-Handler hängen daran und verschwinden mit dem nächsten
// Screen, statt sich bei jedem Besuch auf #app zu stapeln (sonst würde ein Tippen mehrfach speichern).
function mount(el) {
  const root = document.createElement("div");
  el.replaceChildren(root);
  return root;
}

// --- Kundenformular (#/formular) ---------------------------------------------------------------------------
const HELP_EITHER = "Telefon oder E-Mail – eines von beiden genügt.";
const HELP_DRIVE = "Für die Probefahrt brauchen wir Ihre Telefonnummer, damit wir Sie aufrufen können.";

const emptyInput = () => ({ name: "", phone: "", email: "", zip_code: "", notes: "", interests: [], queue: false, consent: false });

// Einstellungen, von denen das Formular (Aufbau, Texte, Kopf, Datenschutz-Dialog) abhängt: ändert sich eine, wird neu gezeichnet.
// Alles andere (z. B. die Wartezeit-Anzeige show_eta, die Stand-PIN) lässt das Formular in Ruhe.
const FORM_SETTINGS = ["module_leads", "module_queue", "interests", "queue_option_label", "queue_option_hint", "page_title", "headline", "headline_accent",
  "subline", "notes_placeholder", "submit_label", "consent_text", "legal_text", "brand_name", "logo", "company", "company_address", "privacy_email", "privacy_text"];
const settingsSig = () => FORM_SETTINGS.map((k) => String(store.settings[k] ?? "")).join("\u0001");

function readForm(form) {
  const f = formData(form);
  return {
    name: f.name || "", phone: f.phone || "", email: f.email || "", zip_code: f.zip_code || "", notes: f.notes || "",
    interests: formList(form, "interests"), queue: !!f.queue, consent: !!f.consent,
  };
}

// Wartezeit der Warteschlange in EINER Zeile mit Uhr-Symbol; sie sitzt in der Probefahrt-Option (gibt es nur die Probefahrt, ohne
// Auswahl, unter dem Untertitel) und wird bei Datenänderungen (auch von anderen Geräten) an Ort und Stelle erneuert – Eingaben
// und Fokus bleiben.
function queueLine() {
  const d = store.data, cfg = store.settings;
  const st = model.queueState(d.queue, d.vehicles, cfg);
  const n = st.waiting.length;
  if (!n) return html`${icon("clock", "sm")}<span>Aktuell <b>keine Wartezeit</b></span>`;
  return html`${icon("clock", "sm")}<span><b>${n} ${n === 1 ? "Person" : "Personen"}</b> ${n === 1 ? "wartet" : "warten"}${cfg.show_eta ? html` · Wartezeit ca. <b>${st.eta(n)} Min.</b>` : ""}</span>`;
}

// Nur die Probefahrt (Interessenten aus): es gibt nichts anzukreuzen, Hinweis und Wartezeit stehen deshalb unter dem Untertitel.
function aloneNote() {
  const hint = T("queue_option_hint");
  return html`<div class="alone-note">${hint ? html`<p>${hint}</p>` : ""}<p class="queue-info alone">${queueLine()}</p></div>`;
}

// Auswahlzeilen: zuerst die Probefahrt (volle Breite, mit Hinweis und Wartezeit), darunter die Interessen aus den Einstellungen.
// Name „queue“ für die Probefahrt, „interests“ für die übrigen – die Beschriftungen der Interessen sind frei wählbar und dürfen
// dem Text der Probefahrt-Option gleichen.
function optionsView(cfg, o, st, errors) {
  const hint = T("queue_option_hint");
  const many = (o.queue ? 1 : 0) + o.interests.length > 1;
  return html`
    <div class="field" role="group" aria-labelledby="form-options-lbl">
      <span class="lbl" id="form-options-lbl">Was interessiert Sie?${many ? html` <small>· Mehrfachauswahl möglich</small>` : ""}</span>
      <div class="opt-picks${errors.interests ? " invalid" : ""}">
        ${o.queue ? html`
        <label class="option opt-pick opt-queue">
          <input type="checkbox" name="queue" value="1"${st.queue ? " checked" : ""}>
          <span class="box"></span>
          <span class="opt-text">
            <span class="opt-ttl">${T("queue_option_label") || model.DEFAULT_SETTINGS.queue_option_label}</span>
            ${hint ? html`<span class="opt-sub">${hint}</span>` : ""}
            <span class="opt-sub queue-info">${queueLine()}</span>
          </span>
        </label>` : ""}
        ${o.interests.map((i) => html`
        <label class="option opt-pick">
          <input type="checkbox" name="interests" value="${i}"${st.interests.includes(i) ? " checked" : ""}>
          <span class="box"></span>
          <span>${i}</span>
        </label>`)}
      </div>
      ${errMsg(errors.interests, "form-interests-msg")}
    </div>`;
}

// Reihenfolge: zuerst die Frage „Was interessiert Sie?“ (Probefahrt/Interessen), danach Name und Kontakt – so weiß der Besucher,
// bevor er tippt, ob das Telefon Pflicht ist (Probefahrt) oder Telefon oder E-Mail genügt.
// Pflicht ist der Normalfall und bleibt unmarkiert; freiwillige Felder tragen „(optional)“ im Label (kein Stern, keine Legende).
// Telefon ODER E-Mail: eine gemeinsame Zeile darunter erklärt es; mit Probefahrt ist das Telefon Pflicht, die E-Mail wird freiwillig.
function formView(cfg, st, errors) {
  const o = model.formOptions(cfg);
  const drive = o.alone || st.queue;                 // die Probefahrt gilt: Telefon ist Pflicht
  const help = drive ? HELP_DRIVE : HELP_EITHER;
  const bad = !!errors.contact;                      // weder Telefon noch E-Mail: beide Felder markiert, eine Meldung hinter dem Paar
  return html`
<main class="page cust">
  <header class="brand">${logo(cfg)}</header>

  <h1>${headlineText("headline")}</h1>
  <p class="lead">${T("subline")}</p>
  ${o.alone ? aloneNote() : ""}

  <form id="customer-form" class="lead-form" novalidate autocomplete="off">
    ${o.alone ? "" : optionsView(cfg, o, st, errors)}

    ${field({ id: "form-name", label: "Name", error: errors.name }, (a) => html`<input ${a} name="name" value="${st.name}" autocomplete="off" required>`)}
    <div class="fields-2 contact-pair${bad ? " invalid" : ""}">
      ${field({ id: "form-phone", label: "Telefon", error: errors.phone, invalid: bad, describedBy: "form-contact-msg" }, (a) => html`<input ${a} type="tel" name="phone" value="${st.phone}" autocomplete="off">`)}
      ${field({ id: "form-email", label: "E-Mail", optional: drive, error: errors.email, invalid: bad, describedBy: "form-contact-msg" }, (a) => html`<input ${a} type="email" name="email" value="${st.email}" autocomplete="off">`)}
    </div>
    ${bad ? errMsg(errors.contact, "form-contact-msg", help) : html`<p class="help" id="form-contact-msg">${help}</p>`}
    ${o.leads ? field({ id: "form-zip", label: "Postleitzahl", optional: true, error: errors.zip_code, cls: "small-field" }, (a) => html`<input ${a} name="zip_code" value="${st.zip_code}" inputmode="numeric" maxlength="5" autocomplete="off">`) : ""}

    ${o.leads ? field({ id: "form-notes", label: "Notizen", optional: true, error: errors.notes }, (a) => html`<textarea ${a} name="notes" rows="3" maxlength="2000" placeholder="${T("notes_placeholder")}">${st.notes}</textarea>`) : ""}

    <label class="consent${errors.consent ? " invalid" : ""}">
      <input type="checkbox" name="consent"${st.consent ? " checked" : ""}${errors.consent ? html` aria-invalid="true" aria-describedby="form-consent-msg"` : ""}>
      <span class="box"></span>
      <span>${T("consent_text")}</span>
    </label>
    ${errMsg(errors.consent, "form-consent-msg")}

    <p class="legal">${T("legal_text")}</p>
    <p class="legal-links">${privacyLink()}</p>

    <div class="cta-bar">
      <button type="submit" class="btn primary lg block">${T("submit_label")}</button>
    </div>
  </form>
  ${adminLink()}
  ${privacyDialog()}
</main>`;
}

function inactiveView(cfg) {
  return html`
<main class="page cust">
  <header class="brand">${logo(cfg)}</header>
  <h1>Zurzeit nicht aktiv</h1>
  <p class="lead">Das Formular ist ausgeschaltet. Mitarbeitende können es im Admin unter „Einstellungen“ einschalten.</p>
  ${adminLink("/admin/einstellungen")}
</main>`;
}

function focusFirstError(root) {
  const bad = $(".invalid", root);
  if (!bad) return;
  bad.scrollIntoView({ block: "center" });
  const target = bad.matches("input, textarea") ? bad : bad.querySelector("input, textarea");
  if (target) target.focus({ preventScroll: true });
}

// Probefahrt an/aus: Hilfetext unter Telefon/E-Mail und „(optional)“ an der E-Mail passen sich an Ort und Stelle an (kein Neu-Rendern:
// der Fokus bleibt auf der Auswahl). Ein Fehler „Telefon fehlt für die Probefahrt“ gilt ohne Probefahrt nicht mehr, ein Fehler
// „Telefon oder E-Mail“ nicht mehr mit Probefahrt (dann zählt nur das Telefon: die Hilfezeile sagt es).
function syncDrive(root, errors) {
  const o = model.formOptions(store.settings);
  const box = $("input[name=queue]", root);
  const drive = o.alone || !!(box && box.checked);
  const text = drive ? HELP_DRIVE : HELP_EITHER;
  const msg = $("#form-contact-msg", root);
  if (msg) { if (msg.classList.contains("errmsg")) msg.dataset.help = text; else msg.textContent = text; }
  const lbl = $("label[for=form-email]", root);
  if (lbl) {
    lbl.replaceChildren(document.createTextNode("E-Mail"));
    if (drive) { const small = document.createElement("small"); small.textContent = "(optional)"; lbl.append(" ", small); }
  }
  const phone = $("#form-phone", root);
  if (!drive && errors.phone === actions.MSG.phoneForDrive) {
    delete errors.phone;
    if (phone) clearFieldError(phone);
  }
  if (drive && errors.contact) {
    delete errors.contact;
    if (phone) clearFieldError(phone);
  }
}

function formScreen({ el, preselect = false }) {
  const root = mount(el);
  let errors = {};
  let busy = false;
  let dirty = false;   // Einstellungen änderten sich, während der Datenschutz-Dialog offen war: danach neu zeichnen
  let sig = settingsSig();
  const draw = () => {
    const cfg = store.settings;
    document.title = T("page_title");
    if (model.formOptions(cfg).off) { render(root, inactiveView(cfg)); return; }
    // Eingaben überleben ein Neu-Rendern (z. B. nach einer Einstellungsänderung); beim ersten Mal gilt der Alias #/warteschlange
    const form = $("#customer-form", root);
    const st = form ? readForm(form) : { ...emptyInput(), queue: preselect && !!cfg.module_queue };
    render(root, formView(cfg, st, errors));
  };
  draw();
  // Datenschutz als Dialog statt Routenwechsel: das Formular bleibt stehen, Eingaben gehen nicht verloren (F3)
  on(root, "click", "[data-privacy]", async (ev, btn) => {
    await openPrivacy(root, btn);
    if (dirty) { dirty = false; draw(); }
  });
  // Fehler verschwinden, sobald das Feld geändert wird (auch aus dem Zustand, sonst kämen sie bei einem Neu-Rendern zurück)
  on(root, "input", "#customer-form", (ev) => {
    const t = ev.target;
    if (t.name) delete errors[t.name];
    if (t.name === "phone" || t.name === "email") delete errors.contact;
    if (t.name === "queue" || t.name === "interests") delete errors.interests;
    clearFieldError(t);
  });
  on(root, "change", "input[name=queue]", () => syncDrive(root, errors));
  on(root, "submit", "#customer-form", async (ev, form) => {
    ev.preventDefault();
    if (busy) return; // doppeltes Tippen auf dem Tablet
    busy = true;
    try {
      const [data, errs] = actions.validateCustomerForm(readForm(form), store.settings);
      errors = errs;
      if (Object.keys(errs).length) { draw(); focusFirstError(root); return; }
      const ref = await model.consentRef(T("consent_text"));   // EIN Einwilligungstext für Probefahrt und Interessen
      let r;
      try {
        r = await store.update((d) => actions.submitCustomerForm(d, d.settings, data, { kiosk: true, refs: { queue: ref, lead: ref } }));
      } catch (e) {
        console.error(e);
        r = { error: "Das Absenden hat nicht geklappt – bitte noch einmal versuchen." };
      }
      if (r.error) { flash(r.error, "error"); return; }
      go(r.entry ? "/warteschlange/ticket/" + r.entry.id : "/danke");
    } finally {
      busy = false;
    }
  });
  // Datenänderungen (auch von anderen Geräten, Hub): nur die Wartezeit-Zeile erneuern – das Formular wird nicht mitten in der
  // Eingabe neu gezeichnet, sonst gingen Fokus und Tastatur verloren. Nur geänderte Einstellungen zeichnen das Formular neu
  // (bei offenem Datenschutz-Dialog erst nach dem Schließen, nicht mitten in der Eingabe).
  const unsub = store.subscribe((_, info) => {
    const wait = $(".queue-info", root);
    if (wait) render(wait, queueLine());
    const now = settingsSig();
    if (now === sig) return;
    const a = document.activeElement;
    if (info && info.remote && a && root.contains(a) && a.matches("input, textarea")) return;
    sig = now;
    if ($("dialog[open]", root)) { dirty = true; return; }
    draw();
  });
  return () => { unsub(); };
}

// --- Ticket (#/warteschlange/ticket/:id) -----------------------------------------------------------------
// Zentriert und groß: die Nummer ist das, was der Kunde mitnimmt. Nach 60 Sekunden zurück zum Formular (nächster Kunde).
function ticketScreen({ params, el }) {
  const cfg = store.settings;
  const e = model.findById(store.data.queue, params.id);
  if (!e) {
    document.title = `Warteschlange – ${cfg.brand_name}`;
    render(el, html`<main class="page cust center stage">
  <div class="stage-body">
    <header class="brand">${logo(cfg)}</header>
    <p class="lead">Diese Anmeldung ist nicht bekannt.</p>
    <a class="btn primary lg" href="#/formular">Zum Formular</a>
  </div>
  ${adminLink()}
</main>`);
    return;
  }
  document.title = `Nr. ${e.number} – ${cfg.brand_name}`;
  const key = model.submissionKey(e);
  const noted = store.data.leads.some((l) => l.interests && model.submissionKey(l) === key);   // mit der Probefahrt wurden auch Interessen gespeichert
  let left = 60;
  // Position in der Schlange und geschätzte Wartezeit (show_eta) – dieselbe Rechnung wie im Formular und in der Admin-Warteschlange
  const st = model.queueState(store.data.queue, store.data.vehicles, cfg);
  const ahead = Math.max(0, st.waiting.findIndex((x) => x.id === e.id));
  const etaLine = e.status === model.STATUS.WAITING && cfg.show_eta
    ? html`<p class="ticket-eta">${ahead === 0 ? "Sie sind als Nächstes dran" : `Vor Ihnen ${ahead === 1 ? "wartet 1 Person" : `warten ${ahead} Personen`}`}${st.eta(ahead) > 0 ? ` · Wartezeit ca. ${st.eta(ahead)} Min.` : ""}</p>`
    : "";
  render(el, html`<main class="page cust center stage">
  <div class="stage-body">
    <header class="brand">${logo(cfg)}</header>
    <p class="ticket-for">Danke, ${model.firstName(e.name)}. Ihre Nummer:</p>
    <div class="ticket-number">${e.number}</div>
    ${etaLine}
    <p class="ticket-note">Wir rufen Sie unter ${model.maskPhone(e.phone)} an, sobald Sie an der Reihe sind.${noted ? html`<span class="ticket-extra">Ihre Interessen haben wir notiert.</span>` : ""}</p>
    <a class="btn secondary lg" href="#/formular">Fertig – nächste Anmeldung</a>
    <p class="count" id="countdown">Automatisch zurück in ${left} s</p>
  </div>
  ${adminLink()}
</main>`);
  // Kiosk: nach 60 Sekunden automatisch zurück zum Formular
  const timer = setInterval(() => {
    left -= 1;
    const c = $("#countdown", el);
    if (c) c.textContent = `Automatisch zurück in ${left} s`;
    if (left <= 0) { clearInterval(timer); go("/formular"); }
  }, 1000);
  return () => clearInterval(timer);
}

// --- Danke (#/danke) ---------------------------------------------------------------------------------
// Wie das Ticket springt auch die Danke-Seite von selbst zurück (nach 10 s): am Stand-Tablet steht gleich das nächste leere Formular bereit.
const THANKS_SECONDS = 10;
function thanksScreen({ el }) {
  const root = mount(el);
  let left = THANKS_SECONDS;
  const draw = () => {
    const cfg = store.settings;
    document.title = `${headlineText("thanks_title")} – ${cfg.brand_name}`;
    render(root, html`
<main class="page cust center stage">
  <div class="stage-body">
    <header class="brand">${logo(cfg)}</header>
    <div class="check-circle">${icon("check", "lg")}</div>
    <h1>${headlineText("thanks_title")}</h1>
    <p class="lead">${T("thanks_text")}</p>
    <a class="btn secondary lg" href="#/formular">Neues Formular</a>
    <p class="count" id="countdown">Neues Formular in ${left} s</p>
  </div>
  ${adminLink()}
</main>`);
  };
  draw();
  const timer = setInterval(() => {
    left -= 1;
    const c = $("#countdown", root);
    if (c) c.textContent = `Neues Formular in ${left} s`;
    if (left <= 0) { clearInterval(timer); go("/formular"); }
  }, 1000);
  const unsub = store.subscribe((_, info) => { if (!(info && info.hub)) draw(); });
  return () => { clearInterval(timer); unsub(); };
}

// --- Datenschutz (#/datenschutz) -----------------------------------------------------------------------
// Anker im Hash-Router: #/datenschutz?zu=art13 statt /datenschutz#art13. Linksbündige Prosa, „Zurück“ oben.
function privacyScreen({ query, el }) {
  const root = mount(el);
  const draw = () => {
    const cfg = store.settings;
    document.title = `Datenschutz – ${cfg.brand_name}`;
    render(root, html`
<main class="page prose cust">
  <a href="#/formular" id="privacy-back" class="btn quiet back">${icon("chevR", "flip")}Zurück</a>
  <h1>Datenschutzerklärung</h1>
  <h2 id="art13">Informationen zur Datenverarbeitung (Art. 13 DSGVO)</h2>
  <div class="pre">${T("privacy_text")}</div>
</main>`);
  };
  draw();
  if (query.zu) {
    const target = $("#" + CSS.escape(query.zu), root);
    if (target) target.scrollIntoView();
  }
  on(root, "click", "#privacy-back", (ev) => {
    ev.preventDefault();
    if (history.length > 1) history.back(); else go("/formular");
  });
  const unsub = store.subscribe(draw);
  return () => { unsub(); };
}

// Alle Wege führen zum selben Formular; #/warteschlange (früher die eigene Anmeldung) öffnet es mit angekreuzter Probefahrt.
register("/formular", (ctx) => formScreen(ctx), { kiosk: true });
register("/warteschlange", (ctx) => formScreen({ ...ctx, preselect: true }), { kiosk: true });
register("/warteschlange/ticket/:id", ticketScreen, { kiosk: true, bodyClass: "kiosk" });
register("/danke", thanksScreen, { kiosk: true });
register("/datenschutz", privacyScreen);
