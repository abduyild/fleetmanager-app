// Aktionen auf den Daten (Port der Regeln aus SPEZIFIKATION A5 bzw. internal/app/queue_admin.go).
// Jede Funktion arbeitet auf einem Entwurf `d` (siehe store.update) und liefert entweder
// { error: "Text" } (nichts geändert, Aufrufer zeigt den Text) oder ein Ergebnis-Objekt.
// Lizenz (license.js): Aufrufen, Starten und Anlegen sind ohne gültige Lizenz gesperrt – diese Funktionen beginnen mit
// `const blocked = licenseBlock(d); if (blocked) return blocked;`: signup, addLead, callEntry, startDrive, requeue, reopen, saveVehicle.
// Alles andere (Fahrt beenden, nicht erschienen, Löschen, Tagesabschluss, Schäden, Sperren/Freigeben, Archivieren) bleibt möglich.
import * as m from "./model.js";
import { licenseBlock } from "./license.js";

const S = m.STATUS;
const err = (text) => ({ error: text });
const entryOf = (d, id) => d.queue.find((e) => e.id === id);
const codeOf = (d, e) => {
  const v = d.vehicles.find((x) => x.id === e.vehicle_id);
  return v ? v.code : (e.vehicle || "").split(" · ")[0].trim();
};

// Hinweis nach dem Beenden: „Fahrzeug 2 ist frei · Nächster: Nr. 15 Schmidt“
function endHint(d, e) {
  const v = d.vehicles.find((x) => x.id === e.vehicle_id);
  let text = "Fahrt beendet";
  if (v && !v.archived_at) text = v.blocked_reason ? `Fahrzeug ${v.code} gesperrt (${v.blocked_reason})` : `Fahrzeug ${v.code} ist frei`;
  const next = m.waiting(d.queue)[0];
  if (next) text += ` · Nächster: Nr. ${next.number} ${next.name}`;
  return { ok: true, hint: text, next_id: next ? next.id : "" };
}

// --- Anmeldung ----------------------------------------------------------------------------------
// Neuer Warteschlangen-Eintrag (+ Interessent bei Marketing-Opt-in). refs = { queue, marketing } (consentRef-Werte).
export function signup(d, cfg, data, { kiosk = true, marketing = false, refs = {} } = {}) {
  const blocked = licenseBlock(d); if (blocked) return blocked;
  const ts = m.now(), day = m.today();
  const e = {
    id: m.newId(), token: "", number: String(m.nextNumber(d.queue, day)), day, name: data.name, phone: data.phone, email: data.email,
    consent: ts, status: S.WAITING, created_at: ts, called_at: "", started_at: "", ended_at: "", vehicle: "", note: "",
    vehicle_id: "", checks: "", staff: "", end_condition: "", end_note: "", source: kiosk ? "kiosk" : "handy",
    consent_ref: refs.queue || "", marketing_consent: marketing ? ts : "",
  };
  d.queue.push(e);
  if (marketing && cfg.queue_marketing_optin) {
    const interests = m.interestList(cfg);
    const interest = interests.find((i) => i.toLowerCase().includes("fahrt")) || interests[0] || "";
    d.leads.push({
      id: m.newId(), created_at: ts, name: data.name, email: data.email, phone: data.phone, zip_code: "",
      interests: interest, notes: `Stand-Warteschlange Nr. ${e.number}`, consent: ts, source: "Warteschlange", consent_ref: refs.marketing || "",
    });
  }
  return { ok: true, entry: e };
}

// --- Interessenten ------------------------------------------------------------------------------
export function addLead(d, data, { source = "Formular", consentRef = "" } = {}) {
  const blocked = licenseBlock(d); if (blocked) return blocked;
  const ts = m.now();
  const lead = { id: m.newId(), created_at: ts, name: data.name, email: data.email, phone: data.phone, zip_code: data.zip_code,
    interests: data.interests.join("|"), notes: data.notes, consent: ts, source, consent_ref: consentRef };
  d.leads.push(lead);
  return { ok: true, lead };
}
export function deleteLead(d, id) {
  const i = d.leads.findIndex((l) => l.id === id);
  if (i < 0) return err("Interessent nicht gefunden.");
  d.leads.splice(i, 1);
  return { ok: true };
}

