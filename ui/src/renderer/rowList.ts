/** A session row: updated in place (no rebuild) so hover, focus and the pointer never flicker when the clock ticks. */
export interface RowData { id: string; current: boolean; tone: string; name: string; meta: string; tip: string; dismissable: boolean; group?: boolean; open?: boolean }

export interface RowHandlers { open(id: string): void; toggle(): void; dismiss(id: string): void; dismissLabel: string }

function make(h: RowHandlers): HTMLElement {
  const row = document.createElement('button');
  row.setAttribute('role', 'option');
  const dot = document.createElement('i'); const name = document.createElement('span'); name.className = 'name';
  const meta = document.createElement('span'); meta.className = 'meta';
  const x = document.createElement('span'); x.className = 'row-x'; x.setAttribute('role', 'button'); x.textContent = '×';
  x.setAttribute('aria-label', h.dismissLabel); x.dataset.tip = h.dismissLabel;
  row.append(dot, name, meta, x);
  row.addEventListener('click', (e) => {
    const id = row.dataset.id ?? '';
    if ((e.target as HTMLElement).closest('.row-x')) { e.stopPropagation(); h.dismiss(id); } else h.open(id);
  });
  return row;
}

function makeGroup(h: RowHandlers): HTMLElement {
  const row = document.createElement('button');
  const name = document.createElement('span'); name.className = 'name';
  const chev = document.createElement('i'); chev.className = 'chev';
  row.append(name, chev);
  row.addEventListener('click', () => h.toggle());
  return row;
}

const setText = (e: Element, t: string) => { if (e.textContent !== t) e.textContent = t; };

/** Make `container` show `rows` in order (before `tail`, if given), reusing existing elements by session id. */
export function syncRows(container: HTMLElement, rows: RowData[], h: RowHandlers, tail: Element | null = null): void {
  const have = new Map<string, HTMLElement>();
  for (const c of Array.from(container.children)) if (c instanceof HTMLElement && c.dataset.id) have.set(c.dataset.id, c);
  let prev: Element | null = null;
  for (const r of rows) {
    let el = have.get(r.id);
    if (el) have.delete(r.id); else { el = r.group ? makeGroup(h) : make(h); el.dataset.id = r.id; }
    if (r.group) {
      const gc = `row group${r.open ? ' open' : ''}`; if (el.className !== gc) el.className = gc;
      setText(el.children[0], r.name); el.setAttribute('aria-expanded', String(!!r.open));
      const w: Element | null = prev ? prev.nextElementSibling : container.firstElementChild;
      if (w !== el) container.insertBefore(el, w ?? tail);
      prev = el; continue;
    }
    const cls = `row${r.current ? ' current' : ''}${r.dismissable ? ' can-x' : ''}`;
    if (el.className !== cls) el.className = cls;
    const [dot, name, meta] = Array.from(el.children);
    const dc = `dot ${r.tone}`.trim(); if (dot.className !== dc) dot.className = dc;
    setText(name, r.name); setText(meta, r.meta);
    if (el.dataset.tip !== r.tip) el.dataset.tip = r.tip;
    const want: Element | null = prev ? prev.nextElementSibling : container.firstElementChild;
    if (want !== el) container.insertBefore(el, want ?? tail);
    prev = el;
  }
  for (const el of have.values()) el.remove();
}
