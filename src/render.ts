/**
 * Renders one page candidate across the viewport matrix the task pinned and
 * reports what happened.
 *
 * The result is evidence, not a verdict. This worker never decides whether a
 * candidate is good enough to apply; it records what the candidate did when it
 * was rendered under stated conditions, and a reviewer and the apply path
 * decide from that.
 */

import type {
  PagePreviewResultContract,
  PagePreviewTaskContract,
} from "../contracts/generated/schema.js";
// Imported with its real extension: this worker has no build step — Node runs
// the TypeScript sources directly — so a ".js" specifier names a file that does
// not exist at runtime. Type-only imports elsewhere are erased before Node sees
// them, which is why they can keep the compiled-output convention.
import {
  approvedAssets,
  boundsOf,
  decideRoute,
  verifyExpectations,
  type PolicyViolation,
} from "./isolation.ts";

/** One viewport's outcome, kept separate so a failure does not lose the others. */
type ViewportStatus = "rendered" | "failed" | "timed-out";

/**
 * The browser surface this worker needs.
 *
 * Narrow on purpose. The pipeline is written against what a render requires —
 * navigate, route, screenshot, audit — rather than against a browser library,
 * so the isolation rules stay readable and the engine can be replaced without
 * rewriting them.
 */
export interface RenderEngine {
  /** Renders one viewport and returns its screenshot bytes. */
  render(request: {
    readonly document: string;
    readonly viewportWidth: number;
    readonly viewportHeight: number;
    readonly locale: string;
    readonly theme: string;
    readonly timezone: string;
    readonly reducedMotion: boolean;
    readonly deterministicSeed: number;
    readonly deadlineMs: number;
    /** Called for every request the page attempts. Returning false blocks it. */
    readonly onRequest: (url: string) => boolean;
    /** Called for every console message the page emits. */
    readonly onConsole: (level: string, text: string) => void;
  }): Promise<{ screenshot: Uint8Array; components: ComponentOutcome[]; accessibility: AccessibilityFinding[] }>;
}

export interface ComponentOutcome {
  readonly componentId: string;
  readonly status: "resolved" | "substituted" | "missing" | "forbidden";
  readonly detail: string;
}

export interface AccessibilityFinding {
  readonly ruleId: string;
  readonly impact: "minor" | "moderate" | "serious" | "critical";
  readonly nodeCount: number;
}

/** Where screenshot bytes are placed. The worker stores evidence, never state. */
export interface ScreenshotStore {
  put(bytes: Uint8Array): Promise<{ artifactId: string; digest: string; sizeBytes: number }>;
}

export interface WorkerEnvironment {
  readonly imageDigest: string;
  readonly environmentDigest: string;
  readonly contractBomDigest: string;
  readonly catalogDigest: string;
  readonly runtimeDigest: string;
}

/**
 * Runs the preview.
 *
 * Every viewport is attempted even when an earlier one failed: a matrix exists
 * because a candidate can be correct at one size and broken at another, and
 * stopping at the first failure would hide exactly the evidence the matrix was
 * requested for.
 */
export async function renderPreview(
  task: PagePreviewTaskContract,
  document: string,
  engine: RenderEngine,
  screenshots: ScreenshotStore,
  environment: WorkerEnvironment,
  traceparent: string,
  now: () => number,
): Promise<PagePreviewResultContract> {
  // Refuse before loading anything if this worker is not the one the task
  // pinned. Rendering anyway would produce a convincing artifact about the
  // wrong catalog.
  verifyExpectations(task, environment);

  const approved = approvedAssets(task);
  const bounds = boundsOf(task);
  const started = now();

  const violations: PolicyViolation[] = [];
  const components = new Map<string, ComponentOutcome>();
  const accessibility = new Map<string, AccessibilityFinding>();
  const capturedScreenshots: PagePreviewResultContract["screenshots"] = [];
  const statuses: { viewportIndex: number; status: ViewportStatus }[] = [];

  for (const [viewportIndex, viewport] of task.matrix.entries()) {
    const remaining = bounds.deadlineMs - (now() - started);
    if (remaining <= 0) {
      // Out of budget: the remaining viewports are reported as timed out rather
      // than silently omitted, so the reviewer sees coverage that was not taken.
      statuses.push({ viewportIndex, status: "timed-out" });
      continue;
    }

    try {
      const rendered = await engine.render({
        document,
        viewportWidth: viewport.viewportWidth,
        viewportHeight: viewport.viewportHeight,
        locale: viewport.locale,
        theme: viewport.theme,
        // Determinism comes from the task, so two runs of the same candidate
        // under the same task are comparable. A worker-chosen clock or seed
        // would make screenshot comparison meaningless.
        timezone: task.runtimeProfile.timezone,
        reducedMotion: task.runtimeProfile.reducedMotion,
        deterministicSeed: task.runtimeProfile.deterministicSeed,
        deadlineMs: remaining,
        onRequest: (url) => {
          const decision = decideRoute(url, approved);
          if (!decision.allow) {
            violations.push(decision.violation);
            return false;
          }
          return true;
        },
        onConsole: (level, text) => {
          if (level === "error" || level === "warning") {
            violations.push({
              channel: "console",
              severity: level === "error" ? "error" : "warning",
              detail: text.slice(0, 512),
            });
          }
        },
      });

      const stored = await screenshots.put(rendered.screenshot);
      capturedScreenshots.push({
        viewportIndex,
        artifact: {
          artifactId: stored.artifactId,
          digest: stored.digest,
          mediaType: "image/png",
          sizeBytes: stored.sizeBytes,
        },
      });
      // Component and accessibility findings are merged across viewports and
      // keyed, because the same component failing at three sizes is one problem
      // to fix, not three.
      for (const outcome of rendered.components) components.set(outcome.componentId, outcome);
      for (const finding of rendered.accessibility) accessibility.set(finding.ruleId, finding);
      statuses.push({ viewportIndex, status: "rendered" });
    } catch {
      // The thrown detail is not carried into the result: it can name internal
      // paths, and this record travels back to the control plane.
      statuses.push({ viewportIndex, status: "failed" });
      violations.push({
        channel: "console",
        severity: "error",
        detail: `viewport ${viewportIndex} did not render`,
      });
    }
  }

  const first = statuses[0] ?? { viewportIndex: 0, status: "failed" as ViewportStatus };

  return {
    kind: "PagePreviewResult",
    candidateDigest: task.candidateDigest,
    screenshots: capturedScreenshots.slice(0, 32),
    viewportStatuses: [first, ...statuses.slice(1, 32)],
    componentResolution: [...components.values()].slice(0, 128),
    policyViolations: violations.slice(0, 128),
    accessibilityFindings: [...accessibility.values()].slice(0, 128),
    resourceUsage: {
      durationMilliseconds: now() - started,
      peakMemoryBytes: 0,
      cpuMillis: 0,
    },
    workerEnvironment: {
      imageDigest: environment.imageDigest,
      environmentDigest: environment.environmentDigest,
    },
    traceContext: { traceparent },
    evidence: [],
  };
}
