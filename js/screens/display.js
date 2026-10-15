// Aufruf-Anzeige (#/anzeige): dunkler Vollbild-Schirm für einen Fernseher oder ein freies Tablet am Stand. Kunden-Screen (Kiosk-Route:
// das Öffnen sperrt den Admin). Zeigt NUR Nummern – „Jetzt dran“ (aufgerufen, neueste hervorgehoben, höchstens 6) und „Als Nächstes“
// (die ersten 5 Wartenden samt Wartezeit) – nie Namen oder Telefonnummern (SPEZIFIKATION B9). Ein Gong erklingt bei jedem neuen
// Aufruf, sobald jemand einmal „Ton und Vollbild einschalten“ getippt hat (Browser erlauben Ton erst nach einer Berührung).
// Die Daten kommen aus dem Speicher des Geräts; im Hub-Betrieb (mehrere Geräte am Stand-Laptop) erscheinen Aufrufe von anderen
// Geräten von selbst. Teilaktualisierung: bei jeder Änderung (store.subscribe) werden nur die Bereiche neu gezeichnet, deren
// Signatur sich geändert hat – nie die ganze Seite; die Uhr tickt für sich.
// Ohne gültige Lizenz (license.js) bleibt die Route offen, zeigt aber statt der Nummern nur „Bitte wenden Sie sich an das Standpersonal.“.
import { register } from "../router.js";
import { html, render, logo, logoURL, on, $ } from "../ui.js";
import { icon } from "../icons.js";
import { store } from "../store.js";
import * as model from "../model.js";
import { licenseInfo, writeAllowed } from "../license.js";

const S = model.STATUS;
const MAX_CALLED = 6;        // mehr Kacheln blieben auf dem Fernseher nicht groß genug
const MAX_NEXT = 5;
const CURSOR_MS = 3000;      // im Vollbild: Mauszeiger nach 3 s Ruhe ausblenden
const CURSOR_EVENTS = ["mousemove", "pointerdown", "keydown", "fullscreenchange"];

// Gong: zwei Sinustöne (E5, C5) – derselbe Klang wie in der Anzeige des Server-Modus.
function gong(audio) {
  const t0 = audio.currentTime;
  [[659, 0], [523, 0.6]].forEach(([freq, delay]) => {
    const osc = audio.createOscillator(), gain = audio.createGain();
    osc.type = "sine"; osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + delay);
    gain.gain.exponentialRampToValueAtTime(0.6, t0 + delay + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + 1.4);
    osc.connect(gain).connect(audio.destination);
    osc.start(t0 + delay); osc.stop(t0 + delay + 1.5);
  });
}
// Fehler beim Ton, Vollbild oder Wachhalten dürfen die Anzeige nie stören (ältere Fernseher-Browser kennen vieles nicht).
const quiet = (fn) => { try { return Promise.resolve(fn()).catch(() => {}); } catch (_) { return Promise.resolve(); } };

// Welche Schale die Anzeige zeigt: "on" = Nummern · "off" = Modul „Warteschlange“ aus · "locked" = keine gültige Lizenz (license.js):
// dann steht ein neutraler Satz statt der Nummern, nichts weiter (die Anzeige hängt am Fernseher, Kunden sehen sie).
const modeOf = () => (!store.settings.module_queue ? "off" : writeAllowed(licenseInfo(store.settings)) ? "on" : "locked");

// --- Daten → Ansicht ----------------------------------------------------------------------------
// Alles, was die Anzeige braucht, als Nummern (Strings). key identifiziert einen Aufruf (erneutes Aufrufen = neuer Aufruf).
function snapshot() {
  const d = store.data, cfg = store.settings;
  const st = model.queueState(d.queue, d.vehicles, cfg);
  const called = model.byStatus(d.queue, S.CALLED)
    .sort((a, b) => (a.called_at < b.called_at ? 1 : a.called_at > b.called_at ? -1 : model.num(b) - model.num(a)))   // neueste zuerst
    .map((e) => ({ number: String(e.number), key: `${e.id}@${e.called_at}` }));
  const waiting = st.waiting.length;
  return {
    on: modeOf() === "on",
    called, shown: called.slice(0, MAX_CALLED),
    next: st.waiting.slice(0, MAX_NEXT).map((e) => String(e.number)),
    waiting,
    eta: cfg.show_eta ? st.eta(waiting) : null,   // Wartezeit für eine neue Anmeldung (null: ausgeschaltet)
  };
}
// Zeilen unter „Als Nächstes“: „3 wartend“ und „Wartezeit ca. 20 Min.“ – die Zeit nur mit „Geschätzte Wartezeit anzeigen“
function waitLines(s) {
  const lines = [];
  if (s.waiting) lines.push(`${s.waiting} wartend`);
  if (s.eta) lines.push(`Wartezeit ca. ${s.eta} Min.`);
  else if (s.eta === 0 && !s.waiting) lines.push("Aktuell keine Wartezeit");
  return lines;
}

