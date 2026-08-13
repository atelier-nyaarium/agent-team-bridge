// Where an agent tool call is served. The gateway dispatch is the coordinated path; a local one runs
// the backend child in this process. Both answer the same validated shapes, so this seam is the only
// place in the tool layer that knows which of the two exists.

export type AgentDispatch = (body: Record<string, unknown>) => Promise<unknown>;
