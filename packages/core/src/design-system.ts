import * as cheerio from "cheerio";
import * as cssTree from "css-tree";
import type {
  BrandProfile,
  DesignAsset,
  DesignColorToken,
  DesignComponent,
  DesignComponentToken,
  DesignMotionToken,
  DesignSystem,
  DesignSystemProvenance,
  DesignTypographyToken,
  ImageAsset,
  PageArtifact,
  Styleguide,
  WalrusResourceRecord
} from "./types.js";
import { domainFromTarget, normalizeCssColor, unique } from "./utils.js";

export type StyleSource = {
  text: string;
  url?: string;
  routePath?: string;
  resourcePath?: string;
  blobId?: string;
  blobHash?: string;
  quiltPatchId?: string;
};

type ParsedDeclaration = {
  selector: string;
  property: string;
  value: string;
  source: DesignSystemProvenance;
};

type ParsedStyles = {
  declarations: ParsedDeclaration[];
  variables: Record<string, { raw: string; resolved: string; source: DesignSystemProvenance }>;
  keyframes: DesignMotionToken[];
};

const COMPONENT_PROPERTIES = new Set([
  "background",
  "background-color",
  "border",
  "border-color",
  "border-radius",
  "box-shadow",
  "color",
  "display",
  "font-family",
  "font-size",
  "font-weight",
  "gap",
  "height",
  "line-height",
  "margin",
  "padding",
  "width"
]);

export function buildDesignSystemFromPages(input: {
  target: string;
  pages: PageArtifact[];
  brand?: BrandProfile;
  styleSources?: StyleSource[];
  resources?: WalrusResourceRecord[];
}): DesignSystem {
  const styleSources = input.styleSources?.length ? input.styleSources : styleSourcesFromPages(input.pages);
  const parsed = parseStyleSources(styleSources);
  const colors = buildColorTokens(parsed);
  const rawPalette = unique([...colors.map((token) => token.value), ...extractColorsFromTexts(styleSources.map((source) => source.text))]).slice(0, 72);
  const components = buildComponents(parsed);
  const assets = buildAssets(input.pages, input.brand, input.resources);
  const typography = buildTypography(parsed);
  const primaryLogo = assets.find((asset) => asset.kind === "logo") ?? assets.find((asset) => asset.kind === "svg");
  const favicon = assets.find((asset) => asset.kind === "favicon");
  const domain = input.brand?.domain ?? safeDomain(input.target);

  return {
    generatedAt: new Date().toISOString(),
    identity: {
      name: input.brand?.name,
      domain,
      description: input.brand?.description,
      confidence: input.brand?.confidence ?? (colors.length || assets.length ? 0.55 : 0.25),
      primaryLogo,
      favicon
    },
    tokens: {
      colors,
      rawPalette,
      cssVariables: Object.fromEntries(Object.entries(parsed.variables).map(([name, variable]) => [name, variable.resolved])),
      typography,
      spacing: extractValues(parsed.declarations, ["padding", "margin", "gap", "row-gap", "column-gap"]).slice(0, 48),
      radii: extractValues(parsed.declarations, ["border-radius"]).slice(0, 32),
      shadows: extractValues(parsed.declarations, ["box-shadow", "text-shadow"]).slice(0, 32),
      borders: extractValues(parsed.declarations, ["border", "border-color", "border-width"]).slice(0, 32),
      layout: {
        breakpoints: extractMediaBreakpoints(styleSources.map((source) => source.text)).slice(0, 24),
        maxWidths: extractValues(parsed.declarations, ["max-width", "width"]).filter((value) => /\b(?:rem|px|%)\b/i.test(value)).slice(0, 32),
        zIndices: extractValues(parsed.declarations, ["z-index"]).slice(0, 24)
      }
    },
    components,
    assets,
    motion: buildMotionTokens(parsed),
    exports: {
      figmaTokens: "/context/figma.tokens.json",
      styleDictionary: "/context/style-dictionary.json",
      tailwindTheme: "/context/tailwind.theme.json",
      tokensCss: "/context/tokens.css",
      webBrandKit: "/context/web-brand-kit.json",
      videoBrandKit: "/context/video-brand-kit.json",
      markdown: "/context/design-system.md",
      rawJson: "/context/design-system.json"
    },
    provenance: {
      sourceRoutes: unique(input.pages.map((page) => page.routePath ?? page.url)).slice(0, 200),
      resourcePaths: unique(input.resources?.map((resource) => resource.path) ?? []).slice(0, 500),
      walrusBlobIds: unique(input.resources?.map((resource) => resource.blobId).filter(Boolean) ?? []).slice(0, 500)
    }
  };
}

