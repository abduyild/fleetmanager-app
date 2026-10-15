// Stand-PIN: Entsperren des Admin-Bereichs auf dem Gerät (ui-review.md §5.9).
// Zentrierte Karte ≤ 400 px (ein Sperrbildschirm darf zentriert sein): Logo, Schloss im Quadrat, Titel, Satz, PIN-Feld, Fehler UNTER dem
// Feld, „Entsperren“ als einzige Hauptaktion, „Zur Kundenansicht“ als ruhiger Link. Das Feld hat ein Label für Screenreader (sr-only),
// weil Titel und Schloss es sichtbar erklären.
import { register } from "../router.js";
import { html, render, logo, checkPin, unlock, on, $, hasPin } from "../ui.js";
import { icon } from "../icons.js";
import { store } from "../store.js";

register("/admin/login", ({ el }) => {
  const cfg = store.settings;
  document.title = `Mitarbeiter-Zugang – ${cfg.brand_name}`;
  if (!hasPin()) { unlock(); location.replace(sessionStorage.getItem("fm_after_login") || "#/"); return; }
  // Kundenansicht: das Kundenformular (wie der Knopf „Tablet weitergeben“ in der Leiste)
  const customerHref = "#/formular";
  render(el, html`
<main class="page center narrow gate">
  <header class="brand">${logo(cfg)}</header>
  <div class="gate-ic">${icon("lock", "lg")}</div>
  <h1 class="title">Stand-PIN eingeben</h1>
  <p class="gate-sub">Der Admin-Bereich ist gesperrt.</p>
  <form class="lead-form gate-form" id="pin-form" autocomplete="off" novalidate>
    <div class="field">
      <label class="sr-only" for="login-pin">Stand-PIN</label>
      <input type="password" id="login-pin" name="pin" class="pin-input" inputmode="numeric" autofocus autocomplete="off" aria-describedby="pin-error">
      <p class="err errmsg" id="pin-error" role="alert" hidden>${icon("alert")}<span>Falsche PIN. Bitte erneut versuchen.</span></p>
    </div>
    <button type="submit" class="btn primary lg block">Entsperren</button>
  </form>
  <p class="gate-alt"><a class="btn quiet" href="${customerHref}">Zur Kundenansicht</a></p>
</main>`);
  // Fehler unter dem Feld (roter Rand + Meldung mit Symbol); beim nächsten Tippen wieder weg
  on(el, "input", "#login-pin", (ev, input) => {
    input.classList.remove("invalid");
    input.removeAttribute("aria-invalid");
    $("#pin-error", el).hidden = true;
  });
  on(el, "submit", "#pin-form", async (ev, form) => {
    ev.preventDefault();
    if (await checkPin(form.pin.value)) {
      unlock();
      const next = sessionStorage.getItem("fm_after_login") || "#/";
      sessionStorage.removeItem("fm_after_login");
      location.replace(next);
    } else {
      $("#pin-error", el).hidden = false;
      form.pin.classList.add("invalid");
      form.pin.setAttribute("aria-invalid", "true");
      form.pin.value = "";
      form.pin.focus();
    }
  });
});
