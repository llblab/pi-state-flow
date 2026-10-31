# Public semantic modules

## Status

Public API v1 is published through `@llblab/pi-state-flow/modules` since **0.27.0** and remains supported in **0.27.1**. It includes native-host registration/disposal, metadata v4 descriptors and opaque retention, external-root read/patch tools, captured Active/Passive context, and cohort-atomic Active producer replacements. The package export and source types in `api/modules.ts` and `lib/semantic-module.ts` define the executable surface; this document owns its integration and trust contract.

Registration and codec/retention received bounded independent acceptance during development. Later activation implementation and final audit were performed inline under the owner's instruction; publication does not retroactively grant independent approval to those subphases. Scripted native-SDK and built-package consumer checks are deterministic integration evidence, not live-model quality or installed-client certification. See [compatibility](compatibility.md) for evidence limits and [BACKLOG](../BACKLOG.md) for outstanding work.

Pi loads ordinary companion extensions. StateFlow provides a thin public registration membrane; it does not discover or load plugin code. The [internal evaluators](semantic-module-contract.md) remain separate from native/source admission and atomic publication.

## Public entry and lifecycle

Import the runtime function `registerStateFlowModule` from `@llblab/pi-state-flow/modules`. The same entry exports types `StateFlowModule`, `StateFlowModuleSource`, `StateFlowModuleFrame`, `StateFlowModuleInput`, `ModuleContextContribution`, `JsonObject` and `JsonValue`; there is no exported loader or publisher. Local source consumers may import `api/modules.ts`; compiled consumers use `dist/api/modules.js`. These membranes do not import the extension composition root.

Register synchronously in the consumer's `session_start` handler, with StateFlow loaded first. Pass `ctx.sessionManager` only as the native-host identity key, not raw runtime context. Host absence, competing ownership of the same manager, duplicate IDs and incompatible API versions fail explicitly. Two different SDK managers in one process have independent catalogs. A retained native identity check also fences manager reuse for another session/address.

```ts
import { registerStateFlowModule, type StateFlowModule } from "@llblab/pi-state-flow/modules";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Notes = { entries: string[] };
const notes: StateFlowModule<Notes> = {
  immutable: false,
  id: "x_acme_notes",
  apiVersion: 1,
  schemaVersion: 1,
  validate(value): value is Notes {
    return typeof value === "object" && value !== null && !Array.isArray(value)
      && "entries" in value && Array.isArray(value.entries)
      && value.entries.every(item => typeof item === "string");
  },
  context(content) { return content ? [{ kind: "data", value: content }] : []; },
};

export default function (pi: ExtensionAPI) {
  let unregister: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    unregister?.();
    unregister = registerStateFlowModule(ctx.sessionManager, notes);
  });
  pi.on("session_shutdown", () => unregister?.());
}
```

With this companion registered, a sole participating owner can persist `{"x_acme_notes":{"entries":["accepted"]}}` through `patch_state` and read `x_acme_notes` through `read_state`. Multiple participating owners retain explicit scope wrappers. The context callback executes on admitted Active/Passive provider contexts; its data is transported as fallible user-level data, not system instructions. Pi 1.0.0 uses `session_shutdown`, not `shutdown`.

Registration returns an idempotent disposer for that exact instance. It cannot revoke a later equal-ID registration or another host generation. Catalog changes abort old catalog signals; host retirement removes only its own binding before signaling cancellation. Snapshots capture immutable policy, callback identities and definition order. Constructor-injected services remain bound to their original instance. Trusted callbacks are not an effects sandbox, and a catalog snapshot alone is not publication authority.

## Definition and admitted-input contract

The public `StateFlowModule<Content, Input>` has the internal identity/immutability/validation/context/optional-production semantics, plus these necessary public bindings:

