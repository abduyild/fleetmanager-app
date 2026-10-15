// Service Worker: alle Dateien der App beim Installieren zwischenspeichern, danach offline aus dem Cache
// bedienen (Cache zuerst, Netz als Rückfall). Bei neuer Version VERSION erhöhen → alter Cache wird entfernt.
const VERSION = "fm-app-v18";
const FILES = [
  "./", "./index.html", "./manifest.webmanifest", "./style.css",
  "./js/main.js", "./js/model.js", "./js/actions.js", "./js/store.js", "./js/ui.js", "./js/router.js", "./js/export.js",
  "./js/icons.js", "./js/color.js",
  "./js/customer.js",
  "./js/license.js", "./js/codes.js", "./js/install.js",
  "./js/screens/login.js", "./js/screens/start.js", "./js/screens/form.js", "./js/screens/leads.js", "./js/screens/queue.js", "./js/screens/vehicles.js",
  "./js/screens/settings.js", "./js/screens/hub.js",
  "./js/screens/display.js", "./js/screens/activate.js", "./js/screens/vendor.js", "./js/screens/install.js",
  "./icons/favicon.png", "./icons/apple-touch-icon.png", "./icons/icon-192.png", "./icons/icon-512.png", "./icons/icon-512-maskable.png", "./icons/oifach-logo.svg",
  "./anleitung/", "./anleitung/index.html",
  "./anleitung/img/einstellungen-marke.png", "./anleitung/img/einstellungen-pin.png", "./anleitung/img/fahrzeug-anlegen.png",
  "./anleitung/img/start-uebersicht.png", "./anleitung/img/warteschlange.png", "./anleitung/img/fahrt-starten.png",
  "./anleitung/img/geraete-verbinden.png", "./anleitung/img/geraet-pin.png", "./anleitung/img/offline.png", "./anleitung/img/backup.png",
  "./anleitung/img/anzeige.png", "./anleitung/img/kundenformular.png", "./anleitung/img/installieren.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  // Nur Dateien der App bedienen. Der Service Worker sieht ALLE Anfragen der von ihm kontrollierten Seiten – auch /api/ des
  // Hubs (Live-Daten vom Stand-Laptop) und /qr.png (enthält die aktuelle LAN-Adresse); die dürfen nie aus dem Cache kommen
  // oder hineingelegt werden.
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith(new URL("./", self.location).pathname)) return;
  // Läuft die App im Wurzelpfad (GitHub Pages, Tests), greift der Pfad-Vergleich nicht – deshalb ausdrücklich ausnehmen.
  if (url.pathname.startsWith("/api/") || url.pathname === "/qr.png") return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || fetch(event.request).then((resp) => {
      if (resp.ok && new URL(event.request.url).origin === location.origin) {
        const copy = resp.clone();
        caches.open(VERSION).then((c) => c.put(event.request, copy));
      }
      return resp;
    }))
  );
});
