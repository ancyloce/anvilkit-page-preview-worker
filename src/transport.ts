/**
 * Signed task intake and result emission.
 *
 * A preview worker renders untrusted content and produces evidence a reviewer
 * and the apply path rely on. Both directions therefore have to be attributable:
 * a task it did not receive from the control plane must not be rendered, and a
 * result it produced must be provable as its own.
 *
 * `PagePreviewResult` carries no provenance field of its own, so signatures here
 * are **detached** — the JWS travels beside the payload rather than inside it.
 * That keeps the canonical contract exactly as published while still making both
 * directions verifiable.
 */

import { createPublicKey, createPrivateKey, sign, verify } from "node:crypto";
import type {
  PagePreviewResultContract,
  PagePreviewTaskContract,
} from "../contracts/generated/schema.js";

/** Trust material for verifying dispatched tasks. Empty means verify nothing. */
export interface TaskTrust {
  /** Base64url raw Ed25519 public keys, by key id. */
  readonly keys: ReadonlyMap<string, string>;
  /** Key ids that must no longer verify, whatever `keys` holds. */
  readonly revokedKeyIds: ReadonlySet<string>;
  /** Issuers whose dispatched tasks this worker accepts. */
  readonly acceptedIssuers: ReadonlySet<string>;
}

export type TaskVerdict =
  | { readonly accepted: true; readonly task: PagePreviewTaskContract }
  | { readonly accepted: false; readonly reason: TaskRefusal };

export type TaskRefusal =
  | "not-configured"
  | "malformed"
  | "unknown-key"
  | "revoked-key"
  | "unsupported-algorithm"
  | "bad-signature"
  | "untrusted-issuer"
  | "payload-mismatch";

/**
 * Verifies a dispatched preview task.
 *
 * Fail-closed throughout, including when no trust material is configured: a
 * worker that rendered unverified tasks would execute whatever content reached
 * its port, which is the one thing an isolated renderer must never do.
 */
export function verifySignedTask(
  presented: PagePreviewTaskContract,
  compactJws: string,
  trust: TaskTrust,
): TaskVerdict {
  if (trust.keys.size === 0 || trust.acceptedIssuers.size === 0) {
    return { accepted: false, reason: "not-configured" };
  }

  const parts = compactJws.split(".");
  if (parts.length !== 3) return { accepted: false, reason: "malformed" };
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  let header: { alg?: unknown; kid?: unknown; iss?: unknown };
  let payload: Uint8Array;
  let signature: Uint8Array;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as typeof header;
    payload = Buffer.from(encodedPayload, "base64url");
    signature = Buffer.from(encodedSignature, "base64url");
  } catch {
    return { accepted: false, reason: "malformed" };
  }

  if (header.alg !== "EdDSA") return { accepted: false, reason: "unsupported-algorithm" };

  const keyId = typeof header.kid === "string" ? header.kid : "";
  if (trust.revokedKeyIds.has(keyId)) return { accepted: false, reason: "revoked-key" };
  const encodedKey = trust.keys.get(keyId);
  if (encodedKey === undefined) return { accepted: false, reason: "unknown-key" };

  const issuer = typeof header.iss === "string" ? header.iss : "";
  if (!trust.acceptedIssuers.has(issuer)) return { accepted: false, reason: "untrusted-issuer" };

  const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`, "ascii");
  if (!verifyEd25519(encodedKey, signingInput, signature)) {
    return { accepted: false, reason: "bad-signature" };
  }

  // The signature covers the payload, not the object handed to us. Without this
  // comparison a valid signature could be replayed around a substituted task —
  // and a substituted task is a substituted candidate, catalog, and set of
  // approved assets.
  if (!signedTaskMatches(payload, presented)) {
    return { accepted: false, reason: "payload-mismatch" };
  }

  return { accepted: true, task: presented };
}

function signedTaskMatches(payload: Uint8Array, presented: PagePreviewTaskContract): boolean {
  try {
    const signed = JSON.parse(Buffer.from(payload).toString("utf8")) as Record<string, unknown>;
    const bound: ReadonlyArray<readonly [string, string]> = [
      ["candidateDigest", presented.candidateDigest],
      ["contractBomDigest", presented.expected.contractBomDigest],
      ["catalogDigest", presented.expected.catalogDigest],
      ["runtimeDigest", presented.expected.runtimeDigest],
    ];
    for (const [key, expected] of bound) {
      if (signed[key] !== expected) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Signs a result, detached.
 *
 * The worker's key attests that this worker produced this evidence. It grants
 * nothing else: it is not a credential for any other system and cannot approve,
 * finalize, or publish anything.
 */
export function signResult(result: PagePreviewResultContract, keyId: string, seedBase64Url: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", kid: keyId, typ: "JOSE" }),
    "utf8",
  ).toString("base64url");
  // Key order is normalised so the same evidence signs identically twice; a
  // signature that depended on serialization order could not be re-verified
  // from a re-encoded payload.
  const payload = Buffer.from(canonicalJson(result), "utf8").toString("base64url");
  const signingInput = Buffer.from(`${header}.${payload}`, "ascii");
  const signature = sign(null, signingInput, privateKeyFromSeed(seedBase64Url)).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

/**
 * Builds an Ed25519 private key from its raw 32-byte seed.
 *
 * The JWK route needs both `d` and the public `x`, and supplying an empty `x`
 * produces a key that type-checks and then fails at signing time. Wrapping the
 * seed in its PKCS#8 structure needs only the seed, which is the one thing a
 * deployment actually mounts.
 */
function privateKeyFromSeed(seedBase64Url: string) {
  const seed = Buffer.from(seedBase64Url, "base64url");
  if (seed.length !== 32) {
    throw new Error("result signing key must be a 32-byte Ed25519 seed");
  }
  // PKCS#8 header for an Ed25519 private key, followed by the seed octets.
  const pkcs8Header = Buffer.from("302e020100300506032b657004220420", "hex");
  return createPrivateKey({
    key: Buffer.concat([pkcs8Header, seed]),
    format: "der",
    type: "pkcs8",
  });
}

/** Stable JSON: object keys sorted at every depth, no incidental whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function verifyEd25519(base64UrlPublicKey: string, signingInput: Buffer, signature: Uint8Array): boolean {
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: base64UrlPublicKey },
      format: "jwk",
    });
    return verify(null, signingInput, key, signature);
  } catch {
    // An unparseable key and a signature that does not verify are the same
    // answer to the only question being asked.
    return false;
  }
}
