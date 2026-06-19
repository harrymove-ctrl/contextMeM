/**
 * Harbor API + Seal crypto domain errors.
 *
 * Ported from the Effect reference (errors.ts) which used `Data.TaggedError`.
 * Here they are plain `Error` subclasses carrying the same structured fields,
 * so callers can branch on `instanceof` / `.code` without pulling in effect.
 */

/** Thrown for any non-OK Harbor REST response. Carries HTTP status + server code. */
export class HarborError extends Error {
  readonly code?: string;
  readonly status?: number;
  readonly endpoint?: string;

  constructor(args: {
    message: string;
    code?: string;
    status?: number;
    endpoint?: string;
  }) {
    super(args.message);
    this.name = "HarborError";
    this.code = args.code;
    this.status = args.status;
    this.endpoint = args.endpoint;
  }
}

/** 401/403 auth failures. Mirrors the reference HarborAuthError code union. */
export class HarborAuthError extends HarborError {
  declare readonly code: "missing_api_key" | "invalid_api_key" | "read_only_api_key";

  constructor(args: {
    message: string;
    code: "missing_api_key" | "invalid_api_key" | "read_only_api_key";
    status?: number;
  }) {
    super(args);
    this.name = "HarborAuthError";
  }
}

export type SealCryptoStep =
  | "load_keypair"
  | "encrypt"
  | "decrypt"
  | "build_ptb"
  | "session_key"
  | "sign";

/** Any failure inside the client-side Seal encrypt/decrypt/sign pipeline. */
export class SealCryptoError extends Error {
  readonly step: SealCryptoStep;

  constructor(args: { message: string; step: SealCryptoStep; cause?: unknown }) {
    super(args.message, args.cause !== undefined ? { cause: args.cause } : undefined);
    this.name = "SealCryptoError";
    this.step = args.step;
  }
}

/**
 * Raised when uploads keep returning the post-finalize `mirror_missing_grant`
 * 403 after the retry budget is exhausted.
 */
export class MirrorGrantMissingError extends Error {
  readonly bucketId: string;
  readonly fileId?: string;
  readonly attempt: number;

  constructor(args: { bucketId: string; fileId?: string; attempt: number }) {
    super(
      `Bucket ${args.bucketId} still missing mirror grant after ${args.attempt} attempts`,
    );
    this.name = "MirrorGrantMissingError";
    this.bucketId = args.bucketId;
    this.fileId = args.fileId;
    this.attempt = args.attempt;
  }
}

/** Upload finished in a non-completed state (failed / timed out while polling). */
export class FileStatusError extends Error {
  readonly fileId: string;
  readonly state: string;
  readonly error?: { code: string; message: string };

  constructor(args: {
    fileId: string;
    state: string;
    error?: { code: string; message: string };
  }) {
    super(
      `File ${args.fileId} ended in state "${args.state}"${
        args.error ? `: ${args.error.code} ${args.error.message}` : ""
      }`,
    );
    this.name = "FileStatusError";
    this.fileId = args.fileId;
    this.state = args.state;
    this.error = args.error;
  }
}
