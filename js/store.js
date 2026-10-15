// Speicher der Standalone-App: alle Tabellen + Einstellungen in EINEM Datensatz. API: await load();
// store.data (nur lesen); await store.update(d => { … }); store.subscribe(fn) für Neu-Rendern nach Änderungen.
//
// Zwei Betriebsarten, derselbe Aufruf-Vertrag:
//  • lokal (Standard, GitHub Pages, Datei/Server ohne Hub): Datensatz in IndexedDB (Rückfall localStorage).
//    Mehrere Tabs desselben Geräts halten sich per BroadcastChannel („fleetmanager“) gegenseitig aktuell.
//  • Hub (die Seite kommt vom Go-Server unter /app/ und /api/hub antwortet): das Datendokument liegt auf dem
//    Stand-Laptop (internal/app/hub.go), alle Geräte lesen und schreiben dasselbe. Änderungen gehen mit der
//    bekannten Version per PUT zum Hub; ist die Version veraltet (409), wird der neue Stand übernommen, die
//    Änderung darauf wiederholt und erneut gesendet. Ein Long-Poll liefert fremde Änderungen sofort.
//    Der letzte bekannte Stand wird zusätzlich in IndexedDB zwischengespeichert (Anzeige ohne Verbindung).
//
// store.hub ist null (lokal) oder { online, url, version, needsPin }; subscribe-Listener werden auch bei
// Änderungen des Hub-Zustands aufgerufen. Listener bekommen (data, info): info.remote ist true, wenn die
// Änderung nicht von diesem Tab selbst kam (anderes Gerät, anderer Tab, Hub-Zustand).
//
// Lizenz (license.js): licenseStatus() ist synchron und liest einen Zwischenspeicher. load() füllt ihn vor dem ersten Rendern
// (WebCrypto, async); nach einer Änderung des Schlüssels in update()/replace() prüft der Speicher ihn gleich mit. Änderungen von
// anderen Geräten fängt der synchrone Rückfall in licenseStatus() auf. Der Hub-Vertrag bleibt unverändert (license_key ist
// nur ein weiteres Feld in settings). Der Aktivierungscode dagegen gehört zum GERÄT: er liegt in localStorage["fm_license_code"], nie im Datensatz
// und nie im Hub-Dokument; ändert ein Tab ihn, benachrichtigt license.js (onDeviceCodeChange) die Beobachter dieses Speichers wie bei einer Änderung.
import { emptyData, DEFAULT_SETTINGS, SETTINGS_VERSION, migrateSettings } from "./model.js";
import { warmLicense, useLicenseSettings, useLicenseHub, migrateLegacyCode, onDeviceCodeChange, deviceCode, hubActivationValue } from "./license.js";
import { deviceId, parseCode } from "./codes.js";

const DB_NAME = "fleetmanager";
const STORE = "kv";
const KEY = "data";               // lokaler Datensatz (Standalone-Betrieb) – bleibt im Hub-Betrieb unberührt
const HUB_KEY = "hubdoc";         // zuletzt bekannter Hub-Stand { version, url, data } (Anzeige ohne Verbindung)
const LS_KEY = "fleetmanager.data";
const LS_HUB_KEY = "fleetmanager.hubdoc";
const LS_PING = "fleetmanager.ping";
const CHANNEL = "fleetmanager";
const HUB_AUTH = "fm_hub_key";    // localStorage: voller admin_pin_hash des Laptops (Zugangsschlüssel)

const HUB_PATH = /^\/app(\/|$)/;  // nur vom Go-Server ausgelieferte Seiten können einen Hub haben
const DETECT_MS = 1500;           // /api/hub beim Laden
const DOC_MS = 5000;              // Dokument holen
const PUT_MS = 20000;             // Dokument schreiben (Logo als Daten-URL kann groß sein)
const WAIT_S = 25;                // Long-Poll (Server begrenzt auf 25)
const MAX_TRIES = 4;              // 1 Versuch + 3 Wiederholungen nach Konflikten

const MSG_OFFLINE = "Keine Verbindung zum Stand-Laptop – bitte noch einmal versuchen.";
const MSG_PIN = "Stand-PIN erforderlich – dieses Gerät bitte mit dem Laptop verbinden.";
const MSG_CONFLICT = "Der Stand wurde gleichzeitig auf einem anderen Gerät geändert – bitte noch einmal versuchen.";
const MSG_SERVER = "Der Stand-Laptop konnte die Änderung nicht speichern.";

