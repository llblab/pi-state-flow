import { isObject, type JsonObject } from "./json.ts";

/** The only materialized memory shape persisted between State Flow runs. */
export interface StateDocument extends JsonObject {
	contract: JsonObject;
	working: JsonObject;
	response: string;
}

export function emptyState(): StateDocument {
	return { contract: {}, working: {}, response: "" };
}

export function isStateDocument(value: unknown): value is StateDocument {
	return isObject(value)
		&& isObject(value.contract)
		&& isObject(value.working)
		&& typeof value.response === "string"
		&& Object.keys(value).every((key) => key === "contract" || key === "working" || key === "response");
}
