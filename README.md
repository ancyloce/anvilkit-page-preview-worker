# anvilkit-page-preview-worker

Isolated, deterministic rendering of AnvilKit page candidates.

## Why this service is Node

Because it *runs* in a Node runtime. The process deployed here drives a browser
through a Node automation library; the runtime is part of what this service is,
not a preference about how to write it.

Rendering reinforces that: a Go renderer could not use Puck, so it would
reimplement Puck's component rendering, and its screenshots would be evidence
about that reimplementation rather than about the page Studio will actually
produce. Design 0001 §2.2 requires the apply path to materialize Puck Data
*without reinterpretation*.

This is the basis of its exemption from the Platform's Go-first rule, recorded
as **ADR-025 §17**. The exemption is the language and nothing else. Browser
automation is fine — `playwright-core` is not restricted and returns the moment
`RenderEngine` is implemented. What stays forbidden here is the React/Puck
rendering surface: `react`, `react-dom`, and `@measured/puck`, enforced by
`scripts/dependency-audit.ts`. Driving a browser that loads a separately
released Puck bundle is permitted; importing Puck's components into this service
is not.

It is **not** the Export Worker. Export Worker's "preview" means deployment
export against a render origin: a Go pipeline with no frontend runtime, no Puck
candidate rendering, no screenshot comparison, and no accessibility evidence.

It is not an Agent Runtime Unit either. This is a worker: it holds no
definition, resolves no turn, and reaches no model.

## What it owns

Isolated deterministic rendering, screenshots, render diagnostics, and the
accessibility report. Nothing else — it commits no business state, approves
nothing, and publishes nothing. Its output is evidence a reviewer and the apply
path consult.

## Isolation

`src/isolation.ts` is where the guarantees live.

- **Denial by default at the route level.** The contract admits one network
  policy, `deny-all`, so there is no permissive branch. Anything not resolving
  to an asset the task approved is refused *and recorded* — a render that
  quietly dropped the attempt would hide a candidate trying to exfiltrate.
- **Approved assets are matched exactly, by artifact identity.** Not by prefix,
  not by host, and never by a URL the candidate supplied: a candidate that could
  name its own asset URL could name any URL.
- **Bounds come from the task.** Deadline, memory, CPU, and output size are the
  ones the control plane sized this attempt with; a worker that could widen its
  own limits could spend resources nobody budgeted.
- **Expectations are verified before content loads.** If this worker's contract
  BOM, catalog, or runtime differs from what the task pinned, the render is
  refused. A screenshot of the wrong catalog is not evidence about the
  candidate — it is a misleading artifact that looks like one.

## Contracts

`contracts/generated` holds canonical Agent types generated in
`anvilkit-platform` and vendored here; these repositories integrate through
contracts, never source imports. `contracts/pin.json` records the digests of the
generated types, the P0-Kernel profile, and the lock they came from. Re-vendor
and re-pin after any canonical contract change; never edit the generated file.

The worker consumes `PagePreviewTask` and produces `PagePreviewResult`.

## Status

Repository ownership was approved on 2026-08-24 (ADR-025 §14, approval 3), and
this repository is a Platform submodule at `services/preview-worker`, tracking
`github.com/ancyloce/anvilkit-page-preview-worker`.

`src/`, `contracts/`, and `test/` typecheck clean under `tsc --noEmit` with
`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, and
`verbatimModuleSyntax`. **21 tests** cover the isolation model, signed task
intake, result signing, and the render pipeline's decisions; they run on Node's
built-in runner with no test dependency, because Node strips TypeScript types
natively.

Run its scripts through **Bun**, not npm: the Platform root pins
`devEngines.packageManager` to bun, so `npm test` refuses inside this tree. Use
`bun run --cwd services/preview-worker test` (or `node --test 'test/**/*.test.ts'`
directly — the tests need no dependency at all).

Two things remain true and are not fixable by tests: **`RenderEngine` has no
implementation, so no page has ever been rendered**, and `npm run lint` cannot
run — eslint 9 needs a flat config and `typescript-eslint` is not a dependency
here. Treat any claim about real rendering as unvalidated.
