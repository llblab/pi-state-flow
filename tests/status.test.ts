import assert from "node:assert/strict";
import test from "node:test";
import { compactStatus, detailedStatus, STATUS_KEY } from "../lib/status.ts";
import { emptyState } from "../lib/state.ts";

const snapshot = {
	enabled: true,
	state: { ...emptyState(), response: "Done" },
	step: 7,
};

test("uses one stable status ownership key", () => {
	assert.equal(STATUS_KEY, "state-flow");
});

test("renders compact status only while enabled", () => {
	const colorize = (color: "accent" | "dim", text: string) => `<${color}>${text}</${color}>`;
	assert.equal(compactStatus(snapshot, colorize), "<accent>state-flow</accent> <dim>#7</dim>");
	assert.equal(compactStatus({ ...snapshot, enabled: false }, colorize), undefined);
});

test("reports metadata and complete materialized state", () => {
	const output = detailedStatus(snapshot);
	assert.match(output, /^State Flow enabled; iteration #7; state \d+ bytes; validation attempts 0\.\n\n\{/);
	assert.match(output, /"response": "Done"/);
});
