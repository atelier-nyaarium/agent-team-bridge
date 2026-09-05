// Copilot delegation: the Copilot-named surface over the neutral execution-target module.

import type { z } from "zod";
import { AgentExecutionTargetSchema, AgentResolvedTargetSchema } from "./agent-execution-target.js";

export const CopilotExecutionTargetSchema = AgentExecutionTargetSchema;
export const CopilotResolvedTargetSchema = AgentResolvedTargetSchema;

export type CopilotExecutionTarget = z.infer<typeof CopilotExecutionTargetSchema>;
export type CopilotResolvedTarget = z.infer<typeof CopilotResolvedTargetSchema>;
