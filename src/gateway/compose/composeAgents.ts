// The Codex and Copilot catalogs, their host relays, and their HTTP routes.

import { agentHttpPath } from "../../shared/agent-backend.js";
import type { Ambient } from "../../shared/ambient.js";
import { CodexAgentService } from "../codexAgentService.js";
import { CodexRelay } from "../codexRelay.js";
import { CodexRoute } from "../codexRoute.js";
import { CopilotAgentService } from "../copilotAgentService.js";
import { CopilotRelay } from "../copilotRelay.js";
import { CopilotRoute } from "../copilotRoute.js";
import type { HostStage } from "./composeHost.js";
import type { SessionsStage } from "./composeSessions.js";

export interface AgentsStageDeps {
	sessions: Pick<
		SessionsStage,
		"sessionAuthority" | "sessionStore" | "offlineCatalog" | "codexCatalogWriter" | "copilotCatalogWriter"
	>;
	host: Pick<HostStage, "liveHostSocket">;
	ambient: Ambient;
}

export interface AgentsStage {
	codexRelay: CodexRelay;
	copilotRelay: CopilotRelay;
	agentRoutes: Map<string, (req: Request, body: unknown) => Promise<Response>>;
}

export function composeAgents({ sessions, host, ambient }: AgentsStageDeps): AgentsStage {
	const sendToHost = (message: unknown): boolean => {
		const hostWs = host.liveHostSocket();
		if (!hostWs) return false;
		hostWs.send(JSON.stringify(message));
		return true;
	};

	const codexAgentService = new CodexAgentService({
		auth: sessions.sessionAuthority,
		sessionStore: sessions.sessionStore,
		offlineCatalog: sessions.offlineCatalog,
		catalogWriter: sessions.codexCatalogWriter,
	});
	const copilotAgentService = new CopilotAgentService({
		auth: sessions.sessionAuthority,
		sessionStore: sessions.sessionStore,
		offlineCatalog: sessions.offlineCatalog,
		catalogWriter: sessions.copilotCatalogWriter,
	});

	const codexRelay = new CodexRelay({
		service: codexAgentService,
		sessionStore: sessions.sessionStore,
		sendToHost,
		ambient,
	});
	const copilotRelay = new CopilotRelay({
		service: copilotAgentService,
		sessionStore: sessions.sessionStore,
		sendToHost,
		ambient,
	});
	const codexRoute = new CodexRoute({ service: codexAgentService, relay: codexRelay, ambient });
	const copilotRoute = new CopilotRoute({ service: copilotAgentService, relay: copilotRelay, ambient });

	const agentRoutes = new Map<string, (req: Request, body: unknown) => Promise<Response>>([
		[agentHttpPath("codex"), (req, body) => codexRoute.handle(req, body)],
		[agentHttpPath("copilot"), (req, body) => copilotRoute.handle(req, body)],
	]);

	return { codexRelay, copilotRelay, agentRoutes };
}
