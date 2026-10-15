// Einstieg der Standalone-App: Speicher laden, Service Worker für Offline-Betrieb, Screens registrieren, Router starten.
import { store } from "./store.js";
import { start } from "./router.js";
import { applyBrand } from "./ui.js";
import { deviceId } from "./codes.js";
import "./screens/login.js";
import "./screens/start.js";
import "./screens/form.js";
import "./screens/leads.js";
import "./screens/queue.js";
import "./screens/vehicles.js";
import "./screens/settings.js";
import "./screens/hub.js";
import "./screens/display.js";
import "./screens/activate.js";
import "./screens/install.js";
import "./screens/vendor.js";

(async () => {
  await store.load();
  deviceId();   // beim ersten Start entsteht die Gerätekennung (localStorage, nie im Datenspeicher); die Aktivierung (#/aktivieren) zeigt sie an
  applyBrand(store.settings);
  store.subscribe(() => applyBrand(store.settings));   // Farbe ändert sich live, wenn ein anderes Gerät sie umstellt
  if ("serviceWorker" in navigator) {
    try {
      // Nach einem Update (neue VERSION in sw.js) übernimmt der neue Service Worker per skipWaiting/claim – die schon
      // geladene Seite läuft aber mit den alten Modulen weiter. Deshalb: war die Seite bereits von einem Service Worker
      // kontrolliert und wechselt der Controller, einmal neu laden; beim allerersten Besuch (noch kein Controller) nicht.
      const hadController = !!navigator.serviceWorker.controller;
      let reloading = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (!hadController || reloading) return;
        reloading = true;
        location.reload();
      });
      const reg = await navigator.serviceWorker.register("./sw.js");
      // Updates auch ohne Neuladen bemerken (Tablet bleibt tagelang offen): beim Sichtbarwerden nachsehen
      document.addEventListener("visibilitychange", () => { if (!document.hidden) reg.update().catch(() => {}); });
    } catch (e) { console.warn("Service Worker:", e); }
  }
  start();
})();
