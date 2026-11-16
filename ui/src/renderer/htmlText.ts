import { L, getLang } from '../../../shared/src/i18n.js';

/** The static texts of index.html are written in Russian there; this swaps in the active language (title / aria-label / text). */
export function localizeHtml(doc: Document = document): void {
  doc.documentElement.lang = getLang();
  const set = (id: string, o: { title?: string; aria?: string; text?: string; placeholder?: string }) => {
    const e = doc.getElementById(id); if (!e) return;
    if (o.title !== undefined) e.setAttribute('title', o.title);
    if (o.aria !== undefined) e.setAttribute('aria-label', o.aria);
    if (o.text !== undefined) e.textContent = o.text;
    if (o.placeholder !== undefined) e.setAttribute('placeholder', o.placeholder);
  };
  set('usage-ring', { title: L('Лимиты плана: данных нет', 'Plan limits: no data') });
  set('btn-allow', { text: L('Разрешить', 'Allow') });
  set('btn-deny', { text: L('Отклонить', 'Deny') });
  set('settings', { aria: L('Настройки Claude Pet', 'Claude Pet settings') });
  set('usage', { aria: L('Лимиты использования плана', 'Plan usage limits') });
  set('chat-switch', { title: L('Сменить чат (Ctrl+Tab)', 'Switch chat (Ctrl+Tab)') });
  set('btn-term', { title: L('Открыть в терминале', 'Open in terminal'), aria: L('Открыть в терминале', 'Open in terminal') });
  set('btn-end', { title: L('Завершить сессию', 'End session'), aria: L('Завершить сессию', 'End session') });
  set('btn-close', { title: L('Свернуть', 'Collapse'), aria: L('Свернуть', 'Collapse') });
  set('btn-folder', { title: L('Новый чат в папке…', 'New chat in a folder…'), aria: L('Новый чат в папке', 'New chat in a folder') });
  set('input', { placeholder: L('Начать новый чат', 'Start a new chat') });
  set('btn-stop', { title: L('Остановить', 'Stop'), aria: L('Остановить', 'Stop') });
  set('btn-send', { title: L('Отправить', 'Send'), aria: L('Отправить', 'Send') });
  set('btn-new', { title: L('Чат', 'Chat'), aria: L('Чат', 'Chat') });
  set('btn-settings', { title: L('Настройки', 'Settings'), aria: L('Настройки', 'Settings') });
  set('btn-activity', { title: L('Сессии', 'Sessions'), aria: L('Сессии', 'Sessions') });
}
