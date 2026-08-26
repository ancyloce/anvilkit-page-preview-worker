/**
 * The preview result is evidence, not a verdict. These assert the pipeline
 * records what a candidate did under stated conditions — including what it was
 * stopped from doing, and what was never attempted — rather than deciding
 * anything about it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderPreview, type RenderEngine, type ScreenshotStore, type WorkerEnvironment } from "../src/render.ts";
import type { PagePreviewTaskContract } from "../contracts/generated/schema.js";

function taskWithViewports(count: number): PagePreviewTaskContract {
  const path = fileURLToPath(new URL("./fixtures/page-preview-task.minimum.json", import.meta.url));
  const task = JSON.parse(readFileSync(path, "utf8")) as PagePreviewTaskContract;
  const one = task.matrix[0]!;
  return {
    ...task,
    matrix: Array.from({ length: count }, (_, index) => ({ ...one, viewportWidth: 320 + index * 320 })),
  } as PagePreviewTaskContract;
}

function environmentFor(task: PagePreviewTaskContract): WorkerEnvironment {
  return {
    imageDigest: `sha256:${"1".repeat(64)}`,
    environmentDigest: `sha256:${"2".repeat(64)}`,
    contractBomDigest: task.expected.contractBomDigest,
    catalogDigest: task.expected.catalogDigest,
    runtimeDigest: task.expected.runtimeDigest,
  };
}

const store: ScreenshotStore = {
  async put(bytes) {
    return { artifactId: "artifact.shot.001", digest: `sha256:${"a".repeat(64)}`, sizeBytes: bytes.length };
  },
};

function engineThat(behaviour: (index: number, request: Parameters<RenderEngine["render"]>[0]) => Promise<{
  screenshot: Uint8Array;
  components: { componentId: string; status: "resolved" | "substituted" | "missing" | "forbidden"; detail: string }[];
  accessibility: { ruleId: string; impact: "minor" | "moderate" | "serious" | "critical"; nodeCount: number }[];
}>): { engine: RenderEngine; calls: Parameters<RenderEngine["render"]>[0][] } {
  const calls: Parameters<RenderEngine["render"]>[0][] = [];
  return {
    calls,
    engine: {
      async render(request) {
        const index = calls.length;
        calls.push(request);
        return behaviour(index, request);
      },
    },
  };
}

const blank = { screenshot: new Uint8Array([1, 2, 3]), components: [], accessibility: [] };

test("every viewport is attempted even after one fails", async () => {
  const task = taskWithViewports(3);
  const { engine, calls } = engineThat(async (index) => {
    if (index === 1) throw new Error("/internal/path/that/must/not/travel exploded");
    return blank;
  });
  const result = await renderPreview(task, "<html></html>", engine, store, environmentFor(task), "00-a-b-01", () => 0);

  // A candidate can be correct at one size and broken at another; stopping at
  // the first failure would hide exactly the evidence the matrix was requested for.
  assert.equal(calls.length, 3);
  assert.deepEqual(result.viewportStatuses.map((s) => s.status), ["rendered", "failed", "rendered"]);
  assert.equal(result.screenshots.length, 2);

  // The thrown detail names internal paths and must not travel in evidence.
  const failure = result.policyViolations.find((v) => v.detail.includes("viewport 1"));
  assert.ok(failure, "the failed viewport was not recorded");
  for (const violation of result.policyViolations) {
    assert.ok(!violation.detail.includes("/internal/path"), violation.detail);
  }
});

test("viewports past the deadline are reported as timed out, not omitted", async () => {
  const task = taskWithViewports(3);
  let clock = 0;
  // Budget is exhausted after the first viewport.
  const { engine, calls } = engineThat(async () => {
    clock = task.limits.timeoutMilliseconds + 1;
    return blank;
  });
  const result = await renderPreview(task, "<html></html>", engine, store, environmentFor(task), "00-a-b-01", () => clock);

  assert.equal(calls.length, 1, "a viewport was attempted past the deadline");
  // Coverage that was not taken is still coverage the reviewer must see.
  assert.deepEqual(result.viewportStatuses.map((s) => s.status), ["rendered", "timed-out", "timed-out"]);
  assert.deepEqual(result.viewportStatuses.map((s) => s.viewportIndex), [0, 1, 2]);
});

test("a blocked request is refused to the page and recorded as evidence", async () => {
  const task = taskWithViewports(1);
  const { engine } = engineThat(async (_index, request) => {
    assert.equal(request.onRequest("https://evil.example/collect"), false, "an unapproved request was allowed");
    assert.equal(request.onRequest("data:image/png;base64,AA"), true, "inline content was blocked");
    return blank;
  });
  const result = await renderPreview(task, "<html></html>", engine, store, environmentFor(task), "00-a-b-01", () => 0);
  const network = result.policyViolations.filter((v) => v.channel === "network");
  assert.equal(network.length, 1);
  assert.match(network[0]!.detail, /evil\.example/);
});

test("console errors and warnings become bounded evidence, and chatter does not", async () => {
  const task = taskWithViewports(1);
  const { engine } = engineThat(async (_index, request) => {
    request.onConsole("error", "x".repeat(2000));
    request.onConsole("warning", "a warning");
    request.onConsole("info", "just chatter");
    request.onConsole("debug", "more chatter");
    return blank;
  });
  const result = await renderPreview(task, "<html></html>", engine, store, environmentFor(task), "00-a-b-01", () => 0);
  const console = result.policyViolations.filter((v) => v.channel === "console");
  assert.deepEqual(console.map((v) => v.severity), ["error", "warning"]);
  assert.equal(console[0]!.detail.length, 512, "an unbounded console message was recorded");
});

test("findings are merged across viewports, because one broken component is one problem", async () => {
  const task = taskWithViewports(3);
  const { engine } = engineThat(async () => ({
    screenshot: new Uint8Array([1]),
    components: [{ componentId: "Hero", status: "missing" as const, detail: "not in catalog" }],
    accessibility: [{ ruleId: "color-contrast", impact: "serious" as const, nodeCount: 2 }],
  }));
  const result = await renderPreview(task, "<html></html>", engine, store, environmentFor(task), "00-a-b-01", () => 0);
  assert.equal(result.componentResolution.length, 1, "the same component was reported once per viewport");
  assert.equal(result.accessibilityFindings.length, 1);
});

test("determinism is taken from the task so two runs are comparable", async () => {
  const task = taskWithViewports(1);
  const { engine, calls } = engineThat(async () => blank);
  await renderPreview(task, "<html></html>", engine, store, environmentFor(task), "00-a-b-01", () => 0);
  const request = calls[0]!;
  // A worker-chosen clock or seed would make screenshot comparison meaningless.
  assert.equal(request.timezone, task.runtimeProfile.timezone);
  assert.equal(request.deterministicSeed, task.runtimeProfile.deterministicSeed);
  assert.equal(request.reducedMotion, task.runtimeProfile.reducedMotion);
  assert.equal(request.viewportWidth, task.matrix[0]!.viewportWidth);
});

test("a worker that is not the one the task pinned refuses before loading anything", async () => {
  const task = taskWithViewports(2);
  const { engine, calls } = engineThat(async () => blank);
  const wrongCatalog = { ...environmentFor(task), catalogDigest: `sha256:${"9".repeat(64)}` };
  await assert.rejects(
    () => renderPreview(task, "<html></html>", engine, store, wrongCatalog, "00-a-b-01", () => 0),
    /catalog/,
  );
  // Rendering anyway would produce a convincing artifact about the wrong catalog.
  assert.equal(calls.length, 0, "content was loaded before the environment was checked");
});

test("an empty matrix still answers with the one status the contract requires", async () => {
  const task = taskWithViewports(0);
  const { engine } = engineThat(async () => blank);
  const result = await renderPreview(task, "<html></html>", engine, store, environmentFor(task), "00-a-b-01", () => 0);
  // viewportStatuses has minItems 1, so an empty matrix cannot answer with none.
  assert.equal(result.viewportStatuses.length, 1);
  assert.equal(result.viewportStatuses[0]!.status, "failed");
  assert.equal(result.screenshots.length, 0);
});
