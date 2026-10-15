// Installation der App auf dem Gerät: Gerät und Browser erkennen, die passende Anleitung liefern, den Installieren-Knopf des Browsers (Chromium) bedienen
// und den einmaligen Hinweis auf dem Start verwalten. Reine Logik ohne DOM (navigator, matchMedia und localStorage werden nur abgesichert gelesen): lässt sich in
// Node testen (tests/pwa/install.test.mjs). Die Oberfläche steht in screens/install.js (Seite #/installieren, Bausteine) und screens/activate.js (Schritt 1).
//
// Worauf es ankommt: Auf iPhone/iPad (jeder Browser) und im Safari am Mac läuft eine zum Home-Bildschirm bzw. Dock hinzugefügte Web-App in einem EIGENEN Speicher.
// Sie bekommt eine andere Gerätekennung (codes.js, localStorage["fm_device_id"]) als der Browser-Tab; ein Aktivierungscode gilt aber nur für die Kennung, für die er
// ausgestellt wurde. Dort muss man also ERST INSTALLIEREN und den Code DANN in der installierten App eingeben. Auf Android (Chrome, Firefox, Samsung Internet) und in
// Chrome/Edge am Windows-PC oder Mac teilt sich die installierte App den Speicher mit dem Browser: dort ist die Reihenfolge egal. Firefox am Computer kann Web-Apps
// gar nicht installieren (die Seite läuft dann im Tab, auch offline).
//
// Erkennung: detectPlatform(ua, { standalone, vendor, maxTouchPoints }) liest nur den User-Agent-Text (plus zwei Nebenangaben), currentPlatform() ruft sie mit den
// Werten des Browsers auf. Auf localhost/127.0.0.1 kann ein Test sie mit window.__fmPlatform = { ua, standalone, vendor, maxTouchPoints } überschreiben – auf jeder
// anderen Adresse wird der Hook ignoriert. Läuft die App als installierte App? isStandalone(): display-mode standalone oder navigator.standalone (iOS).
// Der Installieren-Knopf: Chromium meldet über "beforeinstallprompt", dass es einen Installationsdialog gibt; das Ereignis wird beim Laden dieses Moduls aufgefangen
// (listenForInstall) und erst auf Tipp des Nutzers ausgelöst (installPrompt) – canPrompt() sagt, ob das gerade geht. Safari und Firefox melden nichts, dort bleibt die
// Anleitung zum Nachlesen.

// --- Erkennung -------------------------------------------------------------------------------------------------------
export const OS_NAMES = { ios: "iPhone / iPad", android: "Android", windows: "Windows", mac: "Mac", other: "Dieses Gerät" };
export const BROWSER_NAMES = { safari: "Safari", chrome: "Chrome", edge: "Edge", firefox: "Firefox", samsung: "Samsung Internet", other: "Ihr Browser" };

