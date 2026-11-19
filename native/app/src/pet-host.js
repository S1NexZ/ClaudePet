// window.petHost for the Tauri app: the same API ui/src/preload.cjs gives the renderer under Electron, over Tauri commands and events.
// Injected before the page's own scripts; Tauri's globals are looked up at call time (they are injected next to this script).
(() => {
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const fire = (cmd, args) => { invoke(cmd, args).catch(() => {}); };
  // Subscribed at once when the page is created, before the renderer asks for its config: an event that comes before the renderer's
  // own handler is attached is kept for it (registration is async; a snapshot sent meanwhile would be lost otherwise)
  const EVENTS = ['pet:msg', 'pet:bridge', 'pet:summon', 'pet:answer-key', 'pet:answer-keys', 'pet:moving', 'pet:scale', 'pet:hover', 'pet:open-settings', 'pet:models:progress'];
  const handlers = {}, queued = {};
  const subscribe = () => {
    if (!window.__TAURI__?.event) { setTimeout(subscribe, 0); return; }
    for (const ev of EVENTS) window.__TAURI__.event.listen(ev, (e) => (handlers[ev] ? handlers[ev](e.payload) : (queued[ev] ??= []).push(e.payload)));
  };
  subscribe();
  const on = (ev, cb) => { handlers[ev] = cb; for (const p of queued[ev]?.splice(0) ?? []) cb(p); };
  // not there yet in this build (later milestones): a harmless answer instead of an error
  const later = (value = null) => () => Promise.resolve(value);
  const none = () => {};

  // Electron moves the window by itself over `-webkit-app-region: drag`; the webview needs to be told
  const dragRegion = (el) => {
    for (; el && el.nodeType === 1; el = el.parentElement) {
      const r = getComputedStyle(el).getPropertyValue('-webkit-app-region') || getComputedStyle(el).getPropertyValue('app-region');
      if (r === 'drag') return true;
      if (r === 'no-drag') return false;
    }
    return false;
  };
  // right-click on the pet: the app's menu, as under Electron (never the webview's own)
  window.addEventListener('contextmenu', (e) => { e.preventDefault(); if (dragRegion(e.target)) fire('context_menu'); }, true);
  window.addEventListener('mousedown', (e) => { if (e.button === 0 && dragRegion(e.target)) { e.preventDefault(); fire('start_drag'); } }, true);

  window.petHost = {
    config: () => invoke('config'),
    send: (cmd) => fire('cmd', { cmd }),
    onMsg: (cb) => on('pet:msg', cb),
    onBridge: (cb) => on('pet:bridge', cb),
    onSummon: (cb) => on('pet:summon', cb),
    onAnswerKey: (cb) => on('pet:answer-key', cb),
    onAnswerKeys: (cb) => on('pet:answer-keys', cb),
    openTerminal: (sessionId) => fire('open_terminal', { sessionId: String(sessionId) }),
    pickFolder: () => invoke('pick_folder'),
    focus: () => fire('focus'),
    rects: (r) => fire('rects', { rects: r }),
    resize: (_w, h) => fire('resize', { h }),
    onMoving: (cb) => on('pet:moving', cb),
    models: {
      list: later([]), data: later(null), use: later(null), installZip: later(null), remove: later(null),
      codexScan: later([]), codexImport: later(null), onProgress: (cb) => on('pet:models:progress', cb), reveal: none, pathForFile: () => '',
    },
    copyText: (t) => fire('copy_text', { text: String(t) }),
    openUrl: (u) => fire('open_url', { url: String(u) }),
    onScale: (cb) => on('pet:scale', cb),
    setPetScale: (v) => fire('set_scale', { v }),
    hoverRects: (r) => fire('hover_rects', { rects: r }),
    onHover: (cb) => on('pet:hover', (h) => cb(!!h)),
    setLanguage: (l) => fire('set_language', { pref: String(l) }),
    setPermissions: (m) => fire('set_permissions', { mode: String(m) }),
    connections: {
      get: () => invoke('connections'),
      apply: (host, action) => invoke('connections_apply', { host: String(host), action: String(action) }),
      answerPermissions: (on) => invoke('answer_permissions', { on: on === true }),
      sdkChats: (on) => invoke('sdk_chats', { on: on === true }),
      newChatIn: (where) => invoke('new_chat_in', { place: String(where) }),
      desktopSend: (how) => invoke('desktop_send', { how: String(how) }),
      diagnostics: () => invoke('diagnostics_report'),
    },
    setAppearance: (a) => fire('set_appearance', { a }),
    onOpenSettings: (cb) => on('pet:open-settings', cb),
    notify: (title, body) => fire('notify', { title: String(title), body: String(body) }),
  };
})();