export function buildStyleguideFromStyleSources(styleSources: StyleSource[]): Styleguide {
  const parsed = parseStyleSources(styleSources.length ? styleSources : [{ text: "" }]);
  const colors = buildColorTokens(parsed);
  const palette = unique([...colors.map((token) => token.value), ...extractColorsFromTexts(styleSources.map((source) => source.text))]).slice(0, 48);
  const typography = buildTypography(parsed);
  const background =
    colors.find((token) => token.role === "background")?.value ??
    colors.find((token) => token.role === "surface")?.value ??
    palette.find((color) => ["#fff", "#ffffff", "white"].includes(color.toLowerCase())) ??
    palette[0];
  const text =
    colors.find((token) => token.role === "text")?.value ??
    palette.find((color) => ["#000", "#000000", "black"].includes(color.toLowerCase())) ??
    palette[1];

  return {
    mode: inferColorMode(palette),
    colors: {
      text,
      background,
      accent: colors.find((token) => token.role === "brand" || token.role === "accent" || token.role === "link")?.value ?? palette.find((color) => color !== text && color !== background),
      palette,
      cssVariables: Object.fromEntries(Object.entries(parsed.variables).map(([name, variable]) => [name, variable.resolved]))
    },
    typography: {
      fontFamilies: typography.fontFamilies,
      headings: Object.fromEntries(
        typography.headings.map((token) => [
          token.name.replace(/^type\.heading\./, ""),
          {
            fontFamily: token.fontFamily,
            fontSize: token.fontSize,
            fontWeight: token.fontWeight,
            lineHeight: token.lineHeight,
            letterSpacing: token.letterSpacing
          }
        ])
      ),
      body: typography.body
        ? {
            fontFamily: typography.body.fontFamily,
            fontSize: typography.body.fontSize,
            fontWeight: typography.body.fontWeight,
            lineHeight: typography.body.lineHeight,
            letterSpacing: typography.body.letterSpacing
          }
        : undefined
    },
    spacing: extractValues(parsed.declarations, ["padding", "margin", "gap", "row-gap", "column-gap"]).slice(0, 32),
    radii: extractValues(parsed.declarations, ["border-radius"]).slice(0, 24),
    shadows: extractValues(parsed.declarations, ["box-shadow", "text-shadow"]).slice(0, 24),
    components: Object.fromEntries(
      buildComponents(parsed)
        .slice(0, 12)
        .map((component) => [component.type, Object.fromEntries(component.tokens.map((token) => [token.property, token.value]))])
    )
  };
}

export function styleSourcesFromPages(pages: PageArtifact[]): StyleSource[] {
  return pages.flatMap((page) => inlineStyleSourcesFromPage(page));
}

export function inlineStyleSourcesFromPage(page: PageArtifact): StyleSource[] {
  const $ = cheerio.load(page.html);
  const sources: StyleSource[] = [];
  $("style").each((index, element) => {
    const text = $(element).html()?.trim();
    if (text) sources.push({ text, routePath: page.routePath ?? page.url, url: page.url });
  });
  $("[style]").each((index, element) => {
    const style = $(element).attr("style")?.trim();
    if (style) {
      const tag = element.tagName || "element";
      const id = $(element).attr("id");
      const klass = ($(element).attr("class") ?? "").split(/\s+/).filter(Boolean)[0];
      const selector = id ? `#${id}` : klass ? `.${klass}` : tag;
      sources.push({
        text: `${selector}{${style}}`,
        routePath: page.routePath ?? page.url,
        url: page.url
      });
    }
  });
  return sources;
}

export function buildFigmaTokens(designSystem: DesignSystem): Record<string, unknown> {
  const global: Record<string, unknown> = {};
  for (const token of designSystem.tokens.colors) {
    assignToken(global, token.name, {
      value: token.value,
      type: "color",
      description: describeSource(token.source)
    });
  }
  for (const [index, family] of designSystem.tokens.typography.fontFamilies.entries()) {
    assignToken(global, `fontFamilies.${index === 0 ? "body" : slugName(family)}`, { value: family, type: "fontFamilies" });
  }
  for (const token of designSystem.tokens.typography.scale) {
    if (token.fontSize) assignToken(global, `${token.name}.fontSize`, { value: token.fontSize, type: "fontSizes" });
    if (token.fontWeight) assignToken(global, `${token.name}.fontWeight`, { value: token.fontWeight, type: "fontWeights" });
    if (token.lineHeight) assignToken(global, `${token.name}.lineHeight`, { value: token.lineHeight, type: "lineHeights" });
  }
  for (const [index, value] of designSystem.tokens.spacing.entries()) assignToken(global, `spacing.${index + 1}`, { value, type: "spacing" });
  for (const [index, value] of designSystem.tokens.radii.entries()) assignToken(global, `radii.${index + 1}`, { value, type: "borderRadius" });
  for (const [index, value] of designSystem.tokens.shadows.entries()) assignToken(global, `shadows.${index + 1}`, { value, type: "boxShadow" });
  return {
    $metadata: { tokenSetOrder: ["global"] },
    global
  };
}