// --- Kundenformular: Probefahrt und Interessen in EINEM Absenden ---------------------------------------
// Texte der Fehlermeldungen des Kundenformulars (screens/form.js vergleicht phoneForDrive, wenn die Probefahrt wieder abgewählt wird)
export const MSG = {
  name: "Bitte geben Sie Ihren Namen an.",
  phone: "Bitte geben Sie eine gültige Telefonnummer an.",
  phoneForDrive: "Bitte geben Sie Ihre Telefonnummer an.",
  email: "Bitte geben Sie eine gültige E-Mail-Adresse an.",
  contact: "Bitte geben Sie Telefon oder E-Mail an.",
  zip: "Bitte geben Sie eine gültige Postleitzahl an.",
  interests: "Bitte wählen Sie mindestens ein Interesse.",
  notes: "Maximal 2000 Zeichen.",
  consent: "Bitte bestätigen Sie die Einwilligung.",
  off: "Das Formular ist zurzeit nicht aktiv.",
  changed: "Das Formular wurde gerade geändert – bitte noch einmal absenden.",
};

// input: { name, phone, email, zip_code, notes, interests: [], queue, consent } wie aus der Maske gelesen.
// Pflicht: Name, Einwilligung, Telefon ODER E-Mail (mit „Probefahrt“ das Telefon: wir rufen an) und – wo es Optionen gibt – mindestens eine.
// Liefert [data, errors]; data.queue sagt, ob eine Nummer vergeben wird, data.interests nur Interessen aus den Einstellungen.
// Ohne aktives Interessenten-Modul gibt es weder PLZ noch Notizen noch Interessen, ohne Warteschlange keine Probefahrt.
export function validateCustomerForm(input, cfg) {
  const o = m.formOptions(cfg);
  const data = {
    name: m.cut(String(input.name || "").trim(), 120), phone: m.cut(String(input.phone || "").trim(), 40), email: m.cut(String(input.email || "").trim(), 160),
    zip_code: o.leads ? m.cut(String(input.zip_code || "").trim(), 10) : "", notes: o.leads ? String(input.notes || "").trim() : "",
    interests: (input.interests || []).filter((i) => o.interests.includes(i)),
    queue: o.queue && (o.alone || !!input.queue), consent: !!input.consent,
  };
  const errors = {};
  if (o.off) errors.form = MSG.off;
  if (!data.name) errors.name = MSG.name;
  if (data.phone && !m.PHONE_RE.test(data.phone)) errors.phone = MSG.phone;
  else if (data.queue && !data.phone) errors.phone = MSG.phoneForDrive;
  if (data.email && !m.EMAIL_RE.test(data.email)) errors.email = MSG.email;
  if (!data.phone && !data.email && !data.queue) errors.contact = MSG.contact;   // eines von beiden; mit Probefahrt meldet schon das Telefonfeld
  if (data.zip_code && !m.ZIP_RE.test(data.zip_code)) errors.zip_code = MSG.zip;
  if (!o.alone && (o.queue || o.interests.length) && !data.queue && !data.interests.length) errors.interests = MSG.interests;
  if ([...data.notes].length > 2000) errors.notes = MSG.notes;
  if (!data.consent) errors.consent = MSG.consent;
  return [data, errors];
}

