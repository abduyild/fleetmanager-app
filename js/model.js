// Datenmodell und reine Fachlogik der Standalone-App (Port von internal/model, gleiche Feldnamen wie die
// CSV-Spalten der Go-Version, damit Exporte und ein späterer Abgleich kompatibel bleiben).
// Keine DOM-Zugriffe, kein Speicher – nur Funktionen über Daten.

export const STATUS = {
  WAITING: "wartend", CALLED: "aufgerufen", DRIVING: "unterwegs",
  DONE: "fertig", NO_SHOW: "nicht_erschienen", CANCELLED: "abgesagt",
};
export const STATUS_LABELS = {
  wartend: "Wartet", aufgerufen: "Aufgerufen", unterwegs: "Unterwegs",
  fertig: "Erledigt", nicht_erschienen: "Nicht erschienen", abgesagt: "Abgesagt",
};
export const statusLabel = (s) => STATUS_LABELS[s] || s;
export const END_OK = "ok";
export const END_CONSPICUOUS = "auffaellig";

// Fahrzeug-Status (abgeleitet, nie gespeichert)
export const V = { AVAILABLE: "verfuegbar", DRIVING: "unterwegs", LATE: "ueberfaellig", BLOCKED: "gesperrt", ARCHIVED: "archiviert" };
export const V_LABELS = { verfuegbar: "Verfügbar", unterwegs: "Unterwegs", ueberfaellig: "Überfällig", gesperrt: "Gesperrt", archiviert: "Archiviert" };
export const BLOCK_REASONS = ["Laden", "Schaden", "Pause", "Sonstiges"];
export const VEHICLE_COLORS = ["Weiß", "Schwarz", "Grau", "Silber", "Blau", "Rot", "Grün"];

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const PHONE_RE = /^\+?[0-9 ()/-]{6,20}$/;
export const ZIP_RE = /^[0-9]{4,5}$/;