export function buildStyleDictionaryTokens(designSystem: DesignSystem): Record<string, unknown> {
  const dictionary: Record<string, unknown> = {};
  for (const token of designSystem.tokens.colors) assignToken(dictionary, token.name, { value: token.value, type: "color" });
  for (const [index, value] of designSystem.tokens.spacing.entries()) assignToken(dictionary, `size.spacing.${index + 1}`, { value, type: "dimension" });
  for (const [index, value] of designSystem.tokens.radii.entries()) assignToken(dictionary, `size.radius.${index + 1}`, { value, type: "dimension" });
  for (const [index, value] of designSystem.tokens.shadows.entries()) assignToken(dictionary, `shadow.${index + 1}`, { value, type: "shadow" });
  return dictionary;
}

export function buildTailwindTheme(designSystem: DesignSystem): Record<string, unknown> {
  const colors: Record<string, string> = {};
  for (const token of designSystem.tokens.colors) colors[tailwindKey(token.name.replace(/^color\./, ""))] = token.value;
  return {
    theme: {
      extend: {
        colors,
        fontFamily: {
          sans: designSystem.tokens.typography.fontFamilies[0]?.split(",").map((font) => font.trim()) ?? ["ui-sans-serif", "system-ui"],
          mono: designSystem.tokens.typography.fontFamilies.find((font) => /mono|code/i.test(font))?.split(",").map((font) => font.trim()) ?? ["ui-monospace", "monospace"]
        },
        spacing: Object.fromEntries(designSystem.tokens.spacing.map((value, index) => [String(index + 1), value])),
        borderRadius: Object.fromEntries(designSystem.tokens.radii.map((value, index) => [String(index + 1), value])),
        boxShadow: Object.fromEntries(designSystem.tokens.shadows.map((value, index) => [String(index + 1), value]))
      }
    }
  };
}

