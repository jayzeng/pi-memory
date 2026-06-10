const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const packageRoot = path.resolve(__dirname, "..");

// Distinguish a development checkout of pi-memory from an end-user install.
// When pi-memory is installed as a dependency it lives under node_modules and
// is shipped without the `.githooks` directory (see the "files" allowlist in
// package.json). We must never touch a consumer's repo or VCS config, so all
// the dev-only setup below is gated on "are we actually in the source repo?".
function isDevCheckout() {
	if (packageRoot.split(path.sep).includes("node_modules")) return false;
	return fs.existsSync(path.join(packageRoot, ".githooks"));
}

// Point git at the repo's tracked hooks (lint + tests on commit). Scoped to the
// pi-memory working tree only — `git config` here writes to this repo's local
// config, and we only reach this code in a dev checkout.
function configureGitHooks() {
	const insideRepo = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
		cwd: packageRoot,
		stdio: "ignore",
		shell: process.platform === "win32",
	});
	if (insideRepo.status !== 0) return;

	spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
		cwd: packageRoot,
		stdio: "ignore",
		shell: process.platform === "win32",
	});
}

if (isDevCheckout()) {
	configureGitHooks();
}

// Note: we intentionally do NOT nag about qmd here. qmd is optional, and the
// extension already shows install instructions inside pi (via ctx.ui.notify)
// the first time a session starts without it — printing the same wall of text
// to every `npm install` / `pi install` is just noise.
