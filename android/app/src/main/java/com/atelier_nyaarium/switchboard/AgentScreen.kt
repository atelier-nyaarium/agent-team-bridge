package com.atelier_nyaarium.switchboard

/**
 * Whether a captured tmux pane shows the agent idle/ready or actively working a turn.
 * Twin of the markers in src/mcp/devcontainer/tmuxCore.ts (isAgentReady / isAgentWorking):
 * a fresh start shows the "Claude Code v" header, a resumed session shows "? for shortcuts",
 * and the spinner footer prints "esc to interrupt" only while a turn is running.
 */
object AgentScreen {
	fun isReady(screen: String): Boolean {
		if (screen.contains("Choose the text style")) return false
		return screen.contains("Claude Code v") || screen.contains("? for shortcuts")
	}

	fun isWorking(screen: String): Boolean = screen.contains("esc to interrupt")
}
