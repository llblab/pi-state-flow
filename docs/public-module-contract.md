# Public semantic modules

## Status

Candidate public API v1. Native-host registration and retirement have local supported-Node validation and bounded independent acceptance; **Metadata4 codec/opaque retention has bounded independent acceptance. The local candidate now binds registered mutable external roots to the existing read/patch tools and atomic descriptor admission; this new activation slice is not independently accepted. Public input/context execution is now implemented in the local candidate; Active asynchronous producers now propose complete replacements through that same selected publisher. Local end-to-end acceptance is complete: the ordinary public-only consumer also proves current-only forks and opaque current/history retention through folding, incompatible or absent definitions, reload and re-registration, in SOURCE and the built SDK/package entry. Per the later user instruction, activation implementation and final audit were performed inline without actors; no new independent activation approval or real-model quality result is claimed.** [BACKLOG](../BACKLOG.md#12-ordered-implementation-backlog) alone owns unfinished implementation and acceptance. This is an unpublished local candidate, not a released compatibility promise.

Pi loads ordinary companion extensions. StateFlow provides a thin public registration membrane; it does not discover or load plugin code. The [internal evaluators](semantic-module-contract.md) remain separate from native/source admission and atomic publication.

## Public entry and lifecycle

Import `registerStateFlowModule` and its types from `@llblab/pi-state-flow/modules`. Local source consumers may import `api/modules.ts`; compiled consumers use `dist/api/modules.js`. These membranes do not import the extension composition root.

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

With this companion registered, a sole participating owner can persist `{"x_acme_notes":{"entries":["accepted"]}}` through `patch_state` and read `x_acme_notes` through `read_state`. Multiple participating owners retain explicit scope wrappers. The context callback now executes on admitted Active/Passive provider contexts; its data is transported as fallible user-level data, not system instructions. Pi 1.0.0 uses `session_shutdown`, not `shutdown`.

Registration returns an idempotent disposer for that exact instance. It cannot revoke a later equal-ID registration or another host generation. Catalog changes abort old catalog signals; host retirement removes only its own binding before signaling cancellation. Snapshots capture immutable policy, callback identities and definition order. Constructor-injected services remain bound to their original instance. Trusted callbacks are not an effects sandbox, and a catalog snapshot alone is not publication authority.

## Definition and admitted-input contract

The public `StateFlowModule<Content, Input>` has the internal identity/immutability/validation/context/optional-production semantics, plus these necessary public bindings:

- **`apiVersion: 1`:** Version of callback/frame assumptions, independently of the runtime package resolved by an older companion's import.
- **`schemaVersion`:** Positive safe integer for one exact persisted content/policy contract; not the package or host metadata version.
- **`captureInput?`:** Acquire module-specific JSON input and return `{ value, assertCurrent }`. The synchronous assertion throws if that captured source is obsolete; it does not reacquire data or perform asynchronous work under exclusion.

External durable content is initially a JSON object. Validators admit complete resulting values, not recursive partial patches. `immutable` denies main-agent writes, not authorized producer proposals. `produce?` returns a complete replacement object or `undefined`; it never publishes itself. Constructor-injected narrow services avoid a generic capability registry or raw `ctx`.

Activation must pass a detached `StateFlowModuleFrame` to both context and production: Active/Passive mode, exact admitted owner scope, conversation, optional current prompt and captured input. Shared-owner frames must have neither Session conversation nor prompt. The input acquisition/producer phase runs outside storage exclusion; acceptance must revalidate its original source, content, model, native/selection and registration basis in the existing single engine. The local host now captures inputs and invokes context outside storage exclusion for available owners in both Active and Passive. Off, unavailable private owners and incompatible descriptors invoke no callbacks. Input receipts must synchronously throw or return void; boolean predicates, asynchronous assertions and missing receipts reject. Captured values, callback content and frames are detached; currentness is checked before/after evaluation and again at the native post-context/provider checkpoint. Source/catalog/cancellation/model/native/selected/cache changes abort the current inference, without rolling back already accepted lifecycle work or writing module content. Active preparation captures each available module's input once for production and its first context, computes proposals outside exclusion, then coalesces them with core maintenance/run fields into one existing staging/compiler/publication cohort. Later native tool-loop turns may recapture context but do not rerun the owned preparation's producers. Passive exposes context/tools without automatic production. No background scheduler or plugin reaction loop is introduced.

Context proposals are data or exact source-message indices, not system instructions or arbitrary context mutation. Session conversation contains only the completed native segment before a uniquely anchored current user run; ambiguity withholds that segment. Shared frames carry no dialogue/prompt and cannot propose conversation replacement. At most one Session module may select completed conversation; competing selectors fail closed. A selection must preserve whole native tool-call/result units and original identities/order. The host preserves current-run and foreign frames, removes duplicate completed messages, and only alters provider context, never the native journal. Data-only contributions do not themselves remove history. Scope order then captured module order determines data placement before native conversation, after the owned core head. Off invokes none of these callbacks; metadata registration itself neither acquires nor writes memory.

## Recorded compatibility decision

The external-plane path will use owner metadata **version 4**, retaining the same checkpoint, patch-tail and metadata files. This decision preceded codec implementation. The local candidate now admits descriptors and opaque external values through the existing codec/replay/publication path; absent stream descriptors retain legacy three-key streams and v3 output. Integrated SOURCE/build/package and complete compiled-property checks pass on both supported Nodes; independent retention and acceptance reviews approved this storage slice with disclosed coverage limits. The new manual tool path adds a descriptor only with the first nonempty accepted content transition through the same selected publisher; registration, empty proposals and context-only observation cannot mint a slot. Validators receive a detached complete result, not a partial patch, and must be pure synchronous content guards (no acquisition/inference). Definition/schema/policy mismatches reject model writes before validators. Exact reads and patch history use retained descriptors without calling definitions. Current catalog revocation fences queued old calls, including equal-ID re-registration. Input and context callbacks are activated as described above; Active producer publication is now activated through the same engine. Results are complete JSON-object replacements, never recursive merges; `undefined` is no proposal and `{}` clears content without removing its descriptor or fabricating a new slot. Main-agent immutable restrictions remain intact. All applicable producer jobs compute outside exclusion using narrow constructor-injected services, not ambient runtime/storage/model tools. Before publication, the host rechecks original input, content/descriptor, captured source-scope stream, registration generation, native owner/model/selection and cancellation; model or thinking-level changes revoke the original request even after A→B→A. A fresh transaction cannot launder stale work. One invalid/stale result rejects the proposed cohort. After its own accepted publication, context receives the accepted content using the original input receipt and a lease pinned to that exact acceptance. Late cancellation/context/checkpoint failure never rolls accepted memory back.

- **Identity:** External roots match `x_[a-z][a-z0-9_]*`; use package-derived names. IDs do not authenticate package ownership. Existing built-ins and retired-root reservations remain distinct.
- **Retained descriptors:** Owner metadata maps each written external root to `{ schemaVersion, immutable }`. Persist the descriptor in the same accepted cohort as its first write and retain it through deletion, folding and fork. Do not recycle a root for unrelated semantics.
- **No new content envelope:** External objects remain semantic roots, not `{ immutable, content }` wrappers. Policy/version data remains outside model-patchable state. No mixed schema epochs or automatic module-schema conversion is introduced initially.
- **Available:** Execute a registered definition only when its exact schema version and authoring policy match the retained descriptor. Validate complete candidate content before publication.
- **Unavailable:** Missing, disposed or incompatible definitions leave opaque retained data. Exact current/history reads may return raw data; automatic context and model writes are unavailable. Unrelated writes, pruning, folding, reload and fork must preserve current values and every still-retained historical boundary without invoking missing callbacks.
- **Legacy:** Preserve declared v1/v2/v3 meanings and detect raw external-namespace collisions before conversion; formerly ignored roots cannot be silently adopted. Only admitted semantic acceptance may convert complete cohorts through existing backup/byte-CAS safeguards. Inspection and runtime-only policy persistence cannot migrate.
- **Writer limit:** Version refusal is evidence for inspected old writers, not universal deployed-writer protection. Existing quiescence and unsupported-writer requirements remain. No working-store migration, live reload or release is authorized by this decision.

A registry-only implementation cannot satisfy the durable contract: selecting only currently registered names would lose data when the companion is absent. Exact external reads must also bypass lossy context callbacks; widening the six-root filter alone is insufficient.
