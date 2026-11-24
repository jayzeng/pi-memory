import { afterEach, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as actualAi from "@earendil-works/pi-ai/compat";

const complete = mock(async (_model: unknown, _context: unknown, options: { sessionId?: string }) => {
	if (!options.sessionId) throw new Error("MissingSessionID");
	return { content: [{ type: "text", text: "### Decisions\n- Use SQLite." }] };
});
mock.module("@earendil-works/pi-ai/compat", () => ({ ...actualAi, complete }));
const { default: register, _setBaseDir, _resetBaseDir, _clearUpdateTimer } = await import("../index.js");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-summary-session-"));
afterEach(() => {
	_clearUpdateTimer();
	_resetBaseDir();
	mock.restore();
	fs.rmSync(root, { recursive: true, force: true });
});
test("exit summary sends the active session ID to the provider", async () => {
	_setBaseDir(root);
	const hooks: Record<string, (...args: any[]) => any> = {};
	register({
		on: (name: string, handler: any) => {
			hooks[name] = handler;
		},
		registerTool: () => {},
	} as any);
	const sessionId = "session-needs-routing";
	const branch = ["user", "assistant", "user", "assistant"].map((role) => ({
		type: "message",
		message: { role, content: [{ type: "text", text: "Use SQLite for durable storage." }], timestamp: Date.now() },
	}));
	await hooks.session_shutdown(
		{ reason: "quit" },
		{
			sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
			model: { provider: "opencode", id: "test" },
			modelRegistry: { getApiKey: async () => "test-key" },
			hasUI: false,
		},
	);
	expect(complete).toHaveBeenCalledTimes(1);
	expect(complete.mock.calls[0][2].sessionId).toBe(sessionId);
	const daily = fs.readdirSync(path.join(root, "daily"));
	expect(daily).toHaveLength(1);
	expect(fs.readFileSync(path.join(root, "daily", daily[0]), "utf8")).toContain("Use SQLite.");
});
