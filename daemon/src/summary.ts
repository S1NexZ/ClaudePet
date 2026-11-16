/** One-line description of a tool call for permission prompts and chat chips. */
export function summarize(tool: string, input: Record<string, unknown> = {}): string {
  if (tool === 'Bash') return String(input.command ?? '').slice(0, 200);
  for (const k of ['file_path', 'path', 'pattern', 'url', 'query', 'description'])
    if (typeof input[k] === 'string') return (input[k] as string).slice(0, 200);
  const s = JSON.stringify(input);
  return s === '{}' ? '' : s.slice(0, 120);
}
