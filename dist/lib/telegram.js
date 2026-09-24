// Domain: optional pi-telegram presentation adapter for the State Flow main-menu section.
//
// This is a leaf adapter. Core semantics, storage, and inference never depend on it; when
// pi-telegram is absent or its registry is not ready, registration fails open and retries.
var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
import { conciseDiagnostic, diagnosticText } from "./protocol.js";
import { formatScopeRevisionVector } from "./status.js";
export const STATE_FLOW_TELEGRAM_ID = "@llblab/pi-state-flow";
/** Resolve the package export or the compiled sibling-extension layout used in local development. */
export function stateFlowTelegramSectionSpecifiers(moduleUrl = import.meta.url) {
    return [
        "@llblab/pi-telegram/sections",
        new URL("../../../pi-telegram/dist/api/sections.js", moduleUrl).href,
    ];
}
/** Main-menu section label doubles as the live status value: the spiral identity is constant, the value is not. */
export function formatStateFlowSectionLabel(snapshot) {
    if (!snapshot.enabled)
        return "🌀 State Flow: off";
    return `🌀 State Flow: ${snapshot.revisions ? formatScopeRevisionVector(snapshot.revisions) : `#${snapshot.step}`}`;
}
/** Shared live value: plain in the button label, monospaced in the submenu state line. */
function stateFlowLabelValue(snapshot) {
    if (!snapshot.enabled)
        return "off";
    return snapshot.revisions ? formatScopeRevisionVector(snapshot.revisions) : `#${snapshot.step}`;
}
/** Submenu state line: the same identity as the button label, with the live value in monospace. */
function formatStateFlowSectionHeader(snapshot) {
    return `<b>🌀 State Flow: <code>${stateFlowLabelValue(snapshot)}</code></b>`;
}
/** Short help under the state line: what State Flow is and why its action button exists. */
const STATE_FLOW_SECTION_HELP = "Accepted memory remains visible in active and passive modes. Start or Stop changes episode behavior, not state access.";
/** The submenu header repeats the button's state line; the single action matches the current state. */
export function buildStateFlowSectionView(snapshot, callbackData) {
    const action = snapshot.enabled
        ? { text: "⏹ Stop", callback_data: callbackData("stop") }
        : { text: "▶️ Start", callback_data: callbackData("start") };
    return {
        text: [formatStateFlowSectionHeader(snapshot), "", STATE_FLOW_SECTION_HELP].join("\n"),
        parseMode: "html",
        replyMarkup: { inline_keyboard: [
                [action],
                [{ text: "👁 Show state", callback_data: callbackData("show-state") }],
            ] },
    };
}
const STATE_FLOW_SCOPE_LABELS = {
    global: "🌐 Global",
    cwd: "📂 CWD",
    session: "💬 Session",
    effective: "🧬 Effective",
};
export function buildStateFlowScopeChooser(callbackData) {
    return {
        text: "<b>👁 Show state:</b>",
        parseMode: "html",
        replyMarkup: { inline_keyboard: [
                ...["global", "cwd", "session", "effective"].map((scope) => [
                    { text: STATE_FLOW_SCOPE_LABELS[scope], callback_data: callbackData("inspect", scope) },
                ]),
            ] },
    };
}
// The complete message serializes each preformatted field one additional time;
// 3,000 leaves safe headroom for worst-case JSON escaping across all four fields.
const STATE_FLOW_TELEGRAM_FIELD_MAX_CHARS = 3_000;
function renderStateFlowTelegramField(value) {
    const json = JSON.stringify(value, null, 2);
    if (json.length <= STATE_FLOW_TELEGRAM_FIELD_MAX_CHARS)
        return json;
    let low = 0;
    let high = json.length;
    let rendered = "";
    while (low <= high) {
        const length = Math.floor((low + high) / 2);
        const candidate = JSON.stringify({
            truncated: true,
            ...(value !== null && typeof value === "object" && !Array.isArray(value)
                ? { keys: Object.keys(value) }
                : {}),
            preview: json.slice(0, length),
            omittedChars: json.length - length,
        }, null, 2);
        if (candidate.length <= STATE_FLOW_TELEGRAM_FIELD_MAX_CHARS) {
            rendered = candidate;
            low = length + 1;
        }
        else {
            high = length - 1;
        }
    }
    return rendered;
}
export function renderStateFlowRichState(scope, revisions, state) {
    const fields = scope === "global" || scope === "cwd"
        ? ["intents", "contract", "working", "artifacts", "lazy"]
        : ["intents", "contract", "working", "artifacts", "response", "lazy"];
    const revision = scope === "effective"
        ? formatScopeRevisionVector(revisions)
        : `#${revisions[scope]}`;
    return {
        blocks: [
            {
                type: "heading",
                text: [`${STATE_FLOW_SCOPE_LABELS[scope]}: `, { type: "code", text: revision }],
                size: 3,
            },
            ...fields.map((field) => ({
                type: "details",
                summary: { type: "code", text: field },
                blocks: [{ type: "pre", language: "json", text: renderStateFlowTelegramField(state[field] ?? {}) }],
            })),
        ],
        skip_entity_detection: true,
    };
}
function isStateFlowTelegramScope(value) {
    return value === "global" || value === "cwd" || value === "session" || value === "effective";
}
function buildStateFlowTelegramSection(port, isActive) {
    let interaction = 0;
    return {
        id: STATE_FLOW_TELEGRAM_ID,
        label: "🌀 State Flow",
        getLabel: () => formatStateFlowSectionLabel(port.snapshot()),
        render: (ctx) => buildStateFlowSectionView(port.snapshot(), (action) => ctx.callbackData(action)),
        handleCallback: async (ctx) => {
            // cancel/refresh remain routable for keyboards sent by earlier versions.
            if (ctx.action !== "start" && ctx.action !== "stop" && ctx.action !== "cancel" && ctx.action !== "refresh" && ctx.action !== "show-state" && ctx.action !== "inspect" && ctx.action !== "back")
                return "pass";
            const request = ++interaction;
            let notice;
            let acknowledged = false;
            try {
                if (ctx.action === "show-state") {
                    await ctx.answerCallback();
                    await ctx.edit(buildStateFlowScopeChooser((action, payload) => ctx.callbackData(action, payload)));
                    return "handled";
                }
                if (ctx.action === "inspect") {
                    if (!isStateFlowTelegramScope(ctx.payload))
                        throw new Error("Unknown State Flow scope");
                    let observation;
                    if ("inspect" in port) {
                        await ctx.answerCallback("Reading State Flow memory");
                        acknowledged = true;
                        observation = await port.inspect(ctx.payload);
                    }
                    else {
                        const state = port.state(ctx.payload);
                        const live = port.snapshot();
                        observation = { state, revisions: port.revisions?.() ?? live.revisions ?? { global: live.step, cwd: live.step, session: live.step } };
                    }
                    observation.signal?.throwIfAborted();
                    if (request !== interaction || !isActive())
                        return "handled";
                    await ctx.openRich(renderStateFlowRichState(ctx.payload, observation.revisions, observation.state));
                    if (!acknowledged)
                        await ctx.answerCallback();
                    return "handled";
                }
                const action = ctx.action === "stop" || (ctx.action === "start" && port.canStartNow()) ? ctx.action : undefined;
                if (action) {
                    if ("inspect" in port) {
                        acknowledged = true;
                        // Start the control immediately and acknowledge in parallel; neither promise can reject unobserved.
                        const [, result] = await Promise.all([
                            ctx.answerCallback(action === "stop" ? "Stopping State Flow" : "Starting State Flow"),
                            Promise.resolve().then(() => port[action]()),
                        ]);
                        if (result.signal?.aborted)
                            return "handled";
                        notice = result.message;
                    }
                    else
                        notice = port[action]().message;
                }
                else if (ctx.action === "start") {
                    port.deferStart();
                    notice = "State Flow will start after the current turn";
                }
                else if (ctx.action === "cancel") {
                    port.cancelStart();
                    notice = "Pending start cancelled";
                }
            }
            catch (error) {
                notice = diagnosticText(error);
            }
            if (request !== interaction || !isActive())
                return "handled";
            const summary = notice === undefined ? undefined : conciseDiagnostic(notice, 200);
            const view = buildStateFlowSectionView(port.snapshot(), (action) => ctx.callbackData(action));
            if (acknowledged && summary !== undefined) {
                // Callback queries can expire during storage waits; retain errors in the existing menu instead.
                view.text += `\n\n${summary.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}`;
            }
            else if (!acknowledged)
                await ctx.answerCallback(summary);
            await ctx.edit(view);
            return "handled";
        },
    };
}
async function importTelegramModule(specifiers, guard) {
    for (const specifier of specifiers) {
        try {
            const imported = await import(__rewriteRelativeImportExtension(specifier));
            if (guard(imported))
                return imported;
        }
        catch {
            // pi-telegram is optional; its absence only disables the Telegram surface.
        }
    }
    return undefined;
}
/** Default loader; injectable so tests and embedded hosts can control transport presence. */
export async function loadStateFlowTelegramModules() {
    const sections = await importTelegramModule(stateFlowTelegramSectionSpecifiers(), (module) => typeof module?.registerTelegramSection === "function");
    return { ...(sections === undefined ? {} : { sections }) };
}
export function createStateFlowTelegramAdapter(options) {
    const load = options.load ?? loadStateFlowTelegramModules;
    let generation = 0;
    let sectionRegistered = false;
    let registration;
    const disposers = [];
    const register = async () => {
        const epoch = generation;
        let modules;
        try {
            modules = await load();
        }
        catch {
            return false;
        }
        // A shutdown during loading must not leave a registration behind.
        if (epoch !== generation)
            return false;
        if (!sectionRegistered && modules.sections) {
            try {
                const dispose = modules.sections.registerTelegramSection(buildStateFlowTelegramSection(options.port, () => epoch === generation));
                if (epoch === generation) {
                    disposers.push(dispose);
                    sectionRegistered = true;
                }
                else {
                    dispose();
                }
            }
            catch {
                // Registry not initialized yet; the next ensure retries.
            }
        }
        return sectionRegistered;
    };
    return {
        async ensure() {
            if (sectionRegistered)
                return true;
            registration ??= register().finally(() => {
                registration = undefined;
            });
            return registration;
        },
        dispose() {
            generation += 1;
            for (const dispose of disposers.splice(0)) {
                try {
                    dispose();
                }
                catch {
                    // Disposal is best-effort; pi-telegram owns its registry lifetime.
                }
            }
            sectionRegistered = false;
        },
    };
}
