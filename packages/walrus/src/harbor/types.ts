/**
 * Plain-TS types for the Harbor external REST API + Seal client.
 *
 * Ported from the Effect reference (harbor/types.ts + HarborApiClient.ts) but
 * stripped of `effect` Schema/branding — these are the same DTO shapes the
 * Harbor OpenAPI returns, expressed as plain interfaces.
 */

// Harbor IDs are opaque strings. The reference brands them via effect Schema;
// here we keep readable aliases so the DTOs document intent without a runtime cost.
export type SpaceId = string;
export type BucketId = string;
export type FileId = string;

/** Config for {@link HarborClient} / {@link SealCrypto}. Secrets come from env at runtime. */
export interface HarborConfig {
  /** Harbor API base URL, e.g. https://api.testnet.harbor.walrus.xyz */
  readonly baseUrl: string;
  /** Bearer API key (HARBOR_API_KEY). */
  readonly apiKey: string;
  /** Sui service private key (suiprivkey1... / HARBOR_SERVICE_PRIVATE_KEY). Empty for metadata-only use. */
  readonly servicePrivateKey: string;
  /** Optional default space (HARBOR_DEFAULT_SPACE_ID). */
  readonly defaultSpaceId?: string;
}

// === Resource DTOs (ported from reference types.ts) ===

export interface SpaceListItem {
  readonly id: SpaceId;
  readonly type: "personal" | "team";
  readonly name: string;
  readonly plan: "free" | "starter" | "pro" | "business";
  readonly storage_used: number;
  readonly storage_cap: number;
  readonly bucket_count: number;
  readonly role: "owner" | "admin" | "editor" | "viewer";
  readonly created_at: string;
}

export interface Bucket {
  readonly id: BucketId;
  readonly space_id: SpaceId;
  readonly name: string;
  readonly visibility: "public" | "private";
  readonly seal_policy_id: string | null;
  readonly storage_used: number;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface FileSummary {
  readonly id: FileId;
  readonly bucket_id: BucketId;
  readonly name: string;
  readonly size: number;
  readonly status: string;
  readonly is_private: boolean;
  readonly mime_type: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly created_at: string;
  readonly updated_at: string;
}

// === Response envelopes (ported from reference HarborApiClient.ts) ===

export interface CreateBucketReserveResponse {
  readonly bucket_id: BucketId;
  readonly bytes: string; // base64 sponsored tx
  readonly digest: string;
  readonly state: "pending_policy";
}

export interface FinalizeBucketResponse {
  readonly bucket_id: BucketId;
  readonly seal_policy_id: string | null;
  readonly state: string;
}

export interface FileUploadResponse {
  readonly data: {
    readonly id: FileId;
  };
}

export type FileUploadState = "queued" | "active" | "completed" | "failed";

export interface FileStatusResponse {
  readonly data: {
    readonly state: FileUploadState;
    readonly progress?: number;
    readonly error?: { code: string; message: string };
  };
}

export interface FileListResponse {
  readonly data: readonly FileSummary[];
  readonly pagination: {
    readonly limit: number;
    readonly has_more: boolean;
    readonly next_cursor: string | null;
  };
}

export interface BucketListResponse {
  readonly buckets: readonly Bucket[];
  readonly next_cursor: string | null;
}
