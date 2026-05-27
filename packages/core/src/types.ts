export type TargetMode = "auto" | "web" | "walrus";
export type TargetKind = "url" | "domain" | "email" | "ticker" | "name" | "walrus-object" | "walrus-url" | "preview-config";
export type RunStatus = "queued" | "running" | "completed" | "failed";
export type Network = "testnet" | "mainnet";
export type BuildProfile = "fast" | "balanced" | "full";

export type RunProgress = {
  phase:
    | "queued"
    | "resolving"
    | "listing_resources"
    | "downloading_resources"
    | "crawling_pages"
    | "extracting_pages"
    | "extracting_metadata"
    | "capturing_screenshots"
    | "building_artifacts"
    | "completed"
    | "failed";
  label?: string;
  itemsDone?: number;
  itemsTotal?: number;
  updatedAt: string;
};

export type RunCacheStats = {
  hits: number;
  misses: number;
  writes: number;
  bytesRead: number;
  bytesWritten: number;
};

export type CrawlOptions = {
  maxPages?: number;
  maxDepth?: number;
  urlRegex?: string;
  includeLinks?: boolean;
  includeImages?: boolean;
  useMainContentOnly?: boolean;
  followSubdomains?: boolean;
  timeoutMs?: number;
  waitForMs?: number;
  concurrency?: number;
  seedUrls?: string[];
  onDiscovery?: (stats: DiscoveryStats) => void;
};

export type RunManifest = {
  runId: string;
  target: string;
  normalizedTarget: string;
  targetKind: TargetKind;
  mode: TargetMode;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  namespace: string;
  outputs: string[];
  buildProfile?: BuildProfile;
  progress?: RunProgress;
  timings?: Record<string, number>;
  cacheStats?: RunCacheStats;
  errors: string[];
  artifactDir: string;
};

export type RunHistoryItem = {
  runId: string;
  target: string;
  normalizedTarget: string;
  mode: TargetMode;
  status: RunStatus;
  namespace: string;
  outputs: string[];
  artifactDir: string;
  createdAt: string;
  updatedAt: string;
  pages: number;
  images: number;
  resources: number;
  hasDesignSystem: boolean;
  hasScreenshots: boolean;
  errors: string[];
};

export type ArtifactFileRecord = {
  path: string;
  size: number;
  updatedAt: string;
  contentType: string;
  kind: "json" | "markdown" | "html" | "image" | "css" | "text" | "binary" | "other";
  group: "core" | "design-system" | "walrus" | "screenshots" | "package" | "pages" | "assets" | "other";
  previewable: boolean;
  downloadable: boolean;
};

export type SiteSnapshotDiffEntry = {
  key: string;
  status: "added" | "removed" | "changed" | "unchanged";
  before?: unknown;
  after?: unknown;
};

export type SiteSnapshotDiff = {
  baseRunId: string;
  compareRunId?: string;
  namespace?: string;
  generatedAt: string;
  summary: {
    pages: DiffCounter;
    resources: DiffCounter;
    images: DiffCounter;
    designTokens: DiffCounter;
  };
  pages: SiteSnapshotDiffEntry[];
  resources: SiteSnapshotDiffEntry[];
  images: SiteSnapshotDiffEntry[];
  designTokens: SiteSnapshotDiffEntry[];
};

export type DiffCounter = {
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
};

export type McpInstallSnippet = {
  id: "claude-desktop" | "cursor" | "codex" | "generic" | "mcp-remote";
  label: string;
  command?: string;
  config?: unknown;
};

export type DemoExtraction = {
  id: string;
  target: string;
  namespace: string;
  status: RunStatus;
  result?: unknown;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type ShareLink = {
  id: string;
  namespace: string;
  target: string;
  title?: string;
  description?: string;
  sourceRunId?: string;
  versionId: string;
  artifactCount: number;
  byteLength: number;
  createdAt: string;
  updatedAt: string;
};

export type Schedule = {
  id: string;
  ownerId: string;
  namespace: string;
  target: string;
  intervalHours: number;
  webhookUrl?: string;
  webhookSecret?: string;
  active: boolean;
  lastRunAt?: string;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
};

export type ScheduleRun = {
  id: string;
  scheduleId: string;
  extractionJobId?: string;
  status: RunStatus;
  diffSummary?: SiteSnapshotDiff["summary"];
  error?: string;
  createdAt: string;
  completedAt?: string;
};

export type ContextAlert = {
  id: string;
  ownerId: string;
  scheduleId?: string;
  namespace: string;
  target: string;
  title: string;
  message: string;
  diffSummary?: SiteSnapshotDiff["summary"];
  createdAt: string;
  readAt?: string;
};

export type WebhookDelivery = {
  id: string;
  alertId: string;
  webhookUrl: string;
  status: "queued" | "sent" | "failed";
  statusCode?: number;
  error?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
};

export type VisualDiff = {
  baseRunId: string;
  compareRunId?: string;
  generatedAt: string;
  pages: Array<{
    routePath: string;
    status: "added" | "removed" | "changed" | "unchanged";
    beforeScreenshot?: string;
    afterScreenshot?: string;
    boxes: Array<{ x: number; y: number; width: number; height: number; label: string; tone: "added" | "removed" | "changed" }>;
    markdownDiff?: {
      added: string[];
      removed: string[];
    };
  }>;
};

export type ScreenshotArtifact = {
  routePath: string;
  url: string;
  path?: string;
  width: number;
  height: number;
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
  };
  status: "captured" | "failed";
  error?: string;
};

