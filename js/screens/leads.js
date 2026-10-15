// Interessenten (Admin): /admin/interessenten – Liste mit Suche, Filter nach Interesse, Export (CSV/Excel) und Löschen.
// Die Interessenten entstehen im Kundenformular (screens/form.js): jedes Interesse außer der Probefahrt, auch zusammen mit einer
// Probefahrt-Nummer. Standalone: der Admin sucht, filtert und exportiert lokal (CSV/Excel aus export.js). Markup und Texte entsprechen
// admin/leads.html der Go-Version; Gestaltung nach ui-review.md §5.6 (Suche, Filter-Segment, Karten, Export- und Aktions-Sheet).
import { register } from "../router.js";
import { html, render, on, $, $$, flash, adminShell, ask, shellKey, openSheet } from "../ui.js";
import { icon } from "../icons.js";
import { store } from "../store.js";
import * as actions from "../actions.js";
import { interestList, splitPipe, deDate, deTime, parseTS, today, telLink, submissionKey } from "../model.js";
import { safeCell, downloadCSV, downloadXLSX } from "../export.js";

// Eigener Wurzelknoten je Screen-Aufruf: Ereignis-Handler hängen daran und verschwinden mit dem nächsten
// Screen, statt sich bei jedem Besuch auf #app zu stapeln (sonst würde ein Tippen mehrfach speichern).
function mount(el) {
  const root = document.createElement("div");
  el.replaceChildren(root);
  return root;
}

// --- Admin (/admin/interessenten) -----------------------------------------------------------------------
// Suche in Kleinschreibung über Name, E-Mail, Telefon, PLZ, Notizen; Interessen-Filter; neueste zuerst.
function filterLeads(leads, { q, interest }, interests) {
  const needle = String(q || "").trim().toLowerCase();
  const want = interests.includes(interest) ? interest : "";
  const out = [];
  for (let i = leads.length - 1; i >= 0; i--) {
    const l = leads[i], list = splitPipe(l.interests);
    if (want && !list.includes(want)) continue;
    if (needle && ![l.name, l.email, l.phone, l.zip_code, l.notes].join(" ").toLowerCase().includes(needle)) continue;
    out.push({ ...l, list });
  }
  return out;
}

// Zeitpunkt knapp: heute nur die Uhrzeit, sonst Tag und Monat (ein anderes Jahr mit Jahreszahl)
function when(ts) {
  const d = parseTS(ts);
  if (!d) return ts || "";
  if (String(ts).startsWith(today())) return deTime(ts);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear() === new Date().getFullYear() ? "" : d.getFullYear()} ${deTime(ts)}`;
}

// Karte: Name 17/600 + „…“ (Aktionen im Sheet, dort Löschen in Rot) · Interessen und Zeit als Text (mit „Probefahrt Nr. 7“, wenn der
// Besucher im selben Absenden auch eine Nummer bekam) · Kontakt als markierbarer Text · Notiz als Zitat · Segment [E-Mail | Anrufen]
// (44 px) für die vorhandenen Felder
function cardView(l, drive) {
  const bits = [];
  if (l.list.length) bits.push(html`<span class="lead-interests">${l.list.join(" · ")}</span>`);
  bits.push(html`<time datetime="${String(l.created_at).replace(" ", "T")}">${when(l.created_at)}</time>`);
  if (drive) bits.push(html`<span class="lead-drive">Probefahrt Nr. ${drive.number}</span>`);
  if (l.source && l.source !== "Formular") bits.push(html`<span class="lead-source">${l.source}</span>`);
  const contact = [l.email, l.phone, l.zip_code].filter(Boolean).join(" · ");
  const acts = [];
  if (l.email) acts.push(html`<a href="mailto:${l.email}">${icon("mail")}E-Mail</a>`);
  if (l.phone) acts.push(html`<a href="${telLink(l.phone)}">${icon("phone")}Anrufen</a>`);
  return html`