// Legt an, was angekreuzt wurde – getrennt gespeichert: mit „Probefahrt“ (data.queue) einen Warteschlangen-Eintrag mit Nummer (signup);
// mit weiteren Interessen, PLZ oder Notizen – und ohne Probefahrt immer, sonst ginge die Anfrage verloren – einen Interessenten
// (addLead, Quelle „Formular“). Beides zusammen bekommt denselben Zeitstempel, damit sich Nummer und Interessen später zuordnen
// lassen (model.submissionKey). refs = { queue, lead }: Einwilligungs-Referenzen (consentRef des ausgefüllten Einwilligungstexts)
// für beide Datensätze. Liefert { ok, entry?, lead? } oder { error }; bei einem Fehler im zweiten Schritt verwirft store.update alles.
export function submitCustomerForm(d, cfg, data, { kiosk = true, refs = {} } = {}) {
  const o = m.formOptions(cfg);
  if (o.off) return err(MSG.off);
  const out = { ok: true };
  if (o.queue && data.queue) {
    const r = signup(d, cfg, data, { kiosk, refs: { queue: refs.queue || refs.lead || "" } });
    if (r.error) return r;
    out.entry = r.entry;
  }
  if (o.leads && (!data.queue || data.interests.length || data.notes || data.zip_code)) {
    const r = addLead(d, data, { source: "Formular", consentRef: refs.lead || refs.queue || "" });
    if (r.error) return r;
    out.lead = r.lead;
    if (out.entry) r.lead.created_at = r.lead.consent = out.entry.created_at;
  }
  // Nichts angelegt: die Module wurden zwischen Prüfung und Speichern umgestellt (z. B. von einem anderen Gerät) – nie „Danke“ ohne Speichern
  if (!out.entry && !out.lead) return err(MSG.changed);
  return out;
}

// --- Warteschlange: Aktionen (A5) ---------------------------------------------------------------
export function callEntry(d, id) {
  const blocked = licenseBlock(d); if (blocked) return blocked;
  const e = entryOf(d, id);
  if (!e) return err("Eintrag nicht gefunden.");
  if (e.status === S.WAITING || e.status === S.CALLED) { e.status = S.CALLED; e.called_at = m.now(); }
  return { ok: true };
}

// Start: ohne Tracking → fertig; mit Tracking und Fahrzeugen → Fahrzeug Pflicht, Checks Pflicht, Takeover/Force.
export function startDrive(d, cfg, id, { vehicle_id = "", checks = [], staff = "", takeover = false, force = false } = {}) {
  const blocked = licenseBlock(d); if (blocked) return blocked;
  const e = entryOf(d, id);
  if (!e) return err("Eintrag nicht gefunden.");
  if (e.status !== S.WAITING && e.status !== S.CALLED) return err("Dieser Eintrag kann nicht gestartet werden.");
  const ts = m.now();
  if (!cfg.tracking_enabled) {
    e.status = S.DONE; e.ended_at = ts; e.called_at = e.called_at || ts;
    return { ok: true };
  }
  const active = m.activeVehicles(d.vehicles);
  if (active.length) {
    if (!vehicle_id) return err("Bitte ein Fahrzeug wählen.");
    const v = d.vehicles.find((x) => x.id === vehicle_id);
    if (!v || v.archived_at) return err("Fahrzeug nicht gefunden.");
    const required = m.startCheckList(cfg);
    if (required.some((c) => !checks.includes(c))) return err("Bitte alle Prüfungen bestätigen.");
    const [state, other] = m.vehicleStatus(v, d.queue, cfg);
    if ((state === m.V.DRIVING || state === m.V.LATE) && other && other.id !== e.id) {
      if (!takeover) return err(m.conflictMessage(v, state, other));
      other.status = S.DONE; other.ended_at = ts; other.end_condition = m.END_OK; other.end_note = `beendet beim Start von Nr. ${e.number}`;
    } else if (state === m.V.BLOCKED) {
      if (!force) return err(m.conflictMessage(v, state, null));
      v.blocked_reason = ""; v.blocked_at = ""; v.updated_at = ts;
    }
    e.vehicle_id = v.id; e.vehicle = m.vehicleLabel(v); e.checks = required.join("|");
    const st = String(staff || "").trim();
    e.staff = m.staffList(cfg).includes(st) ? m.cut(st, 20) : "";
  }
  e.status = S.DRIVING; e.started_at = ts; e.called_at = e.called_at || ts; e.ended_at = "";
  e.end_condition = ""; e.end_note = "";
  return { ok: true };
}