// → { os: "ios"|"android"|"windows"|"mac"|"other", browser: "safari"|"chrome"|"edge"|"firefox"|"samsung"|"other",
//     separateStorage, canInstall, isIPadOS, standalone }
//   separateStorage  die installierte App hat einen eigenen Speicher (iPhone/iPad in jedem Browser, Safari am Mac) – dort erst installieren, dann aktivieren
//   canInstall       false nur, wenn der Browser Web-Apps gar nicht installieren kann (Firefox am Computer); unbekannte Browser bekommen die allgemeine Anleitung
//   isIPadOS         iPad, das sich als Mac meldet (iPadOS 13+: Macintosh-Kennung, aber Touch) – os ist dann "ios"
// ua: der User-Agent-Text, vendor: navigator.vendor (hilft nur bei Safari ohne Version), maxTouchPoints: navigator.maxTouchPoints (unterscheidet iPad und Mac)
export function detectPlatform(ua, options) {
  const { standalone = false, vendor = "", maxTouchPoints = 0 } = options || {};
  const text = String(ua || "");
  let os = "other";
  if (/Android/i.test(text)) os = "android";
  else if (/iPhone|iPad|iPod/.test(text)) os = "ios";
  else if (/Windows/i.test(text)) os = "windows";
  else if (/Macintosh|Mac OS X/.test(text)) os = "mac";
  const isIPadOS = os === "mac" && Number(maxTouchPoints) > 1;
  if (isIPadOS) os = "ios";

  // Die Reihenfolge zählt: Samsung Internet, Edge und Opera tragen auch die Zeichen von Chrome, Chrome unter iOS (CriOS) und Firefox unter iOS (FxiOS) die von Safari.
  let browser = "other";
  if (/SamsungBrowser/i.test(text)) browser = "samsung";
  else if (/EdgiOS|EdgA|Edg\//.test(text)) browser = "edge";
  else if (/OPR\/|OPiOS|OPT\/|Opera/.test(text)) browser = "other";
  else if (/CriOS/.test(text)) browser = "chrome";
  else if (/FxiOS|Firefox\//.test(text)) browser = "firefox";
  else if (/(Chrome|Chromium)\//.test(text)) browser = /;\s*wv\)/.test(text) ? "other" : "chrome";   // "; wv)" = WebView einer anderen App
  else if (/Safari\//.test(text) && (/Version\//.test(text) || /Apple/i.test(String(vendor || "")))) browser = "safari";

  const desktop = os === "windows" || os === "mac" || os === "other";
  return {
    os,
    browser,
    separateStorage: os === "ios" || (os === "mac" && browser === "safari"),
    canInstall: !(desktop && browser === "firefox"),
    isIPadOS,
    standalone: !!standalone,
  };
}

// Kurzbeschreibung für „Erkannt: …“: „iPhone / iPad · Safari“, „Android · Chrome“, bei Unbekanntem nur, was bekannt ist; "" bei ganz Unbekanntem
export function platformLabel(p) {
  const os = p && p.os && p.os !== "other" ? OS_NAMES[p.os] : "";
  const browser = p && p.browser && p.browser !== "other" ? BROWSER_NAMES[p.browser] : "";
  return [os, browser].filter(Boolean).join(" · ");
}

// --- Anleitung -------------------------------------------------------------------------------------------------------
// Die Wege je Gerät und Browser. Die Anleitungsseite der App (screens/install.js), Schritt 1 der Aktivierung und die Tabelle in anleitung/index.html zeigen dieselben
// Wege; ein Test (tests/pwa/install.test.mjs) prüft, dass jede in „…“ genannte Menüangabe auch in der Tabelle der Anleitung steht.
// Gruppe: storage = Satz zum Speicher für die ganze Gruppe (Reihenfolge von Installieren und Aktivieren; steht auf der Anleitungsseite einmal oben), storageKind =
// "separate" | "shared" | "mixed" (Mac: Safari eigener Speicher, Chrome/Edge gemeinsamer). Eintrag: extra = Besonderheit des Browsers (Mindestversion, Rückfrage),
// storage = Satz zum Speicher dieses Browsers, wo er von der Gruppe abweicht (Mac); installSteps() nimmt den des Eintrags, sonst den der Gruppe.
export const SEPARATE_IOS = "Die installierte App hat einen eigenen Speicher: Geben Sie den Code erst in der installierten App ein und öffnen Sie die App immer über das Symbol auf dem Home-Bildschirm.";
export const SEPARATE_MAC = "Die Dock-App hat einen eigenen Speicher: Geben Sie den Code erst in der Dock-App ein und öffnen Sie die App immer über das Dock.";
export const SHARED = "Die installierte App teilt ihren Speicher mit dem Browser: Den Code können Sie vor oder nach der Installation eingeben.";
// Am Mac mischen sich beide Fälle: der Satz für die ganze Gruppe auf der Anleitungsseite nennt sie nebeneinander
const MAC_STORAGE = "Safari: Die Dock-App hat einen eigenen Speicher. Geben Sie den Code erst in der Dock-App ein und öffnen Sie die App immer über das Dock. Chrome und Edge: Die installierte App teilt ihren Speicher mit dem Browser, den Code können Sie vor oder nach der Installation eingeben.";
// Die Warnung für Geräte mit eigenem Speicher (Schritt 1 der Aktivierung, Seite #/installieren), mit „Wichtig:“ davor
export const SEPARATE_WARNING = "Code erst in der installierten App eingeben – sie hat eine eigene Gerätekennung.";
const NO_INSTALL = "Keine Installation möglich: Firefox kann Web-Apps nicht installieren. Behalten Sie die Seite als Lesezeichen – sie läuft im Tab auch ohne Internet. Für ein eigenes App-Fenster nutzen Sie Chrome oder Edge.";

const CHROME_DESKTOP = [
  "Klicken Sie rechts in der Adressleiste auf das Symbol „App installieren“ – oder öffnen Sie das Menü (drei Punkte), wählen Sie „Speichern und teilen“ und dann „Seite als App installieren“.",
  "Bestätigen Sie mit „Installieren“.",
];
const EDGE_DESKTOP = [
  "Klicken Sie in der Adressleiste auf das Symbol „App installieren“ – oder öffnen Sie das Menü (drei Punkte), wählen Sie „Apps“ und dann „Diese Website als App installieren“.",
  "Bestätigen Sie mit „Installieren“.",
];
const FIREFOX_DESKTOP = { id: "firefox", name: "Firefox", steps: [], extra: NO_INSTALL, storage: "" };

export const INSTALL_GROUPS = [
  {
    id: "ios", name: OS_NAMES.ios, storage: SEPARATE_IOS, storageKind: "separate",
    browsers: [
      { id: "safari", name: "Safari", extra: "", steps: [
        "Tippen Sie auf das Teilen-Symbol (Quadrat mit Pfeil nach oben).",
        "Wählen Sie „Zum Home-Bildschirm“.",
        "Tippen Sie auf „Hinzufügen“.",
      ] },
      { id: "chrome", name: "Chrome", extra: "Ab iOS 16.4.", steps: [
        "Tippen Sie oben in der Adressleiste auf das Teilen-Symbol.",
        "Wählen Sie „Zum Home-Bildschirm hinzufügen“.",
        "Tippen Sie auf „Hinzufügen“.",
      ] },
      { id: "firefox", name: "Firefox", extra: "Ab iOS 16.4.", steps: [
        "Tippen Sie auf das Menü (drei Punkte).",
        "Wählen Sie „Teilen“ und dann „Zum Home-Bildschirm“.",
        "Tippen Sie auf „Hinzufügen“.",
      ] },
    ],
  },
  {
    id: "android", name: OS_NAMES.android, storage: SHARED, storageKind: "shared",
    browsers: [
      { id: "chrome", name: "Chrome", extra: "", steps: [
        "Tippen Sie auf den Knopf „Installieren“, falls er hier angeboten wird – oder öffnen Sie das Menü (drei Punkte) und wählen Sie „App installieren“ (ältere Versionen: „Zum Startbildschirm hinzufügen“).",
        "Bestätigen Sie mit „Installieren“.",
      ] },
      { id: "firefox", name: "Firefox", extra: "Beantworten Sie die Frage „Daten dauerhaft speichern“ mit „Erlauben“.", steps: [
        "Öffnen Sie das Menü (drei Punkte).",
        "Wählen Sie „Installieren“ (ältere Versionen: „Zum Startbildschirm hinzufügen“).",
        "Bestätigen Sie mit „Hinzufügen“.",
      ] },
      { id: "samsung", name: "Samsung Internet", extra: "", steps: [
        "Öffnen Sie das Menü (drei waagerechte Striche).",
        "Wählen Sie „Seite hinzufügen zu“.",
        "Tippen Sie auf „Startbildschirm“ – oder auf „Installieren“, wenn dieser Eintrag angeboten wird.",
      ] },
    ],
  },
  {
    id: "windows", name: OS_NAMES.windows, storage: SHARED, storageKind: "shared",
    browsers: [
      { id: "chrome", name: "Chrome", extra: "", steps: CHROME_DESKTOP },
      { id: "edge", name: "Edge", extra: "", steps: EDGE_DESKTOP },
      { ...FIREFOX_DESKTOP },
    ],
  },
  {
    id: "mac", name: OS_NAMES.mac, storage: MAC_STORAGE, storageKind: "mixed",
    browsers: [
      { id: "safari", name: "Safari", storage: SEPARATE_MAC, extra: "Ab macOS 14. Wird der Eintrag nicht angeboten, ist der Mac dafür zu alt: Nutzen Sie dann Chrome oder Edge.", steps: [
        "Öffnen Sie in der Menüleiste das Menü „Ablage“.",
        "Wählen Sie „Zum Dock hinzufügen“.",
        "Bestätigen Sie mit „Hinzufügen“.",
      ] },
      { id: "chrome", name: "Chrome", storage: SHARED, extra: "", steps: CHROME_DESKTOP },
      { id: "edge", name: "Edge", storage: SHARED, extra: "", steps: EDGE_DESKTOP },
      { ...FIREFOX_DESKTOP },
    ],
  },
];
const GROUP = Object.fromEntries(INSTALL_GROUPS.map((g) => [g.id, g]));

// Der Satz zum Speicher eines Eintrags: Mac mischt Safari (eigener Speicher) und Chrome/Edge (gemeinsamer), die anderen Gruppen haben einen für alle
const storageNote = (group, entry) => (entry && entry.storage !== undefined ? entry.storage : group.storage);

// → { title, steps, note, extra, storage, group, browser }
//   title    „iPhone / iPad · Safari“ (ohne Browser, wenn es dafür keine eigene Anleitung gibt)
//   steps    die Schritte als Sätze (leer, wenn der Browser nicht installieren kann: dann sagt note, was geht)
//   note     extra und storage zusammen; extra: Besonderheit des Browsers, storage: Satz zum Speicher
//   group    Gruppe der Tabelle ("ios", "android", "windows", "mac"; Linux/ChromeOS zählen wie Windows), browser: Eintrag darin
// Ohne eigene Anleitung gilt die Anleitung des üblichen Browsers der Gruppe (iPhone/iPad: Safari, sonst Chrome) mit einem Hinweis.
export function installSteps(platform) {
  const p = platform || {};
  const os = GROUP[p.os] ? p.os : "other";
  const group = GROUP[os === "other" ? "windows" : os];
  const wanted = BROWSER_NAMES[p.browser] ? p.browser : "other";
  let entry = group.browsers.find((b) => b.id === wanted);
  let extra = "";
  const known = !!entry;
  if (!entry) {
    entry = group.browsers[0];   // iPhone/iPad: Safari; Android und Windows: Chrome (am Mac gleich Chrome statt Safari, siehe unten)
    if (group.id === "ios") extra = "Am sichersten geht es in Safari: Öffnen Sie diese Adresse dort.";
    else if (group.id === "android") extra = "Heißt der Eintrag in Ihrem Browser anders, suchen Sie im Menü nach „Installieren“ oder „Zum Startbildschirm hinzufügen“.";
    else extra = "Bietet Ihr Browser das nicht an, öffnen Sie diese Adresse in Chrome oder Edge.";
    if (group.id === "mac") entry = group.browsers.find((b) => b.id === "chrome");
  }
  // Linux/ChromeOS (os "other"): die Wege von Chrome, Edge und Firefox am Computer; ohne Browsernamen die allgemeine Anleitung
  const title = os === "other"
    ? (known ? entry.name : OS_NAMES.other)
    : (known ? `${group.name} · ${entry.name}` : group.name);
  const storage = storageNote(group, entry);
  const own = [entry.extra, extra].filter(Boolean).join(" ");
  return {
    title,
    steps: entry.steps.slice(),
    note: [own, storage].filter(Boolean).join(" "),
    extra: own,
    storage,
    group: group.id,
    browser: entry.id,
  };
}

// --- Dieses Gerät ------------------------------------------------------------------------------------------------------
// Test-Hook: window.__fmPlatform ({ ua, standalone, vendor, maxTouchPoints }) gilt nur auf localhost/127.0.0.1
function override() {
  try {
    const w = typeof window !== "undefined" ? window : globalThis;
    const o = w.__fmPlatform;
    if (!o || typeof o !== "object") return null;
    const host = w.location && w.location.hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" ? o : null;
  } catch (_) { return null; }
}

// Läuft die App als installierte App (Home-Bildschirm, Dock, App-Fenster)? iOS: navigator.standalone, sonst die Anzeigeart des Manifests (display: standalone)
export function isStandalone() {
  const o = override();
  if (o && typeof o.standalone === "boolean") return o.standalone;
  try { if (typeof navigator !== "undefined" && navigator && navigator.standalone === true) return true; } catch (_) { /* ohne Angabe */ }
  try { if (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches) return true; } catch (_) { /* ohne Angabe */ }
  return false;
}

// Gerät und Browser jetzt (immer frisch gelesen: ein Test kann den Hook zwischen zwei Aufrufen ändern)
export function currentPlatform() {
  const o = override() || {};
  const nav = typeof navigator !== "undefined" && navigator ? navigator : {};
  return detectPlatform(o.ua !== undefined ? o.ua : nav.userAgent, {
    standalone: isStandalone(),
    vendor: o.vendor !== undefined ? o.vendor : nav.vendor,
    maxTouchPoints: o.maxTouchPoints !== undefined ? o.maxTouchPoints : nav.maxTouchPoints,
  });
}

// --- Installieren-Knopf (Chromium: beforeinstallprompt) -----------------------------------------------------------------
let deferred = null;       // das aufgefangene Ereignis; prompt() geht nur einmal je Ereignis
let installedNow = false;  // Installation in dieser Sitzung angenommen
const listeners = new Set();
const notify = () => { for (const fn of [...listeners]) { try { fn(); } catch (e) { console.error(e); } } };

// Ruft fn, sobald sich canPrompt() oder justInstalled() ändern (das Ereignis kommt oft erst nach dem ersten Zeichnen); liefert die Abmeldung
export function onInstallChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
// Fängt die beiden Ereignisse eines Fensters auf (beim Laden dieses Moduls mit window; Tests geben ein eigenes Ziel). Der Browser zeigt seine eigene Einblendung dann
// nicht von selbst; der Knopf in der App löst den Dialog aus.
export function listenForInstall(target) {
  target.addEventListener("beforeinstallprompt", (ev) => {
    if (ev && typeof ev.preventDefault === "function") ev.preventDefault();
    deferred = ev;
    notify();
  });
  target.addEventListener("appinstalled", () => { deferred = null; installedNow = true; notify(); });
}
if (typeof window !== "undefined" && window && typeof window.addEventListener === "function") listenForInstall(window);

// Bietet der Browser gerade einen Installationsdialog an (und läuft die App nicht schon installiert)?
export const canPrompt = () => !!deferred && !isStandalone();
// Wurde die App in dieser Sitzung installiert (Dialog angenommen oder appinstalled)? Dann gilt: „Jetzt vom Startbildschirm öffnen“.
export const justInstalled = () => installedNow;
// Den Dialog des Browsers zeigen (nur auf Tipp des Nutzers). → "accepted" | "dismissed" | "unavailable" (kein Ereignis, Fehler)
export async function installPrompt() {
  const ev = deferred;
  if (!ev || typeof ev.prompt !== "function") return "unavailable";
  deferred = null;   // ein Ereignis löst den Dialog nur einmal aus; nach „Abbrechen“ meldet der Browser sich später selbst wieder
  notify();
  try {
    await ev.prompt();
    const choice = await ev.userChoice;
    if (choice && choice.outcome === "accepted") { installedNow = true; notify(); return "accepted"; }
    return "dismissed";
  } catch (_) { return "unavailable"; }
}
// Nur für Tests: Zustand zurücksetzen
export function resetInstall() { deferred = null; installedNow = false; hintMemory = false; listeners.clear(); }

// --- Hinweis auf dem Start ------------------------------------------------------------------------------------------------
// Einmaliger, schließbarer Hinweis nach der Aktivierung, solange die App nur im Browser läuft und installierbar ist. Erinnert wird er in localStorage["fm_install_hint"];
// gesperrter Speicher: wenigstens bis zum Schließen der Seite.
export const HINT_KEY = "fm_install_hint";
let hintMemory = false;
export function installHintDismissed() {
  if (hintMemory) return true;
  try { return !!(typeof localStorage !== "undefined" && localStorage && localStorage.getItem(HINT_KEY)); } catch (_) { return false; }
}
export function dismissInstallHint() {
  hintMemory = true;
  try { if (typeof localStorage !== "undefined" && localStorage) localStorage.setItem(HINT_KEY, "1"); } catch (_) { /* gesperrt: gilt bis zum Schließen */ }
}
// "" = kein Hinweis; "install" = „App installieren – dann läuft sie wie eine echte App und offline“; "separate" (iPhone/iPad, Safari am Mac) = ehrlicher Hinweis,
// dass die installierte App neu aktiviert werden muss (eigener Speicher, eigene Gerätekennung, neuer Code)
export function installHintMode(platform = currentPlatform()) {
  if (!platform || platform.standalone || !platform.canInstall || installHintDismissed()) return "";
  return platform.separateStorage ? "separate" : "install";
}
export function installHintText(platform = currentPlatform()) {
  const mode = installHintMode(platform);
  if (mode === "separate") return `Für ${platform.os === "mac" ? "das Dock" : "den Home-Bildschirm"}: App installieren und dort mit neuem Code aktivieren`;
  if (mode === "install") return "App installieren – dann läuft sie wie eine echte App und offline";
  return "";
}