<article class="card lead-card" data-id="${l.id}">
  <div class="lead-top">
    <div class="lead-who">
      <h2>${l.name}</h2>
      <p class="lead-meta">${bits.map((b, i) => html`${i ? " · " : ""}${b}`)}</p>
    </div>
    <button type="button" class="btn quiet icon" data-lead-menu="${l.id}" aria-label="Weitere Aktionen zu ${l.name}">${icon("more")}</button>
  </div>
  ${contact ? html`<p class="lead-contact">${contact}</p>` : ""}
  ${l.notes ? html`<p class="lead-note">${l.notes}</p>` : ""}
  ${acts.length ? html`<div class="seg lead-actions">${acts}</div>` : ""}
</article>`;
}

function cardsView(leads, queue) {
  if (!leads.length) return html`<div class="empty">${icon("search")}<h3>Keine Interessenten gefunden</h3><p>Ändere die Suche oder den Filter.</p></div>`;
  const drives = new Map(queue.map((e) => [submissionKey(e), e]));   // Probefahrt-Nummer zum selben Absenden des Kundenformulars
  return html`${leads.map((l) => cardView(l, drives.get(submissionKey(l))))}`;
}

// „3 von 3 Interessenten · 1 heute“ – ersetzt die Kennzahlkacheln (Gesamt/Heute); die Zahlen je Interesse stehen im Filter
function summaryView(shown, leads) {
  const todayN = leads.filter((l) => String(l.created_at || "").startsWith(today())).length;
  return html`<b id="lead-count">${shown}</b> von <b id="lead-total">${leads.length}</b> Interessenten · <b id="lead-today" data-count="today">${todayN}</b> heute`;
}

const countOf = (leads, interest) => (interest ? leads.filter((l) => splitPipe(l.interests).includes(interest)).length : leads.length);

// Filter als Auswahl-Segment (Alle · Interessen mit Anzahl); mehr als vier Einträge scrollen waagerecht
function filterView(state, leads, interests) {
  const item = (value, label) => {
    const on = (state.interest || "") === value;
    return html`<button type="button" class="${on ? "on" : ""}" aria-pressed="${String(on)}" data-interest="${value}">${label} <span class="n">${countOf(leads, value)}</span></button>`;
  };
  return html`${item("", "Alle")}${interests.map((i) => item(i, i))}`;
}

// Sheets hängen außerhalb der Kartenliste (sie überleben deren Neu-Rendern) und werden je Öffnen befüllt
const sheetHead = (id, title, sub) => html`
  <div class="sheet-h">
    <h2 id="${id}-title"><span id="${id}-name">${title}</span><small id="${id}-sub">${sub}</small></h2>
    <form method="dialog"><button class="btn quiet icon" aria-label="Schließen">${icon("x")}</button></form>
  </div>`;

const exportSheet = () => html`
<dialog class="sheet" id="lead-export" aria-labelledby="lead-export-title">
  ${sheetHead("lead-export", "Exportieren", "")}
  <div class="sheet-b">
    <div class="list">
      <button type="button" class="row act" data-export="xlsx">${icon("download")}<span class="grow"><span class="ttl">Excel (.xlsx)</span><span class="desc">Zum Weiterarbeiten in Excel</span></span></button>
      <button type="button" class="row act" data-export="csv">${icon("download")}<span class="grow"><span class="ttl">CSV (.csv)</span><span class="desc">Für andere Programme, mit Semikolon getrennt</span></span></button>
    </div>
  </div>
</dialog>`;

const menuSheet = () => html`
<dialog class="sheet" id="lead-menu" aria-labelledby="lead-menu-title">
  ${sheetHead("lead-menu", "", "")}
  <div class="sheet-b">
    <div class="list">
      <button type="button" class="row act danger" data-delete="">${icon("trash")}<span class="grow"><span class="ttl">Löschen</span><span class="desc">Entfernt den Interessenten endgültig.</span></span></button>
    </div>
  </div>
