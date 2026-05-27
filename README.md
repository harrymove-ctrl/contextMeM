# ContextMeM

ContextMeM is a Walrus-native web context engine for agents. It can inspect deployed Walrus Sites from onchain resource metadata, scrape normal websites, package extracted context into static agent-readable artifacts, and optionally remember site snapshots in MemWal.

Live demo: https://contextmem.pages.dev/

## Quickstart

```sh
bun install
bun run contextmem web scrape https://fmsprint.wal.app/
bun run contextmem walrus inspect https://fmsprint.wal.app/
bun run dev
```

Open the web app at `http://localhost:5173` and the API at `http://localhost:8791`.

## 90-Second Demo Path

1. Open https://contextmem.pages.dev/.
2. Use the curated sample or paste one public URL. Anonymous visitors get one custom browser/IP extraction per day.
3. Wait for the public demo extraction to finish, then open the generated `/share/:shareId` page.
4. Show the share page artifacts, AI summary, screenshots/resources when available, and the MCP URL.
5. For the full DEV workflow, import MemWal SDK credentials locally, build a run, ask AI Query, inspect visual diff, publish a hosted MCP namespace, and copy an install snippet.

## Main Surfaces

- Web app: extraction workspace for Web, Walrus Site, or Auto mode with AI Query, run history, artifact previews, MemWal recall/diff, screenshots, and publish readiness.
- API: local JSON endpoints for runs, extraction, artifact files, package generation, AI query, local diffs, and MemWal.
- CLI: `contextmem web`, `contextmem walrus`, `contextmem runs`, `contextmem memwal`, and `contextmem ask`.
- MCP: `bun run mcp:start` exposes the same core tools to agents.
- Hosted Worker/Pages: public demo extraction, feedback capture, opt-in share pages, hosted namespace MCP, scheduled re-scrape alerts, and webhook delivery metadata.

## Runtime And MemWal Auth

The repo is Bun-first and uses Bun workspaces through the root `package.json`. The dashboard unlocks the full app by importing MemWal SDK credentials: a MemWal account ID plus delegate private key. No wallet connect or ContextMeM signature step is required.

Set these in `.env` or your host environment when you need MemWal MCP access or developer credential import:

```sh
MEMWAL_MCP_URL=http://localhost:3005/api/mcp
MEMWAL_AUTHORIZATION=Bearer replace-with-delegate-key
MEMWAL_ACCOUNT_ID=
VITE_CONTEXTMEM_DEV_AUTH=false
```

## Walrus-Native Flow

For Walrus Sites, ContextMeM resolves a site object ID, reads dynamic resource fields from Sui, fetches bytes from a Walrus aggregator by blob ID or derived quilt patch ID, verifies hashes, materializes the site locally, then extracts markdown, sitemap, images, brand, styleguide, and AI-queryable artifacts.

## Product Workflow

The web app now treats each extraction as a reusable local run. You can reopen prior runs, ask structured AI questions over the extracted context, inspect and download `/context/*` artifacts, preview screenshot/component PNGs, compare snapshots, inspect Walrus Site update history from Sui transactions, and copy the exact `site-builder publish` or `site-builder update` command for the generated static package.

## DEV Onboarding

ContextMeM is designed as a wedge for developers who want agent-readable context from real websites and Walrus Sites without hand-curating docs. Publish a hosted namespace, then install it in Claude Desktop, Cursor, Codex, generic MCP JSON, or `mcp-remote` using the snippets shown in the Publish page. Snippets include the namespace, hosted MCP URL, and read token only; delegate keys stay server-side.

Scheduled re-scrape runs can watch a namespace/target, diff it against the prior version, store in-app alerts, and POST signed webhook payloads. Email is intentionally out of scope.

Marketplace docs/assets are prepared for Smithery, Claude Desktop directory, and Cursor MCP marketplace positioning, but submission and repo visibility changes remain manual human approval steps.

Useful local commands:

```sh
bun run contextmem runs list
bun run contextmem runs artifacts <runId> --readiness
bun run contextmem runs diff <runId> [compareToRunId]
bun run contextmem walrus history https://fmsprint.wal.app/ --mainnet
bun run contextmem memwal query <namespace> "What changed?"
```
