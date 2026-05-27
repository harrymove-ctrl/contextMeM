# ContextMeM Launch Checklist

These are the human-gated steps from `plans/reports/brainstorm-260526-end-user-improvements.md`. Each requires explicit human action — never automated.

## D1 — Reachability

- [ ] Record a 90-second happy-path screen capture covering:
  - Open https://contextmem.pages.dev/
  - Click the sample target on the landing page (demo mode, 1/day quota)
  - Wait for the public extraction to finish
  - Land on `/share/<id>` — show artifacts, AI summary, MCP URL
  - Click "Copy MCP URL"
- [ ] Save as `docs/demo.gif` (target ≤6 MB, 1280×720, ≤30 fps).
- [ ] Add `![Demo](docs/demo.gif)` near the top of `README.md`.
- [ ] Flip repo to public on GitHub:
  - Audit one more time for secrets (`git log -p | grep -i "sk-\\|memwal_\\|delegate"`).
  - Confirm `.env.local`, `.env`, `runs/` are in `.gitignore` (already are).
  - Settings → Danger Zone → Change visibility → Public.

## D5 — Marketplace listings

Submission copy lives in `docs/marketplace-listings.md`. Each platform must be submitted manually under the maintainer's account.

- [ ] **Smithery** — paste the long description + setup JSON from `marketplace-listings.md`. Use the hosted MCP URL `https://contextmem-hosted-namespace-mcp.vega-fi.workers.dev/mcp?namespace=<namespace>`.
- [ ] **Claude Desktop Directory** — submit category "Developer Tools" with the `mcp-remote` install shape.
- [ ] **Cursor MCP Marketplace** — submit category "Docs and Knowledge" with namespace-specific MCP URL + read token instructions.

After each submission, save the listing URL into `docs/marketplace-listings.md` so future updates can be cross-referenced.

## Known SPA limitation — per-share social previews

`/share/:shareId` injects `og:image` and `twitter:image` from JavaScript. Crawlers that execute JS (Slack, Discord, LinkedIn in some cases) will pick them up; crawlers that read initial HTML only (X/Twitter, most generic OG fetchers) will fall back to the static defaults in `apps/web/index.html` → `/og-default.svg`. To get per-share OG cards on X, you need either:

- a Cloudflare Pages Function (`_middleware.ts`) that intercepts `/share/*` and injects per-share `og:image` server-side, or
- prerender share pages to static HTML.

Both are out of scope for the current SPA shell. Track if/when this matters by watching share-link CTR.

## Post-launch monitoring

- Watch `/api/feedback` inserts for first 14 days.
- Track demo-mode quota burn via `contextmem_demo_limits` D1 rows.
- Inspect first 5 share-link visits for any redaction issues.
- Confirm cron `*/30 * * * *` is producing `contextmem_schedule_runs` entries.
