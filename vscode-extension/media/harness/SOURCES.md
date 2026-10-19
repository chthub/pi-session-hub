# Harness icon sources

These bundled marks identify the origin of a session. They do not imply affiliation,
endorsement, or a grant of trademark rights. Third-party artwork is not relicensed
under this project's MIT license; the original owners' terms continue to apply.
All images are local, self-contained SVGs. The sidebar places them in a fixed
16px-wide, 20px-high slot. Images are centered horizontally. Their top edges use
the actual painted title glyphs as the reference, then shift down by 1 CSS pixel
for optical balance with the text body, rather than enforcing exact pixel-top
alignment. The final position is snapped to a device pixel to keep small marks
crisp at fractional display scaling. This correction is separate from font measurement. A temporary inline
baseline marker and a local Canvas text raster determine the visible glyph top
for the current title, font, and display scale. Results are bounded/cached, and
alignment is refreshed on rendering, resizing, group expansion, font loading,
and host font/theme style changes. Translating the artwork does not change row
height or the time-label position. Dense, square Pi and OpenCode
marks render in a 14px image box; open/circular Claude, Codex, and Jcode marks use
16px, as does the wider-than-tall Crush heart. This optical sizing balances perceived size without stretching or changing
the official SVG geometry. The sidebar does not apply reduced opacity to brand
artwork. TUI character badges are unchanged.

## Claude Code — Anthropic

- Source: official `Anthropic.claude-code` VS Code extension, version `2.1.301`,
  `resources/claude-logo.svg`.
- Publisher listing: https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code
- Original SVG and orange `#D97757` are unchanged in both themes (only a final newline is added).
- Source SHA-256: `d4366130584b1027bbc376e3c06a48500d6e862403a69556726d7722610e5561`.
- Copyright Anthropic PBC; all rights reserved. This is not an MIT-licensed asset.
  The package references https://code.claude.com/docs/en/legal-and-compliance.

## Codex — OpenAI

- Source: official `openai.chatgpt` VS Code extension, version `26.51007.21434`,
  `resources/blossom-black.svg` (light) and `resources/blossom-white.svg` (dark).
- Publisher listing: https://marketplace.visualstudio.com/items?itemName=openai.chatgpt
- Versioned VSIX: https://openai.gallery.vsassets.io/_apis/public/gallery/publisher/openai/extension/chatgpt/26.51007.21434/assetbyname/Microsoft.VisualStudio.Services.VSIXPackage?targetPlatform=linux-x64
- These are the OpenAI Blossom marks shipped by the official Codex extension;
  the extension manifest itself selects `blossom-white.svg` for its Codex container.
  No Codex-specific hexagon has been invented. Geometry, viewBox, and colors are unchanged.
- SHA-256: light `8652777b55544c572ba445dd230a90c2e248611e92eaa77de5805e8d0561fc30`;
  dark `c6d12166686ed8c6b5b86f7eb7b5315c0b1b2fc7494e401b67ebb91f6c89dd95`.
- The extension's `LICENSE.md` refers to https://openai.com/policies/row-terms-of-use.
  Brand guidance: https://openai.com/brand/. No MIT or trademark license is claimed.

## OpenCode — Anomaly

- Official repository commit: `afc68054c3b39cbc0d580a92184e00e2b8a97ae9`.
- Light: https://github.com/anomalyco/opencode/blob/afc68054c3b39cbc0d580a92184e00e2b8a97ae9/packages/console/app/src/asset/brand/opencode-logo-light.svg
- Dark: https://github.com/anomalyco/opencode/blob/afc68054c3b39cbc0d580a92184e00e2b8a97ae9/packages/console/app/src/asset/brand/opencode-logo-dark.svg
- Official geometry, colors, and viewBox are unchanged. Only intrinsic size is
  set to 16px and attribution is added.
- MIT license: https://github.com/anomalyco/opencode/blob/afc68054c3b39cbc0d580a92184e00e2b8a97ae9/LICENSE
  Copyright (c) 2025 opencode. The full notice is included in each SVG.

## Crush — Charmbracelet

- Official repository commit: `52c75da8acbcd11dc269ae582f3ed7947ba3cff6`.
- Source: https://github.com/charmbracelet/crush/blob/52c75da8acbcd11dc269ae582f3ed7947ba3cff6/internal/oauth/callback/heartbit.svg
- Official Heartbit artwork used by Crush's OAuth callback page, whose SVG is
  labelled `Crush`. It is not a third-party logo reconstruction.
- Both themes retain the original full-color artwork, geometry, and viewBox.
  Intrinsic size is 16px. `preserveAspectRatio="xMidYMin meet"` removes the top
  letterbox gap in the square image slot without stretching the wider heart;
  attribution is added.
- Copyright 2025–2026 Charmbracelet, Inc.
- FSL-1.1-MIT terms: https://github.com/charmbracelet/crush/blob/52c75da8acbcd11dc269ae582f3ed7947ba3cff6/LICENSE.md
  This is not an immediately effective MIT grant: Permitted Purpose / Competing
  Use restrictions apply; the future MIT grant takes effect on the second
  anniversary of the relevant version. Redistribution must retain copyright and
  a copy of or link to the terms. Trademark use is limited to identifying origin.

## Pi — Earendil

- Official compact badge: https://pi.dev/favicon.svg
- Official brand selection: https://pi.dev/press-kit
- Upstream reference: https://github.com/earendil-works/pi/blob/1402973a9dbe8c627341e04c9744c54953e285ca/README.md
- The repository commit pins the upstream reference, not the website SVG: no
  public source commit was identified for the website asset. Original SVG SHA-256:
  `d266b2c1d2c7bf169ca30d438963b176fba16fea6263b9ac30c8302f34ad7ce7`.
- Original path geometry and `0 0 560 560` viewBox retained. Intrinsic size is 16px;
  the original theme stylesheet is replaced by a fixed foreground in each file
  so the host can select the correct image without embedded media queries.
- Website footer credits Earendil Inc. & Contributors and MIT License. No separate
  icon-specific license statement was found. The website's MIT notice is included
  in each SVG; this does not grant trademark rights.

## Jcode — Jeremy Huang

- Official repository commit: `b10378482dc4903d8c6af1e306c25bf84101e449`.
- Light: https://github.com/1jehuang/jcode/blob/b10378482dc4903d8c6af1e306c25bf84101e449/assets/brand/jcode-mark.svg
- Dark: https://github.com/1jehuang/jcode/blob/b10378482dc4903d8c6af1e306c25bf84101e449/assets/brand/jcode-mark-inverse.svg
- The official mark is a halftone torus, not the former generic diamond badge.
  The original 1,441 circles, viewBox, and official theme colors are retained.
  Only intrinsic size is set to 16px and attribution is added.
- MIT license: https://github.com/1jehuang/jcode/blob/b10378482dc4903d8c6af1e306c25bf84101e449/LICENSE
  Copyright (c) 2025 Jeremy Huang. The full notice is included in each SVG.
