import { SuiGrpcClient } from "@mysten/sui/grpc";
import type { WalrusSiteContext, WalrusSiteProof } from "@contextmem/core";

/**
 * Best-effort capture of the on-chain site object state (version + digest +
 * last transaction) so a snapshot can be tied back to a verifiable Sui object.
 * Never throws: a run still completes if the proof read fails.
 */
export async function captureWalrusSiteProof(site: WalrusSiteContext): Promise<WalrusSiteProof> {
  const capturedAt = new Date().toISOString();
  try {
    const client = new SuiGrpcClient({ network: site.network, baseUrl: site.rpcUrl });
    const response = await client.getObject({ objectId: site.siteObjectId });
    const object = response.object as { version?: string | number; digest?: string; previousTransaction?: string } | undefined;
    return {
      version: object?.version != null ? String(object.version) : undefined,
      digest: object?.digest,
      previousTransaction: object?.previousTransaction,
      capturedAt
    };
  } catch {
    return { capturedAt };
  }
}
