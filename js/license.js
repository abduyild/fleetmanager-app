// Lizenz der Standalone-App (SPEZIFIKATION D5/D6): ein signierter Schlüssel gilt für einen Zeitraum; danach sind Aufrufen, Starten
// und Anlegen gesperrt, Export, Backup und Löschen bleiben möglich. Alles läuft offline, ohne Server.
//
// Schlüssel:  PF1.<base64url(Payload-JSON)>.<base64url(Signatur)>   (ohne Padding, Zeilenumbrüche beim Einfügen sind egal)
//   Payload   {"v":1,"kid":"k1","id":"LIC-…","cust":"Kunde","brand":"Marke","nb":"JJJJ-MM-TT","exp":"JJJJ-MM-TT","grace":14,"feat":["leads","queue","vehicles"]}
//   Signatur  ECDSA P-256 / SHA-256 über die ASCII-Bytes "PF1." + <base64url(Payload)>, als rohes r||s (64 Byte, kein DER) –
//             das Format von WebCrypto. Ausgestellt mit cmd/license (Go); der private Schlüssel liegt nur beim Anbieter.
//
// Zustände (licenseStatus): valid · expiring (gültig, höchstens 14 Tage Rest) · grace (nach exp, höchstens grace Tage) · expired ·
// not_yet_valid · invalid (Syntax, unbekannte kid, Signatur) · none (gar kein Schlüssel). Schreiben ist in valid/expiring/grace erlaubt.
// exp gilt bis Tagesende (Ortszeit des Geräts): am Tag exp selbst ist die Lizenz noch gültig.
//
// Zwei Prüfwege, ein Ergebnis: verifyLicense() ist async und nimmt WebCrypto (schnell). licenseStatus() ist synchron und liest den
// Zwischenspeicher; fehlt der Schlüssel dort noch, prüft es ihn sofort in reinem JavaScript (BigInt). Das ist nötig, weil WebCrypto
// nur in sicheren Kontexten existiert: Tablets und Handys im Stand-WLAN öffnen die App über http://192.168.…, dort fehlt crypto.subtle.
// store.load() wärmt den Zwischenspeicher vor dem ersten Rendern, der Rückfall fängt alles andere (anderes Gerät ändert den Schlüssel).
// Sagt WebCrypto „nein“ oder wirft, prüft das reine JavaScript noch einmal: ein Browserfehler soll keine echte Lizenz sperren.
//
// Zwei Quellen für die Lizenz:
//  • Aktivierungscode XXX-XXX (codes.js) – GERÄTEGEBUNDEN: kurz, vom Anbieter für Kundennummer + Gerätekennung im Anbieter-Bereich erzeugt, mit einem
//    Geheimnis gesichert, ohne Server prüfbar. Er passt nur auf das Gerät, dessen Kennung (codes.js: deviceId) in ihn eingerechnet ist, und liegt auch nur
//    dort: in localStorage["fm_license_code"] des Geräts – NICHT in den Einstellungen und damit nie im Datendokument des Hubs (sonst bekämen ihn alle Geräte
//    am Laptop mit). Das Ende der Lizenz ist für alle Codes dieselbe Konstante LICENSE_END (codes.js), ohne Kulanz, alle Funktionen frei. Der Normalfall: der
//    Kunde tippt ihn auf #/aktivieren oder in der Karte „Lizenz“ ein. Im Hub-Betrieb aktiviert sich jedes Gerät einmal selbst.
//  • settings.license_key – langer, mit ECDSA signierter Schlüssel PF1.… (oben), ausgestellt mit cmd/license, mit eigenem Zeitraum und eigener Kulanz;
//    Eingabe über das Aufklappfeld auf #/aktivieren. Er ist NICHT an ein Gerät gebunden, liegt in den Einstellungen (Backup, Hub: gilt für alle Geräte am
//    Laptop) und ist kein Feld des Einstellungsformulars.
// Gelten beide (schreiben lassen), zählt, was länger schreiben lässt (bei Gleichstand der Code); lässt nur eines schreiben, gilt dieses; sonst das, das
// später abläuft. Fehlen beide oder taugt keiner, ist der Zustand none bzw. invalid – dann zeigt der Router nur noch #/aktivieren (router.js).
// Ein früher in settings.license_code gespeicherter Code (Stand vor der Gerätebindung) wird nicht mehr gelesen – außer einmal beim Laden, falls er für
// dieses Gerät gilt (migrateLegacyCode).
//
// Die Prüfung läuft auf dem Gerät und schützt vor Versehen und Vertragsverstößen, nicht vor jemandem, der die Uhr zurückstellt
// oder die Entwicklerwerkzeuge benutzt (es gibt keinen Server, der das verhindern könnte).
import { today as todayISO, deDay, sha256Fallback, dayNumber, addDays, EXPIRING_DAYS } from "./model.js";
import { parseCode, codeStatus, codeDaysLeft, normalizeCode, formatCode, deviceId, readLocal, writeLocal, removeLocal, LICENSE_END } from "./codes.js";

