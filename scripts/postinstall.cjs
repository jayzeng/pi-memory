const { spawnSync } = require("node:child_process");
const path = require("node:path");

function hasQmd() {
	const result = spawnSync("qmd", ["status"], {
		stdio: "ignore",
		shell: process.platform === "win32",
	});
	return result.status === 0;
}

function memoryDir() {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? "~";
	return path.join(home, ".pi", "agent", "memory");
}

function configureGitHooks() {
	const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
		stdio: "ignore",
		shell: process.platform === "win32",
	});

	if (result.status !== 0) {
		return;
	}

	spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
		stdio: "ignore",
		shell: process.platform === "win32",
	});
}

configureGitHooks();

if (!hasQmd()) {
	const dir = memoryDir();
	console.log("\npi-memory: qmd not found (required for `memory_search`).\n");
	console.log("Install qmd (requires Bun):");
	console.log("  bun install -g https://github.com/tobi/qmd");
	console.log("  # ensure ~/.bun/bin is in your PATH\n");
	console.log("Then set up the collection (one-time):");
	console.log(`  qmd collection add ${dir} --name pi-memory`);
	console.log("  qmd embed\n");
}
