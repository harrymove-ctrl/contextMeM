# Why contextMeM's extracted output feels worthless — and what to ship instead

Date: 2026-05-27 · Failure case: seal-docs.wal.app demo build

## The honest diagnosis

We shipped a "Design System" panel that surfaces the CSS framework, not the brand. Seal-docs is Docusaurus. Docusaurus ships an Infima-based CSS reset plus a default neutral palette (`--ifm-color-emphasis-*`, `--ifm-background-color`, `--ifm-font-family-base`). Our extractor walked all inline + linked stylesheets, counted token frequencies, and dumped the top hits. Result: 14 "colors" that are literally the Docusaurus default neutral ramp (#fbffea, #e0e2e6, #1c1e21, #d0d7de, #ebedf0). PRIMARY=#fff / SECONDARY=#000 — these aren't picks, they're the highest-frequency values in any reset stylesheet on Earth. Zero Seal brand color survived. Anyone running our extractor on any Docusaurus site will get this exact output ±epsilon.

The "12 typography styles" entry is worse — it's surfacing `var(--ifm-font-family-base)` as a value. An agent can't render a var reference; it needs the resolved string ("Inter", "system-ui", whatever). We're emitting pointers without dereferencing them. Project Wallace, the most mature CSS analyzer in the field, explicitly drops values it can't resolve via ColorJS.io — they chose loud silence over fake signal [Source: https://github.com/projectwallace/css-design-tokens]. We chose the opposite.

The "100% confidence" badge is a lie of self-assessment. Confidence over what? That we successfully read CSS files? Sure. That what we read represents the brand? Demonstrably no. A confidence number is only meaningful when it differentiates good extractions from bad — ours fires 100% on a near-empty result. The Spacing histogram (1rem, 12px, 2rem, 1.25rem, 5rem, 8px, 0.75rem) is a usage frequency table dressed as a scale; a real scale has ratio/relationship (4/8/12/16/24/32 or a 1.25 modular step). Components=0, Motion=0, Assets=favicon-only confirm the surface area we're actually parsing is the page's `<style>` blob — nothing semantic, nothing rendered, no DOM walk.

## What the field actually does

### llms.txt / llms-full.txt

Jeremy Howard / Answer.AI proposed `/llms.txt` in September 2024 as the docs→agent equivalent of `sitemap.xml` [Source: https://llms-txt.io/blog/what-are-llms-txt-files]. Two artifacts:

- **llms.txt** — index. Each page = one sentence + URL. Anthropic's is 8,364 tokens.
- **llms-full.txt** — full content concatenated as markdown. Anthropic's is 481,349 tokens [Source: https://llms-txt.io/blog/what-are-llms-txt-files].

Adoption: Mintlify auto-generates both for every customer [Source: https://www.mintlify.com/blog/simplifying-docs-with-llms-txt]. Fern, Nuxt UI, and 788+ verified sites tracked at llms-text.com/directory ship them. Three competing directories (llms-text.com, llmstxt.site, directory.llmstxt.cloud) prove this is now table stakes for any docs platform [Source: https://llms-txt.io/blog/what-are-llms-txt-files].

Why this matters for contextMeM: for an MCP-served context product, **markdown-with-headings is what the agent actually consumes**. Design tokens are a side dish. We shipped the side dish first.

### CSS analyzers (Project Wallace et al)

Project Wallace's `css-design-tokens` extracts 9 token categories: color, font-size, font-family, line-height, gradient, box-shadow, radius, duration, easing [Source: https://github.com/projectwallace/css-design-tokens]. Output conforms to the W3C Design Tokens Community Group spec, with a `com.projectwallace` extension namespace carrying `css-authored-as`, `usage-count`, and `css-properties` for each token. Stable hash-based IDs let you diff runs.

Key honesty: **Wallace does not resolve var()**. Colors containing CSS variables are ignored — "colors that can't be parsed by ColorJS.io are ignored" [Source: https://github.com/projectwallace/css-design-tokens]. Wallace ships the static-CSS surface and tells you what it can't do. It does not pretend to be a brand extractor. It is the right tool for "show me what's in this CSS file." It is the wrong tool for "what does this brand look like."

### Brand extraction services

**brand.dev** (now context.dev after rebrand) pitches the opposite tradeoff: it renders the page in a real browser and reads **computed styles from the DOM**, then deduplicates via pattern clustering to find canonical tokens [Source: https://www.context.dev/company-styleguide-api]. Quote: "extraction happens after the browser computes styles, so vendor prefixes, cascade overrides, and dynamic classes resolve correctly." It returns resolved values, never var() refs. Categorizes colors as primary/secondary/background/text by frequency-clustering on rendered elements [Source: https://www.context.dev/company-styleguide-api].

**brand.dev's Logo API** prioritizes structured logo data: SVG/PNG/WebP/JPEG variants, background analysis (transparent/dark/light), color extraction from the logo itself, resolution metadata, smart fallbacks [Source: https://brand.dev/logo-api]. **Brandfetch** ships similar [Source: https://brandfetch.com/developers]. **Brandkit.dev** markets itself as "the fastest brand extraction API for developers & AI agents" — same product, same pitch [Source: https://brandkit.dev/].

The pattern across all three competitors: **render the page, sample the rendered output, prioritize logo/OG assets as ground truth for colors**. Nobody serious extracts brand identity from static CSS scanning anymore.

### The Docusaurus-defaults trap

Docs frameworks bundle large opinionated CSS payloads: Infima (Docusaurus), Nextra's theme, Mintlify's chrome, GitBook's reader, VitePress's default theme. The brand-specific CSS a project adds on top is small (often <50 declarations) compared to the framework reset (>500 declarations). A naive frequency-counter on combined CSS will surface the framework every time. Our seal-docs output is the textbook case.

Mitigations the field uses:
1. **Render-then-sample** (context.dev approach) — let the cascade settle, sample what's actually shown.
2. **Logo-first** (brand.dev, Brandfetch) — extract dominant colors from the logo, not the stylesheet.
3. **Differential extraction** — fingerprint the framework's default CSS, subtract it from observed CSS, surface what's left.

We do none of these. We do (raw frequency count of combined inline + linked CSS), which is exactly the case where the framework wins.

Aside: `dembrandt` is a CLI that claims to extract any site's design system in one command and explicitly lists logo, colors, typography, borders [Source: https://github.com/dembrandt/dembrandt] — same render-then-sample pattern. The fact that this is now a one-off CLI tool means we're competing with infrastructure, not novelty.

## What contextMeM should ship next

### Tier 1 — Drop the lie, narrow the surface

- **Kill the "100% confidence" badge.** Replace with a confidence signal that actually means something: requires ≥1 brand-distinct-from-framework signal (logo color sample, brand-specific CSS custom property, OG image dominant color). If we don't have one, the badge says "framework defaults only" — honest, not flattering.
- **Detect docs framework first.** Sniff for `data-theme="docusaurus"`, `<meta name="generator" content="...">`, Infima class prefixes, Mintlify `<mintlify-*>` elements, Nextra/VitePress signatures, GitBook chrome. Maintain a default-tokens fingerprint per framework. **Subtract framework defaults before surfacing the design system.** If only 0 brand tokens remain, say so — surface nothing rather than fake something.
- **Resolve var() before serializing.** Walk `:root` (and `[data-theme]` blocks for theme switching), build a `--token: value` map, substitute on emit. Never ship `var(--ifm-font-family-base)` as a typography value. If we can't resolve, drop it (Wallace's discipline).
- **Stop showing frequency histograms as scales.** A spacing scale is a list of related values with a clear step. If we can detect 4/8/12/16/24/32 or a modular ratio, surface that. Otherwise just list "raw values observed" and label honestly.

### Tier 2 — The real product

- **llms.txt and llms-full.txt as first-class artifacts.** For an MCP-served context product this is the headline deliverable, not a footnote. Generate both on every extraction. llms.txt = title + one-sentence description + URL per page. llms-full.txt = full markdown concatenated. Mintlify, Fern, Nuxt UI already ship these — we'd be one CLI away from parity with the entire docs platform tier [Source: https://buildwithfern.com/learn/docs/ai-features/llms-txt].
- **Per-page heading outline** (TOC tree) — for an agent doing MCP queries against a doc, the heading hierarchy is the index. We have this data already from markdown parsing; we just don't surface it as a queryable structure.
- **Code-block index.** For technical docs, the snippets ARE the content. Index every fenced code block by language + parent heading + page URL. An agent asking "show me Seal's Move example for sealing an object" wants a snippet hit, not a paragraph hit.
- **Brand assets via render-then-sample, with logo priority.** Order: `og:image` > `apple-touch-icon` (180×180) > inline SVG logos in header/nav > favicon. Sample dominant colors from these assets. Use the result to override the brand-color fields. A favicon-only fallback means "we couldn't find a brand identity" and we should say so.

### Tier 3 — Differentiation

What's defensible vs. llms.txt scrapers and brand.dev clones? Three angles:

- **Walrus-native verification.** We're already the only product crawling .wal.app sites. Lean into it: emit content-addressed blob references for every asset (image, code snippet, page) so an agent can verify the context hasn't been swapped between extraction and consumption. brand.dev returns mutable JSON; we can return immutable Walrus blob IDs. This is the moat.
- **Editable namespace-bound context.** llms.txt is read-only by convention. We can offer: write-back from agent → the project's contextMeM namespace, so iterative agent sessions accumulate. Nobody else does this because nobody else has a namespace primitive on storage they control.
- **Per-page agent-readable manifest.** Beyond llms.txt: each page gets a manifest with (frontmatter, heading tree, code blocks, image refs as Walrus blob IDs, outbound links classified as internal/external/wal-app). This is what an agent actually wants for navigation.

## What to delete

Looking at `apps/api/src/worker.ts` (the extractor) based on the failure pattern:

- **Combined inline + linked CSS frequency counting for "design tokens".** This is the root of the framework-defaults garbage. Either replace with render-then-sample, or scope to brand-distinct-from-framework values only.
- **The "100% confidence" emit path.** Whatever code unconditionally writes confidence=1.0 — delete it. Confidence has to come from signal count, not from "extractor ran without errors."
- **PRIMARY=#ffffff, SECONDARY=#000000 emit logic.** Whatever fallback assigns these when there's no brand color found — change to null/empty + "not detected" label. White and black are never brand colors; if you're about to emit them as primary/secondary, you've already lost.
- **var() value passthrough in typography/spacing output.** Resolve or drop. Never serialize a var() ref to the user-facing JSON.
- **Spacing histogram dressed as scale.** Either compute a real scale or label as raw observations.
- **Components=0, Motion=0 zero-value fields.** If we can't extract them, don't render the field. Empty buckets read as "we tried and there's nothing" — usually we never tried.

## Open questions

- Does Walrus content addressing already give us cheap per-asset hashing, or do we need to compute SHA separately? If the former, the verification moat is essentially free to ship.
- Render-then-sample (headless browser) is heavy. For an extractor running in a Cloudflare Worker (`apps/api/`), do we have the budget for browser rendering, or do we offload to a separate service / accept static-CSS limits with much better filtering?
- Framework fingerprint maintenance: who owns updating the Docusaurus/Mintlify/Nextra default-token fingerprints as those frameworks version? Could be community-sourced (PRs against a JSON file).
- llms.txt has no standards body — adoption is purely convention. If a competing standard emerges (MCP-native manifest, schema.org/DocSet), are we locked in to llms.txt or do we emit multiple formats?
