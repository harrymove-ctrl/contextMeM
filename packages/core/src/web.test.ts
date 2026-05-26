import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDesignSystemFromPages, renderTokensCss } from "./design-system.js";
import { extractImages } from "./html.js";
import { aiQueryWebsite, buildStyleguideFromTexts, crawlWebSite, imageAssetsFromResourcePaths } from "./web.js";
import type { BrandProfile, PageArtifact } from "./types.js";

const savedOpenAiKey = process.env.OPENAI_API_KEY;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  if (savedOpenAiKey) process.env.OPENAI_API_KEY = savedOpenAiKey;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("AI query extraction", () => {
  it("detects boolean datapoints from meaningful schema keywords", async () => {
    const result = await aiQueryWebsite(
      "https://seal-docs.wal.app/",
      [{ name: "mentions_walrus", description: "Whether the context mentions Walrus", type: "boolean" }],
      [page("Seal stores encrypted data on Walrus and uses Sui for access control.")]
    );

    expect(result.data.mentions_walrus).toBe(true);
    expect(result.usedProvider).toBe("heuristic");
  });

  it("summarizes from relevant page sentences instead of markdown link fragments", async () => {
    const result = await aiQueryWebsite(
      "https://seal-docs.wal.app/",
      [
        {
          name: "answer",
          description: "Summarize product facts, target users, and developer APIs from this site.",
          type: "text"
        },
        {
          name: "keyFacts",
          description: "Important facts with source support",
          type: "list"
        }
      ],
      [
        page(`Seal Overview Video

info

## Features[](#features "Direct link to Features")

Seal is a decentralized secrets management service for application developers who need to secure sensitive data at rest.
Seal uses Sui access-control policies and Walrus storage so apps can encrypt data client-side and gate decryption keys.
Developers integrate Seal with TypeScript SDKs, Move examples, and key-server APIs.`)
      ]
    );

    expect(result.data.answer).toContain("decentralized secrets management");
    expect(result.data.answer).not.toContain("Direct link");
    expect(result.data.keyFacts).toEqual(expect.arrayContaining([expect.stringContaining("Developers integrate Seal")]));
    expect(result.sources[0]?.quote).toContain("Walrus storage");
    expect(result.sources[0]?.quote).not.toContain("Direct link");
  });
});

describe("web crawling", () => {
  it("uses sitemap seeds, strips hash/query duplicates, stays in scope, and returns deterministic routes", async () => {
    const fetched: string[] = [];
    let discovery:
      | {
          totalCandidates: number;
          pagesEmitted: number;
          fetchErrors: number;
        }
      | undefined;

    globalThis.fetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = new URL(String(input));
      fetched.push(url.toString());
      const bodyByPath: Record<string, string> = {
        "/": '<!doctype html><title>Home</title><main>Home</main><a href="/z?utm=1#top">Z</a><a href="/a">A</a><a href="https://outside.test/nope">Out</a>',
        "/a": "<!doctype html><title>A</title><main>A page</main>",
        "/hidden": "<!doctype html><title>Hidden</title><main>Hidden page</main>",
        "/z": '<!doctype html><title>Z</title><main>Z page</main><a href="/a#again">A again</a>'
      };
      const response = new Response(bodyByPath[url.pathname] ?? "<!doctype html><title>Missing</title><main>Missing</main>", {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" }
      });
      Object.defineProperty(response, "url", { value: url.toString() });
      return response;
    }) as typeof fetch;

    const pages = await crawlWebSite("https://example.com/", {
      maxPages: 10,
      maxDepth: 1,
      concurrency: 2,
      includeLinks: true,
      seedUrls: ["https://example.com/hidden?ref=1#section", "https://outside.test/seed"],
      onDiscovery: (stats) => {
        discovery = stats;
      }
    });

    expect(pages.map((page) => page.routePath)).toEqual(["/", "/a", "/hidden", "/z"]);
    expect(fetched.some((url) => url.includes("outside.test"))).toBe(false);
    expect(fetched.some((url) => url.includes("?") || url.includes("#"))).toBe(false);
    expect(discovery).toMatchObject({ pagesEmitted: 4, fetchErrors: 0 });
    expect(discovery?.totalCandidates).toBeGreaterThanOrEqual(4);
  });
});

