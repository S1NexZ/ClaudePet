# Third-party notices

The MIT license in `LICENSE` covers **only the original source code of ccPet**. It does **not** apply to the items below,
which keep their own licenses and rights.

## Pet model: Clawd (`models/clawd`)
- Pack `clawd-svg`, Codex pet format v2, installed under the id `clawd`; source recorded in its description: https://github.com/godxxy1229/clawd-codex-pet ("An unofficial Claude-inspired companion for Codex.").
- The character Clawd is the mascot of Anthropic's Claude Code; rights to the character belong to their owners. The sprite sheet is included unmodified.

## Pet model: Claude娘 / Claude-maiden (`models/claude-maiden`)
- Pack `claude-maiden`, Codex pet format v2 ("An orange-haired, amber-eyed Claude."); the author is not named in the pack's metadata.
- A fan-made personification of Anthropic's Claude; rights to the artwork belong to its author. Included unmodified.

## Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- © Anthropic PBC. All rights reserved. Use is subject to Anthropic's legal agreements: https://code.claude.com/docs/en/legal-and-compliance
- It is bundled into the application's WSL bridge (`resources/bridge/bridge.cjs`) and is **not** MIT-licensed.
- ccPet uses it to resume sessions (fallback path) and to read plan usage limits (an experimental SDK method).

## GSAP
- GSAP 3 (GreenSock) — bundled into the renderer for the hover and state animations. It is **not** MIT-licensed: it is used under the GreenSock Standard "no charge" license (https://gsap.com/standard-license), which allows free use, including commercial. Only the core engine is used (no premium plugins).

## Electron and Chromium
- Electron 33 — MIT. Chromium and its dependencies — see `LICENSES.chromium.html` and `LICENSE.electron.txt`, installed next to the application.

## Build and test tooling (not shipped inside the application)
electron-builder, esbuild, TypeScript, tsx, Vitest and their dependencies, each under its own license (see their packages).

## Third-party pet models you install yourself
Models installed through the model manager (ZIP or an npm pet installer) are not part of ccPet. Each belongs to its author; check its license before sharing it.
The npm package `codex-pets` mentioned in the model manager is a separate third-party project (MIT) and is not affiliated with ccPet.

## Names
"Claude" and "Claude Code" are trademarks of Anthropic. ccPet is an independent, unofficial project and is not affiliated with or endorsed by Anthropic.