export { addDays, EXPIRING_DAYS };

// Öffentliche Anbieter-Schlüssel (JWK), nach kid. Das Gegenstück liegt in cmd/license/main.go (vendorPublicKeys); ein Go-Test prüft,
// dass beide übereinstimmen. Der private Schlüssel gehört NIE ins Repo (~/.fleetmanager/license-private.pem).
export const VENDOR_PUBLIC_KEYS = {
  k1: { kty: "EC", crv: "P-256", x: "zpA7KuxGaG_ecIJsj6jqEsHlV3QyIxoFfvTzyVwGriI", y: "oDE2pNQm9-KHG9ViTGO8J9HI6EFer6IkEFoThGUcxmI" },
};

// Keine mitgelieferte Lizenz mehr: ohne Aktivierungscode oder Schlüssel in den Einstellungen zeigt die App nur „App aktivieren“.
// (Die frühere Messe-Lizenz LIC-2026-EVENT-1 lag hier; sie steht jetzt nur noch als Testschlüssel in tests/pwa/license-helper.mjs.)
// Die Konstante bleibt, damit sich eine Standard-Lizenz notfalls wieder eintragen lässt.
export const DEFAULT_LICENSE_KEY = "";

const PREFIX = "PF1.";
const WRITE_STATES = ["valid", "expiring", "grace"];

// --- Texte --------------------------------------------------------------------------------------
export const BLOCKED_TAIL = "Aufrufen, Starten und Anlegen sind gesperrt. Export, Backup und Löschen bleiben möglich.";
export const REASON_TEXT = {
  empty: "Bitte den Lizenzschlüssel einfügen.",
  syntax: "Das ist kein Lizenzschlüssel. Er beginnt mit „PF1.“ und besteht aus drei Teilen, die durch Punkte getrennt sind – bitte vollständig einfügen.",
  payload: "Der Schlüssel ist beschädigt oder unvollständig.",
  version: "Dieser Schlüssel gehört zu einer anderen Programmversion.",
  kid: "Unbekannter Schlüssel – er stammt nicht vom Anbieter dieser App.",
  signature: "Signatur ungültig – der Schlüssel wurde verändert oder gehört nicht zu dieser App.",
  code: "Der gespeicherte Aktivierungscode gilt nicht mehr.",   // nur für den gespeicherten Zustand (reason bei invalid), nie als Eingabefehler
};
// Texte zur Eingabe eines Aktivierungscodes (Bildschirm „App aktivieren“, Karte „Lizenz“)
export const CODE_TEXT = {
  empty: "Bitte den Aktivierungscode eingeben.",
  invalid: "Dieser Code passt nicht zu diesem Gerät.",   // Tippfehler oder ein Code für ein anderes Gerät – von außen nicht zu unterscheiden
  expired: `Die Lizenz ist am ${deDay(LICENSE_END)} abgelaufen.`,   // alle Codes enden mit LICENSE_END: ein weiterer Code hilft dann nicht mehr
};
const days = (n) => `${n} ${n === 1 ? "Tag" : "Tage"}`;

