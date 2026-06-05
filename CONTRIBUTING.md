# Contributing to ContextMeM

This guide is for adding **new functions / tools** to ContextMeM. It explains the
repo layout, local setup, and the exact end-to-end pattern a feature follows
through every layer. Follow it and your change will be typechecked, tested, and
auto-deployed on merge.

## Repo layout

A Bun workspace monorepo. Logic lives in `packages/`; runnable surfaces in `apps/`.

| Path | What it is |
|---|---|
| `packages/core` | Pure logic + all shared types (`src/types.ts`). Scraping, chunking, snapshots, readiness. No transport, no I/O frameworks. |
| `packages/walrus` | Walrus Site resolution, materialization, proofs, history, and **Tatum storage** (`src/storage.ts`). Node/Bun only. |
| `packages/memwal` | Walrus Memory (MemWal) client. Two transports: `index.ts` (signed relayer) + `sdk.ts`. |
| `packages/mcp` | MCP server — wraps the packages as agent tools (`src/index.ts`). |
| `packages/cli` | `contextmem` CLI — wraps the packages as commands (`src/index.ts`). |
| `apps/api` | Fastify server (`src/index.ts`) + Cloudflare Worker (`src/worker.ts`). |
| `apps/web` | Vite + React frontend → contextmem.pages.dev. |

**Dependency direction:** `core` is the base; `walrus`/`memwal` depend on `core`;
`cli`/`mcp`/`apps` depend on all of them. Never import "up" (e.g. core must not
import walrus).

## Local setup

```sh
bun install
cp .env.example .env.local        # fill in keys; .env.local is gitignored
```

Useful env keys (see `.env.example` for the full list):
- `OPENAI_API_KEY` — AI Query
- `MEMWAL_ACCOUNT_ID` + `MEMWAL_PRIVATE_KEY` — Walrus Memory
- `TATUM_API_KEY` (mainnet) + `TATUM_STORAGE_URL` — Walrus storage REST + chain reads

Run things:

```sh
bun run dev                       # api + web together
bun run contextmem <command>      # the CLI (e.g. contextmem doctor)
bun run mcp:start                 # the MCP server over stdio
bun run check                     # typecheck + test — run before every PR
```

## The pattern: adding a new function

A feature flows **core → (walrus/memwal) → cli + mcp → tests**. You usually
don't touch every layer, but surface anything agent-useful in *both* the CLI and
the MCP server so humans and agents reach it the same way.

Worked example — how the Tatum **Walrus storage** feature was added (use it as a
template):

**1. Type — `packages/core/src/types.ts`**
Add the shared shape. Types live in core so every package can import them.
```ts
export type WalrusStorageReceipt = {
  provider: "tatum";
  jobId: string;
  blobId?: string;
  status: string;
  certified: boolean;
  // …
};
```

**2. Logic — `packages/walrus/src/storage.ts`** (new file)
Implement the function as a plain, testable async function. Keep network calls
isomorphic (`fetch`) where possible; isolate Node-only bits (here, `tar` via
`child_process`) so they never run in the Worker.
```ts
export async function uploadProofBundle(input, config): Promise<WalrusStorageReceipt> { … }
```
Then re-export it from the package barrel — `packages/walrus/src/index.ts`:
```ts
export * from "./storage.js";
```

**3. CLI command — `packages/cli/src/index.ts`**
Add a subcommand under the right `program.command(...)` group. Import the
function, parse options with commander, `print(...)` JSON.
```ts
storage
  .command("push")
  .argument("<runDir>", "ContextMeM run directory")
  .action(async (runDir, options) => { … print(result); });
```

**4. MCP tool — `packages/mcp/src/index.ts`**
Mirror the CLI as an agent tool. Inputs are a Zod schema; return via `text(...)`.
```ts
server.tool(
  "upload_proof_to_walrus",
  { runDir: z.string(), wait: z.boolean().default(true) },
  async ({ runDir, wait }) => { … return text({ receipt }); }
);
```

**5. Worker (only if it runs hosted) — `apps/api/src/worker.ts`**
If the feature needs config in the deployed Worker, add it to `WorkerEnv` and to
both `apps/api/cloudflare/wrangler.jsonc` (real) and `wrangler.example.jsonc`
(placeholders) — vars under `vars`, secrets under `secrets.required`.

**6. Tests**
Co-locate a `*.test.ts` next to the code (Vitest). Pure functions get unit
tests; prefer testing the logic layer over the CLI/MCP wrappers.

**7. Docs + env**
Add new env keys to `.env.example` (placeholders only — never real keys) and a
note in `README.md` if it's a user-facing surface.

## Conventions

- **Style:** match the surrounding file — naming, comment density, idiom. TypeScript, ESM, `node:`-prefixed builtins.
- **Branches:** `<type>/<short-slug>` — e.g. `feat/storage-resume`, `fix/poll-timeout`. No usernames, no ticket IDs in the branch name.
- **Commits / PRs:** no AI attribution (no "Generated with…", no `Co-Authored-By: Claude`).
- **Secrets:** never commit real keys. `.env.local` and `.env.*` are gitignored (except `.env.example`). Worker secrets go via `wrangler secret put` or GitHub repo secrets.
- **Before pushing:** `bun run check` must pass (typecheck + 51+ tests).

## CI & deploy

- **On every PR** to `main`/`staging`: `.github/workflows/bun-check.yml` runs `bun install`, `bun run check`, and `bun run build`. Your PR must be green.
- **On merge to `main`**: `.github/workflows/deploy.yml` deploys both surfaces — the Worker (`wrangler deploy`, with `TATUM_API_KEY` pushed as a secret) and the Pages frontend (`wrangler pages deploy … --project-name=contextmem` → contextmem.pages.dev).

So the contributor loop is: **branch → code (core→cli/mcp→tests) → `bun run check` → PR → green CI → merge → auto-deploy.**
