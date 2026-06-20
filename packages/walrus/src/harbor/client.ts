import { HarborAuthError, HarborError } from "./errors.js";
import type {
  Bucket,
  BucketId,
  BucketListResponse,
  CreateBucketReserveResponse,
  FileId,
  FileListResponse,
  FileStatusResponse,
  FileUploadResponse,
  FinalizeBucketResponse,
  HarborConfig,
  SpaceId,
  SpaceListItem,
} from "./types.js";

// Harbor stores a file's mime_type from the multipart part's content-type (it does NOT
// sniff the ciphertext or read the extension server-side). The UI keys preview/rendering
// off that stored mime, so an octet-stream type makes images/PDFs un-previewable even
// though they decrypt fine. Derive the real type from the file name.
const EXT_MIME: Record<string, string> = {
  apng: "image/apng",
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  pdf: "application/pdf",
  csv: "text/csv",
  htm: "text/html",
  html: "text/html",
  md: "text/markdown",
  mdx: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
};

function contentTypeFromName(fileName: string): string {
  const ext = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
  return EXT_MIME[ext] ?? "application/octet-stream";
}

/** Harbor wraps single-resource GETs as `{ data: <resource> }`. */
interface DataEnvelope<T> {
  readonly data: T;
}

/** Harbor error bodies arrive as `{ error: "msg" }` or `{ error: { code, message } }`. */
interface HarborErrorBody {
  readonly code?: string;
  readonly message?: string;
  readonly error?: string | { readonly code?: string; readonly message?: string };
}

/**
 * Typed Harbor REST API client (plain async/await port of the Effect
 * `HarborApiClient` service). Uses native `fetch` with a Bearer header and the
 * `contentTypeFromName` helper for multipart uploads.
 *
 * Only the curated external surface (Bearer-only) is implemented.
 */
