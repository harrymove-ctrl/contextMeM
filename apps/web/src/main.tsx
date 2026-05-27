import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useNavigate, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertCircle, ArrowDownRight, Bell, Boxes, Brain, CalendarClock, CheckCircle2, Clipboard, Code2, Cpu, Database, Download, ExternalLink, Eye, FileText, FolderOpen, GitCompare, Globe2, Hash, History, Home, Image, KeyRound, LayoutGrid, ListTree, LoaderCircle, Maximize2, MessageSquare, Palette, Play, Search, Server, Settings, Share2, ShieldCheck, Sparkles, UserCheck, X, Zap } from "lucide-react";
import Auth1 from "./components/blocks/auth-1.js";
import Navigation10 from "./components/blocks/navigation-10.js";
import "./styles.css";

type DesignSystem = {
  identity: {
    name?: string;
    domain?: string;
    description?: string;
    confidence: number;
    primaryLogo?: { url?: string; resourcePath?: string };
    favicon?: { url?: string; resourcePath?: string };
  };
  framework?: { name: string; defaultsSubtracted: number };
  tokens: {
    colors: Array<{ name: string; value: string; role: string; source?: unknown }>;
    rawPalette: string[];
    cssVariables: Record<string, string>;
    typography: {
      fontFamilies: string[];
      scale: Array<TypographyToken>;
      body?: TypographyToken;
      headings: Array<TypographyToken>;
    };
    spacing: string[];
    radii: string[];
    shadows: string[];
    borders: string[];
    layout: { breakpoints: string[]; maxWidths: string[]; zIndices: string[] };
  };
  components: Array<{
    name: string;
    type: string;
    selectors: string[];
    tokens: Array<{ property: string; value: string }>;
    states: Array<{ name: string; tokens: Array<{ property: string; value: string }> }>;
    sourceRoutes: string[];
    previews?: ComponentPreviewArtifact[];
  }>;
  assets: Array<{ kind: string; label: string; url?: string; resourcePath?: string; contentType?: string; alt?: string }>;
  motion: Array<{ name: string; property: string; value: string }>;
  exports: Record<"figmaTokens" | "styleDictionary" | "tailwindTheme" | "tokensCss" | "webBrandKit" | "videoBrandKit" | "markdown" | "rawJson", string>;
};

type TypographyToken = {
  name: string;
  selector?: string;
  fontFamily?: string;
  fontSize?: string;
  fontWeight?: string;
  lineHeight?: string;
  letterSpacing?: string;
};

type RunResponse = {
  manifest: {
    runId: string;
    target: string;
    mode: "web" | "walrus" | "auto";
    status: string;
    createdAt?: string;
    updatedAt?: string;
    artifactDir: string;
    namespace: string;
    outputs?: string[];
    buildProfile?: BuildProfile;
    progress?: RunProgress;
    timings?: Record<string, number>;
    cacheStats?: RunCacheStats;
    errors: string[];
  };
  pages?: number;
  walrus?: {
    resources: number;
    pages: number;
  };
};

type BuildProfile = "fast" | "balanced" | "full";

type RunProgress = {
  phase: string;
  label?: string;
  itemsDone?: number;
  itemsTotal?: number;
  updatedAt: string;
};

type RunCacheStats = {
  hits: number;
  misses: number;
  writes: number;
  bytesRead: number;
  bytesWritten: number;
};

type ArtifactManifest = {
  runId?: string;
  target: string;
  generatedAt?: string;
  pages: Array<{ url: string; routePath?: string; artifactPath?: string; title?: string; markdown: string; source?: { blobId?: string; resourcePath?: string } }>;
  discovery?: {
    strategy: "web" | "walrus";
    profile?: BuildProfile;
    totalCandidates: number;
    pagesEmitted: number;
    skippedUtilityOrRedirect: number;
    sitemapSources: string[];
    markdownFallbacks: number;
    fetchErrors: number;
  };
  siteStructure?: SiteStructure;
  images: Array<{ src?: string; absoluteUrl: string; previewUrl?: string; role?: string; contentType?: string; type?: string; alt?: string; width?: number; height?: number }>;
  brand?: {
    name?: string;
    domain?: string;
    description?: string;
    colors: string[];
    fonts: string[];
    logos: Array<{ src?: string; absoluteUrl?: string; role?: string; contentType?: string; alt?: string; type?: string }>;
    socials: string[];
    confidence: number;
  };
  styleguide?: { colors: { palette: string[]; cssVariables: Record<string, string> }; typography: { fontFamilies: string[] }; radii: string[]; shadows: string[] };
  designSystem?: DesignSystem;
  walrus?: {
    site: { network: string; siteObjectId: string; aggregatorUrl: string; portalUrl?: string; suinsName?: string };
    resources: Array<{
      path: string;
      blobId: string;
      blobHash: string;
      quiltPatchId?: string;
      quiltPatchInternalId?: string;
      contentType?: string;
      aggregatorUrl?: string;
      byteLength?: number;
      verified?: boolean;
      error?: string;
    }>;
  };
  aiQuery?: AiQueryResult;
  screenshots?: ScreenshotArtifact[];
  componentPreviews?: ComponentPreviewArtifact[];
};

