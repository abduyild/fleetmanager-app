// Aktivierungscodes ohne Server, an EIN Gerät gebunden. Jedes Gerät erzeugt beim ersten Start eine Gerätekennung (XXXX-XXXX, localStorage). Der Kunde schickt sie
// dem Anbieter; der erzeugt im Anbieter-Bereich (#/anbieter, screens/vendor.js) den Code für Kundennummer + Gerätekennung, und der Kunde tippt ihn einmal auf
// #/aktivieren ein (screens/activate.js). Die App prüft den Code offline, ohne Server und ohne Internet – ein Code für Gerät A passt nicht auf Gerät B.
// Reine Funktionen (außer dem kleinen Gerätespeicher unten), kein DOM: lässt sich in Node testen (tests/pwa/codes.test.mjs).
//
// Gerätekennung   8 Zeichen aus dem Code-Alphabet (40 Bit, crypto.getRandomValues), angezeigt als XXXX-XXXX, gespeichert in localStorage["fm_device_id"] –
//                 nie im Datenspeicher der App und damit nie über den Hub auf andere Geräte verteilt.
// Format          XXX-XXX  =  6 Zeichen aus 32 Symbolen (5 Bit je Zeichen) = 30 Bit, Groß-/Kleinschreibung beim Eingeben egal.
//   Zeichen 1–2   Kundennummer (10 Bit, 1–1023), das erste Zeichen ist das höherwertige
//   Zeichen 3–6   Prüfsumme (20 Bit): die ersten 20 Bit von HMAC-SHA256(VENDOR_SECRET, Kundennummer + "|" + Gerätekennung), z. B. "12|ABCDEFGH"
//                 (Kundennummer als Dezimaltext ohne führende Nullen, Gerätekennung als 8 Großbuchstaben/Ziffern ohne Strich)
// Das Alphabet lässt I, O, 0 und 1 weg (Verwechslung beim Abtippen); ein Zeichen außerhalb des Alphabets macht Code oder Kennung ungültig (es wird nichts
// „korrigiert“). Im Code stehen weder ein Ablaufdatum noch Funktionen: das Ende der Lizenz ist die Konstante LICENSE_END (für alle Codes gleich, ohne
// Kulanz), freigeschaltet sind immer alle Funktionen.
//
// Grenzen (bewusst, Wunsch des Anbieters: „muss nicht absolut sicher sein, nur besser als jetzt“):
//  • Das Geheimnis steht im öffentlichen Quelltext. Wer es liest, kann Codes für jede Gerätekennung selbst erzeugen. Die Bindung schützt davor, dass ein
//    Code (Chat, Foto, weitergereichter Zettel) auf anderen Geräten läuft – nicht vor einem Fälscher mit Programmierkenntnissen.
//  • Die Gerätekennung hängt am Browser-Speicher UND an der Adresse (Ursprung) der App: Wer die Browserdaten löscht oder die App unter einer anderen Adresse
//    öffnet (GitHub-Seite statt Laptop-Adresse im WLAN), hat eine neue Kennung und braucht einen neuen Code.
//  • Ein Code lässt sich nicht widerrufen (ohne Server geht das nicht), und der Anbieter sieht nur seine eigene Liste, nicht, wo Codes laufen.
//  • Das Ende hängt an der Uhr des Geräts (wie bei den langen Lizenzschlüsseln in license.js).
import { sha256Fallback, today as todayISO, dayNumber, EXPIRING_DAYS } from "./model.js";

// --- Konstanten des Anbieters -----------------------------------------------------------------------------------------------
// Alle darf der Anbieter jederzeit ändern. Für das nächste Event: LICENSE_END (und, wenn die alten Codes nicht mehr gelten sollen, auch VENDOR_SECRET)
// ändern – danach sw.js:VERSION erhöhen, damit die Geräte die neue Datei laden. Wer VENDOR_SECRET ändert, entwertet ALLE bisher ausgegebenen Codes (die
// Geräte zeigen dann wieder „App aktivieren“); VENDOR_PIN schützt nur den Anbieter-Bereich und ändert an den Codes nichts; APP_URL ist nur der Link,
// den der Anbieter-Bereich zum Kopieren anbietet. Siehe docs/LIZENZ.md, Abschnitt „Aktivierungscodes (ohne Server)“.
export const VENDOR_SECRET = "HpzKOlp92u0wJwgkoCZQaysci9mYo4I7";
export const VENDOR_PIN = "55639768";
export const LICENSE_END = "2026-10-19";   // letzter Gültigkeitstag aller Codes (bis Tagesende, Ortszeit des Geräts), keine Kulanz
export const APP_URL = "https://abduyild.github.io/fleetmanager-app/";   // öffentliche Adresse der App (mit Schrägstrich am Ende); die Anleitung liegt darunter in anleitung/

