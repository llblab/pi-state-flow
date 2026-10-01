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
/** Main-menu section label shows only the current session mode. */
export function formatStateFlowSectionLabel(snapshot) {
    return `🌀 State Flow: ${snapshot.mode}`;
}
export const STATE_FLOW_MODES = ["off", "passive", "active"];
const STATE_FLOW_MODE_LABELS = { off: "Off", passive: "Passive", active: "Active" };
const STATE_FLOW_SELECTED_MARKERS = { off: "🟡", passive: "🟣", active: "🟢" };
function isStateFlowModeAction(value) {
    return STATE_FLOW_MODES.includes(value);
}
function modeReceiptNotice(mode, result) {
    if (result.ok && (result.message === `State Flow ${mode}` || result.message === `State Flow is already ${mode}`))
        return undefined;
    return result.message;
}
/** One radio-style mode row followed directly by read-only scope actions. */
export function buildStateFlowSectionView(snapshot, callbackData) {
    const modes = STATE_FLOW_MODES.map((mode) => ({
        text: `${mode === snapshot.mode ? STATE_FLOW_SELECTED_MARKERS[mode] : "⚫️"} ${STATE_FLOW_MODE_LABELS[mode]}`,
        callback_data: callbackData(mode),
    }));
    return {
        text: [
            `<b>🌀 State Flow:</b> <code>${snapshot.mode}</code>`,
            "",
            "<b>Mode</b> — choose a workflow (switching modes never erases stored memory):",
            "",
            "<code>-</code> <code>off</code> (default): regular chat without State Flow memory tools or context.",
            "<code>-</code> <code>passive</code>: regular chat with memory tools; available combined memory enters the agent's context.",
            "<code>-</code> <code>active</code>: same memory access; each completed answer closes a cycle, and the next request starts from saved state, not the full chat.",
            "",
            "<b>Inspect memory</b> — view stored state even in Off:",
            "",
            "<code>-</code> <code>global</code>: memory shared across projects and sessions.",
            "<code>-</code> <code>cwd</code>: memory shared by sessions in this directory.",
            "<code>-</code> <code>session</code>: private memory for this session, kept on resume.",
            "<code>-</code> <code>effective</code>: merged Global, CWD and Session state; the agent can use it when memory is enabled and available.",
        ].join("\n"),
        parseMode: "html",
        replyMarkup: { inline_keyboard: [
                modes,
                ...[["global", "cwd"], ["session", "effective"]].map((row) => row.map((scope) => ({
                    text: STATE_FLOW_SCOPE_LABELS[scope], callback_data: callbackData("inspect", scope),
                }))),
            ] },
    };
}
const STATE_FLOW_SCOPE_LABELS = {
    global: "🌐 Global",
    cwd: "📂 CWD",
    session: "💬 Session",
    effective: "🧬 Effective",
};
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
            ...fields.filter((field) => state[field] !== undefined && state[field] !== "").map((field) => ({
                type: "details",
                summary: { type: "code", text: field },
                blocks: [{ type: "pre", language: "json", text: renderStateFlowTelegramField(state[field]) }],
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
        render: (ctx) => buildStateFlowSectionView(port.snapshot(), (action, payload) => ctx.callbackData(action, payload)),
        handleCallback: async (ctx) => {
            // Keyboards sent by earlier versions re-render (start/stop/refresh) or withdraw deferral (cancel); they change no mode.
            const legacy = ctx.action === "start" || ctx.action === "stop" || ctx.action === "cancel" || ctx.action === "refresh";
            if (!isStateFlowModeAction(ctx.action) && !legacy && ctx.action !== "show-state" && ctx.action !== "inspect" && ctx.action !== "back")
                return "pass";
            const request = ++interaction;
            let notice;
            let acknowledged = false;
            try {
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
                const mode = isStateFlowModeAction(ctx.action) && (ctx.action !== "active" || port.canStartNow()) ? ctx.action : undefined;
                if (mode) {
                    if ("inspect" in port) {
                        acknowledged = true;
                        // Apply the control immediately and acknowledge in parallel; neither promise can reject unobserved.
                        const [, result] = await Promise.all([
                            ctx.answerCallback(`Switching State Flow to ${mode}`),
                            Promise.resolve().then(() => port.select(mode)),
                        ]);
                        if (result.signal?.aborted)
                            return "handled";
                        notice = modeReceiptNotice(mode, result);
                    }
                    else
                        notice = modeReceiptNotice(mode, port.select(mode));
                }
                else if (ctx.action === "active") {
                    port.deferStart();
                    notice = "State Flow will become active after the current turn";
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
            const view = buildStateFlowSectionView(port.snapshot(), (action, payload) => ctx.callbackData(action, payload));
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
