import { strict as assert } from "node:assert";
import type { execFile } from "node:child_process";
import {
	_clearQmdStatusCaches,
	_resetExecFileForTest,
	_setExecFileForTest,
	_setQmdAvailable,
	checkCollection,
	detectQmd,
	shouldSkipExitSummaryForReason,
} from "../index.ts";

type ExecFileFn = typeof execFile;

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;

function mockExecFile(handler: (cmd: string, args: readonly string[]) => { error?: Error; stdout?: string }) {
	let calls = 0;
	const fn: ExecFileFn = ((cmd: string, args: readonly string[], _options: unknown, callback: ExecCallback) => {
		calls++;
		const result = handler(cmd, args);
		queueMicrotask(() => callback(result.error ?? null, result.stdout ?? "", ""));
	}) as ExecFileFn;
	_setExecFileForTest(fn);
	return () => calls;
}

try {
	_clearQmdStatusCaches();
	const qmdCalls = mockExecFile((cmd, args) => {
		assert.equal(cmd, "qmd");
		assert.deepEqual(args, ["status"]);
		return {};
	});

	assert.equal(await detectQmd(), true);
	assert.equal(await detectQmd(), true);
	assert.equal(qmdCalls(), 1, "detectQmd should cache qmd status within the TTL");

	_clearQmdStatusCaches();
	const collectionCalls = mockExecFile((cmd, args) => {
		assert.equal(cmd, "qmd");
		assert.deepEqual(args, ["collection", "list", "--json"]);
		return { stdout: JSON.stringify([{ name: "pi-memory" }]) };
	});

	assert.equal(await checkCollection("pi-memory"), true);
	assert.equal(await checkCollection("pi-memory"), true);
	assert.equal(collectionCalls(), 1, "checkCollection should cache collection lookup within the TTL");

	_setQmdAvailable(false);
	assert.equal(await detectQmd(), false, "_setQmdAvailable should seed the cached status");

	const originalSummarizeTransitions = process.env.PI_MEMORY_SUMMARIZE_TRANSITIONS;
	try {
		delete process.env.PI_MEMORY_SUMMARIZE_TRANSITIONS;
		assert.equal(shouldSkipExitSummaryForReason("reload"), true);
		assert.equal(shouldSkipExitSummaryForReason("new"), true);
		assert.equal(shouldSkipExitSummaryForReason("session-end"), false);

		process.env.PI_MEMORY_SUMMARIZE_TRANSITIONS = "1";
		assert.equal(shouldSkipExitSummaryForReason("reload"), false);
		assert.equal(shouldSkipExitSummaryForReason("new"), false);
	} finally {
		if (originalSummarizeTransitions === undefined) {
			delete process.env.PI_MEMORY_SUMMARIZE_TRANSITIONS;
		} else {
			process.env.PI_MEMORY_SUMMARIZE_TRANSITIONS = originalSummarizeTransitions;
		}
	}

	console.log("qmd cache tests passed");
} finally {
	_resetExecFileForTest();
	_clearQmdStatusCaches();
}