// Ende: ok oder auffaellig (Text Pflicht, Schaden anlegen, optional Fahrzeug sperren). Liefert den Hinweis.
export function endDrive(d, id, { end_condition = m.END_OK, end_note = "", block_vehicle = false } = {}) {
  const e = entryOf(d, id);
  if (!e) return err("Eintrag nicht gefunden.");
  if (e.status !== S.DRIVING) return err("Diese Fahrt läuft nicht.");
  const ts = m.now();
  const note = m.cut(String(end_note || "").trim(), 300);
  if (end_condition === m.END_CONSPICUOUS) {
    if ([...note].length < 3) return err("Bitte beschreiben, was aufgefallen ist.");
    e.end_condition = m.END_CONSPICUOUS; e.end_note = note;
    if (e.vehicle_id) {
      d.damages.push(m.newDamage(e.vehicle_id, e.id, note));
      const v = d.vehicles.find((x) => x.id === e.vehicle_id);
      if (block_vehicle && v) { v.blocked_reason = "Schaden"; v.blocked_at = ts; v.updated_at = ts; }
    }
  } else {
    e.end_condition = m.END_OK; e.end_note = "";
  }
  e.status = S.DONE; e.ended_at = ts;
  return endHint(d, e);
}
export function noShow(d, id) {
  const e = entryOf(d, id);
  if (!e) return err("Eintrag nicht gefunden.");
  if (e.status === S.WAITING || e.status === S.CALLED) { e.status = S.NO_SHOW; e.ended_at = m.now(); }
  return { ok: true };
}
export function requeue(d, id) {
  const blocked = licenseBlock(d); if (blocked) return blocked;
  const e = entryOf(d, id);
  if (!e) return err("Eintrag nicht gefunden.");
  if ([S.CALLED, S.NO_SHOW, S.CANCELLED].includes(e.status)) { e.status = S.WAITING; e.called_at = ""; e.ended_at = ""; }
  return { ok: true };
}
// Fortsetzen: nur wenn das Fahrzeug nicht inzwischen bei einer anderen Fahrt ist.
export function reopen(d, id) {
  const blocked = licenseBlock(d); if (blocked) return blocked;
  const e = entryOf(d, id);
  if (!e) return err("Eintrag nicht gefunden.");
  if (e.status !== S.DONE || !e.started_at) return err("Diese Fahrt kann nicht fortgesetzt werden.");
  if (e.vehicle_id) {
    const other = m.drivingEntry(d.queue, e.vehicle_id);
    if (other) return err(`Fahrzeug ${codeOf(d, e)} ist inzwischen bei Nr. ${other.number}.`);
  }
  e.status = S.DRIVING; e.ended_at = ""; e.end_condition = ""; e.end_note = "";
  return { ok: true };
}
export function cancelEntry(d, id) {
  const e = entryOf(d, id);
  if (!e) return err("Eintrag nicht gefunden.");
  if (e.status === S.WAITING || e.status === S.CALLED) { e.status = S.CANCELLED; e.ended_at = m.now(); }
  return { ok: true };
}
export function deleteEntry(d, id) {
  const i = d.queue.findIndex((e) => e.id === id);
  if (i < 0) return err("Eintrag nicht gefunden.");
  if (d.queue[i].status === S.DRIVING) return err("Bitte zuerst die Fahrt beenden.");
  d.queue.splice(i, 1);
  return { ok: true };
}
export function setNote(d, id, note) {
  const e = entryOf(d, id);
  if (!e) return err("Eintrag nicht gefunden.");
  e.note = m.cut(String(note || "").trim(), 500);
  return { ok: true };
}
// Tagesabschluss: verweigert bei offener Fahrt, sonst wartend/aufgerufen → abgesagt.
export function clearDay(d) {
  const open = d.queue.find((e) => e.status === S.DRIVING);
  if (open) {
    const code = codeOf(d, open);
    return err(code ? `Fahrzeug ${code} ist noch unterwegs: Nr. ${open.number} ${open.name}. Bitte zuerst die Fahrt beenden.`
      : `Nr. ${open.number} ${open.name} ist noch unterwegs. Bitte zuerst die Fahrt beenden.`);
  }
  const ts = m.now();
  let n = 0;
  for (const e of d.queue) if (e.status === S.WAITING || e.status === S.CALLED) { e.status = S.CANCELLED; e.ended_at = ts; n++; }
  return { ok: true, count: n };
}

