# Gap Analysis: ContextMeM code vs. proposed "Stable Walrus Site Memory" architecture

Date: 2026-05-28
Question: *"has contextMeM met this yet?"* (the attached target-architecture doc)
Method: read actual code, not the README. Evidence cited by file:line.

## Verdict (one line)

**No.** The doc accurately describes the *current* product, but its *target* is a 6-month
enterprise-grade roadmap. Of ~14 structural proposals: **0 fully met, 5 partial, 9 not met.**
The keystone the whole doc hangs off — a signed, content-addressed `SnapshotManifest` — does not exist.

## Scorecard

| # | Proposal | Status | Evidence |
|---|---|---|---|
| 1 | Signed, content-addressed `SnapshotManifest` (digest + signatures) | ❌ | `runs/*/manifest.json` is a mutable run-status doc (status/progress/timings/updatedAt, no digest/signature/proof). No `SnapshotManifest`/`manifestDigest`/`signManifest` symbol anywhere. |
| 2 | Stable `/context/` artifact contract | ⚠️ | Has manifest/resources/styleguide/sitemap.json + more (design-system, brand, tokens, routes). Missing: `proofs.json`, `chunks.ndjson`, `diff/<base>.json`, `install/mcp.json`. |
| 3 | Hardened resolver: checkpoint pin / quorum / aggregator pool / quarantine | ❌ | `walrus/src/resolve.ts` — single `SuiGrpcClient`, single `aggregatorUrl`, no checkpoint. Reads "latest" → non-deterministic over time. |
| 3b | Real hash verification | ✅ | `walrus/src/resources.ts:145-148` sha256 compare vs `blobHash`, throws on mismatch. (But unverifiable = inline `verified:false`, not quarantined.) |
| 4 | Proof-carrying provenance (Sui obj/tx/checkpoint/blob bundled) | ❌ | `walrus/src/history.ts` reads tx digests for the history *view* only; no proof bundle, manifest has no proof tuple. |
| 5 | Durable job system (idempotency / DLQ / typed errors / backoff) | ⚠️ | Cloudflare Queue consumer `worker.ts:418 queue()` + `message.retry()`, `processExtractionJob`, status via `/api/demo/extractions/:jobId`+`/events`. Missing: idempotency keys, DLQ, typed errors, backoff. |
| 6 | Delta / change-aware MemWal writes | ❌ | `memwal/src/index.ts:69-80` writes full `JSON.stringify(snapshot)` every time. No `MemoryWritePlan`/changed-chunk logic. The exact full-corpus anti-pattern the doc warns about. |
| 7 | Tokenized read-only delegate flows | ⚠️ (strong) | `worker.ts` `generateReadToken`/`hashReadToken` (hashed in D1), `revoked_at` enforced, `revokeNamespaceToken`; delegate keys stay server-side. Missing: token scope/expiry, snapshotPin, KMS. |
| 8 | Snapshot-pinned hosted MCP gateway | ❌ | No `snapshotPin`/`pinPolicy` anywhere. Hosted namespace is rolling (latest `versionId`); installs point at rolling ns. |
| 9 | Privacy / retention / redaction | ⚠️ | Secret redaction on import (`redactSecrets`/`redactImportFiles` `worker.ts:2977+`), share `visibility` flag. Missing: retentionClass, expiry, purgeReceipt. |
| 10 | Harbor-ready observability (usage / audit / recall-trace) | ❌ | Zero hits for `usageEvent`/`auditEvent`/`recallTrace`. Only audit-ish log is the webhook deliveries table. |
| 11 | Multi-tenancy (tenantId / quota / pooled isolation) | ❌ | No `tenantId`. Per-account scoping only (`ownerId` ×92) = single-tenant-with-accounts. No quota engine. |
| 12 | Export + verify + purge portability | ⚠️ | Import exists (`importNamespace`) + redaction. No export endpoint (confirmed), no digest-chain verify, no purge/delete-after-export. |
| 13 | `/v1` versioned API + Harbor contracts | ❌ | API is `/api/...` unversioned. (The `/v1/` hits are Walrus's *own* aggregator URL.) |
| 14 | Benchmarks / CI gates / chaos / determinism gate | ❌ | One workflow `bun-check.yml` (typecheck+test), 9 test files. No bench/chaos/release gate. |

### Built beyond the doc's "current state" (credit due)
- Webhook **HMAC signing** + delivery log: `worker.ts:2741 deliverWebhook`, `signWebhookPayload` (SHA-256), `x-contextmem-signature`, `contextmem_webhook_deliveries` table — but `attempts=1` hardcoded (no retry/DLQ).
- Namespace **versioning** (`versionId`) + R2 artifacts addressed by `sha256Hex(namespace)/versionId/path` with per-file `sha256` — a partial CAS, just not a signed canonical manifest.

## Opinion (what's worth doing — YAGNI applied)

The code is at the **wedge** stage, not the platform stage (160 local run folders, tiny git history,
hackathon-grade CI). Most of the doc is over-scoped for now.

**Do (cheap, high-value, correctness/cost):**
1. Signed `SnapshotManifest` + `proofs.json` — the keystone; cheap; it's the entire trust story.
2. Delta MemWal writes — current full-blob write is a real cost/quota liability.
3. Resolver determinism (checkpoint pin) — correctness; today reads drift with chain state.
4. Token scope + expiry + snapshotPin — small add on the already-good token system.

**Skip until real traction:** multi-tenancy, KMS, DLQ/idempotency, Harbor contracts,
chaos/benchmark gates, export/import proof bundles, 100-tenant soak.
