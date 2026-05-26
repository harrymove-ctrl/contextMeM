import { base64UrlSafeEncode, base64UrlToBase64 } from "@contextmem/core";

export function deriveQuiltPatchId(quiltBlobIdBase64Url: string, quiltPatchInternalId: string): string {
  const internal = quiltPatchInternalId.startsWith("0x") ? quiltPatchInternalId.slice(2) : quiltPatchInternalId;
  const blobIdBytes = Buffer.from(base64UrlToBase64(quiltBlobIdBase64Url), "base64");
  const internalBuffer = Buffer.from(internal, "hex");
  if (internalBuffer.byteLength < 5) {
    throw new Error(`Invalid quilt patch internal id: ${quiltPatchInternalId}`);
  }

  const buffer = Buffer.alloc(37);
  blobIdBytes.copy(buffer, 0, 0, Math.min(blobIdBytes.length, 32));
  const outputView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const internalView = new DataView(internalBuffer.buffer, internalBuffer.byteOffset, internalBuffer.byteLength);
  outputView.setUint8(32, internalView.getInt8(0));
  outputView.setUint16(33, internalView.getInt16(1, true), true);
  outputView.setUint16(35, internalView.getInt16(3, true), true);
  return base64UrlSafeEncode(buffer).slice(0, 50);
}

export function blobAggregatorEndpoint(blobId: string, aggregatorUrl: string): URL {
  const clean = aggregatorUrl.endsWith("/") ? aggregatorUrl.slice(0, -1) : aggregatorUrl;
  return new URL(`${clean}/v1/blobs/${encodeURIComponent(blobId)}`);
}

export function quiltAggregatorEndpoint(quiltPatchId: string, aggregatorUrl: string): URL {
  const clean = aggregatorUrl.endsWith("/") ? aggregatorUrl.slice(0, -1) : aggregatorUrl;
  return new URL(`${clean}/v1/blobs/by-quilt-patch-id/${encodeURIComponent(quiltPatchId)}`);
}