// Kopfzeile bei gesperrtem Schreiben („Lizenz abgelaufen am 19.10.2026“); leer, solange geschrieben werden darf
export function licenseHeadline(st) {
  switch (st.state) {
    case "expired": return `Lizenz abgelaufen am ${deDay(st.exp)}`;
    case "not_yet_valid": return `Lizenz gilt erst ab ${deDay(st.nb)}`;
    case "invalid": return st.reason === "code" ? "Aktivierungscode ungültig" : "Lizenzschlüssel ungültig";
    case "none": return "Keine Lizenz hinterlegt";
    default: return "";
  }
}
// Zusatz für „noch nicht gültig“: meist steht die Uhr des Geräts falsch (Datum zurückgesetzt, leere Batterie)
export const licenseHint = (st) => (st.state === "not_yet_valid" ? "Bitte das Datum des Geräts prüfen." : "");
// Der ganze Text hinter der Kopfzeile (Sperre, Zusatz) – im Toast und im Fehler-Banner gleich
export const licenseDetail = (st) => [BLOCKED_TAIL, licenseHint(st)].filter(Boolean).join(" ");
// Meldung einer abgelehnten Aktion (Toast) – ohne Link, mit Weg zur Lösung
export const blockMessage = (st) => `${licenseHeadline(st)} – ${licenseDetail(st)} Neuen Code unter Einstellungen → Lizenz eingeben.`;
// Hinweiszeile für Start und Einstellungen, solange noch geschrieben werden darf: „Lizenz endet am 19.10.2026 (noch 3 Tage)“
export function licenseNotice(st) {
  if (st.state === "expiring") return st.daysLeft === 0 ? `Lizenz endet heute (${deDay(st.exp)})` : `Lizenz endet am ${deDay(st.exp)} (noch ${days(st.daysLeft)})`;
  if (st.state === "grace") return `Lizenz abgelaufen am ${deDay(st.exp)} – ${st.daysLeft === 0 ? "Kulanzfrist endet heute" : `noch ${days(st.daysLeft)} Kulanz`}`;
  return "";
}

// --- Hilfen: Schlüsseltext, base64url, Datum -------------------------------------------------------
// Echte Schlüssel sind knapp 500 Zeichen lang; was weit darüber liegt, wird abgeschnitten (und scheitert dann) – so kostet ein
// riesiger Einfügetext oder ein kaputtes Backup nicht bei jedem Neuzeichnen Zeit.
const MAX_KEY_CHARS = 8192;
const normalizeKey = (key) => String(key ?? "").slice(0, MAX_KEY_CHARS).replace(/\s+/g, "");
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function b64urlBytes(s) {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error("base64url");
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const bytesToBig = (bytes) => BigInt("0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(""));

// (Tageszählung dayNumber() und addDays() stehen in model.js und werden mit codes.js geteilt.)

// --- Lesen und Prüfen ------------------------------------------------------------------------------
// Nutzdaten prüfen und bereinigen; null = unbrauchbar
function cleanPayload(p) {
  const isStr = (x) => typeof x === "string";
  if (!isStr(p.id) || !isStr(p.cust) || !(dayNumber(p.nb) <= dayNumber(p.exp))) return null;   // false bei NaN
  const grace = p.grace === undefined ? 0 : p.grace;
  if (!Number.isInteger(grace) || grace < 0 || grace > 3650) return null;
  return { v: 1, kid: p.kid, id: p.id, cust: p.cust, brand: isStr(p.brand) ? p.brand : "", nb: p.nb, exp: p.exp, grace,
    feat: Array.isArray(p.feat) && p.feat.every(isStr) ? p.feat : [] };
}
// Aufbau prüfen, ohne die Signatur: liefert { payload, signedText, signedBytes, sig } oder { error } mit einem Kürzel aus REASON_TEXT
// (empty · syntax · payload · version · kid). `keys` bestimmt, welche kid bekannt sind.
export function parseLicense(key, keys = VENDOR_PUBLIC_KEYS) {
  const text = normalizeKey(key);
  if (!text) return { error: "empty" };
  const m = /^PF1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(text);
  if (!m) return { error: "syntax" };
  let body, sig;
  try { body = b64urlBytes(m[1]); sig = b64urlBytes(m[2]); } catch (_) { return { error: "syntax" }; }
  if (sig.length !== 64) return { error: "syntax" };
  let raw;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); } catch (_) { return { error: "payload" }; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "payload" };
  if (raw.v !== 1) return { error: "version" };
  if (typeof raw.kid !== "string" || !hasOwn(keys, raw.kid)) return { error: "kid" };
  const payload = cleanPayload(raw);
  if (!payload) return { error: "payload" };
  const signedText = PREFIX + m[1];
  return { payload, signedText, signedBytes: new TextEncoder().encode(signedText), sig };
}

