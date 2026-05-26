import fs from "node:fs/promises";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import type { Network, WalrusSiteContext } from "@contextmem/core";
import { inferTargetKind, isWalrusObjectId, looksLikeUrl } from "@contextmem/core";
import { WALRUS_NETWORKS } from "./constants.js";

export type ResolveWalrusOptions = {
  network?: Network;
  rpcUrl?: string;
  aggregatorUrl?: string;
  sitePackage?: string;
  siteObjectId?: string;
};

export async function resolveWalrusTarget(target: string, options: ResolveWalrusOptions = {}): Promise<WalrusSiteContext> {
  const explicitNetwork = options.network ?? "mainnet";
  const defaults = WALRUS_NETWORKS[explicitNetwork];
  const siteObjectId = options.siteObjectId ?? (isWalrusObjectId(target) ? target.toLowerCase() : undefined);

  if (siteObjectId) {
    return {
      network: explicitNetwork,
      siteObjectId,
      sitePackage: options.sitePackage ?? defaults.sitePackage,
      rpcUrl: options.rpcUrl ?? defaults.rpcUrl,
      aggregatorUrl: options.aggregatorUrl ?? defaults.aggregatorUrl,
      portalUrl: explicitNetwork === "mainnet" ? `https://${siteObjectId}.wal.app` : undefined
    };
  }

  if (target.endsWith(".json")) {
    const raw = JSON.parse(await fs.readFile(target, "utf8")) as Partial<{
      network: Network;
      rpcUrl: string;
      rpcUrlList: string[];
      aggregatorUrl: string;
      sitePackage: string;
      siteObjectId: string;
    }>;
    const network = raw.network ?? explicitNetwork;
    const networkDefaults = WALRUS_NETWORKS[network];
    if (!raw.siteObjectId) throw new Error(`Preview config is missing siteObjectId: ${target}`);
    return {
      network,
      siteObjectId: raw.siteObjectId.toLowerCase(),
      sitePackage: raw.sitePackage ?? networkDefaults.sitePackage,
      rpcUrl: raw.rpcUrl ?? raw.rpcUrlList?.[0] ?? networkDefaults.rpcUrl,
      aggregatorUrl: raw.aggregatorUrl ?? networkDefaults.aggregatorUrl
    };
  }

  if (looksLikeUrl(target)) {
    const url = new URL(target);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      try {
        const configUrl = new URL("/__config", url);
        const config = (await fetch(configUrl).then((r) => (r.ok ? r.json() : null))) as Partial<{
          network: Network;
          rpcUrl: string;
          rpcUrlList: string[];
          aggregatorUrl: string;
          sitePackage: string;
          siteObjectId: string;
        }> | null;
        if (config?.siteObjectId) {
          const network = config.network ?? explicitNetwork;
          const networkDefaults = WALRUS_NETWORKS[network];
          return {
            network,
            siteObjectId: config.siteObjectId.toLowerCase(),
            sitePackage: config.sitePackage ?? networkDefaults.sitePackage,
            rpcUrl: config.rpcUrl ?? config.rpcUrlList?.[0] ?? networkDefaults.rpcUrl,
            aggregatorUrl: config.aggregatorUrl ?? networkDefaults.aggregatorUrl,
            portalUrl: target
          };
        }
      } catch {
        // Continue to the clearer error below.
      }
    }

    if (url.hostname.endsWith(".wal.app")) {
      const suinsName = url.hostname.slice(0, -".wal.app".length);
      if (!suinsName) throw new Error(`Walrus URL "${target}" does not include a site subdomain.`);
      return resolveSuiNsWalrusSite(suinsName, {
        ...options,
        network: "mainnet",
        portalUrl: target
      });
    }
  }

  if (looksLikeSuiNsName(target)) {
    return resolveSuiNsWalrusSite(target, options);
  }

  const kind = inferTargetKind(target);
  throw new Error(`Cannot resolve ${kind} as a Walrus Site target. Pass a 0x site object ID, preview config JSON, or localhost preview URL.`);
}

async function resolveSuiNsWalrusSite(
  inputName: string,
  options: ResolveWalrusOptions & { portalUrl?: string } = {}
): Promise<WalrusSiteContext> {
  const network = options.network ?? "mainnet";
  const defaults = WALRUS_NETWORKS[network];
  const suinsName = normalizeSuiNsName(inputName);
  const client = new SuiGrpcClient({ network, baseUrl: options.rpcUrl ?? defaults.rpcUrl });
  const response = await client.nameService.lookupName({ name: suinsName });
  const record = response.response.record;
  const data = record?.data ?? {};
  const siteObjectId = data.walrus_site_id ?? data.walrusSiteId ?? data.walrus_site_address ?? data.walrusSiteAddress;

  if (!siteObjectId || !isWalrusObjectId(siteObjectId)) {
    throw new Error(`SuiNS name "${suinsName}" does not have a walrus_site_id record.`);
  }

  return {
    network,
    siteObjectId: siteObjectId.toLowerCase(),
    sitePackage: options.sitePackage ?? defaults.sitePackage,
    rpcUrl: options.rpcUrl ?? defaults.rpcUrl,
    aggregatorUrl: options.aggregatorUrl ?? defaults.aggregatorUrl,
    portalUrl: options.portalUrl ?? (network === "mainnet" ? `https://${suinsName.replace(/\.sui$/, "")}.wal.app` : undefined),
    suinsName
  };
}

function normalizeSuiNsName(value: string): string {
  const name = value.trim().replace(/^@/, "").replace(/\.wal\.app$/i, "");
  return name.endsWith(".sui") ? name : `${name}.sui`;
}

function looksLikeSuiNsName(value: string): boolean {
  return /^@?[a-z0-9-]+(?:\.sui)?$/i.test(value.trim());
}
