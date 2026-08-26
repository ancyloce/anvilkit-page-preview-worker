/**
 * The isolation model for one page-candidate render.
 *
 * A preview renders a document produced by a model, using components from a
 * catalog, inside a real browser. That is untrusted content executing in an
 * engine designed to fetch things. The default therefore has to be that it
 * reaches nothing, and every exception has to be something the task named.
 *
 * Denial is enforced at the route level rather than by policy, so a candidate
 * that tries to phone home is stopped by the renderer rather than noticed
 * afterwards in a report.
 */

import type { PagePreviewTaskContract } from "../contracts/generated/schema.js";

/** A request the render attempted that the task did not permit. */
export interface PolicyViolation {
  readonly channel: "console" | "network";
  readonly severity: "info" | "warning" | "error";
  readonly detail: string;
}

/**
 * Route decisions available to the renderer. Modelled explicitly so the reason
 * a request was allowed is recorded, not inferred from whether it succeeded.
 */
export type RouteDecision =
  | { readonly allow: true; readonly because: "approved-asset" | "inline-document" }
  | { readonly allow: false; readonly because: "denied-by-default"; readonly violation: PolicyViolation };

/**
 * Builds the closed set of URLs a render may fetch.
 *
 * Only the assets the task explicitly approved are reachable, matched exactly.
 * A prefix or host match would let a lookalike path through, and the whole point
 * of pinning approved assets is that the render sees the bytes the run was
 * admitted against.
 */
export function approvedAssets(task: PagePreviewTaskContract): ReadonlySet<string> {
  const approved = new Set<string>();
  for (const asset of task.resolved.approvedAssets) {
    // Assets are addressed by artifact identity, never by an arbitrary URL the
    // candidate supplied: a candidate that could name its own asset URL could
    // name any URL.
    approved.add(asset.artifactId);
  }
  return approved;
}

/**
 * Decides one request.
 *
 * `deny-all` is the only network policy the contract admits, so this function
 * has no permissive branch to fall into. Anything not resolvable to an approved
 * asset is refused and recorded as a violation the result will carry — a render
 * that quietly dropped the attempt would hide a candidate trying to exfiltrate.
 */
export function decideRoute(url: string, approved: ReadonlySet<string>): RouteDecision {
  if (url.startsWith("data:") || url.startsWith("about:")) {
    // Inline content is already inside the document the run was admitted with.
    return { allow: true, because: "inline-document" };
  }
  const artifactId = artifactIdentityOf(url);
  if (artifactId !== undefined && approved.has(artifactId)) {
    return { allow: true, because: "approved-asset" };
  }
  return {
    allow: false,
    because: "denied-by-default",
    violation: {
      channel: "network",
      severity: "error",
      // The attempted destination is recorded: a reviewer needs to know what a
      // candidate reached for, and this string never leaves the governed result.
      detail: `blocked request to ${redact(url)}`,
    },
  };
}

/**
 * Extracts the artifact identity an asset URL addresses, or undefined when the
 * URL is not an artifact reference at all.
 */
function artifactIdentityOf(url: string): string | undefined {
  const match = /^anvilkit:\/\/artifact\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(url);
  return match?.[1];
}

/**
 * Trims a destination to what a reviewer needs. Query strings can carry
 * credentials a candidate embedded, and the violation record is durable.
 */
function redact(url: string): string {
  const cut = url.indexOf("?");
  const withoutQuery = cut === -1 ? url : `${url.slice(0, cut)}?…`;
  return withoutQuery.length > 200 ? `${withoutQuery.slice(0, 200)}…` : withoutQuery;
}

/** Hard bounds one render runs under, taken from the task rather than defaults. */
export interface RenderBounds {
  readonly deadlineMs: number;
  readonly memoryBytes: number;
  readonly cpuMillis: number;
  readonly outputBytes: number;
}

/**
 * Reads the bounds the task was dispatched with.
 *
 * Bounds come from the task, never from local configuration: the control plane
 * sized this attempt, and a worker that could widen its own limits could spend
 * resources nobody budgeted.
 */
export function boundsOf(task: PagePreviewTaskContract): RenderBounds {
  return {
    deadlineMs: task.limits.timeoutMilliseconds,
    memoryBytes: task.limits.memoryBytes,
    cpuMillis: task.limits.cpuMillis,
    outputBytes: task.limits.outputBytes,
  };
}

/**
 * Verifies the render environment matches what the task expects before any
 * content is loaded.
 *
 * A preview whose catalog or runtime differs from the one the candidate was
 * generated against is not evidence about that candidate. Refusing here is
 * cheaper and far more honest than producing a screenshot of the wrong thing.
 */
export function verifyExpectations(
  task: PagePreviewTaskContract,
  actual: { contractBomDigest: string; catalogDigest: string; runtimeDigest: string },
): void {
  const mismatches: string[] = [];
  if (actual.contractBomDigest !== task.expected.contractBomDigest) mismatches.push("contract BOM");
  if (actual.catalogDigest !== task.expected.catalogDigest) mismatches.push("catalog");
  if (actual.runtimeDigest !== task.expected.runtimeDigest) mismatches.push("runtime");
  if (mismatches.length > 0) {
    throw new Error(
      `preview refused: this worker's ${mismatches.join(", ")} does not match what the task pinned`,
    );
  }
}
