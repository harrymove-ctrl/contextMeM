import { bcs } from "@mysten/sui/bcs";
import { fromHex, toHex } from "@mysten/sui/utils";
import { base64UrlSafeEncode } from "@contextmem/core";

export const Address = bcs.bytes(32).transform({
  input: (id: string) => fromHex(id),
  output: (id: Uint8Array) => toHex(id)
});

export const BlobId = bcs.u256().transform({
  input: (id: string | number | bigint) => id as never,
  output: (id: unknown) => base64UrlSafeEncode(bcs.u256().serialize(id as never).toBytes())
}) as never;

export const DataHash = bcs.u256().transform({
  input: (id: string | number | bigint) => id as never,
  output: (id: unknown) => Buffer.from(bcs.u256().serialize(id as never).toBytes()).toString("base64")
}) as never;

export const ResourcePathStruct = bcs.struct("ResourcePath", {
  path: bcs.string()
});

const OptionU64 = bcs.option(bcs.u64()).transform({
  input: (value: bigint | number | null) => value as never,
  output: (value: unknown) => (value === null ? null : Number(value))
}) as never;

const RangeStruct = bcs.struct("Range", {
  start: OptionU64,
  end: OptionU64
});

const OptionalRangeStruct = bcs.option(RangeStruct).transform({
  input: (value: { start: number | null; end: number | null } | null) => value as never,
  output: (value: unknown) => (value as { start: number | null; end: number | null } | null) ?? null
}) as never;

export const ResourceStruct = bcs.struct("Resource", {
  path: bcs.string(),
  headers: bcs.map(bcs.string(), bcs.string()),
  blob_id: BlobId,
  blob_hash: DataHash,
  range: OptionalRangeStruct
});

export function DynamicFieldStruct(key: { name: string }, value: { name: string }) {
  return bcs.struct(`DynamicFieldStruct<${key.name}, ${value.name}>`, {
    parentId: Address,
    name: key as never,
    value: value as never
  });
}

export function fromBase64(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, "base64"));
}
