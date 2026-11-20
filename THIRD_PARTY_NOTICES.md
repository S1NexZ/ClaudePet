# Third-party notices

The MIT license in `LICENSE` covers **only the original source code of ccPet**. It does **not** apply to the items below,
which keep their own licenses and rights.

## Pet model: Claude娘 / Claude-maiden (`models/claude-maiden`), shown in the app as "cPet"

The app displays this pack under the name **cPet** (Anthropic's trademark guidelines do not allow "Claude" in a third-party product's feature names). The pack's files are unchanged.
- Pack `claude-maiden`, Codex pet format v2 ("An orange-haired, amber-eyed Claude."); the author is not named in the pack's metadata.
- A fan-made personification of Anthropic's Claude; rights to the artwork belong to its author. Included unmodified.

## Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`)
- © Anthropic PBC. All rights reserved. Use is subject to Anthropic's legal agreements: https://code.claude.com/docs/en/legal-and-compliance
- It is bundled into the application's WSL bridge (`resources/bridge/bridge.cjs`) and is **not** MIT-licensed.
- ccPet uses it to resume sessions (fallback path) and to read plan usage limits (an experimental SDK method).

## GSAP
- GSAP 3 (GreenSock) — bundled into the renderer for the hover and state animations. It is **not** MIT-licensed: it is used under the GreenSock Standard "no charge" license (https://gsap.com/standard-license), which allows free use, including commercial. Only the core engine is used (no premium plugins).

## Manrope font
- Manrope (`ui/assets/fonts`, Latin and Cyrillic subsets as served by Google Fonts) — the interface font. Copyright 2018 The Manrope Project Authors (https://github.com/googlefonts/manrope), licensed under the SIL Open Font License 1.1; the licence text is `ui/assets/fonts/Manrope-OFL.txt` and ships next to the font files.

## Build and test tooling (not shipped inside the application)
esbuild, TypeScript, tsx, Vitest and their dependencies, each under its own license (see their packages).

## Third-party pet models you install yourself
Models installed through the model manager (ZIP or an npm pet installer) are not part of ccPet. Each belongs to its author; check its license before sharing it.
The npm package `codex-pets` mentioned in the model manager is a separate third-party project (MIT) and is not affiliated with ccPet.

## Names
"Claude" and "Claude Code" are trademarks of Anthropic. ccPet is an independent, unofficial project and is not affiliated with or endorsed by Anthropic.
