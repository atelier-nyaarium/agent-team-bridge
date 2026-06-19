import { startGateway } from "./gateway/index.js";

startGateway().catch((err) => {
	console.error(`[gateway] fatal:`, err);
	process.exit(1);
});
