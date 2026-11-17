/** The PowerShell `claude` wrapper line (no fs here: the renderer shows the same text the profile check compares). */
export const wrapperLine = (helper: string) => `function claude { & '${helper.replace(/'/g, "''")}' pty claude @args }`;
