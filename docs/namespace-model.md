# Namespace, visibility, and token model

Operator-facing reference for publishing and protecting hosted ContextMeM namespaces.

## Namespace naming

A namespace is the addressable unit of agent-readable context. Format: `<prefix>:<slug>:<id>` (lowercase, `[a-z0-9._:-]`).

| Prefix | Source | Auto-generated form | Example |
| --- | --- | --- | --- |
| `demo:` | Public hosted demo + `Build context` on `/app` | `demo:<hostname>:<short-id>` | `demo:seal-docs-wal-app:RN9Jhw` |
| `web:` | Imported namespaces from a non-Walrus crawl | `web:<hostname>` | `web:contextmem.pages.dev` |
| `walrus:` | Walrus Sites resolved via Sui | `walrus:<network>:<siteObjectId>` | `walrus:mainnet:0xdf81…` |

You can override the auto-generated slug on hosted builds via the **Namespace · custom (optional)** panel on `/app` (becomes `demo:<your-slug>`).

## Visibility

Each namespace stores a `visibility` flag at import time:

- **`public`** — anyone can read namespace artifacts and call the MCP endpoint without a token. Used by the demo and `/showcase` directory entries.
- **`private`** — reads require a valid `Authorization: Bearer <read-token>` header. The Worker rejects token-less reads with `401`.

Demo extractions are always `public` but `directoryEnabled = false`, so they're reachable via MCP/share-link but not listed in `/showcase`.

## Tokens

Two distinct tokens cover different access patterns:

| Token | Where it's set | What it gates | Lifetime |
| --- | --- | --- | --- |
| **Read token** (`ctxm_*`) | Issued per private namespace via `POST /api/namespaces/:namespace/tokens` | Reading namespace artifacts and calling the MCP endpoint | Until revoked via `DELETE /api/namespaces/:namespace/tokens/:tokenId` |
| **Import token** (env `CONTEXTMEM_NAMESPACE_IMPORT_TOKEN`) | Cloudflare secret on the Worker | Creating/updating/deleting namespaces, minting read tokens | Per Worker deploy |
| **MemWal delegate** (`x-memwal-account-id` + `x-memwal-authorization`) | Per-request header forwarded by the web client | Authorising MemWal recall/remember on behalf of the user | Until rotated in MemWal |

The Worker **never persists** MemWal delegate keys. On the public site they're held in the browser's `localStorage` (under `contextmem.hostedDelegate`) and attached to every API + MCP request as headers.

## Directory entry

A namespace appears on `/showcase` and in `/api/directory` only when both:

- `visibility = "public"`, and
- `directoryEnabled = true` (defaults to `false`; set via the namespace import payload or `PATCH /api/namespaces/:namespace`).

Directory entries carry `displayName`, `description`, `tags[]`, last-snapshot timestamp, and artifact count.

## MCP endpoint URLs

For a namespace `ns = demo:seal-docs-wal-app:RN9Jhw`:

- **Single-namespace** (preferred): `https://<worker-host>/mcp/<encoded-ns>` — namespace baked into the path.
- **Gateway**: `https://<worker-host>/mcp?namespace=<encoded-ns>` — pass namespace per request via query/headers.

Both forms accept JSON-RPC `initialize` + `tools/call` and return SSE or JSON depending on `Accept`. Browsers (no `text/event-stream` accept) get an HTML install snippet page; MCP clients negotiate normally.

## Share links

`POST /api/share-links` creates a `shr_*` link from a namespace import. Share pages live at `https://contextmem.pages.dev/share/<shareId>` and expose the same artifacts read-only, plus an OG card at `/api/share-links/:id/og.svg`. Share links are independent of namespace visibility — sharing a private namespace's run via a share link makes that snapshot public, but does not change the namespace's `visibility`.

## Owner-bound mutations

`POST /api/namespaces/:namespace/artifact-edit` (inline markdown edits from the web UI) authorises in this order:

1. Import token (Bearer) — full admin override.
2. `x-memwal-account-id` matches the namespace's recorded `owner_id` — for namespaces created by an authenticated MemWal user.
3. For `demo:` namespaces, the requesting IP's `demo:<hash>` owner ID matches — so a browser session can keep editing the namespace it just built.

If none match, the edit returns `403`.

## Operator checklist

When promoting a demo namespace to a permanent product surface:

1. Re-import as `private` with a real `owner_id` and `directoryEnabled` of your choice.
2. Mint a long-lived read token: `POST /api/namespaces/:namespace/tokens` with `{ label: "agent-prod" }`.
3. Distribute the MCP URL + read token (snippets in `docs/marketplace-listings.md`).
4. Schedule re-scrapes: `POST /api/schedules` with `{ namespace, target, intervalHours, webhookUrl? }`.
5. Watch `contextmem_alerts` for diff notifications; webhook deliveries are tracked in `contextmem_webhook_deliveries`.