const LOCAL = { remote: false };
const REMOTE = { remote: true };
const HUBSTATE = { remote: true, hub: true };

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("kein IndexedDB"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbGet(db, key = KEY) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbPut(db, value, key = KEY) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
function lsRead(key) {
  try { return JSON.parse((typeof localStorage !== "undefined" && localStorage.getItem(key)) || "null"); } catch (_) { return null; }
}

// Fehlende Felder/Einstellungen aus älteren Versionen ergänzen
export function normalize(raw) {
  const d = emptyData();
  if (raw && typeof raw === "object") {
    for (const k of ["leads", "queue", "vehicles", "damages"]) if (Array.isArray(raw[k])) d[k] = raw[k];
    const from = raw.settings ? Number(raw.settings.settings_version) || 0 : 0;   // Stand der Standardwerte beim Speichern (0 = Altbestand)
    d.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
    // Alte Schlüssel: Fahrzeug-Textliste → Fahrzeuge, queue_also_lead → Marketing-Opt-in
    if (raw.settings && typeof raw.settings.queue_also_lead === "boolean" && raw.settings.queue_marketing_optin === undefined) {
      d.settings.queue_marketing_optin = raw.settings.queue_also_lead;
    }
    delete d.settings.queue_also_lead;
    delete d.settings.vehicles;
    if (from < SETTINGS_VERSION) migrateSettings(d.settings, from);   // frühere Standardwerte (zwei Formulare, Beispielmarke Togg) → die neuen, je Schritt einmalig
  }
  return d;
}

// --- Hub: Zugangsschlüssel, Anfragen, Erkennung ---------------------------------------------------
let memoryKey = "";   // falls localStorage gesperrt ist: wenigstens für diese Sitzung
function hubKey() {
  try { return localStorage.getItem(HUB_AUTH) || memoryKey; } catch (_) { return memoryKey; }
}
function setHubKey(key) {
  memoryKey = key || "";
  try { if (key) localStorage.setItem(HUB_AUTH, key); else localStorage.removeItem(HUB_AUTH); } catch (_) {}
}

// Eine Anfrage an den Hub: liefert { status, body } (body = geparstes JSON oder null); wirft bei Netzfehler/Zeitüberschreitung.
async function hubFetch(path, { method = "GET", body = null, timeout = DOC_MS, ctl = new AbortController(), key = hubKey() } = {}) {
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const headers = {};
    if (key) headers["X-Hub-Key"] = key;
    if (body !== null) headers["Content-Type"] = "application/json";
    const resp = await fetch(path, { method, headers, body, cache: "no-store", signal: ctl.signal });
    let json = null;
    try { json = await resp.json(); } catch (_) {}
    return { status: resp.status, body: json };
  } finally {
    clearTimeout(timer);
  }
}

// Kommt die Seite vom Stand-Laptop? { status: "none" } = kein Hub (lokaler Betrieb), "down" = Hub-Pfad, aber keine
// Antwort (Netz/Zeitüberschreitung), "ok" = Hub gefunden. Wirft nie und dauert höchstens DETECT_MS.
async function detectHub() {
  if (typeof location === "undefined" || !HUB_PATH.test(location.pathname)) return { status: "none" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), DETECT_MS);
  try {
    const resp = await fetch("/api/hub", { cache: "no-store", signal: ctl.signal });
    if (!resp.ok) return { status: "none" };
    let info = null;
    try { info = await resp.json(); } catch (_) {}
    return info && info.hub === true ? { status: "ok", info } : { status: "none" };
  } catch (_) {
    return { status: "down" };
  } finally {
    clearTimeout(timer);
  }
}

class Store {
  constructor() {
    this.data = emptyData();
    this.db = null;
    this.listeners = new Set();
    this.ready = false;
    this.persistent = false;
    this.hub = null;                    // null = lokal; sonst { online, url, version, needsPin }
    this._chain = Promise.resolve();    // Änderungen laufen nacheinander (sonst ginge im selben Tab ein Update verloren)
    this._bc = null;
    this._pollCtl = null;
    this._aborted = false;
    this._wakeFn = null;
    this._lastFail = 0;
  }