export class HarborClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: Pick<HarborConfig, "baseUrl" | "apiKey">) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
  }

  // --- internals ---

  private authHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
      ...extra,
    };
  }

  // A 401/403 is only an *auth* failure when its server code is auth-related (or
  // absent). Other 403s — notably the post-finalize `mirror_missing_grant` — must
  // keep their original server code so callers (HarborStorage.putEncrypted) can
  // detect & retry them instead of treating them as a dead API key.
  private isAuthCode(code: string | undefined): boolean {
    return (
      code === undefined ||
      code === "missing_api_key" ||
      code === "invalid_api_key" ||
      code === "read_only_api_key"
    );
  }

  private async parseErrorBody(res: Response): Promise<HarborErrorBody> {
    try {
      return (await res.json()) as HarborErrorBody;
    } catch {
      return {};
    }
  }

  /** Build a typed error from a non-OK JSON response and throw it. */
  private async fail(res: Response, endpoint: string): Promise<never> {
    const body = await this.parseErrorBody(res);
    // Harbor error bodies come as either `{ error: "msg" }` or `{ error: { code, message } }`,
    // so pull the string out of both shapes — otherwise String(message) yields "[object Object]".
    const errBody = body.error;
    const code =
      body.code ?? (errBody && typeof errBody === "object" ? errBody.code : undefined);
    const message =
      (typeof errBody === "string" ? errBody : errBody?.message) ??
      body.message ??
      `HTTP ${res.status}`;

    if ((res.status === 401 || res.status === 403) && this.isAuthCode(code)) {
      throw new HarborAuthError({
        message: String(message),
        code: code === "read_only_api_key" ? "read_only_api_key" : "invalid_api_key",
        status: res.status,
      });
    }
    throw new HarborError({
      message: String(message),
      ...(code !== undefined ? { code } : {}),
      status: res.status,
      endpoint,
    });
  }

  /**
   * Throw a typed error from a raw (non-JSON) failure, preserving any server
   * `code` so callers can detect e.g. the post-finalize `mirror_missing_grant`.
   */
  private async failRaw(res: Response, endpoint: string): Promise<never> {
    const text = await res.text().catch(() => "");
    let code: string | undefined;
    let parsedMessage: string | undefined;
    if (text) {
      try {
        const body = JSON.parse(text) as HarborErrorBody;
        const errBody = body.error;
        code =
          body.code ?? (errBody && typeof errBody === "object" ? errBody.code : undefined);
        parsedMessage =
          (typeof errBody === "string" ? errBody : errBody?.message) ?? body.message;
      } catch {
        // non-JSON body; keep the raw text in the message below
      }
    }
    if ((res.status === 401 || res.status === 403) && this.isAuthCode(code)) {
      throw new HarborAuthError({
        message: parsedMessage ?? text ?? `HTTP ${res.status}`,
        code: code === "read_only_api_key" ? "read_only_api_key" : "invalid_api_key",
        status: res.status,
      });
    }
    throw new HarborError({
      message: parsedMessage ?? `HTTP ${res.status}: ${text}`,
      ...(code !== undefined ? { code } : {}),
      status: res.status,
      endpoint,
    });
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  // === Read flows ===

  async listSpaces(filter?: { type?: "personal" | "team" }): Promise<readonly SpaceListItem[]> {
    const path = filter?.type ? `/api/v1/spaces?type=${filter.type}` : "/api/v1/spaces";
    const res = await fetch(this.url(path), { headers: this.authHeaders() });
    if (res.status !== 200) return this.fail(res, path);
    const json = (await res.json()) as DataEnvelope<readonly SpaceListItem[]>;
    return json.data;
  }

  async listBuckets(args: {
    spaceId: SpaceId;
    limit?: number;
    cursor?: string;
    q?: string;
    visibility?: "public" | "private";
  }): Promise<BucketListResponse> {
    const params = new URLSearchParams();
    if (args.limit !== undefined) params.set("limit", String(args.limit));
    if (args.cursor) params.set("cursor", args.cursor);
    if (args.q) params.set("q", args.q);
    if (args.visibility) params.set("visibility", args.visibility);

    const path = `/api/v1/spaces/${args.spaceId}/buckets?${params.toString()}`;
    const res = await fetch(this.url(path), { headers: this.authHeaders() });
    if (res.status !== 200) return this.fail(res, path);
    const json = (await res.json()) as BucketListResponse;
    return { buckets: json.buckets, next_cursor: json.next_cursor };
  }

  async getBucketById(bucketId: BucketId): Promise<Bucket> {
    const path = `/api/v1/buckets/${bucketId}`;
    const res = await fetch(this.url(path), { headers: this.authHeaders() });
    if (res.status !== 200) return this.fail(res, path);
    const json = (await res.json()) as DataEnvelope<Bucket>;
    return json.data;
  }

  async listBucketFiles(
    bucketId: BucketId,
    limit?: number,
    cursor?: string,
    q?: string,
  ): Promise<FileListResponse> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    if (q) params.set("q", q);

    const path = `/api/v1/buckets/${bucketId}/files?${params.toString()}`;
    const res = await fetch(this.url(path), { headers: this.authHeaders() });
    if (res.status !== 200) return this.fail(res, path);
    return (await res.json()) as FileListResponse;
  }

  // === Write flows ===

  async createBucket(spaceId: SpaceId, name: string): Promise<CreateBucketReserveResponse> {
    const path = `/api/v1/spaces/${spaceId}/buckets`;
    const res = await fetch(this.url(path), {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ name, scope: "private" }),
    });
    if (res.status !== 201) return this.fail(res, path);
    return (await res.json()) as CreateBucketReserveResponse;
  }

  async finalizeBucket(bucketId: BucketId, signature: string): Promise<FinalizeBucketResponse> {
    const path = `/api/v1/buckets/${bucketId}/finalize`;
    const res = await fetch(this.url(path), {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ signature }),
    });
    if (res.status !== 200) return this.fail(res, path);
    return (await res.json()) as FinalizeBucketResponse;
  }

  async updateBucket(
    bucketId: BucketId,
    body: { name: string; visibility?: "public" | "private"; sealPolicyId?: string | null },
  ): Promise<Bucket> {
    const path = `/api/v1/buckets/${bucketId}`;
    const res = await fetch(this.url(path), {
      method: "PUT",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    if (res.status !== 200) return this.fail(res, path);
    const json = (await res.json()) as Bucket & { data?: Bucket };
    return json.data ?? json;
  }

  // PUT /buckets/{id} is a partial update; visibility/sealPolicyId are immutable
  // server-side (sending visibility returns 403), so a rename sends only the name.
  async renameBucket(bucketId: BucketId, newName: string): Promise<Bucket> {
    return this.updateBucket(bucketId, { name: newName });
  }

  async deleteBucket(bucketId: BucketId): Promise<{ id: BucketId; deleted: true }> {
    // Harbor guards bucket deletion behind ?confirm=true (it deletes all contained files).
    const path = `/api/v1/buckets/${bucketId}?confirm=true`;
    const res = await fetch(this.url(path), { method: "DELETE", headers: this.authHeaders() });
    // Harbor returns 204 No Content on success; tolerate 200 with a body too.
    if (res.status !== 200 && res.status !== 204) return this.fail(res, path);
    return { id: bucketId, deleted: true };
  }

  async uploadBucketFile(
    bucketId: BucketId,
    fileBytes: Uint8Array,
    fileName: string,
    metadata?: Record<string, unknown>,
  ): Promise<FileUploadResponse> {
    const form = new FormData();
    const blob = new Blob([fileBytes as unknown as BlobPart], {
      type: contentTypeFromName(fileName),
    });
    form.append("file", blob, fileName);
    if (metadata) form.append("metadata", JSON.stringify(metadata));

    const path = `/api/v1/buckets/${bucketId}/files`;
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
      });
    } catch (cause) {
      throw new HarborError({
        message: `Multipart upload failed: ${String(cause)}`,
        endpoint: path,
      });
    }

    if (res.status !== 202) return this.failRaw(res, path);
    return (await res.json()) as FileUploadResponse;
  }

  async getFileUploadStatus(bucketId: BucketId, fileId: FileId): Promise<FileStatusResponse> {
    const path = `/api/v1/buckets/${bucketId}/files/${fileId}/status`;
    const res = await fetch(this.url(path), { headers: this.authHeaders() });
    if (res.status !== 200) return this.fail(res, path);
    return (await res.json()) as FileStatusResponse;
  }

  async downloadBucketFile(bucketId: BucketId, fileId: FileId): Promise<Uint8Array> {
    const path = `/api/v1/buckets/${bucketId}/files/${fileId}/download`;
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method: "GET",
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
    } catch (cause) {
      throw new HarborError({ message: `Download failed: ${String(cause)}`, endpoint: path });
    }
    if (res.status !== 200) return this.failRaw(res, path);
    const arrayBuffer = await res.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }

  async deleteBucketFile(
    bucketId: BucketId,
    fileId: FileId,
  ): Promise<{ id: FileId; deleted: true }> {
    const path = `/api/v1/buckets/${bucketId}/files/${fileId}`;
    const res = await fetch(this.url(path), { method: "DELETE", headers: this.authHeaders() });
    // Harbor returns 204 No Content on success; tolerate 200 with a body too.
    if (res.status !== 200 && res.status !== 204) return this.fail(res, path);
    return { id: fileId, deleted: true };
  }
}

export { contentTypeFromName };
