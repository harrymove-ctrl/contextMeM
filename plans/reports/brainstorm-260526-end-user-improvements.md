# Brainstorm — End-User Improvements for ContextMeM

**Date:** 2026-05-26
**Scope:** Open-ended (1–3 months). Personas: AI app devs (DEV), Walrus Site owners (OWNER), non-technical operators (OP).
**Improvement buckets requested:** all four — polish, missing capability, friction, growth.
**User feedback collected so far:** none (hunches only).

---

## Brutal-honesty preamble

1. **You have no real users.** With 3 personas, 4 buckets, and no feedback, ranking is guessing. The cheapest highest-value next move is **shipping a feedback loop**, not features. Until you have 5–10 real users, "what to improve" is fiction.
2. **Three personas conflict.** DEV wants MCP/CLI/API ergonomics. OWNER wants change-tracking + publish. OP wants a no-CLI web UI with chat. Build for all three → win none. **Pick a wedge.** My pick: **DEV** — fastest to delight, smallest delta to value, MCP-native distribution, and DEVs *bring* OWNER + OP downstream.
3. **The product is wider than its narrative.** 8 web routes, 20+ API endpoints, 20+ CLI commands, 23 MCP tools — every README claim is implemented. The problem is *cohesion*, not coverage. `main.tsx` at 3,817 lines is a UX symptom: sprawling SPA → sprawling story. The right "polish" answer is *scope reduction* — kill or hide surfaces, don't improve all 8.
4. **Repo is private and there is no live demo URL.** Discovery floor is zero. Any growth idea is blocked until that flips.

---

## Inventory snapshot (so suggestions are grounded)

- **Web:** `/`, `/app`, `/app/artifacts`, `/app/runs`, `/app/memory`, `/app/publish`, `/app/namespaces`, `/app/settings`
- **API:** runs, artifacts, publish-readiness, hosted namespaces + tokens + directory, Cloudflare-queued extractions, Walrus history, snapshot diff, AI query, MemWal remember/recall/query, extension auth-token
- **CLI:** `web scrape/crawl/sitemap/brand/styleguide/design-system`, `walrus inspect/extract/preview/package/history/ask`, `memwal remember/recall/query`, `runs list/artifacts/diff/package-web`
- **MCP (local + hosted):** ~23 tools — scrape, crawl, brand/styleguide/design-system extraction, Walrus inspect/extract/build, ai_query, memory remember/recall/query, diff, history, hosted namespace info/list/read/search/recall/bundle
- **Auth model:** local SQLite + session token; MemWal delegate key import via web settings or `.env.local`; per-namespace read tokens; no wallet connect

---

## Ideas — categorized × persona × effort

Legend — **E** = effort (L/M/H), **P** = primary persona, **🔥** = my pick.

### A. POLISH the existing flow

| ID | Idea | P | E | Notes |
|---|---|---|---|---|
| A1 | Collapse 7 inner routes → ONE run-detail page with sticky tabs (Artifacts / Memory / Publish / History). Story = "one run, one place." | OP, OWNER | M | Tackles sprawl. Risk: rewriting too much; ship behind a feature flag. |
| A2 🔥 | Visual snapshot diff: side-by-side screenshots with bounding boxes + red/green markdown diff + "new page" badges. Current diff is probably JSON. | OWNER | M | Without this, MemWal value prop is invisible. Highest single ROI for OWNER. |
| A3 🔥 | AI Query as a chat box on every run with suggested prompts ("What pricing?", "What's their brand voice?"). Same backend, lower cognitive load. | OP, DEV | L | Biggest perceived-quality jump per hour spent. |
| A4 🔥 | SSE/WebSocket progress streaming during extraction ("Scraping /pricing… Captured screenshot… Extracting tokens…"). | OP, judges | L–M | Reduces perceived wait, demos beautifully. |
| A5 | Consistent error envelope + a "Why did this fail?" panel mapping known failures (Walrus aggregator down, MemWal 401, OpenAI rate limit) to user fixes. | all | L | High polish-per-line. |

### B. FILL MISSING CAPABILITIES

| ID | Idea | P | E | Notes |
|---|---|---|---|---|
| B1 🔥 | Scheduled re-scrape + "what changed" alerts (cron + diff + email/webhook). Diff infra ≈ 30% built. | OWNER, DEV | M | Strategic differentiator. Reason to come back weekly. |
| B2 | Embeddable "powered by ContextMeM" badge linking to public read endpoint of a hosted namespace. | DEV, OWNER | L | Cheap virality. |
| B3 | Multi-target compare (my-site vs competitor-site brand/design/pricing). Extraction layer already supports both. | OP | M | Killer competitive-intel use case. |
| B4 | Browser extension. `/api/ext/auth-token` already wired. Either finish or rip — half-built scaffolding confuses. | OP, DEV | H | **YAGNI candidate** — drop unless committed. |
| B5 🔥 | "Install in Claude/Cursor" one-click MCP snippets per namespace, with token pre-filled. | DEV | L | Highest-leverage DEV on-ramp. The MCP exists; activation is the gap. |

### C. REDUCE SETUP FRICTION