  async load() {
    let local = null, cached = null;
    try {
      this.db = await openDB();
      local = await idbGet(this.db, KEY);
      cached = await idbGet(this.db, HUB_KEY);
    } catch (e) {
      this.db = null;
      local = lsRead(LS_KEY);
      cached = lsRead(LS_HUB_KEY);
    }
    this.data = normalize(local);
    // Hub erkennen; ohne Antwort (Laptop aus, Funkloch) trotzdem im Hub-Betrieb starten, wenn dieses Gerät schon einmal
    // verbunden war – mit dem zwischengespeicherten Stand; die Schleife verbindet sich später von selbst.
    const found = await detectHub();
    const hasCache = !!(cached && cached.data);
    if (found.status === "ok" || (found.status === "down" && hasCache)) await this._enterHub(found.info || null, hasCache ? cached : null);
    else this._startLocalSync();
    // Speicher gegen automatische Bereinigung schützen (iOS/Android), wo möglich
    try { if (typeof navigator !== "undefined" && navigator.storage && navigator.storage.persist) this.persistent = await navigator.storage.persist(); } catch (_) {}
    migrateLegacyCode(this.data.settings);   // ein früher in den Einstellungen gespeicherter Code, der für DIESES Gerät gilt, wandert einmal in den Gerätespeicher
    await warmLicense(this.data.settings);   // Lizenz vorab prüfen, damit schon die erste Seite den richtigen Zustand zeigt
    this.ready = true;
    return this.data;
  }
  get settings() { return this.data.settings; }

  // Änderung: fn bekommt eine tiefe Kopie, gibt sie (bei Erfolg) zurück. Liefert fn {error} → nichts gespeichert.
  update(fn) {
    const run = this._chain.then(() => (this.hub ? this._updateHub(fn, null) : this._updateLocal(fn)));
    this._chain = run.then(() => {}, () => {});
    return run;
  }
  // Komplett ersetzen (Wiederherstellen aus Backup)
  replace(raw) {
    const d = normalize(raw);
    const run = this._chain.then(async () => {
      await warmLicense(d.settings);
      if (this.hub) {
        const r = await this._updateHub(null, d);
        if (r.error) throw new Error(r.error);   // der Aufrufer (settings.js) meldet Ausnahmen, statt Erfolg vorzutäuschen
        return;
      }
      await this.persist(d);
      this.data = d;
      this.notify();
    });
    this._chain = run.then(() => {}, () => {});
    return run;
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  notify(info = LOCAL) { for (const fn of this.listeners) { try { fn(this.data, info); } catch (e) { console.error(e); } } }
  // Backup als JSON (Datei) – gleiche Struktur wie der Speicher
  backupJSON() {
    return JSON.stringify({ app: "fleetmanager", version: 1, exported_at: new Date().toISOString(), ...this.data }, null, 2);
  }

  // --- Lokaler Betrieb ----------------------------------------------------------------------------
  async _updateLocal(fn) {
    const draft = structuredClone(this.data);
    const result = fn(draft);
    const r = result && typeof result.then === "function" ? await result : result;
    if (r && r.error) return r;
    if (draft.settings.license_key !== this.data.settings.license_key) await warmLicense(draft.settings);   // neuer Schlüssel: gleich prüfen
    await this.persist(draft);
    this.data = draft;
    this.notify();
    return r || { ok: true };
  }
  async persist(d) {
    if (this.db) {
      await idbPut(this.db, d);
    } else if (typeof localStorage !== "undefined") {
      localStorage.setItem(LS_KEY, JSON.stringify(d));
    }
    this._announce();
  }
  // Andere Tabs desselben Geräts benachrichtigen (sie laden den Datensatz neu)
  _announce() {
    try {
      if (this._bc) this._bc.postMessage("persist");
      else if (typeof localStorage !== "undefined") localStorage.setItem(LS_PING, String(Date.now()));
    } catch (_) {}
  }
  _startLocalSync() {
    try {
      if (typeof BroadcastChannel !== "undefined") {
        this._bc = new BroadcastChannel(CHANNEL);
        this._bc.onmessage = () => this._reloadLocal();
      }
    } catch (_) { this._bc = null; }
    // Rückfall ohne BroadcastChannel (ältere Safari) bzw. Speicher in localStorage: das storage-Ereignis kommt nur in anderen Tabs an
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("storage", (ev) => { if (ev.key === LS_KEY || ev.key === LS_PING) this._reloadLocal(); });
    }
  }
  _reloadLocal() {
    const run = this._chain.then(async () => {
      let raw = null;
      try { raw = this.db ? await idbGet(this.db, KEY) : lsRead(LS_KEY); } catch (_) { return; }
      this.data = normalize(raw);
      this.notify(REMOTE);
    });
    this._chain = run.then(() => {}, () => {});
  }