type SiteStructure = {
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

type SiteStructureNode = {
  id: string;
  label: string;
  kind: "group" | "page" | "html" | "markdown" | "asset" | "brand" | "agent" | "context" | "walrus-resource";
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

type RunHistoryItem = {
  runId: string;
  target: string;
  mode: "web" | "walrus" | "auto";
  status: string;
  namespace: string;
  updatedAt: string;
  pages: number;
  images: number;
  resources: number;
  hasDesignSystem: boolean;
  hasScreenshots: boolean;
  errors: string[];
};

type ArtifactFileRecord = {
  path: string;
  size: number;
  updatedAt: string;
  contentType: string;
  kind: "json" | "markdown" | "html" | "image" | "css" | "text" | "binary" | "other";
  group: "core" | "design-system" | "walrus" | "screenshots" | "package" | "pages" | "assets" | "other";
  previewable: boolean;
  downloadable: boolean;
};

type AiDatapoint = {
  name: string;
  description: string;
  type: "text" | "number" | "boolean" | "list" | "object";
  example?: unknown;
};

type AiQueryResult = {
  target: string;
  schema?: AiDatapoint[];
  data: Record<string, unknown>;
  confidence: number;
  usedProvider: string;
  sources: Array<{ url: string; routePath?: string; resourcePath?: string; blobId?: string; quote?: string }>;
};

type SiteSnapshotDiff = {
  baseRunId: string;
  compareRunId?: string;
  summary: Record<"pages" | "resources" | "images" | "designTokens", { added: number; removed: number; changed: number; unchanged: number }>;
  pages: Array<DiffEntry>;
  resources: Array<DiffEntry>;
  images: Array<DiffEntry>;
  designTokens: Array<DiffEntry>;
};

type DiffEntry = {
  key: string;
  status: "added" | "removed" | "changed" | "unchanged";
  before?: unknown;
  after?: unknown;
};

type PublishReadiness = {
  ready: boolean;
  routeCount: number;
  artifactCount: number;
  totalBytes: number;
  required: Array<{ path: string; exists: boolean; size?: number }>;
  optional: Array<{ path: string; exists: boolean; size?: number }>;
  warnings: string[];
  commands: { publish: string; update?: string };
  files: ArtifactFileRecord[];
};

type HostedNamespaceImportResponse = {
  namespace: string;
  target: string;
  sourceRunId?: string;
  versionId: string;
  visibility: "private" | "public";
  displayName?: string;
  description?: string;
  tags?: string[];
  sourceType?: string;
  directoryEnabled?: boolean;
  artifactCount: number;
  byteLength: number;
  mcpUrl: string;
  gatewayMcpUrl?: string;
  readToken: string;
  snippets: {
    claudeDesktop?: unknown;
    cursor?: unknown;
    codex?: unknown;
    generic: unknown;
    contextMcpGateway?: unknown;
    mcpRemote: unknown;
  };
};

type HostedNamespaceSummary = Omit<HostedNamespaceImportResponse, "readToken" | "snippets"> & {
  ownerId?: string;
  createdAt: string;
  updatedAt: string;
};

type MarkdownViewMode = "preview" | "raw";
type MarkdownPage = ArtifactManifest["pages"][number];
type MarkdownAnchorProps = React.ComponentPropsWithoutRef<"a"> & { node?: unknown };

type HostedNamespaceToken = {
  id: string;
  label: string;
  hashPrefix: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  revoked: boolean;
};

type HostedExtractionJob = {
  id: string;
  ownerId: string;
  namespace: string;
  target: string;
  status: "queued" | "running" | "completed" | "failed";
  visibility: "private" | "public";
  displayName?: string;
  description?: string;
  tags?: string[];
  directoryEnabled?: boolean;
  result?: HostedNamespaceImportResponse;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

type DemoPreviewPhase = "starting" | "queued" | "running" | "completed" | "failed";

type DemoPreviewState = {
  phase: DemoPreviewPhase;
  target: string;
  message: string;
  jobId?: string;
  shareId?: string;
  updatedAt: number;
};

type ShareLinkResponse = {
  share: {
    id: string;
    namespace: string;
    target: string;
    title?: string;
    description?: string;
    sourceRunId?: string;
    versionId: string;
    artifactCount: number;
    byteLength: number;
    url: string;
    mcpUrl: string;
    createdAt: string;
    updatedAt: string;
  };
  manifest?: ArtifactManifest;
};

type VisualDiff = {
  baseRunId: string;
  compareRunId?: string;
  generatedAt: string;
  pages: Array<{
    routePath: string;
    status: "added" | "removed" | "changed" | "unchanged";
    beforeScreenshot?: string;
    afterScreenshot?: string;
    boxes: Array<{ x: number; y: number; width: number; height: number; label: string; tone: "added" | "removed" | "changed" }>;
    markdownDiff?: { added: string[]; removed: string[] };
  }>;
};

type HostedSchedule = {
  id: string;
  ownerId: string;
  namespace: string;
  target: string;
  intervalHours: number;
  webhookUrl?: string;
  active: boolean;
  lastRunAt?: string;
  nextRunAt: string;
  createdAt: string;
  updatedAt: string;
};

type ContextAlert = {
  id: string;
  scheduleId?: string;
  namespace: string;
  target: string;
  title: string;
  message: string;
  diffSummary?: SiteSnapshotDiff["summary"];
  createdAt: string;
  readAt?: string;
};

type ScreenshotArtifact = {
  routePath: string;
  url: string;
  path?: string;
  status: "captured" | "failed";
  error?: string;
};

type ComponentPreviewArtifact = {
  componentName: string;
  componentType: string;
  selector: string;
  routePath?: string;
  url?: string;
  path?: string;
  status: "captured" | "failed";
  error?: string;
};

type WalrusSiteHistory = {
  owner?: string;
  currentVersion?: string;
  currentDigest?: string;
  previousTransaction?: string;
  scannedTransactions: number;
  entries: Array<{
    digest: string;
    timestampIso?: string;
    sender?: string;
    action: "created" | "updated" | "deleted" | "unknown";
    status?: string;
    siteVersion?: string;
    previousVersion?: string;
    siteDigest?: string;
    functions: string[];
    resourcePaths: string[];
    resourceChanges: Array<{ objectId?: string; type?: string; version?: string; previousVersion?: string; digest?: string }>;
  }>;
  warnings: string[];
};

type AccountMe = {
  authenticated: boolean;
  account: {
    id: string;
    ownerAddress: string;
    provider: "unknown";
    memwalAccountId?: string;
    hasDelegateKey: boolean;
    createdAt: string;
    updatedAt: string;
  } | null;
  quota: {
    limit: number;
    used: number;
    remaining: number;
    resetAt?: string;
    unlimited?: boolean;
  };
  access: {
    canPreview: boolean;
    canRun: boolean;
    reason: string;
  };
};

type MemWalConnectResponse = {
  status: "imported-local-credentials" | "account-mismatch" | "credentials-missing" | "credentials-invalid";
  imported: boolean;
  me?: AccountMe;
  message: string;
  commands?: string[];
  requiredQuery?: string[];
};

type DelegateImportResponse = AccountMe | { token: string; me: AccountMe };

type MemWalNotice = {
  tone: "success" | "warning" | "info";
  message: string;
  command?: string;
};

const API_BASE = import.meta.env.VITE_CONTEXTMEM_API_BASE ?? "http://localhost:8791";
const showDevMemWalAuth = import.meta.env.DEV && !import.meta.env.PROD && (import.meta.env.VITE_CONTEXTMEM_DEV_AUTH === "true" || new URLSearchParams(window.location.search).get("devAuth") === "1");
const buildProfileDefaults: Record<BuildProfile, string[]> = {
  fast: ["markdown", "sitemap"],
  balanced: ["markdown", "images", "brand", "styleguide", "sitemap"],
  full: ["markdown", "images", "brand", "styleguide", "sitemap", "screenshots"]
};
const buildProfiles: Array<{ id: BuildProfile; label: string; detail: string }> = [
  { id: "fast", label: "Fast", detail: "Context first" },
  { id: "balanced", label: "Balanced", detail: "No screenshots" },
  { id: "full", label: "Full", detail: "Rich visual pass" }
];
const outputOptions: Array<{ id: string; label: string; detail?: string }> = [
  { id: "markdown", label: "markdown" },
  { id: "images", label: "images" },
  { id: "brand", label: "brand" },
  { id: "styleguide", label: "styleguide" },
  { id: "sitemap", label: "sitemap" },
  { id: "screenshots", label: "screenshots", detail: "slower/full" }
];
const launchOptions = readLaunchOptions();
const revealHeadline = "ContextMeM turns Walrus Sites into portable agent context with verified resources, markdown, assets, visual systems, onchain provenance, and MemWal recall.";
const revealWords = revealHeadline.split(" ");
const loopItems = ["Walrus Sites", ".wal.app", "Sui object IDs", "Walrus resources", "Markdown", "Design tokens", "Screenshots", "MemWal"];
const showcaseCards = [
  { title: "Resolve", detail: "Resolve .wal.app names, Walrus object IDs, and fallback web URLs into a target map.", icon: Search },
  { title: "Verify", detail: "Check Sui provenance, Walrus blob IDs, hashes, routes, and resource metadata.", icon: ShieldCheck },
  { title: "Package", detail: "Bundle markdown, screenshots, assets, design tokens, and resource manifests for agents.", icon: Boxes },
  { title: "Remember", detail: "Sync verified context into MemWal account memory for future agent recall.", icon: Brain }
];
const sdkImportTitle = "Import MemWal SDK credentials";
const sdkImportBody = "Paste your MemWal account ID and delegate private key. ContextMeM stores the delegate encrypted and unlocks verified Walrus context.";
const memwalDashboardUrl = "https://memwal.ai/dashboard";

const anonymousMe: AccountMe = {
  authenticated: false,
  account: null,
  quota: { limit: 1, used: 0, remaining: 0 },
  access: {
    canPreview: true,
    canRun: false,
    reason: "Import MemWal SDK credentials for verified recall and memory."
  }
};

function App() {
  return (
    <BrowserRouter>
      <ContextMemExperience />
    </BrowserRouter>
  );
}

function ContextMemExperience() {
  const navigate = useNavigate();
  const [target, setTarget] = useState(launchOptions.target);
  const [customNamespace, setCustomNamespace] = useState("");
  const [customDisplayName, setCustomDisplayName] = useState("");
  const [mode, setMode] = useState<"auto" | "web" | "walrus">(launchOptions.mode);
  const [buildProfile, setBuildProfile] = useState<BuildProfile>("balanced");
  const [outputs, setOutputs] = useState<string[]>(buildProfileDefaults.balanced);
  const [run, setRun] = useState<RunResponse | null>(null);
  const [artifact, setArtifact] = useState<ArtifactManifest | null>(null);
  const [history, setHistory] = useState<RunHistoryItem[]>([]);
  const [activeTab, setActiveTab] = useState("Markdown");
  const [busy, setBusy] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authHint, setAuthHint] = useState("");
  const [hostedBuildResult, setHostedBuildResult] = useState<{ shareId: string; namespace: string; shareUrl: string; mcpUrl: string } | null>(null);
  const [memwalNotice, setMemwalNotice] = useState<MemWalNotice | null>(null);
  const [demoPreview, setDemoPreview] = useState<DemoPreviewState | null>(null);
  const [me, setMe] = useState<AccountMe>(anonymousMe);
  const [sessionToken, setSessionToken] = useState(() => window.localStorage.getItem("contextmem.session") ?? "");
  const [delegateAccountId, setDelegateAccountId] = useState("");
  const [delegateKey, setDelegateKey] = useState("");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const memwalAccount = params.get("memwalAccountId") ?? params.get("delegateAccountId");
    const memwalKey = params.get("memwalDelegateKey") ?? params.get("delegateKey");
    if (!memwalAccount && !memwalKey) return;
    if (memwalAccount) setDelegateAccountId(memwalAccount);
    if (memwalKey) setDelegateKey(memwalKey);
    const cleanUrl = window.location.pathname + window.location.hash;
    window.history.replaceState({}, "", cleanUrl);
    if (!window.location.pathname.startsWith("/app/settings")) navigate("/app/settings");
  }, [navigate]);
  const didAutorun = useRef(false);
  const heroRef = useRef<HTMLElement>(null);
  const headlineRef = useRef<HTMLElement>(null);
  const [heroOffset, setHeroOffset] = useState({ x: 0, y: 0 });
  const [headlineProgress, setHeadlineProgress] = useState(0);
  const runNetwork = "mainnet";
  const hasMemWalDelegate = Boolean(me.authenticated && me.account?.hasDelegateKey);
  const canBuild = Boolean(hasMemWalDelegate);
  const canImportSdkCredentials = true;
  const isHostedApiBase = !isLocalApiBase(API_BASE);
  const quotaLabel = me.authenticated ? (me.quota.unlimited ? "full" : `${me.quota.remaining}/${me.quota.limit}`) : "import";
  const primaryActionLabel = busy ? "Running" : hasMemWalDelegate ? "Build context" : "Import credentials";
  const compactPrimaryActionLabel = busy ? "Running" : hasMemWalDelegate ? "Build" : "Import";

  const stats = useMemo(() => {
    return [
      { label: "Pages", value: artifact?.pages.length ?? run?.pages ?? run?.walrus?.pages ?? 0, icon: FileText },
      { label: "Images", value: artifact?.images.length ?? 0, icon: Image },
      { label: "Resources", value: artifact?.walrus?.resources.length ?? run?.walrus?.resources ?? 0, icon: Boxes },
      ...(artifact?.discovery ? [{ label: "Discovery", value: `${artifact.discovery.pagesEmitted}/${artifact.discovery.totalCandidates}`, icon: Search }] : []),
      { label: "Namespace", value: run?.manifest.namespace ?? "not synced", icon: Database }
    ];
  }, [artifact, run]);

  const heroMetrics = useMemo(() => {
    return [
      { label: "mode", value: mode, icon: Sparkles },
      { label: "network", value: runNetwork, icon: Globe2 },
      { label: "quota", value: quotaLabel, icon: ShieldCheck }
    ];
  }, [mode, quotaLabel, runNetwork]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const callbackSession = params.get("contextmem_session");
    const memwalStatus = params.get("memwal");
    if (callbackSession) {
      window.localStorage.setItem("contextmem.session", callbackSession);
      setSessionToken(callbackSession);
      setAuthHint("MemWal connected. ContextMeM session restored.");
      setMemwalNotice({ tone: "success", message: "MemWal connected. SDK delegate is ready for ContextMeM." });
      params.delete("contextmem_session");
      params.delete("memwal");
      const nextQuery = params.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${nextQuery ? `?${nextQuery}` : ""}${window.location.hash}`);
    } else if (memwalStatus && memwalStatus !== "connected") {
      setMemwalNotice({ tone: "warning", message: `MemWal auth did not finish: ${memwalStatus.replaceAll("_", " ")}.` });
    }
  }, []);

  useEffect(() => {
    if (!launchOptions.autorun || didAutorun.current || !target || !canBuild) return;
    didAutorun.current = true;
    void startRun();
  }, [canBuild]);

  useEffect(() => {
    void loadMe(sessionToken);
  }, [sessionToken]);

  useEffect(() => {
    if (me.authenticated) void refreshHistory();
    else setHistory([]);
  }, [me.authenticated, sessionToken]);

  useEffect(() => {
    const section = headlineRef.current;
    if (!section) return;

    let frame = 0;
    const updateProgress = () => {
      frame = 0;
      const rect = section.getBoundingClientRect();
      const start = window.innerHeight * 0.9;
      const end = window.innerHeight * 0.52;
      const nextProgress = Math.min(1, Math.max(0, (start - rect.top) / (start - end)));
      setHeadlineProgress(nextProgress);
    };
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(updateProgress);
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    updateProgress();

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  function handleHeroMouseMove(event: React.MouseEvent<HTMLElement>) {
    if (!heroRef.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const rect = heroRef.current.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width - 0.5) * 34;
    const y = ((event.clientY - rect.top) / rect.height - 0.5) * 34;
    setHeroOffset({ x, y });
  }

  function resetHeroMotion() {
    setHeroOffset({ x: 0, y: 0 });
  }

  function openApp(path = "/app") {
    navigate(path);
    window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  }

  async function loadMe(token = sessionToken) {
    if (isHostedApiBase) {
      const stored = readHostedDelegate();
      if (stored) {
        setMe(hostedBrowserMe(stored));
        return;
      }
      setMe(anonymousMe);
      return;
    }
    try {
      const response = await fetch(`${API_BASE}/api/me`, { headers: authHeaders(token) });
      if (!response.ok) throw new Error(await readResponseError(response));
      const nextMe = (await response.json()) as AccountMe;
      setMe(nextMe);
      if (!nextMe.authenticated) {
        window.localStorage.removeItem("contextmem.session");
        setSessionToken("");
      }
    } catch {
      setMe(anonymousMe);
      window.localStorage.removeItem("contextmem.session");
      if (token) setSessionToken("");
    }
  }

  function logout() {
    window.localStorage.removeItem("contextmem.session");
    window.localStorage.removeItem("contextmem.hostedDelegate");
    setSessionToken("");
    setMe(anonymousMe);
    setRun(null);
    setArtifact(null);
    setHistory([]);
    setMemwalNotice(null);
  }

  async function attachLocalMemWal() {
    if (!me.authenticated) {
      const message = "Import MemWal SDK credentials first, then local MCP credentials can be attached in dev mode.";
      setAuthHint(message);
      setMemwalNotice({ tone: "info", message });
      return;
    }
    setAuthBusy(true);
    setError(null);
    setMemwalNotice(null);
    try {
      const response = await fetch(`${API_BASE}/api/memwal/connect`, {
        method: "POST",
        headers: authHeaders(sessionToken, { "content-type": "application/json" }),
        body: JSON.stringify({ mode: "local" })
      });
      if (!response.ok) throw new Error(await readResponseError(response));
      const result = (await response.json()) as MemWalConnectResponse;
      if (result.imported && result.me) {
        setMe(result.me);
        setAuthHint("Local MemWal MCP credentials attached for dev. Delegate key stays server-side.");
        setMemwalNotice({ tone: "success", message: "Local MemWal MCP credentials attached for dev. Delegate key stays encrypted on the ContextMeM API." });
        return;
      }
      const command = result.commands?.[0];
      const tone = result.status === "account-mismatch" || result.status === "credentials-invalid" ? "warning" : "info";
      setMemwalNotice({ tone, message: result.message, command });
      setAuthHint(command ? `Local MCP dev attach needs MemWal MCP login. Copy/run: ${command}` : result.message);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setMemwalNotice({ tone: "warning", message });
    } finally {
      setAuthBusy(false);
    }
  }

  async function importDelegate() {
    const accountId = delegateAccountId.trim();
    const key = delegateKey.trim();
    if (!accountId || key.length < 12) {
      const message = "Paste both your MemWal account ID and a delegate private key (12+ chars).";
      setError(message);
      setMemwalNotice({ tone: "warning", message });
      return;
    }
    if (isHostedApiBase) {
      try {
        window.localStorage.setItem(
          "contextmem.hostedDelegate",
          JSON.stringify({ memwalAccountId: accountId, delegateKey: key })
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "Could not persist delegate to browser storage.";
        setError(message);
        setMemwalNotice({ tone: "warning", message });
        return;
      }
      setMe(hostedBrowserMe({ memwalAccountId: accountId, delegateKey: key }));
      setDelegateAccountId("");
      setDelegateKey("");
      setAuthHint("MemWal delegate stored for this browser session and sent to the hosted API only when you run private ContextMeM requests.");
      setMemwalNotice({
        tone: "success",
        message: "Delegate ready on the hosted app. The Worker accepts it for prod testing and does not persist the private key server-side."
      });
      return;
    }
    setAuthBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/memwal/import-delegate`, {
        method: "POST",
        headers: sessionToken ? authHeaders(sessionToken, { "content-type": "application/json" }) : { "content-type": "application/json" },
        body: JSON.stringify({ memwalAccountId: accountId, delegateKey: key })
      });
      if (!response.ok) throw new Error(await readResponseError(response));
      const result = (await response.json()) as DelegateImportResponse;
      const nextMe = "me" in result ? result.me : result;
      if ("token" in result) {
        window.localStorage.setItem("contextmem.session", result.token);
        setSessionToken(result.token);
      }
      setMe(nextMe);
      setDelegateAccountId("");
      setDelegateKey("");
      setAuthHint("MemWal delegate imported. ContextMeM will use it server-side.");
      setMemwalNotice({ tone: "success", message: "SDK credentials imported. The delegate key was sent once and is stored encrypted server-side." });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setMemwalNotice({ tone: "warning", message });
    } finally {
      setDelegateKey("");
      setAuthBusy(false);
    }
  }

  async function refreshHistory() {
    if (!sessionToken) return;
    try {
      const response = await fetch(`${API_BASE}/api/runs?limit=25`, { headers: authHeaders(sessionToken) });
      if (response.ok) setHistory((await response.json()) as RunHistoryItem[]);
    } catch {
      // History should never block extraction.
    }
  }

  async function openRun(runId: string) {
    setBusy(true);
    setError(null);
    try {
      const [manifestResponse, artifactResponse] = await Promise.all([fetch(`${API_BASE}/api/runs/${runId}`, { headers: authHeaders(sessionToken) }), fetch(`${API_BASE}/api/runs/${runId}/artifacts`, { headers: authHeaders(sessionToken) })]);
      if (!manifestResponse.ok) throw new Error(await readResponseError(manifestResponse));
      if (!artifactResponse.ok) throw new Error(await readResponseError(artifactResponse));
      const manifest = (await manifestResponse.json()) as RunResponse["manifest"];
      const nextArtifact = (await artifactResponse.json()) as ArtifactManifest;
      setRun({ manifest });
      setArtifact(nextArtifact);
      setTarget(manifest.target);
      if (manifest.buildProfile) setBuildProfile(manifest.buildProfile);
      if (manifest.outputs?.length) setOutputs(manifest.outputs);
      setActiveTab(nextArtifact.designSystem ? "Design System" : "Markdown");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function startRun() {
    if (!hasMemWalDelegate) {
      setError("Import MemWal SDK credentials before building context.");
      return;
    }
    if (isHostedApiBase) {
      await startRunHosted();
      return;
    }
    setBusy(true);
    setError(null);
    setRun(null);
    setArtifact(null);
    try {
      const response = await fetch(`${API_BASE}/api/runs`, {
        method: "POST",
        headers: authHeaders(sessionToken, { "content-type": "application/json" }),
        body: JSON.stringify({
          target,
          mode,
          network: runNetwork,
          buildProfile,
          outputs,
          background: true,
          crawlOptions: { maxPages: 12, maxDepth: 2, includeImages: outputs.includes("images"), includeLinks: true, concurrency: 6 }
        })
      });
      if (!response.ok) throw new Error(await readResponseError(response));
      const data = (await response.json()) as RunResponse;
      setRun(data);
      const completedManifest = data.manifest.status === "completed" ? data.manifest : await waitForRun(data.manifest.runId);
      setRun({ manifest: completedManifest });
      const artifacts = await fetch(`${API_BASE}/api/runs/${completedManifest.runId}/artifacts`, { headers: authHeaders(sessionToken) });
      if (artifacts.ok) {
        const nextArtifact = (await artifacts.json()) as ArtifactManifest;
        setArtifact(nextArtifact);
        setActiveTab(nextArtifact.designSystem ? "Design System" : nextArtifact.walrus ? "Walrus Resources" : "Markdown");
      } else if (data.walrus) {
        setActiveTab("Walrus Resources");
      }
      await Promise.allSettled([refreshHistory(), loadMe(sessionToken)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function startRunHosted() {
    const requestedTarget = target.trim();
    if (!requestedTarget) {
      setError("Paste a Walrus Site URL, Walrus object ID, or public web URL.");
      return;
    }
    setBusy(true);
    setError(null);
    setRun(null);
    setArtifact(null);
    try {
      const createRes = await fetch(`${API_BASE}/api/demo/extractions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...hostedDelegateHeaders() },
        body: JSON.stringify({
          target: requestedTarget,
          ...(customNamespace.trim() ? { namespace: customNamespace.trim() } : {}),
          ...(customDisplayName.trim() ? { displayName: customDisplayName.trim() } : {})
        })
      });
      if (!createRes.ok) throw new Error(await readResponseError(createRes));
      let body = (await createRes.json()) as { job: HostedExtractionJob };
      const jobId = body.job.id;
      for (let attempt = 0; attempt < 60 && (body.job.status === "queued" || body.job.status === "running"); attempt += 1) {
        await delay(900);
        const poll = await fetch(`${API_BASE}/api/demo/extractions/${encodeURIComponent(jobId)}`);
        if (!poll.ok) throw new Error(await readResponseError(poll));
        const next = (await poll.json()) as { job?: HostedExtractionJob } | HostedExtractionJob;
        body = { job: ("job" in next ? next.job : next) as HostedExtractionJob };
      }
      if (body.job.status !== "completed") {
        throw new Error(body.job.error ?? "Hosted context build did not finish in time.");
      }
      const result = (body.job.result ?? {}) as { share?: { id?: string } };
      const shareId = result.share?.id;
      if (!shareId) throw new Error("Hosted build completed without a share artifact.");
      const [shareResp, artifactResp] = await Promise.all([
        fetch(`${API_BASE}/api/share-links/${encodeURIComponent(shareId)}`),
        fetch(`${API_BASE}/api/share-links/${encodeURIComponent(shareId)}/artifacts`)
      ]);
      if (!shareResp.ok) throw new Error(await readResponseError(shareResp));
      const shareData = (await shareResp.json()) as { manifest?: ArtifactManifest };
      const manifest = shareData.manifest;
      if (manifest) {
        setArtifact(manifest);
        setActiveTab(manifest.designSystem ? "Design System" : manifest.walrus ? "Walrus Resources" : "Markdown");
        setRun({
          manifest: {
            runId: body.job.id,
            target: body.job.target,
            namespace: body.job.namespace,
            artifactDir: `share/${shareId}`,
            mode: body.job.target.includes(".wal.app") ? "walrus" : "web",
            status: "completed",
            pages: manifest.pages?.length ?? 0,
            images: manifest.images?.length ?? 0,
            resources: manifest.walrus?.resources?.length ?? 0,
            errors: [],
            updatedAt: new Date().toISOString(),
            walrus: manifest.walrus
          } as unknown as RunResponse["manifest"]
        });
      }
      const shareUrl = `${window.location.origin}/share/${shareId}`;
      const mcpUrl = `${window.location.origin}/mcp?namespace=${encodeURIComponent(body.job.namespace)}`;
      setHostedBuildResult({ shareId, namespace: body.job.namespace, shareUrl, mcpUrl });
      setAuthHint(`Hosted build complete. Public share + MCP endpoint below.`);
      if (artifactResp.ok) {
        // artifact list refreshed - not used directly, the manifest already populates tabs
        void artifactResp;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function waitForRun(runId: string): Promise<RunResponse["manifest"]> {
    try {
      const streamed = await streamRunEvents(runId, sessionToken, (event) => {
        setRun((current) => {
          if (!current || current.manifest.runId !== runId) return current;
          return {
            manifest: {
              ...current.manifest,
              status: event.status,
              progress: event.progress ?? current.manifest.progress,
              updatedAt: event.updatedAt ?? current.manifest.updatedAt
            }
          };
        });
      });
      if (streamed.status === "completed") return streamed;
      if (streamed.status === "failed") throw new Error(streamed.errors?.[0] ?? "Context build failed.");
    } catch {
      // Older dev servers may not expose SSE yet; polling keeps the build usable.
    }
    for (;;) {
      await delay(650);
      const response = await fetch(`${API_BASE}/api/runs/${runId}`, { headers: authHeaders(sessionToken) });
      if (!response.ok) throw new Error(await readResponseError(response));
      const manifest = (await response.json()) as RunResponse["manifest"];
      setRun({ manifest });
      if (manifest.status === "completed") return manifest;
      if (manifest.status === "failed") throw new Error(manifest.errors?.[0] ?? "Context build failed.");
    }
  }

  async function remember() {
    if (!run) return;
    if (!hasMemWalDelegate) {
      setError("Import MemWal SDK credentials before remembering context.");
      return;
    }
    if (isHostedApiBase) {
      setMemwalNotice({
        tone: "info",
        message: "Remember/recall round-trip needs the local ContextMeM API. On the public site the share page already exposes verified context via the hosted MCP namespace shown in the result."
      });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/runs/${run.manifest.runId}/memwal/remember`, { method: "POST", headers: authHeaders(sessionToken) });
      if (!response.ok) throw new Error(await readResponseError(response));
      const result = await response.json();
      setError(`MemWal remembered namespace: ${result.namespace}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(isUnavailableMessage(message) ? `MemWal unavailable: ${message}` : message);
    } finally {
      setBusy(false);
    }
  }

  async function openRunAndViewArtifacts(runId: string) {
    await openRun(runId);
    openApp("/app/artifacts");
  }

  async function startRunFromLanding() {
    if (!hasMemWalDelegate) {
      if (isLocalApiBase(API_BASE)) {
        openApp("/app");
        return;
      }
      await startDemoExtraction();
      return;
    }
    openApp("/app");
    await startRun();
  }

  async function startDemoExtraction() {
    const requestedTarget = target.trim();
    const displayTarget = requestedTarget || "curated Walrus Site sample";
    setBusy(true);
    setError(null);
    setAuthHint("");
    setDemoPreview({
      phase: "starting",
      target: displayTarget,
      message: "Starting hosted preview",
      updatedAt: Date.now()
    });
    let lastJob: HostedExtractionJob | null = null;
    try {
      const response = await fetch(`${API_BASE}/api/demo/extractions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target: requestedTarget || undefined, sample: !requestedTarget })
      });
      if (!response.ok) throw new Error(await readResponseError(response));
      let body = (await response.json()) as { job: HostedExtractionJob; demo?: { remainingToday?: number } };
      lastJob = body.job;
      setDemoPreview(demoPreviewStateFromJob(body.job, displayTarget));
      for (let attempt = 0; attempt < 20 && (body.job.status === "queued" || body.job.status === "running"); attempt += 1) {
        await delay(800);
        const status = await fetch(`${API_BASE}/api/demo/extractions/${encodeURIComponent(body.job.id)}`);
        if (!status.ok) throw new Error(await readResponseError(status));
        body = (await status.json()) as { job: HostedExtractionJob };
        lastJob = body.job;
        setDemoPreview(demoPreviewStateFromJob(body.job, displayTarget));
      }
      const shareId = (body.job.result as { share?: { id?: string } } | undefined)?.share?.id;
      if (!shareId) throw new Error(body.job.error ?? "Demo extraction finished without a share page.");
      setDemoPreview({
        phase: "completed",
        target: body.job.target || displayTarget,
        jobId: body.job.id,
        shareId,
        message: "Preview ready. Opening share page",
        updatedAt: Date.now()
      });
      navigate(`/share/${shareId}`);
      window.requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "smooth" }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setDemoPreview({
        phase: "failed",
        target: lastJob?.target || displayTarget,
        jobId: lastJob?.id,
        message,
        updatedAt: Date.now()
      });
      setAuthHint(message);
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  const statusLabel = hasMemWalDelegate ? "MemWal ready" : "SDK import needed";
  const statusTone: "ready" | "needsMemWal" | "preview" = hasMemWalDelegate ? "ready" : "needsMemWal";
  const sessionSlot = me.authenticated ? (
    <button className="sessionButton" onClick={logout}>
      <UserCheck size={15} />
      {compactHash(me.account?.memwalAccountId ?? me.account?.ownerAddress ?? "")}
    </button>
  ) : null;
  const lockScreen = (
    <LockedPreview
      authenticated={me.authenticated}
      authBusy={authBusy}
      notice={memwalNotice}
      delegateAccountId={delegateAccountId}
      delegateKey={delegateKey}
      setDelegateAccountId={setDelegateAccountId}
      setDelegateKey={setDelegateKey}
      onImport={importDelegate}
      canImportSdkCredentials={canImportSdkCredentials}
      previewBusy={busy}
      onPreviewDemo={startDemoExtraction}
      target={target}
      setTarget={setTarget}
    />
  );
  const buildPage = (
    <BuildConsolePage
      target={target}
      setTarget={setTarget}
      mode={mode}
      setMode={setMode}
      buildProfile={buildProfile}
      setBuildProfile={setBuildProfile}
      outputs={outputs}
      setOutputs={setOutputs}
      busy={busy}
      error={error}
      run={run}
      artifact={artifact}
      stats={stats}
      activeTab={activeTab}
      setActiveTab={setActiveTab}
      setArtifact={setArtifact}
      history={history}
      refreshHistory={refreshHistory}
      authToken={sessionToken}
      accountLabel={me.account?.memwalAccountId ?? me.account?.ownerAddress ?? ""}
      primaryActionLabel={primaryActionLabel}
      onStartRun={startRun}
      onRemember={remember}
      hasMemWalDelegate={hasMemWalDelegate}
      hostedBuildResult={hostedBuildResult}
      customNamespace={customNamespace}
      setCustomNamespace={setCustomNamespace}
      customDisplayName={customDisplayName}
      setCustomDisplayName={setCustomDisplayName}
      isHostedApiBase={isHostedApiBase}
    />
  );

  function renderShell(pageTitle: string, pageDescription: string, child: React.ReactNode) {
    const lockedContent = (
      <>
        {demoPreview ? <DemoPreviewAppPanel preview={demoPreview} onBackHome={() => openApp("/")} /> : null}
        {lockScreen}
      </>
    );
    return (
      <AppShell
        pageTitle={pageTitle}
        pageDescription={pageDescription}
        statusLabel={statusLabel}
        statusTone={statusTone}
        authHint={authHint}
        sessionSlot={sessionSlot}
        hasMemWalDelegate={hasMemWalDelegate}
        run={run}
      >
        {hasMemWalDelegate ? child : lockedContent}
      </AppShell>
    );
  }

  return (
    <>
      <Routes>
      <Route
        path="/"
        element={
          <LandingPage
            target={target}
            setTarget={setTarget}
            busy={busy}
            demoPreview={demoPreview}
            hasMemWalDelegate={hasMemWalDelegate}
            compactPrimaryActionLabel={compactPrimaryActionLabel}
            statusLabel={statusLabel}
            statusTone={statusTone}
            sessionSlot={sessionSlot}
            authHint={authHint}
            heroRef={heroRef}
            heroOffset={heroOffset}
            headlineRef={headlineRef}
            headlineProgress={headlineProgress}
            heroMetrics={heroMetrics}
            onHeroMouseMove={handleHeroMouseMove}
            onHeroMouseLeave={resetHeroMotion}
            onHeroAction={startRunFromLanding}
            onOpenApp={() => openApp("/app")}
            onInspectArtifacts={() => openApp("/app/artifacts")}
            onOpenHistory={() => openApp("/app/runs")}
          />
        }
      />
      <Route path="/share/:shareId" element={<SharePage />} />
      <Route path="/showcase" element={<ShowcasePage />} />
      <Route path="/app" element={renderShell("Build console", "Resolve a Walrus Site, verify resources, then generate a context package.", buildPage)} />
      <Route
        path="/app/artifacts"
        element={renderShell(
          "Artifacts",
          "Browse generated markdown, manifests, screenshots, and file previews for the selected run.",
          <ArtifactsAppPage stats={stats} run={run} artifact={artifact} authToken={sessionToken} setArtifact={setArtifact} history={history} accountLabel={me.account?.memwalAccountId ?? me.account?.ownerAddress ?? ""} />
        )}
      />
      <Route
        path="/app/runs"
        element={renderShell(
          "Runs",
          "Review previous context packages and reopen any run into the artifact browser.",
          <RunsAppPage history={history} busy={busy} currentRunId={run?.manifest.runId} onRefresh={refreshHistory} onOpenRun={openRunAndViewArtifacts} />
        )}
      />
      <Route
        path="/app/memory"
        element={renderShell(
          "MemWal memory",
          "Recall and remember verified context namespaces from the active package.",
          <MemoryAppPage artifact={artifact} run={run} history={history} refreshHistory={refreshHistory} authToken={sessionToken} onRemember={remember} busy={busy} />
        )}
      />
      <Route path="/app/compare" element={renderShell("Compare", "Pick two runs and review brand, design tokens, and key facts side-by-side.", <CompareAppPage history={history} authToken={sessionToken} />)} />
      <Route path="/app/publish" element={renderShell("Publish", "Check readiness and copy the commands needed to publish the context package.", <PublishPanel run={run} authToken={sessionToken} />)} />
      <Route path="/app/namespaces" element={renderShell("Namespaces", "Manage hosted ContextMCP namespaces, tokens, public directory entries, and Cloudflare extraction jobs.", <NamespacesAppPage authToken={sessionToken} />)} />
      <Route
        path="/app/settings"
        element={renderShell(
          "Settings",
          isLocalApiBase(API_BASE)
            ? "Manage MemWal delegate status and encrypted server-side credentials."
            : "Manage MemWal delegate status for hosted prod testing.",
          <SettingsAppPage
            me={me}
            quotaLabel={quotaLabel}
            hasMemWalDelegate={hasMemWalDelegate}
            authBusy={authBusy}
            delegateAccountId={delegateAccountId}
            delegateKey={delegateKey}
            setDelegateAccountId={setDelegateAccountId}
            setDelegateKey={setDelegateKey}
            onImport={importDelegate}
            notice={memwalNotice}
            canImportSdkCredentials={canImportSdkCredentials}
            previewBusy={busy}
            onPreviewDemo={startDemoExtraction}
            showDevMemWalAuth={showDevMemWalAuth}
            onAttachLocalMemWal={attachLocalMemWal}
            onLogout={logout}
          />
        )}
      />
      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <FeedbackWidget ownerId={me.account?.id} />
    </>
  );
}

type StatusTone = "ready" | "needsMemWal" | "preview";
type MetricItem = { label: string; value: string | number; icon: React.ComponentType<{ size?: number }> };

const appNavItems = [
  { to: "/app", label: "Build", icon: Play, end: true },
  { to: "/app/artifacts", label: "Artifacts", icon: FolderOpen },
  { to: "/app/runs", label: "Runs", icon: History },
  { to: "/app/memory", label: "Memory", icon: Brain },
  { to: "/app/compare", label: "Compare", icon: GitCompare },
  { to: "/app/publish", label: "Publish", icon: LayoutGrid },
  { to: "/app/namespaces", label: "Namespaces", icon: Database },
  { to: "/app/settings", label: "Settings", icon: Settings }
];

const buildTabs = [
  ["Markdown", FileText],
  ["Structure", ListTree],
  ["Images", Image],
  ["Brand", Globe2],
  ["Design System", Palette],
  ["AI Query", MessageSquare],
  ["Walrus Resources", Boxes]
] as const;

function SharePage() {
  const { shareId = "" } = useParams();
  const [data, setData] = useState<ShareLinkResponse | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactFileRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!shareId) return;
    void loadShare();
  }, [shareId]);

  useEffect(() => {
    if (!shareId) return;
    const ogUrl = `${API_BASE}/api/share-links/${encodeURIComponent(shareId)}/og.svg`;
    const tags: HTMLMetaElement[] = [];
    function upsert(selector: string, attrName: "property" | "name", attrValue: string, content: string) {
      let tag = document.head.querySelector<HTMLMetaElement>(selector);
      if (!tag) {
        tag = document.createElement("meta");
        tag.setAttribute(attrName, attrValue);
        document.head.appendChild(tag);
        tags.push(tag);
      }
      tag.content = content;
    }
    upsert('meta[property="og:image"]', "property", "og:image", ogUrl);
    upsert('meta[property="og:type"]', "property", "og:type", "article");
    upsert('meta[name="twitter:card"]', "name", "twitter:card", "summary_large_image");
    upsert('meta[name="twitter:image"]', "name", "twitter:image", ogUrl);
    return () => {
      tags.forEach((tag) => tag.remove());
    };
  }, [shareId]);

  async function loadShare() {
    setError(null);
    try {
      const [shareResponse, artifactResponse] = await Promise.all([fetch(`${API_BASE}/api/share-links/${encodeURIComponent(shareId)}`), fetch(`${API_BASE}/api/share-links/${encodeURIComponent(shareId)}/artifacts`)]);
      if (!shareResponse.ok) throw new Error(await readResponseError(shareResponse));
      if (!artifactResponse.ok) throw new Error(await readResponseError(artifactResponse));
      setData((await shareResponse.json()) as ShareLinkResponse);
      setArtifacts(((await artifactResponse.json()) as { artifacts: ArtifactFileRecord[] }).artifacts ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const manifest = data?.manifest;
  const share = data?.share;
  const pages = manifest?.pages ?? [];
  const resources = manifest?.walrus?.resources ?? [];
  const screenshots = manifest?.screenshots?.filter((screenshot) => screenshot.status === "captured") ?? [];

  return (
    <main className="sharePage">
      <header className="shareTopbar">
        <Link className="appBrand" to="/">
          <span className="appBrandMark">
            <Server size={18} />
          </span>
          <span>
            <strong>ContextMeM</strong>
            <small>Public context share</small>
          </span>
        </Link>
        <Link className="heroGhost" to="/">
          <Home size={16} />
          Home
        </Link>
      </header>

      {error ? (
        <section className="shareHero panel errorState">
          <AlertCircle size={24} />
          <h1>Share not available</h1>
          <p>{error}</p>
        </section>
      ) : !data || !share ? (
        <section className="shareHero panel">
          <LoaderCircle size={24} />
          <h1>Loading shared context</h1>
        </section>
      ) : (
        <>
          <section className="shareHero">
            <div>
              <span>Shareable run</span>
              <h1>{share.title ?? compactTarget(share.target)}</h1>
              <p>{share.description ?? "Redacted public ContextMeM package with artifacts, screenshots, and an MCP entrypoint for agents."}</p>
              <div className="shareActions">
                <a href={share.mcpUrl} target="_blank" rel="noreferrer">
                  <Server size={16} />
                  MCP endpoint
                </a>
                <button onClick={() => navigator.clipboard.writeText(share.mcpUrl)}>
                  <Clipboard size={15} />
                  Copy MCP URL
                </button>
              </div>
            </div>
            <aside>
              <div><span>pages</span><strong>{pages.length}</strong></div>
              <div><span>artifacts</span><strong>{share.artifactCount}</strong></div>
              <div><span>resources</span><strong>{resources.length}</strong></div>
              <div><span>screenshots</span><strong>{screenshots.length}</strong></div>
            </aside>
          </section>

          {manifest ? <ShareContentTabs manifest={manifest as ArtifactManifest} artifacts={artifacts} mcpUrl={share.mcpUrl} namespace={share.namespace} shareId={shareId} /> : null}
        </>
      )}
    </main>
  );
}

function ShareContentTabs({ manifest, artifacts, mcpUrl, namespace, shareId }: { manifest: ArtifactManifest; artifacts: ArtifactFileRecord[]; mcpUrl: string; namespace: string; shareId: string }) {
  const availableTabs = useMemo(() => {
    const tabs: Array<{ key: string; label: string; count?: number }> = [];
    if (manifest.pages?.length) tabs.push({ key: "markdown", label: "Markdown", count: manifest.pages.length });
    if (manifest.siteStructure?.nodes?.length) tabs.push({ key: "structure", label: "Structure" });
    if (manifest.images?.length) tabs.push({ key: "images", label: "Images", count: manifest.images.length });
    if (manifest.brand) tabs.push({ key: "brand", label: "Brand" });
    if (manifest.designSystem || manifest.styleguide) tabs.push({ key: "design", label: "Design System" });
    if (manifest.aiQuery) tabs.push({ key: "ai", label: "AI Summary" });
    if (manifest.walrus?.resources?.length) tabs.push({ key: "walrus", label: "Walrus Resources", count: manifest.walrus.resources.length });
    tabs.push({ key: "artifacts", label: "Artifacts", count: artifacts.length });
    tabs.push({ key: "mcp", label: "MCP install" });
    return tabs;
  }, [manifest, artifacts]);
  const [active, setActive] = useState<string>(availableTabs[0]?.key ?? "markdown");

  return (
    <section className="shareContent panel">
      <nav className="shareTabs" role="tablist" aria-label="Share content sections">
        {availableTabs.map((tab) => (
          <button
            key={tab.key}
            role="tab"
            aria-selected={active === tab.key}
            className={active === tab.key ? "selected" : ""}
            onClick={() => setActive(tab.key)}
            type="button"
          >
            {tab.label}
            {typeof tab.count === "number" ? <span className="shareTabBadge">{tab.count}</span> : null}
          </button>
        ))}
      </nav>
      <div className="shareTabBody">
        {active === "markdown" ? <MarkdownPanel pages={manifest.pages} namespace={namespace} /> : null}
        {active === "structure" ? <ShareStructurePreview structure={manifest.siteStructure} /> : null}
        {active === "images" ? <ShareImagesGrid manifest={manifest} /> : null}
        {active === "brand" ? <BrandPanel data={manifest.brand} /> : null}
        {active === "design" ? <ShareDesignPreview manifest={manifest} /> : null}
        {active === "ai" ? (
          <div className="panel">
            <div className="sectionHead"><h2>AI Summary</h2><span>{manifest.aiQuery?.usedProvider ?? "stored"}</span></div>
            {manifest.aiQuery ? <AiResultData data={manifest.aiQuery.data} /> : <p className="subEmpty">No AI summary on this run.</p>}
          </div>
        ) : null}
        {active === "walrus" ? <WalrusResourcesPanel data={manifest.walrus} /> : null}
        {active === "artifacts" ? <ShareArtifactList artifacts={artifacts} shareId={shareId} /> : null}
        {active === "mcp" ? <ShareMcpInstall mcpUrl={mcpUrl} namespace={namespace} /> : null}
      </div>
    </section>
  );
}

function ShareStructurePreview({ structure }: { structure?: SiteStructure }) {
  if (!structure) return <div className="panel subEmpty">No site structure captured.</div>;
  return (
    <div className="panel">
      <div className="sectionHead">
        <h2>Site structure</h2>
        <span>{structure.summary.pages} pages · {structure.summary.assets} assets · {structure.summary.walrusResources} Walrus resources</span>
      </div>
      <ShareStructureNodes nodes={structure.nodes} depth={0} />
    </div>
  );
}

function ShareStructureNodes({ nodes, depth }: { nodes: SiteStructureNode[]; depth: number }) {
  return (
    <ul className="shareStructureTree" style={{ paddingLeft: depth === 0 ? 0 : 16 }}>
      {nodes.map((node) => (
        <li key={node.id}>
          <strong>{node.label}</strong>
          {node.path ? <code>{node.path}</code> : null}
          <span className="shareStructureKind">{node.kind}</span>
          {node.children?.length ? <ShareStructureNodes nodes={node.children} depth={depth + 1} /> : null}
        </li>
      ))}
    </ul>
  );
}

function ShareImagesGrid({ manifest }: { manifest: ArtifactManifest }) {
  if (!manifest.images.length) return <div className="panel subEmpty">No images extracted.</div>;
  return (
    <div className="grid">
      {manifest.images.map((image, index) => {
        const previewUrl = imagePreviewUrl(image, manifest);
        const displayUrl = imageDisplayUrl(image, manifest);
        return (
          <article className="imageCard" key={`${image.absoluteUrl}-${index}`}>
            <div className="imagePreview">
              {previewUrl ? <img src={previewUrl} alt={image.alt ?? image.role ?? image.type ?? "Extracted image"} loading="lazy" /> : <span>{image.type ?? "asset"}</span>}
            </div>
            <div className="imageMeta">
              <strong>{image.role ?? image.contentType ?? image.type ?? "image"}</strong>
              {image.alt ? <span>{image.alt}</span> : null}
              <code>{displayUrl}</code>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function ShareDesignPreview({ manifest }: { manifest: ArtifactManifest }) {
  const data = manifest.designSystem;
  const fallback = manifest.styleguide;
  if (!data && !fallback) return <div className="panel subEmpty">No design tokens captured.</div>;
  const colors = data?.tokens.colors ?? (fallback?.colors.palette ?? []).map((value, index) => ({ name: `color-${index}`, value, role: "raw" }));
  const fonts = data?.tokens.typography.fontFamilies ?? fallback?.typography.fontFamilies ?? [];
  return (
    <div className="panel">
      <div className="sectionHead">
        <h2>Design tokens</h2>
        <span>{colors.length} colors · {fonts.length} font families</span>
      </div>
      <div className="comparePalette" style={{ marginTop: 12 }}>
        {colors.slice(0, 24).map((token) => (
          <span key={`${token.name}-${token.value}`} style={{ background: token.value }} title={`${token.name} → ${token.value}`}>
            <small>{token.name}</small>
          </span>
        ))}
      </div>
      <div className="compareFonts" style={{ marginTop: 12 }}>
        {fonts.slice(0, 8).map((font) => <code key={font}>{font}</code>)}
      </div>
    </div>
  );
}

function ShareArtifactList({ artifacts, shareId }: { artifacts: ArtifactFileRecord[]; shareId: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const [content, setContent] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function toggle(artifact: ArtifactFileRecord) {
    if (open === artifact.path) {
      setOpen(null);
      return;
    }
    setOpen(artifact.path);
    if (content[artifact.path]) return;
    if (!artifact.previewable) return;
    setBusy(artifact.path);
    try {
      const url = `${API_BASE}/api/share-links/${encodeURIComponent(shareId)}/file?path=${encodeURIComponent(artifact.path)}`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(await readResponseError(resp));
      const text = await resp.text();
      setContent((prev) => ({ ...prev, [artifact.path]: text.slice(0, 30000) }));
    } catch (err) {
      setContent((prev) => ({ ...prev, [artifact.path]: err instanceof Error ? `(failed: ${err.message})` : "(failed to load)" }));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="panel">
      <div className="sectionHead">
        <h2>Artifacts</h2>
        <span>{artifacts.length} files · click to preview</span>
      </div>
      <div className="shareArtifactList">
        {artifacts.map((artifact) => (
          <div key={artifact.path}>
            <button type="button" onClick={() => void toggle(artifact)} className="shareArtifactRow">
              <FileText size={14} />
              <code>{artifact.path}</code>
              <span>{artifact.kind}</span>
            </button>
            {open === artifact.path ? (
              <pre className="shareArtifactPreview">
                {busy === artifact.path ? "Loading…" : content[artifact.path] ?? "(no preview)"}
              </pre>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function ShareMcpInstall({ mcpUrl, namespace }: { mcpUrl: string; namespace: string }) {
  const slug = namespace.replace(/[^a-zA-Z0-9_-]/g, "-");
  const claudeSnippet = JSON.stringify({ mcpServers: { [`contextmem-${slug}`]: { command: "npx", args: ["-y", "mcp-remote", mcpUrl] } } }, null, 2);
  const cursorSnippet = JSON.stringify({ contextmem: { url: mcpUrl } }, null, 2);
  return (
    <div className="panel">
      <div className="sectionHead"><h2>Install in your MCP client</h2><span>read-only</span></div>
      <p className="subEmpty" style={{ margin: "8px 0 16px" }}>Endpoint: <code>{mcpUrl}</code></p>
      <h3 style={{ margin: "8px 0 6px", fontSize: 13 }}>Claude Desktop / Codex</h3>
      <pre>{claudeSnippet}</pre>
      <h3 style={{ margin: "16px 0 6px", fontSize: 13 }}>Cursor (generic)</h3>
      <pre>{cursorSnippet}</pre>
    </div>
  );
}

type ShowcaseItem = {
  namespace: string;
  target: string;
  displayName?: string;
  description?: string;
  tags?: string[];
  visibility: string;
  directoryEnabled: boolean;
  lastSnapshotAt?: string;
  artifactCount?: number;
  mcpUrl: string;
};

function ShowcasePage() {
  const [items, setItems] = useState<ShowcaseItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch(`${API_BASE}/api/directory`);
        if (!response.ok) throw new Error(await readResponseError(response));
        const body = (await response.json()) as { namespaces: ShowcaseItem[] };
        if (!cancelled) setItems(body.namespaces ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = items.filter((item) => {
    if (!search.trim()) return true;
    const haystack = `${item.namespace} ${item.target} ${item.displayName ?? ""} ${item.description ?? ""} ${(item.tags ?? []).join(" ")}`.toLowerCase();
    return haystack.includes(search.trim().toLowerCase());
  });

  return (
    <main className="showcasePage">
      <header className="showcaseHero">
        <Link className="appBrand" to="/">
          <span className="appBrandMark"><Server size={18} /></span>
          <span>
            <strong>ContextMeM</strong>
            <small>Showcase · public hosted namespaces</small>
          </span>
        </Link>
        <h1>Browse public ContextMeM namespaces</h1>
        <p>Every namespace below exposes a read-only MCP endpoint. Install one in Claude Desktop, Cursor, or any MCP client to ground an agent in verified site context.</p>
        <input
          className="showcaseSearch"
          type="search"
          placeholder="Filter by domain, namespace, or tag"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </header>

      {busy ? (
        <section className="panel"><p>Loading directory…</p></section>
      ) : error ? (
        <section className="panel errorState">
          <h2>Directory unavailable</h2>
          <p>{error}</p>
          <FailureExplainer message={error} />
        </section>
      ) : !filtered.length ? (
        <section className="panel"><p>No public namespaces match that filter yet.</p></section>
      ) : (
        <section className="showcaseGrid">
          {filtered.map((item) => (
            <article key={item.namespace} className="showcaseCard">
              <header>
                <strong>{item.displayName ?? item.namespace}</strong>
                <code>{item.namespace}</code>
              </header>
              <p>{item.description ?? compactTarget(item.target)}</p>
              <dl>
                <div><span>target</span><strong>{compactTarget(item.target)}</strong></div>
                <div><span>artifacts</span><strong>{item.artifactCount ?? "—"}</strong></div>
                <div><span>last snapshot</span><strong>{item.lastSnapshotAt ? new Date(item.lastSnapshotAt).toLocaleDateString() : "—"}</strong></div>
              </dl>
              {item.tags?.length ? (
                <div className="showcaseTags">{item.tags.slice(0, 6).map((tag) => <span key={tag}>{tag}</span>)}</div>
              ) : null}
              <footer>
                <a href={item.mcpUrl} target="_blank" rel="noreferrer">Open MCP URL</a>
                <button onClick={() => void navigator.clipboard.writeText(item.mcpUrl)}>Copy</button>
              </footer>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}

function FeedbackWidget({ ownerId }: { ownerId?: string }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function sendFeedback() {
    if (!message.trim()) return;
    setBusy(true);
    try {
      await fetch(`${API_BASE}/api/feedback`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ownerId, message: message.trim(), pageUrl: window.location.href, sentiment: "neutral" })
      });
      setSent(true);
      setMessage("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`feedbackWidget ${open ? "open" : ""}`}>
      {open ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void sendFeedback();
          }}
        >
          <div className="sectionHead">
            <h2>Feedback</h2>
            <button type="button" onClick={() => setOpen(false)}>Close</button>
          </div>
          {sent ? <p>Thanks, saved.</p> : <textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="What felt confusing or valuable?" />}
          {!sent ? <button type="submit" disabled={busy || !message.trim()}>{busy ? "Sending" : "Send feedback"}</button> : null}
        </form>
      ) : (
        <button type="button" onClick={() => setOpen(true)}>
          <MessageSquare size={16} />
          Feedback
        </button>
      )}
    </div>
  );
}

function AppShell({
  pageTitle,
  pageDescription,
  statusLabel,
  statusTone,
  authHint,
  sessionSlot,
  hasMemWalDelegate,
  run,
  children
}: {
  pageTitle: string;
  pageDescription: string;
  statusLabel: string;
  statusTone: StatusTone;
  authHint: string;
  sessionSlot: React.ReactNode;
  hasMemWalDelegate: boolean;
  run: RunResponse | null;
  children: React.ReactNode;
}) {
  return (
    <main className={`appShell ${hasMemWalDelegate ? "" : "isLocked"}`}>
      <aside className="appSidebar">
        <Link className="appBrand" to="/">
          <span className="appBrandMark">
            <Server size={18} />
          </span>
          <span>
            <strong>ContextMeM</strong>
            <small>Walrus Sites context engine</small>
          </span>
        </Link>

        <nav className="appSideNav" aria-label="App pages">
          <NavLink className={({ isActive }) => `appSideLink ${isActive ? "selected" : ""}`} to="/" end>
            <Home size={17} />
            Home
          </NavLink>
          {appNavItems.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink key={item.to} className={({ isActive }) => `appSideLink ${isActive ? "selected" : ""}`} to={item.to} end={item.end}>
                <Icon size={17} />
                {item.label}
              </NavLink>
            );
          })}
        </nav>

        <div className="appSidebarFoot">
          <span>Mainnet only</span>
          <strong>Walrus Sites</strong>
        </div>
      </aside>

      <section className="appMain">
        {showDevMemWalAuth ? (
          <div className="devAuthBanner" role="alert">
            <strong>Developer auth fallback active.</strong>
            <span>
              <code>VITE_CONTEXTMEM_DEV_AUTH</code> or <code>?devAuth=1</code> is enabling a local MemWal bypass. This panel is hidden in production builds. Disable before sharing this browser session.
            </span>
          </div>
        ) : null}
        <header className="appTopbar">
          <div className="appTitleBlock">
            <span>{hasMemWalDelegate ? "Full app" : "Locked preview"}</span>
            <h1>{pageTitle}</h1>
            <p>{pageDescription}</p>
          </div>
          <div className="appTopbarActions">
            <span className="mainnetPill">
              <span />
              mainnet
            </span>
            <span className={`rbNav10Status ${statusTone}`}>{statusLabel}</span>
            <span className="runChip">{run ? compactHash(run.manifest.runId) : "no active run"}</span>
            {sessionSlot ? sessionSlot : null}
          </div>
        </header>
        {authHint ? <div className="appHint">{authHint}</div> : null}
        <div className="appContent">{children}</div>
      </section>
    </main>
  );
}

function demoPreviewStateFromJob(job: HostedExtractionJob, fallbackTarget: string): DemoPreviewState {
  const phase = job.status === "queued" || job.status === "running" || job.status === "completed" || job.status === "failed" ? job.status : "starting";
  const shareId = (job.result as { share?: { id?: string } } | undefined)?.share?.id;
  return {
    phase,
    target: job.target || fallbackTarget,
    jobId: job.id,
    shareId,
    message: demoPreviewMessage(phase, job.error),
    updatedAt: Date.now()
  };
}

function demoPreviewMessage(phase: DemoPreviewPhase, error?: string): string {
  switch (phase) {
    case "starting":
      return "Starting hosted preview";
    case "queued":
      return "Queued in Worker. Preparing extraction";
    case "running":
      return "Extracting public context and artifacts";
    case "completed":
      return "Preview ready. Opening share page";
    case "failed":
      return error || "Preview failed. Try another Walrus Site URL";
  }
}

function demoPreviewButtonLabel(preview: DemoPreviewState | null): string {
  if (!preview) return "Preview";
  switch (preview.phase) {
    case "starting":
      return "Starting";
    case "queued":
      return "Queued";
    case "running":
      return "Extracting";
    case "completed":
      return "Opening";
    case "failed":
      return "Retry";
  }
}

function demoPreviewProgress(phase: DemoPreviewPhase): number {
  switch (phase) {
    case "starting":
      return 18;
    case "queued":
      return 36;
    case "running":
      return 72;
    case "completed":
    case "failed":
      return 100;
  }
}

function demoStepState(index: number, preview: DemoPreviewState | null): string {
  if (!preview) return "";
  if (preview.phase === "failed") return index === 0 ? "isFailed" : "";
  if (preview.phase === "completed") return "isDone";
  if (preview.phase === "running") {
    if (index === 0) return "isDone";
    return index === 1 || index === 2 ? "isActive" : "";
  }
  return index === 0 ? "isActive" : "";
}

function demoLogState(index: number, preview: DemoPreviewState | null): string {
  if (!preview) return "";
  if (preview.phase === "failed") return index === 0 ? "isFailed" : "";
  if (preview.phase === "completed") return "isDone";
  if (preview.phase === "running") return index === 0 ? "isDone" : index === 1 || index === 2 ? "isActive" : "";
  if (preview.phase === "queued") return index === 0 ? "isDone" : index === 1 ? "isActive" : "";
  return index === 0 ? "isActive" : "";
}

function titleCasePhase(phase: DemoPreviewPhase): string {
  return `${phase.charAt(0).toUpperCase()}${phase.slice(1)}`;
}

function DemoPreviewAppPanel({ preview, onBackHome }: { preview: DemoPreviewState; onBackHome: () => void }) {
  const active = preview.phase !== "failed" && preview.phase !== "completed";
  const progress = demoPreviewProgress(preview.phase);
  const steps = [
    ["Create job", demoLogState(0, preview)],
    ["Resolve target", demoLogState(1, preview)],
    ["Package share page", demoLogState(2, preview)]
  ];
  return (
    <section className={`demoRunPanel ${preview.phase}`} aria-live="polite" aria-busy={active}>
      <div className="demoRunPanelTop">
        <span className="demoRunPanelIcon">
          {preview.phase === "failed" ? <AlertCircle size={18} /> : active ? <LoaderCircle className="spinIcon" size={18} /> : <CheckCircle2 size={18} />}
        </span>
        <div>
          <span>Public demo preview</span>
          <h2>{preview.message}</h2>
          <p>{preview.target}</p>
        </div>
        {preview.shareId ? (
          <Link className="demoRunPanelButton primary" to={`/share/${preview.shareId}`}>
            Open share page
            <ArrowDownRight size={15} />
          </Link>
        ) : (
          <button className="demoRunPanelButton" type="button" onClick={onBackHome}>
            Back to homepage
          </button>
        )}
      </div>
      <div className="demoRunPanelTrack" style={{ "--preview-progress": `${progress}%` } as React.CSSProperties}>
        <span />
      </div>
      <div className="demoRunPanelMeta">
        {preview.jobId ? <code>{compactHash(preview.jobId)}</code> : <span>waiting for job id</span>}
        <span>{active ? "The Worker is still running. You can stay here or go back to the homepage." : preview.phase === "failed" ? "Try a different Walrus Site URL or run the curated sample." : "Share page is ready."}</span>
      </div>
      <div className="demoRunPanelSteps" aria-label="Demo preview progress">
        {steps.map(([label, state]) => (
          <div key={label} className={state}>
            <span />
            <p>{label}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function LandingPage({
  target,
  setTarget,
  busy,
  demoPreview,
  hasMemWalDelegate,
  compactPrimaryActionLabel,
  statusLabel,
  statusTone,
  sessionSlot,
  authHint,
  heroRef,
  heroOffset,
  headlineRef,
  headlineProgress,
  heroMetrics,
  onHeroMouseMove,
  onHeroMouseLeave,
  onHeroAction,
  onOpenApp,
  onInspectArtifacts,
  onOpenHistory
}: {
  target: string;
  setTarget: React.Dispatch<React.SetStateAction<string>>;
  busy: boolean;
  demoPreview: DemoPreviewState | null;
  hasMemWalDelegate: boolean;
  compactPrimaryActionLabel: string;
  statusLabel: string;
  statusTone: StatusTone;
  sessionSlot: React.ReactNode;
  authHint: string;
  heroRef: React.RefObject<HTMLElement | null>;
  heroOffset: { x: number; y: number };
  headlineRef: React.RefObject<HTMLElement | null>;
  headlineProgress: number;
  heroMetrics: MetricItem[];
  onHeroMouseMove: (event: React.MouseEvent<HTMLElement>) => void;
  onHeroMouseLeave: () => void;
  onHeroAction: () => void;
  onOpenApp: () => void;
  onInspectArtifacts: () => void;
  onOpenHistory: () => void;
}) {
  const demoActive = Boolean(demoPreview && demoPreview.phase !== "failed" && demoPreview.phase !== "completed");
  const demoProgress = demoPreview ? demoPreviewProgress(demoPreview.phase) : 0;
  const previewTarget = demoPreview?.target || (target ? compactTarget(target) : "waiting for target");
  const previewLogItems = [
    { label: demoPreview?.phase === "starting" ? "start hosted preview job" : "resolve Walrus Site object", state: demoLogState(0, demoPreview) },
    { label: demoPreview?.phase === "queued" ? "waiting for Worker slot" : "verify blob/resource manifest", state: demoLogState(1, demoPreview) },
    { label: demoPreview?.phase === "running" ? "exporting public share package" : "export MemWal-ready context", state: demoLogState(2, demoPreview) }
  ];

  return (
    <main className={`shell landingShell ${hasMemWalDelegate ? "" : "isLocked"}`}>
      <Navigation10
        statusLabel={statusLabel}
        statusTone={statusTone}
        sessionSlot={sessionSlot}
        authHint={authHint}
        onOpenConsole={onOpenApp}
        onInspectArtifacts={onInspectArtifacts}
        onOpenHistory={onOpenHistory}
      />

      <section
        ref={heroRef}
        className="productHero landingHero"
        onMouseMove={onHeroMouseMove}
        onMouseLeave={onHeroMouseLeave}
        style={{ "--hero-x": `${heroOffset.x}px`, "--hero-y": `${heroOffset.y}px` } as React.CSSProperties}
      >
        <div className="heroBackdrop" aria-hidden="true" />
        <div className="heroGrid">
          <div className="heroCopy">
            <div className="heroKicker">
              <Sparkles size={16} />
              Walrus Sites context engine
            </div>
            <h1 className="heroTitle">
              <span>
                Decode <em>Walrus Sites</em>.
              </span>
              <span>
                Package <em>onchain context</em>.
              </span>
            </h1>
            <p>
              Resolve .wal.app names and Walrus Site object IDs, verify resources from Sui and Walrus, then package markdown, assets, design tokens, screenshots, and MemWal-ready memory for agents.
            </p>
            <div className="heroTarget">
              <Search size={18} />
              <input
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                disabled={demoActive}
                placeholder="Paste a .wal.app URL, Walrus object ID, or web URL"
              />
              <button className={demoActive ? "isLoading" : ""} disabled={busy || (hasMemWalDelegate && !target)} onClick={onHeroAction}>
                {!hasMemWalDelegate && demoActive ? <LoaderCircle className="spinIcon" size={16} /> : null}
                {hasMemWalDelegate ? compactPrimaryActionLabel : demoPreviewButtonLabel(demoPreview)}
              </button>
            </div>
            {!hasMemWalDelegate && demoPreview ? (
              <div className={`heroDemoStatus ${demoPreview.phase}`} aria-live="polite" aria-busy={demoActive}>
                <div className="heroDemoStatusMain">
                  <span className="heroDemoStatusIcon">
                    {demoPreview.phase === "failed" ? <AlertCircle size={16} /> : demoActive ? <LoaderCircle className="spinIcon" size={16} /> : <CheckCircle2 size={16} />}
                  </span>
                  <div>
                    <small className="heroDemoStatusLabel">Public demo preview</small>
                    <strong>{demoPreview.message}</strong>
                    <span>{previewTarget}</span>
                  </div>
                </div>
                {demoPreview.jobId ? <code>{compactHash(demoPreview.jobId)}</code> : null}
                <div className="heroDemoStatusTrack" style={{ "--preview-progress": `${demoProgress}%` } as React.CSSProperties}>
                  <span />
                </div>
              </div>
            ) : null}
            <div className="heroActions">
              <button className="heroCta" onClick={hasMemWalDelegate ? onOpenApp : onHeroAction} disabled={!hasMemWalDelegate && demoActive}>
                {!hasMemWalDelegate && demoActive ? <LoaderCircle className="spinIcon" size={17} /> : null}
                {hasMemWalDelegate ? "Open app" : demoActive ? demoPreviewButtonLabel(demoPreview) : "Run public preview"}
                {!demoActive ? <ArrowDownRight size={18} /> : null}
              </button>
              <button className="heroGhost" onClick={onInspectArtifacts}>
                <LayoutGrid size={17} />
                Inspect artifacts
              </button>
            </div>
          </div>

          <div className={`heroPreview ${demoPreview ? `isDemo${titleCasePhase(demoPreview.phase)}` : ""}`} aria-label="ContextMeM workflow preview">
            <div className="previewChrome">
              <span />
              <span />
              <span />
            </div>
            <div className="previewHeader">
              <div>
                <span>Live pipeline</span>
                <strong>{previewTarget}</strong>
              </div>
              {demoPreview?.phase === "failed" ? <AlertCircle size={20} /> : demoActive ? <LoaderCircle className="spinIcon" size={20} /> : <CheckCircle2 size={20} />}
            </div>
            <div className="previewPipeline">
              {[
                ["resolve", ".wal.app or object ID", Globe2],
                ["verify", "Sui + Walrus resources", Cpu],
                ["package", "agent context bundle", Boxes],
                ["remember", "MemWal account memory", Brain]
              ].map(([step, label, Icon], index) => {
                const StepIcon = Icon as typeof Globe2;
                return (
                  <div key={step as string} className={`pipelineStep ${demoStepState(index, demoPreview)}`}>
                    <StepIcon size={17} />
                    <span>{step as string}</span>
                    <strong>{label as string}</strong>
                  </div>
                );
              })}
            </div>
            <div className="previewLog">
              {previewLogItems.map((item) => (
                <div key={item.label} className={item.state}>
                  <span />
                  <p>{item.label}</p>
                </div>
              ))}
            </div>
            <div className="previewMetrics">
              {heroMetrics.map((metric) => {
                const Icon = metric.icon;
                return (
                  <div key={metric.label}>
                    <Icon size={16} />
                    <span>{metric.label}</span>
                    <strong>{String(metric.value)}</strong>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="logoLoop" aria-label="ContextMeM output loop">
          <div className="logoTrack">
            {[0, 1].map((copy) => (
              <div className="logoSequence" key={copy} aria-hidden={copy > 0}>
                {loopItems.map((item) => (
                  <span key={`${copy}-${item}`}>{item}</span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section ref={headlineRef} className="headlineReveal">
        <p>
          {revealWords.map((word, index) => {
            const start = index / revealWords.length;
            const end = start + 1 / revealWords.length;
            const progress = Math.min(1, Math.max(0, (headlineProgress - start) / (end - start)));
            return (
              <span key={`${word}-${index}`} style={{ opacity: 0.58 + progress * 0.42, filter: `blur(${(1 - progress) * 1.4}px)` }}>
                {word}
              </span>
            );
          })}
        </p>
      </section>

      <section className="featureBento" aria-label="ContextMeM capabilities">
        {showcaseCards.map((card, index) => {
          const Icon = card.icon;
          return (
            <article className="featureCard" key={card.title} style={{ "--card-delay": `${index * 90}ms` } as React.CSSProperties}>
              <Icon size={20} />
              <div>
                <h2>{card.title}</h2>
                <p>{card.detail}</p>
              </div>
              <Zap size={16} aria-hidden="true" />
            </article>
          );
        })}
      </section>

      <section className="pageEnd" aria-label="ContextMeM page end">
        <div>
          <span>Account-gated Walrus context</span>
          <h2>Homepage stays focused. The full console, artifacts, history, memory, and publish tools live inside the app.</h2>
        </div>
        <button onClick={hasMemWalDelegate ? onOpenApp : onHeroAction} disabled={!hasMemWalDelegate && demoActive}>
          <ArrowDownRight size={17} />
          {hasMemWalDelegate ? "Open app" : demoActive ? demoPreviewButtonLabel(demoPreview) : "Run public preview"}
        </button>
      </section>
    </main>
  );
}

function BuildConsolePage({
  target,
  setTarget,
  mode,
  setMode,
  buildProfile,
  setBuildProfile,
  outputs,
  setOutputs,
  busy,
  error,
  run,
  artifact,
  stats,
  activeTab,
  setActiveTab,
  setArtifact,
  history,
  refreshHistory,
  authToken,
  accountLabel,
  primaryActionLabel,
  onStartRun,
  onRemember,
  hasMemWalDelegate,
  hostedBuildResult,
  customNamespace,
  setCustomNamespace,
  customDisplayName,
  setCustomDisplayName,
  isHostedApiBase
}: {
  target: string;
  setTarget: React.Dispatch<React.SetStateAction<string>>;
  mode: "auto" | "web" | "walrus";
  setMode: React.Dispatch<React.SetStateAction<"auto" | "web" | "walrus">>;
  buildProfile: BuildProfile;
  setBuildProfile: React.Dispatch<React.SetStateAction<BuildProfile>>;
  outputs: string[];
  setOutputs: React.Dispatch<React.SetStateAction<string[]>>;
  busy: boolean;
  error: string | null;
  run: RunResponse | null;
  artifact: ArtifactManifest | null;
  stats: MetricItem[];
  activeTab: string;
  setActiveTab: React.Dispatch<React.SetStateAction<string>>;
  setArtifact: React.Dispatch<React.SetStateAction<ArtifactManifest | null>>;
  history: RunHistoryItem[];
  refreshHistory: () => Promise<void>;
  authToken: string;
  accountLabel: string;
  primaryActionLabel: string;
  onStartRun: () => void;
  onRemember: () => void;
  hasMemWalDelegate: boolean;
  hostedBuildResult: { shareId: string; namespace: string; shareUrl: string; mcpUrl: string } | null;
  customNamespace: string;
  setCustomNamespace: React.Dispatch<React.SetStateAction<string>>;
  customDisplayName: string;
  setCustomDisplayName: React.Dispatch<React.SetStateAction<string>>;
  isHostedApiBase: boolean;
}) {
  const visibleTab = buildTabs.some(([label]) => label === activeTab) ? activeTab : "Markdown";
  const [resultsExpanded, setResultsExpanded] = useState(false);
  const applyBuildProfile = (profile: BuildProfile) => {
    setBuildProfile(profile);
    setOutputs(buildProfileDefaults[profile]);
  };

  useEffect(() => {
    if (!resultsExpanded) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setResultsExpanded(false);
    }
    window.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [resultsExpanded]);

  const runId = run?.manifest.runId ?? null;
  const shareId = hostedBuildResult?.shareId ?? null;
  const shareUrl = hostedBuildResult?.shareUrl ?? null;

  const resultsBody = (
    <>
      <ResultsMetaBar runId={runId} shareId={shareId} shareUrl={shareUrl} expanded={resultsExpanded} onToggleExpand={() => setResultsExpanded((value) => !value)} />
      <div className="stats">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div className="stat" key={stat.label}>
              <Icon size={18} />
              <span>{stat.label}</span>
              <strong>{String(stat.value)}</strong>
            </div>
          );
        })}
      </div>

      <div className="tabs">
        {buildTabs.map(([label, Icon]) => (
          <button key={label} className={visibleTab === label ? "selected" : ""} onClick={() => setActiveTab(label)}>
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>

      <ResultPane tab={visibleTab} artifact={artifact} run={run} busy={busy} error={error?.startsWith("MemWal") ? null : error} setArtifact={setArtifact} history={history} refreshHistory={refreshHistory} authToken={authToken} accountLabel={accountLabel} />
    </>
  );

  return (
    <section className="workspace appWorkspace">
      <aside className="control buildControl">
        <label className="field">
          <span>Target</span>
          <div className="targetBox">
            <Search size={17} />
            <input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="Paste a .wal.app URL, Walrus object ID, or web URL" />
          </div>
        </label>

        <div className="field">
          <span>Mode</span>
          <div className="segmented">
            {(["auto", "web", "walrus"] as const).map((item) => (
              <button key={item} className={mode === item ? "selected" : ""} onClick={() => setMode(item)}>
                {item === "web" ? <Globe2 size={15} /> : item === "walrus" ? <Boxes size={15} /> : <Sparkles size={15} />}
                {item}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <span>Network</span>
          <div className="segmented networkOnly" aria-label="Walrus network">
            <button className="selected" type="button" aria-pressed="true">
              <Globe2 size={15} />
              mainnet
            </button>
          </div>
        </div>

        <div className="field">
          <span>Build profile</span>
          <div className="profileGrid">
            {buildProfiles.map((profile) => (
              <button key={profile.id} className={buildProfile === profile.id ? "selected" : ""} type="button" onClick={() => applyBuildProfile(profile.id)}>
                <strong>{profile.label}</strong>
                <small>{profile.detail}</small>
              </button>
            ))}
          </div>
        </div>

        {isHostedApiBase ? (
          <details className="field customNamespaceField">
            <summary>Namespace · custom (optional)</summary>
            <div className="namespaceFields">
              <label>
                <span>Namespace slug</span>
                <input
                  type="text"
                  value={customNamespace}
                  onChange={(event) => setCustomNamespace(event.target.value.replace(/[^a-zA-Z0-9_:.-]/g, ""))}
                  placeholder="seal-docs (becomes demo:seal-docs)"
                  spellCheck={false}
                />
              </label>
              <label>
                <span>Display name</span>
                <input
                  type="text"
                  value={customDisplayName}
                  onChange={(event) => setCustomDisplayName(event.target.value)}
                  placeholder="Seal Docs (shown on share page)"
                />
              </label>
              <small>Leave blank to auto-generate <code>demo:&lt;hostname&gt;:&lt;random&gt;</code>.</small>
            </div>
          </details>
        ) : null}

        <div className="field">
          <span>Outputs</span>
          <div className="checks">
            {outputOptions.map((option) => (
              <label key={option.id} className={option.id === "screenshots" ? "slowOutput" : ""}>
                <input
                  type="checkbox"
                  checked={outputs.includes(option.id)}
                  onChange={() => setOutputs((current) => (current.includes(option.id) ? current.filter((item) => item !== option.id) : [...current, option.id]))}
                />
                <span>
                  {option.label}
                  {option.detail ? <small>{option.detail}</small> : null}
                </span>
              </label>
            ))}
          </div>
        </div>

        <button className="run" disabled={!target || busy} onClick={onStartRun}>
          <Play size={17} />
          {primaryActionLabel}
        </button>

        <button className="secondary" disabled={!run || busy || !hasMemWalDelegate} onClick={onRemember}>
          <Brain size={17} />
          Remember in MemWal
        </button>

        {hostedBuildResult ? <HostedBuildBanner result={hostedBuildResult} /> : null}

        {error ? <div className={artifact || error.startsWith("MemWal") ? "notice" : "error"}>{artifact && !error.startsWith("MemWal") ? `Partial context kept: ${error}` : error}</div> : null}
      </aside>

      <section className="results appResults" aria-hidden={resultsExpanded}>
        {resultsExpanded ? <div className="resultsExpandPlaceholder">Output expanded — close the overlay to return.</div> : resultsBody}
      </section>
      {resultsExpanded ? (
        <div className="resultsExpandModal" role="dialog" aria-modal="true" aria-label="Build output (expanded)" onClick={() => setResultsExpanded(false)}>
          <div className="resultsExpandModalInner" onClick={(event) => event.stopPropagation()}>
            {resultsBody}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function ArtifactsAppPage({
  stats,
  run,
  artifact,
  authToken,
  setArtifact,
  history,
  accountLabel
}: {
  stats: MetricItem[];
  run: RunResponse | null;
  artifact: ArtifactManifest | null;
  authToken: string;
  setArtifact: React.Dispatch<React.SetStateAction<ArtifactManifest | null>>;
  history: RunHistoryItem[];
  accountLabel: string;
}) {
  return (
    <section className="appPanelStack">
      <div className="stats">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <div className="stat" key={stat.label}>
              <Icon size={18} />
              <span>{stat.label}</span>
              <strong>{String(stat.value)}</strong>
            </div>
          );
        })}
      </div>
      {artifact && run ? <AiQueryPanel artifact={artifact} run={run} setArtifact={setArtifact} authToken={authToken} history={history} accountLabel={accountLabel} /> : null}
      {artifact ? <ArtifactViewerPanel run={run} authToken={authToken} /> : <div className="panel subEmpty">No artifact package selected yet. Build or reopen a run to inspect generated files.</div>}
    </section>
  );
}

function RunsAppPage({ history, busy, currentRunId, onRefresh, onOpenRun }: { history: RunHistoryItem[]; busy: boolean; currentRunId?: string; onRefresh: () => Promise<void>; onOpenRun: (runId: string) => Promise<void> }) {
  return (
    <section className="appPanelStack">
      <div className="pageToolbar">
        <div>
          <strong>{history.length} packages</strong>
          <span>Previous Walrus context runs from your account.</span>
        </div>
        <button onClick={() => void onRefresh()} disabled={busy}>
          <History size={16} />
          Refresh
        </button>
      </div>

      {history.length ? (
        <div className="runListPage">
          {history.map((item) => (
            <button key={item.runId} className={`runRow ${currentRunId === item.runId ? "selected" : ""}`} onClick={() => void onOpenRun(item.runId)} disabled={busy}>
              <span>
                <strong>{compactTarget(item.target)}</strong>
                <small>{item.namespace || compactHash(item.runId)}</small>
              </span>
              <span>{item.mode}</span>
              <span>{item.pages} pages</span>
              <span>{item.resources} resources</span>
              <time>{formatDateTime(item.updatedAt)}</time>
            </button>
          ))}
        </div>
      ) : (
        <div className="panel subEmpty">No run history yet. Build your first context package from the Build page.</div>
      )}
    </section>
  );
}

function MemoryAppPage({
  artifact,
  run,
  history,
  refreshHistory,
  authToken,
  onRemember,
  busy
}: {
  artifact: ArtifactManifest | null;
  run: RunResponse | null;
  history: RunHistoryItem[];
  refreshHistory: () => Promise<void>;
  authToken: string;
  onRemember: () => void;
  busy: boolean;
}) {
  return (
    <section className="appPanelStack">
      {artifact && run ? <MemWalPanel artifact={artifact} run={run} history={history} refreshHistory={refreshHistory} authToken={authToken} onRemember={onRemember} rememberBusy={busy} /> : <div className="panel subEmpty">Build or reopen a run before using MemWal memory tools.</div>}
    </section>
  );
}

function SettingsAppPage({
  me,
  quotaLabel,
  hasMemWalDelegate,
  authBusy,
  delegateAccountId,
  delegateKey,
  setDelegateAccountId,
  setDelegateKey,
  onImport,
  notice,
  canImportSdkCredentials,
  previewBusy,
  onPreviewDemo,
  showDevMemWalAuth,
  onAttachLocalMemWal,
  onLogout
}: {
  me: AccountMe;
  quotaLabel: string;
  hasMemWalDelegate: boolean;
  authBusy: boolean;
  delegateAccountId: string;
  delegateKey: string;
  setDelegateAccountId: React.Dispatch<React.SetStateAction<string>>;
  setDelegateKey: React.Dispatch<React.SetStateAction<string>>;
  onImport: () => void;
  notice: MemWalNotice | null;
  canImportSdkCredentials: boolean;
  previewBusy: boolean;
  onPreviewDemo: () => void;
  showDevMemWalAuth: boolean;
  onAttachLocalMemWal: () => void;
  onLogout: () => void;
}) {
  return (
    <section className="settingsGrid">
      <section className="accountCard settingsCard">
        <div className="accountCardHead">
          <Database size={17} />
          <div>
            <strong>MemWal account</strong>
            <span>{me.authenticated ? me.account?.memwalAccountId ?? "MemWal not connected" : "login required"}</span>
          </div>
        </div>
        <div className="accountGrid">
          <div>
            <span>quota</span>
            <strong>{me.authenticated ? quotaLabel : "locked"}</strong>
          </div>
          <div>
            <span>MemWal</span>
            <strong>{hasMemWalDelegate ? "ready" : "import"}</strong>
          </div>
        </div>
        {hasMemWalDelegate ? <SavedSdkCredentialStatus accountId={me.account?.memwalAccountId} /> : null}
        <div className="settingsActionRow">
          <button className="secondary danger" type="button" disabled={!me.authenticated} onClick={onLogout}>
            <KeyRound size={15} />
            Log out account
          </button>
          <Link className="settingsLinkButton" to="/app/namespaces">
            <Database size={15} />
            Manage namespaces
          </Link>
        </div>
        <MemWalNoticeCard notice={notice} />
      </section>

      <section className="settingsCard">
        <div className="sectionHead">
          <h2>{hasMemWalDelegate ? "Rotate SDK credentials" : sdkImportTitle}</h2>
          <span>{isLocalApiBase(API_BASE) ? "encrypted server-side" : "stored in this browser only"}</span>
        </div>
        <p className="settingsCopy">
          {hasMemWalDelegate
            ? "Import again only if you rotate the delegate key in MemWal."
            : isLocalApiBase(API_BASE)
              ? sdkImportBody
              : "Paste your MemWal account ID and delegate private key. On the public site the delegate is stored in this browser only, sent as a request header for private hosted runs, and never persisted by the Worker."}
        </p>
        <a className="sdkSetupLink" href={memwalDashboardUrl} target="_blank" rel="noreferrer">
          <ExternalLink size={13} />
          Open MemWal dashboard to create or copy credentials
        </a>
        <SdkCredentialImportForm authenticated={me.authenticated} authBusy={authBusy} delegateAccountId={delegateAccountId} delegateKey={delegateKey} setDelegateAccountId={setDelegateAccountId} setDelegateKey={setDelegateKey} onImport={onImport} />
      </section>

      <SettingsUsageGuide authenticated={me.authenticated} onLogout={onLogout} />

      {isLocalApiBase(API_BASE) ? <AccountSecretCard /> : null}

      {showDevMemWalAuth ? (
        <section className="settingsCard">
          <div className="sectionHead">
            <h2>Developer auth fallback</h2>
            <span>local MCP</span>
          </div>
          <div className="devOnlyBanner">Dev only. This panel is hidden in production builds and delegate keys stay server-side.</div>
          <button className="secondary" onClick={onAttachLocalMemWal} disabled={authBusy || !me.authenticated}>
            Use local MCP credentials
          </button>
        </section>
      ) : null}
    </section>
  );
}

function SettingsUsageGuide({ authenticated, onLogout }: { authenticated: boolean; onLogout: () => void }) {
  return (
    <section className="settingsCard settingsUsageGuide">
      <div className="sectionHead">
        <h2>How to use this account</h2>
        <span>logout · MCP · namespace name</span>
      </div>
      <div className="usageGuideGrid">
        <article>
          <strong>Log out</strong>
          <p>Use this when you want to remove the MemWal delegate from this browser and clear the active run state.</p>
          <button className="secondary danger" type="button" disabled={!authenticated} onClick={onLogout}>
            <KeyRound size={14} />
            Log out now
          </button>
        </article>
        <article>
          <strong>Use MCP</strong>
          <p>Build or publish a namespace, open Namespaces, copy the MCP URL, then add it to Codex, Claude Desktop, Cursor, or any MCP client.</p>
          <Link className="settingsLinkButton" to="/app/namespaces">
            <Server size={14} />
            Open Namespaces
          </Link>
        </article>
        <article>
          <strong>Set namespace name</strong>
          <p>Namespace is the stable ID agents connect to. Display name is the friendly label shown in this UI and share pages.</p>
          <Link className="settingsLinkButton" to="/app/publish">
            <LayoutGrid size={14} />
            Publish / name namespace
          </Link>
        </article>
      </div>
    </section>
  );
}

function AccountSecretCard() {
  const [secret, setSecret] = useState<string>("");
  const [copied, setCopied] = useState(false);

  function generate() {
    const buffer = new Uint8Array(32);
    crypto.getRandomValues(buffer);
    const hex = Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("");
    setSecret(hex);
    setCopied(false);
  }

  async function copyEnvLine() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(`CONTEXTMEM_ACCOUNT_SECRET=${secret}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="settingsCard">
      <div className="sectionHead">
        <h2>Account secret</h2>
        <span>32-byte hex</span>
      </div>
      <p className="settingsCopy">Generate a fresh <code>CONTEXTMEM_ACCOUNT_SECRET</code> for your local <code>.env.local</code>. Used to derive session tokens; never sent to the server.</p>
      <div className="accountSecretRow">
        <button className="secondary" onClick={generate}>{secret ? "Generate again" : "Generate secret"}</button>
        {secret ? (
          <button className="ghost" onClick={() => void copyEnvLine()}>{copied ? "Copied" : "Copy env line"}</button>
        ) : null}
      </div>
      {secret ? (
        <pre className="accountSecretReadout"><code>CONTEXTMEM_ACCOUNT_SECRET={secret}</code></pre>
      ) : null}
    </section>
  );
}

function ResultPane({
  tab,
  artifact,
  run,
  busy,
  error,
  setArtifact,
  history,
  refreshHistory,
  authToken,
  accountLabel
}: {
  tab: string;
  artifact: ArtifactManifest | null;
  run: RunResponse | null;
  busy: boolean;
  error: string | null;
  setArtifact: React.Dispatch<React.SetStateAction<ArtifactManifest | null>>;
  history: RunHistoryItem[];
  refreshHistory: () => Promise<void>;
  authToken: string;
  accountLabel: string;
}) {
  const runErrors = run?.manifest.errors.filter(Boolean) ?? [];
  const runFailure = run?.manifest.status === "failed" ? runErrors[0] ?? "Context build failed." : null;
  const visibleError = runFailure ?? (!artifact ? error : null);

  if (visibleError) {
    return (
      <div className="empty resultState errorState" role="alert">
        <AlertCircle size={26} />
        <strong>Context build failed</strong>
        <span>{visibleError}</span>
        <FailureExplainer message={visibleError} />
      </div>
    );
  }

  if (!artifact) {
    if (busy) {
      const progress = run?.manifest.progress;
      const cacheStats = run?.manifest.cacheStats;
      const itemLabel =
        typeof progress?.itemsDone === "number" && typeof progress?.itemsTotal === "number"
          ? `${progress.itemsDone}/${progress.itemsTotal}`
          : progress?.phase
            ? progress.phase.replaceAll("_", " ")
            : "starting";
      const elapsedMs = run?.manifest.createdAt ? Math.max(0, Date.now() - Date.parse(run.manifest.createdAt)) : 0;
      return (
        <div className="empty resultState loadingState" aria-live="polite" aria-busy="true">
          <LoaderCircle size={28} />
          <strong>{progress?.label ?? "Building context package"}</strong>
          <span>{buildProgressCopy(progress?.phase)}</span>
          <div className="progressMeta">
            <code>{itemLabel}</code>
            <code>{formatDuration(elapsedMs)}</code>
            {cacheStats && cacheStats.hits + cacheStats.misses > 0 ? <code>{cacheStats.hits} cache hits</code> : null}
          </div>
          <div className="loadingTrack" aria-hidden="true">
            <span />
          </div>
        </div>
      );
    }

    return (
      <div className="empty">
        <Sparkles size={24} />
        <span>Build a Walrus Site context package to inspect verified resources, markdown, visual assets, MemWal memory, and publish artifacts.</span>
      </div>
    );
  }

  if (tab === "Markdown") {
    const ns = run?.manifest.namespace;
    return (
      <MarkdownPanel
        pages={artifact.pages}
        namespace={ns}
        onPageEdited={(artifactPath, content) => {
          setArtifact((current) => {
            if (!current) return current;
            return {
              ...current,
              pages: current.pages.map((page) => (page.artifactPath === artifactPath ? { ...page, markdown: content } : page))
            };
          });
        }}
      />
    );
  }

  if (tab === "Structure") return <StructurePanel data={artifact.siteStructure} run={run} authToken={authToken} />;
  if (tab === "Images") {
    return (
      <div className="grid">
        {artifact.images.map((image, index) => {
          const previewUrl = imagePreviewUrl(image, artifact);
          const displayUrl = imageDisplayUrl(image, artifact);
          return (
            <article className="imageCard" key={`${image.absoluteUrl}-${index}`}>
              <div className="imagePreview">
                {previewUrl ? <img src={previewUrl} alt={image.alt ?? image.role ?? image.type ?? "Extracted image"} loading="lazy" /> : <span>{image.type ?? "asset"}</span>}
              </div>
              <div className="imageMeta">
                <strong>{image.role ?? image.contentType ?? image.type ?? "image"}</strong>
                {image.alt ? <span>{image.alt}</span> : null}
                <code>{displayUrl}</code>
              </div>
            </article>
          );
        })}
      </div>
    );
  }

  if (tab === "Brand") return <BrandPanel data={artifact.brand} />;
  if (tab === "Design System" || tab === "Styleguide") return <DesignSystemPanel data={artifact.designSystem} fallback={artifact.styleguide} run={run} authToken={authToken} />;
  if (tab === "AI Query") return <AiQueryPanel artifact={artifact} run={run} setArtifact={setArtifact} authToken={authToken} history={history} accountLabel={accountLabel} />;
  if (tab === "Artifacts") return <ArtifactViewerPanel run={run} authToken={authToken} />;
  if (tab === "Walrus Resources") return <WalrusResourcesPanel data={artifact.walrus} />;
  if (tab === "Walrus History") return <WalrusHistoryPanel run={run} walrus={artifact.walrus} authToken={authToken} />;
  if (tab === "MemWal Memory") return <MemWalPanel artifact={artifact} run={run} history={history} refreshHistory={refreshHistory} authToken={authToken} />;
  return <PublishPanel run={run} authToken={authToken} />;
}

function MarkdownPanel({ pages, namespace, onPageEdited }: { pages: MarkdownPage[]; namespace?: string; onPageEdited?: (artifactPath: string, content: string) => void }) {
  const [mode, setMode] = useState<MarkdownViewMode>("preview");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingPath, setSavingPath] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<{ tone: "success" | "warning"; message: string } | null>(null);
  const totalCharacters = useMemo(() => pages.reduce((sum, page) => sum + page.markdown.length, 0), [pages]);
  const canEdit = Boolean(namespace);

  if (!pages.length) {
    return <div className="panel subEmpty">No markdown pages were extracted for this run.</div>;
  }

  function draftFor(page: MarkdownPage): string {
    const key = pageEditKey(page);
    return drafts[key] ?? page.markdown;
  }

  function setDraft(page: MarkdownPage, value: string) {
    const key = pageEditKey(page);
    setDrafts((prev) => ({ ...prev, [key]: value }));
  }

  function resetDraft(page: MarkdownPage) {
    const key = pageEditKey(page);
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function savePage(page: MarkdownPage) {
    if (!page.artifactPath || !namespace) {
      setSaveNotice({ tone: "warning", message: "This page has no artifact path. Re-run the build so it's tracked." });
      return;
    }
    setSavingPath(page.artifactPath);
    setSaveNotice(null);
    try {
      const response = await fetch(`${API_BASE}/api/namespaces/${encodeURIComponent(namespace)}/artifact-edit`, {
        method: "POST",
        headers: authHeaders("", { "content-type": "application/json" }),
        body: JSON.stringify({ path: page.artifactPath, content: draftFor(page) })
      });
      if (!response.ok) throw new Error(await readResponseError(response));
      const content = draftFor(page);
      onPageEdited?.(page.artifactPath, content);
      resetDraft(page);
      setSaveNotice({ tone: "success", message: `Saved ${page.artifactPath}. MCP clients reading this namespace will get the new content on next query.` });
    } catch (err) {
      setSaveNotice({ tone: "warning", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSavingPath(null);
    }
  }

  const [selectedKey, setSelectedKey] = useState<string>(() => pageEditKey(pages[0]!));
  const selectedPage = pages.find((page) => pageEditKey(page) === selectedKey) ?? pages[0]!;
  const selectedValue = draftFor(selectedPage);
  const selectedDirty = drafts[pageEditKey(selectedPage)] !== undefined && drafts[pageEditKey(selectedPage)] !== selectedPage.markdown;
  return (
    <div className="panel markdownPanel markdownDocs">
      <div className="markdownToolbar">
        <div>
          <strong>Markdown</strong>
          <span>{pages.length} pages · {formatBytes(totalCharacters)}{canEdit ? " · raw is editable" : ""}</span>
        </div>
        <div className="markdownMode" role="group" aria-label="Markdown view mode">
          <button type="button" className={mode === "preview" ? "selected" : ""} onClick={() => setMode("preview")} aria-pressed={mode === "preview"}>
            <Eye size={14} />
            Preview
          </button>
          <button type="button" className={mode === "raw" ? "selected" : ""} onClick={() => setMode("raw")} aria-pressed={mode === "raw"}>
            <Code2 size={14} />
            Raw
          </button>
        </div>
      </div>

      {saveNotice ? (
        <div className={`markdownSaveNotice ${saveNotice.tone}`}>{saveNotice.message}</div>
      ) : null}

      <div className="markdownDocsLayout">
        <aside className="markdownPageNav" aria-label="Markdown pages">
          <div className="markdownPageNavHead">
            <span>Pages</span>
            <small>{pages.length}</small>
          </div>
          <ul>
            {pages.map((page) => {
              const key = pageEditKey(page);
              const draft = draftFor(page);
              const isDirty = drafts[key] !== undefined && drafts[key] !== page.markdown;
              return (
                <li key={key}>
                  <button
                    type="button"
                    className={key === selectedKey ? "selected" : ""}
                    onClick={() => setSelectedKey(key)}
                    title={page.routePath ?? page.url}
                  >
                    <span className="markdownPageNavTitle">{page.title ?? page.routePath ?? page.url}</span>
                    <span className="markdownPageNavMeta">
                      <small>{formatBytes(draft.length)}</small>
                      {isDirty ? <em>edited</em> : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        <article className="page markdownPage markdownDocsBody" key={selectedKey}>
          <div className="pageHead markdownPageHead">
            <div>
              <strong>{selectedPage.title ?? selectedPage.routePath ?? selectedPage.url}</strong>
              <span>{selectedPage.routePath ?? selectedPage.url}</span>
            </div>
            <span>{selectedPage.source?.blobId ?? formatBytes(selectedValue.length)}{selectedPage.artifactPath ? ` · ${selectedPage.artifactPath}` : ""}</span>
          </div>

          {mode === "preview" ? (
            <div className="markdownBody">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: MarkdownLink }}>
                {selectedValue}
              </ReactMarkdown>
            </div>
          ) : canEdit ? (
            <>
              <textarea
                className="markdownRawEditor"
                value={selectedValue}
                onChange={(event) => setDraft(selectedPage, event.target.value)}
                spellCheck={false}
                rows={Math.min(36, Math.max(12, selectedValue.split("\n").length))}
              />
              <div className="markdownEditActions">
                <button
                  type="button"
                  className="primary"
                  disabled={!selectedDirty || savingPath === selectedPage.artifactPath}
                  onClick={() => void savePage(selectedPage)}
                >
                  {savingPath === selectedPage.artifactPath ? "Saving…" : selectedDirty ? "Save to namespace" : "Saved"}
                </button>
                {selectedDirty ? (
                  <button type="button" className="ghost" onClick={() => resetDraft(selectedPage)}>
                    Discard changes
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <pre className="markdownRaw">{selectedValue}</pre>
          )}
        </article>
      </div>
    </div>
  );
}

function pageEditKey(page: MarkdownPage): string {
  return page.artifactPath ?? page.url;
}

function ResultsMetaBar({ runId, shareId, shareUrl, expanded, onToggleExpand }: { runId: string | null; shareId: string | null; shareUrl: string | null; expanded: boolean; onToggleExpand: () => void }) {
  const [copiedJob, setCopiedJob] = useState(false);
  async function copyJobId() {
    if (!runId) return;
    try {
      await navigator.clipboard.writeText(runId);
      setCopiedJob(true);
      setTimeout(() => setCopiedJob(false), 1600);
    } catch {
      setCopiedJob(false);
    }
  }
  return (
    <div className="resultsMetaBar">
      <div className="resultsMetaBarFacts">
        {runId ? (
          <button type="button" className="resultsMetaChip" onClick={() => void copyJobId()} title={runId} aria-label={`Job ID ${runId}, click to copy`}>
            <Hash size={13} />
            <span>job</span>
            <code>{compactHash(runId)}</code>
            {copiedJob ? <small>copied</small> : null}
          </button>
        ) : (
          <span className="resultsMetaChip resultsMetaChipMuted">
            <Hash size={13} />
            <span>no active run</span>
          </span>
        )}
        {shareId && shareUrl ? (
          <Link className="resultsMetaShareLink" to={`/share/${shareId}`} title={shareUrl}>
            <Share2 size={13} />
            Open share page
            <ArrowDownRight size={13} />
          </Link>
        ) : null}
      </div>
      <button type="button" className="resultsMetaExpandButton" onClick={onToggleExpand} aria-label={expanded ? "Close expanded view" : "Expand output to fullscreen"}>
        {expanded ? <X size={15} /> : <Maximize2 size={15} />}
        {expanded ? "Close" : "Expand"}
      </button>
    </div>
  );
}

function HostedBuildBanner({ result }: { result: { shareId: string; namespace: string; shareUrl: string; mcpUrl: string } }) {
  const [copied, setCopied] = useState<"share" | "mcp" | null>(null);
  async function copy(kind: "share" | "mcp", value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      setCopied(null);
    }
  }
  return (
    <div className="hostedBuildBanner">
      <div className="hostedBuildBannerHead">
        <CheckCircle2 size={16} />
        <strong>Hosted build complete</strong>
        <code>{result.namespace}</code>
      </div>
      <div className="hostedBuildBannerRow">
        <span>Share page</span>
        <Link to={`/share/${result.shareId}`}>{result.shareUrl}</Link>
        <button type="button" onClick={() => void copy("share", result.shareUrl)}>
          <Clipboard size={13} />
          {copied === "share" ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="hostedBuildBannerRow">
        <span>MCP endpoint</span>
        <a href={result.mcpUrl} target="_blank" rel="noreferrer">{result.mcpUrl}</a>
        <button type="button" onClick={() => void copy("mcp", result.mcpUrl)}>
          <Clipboard size={13} />
          {copied === "mcp" ? "Copied" : "Copy"}
        </button>
      </div>
      <McpPlayground mcpUrl={result.mcpUrl} namespace={result.namespace} />
    </div>
  );
}

function McpPlayground({ mcpUrl, namespace }: { mcpUrl: string; namespace: string }) {
  const [busy, setBusy] = useState<"tools" | "read" | null>(null);
  const [output, setOutput] = useState<string>("");
  const [readPath, setReadPath] = useState<string>("/site/index.md");

  async function rpc(method: string, params: Record<string, unknown>) {
    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...hostedDelegateHeaders()
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
    });
    return response.text();
  }

  async function listTools() {
    setBusy("tools");
    setOutput("");
    try {
      await rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "contextmem-playground", version: "0.1.0" }
      });
      const body = await rpc("tools/list", {});
      setOutput(formatRpcResult(body));
    } catch (err) {
      setOutput(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function readArtifact() {
    if (!readPath.trim()) return;
    setBusy("read");
    setOutput("");
    try {
      await rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "contextmem-playground", version: "0.1.0" }
      });
      const body = await rpc("tools/call", {
        name: "contextmem_read_artifact",
        arguments: { path: readPath.trim(), namespace }
      });
      setOutput(formatRpcResult(body));
    } catch (err) {
      setOutput(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mcpPlayground">
      <strong>Try this MCP endpoint</strong>
      <div className="mcpPlaygroundActions">
        <button type="button" onClick={() => void listTools()} disabled={busy !== null}>
          {busy === "tools" ? "Listing…" : "tools/list"}
        </button>
        <input
          type="text"
          value={readPath}
          onChange={(event) => setReadPath(event.target.value)}
          placeholder="/site/index.md"
          spellCheck={false}
        />
        <button type="button" onClick={() => void readArtifact()} disabled={busy !== null || !readPath.trim()}>
          {busy === "read" ? "Reading…" : "read_artifact"}
        </button>
      </div>
      {output ? <pre className="mcpPlaygroundOutput">{output}</pre> : <small>Run `tools/list` to see what your namespace exposes, or `read_artifact` to fetch a file like `/site/index.md` or `/llms.txt`.</small>}
    </div>
  );
}

function formatRpcResult(raw: string): string {
  try {
    const trimmed = raw
      .split("\n")
      .map((line) => (line.startsWith("data: ") ? line.slice(6) : line))
      .filter((line) => line.trim().length > 0)
      .join("\n");
    const parsed = JSON.parse(trimmed) as { result?: unknown; error?: unknown };
    if (parsed.error) return JSON.stringify(parsed.error, null, 2);
    if (parsed.result) return JSON.stringify(parsed.result, null, 2).slice(0, 6000);
    return JSON.stringify(parsed, null, 2).slice(0, 6000);
  } catch {
    return raw.slice(0, 6000);
  }
}

function MarkdownLink(props: MarkdownAnchorProps) {
  const { href, children, node: _node, ...anchorProps } = props;
  const external = typeof href === "string" && /^https?:\/\//i.test(href);

  return (
    <a href={href} target={external ? "_blank" : undefined} rel={external ? "noreferrer" : undefined} {...anchorProps}>
      {children}
    </a>
  );
}

type SdkCredentialImportFormProps = {
  authenticated: boolean;
  authBusy: boolean;
  delegateAccountId: string;
  delegateKey: string;
  setDelegateAccountId: React.Dispatch<React.SetStateAction<string>>;
  setDelegateKey: React.Dispatch<React.SetStateAction<string>>;
  onImport: () => void;
};

function SdkCredentialImportForm({
  authenticated,
  authBusy,
  delegateAccountId,
  delegateKey,
  setDelegateAccountId,
  setDelegateKey,
  onImport
}: SdkCredentialImportFormProps) {
  return (
    <Auth1
      variant="compact"
      authenticated={authenticated}
      authBusy={authBusy}
      delegateAccountId={delegateAccountId}
      delegateKey={delegateKey}
      setDelegateAccountId={setDelegateAccountId}
      setDelegateKey={setDelegateKey}
      onImport={onImport}
      dashboardUrl={memwalDashboardUrl}
      delegateStorage={isLocalApiBase(API_BASE) ? "server" : "browser"}
      description={isLocalApiBase(API_BASE)
        ? "Paste your MemWal account ID and delegate private key. ContextMeM stores the delegate encrypted server-side and unlocks verified Walrus context."
        : "Paste your MemWal account ID and delegate private key. On the public site they are stored in this browser only, sent as request headers for private hosted runs, and never persisted by the Worker."}
    />
  );
}

function SavedSdkCredentialStatus({ accountId }: { accountId?: string }) {
  return (
    <div className="sdkSavedState">
      <ShieldCheck size={16} />
      <div>
        <strong>SDK credentials saved</strong>
        <p>{isLocalApiBase(API_BASE) ? "ContextMeM will reuse the encrypted server-side delegate. Import again only if you rotate this key in MemWal." : "ContextMeM will reuse the delegate from this browser for hosted prod testing. Import again only if you rotate this key in MemWal."}</p>
        {accountId ? <code>{compactHash(accountId)}</code> : null}
      </div>
      <a className="sdkSetupLink" href={memwalDashboardUrl} target="_blank" rel="noreferrer">
        <ExternalLink size={13} />
        Open MemWal dashboard
      </a>
    </div>
  );
}

function HostedCredentialGate({ notice, previewBusy, onPreviewDemo, panel = false, target, setTarget }: { notice: MemWalNotice | null; previewBusy: boolean; onPreviewDemo: () => void; panel?: boolean; target?: string; setTarget?: React.Dispatch<React.SetStateAction<string>> }) {
  const hasInput = typeof target === "string" && typeof setTarget === "function";
  return (
    <div className={`hostedCredentialGate ${panel ? "panelMode" : ""}`}>
      <div className="hostedCredentialIcon">
        <ShieldCheck size={22} />
      </div>
      <span>Hosted prod test</span>
      <h2>Run a public preview or import credentials.</h2>
      <p>
        Public preview works without credentials. Private hosted runs accept your MemWal delegate from Settings and do not require a local API.
      </p>
      {hasInput ? (
        <form
          className="hostedCredentialInput"
          onSubmit={(event) => {
            event.preventDefault();
            if (!previewBusy) onPreviewDemo();
          }}
        >
          <input
            type="url"
            value={target ?? ""}
            onChange={(event) => setTarget?.(event.target.value)}
            placeholder="Paste a .wal.app URL or public web URL (leave blank for the curated sample)"
            disabled={previewBusy}
            spellCheck={false}
            inputMode="url"
            autoComplete="off"
          />
          <button type="submit" disabled={previewBusy}>
            {previewBusy ? <LoaderCircle className="spinIcon" size={16} /> : <Play size={16} />}
            {previewBusy ? "Running" : target?.trim() ? "Run this URL" : "Run public preview"}
          </button>
        </form>
      ) : (
        <div className="hostedCredentialActions">
          <button type="button" onClick={onPreviewDemo} disabled={previewBusy}>
            {previewBusy ? <LoaderCircle className="spinIcon" size={16} /> : <Play size={16} />}
            {previewBusy ? "Preview running" : "Run public preview"}
          </button>
        </div>
      )}
      <div className="hostedCredentialActions secondary">
        <a href={memwalDashboardUrl} target="_blank" rel="noreferrer">
          <ExternalLink size={14} />
          Open MemWal dashboard
        </a>
      </div>
      <MemWalNoticeCard notice={notice} centered={panel} />
    </div>
  );
}

function LockedPreview({
  authenticated,
  authBusy,
  notice,
  delegateAccountId,
  delegateKey,
  setDelegateAccountId,
  setDelegateKey,
  onImport,
  canImportSdkCredentials,
  previewBusy,
  onPreviewDemo,
  target,
  setTarget
}: SdkCredentialImportFormProps & { notice: MemWalNotice | null; canImportSdkCredentials: boolean; previewBusy: boolean; onPreviewDemo: () => void; target: string; setTarget: React.Dispatch<React.SetStateAction<string>> }) {
  return (
    <div className="lockedPreview">
      <div className="blurredDemo" aria-hidden="true">
        <div className="stats">
          {["Pages", "Resources", "Design tokens", "MemWal"].map((item, index) => (
            <div className="stat" key={item}>
              <Sparkles size={16} />
              <span>{item}</span>
              <strong>{index === 3 ? "locked" : `${(index + 1) * 8}`}</strong>
            </div>
          ))}
        </div>
        <div className="panel">
          <pre>{`Walrus Site package\n- verified Sui object provenance\n- resource manifest and blob IDs\n- markdown and visual system export\n- MemWal recall namespace`}</pre>
        </div>
      </div>
      {canImportSdkCredentials ? (
        <Auth1
          variant="panel"
          authenticated={authenticated}
          authBusy={authBusy}
          delegateAccountId={delegateAccountId}
          delegateKey={delegateKey}
          setDelegateAccountId={setDelegateAccountId}
          setDelegateKey={setDelegateKey}
          onImport={onImport}
          dashboardUrl={memwalDashboardUrl}
          noticeSlot={<MemWalNoticeCard notice={notice} centered />}
          delegateStorage={isLocalApiBase(API_BASE) ? "server" : "browser"}
          description={isLocalApiBase(API_BASE)
            ? "Paste your MemWal account ID and delegate private key. ContextMeM stores the delegate encrypted server-side and unlocks verified Walrus context."
            : "Paste your MemWal account ID and delegate private key. On the public site they are stored in this browser only, sent as request headers for private hosted runs, and never persisted by the Worker."}
        />
      ) : (
        <HostedCredentialGate notice={notice} previewBusy={previewBusy} onPreviewDemo={onPreviewDemo} panel target={target} setTarget={setTarget} />
      )}
    </div>
  );
}

function MemWalNoticeCard({ notice, centered = false }: { notice: MemWalNotice | null; centered?: boolean }) {
  if (!notice) return null;
  return (
    <div className={`memwalNotice ${notice.tone} ${centered ? "centered" : ""}`}>
      <p>{notice.message}</p>
      {notice.command ? (
        <div className="memwalCommand">
          <code>{notice.command}</code>
          <button onClick={() => void navigator.clipboard.writeText(notice.command!)}>Copy command</button>
        </div>
      ) : null}
    </div>
  );
}

function StructurePanel({ data, run, authToken }: { data?: SiteStructure; run: RunResponse | null; authToken: string }) {
  const selectable = useMemo(() => (data ? flattenStructure(data.nodes).filter((node) => node.kind !== "group") : []), [data]);
  const [selectedId, setSelectedId] = useState<string>("");
  const selected = selectable.find((node) => node.id === selectedId) ?? selectable[0];
  const previewNode = useMemo(() => previewNodeForStructureSelection(selected), [selected]);
  const [preview, setPreview] = useState("");

  useEffect(() => {
    setSelectedId(selectable[0]?.id ?? "");
  }, [data?.generatedAt]);

  useEffect(() => {
    if (!run || !previewNode?.artifactPath || isImageNode(previewNode)) {
      setPreview("");
      return;
    }
    if (!isTextPreviewNode(previewNode)) {
      setPreview("Preview unavailable for this node.");
      return;
    }
    void fetch(artifactFileUrl(run.manifest.runId, previewNode.artifactPath, authToken), { headers: authHeaders(authToken) })
      .then((response) => (response.ok ? response.text() : response.text().then((text) => Promise.reject(new Error(text)))))
      .then(setPreview)
      .catch((err) => setPreview(err instanceof Error ? err.message : String(err)));
  }, [authToken, run?.manifest.runId, previewNode?.id, previewNode?.artifactPath]);

  if (!data) {
    return (
      <div className="panel structurePanel">
        <div className="tabEmptyState">
          <strong>Site structure not in this run</strong>
          <p>This run was built before site-structure extraction shipped. Re-run the Build to get a tree of pages, resources, and Walrus assets — saved as <code>/context/site-structure.json</code>.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="panel structurePanel">
      <section className="structureSummary">
        <div>
          <span>Pages</span>
          <strong>{data.summary.pages}</strong>
        </div>
        <div>
          <span>Docs</span>
          <strong>{data.summary.docs}</strong>
        </div>
        <div>
          <span>Assets</span>
          <strong>{data.summary.assets}</strong>
        </div>
        <div>
          <span>Brand</span>
          <strong>{data.summary.brandAssets}</strong>
        </div>
        <div>
          <span>Walrus</span>
          <strong>{data.summary.walrusResources}</strong>
        </div>
      </section>

      <section className="structureLayout">
        <div className="structureTree">
          {data.nodes.map((node) => (
            <StructureTreeNode key={node.id} node={node} selectedId={selected?.id} onSelect={setSelectedId} depth={0} runId={run?.manifest.runId} authToken={authToken} />
          ))}
        </div>
        <aside className="structureInspector">
          {selected ? (
            <>
              <div className="sectionHead">
                <h2>{selected.label}</h2>
                <span>{selected.kind}</span>
              </div>
              <dl>
                {selected.path ? (
                  <div>
                    <dt>path</dt>
                    <dd>{selected.path}</dd>
                  </div>
                ) : null}
                {selected.route ? (
                  <div>
                    <dt>route</dt>
                    <dd>{selected.route}</dd>
                  </div>
                ) : null}
                {selected.contentType ? (
                  <div>
                    <dt>type</dt>
                    <dd>{selected.contentType}</dd>
                  </div>
                ) : null}
                {selected.byteLength ? (
                  <div>
                    <dt>size</dt>
                    <dd>{formatBytes(selected.byteLength)}</dd>
                  </div>
                ) : null}
                {selected.blobId ? (
                  <div>
                    <dt>blob</dt>
                    <dd>{selected.blobId}</dd>
                  </div>
                ) : null}
                {selected.blobHash ? (
                  <div>
                    <dt>hash</dt>
                    <dd>{selected.blobHash}</dd>
                  </div>
                ) : null}
                {selected.artifactPath ? (
                  <div>
                    <dt>artifact</dt>
                    <dd>{selected.artifactPath}</dd>
                  </div>
                ) : null}
                {!selected.artifactPath && previewNode?.artifactPath ? (
                  <div>
                    <dt>preview</dt>
                    <dd>{previewNode.artifactPath}</dd>
                  </div>
                ) : null}
              </dl>
              <div className="structureActions">
                <button onClick={() => navigator.clipboard.writeText(selected.path ?? selected.artifactPath ?? selected.label)}>
                  <Clipboard size={14} />
                  Copy path
                </button>
                {previewNode?.artifactPath ? (
                  <a href={artifactFileUrl(run?.manifest.runId, previewNode.artifactPath, authToken)} target="_blank" rel="noreferrer">
                    <FolderOpen size={14} />
                    Open
                  </a>
                ) : null}
              </div>
              {previewNode?.artifactPath ? (
                <div className="structurePreview">
                  {isImageNode(previewNode) ? <img src={artifactFileUrl(run?.manifest.runId, previewNode.artifactPath, authToken)} alt={previewNode.label} /> : <pre>{preview}</pre>}
                </div>
              ) : (
                <div className="subEmpty">No local preview artifact for this node.</div>
              )}
            </>
          ) : (
            <div className="subEmpty">No structure nodes found.</div>
          )}
        </aside>
      </section>
    </div>
  );
}

function StructureTreeNode({
  node,
  selectedId,
  onSelect,
  depth,
  runId,
  authToken
}: {
  node: SiteStructureNode;
  selectedId?: string;
  onSelect: (id: string) => void;
  depth: number;
  runId?: string;
  authToken: string;
}) {
  const hasChildren = Boolean(node.children?.length);
  const openNode = previewNodeForStructureSelection(node);
  const line = (
    <div className={`structureLine ${selectedId === node.id ? "selected" : ""}`} style={{ paddingLeft: `${depth * 14 + 8}px` }}>
      <button onClick={() => onSelect(node.id)}>
        <span>{node.kind}</span>
        <strong>{node.label}</strong>
        {node.contentType ? <small>{node.contentType.split(";")[0]}</small> : null}
        {node.blobId ? <code>{compactHash(node.blobId)}</code> : null}
      </button>
      <div>
        <button title="Copy path" onClick={() => navigator.clipboard.writeText(node.path ?? node.artifactPath ?? node.label)}>
          <Clipboard size={13} />
        </button>
        {openNode?.artifactPath ? (
          <a title="Open artifact" href={artifactFileUrl(runId, openNode.artifactPath, authToken)} target="_blank" rel="noreferrer">
            <FolderOpen size={13} />
          </a>
        ) : null}
      </div>
    </div>
  );

  if (!hasChildren) return line;
  return (
    <details open={depth < 1} className="structureBranch">
      <summary>{line}</summary>
      {node.children?.map((child) => (
        <StructureTreeNode key={child.id} node={child} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} runId={runId} authToken={authToken} />
      ))}
    </details>
  );
}

type AiQuickPrompt = { label: string; question: string };
type NamespaceRecommendation = { title: string; detail: string };

const fallbackAiPrompts: AiQuickPrompt[] = [
  { label: "Namespace summary", question: "Summarize this namespace for a developer agent. Include the best pages and confidence level." },
  { label: "What to remember?", question: "What should this account remember about this namespace for future agent recall?" },
  { label: "API endpoints", question: "List any developer API endpoints, SDKs, auth model, and example payloads found in this context." },
  { label: "Install steps", question: "How does a new developer install or integrate this product in under 5 minutes?" },
  { label: "Risks / gaps", question: "What important information is missing or low-confidence in this extracted context?" }
];

function buildNamespaceAiPrompts(artifact: ArtifactManifest, run: RunResponse | null, accountLabel: string, history: RunHistoryItem[]): AiQuickPrompt[] {
  const namespace = namespaceLabel(artifact, run);
  const siteName = siteDisplayName(artifact);
  const account = accountLabel ? compactHash(accountLabel) : "this account";
  const hasWalrus = Boolean(artifact.walrus?.resources.length);
  const previousRuns = history.filter((item) => item.namespace === run?.manifest.namespace && item.runId !== run?.manifest.runId);
  const topics = topicHintsFromArtifact(artifact);
  const prompts: AiQuickPrompt[] = [
    {
      label: "For this account",
      question: `What should account ${account} do next with namespace ${namespace}? Include MCP usage, memory recommendations, and the most relevant extracted pages.`
    },
    {
      label: "What to remember?",
      question: `Create a concise memory note for account ${account} about ${siteName} from namespace ${namespace}. Include stable facts and open gaps.`
    },
    {
      label: "Best pages",
      question: `Which extracted pages in namespace ${namespace} are most useful for a developer agent, and why?`
    },
    hasWalrus
      ? {
          label: "Walrus proof",
          question: `Explain the Walrus resources and verification signals for ${namespace}. Which resources should an agent trust first?`
        }
      : {
          label: "Context quality",
          question: `How complete is this namespace for ${siteName}? Identify missing pages or weak evidence.`
        },
    previousRuns.length
      ? {
          label: "Recent changes",
          question: `Compare this namespace against previous runs for the same account. What likely changed and what should be rechecked?`
        }
      : {
          label: "First snapshot",
          question: `This appears to be the first snapshot for ${namespace}. What baseline should the account keep for later comparisons?`
        }
  ];

  if (topics.includes("developerDocs")) {
    prompts.push({ label: "SDK / APIs", question: `Extract SDK setup, API endpoints, auth requirements, and integration steps from ${namespace}.` });
  }
  if (topics.includes("pricing")) {
    prompts.push({ label: "Pricing", question: `Find pricing, plans, limits, free tier, and commercial terms for ${siteName}.` });
  }
  if (artifact.designSystem || artifact.brand) {
    prompts.push({ label: "Brand voice", question: `Summarize the brand voice, design tokens, and visual system for ${siteName} using this namespace.` });
  }

  return uniquePrompts(prompts.concat(fallbackAiPrompts)).slice(0, 7);
}

function buildNamespaceRecommendations(artifact: ArtifactManifest, run: RunResponse | null, accountLabel: string, history: RunHistoryItem[]): NamespaceRecommendation[] {
  const namespace = namespaceLabel(artifact, run);
  const siteName = siteDisplayName(artifact);
  const account = accountLabel ? `account ${compactHash(accountLabel)}` : "this account";
  const pageCount = artifact.pages.length;
  const resourceCount = artifact.walrus?.resources.length ?? 0;
  const imageCount = artifact.images.length;
  const previousRuns = history.filter((item) => item.namespace === run?.manifest.namespace && item.runId !== run?.manifest.runId);
  const mcpUrl = namespaceMcpUrl(namespace);

  return [
    {
      title: "Use as agent context",
      detail: `${namespace} has ${pageCount} pages${resourceCount ? ` and ${resourceCount} Walrus resources` : ""}. Query the MCP namespace before asking agents to reason about ${siteName}.`
    },
    {
      title: `Recommended for ${account}`,
      detail: `Save the namespace, target, top pages, MCP URL, and known gaps as recall context so future chats do not restart from a blank crawl.`
    },
    {
      title: "MCP endpoint",
      detail: mcpUrl
    },
    {
      title: "Ask evidence-first questions",
      detail: imageCount ? `Start with best pages, SDK/API details, and visual/brand assets. This run also has ${imageCount} extracted images.` : "Start with best pages, SDK/API details, target users, and missing evidence."
    },
    {
      title: previousRuns.length ? "Compare with earlier run" : "Create a baseline",
      detail: previousRuns.length ? `${previousRuns.length} related run${previousRuns.length === 1 ? "" : "s"} found for this namespace. Ask what changed before publishing or remembering.` : `No earlier run for this namespace is loaded. Treat this as the baseline for later alerts and diffs.`
    }
  ];
}

function uniquePrompts(prompts: AiQuickPrompt[]): AiQuickPrompt[] {
  const seen = new Set<string>();
  return prompts.filter((prompt) => {
    const key = `${prompt.label}:${prompt.question}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function namespaceLabel(artifact: ArtifactManifest, run: RunResponse | null): string {
  return run?.manifest.namespace || artifact.runId || safeDomain(artifact.target) || "current namespace";
}

function siteDisplayName(artifact: ArtifactManifest): string {
  return artifact.designSystem?.identity.name || artifact.brand?.name || safeDomain(artifact.target) || artifact.target;
}

function safeDomain(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  }
}

function namespaceMcpUrl(namespace: string): string {
  if (typeof window === "undefined") return `/mcp?namespace=${encodeURIComponent(namespace)}`;
  return `${window.location.origin}/mcp?namespace=${encodeURIComponent(namespace)}`;
}

function topicHintsFromArtifact(artifact: ArtifactManifest): string[] {
  const haystack = [artifact.target, artifact.brand?.description, artifact.designSystem?.identity.description, ...artifact.pages.slice(0, 8).flatMap((page) => [page.title, page.url, page.markdown.slice(0, 1400)])]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  const topics: string[] = [];
  if (/\b(api|sdk|developer|docs|quickstart|install|cli|endpoint|auth)\b/.test(haystack)) topics.push("developerDocs");
  if (/\b(pricing|plan|billing|free tier|subscription|paid|quota|limit)\b/.test(haystack)) topics.push("pricing");
  if (/\b(seal|encrypt|decrypt|access control|secret|private|policy)\b/.test(haystack)) topics.push("security");
  if (/\b(walrus|sui|blob|object id|resource|quilt)\b/.test(haystack)) topics.push("walrus");
  if (/\b(brand|design|token|color|font|component|style)\b/.test(haystack)) topics.push("brand");
  return topics;
}

function buildClientAiQueryResult(artifact: ArtifactManifest, run: RunResponse | null, question: string, accountLabel: string, history: RunHistoryItem[]): AiQueryResult {
  const namespace = namespaceLabel(artifact, run);
  const siteName = siteDisplayName(artifact);
  const account = accountLabel ? compactHash(accountLabel) : "this account";
  const pages = relevantPagesForQuestion(artifact, question, 5);
  const recommendations = buildNamespaceRecommendations(artifact, run, accountLabel, history);
  const pageCount = artifact.pages.length;
  const resourceCount = artifact.walrus?.resources.length ?? 0;
  const lowerQuestion = question.toLowerCase();
  const mcpUrl = namespaceMcpUrl(namespace);
  const directFocus = lowerQuestion.includes("pricing")
    ? "Pricing terms were not assumed. If no pricing page appears in the sources below, treat pricing as unknown and ask the site owner to add it to the namespace."
    : lowerQuestion.includes("api") || lowerQuestion.includes("sdk") || lowerQuestion.includes("install")
      ? "Focus on docs, SDK setup, auth, endpoints, and integration steps from the strongest extracted pages."
      : lowerQuestion.includes("remember") || lowerQuestion.includes("account")
        ? `For ${account}, remember the namespace, target, MCP URL, strongest pages, and any gaps that should be refreshed later.`
        : "Use the namespace summary, strongest pages, and extracted Walrus proof before making product claims.";

  return {
    target: artifact.target,
    data: {
      answer: `From namespace ${namespace}, ${siteName} currently has ${pageCount} extracted page${pageCount === 1 ? "" : "s"}${resourceCount ? ` and ${resourceCount} verified Walrus resource${resourceCount === 1 ? "" : "s"}` : ""}. ${directFocus}`,
      recommendedForThisAccount: recommendations.slice(0, 4).map((item) => `${item.title}: ${item.detail}`),
      bestPagesToRead: pages.length ? pages.map((page) => `${page.routePath ?? safeDomain(page.url)} — ${page.title ?? firstReadableSentence(page.markdown) ?? page.url}`) : ["No page-level markdown was available in this artifact."],
      agentNextSteps: [
        `Query MCP namespace: ${mcpUrl}`,
        `Ask: "What should account ${account} remember about ${namespace}?"`,
        resourceCount ? "Verify Walrus resource paths before citing object/blob proof." : "Re-run with Walrus mode if object/resource proof is required."
      ],
      confidenceNote: "Client-side namespace answer. It uses the extracted manifest and page markdown because the hosted AI Query route is not available for public demo jobs yet."
    },
    confidence: pages.length ? 0.62 : 0.42,
    usedProvider: "namespace heuristic",
    sources: pages.map((page) => ({
      url: page.url,
      routePath: page.routePath,
      resourcePath: page.source?.resourcePath ?? page.artifactPath,
      blobId: page.source?.blobId,
      quote: firstReadableSentence(page.markdown)
    }))
  };
}

function relevantPagesForQuestion(artifact: ArtifactManifest, question: string, limit: number): ArtifactManifest["pages"] {
  const terms = question
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((term) => term.length > 2 && !["the", "and", "for", "this", "that", "with", "from", "what", "how"].includes(term));

  return artifact.pages
    .map((page, index) => {
      const text = [page.title, page.routePath, page.url, page.markdown.slice(0, 4000)].filter(Boolean).join(" ").toLowerCase();
      const score = terms.reduce((sum, term) => sum + (text.includes(term) ? 2 : 0), 0) + (page.title ? 1 : 0) + Math.max(0, 4 - index) * 0.1;
      return { page, score };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((item) => item.page);
}

function firstReadableSentence(markdown?: string): string | undefined {
  if (!markdown) return undefined;
  const cleaned = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[[^\]]+]\([^)]*\)/g, (match) => match.replace(/^\[|\]\([^)]*\)$/g, ""))
    .replace(/[#*_>`~|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = cleaned.split(/(?<=[.!?])\s+/).find((part) => part.length >= 48) ?? cleaned.slice(0, 180);
  return sentence ? `${sentence.slice(0, 220)}${sentence.length > 220 ? "..." : ""}` : undefined;
}

function shouldUseClientAiFallback(status: number | null, message: string, artifact: ArtifactManifest): boolean {
  if (!artifact.pages.length) return false;
  // Hosted worker now serves /api/runs/:id/ai-query via Workers AI.
  // Only fall back to the client-only stub when the endpoint is truly missing
  // (404 / 501) or the network is unreachable. Real LLM/runtime errors should
  // surface to the user instead of being silently masked.
  if (status === 404 || status === 501) return true;
  return isLocalApiBase(API_BASE) && /not found|ai query|openai/i.test(message);
}

type AiChatTurn = { id: string; question: string; result: AiQueryResult; at: string };

function AiQueryPanel({
  artifact,
  run,
  setArtifact,
  authToken,
  history,
  accountLabel
}: {
  artifact: ArtifactManifest;
  run: RunResponse | null;
  setArtifact: React.Dispatch<React.SetStateAction<ArtifactManifest | null>>;
  authToken: string;
  history: RunHistoryItem[];
  accountLabel: string;
}) {
  const [question, setQuestion] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [schema, setSchema] = useState('{\n  "answer": { "type": "text", "description": "Direct answer to the question" },\n  "keyFacts": { "type": "list", "description": "Important facts with source support" }\n}');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<AiChatTurn[]>(() => (artifact.aiQuery ? [{ id: "initial", question: "(previous query)", result: artifact.aiQuery, at: "" }] : []));
  const quickPrompts = useMemo(() => buildNamespaceAiPrompts(artifact, run, accountLabel, history), [artifact, run?.manifest.namespace, run?.manifest.runId, accountLabel, history]);
  const recommendations = useMemo(() => buildNamespaceRecommendations(artifact, run, accountLabel, history), [artifact, run?.manifest.namespace, run?.manifest.runId, accountLabel, history]);
  const namespace = namespaceLabel(artifact, run);

  useEffect(() => {
    setTurns(artifact.aiQuery ? [{ id: "initial", question: "(previous query)", result: artifact.aiQuery, at: "" }] : []);
    setError(null);
    setQuestion("");
  }, [artifact.runId, artifact.target, run?.manifest.runId]);

  function appendResult(prompt: string, nextResult: AiQueryResult) {
    setArtifact((current) => (current ? { ...current, aiQuery: nextResult } : current));
    setTurns((prev) => [...prev, { id: `${Date.now()}`, question: prompt, result: nextResult, at: new Date().toISOString() }]);
    setQuestion("");
  }

  async function runQuery(text?: string) {
    if (!run) return;
    const prompt = (text ?? question).trim();
    if (!prompt) return;
    setBusy(true);
    setError(null);
    let parsedSchema: unknown;
    try {
      parsedSchema = showAdvanced && schema.trim() ? JSON.parse(schema) : undefined;
    } catch {
      setError("Structured schema is not valid JSON.");
      setBusy(false);
      return;
    }
    try {
      const response = await fetch(`${API_BASE}/api/runs/${run.manifest.runId}/ai-query`, {
        method: "POST",
        headers: authHeaders(authToken, { "content-type": "application/json" }),
        body: JSON.stringify({ question: prompt, schema: parsedSchema })
      });
      if (!response.ok) {
        const message = await readResponseError(response);
        if (shouldUseClientAiFallback(response.status, message, artifact)) {
          appendResult(prompt, buildClientAiQueryResult(artifact, run, prompt, accountLabel, history));
          return;
        }
        throw new Error(message);
      }
      const nextResult = (await response.json()) as AiQueryResult;
      appendResult(prompt, nextResult);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (shouldUseClientAiFallback(null, message, artifact)) {
        appendResult(prompt, buildClientAiQueryResult(artifact, run, prompt, accountLabel, history));
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel queryPanel aiChatPanel">
      <section className="aiNamespaceBrief">
        <div className="aiNamespaceBriefHead">
          <span>
            <Brain size={15} />
            Recommended for this namespace
          </span>
          <code>{namespace}</code>
          {accountLabel ? <small>{compactHash(accountLabel)}</small> : null}
        </div>
        <div className="aiRecommendationGrid">
          {recommendations.slice(0, 4).map((item) => (
            <article key={item.title}>
              <strong>{item.title}</strong>
              <p>{item.detail}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="aiChatStream" aria-live="polite">
        {turns.length === 0 ? (
          <div className="aiChatEmpty">
            <MessageSquare size={20} />
            <strong>Ask anything about this context</strong>
            <span>Suggested prompts are tuned to this namespace and account. Hosted runs query Workers AI server-side over the extracted pages; client-side fallback only kicks in if the worker endpoint is unreachable.</span>
          </div>
        ) : (
          turns.map((turn) => (
            <article key={turn.id} className="aiChatTurn">
              <div className="aiChatUser">
                <span>You</span>
                <p>{turn.question}</p>
              </div>
              <div className="aiChatAssistant">
                <div className="aiChatAssistantHead">
                  <span>ContextMeM</span>
                  <small>{turn.result.usedProvider} · {Math.round(turn.result.confidence * 100)}%</small>
                </div>
                <AiResultData data={turn.result.data} />
                {turn.result.sources.length ? (
                  <details className="aiChatSources">
                    <summary>{turn.result.sources.length} source{turn.result.sources.length === 1 ? "" : "s"}</summary>
                    <div className="sourceGrid">
                      {turn.result.sources.map((source, index) => (
                        <article key={`${source.url}-${index}`}>
                          <strong>{source.routePath ?? source.url}</strong>
                          {source.quote ? <p>{source.quote}</p> : null}
                          <code>{source.resourcePath ?? source.blobId ?? source.url}</code>
                        </article>
                      ))}
                    </div>
                  </details>
                ) : null}
              </div>
            </article>
          ))
        )}
      </section>

      <section className="aiChatComposer">
        <div className="memoryQuickPrompts aiPrompts">
          {quickPrompts.map((prompt) => (
            <button key={prompt.label} type="button" onClick={() => void runQuery(prompt.question)} disabled={!run || busy}>
              {prompt.label}
            </button>
          ))}
        </div>
        <form
          className="aiChatForm"
          onSubmit={(event) => {
            event.preventDefault();
            void runQuery();
          }}
        >
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="Ask about this site… pricing, APIs, tone, target users, recent changes"
            rows={2}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void runQuery();
              }
            }}
          />
          <button className="run inline" type="submit" disabled={!run || busy || !question.trim()}>
            <MessageSquare size={16} />
            {busy ? "Asking" : "Ask"}
          </button>
        </form>
        <button type="button" className="aiChatAdvancedToggle" onClick={() => setShowAdvanced((value) => !value)}>
          {showAdvanced ? "Hide" : "Show"} structured schema (advanced)
        </button>
        {showAdvanced ? (
          <label className="aiChatSchema">
            <span>Structured schema (JSON)</span>
            <textarea value={schema} onChange={(event) => setSchema(event.target.value)} spellCheck={false} rows={5} />
          </label>
        ) : null}
        {error ? (
          <div className="error">
            {error}
            <FailureExplainer message={error} />
          </div>
        ) : null}
      </section>
    </div>
  );
}

function AiResultData({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data);
  if (!entries.length) return <div className="subEmpty aiResultEmpty">No structured data returned.</div>;

  return (
    <div className="aiResultData">
      {entries.map(([key, value]) => (
        <article className="aiResultCard" key={key}>
          <span>{formatAiFieldLabel(key)}</span>
          <AiResultValue value={value} />
        </article>
      ))}
    </div>
  );
}

function AiResultValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    const items = value.map((item) => stringifyAiValue(item)).filter(Boolean);
    return items.length ? (
      <ul>
        {items.map((item, index) => (
          <li key={`${item}-${index}`}>{item}</li>
        ))}
      </ul>
    ) : (
      <p className="mutedText">No items found.</p>
    );
  }

  if (value && typeof value === "object") {
    return <pre className="compactJson">{JSON.stringify(value, null, 2)}</pre>;
  }

  const text = stringifyAiValue(value);
  if (!text) return <p className="mutedText">No answer returned.</p>;
  return (
    <div className="aiTextAnswer">
      {splitAiParagraphs(text).map((paragraph, index) => (
        <p key={`${paragraph}-${index}`}>{paragraph}</p>
      ))}
    </div>
  );
}

function stringifyAiValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return "";
  return JSON.stringify(value);
}

function splitAiParagraphs(text: string): string[] {
  return text
    .replaceAll(/\\n/g, "\n")
    .split(/\n{2,}/g)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function formatAiFieldLabel(value: string): string {
  return value
    .replaceAll(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatSnippetLabel(value: string): string {
  const labels: Record<string, string> = {
    claudeDesktop: "Claude Desktop",
    contextMcpGateway: "Gateway",
    mcpRemote: "mcp-remote",
    generic: "Generic MCP",
    cursor: "Cursor",
    codex: "Codex"
  };
  return labels[value] ?? formatAiFieldLabel(value);
}

function ArtifactViewerPanel({ run, authToken }: { run: RunResponse | null; authToken: string }) {
  const [files, setFiles] = useState<ArtifactFileRecord[]>([]);
  const [selected, setSelected] = useState<ArtifactFileRecord | null>(null);
  const [preview, setPreview] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!run) return;
    void loadFiles();
  }, [run?.manifest.runId]);

  async function loadFiles() {
    if (!run) return;
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/runs/${run.manifest.runId}/artifact-files`, { headers: authHeaders(authToken) });
      if (!response.ok) throw new Error(await readResponseError(response));
      const nextFiles = (await response.json()) as ArtifactFileRecord[];
      setFiles(nextFiles);
      setSelected(nextFiles.find((file) => file.path === "/context/design-system.json") ?? nextFiles.find((file) => file.previewable) ?? nextFiles[0] ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    if (!run || !selected || selected.kind === "image") {
      setPreview("");
      return;
    }
    if (!selected.previewable) {
      setPreview("Preview unavailable for this file.");
      return;
    }
    void fetch(artifactFileUrl(run.manifest.runId, selected.path, authToken), { headers: authHeaders(authToken) })
      .then((response) => (response.ok ? response.text() : response.text().then((text) => Promise.reject(new Error(text)))))
      .then(setPreview)
      .catch((err) => setPreview(err instanceof Error ? err.message : String(err)));
  }, [authToken, run?.manifest.runId, selected?.path]);

  const grouped = files.reduce<Record<string, ArtifactFileRecord[]>>((acc, file) => {
    acc[file.group] = [...(acc[file.group] ?? []), file];
    return acc;
  }, {});

  return (
    <div className="panel artifactPanel">
      <aside className="artifactList">
        <div className="sectionHead">
          <h2>Artifacts</h2>
          <span>{files.length} files</span>
        </div>
        {error ? <div className="error">{error}</div> : null}
        {Object.entries(grouped).map(([group, groupFiles]) => (
          <section key={group}>
            <h3>{group}</h3>
            {groupFiles.map((file) => (
              <button key={file.path} className={selected?.path === file.path ? "selected" : ""} onClick={() => setSelected(file)}>
                <FileText size={14} />
                <span>{file.path}</span>
                <small>{formatBytes(file.size)}</small>
              </button>
            ))}
          </section>
        ))}
      </aside>
      <section className="artifactPreview">
        {selected ? (
          <>
            <div className="artifactPreviewHead">
              <div>
                <strong>{selected.path}</strong>
                <span>{selected.contentType} · {formatBytes(selected.size)}</span>
              </div>
              <a className="downloadLink" href={`${artifactFileUrl(run?.manifest.runId, selected.path, authToken)}&download=1`}>
                <Download size={15} />
                Download
              </a>
            </div>
            {selected.kind === "image" ? (
              <div className="artifactImage">
                <img src={artifactFileUrl(run?.manifest.runId, selected.path, authToken)} alt={selected.path} />
              </div>
            ) : (
              <pre>{preview}</pre>
            )}
          </>
        ) : (
          <div className="subEmpty">No artifacts found for this run.</div>
        )}
      </section>
    </div>
  );
}

function CompareAppPage({ history, authToken }: { history: RunHistoryItem[]; authToken: string }) {
  const [leftRunId, setLeftRunId] = useState<string>("");
  const [rightRunId, setRightRunId] = useState<string>("");
  const [leftManifest, setLeftManifest] = useState<ArtifactManifest | null>(null);
  const [rightManifest, setRightManifest] = useState<ArtifactManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"left" | "right" | null>(null);

  useEffect(() => {
    if (history.length >= 2 && !leftRunId && !rightRunId) {
      const first = history[0];
      const second = history[1];
      if (first) setLeftRunId(first.runId);
      if (second) setRightRunId(second.runId);
    }
  }, [history, leftRunId, rightRunId]);

  async function loadManifest(runId: string, side: "left" | "right") {
    if (!runId) {
      if (side === "left") setLeftManifest(null);
      else setRightManifest(null);
      return;
    }
    setBusy(side);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/runs/${encodeURIComponent(runId)}/artifact-file?path=context/manifest.json`, {
        headers: authHeaders(authToken)
      });
      if (!response.ok) throw new Error(await readResponseError(response));
      const manifest = (await response.json()) as ArtifactManifest;
      if (side === "left") setLeftManifest(manifest);
      else setRightManifest(manifest);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void loadManifest(leftRunId, "left");
  }, [leftRunId]);
  useEffect(() => {
    void loadManifest(rightRunId, "right");
  }, [rightRunId]);

  return (
    <section className="comparePage">
      <header className="compareHead">
        <label>
          <span>Left run</span>
          <select value={leftRunId} onChange={(event) => setLeftRunId(event.target.value)}>
            <option value="">— pick a run —</option>
            {history.map((item) => (
              <option key={item.runId} value={item.runId}>
                {compactTarget(item.target)} · {item.mode} · {new Date(item.updatedAt).toLocaleDateString()}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Right run</span>
          <select value={rightRunId} onChange={(event) => setRightRunId(event.target.value)}>
            <option value="">— pick a run —</option>
            {history.map((item) => (
              <option key={item.runId} value={item.runId}>
                {compactTarget(item.target)} · {item.mode} · {new Date(item.updatedAt).toLocaleDateString()}
              </option>
            ))}
          </select>
        </label>
      </header>

      {error ? (
        <div className="errorState panel">
          <p>{error}</p>
          <FailureExplainer message={error} />
        </div>
      ) : null}

      {busy ? <div className="subEmpty">Loading manifest…</div> : null}

      <div className="compareGrid">
        <CompareColumn label="Left" manifest={leftManifest} />
        <CompareColumn label="Right" manifest={rightManifest} />
      </div>
    </section>
  );
}

function CompareColumn({ label, manifest }: { label: string; manifest: ArtifactManifest | null }) {
  if (!manifest) {
    return <div className="compareColumn panel subEmpty">No run selected for {label.toLowerCase()}.</div>;
  }
  const colors = manifest.brand?.colors?.slice(0, 8) ?? manifest.styleguide?.colors.palette.slice(0, 8) ?? [];
  const fonts = manifest.brand?.fonts ?? manifest.styleguide?.typography.fontFamilies ?? [];
  const pages = manifest.pages.slice(0, 6);
  const designColors = manifest.designSystem?.tokens.colors.slice(0, 8) ?? [];
  return (
    <article className="compareColumn panel">
      <header>
        <span>{label}</span>
        <strong>{manifest.brand?.name ?? manifest.brand?.domain ?? compactTarget(manifest.target)}</strong>
        <code>{compactTarget(manifest.target)}</code>
      </header>

      <section className="compareSection">
        <h3>Brand</h3>
        {manifest.brand?.description ? <p>{manifest.brand.description}</p> : <p className="subEmpty">No brand description extracted.</p>}
        <div className="comparePalette">
          {colors.length ? colors.map((color) => (
            <span key={color} style={{ background: color }} title={color}>
              <small>{color}</small>
            </span>
          )) : <span className="subEmpty">No palette</span>}
        </div>
        <div className="compareFonts">
          {fonts.slice(0, 4).map((font) => <code key={font}>{font}</code>)}
        </div>
      </section>

      <section className="compareSection">
        <h3>Design tokens</h3>
        {designColors.length ? (
          <div className="comparePalette">
            {designColors.map((token) => (
              <span key={`${token.name}-${token.value}`} style={{ background: token.value }} title={`${token.name} → ${token.value}`}>
                <small>{token.name}</small>
              </span>
            ))}
          </div>
        ) : <p className="subEmpty">No design system extracted.</p>}
      </section>

      <section className="compareSection">
        <h3>Pages ({manifest.pages.length})</h3>
        <ul className="compareList">
          {pages.map((page) => (
            <li key={page.url}>
              <strong>{page.title ?? page.routePath ?? page.url}</strong>
              <span>{page.routePath ?? page.url}</span>
            </li>
          ))}
        </ul>
      </section>

      {manifest.walrus ? (
        <section className="compareSection">
          <h3>Walrus</h3>
          <p>
            <code>{manifest.walrus.site.siteObjectId.slice(0, 18)}…</code>
            {manifest.walrus.site.suinsName ? <> · {manifest.walrus.site.suinsName}</> : null}
          </p>
          <small>{manifest.walrus.resources.length} resources verified</small>
        </section>
      ) : null}
    </article>
  );
}

function PublishPanel({ run, authToken }: { run: RunResponse | null; authToken: string }) {
  const [readiness, setReadiness] = useState<PublishReadiness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hostedVisibility, setHostedVisibility] = useState<"private" | "public">("private");
  const [hostedDirectoryEnabled, setHostedDirectoryEnabled] = useState(false);
  const [hostedNamespace, setHostedNamespace] = useState("");
  const [hostedDisplayName, setHostedDisplayName] = useState("");
  const [hostedDescription, setHostedDescription] = useState("");
  const [hostedTags, setHostedTags] = useState("");
  const [hostedBusy, setHostedBusy] = useState(false);
  const [hostedError, setHostedError] = useState<string | null>(null);
  const [hostedResult, setHostedResult] = useState<HostedNamespaceImportResponse | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareResult, setShareResult] = useState<{ share: ShareLinkResponse["share"]; url: string } | null>(null);

  useEffect(() => {
    if (!run) return;
    setHostedError(null);
    setHostedResult(null);
    setHostedNamespace(run.manifest.namespace);
    setHostedDisplayName(defaultDisplayName(run.manifest.target));
    setHostedDescription("");
    setHostedTags(run.manifest.mode === "walrus" ? "walrus,context" : "web,context");
    void fetch(`${API_BASE}/api/runs/${run.manifest.runId}/publish-readiness`, { headers: authHeaders(authToken) })
      .then((response) => (response.ok ? response.json() : response.text().then((text) => Promise.reject(new Error(text)))))
      .then((data) => setReadiness(data as PublishReadiness))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [authToken, run?.manifest.runId]);

  async function publishHostedNamespace() {
    if (!run) return;
    setHostedBusy(true);
    setHostedError(null);
    try {
      const response = await fetch(`${API_BASE}/api/runs/${run.manifest.runId}/hosted/import`, {
        method: "POST",
        headers: authHeaders(authToken, { "content-type": "application/json" }),
        body: JSON.stringify({
          visibility: hostedVisibility,
          namespace: hostedNamespace || run.manifest.namespace,
          displayName: hostedDisplayName || defaultDisplayName(run.manifest.target),
          description: hostedDescription || undefined,
          tags: hostedTags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
          directoryEnabled: hostedVisibility === "public" && hostedDirectoryEnabled
        })
      });
      if (!response.ok) throw new Error(await readResponseError(response));
      setHostedResult((await response.json()) as HostedNamespaceImportResponse);
    } catch (err) {
      setHostedError(err instanceof Error ? err.message : String(err));
    } finally {
      setHostedBusy(false);
    }
  }

  async function createShareLink() {
    if (!run) return;
    setShareBusy(true);
    setHostedError(null);
    try {
      const response = await fetch(`${API_BASE}/api/runs/${run.manifest.runId}/share`, {
        method: "POST",
        headers: authHeaders(authToken, { "content-type": "application/json" }),
        body: JSON.stringify({ title: hostedDisplayName || defaultDisplayName(run.manifest.target), description: hostedDescription || undefined })
      });
      if (!response.ok) throw new Error(await readResponseError(response));
      setShareResult((await response.json()) as { share: ShareLinkResponse["share"]; url: string });
    } catch (err) {
      setHostedError(err instanceof Error ? err.message : String(err));
    } finally {
      setShareBusy(false);
    }
  }

  if (!run) return <JsonPanel data={{ status: "No run selected" }} />;
  if (error) return <div className="panel"><div className="error">{error}</div></div>;
  if (!readiness) return <div className="empty">Loading publish package...</div>;

  return (
    <div className="panel publishPanel">
      <section className="publishHero">
        <div>
          <span>Walrus package readiness</span>
          <h2>{readiness.ready ? "Ready to publish" : "Needs files"}</h2>
        </div>
        <div className="publishStats">
          <strong>{readiness.routeCount}</strong>
          <span>routes</span>
          <strong>{readiness.artifactCount}</strong>
          <span>artifacts</span>
          <strong>{formatBytes(readiness.totalBytes)}</strong>
          <span>package</span>
        </div>
      </section>

      <section className="designSection split">
        <article>
          <div className="sectionHead">
            <h2>Required Files</h2>
            <span>static package</span>
          </div>
          <FileChecklist files={readiness.required} />
        </article>
        <article>
          <div className="sectionHead">
            <h2>Optional Exports</h2>
            <span>agent/design extras</span>
          </div>
          <FileChecklist files={readiness.optional} />
        </article>
      </section>

      {readiness.warnings.length ? (
        <section className="warningList">
          {readiness.warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </section>
      ) : null}

      <section className="commandBox">
        <div className="sectionHead">
          <h2>Publish Commands</h2>
          <span>run locally with site-builder</span>
        </div>
        <code>{readiness.commands.publish}</code>
        <button onClick={() => navigator.clipboard.writeText(readiness.commands.publish)}>
          <Clipboard size={15} />
          Copy publish command
        </button>
        {readiness.commands.update ? <code>{readiness.commands.update}</code> : null}
      </section>

      <section className="namespacePanel">
        <div className="sectionHead">
          <h2>Hosted MCP Namespace</h2>
          <span>{run.manifest.namespace}</span>
        </div>
        <div className="namespaceForm">
          <label>
            <span>Namespace</span>
            <input value={hostedNamespace} onChange={(event) => setHostedNamespace(event.target.value)} placeholder="team.project or walrus:mainnet:0x..." />
          </label>
          <label>
            <span>Display name</span>
            <input value={hostedDisplayName} onChange={(event) => setHostedDisplayName(event.target.value)} placeholder="Docs, product, client, or project name" />
          </label>
          <label className="wide">
            <span>Description</span>
            <input value={hostedDescription} onChange={(event) => setHostedDescription(event.target.value)} placeholder="Short note shown in your namespace dashboard and public directory" />
          </label>
          <label>
            <span>Tags</span>
            <input value={hostedTags} onChange={(event) => setHostedTags(event.target.value)} placeholder="walrus, docs, design" />
          </label>
        </div>
        <div className="namespaceControls">
          <div className="segmented compact">
            <button className={hostedVisibility === "private" ? "selected" : ""} onClick={() => setHostedVisibility("private")}>
              Private
            </button>
            <button className={hostedVisibility === "public" ? "selected" : ""} onClick={() => setHostedVisibility("public")}>
              Public
            </button>
          </div>
          <label className="inlineCheck">
            <input type="checkbox" checked={hostedDirectoryEnabled} disabled={hostedVisibility !== "public"} onChange={(event) => setHostedDirectoryEnabled(event.target.checked)} />
            Directory
          </label>
          <button className="secondary" onClick={publishHostedNamespace} disabled={hostedBusy}>
            <Server size={15} />
            {hostedBusy ? "Publishing" : "Publish MCP namespace"}
          </button>
          <button className="secondary" onClick={createShareLink} disabled={shareBusy}>
            <Share2 size={15} />
            {shareBusy ? "Creating" : "Create share page"}
          </button>
        </div>
        {hostedError ? <div className="error">{hostedError}</div> : null}
        {shareResult ? (
          <label className="shareResultLink">
            <span>Share URL</span>
            <code>{shareResult.url}</code>
            <button onClick={() => navigator.clipboard.writeText(shareResult.url)}>
              <Clipboard size={14} />
              Copy
            </button>
          </label>
        ) : null}
        {hostedResult ? (
          <div className="namespaceResult">
            <div className="namespaceMeta">
              <div>
                <span>version</span>
                <strong>{hostedResult.versionId}</strong>
              </div>
              <div>
                <span>artifacts</span>
                <strong>{hostedResult.artifactCount}</strong>
              </div>
              <div>
                <span>size</span>
                <strong>{formatBytes(hostedResult.byteLength)}</strong>
              </div>
            </div>
            <label>
              <span>Gateway</span>
              <code>{hostedResult.gatewayMcpUrl ?? ""}</code>
              <button onClick={() => navigator.clipboard.writeText(hostedResult.gatewayMcpUrl ?? "")}>
                <Clipboard size={14} />
                Copy
              </button>
            </label>
            <label>
              <span>MCP URL</span>
              <code>{hostedResult.mcpUrl}</code>
              <button onClick={() => navigator.clipboard.writeText(hostedResult.mcpUrl)}>
                <Clipboard size={14} />
                Copy
              </button>
            </label>
            <label>
              <span>Read token</span>
              <code className="secretToken">{hostedResult.readToken}</code>
              <button onClick={() => navigator.clipboard.writeText(hostedResult.readToken)}>
                <Clipboard size={14} />
                Copy
              </button>
            </label>
            <div className="snippetGrid">
              {Object.entries(hostedResult.snippets)
                .filter(([, snippet]) => Boolean(snippet))
                .map(([label, snippet]) => (
                  <article key={label}>
                    <div className="sectionHead">
                      <h2>{formatSnippetLabel(label)}</h2>
                      <button onClick={() => navigator.clipboard.writeText(JSON.stringify(snippet, null, 2))}>
                        <Clipboard size={14} />
                        Copy
                      </button>
                    </div>
                    <pre>{JSON.stringify(snippet, null, 2)}</pre>
                  </article>
                ))}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function NamespacesAppPage({ authToken }: { authToken: string }) {
  const [namespaces, setNamespaces] = useState<HostedNamespaceSummary[]>([]);
  const [directory, setDirectory] = useState<HostedNamespaceSummary[]>([]);
  const [selected, setSelected] = useState<HostedNamespaceSummary | null>(null);
  const [tokens, setTokens] = useState<HostedNamespaceToken[]>([]);
  const [newTokenLabel, setNewTokenLabel] = useState("agent import");
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [metadataDraft, setMetadataDraft] = useState({ displayName: "", description: "", tags: "", visibility: "private" as "private" | "public", directoryEnabled: false });
  const [extractTarget, setExtractTarget] = useState("https://fmsprint.wal.app/");
  const [extractNamespace, setExtractNamespace] = useState("");
  const [extractJob, setExtractJob] = useState<HostedExtractionJob | null>(null);
  const [schedules, setSchedules] = useState<HostedSchedule[]>([]);
  const [alerts, setAlerts] = useState<ContextAlert[]>([]);
  const [scheduleTarget, setScheduleTarget] = useState("https://fmsprint.wal.app/");
  const [scheduleNamespace, setScheduleNamespace] = useState("");
  const [scheduleInterval, setScheduleInterval] = useState(24);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setError(null);
    const [ownedResponse, directoryResponse, schedulesResponse, alertsResponse] = await Promise.all([
      fetch(`${API_BASE}/api/hosted/namespaces`, { headers: authHeaders(authToken) }),
      fetch(`${API_BASE}/api/hosted/directory`, { headers: authHeaders(authToken) }),
      fetch(`${API_BASE}/api/hosted/schedules`, { headers: authHeaders(authToken) }),
      fetch(`${API_BASE}/api/hosted/alerts`, { headers: authHeaders(authToken) })
    ]);
    if (!ownedResponse.ok) throw new Error(await readResponseError(ownedResponse));
    if (!directoryResponse.ok) throw new Error(await readResponseError(directoryResponse));
    const owned = (await ownedResponse.json()) as { namespaces: HostedNamespaceSummary[] };
    const publicDirectory = (await directoryResponse.json()) as { namespaces: HostedNamespaceSummary[] };
    setNamespaces(owned.namespaces ?? []);
    setDirectory(publicDirectory.namespaces ?? []);
    if (schedulesResponse.ok) setSchedules(((await schedulesResponse.json()) as { schedules: HostedSchedule[] }).schedules ?? []);
    if (alertsResponse.ok) setAlerts(((await alertsResponse.json()) as { alerts: ContextAlert[] }).alerts ?? []);
    setSelected((current) => (current ? owned.namespaces.find((item) => item.namespace === current.namespace) ?? current : owned.namespaces[0] ?? null));
  };

  useEffect(() => {
    void refresh().catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [authToken]);

  useEffect(() => {
    if (!selected) {
      setTokens([]);
      return;
    }
    void fetch(`${API_BASE}/api/hosted/namespaces/${encodeURIComponent(selected.namespace)}/tokens`, { headers: authHeaders(authToken) })
      .then((response) => (response.ok ? response.json() : response.text().then((text) => Promise.reject(new Error(text)))))
      .then((body: { tokens: HostedNamespaceToken[] }) => setTokens(body.tokens ?? []))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [authToken, selected?.namespace]);

  useEffect(() => {
    if (!selected) return;
    setMetadataDraft({
      displayName: selected.displayName ?? defaultDisplayName(selected.target),
      description: selected.description ?? "",
      tags: selected.tags?.join(", ") ?? "",
      visibility: selected.visibility,
      directoryEnabled: Boolean(selected.directoryEnabled)
    });
    setFreshToken(null);
  }, [selected?.namespace]);

  async function copyText(value: string) {
    await navigator.clipboard.writeText(value);
  }

  async function createToken() {
    if (!selected) return;
    setBusy("token");
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/hosted/namespaces/${encodeURIComponent(selected.namespace)}/tokens`, {
        method: "POST",
        headers: authHeaders(authToken, { "content-type": "application/json" }),
        body: JSON.stringify({ label: newTokenLabel })
      });
      if (!response.ok) throw new Error(await readResponseError(response));
      const body = (await response.json()) as { readToken: string };
      setFreshToken(body.readToken);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function revokeToken(tokenId: string) {
    if (!selected) return;
    setBusy(tokenId);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/hosted/namespaces/${encodeURIComponent(selected.namespace)}/tokens/${encodeURIComponent(tokenId)}`, {
        method: "DELETE",
        headers: authHeaders(authToken)
      });
      if (!response.ok) throw new Error(await readResponseError(response));
      const tokenResponse = await fetch(`${API_BASE}/api/hosted/namespaces/${encodeURIComponent(selected.namespace)}/tokens`, { headers: authHeaders(authToken) });
      if (tokenResponse.ok) setTokens(((await tokenResponse.json()) as { tokens: HostedNamespaceToken[] }).tokens ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function updateSelectedNamespace() {
    if (!selected) return;
    setBusy("metadata");
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/hosted/namespaces/${encodeURIComponent(selected.namespace)}`, {
        method: "PATCH",
        headers: authHeaders(authToken, { "content-type": "application/json" }),
        body: JSON.stringify({
          displayName: metadataDraft.displayName || undefined,
          description: metadataDraft.description || undefined,
          visibility: metadataDraft.visibility,
          directoryEnabled: metadataDraft.visibility === "public" && metadataDraft.directoryEnabled,
          tags: metadataDraft.tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean)
        })
      });
      if (!response.ok) throw new Error(await readResponseError(response));
      const body = (await response.json()) as { namespace?: HostedNamespaceSummary } | HostedNamespaceSummary;
      const updated = ("namespace" in body && typeof body.namespace === "object" ? body.namespace : body) as HostedNamespaceSummary;
      setSelected(updated);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function startExtraction() {
    setBusy("extract");
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/hosted/extractions`, {
        method: "POST",
        headers: authHeaders(authToken, { "content-type": "application/json" }),
        body: JSON.stringify({
          target: extractTarget,
          namespace: extractNamespace || undefined,
          visibility: "private",
          displayName: defaultDisplayName(extractTarget),
          tags: ["extract", "context"],
          directoryEnabled: false
        })
      });
      if (!response.ok) throw new Error(await readResponseError(response));
      const body = (await response.json()) as { job: HostedExtractionJob };
      setExtractJob(body.job);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function createSchedule() {
    setBusy("schedule");
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/hosted/schedules`, {
        method: "POST",
        headers: authHeaders(authToken, { "content-type": "application/json" }),
        body: JSON.stringify({
          target: scheduleTarget,
          namespace: scheduleNamespace || undefined,
          intervalHours: scheduleInterval,
          webhookUrl: webhookUrl || undefined,
          webhookSecret: webhookSecret || undefined,
          active: true
        })
      });
      if (!response.ok) throw new Error(await readResponseError(response));
      setWebhookSecret("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function toggleSchedule(schedule: HostedSchedule) {
    setBusy(schedule.id);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/hosted/schedules/${encodeURIComponent(schedule.id)}`, {
        method: "PATCH",
        headers: authHeaders(authToken, { "content-type": "application/json" }),
        body: JSON.stringify({ active: !schedule.active })
      });
      if (!response.ok) throw new Error(await readResponseError(response));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="panel namespaceDashboard">
      {error ? <div className="error">{error}</div> : null}
      <section className="namespacePanel">
        <div className="sectionHead">
          <h2>Your ContextMCP Namespaces</h2>
          <span>{namespaces.length} namespaces</span>
        </div>
        <div className="namespaceList">
          {namespaces.map((item) => (
            <button key={item.namespace} className={selected?.namespace === item.namespace ? "selected" : ""} onClick={() => setSelected(item)}>
              <strong>{item.displayName || item.namespace}</strong>
              <code>{item.namespace}</code>
              <span>{item.visibility} · {item.artifactCount} artifacts · {item.directoryEnabled ? "directory" : "unlisted"}</span>
            </button>
          ))}
          {!namespaces.length ? <div className="subEmpty">Publish a run or start a Cloudflare extraction to create your first namespace.</div> : null}
        </div>
      </section>

      {selected ? (
        <section className="namespacePanel">
          <div className="sectionHead">
            <h2>{selected.displayName || selected.namespace}</h2>
            <button onClick={() => navigator.clipboard.writeText(selected.mcpUrl)}>
              <Clipboard size={14} />
              Copy MCP URL
            </button>
          </div>
          <div className="namespaceMeta">
            <div><span>visibility</span><strong>{selected.visibility}</strong></div>
            <div><span>updated</span><strong>{formatDateTime(selected.updatedAt)}</strong></div>
            <div><span>size</span><strong>{formatBytes(selected.byteLength)}</strong></div>
          </div>
          <code>{selected.mcpUrl}</code>
          <div className="tokenBox">
            <div className="sectionHead">
              <h2>Read Tokens</h2>
              <span>hashed at rest</span>
            </div>
            <div className="tokenCreate">
              <input value={newTokenLabel} onChange={(event) => setNewTokenLabel(event.target.value)} />
              <button onClick={createToken} disabled={busy === "token"}>
                <KeyRound size={14} />
                Create token
              </button>
            </div>
            {freshToken ? (
              <label className="freshToken">
                <span>New token</span>
                <code>{freshToken}</code>
                <button onClick={() => navigator.clipboard.writeText(freshToken)}>
                  <Clipboard size={14} />
                  Copy
                </button>
              </label>
            ) : null}
            <div className="tokenList">
              {tokens.map((token) => (
                <div key={token.id}>
                  <strong>{token.label}</strong>
                  <span>{token.revoked ? "revoked" : "active"} · {token.hashPrefix}</span>
                  <button onClick={() => revokeToken(token.id)} disabled={token.revoked || busy === token.id}>Revoke</button>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      <section className="namespacePanel">
        <div className="sectionHead">
          <h2>Cloudflare Extraction</h2>
          <span>fetch-based</span>
        </div>
        <div className="namespaceForm">
          <label className="wide">
            <span>Target URL</span>
            <input value={extractTarget} onChange={(event) => setExtractTarget(event.target.value)} />
          </label>
          <label>
            <span>Namespace</span>
            <input value={extractNamespace} onChange={(event) => setExtractNamespace(event.target.value)} placeholder="optional custom namespace" />
          </label>
        </div>
        <button className="secondary" onClick={startExtraction} disabled={busy === "extract"}>
          <Server size={15} />
          {busy === "extract" ? "Starting" : "Start Worker extraction"}
        </button>
        {extractJob ? <JsonPanel data={extractJob} /> : null}
      </section>

      <section className="namespacePanel">
        <div className="sectionHead">
          <h2>Scheduled Re-scrape</h2>
          <span>{schedules.length} schedules</span>
        </div>
        <div className="namespaceForm">
          <label className="wide">
            <span>Target URL</span>
            <input value={scheduleTarget} onChange={(event) => setScheduleTarget(event.target.value)} />
          </label>
          <label>
            <span>Namespace</span>
            <input value={scheduleNamespace} onChange={(event) => setScheduleNamespace(event.target.value)} placeholder="optional" />
          </label>
          <label>
            <span>Every hours</span>
            <input type="number" min={1} max={720} value={scheduleInterval} onChange={(event) => setScheduleInterval(Number(event.target.value) || 24)} />
          </label>
          <label className="wide">
            <span>Webhook URL</span>
            <input value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} placeholder="optional https://..." />
          </label>
          <label>
            <span>Webhook secret</span>
            <input value={webhookSecret} onChange={(event) => setWebhookSecret(event.target.value)} placeholder="optional signing secret" />
          </label>
        </div>
        <button className="secondary" onClick={createSchedule} disabled={busy === "schedule"}>
          <CalendarClock size={15} />
          {busy === "schedule" ? "Scheduling" : "Create schedule"}
        </button>
        <div className="scheduleList">
          {schedules.map((schedule) => (
            <article key={schedule.id}>
              <div>
                <strong>{schedule.namespace}</strong>
                <span>{schedule.target}</span>
                <small>next {formatDateTime(schedule.nextRunAt)} · every {schedule.intervalHours}h</small>
              </div>
              <button onClick={() => void toggleSchedule(schedule)} disabled={busy === schedule.id}>{schedule.active ? "Pause" : "Resume"}</button>
            </article>
          ))}
          {!schedules.length ? <div className="subEmpty">No scheduled re-scrapes yet.</div> : null}
        </div>
      </section>

      <section className="namespacePanel">
        <div className="sectionHead">
          <h2>Alerts</h2>
          <span>{alerts.length} recent</span>
        </div>
        <div className="alertList">
          {alerts.map((alert) => (
            <article key={alert.id}>
              <Bell size={15} />
              <div>
                <strong>{alert.title}</strong>
                <span>{alert.message}</span>
                <small>{formatDateTime(alert.createdAt)} · {alert.namespace}</small>
              </div>
            </article>
          ))}
          {!alerts.length ? <div className="subEmpty">No alerts yet. Scheduled runs will appear here after cron creates a diff.</div> : null}
        </div>
      </section>

      <section className="namespacePanel">
        <div className="sectionHead">
          <h2>Public Directory</h2>
          <span>{directory.length} public</span>
        </div>
        <div className="namespaceList directory">
          {directory.map((item) => (
            <button key={item.namespace} onClick={() => navigator.clipboard.writeText(item.mcpUrl)}>
              <strong>{item.displayName || item.namespace}</strong>
              <code>{item.namespace}</code>
              <span>{item.tags?.join(", ") || "public context"} · copy MCP URL</span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function MemWalPanel({
  artifact,
  run,
  history,
  refreshHistory,
  authToken,
  onRemember,
  rememberBusy = false
}: {
  artifact: ArtifactManifest;
  run: RunResponse | null;
  history: RunHistoryItem[];
  refreshHistory: () => Promise<void>;
  authToken: string;
  onRemember?: () => void;
  rememberBusy?: boolean;
}) {
  const [query, setQuery] = useState("What changed or should the agent remember about this site?");
  const [recall, setRecall] = useState<unknown>(null);
  const [memoryAnswer, setMemoryAnswer] = useState<unknown>(null);
  const [diff, setDiff] = useState<SiteSnapshotDiff | null>(null);
  const [visualDiff, setVisualDiff] = useState<VisualDiff | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [messages, setMessages] = useState<MemoryChatMessage[]>(() => [buildInitialMemoryMessage(artifact, run)]);
  const chatLogRef = useRef<HTMLDivElement>(null);
  const previousRuns = history.filter((item) => item.runId !== run?.manifest.runId && item.namespace === run?.manifest.namespace).slice(0, 5);

  useEffect(() => {
    if (!run) return;
    void loadDiff();
  }, [run?.manifest.runId]);

  useEffect(() => {
    setMessages([buildInitialMemoryMessage(artifact, run)]);
    setRecall(null);
    setMemoryAnswer(null);
    setError(null);
  }, [artifact.runId, run?.manifest.runId]);

  useEffect(() => {
    chatLogRef.current?.scrollTo({ top: chatLogRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  async function sendMemoryMessage(kind: "recall" | "query") {
    if (!run) return;
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return;
    const endpoint = kind === "recall" ? "memwal/recall" : "memwal/query";
    const setter = kind === "recall" ? setRecall : setMemoryAnswer;
    const userMessage: MemoryChatMessage = {
      id: createMessageId("user"),
      role: "user",
      content: trimmedQuery,
      mode: kind
    };
    setMessages((current) => [...current, userMessage]);
    setBusy(endpoint);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/runs/${run.manifest.runId}/${endpoint}`, {
        method: "POST",
        headers: authHeaders(authToken, { "content-type": "application/json" }),
        body: JSON.stringify({ query: trimmedQuery })
      });
      if (!response.ok) throw new Error(await readResponseError(response));
      const payload = await response.json();
      setter(payload);
      setMessages((current) => [
        ...current,
        {
          id: createMessageId("assistant"),
          role: "assistant",
          mode: kind,
          content: memoryPayloadToText(payload, kind),
          data: payload
        }
      ]);
      await refreshHistory();
    } catch (err) {
      const message = normalizeMemoryError(err instanceof Error ? err.message : String(err), kind);
      setError(null);
      setMessages((current) => [
        ...current,
        {
          id: createMessageId("error"),
          role: "assistant",
          mode: kind,
          content: message
        }
      ]);
    } finally {
      setBusy(null);
    }
  }

  async function loadDiff(compareToRunId?: string) {
    if (!run) return;
    try {
      const response = await fetch(`${API_BASE}/api/runs/${run.manifest.runId}/diff`, {
        method: "POST",
        headers: authHeaders(authToken, { "content-type": "application/json" }),
        body: JSON.stringify({ compareToRunId })
      });
      if (response.ok) setDiff((await response.json()) as SiteSnapshotDiff);
      const visualResponse = await fetch(`${API_BASE}/api/runs/${run.manifest.runId}/visual-diff`, {
        method: "POST",
        headers: authHeaders(authToken, { "content-type": "application/json" }),
        body: JSON.stringify({ compareToRunId })
      });
      if (visualResponse.ok) setVisualDiff((await visualResponse.json()) as VisualDiff);
    } catch {
      setDiff(null);
      setVisualDiff(null);
    }
  }

  return (
    <div className="panel memwalPanel memoryChatPanel">
      <section className="memoryChatShell" aria-label="MemWal memory chat">
        <header className="memoryChatHeader">
          <div>
            <span>Namespace</span>
            <strong>{run?.manifest.namespace ?? "not synced"}</strong>
            <p>{artifact.pages.length} pages · {artifact.walrus?.resources.length ?? 0} resources · {artifact.designSystem?.tokens.colors.length ?? 0} color tokens</p>
          </div>
          <div className="memoryHeaderActions">
            <div className="memoryStatusDots" aria-label="Memory package status">
              <span>verified</span>
              <span>mainnet</span>
            </div>
            <button type="button" onClick={onRemember} disabled={!run || !onRemember || rememberBusy}>
              <Brain size={15} />
              {rememberBusy ? "Remembering" : "Remember run"}
            </button>
          </div>
        </header>

        <div className="memoryQuickPrompts" aria-label="Prompt shortcuts">
          {["What changed since the last snapshot?", "What should an agent remember?", "Summarize important docs pages"].map((prompt) => (
            <button key={prompt} type="button" onClick={() => setQuery(prompt)}>
              {prompt}
            </button>
          ))}
        </div>

        <div className="memoryChatLog" ref={chatLogRef} role="log" aria-live="polite" aria-relevant="additions text">
          <div className="memoryChatLogInner">
            {messages.map((message) => (
              <article key={message.id} className={`memoryBubble ${message.role} ${message.mode ?? ""}`}>
                <div className="memoryBubbleIcon">{message.role === "user" ? <UserCheck size={16} /> : message.mode === "recall" ? <Brain size={16} /> : <MessageSquare size={16} />}</div>
                <div>
                  <span>{message.role === "user" ? (message.mode === "recall" ? "Recall prompt" : "Memory question") : message.mode === "recall" ? "MemWal recall" : "ContextMeM memory"}</span>
                  <p>{message.content}</p>
                  {message.data ? (
                    <details>
                      <summary>Raw response</summary>
                      <JsonPanel data={message.data} />
                    </details>
                  ) : null}
                </div>
              </article>
            ))}
            {busy ? (
              <article className="memoryBubble assistant loading">
                <div className="memoryBubbleIcon">
                  <LoaderCircle size={16} />
                </div>
                <div>
                  <span>{busy === "memwal/recall" ? "MemWal recall" : "ContextMeM memory"}</span>
                  <p>{busy === "memwal/recall" ? "Searching previous namespace memory..." : "Querying remembered context..."}</p>
                </div>
              </article>
            ) : null}
          </div>
        </div>

        <form
          className="memoryChatComposer"
          onSubmit={(event) => {
            event.preventDefault();
            void sendMemoryMessage("query");
          }}
        >
          <textarea value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Ask MemWal what changed, what matters, or what the next agent should remember..." />
          <div className="memoryComposerActions">
            <button type="button" onClick={() => void sendMemoryMessage("recall")} disabled={!run || busy !== null || !query.trim()}>
              <Brain size={15} />
              {busy === "memwal/recall" ? "Recalling" : "Recall"}
            </button>
            <button type="submit" className="primary" disabled={!run || busy !== null || !query.trim()}>
              <MessageSquare size={15} />
              {busy === "memwal/query" ? "Querying" : "Send"}
            </button>
          </div>
        </form>

        {error ? <div className="error memoryChatError">{error}</div> : null}
      </section>

      <aside className="memoryContextRail">
        <section>
          <div className="sectionHead">
            <h2>Local Diff</h2>
            <span>{diff?.compareRunId ?? "no previous run"}</span>
          </div>
          {diff ? <DiffSummary diff={diff} /> : <div className="subEmpty">No comparable run found.</div>}
        </section>
        <section>
          <div className="sectionHead">
            <h2>Previous Runs</h2>
            <span>{previousRuns.length} matches</span>
          </div>
          <div className="previousRuns">
            {previousRuns.map((item) => (
              <button key={item.runId} onClick={() => loadDiff(item.runId)}>
                <strong>{item.runId}</strong>
                <span>{formatDateTime(item.updatedAt)} · {item.pages}p/{item.resources}r</span>
              </button>
            ))}
            {!previousRuns.length ? <p>No prior local snapshot for this namespace.</p> : null}
          </div>
        </section>
        <section>
          <div className="sectionHead">
            <h2>Visual Diff</h2>
            <span>{visualDiff?.pages.length ?? 0} pages</span>
          </div>
          {visualDiff && run ? <VisualDiffPanel diff={visualDiff} run={run} authToken={authToken} /> : <div className="subEmpty">No visual diff generated yet.</div>}
        </section>
        <section>
          <div className="sectionHead">
            <h2>Last Recall</h2>
          </div>
          <MemoryRawResult data={recall} empty="No recall run yet." />
        </section>
        <section>
          <div className="sectionHead">
            <h2>Last Query</h2>
          </div>
          <MemoryRawResult data={memoryAnswer} empty="No memory query run yet." />
        </section>
      </aside>
    </div>
  );
}

function MemoryRawResult({ data, empty }: { data: unknown; empty: string }) {
  if (!data) return <div className="memoryEmptyResult">{empty}</div>;
  return (
    <details className="memoryRawResult">
      <summary>View raw response</summary>
      <JsonPanel data={data} />
    </details>
  );
}

type MemoryChatMessage = {
  id: string;
  role: "assistant" | "user";
  content: string;
  mode?: "recall" | "query";
  data?: unknown;
};

function createMessageId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function buildInitialMemoryMessage(artifact: ArtifactManifest, run: RunResponse | null): MemoryChatMessage {
  const namespace = run?.manifest.namespace ?? "not synced";
  return {
    id: `system-${run?.manifest.runId ?? "empty"}`,
    role: "assistant",
    content: `Active package loaded for ${compactHash(namespace)}. Ask what changed, what should be remembered, or query existing MemWal context for this namespace.`,
    mode: "query"
  };
}

function memoryPayloadToText(payload: unknown, kind: "recall" | "query"): string {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") return kind === "recall" ? "Recall completed." : "Memory query completed.";

  const record = payload as Record<string, unknown>;
  for (const key of ["answer", "response", "message", "summary", "text", "content"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }

  if (Array.isArray(record.content)) {
    const contentText = record.content
      .map((item) => (item && typeof item === "object" && typeof (item as Record<string, unknown>).text === "string" ? ((item as Record<string, unknown>).text as string) : ""))
      .filter(Boolean)
      .join("\n");
    if (contentText.trim()) return contentText;
  }

  if (record.result && record.result !== payload) {
    const resultText: string = memoryPayloadToText(record.result, kind);
    if (resultText.trim()) return resultText;
  }

  if (Array.isArray(record.matches) && record.matches.length) return `Found ${record.matches.length} matching memory item${record.matches.length === 1 ? "" : "s"}. Open Raw response for details.`;
  if (Array.isArray(record.memories) && record.memories.length) return `Found ${record.memories.length} remembered item${record.memories.length === 1 ? "" : "s"} for this namespace.`;
  if (Array.isArray(record.results) && record.results.length) return `Found ${record.results.length} result${record.results.length === 1 ? "" : "s"} from MemWal.`;

  const rendered = JSON.stringify(payload, null, 2);
  return rendered.length > 1200 ? `${rendered.slice(0, 1200)}\n...` : rendered;
}

function normalizeMemoryError(message: string, kind: "recall" | "query") {
  const connectionProblem = /unable to connect|failed to fetch|network|ECONNREFUSED|ENOTFOUND/i.test(message);
  if (!connectionProblem) return message;
  if (kind === "recall") return "MemWal could not be reached from the ContextMeM server. The active package is still available here; remember this run once the MemWal service is reachable, then retry recall.";
  return "MemWal could not answer right now. The active package is loaded locally, but the server-side MemWal connection failed. Try Remember run first, then send the question again.";
}

function FileChecklist({ files }: { files: Array<{ path: string; exists: boolean; size?: number }> }) {
  return (
    <div className="fileChecklist">
      {files.map((file) => (
        <div key={file.path} className={file.exists ? "ok" : "missing"}>
          <span>{file.exists ? "ok" : "missing"}</span>
          <code>{file.path}</code>
          {typeof file.size === "number" ? <small>{formatBytes(file.size)}</small> : null}
        </div>
      ))}
    </div>
  );
}

function DiffSummary({ diff }: { diff: SiteSnapshotDiff }) {
  return (
    <div className="diffSummary">
      {Object.entries(diff.summary).map(([kind, counts]) => (
        <article key={kind}>
          <strong>{kind}</strong>
          <span>+{counts.added}</span>
          <span>-{counts.removed}</span>
          <span>~{counts.changed}</span>
          <span>{counts.unchanged} same</span>
        </article>
      ))}
    </div>
  );
}

function VisualDiffPanel({ diff, run, authToken }: { diff: VisualDiff; run: RunResponse; authToken: string }) {
  const [showAll, setShowAll] = useState(false);
  const changedPages = diff.pages.filter((page) => page.status !== "unchanged");
  const visible = showAll ? changedPages : changedPages.slice(0, 6);
  if (!changedPages.length) return <div className="memoryEmptyResult">No changed page screenshots.</div>;
  const counts = changedPages.reduce(
    (acc, page) => {
      acc[page.status] = (acc[page.status] ?? 0) + 1;
      return acc;
    },
    { added: 0, removed: 0, changed: 0, unchanged: 0 } as Record<VisualDiff["pages"][number]["status"], number>
  );
  return (
    <div className="visualDiffList">
      <header className="visualDiffSummary">
        <span className="visualBadge added">+{counts.added} new</span>
        <span className="visualBadge removed">-{counts.removed} removed</span>
        <span className="visualBadge changed">~{counts.changed} changed</span>
        <small>Generated {new Date(diff.generatedAt).toLocaleString()}</small>
      </header>
      {visible.map((page) => (
        <article key={page.routePath} className={`visualDiffCard ${page.status}`}>
          <div className="visualDiffHead">
            <strong>{page.routePath}</strong>
            <span className={`visualBadge ${page.status}`}>{page.status === "added" ? "new page" : page.status}</span>
          </div>
          <div className="visualPair">
            <figure>
              <figcaption>before</figcaption>
              {page.beforeScreenshot ? (
                <img src={artifactFileUrl(diff.compareRunId, page.beforeScreenshot, authToken)} alt={`${page.routePath} before`} />
              ) : (
                <div className="visualPlaceholder">This page did not exist in the prior run.</div>
              )}
            </figure>
            <figure className="visualAfter">
              <figcaption>after</figcaption>
              {page.afterScreenshot ? (
                <div className="visualAfterCanvas">
                  <img src={artifactFileUrl(run.manifest.runId, page.afterScreenshot, authToken)} alt={`${page.routePath} after`} />
                  {page.boxes?.length ? (() => {
                    const maxX = Math.max(...page.boxes.map((box) => box.x + box.width), 1);
                    const maxY = Math.max(...page.boxes.map((box) => box.y + box.height), 1);
                    return (
                      <svg
                        className="visualBoxes"
                        viewBox={`0 0 ${maxX} ${maxY}`}
                        preserveAspectRatio="none"
                        aria-hidden="true"
                      >
                        {page.boxes.map((box, index) => (
                          <rect
                            key={`${box.label}-${index}`}
                            x={box.x}
                            y={box.y}
                            width={box.width}
                            height={box.height}
                            className={`visualBox ${box.tone}`}
                            vectorEffect="non-scaling-stroke"
                          />
                        ))}
                      </svg>
                    );
                  })() : null}
                </div>
              ) : (
                <div className="visualPlaceholder">This page was removed in the latest run.</div>
              )}
            </figure>
          </div>
          {page.markdownDiff && (page.markdownDiff.added.length || page.markdownDiff.removed.length) ? (
            <div className="markdownMiniDiff">
              {page.markdownDiff.added.slice(0, 8).map((line, index) => (
                <p key={`add-${index}`}>+ {line}</p>
              ))}
              {page.markdownDiff.removed.slice(0, 8).map((line, index) => (
                <p key={`remove-${index}`} className="removed">- {line}</p>
              ))}
              {page.markdownDiff.added.length + page.markdownDiff.removed.length > 16 ? (
                <small>… {(page.markdownDiff.added.length - 8) + (page.markdownDiff.removed.length - 8)} more lines</small>
              ) : null}
            </div>
          ) : null}
        </article>
      ))}
      {changedPages.length > 6 ? (
        <button type="button" className="visualDiffMore" onClick={() => setShowAll((value) => !value)}>
          {showAll ? "Show fewer pages" : `Show ${changedPages.length - 6} more page${changedPages.length - 6 === 1 ? "" : "s"}`}
        </button>
      ) : null}
    </div>
  );
}

function DesignSystemPanel({ data, fallback, run, authToken }: { data?: DesignSystem; fallback?: ArtifactManifest["styleguide"]; run: RunResponse | null; authToken: string }) {
  if (!data) return <StyleguideFallbackPanel data={fallback} />;
  const groupedColors = data.tokens.colors.reduce<Record<string, DesignSystem["tokens"]["colors"]>>((acc, token) => {
    acc[token.role] = [...(acc[token.role] ?? []), token];
    return acc;
  }, {});
  const exportEntries = [
    ["Figma Tokens", data.exports.figmaTokens, buildFigmaExport(data)],
    ["Style Dictionary", data.exports.styleDictionary, buildStyleDictionaryExport(data)],
    ["Tailwind Theme", data.exports.tailwindTheme, buildTailwindExport(data)],
    ["Tokens CSS", data.exports.tokensCss, buildTokensCssExport(data)],
    ["Web Brand Kit", data.exports.webBrandKit, buildWebKitExport(data)],
    ["Video Brand Kit", data.exports.videoBrandKit, buildVideoKitExport(data)],
    ["Raw JSON", data.exports.rawJson, data]
  ] as const;

  const brandTokenCount = data.tokens.colors.length + data.tokens.spacing.length + data.tokens.radii.length + data.tokens.shadows.length;
  const confidenceLabel = data.identity.confidence >= 0.66 ? "high" : data.identity.confidence >= 0.33 ? "partial" : "framework-only";
  return (
    <div className="panel designPanel">
      <section className="designHero">
        <div>
          <span>Design System</span>
          <h2>{data.identity.name ?? data.identity.domain ?? "Extracted identity"}</h2>
          {data.identity.description ? <p>{data.identity.description}</p> : null}
          {data.framework ? (
            <small className="frameworkBadge" title={`${data.framework.defaultsSubtracted} framework defaults filtered out`}>
              Built on {data.framework.name} — {data.framework.defaultsSubtracted} defaults filtered
            </small>
          ) : null}
        </div>
        <div className="designScore">
          <strong>{Math.round(data.identity.confidence * 100)}%</strong>
          <span>{confidenceLabel}</span>
        </div>
      </section>

      {brandTokenCount === 0 ? (
        <div className="tabEmptyState">
          <strong>No brand-distinct tokens detected</strong>
          <p>{data.framework ? `This site uses ${data.framework.name}; its default tokens were filtered out and nothing brand-distinct remained.` : "Inline CSS contained only framework or system defaults."} Try a fresh Build, or render-then-sample is required to surface real brand tokens (Tier 2 — not shipped yet).</p>
        </div>
      ) : null}

      <section className="designStats">
        <div>
          <span>Tokens</span>
          <strong>{brandTokenCount}</strong>
        </div>
        {data.assets.length > 0 ? (
          <div>
            <span>Assets</span>
            <strong>{data.assets.length}</strong>
          </div>
        ) : null}
        {data.components.length > 0 ? (
          <div>
            <span>Components</span>
            <strong>{data.components.length}</strong>
          </div>
        ) : null}
        {data.motion.length > 0 ? (
          <div>
            <span>Motion</span>
            <strong>{data.motion.length}</strong>
          </div>
        ) : null}
      </section>

      <section className="designSection">
        <div className="sectionHead">
          <h2>Semantic Color Tokens</h2>
          <span>{data.tokens.rawPalette.length} raw colors</span>
        </div>
        <div className="colorRoles">
          {Object.entries(groupedColors).map(([role, tokens]) => (
            <article className="roleGroup" key={role}>
              <h3>{role}</h3>
              <div className="swatches compact">
                {tokens.slice(0, 12).map((token) => (
                  <span key={`${token.name}-${token.value}`} style={{ background: token.value }} title={token.name}>
                    {token.value}
                  </span>
                ))}
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="designSection split">
        <article>
          <div className="sectionHead">
            <h2>Typography</h2>
            <span>{data.tokens.typography.scale.length} styles</span>
          </div>
          <div className="fontList">
            {data.tokens.typography.fontFamilies.slice(0, 10).map((font) => (
              <span key={font}>{font}</span>
            ))}
          </div>
          <div className="tokenRows">
            {[data.tokens.typography.body, ...data.tokens.typography.headings].filter(Boolean).map((token) => (
              <div key={token!.name}>
                <strong>{token!.name}</strong>
                <code>{[token!.fontSize, token!.fontWeight, token!.lineHeight].filter(Boolean).join(" / ") || token!.fontFamily}</code>
              </div>
            ))}
          </div>
        </article>
        <article>
          <div className="sectionHead">
            <h2>Layout Primitives</h2>
            <span>raw values observed</span>
          </div>
          <TokenChips label="Spacing (raw)" values={data.tokens.spacing} />
          <TokenChips label="Radii (raw)" values={data.tokens.radii} />
          <TokenChips label="Shadows (raw)" values={data.tokens.shadows} />
        </article>
      </section>

      <section className="designSection">
        <div className="sectionHead">
          <h2>Components</h2>
          <span>{data.components.length} detected</span>
        </div>
        <div className="componentGrid">
          {data.components.map((component) => (
            <article className="componentCard" key={component.type}>
              {component.previews?.find((preview) => preview.path && preview.status === "captured") ? (
                <img className="componentPreview" src={artifactFileUrl(run?.manifest.runId, component.previews.find((preview) => preview.path && preview.status === "captured")!.path!, authToken)} alt={`${component.name} preview`} />
              ) : null}
              <div>
                <strong>{component.name}</strong>
                <span>{component.selectors.slice(0, 3).join(", ") || component.type}</span>
              </div>
              <dl>
                {component.tokens.slice(0, 6).map((token) => (
                  <React.Fragment key={`${component.type}-${token.property}-${token.value}`}>
                    <dt>{token.property}</dt>
                    <dd>{token.value}</dd>
                  </React.Fragment>
                ))}
              </dl>
              {component.states.length ? <code>{component.states.map((state) => state.name).join(" · ")}</code> : null}
            </article>
          ))}
        </div>
      </section>

      <section className="designSection split">
        <article>
          <div className="sectionHead">
            <h2>Assets</h2>
            <span>{data.assets.length} files</span>
          </div>
          <div className="assetList">
            {data.assets.slice(0, 18).map((asset, index) => (
              <div key={`${asset.kind}-${asset.url ?? asset.resourcePath}-${index}`}>
                <strong>{asset.kind}</strong>
                <code>{asset.url ?? asset.resourcePath ?? asset.label}</code>
              </div>
            ))}
          </div>
        </article>
        <article>
          <div className="sectionHead">
            <h2>Motion</h2>
            <span>{data.motion.length} tokens</span>
          </div>
          <div className="tokenRows">
            {data.motion.slice(0, 12).map((token) => (
              <div key={`${token.name}-${token.value}`}>
                <strong>{token.property}</strong>
                <code>{token.value}</code>
              </div>
            ))}
          </div>
        </article>
      </section>

      <section className="designSection">
        <div className="sectionHead">
          <h2>Exports</h2>
          <span>Figma, web, video, agent JSON</span>
        </div>
        <div className="exportGrid">
          {exportEntries.map(([label, route, payload]) => (
            <article className="exportCard" key={route}>
              <div>
                <strong>{label}</strong>
                <code>{route}</code>
              </div>
              <div className="exportActions">
                <button onClick={() => copyExport(payload)}>Copy</button>
                <button onClick={() => downloadExport(label, payload, route.endsWith(".css") ? "text/css" : "application/json")}>Download</button>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function StyleguideFallbackPanel({ data }: { data?: ArtifactManifest["styleguide"] }) {
  if (!data) {
    return (
      <div className="panel">
        <div className="tabEmptyState">
          <strong>Design system tokens not in this run</strong>
          <p>Re-run the Build to extract a token snapshot — palette, font scale, spacing, radii, shadows — from the home page's inline CSS, saved as <code>/context/design-system.json</code>.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="panel">
      <div className="swatches">
        {data.colors.palette.slice(0, 24).map((color) => (
          <span key={color} style={{ background: color }}>
            {color}
          </span>
        ))}
      </div>
      <JsonPanel data={data} />
    </div>
  );
}

function TokenChips({ label, values }: { label: string; values: string[] }) {
  if (!values.length) return null;
  return (
    <div className="tokenChipGroup">
      <span>{label}</span>
      <div>
        {values.slice(0, 16).map((value) => (
          <code key={`${label}-${value}`}>{value}</code>
        ))}
      </div>
    </div>
  );
}

function BrandPanel({ data }: { data?: ArtifactManifest["brand"] }) {
  if (!data) {
    return (
      <div className="panel brandPanel">
        <div className="tabEmptyState">
          <strong>Brand profile not in this run</strong>
          <p>Re-run the Build to extract a brand profile — favicon, OG image, palette from inline CSS, font families, and social links — saved as <code>/context/brand.json</code>.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="panel brandPanel">
      <div className="brandSummary">
        <div>
          <span>Name</span>
          <strong>{data.name ?? "Unknown"}</strong>
        </div>
        <div>
          <span>Domain</span>
          <strong>{data.domain ?? "Unknown"}</strong>
        </div>
        <div>
          <span>Confidence</span>
          <strong>{Math.round(data.confidence * 100)}%</strong>
        </div>
      </div>

      {data.description ? <p className="brandDescription">{data.description}</p> : null}

      {data.colors.length ? (
        <div className="brandSection">
          <h2>Colors</h2>
          <div className="swatches">
            {data.colors.slice(0, 24).map((color) => (
              <span key={color} style={{ background: color }}>
                {color}
              </span>
            ))}
          </div>
        </div>
      ) : null}

      {data.fonts.length ? (
        <div className="brandSection">
          <h2>Fonts</h2>
          <div className="fontList">
            {data.fonts.slice(0, 12).map((font) => (
              <span key={font}>{font}</span>
            ))}
          </div>
        </div>
      ) : null}

      {data.logos.length ? (
        <div className="brandSection">
          <h2>Logo Assets</h2>
          <div className="brandAssets">
            {data.logos.map((logo, index) => (
              <article className="brandAsset" key={`${logo.absoluteUrl ?? logo.src}-${index}`}>
                <strong>{logo.role ?? logo.type ?? "logo-candidate"}</strong>
                {logo.alt ? <span>{logo.alt}</span> : null}
                <code>{logo.absoluteUrl ?? logo.src}</code>
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function WalrusResourcesPanel({ data }: { data?: ArtifactManifest["walrus"] }) {
  if (!data) return <JsonPanel data={{ status: "No Walrus resource artifact" }} />;

  const verified = data.resources.filter((resource) => resource.verified).length;
  const failed = data.resources.filter((resource) => resource.error).length;

  return (
    <div className="panel walrusPanel">
      <div className="walrusSummary">
        <div>
          <span>Network</span>
          <strong>{data.site.network}</strong>
        </div>
        <div>
          <span>Object</span>
          <strong>{data.site.siteObjectId}</strong>
        </div>
        <div>
          <span>Resources</span>
          <strong>{data.resources.length}</strong>
        </div>
        <div>
          <span>Verified</span>
          <strong>{verified}</strong>
        </div>
        {failed ? (
          <div>
            <span>Fetch errors</span>
            <strong>{failed}</strong>
          </div>
        ) : null}
      </div>

      <div className="resourceGrid">
        {data.resources.map((resource) => {
          const state = resource.error ? "error" : resource.verified ? "verified" : "unverified";
          return (
            <article className={`resourceCard ${state}`} key={`${resource.path}-${resource.blobId}-${resource.quiltPatchId ?? ""}`}>
              <div className="resourceTop">
                <strong>{resource.path}</strong>
                <span>{state}</span>
              </div>
              <code>{resource.contentType ?? "application/octet-stream"}</code>
              <dl>
                <div>
                  <dt>blob</dt>
                  <dd>{resource.blobId}</dd>
                </div>
                <div>
                  <dt>hash</dt>
                  <dd>{resource.blobHash}</dd>
                </div>
                {resource.quiltPatchId ? (
                  <div>
                    <dt>patch</dt>
                    <dd>{resource.quiltPatchId}</dd>
                  </div>
                ) : null}
                {typeof resource.byteLength === "number" ? (
                  <div>
                    <dt>bytes</dt>
                    <dd>{formatBytes(resource.byteLength)}</dd>
                  </div>
                ) : null}
              </dl>
              {resource.error ? <p>{resource.error}</p> : null}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function WalrusHistoryPanel({ run, walrus, authToken }: { run: RunResponse | null; walrus?: ArtifactManifest["walrus"]; authToken: string }) {
  const [history, setHistory] = useState<WalrusSiteHistory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!run || !walrus) return;
    void loadHistory();
  }, [authToken, run?.manifest.runId, Boolean(walrus)]);

  async function loadHistory() {
    if (!run) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/runs/${run.manifest.runId}/walrus/history?limit=40&maxTransactions=800`, { headers: authHeaders(authToken) });
      if (!response.ok) throw new Error(await readResponseError(response));
      setHistory((await response.json()) as WalrusSiteHistory);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!walrus) return <JsonPanel data={{ status: "No Walrus site selected" }} />;

  return (
    <div className="panel historyTimelinePanel">
      <section className="historyOverview">
        <div>
          <span>Site object</span>
          <strong>{walrus.site.siteObjectId}</strong>
        </div>
        <div>
          <span>Owner</span>
          <strong>{history?.owner ?? "loading"}</strong>
        </div>
        <div>
          <span>Current version</span>
          <strong>{history?.currentVersion ?? "loading"}</strong>
        </div>
        <div>
          <span>Scanned</span>
          <strong>{history?.scannedTransactions ?? 0} tx</strong>
        </div>
        <button onClick={loadHistory} disabled={busy}>
          <History size={15} />
          {busy ? "Loading" : "Refresh history"}
        </button>
      </section>

      {error ? <div className="error">{error}</div> : null}
      {history?.warnings.length ? <div className="warningList">{history.warnings.map((warning) => <div key={warning}>{warning}</div>)}</div> : null}

      <section className="timeline">
        {history?.entries.map((entry) => (
          <article key={entry.digest} className={entry.action}>
            <div className="timelineDot" />
            <div className="timelineBody">
              <div className="timelineHead">
                <div>
                  <strong>{entry.action}</strong>
                  <span>{entry.timestampIso ? formatDateTime(entry.timestampIso) : "unknown time"} · {entry.status ?? "unknown"}</span>
                </div>
                <code>{entry.digest}</code>
              </div>
              <dl>
                <div>
                  <dt>version</dt>
                  <dd>{entry.previousVersion ?? "new"} → {entry.siteVersion ?? "unknown"}</dd>
                </div>
                <div>
                  <dt>sender</dt>
                  <dd>{entry.sender ?? "unknown"}</dd>
                </div>
                <div>
                  <dt>functions</dt>
                  <dd>{entry.functions.join(", ") || "unknown"}</dd>
                </div>
                <div>
                  <dt>paths</dt>
                  <dd>{entry.resourcePaths.join(", ") || `${entry.resourceChanges.length} resource object changes`}</dd>
                </div>
              </dl>
            </div>
          </article>
        ))}
        {history && !history.entries.length ? <div className="subEmpty">No site update transactions found in the scanned owner history.</div> : null}
        {!history && !error ? <div className="subEmpty">Loading onchain Walrus update history...</div> : null}
      </section>
    </div>
  );
}

function JsonPanel({ data }: { data: unknown }) {
  return (
    <div className="panel">
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDuration(value: number): string {
  const seconds = Math.max(0, Math.floor(value / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function buildProgressCopy(phase?: string): string {
  switch (phase) {
    case "queued":
      return "The API accepted the build and is preparing the first phase.";
    case "resolving":
      return "Resolving the target to a website or Walrus Site object.";
    case "listing_resources":
      return "Reading Walrus resource metadata from Sui before downloading blobs.";
    case "downloading_resources":
      return "Fetching verified resources with bounded parallel downloads and cache reuse.";
    case "crawling_pages":
      return "Collecting pages once so downstream context steps can reuse the same crawl.";
    case "extracting_pages":
      return "Converting materialized pages into markdown and structured context.";
    case "extracting_metadata":
      return "Building brand, styleguide, and design metadata from the cached page set.";
    case "capturing_screenshots":
      return "Running the slower visual pass for screenshots and component previews.";
    case "building_artifacts":
      return "Writing the agent-readable package files.";
    default:
      return "Resolving target, fetching resources, and preparing the agent-readable artifacts.";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function streamRunEvents(runId: string, token: string, onProgress: (event: { status: string; progress?: RunProgress; updatedAt?: string }) => void): Promise<RunResponse["manifest"]> {
  const response = await fetch(`${API_BASE}/api/runs/${runId}/events`, { headers: authHeaders(token) });
  if (!response.ok || !response.body) throw new Error(response.ok ? "Run event stream unavailable." : await readResponseError(response));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let eventData = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });
    let separator = buffer.indexOf("\n\n");
    while (separator >= 0) {
      const raw = buffer.slice(0, separator);
      buffer = buffer.slice(separator + 2);
      eventName = "message";
      eventData = "";
      for (const line of raw.split(/\n/)) {
        if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
        if (line.startsWith("data:")) eventData += line.slice("data:".length).trim();
      }
      if (eventData) {
        const parsed = JSON.parse(eventData);
        if (eventName === "progress") onProgress(parsed);
        if (eventName === "done") return parsed as RunResponse["manifest"];
      }
      separator = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  throw new Error("Run event stream closed before completion.");
}

function flattenStructure(nodes: SiteStructureNode[]): SiteStructureNode[] {
  return nodes.flatMap((node) => [node, ...flattenStructure(node.children ?? [])]);
}

function previewNodeForStructureSelection(node?: SiteStructureNode): SiteStructureNode | undefined {
  if (!node) return undefined;
  if (node.kind === "page") {
    const children = flattenStructure(node.children ?? []);
    const extractedMarkdown = children.find((child) => child.artifactPath && child.kind === "markdown" && /extracted/i.test(child.label));
    if (extractedMarkdown) return extractedMarkdown;
    const markdown = children.find((child) => child.artifactPath && child.kind === "markdown");
    if (markdown) return markdown;
  }
  if (node.artifactPath) return node;
  return flattenStructure(node.children ?? []).find((child) => child.artifactPath && (isTextPreviewNode(child) || isImageNode(child))) ?? flattenStructure(node.children ?? []).find((child) => child.artifactPath);
}

function isImageNode(node: SiteStructureNode): boolean {
  return /^image\//i.test(node.contentType ?? "") || /\.(?:svg|png|jpe?g|webp|gif|ico)$/i.test(node.artifactPath ?? node.path ?? "");
}

function isTextPreviewNode(node: SiteStructureNode): boolean {
  return /(?:json|markdown|html|text|css|javascript|xml)/i.test(node.contentType ?? "") || /\.(?:json|md|html?|txt|css|js|xml)$/i.test(node.artifactPath ?? node.path ?? "");
}

function compactHash(value: string): string {
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function compactTarget(value: string): string {
  try {
    const parsed = new URL(value);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return value.length > 34 ? `${value.slice(0, 18)}...${value.slice(-10)}` : value;
  }
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function defaultDisplayName(target: string): string {
  try {
    return new URL(target).hostname.replace(/^www\./, "");
  } catch {
    return target.slice(0, 80);
  }
}

function artifactFileUrl(runId: string | undefined, artifactPath: string, accessToken = ""): string {
  if (!runId) return "";
  const params = new URLSearchParams({ path: artifactPath });
  if (accessToken) params.set("accessToken", accessToken);
  return `${API_BASE}/api/runs/${runId}/artifact-file?${params.toString()}`;
}

function authHeaders(token: string, base: Record<string, string> = {}): Record<string, string> {
  const merged = { ...base, ...(!isLocalApiBase(API_BASE) ? hostedDelegateHeaders() : {}) };
  return token ? { ...merged, authorization: `Bearer ${token}` } : merged;
}

function isLocalApiBase(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  } catch {
    return false;
  }
}

function readHostedDelegate(): { memwalAccountId: string; delegateKey: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem("contextmem.hostedDelegate");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { memwalAccountId?: unknown; delegateKey?: unknown };
    const accountId = typeof parsed.memwalAccountId === "string" ? parsed.memwalAccountId : "";
    const key = typeof parsed.delegateKey === "string" ? parsed.delegateKey : "";
    if (!accountId || key.length < 12) return null;
    return { memwalAccountId: accountId, delegateKey: key };
  } catch {
    return null;
  }
}

function hostedBrowserMe(stored: { memwalAccountId: string; delegateKey: string }): AccountMe {
  const now = new Date().toISOString();
  return {
    authenticated: true,
    account: {
      id: `hosted:${stored.memwalAccountId.toLowerCase().replace(/[^a-z0-9:._-]+/g, "-").slice(0, 180)}`,
      ownerAddress: stored.memwalAccountId,
      provider: "unknown",
      memwalAccountId: stored.memwalAccountId,
      hasDelegateKey: true,
      createdAt: now,
      updatedAt: now
    },
    quota: { limit: 0, used: 0, remaining: 0, unlimited: true },
    access: { canPreview: true, canRun: true, reason: "Hosted MemWal delegate is available for this browser session." }
  };
}

function hostedDelegateHeaders(): Record<string, string> {
  const stored = readHostedDelegate();
  if (!stored) return {};
  const bearer = stored.delegateKey.startsWith("Bearer ") ? stored.delegateKey : `Bearer ${stored.delegateKey}`;
  return {
    "x-memwal-authorization": bearer,
    "x-memwal-account-id": stored.memwalAccountId
  };
}

function isUnavailableMessage(message: string): boolean {
  return /unable to connect|fetch failed|network|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|terminated|MCP HTTP (502|503|504)/i.test(message);
}

async function readResponseError(response: Response): Promise<string> {
  const text = await response.text();
  if (!text) return response.statusText;
  try {
    const parsed = JSON.parse(text) as { message?: string; error?: string | { code?: string; message?: string; hint?: string } };
    if (typeof parsed.error === "object" && parsed.error && parsed.error.message) {
      const tag = parsed.error.code ? `[${parsed.error.code}] ` : "";
      const hint = parsed.error.hint ? ` — ${parsed.error.hint}` : "";
      return `${tag}${parsed.error.message}${hint}`;
    }
    if (typeof parsed.error === "string") return parsed.error;
    return parsed.message ?? text;
  } catch {
    return text;
  }
}

function failureHintFor(message: string): { code?: string; hint: string } | null {
  if (!message) return null;
  const lower = message.toLowerCase();
  if (lower.includes("[demo_limit_exceeded]") || lower.includes("demo limit reached")) {
    return { code: "DEMO_LIMIT_EXCEEDED", hint: "Open /app/settings, generate an account secret and import MemWal credentials to unlock unlimited extractions." };
  }
  if (lower.includes("walrus") && (lower.includes("aggregator") || lower.includes("timeout") || lower.includes("unreachable"))) {
    return { code: "WALRUS_UNREACHABLE", hint: "Walrus aggregator is unreachable. Try again in a minute or set WALRUS_AGGREGATOR_URL to an alternate mirror." };
  }
  if (lower.includes("memwal") && (lower.includes("401") || lower.includes("unauthorized") || lower.includes("delegate"))) {
    return { code: "MEMWAL_AUTH", hint: "MemWal rejected the delegate key. Re-import SDK credentials in /app/settings or rotate the key in the MemWal dashboard." };
  }
  if (lower.includes("openai") && (lower.includes("rate") || lower.includes("429"))) {
    return { code: "OPENAI_RATE_LIMIT", hint: "OpenAI rate-limited the request. Wait ~30 seconds, then retry — or set a higher-tier OPENAI_API_KEY." };
  }
  if (lower.includes("openai") && lower.includes("api key")) {
    return { code: "OPENAI_MISSING", hint: "OPENAI_API_KEY is not configured. AI Query is disabled until it's set in the API worker env." };
  }
  if (lower.includes("namespace") && lower.includes("not found")) {
    return { code: "NAMESPACE_MISSING", hint: "The hosted namespace doesn't exist or was deleted. Re-publish from /app/publish or check the URL." };
  }
  if (lower.includes("read token") || (lower.includes("namespace") && lower.includes("token"))) {
    return { code: "NAMESPACE_TOKEN", hint: "The hosted namespace requires a read token. Generate one in /app/namespaces and pass it as `Authorization: Bearer <token>`." };
  }
  return null;
}

function FailureExplainer({ message }: { message: string | null }) {
  if (!message) return null;
  const detail = failureHintFor(message);
  if (!detail) return null;
  return (
    <div className="failurePanel" role="note">
      <strong>Why did this fail?</strong>
      <span>{detail.hint}</span>
      {detail.code ? <code className="failureCode">{detail.code}</code> : null}
    </div>
  );
}

function imagePreviewUrl(image: ArtifactManifest["images"][number], artifact: ArtifactManifest): string | undefined {
  const candidate = image.previewUrl ?? image.absoluteUrl;
  if (!candidate || candidate.startsWith("inline-svg:")) return undefined;
  return normalizeWalrusPublicImageUrl(candidate, artifact);
}

function imageDisplayUrl(image: ArtifactManifest["images"][number], artifact: ArtifactManifest): string {
  if (image.absoluteUrl.startsWith("inline-svg:")) return image.absoluteUrl;
  return normalizeWalrusPublicImageUrl(image.absoluteUrl, artifact);
}

function normalizeWalrusPublicImageUrl(value: string, artifact: ArtifactManifest): string {
  if (!artifact.walrus?.site.portalUrl) return value;
  try {
    const parsed = new URL(value);
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") {
      return new URL(`${parsed.pathname}${parsed.search}`, artifact.walrus.site.portalUrl).toString();
    }
  } catch {
    return value;
  }
  return value;
}

function buildFigmaExport(data: DesignSystem): Record<string, unknown> {
  const global: Record<string, unknown> = {};
  for (const token of data.tokens.colors) assignExportToken(global, token.name, { value: token.value, type: "color" });
  for (const [index, family] of data.tokens.typography.fontFamilies.entries()) assignExportToken(global, `fontFamilies.${index === 0 ? "body" : exportKey(family)}`, { value: family, type: "fontFamilies" });
  for (const [index, value] of data.tokens.spacing.entries()) assignExportToken(global, `spacing.${index + 1}`, { value, type: "spacing" });
  for (const [index, value] of data.tokens.radii.entries()) assignExportToken(global, `radii.${index + 1}`, { value, type: "borderRadius" });
  for (const [index, value] of data.tokens.shadows.entries()) assignExportToken(global, `shadows.${index + 1}`, { value, type: "boxShadow" });
  return { $metadata: { tokenSetOrder: ["global"] }, global };
}

function buildStyleDictionaryExport(data: DesignSystem): Record<string, unknown> {
  const tokens: Record<string, unknown> = {};
  for (const token of data.tokens.colors) assignExportToken(tokens, token.name, { value: token.value, type: "color" });
  for (const [index, value] of data.tokens.spacing.entries()) assignExportToken(tokens, `size.spacing.${index + 1}`, { value, type: "dimension" });
  for (const [index, value] of data.tokens.radii.entries()) assignExportToken(tokens, `size.radius.${index + 1}`, { value, type: "dimension" });
  for (const [index, value] of data.tokens.shadows.entries()) assignExportToken(tokens, `shadow.${index + 1}`, { value, type: "shadow" });
  return tokens;
}

function buildTailwindExport(data: DesignSystem): Record<string, unknown> {
  return {
    theme: {
      extend: {
        colors: Object.fromEntries(data.tokens.colors.map((token) => [exportKey(token.name.replace(/^color\./, "")), token.value])),
        fontFamily: {
          sans: data.tokens.typography.fontFamilies[0]?.split(",").map((font) => font.trim()) ?? ["ui-sans-serif", "system-ui"],
          mono: data.tokens.typography.fontFamilies.find((font) => /mono|code/i.test(font))?.split(",").map((font) => font.trim()) ?? ["ui-monospace", "monospace"]
        },
        spacing: Object.fromEntries(data.tokens.spacing.map((value, index) => [String(index + 1), value])),
        borderRadius: Object.fromEntries(data.tokens.radii.map((value, index) => [String(index + 1), value])),
        boxShadow: Object.fromEntries(data.tokens.shadows.map((value, index) => [String(index + 1), value]))
      }
    }
  };
}

function buildTokensCssExport(data: DesignSystem): string {
  const lines = [":root {"];
  for (const token of data.tokens.colors) lines.push(`  --cm-${exportKey(token.name)}: ${token.value};`);
  for (const [index, value] of data.tokens.spacing.entries()) lines.push(`  --cm-spacing-${index + 1}: ${value};`);
  for (const [index, value] of data.tokens.radii.entries()) lines.push(`  --cm-radius-${index + 1}: ${value};`);
  for (const [index, value] of data.tokens.shadows.entries()) lines.push(`  --cm-shadow-${index + 1}: ${value};`);
  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function buildWebKitExport(data: DesignSystem): Record<string, unknown> {
  return {
    identity: data.identity,
    tokens: data.tokens,
    components: data.components,
    exports: {
      css: data.exports.tokensCss,
      tailwind: data.exports.tailwindTheme,
      styleDictionary: data.exports.styleDictionary
    }
  };
}

function buildVideoKitExport(data: DesignSystem): Record<string, unknown> {
  const brand = data.tokens.colors.find((token) => token.role === "brand") ?? data.tokens.colors[0];
  const text = data.tokens.colors.find((token) => token.role === "text");
  const background = data.tokens.colors.find((token) => token.role === "background" || token.role === "surface");
  return {
    identity: data.identity,
    titleCard: {
      background: background?.value ?? "#ffffff",
      foreground: text?.value ?? "#111827",
      accent: brand?.value ?? "#2563eb",
      fontFamily: data.tokens.typography.fontFamilies[0] ?? "Inter, system-ui, sans-serif"
    },
    lowerThird: {
      background: brand?.value ?? "#2563eb",
      foreground: text?.value ?? "#ffffff",
      radius: data.tokens.radii[0] ?? "8px",
      shadow: data.tokens.shadows[0] ?? "none"
    },
    motion: {
      defaultDuration: data.motion.find((token) => token.property === "duration")?.value ?? "180ms",
      easing: data.motion.find((token) => token.property === "easing")?.value ?? "ease"
    }
  };
}

function assignExportToken(root: Record<string, unknown>, path: string, token: Record<string, unknown>) {
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

function exportKey(value: string): string {
  return value.replaceAll(".", "-").replaceAll(/[^a-z0-9-_]+/gi, "-").replaceAll(/^-|-$/g, "").toLowerCase();
}

async function copyExport(payload: unknown): Promise<void> {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  await navigator.clipboard.writeText(text);
}

function downloadExport(label: string, payload: unknown, contentType: string): void {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  const blob = new Blob([text], { type: contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${label.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "")}.${contentType === "text/css" ? "css" : "json"}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function readLaunchOptions(): { target: string; mode: "auto" | "web" | "walrus"; autorun: boolean } {
  if (typeof window === "undefined") return { target: "", mode: "auto", autorun: false };

  const params = new URLSearchParams(window.location.search);
  const mode = params.get("mode");

  return {
    target: params.get("target") ?? "",
    mode: mode === "web" || mode === "walrus" || mode === "auto" ? mode : "auto",
    autorun: params.get("autorun") === "1" || params.get("autorun") === "true"
  };
}

type RootHost = HTMLElement & { __contextMemRoot?: ReturnType<typeof createRoot> };

const rootHost = document.getElementById("root")! as RootHost;
rootHost.__contextMemRoot ??= createRoot(rootHost);
rootHost.__contextMemRoot.render(
  <App />
);
