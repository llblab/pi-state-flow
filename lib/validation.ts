import { terminalRegenerationInstruction } from "./terminal.ts";

export const MAX_VALIDATION_RETRIES = 3;

export interface ValidationFeedback {
	attempt: number;
	error: string;
	instruction: string;
}

export type ValidationDecision =
	| { kind: "retry"; feedback: ValidationFeedback }
	| { kind: "exhausted"; error: string };

/** Decide retry progression without mutating persistent runtime state. */
export function nextValidation(previous: ValidationFeedback | undefined, error: string): ValidationDecision {
	const attempt = (previous?.attempt ?? 0) + 1;
	if (attempt > MAX_VALIDATION_RETRIES) return { kind: "exhausted", error };
	return {
		kind: "retry",
		feedback: {
			attempt,
			error,
			instruction: terminalRegenerationInstruction(error),
		},
	};
}
