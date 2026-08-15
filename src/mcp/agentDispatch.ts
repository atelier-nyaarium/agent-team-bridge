// The only seam that knows whether a call is served by the gateway or a local child.

export type AgentDispatch = (body: Record<string, unknown>) => Promise<unknown>;