// Zwischenspeicher: normalisierter Schlüssel → { ok: true, payload } | { ok: false, error }. Ein Schlüssel ändert sich nie,
// also muss er nur einmal geprüft werden. Fehlschläge nur für Schlüssel, deren Aufbau stimmt (Syntaxfehler sind billig).
const cache = new Map();
export const resetLicenseCache = () => cache.clear();   // für Tests

// ECDSA-Prüfung: WebCrypto, wo es das gibt (schnell). Sagt WebCrypto „nein“ oder kann es nicht (Browser ohne ECDSA/JWK-Import,
// Browserfehler), entscheidet das reine JavaScript – ein Browserfehler darf keine echte Lizenz sperren. Es kostet nur bei
// ungültigen Schlüsseln etwas Zeit und kann nichts Gefälschtes durchlassen (es ist ein vollständiger Prüfer).
async function ecdsaVerify(jwk, signedText, sig) {
  const bytes = new TextEncoder().encode(signedText);
  const subtle = typeof crypto !== "undefined" ? crypto.subtle : undefined;
  if (subtle && typeof subtle.verify === "function") {
    try {
      const pub = await subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      if (await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, sig, bytes)) return true;
    } catch (_) { /* weiter mit dem Rückfall */ }
  }
  return verifyP256(jwk, sha256Fallback(bytes), sig);
}

// Prüft Aufbau und Signatur. Mit dem eigenen Schlüsselsatz `keys` (Tests) wird nur ein Erfolg zwischengespeichert, damit ein Fehlversuch
// mit fremden Schlüsseln den echten Zwischenspeicher nicht vergiftet. Wirft nie. → { ok: true, payload } | { ok: false, error }
export async function verifyLicense(key, keys = VENDOR_PUBLIC_KEYS) {
  const text = normalizeKey(key), shared = keys === VENDOR_PUBLIC_KEYS;
  if (shared && cache.has(text)) return cache.get(text);
  const parsed = parseLicense(text, keys);
  if (parsed.error) return { ok: false, error: parsed.error };
  let valid = false;
  try { valid = await ecdsaVerify(keys[parsed.payload.kid], parsed.signedText, parsed.sig); } catch (_) { valid = false; }
  const result = valid ? { ok: true, payload: parsed.payload } : { ok: false, error: "signature" };
  if (valid || shared) cache.set(text, result);
  return result;
}
// Dasselbe synchron (reines JavaScript), nur mit den Anbieter-Schlüsseln – der Rückfall von licenseStatus()
function verifySync(text) {
  const parsed = parseLicense(text);
  if (parsed.error) return { ok: false, error: parsed.error };
  let valid = false;
  try { valid = verifyP256(VENDOR_PUBLIC_KEYS[parsed.payload.kid], sha256Fallback(parsed.signedBytes), parsed.sig); } catch (_) { valid = false; }
  const result = valid ? { ok: true, payload: parsed.payload } : { ok: false, error: "signature" };
  cache.set(text, result);
  return result;
}

// --- Zustand ------------------------------------------------------------------------------------------
const blank = { exp: "", nb: "", grace: 0, until: "", daysLeft: null, customer: "", id: "", brand: "", features: [], source: "" };

// Zustand eines langen Schlüssels (source "key") an einem Stichtag; now = dayNumber(Stichtag)
function keyLicense(key, now) {
  const text = normalizeKey(key);
  if (!text) return { ...blank, state: "none", reason: "empty" };
  const res = cache.get(text) || verifySync(text);
  if (!res.ok) return { ...blank, state: "invalid", reason: res.error };
  const p = res.payload, nb = dayNumber(p.nb), exp = dayNumber(p.exp), until = exp + p.grace;
  const info = { exp: p.exp, nb: p.nb, grace: p.grace, until: addDays(p.exp, p.grace), customer: p.cust, id: p.id, brand: p.brand, features: p.feat, source: "key", reason: "" };
  if (now < nb) return { ...info, state: "not_yet_valid", daysLeft: null };
  if (now <= exp) return { ...info, state: exp - now <= EXPIRING_DAYS ? "expiring" : "valid", daysLeft: exp - now };
  if (now <= until) return { ...info, state: "grace", daysLeft: until - now };
  return { ...info, state: "expired", daysLeft: null };
}
// Zustand eines Aktivierungscodes (source "code") auf dem Gerät `device` (Standard: dieses Gerät); null = kein brauchbarer Code (falsche Länge, Zeichen,
// Prüfsumme – auch ein Code, der zu einem anderen Gerät gehört). Ein Code kennt weder Beginn noch Kulanz: er gilt ab sofort bis Tagesende von LICENSE_END
// (codes.js), für alle Codes dasselbe Datum. Kunde: „Kunde Nr. 12“, id: der Code selbst, Funktionen: immer alle.
const ALL_FEATURES = ["leads", "queue", "vehicles"];
function codeLicense(code, today, device) {
  const parsed = parseCode(code, device === undefined ? deviceId() : device);
  if (!parsed) return null;
  const state = codeStatus(today);
  return { state, exp: LICENSE_END, nb: "", grace: 0, until: LICENSE_END, daysLeft: state === "expired" ? null : codeDaysLeft(today),
    customer: `Kunde Nr. ${parsed.customer}`, id: formatCode(code), brand: "", features: [...ALL_FEATURES], source: "code", reason: "" };
}

