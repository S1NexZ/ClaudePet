export type Block = { type: 'p' | 'h'; text: string } | { type: 'code'; text: string; lang: string };
export type Inline = { t: 'text' | 'code' | 'bold'; v: string };

/** Splits a message into paragraphs and fenced code blocks (an unclosed fence runs to the end). */
export function mdBlocks(text: string): Block[] {
  const out: Block[] = [];
  const parts = text.split(/^```/m);
  parts.forEach((part, i) => {
    if (i % 2 === 0) {
      // prose: headings and table runs are split out, the rest stays paragraphs
      let para: string[] = [], table: string[] = [];
      const flush = () => {
        const t = para.join('\n').trim();
        if (t) out.push({ type: 'p', text: t });
        para = [];
        if (table.length) out.push({ type: 'code', text: table.join('\n'), lang: 'table' });
        table = [];
      };
      for (const line of part.split('\n')) {
        if (/^\s*\|/.test(line)) { if (para.length) { const keep = table; table = []; flush(); table = keep; } table.push(line.trim()); continue; }
        if (table.length) flush();
        const h = /^#{1,6}\s+(.*)$/.exec(line);
        if (h) { flush(); out.push({ type: 'h', text: h[1].trim() }); continue; }
        para.push(line);
      }
      flush();
    } else {
      const nl = part.indexOf('\n');
      const lang = (nl < 0 ? part : part.slice(0, nl)).trim();
      out.push({ type: 'code', text: (nl < 0 ? '' : part.slice(nl + 1)).replace(/\n$/, ''), lang });
    }
  });
  return out;
}

/** Inline `code` and **bold**; everything else is literal text. */
export function mdInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
  let pos = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > pos) out.push({ t: 'text', v: text.slice(pos, m.index) });
    out.push(m[1] !== undefined ? { t: 'code', v: m[1] } : { t: 'bold', v: m[2] });
    pos = m.index + m[0].length;
  }
  if (pos < text.length) out.push({ t: 'text', v: text.slice(pos) });
  return out;
}