export type ComponentPreviewArtifact = {
  componentName: string;
  componentType: DesignComponent["type"];
  selector: string;
  routePath?: string;
  url?: string;
  path?: string;
  width?: number;
  height?: number;
  status: "captured" | "failed";
  error?: string;
};

export type PublishReadiness = {
  runId: string;
  outputDir: string;
  ready: boolean;
  routeCount: number;
  artifactCount: number;
  totalBytes: number;
  required: Array<{ path: string; exists: boolean; size?: number }>;
  optional: Array<{ path: string; exists: boolean; size?: number }>;
  warnings: string[];
  commands: {
    publish: string;
    update?: string;
  };
  files: ArtifactFileRecord[];
};

export type HtmlMetadata = {
  title?: string;
  description?: string;
  canonicalUrl?: string;
  language?: string;
  openGraph?: Record<string, string>;
  twitter?: Record<string, string>;
  icons?: string[];
};

export type ImageAsset = {
  src: string;
  absoluteUrl: string;
  previewUrl?: string;
  element: string;
  type: "url" | "inline-svg" | "data-uri" | "srcset" | "manifest" | "favicon";
  alt?: string;
  width?: number;
  height?: number;
  role?: string;
  contentType?: string;
  localPath?: string;
};

export type PageArtifact = {
  url: string;
  routePath?: string;
  title?: string;
  statusCode?: number;
  contentType?: string;
  markdown: string;
  html: string;
  text: string;
  metadata: HtmlMetadata;
  links: string[];
  images: ImageAsset[];
  contentHash: string;
  source?: {
    kind: "web" | "walrus";
    resourcePath?: string;
    blobId?: string;
    blobHash?: string;
    quiltPatchId?: string;
  };
};

export type SitemapResult = {
  target: string;
  urls: string[];
  meta: {
    sitemapsDiscovered: number;
    sitemapsFetched: number;
    sitemapsSkipped: number;
    errors: number;
  };
};

export type DiscoveryStats = {
  strategy: "web" | "walrus";
  profile?: BuildProfile;
  totalCandidates: number;
  pagesEmitted: number;
  skippedUtilityOrRedirect: number;
  sitemapSources: string[];
  markdownFallbacks: number;
  fetchErrors: number;
};

export type SiteStructureNodeKind =
  | "group"
  | "page"
  | "html"
  | "markdown"
  | "asset"
  | "brand"
  | "agent"
  | "context"
  | "walrus-resource";

export type SiteStructureNode = {
  id: string;
  label: string;
  kind: SiteStructureNodeKind;
  path?: string;
  contentType?: string;
  children?: SiteStructureNode[];
  route?: string;
  sourcePath?: string;
  artifactPath?: string;
  blobId?: string;
  blobHash?: string;
  resourcePath?: string;
  byteLength?: number;
};

export type SiteStructure = {
  target: string;
  generatedAt: string;
  summary: {
    pages: number;
    docs: number;
    assets: number;
    brandAssets: number;
    agentFiles: number;
    walrusResources: number;
  };
  nodes: SiteStructureNode[];
};

export type BrandProfile = {
  name?: string;
  domain?: string;
  description?: string;
  logos: ImageAsset[];
  colors: string[];
  fonts: string[];
  socials: string[];
  metadata: HtmlMetadata;
  confidence: number;
};

export type Styleguide = {
  mode: "light" | "dark" | "mixed" | "unknown";
  colors: {
    text?: string;
    background?: string;
    accent?: string;
    palette: string[];
    cssVariables: Record<string, string>;
  };
  typography: {
    fontFamilies: string[];
    headings: Record<string, Partial<CSSFontToken>>;
    body?: Partial<CSSFontToken>;
  };
  spacing: string[];
  radii: string[];
  shadows: string[];
  components: Record<string, Record<string, string>>;
};

export type DesignSystemProvenance = {
  routePath?: string;
  url?: string;
  selector?: string;
  cssProperty?: string;
  cssVariable?: string;
  resourcePath?: string;
  blobId?: string;
  blobHash?: string;
  quiltPatchId?: string;
};

export type DesignColorToken = {
  name: string;
  value: string;
  role: "brand" | "text" | "background" | "border" | "muted" | "success" | "warning" | "danger" | "info" | "link" | "accent" | "surface" | "raw";
  rawName?: string;
  aliases: string[];
  usage: string[];
  source?: DesignSystemProvenance;
};

export type DesignTypographyToken = Partial<CSSFontToken> & {
  name: string;
  selector?: string;
  usage: string[];
  source?: DesignSystemProvenance;
};

export type DesignComponentToken = {
  property: string;
  value: string;
  source?: DesignSystemProvenance;
};