// Synchron: Zustand der Lizenz an einem Stichtag (JJJJ-MM-TT, Standard heute) aus Schlüsseltext und Aktivierungscode (beide dürfen leer sein).
// `device` ist die Gerätekennung, zu der der Code gehören muss (Standard: die dieses Geräts, codes.js: deviceId); nur Tests geben sie an.
// Welche Quelle gilt: lässt nur eine schreiben, diese; lassen beide schreiben, die, die länger schreiben lässt (bei Gleichstand der Code); sonst die
// Quelle, die später abläuft (sie sagt dem Kunden am meisten: „abgelaufen am …“). Ein kaputter Schlüssel oder Code allein ergibt invalid, gar nichts ergibt none.
// daysLeft: Tage bis zum Ende der laufenden Phase (valid/expiring: bis exp, grace: bis exp+grace), sonst null. until = letzter Tag mit Schreibrecht.
// source: "key" | "code" (leer bei none/invalid). reason (nur bei invalid/none): Kürzel aus REASON_TEXT.
export function licenseStatus(key, today = todayISO(), code = "", device = undefined) {
  const now = dayNumber(today);
  if (Number.isNaN(now)) throw new RangeError("today muss ein Datum JJJJ-MM-TT sein");
  const k = keyLicense(key, now);
  if (!normalizeCode(code)) return k;                                   // kein Code: allein der Schlüssel entscheidet
  const c = codeLicense(code, today, device);
  if (!c) return k.state === "none" ? { ...blank, state: "invalid", reason: "code" } : k;   // der Code taugt nichts (oder gehört zu einem anderen Gerät)
  const kw = writeAllowed(k), cw = writeAllowed(c);
  if (kw && cw) return k.until > c.until ? k : c;                       // beide gelten: was länger schreiben lässt (JJJJ-MM-TT vergleicht sich als Text)
  if (kw) return k;
  if (cw) return c;
  if (k.state === "none" || k.state === "invalid") return c;            // der Schlüssel ist keine Lizenz: der abgelaufene Code ist alles, was es gibt
  return c.exp > k.exp ? c : k;
}
export const writeAllowed = (st) => !!st && WRITE_STATES.includes(st.state);

// Welcher Schlüssel gilt: der eingegebene (settings.license_key), sonst die Standard-Lizenz (derzeit keine: DEFAULT_LICENSE_KEY ist leer)
export const licenseKeyOf = (settings) => normalizeKey(settings && settings.license_key) || DEFAULT_LICENSE_KEY;

