/**
 * Both directions of the preview worker have to be attributable: a task it did
 * not receive from the control plane must not be rendered, and a result it
 * produced must be provable as its own.
 *
 * Every case builds a real Ed25519 keypair and a real compact JWS, so refusals
 * come from the verifier rather than from malformed input it would have rejected
 * anyway.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, sign, verify, createPublicKey, createPrivateKey } from "node:crypto";
import { signResult, verifySignedTask, type TaskTrust } from "../src/transport.ts";
import type {
  PagePreviewResultContract,
  PagePreviewTaskContract,
} from "../contracts/generated/schema.js";

const KEY_ID = "urn:anvilkit:key:agent-service:preview";
const ISSUER = "urn:anvilkit:issuer:agent-service";

function canonicalTask(): PagePreviewTaskContract {
  const path = fileURLToPath(new URL("./fixtures/page-preview-task.minimum.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as PagePreviewTaskContract;
}

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return { privateKey, publicKeyBase64Url: jwk.x };
}

function trustFor(publicKeyBase64Url: string, overrides: Partial<{
  keys: ReadonlyMap<string, string>;
  revokedKeyIds: ReadonlySet<string>;
  acceptedIssuers: ReadonlySet<string>;
}> = {}): TaskTrust {
  return {
    keys: overrides.keys ?? new Map([[KEY_ID, publicKeyBase64Url]]),
    revokedKeyIds: overrides.revokedKeyIds ?? new Set<string>(),
    acceptedIssuers: overrides.acceptedIssuers ?? new Set([ISSUER]),
  };
}

/** Builds a compact JWS over the claims a dispatched task is bound by. */
function dispatch(
  task: PagePreviewTaskContract,
  privateKey: ReturnType<typeof keypair>["privateKey"],
  options: Partial<{ alg: string; kid: string; iss: string; claims: Record<string, unknown>; corrupt: boolean }> = {},
): string {
  const header = Buffer.from(JSON.stringify({
    alg: options.alg ?? "EdDSA",
    kid: options.kid ?? KEY_ID,
    iss: options.iss ?? ISSUER,
  })).toString("base64url");
  const claims = options.claims ?? {
    candidateDigest: task.candidateDigest,
    contractBomDigest: task.expected.contractBomDigest,
    catalogDigest: task.expected.catalogDigest,
    runtimeDigest: task.expected.runtimeDigest,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = options.corrupt
    ? Buffer.alloc(64).toString("base64url")
    : sign(null, Buffer.from(`${header}.${payload}`, "ascii"), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

test("a genuinely dispatched task is accepted", () => {
  const { privateKey, publicKeyBase64Url } = keypair();
  const task = canonicalTask();
  const verdict = verifySignedTask(task, dispatch(task, privateKey), trustFor(publicKeyBase64Url));
  assert.equal(verdict.accepted, true, JSON.stringify(verdict));
});

test("a worker with no trust material renders nothing", () => {
  const { privateKey, publicKeyBase64Url } = keypair();
  const task = canonicalTask();
  const jws = dispatch(task, privateKey);
  // A worker that rendered unverified tasks would execute whatever content
  // reached its port, which is the one thing an isolated renderer must not do.
  for (const trust of [
    trustFor(publicKeyBase64Url, { keys: new Map() }),
    trustFor(publicKeyBase64Url, { acceptedIssuers: new Set<string>() }),
  ]) {
    const verdict = verifySignedTask(task, jws, trust);
    assert.equal(verdict.accepted, false);
    assert.equal(verdict.reason, "not-configured");
  }
});

test("every way a dispatch can be wrong is refused with its own reason", () => {
  const { privateKey, publicKeyBase64Url } = keypair();
  const other = keypair();
  const task = canonicalTask();
  const cases: ReadonlyArray<readonly [string, string, TaskTrust]> = [
    ["malformed", "not.a.jws.at.all.x", trustFor(publicKeyBase64Url)],
    ["malformed", "onlyonepart", trustFor(publicKeyBase64Url)],
    ["unsupported-algorithm", dispatch(task, privateKey, { alg: "HS256" }), trustFor(publicKeyBase64Url)],
    ["unknown-key", dispatch(task, privateKey, { kid: "urn:anvilkit:key:someone-else" }), trustFor(publicKeyBase64Url)],
    ["revoked-key", dispatch(task, privateKey), trustFor(publicKeyBase64Url, { revokedKeyIds: new Set([KEY_ID]) })],
    ["untrusted-issuer", dispatch(task, privateKey, { iss: "urn:anvilkit:issuer:elsewhere" }), trustFor(publicKeyBase64Url)],
    ["bad-signature", dispatch(task, privateKey, { corrupt: true }), trustFor(publicKeyBase64Url)],
    ["bad-signature", dispatch(task, other.privateKey), trustFor(publicKeyBase64Url)],
  ];
  for (const [expected, jws, trust] of cases) {
    const verdict = verifySignedTask(task, jws, trust);
    assert.equal(verdict.accepted, false, `${expected}: accepted`);
    assert.equal(verdict.reason, expected);
  }
});

test("a valid signature cannot be replayed around a substituted task", () => {
  const { privateKey, publicKeyBase64Url } = keypair();
  const dispatched = canonicalTask();
  const jws = dispatch(dispatched, privateKey);

  // A substituted task is a substituted candidate, catalog, and set of approved
  // assets — the signature still verifies, so only the comparison catches it.
  for (const substituted of [
    { ...dispatched, candidateDigest: `sha256:${"9".repeat(64)}` },
    { ...dispatched, expected: { ...dispatched.expected, catalogDigest: `sha256:${"9".repeat(64)}` } },
    { ...dispatched, expected: { ...dispatched.expected, runtimeDigest: `sha256:${"9".repeat(64)}` } },
    { ...dispatched, expected: { ...dispatched.expected, contractBomDigest: `sha256:${"9".repeat(64)}` } },
  ] as PagePreviewTaskContract[]) {
    const verdict = verifySignedTask(substituted, jws, trustFor(publicKeyBase64Url));
    assert.equal(verdict.accepted, false, "a substituted task was accepted");
    assert.equal(verdict.reason, "payload-mismatch");
  }
});

test("a signed result verifies under the worker's key and is stable across encodings", () => {
  const seed = Buffer.alloc(32, 7);
  const result = { kind: "PagePreviewResult", taskId: "task.0001" } as unknown as PagePreviewResultContract;
  const jws = signResult(result, "urn:anvilkit:key:preview-worker", seed.toString("base64url"));
  const [header, payload, signature] = jws.split(".") as [string, string, string];

  // Derive the public half from the same seed and verify the detached signature.
  const privateKeyDer = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const key = createPrivateKey({ key: privateKeyDer, format: "der", type: "pkcs8" });
  const verified = verify(
    null,
    Buffer.from(`${header}.${payload}`, "ascii"),
    createPublicKey(key),
    Buffer.from(signature, "base64url"),
  );
  assert.equal(verified, true, "the worker's own signature did not verify");

  // Key order is normalised, so re-signing the same evidence with reordered
  // keys produces the identical signature: evidence re-encoded on the way back
  // is still verifiable.
  const reordered = { taskId: "task.0001", kind: "PagePreviewResult" } as unknown as PagePreviewResultContract;
  assert.equal(signResult(reordered, "urn:anvilkit:key:preview-worker", seed.toString("base64url")), jws);
});

test("a result signing key that is not a 32-byte seed is refused", () => {
  const result = { kind: "PagePreviewResult" } as unknown as PagePreviewResultContract;
  for (const bad of [Buffer.alloc(16).toString("base64url"), Buffer.alloc(64).toString("base64url"), ""]) {
    assert.throws(() => signResult(result, "kid", bad), /32-byte Ed25519 seed/);
  }
});