  // --- Hub: Einstieg, Dokument, Zwischenspeicher ----------------------------------------------------
  async _enterHub(info, cached) {
    this.hub = { online: !!info, url: (info && info.lan_url) || (cached && cached.url) || location.origin, version: cached ? cached.version || 0 : 0, needsPin: false };
    if (cached) this.data = normalize(cached.data);   // zuletzt bekannter Hub-Stand statt des alten lokalen Datensatzes
    if (info) {
      if (info.pin_required && !hubKey()) this.hub.needsPin = true;
      else {
        try {
          const r = await hubFetch("/api/doc", { timeout: DOC_MS });
          if (r.status === 200 && r.body) await this._applyRemote(r.body, false);
          else if (r.status === 401) this.hub.needsPin = true;
          else this.hub.online = false;
        } catch (_) { this.hub.online = false; }
      }
    }
    this._startLoop();
  }
  // Stand vom Hub übernehmen. Ein leerer Hub (Version 0, data:null) bekommt den Stand dieses Geräts als Anfang.
  async _applyRemote(doc, announce = true) {
    if (doc.data == null) { await this._seed(); return; }
    this.data = normalize(doc.data);
    this.hub.version = doc.version;
    this._cache();
    if (announce) this.notify(REMOTE);
  }
  async _seed() {
    try {
      const r = await hubFetch("/api/doc", { method: "PUT", body: JSON.stringify({ version: 0, data: this.data }), timeout: PUT_MS });
      if (r.status === 200 && r.body) { this.hub.version = r.body.version; this._cache(); }
      else if (r.status === 409 && r.body && r.body.data != null) { this.data = normalize(r.body.data); this.hub.version = r.body.version; this._cache(); }
    } catch (_) { this.hub.online = false; }
  }
  _cache() {
    const rec = { version: this.hub.version, url: this.hub.url, data: this.data };
    try {
      if (this.db) idbPut(this.db, rec, HUB_KEY).catch(() => {});
      else if (typeof localStorage !== "undefined") localStorage.setItem(LS_HUB_KEY, JSON.stringify(rec));
    } catch (_) {}   // der Zwischenspeicher ist nur eine Zugabe – ein Fehler (Platz, privater Modus) bricht nichts ab
  }
  _setOnline(online) {
    if (this.hub.online === online) return;
    this.hub.online = online;
    this.notify(HUBSTATE);
  }