// --- Der Aktivierungscode DIESES Geräts: localStorage["fm_license_code"] ----------------------------------------------------------
// Pro Gerät, nie in den Einstellungen (siehe oben). Mehrere Tabs desselben Geräts teilen ihn; ein anderer Tab, der ihn ändert, meldet sich über das
// storage-Ereignis. store.js trägt sich mit onDeviceCodeChange ein und stößt dann seine Beobachter an (Router, Aktivierungsseite, Admin-Rahmen).
export const DEVICE_CODE_KEY = "fm_license_code";
const codeListeners = new Set();
export function onDeviceCodeChange(fn) { codeListeners.add(fn); return () => codeListeners.delete(fn); }
function announce(remote) { for (const fn of codeListeners) { try { fn(remote); } catch (e) { console.error(e); } } }
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (ev) => { if (ev.key === DEVICE_CODE_KEY || ev.key === null) announce(true); });   // key null: localStorage.clear()
}
// Der gespeicherte Aktivierungscode in Schreibweise XXX-XXX ("" ohne Code)
export const deviceCode = () => formatCode(readLocal(DEVICE_CODE_KEY));
// Code speichern (die Eingabe ist vorher mit checkActivationCode geprüft). → true, wenn der Browser ihn dauerhaft behält; false: nur bis zum Schließen der Seite
export function saveDeviceCode(code) {
  const stored = writeLocal(DEVICE_CODE_KEY, formatCode(code));
  announce(false);
  return stored;
}
export function clearDeviceCode() {
  removeLocal(DEVICE_CODE_KEY);
  announce(false);
}
// Früher stand der Code in den Einstellungen (und lag damit im Hub-Dokument jedes Geräts). Fehlt dem Gerät ein eigener Code und gilt der alte Eintrag für
// DIESES Gerät, wird er einmal übernommen (store.load ruft das auf); alles andere bleibt unbeachtet. → true, wenn etwas übernommen wurde.
export function migrateLegacyCode(settings) {
  const legacy = formatCode(settings && settings.license_code);
  if (!legacy || deviceCode() || !parseCode(legacy, deviceId())) return false;
  saveDeviceCode(legacy);
  return true;
}

// Woher licenseInfo() & Co. ohne Argument die Einstellungen nehmen: store.js trägt sich hier ein (license.js importiert den Speicher
// nicht – das gäbe einen Importkreis). Ohne Eintrag, etwa in Tests ohne Speicher, gibt es keine Lizenz (Zustand none).
let settingsSource = () => undefined;
export const useLicenseSettings = (fn) => { settingsSource = fn; };
// Hub-Betrieb: store.js meldet, ob dieses Gerät am Stand-Laptop hängt (store.hub). Dann gilt die Aktivierung des Laptops auch hier.
let hubSource = () => null;
export const useLicenseHub = (fn) => { hubSource = fn; };
// Die vom Laptop geteilte Aktivierung steht in den (über den Hub geteilten) Einstellungen als "CODE|GERÄTEKENNUNG" (settings.hub_activation).
// Ein verbundenes Gerät ohne eigenen Code übernimmt sie – lizenziert wird der Stand, nicht jedes Tablet daran; ohne Verbindung zum Laptop
// (eigenständiger Betrieb) zählt sie nicht. Quelle dann "hub".
export const hubActivationOf = (settings) => {
  const raw = String((settings && settings.hub_activation) || "");
  const i = raw.indexOf("|");
  return i > 0 ? { code: raw.slice(0, i), device: raw.slice(i + 1) } : null;
};
export const hubActivationValue = (code, device) => `${formatCode(code)}|${device}`;
// Zustand der Lizenz zu den Einstellungen: licenseInfo() = die des Speichers (store.settings), licenseInfo(d.settings) = die eines Entwurfs.
// Die Einstellungen liefern nur den langen Schlüssel; der Aktivierungscode kommt vom Gerät (deviceCode).
export function licenseInfo(settings = settingsSource()) {
  const own = licenseStatus(licenseKeyOf(settings), todayISO(), deviceCode());
  if (own.state !== "none" && own.state !== "invalid") return own;
  const shared = hubSource() ? hubActivationOf(settings) : null;
  if (!shared) return own;
  const st = licenseStatus("", todayISO(), shared.code, shared.device);
  return st.source === "code" ? { ...st, source: "hub" } : own;
}
// Ein Satz fürs Erkennen von Änderungen (Rahmen, Router): ändert sich, wenn Zustand oder Resttage wechseln
export const licenseSignature = (settings = settingsSource()) => { const st = licenseInfo(settings); return `${st.state}|${st.daysLeft}`; };

