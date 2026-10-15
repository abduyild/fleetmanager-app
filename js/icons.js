// Symbolsatz der App: 30 Inline-SVG (24er Raster, Strich 1,75 px, runde Enden) statt Emoji und Textzeichen.
// icon("phone") liefert raw()-Markup für das html-Tag; die Farbe kommt von currentColor, die Größe von CSS:
// .i = 20 px, .i.lg = 24 px (Tab-Leiste, Kundenkacheln, leere Zustände), .i.sm = 16 px (Haken in Auswahlzeilen).
// Immer neben einem Wort verwenden oder dem Element ein aria-label geben (das SVG selbst ist aria-hidden).
import { raw } from "./ui.js";

export const ICONS = {
  phone: '<path d="M6.6 3.5h3l1.4 4-2 1.3a11 11 0 0 0 5.2 5.2l1.3-2 4 1.4v3a2 2 0 0 1-2.2 2A16 16 0 0 1 4.6 5.7a2 2 0 0 1 2-2.2z"/>',
  sms: '<path d="M4 5.5h16v10.5H10l-4.5 3.5V16H4z"/>',
  chat: '<path d="M12 4a8 8 0 0 0-6.9 12L4 20l4.1-1.1A8 8 0 1 0 12 4z"/>',
  bell: '<path d="M6 16.5v-5a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 21h4"/>',
  car: '<path d="M4.5 15l1.5-4.6A2 2 0 0 1 7.9 9h8.2a2 2 0 0 1 1.9 1.4L19.5 15"/><rect x="3.5" y="15" width="17" height="4.5" rx="1.5"/><path d="M7 17.2h.01M17 17.2h.01"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>',
  alert: '<path d="M12 4.5l8.5 15h-17z"/><path d="M12 10v4.2M12 17.2v.01"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  chevR: '<path d="M9 6l6 6-6 6"/>',
  chevD: '<path d="M6 9l6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  download: '<path d="M12 4v11M7.5 11l4.5 4.5 4.5-4.5M5 20h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v4.7l3 1.8"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  qr: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2.5v2.5M20 14v.01M14 20h2M18.5 17.5V20H20"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  home: '<path d="M4 11l8-7 8 7v8.5a.5.5 0 0 1-.5.5H15v-6H9v6H4.5a.5.5 0 0 1-.5-.5z"/>',
  list: '<path d="M9 6.5h11M9 12h11M9 17.5h11"/><path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/>',
  tablet: '<rect x="5.5" y="3" width="13" height="18" rx="2"/><path d="M11 18h2"/>',
  form: '<path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4M9.5 12h5M9.5 15.5h5"/>',
  mail: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
  wifi: '<path d="M3.5 9.5a12 12 0 0 1 17 0M6.5 12.8a8 8 0 0 1 11 0M9.5 16a4 4 0 0 1 5 0"/><path d="M12 19.2v.01"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.01"/>',
  undo: '<path d="M9 7L4.5 11.5 9 16"/><path d="M5 11.5h8.5a5 5 0 0 1 0 10"/>',
  trash: '<path d="M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13M10 11v6M14 11v6"/>',
  doc: '<path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4"/>',
};
export const ICON_NAMES = Object.keys(ICONS);

// size: "lg" (24 px), "sm" (16 px) oder leer (20 px); Zahlen werden auf diese Stufen abgebildet. Weitere Klassen
// (z. B. "flip" zum Spiegeln von chevR als „zurück“) lassen sich anhängen: icon("chevR", "flip").
export function icon(name, size = "") {
  const body = ICONS[name];
  if (body === undefined) { console.warn("Unbekanntes Symbol:", name); return raw(""); }
  const cls = typeof size === "number" ? (size >= 24 ? "lg" : size <= 16 ? "sm" : "") : String(size || "");
  return raw(`<svg class="i${cls ? " " + cls : ""}" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`);
}