export type DesignComponent = {
  name: string;
  type: "button" | "nav" | "card" | "input" | "tabs" | "code" | "alert" | "table" | "badge" | "link" | "layout";
  selectors: string[];
  tokens: DesignComponentToken[];
  states: Array<{
    name: "base" | "hover" | "focus" | "active" | "disabled" | "selected" | "unknown";
    tokens: DesignComponentToken[];
  }>;
  sourceRoutes: string[];
  previews?: ComponentPreviewArtifact[];
};

export type DesignAsset = {
  kind: "logo" | "favicon" | "icon" | "image" | "font" | "svg" | "og-image";
  label: string;
  url?: string;
  resourcePath?: string;
  contentType?: string;
  alt?: string;
  source?: DesignSystemProvenance;
};

export type DesignMotionToken = {
  name: string;
  property: "transition" | "animation" | "duration" | "easing" | "keyframes";
  value: string;
  source?: DesignSystemProvenance;
};

export type DesignSystem = {
  generatedAt: string;
  identity: {
    name?: string;
    domain?: string;
    description?: string;
    confidence: number;
    primaryLogo?: DesignAsset;
    favicon?: DesignAsset;
  };
  tokens: {
    colors: DesignColorToken[];
    rawPalette: string[];
    cssVariables: Record<string, string>;
    typography: {
      fontFamilies: string[];
      scale: DesignTypographyToken[];
      body?: DesignTypographyToken;
      headings: DesignTypographyToken[];
    };
    spacing: string[];
    radii: string[];
    shadows: string[];
    borders: string[];
    layout: {
      breakpoints: string[];
      maxWidths: string[];
      zIndices: string[];
    };
  };
  components: DesignComponent[];
  assets: DesignAsset[];
  motion: DesignMotionToken[];
  exports: {
    figmaTokens: string;
    styleDictionary: string;
    tailwindTheme: string;
    tokensCss: string;
    webBrandKit: string;
    videoBrandKit: string;
    markdown: string;
    rawJson: string;
  };
  provenance: {
    sourceRoutes: string[];
    resourcePaths: string[];
    walrusBlobIds: string[];
  };
};

export type CSSFontToken = {
  fontFamily: string;
  fontSize: string;
  fontWeight: string;
  lineHeight: string;
  letterSpacing: string;
};

export type AiDatapoint = {
  name: string;
  description: string;
  type: "text" | "number" | "boolean" | "list" | "object";
  example?: unknown;
};

export type AiQueryResult = {
  target: string;
  schema: AiDatapoint[];
  data: Record<string, unknown>;
  sources: Array<{
    url: string;
    routePath?: string;
    resourcePath?: string;
    blobId?: string;
    quote?: string;
  }>;
  confidence: number;
  usedProvider: "heuristic" | "openai-compatible";
};

export type WalrusResourceRecord = {
  path: string;
  dynamicFieldObjectId?: string;
  version?: string;
  headers: Record<string, string>;
  blobId: string;
  blobHash: string;
  range: { start: number | null; end: number | null } | null;
  quiltPatchInternalId?: string;
  quiltPatchId?: string;
  contentType?: string;
  aggregatorUrl?: string;
  byteLength?: number;
  verified?: boolean;
  cacheStatus?: "hit" | "miss" | "disabled";
  error?: string;
  localPath?: string;
};

export type WalrusSiteContext = {
  network: Network;
  siteObjectId: string;
  sitePackage: string;
  rpcUrl: string;
  aggregatorUrl: string;
  portalUrl?: string;
  suinsName?: string;
};

export type WalrusSiteHistoryEntry = {
  digest: string;
  timestampMs?: string;
  timestampIso?: string;
  sender?: string;
  action: "created" | "updated" | "deleted" | "unknown";
  status?: string;
  siteVersion?: string;
  previousVersion?: string;
  siteDigest?: string;
  functions: string[];
  resourcePaths: string[];
  resourceChanges: Array<{
    objectId?: string;
    type?: string;
    version?: string;
    previousVersion?: string;
    digest?: string;
  }>;
};

export type WalrusSiteHistory = {
  site: WalrusSiteContext;
  owner?: string;
  currentVersion?: string;
  currentDigest?: string;
  previousTransaction?: string;
  scannedTransactions: number;
  entries: WalrusSiteHistoryEntry[];
  warnings: string[];
};

export type WalrusPackageManifest = {
  runId: string;
  target: string;
  outputDir: string;
  contextDir: string;
  generatedAt: string;
  pages: PageArtifact[];
  sitemap?: SitemapResult;
  discovery?: DiscoveryStats;
  siteStructure?: SiteStructure;
  images: ImageAsset[];
  brand?: BrandProfile;
  styleguide?: Styleguide;
  designSystem?: DesignSystem;
  aiQuery?: AiQueryResult;
  screenshots?: ScreenshotArtifact[];
  componentPreviews?: ComponentPreviewArtifact[];
  walrus?: {
    site: WalrusSiteContext;
    resources: WalrusResourceRecord[];
  };
};