describe("design system extraction", () => {
  it("extracts CSS variables without leaking surrounding HTML", () => {
    const styleguide = buildStyleguideFromTexts([
      `<!doctype html><html><head><style>
        :root { --brand-primary: #2563eb; --broken-fragment: <div class="bad">; }
        body { color: #111827; background: #ffffff; }
      </style></head><body></body></html>`
    ]);

    expect(styleguide.colors.cssVariables["--brand-primary"]).toBe("#2563eb");
    expect(Object.values(styleguide.colors.cssVariables).some((value) => value.includes("<div"))).toBe(false);
  });

  it("builds agent-readable tokens, components, assets, motion, and exports", () => {
    const designSystem = buildDesignSystemFromPages({
      target: "https://seal-docs.wal.app/",
      pages: [
        pageWithHtml(`<!doctype html>
          <html>
            <head>
              <title>Seal Documentation</title>
              <style>
                :root {
                  --ifm-color-primary: #00a4db;
                  --ifm-font-family-base: Inter, system-ui, sans-serif;
                  --ifm-card-radius: 8px;
                }
                body { color: #111827; background: #ffffff; font-family: var(--ifm-font-family-base); }
                h1 { font-size: 40px; font-weight: 700; line-height: 1.1; }
                .button, button { background: var(--ifm-color-primary); color: #ffffff; border-radius: var(--ifm-card-radius); padding: 10px 14px; transition: color 180ms ease; }
                .button:hover { background: #0284c7; }
                .card { background: #f8fafc; border: 1px solid #d8dee9; box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12); }
                @keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
              </style>
            </head>
            <body>
              <img src="/img/logo.svg" alt="Seal Logo" />
              <button class="button">Start</button>
              <article class="card">Docs</article>
            </body>
          </html>`)
      ],
      brand: brand()
    });

    expect(designSystem.tokens.colors.some((token) => token.role === "brand" && token.value === "#00a4db")).toBe(true);
    expect(designSystem.tokens.typography.fontFamilies).toContain("Inter");
    expect(designSystem.components.map((component) => component.type)).toEqual(expect.arrayContaining(["button", "card"]));
    expect(designSystem.assets.some((asset) => asset.kind === "logo")).toBe(true);
    expect(designSystem.motion.some((token) => token.property === "keyframes" || token.value.includes("180ms"))).toBe(true);
    expect(renderTokensCss(designSystem)).toContain("--cm-color-brand");
  });
});

describe("image previews", () => {
  it("keeps a renderable preview URL for inline SVG images", () => {
    const images = extractImages(
      "https://seal-docs.wal.app/",
      `<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="4" /></svg>`
    );

    expect(images[0]?.absoluteUrl).toMatch(/^inline-svg:/);
    expect(images[0]?.previewUrl).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("uses the public Walrus portal URL for image resources", () => {
    const images = imageAssetsFromResourcePaths(["/img/logo.svg"], "https://seal-docs.wal.app/");

    expect(images[0]?.absoluteUrl).toBe("https://seal-docs.wal.app/img/logo.svg");
    expect(images[0]?.previewUrl).toBe("https://seal-docs.wal.app/img/logo.svg");
  });
});

function page(markdown: string): PageArtifact {
  return {
    url: "https://seal-docs.wal.app/",
    routePath: "/",
    title: "Seal",
    statusCode: 200,
    contentType: "text/html",
    markdown,
    html: "",
    text: markdown,
    metadata: {},
    links: [],
    images: [],
    contentHash: "hash"
  };
}

function pageWithHtml(html: string): PageArtifact {
  return {
    ...page("Seal docs"),
    html,
    images: [
      {
        src: "/img/logo.svg",
        absoluteUrl: "https://seal-docs.wal.app/img/logo.svg",
        element: "img",
        type: "url",
        alt: "Seal Logo",
        role: "brand-asset",
        contentType: "image/svg+xml"
      }
    ]
  };
}

function brand(): BrandProfile {
  return {
    name: "Seal Documentation",
    domain: "seal-docs.wal.app",
    description: "Seal docs",
    logos: [
      {
        src: "/img/logo.svg",
        absoluteUrl: "https://seal-docs.wal.app/img/logo.svg",
        element: "img",
        type: "url",
        alt: "Seal Logo",
        role: "brand-asset",
        contentType: "image/svg+xml"
      }
    ],
    colors: ["#00a4db"],
    fonts: ["Inter"],
    socials: [],
    metadata: {},
    confidence: 0.9
  };
}
