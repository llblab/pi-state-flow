// SDK/schema experiment only: not State Flow argument normalization or canonical publication authority.
import { Type } from "@earendil-works/pi-ai";

export const PROBE_PLANES = ["intents", "strategy", "tactics", "artifacts", "lazy"] as const;
export const PROBE_OWNERS = ["global", "cwd", "session"] as const;
const plane = () => Type.Record(Type.String(), Type.Unknown());
const planes = () => Object.fromEntries(PROBE_PLANES.map(name => [name, Type.Optional(plane())]));
export const FLAT_PROBE_SCHEMA = Type.Object(planes(), { additionalProperties: false, minProperties: 1 });
export const SCOPED_PROBE_SCHEMA = Type.Object(Object.fromEntries(PROBE_OWNERS.map(name => [name, Type.Optional(FLAT_PROBE_SCHEMA)])), { additionalProperties: false, minProperties: 1 });
// Root properties retain an ordinary object vocabulary even on serializers that discard combinators.
export const STABLE_PROBE_SCHEMA = Type.Object({ ...FLAT_PROBE_SCHEMA.properties, ...SCOPED_PROBE_SCHEMA.properties }, {
	additionalProperties: false,
	minProperties: 1,
	oneOf: [
		{ anyOf: PROBE_PLANES.map(name => ({ required: [name] })) },
		{ anyOf: PROBE_OWNERS.map(name => ({ required: [name] })) },
	],
});
export const UNION_PROBE_SCHEMA = Type.Union([FLAT_PROBE_SCHEMA, SCOPED_PROBE_SCHEMA], { type: "object" });
export const PROBE_SCHEMAS = { stable: STABLE_PROBE_SCHEMA, union: UNION_PROBE_SCHEMA, flat: FLAT_PROBE_SCHEMA, scoped: SCOPED_PROBE_SCHEMA };
