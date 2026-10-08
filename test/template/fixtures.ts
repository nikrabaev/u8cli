import type { IndicatorTone, IndicatorValue } from "../../src/ipc/protocol.js";
import type { IndicatorLookup } from "../../src/template/index.js";

export type ValueSpec = string | { value: string; display?: string; tone?: IndicatorTone };

/** Builds a lookup from a `"ns@name"` map; anything absent is an unknown indicator. */
export function lookupOf(values: Record<string, ValueSpec>): IndicatorLookup {
  return (ns, name) => {
    const spec = values[`${ns}@${name}`];
    if (spec === undefined) return undefined;
    const body = typeof spec === "string" ? { value: spec } : spec;
    return { ns, name, scope: "app", owner: "gateway", ...body } satisfies IndicatorValue;
  };
}

/** Lookup that knows nothing — every token renders as an unknown marker. */
export const emptyLookup: IndicatorLookup = () => undefined;