</dialog>`;

function adminView(state) {
  const cfg = store.settings, leads = store.data.leads, interests = interestList(cfg);
  if (!leads.length) {
    // Leer: kein Export, keine Suche – nur der nächste Schritt
    return html`
  <div class="page-head"><h1 class="title">Interessenten</h1></div>
  <div class="empty">${icon("user")}<h3>Noch keine Interessenten</h3><p>Öffne das Formular und gib das Tablet weiter.</p><a class="btn primary" href="#/formular">Formular öffnen</a></div>`;
  }
  const shown = filterLeads(leads, state, interests);
  return html`
  <div class="page-head">
    <h1 class="title">Interessenten</h1>
    <div class="actions"><button type="button" class="btn secondary" id="lead-export-open">${icon("download")}Exportieren</button></div>
  </div>
  <p class="sub count" id="lead-sum">${summaryView(shown.length, leads)}</p>

  <form class="search" id="lead-search" role="search" autocomplete="off">
    <div class="has-ic">${icon("search")}<input type="search" name="q" value="${state.q}" placeholder="Name, E-Mail, Telefon suchen" aria-label="Interessenten suchen"></div>
  </form>

  ${interests.length ? html`<div class="seg pick lead-filter" id="lead-filter" role="group" aria-label="Nach Interesse filtern">${filterView(state, leads, interests)}</div>` : ""}

  <section class="cards" id="lead-cards">${cardsView(shown, store.data.queue)}</section>
  ${exportSheet()}
  ${menuSheet()}`;
}

// Export mit denselben Filtern wie die Liste: Datum, Name, E-Mail, Telefon, PLZ, je Interesse Ja/Nein, [Weitere Interessen],
// [Probefahrt-Nr.], Notizen, Quelle, Einwilligung. „Weitere Interessen“ steht nur da, wenn es Werte gibt, die nicht (mehr) in den
// Einstellungen stehen (z. B. „Testfahrt“ aus der Zeit der zwei Formulare) – sie fielen sonst aus dem Export. „Probefahrt-Nr.“
// (bei aktiver Warteschlange) ist die Nummer, die der Besucher im selben Absenden bekam: der Schlüssel zwischen Interessenten und Probefahrten.
function exportLeads(kind, state) {
  const cfg = store.settings, interests = interestList(cfg);
  const leads = filterLeads(store.data.leads, state, interests);
  const other = (l) => l.list.filter((i) => !interests.includes(i));
  const extra = leads.some((l) => other(l).length > 0);
  const drives = new Map(store.data.queue.map((e) => [submissionKey(e), e.number]));
  const header = ["Datum", "Name", "E-Mail", "Telefon", "PLZ", ...interests, ...(extra ? ["Weitere Interessen"] : []),
    ...(cfg.module_queue ? ["Probefahrt-Nr."] : []), "Notizen", "Quelle", "Einwilligung"];
  const rows = leads.map((l) => [
    deDate(l.created_at), safeCell(l.name), safeCell(l.email), safeCell(l.phone), l.zip_code,
    ...interests.map((i) => (l.list.includes(i) ? "Ja" : "Nein")),
    ...(extra ? [safeCell(other(l).join(" · "))] : []),
    ...(cfg.module_queue ? [drives.get(submissionKey(l)) || ""] : []),
    safeCell(l.notes), l.source || "Formular", deDate(l.consent),
  ]);
  if (kind === "xlsx") downloadXLSX("interessenten", [{ title: "Interessenten", header, rows }], cfg.accent_color);
  else downloadCSV("interessenten", header, rows);
}

function adminScreen({ el }) {
  const root = mount(el);
  const state = { q: "", interest: "" }; // Suche/Filter leben nur im Screen, nicht in der URL
  let shellSig = "";
  // Rahmen + alles, was nur bei einem Gesamt-Neuaufbau stimmt: Interessen-Einstellung (Filter), leer/nicht leer (Kopf, Suche, Export)
  const frame = () => shellKey() + "|" + store.settings.interests + "|" + (store.data.leads.length ? "L" : "0");
  const draw = () => {
    if (state.interest && !interestList(store.settings).includes(state.interest)) state.interest = "";
    render(root, adminShell("leads", adminView(state), { title: "Interessenten" }));
    shellSig = frame();
  };
  // Beim Tippen und bei Datenänderungen (auch von anderen Geräten) nur Zusammenfassung, Filter-Zahlen und Liste erneuern –
  // Kopfleiste, Suchfeld (Fokus!), offene Sheets und Scroll-Position bleiben unberührt
  const drawResults = () => {
    const interests = interestList(store.settings), leads = store.data.leads;
    const shown = filterLeads(leads, state, interests);
    const sum = $("#lead-sum", root), cards = $("#lead-cards", root), seg = $("#lead-filter", root);
    if (sum) render(sum, summaryView(shown.length, leads));
    if (seg) {
      for (const b of $$("[data-interest]", seg)) {
        const value = b.dataset.interest, active = (state.interest || "") === value, n = $(".n", b);
        b.classList.toggle("on", active);
        b.setAttribute("aria-pressed", String(active));
        if (n) n.textContent = String(countOf(leads, value));
      }
    }
    if (cards) render(cards, cardsView(shown, store.data.queue));
  };
  draw();
  on(root, "submit", "#lead-search", (ev) => ev.preventDefault());
  on(root, "input", "#lead-search input[name=q]", (ev, input) => { state.q = input.value; drawResults(); });
  on(root, "click", "[data-interest]", (ev, btn) => { state.interest = btn.dataset.interest; drawResults(); });

  // Export (Sheet „Exportieren“): wirkt mit der aktuellen Auswahl aus Suche und Filter
  on(root, "click", "#lead-export-open", (ev, btn) => {
    const n = filterLeads(store.data.leads, state, interestList(store.settings)).length;
    const narrowed = state.interest || state.q.trim();
    $("#lead-export-sub", root).textContent = `${n} ${n === 1 ? "Interessent" : "Interessenten"}${narrowed ? " (aktuelle Auswahl)" : ""}`;
    openSheet($("#lead-export", root), { opener: btn });
  });
  on(root, "click", "#lead-export [data-export]", (ev, btn) => {
    exportLeads(btn.dataset.export, state);
    $("#lead-export", root).close();
  });

  // Aktionen je Interessent (Sheet): Löschen in Rot, mit Rückfrage
  on(root, "click", "[data-lead-menu]", (ev, btn) => {
    const lead = store.data.leads.find((l) => l.id === btn.dataset.leadMenu);
    if (!lead) return;
    const dlg = $("#lead-menu", root);
    $("#lead-menu-name", root).textContent = lead.name;
    $("#lead-menu-sub", root).textContent = `Interessent · ${deDate(lead.created_at)}`;
    $("[data-delete]", dlg).dataset.delete = lead.id;
    openSheet(dlg, { opener: btn });
  });
  on(root, "click", "#lead-menu [data-delete]", async (ev, btn) => {
    const dlg = $("#lead-menu", root);
    const lead = store.data.leads.find((l) => l.id === btn.dataset.delete);
    if (!lead) { dlg.close(); return; }
    // Mit Probefahrt-Nummer im selben Absenden: der Warteschlangen-Eintrag ist ein eigener Datensatz und bleibt stehen
    const drive = store.data.queue.find((e) => submissionKey(e) === submissionKey(lead));
    if (!ask(`Interessent „${lead.name}“ wirklich löschen?${drive ? `\n\nDie Probefahrt-Anmeldung Nr. ${drive.number} bleibt in der Warteschlange bestehen und muss dort gesondert gelöscht werden.` : ""}`)) return;
    dlg.close();
    const r = await store.update((d) => actions.deleteLead(d, lead.id));
    if (r.error) flash(r.error, "error"); else flash("Interessent gelöscht.");
  });

  const unsub = store.subscribe((_, info) => {
    if (info && info.hub) return;   // Hub-Zustand allein ändert die Liste nicht
    if (frame() !== shellSig) draw(); else drawResults();
  });
  return () => { unsub(); };
}

register("/admin/interessenten", adminScreen, { admin: true });
