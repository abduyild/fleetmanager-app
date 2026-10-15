// Mit dem Stand-Laptop verbinden (/verbinden): Dieses Gerät teilt die Daten des Laptops (Hub-Sync, internal/app/hub.go).
// Hat der Laptop eine Stand-PIN, braucht jedes weitere Gerät sie einmal: Aus PIN und öffentlichem Salz entsteht derselbe
// Hash wie in den Einstellungen (ui.hashPin); er ist der Zugangsschlüssel und bleibt in localStorage (fm_hub_key),
// das Gerät bleibt also auch nach einem Neuladen verbunden. Der Router leitet hierher um, solange store.hub.needsPin gilt.
// Die Admin-Sperre (Stand-PIN, sessionStorage) ist davon getrennt und unberührt.
// Gestaltung wie der Login (ui-review.md K4): zentrierte Karte ≤ 400 px, Logo, Symbol im Quadrat, Titel, Satz, Feld, Fehler UNTER
// dem Feld, ein Button; keine Leiste. Link und QR-Code für weitere Geräte stehen auf dem Start.
import { register } from "../router.js";
import { html, render, logo, hashPin, on, $ } from "../ui.js";
import { icon } from "../icons.js";
import { store } from "../store.js";

const ERRORS = {
  empty: "Bitte die Stand-PIN des Laptops eingeben.",
  pin: "Falsche PIN.",
  limit: "Zu viele Versuche – bitte kurz warten und noch einmal versuchen.",
  offline: "Keine Verbindung zum Stand-Laptop. Bitte WLAN prüfen.",
  server: "Der Stand-Laptop hat nicht wie erwartet geantwortet.",
};

register("/verbinden", ({ el }) => {
  const cfg = store.settings;
  document.title = `Verbinden – ${cfg.brand_name}`;
  // Kein Hub oder schon verbunden: hier gibt es nichts zu tun
  if (!store.hub || !store.hub.needsPin) { location.replace("#/"); return; }
  render(el, html`
<main class="page center narrow gate">
  <header class="brand">${logo(cfg)}</header>
  <div class="gate-ic">${icon("wifi", "lg")}</div>
  <h1 class="title">Mit dem Stand-Laptop verbinden</h1>
  <p class="gate-sub">Danach zeigt dieses Gerät dieselbe Liste wie der Laptop – neue Anmeldungen erscheinen auf allen Geräten sofort.</p>
  <form class="lead-form gate-form" id="connect-form" autocomplete="off" novalidate>
    <div class="field">
      <label class="lbl" for="connect-pin">Stand-PIN des Laptops</label>
      <input type="password" id="connect-pin" name="pin" class="pin-input" inputmode="numeric" autofocus autocomplete="off" aria-describedby="connect-error">
      <p class="err errmsg" id="connect-error" role="alert" hidden>${icon("alert")}<span></span></p>
    </div>
    <button type="submit" class="btn primary lg block">Verbinden</button>
  </form>
  <p class="gate-addr">${store.hub.url}</p>
</main>`);

  // Fehler unter dem Feld: roter Rand am Feld + Meldung mit Symbol; beim nächsten Tippen wieder weg
  const pinInput = () => $("#connect-pin", el);
  const fail = (text) => {
    const box = $("#connect-error", el);
    $("span", box).textContent = text;
    box.hidden = false;
    const input = pinInput();
    input.classList.add("invalid");
    input.setAttribute("aria-invalid", "true");
  };
  on(el, "input", "#connect-pin", (ev, input) => {
    input.classList.remove("invalid");
    input.removeAttribute("aria-invalid");
    $("#connect-error", el).hidden = true;
  });
  let busy = false;
  on(el, "submit", "#connect-form", async (ev, form) => {
    ev.preventDefault();
    if (busy) return;
    busy = true;
    const pin = form.pin.value;
    try {
      const info = await store.hubPeek();   // frisches Salz: die PIN kann inzwischen gewechselt worden sein
      if (!info) { fail(ERRORS.offline); return; }
      let key = "";
      if (info.pin_required) {   // (wurde die PIN inzwischen entfernt, verbindet auch ein leeres Feld)
        if (!pin) { fail(ERRORS.empty); return; }
        try { key = await hashPin(pin, info.pin_salt || null); } catch (e) { fail(ERRORS.server); return; }
      }
      const r = await store.hubUseKey(key);
      if (r.error) {
        fail(ERRORS[r.error] || ERRORS.server);
        form.pin.value = "";
        form.pin.focus();
        return;
      }
      // Zurück dorthin, wo der Router umgeleitet hat (sonst zur Startseite)
      let next = "#/";
      try { next = sessionStorage.getItem("fm_after_connect") || next; sessionStorage.removeItem("fm_after_connect"); } catch (_) {}
      location.replace(next.startsWith("#/verbinden") ? "#/" : next);
    } finally {
      busy = false;
    }
  });
});
