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
  set('usage-ring', { title: L('Лимиты плана: данных нет', 'Plan limits: no data', '套餐额度：无数据') });
  set('btn-allow', { text: L('Разрешить', 'Allow', '允许') });
  set('btn-deny', { text: L('Отклонить', 'Deny', '拒绝') });
  set('settings', { aria: L('Настройки ccPet', 'ccPet settings', 'ccPet 设置') });
  set('usage', { aria: L('Лимиты использования плана', 'Plan usage limits', '套餐用量额度') });
  set('chat-switch', { title: L('Сменить чат (Ctrl+Tab)', 'Switch chat (Ctrl+Tab)', '切换聊天 (Ctrl+Tab)') });
  set('btn-term', { title: L('Открыть в терминале', 'Open in terminal', '在终端中打开'), aria: L('Открыть в терминале', 'Open in terminal', '在终端中打开') });
  set('btn-end', { title: L('Завершить сессию', 'End session', '结束会话'), aria: L('Завершить сессию', 'End session', '结束会话') });
  set('btn-close', { title: L('Свернуть', 'Collapse', '收起'), aria: L('Свернуть', 'Collapse', '收起') });
  set('btn-folder', { title: L('Новый чат в папке…', 'New chat in a folder…', '在文件夹中新建聊天…'), aria: L('Новый чат в папке', 'New chat in a folder', '在文件夹中新建聊天') });
  set('input', { placeholder: L('Начать новый чат', 'Start a new chat', '开始新聊天') });
  set('btn-stop', { title: L('Остановить', 'Stop', '停止'), aria: L('Остановить', 'Stop', '停止') });
  set('btn-send', { title: L('Отправить', 'Send', '发送'), aria: L('Отправить', 'Send', '发送') });
  set('btn-new', { title: L('Чат', 'Chat', '聊天'), aria: L('Чат', 'Chat', '聊天') });
  set('btn-settings', { title: L('Настройки', 'Settings', '设置'), aria: L('Настройки', 'Settings', '设置') });
  set('btn-activity', { title: L('Сессии', 'Sessions', '会话'), aria: L('Сессии', 'Sessions', '会话') });
  set('btn-reload', { title: L('Найти сессии заново', 'Find sessions again', '重新查找会话'), aria: L('Найти сессии заново', 'Find sessions again', '重新查找会话') });
}