// --- Markup -------------------------------------------------------------------------------------
const headView = (cfg) => html`${logo(cfg)}<h1 class="sr-only">Aufruf</h1>`;
// Die neueste Nummer ist hervorgehoben (newest); flash = frisch aufgerufen → kurze Einblend-Animation.
const calledTiles = (s, flash) => html`${s.shown.map(({ number }, i) => html`<div class="called-num${i === 0 ? " newest" : ""}${i === 0 && flash ? " flash-in" : ""}" data-num="${number}">${number}</div>`)}`;
// Die Schriftgröße richtet sich nach der längsten Nummer (1, 2, 3, ≥ 4 Ziffern): frühmorgens mit Nr. 1–9 werden die Ziffern größer.
const digitsOf = (s) => Math.min(4, Math.max(1, ...s.shown.map((c) => c.number.length)));
const nextTiles = (s) => html`${s.next.length ? s.next.map((number) => html`<span class="next-num" data-num="${number}">${number}</span>`) : html`<span class="next-none">–</span>`}`;

const shell = (mode) => html`
<div class="display-wrap" data-screen="display">
  <header class="display-head">
    <div class="display-id" id="display-id"></div>
    <span class="display-clock" id="clock" data-clock></span>
  </header>
  ${mode === "on" ? html`
  <main class="display-main">
    <section class="display-called" aria-labelledby="called-h">
      <h2 id="called-h">Jetzt dran</h2>
      <div class="called-grid" id="called" role="status" data-count="0" data-len="1"></div>
      <p class="display-empty" id="called-empty">Bitte haben Sie einen Moment Geduld.</p>
      <p class="display-muted" id="called-more" hidden></p>
    </section>
    <aside class="display-side" aria-labelledby="next-h">
      <h2 id="next-h">Als Nächstes</h2>
      <div class="next-list" id="next"></div>
      <p class="display-muted" id="wait-info" hidden></p>
    </aside>
  </main>` : mode === "locked" ? html`
  <main class="display-main display-off" data-license-state="locked">
    <p class="display-empty">Bitte wenden Sie sich an das Standpersonal.</p>
  </main>` : html`
  <main class="display-main display-off">
    <p class="display-empty">Die Warteschlange ist zurzeit nicht aktiv.</p>
  </main>`}
  <footer class="display-foot">
    <a class="display-staff" href="#/">Mitarbeiter-Zugang</a>
    <p class="display-conn" id="conn" role="status" hidden>${icon("alert")}<span>Keine Verbindung zum Stand-Laptop</span></p>
    ${mode === "on" ? html`<button type="button" class="btn primary lg" id="sound">Ton und Vollbild einschalten</button>
    <button type="button" class="btn quiet" id="sound-toggle" hidden>Ton aus</button>` : ""}
  </footer>
</div>`;