- **`apiVersion: 1`:** Version of callback/frame assumptions, independently of the runtime package resolved by an older companion's import.
- **`schemaVersion`:** Positive safe integer for one exact persisted content/policy contract; not the package or host metadata version.
- **`captureInput?(source, signal)`:** Optional synchronous or asynchronous acquisition of module-specific JSON input, returning `{ value, assertCurrent }`. It runs outside exclusion; the synchronous receipt throws if that captured source is obsolete and never reacquires data or performs asynchronous work under exclusion.
- **`context(content, frame)`:** Synchronous contribution computation; an asynchronous return is not admitted. Contributions are user-level data or admitted native conversation indices, never arbitrary system-prompt text.
- **`produce?(content, frame, signal)`:** Optional synchronous or asynchronous complete-replacement proposal, invoked only by an owned Active preparation. It is not a publisher or independent scheduler. Abort/currentness fences abandon stale asynchronous work even if the callback ignores its signal; trusted synchronous JavaScript is not preempted or sandboxed.

External durable content is initially a JSON object. Validators admit complete resulting values, not recursive partial patches. `immutable` denies main-agent writes, not authorized producer proposals. `produce?` returns a complete replacement object or `undefined`; it never publishes itself. Constructor-injected narrow services avoid a generic capability registry or raw `ctx`.

Activation must pass a detached `StateFlowModuleFrame` to both context and production: Active/Passive mode, exact admitted owner scope, conversation, optional current prompt and captured input. Shared-owner frames must have neither Session conversation nor prompt. The input acquisition/producer phase runs outside storage exclusion; acceptance must revalidate its original source, content, model, native/selection and registration basis in the existing single engine. The local host now captures inputs and invokes context outside storage exclusion for available owners in both Active and Passive. Off, unavailable private owners and incompatible descriptors invoke no callbacks. Input receipts must synchronously throw or return void; boolean predicates, asynchronous assertions and missing receipts reject. Captured values, callback content and frames are detached; currentness is checked before/after evaluation and again at the native post-context/provider checkpoint. Source/catalog/cancellation/model/native/selected/cache changes abort the current inference, without rolling back already accepted lifecycle work or writing module content. Active preparation captures each available module's input once for production and its first context, computes proposals outside exclusion, then coalesces them with core maintenance/run fields into one existing staging/compiler/publication cohort. Later native tool-loop turns may recapture context but do not rerun the owned preparation's producers. Passive exposes context/tools without automatic production. No background scheduler or plugin reaction loop is introduced.

Context proposals are data or exact source-message indices, not system instructions or arbitrary context mutation. Session conversation contains only the completed native segment before a uniquely anchored current user run; ambiguity withholds that segment. Shared frames carry no dialogue/prompt and cannot propose conversation replacement. At most one Session module may select completed conversation; competing selectors fail closed. A selection must preserve whole native tool-call/result units and original identities/order. The host preserves current-run and foreign frames, removes duplicate completed messages, and only alters provider context, never the native journal. Data-only contributions do not themselves remove history. Scope order then captured module order determines data placement before native conversation, after the owned core head. Off invokes none of these callbacks; metadata registration itself neither acquires nor writes memory.

## Historical local acceptance

Before 0.27.0 publication, ordinary public-only SDK consumers exercised mutable/immutable current-only forks from older native points, unchanged parent semantic-file bytes, retained descriptors, a fresh child aligned origin and child reload. Pre-origin materialized reads reject; this does not claim that retained per-owner tail bytes are absent from child storage. Global/CWD/Session/all-three fixtures at history limits 0/1/7 crossed actual folding, retained every still-available current/historical opaque value through missing or incompatible definitions, refused incompatible callbacks/writes and resumed after cold re-registration.

