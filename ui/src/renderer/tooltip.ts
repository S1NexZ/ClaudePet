/** Soft in-app tooltips instead of the grey native ones: any `title` becomes `data-tip`, shown after a short delay near the element. */
export function initTooltips(doc: Document = document): void {
  const tip = doc.createElement('div'); tip.id = 'tip'; tip.setAttribute('role', 'tooltip'); doc.body.append(tip);
  const lift = (e: Element) => { const t = e.getAttribute('title'); if (t) { e.setAttribute('data-tip', t); e.removeAttribute('title'); } };
  doc.querySelectorAll('[title]').forEach(lift);
  new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === 'attributes') lift(m.target as Element);
      else m.addedNodes.forEach((n) => { if (n instanceof Element) { lift(n); n.querySelectorAll('[title]').forEach(lift); } });
    }
  }).observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });

  let timer: ReturnType<typeof setTimeout> | undefined, cur: Element | null = null;
  const hide = () => { clearTimeout(timer); cur = null; tip.classList.remove('on'); };
  const show = (el: Element) => {
    const text = el.getAttribute('data-tip'); if (!text) return;
    tip.textContent = text; tip.classList.add('on');
    const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
    const x = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), window.innerWidth - t.width - 8);
    const below = r.bottom + 8 + t.height <= window.innerHeight;
    tip.style.left = `${Math.round(x)}px`; tip.style.top = `${Math.round(below ? r.bottom + 8 : r.top - 8 - t.height)}px`;
  };
  doc.addEventListener('mouseover', (e) => {
    const el = (e.target as Element | null)?.closest?.('[data-tip]') ?? null;
    if (el === cur) return;
    hide(); cur = el;
    if (el) timer = setTimeout(() => { if (cur === el) show(el); }, 450);
  });
  doc.addEventListener('mousedown', hide, true);
  doc.addEventListener('mouseleave', hide);
}
