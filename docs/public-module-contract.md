# Public semantic modules

## Status

Public API v1 is available through `@llblab/pi-state-flow/modules`. It includes native-host registration/disposal, metadata v4 descriptors and opaque retention, external-root read/patch tools, captured Active/Passive context, and atomic Active producer replacements. The package export and source types in `api/modules.ts` and `lib/semantic-module.ts` define the executable surface; this document owns its integration and trust contract. See [compatibility](compatibility.md) for verification limits and the [historical evidence index](README.md#historical-semantic-evidence) for original decisions and results.

Pi loads ordinary companion extensions. StateFlow provides a thin public registration membrane; it does not discover or load plugin code. The [internal evaluators](semantic-layers.md#internal-semantic-modules) remain separate from native/source admission and atomic publication.

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

With this companion registered, a sole participating owner can persist `{"x_acme_notes":{"entries":["accepted"]}}` through `state_flow_patch` and read `x_acme_notes` through `state_flow_read`. Multiple participating owners retain explicit scope wrappers. The context callback executes on admitted Active/Passive provider contexts; its data is transported as fallible user-level data, not system instructions. Pi 1.0.0 uses `session_shutdown`, not `shutdown`.

Registration returns an idempotent disposer for that exact instance. It cannot revoke a later equal-ID registration or another host generation. Catalog changes abort old catalog signals; host retirement removes only its own binding before signaling cancellation. Snapshots capture immutable policy, callback identities and definition order. Constructor-injected services remain bound to their original instance. Trusted callbacks are not an effects sandbox, and a catalog snapshot alone is not publication authority.

## Definition and admitted-input contract

The public `StateFlowModule<Content, Input>` has the internal identity/immutability/validation/context/optional-production semantics, plus these necessary public bindings:

- **`apiVersion: 1`:** Version of callback/frame assumptions, independently of the runtime package resolved by an older companion's import.
- **`schemaVersion`:** Positive safe integer for one exact persisted content/policy contract; not the package or host metadata version.
- **`captureInput?(source, signal)`:** Optional synchronous or asynchronous acquisition of module-specific JSON input, returning `{ value, assertCurrent }`. It runs outside exclusion; the synchronous receipt throws if that captured source is obsolete and never reacquires data or performs asynchronous work under exclusion.
- **`context(content, frame)`:** Synchronous contribution computation; an asynchronous return is not admitted. Contributions are user-level data or admitted native conversation indices, never arbitrary system-prompt text.
- **`produce?(content, frame, signal)`:** Optional synchronous or asynchronous complete-replacement proposal, invoked only by an owned Active preparation. It is not a publisher or independent scheduler. Abort/currentness fences abandon stale asynchronous work even if the callback ignores its signal; trusted synchronous JavaScript is not preempted or sandboxed.

External content is a JSON object. Model writes and producer results replace the whole object, not recursively merge it; `undefined` is no producer proposal and `{}` clears content without deleting its descriptor or creating a slot. Validators are pure synchronous guards over the detached complete result, without acquisition or inference. `immutable` denies main-agent writes, not authorized producer proposals. Constructor-injected narrow services avoid a generic capability registry or raw `ctx`.

Both callbacks receive a detached `StateFlowModuleFrame` with mode, exact admitted owner, conversation, optional current prompt and captured input. Input receipts must synchronously return void or throw; missing, boolean and asynchronous receipts reject. Active and Passive capture input and evaluate context outside exclusion for available owners only. Active preparation captures each available input once for production and the first context, computes proposals outside exclusion and stages them with core maintenance and run fields in one accepted cohort. Later tool-loop turns can recapture context but do not rerun those producers. Passive does not produce, and Off does not invoke callbacks.

Before publication, recheck the original input receipt, content/descriptor, scope stream, native owner/selection, model and thinking level, registration generation and cancellation. A model or thinking-level ABA revokes the request, and catalog revocation fences queued work even after equal-ID re-registration. One invalid or stale proposal rejects the cohort; a fresh transaction cannot make the old proposal current. After accepted publication, first context uses the accepted content and original input receipt pinned to that acceptance. Recheck currentness around context evaluation and at the native post-context/provider checkpoint; loss of authority (including cache change) aborts inference without undoing accepted effects.

Context proposals are data or exact source-message indices, not system instructions or arbitrary context mutation. Session conversation contains only the completed native segment before a uniquely anchored current user run; ambiguity withholds that segment. Shared frames carry no dialogue/prompt and cannot propose conversation replacement. At most one Session module may select completed conversation; competing selectors fail closed. A selection must preserve whole native tool-call/result units and original identities/order. The host preserves current-run and foreign frames, removes duplicate completed messages, and only alters provider context, never the native journal. Data-only contributions do not themselves remove history. Scope order then captured module order determines data placement before native conversation, after the owned core head. Off invokes none of these callbacks; metadata registration itself neither acquires nor writes memory.

## Retention and format compatibility

External planes use [scope metadata v4](compatibility.md#canonical-scope-format-admission), with the same checkpoint, patch-tail and metadata files. Descriptors and opaque values use the ordinary codec, replay and selected publication. Raw external-namespace collisions are not silently adopted as external planes.

- **Identity:** External roots match `x_[a-z][a-z0-9_]*`; use package-derived names. IDs do not authenticate package ownership. Existing built-ins and retired-root reservations remain distinct.
- **Retained descriptors:** Owner metadata maps each written external root to `{ schemaVersion, immutable }`. Persist the descriptor with its first nonempty accepted content and retain it through deletion, folding and fork. Registration and observation cannot mint a descriptor. Do not recycle a root for unrelated semantics.
- **Content shape:** External objects are semantic roots, not `{ immutable, content }` wrappers. Policy/version data stays outside model-patchable state. There are no mixed schema epochs or automatic module-schema conversions.
- **Available definition:** A registered new root can receive absent content and propose its first value. With a retained descriptor, schema version and authoring policy must match exactly; mismatches reject model writes before validation.
- **Unavailable definition:** Missing, disposed or incompatible definitions leave opaque values. Exact current reads and still-available historical reads use retained descriptors without invoking definitions. Context, production and model writes for that root are unavailable. Unrelated writes, pruning, folding, reload and fork preserve opaque data without those callbacks; a fork retains its own [current-only history boundary](fork-contract.md).
- **Recovery is independent of the catalog:** A missing definition does not make stored bytes corrupt and cannot authorize reset. See [filesystem recovery](filesystem-recovery.md#self-healing) for stored descriptor damage and the limits of composed history after a reset.