// Für jede Aktion, die Aufrufen/Starten/Anlegen bedeutet, als erste Zeile: `const blocked = licenseBlock(d); if (blocked) return blocked;`
// d ist der Entwurf aus store.update. → null (erlaubt) oder { error } mit dem Text für den Toast.
export function licenseBlock(d) {
  const st = licenseInfo(d && d.settings);
  return writeAllowed(st) ? null : { error: blockMessage(st) };
}
// Vor dem ersten Rendern aufrufen (store.load) und nach Änderungen des Schlüssels: prüft die Standard-Lizenz (falls es eine gibt) und den
// eingegebenen Schlüssel per WebCrypto, damit licenseStatus() nicht auf den langsameren JavaScript-Rückfall angewiesen ist. Wirft nie.
// Ein Aktivierungscode braucht das nicht: seine Prüfung (HMAC über vier Byte) ist ohnehin synchron und kostet Mikrosekunden.
export async function warmLicense(settings = settingsSource()) {
  await Promise.all([DEFAULT_LICENSE_KEY, licenseKeyOf(settings)].filter(Boolean).map((key) => verifyLicense(key)));
}

// --- Eingabe prüfen, ehe etwas gespeichert wird ---------------------------------------------------------------------------------------
// Gemeinsamer Weg für den Bildschirm „App aktivieren“ (screens/activate.js) und die Karte „Lizenz“ (screens/settings.js). Beide zeigen den
// Fehlertext und rufen bei Erfolg saveDeviceCode(code) (der Code gehört zum Gerät) bzw. store.update(d => { d.settings.license_key = key; … }) auf (der
// lange Schlüssel gehört zu den Einstellungen und gilt im Hub-Betrieb für alle Geräte). Keiner der beiden Wege löscht die andere Quelle: gelten beide,
// zählt, was länger schreiben lässt (licenseStatus). Ein schon abgelaufener oder noch nicht gültiger Eintrag wird abgelehnt: er würde nichts bringen.

// → { error: "Text" } oder { code: "XXX-XXX", exp, status } (exp = LICENSE_END, status = licenseStatus-Form des Codes).
// `device` ist die Gerätekennung, zu der der Code gehören muss (Standard: die dieses Geräts).
export function checkActivationCode(input, today = todayISO(), device = undefined) {
  const raw = normalizeCode(input);
  if (!raw) return { error: CODE_TEXT.empty };
  const dev = device === undefined ? deviceId() : device;
  if (!parseCode(raw, dev)) return { error: CODE_TEXT.invalid };
  if (codeStatus(today) === "expired") return { error: CODE_TEXT.expired };
  return { code: formatCode(raw), exp: LICENSE_END, status: codeLicense(raw, today, dev) };
}
// → { error: "Text" } oder { key, exp, status }; async, weil die Signatur per WebCrypto geprüft wird (verifyLicense)
export async function checkLicenseKey(input, today = todayISO()) {
  const key = normalizeKey(input);
  if (!key) return { error: REASON_TEXT.empty };
  const check = await verifyLicense(key);
  if (!check.ok) return { error: REASON_TEXT[check.error] || REASON_TEXT.signature };
  const status = licenseStatus(key, today);
  if (status.state === "expired") return { error: `Dieser Schlüssel ist schon abgelaufen (am ${deDay(status.exp)}) und kann nicht mehr verwendet werden.` };
  if (status.state === "not_yet_valid") return { error: `Dieser Schlüssel gilt erst ab ${deDay(status.nb)}. Bitte ab diesem Tag noch einmal eingeben.` };
  return { key, exp: status.exp, status };
}

// Die Lizenz gehört zum Gerät, nicht zu den Daten: ein Backup ersetzt den langen Schlüssel der Einstellungen nur durch einen echten, der länger schreiben
// lässt (sonst sperrte ein altes Backup die App). Der Aktivierungscode liegt gar nicht in den Einstellungen (localStorage des Geräts) und ist von einem Backup
// nie betroffen; ein alter license_code im Backup (Stand vor der Gerätebindung) kommt nicht mit. current/backup = Einstellungen mit license_key (beliebig
// unvollständig). → { license_code: "", license_key }, die in die wiederhergestellten Einstellungen kommen. Wirft nie.
export async function licenseAfterRestore(current, backup, today = todayISO()) {
  const str = (v) => (typeof v === "string" ? v : "");
  const own = str(current && current.license_key), key = str(backup && backup.license_key);
  // nur ein Schlüssel, der heute schreiben lässt, kommt mit (ein abgelaufener oder kaputter Schlüssel im Backup bleibt draußen)
  const theirs = key && (await verifyLicense(key)).ok && writeAllowed(licenseStatus(key, today)) ? normalizeKey(key) : "";
  const end = (k) => { const st = licenseStatus(licenseKeyOf({ license_key: k }), today); return writeAllowed(st) ? st.until : ""; };   // "" = gesperrt
  return { license_code: "", license_key: end(theirs) > end(own) ? theirs : own };
}

