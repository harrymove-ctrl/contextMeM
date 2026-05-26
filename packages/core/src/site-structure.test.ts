import { describe, expect, it } from "vitest";
import { buildSiteStructure } from "./site-structure.js";
import type { PageArtifact, WalrusResourceRecord } from "./types.js";

describe("site structure", () => {
  it("groups Docusaurus Walrus resources into route-first sections with provenance", () => {
    const resources = [
      resource("/Aggregator/index.html", "text/html", "blob-html", "hash-html"),
      resource("/404.html", "text/html", "blob-404", "hash-404"),
      resource("/search/index.html", "text/html", "blob-search", "hash-search"),
      resource("/Aggregator.md", "text/markdown", "blob-md", "hash-md"),
      resource("/assets/css/styles.6c9995e0.css", "text/css", "blob-css", "hash-css"),
      resource("/assets/js/main.28491f29.js", "text/javascript", "blob-js", "hash-js"),
      resource("/assets/files/Seal_White_Paper_v1.pdf", "application/pdf", "blob-pdf", "hash-pdf"),
      resource("/img/logo.svg", "image/svg+xml", "blob-logo", "hash-logo"),
      resource("/img/favicon.ico", "image/x-icon", "blob-icon", "hash-icon"),
      resource("/llms.txt", "text/plain", "blob-llms", "hash-llms"),
      resource("/sitemap.xml", "application/xml", "blob-sitemap", "hash-sitemap")
    ];

    const structure = buildSiteStructure({
      target: "https://seal-docs.wal.app/",
      pages: [page("/Aggregator/index.html")],
      sitemap: {
        target: "https://seal-docs.wal.app/",
        urls: resources.map((item) => item.path),
        meta: { sitemapsDiscovered: 0, sitemapsFetched: 0, sitemapsSkipped: 0, errors: 0 }
      },
      images: [{ src: "/img/logo.svg", absoluteUrl: "https://seal-docs.wal.app/img/logo.svg", element: "img", type: "url", role: "logo" }],
      walrus: { resources }
    });

    const pages = structure.nodes.find((node) => node.id === "pages")!;
    const aggregator = pages.children?.find((node) => node.path === "/Aggregator/index.html");
    expect(aggregator?.label).toBe("/Aggregator/");
    expect(aggregator?.children?.some((node) => node.path === "/Aggregator.md")).toBe(true);
    expect(pages.children?.some((node) => node.path === "/404.html")).toBe(false);
    expect(pages.children?.some((node) => node.path === "/search/index.html")).toBe(false);

    const assets = structure.nodes.find((node) => node.id === "assets")!;
    expect(assets.children?.map((node) => node.path)).toEqual(expect.arrayContaining(["/assets/css/styles.6c9995e0.css", "/assets/js/main.28491f29.js", "/assets/files/Seal_White_Paper_v1.pdf"]));

    const brand = structure.nodes.find((node) => node.id === "brand-assets")!;
    expect(brand.children?.map((node) => node.path)).toEqual(expect.arrayContaining(["/img/logo.svg", "/img/favicon.ico"]));

    const walrus = structure.nodes.find((node) => node.id === "walrus-provenance")!;
    const logo = walrus.children?.find((node) => node.path === "/img/logo.svg");
    expect(logo?.blobId).toBe("blob-logo");
    expect(logo?.blobHash).toBe("hash-logo");
    expect(walrus.children?.some((node) => node.path === "/404.html")).toBe(true);
  });

  it("connects extensionless page routes to index.html and markdown resources", () => {
    const resources = [
      resource("/ExamplePatterns/index.html", "text/html", "blob-html", "hash-html"),
      resource("/ExamplePatterns.md", "text/markdown", "blob-md", "hash-md")
    ];

    const structure = buildSiteStructure({
      target: "https://seal-docs.wal.app/",
      pages: [page("/ExamplePatterns", "/ExamplePatterns/index.html")],
      walrus: { resources }
    });

    const pages = structure.nodes.find((node) => node.id === "pages")!;
    const examplePatterns = pages.children?.find((node) => node.path === "/ExamplePatterns");
    expect(examplePatterns?.artifactPath).toBe("/site/ExamplePatterns/index.html");
    expect(examplePatterns?.resourcePath).toBe("/ExamplePatterns/index.html");

    const html = examplePatterns?.children?.find((node) => node.id === "page:/ExamplePatterns:html");
    expect(html?.artifactPath).toBe("/site/ExamplePatterns/index.html");
    expect(html?.resourcePath).toBe("/ExamplePatterns/index.html");

    const markdownSource = examplePatterns?.children?.find((node) => node.id === "page:/ExamplePatterns:markdown-source");
    expect(markdownSource?.artifactPath).toBe("/site/ExamplePatterns.md");
    expect(markdownSource?.resourcePath).toBe("/ExamplePatterns.md");
  });
});

function resource(path: string, contentType: string, blobId: string, blobHash: string): WalrusResourceRecord {
  return {
    path,
    headers: { "content-type": contentType },
    blobId,
    blobHash,
    range: null,
    contentType,
    byteLength: 123,
    verified: true,
    localPath: `site${path}`
  };
}

function page(routePath: string, resourcePath = routePath): PageArtifact {
  return {
    url: `walrus://mainnet/0x${"1".repeat(64)}${resourcePath}`,
    routePath,
    title: "Aggregator",
    statusCode: 200,
    contentType: "text/html",
    markdown: "# Aggregator",
    html: "<main>Aggregator</main>",
    text: "Aggregator",
    metadata: {},
    links: [],
    images: [],
    contentHash: "page-hash",
    source: {
      kind: "walrus",
      resourcePath,
      blobId: "blob-html",
      blobHash: "hash-html"
    }
  };
}
