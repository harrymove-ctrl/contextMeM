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
- CLI: `contextmem web`, `contextmem walrus`, `contextmem runs`, `contextmem storage`, `contextmem memwal`, and `contextmem ask`.
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

### MemWal bridge transport

`@contextmem/memwal` wraps the official **`@mysten-incubation/memwal`** SDK. The SDK signs every request with the delegate's Ed25519 key and talks to the relayer at `MEMWAL_API_URL` (default `https://relayer.memwal.ai`; set to `https://relayer.staging.memwal.ai` for staging). The bridge no longer speaks raw JSON-RPC or Bearer auth — the relayer rejects both.

The delta path encodes per-chunk identity (`chunkId`, `routePath`, `heading`, `contentHash`) into the text content itself since the SDK's `remember(text)` takes a single string:

```
[ctxm-chunk] {"chunkId":"…","routePath":"/Pricing","heading":"Plans","contentHash":"…"}

<chunk text>
```

## Walrus-Native Flow

For Walrus Sites, ContextMeM resolves a site object ID, reads dynamic resource fields from Sui, fetches bytes from a Walrus aggregator by blob ID or derived quilt patch ID, verifies hashes, materializes the site locally, then extracts markdown, sitemap, images, brand, styleguide, and AI-queryable artifacts.

## Walrus Storage + Walrus Memory + Tatum

ContextMeM uses three distinct layers so the Walrus integration is real, not decorative:

- **Walrus Storage** holds the *real artifacts*. `contextmem storage push <runDir>` tars a run's `context/` bundle (`manifest.json`, `llms.txt`, markdown chunks, `proofs.json`, screenshots) and uploads it to Walrus via Tatum's `POST /v4/data/storage/upload`. The async job returns a `jobId` + pre-computed `blobId`; we poll until the blob is `CERTIFIED` on the network, then persist the receipt to `runs/<runId>/context/storage.json`.
- **Walrus Memory** (MemWal) holds the *recall-able semantic index only* — never the file bytes. With `--remember`, the certified receipt is written as a small memory note: `target`, `namespace`, `artifactDigest`, `walrusBlobId`, `tatumJobId`, certification status, and `whatChanged`. An agent later `recall`s the pointer and re-fetches the real artifact from Walrus Storage by `blobId`.
- **Tatum** is the gateway for both the storage REST calls above and on-chain reads. Point the `@tatumio/blockchain-mcp` server at the same `TATUM_API_KEY` to give agents RPC/blockchain-data tools alongside ContextMeM's tools.

```sh
# build a run, then store + index its proof bundle
bun run contextmem walrus extract https://fmsprint.wal.app/ --mainnet
bun run contextmem runs artifacts <runId> --readiness
bun run contextmem storage push <runId> --remember --what-changed "Initial certified proof pack"
bun run contextmem storage status <jobId>   # re-poll an upload
```

MCP tools exposed for agents: `upload_proof_to_walrus` (pack → upload → certify → optional remember) and `check_walrus_storage_job`. Suggested combined MCP config:

```json
{
  "mcpServers": {
    "tatumio": {
      "command": "npx",
      "args": ["-y", "@tatumio/blockchain-mcp"],
      "env": { "TATUM_API_KEY": "${TATUM_API_KEY}" }
    },
    "contextmem": {
      "command": "bun",
      "args": ["/path/to/contextMeM/packages/mcp/src/index.ts"],
      "env": {
        "CONTEXTMEM_RUNS_DIR": "/path/to/contextMeM/runs",
        "TATUM_API_KEY": "${TATUM_API_KEY}",
        "MEMWAL_ACCOUNT_ID": "${MEMWAL_ACCOUNT_ID}",
        "MEMWAL_PRIVATE_KEY": "${MEMWAL_PRIVATE_KEY}",
        "MEMWAL_API_URL": "https://relayer.memwal.ai"
      }
    }
  }
}
```

`TATUM_API_KEY` must be a **mainnet** key (`/v4/data/storage/upload` is mainnet-only, 50 MiB max). `contextmem doctor` reports whether it is set.

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