// --- Format ------------------------------------------------------------------------------------------------------------------
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // 32 Symbole, kein I, O, 0, 1
export const CODE_LENGTH = 6;
export const DEVICE_LENGTH = 8;
export const MAX_CUSTOMER = 1023;                                   // 10 Bit
export const DEVICE_KEY = "fm_device_id";                           // localStorage-Schlüssel der Gerätekennung
export { EXPIRING_DAYS };

const MAX_INPUT_CHARS = 64;   // ein riesiger Einfügetext kostet sonst bei jedem Tastendruck Zeit

// --- Gerätespeicher: localStorage, Rückfall Arbeitsspeicher -------------------------------------------------------------------
// Gerätekennung und Aktivierungscode (license.js) liegen im localStorage des Geräts. Fehlt er (Node, Tests) oder ist er gesperrt (privates Fenster,
// Browsereinstellung), hält ein Arbeitsspeicher-Rückfall die Werte bis zum Schließen der Seite; localStorageFailed() sagt dann „Schreiben misslungen“, damit
// die Aktivierungsseite warnen kann. Lesen: localStorage gilt, solange er etwas hat, sonst der Rückfall.
const memory = new Map();
let writeFailed = false;
export function readLocal(key) {
  try { if (typeof localStorage !== "undefined" && localStorage) { const v = localStorage.getItem(key); if (v !== null && v !== undefined) return String(v); } } catch (_) { /* gesperrt */ }
  return memory.get(key) ?? "";
}
export function writeLocal(key, value) {
  try {
    if (typeof localStorage !== "undefined" && localStorage) { localStorage.setItem(key, value); memory.delete(key); return true; }
  } catch (_) { /* voll oder gesperrt */ }
  memory.set(key, value);
  writeFailed = true;
  return false;
}
export function removeLocal(key) {
  memory.delete(key);
  try { if (typeof localStorage !== "undefined" && localStorage) localStorage.removeItem(key); } catch (_) { /* gesperrt */ }
}
export const localStorageFailed = () => writeFailed;

// --- Kleine Helfer ---------------------------------------------------------------------------------------------------------------
const hexBytes = (hex) => Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
const encode = (text) => new TextEncoder().encode(text);

// HMAC-SHA256 (RFC 2104) auf dem reinen JavaScript-SHA-256 aus model.js (sha256Fallback: Bytes hinein, Hex heraus). Schlüssel bis 64 Byte
// brauchen keine Vorverdichtung; längere werden wie im RFC zuerst gehasht.
export function hmacSha256(key, message) {
  const BLOCK = 64;
  let k = key;
  if (k.length > BLOCK) k = hexBytes(sha256Fallback(k));
  const inner = new Uint8Array(BLOCK + message.length), outer = new Uint8Array(BLOCK + 32);
  for (let i = 0; i < BLOCK; i++) {
    const b = i < k.length ? k[i] : 0;
    inner[i] = b ^ 0x36;
    outer[i] = b ^ 0x5c;
  }
  inner.set(message, BLOCK);
  outer.set(hexBytes(sha256Fallback(inner)), BLOCK);
  return hexBytes(sha256Fallback(outer));
}

// n → count Zeichen (big-endian), und zurück (−1 bei einem Zeichen außerhalb des Alphabets)
const toSymbols = (n, count) => Array.from({ length: count }, (_, i) => CODE_ALPHABET[(n >>> (5 * (count - 1 - i))) & 31]).join("");
function fromSymbols(text) {
  let n = 0;
  for (const ch of text) {
    const v = CODE_ALPHABET.indexOf(ch);
    if (v < 0) return -1;
    n = n * 32 + v;
  }
  return n;
}
const allSymbols = (text) => [...text].every((ch) => CODE_ALPHABET.includes(ch));

// --- Eingabe -----------------------------------------------------------------------------------------------------------------------
// Groß schreiben, Leerzeichen und Striche (auch die typografischen, die Chat und Textverarbeitung aus „-“ machen) entfernen.
// Mehr passiert nicht: Zeichen außerhalb des Alphabets bleiben stehen und machen parseCode() bzw. normalizeDeviceId() zu null/"".
export function normalizeCode(input) {
  return String(input ?? "").slice(0, MAX_INPUT_CHARS).toUpperCase().replace(/[\s\-‐-―−]+/g, "");
}
// Für das Eingabefeld beim Tippen: normalisieren, auf sechs Zeichen kürzen, nach dem dritten ein Strich („ABC-D“)
export function formatCode(input) {
  const raw = normalizeCode(input).slice(0, CODE_LENGTH);
  return raw.length > 3 ? `${raw.slice(0, 3)}-${raw.slice(3)}` : raw;
}

