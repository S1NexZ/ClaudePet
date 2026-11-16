import { describe, it, expect, afterEach } from 'vitest';
import { setLang } from '../../../shared/src/i18n.js';
import { localizeHtml } from './htmlText.js';

/** a tiny stand-in for Document: elements by id with attributes and text */
const fakeDoc = (ids: string[]) => {
  const els = new Map(ids.map((id) => [id, { attrs: {} as Record<string, string>, textContent: '', setAttribute(k: string, v: string) { this.attrs[k] = v; } }]));
  return { documentElement: { lang: '' }, getElementById: (id: string) => els.get(id) ?? null, els } as unknown as Document & { els: Map<string, any> };
};

describe('localizeHtml', () => {
  afterEach(() => setLang('ru'));
  it('swaps the static texts to English and back, and skips ids that are missing', () => {
    const d = fakeDoc(['btn-allow', 'input', 'btn-send']);
    setLang('en'); localizeHtml(d);
    expect(d.els.get('btn-allow').textContent).toBe('Allow');
    expect(d.els.get('input').attrs.placeholder).toBe('Start a new chat');
    expect(d.els.get('btn-send').attrs.title).toBe('Send');
    expect(d.documentElement.lang).toBe('en');
    setLang('ru'); localizeHtml(d);
    expect(d.els.get('btn-allow').textContent).toBe('Разрешить');
  });
});
