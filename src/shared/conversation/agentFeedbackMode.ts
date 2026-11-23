import * as Schema from "effect/Schema";

/** `on-request`: agents report only when the user asks. `auto`: they also report on their own. */
export const AgentFeedbackMode = Schema.Literals(["off", "on-request", "auto"]);
export type AgentFeedbackMode = typeof AgentFeedbackMode.Type;