// --- Gerätekennung ---------------------------------------------------------------------------------------------------------------
// Für das Eingabefeld beim Tippen (Anbieter-Bereich): normalisieren, auf acht Zeichen kürzen, nach dem vierten ein Strich („ABCD-E“)
export function formatDeviceId(input) {
  const raw = normalizeCode(input).slice(0, DEVICE_LENGTH);
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}
// Die acht Zeichen einer vollständigen, gültigen Gerätekennung ohne Strich („ABCDEFGH“) – sonst "" (falsche Länge, Zeichen außerhalb des Alphabets)
export function normalizeDeviceId(input) {
  const raw = normalizeCode(input);
  return raw.length === DEVICE_LENGTH && allSymbols(raw) ? raw : "";
}
// Acht zufällige Symbole. 256 ist ein Vielfaches von 32, `& 31` verteilt deshalb gleichmäßig. crypto.getRandomValues gibt es auch ohne sicheren
// Kontext (http://192.168.…); nur ganz alte Browser fallen auf Math.random zurück.
function randomSymbols(count) {
  const bytes = new Uint8Array(count);
  const c = typeof crypto !== "undefined" ? crypto : null;
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < count; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => CODE_ALPHABET[b & 31]).join("");
}
// Die Gerätekennung DIESES Geräts in der Schreibweise XXXX-XXXX. Beim ersten Aufruf wird sie erzeugt und gespeichert (danach bleibt sie gleich, bis die
// Browserdaten gelöscht werden). Ein kaputter gespeicherter Wert wird ersetzt.
export function deviceId() {
  let raw = normalizeDeviceId(readLocal(DEVICE_KEY));
  if (!raw) {
    raw = randomSymbols(DEVICE_LENGTH);
    writeLocal(DEVICE_KEY, formatDeviceId(raw));
    raw = normalizeDeviceId(readLocal(DEVICE_KEY)) || raw;   // ein anderer Tab war im selben Augenblick schneller: dessen Kennung gilt
  }
  return formatDeviceId(raw);
}

// --- Erzeugen ---------------------------------------------------------------------------------------------------------------------
// Prüfsumme (20 Bit) zu Kundennummer und Gerätekennung (acht Zeichen ohne Strich): die ersten 20 Bit von HMAC-SHA256(Geheimnis, "12|ABCDEFGH")
function macOf(customer, device, secret = VENDOR_SECRET) {
  const h = hmacSha256(encode(secret), encode(`${customer}|${device}`));
  return (h[0] << 12) | (h[1] << 4) | (h[2] >> 4);
}
// makeCode({ customer: 12, device: "ABCD-EFGH" }) → "XXX-XXX". Kundennummer 1–1023 (auch als Ziffernfolge), Gerätekennung in jeder Schreibweise (mit/ohne Strich,
// klein). Wirft RangeError außerhalb des Formats (der Anbieter-Bereich prüft vorher und zeigt Klartext).
export function makeCode(arg) {
  if (arg === null || typeof arg !== "object") throw new RangeError("makeCode({ customer, device }): Kundennummer und Gerätekennung angeben");
  const raw = arg.customer;
  const customer = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (!Number.isInteger(customer) || customer < 1 || customer > MAX_CUSTOMER) throw new RangeError(`Kundennummer: 1–${MAX_CUSTOMER}`);
  const device = normalizeDeviceId(arg.device);
  if (!device) throw new RangeError(`Gerätekennung: ${DEVICE_LENGTH} Zeichen aus ${CODE_ALPHABET}`);
  return formatCode(toSymbols(customer, 2) + toSymbols(macOf(customer, device), 4));
}

// --- Prüfen --------------------------------------------------------------------------------------------------------------------------
// parseCode(code, gerätekennung) → { customer } oder null (falsche Länge, Zeichen außerhalb des Alphabets, Prüfsumme stimmt nicht – auch nicht, wenn der Code zu
// einem anderen Gerät gehört –, Kundennummer 0, fehlende oder ungültige Gerätekennung). Es wird nur das Format geprüft – ob die Lizenz noch läuft, sagt codeStatus().
// Die Gerätekennung gibt der Aufrufer an (license.js: deviceId()); ohne sie gilt kein Code.
export function parseCode(input, device) {
  const dev = normalizeDeviceId(device);
  if (!dev) return null;
  const raw = normalizeCode(input);
  if (raw.length !== CODE_LENGTH) return null;
  const customer = fromSymbols(raw.slice(0, 2)), mac = fromSymbols(raw.slice(2));
  if (customer < 1 || mac < 0 || mac !== macOf(customer, dev)) return null;
  return { customer };
}

// Zustand der Lizenz aller Codes an einem Stichtag (JJJJ-MM-TT, Standard heute), nur aus LICENSE_END:
// "valid" | "expiring" (höchstens EXPIRING_DAYS = 14 Tage Rest, der letzte Tag selbst zählt noch) | "expired"
export function codeStatus(today = todayISO()) {
  const left = codeDaysLeft(today);
  return left < 0 ? "expired" : left <= EXPIRING_DAYS ? "expiring" : "valid";
}
// Tage bis LICENSE_END (0 am letzten Tag, negativ danach); ein Stichtag, der kein Datum ist, ist ein Programmierfehler
export function codeDaysLeft(today = todayISO()) {
  const now = dayNumber(today);
  if (Number.isNaN(now)) throw new RangeError("today muss ein Datum JJJJ-MM-TT sein");
  return dayNumber(LICENSE_END) - now;
}
