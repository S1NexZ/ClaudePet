# Third-party notices

The MIT license in `LICENSE` covers **only the original source code of Claude Pet**. It does **not** apply to the items below,
which keep their own licenses and rights.

## Pet model: Clawd (`models/clawd`)
- Pack `clawd`, Codex pet format, source recorded in its `pet.json`: **codex-pets.net** (sourceId `clawd`).
- Description recorded in the pack: "A compact Codex pet based on official Claude Code pixel Clawd frames, extracted without stretching."
- The character Clawd is the mascot of Anthropic's Claude Code; rights to the character and the original pixel art belong to their owners.
- The pack's individual author is not named in its metadata, so none is stated here. Attribution is not a license: **the redistribution terms of this
  pack have not been verified by the Claude Pet author.** The files `pet.json` and `spritesheet.webp` are included unmodified.
  `tweaks.json` next to them is Claude Pet's own display setting.
- If you are the author or a rights holder and want the credit changed or the pack removed, please open an issue.

## Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- © Anthropic PBC. All rights reserved. Use is subject to Anthropic's legal agreements: https://code.claude.com/docs/en/legal-and-compliance
- It is bundled into the application's WSL bridge (`resources/bridge/bridge.cjs`) and is **not** MIT-licensed.
- Claude Pet uses it to resume sessions (fallback path) and to read plan usage limits (an experimental SDK method).

## GSAP
- GSAP 3 (GreenSock) — bundled into the renderer for the hover and state animations. It is **not** MIT-licensed: it is used under the GreenSock Standard "no charge" license (https://gsap.com/standard-license), which allows free use, including commercial. Only the core engine is used (no premium plugins).

## Electron and Chromium
- Electron 33 — MIT. Chromium and its dependencies — see `LICENSES.chromium.html` and `LICENSE.electron.txt`, installed next to the application.

## Build and test tooling (not shipped inside the application)
electron-builder, esbuild, TypeScript, tsx, Vitest and their dependencies, each under its own license (see their packages).

## Third-party pet models you install yourself
Models installed through the model manager (ZIP or an npm pet installer) are not part of Claude Pet. Each belongs to its author; check its license before sharing it.
The npm package `codex-pets` mentioned in the model manager is a separate third-party project (MIT) and is not affiliated with Claude Pet.

## Names
"Claude" and "Claude Code" are trademarks of Anthropic. Claude Pet is an independent, unofficial project and is not affiliated with or endorsed by Anthropic.
