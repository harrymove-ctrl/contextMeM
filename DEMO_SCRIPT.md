# ContextMeM — Demo Video Script (Tatum x Walrus Hackathon)

*Two ready-to-record cuts: 75s Judge Cut + 2.5min Full Walkthrough. One source of truth.*

---

## 1. PRODUCTION NOTES

**Tools**
- Screen recorder: capture at **1440p (2560×1440)**, 60fps, hide bookmarks bar, full-screen browser, cursor highlight ON.
- Mic: record VO on a separate track (record silent screen first, lay VO over it). Aim for a calm, confident pace — both cuts are tight.
- Editor: add lower-thirds + box-callouts in post (see sections 4–5). Use the green brand accent **#a8d946** for all overlays/badges.

**Pre-open these exact tabs (in this order) so navigation is instant:**
1. `https://contextmem.pages.dev` (Home / landing)
2. `https://contextmem.pages.dev/app/memory` (opens on **Sui Docs** chip by default)
3. `https://contextmem.pages.dev/app/namespaces`
4. `https://contextmem.pages.dev/app/build`
5. `https://contextmem.pages.dev/app/memory?ns=demo:walrus-docs` ← **the money shot (Walrus storage proof panel)**

Pre-load each tab once before recording so the force graph / proof panel is already rendered (no spinner on camera).

**Real proof values — keep on a sticky note, read them EXACTLY (this is the whole demo):**
| Field | Value |
|---|---|
| Blob ID | `PriRx-_a55xDCh63kBg_RkwwRf3dKMk62JkTpkYu4aU` |
| Tatum job ID | `6a23e05fde51712efd6c5c92` |
| Artifact digest | `sha256:c4f0eab4e7ba0073c83b19ad8b0402008710feaab358b85a792b69ab6680bcb7` |
| Bundle size | `11.6 KB` |
| Status | `CERTIFIED` (green badge) |
| Tatum endpoint | `api.tatum.io/v4/data/storage/upload` |
| Walrus card counts | Walrus Docs: **12 entities · 12 edges · 85% confidence** |
| Sui card counts | Sui Docs: **11 entities · 12 relationships · 82% confidence** |

> Pronounce the blob ID as **"Pri-R-x"** then say "the full hash is on screen." Don't read all 44 chars aloud — let the box-callout do the work.

---

## 2. THE 75s JUDGE CUT — Shot Table

**Logline:** *AI agents forget between runs — ContextMeM gives them a verifiable knowledge graph plus a real, onchain-certified Walrus storage proof pushed through Tatum.*

| Time | On screen / action | Voiceover |
|---|---|---|
| **0:00–0:08** | Open `contextmem.pages.dev` (Home). Show top nav once: Home · Build · Artifacts · Runs · Memory · Namespaces · Settings. Cursor rests on the **ContextMeM** wordmark. Subtle zoom into logo on green backdrop. *LT: "Walrus-native context engine."* | "AI agents forget everything between runs. ContextMeM gives them permanent, verifiable memory — stored on Walrus, the decentralized storage network, through Tatum." |
| **0:08–0:20** | Click **Memory** (Brain icon) → `/app/memory`. Header: "Browse Knowledge + Memory." Default chip = **Sui Docs**. Slowly scroll to reveal the SVG force graph and the "Sui" identity hero. Arrows on nodes. *Chip overlay: "11 entities · 12 relationships · 82% confidence."* | "Here's the Memory explorer. Pick a namespace and it renders a verified knowledge graph — entities, relationships, and an identity card. This is the Sui docs: eleven entities, twelve relationships, eighty-two percent confidence." |
| **0:20–0:32** | At the top is **"Chat with this namespace."** Click preset **"What are the key facts, numbers, and costs?"** — a real answer renders in a chat bubble with a source line (*Verified facts · openai-compatible · 90%*). Click a second preset to show a visibly **different** grounded answer. | "And you can chat with it like a real assistant. I ask a question and ContextMeM answers from the verified knowledge graph — real AI synthesis grounded in stored facts, with the source and a confidence score on every reply. Each question gets its own distinct answer, not a canned dump." |
| **0:32–0:42** | Click **Namespaces** → `/app/namespaces`. **Thirteen** verified namespaces — Walrus, Sui, Seal, Tatum, SuiNS, DeepBook, Mysten Labs, Walrus Sites, Move, plus real Web2 sites (Stripe, Vercel, Anthropic, Linear). Hover the green **"✓ Walrus"** badge on the Walrus card (tooltip shows blob id). Pulse/glow ring on the badge. | "Thirteen verified namespaces — the whole Sui and Walrus ecosystem, plus real Web2 sites like Stripe and Vercel, all recallable. Notice the Walrus card carries a green certified badge. That's the part the judges should care about." |
| **0:42–1:06** ⭐ **PEAK** | Click the **Walrus Documentation** card → `/app/memory?ns=demo:walrus-docs`. The **Walrus storage proof** panel renders at top: ShieldCheck + green **CERTIFIED** badge; blob ID `PriRx-_a55xDCh63kBg_RkwwRf3dKMk62JkTpkYu4aU`; Tatum job `6a23e05fde51712efd6c5c92`; digest `sha256:c4f0eab4…`; size 11.6 KB; certified timestamp. **Hold on the blob ID.** Zoom + box-callout CERTIFIED → then blobId. *Overlay: "Tatum → Walrus mainnet · api.tatum.io/v4/data/storage/upload."* | "Click it. ContextMeM packaged this Walrus context bundle, pushed it to Walrus mainnet through the Tatum gateway — and it came back certified onchain. This is real. The blob ID, Pri-R-x, is right here, status certified, eleven-point-six kilobytes, with the full SHA-256 artifact digest and the Tatum job ID. Not a mock. A live storage proof." |
| **1:06–1:15** | Same page. Scroll past the "Walrus" identity hero (85% confidence) down to the FactsGraph — **12 entities · 12 edges**. End on the ContextMeM closing card. *Callout: "12 entities · 12 edges."* | "Same page, the Walrus knowledge graph — twelve entities, twelve edges. Verifiable memory, plus an onchain proof. That's ContextMeM." |