// --- ECDSA P-256 in reinem JavaScript (BigInt) – nur Prüfen ------------------------------------------------
// Kurve y² = x³ − 3x + b über GF(p); Punkte intern in Jacobi-Koordinaten [X, Y, Z] (Z = 0 ist der unendlich ferne Punkt),
// u1·G + u2·Q in einem Durchlauf (Shamirs Trick). Nicht zeitkonstant – es gibt hier nichts Geheimes.
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const G = [0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n, 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n, 1n];
const INF = [0n, 1n, 0n];
const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m; };
function inv(a, m) {   // erweiterter euklidischer Algorithmus
  let x = 0n, u = 1n, lo = mod(a, m), hi = m;
  while (lo !== 0n) {
    const q = hi / lo;
    [x, u] = [u, x - u * q];
    [hi, lo] = [lo, hi - q * lo];
  }
  if (hi !== 1n) throw new Error("nicht invertierbar");
  return mod(x, m);
}
function jDouble([X, Y, Z]) {   // dbl-2001-b (a = −3)
  if (Z === 0n || Y === 0n) return INF;
  const delta = mod(Z * Z), gamma = mod(Y * Y), beta = mod(X * gamma), alpha = mod(3n * (X - delta) * (X + delta));
  const X3 = mod(alpha * alpha - 8n * beta);
  return [X3, mod(alpha * (4n * beta - X3) - 8n * gamma * gamma), mod((Y + Z) * (Y + Z) - gamma - delta)];
}
function jAdd(p1, p2) {   // add-2007-bl
  const [X1, Y1, Z1] = p1, [X2, Y2, Z2] = p2;
  if (Z1 === 0n) return p2;
  if (Z2 === 0n) return p1;
  const Z1Z1 = mod(Z1 * Z1), Z2Z2 = mod(Z2 * Z2), U1 = mod(X1 * Z2Z2), U2 = mod(X2 * Z1Z1);
  const S1 = mod(Y1 * Z2 * Z2Z2), S2 = mod(Y2 * Z1 * Z1Z1), H = mod(U2 - U1), r = mod(2n * (S2 - S1));
  if (H === 0n) return r === 0n ? jDouble(p1) : INF;   // gleicher Punkt bzw. Gegenpunkt
  const I = mod(4n * H * H), J = mod(H * I), V = mod(U1 * I), X3 = mod(r * r - J - 2n * V);
  return [X3, mod(r * (V - X3) - 2n * S1 * J), mod(((Z1 + Z2) * (Z1 + Z2) - Z1Z1 - Z2Z2) * H)];
}
// jwk: öffentlicher Schlüssel; hashHex: SHA-256 der Nachricht (64 Hex-Zeichen); sig: 64 Byte r||s → true/false
export function verifyP256(jwk, hashHex, sig) {
  if (sig.length !== 64) return false;
  const r = bytesToBig(sig.subarray(0, 32)), s = bytesToBig(sig.subarray(32));
  if (r < 1n || r >= N || s < 1n || s >= N) return false;
  const qx = bytesToBig(b64urlBytes(jwk.x)), qy = bytesToBig(b64urlBytes(jwk.y));
  if (qx >= P || qy >= P || mod(qy * qy) !== mod(qx * qx * qx - 3n * qx + B)) return false;   // der Schlüssel muss auf der Kurve liegen
  const w = inv(s, N), u1 = mod(BigInt("0x" + hashHex) * w, N), u2 = mod(r * w, N);
  const Q = [qx, qy, 1n], GQ = jAdd(G, Q);
  let R = INF;
  for (let i = 255n; i >= 0n; i--) {
    R = jDouble(R);
    const a = (u1 >> i) & 1n, b = (u2 >> i) & 1n;
    if (a && b) R = jAdd(R, GQ); else if (a) R = jAdd(R, G); else if (b) R = jAdd(R, Q);
  }
  if (R[2] === 0n) return false;
  const zi = inv(R[2], P);
  return mod(R[0] * zi * zi) % N === r;
}