That local checkpoint recorded **1695/1695 on Node 22/24**, **145 package files**, the same two final compiled SDK properties, earlier 16 public and seven codec properties; sets overlap and are not summed. Registration/lifetime and codec retention had their separately bounded independent approvals; activation and final audit were inline. The earlier global **REQUESTCHANGES** verdict was not retroactively upgraded by scoped remediation or publication. The [exact pre-release record](https://github.com/llblab/pi-state-flow/blob/f9128d9eaa2b94133d992f51f80f16aec0d43653/BACKLOG.md#12-ordered-implementation-backlog) retains original counts, review boundaries and superseded execution instructions. These are historical results, not fresh 0.27.2 tests, installed-client certification or model-quality evidence.

## Recorded compatibility decision

The external-plane path uses owner metadata **version 4**, retaining the same checkpoint, patch-tail and metadata files. The recorded decision preceded codec implementation; that implementation shipped in 0.27.0. Descriptors and opaque external values use the existing codec/replay/publication path; absent stream descriptors retain legacy three-key streams and v3 output. Historical integrated SOURCE/build/package and compiled-property checks passed on both supported Nodes; independent retention and acceptance reviews approved that storage slice with disclosed coverage limits. The new manual tool path adds a descriptor only with the first nonempty accepted content transition through the same selected publisher; registration, empty proposals and context-only observation cannot mint a slot. Validators receive a detached complete result, not a partial patch, and must be pure synchronous content guards (no acquisition/inference). Definition/schema/policy mismatches reject model writes before validators. Exact reads and patch history use retained descriptors without calling definitions. Current catalog revocation fences queued old calls, including equal-ID re-registration. Input and context callbacks are activated as described above; Active producer publication is now activated through the same engine. Results are complete JSON-object replacements, never recursive merges; `undefined` is no proposal and `{}` clears content without removing its descriptor or fabricating a new slot. Main-agent immutable restrictions remain intact. All applicable producer jobs compute outside exclusion using narrow constructor-injected services, not ambient runtime/storage/model tools. Before publication, the host rechecks original input, content/descriptor, captured source-scope stream, registration generation, native owner/model/selection and cancellation; model or thinking-level changes revoke the original request even after A→B→A. A fresh transaction cannot launder stale work. One invalid/stale result rejects the proposed cohort. After its own accepted publication, context receives the accepted content using the original input receipt and a lease pinned to that exact acceptance. Late cancellation/context/checkpoint failure never rolls accepted memory back.

- **Identity:** External roots match `x_[a-z][a-z0-9_]*`; use package-derived names. IDs do not authenticate package ownership. Existing built-ins and retired-root reservations remain distinct.
- **Retained descriptors:** Owner metadata maps each written external root to `{ schemaVersion, immutable }`. Persist the descriptor in the same accepted cohort as its first write and retain it through deletion, folding and fork. Do not recycle a root for unrelated semantics.
- **No new content envelope:** External objects remain semantic roots, not `{ immutable, content }` wrappers. Policy/version data remains outside model-patchable state. No mixed schema epochs or automatic module-schema conversion is introduced initially.
- **Available:** A registered new root without a retained descriptor can receive absent content and propose its first accepted value. Once a descriptor exists, execute only when schema version and authoring policy match it exactly. Registration/observation alone never mint a descriptor; complete candidate content must validate before publication.
- **Unavailable:** Missing, disposed or incompatible definitions leave opaque retained data. Exact current/history reads may return raw data; automatic context and model writes are unavailable. Unrelated writes, pruning, folding, reload and fork must preserve current values and every still-retained historical boundary without invoking missing callbacks.
- **Legacy:** Preserve declared v1/v2/v3 meanings and detect raw external-namespace collisions before conversion; formerly ignored roots cannot be silently adopted. Only admitted semantic acceptance may convert complete cohorts through existing backup/byte-CAS safeguards. Inspection and runtime-only policy persistence cannot migrate.
- **Writer limit:** Version refusal is evidence for inspected old writers, not universal deployed-writer protection. Existing quiescence and unsupported-writer requirements remain. No working-store migration, live reload or release is authorized by this decision.

A registry-only implementation cannot satisfy the durable contract: selecting only currently registered names would lose data when the companion is absent. Exact external reads must also bypass lossy context callbacks; widening the six-root filter alone is insufficient.
