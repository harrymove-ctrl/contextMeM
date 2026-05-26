import fs from "node:fs/promises";
import path from "node:path";
import type { ComponentPreviewArtifact, DesignComponent, DesignSystem, PageArtifact, ScreenshotArtifact } from "./types.js";
import { safeJoin } from "./utils.js";

export type ScreenshotCaptureResult = {
  screenshots: ScreenshotArtifact[];
  componentPreviews: ComponentPreviewArtifact[];
  warnings: string[];
};

export async function captureScreenshots(input: {
  outputDir: string;
  pages: PageArtifact[];
  designSystem?: DesignSystem;
  baseUrl?: string;
  maxPages?: number;
  maxComponents?: number;
}): Promise<ScreenshotCaptureResult> {
  const screenshots: ScreenshotArtifact[] = [];
  const componentPreviews: ComponentPreviewArtifact[] = [];
  const warnings: string[] = [];
  const routes = representativePages(input.pages, input.maxPages ?? 5, input.baseUrl);

  if (!routes.length) return { screenshots, componentPreviews, warnings: ["No pages available for screenshot capture."] };

  let chromium: any;
  try {
    ({ chromium } = await import("playwright"));
  } catch (error) {
    return {
      screenshots,
      componentPreviews,
      warnings: [`Playwright is unavailable: ${error instanceof Error ? error.message : String(error)}`]
    };
  }

  let browser: any;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      deviceScaleFactor: 1
    });
    const page = await context.newPage();

    await fs.mkdir(path.join(input.outputDir, "context", "screenshots"), { recursive: true });
    await fs.mkdir(path.join(input.outputDir, "context", "component-previews"), { recursive: true });

    for (const [index, route] of routes.entries()) {
      const fileRoute = `/context/screenshots/${String(index + 1).padStart(3, "0")}-${slug(route.routePath)}.png`;
      const absoluteFile = safeJoin(input.outputDir, fileRoute);
      try {
        const response = await page.goto(route.url, { waitUntil: "networkidle", timeout: 15_000 });
        await page.screenshot({ path: absoluteFile, fullPage: true });
        screenshots.push({
          routePath: route.routePath,
          url: route.url,
          path: fileRoute,
          width: 1440,
          height: 1000,
          viewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
          status: response?.ok() === false ? "failed" : "captured",
          error: response?.ok() === false ? `HTTP ${response.status()}` : undefined
        });
      } catch (error) {
        screenshots.push({
          routePath: route.routePath,
          url: route.url,
          width: 1440,
          height: 1000,
          viewport: { width: 1440, height: 1000, deviceScaleFactor: 1 },
          status: "failed",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    const previewTargets = componentPreviewTargets(input.designSystem?.components ?? [], input.maxComponents ?? 16);
    const firstRoute = routes[0]!;
    try {
      await page.goto(firstRoute.url, { waitUntil: "networkidle", timeout: 15_000 });
    } catch {
      // Component previews can still fail individually below.
    }

    for (const [index, target] of previewTargets.entries()) {
      const fileRoute = `/context/component-previews/${String(index + 1).padStart(3, "0")}-${slug(`${target.type}-${target.selector}`)}.png`;
      const absoluteFile = safeJoin(input.outputDir, fileRoute);
      try {
        const locator = page.locator(target.selector).first();
        await locator.waitFor({ state: "visible", timeout: 2_000 });
        const box = await locator.boundingBox();
        await locator.screenshot({ path: absoluteFile });
        componentPreviews.push({
          componentName: target.name,
          componentType: target.type,
          selector: target.selector,
          routePath: firstRoute.routePath,
          url: firstRoute.url,
          path: fileRoute,
          width: Math.round(box?.width ?? 0),
          height: Math.round(box?.height ?? 0),
          status: "captured"
        });
      } catch (error) {
        componentPreviews.push({
          componentName: target.name,
          componentType: target.type,
          selector: target.selector,
          routePath: firstRoute.routePath,
          url: firstRoute.url,
          status: "failed",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    attachComponentPreviews(input.designSystem, componentPreviews);
  } catch (error) {
    warnings.push(`Screenshot capture failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await browser?.close().catch(() => undefined);
  }

  return { screenshots, componentPreviews, warnings };
}

export function attachComponentPreviews(designSystem: DesignSystem | undefined, previews: ComponentPreviewArtifact[]): void {
  if (!designSystem || !previews.length) return;
  for (const component of designSystem.components) {
    const matches = previews.filter((preview) => preview.componentType === component.type || preview.componentName === component.name);
    if (matches.length) component.previews = matches;
  }
}

function representativePages(pages: PageArtifact[], maxPages: number, baseUrl?: string): Array<{ routePath: string; url: string }> {
  const seen = new Set<string>();
  const scored = [...pages].sort((a, b) => pageScore(a) - pageScore(b));
  const routes: Array<{ routePath: string; url: string }> = [];
  for (const page of scored) {
    const routePath = page.routePath ?? safeRoutePath(page.url);
    if (seen.has(routePath)) continue;
    seen.add(routePath);
    const url = baseUrl ? new URL(routePath, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString() : page.url;
    if (!/^https?:\/\//i.test(url)) continue;
    routes.push({ routePath, url });
    if (routes.length >= maxPages) break;
  }
  return routes;
}

function componentPreviewTargets(components: DesignComponent[], maxComponents: number): Array<{ name: string; type: DesignComponent["type"]; selector: string }> {
  const targets: Array<{ name: string; type: DesignComponent["type"]; selector: string }> = [];
  for (const component of components) {
    const selector = component.selectors.map(normalizePreviewSelector).find(Boolean);
    if (!selector) continue;
    targets.push({ name: component.name, type: component.type, selector });
    if (targets.length >= maxComponents) break;
  }
  return targets;
}

function normalizePreviewSelector(selector: string): string | undefined {
  const first = selector.split(",").map((part) => part.trim()).find(Boolean);
  if (!first || /:(hover|focus|active|visited|disabled|checked)/.test(first)) return undefined;
  if (first.length > 180 || /[{}]/.test(first)) return undefined;
  return first;
}

function pageScore(page: PageArtifact): number {
  const route = page.routePath ?? page.url;
  if (route === "/" || /\/index\.html?$/i.test(route)) return 0;
  if (/docs|get-started|guide/i.test(route)) return 1;
  return 2;
}

function safeRoutePath(url: string): string {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return "/";
  }
}

function slug(input: string): string {
  return input.replace(/^https?:\/\//, "").replaceAll(/[^a-z0-9]+/gi, "-").replaceAll(/^-|-$/g, "").toLowerCase() || "index";
}
