import { ask } from "./lib/host.js";

// Typed confirmation prevents accidental board loss.
export async function confirmBoardLoss(): Promise<boolean> {
	console.log("Purging destroys the task board.");
	return ask("Type DELETE to confirm: ").trim() === "DELETE";
}