  // Änderung im Hub-Betrieb (fn) oder Ersetzen des ganzen Dokuments (replacement)
  async _updateHub(fn, replacement) {
    if (this.hub.needsPin) return { error: MSG_PIN };
    if (!this.hub.online && Date.now() - this._lastFail < 3000) return { error: MSG_OFFLINE };   // gerade erst gescheitert: nicht erneut warten
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      const version = this.hub.version;
      let draft, result = { ok: true };
      if (replacement) draft = structuredClone(replacement);
      else {
        draft = structuredClone(this.data);
        const out = fn(draft);
        result = out && typeof out.then === "function" ? await out : out;
        if (result && result.error) return result;
        if (draft.settings.license_key !== this.data.settings.license_key) await warmLicense(draft.settings);   // neuer Schlüssel: gleich prüfen
      }
      let r;
      try {
        r = await hubFetch("/api/doc", { method: "PUT", body: JSON.stringify({ version, data: draft }), timeout: this.hub.online ? PUT_MS : 6000 });
      } catch (_) {
        this._lastFail = Date.now();
        this._setOnline(false);
        this._wake(true);   // sofort neu probieren, ob der Hub wieder erreichbar ist
        return { error: MSG_OFFLINE };
      }
      if (r.status === 409 && r.body) {
        // Ein anderes Gerät war schneller: dessen Stand übernehmen und die Änderung darauf wiederholen.
        // (Leerer Hub, data:null: Version 0 übernehmen – der nächste Versuch speist den Stand wieder ein.)
        if (r.body.data != null) this.data = normalize(r.body.data);
        this.hub.version = r.body.version;
        await new Promise((done) => setTimeout(done, Math.random() * 60 * (attempt + 1)));   // kurze Zufallspause: mehrere Geräte stoßen nicht im Gleichschritt erneut zusammen
        continue;
      }
      if (r.status === 401) {
        this.hub.needsPin = true;
        this.notify(HUBSTATE);
        return { error: MSG_PIN };
      }
      if (r.status === 429) return { error: "Bitte kurz warten und noch einmal versuchen." };
      if (r.status !== 200 || !r.body) return { error: r.status === 413 || r.status === 400 ? "Das Dokument ist zu groß oder ungültig." : MSG_SERVER };
      const wasOnline = this.hub.online;
      this.hub.online = true;
      // Neue/geänderte Stand-PIN: dieses Gerät kennt sie (hat sie gerade gesetzt) und bleibt verbunden, alle anderen müssen neu verbinden.
      const pinHash = (draft.settings && draft.settings.admin_pin_hash) || "";
      if (pinHash && pinHash !== hubKey()) setHubKey(pinHash);
      // Hat ein Long-Poll den neuen Stand schon geliefert (oder noch Neueres), nicht zurückschreiben.
      if (this.hub.version < r.body.version) {
        this.data = draft;
        this.hub.version = r.body.version;
        this._cache();
        this.notify();
      } else if (!wasOnline) this.notify(HUBSTATE);
      return result || { ok: true };
    }
    this.notify(REMOTE);   // der übernommene Stand soll sichtbar sein, auch wenn die Änderung nicht durchkam
    return { error: MSG_CONFLICT };
  }

  // --- Hub: Live-Aktualisierung (Long-Poll) -----------------------------------------------------------
  _startLoop() {
    if (this._looping) return;
    this._looping = true;
    // Aufwachen: Tab wieder sichtbar, Fenster fokussiert, Netz zurück → sofort neu abgleichen
    document.addEventListener("visibilitychange", () => { if (!document.hidden) this._wake(true); });
    window.addEventListener("focus", () => this._wake(true));
    window.addEventListener("online", () => this._wake(true));
    this._loop();
  }
  // Schlafen, bis die Zeit um ist oder _wake() gerufen wird
  _sleep(ms) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); if (this._wakeFn === done) this._wakeFn = null; resolve(); };
      const timer = setTimeout(done, ms);
      this._wakeFn = done;
    });
  }
  _wake(abortPoll = false) {
    if (abortPoll && this._pollCtl) { this._aborted = true; this._pollCtl.abort(); }
    const fn = this._wakeFn;
    this._wakeFn = null;
    if (fn) fn();
  }
  // Die Schleife darf nie sterben: ein unerwarteter Fehler in einem Durchgang wird gemeldet, danach geht es weiter.
  async _loop() {
    const st = { backoff: 0, quick: true };
    for (;;) {
      try { await this._cycle(st); } catch (e) { console.error("Hub-Abgleich:", e); st.quick = true; await this._sleep(5000); }
    }
  }
  // Ein Durchgang: eine Anfrage an den Hub (Long-Poll) und deren Auswertung
  async _cycle(st) {
    if (document.hidden || this.hub.needsPin) {   // pausiert: wartet auf Sichtbarkeit bzw. auf das Verbinden
      await this._sleep(60000);
      st.quick = true;
      return;
    }
    const since = this.hub.version, usedKey = hubKey(), started = Date.now(), wasQuick = st.quick;
    const ctl = this._pollCtl = new AbortController();
    let r;
    try {
      // Erste Anfrage nach dem Aufwachen ohne Warten (sofort aktuell), danach lange Anfragen
      r = await hubFetch(`/api/doc?since=${since}&wait=${st.quick ? 0 : WAIT_S}`, { ctl, key: usedKey, timeout: st.quick ? DOC_MS : (WAIT_S + 10) * 1000 });
    } catch (_) {
      this._pollCtl = null;
      if (this._aborted) { this._aborted = false; st.quick = true; return; }   // von uns abgebrochen (Fokus, Sichtbarkeit): kein Fehler
      await this._failed(st);
      return;
    }
    this._pollCtl = null;
    this._aborted = false;
    if (r.status === 200 && r.body) {
      st.backoff = 0;
      st.quick = false;
      this._setOnline(true);
      // Antwort nur verwenden, wenn sich der Stand seit der Anfrage nicht anderweitig geändert hat (eigenes PUT, anderer Tab)
      if (r.body.changed === false) {
        if (!wasQuick && Date.now() - started < 500) await this._sleep(1000);   // Schutz vor einer Daueranfrage, falls ein Zwischenserver sofort antwortet
        return;
      }
      if (this.hub.version !== since) return;
      await this._applyRemote(r.body);
    } else if (r.status === 401) {
      // Gerade läuft evtl. eine eigene Änderung, die die PIN wechselt – erst abwarten, dann entscheiden
      await this._chain;
      if (hubKey() !== usedKey) { st.quick = true; return; }
      this._setOnline(true);
      this.hub.needsPin = true;
      this.notify(HUBSTATE);
    } else if (r.status === 429) {
      await this._sleep(2200);
      st.quick = true;
    } else {
      await this._failed(st);   // Hub antwortet, aber fehlerhaft (5xx …)
    }
  }
  // Keine (brauchbare) Antwort: offline anzeigen und mit wachsendem Abstand (2 s … 10 s) neu versuchen
  async _failed(st) {
    this._setOnline(false);
    st.backoff = Math.min(st.backoff ? st.backoff * 2 : 2000, 10000);
    await this._sleep(st.backoff);
    st.quick = true;
  }

  // --- Hub: Verbinden (Bildschirm „Mit dem Stand-Laptop verbinden“) ------------------------------------
  // Frischer Blick auf den Hub: { version, lan_url, pin_required, pin_salt } oder null, wenn er nicht antwortet.
  async hubPeek() {
    try {
      const r = await hubFetch("/api/hub", { timeout: 3000, key: "" });
      return r.status === 200 && r.body && r.body.hub ? r.body : null;
    } catch (_) { return null; }
  }
  // Zugangsschlüssel (voller PIN-Hash; leer, wenn der Hub keine PIN verlangt) ausprobieren.
  // Liefert { ok: true } oder { error: "pin" | "limit" | "offline" | "server" }.
  async hubUseKey(key) {
    if (!this.hub) return { error: "server" };
    try {
      const r = await hubFetch("/api/doc", { timeout: DOC_MS, key });
      if (r.status === 401) return { error: "pin" };
      if (r.status === 429) return { error: "limit" };
      if (r.status !== 200 || !r.body) return { error: "server" };
      setHubKey(key);
      this.hub.needsPin = false;
      this.hub.online = true;
      await this._applyRemote(r.body, false);
      this.notify(HUBSTATE);
      this._wake(true);   // die pausierte Schleife läuft sofort weiter
      return { ok: true };
    } catch (_) { return { error: "offline" }; }
  }
}

export const store = new Store();
useLicenseSettings(() => store.settings);   // licenseInfo() ohne Argument = die Lizenz dieses Speichers
useLicenseHub(() => store.hub);              // am Stand-Laptop: dessen Aktivierung gilt für verbundene Geräte mit
// Der Aktivierungscode des Geräts hat sich geändert (hier oder in einem anderen Tab): Router, Aktivierungsseite und Admin-Rahmen sollen es merken
onDeviceCodeChange((remote) => {
  store.notify(remote ? REMOTE : LOCAL);
  // Am Stand-Laptop (Hub): die eigene Aktivierung mit allen verbundenen Geräten teilen – lizenziert wird der Stand, nicht jedes Tablet daran.
  // Nur bei einer Aktivierung in diesem Tab (nicht beim storage-Echo anderer Tabs) und nur, wenn der Code zu diesem Gerät passt.
  if (remote || !store.hub) return;
  const code = deviceCode();
  if (!code || !parseCode(code, deviceId())) return;
  const value = hubActivationValue(code, deviceId());
  if (store.settings.hub_activation === value) return;
  store.update((d) => { d.settings.hub_activation = value; return { ok: true }; }).catch(() => {});
});