**Closing card:** ContextMeM — verifiable memory for AI agents. Stored on Walrus · Certified via Tatum. `blobId PriRx-_a55xDCh63kBg_RkwwRf3dKMk62JkTpkYu4aU · CERTIFIED` · contextmem.pages.dev

---

## 3. THE 2.5min FULL WALKTHROUGH — Shot Table

**Logline:** *AI agents can't read verifiable onchain context — ContextMeM turns docs into a knowledge graph an agent can recall, then proves provenance with a real, CERTIFIED Tatum-to-Walrus mainnet transaction.*

| Time | On screen / action | Voiceover |
|---|---|---|
| **0:00–0:11** | Title card, green backdrop (#a8d946). Overlay: **"Your AI agent can't read this."** Beneath: faded screenshot of a Walrus Site / onchain docs page. Slow zoom; cursor hovers but nothing is parseable. | "AI agents are great at reasoning, but they're blind to verifiable onchain context. Point one at a Walrus Site and it just sees bytes it can't trust." |
| **0:11–0:22** | Browser at `contextmem.pages.dev` (Home). Show top nav: Home · Build · Artifacts · Runs · Memory · Namespaces · Settings. Cursor glides across the nav to preview the tour. | "ContextMeM fixes that. It's a Walrus-native context engine: it turns documentation into a verified knowledge graph an agent can actually recall — and proves where every byte came from." |
| **0:22–0:35** | Click **Build** → `/app/build`. Show the build screen where a source/namespace becomes a context bundle. *Callout: "docs in → context bundle out."* | "It starts with Build. You point ContextMeM at a docs source — say the Walrus docs — and it extracts entities, relationships, claims and facts into a structured context bundle." |
| **0:35–0:51** | Go to `/app/memory` (opens on **Sui Docs**). Click the **Walrus Docs** chip (`demo:walrus-docs`). Knowledge view renders. Scroll to force graph, hover one node — its edges highlight. *Callout: "12 entities · 12 relationships."* | "Here's the result on the Memory page. I'll pick the Walrus namespace, and ContextMeM renders a live force graph — twelve entities, twelve relationships. Hover a node and you see exactly how the concepts connect." |
| **0:51–1:05** | Scroll up to the identity hero (FactsPanel): H2 **"Walrus"**, one-liner "Decentralized verifiable blob storage built on Sui, with RedStuff erasure coding.", chips, **85% confidence** metric. Highlight the 85% + audience chips. | "Above the graph is an identity card: what Walrus is, who it's for, and a confidence score — eighty-five percent here — so the agent knows how much to trust each fact." |
| **1:05–1:21** | At the top of the Memory page: **"Chat with this namespace."** Type a question or click preset **"How does it work technically?"** and hit **Send**. A grounded answer renders in a chat bubble with key-points and a source line. Ask a follow-up to show it's **multi-turn** (the thread remembers context). | "Now chat. I ask a question in plain English and ContextMeM answers straight from the verified knowledge graph — real AI synthesis, and it labels the source and confidence on every reply so you know it's grounded in stored facts, not hallucinated. It's multi-turn, so I can ask follow-ups." |
| **1:21–1:35** | Click **Namespaces** → `/app/namespaces`. **Thirteen** cards — "Walrus Documentation" (green **✓ Walrus** badge), "Sui Documentation", "Seal", "Tatum", "SuiNS", "DeepBook", "Mysten Labs", "Walrus Sites", "Move", plus Web2: "Stripe", "Vercel", "Anthropic", "Linear" — each with entity/link/topic/Q&A counts. Zoom the Walrus badge; tooltip reveals blob id. | "Everything lives in clean namespaces — thirteen of them, spanning the Sui and Walrus ecosystem and real Web2 sites — each with counts at a glance. Notice the Walrus card carries a green certified badge. That's the part that makes this a hackathon centerpiece." |
| **1:35–1:49** | Architecture slide (b-roll): three labeled layers — **Walrus STORAGE** (the bytes, via Tatum) · **Walrus MEMORY / MemWal** (semantic recall) · **Tatum** (the gateway). Animate flow: bundle → Tatum → Walrus Storage → Walrus Memory. | "Under the hood there are three layers: Walrus Storage holds the actual proof bytes, Walrus Memory indexes them for recall, and Tatum is the gateway that ships them onchain. Storage is the bytes; Memory is where they are and what changed." |
| **1:49–2:04** | Terminal. Type & run: `contextmem storage push <runDir>`. Output lines: tarring `context/`, uploading to Walrus via Tatum (`POST api.tatum.io/v4/data/storage/upload`), polling… → **CERTIFIED**, then the written receipt. Highlight the endpoint and the CERTIFIED line. | "And it's real. One CLI command — contextmem storage push — tars the run's context, uploads it to Walrus mainnet through Tatum's REST gateway, and polls until it's certified onchain." |
| **2:04–2:30** ⭐ **PEAK** | Back in the app on the Walrus Docs view, scroll to the top **Walrus storage proof** panel (WalrusProofPanel): green **CERTIFIED** badge; "stored and certified onchain on Walrus mainnet via Tatum"; blob ID `PriRx-_a55xDCh63kBg_RkwwRf3dKMk62JkTpkYu4aU`; Tatum job `6a23e05fde51712efd6c5c92`; digest `sha256:c4f0eab4e7ba0073c83b19ad8b0402008710feaab358b85a792b69ab6680bcb7`; size 11.6 KB; certified timestamp. Sequential callouts: blobId → Tatum jobId → full digest; **freeze on the green CERTIFIED badge.** | "That same receipt shows right in the app. This Walrus context bundle — eleven-point-six kilobytes — is certified onchain on Walrus mainnet. Real Walrus blob ID, real Tatum job ID, and a SHA-256 digest you can verify byte for byte. This is provenance you can check, not a claim you have to believe." |
| **2:30–2:35** | Closing card on green backdrop, logo + `https://contextmem.pages.dev`. Fade up logo + tagline. | "ContextMeM: verifiable, recallable context for AI agents — proven onchain with Walrus and Tatum." |

**Closing card:** ContextMeM — a Walrus-native context engine for AI agents. Verified knowledge graphs + recall, with provenance certified onchain via Tatum → Walrus mainnet. Live at `https://contextmem.pages.dev` · Built for the Tatum x Walrus hackathon.

---

## 4. KEY LINES TO NAIL

These 4–5 sentences sell the Tatum x Walrus integration — land them clean, don't rush them:

1. **"It's a Walrus-native context engine: it turns documentation into a verified knowledge graph an agent can actually recall — and proves where every byte came from."**
2. **"ContextMeM packaged this Walrus context bundle, pushed it to Walrus mainnet through the Tatum gateway — and it came back certified onchain. This is real, not a mock."**
3. **"One CLI command — `contextmem storage push` — tars the run's context, uploads it to Walrus mainnet through Tatum's REST gateway, and polls until it's certified onchain."**
4. **"Real Walrus blob ID, real Tatum job ID, and a SHA-256 digest you can verify byte for byte — this is provenance you can check, not a claim you have to believe."**
5. **"Storage is the bytes, Memory is where they are and what changed, and Tatum is the gateway that ships them onchain."**

---

## 5. LOWER-THIRDS / ON-SCREEN TEXT

Pin these as overlays at the cued moments (green #a8d946 accent throughout):

- **0:00–0:08 (both):** `Walrus-native context engine`
- **Title card (Full only):** `Your AI agent can't read this.`
- **Memory / Sui graph:** `11 entities · 12 relationships · 82% confidence`
- **Memory / Walrus graph:** `12 entities · 12 relationships · 85% confidence`
- **Build screen:** `docs in → context bundle out`
- **Chat answer source line (highlight on screen):** `Verified facts · openai-compatible · 90%` (each reply carries source · provider · confidence)
- **Namespaces badge hover:** `✓ Walrus — CERTIFIED` (badge glow ring)
- **Architecture slide:** `Walrus STORAGE (bytes, via Tatum) · Walrus MEMORY (recall) · Tatum (gateway)`
- **Terminal:** `POST api.tatum.io/v4/data/storage/upload  →  CERTIFIED`
- **PEAK proof panel — sequential box-callouts:**
  - `blobId: PriRx-_a55xDCh63kBg_RkwwRf3dKMk62JkTpkYu4aU`
  - `Tatum job: 6a23e05fde51712efd6c5c92`
  - `sha256:c4f0eab4e7ba0073c83b19ad8b0402008710feaab358b85a792b69ab6680bcb7`
  - `11.6 KB · CERTIFIED on Walrus mainnet via Tatum` ← hold/freeze
- **Both closing cards:** `Stored on Walrus · Certified via Tatum · contextmem.pages.dev`