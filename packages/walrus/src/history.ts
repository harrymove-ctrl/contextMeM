import type { WalrusSiteContext, WalrusSiteHistory, WalrusSiteHistoryEntry } from "@contextmem/core";

type JsonRpcResponse<T> = {
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type SuiObjectResponse = {
  data?: {
    objectId: string;
    version: string;
    digest: string;
    previousTransaction?: string;
    owner?: { AddressOwner?: string; ObjectOwner?: string; Shared?: unknown; Immutable?: true };
  };
};

type TransactionPage = {
  data: SuiTransactionBlock[];
  nextCursor?: unknown;
  hasNextPage: boolean;
};

type SuiTransactionBlock = {
  digest: string;
  timestampMs?: string;
  effects?: {
    status?: {
      status?: string;
      error?: string;
    };
  };
  transaction?: {
    data?: {
      sender?: string;
      transaction?: {
        kind?: string;
        inputs?: Array<Record<string, unknown>>;
        transactions?: Array<Record<string, unknown>>;
      };
    };
  };
  objectChanges?: Array<Record<string, unknown>>;
};

export async function getWalrusSiteHistory(
  site: WalrusSiteContext,
  options: {
    limit?: number;
    maxTransactions?: number;
    ownerAddress?: string;
  } = {}
): Promise<WalrusSiteHistory> {
  const current = await suiRpc<SuiObjectResponse>(site.rpcUrl, "sui_getObject", [
    site.siteObjectId,
    {
      showOwner: true,
      showPreviousTransaction: true
    }
  ]);
  const owner = options.ownerAddress ?? ownerAddressFromObject(current);
  const warnings: string[] = [];
  const entries: WalrusSiteHistoryEntry[] = [];

  if (!owner) {
    warnings.push("Could not derive a site owner address, so transaction history scan is unavailable.");
    return {
      site,
      currentVersion: current.data?.version,
      currentDigest: current.data?.digest,
      previousTransaction: current.data?.previousTransaction,
      scannedTransactions: 0,
      entries,
      warnings
    };
  }

  let cursor: unknown = null;
  let scannedTransactions = 0;
  const limit = options.limit ?? 30;
  const maxTransactions = options.maxTransactions ?? 500;
  const seen = new Set<string>();

  while (scannedTransactions < maxTransactions && entries.length < limit) {
    const page = await suiRpc<TransactionPage>(site.rpcUrl, "suix_queryTransactionBlocks", [
      {
        filter: { FromAddress: owner },
        options: {
          showInput: true,
          showEffects: true,
          showObjectChanges: true
        }
      },
      cursor,
      Math.min(50, maxTransactions - scannedTransactions),
      true
    ]);

    for (const tx of page.data ?? []) {
      scannedTransactions += 1;
      const entry = parseHistoryEntry(site, tx);
      if (entry && !seen.has(entry.digest)) {
        seen.add(entry.digest);
        entries.push(entry);
        if (entries.length >= limit) break;
      }
    }

    if (!page.hasNextPage || !page.nextCursor) break;
    cursor = page.nextCursor;
  }

  if (entries.length === 0 && current.data?.previousTransaction) {
    try {
      const tx = await suiRpc<SuiTransactionBlock>(site.rpcUrl, "sui_getTransactionBlock", [
        current.data.previousTransaction,
        {
          showInput: true,
          showEffects: true,
          showObjectChanges: true
        }
      ]);
      const entry = parseHistoryEntry(site, tx);
      if (entry) entries.push(entry);
    } catch (error) {
      warnings.push(`Could not fetch previous transaction: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    site,
    owner,
    currentVersion: current.data?.version,
    currentDigest: current.data?.digest,
    previousTransaction: current.data?.previousTransaction,
    scannedTransactions,
    entries: entries.sort((a, b) => Number(b.timestampMs ?? 0) - Number(a.timestampMs ?? 0)),
    warnings
  };
}

function parseHistoryEntry(site: WalrusSiteContext, tx: SuiTransactionBlock): WalrusSiteHistoryEntry | undefined {
  if (!transactionMentionsSite(site.siteObjectId, tx)) return undefined;

  const siteChange = tx.objectChanges?.find((change) => change.objectId === site.siteObjectId);
  const functions = extractMoveFunctions(site, tx);
  const resourcePaths = extractResourcePaths(tx);
  const resourceChanges =
    tx.objectChanges
      ?.filter((change) => typeof change.objectType === "string" && change.objectType.includes("::site::Resource"))
      .map((change) => ({
        objectId: stringValue(change.objectId),
        type: stringValue(change.type),
        version: stringValue(change.version),
        previousVersion: stringValue(change.previousVersion),
        digest: stringValue(change.digest)
      })) ?? [];

  if (!siteChange && functions.length === 0 && resourcePaths.length === 0 && resourceChanges.length === 0) return undefined;

  return {
    digest: tx.digest,
    timestampMs: tx.timestampMs,
    timestampIso: tx.timestampMs ? new Date(Number(tx.timestampMs)).toISOString() : undefined,
    sender: stringValue(siteChange?.sender) ?? tx.transaction?.data?.sender,
    action: actionFromChange(siteChange?.type),
    status: tx.effects?.status?.status,
    siteVersion: stringValue(siteChange?.version),
    previousVersion: stringValue(siteChange?.previousVersion),
    siteDigest: stringValue(siteChange?.digest),
    functions,
    resourcePaths,
    resourceChanges
  };
}

function ownerAddressFromObject(object: SuiObjectResponse): string | undefined {
  const owner = object.data?.owner;
  if (owner?.AddressOwner) return owner.AddressOwner;
  return undefined;
}

function transactionMentionsSite(siteObjectId: string, tx: SuiTransactionBlock): boolean {
  if (tx.objectChanges?.some((change) => change.objectId === siteObjectId)) return true;
  return JSON.stringify(tx.transaction?.data?.transaction?.inputs ?? []).includes(siteObjectId);
}

function actionFromChange(type: unknown): WalrusSiteHistoryEntry["action"] {
  if (type === "created") return "created";
  if (type === "mutated") return "updated";
  if (type === "deleted") return "deleted";
  return "unknown";
}

function extractMoveFunctions(site: WalrusSiteContext, tx: SuiTransactionBlock): string[] {
  const functions = new Set<string>();
  for (const command of tx.transaction?.data?.transaction?.transactions ?? []) {
    const moveCall = (command as { MoveCall?: Record<string, unknown> }).MoveCall;
    if (!moveCall) continue;
    if (stringValue(moveCall.package)?.toLowerCase() !== site.sitePackage.toLowerCase()) continue;
    if (stringValue(moveCall.module) !== "site") continue;
    const fn = stringValue(moveCall.function);
    if (fn) functions.add(fn);
  }
  return [...functions];
}

function extractResourcePaths(tx: SuiTransactionBlock): string[] {
  const paths = new Set<string>();
  for (const input of tx.transaction?.data?.transaction?.inputs ?? []) {
    const value = input.value;
    if (typeof value === "string" && value.startsWith("/")) paths.add(value);
  }
  return [...paths].sort();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function suiRpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params
    })
  });
  const json = (await response.json()) as JsonRpcResponse<T>;
  if (json.error) throw new Error(`${json.error.message}${json.error.data ? `: ${JSON.stringify(json.error.data)}` : ""}`);
  if (!json.result) throw new Error(`Sui RPC ${method} returned no result`);
  return json.result;
}
