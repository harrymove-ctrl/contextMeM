import { Buffer } from "node:buffer";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import * as cheerio from "cheerio";
import type { HtmlMetadata, ImageAsset } from "./types.js";
import { normalizeUrl, sha256Hex, unique } from "./utils.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-"
});

export function extractHtmlMetadata(url: string, html: string): HtmlMetadata {
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim() || attr($, "meta[property='og:title']", "content") || undefined;
  const description = attr($, "meta[name='description']", "content") || attr($, "meta[property='og:description']", "content") || undefined;
  const canonicalUrl = absolutize(url, $("link[rel='canonical']").attr("href"));
  const language = $("html").attr("lang") || undefined;
  const openGraph: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  $("meta[property^='og:']").each((_, el) => {
    const key = $(el).attr("property");
    const value = $(el).attr("content");
    if (key && value) openGraph[key.replace("og:", "")] = value;
  });
  $("meta[name^='twitter:']").each((_, el) => {
    const key = $(el).attr("name");
    const value = $(el).attr("content");
    if (key && value) twitter[key.replace("twitter:", "")] = value;
  });
  const icons = unique(
    $("link[rel~='icon'], link[rel='apple-touch-icon'], link[rel='mask-icon']")
      .map((_, el) => absolutize(url, $(el).attr("href")))
      .get()
      .filter(Boolean) as string[]
  );
  return { title, description, canonicalUrl, language, openGraph, twitter, icons };
}

export function htmlToMarkdown(url: string, html: string, useMainContentOnly = true): { markdown: string; text: string; title?: string } {
  const dom = new JSDOM(html, { url });
  const document = dom.window.document;
  let contentHtml = html;
  let title: string | undefined;

  if (useMainContentOnly) {
    const reader = new Readability(document.cloneNode(true) as Document);
    const article = reader.parse();
    if (article?.content) {
      contentHtml = article.content;
      title = article.title || undefined;
    }
  }

  const markdown = turndown.turndown(contentHtml).replace(/\n{3,}/g, "\n\n").trim();
  const textDom = new JSDOM(contentHtml);
  const text = textDom.window.document.body.textContent?.replace(/\s+/g, " ").trim() ?? "";
  return { markdown, text, title };
}

export function extractLinks(url: string, html: string): string[] {
  const $ = cheerio.load(html);
  return unique(
    $("a[href]")
      .map((_, el) => absolutize(url, $(el).attr("href")))
      .get()
      .filter((href): href is string => Boolean(href && href.startsWith("http")))
      .map((href) => {
        try {
          return normalizeUrl(href);
        } catch {
          return href;
        }
      })
  );
}

export function extractImages(url: string, html: string): ImageAsset[] {
  const $ = cheerio.load(html);
  const images: ImageAsset[] = [];

  $("img").each((_, el) => {
    const src = $(el).attr("src");
    if (!src) return;
    images.push({
      src,
      absoluteUrl: absolutize(url, src) ?? src,
      element: "img",
      type: src.startsWith("data:") ? "data-uri" : "url",
      alt: $(el).attr("alt") || undefined,
      width: numberAttr($(el).attr("width")),
      height: numberAttr($(el).attr("height"))
    });
    const srcset = $(el).attr("srcset");
    if (srcset) images.push(...parseSrcset(url, srcset, "img"));
  });

  $("source[srcset]").each((_, el) => {
    images.push(...parseSrcset(url, $(el).attr("srcset") ?? "", "source"));
  });

  $("svg").each((index, el) => {
    const svg = $.html(el);
    const id = `inline-svg:${sha256Hex(svg).slice(0, 12)}`;
    images.push({
      src: id,
      absoluteUrl: id,
      previewUrl: svgToDataUrl(svg),
      element: "svg",
      type: "inline-svg",
      role: index === 0 ? "logo-candidate" : undefined
    });
  });

  $("meta[property='og:image'], meta[name='twitter:image']").each((_, el) => {
    const content = $(el).attr("content");
    if (!content) return;
    images.push({
      src: content,
      absoluteUrl: absolutize(url, content) ?? content,
      element: "meta",
      type: "url",
      role: "social-preview"
    });
  });

  $("link[rel~='icon'], link[rel='apple-touch-icon'], link[rel='mask-icon']").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    images.push({
      src: href,
      absoluteUrl: absolutize(url, href) ?? href,
      element: "link",
      type: "favicon",
      role: "icon"
    });
  });

  const seen = new Set<string>();
  return images.filter((image) => {
    const key = `${image.absoluteUrl}:${image.element}:${image.role ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function svgToDataUrl(svg: string): string {
  const standaloneSvg = /<svg\b[^>]*\sxmlns=/i.test(svg) ? svg : svg.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return `data:image/svg+xml;base64,${Buffer.from(standaloneSvg).toString("base64")}`;
}

function parseSrcset(url: string, srcset: string, element: string): ImageAsset[] {
  return srcset
    .split(",")
    .flatMap((part) => {
      const src = part.trim().split(/\s+/)[0];
      if (!src) return [];
      return [
        {
          src,
          absoluteUrl: absolutize(url, src) ?? src,
          element,
          type: "srcset" as const
        }
      ];
    });
}

function attr($: cheerio.CheerioAPI, selector: string, name: string): string | undefined {
  return $(selector).first().attr(name) || undefined;
}

function absolutize(baseUrl: string, value?: string): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return undefined;
  }
}

function numberAttr(value?: string): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