// --- Zeit ---------------------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, "0");
export function now(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export function today(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// Tage seit 1970 (UTC) für ein Datum JJJJ-MM-TT; NaN bei Unsinn („2026-02-30“). So zählen Tage exakt, ohne Sommerzeit.
// Gemeinsam genutzt von license.js (Schlüssel) und codes.js (Aktivierungscodes).
const DAY_MS = 86400000;
export function dayNumber(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return NaN;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]), d = new Date(t);
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? t / DAY_MS : NaN;
}
export function addDays(iso, n) {
  const d = new Date((dayNumber(iso) + n) * DAY_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
// So viele Tage vor dem Ablauf gilt eine Lizenz als „läuft bald ab“ (Schlüssel und Aktivierungscodes; cmd/license rechnet ebenso)
export const EXPIRING_DAYS = 14;
export function parseTS(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s || "");
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}
export function deDate(s) {
  const d = parseTS(s);
  return d ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}` : (s || "");
}
export function deTime(s) {
  const d = parseTS(s);
  return d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "";
}
export function deDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || "");
  return m ? `${m[3]}.${m[2]}.${m[1]}` : (day || "");
}
export function durationSeconds(e) {
  const a = parseTS(e.started_at), b = parseTS(e.ended_at);
  if (!a || !b) return null;
  return Math.max(0, Math.floor((b - a) / 1000));
}
export function fmtDuration(sec) {
  if (sec === null || sec === undefined) return "–";
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
export function elapsedSince(ts, d = new Date()) {
  const t0 = parseTS(ts);
  if (!t0) return 0;
  return Math.max(0, Math.floor((d - t0) / 1000));
}

// --- Helfer -------------------------------------------------------------------------------------
export function newId() {
  const b = new Uint8Array(5);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
export const lines = (v) => String(v || "").split("\n").map((l) => l.trim()).filter(Boolean);
export const splitPipe = (v) => String(v || "").split("|").filter(Boolean);
export const firstName = (name) => String(name || "").split(" ")[0];
export const cut = (s, n) => [...String(s || "")].slice(0, n).join("");
export function maskPhone(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  return "… " + d.slice(-4);
}
export const num = (e) => parseInt(e.number, 10) || 0;

// SHA-256 als Hex – per WebCrypto; Rückfall in reinem JS für unsichere Kontexte (http im Stand-WLAN),
// in denen crypto.subtle fehlt.
export async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  if (typeof crypto !== "undefined" && crypto.subtle) {
    const buf = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  return sha256Fallback(bytes);
}
export function sha256Fallback(bytes) {
  const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const len = bytes.length, bitLen = len * 8;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes); padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, bitLen >>> 0); dv.setUint32(padded.length - 8, Math.floor(bitLen / 2 ** 32));
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let i = 0; i < padded.length; i += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4);
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
      const s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
      w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let j = 0; j < 64; j++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[j] + w[j]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  return H.map((x) => x.toString(16).padStart(8, "0")).join("");
}
// consentRef: sha256 des ausgefüllten Einwilligungstexts, 12 Hex-Zeichen (SPEZIFIKATION C7)
export async function consentRef(filledText) {
  return (await sha256Hex(filledText)).slice(0, 12);
}

// --- Einstellungen ------------------------------------------------------------------------------
// Stand der Standardwerte: 2 = ein Kundenformular statt zweier Formulare, 3 = Marke des Anbieters (oifach.digital, Logo-Datei
// icons/oifach-logo.svg, Platzhalter-Firmendaten) statt der früheren Beispielmarke Togg. Daten ohne diese Zahl oder mit einer kleineren
// (Altbestand, Backups) bekommen beim Laden einmal die neuen Standardwerte (migrateSettings: unveränderte Texte, die Marke nur, wenn
// sie unberührt ist); danach gilt, was der Admin einstellt – auch ein alter Standardwert.
export const SETTINGS_VERSION = 3;
export const DEFAULT_SETTINGS = {
  settings_version: SETTINGS_VERSION,
  brand_name: "oifach.digital", logo: "", favicon: "", accent_color: "#1e6fe0", public_url: "",
  module_leads: true, module_queue: true, tracking_enabled: false, queue_marketing_optin: false, show_eta: true,
  cars_count: 2, drive_minutes: 20, max_drive_minutes: 45,
  start_checks: "Führerschein gesehen\nProbefahrtvereinbarung unterschrieben", staff: "",
  contact_message: "Hallo {name}, Sie sind jetzt dran für Ihre {marke}-Probefahrt (Nr. {nummer}). Bitte kommen Sie zum Stand.",
  // Kundenformular (ein Formular für Probefahrt und Interessen). headline_accent bleibt als leerer Schlüssel für Altbestand:
  // die Überschrift ist EIN Text (migrateSettings hängt einen früheren „farbigen Teil“ an).
  page_title: "Entdecken Sie {marke}.", headline: "Entdecken Sie {marke}.", headline_accent: "",
  subline: "Sie interessieren sich für {marke}? Hinterlassen Sie uns gern Ihre Kontaktdaten.",
  interests: "Kaufinteresse\nFinanzierung\nLeasing",
  queue_option_label: "Probefahrt jetzt", queue_option_hint: "Sie bekommen eine Nummer und werden aufgerufen.",
  notes_placeholder: "Modell, Wunschtermin, Fragen …",
  submit_label: "Absenden",
  consent_text: "Ich willige ein, dass die {firma} die von mir angegebenen Daten zur Bearbeitung meiner Anfrage und, falls ich " +
    "eine Probefahrt wünsche, zur Organisation dieser Probefahrt speichert und mich dazu per Telefon, SMS, WhatsApp oder " +
    "E-Mail kontaktiert. Diese Einwilligung ist freiwillig. Ich kann sie jederzeit mit Wirkung für die Zukunft widerrufen, " +
    "z. B. per E-Mail an {email}. Die Rechtmäßigkeit der bis zum Widerruf erfolgten Verarbeitung bleibt davon unberührt.",
  thanks_title: "Vielen", thanks_title_accent: "Dank.",
  thanks_text: "Ihr Interesse wurde erfolgreich angemeldet. Wir melden uns in Kürze bei Ihnen.",
  // Die folgenden Texte gehörten zum früheren eigenen Anmeldeformular: sie bleiben für Altbestand (Backups) erhalten, das
  // Kundenformular nutzt nur noch consent_text. Im Formular bearbeitbar ist davon allein queue_called_text.
  queue_headline: "Probefahrt", queue_headline_accent: "ohne Warten.",
  queue_subline: "Melden Sie sich an – wir rufen Sie auf, sobald ein Fahrzeug frei ist. Sie können sich in der Zwischenzeit frei umsehen.",
  queue_submit_label: "In Warteschlange eintragen",
  queue_consent_text: "Ich willige ein, dass die {firma} meine Daten zur Organisation der Probefahrt speichert und " +
    "mich dafür per Telefon, SMS oder WhatsApp kontaktiert. Widerruf jederzeit an {email}.",
  queue_marketing_text: "Ich möchte zusätzlich Informationen und Angebote der {firma} zu {marke} per E-Mail und " +
    "Telefon erhalten. Widerruf jederzeit an {email}.",
  queue_waiting_text: "Lassen Sie diese Seite geöffnet – wir benachrichtigen Sie hier, sobald Sie dran sind.",
  queue_called_text: "Bitte kommen Sie jetzt zum {marke}-Stand. Ihr Fahrzeug wartet!",
  company: "Muster Autohaus GmbH", company_address: "Musterstraße 1, 12345 Musterstadt", privacy_email: "datenschutz@beispiel.de",
  legal_text: "Verantwortlich für die Datenverarbeitung ist die {firma}, {adresse}. Ihre Daten werden " +
    "ausschließlich zur Bearbeitung Ihrer Anfrage und zur Kontaktaufnahme auf Grundlage Ihrer " +
    "Einwilligung (Art. 6 Abs. 1 lit. a DSGVO) verarbeitet und nicht zu anderen Zwecken genutzt.",
  privacy_text: "Verantwortlicher: {firma}, {adresse}\n" +
    "Zweck: Bearbeitung Ihrer Anfrage bzw. Organisation Ihrer Probefahrt und Kontaktaufnahme\n" +
    "Rechtsgrundlage: Einwilligung, Art. 6 Abs. 1 lit. a DSGVO\n" +
    "Gespeicherte Daten: Name, Kontaktdaten, Interesse, Notizen, ggf. Zeitpunkte der Probefahrt\n" +
    "Widerruf: jederzeit per E-Mail an {email}\n\n" +
    "Hinweis: Platzhalter – bitte durch die vollständige Datenschutzerklärung ersetzen.",
  // Standalone: Stand-PIN schützt den Admin-Bereich auf dem Gerät (Format sha256:<salt>:<hex>, leer = keine PIN)
  admin_pin_hash: "",
  // Lizenz (siehe license.js): Aktivierungscode (XXX-XXX, siehe codes.js) und/oder langer Lizenzschlüssel (PF1.…). Beide leer =
  // keine Lizenz, die App zeigt dann nur den Bildschirm „App aktivieren“. Stehen nicht im Schema: der Bildschirm #/aktivieren und die Karte
  // „Lizenz“ der Einstellungen prüfen und speichern sie selbst.
  license_code: "",
  license_key: "", hub_activation: "",   // hub_activation: "CODE|GERÄTEKENNUNG" des aktivierten Stand-Laptops (gilt für verbundene Geräte)
};

// Formular-Schema: [Abschnitt, [[key, label, kind, help], …]]; kind: text, textarea, lines, bool, int, color, file
export const SETTINGS_SCHEMA = [
  ["Marke", [
    ["brand_name", "Markenname", "text", "Ersetzt {marke} in allen Texten."],
    ["logo", "Logo", "file", "PNG, SVG, JPG oder WebP, max. 2 MB. Am besten mit transparentem Hintergrund."],
    ["accent_color", "Akzentfarbe", "color", "Buttons, Hervorhebungen, Auswahl."],
  ]],
  ["Module", [
    ["module_leads", "Interessenten erfassen", "bool", "Das Kundenformular fragt Interessen ab und speichert sie unter „Interessenten“."],
    ["module_queue", "Probefahrt-Warteschlange aktiv", "bool", "Das Kundenformular bietet „Probefahrt“ an: Besucher bekommen eine Nummer und werden aufgerufen."],
    ["tracking_enabled", "Fahrtzeit-Tracking", "bool", "Start und Ende jeder Probefahrt erfassen (Dauer, Fahrzeug, Durchschnitt). Voraussetzung für Fahrzeuge."],
    ["show_eta", "Geschätzte Wartezeit anzeigen", "bool", "Die Wartezeit-Schätzung nutzt die angelegten Fahrzeuge (frei und nicht gesperrt); ohne Fahrzeuge rechnet sie mit einem."],
  ]],
  ["Probefahrt", [
    ["drive_minutes", "Ø Dauer einer Probefahrt (Minuten)", "int", "Mit Tracking wird automatisch der echte Durchschnitt genutzt."],
    ["max_drive_minutes", "Fahrt gilt als überfällig ab (Minuten)", "int", "Ab dieser Fahrzeit wird eine laufende Fahrt rot markiert."],
    ["start_checks", "Vor der Fahrt prüfen (eine Prüfung pro Zeile)", "lines", "Jede Zeile wird beim Start einer Fahrt zu einem Haken, der gesetzt sein muss. Leer lassen = keine Prüfungen."],
    ["staff", "Begleiter (beim Start wählbar)", "lines", "Vorname oder Kürzel, einer pro Zeile. Leer lassen = keine Auswahl beim Start."],
    ["contact_message", "Nachricht für SMS/WhatsApp", "textarea", "Platzhalter: {name}, {nummer}, {marke}"],
  ]],
  // Ein Formular für Probefahrt und Interessen: ein Abschnitt mit allen Kundentexten. Die Texte des früheren eigenen Anmeldeformulars
  // (queue_headline …, queue_marketing_*) und der frühere „farbige Teil“ der Überschrift (headline_accent) sind hier nicht mehr bearbeitbar.
  ["Kundenformular", [
    ["page_title", "Seitentitel", "text", ""],
    ["headline", "Überschrift", "text", ""],
    ["subline", "Untertitel", "textarea", ""],
    ["interests", "Interessen (eins pro Zeile)", "lines", "„Probefahrt“ ist fest die erste Option, solange die Warteschlange aktiv ist."],
    ["queue_option_label", "Probefahrt-Option: Beschriftung", "text", ""],
    ["queue_option_hint", "Probefahrt-Option: Hinweis", "text", ""],
    ["notes_placeholder", "Platzhalter Notizen", "text", ""],
    ["submit_label", "Button-Text", "text", ""],
    ["consent_text", "Einwilligungstext", "textarea", "Gilt für die Interessen und für die Probefahrt: beides sollte genannt sein."],
    ["thanks_title", "Danke-Seite: Überschrift", "text", ""],
    ["thanks_title_accent", "Danke-Seite: farbiger Teil", "text", ""],
    ["thanks_text", "Danke-Seite: Text", "textarea", ""],
    ["queue_called_text", "Text, wenn aufgerufen (für SMS/Anzeige)", "textarea", ""],
  ]],
  ["Rechtliches", [
    ["company", "Verantwortliche Firma", "text", "Ersetzt {firma}."],
    ["company_address", "Adresse", "text", "Ersetzt {adresse}."],
    ["privacy_email", "Datenschutz-E-Mail", "text", "Ersetzt {email}."],
    ["legal_text", "Hinweis unter dem Formular", "textarea", ""],
    ["privacy_text", "Datenschutzerklärung", "textarea", ""],
  ]],
];
export function intRange(key) {
  if (key === "max_drive_minutes") return [10, 600];
  if (key === "queue_retention_days" || key === "lead_retention_days") return [7, 3650];
  return [1, 600];
}
export function fill(cfg, text, extra = {}) {
  const values = { marke: cfg.brand_name, firma: cfg.company, adresse: cfg.company_address, email: cfg.privacy_email, ...extra };
  let out = String(text ?? "");
  for (const [k, v] of Object.entries(values)) out = out.split("{" + k + "}").join(String(v ?? ""));
  return out;
}
export const t = (cfg, key, extra) => fill(cfg, cfg[key] ?? "", extra);
export const interestList = (cfg) => lines(cfg.interests);
export const startCheckList = (cfg) => lines(cfg.start_checks);
export const staffList = (cfg) => lines(cfg.staff);

// Frühere Standardtexte (Zwei-Formulare-Zeit, bis Stand 1): Wer sie nie geändert hat, bekommt die neuen Standardwerte des einen
// Kundenformulars; eigene Texte bleiben unangetastet. Ohne Warteschlange bleibt die Interessenliste: dort ist „Testfahrt“ der einzige
// Weg, ein Probefahrt-Interesse zu erfassen.
const LEGACY_DEFAULTS = {
  interests: ["Testfahrt\nFinanzierung"],
  submit_label: ["Interesse anmelden"],
  consent_text: ["Ich willige ein, dass die {firma} die von mir angegebenen Daten speichert und mich zu meinem " +
    "ausgewählten Interesse per E-Mail und Telefon kontaktiert. Diese Einwilligung ist freiwillig. " +
    "Ich kann sie jederzeit mit Wirkung für die Zukunft widerrufen, z. B. per E-Mail an {email}. " +
    "Die Rechtmäßigkeit der bis zum Widerruf erfolgten Verarbeitung bleibt davon unberührt."],
};
// Marken-Standardwerte bis Stand 2 (Beispielmarke Togg, ohne eigenes Logo). Die Marke wird nur ersetzt, wenn sie UNBERÜHRT ist: alle
// sechs Werte stehen noch genau so da. Hat jemand irgendetwas davon eingetragen (Name, Logo, Farbe, Firma, Adresse oder E-Mail), ist das
// seine Marke und bleibt vollständig, wie sie ist – auch ein „Togg“ als Name (ein Togg-Händler) und die Firmendaten daneben.
const BRAND_DEFAULTS_V2 = {
  brand_name: "Togg", logo: "", accent_color: "#5aafdc",
  company: "Togg Europe GmbH", company_address: "Schelmenwasenstr. 34, 70567 Stuttgart", privacy_email: "toggcare@togg.eu",
};
const brandUntouched = (s) => Object.entries(BRAND_DEFAULTS_V2).every(([key, old]) => (key === "accent_color"
  ? String(s[key] ?? "").toLowerCase() === old : (s[key] ?? "") === old));
// Ändert `s` an Ort und Stelle (die Einstellungen eines geladenen Datensatzes) und gibt es zurück. `from` ist der Stand der Daten
// (settings_version vor dem Laden; 0 = Altbestand): jeder Schritt läuft nur einmal, damit ein Wert, den der Admin später bewusst
// wieder auf einen alten Standard setzt, nicht bei jedem Update überschrieben wird.
export function migrateSettings(s, from = 0) {
  if (from < 2) {
    for (const [key, olds] of Object.entries(LEGACY_DEFAULTS)) {
      if (key === "interests" && s.module_queue === false) continue;
      if (olds.includes(s[key])) s[key] = DEFAULT_SETTINGS[key];
    }
    // Die Überschrift ist EIN Text: ein früherer „farbiger Teil“ wird angehängt (headline_accent ist kein Formularfeld mehr)
    if (s.headline_accent) {
      s.headline = [s.headline, s.headline_accent].filter(Boolean).join(" ");
      s.headline_accent = "";
    }
  }
  if (from < 3 && brandUntouched(s)) {
    for (const key of Object.keys(BRAND_DEFAULTS_V2)) s[key] = DEFAULT_SETTINGS[key];
  }
  s.settings_version = SETTINGS_VERSION;
  return s;
}

// Was das Kundenformular anbietet: Interessen nur mit aktivem Interessenten-Modul, die Probefahrt nur mit aktiver Warteschlange.
// alone: nur die Probefahrt (keine Interessen) – sie gilt dann von selbst, es gibt nichts anzukreuzen. off: beide Module aus, kein Formular.
export function formOptions(cfg) {
  const leads = !!cfg.module_leads, queue = !!cfg.module_queue;
  const interests = leads ? interestList(cfg) : [];
  return { leads, queue, interests, alone: queue && !interests.length, off: !leads && !queue };
}

// --- Warteschlange ------------------------------------------------------------------------------
export function sortQueue(rows) {
  return [...rows].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : num(a) - num(b)));
}
export const waiting = (rows) => sortQueue(rows.filter((e) => e.status === STATUS.WAITING));
export const byStatus = (rows, s) => rows.filter((e) => e.status === s);
export function avgDriveMinutes(rows, cfg) {
  if (cfg.tracking_enabled) {
    let d = rows.filter((e) => e.status === STATUS.DONE).map(durationSeconds).filter((x) => x);
    d = d.slice(-20);
    if (d.length >= 3) return Math.max(1, Math.round(d.reduce((a, b) => a + b, 0) / d.length / 60));
  }
  return Math.max(1, parseInt(cfg.drive_minutes, 10) || 1);
}
// Wartezeit-Schätzung; `cars` aus den Fahrzeugen (carCount).
export function queueState(rows, vehicles, cfg) {
  const w = waiting(rows);
  const busy = rows.filter((e) => e.status === STATUS.CALLED || e.status === STATUS.DRIVING).length;
  const avg = avgDriveMinutes(rows, cfg);
  const cars = carCount(vehicles);
  const eta = (ahead) => {
    const rounds = Math.floor((ahead + busy) / cars);
    return rounds === 0 ? 0 : Math.ceil((rounds * avg) / 5) * 5;
  };
  return { waiting: w, busy, avg, cars, eta };
}
export function phoneDigits(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (String(phone || "").trim().startsWith("+")) return digits;
  if (digits.startsWith("00")) return digits.slice(2);
  if (digits.startsWith("0")) return "49" + digits.slice(1);
  return digits;
}
export const telLink = (phone) => "tel:" + String(phone || "").trim().replace(/[^0-9+]/g, "");
export function contactLinks(e, cfg) {
  const msg = fill(cfg, cfg.contact_message, { name: firstName(e.name), nummer: e.number });
  const phone = String(e.phone || "").trim();
  const q = encodeURIComponent(msg);
  return {
    tel: telLink(phone),
    sms: "sms:" + phone.replace(/[^0-9+]/g, "") + "?&body=" + q,
    whatsapp: "https://wa.me/" + phoneDigits(phone) + "?text=" + q,
  };
}
export function nextNumber(rows, day) {
  return rows.filter((e) => e.day === day).reduce((m, e) => Math.max(m, num(e)), 0) + 1;
}
export const findById = (rows, id) => rows.find((r) => r.id === id);
// Interessent und Warteschlangen-Eintrag eines Absendens des Kundenformulars tragen denselben Zeitstempel (actions.submitCustomerForm),
// Namen und Telefon: darüber findet man zur Nummer die Interessen und zum Interessenten die Probefahrt-Nummer.
export const submissionKey = (r) => [r.created_at, r.name, r.phone].join("|");

// --- Fahrzeuge ----------------------------------------------------------------------------------
export function vehicleLabel(v) {
  const parts = [v.code, `${v.model || ""} ${v.color || ""}`.trim()];
  if (v.plate) parts.push(v.plate);
  return parts.filter(Boolean).join(" · ");
}
export const shortLabel = (v) => `${v.model || ""} ${v.color || ""}`.trim();
export const drivingEntry = (rows, vid) => (vid ? rows.find((e) => e.status === STATUS.DRIVING && e.vehicle_id === vid) : undefined);
// Status (A5): unterwegs vor archiviert, damit eine laufende Fahrt immer sichtbar ist.
export function vehicleStatus(v, rows, cfg, d = new Date()) {
  const e = drivingEntry(rows, v.id);
  if (e) {
    const late = elapsedSince(e.started_at, d) > (parseInt(cfg.max_drive_minutes, 10) || 45) * 60;
    return [late ? V.LATE : V.DRIVING, e];
  }
  if (v.archived_at) return [V.ARCHIVED, null];
  if (v.blocked_reason) return [V.BLOCKED, null];
  return [V.AVAILABLE, null];
}
export function openDamages(damages, vid) {
  return damages.filter((x) => x.vehicle_id === vid && !x.resolved_at).sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}
export function driveStats(rows, vid, day = today()) {
  const s = { today_count: 0, today_seconds: 0, today_avg: 0, total_count: 0, total_avg: 0, last_end: "" };
  let tSum = 0, tN = 0, aSum = 0, aN = 0;
  for (const e of rows) {
    if (e.vehicle_id !== vid || e.status !== STATUS.DONE || !e.started_at) continue;
    s.total_count++;
    const d = durationSeconds(e);
    if (d) { aSum += d; aN++; }
    if (e.day === day) {
      s.today_count++;
      if (d) { tSum += d; tN++; }
      if (e.ended_at > s.last_end) s.last_end = e.ended_at;
    }
  }
  s.today_seconds = tSum;
  if (tN) s.today_avg = Math.round(tSum / tN / 60);
  if (aN) s.total_avg = Math.round(aSum / aN / 60);
  return s;
}
export function statsLine(s) {
  if (!s.today_count) return "Heute noch keine Fahrt";
  const parts = [`Heute ${s.today_count} ${s.today_count === 1 ? "Fahrt" : "Fahrten"}`];
  if (s.today_seconds > 0) {
    const h = Math.floor(s.today_seconds / 3600), m = Math.floor((s.today_seconds % 3600) / 60);
    parts.push(h ? `${h}:${pad(m)} h` : `${m} Min`);
  }
  if (s.today_avg > 0) parts.push(`Ø ${s.today_avg} Min`);
  const last = deTime(s.last_end);
  if (last) parts.push("letzte " + last);
  return parts.join(" · ");
}
export function conflictMessage(v, state, entry) {
  if (state === V.DRIVING || state === V.LATE) return entry ? `Fahrzeug ${v.code} ist noch unterwegs (Nr. ${entry.number}).` : `Fahrzeug ${v.code} ist noch unterwegs.`;
  if (state === V.BLOCKED) return `Fahrzeug ${v.code} ist gesperrt: ${v.blocked_reason}.`;
  if (state === V.ARCHIVED) return `Fahrzeug ${v.code} ist archiviert.`;
  return "";
}
function subText(info) {
  if (info.state === V.DRIVING || info.state === V.LATE) {
    let s = `unterwegs · Nr. ${info.entry.number} · ${deTime(info.entry.started_at)}`;
    if (info.late) s += " · überfällig";
    if (info.blocked_after) s += " · danach gesperrt";
    return s;
  }
  if (info.state === V.BLOCKED) return "gesperrt: " + info.blocked_reason;
  if (info.state === V.ARCHIVED) return "archiviert";
  const n = info.open_damages.length;
  return n === 0 ? "" : n === 1 ? "1 bekannter Schaden" : `${n} bekannte Schäden`;
}
// Alle Fahrzeuge mit Status, laufender Fahrt, offenen Schäden, Kennzahlen (unsortiert).
export function vehicleStates(vehicles, rows, damages, cfg, includeArchived = false, d = new Date()) {
  const day = today(d);
  const out = [];
  for (const v of vehicles) {
    if (v.archived_at && !includeArchived) continue;
    const [state, entry] = vehicleStatus(v, rows, cfg, d);
    const info = {
      ...v, state, state_label: V_LABELS[state], label: vehicleLabel(v), entry,
      elapsed: entry ? elapsedSince(entry.started_at, d) : 0, late: state === V.LATE,
      blocked_after: !!(entry && v.blocked_reason), open_damages: openDamages(damages, v.id),
      msg: conflictMessage(v, state, entry), stats: driveStats(rows, v.id, day),
    };
    info.known = info.open_damages.map((x) => x.text).join("; ");
    info.sub = subText(info);
    out.push(info);
  }
  return out;
}
const START_ORDER = { verfuegbar: 0, unterwegs: 1, ueberfaellig: 1, gesperrt: 2, archiviert: 3 };
const PAGE_ORDER = { ueberfaellig: 0, unterwegs: 1, verfuegbar: 2, gesperrt: 3, archiviert: 4 };
export function codeKey(code) {
  const n = /^\d+$/.test(code) ? parseInt(code, 10) : null;
  return n === null ? [1, 0, code] : [0, n, ""];
}
function lessCode(a, b) {
  const [ka, na, sa] = codeKey(a), [kb, nb, sb] = codeKey(b);
  return ka !== kb ? ka - kb : na !== nb ? na - nb : sa < sb ? -1 : sa > sb ? 1 : 0;
}
export const sortForStart = (v) => [...v].sort((a, b) => START_ORDER[a.state] - START_ORDER[b.state] || lessCode(a.code, b.code));
export const sortForPage = (v) => [...v].sort((a, b) => PAGE_ORDER[a.state] - PAGE_ORDER[b.state] || lessCode(a.code, b.code));
export const sortByCode = (v) => [...v].sort((a, b) => lessCode(a.code, b.code));
export const freeCount = (v) => v.filter((x) => x.state === V.AVAILABLE).length;
export const countState = (v, ...states) => v.filter((x) => states.includes(x.state)).length;
export const activeVehicles = (vehicles) => vehicles.filter((v) => !v.archived_at);
// Fahrzeugzahl für die Wartezeit: nicht archiviert, nicht gesperrt, mindestens 1. Die Wartezeit rechnet mit einem Fahrzeug,
// bis Fahrzeuge angelegt sind (die frühere Einstellung „Anzahl Testfahrzeuge“ entfällt; cars_count wird nicht mehr ausgewertet).
export function carCount(vehicles) {
  return Math.max(1, activeVehicles(vehicles || []).filter((v) => !v.blocked_reason).length);
}
export function nextCode(vehicles) {
  const used = new Set(vehicles.filter((v) => !v.archived_at).map((v) => v.code));
  for (let n = 1; ; n++) if (!used.has(String(n))) return String(n);
}
export function validateVehicle(input, vehicles, selfId = "") {
  const v = {
    code: cut(String(input.code || "").trim().toUpperCase(), 3),
    model: cut(String(input.model || "").trim(), 60),
    color: cut(String(input.color || "").trim(), 30),
    plate: cut(String(input.plate || "").trim().replace(/\s+/g, " ").toUpperCase(), 15),
    trim: cut(String(input.trim || "").trim(), 80),
  };
  const errors = {};
  if (!v.model) errors.model = "Bitte das Modell angeben.";
  if (!/^\S{1,3}$/.test(v.code)) errors.code = "Kürzel: 1–3 Zeichen, ohne Leerzeichen.";
  for (const o of vehicles) {
    if (o.id === selfId || o.archived_at) continue;
    if (!errors.code && o.code === v.code) errors.code = `Kürzel ${v.code} ist schon vergeben.`;
    if (v.plate && o.plate === v.plate) errors.plate = "Dieses Kennzeichen ist schon angelegt.";
  }
  return [v, errors];
}
export function newVehicle(input) {
  const ts = now();
  return { id: newId(), code: input.code, model: input.model, color: input.color, plate: input.plate, trim: input.trim,
    blocked_reason: "", blocked_at: "", archived_at: "", created_at: ts, updated_at: ts };
}
export function newDamage(vehicleId, entryId, text) {
  return { id: newId(), vehicle_id: vehicleId, entry_id: entryId || "", created_at: now(), text: cut(String(text || "").trim(), 300), resolved_at: "" };
}
export const isReferenced = (vid, rows, damages) => rows.some((e) => e.vehicle_id === vid) || damages.some((x) => x.vehicle_id === vid);

// Leere Datenstruktur (Tabellen wie in der Go-Version)
export const emptyData = () => ({ leads: [], queue: [], vehicles: [], damages: [], settings: { ...DEFAULT_SETTINGS } });
