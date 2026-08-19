import { base64UrlEncode } from "@cosmaneura-scribe/capture-protocol";

import type { AudioEncryptionPublicKey } from "../bff/contracts";
import { QueueInvariantError } from "../queue/errors";

const SESSION_DEK_BYTES = 32;
const RSA_3072_WRAPPED_BYTES = 384;

export interface WrappedSessionKey {
  readonly key: CryptoKey;
  readonly keyVersion: string;
  readonly wrappedDek: string;
}

export async function createWrappedSessionKey(
  published: AudioEncryptionPublicKey,
  crypto: Crypto = globalThis.crypto,
): Promise<WrappedSessionKey> {
  assertPublishedKey(published);
  if (crypto?.subtle === undefined) throw new QueueInvariantError("webcrypto_unavailable");

  const raw = crypto.getRandomValues(
    new Uint8Array(new ArrayBuffer(SESSION_DEK_BYTES)),
  );
  try {
    const temporaryKey = await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt"],
    );
    const wrappingKey = await crypto.subtle.importKey(
      "jwk",
      published.public_jwk,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["wrapKey"],
    );
    const wrapped = await crypto.subtle.wrapKey(
      "raw",
      temporaryKey,
      wrappingKey,
      { name: "RSA-OAEP" },
    );
    if (wrapped.byteLength !== RSA_3072_WRAPPED_BYTES) {
      throw new QueueInvariantError("invalid_wrapped_dek");
    }
    const key = await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt"],
    );
    return {
      key,
      keyVersion: published.key_version,
      wrappedDek: base64UrlEncode(new Uint8Array(wrapped)),
    };
  } finally {
    raw.fill(0);
  }
}

function assertPublishedKey(value: AudioEncryptionPublicKey): void {
  if (
    value.algorithm !== "RSA-OAEP-256" ||
    value.key_version.length < 1 ||
    value.public_jwk.kty !== "RSA" ||
    value.public_jwk.alg !== "RSA-OAEP-256" ||
    value.public_jwk.ext !== true ||
    value.public_jwk.e !== "AQAB" ||
    value.public_jwk.key_ops.length !== 1 ||
    value.public_jwk.key_ops[0] !== "wrapKey" ||
    !/^[A-Za-z0-9_-]+$/u.test(value.public_jwk.n)
  ) {
    throw new QueueInvariantError("invalid_audio_encryption_key");
  }
}