// --- Screen -------------------------------------------------------------------------------------
function displayScreen({ el }) {
  let mode = null;          // Schale gezeichnet für: "on" = Nummern, "off" = Modul „Warteschlange“ aus, "locked" = keine Lizenz (nur ein Hinweis)
  let last = {};            // zuletzt gezeichnete Signatur je Bereich
  let seen = null;          // schon gezeigte Aufrufe (key); null = noch nichts gezeichnet (kein Gong, keine Animation beim Öffnen)
  let audio = null, activated = false, muted = false, wake = null, cursorTimer = null;

  const ring = () => {
    if (!audio || muted) return;
    quiet(() => { if (audio.state === "suspended") audio.resume(); gong(audio); });
  };
  const soundUi = () => {
    const start = $("#sound", el), toggle = $("#sound-toggle", el);
    if (start) start.hidden = activated;
    if (toggle) { toggle.hidden = !(activated && audio); toggle.textContent = muted ? "Ton an" : "Ton aus"; }
  };
  const tick = () => {
    const c = $("#clock", el), text = model.deTime(model.now());
    if (c && c.textContent !== text) c.textContent = text;
  };

  // Ein Durchgang: jeden Bereich nur anfassen, wenn sich sein Inhalt geändert hat.
  const refresh = () => {
    const cfg = store.settings, s = snapshot();
    const fresh = seen ? s.called.filter((c) => !seen.has(c.key)) : [];
    seen = new Set(s.called.map((c) => c.key));
    const src = logoURL(cfg), head = [src.length, src.slice(-24), cfg.brand_name].join("|");   // Logo kann eine lange Daten-URL sein
    if (head !== last.head) { last.head = head; render($("#display-id", el), headView(cfg)); document.title = `Aufruf – ${cfg.brand_name}`; }
    const offline = !!(store.hub && !store.hub.online);
    if (offline !== last.offline) { last.offline = offline; $("#conn", el).hidden = !offline; }
    if (!s.on) return;
    const calledSig = s.shown.map((c) => c.key).join("|") + "+" + (s.called.length - s.shown.length);
    if (calledSig !== last.called) {
      last.called = calledSig;
      const grid = $("#called", el), extra = s.called.length - s.shown.length, more = $("#called-more", el);
      grid.dataset.count = String(s.shown.length);
      grid.dataset.len = String(digitsOf(s));
      render(grid, calledTiles(s, fresh.length > 0));
      $("#called-empty", el).hidden = s.shown.length > 0;
      more.hidden = !extra;
      more.textContent = extra ? `und ${extra} weitere` : "";
    }
    const nextSig = s.next.join("|");
    if (nextSig !== last.next) { last.next = nextSig; render($("#next", el), nextTiles(s)); }
    const wait = waitLines(s), waitSig = wait.join("|");
    if (waitSig !== last.wait) {
      last.wait = waitSig;
      const box = $("#wait-info", el);
      render(box, html`${wait.map((line) => html`<span>${line}</span>`)}`);
      box.hidden = !wait.length;
    }
    if (fresh.length) ring();
  };
  const draw = () => {
    mode = modeOf();
    last = {};
    render(el, shell(mode));
    soundUi();
    refresh();
    tick();
  };
  // Modul an/aus oder Lizenz gültig/gesperrt wechselt die Schale (selten); alles andere ist eine Teilaktualisierung.
  const unsub = store.subscribe(() => { if (modeOf() !== mode) draw(); else refresh(); });
  const clock = setInterval(tick, 1000);

  // Ton und Vollbild: erst auf Berührung. Vollbild zuerst und ohne Warten anstoßen (manche Browser verlangen es direkt in der Berührung).
  const goFullscreen = () => quiet(() => {
    const root = document.documentElement, fn = root.requestFullscreen || root.webkitRequestFullscreen;
    return fn ? fn.call(root) : null;
  });
  // Bildschirm wach halten (nur in sicheren Kontexten verfügbar; die Sperre endet, wenn der Tab verdeckt wird)
  const keepAwake = () => quiet(async () => {
    if (!navigator.wakeLock || (wake && !wake.released)) return;
    wake = await navigator.wakeLock.request("screen");
  });
  on(el, "click", "#sound", async () => {
    const fullscreen = goFullscreen();
    try { const Ctx = window.AudioContext || window.webkitAudioContext; audio = Ctx ? new Ctx() : null; } catch (_) { audio = null; }
    activated = true;
    soundUi();
    if (audio) { await quiet(() => audio.resume()); ring(); }   // Probe-Gong: so hört das Team, ob der Ton laut genug ist
    await fullscreen;
    keepAwake();
  });
  on(el, "click", "#sound-toggle", () => { muted = !muted; soundUi(); if (!muted) ring(); });

  const onVisible = () => { if (!document.hidden && activated) keepAwake(); };
  document.addEventListener("visibilitychange", onVisible);
  // Mauszeiger im Vollbild nach kurzer Ruhe ausblenden, bei jeder Bewegung wieder zeigen
  const showCursor = () => {
    el.classList.remove("idle");
    clearTimeout(cursorTimer);
    if (document.fullscreenElement) cursorTimer = setTimeout(() => el.classList.add("idle"), CURSOR_MS);
  };
  for (const type of CURSOR_EVENTS) document.addEventListener(type, showCursor);

  draw();
  return () => {
    clearInterval(clock); clearTimeout(cursorTimer); unsub();
    document.removeEventListener("visibilitychange", onVisible);
    for (const type of CURSOR_EVENTS) document.removeEventListener(type, showCursor);
    if (wake) quiet(() => wake.release());
    if (audio) quiet(() => audio.close());
    if (document.fullscreenElement && document.exitFullscreen) quiet(() => document.exitFullscreen());   // der Admin soll nicht im Vollbild landen
  };
}

register("/anzeige", displayScreen, { kiosk: true, bodyClass: "display" });
