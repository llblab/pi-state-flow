import type { Snapshot } from "./snapshot.ts";

export const STATUS_KEY = "state-flow";

export type Colorize = (color: "accent" | "dim", text: string) => string;

export function compactStatus(snapshot: Snapshot, colorize: Colorize): string | undefined {
	if (!snapshot.enabled) return undefined;
	return `${colorize("accent", "state-flow")} ${colorize("dim", `#${snapshot.step}`)}`;
}

export function detailedStatus(snapshot: Snapshot): string {
	const stateJson = JSON.stringify(snapshot.state, null, 2);
	const stateBytes = Buffer.byteLength(stateJson, "utf8");
	return `State Flow ${snapshot.enabled ? "enabled" : "disabled"}; iteration #${snapshot.step}; state ${stateBytes} bytes; validation attempts ${snapshot.validation?.attempt ?? 0}.\n\n${stateJson}`;
}
