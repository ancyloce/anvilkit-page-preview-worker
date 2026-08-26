/**
 * The isolation model is what makes a preview safe to run at all: a page
 * candidate is model-produced content executing in an engine designed to fetch
 * things. These assert that the default is unreachable and that every exception
 * is something the task named.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { approvedAssets, boundsOf, decideRoute, verifyExpectations } from "../src/isolation.ts";
import type { PagePreviewTaskContract } from "../contracts/generated/schema.js";

/** The canonical fixture, used verbatim so these track the contract. */
function canonicalTask(): PagePreviewTaskContract {
  const path = fileURLToPath(new URL("./fixtures/page-preview-task.minimum.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as PagePreviewTaskContract;
}

function taskWithAssets(artifactIds: readonly string[]): PagePreviewTaskContract {
  const task = canonicalTask();
  return {
    ...task,
    resolved: {
      ...task.resolved,
      approvedAssets: artifactIds.map((artifactId) => ({
        artifactId,
        digest: `sha256:${"a".repeat(64)}`,
        mediaType: "image/png",
        sizeBytes: 128,
      })),
    },
  } as PagePreviewTaskContract;
}

test("a task with no approved assets reaches nothing on the network", () => {
  const approved = approvedAssets(canonicalTask());
  assert.equal(approved.size, 0);
  for (const url of [
    "https://evil.example/collect",
    "http://169.254.169.254/latest/meta-data/",
    "https://gateway.internal/v1/models",
    "file:///etc/passwd",
    "anvilkit://artifact/not-approved",
  ]) {
    const decision = decideRoute(url, approved);
    assert.equal(decision.allow, false, `${url} was reachable`);
    assert.equal(decision.because, "denied-by-default");
  }
});

test("inline content is allowed because it is already inside the admitted document", () => {
  const approved = approvedAssets(canonicalTask());
  for (const url of ["data:image/png;base64,AAAA", "about:blank"]) {
    const decision = decideRoute(url, approved);
    assert.equal(decision.allow, true, `${url} was blocked`);
    assert.equal(decision.because, "inline-document");
  }
});

test("an approved asset is reachable, and only by exact artifact identity", () => {
  const approved = approvedAssets(taskWithAssets(["artifact.logo.001"]));
  const allowed = decideRoute("anvilkit://artifact/artifact.logo.001", approved);
  assert.equal(allowed.allow, true);
  assert.equal(allowed.because, "approved-asset");

  // A prefix, suffix, or lookalike must not inherit the approval: pinning
  // assets is pointless if a candidate can name a near-miss.
  for (const lookalike of [
    "anvilkit://artifact/artifact.logo.0011",
    "anvilkit://artifact/artifact.logo.00",
    "anvilkit://artifact/artifact.logo.001/../other",
    "anvilkit://artifact/artifact.logo.001?x=1",
    "https://cdn.example/artifact.logo.001",
  ]) {
    assert.equal(decideRoute(lookalike, approved).allow, false, `${lookalike} inherited an approval`);
  }
});

test("a blocked request is recorded rather than quietly dropped", () => {
  const decision = decideRoute("https://evil.example/collect", new Set<string>());
  assert.equal(decision.allow, false);
  // A render that silently dropped the attempt would hide a candidate trying to
  // exfiltrate; the reviewer needs to see what was reached for.
  assert.equal(decision.violation.channel, "network");
  assert.equal(decision.violation.severity, "error");
  assert.match(decision.violation.detail, /evil\.example/);
});

test("a recorded violation carries no query string and is bounded", () => {
  const withSecret = decideRoute("https://evil.example/collect?token=super-secret-value", new Set<string>());
  assert.equal(withSecret.allow, false);
  // The record is durable, and a candidate can embed credentials in a query.
  assert.ok(!withSecret.violation.detail.includes("super-secret-value"), withSecret.violation.detail);

  const long = decideRoute(`https://evil.example/${"a".repeat(4000)}`, new Set<string>());
  assert.equal(long.allow, false);
  assert.ok(long.violation.detail.length < 300, `detail was ${long.violation.detail.length} chars`);
});

test("bounds come from the task, never from local defaults", () => {
  const task = canonicalTask();
  const bounds = boundsOf(task);
  assert.equal(bounds.deadlineMs, task.limits.timeoutMilliseconds);
  assert.equal(bounds.memoryBytes, task.limits.memoryBytes);
  assert.equal(bounds.cpuMillis, task.limits.cpuMillis);
  assert.equal(bounds.outputBytes, task.limits.outputBytes);

  // A worker that could widen its own limits could spend what nobody budgeted.
  const tighter = { ...task, limits: { ...task.limits, timeoutMilliseconds: 1_000 } } as PagePreviewTaskContract;
  assert.equal(boundsOf(tighter).deadlineMs, 1_000);
});

test("a render environment that does not match what the task pinned is refused", () => {
  const task = canonicalTask();
  const matching = {
    contractBomDigest: task.expected.contractBomDigest,
    catalogDigest: task.expected.catalogDigest,
    runtimeDigest: task.expected.runtimeDigest,
  };
  assert.doesNotThrow(() => verifyExpectations(task, matching));

  // A preview of the wrong catalog or runtime is not evidence about this
  // candidate, so it is refused before any content loads.
  for (const [field, label] of [
    ["contractBomDigest", "contract BOM"],
    ["catalogDigest", "catalog"],
    ["runtimeDigest", "runtime"],
  ] as const) {
    assert.throws(
      () => verifyExpectations(task, { ...matching, [field]: `sha256:${"9".repeat(64)}` }),
      new RegExp(label),
      `a mismatched ${label} was accepted`,
    );
  }
});
