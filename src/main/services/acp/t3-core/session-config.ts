import type * as EffectAcpSchema from "./compat.ts";

export function flattenSelectChoices(
  options: EffectAcpSchema.SessionConfigSelectOptions,
): ReadonlyArray<EffectAcpSchema.SessionConfigSelectOption> {
  return options.flatMap((candidate) => ("value" in candidate ? [candidate] : candidate.options));
}
