import { applyPatch, containsNull, isJsonValue, isObject, type JsonObject } from "./json.ts";
import { emptyState, isStateDocument, type StateDocument } from "./state.ts";
import { MAX_VALIDATION_RETRIES, type ValidationFeedback } from "./validation.ts";

const MAX_RESTORED_STEP = Number.MAX_SAFE_INTEGER - 1;

export interface Snapshot {
	enabled: boolean;
	specification?: string;
	state: StateDocument;
	step: number;
	validation?: ValidationFeedback;
	bootstrap?: boolean;
}

function isLegacyTwoPartState(value: unknown): value is { contract: JsonObject; working: JsonObject } {
	return isObject(value)
		&& isObject(value.contract)
		&& isObject(value.working)
		&& Object.keys(value).every((key) => key === "contract" || key === "working");
}

function restoredStep(value: unknown): number {
	return typeof value === "number"
		&& Number.isSafeInteger(value)
		&& value >= 0
		&& value <= MAX_RESTORED_STEP
		? value
		: 0;
}

function restoredValidation(value: unknown): ValidationFeedback | undefined {
	if (!isObject(value)
		|| !Number.isSafeInteger(value.attempt as number)
		|| (value.attempt as number) < 0
		|| (value.attempt as number) > MAX_VALIDATION_RETRIES
		|| typeof value.error !== "string"
		|| typeof value.instruction !== "string") return undefined;
	return {
		attempt: value.attempt as number,
		error: value.error,
		instruction: value.instruction,
	};
}

export function migrationFailure(data: JsonObject, error: string): Snapshot {
	return {
		enabled: false,
		specification: typeof data.specification === "string" ? data.specification : undefined,
		state: emptyState(),
		step: restoredStep(data.step),
		validation: {
			attempt: 0,
			error,
			instruction: "Start a fresh State Flow episode; null is reserved for patch deletion.",
		},
	};
}

export function migrateSnapshot(value: unknown): Snapshot {
	if (!isObject(value)) return { enabled: false, state: emptyState(), step: 0 };
	const base = {
		enabled: value.enabled === true,
		specification: typeof value.specification === "string" ? value.specification : undefined,
		step: restoredStep(value.step),
		validation: restoredValidation(value.validation),
		bootstrap: value.bootstrap === true,
	};
	if (isStateDocument(value.state)) {
		if (!isJsonValue(value.state)) return migrationFailure(value, "Restored state contains non-JSON data");
		if (containsNull(value.state)) return migrationFailure(value, "Restored state contains null data");
		return { ...base, state: structuredClone(value.state) };
	}
	if (isLegacyTwoPartState(value.state)) {
		if (!isJsonValue(value.state)) return migrationFailure(value, "Restored state contains non-JSON data");
		if (containsNull(value.state)) return migrationFailure(value, "Restored state contains null data");
		return {
			...base,
			state: {
				contract: structuredClone(value.state.contract),
				working: structuredClone(value.state.working),
				response: "",
			},
		};
	}
	if (isObject(value.state)
		&& (Object.hasOwn(value.state, "response")
			|| (Object.hasOwn(value.state, "contract") && Object.hasOwn(value.state, "working")))) {
		return migrationFailure(value, "Restored state has an invalid materialized-state schema");
	}
	const legacyBasis = isObject(value.stateBasis)
		? value.stateBasis
		: isObject(value.state)
			? value.state
			: {};
	const legacyPatch = isObject(value.previousStatePatch) ? value.previousStatePatch : undefined;
	if (!isJsonValue(legacyBasis) || (legacyPatch !== undefined && !isJsonValue(legacyPatch))) {
		return migrationFailure(value, "Legacy state contains non-JSON data");
	}
	const legacyState = legacyPatch === undefined ? legacyBasis : applyPatch(legacyBasis, legacyPatch);
	if (containsNull(legacyState)) return migrationFailure(value, "Legacy state contains null data");
	return { ...base, state: { contract: {}, working: structuredClone(legacyState), response: "" } };
}
