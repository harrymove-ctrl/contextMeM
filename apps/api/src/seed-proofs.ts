// AUTO-GENERATED — real Tatum->Walrus storage receipts (CERTIFIED onchain proofs).
// Embedded so the (fs-less) Worker can surface the real proof for a namespace.

export type WalrusStorageProof = {
  namespace: string; target: string; provider: string; endpoint: string;
  blobId: string; jobId: string; status: string; certified: boolean;
  artifactDigest: string; byteLength: number; fileName: string;
  uploadedAt: string; certifiedAt?: string; network: string;
};

export const SEED_PROOFS: Record<string, WalrusStorageProof> = {
  "demo:walrus-docs": {
    "namespace": "demo:walrus-docs",
    "target": "https://docs.wal.app",
    "provider": "tatum",
    "endpoint": "https://api.tatum.io/v4/data/storage/upload",
    "blobId": "PriRx-_a55xDCh63kBg_RkwwRf3dKMk62JkTpkYu4aU",
    "jobId": "6a23e05fde51712efd6c5c92",
    "status": "CERTIFIED",
    "certified": true,
    "artifactDigest": "sha256:c4f0eab4e7ba0073c83b19ad8b0402008710feaab358b85a792b69ab6680bcb7",
    "byteLength": 11924,
    "fileName": "contextmem-proof-proof-walrus-docs-20260606-153606.tgz",
    "uploadedAt": "2026-06-06T08:54:59.181Z",
    "certifiedAt": "2026-06-06T08:55:13.985Z",
    "network": "mainnet"
  }
};