// --- Fahrzeuge ----------------------------------------------------------------------------------
export function saveVehicle(d, cfg, input, selfId = "", predamages = []) {
  const blocked = licenseBlock(d); if (blocked) return blocked;
  const [v, errors] = m.validateVehicle(input, d.vehicles, selfId);
  if (Object.keys(errors).length) return { error: "Bitte Eingaben prüfen.", errors };
  let vehicle, trackingOn = false;
  if (selfId) {
    vehicle = d.vehicles.find((x) => x.id === selfId);
    if (!vehicle) return err("Fahrzeug nicht gefunden.");
    Object.assign(vehicle, v, { updated_at: m.now() });
  } else {
    vehicle = m.newVehicle(v);
    d.vehicles.push(vehicle);
    for (const line of predamages) d.damages.push(m.newDamage(vehicle.id, "", line));
    if (!cfg.tracking_enabled) { d.settings.tracking_enabled = true; trackingOn = true; }
  }
  return { ok: true, vehicle, trackingOn };
}
export function blockVehicle(d, vid, reason) {
  const v = d.vehicles.find((x) => x.id === vid);
  if (!v) return err("Fahrzeug nicht gefunden.");
  if (v.archived_at) return err(`Fahrzeug ${v.code} ist archiviert.`);
  v.blocked_reason = m.cut(String(reason || "").trim(), 60) || "Sonstiges"; v.blocked_at = m.now(); v.updated_at = v.blocked_at;
  return { ok: true };
}
export function unblockVehicle(d, vid) {
  const v = d.vehicles.find((x) => x.id === vid);
  if (!v) return err("Fahrzeug nicht gefunden.");
  v.blocked_reason = ""; v.blocked_at = ""; v.updated_at = m.now();
  return { ok: true };
}
export function archiveVehicle(d, cfg, vid) {
  const v = d.vehicles.find((x) => x.id === vid);
  if (!v) return err("Fahrzeug nicht gefunden.");
  const [state, entry] = m.vehicleStatus(v, d.queue, cfg);
  if (state === m.V.DRIVING || state === m.V.LATE) return err(m.conflictMessage(v, state, entry));
  v.archived_at = m.now(); v.updated_at = v.archived_at;
  return { ok: true };
}
export function restoreVehicle(d, vid) {
  const v = d.vehicles.find((x) => x.id === vid);
  if (!v) return err("Fahrzeug nicht gefunden.");
  for (const o of d.vehicles) {
    if (o.id === vid || o.archived_at) continue;
    if (o.code === v.code) return err(`Kürzel ${v.code} ist inzwischen vergeben.`);
    if (v.plate && o.plate === v.plate) return err(`Kennzeichen ${v.plate} ist inzwischen vergeben.`);
  }
  v.archived_at = ""; v.updated_at = m.now();
  return { ok: true };
}
export function deleteVehicle(d, vid) {
  const i = d.vehicles.findIndex((x) => x.id === vid);
  if (i < 0) return err("Fahrzeug nicht gefunden.");
  if (m.isReferenced(vid, d.queue, d.damages)) return err("Fahrzeug hat Fahrten oder Schäden – bitte archivieren.");
  d.vehicles.splice(i, 1);
  return { ok: true };
}
export function addDamage(d, vid, text) {
  if (!d.vehicles.some((x) => x.id === vid)) return err("Fahrzeug nicht gefunden.");
  if ([...String(text || "").trim()].length < 3) return err("Bitte den Schaden kurz beschreiben (mindestens 3 Zeichen).");
  d.damages.push(m.newDamage(vid, "", text));
  return { ok: true };
}
export function resolveDamage(d, did) {
  const x = d.damages.find((y) => y.id === did);
  if (!x) return err("Schaden nicht gefunden.");
  x.resolved_at = m.now();
  return { ok: true };
}
export function deleteDamage(d, did) {
  const i = d.damages.findIndex((y) => y.id === did);
  if (i < 0) return err("Schaden nicht gefunden.");
  d.damages.splice(i, 1);
  return { ok: true };
}