export function renderTokensCss(designSystem: DesignSystem): string {
  const lines = [":root {"];
  for (const token of designSystem.tokens.colors) lines.push(`  --cm-${cssVarName(token.name)}: ${token.value};`);
  for (const [index, value] of designSystem.tokens.spacing.entries()) lines.push(`  --cm-spacing-${index + 1}: ${value};`);
  for (const [index, value] of designSystem.tokens.radii.entries()) lines.push(`  --cm-radius-${index + 1}: ${value};`);
  for (const [index, value] of designSystem.tokens.shadows.entries()) lines.push(`  --cm-shadow-${index + 1}: ${value};`);
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

export function buildWebBrandKit(designSystem: DesignSystem): Record<string, unknown> {
  return {
    identity: designSystem.identity,
    tokens: designSystem.tokens,
    components: designSystem.components.map((component) => ({
      name: component.name,
      type: component.type,
      selectors: component.selectors,
      tokens: Object.fromEntries(component.tokens.map((token) => [token.property, token.value]))
    })),
    exports: {
      css: designSystem.exports.tokensCss,
      tailwind: designSystem.exports.tailwindTheme,
      styleDictionary: designSystem.exports.styleDictionary
    }
  };
}

export function buildVideoBrandKit(designSystem: DesignSystem): Record<string, unknown> {
  const brand = designSystem.tokens.colors.find((token) => token.role === "brand") ?? designSystem.tokens.colors[0];
  const text = designSystem.tokens.colors.find((token) => token.role === "text");
  const background = designSystem.tokens.colors.find((token) => token.role === "background" || token.role === "surface");
  const fontFamily = designSystem.tokens.typography.fontFamilies[0] ?? "Inter, system-ui, sans-serif";
  const duration = designSystem.motion.find((token) => token.property === "duration")?.value ?? "180ms";
  return {
    identity: designSystem.identity,
    titleCard: {
      background: background?.value ?? "#ffffff",
      foreground: text?.value ?? "#111827",
      accent: brand?.value ?? "#2563eb",
      fontFamily
    },
    lowerThird: {
      background: brand?.value ?? "#2563eb",
      foreground: text?.value ?? "#ffffff",
      radius: designSystem.tokens.radii[0] ?? "8px",
      shadow: designSystem.tokens.shadows[0] ?? "none"
    },
    captions: {
      fontFamily,
      color: text?.value ?? "#111827",
      background: background?.value ?? "rgba(255,255,255,0.92)"
    },
    logoSafeArea: {
      preferredAsset: designSystem.identity.primaryLogo?.url ?? designSystem.identity.primaryLogo?.resourcePath,
      padding: designSystem.tokens.spacing[0] ?? "24px"
    },
    motion: {
      defaultDuration: duration,
      easing: designSystem.motion.find((token) => token.property === "easing")?.value ?? "ease"
    }
  };
}

export function renderDesignSystemMarkdown(designSystem: DesignSystem): string {
  const lines = [
    `# ${designSystem.identity.name ?? designSystem.identity.domain ?? "Design System"}`,
    "",
    designSystem.identity.description ?? "",
    "",
    "## Identity",
    `- Domain: ${designSystem.identity.domain ?? "unknown"}`,
    `- Confidence: ${Math.round(designSystem.identity.confidence * 100)}%`,
    "",
    "## Color Tokens",
    ...designSystem.tokens.colors.slice(0, 32).map((token) => `- ${token.name}: ${token.value} (${token.role})`),
    "",
    "## Typography",
    ...designSystem.tokens.typography.fontFamilies.slice(0, 12).map((font) => `- ${font}`),
    "",
    "## Components",
    ...designSystem.components.slice(0, 20).map((component) => `- ${component.name}: ${component.selectors.slice(0, 4).join(", ")}`),
    "",
    "## Exports",
    ...Object.entries(designSystem.exports).map(([name, route]) => `- ${name}: ${route}`)
  ];
  return `${lines.filter((line, index) => line !== "" || lines[index - 1] !== "").join("\n")}\n`;
}

function parseStyleSources(styleSources: StyleSource[]): ParsedStyles {
  const declarations: ParsedDeclaration[] = [];
  const rawVariables: Record<string, { raw: string; source: DesignSystemProvenance }> = {};
  const keyframes: DesignMotionToken[] = [];

  for (const source of styleSources) {
    const sourceInfo = sourceToProvenance(source);
    try {
      const ast = cssTree.parse(source.text, {
        parseValue: false,
        parseCustomProperty: false,
        positions: false
      } as cssTree.ParseOptions);
      cssTree.walk(ast, {
        enter(node: cssTree.CssNode) {
          const anyNode = node as any;
          if (anyNode.type === "Rule") {
            const selector = safeGenerate(anyNode.prelude);
            for (const child of listChildren(anyNode.block?.children)) {
              if (child.type !== "Declaration") continue;
              const property = String(child.property ?? "").trim();
              const value = cleanCssValue(safeGenerate(child.value));
              if (!property || !value) continue;
              const declarationSource = { ...sourceInfo, selector, cssProperty: property };
              declarations.push({ selector, property, value, source: declarationSource });
              if (property.startsWith("--") && isReasonableCssValue(value)) rawVariables[property] = { raw: value, source: { ...declarationSource, cssVariable: property } };
            }
          }
          if (anyNode.type === "Atrule" && String(anyNode.name).toLowerCase() === "keyframes") {
            const name = cleanCssValue(safeGenerate(anyNode.prelude));
            if (name) keyframes.push({ name: `motion.keyframes.${slugName(name)}`, property: "keyframes", value: name, source: sourceInfo });
          }
        }
      });
    } catch {
      declarations.push(...parseFallbackDeclarations(source.text, sourceInfo));
    }
  }

  for (const declaration of declarations) {
    if (declaration.property.startsWith("--") && isReasonableCssValue(declaration.value)) {
      rawVariables[declaration.property] = {
        raw: declaration.value,
        source: { ...declaration.source, cssVariable: declaration.property }
      };
    }
  }

  const variableEntries = Object.entries(rawVariables);
  const rawVarMap = Object.fromEntries(variableEntries.map(([name, variable]) => [name, variable.raw]));
  const variables = Object.fromEntries(
    variableEntries
      .map(([name, variable]) => [
        name,
        {
          raw: variable.raw,
          resolved: resolveCssValue(variable.raw, rawVarMap),
          source: variable.source
        }
      ])
      .filter(([, variable]) => isReasonableCssValue((variable as { resolved: string }).resolved))
      .slice(0, 180)
  ) as ParsedStyles["variables"];

  return { declarations, variables, keyframes };
}

function buildColorTokens(parsed: ParsedStyles): DesignColorToken[] {
  const tokens: DesignColorToken[] = [];
  const seen = new Set<string>();
  const add = (token: DesignColorToken) => {
    const key = `${token.role}:${token.value}:${token.rawName ?? token.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    tokens.push(token);
  };

  for (const [name, variable] of Object.entries(parsed.variables)) {
    const color = extractColorsFromText(variable.resolved)[0];
    if (!color) continue;
    const role = classifyColor(name, variable.source.cssProperty);
    add({
      name: `color.${role}.${slugName(name.replace(/^--/, ""))}`,
      value: color,
      role,
      rawName: name,
      aliases: variable.raw.includes("var(") ? [variable.raw] : [],
      usage: [`CSS variable ${name}`],
      source: variable.source
    });
  }

  for (const declaration of parsed.declarations) {
    if (!/(^color$|background|border|outline|fill|stroke|shadow)/i.test(declaration.property)) continue;
    for (const color of extractColorsFromText(resolveCssValue(declaration.value, Object.fromEntries(Object.entries(parsed.variables).map(([name, variable]) => [name, variable.resolved]))))) {
      const role = classifyColor(declaration.selector, declaration.property);
      add({
        name: `color.${role}.${slugName(declaration.selector || declaration.property)}`,
        value: color,
        role,
        aliases: [],
        usage: [`${declaration.property} on ${declaration.selector || "unknown selector"}`],
        source: declaration.source
      });
    }
  }

  return tokens.slice(0, 96);
}

function buildTypography(parsed: ParsedStyles): DesignSystem["tokens"]["typography"] {
  const variableValues = Object.fromEntries(Object.entries(parsed.variables).map(([name, variable]) => [name, variable.resolved]));
  const fontFamilies = unique(
    [
      ...Object.values(parsed.variables)
        .filter((variable) => /font/i.test(variable.source.cssVariable ?? ""))
        .flatMap((variable) => splitFontFamilies(resolveCssValue(variable.resolved, variableValues))),
      ...parsed.declarations.filter((declaration) => declaration.property === "font-family").flatMap((declaration) => splitFontFamilies(resolveCssValue(declaration.value, variableValues)))
    ].filter(Boolean)
  ).slice(0, 24);

  const bySelector = new Map<string, Record<string, ParsedDeclaration>>();
  for (const declaration of parsed.declarations) {
    if (!["font-family", "font-size", "font-weight", "line-height", "letter-spacing"].includes(declaration.property)) continue;
    const current = bySelector.get(declaration.selector) ?? {};
    current[declaration.property] = declaration;
    bySelector.set(declaration.selector, current);
  }

  const scale: DesignTypographyToken[] = [];
  for (const [selector, declarations] of bySelector.entries()) {
    const token = typographyTokenFromDeclarations(selector, declarations, variableValues);
    if (token) scale.push(token);
  }
  const headings = scale.filter((token) => /^type\.heading\./.test(token.name)).slice(0, 8);
  const body = scale.find((token) => token.name === "type.body") ?? scale.find((token) => /body|html|root/i.test(token.selector ?? ""));

  return {
    fontFamilies,
    scale: scale.slice(0, 48),
    body,
    headings
  };
}

function buildComponents(parsed: ParsedStyles): DesignComponent[] {
  const groups = new Map<DesignComponent["type"], DesignComponent>();
  const variableValues = Object.fromEntries(Object.entries(parsed.variables).map(([name, variable]) => [name, variable.resolved]));

  for (const declaration of parsed.declarations) {
    const type = classifyComponent(declaration.selector);
    if (!type || !COMPONENT_PROPERTIES.has(declaration.property)) continue;
    const component = groups.get(type) ?? {
      name: titleCase(type),
      type,
      selectors: [],
      tokens: [],
      states: [],
      sourceRoutes: []
    };
    if (!component.selectors.includes(declaration.selector)) component.selectors.push(declaration.selector);
    if (declaration.source.routePath && !component.sourceRoutes.includes(declaration.source.routePath)) component.sourceRoutes.push(declaration.source.routePath);
    const token: DesignComponentToken = {
      property: declaration.property,
      value: resolveCssValue(declaration.value, variableValues),
      source: declaration.source
    };
    const stateName = classifyState(declaration.selector);
    const state = component.states.find((entry) => entry.name === stateName) ?? { name: stateName, tokens: [] };
    if (!component.states.includes(state)) component.states.push(state);
    if (!state.tokens.some((entry) => entry.property === token.property && entry.value === token.value)) state.tokens.push(token);
    if (stateName === "base" && !component.tokens.some((entry) => entry.property === token.property && entry.value === token.value)) component.tokens.push(token);
    groups.set(type, component);
  }

  return [...groups.values()].map((component) => ({
    ...component,
    selectors: component.selectors.slice(0, 16),
    tokens: component.tokens.slice(0, 18),
    states: component.states.map((state) => ({ ...state, tokens: state.tokens.slice(0, 18) })).slice(0, 8),
    sourceRoutes: component.sourceRoutes.slice(0, 12)
  }));
}

function buildAssets(pages: PageArtifact[], brand?: BrandProfile, resources: WalrusResourceRecord[] = []): DesignAsset[] {
  const fromImages = uniqueImages([...(brand?.logos ?? []), ...pages.flatMap((page) => page.images)]).map(imageToAsset);
  const fromResources = resources
    .filter((resource) => !resource.error)
    .flatMap((resource): DesignAsset[] => {
      const path = resource.path;
      const contentType = resource.contentType;
      const source = {
        resourcePath: path,
        blobId: resource.blobId,
        blobHash: resource.blobHash,
        quiltPatchId: resource.quiltPatchId
      };
      if (/\.(woff2?|ttf|otf)$/i.test(path) || /font/i.test(contentType ?? "")) return [{ kind: "font", label: path.split("/").pop() ?? path, resourcePath: path, contentType, source }];
      if (/logo/i.test(path)) return [{ kind: "logo", label: path.split("/").pop() ?? path, resourcePath: path, contentType, source }];
      if (/favicon|icon/i.test(path)) return [{ kind: "favicon", label: path.split("/").pop() ?? path, resourcePath: path, contentType, source }];
      if (/\.svg$/i.test(path)) return [{ kind: "svg", label: path.split("/").pop() ?? path, resourcePath: path, contentType, source }];
      if (/\.(png|jpe?g|gif|webp|ico)$/i.test(path)) return [{ kind: "image", label: path.split("/").pop() ?? path, resourcePath: path, contentType, source }];
      return [];
    });
  return uniqueAssets([...fromImages, ...fromResources]).slice(0, 160);
}

function buildMotionTokens(parsed: ParsedStyles): DesignMotionToken[] {
  const tokens: DesignMotionToken[] = [...parsed.keyframes];
  const seen = new Set(tokens.map((token) => `${token.property}:${token.value}`));
  const add = (token: DesignMotionToken) => {
    const key = `${token.property}:${token.value}`;
    if (seen.has(key)) return;
    seen.add(key);
    tokens.push(token);
  };
  for (const declaration of parsed.declarations) {
    if (declaration.property.includes("transition")) {
      add({ name: `motion.transition.${slugName(declaration.selector || "base")}`, property: "transition", value: declaration.value, source: declaration.source });
      for (const duration of extractDurations(declaration.value)) add({ name: `motion.duration.${slugName(duration)}`, property: "duration", value: duration, source: declaration.source });
      for (const easing of extractEasings(declaration.value)) add({ name: `motion.easing.${slugName(easing)}`, property: "easing", value: easing, source: declaration.source });
    }
    if (declaration.property.includes("animation")) {
      add({ name: `motion.animation.${slugName(declaration.selector || "base")}`, property: "animation", value: declaration.value, source: declaration.source });
      for (const duration of extractDurations(declaration.value)) add({ name: `motion.duration.${slugName(duration)}`, property: "duration", value: duration, source: declaration.source });
      for (const easing of extractEasings(declaration.value)) add({ name: `motion.easing.${slugName(easing)}`, property: "easing", value: easing, source: declaration.source });
    }
  }
  return tokens.slice(0, 80);
}

function parseFallbackDeclarations(text: string, source: DesignSystemProvenance): ParsedDeclaration[] {
  const declarations: ParsedDeclaration[] = [];
  for (const match of text.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
    const selector = match[1]?.trim() ?? "";
    const body = match[2] ?? "";
    for (const declaration of body.split(";")) {
      const colon = declaration.indexOf(":");
      if (colon <= 0) continue;
      const property = declaration.slice(0, colon).trim();
      const value = cleanCssValue(declaration.slice(colon + 1));
      if (property && value) declarations.push({ selector, property, value, source: { ...source, selector, cssProperty: property } });
    }
  }
  return declarations;
}

function typographyTokenFromDeclarations(selector: string, declarations: Record<string, ParsedDeclaration>, vars: Record<string, string>): DesignTypographyToken | null {
  const fontFamily = declarations["font-family"] ? resolveCssValue(declarations["font-family"].value, vars) : undefined;
  const fontSize = declarations["font-size"] ? resolveCssValue(declarations["font-size"].value, vars) : undefined;
  const fontWeight = declarations["font-weight"] ? resolveCssValue(declarations["font-weight"].value, vars) : undefined;
  const lineHeight = declarations["line-height"] ? resolveCssValue(declarations["line-height"].value, vars) : undefined;
  const letterSpacing = declarations["letter-spacing"] ? resolveCssValue(declarations["letter-spacing"].value, vars) : undefined;
  if (!fontFamily && !fontSize && !fontWeight && !lineHeight && !letterSpacing) return null;
  const headingMatch = selector.match(/\b(h[1-6])\b/i)?.[1]?.toLowerCase();
  const name = headingMatch ? `type.heading.${headingMatch}` : /body|html|:root/i.test(selector) ? "type.body" : `type.${slugName(selector)}`;
  return {
    name,
    selector,
    fontFamily,
    fontSize,
    fontWeight,
    lineHeight,
    letterSpacing,
    usage: [`Typography from ${selector}`],
    source: Object.values(declarations)[0]?.source
  };
}

function extractValues(declarations: ParsedDeclaration[], properties: string[]): string[] {
  const propertySet = new Set(properties);
  return unique(
    declarations
      .filter((declaration) => propertySet.has(declaration.property))
      .map((declaration) => declaration.value)
      .filter((value) => value && isReasonableCssValue(value))
  );
}

function extractColorsFromTexts(texts: string[]): string[] {
  return unique(texts.flatMap(extractColorsFromText)).slice(0, 96);
}

function extractColorsFromText(text: string): string[] {
  return unique(
    [
      ...text.matchAll(/#[0-9a-f]{3,8}\b/gi),
      ...text.matchAll(/\b(?:rgb|rgba|hsl|hsla)\([^)]+\)/gi),
      ...text.matchAll(/\b(?:black|white|transparent|currentColor)\b/gi)
    ].map((match) => normalizeCssColor(match[0]))
  );
}

function extractMediaBreakpoints(texts: string[]): string[] {
  return unique(texts.flatMap((text) => [...text.matchAll(/@media[^{]+/gi)].map((match) => cleanCssValue(match[0]))));
}

function extractDurations(value: string): string[] {
  return unique([...value.matchAll(/\b\d*\.?\d+(?:ms|s)\b/gi)].map((match) => match[0]));
}

function extractEasings(value: string): string[] {
  return unique([...value.matchAll(/\b(?:ease(?:-in|-out|-in-out)?|linear|cubic-bezier\([^)]+\))\b/gi)].map((match) => match[0]));
}

function classifyColor(nameOrSelector: string, property?: string): DesignColorToken["role"] {
  const haystack = `${nameOrSelector} ${property ?? ""}`.toLowerCase();
  if (/success|valid|positive|green/.test(haystack)) return "success";
  if (/warning|caution|yellow|amber/.test(haystack)) return "warning";
  if (/danger|error|invalid|destructive|red/.test(haystack)) return "danger";
  if (/info|notice|blue/.test(haystack)) return "info";
  if (/link|anchor/.test(haystack)) return "link";
  if (/background|bg|surface|page|body/.test(haystack)) return /surface|card|panel/.test(haystack) ? "surface" : "background";
  if (/text|foreground|content|heading|body|copy|color$/.test(haystack)) return "text";
  if (/border|outline|divider|stroke/.test(haystack)) return "border";
  if (/muted|subtle|secondary|disabled|placeholder/.test(haystack)) return "muted";
  if (/primary|brand|accent|theme|ifm-color-primary/.test(haystack)) return "brand";
  if (/accent|highlight/.test(haystack)) return "accent";
  return "raw";
}

function classifyComponent(selector: string): DesignComponent["type"] | null {
  const value = selector.toLowerCase();
  if (/(^|[,\s.#:[>+~])button\b|\.btn\b|button|primary-button/.test(value)) return "button";
  if (/\bnav\b|navbar|menu|sidebar|breadcrumb|toc/.test(value)) return "nav";
  if (/card|tile|panel|surface|container/.test(value)) return "card";
  if (/\binput\b|textarea|select|form|checkbox|radio/.test(value)) return "input";
  if (/\btab\b|tabs/.test(value)) return "tabs";
  if (/\bcode\b|\bpre\b|prism|highlight/.test(value)) return "code";
  if (/alert|admonition|callout|notice|toast/.test(value)) return "alert";
  if (/\btable\b|thead|tbody|tr|td|th/.test(value)) return "table";
  if (/badge|tag|pill|label/.test(value)) return "badge";
  if (/(^|[,\s.#:[>+~])a\b|link/.test(value)) return "link";
  if (/layout|grid|row|col|main|section/.test(value)) return "layout";
  return null;
}

function classifyState(selector: string): DesignComponent["states"][number]["name"] {
  if (/:hover/.test(selector)) return "hover";
  if (/:focus|:focus-visible|:focus-within/.test(selector)) return "focus";
  if (/:active/.test(selector)) return "active";
  if (/:disabled|\[disabled\]|\.disabled/.test(selector)) return "disabled";
  if (/:checked|\.selected|\.active|\[aria-selected/.test(selector)) return "selected";
  return "base";
}

function inferColorMode(colors: string[]): Styleguide["mode"] {
  const hasDark = colors.some((color) => /#0[0-9a-f]{2,5}|#111|#000|rgb\(\s*(0|1[0-9]|2[0-9])\s*,|black/i.test(color));
  const hasLight = colors.some((color) => /#fff|#ffffff|rgb\(\s*255\s*,|white/i.test(color));
  if (hasDark && hasLight) return "mixed";
  if (hasDark) return "dark";
  if (hasLight) return "light";
  return "unknown";
}

function resolveCssValue(value: string, variables: Record<string, string>, stack: string[] = []): string {
  return cleanCssValue(
    value.replace(/var\(\s*(--[a-z0-9-_]+)\s*(?:,\s*([^)]+))?\)/gi, (_match, name: string, fallback?: string) => {
      if (stack.includes(name)) return fallback ? cleanCssValue(fallback) : `var(${name})`;
      const next = variables[name];
      if (!next) return fallback ? cleanCssValue(fallback) : `var(${name})`;
      return resolveCssValue(next, variables, [...stack, name]);
    })
  );
}

function splitFontFamilies(value: string): string[] {
  return value
    .split(",")
    .map((font) => font.trim().replaceAll(/^["']|["']$/g, ""))
    .filter((font) => font && !/^var\(/i.test(font))
    .slice(0, 12);
}

function imageToAsset(image: ImageAsset): DesignAsset {
  const haystack = `${image.absoluteUrl} ${image.src} ${image.role ?? ""} ${image.contentType ?? ""}`.toLowerCase();
  const kind: DesignAsset["kind"] = /favicon/.test(haystack) ? "favicon" : /logo/.test(haystack) || image.role === "brand-asset" ? "logo" : image.type === "inline-svg" ? "svg" : "image";
  return {
    kind,
    label: image.alt ?? image.role ?? image.absoluteUrl.split("/").pop() ?? kind,
    url: image.absoluteUrl,
    contentType: image.contentType,
    alt: image.alt
  };
}

function uniqueImages(images: ImageAsset[]): ImageAsset[] {
  const seen = new Set<string>();
  return images.filter((image) => {
    const key = `${image.absoluteUrl}:${image.role ?? ""}:${image.contentType ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueAssets(assets: DesignAsset[]): DesignAsset[] {
  const seen = new Set<string>();
  return assets.filter((asset) => {
    const key = `${asset.kind}:${asset.url ?? asset.resourcePath ?? asset.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function assignToken(root: Record<string, unknown>, path: string, token: Record<string, unknown>): void {
  const parts = path.split(".").filter(Boolean);
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    const current = cursor[part];
    if (!current || typeof current !== "object" || Array.isArray(current)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  const last = parts.at(-1);
  if (last) cursor[last] = token;
}

function describeSource(source?: DesignSystemProvenance): string | undefined {
  if (!source) return undefined;
  return [source.resourcePath, source.routePath, source.selector, source.cssVariable ?? source.cssProperty].filter(Boolean).join(" ");
}

function sourceToProvenance(source: StyleSource): DesignSystemProvenance {
  return {
    routePath: source.routePath,
    url: source.url,
    resourcePath: source.resourcePath,
    blobId: source.blobId,
    blobHash: source.blobHash,
    quiltPatchId: source.quiltPatchId
  };
}

function listChildren(list: unknown): any[] {
  const anyList = list as any;
  if (!anyList) return [];
  if (typeof anyList.toArray === "function") return anyList.toArray();
  const items: any[] = [];
  if (typeof anyList.forEach === "function") anyList.forEach((item: any) => items.push(item));
  return items;
}

function safeGenerate(node: unknown): string {
  try {
    return cleanCssValue(cssTree.generate(node as cssTree.CssNode));
  } catch {
    return "";
  }
}

function cleanCssValue(value: string): string {
  return value.replaceAll(/\s+/g, " ").replaceAll(/\/\*.*?\*\//g, "").replace(/\s*!important$/i, "").trim();
}

function isReasonableCssValue(value: string): boolean {
  return Boolean(value && value.length <= 220 && !/[<>]/.test(value) && !value.includes("</"));
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (char) => char.toUpperCase());
}

function slugName(value: string): string {
  return (
    value
      .replace(/^--/, "")
      .replace(/^[.#]/, "")
      .replaceAll(/[^a-z0-9]+/gi, "-")
      .replaceAll(/^-|-$/g, "")
      .toLowerCase() || "base"
  );
}

function cssVarName(value: string): string {
  return value.replaceAll(".", "-").replaceAll(/[^a-z0-9-_]+/gi, "-").toLowerCase();
}

function tailwindKey(value: string): string {
  return value.replaceAll(".", "-").replaceAll(/[^a-z0-9-_]+/gi, "-").toLowerCase();
}

function safeDomain(target: string): string | undefined {
  try {
    return domainFromTarget(target);
  } catch {
    try {
      return new URL(target).hostname;
    } catch {
      return undefined;
    }
  }
}
