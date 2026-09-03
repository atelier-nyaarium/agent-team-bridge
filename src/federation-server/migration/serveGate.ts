import fs from "node:fs";
import path from "node:path";

const IN_PROGRESS = "import-in-progress";

export type ServeVerdict = { kind: "serve" } | { kind: "refuse"; reason: "import_unverified" };

export function decideServe(dataDir: string): ServeVerdict {
	return fs.existsSync(path.join(dataDir, IN_PROGRESS))
		? { kind: "refuse", reason: "import_unverified" }
		: { kind: "serve" };
}
