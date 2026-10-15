// Markenfarbe -> lesbare Ableitungen (white-label). Reine Funktionen ohne DOM, damit Node sie testen kann
// (tests/pwa/accent.test.mjs); ui.applyBrand() setzt das Ergebnis als CSS-Variablen auf <html>.
//
// Die Markenfarbe bleibt EXAKT als Füllung erhalten (--accent); geändert wird nur, was darauf oder daneben steht:
//   --on-accent   Schriftfarbe auf der Füllung: Weiß oder Tinte (#17191c), je nachdem, was mehr Kontrast gibt
//   --accent-ink  Akzent als Text/Rahmen: in 4-%-Schritten mit Schwarz gemischt, bis der Kontrast auf Weiß ≥ 4,7:1 ist UND auf den grauen
//                 Flächen, auf denen Akzent-Text steht (--bg, --surface-2) sowie auf der eigenen Tönung ≥ 4,5:1 (Links, Fokusring, Auswahl).
//                 Abweichung von ui-review.md §3.6, das nur gegen Weiß prüft: dort liegen der frühere Standard (#5aafdc) und Blau auf Grau/Tönung bei 4,1–4,5:1.
//   --accent-tint 12 % Akzent auf Weiß (gewählte Zeilen, Kundenkacheln)
//   --live*       Farbe für „unterwegs“: wie der Akzent – außer dessen Farbton kollidiert mit einer festen Zustandsfarbe
//                 (Rot/Orange/Gelb = aufgerufen/überfällig, Grün = frei); dann ist „unterwegs“ neutral (Tinte).
export const DEFAULT_ACCENT = "#1e6fe0";   // Standardfarbe (DEFAULT_SETTINGS.accent_color); die Tokens in style.css :root sind ihre Ableitung
export const INK = "#17191c";
const WHITE = [255, 255, 255];
const BG = [243, 244, 246], SURFACE_2 = [236, 238, 241];   // --bg und --surface-2 aus style.css (Tokens, nicht markenabhängig)

// WCAG 2.x: relative Leuchtdichte und Kontrastverhältnis
const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (c) => "#" + c.map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => a.map((x, i) => x * (1 - t) + b[i] * t);   // t = Anteil von b

export const isHexColor = (s) => /^#[0-9a-fA-F]{6}$/.test(String(s));
// Kontrast zweier Farben "#rrggbb" (1 … 21)
export const contrast = (a, b) => ratio(hex(a), hex(b));

// Farbton 0–360°; -1 bei (nahezu) Grau, dort gibt es keine Kollision
function hueOf([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (d < 0.08) return -1;
  const h = 60 * (mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4);
  return h < 0 ? h + 360 : h;
}
// Rot/Orange/Gelb (345–50°: aufgerufen, überfällig) und Grün (90–160°: frei)
const clashes = (h) => h >= 0 && (h >= 345 || h <= 50 || (h >= 90 && h <= 160));
export const clashesWithStates = (accent) => clashes(hueOf(hex(isHexColor(accent) ? accent : DEFAULT_ACCENT)));

export function accentVars(accent) {
  if (!isHexColor(accent)) accent = DEFAULT_ACCENT;
  const a = hex(accent), ink = hex(INK);
  const onAccent = ratio(a, WHITE) >= ratio(a, ink) ? "#ffffff" : INK;
  const tintRGB = mix(a, WHITE, 0.88);
  const readable = (c) => ratio(c, WHITE) >= 4.7 && [BG, SURFACE_2, tintRGB].every((bg) => ratio(c, bg) >= 4.5);
  let t = 0, c = a;
  while (!readable(c) && t < 1) { t += 0.04; c = mix(a, [0, 0, 0], t); }
  const accentInk = toHex(c), tint = toHex(tintRGB);
  const clash = clashes(hueOf(a));
  return {
    "--accent": accent, "--on-accent": onAccent, "--accent-ink": accentInk, "--accent-tint": tint,
    "--live": clash ? INK : accent, "--on-live": clash ? "#ffffff" : onAccent,
    "--live-ink": clash ? INK : accentInk, "--live-tint": clash ? "#eceef1" : tint,
  };
}
