# ContextMeM seed data (real, grounded)

Real context data crawled from the live Sui / Walrus / Seal sites and used to seed
Walrus Memory + the Namespaces / Facts views. **Nothing here is mocked** — every
`facts.*.json` quote is a verbatim substring of fetched page content (adversarially
verified), and every memory line is grounded in the same fetched text.

Owner account: `0x8a1121b8f95d79e68bd07efaf71689ce6fd832b369cdb1b2a943ec7beb822392`

## Sources (real, reachable origins)

| Namespace | Target shown in app | Crawled from (reachable) |
|---|---|---|
| `demo:sui-docs` | https://docs.sui.io | docs.sui.io/concepts (+ object-model, sui-move-concepts, transactions, tokenomics, cryptography) |
| `demo:walrus-docs` | https://docs.wal.app | walrus.xyz + github.com/MystenLabs/walrus (docs.wal.app blocks bots → same content, reachable origin) |
| `demo:seal-docs` | https://seal-docs.wal.app | github.com/MystenLabs/seal (README, Design, UsingSeal) |

## Files

- `namespaces.json` — the hosted-namespace registry list (HostedNamespaceSummary shape:
  namespace, target, displayName, description, visibility, tags, sources, versionId,
  artifactCount, byteLength, mcpUrl, ownerId, createdAt/updatedAt). Feeds the
  **Namespaces** manager + **Runs** list.
- `facts.<slug>.json` — a full `SiteFacts` object (schemaVersion 2) per site:
  identity, entities, claims, stats, topics, relationships, questions, coverage.
  Every `sources[].quote` is grounded. Feeds the **Facts** view / future viz.
- `memories.<slug>.json` — the 12 standalone facts pushed to Walrus Memory per namespace.

## Grounding (adversarially verified)

| Namespace | Quotes checked | Passed | Entities / Claims / Stats / Topics / Rels / Qs |
|---|---|---|---|
| demo:sui-docs | 52 | 52 | 11 / 10 / 6 / 6 / 12 / 9 |
| demo:walrus-docs | 66 | 66 | 12 / 10 / 7 / 5 / 12 / 9 |
| demo:seal-docs | 67 | 66 (1 ungrounded quote pruned) | 11 / 10 / 5 / 5 / 11 / 9 |

## Already live in Walrus Memory

All 36 memories (12 × 3) were pushed to Walrus Memory under their namespaces via
`memwal_remember` and confirmed recallable via `memwal_recall`. Re-seed/verify with:

```
# recall any namespace
memwal_recall(namespace="demo:walrus-docs", query="storage cost and erasure coding")
```

To rebuild the search index from the stored blobs:

```
memwal_restore(namespace="demo:sui-docs")
```