| ID | Idea | P | E | Notes |
|---|---|---|---|---|
| C1 | "Generate secret" button — kill the 32-byte hand-rolled `CONTEXTMEM_ACCOUNT_SECRET`. | all | L | Trivial. Removes a first-run cliff. |
| C2 🔥 | **Demo mode** — try without credentials on a rate-limited hosted worker. Single public extraction. | judges, OP, prospective DEV | M | **Critical** for landing-page conversion. Closes the "what do I do here?" door. |
| C3 | Deep-link MemWal create-delegate flow with return URL → autopaste back into `/app/settings`. | all | L–M | Needs MemWal cooperation. |
| C4 | Pick one env-var name (drop `MEMWAL_AUTHORIZATION` vs `MEMWAL_BEARER` ambiguity). Add `contextmem doctor` checking env + network + MemWal + Walrus reachability. | DEV, OWNER | L | DX win. |
| C5 | Remove `VITE_CONTEXTMEM_DEV_AUTH` as a viable default. Explicit opt-in + banner. | all + security | trivial | **Do this before going public.** |

### D. GROW REACH / VIRALITY

| ID | Idea | P | E | Notes |
|---|---|---|---|---|
| D1 🔥 | **Flip repo public + 90-second happy-path gif in README + live demo URL.** | DEV, judges | trivial | Prerequisite for every other growth idea. |
| D2 | `/showcase` page from `/api/hosted/directory` — thumbnails + last-snapshot timestamps. | all | L | Social proof + SEO with existing infra. |
| D3 🔥 | **Shareable per-run public pages** — read-only URL with brand tokens, screenshots, AI summary, watermark. Replaces "download artifact." | all | M | Highest viral coefficient. People share runs in Slack/Discord. |
| D4 | OG image per run (site screenshot + brand colors + watermark) for sharing on X/LinkedIn. | growth | L | Compounds D3. |
| D5 | List the hosted MCP on Smithery / Claude Desktop directory / Cursor MCP marketplace. | DEV | L | Where DEVs actually discover tools. |

---

## Recommended top 3 (1–3 month horizon)

If I were you, I'd ship these in order — each one unlocks the next.

### 1. Reachability + feedback loop *(weeks 1–2)*
**C2 + C5 + D1 + D3** — demo mode, lock down dev-auth, public repo + live URL, shareable run pages.
**Why:** you cannot prioritize improvements without users, and you cannot get users without distribution. Everything else is wasted motion until this exists.
**Success:** ≥10 external sessions, ≥3 written feedback items inside 2 weeks.

### 2. Perceived-quality leap *(weeks 3–6)*
**A3 + A4 + A2** — chat-style AI Query, streaming progress, visual snapshot diff.
**Why:** these are the three moments where users decide "this is good." Same backend, dramatically different feel. Highest ROI per engineering hour.
**Success:** demo-able in 90 seconds without narration; 1 of 3 visitors completes a full run.

### 3. Wedge-persona lock-in *(weeks 7–12)*
**B5 + B1 + D5** — one-click MCP install, scheduled re-scrape alerts, MCP marketplace listings.
**Why:** locks in DEV persona (your wedge) and gives OWNER persona a weekly reason to return. Distribution + retention in the same push.
**Success:** ≥20 installs from marketplace; ≥30% week-2 retention on accounts with ≥1 scheduled scrape.

Everything else (A1, A5, B2, B3, B4, C1, C3, C4, D2, D4) is **deferred** — pull from this list only when real user feedback says to.

---

## Explicit non-recommendations (YAGNI)

- **Browser extension (B4)** — drop scaffolding unless someone asks for it.
- **Multi-target compare (B3)** — defer until OP persona is validated. May not exist as a real persona.
- **Refactoring `main.tsx`** — internal smell, not an end-user improvement. The right "fix" is A1 (scope reduction), not a refactor.
- **Wallet-connect / signature flows** — explicitly avoided in README; keep it that way. Friction wins nothing here.

---

## Open risks / unknowns

1. **MemWal cooperation for C3** — deep-link UX depends on their flow. Verify before committing.
2. **Cloudflare quota for C2 demo mode** — rate-limit aggressively, cache hard.
3. **D3 shareable pages = data exposure** — must default to opt-in; auto-redact env-like strings from extracted content.
4. **Persona decision is unconfirmed.** My recommendation is DEV-first, but you may know something I don't. If the answer is "OWNER," shuffle order: B1 + A2 first, then C2 + D3.

---

## Validation criteria (how you'll know it worked)

- **Reachability:** weekly active accounts > 0 (currently 0).
- **Activation:** ≥50% of new accounts complete one full extraction within first session.
- **Retention:** ≥30% week-2 return rate on accounts that set up a scheduled scrape.
- **Distribution:** ≥3 inbound channels (search, marketplace, shared run link) producing signups by month 3.
- **Quality signal:** ≥5 unsolicited pieces of user feedback (any sentiment) by week 4.

---

## Next steps

1. **Decide the wedge persona** (DEV / OWNER / OP). Single answer, no compromise. Everything below depends on this.
2. **Confirm or reject the Top 3 ordering.** Push back where you disagree.
3. Once aligned, I can hand off Top-3 items to `/plan:parallel` or `/cook` for execution. This report does *not* implement — it's the brief.
