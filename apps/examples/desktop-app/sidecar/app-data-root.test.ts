import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AUTOCLINE_SHARED_ROOT_ENV_KEYS,
	AUTOCLINE_ROOT_ENV,
	applyAppDataRoot,
	type AppDataEnv,
	isAutoClineInternalPath,
	isSameOrInsidePath,
	resolveAppDataRootEnv,
	resolveAutoClineInternalRoots,
} from "./app-data-root";

let sandbox: string;
let saved: NodeJS.ProcessEnv;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "autocline-root-"));
	// Every assertion runs against a private env object, never the real one.
	saved = { ...process.env };
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
	for (const key of AUTOCLINE_SHARED_ROOT_ENV_KEYS) {
		delete process.env[key];
	}
	process.env = { ...saved };
});

function isolatedEnv(extra: AppDataEnv = {}): AppDataEnv {
	const env: AppDataEnv = { HOME: sandbox };
	for (const key of AUTOCLINE_SHARED_ROOT_ENV_KEYS) {
		delete env[key];
	}
	delete env[AUTOCLINE_ROOT_ENV];
	return Object.assign(env, extra);
}

describe("resolveAppDataRootEnv", () => {
	it("defaults the whole tree under ~/.autocline", () => {
		const env = resolveAppDataRootEnv({ homeDir: sandbox, env: isolatedEnv() });
		const root = join(sandbox, ".autocline");
		expect(env.CLINE_DIR).toBe(root);
		expect(env.CLINE_DATA_DIR).toBe(join(root, "data"));
		expect(env.CLINE_SESSION_DATA_DIR).toBe(join(root, "data", "sessions"));
		expect(env.CLINE_KANBAN_DATA_DIR).toBe(join(root, "apps", "kanban"));
		expect(env.CLINE_HUB_CONFIG).toBe(join(root, "config", "hub.json"));
		expect(env.CLINE_HOOKS_LOG_PATH).toBe(
			join(root, "data", "logs", "hooks.jsonl"),
		);
		expect(env.CLINE_MCP_SETTINGS_PATH).toBe(
			join(root, "data", "settings", "cline_mcp_settings.json"),
		);
		// Nothing may point at the official root.
		for (const value of Object.values(env)) {
			expect(value.includes(join(sandbox, ".cline"))).toBe(false);
		}
	});

	it("honors CLINE_AUTOCLINE_ROOT as the whole-tree override", () => {
		const env = resolveAppDataRootEnv({
			homeDir: sandbox,
			env: isolatedEnv({ [AUTOCLINE_ROOT_ENV]: join(sandbox, "portable") }),
		});
		expect(env.CLINE_DIR).toBe(join(sandbox, "portable"));
		expect(env.CLINE_DATA_DIR).toBe(join(sandbox, "portable", "data"));
	});
});

describe("applyAppDataRoot", () => {
	it("creates and claims ~/.autocline on a first, env-less launch", () => {
		const env = isolatedEnv();
		const created: string[] = [];
		const result = applyAppDataRoot({
			homeDir: sandbox,
			env,
			mkdir: (directory) => {
				mkdirSync(directory, { recursive: true, mode: 0o700 });
				created.push(directory);
			},
		});
		const root = join(sandbox, ".autocline");
		expect(result.action).toBe("applied");
		expect(result.root).toBe(root);
		expect(result.mode).toBe("conflict");
		expect(env.CLINE_DIR).toBe(root);
		expect(created).toEqual([root, join(root, "data"), join(root, "config")]);
		expect(statSync(root).isDirectory()).toBe(true);
		expect(statSync(join(root, "data")).isDirectory()).toBe(true);
		expect(statSync(root).mode & 0o777).toBe(0o700);
	});

	it("is idempotent across a second launch (Dock open twice)", () => {
		const env = isolatedEnv();
		applyAppDataRoot({ homeDir: sandbox, env });
		const second = applyAppDataRoot({ homeDir: sandbox, env });
		expect(second.action).toBe("unchanged");
		expect(env.CLINE_DIR).toBe(join(sandbox, ".autocline"));
	});

	it("keeps an explicit AutoCline-root override and fills sub-paths", () => {
		const root = join(sandbox, "custom-root");
		const env = isolatedEnv({ [AUTOCLINE_ROOT_ENV]: root });
		const result = applyAppDataRoot({ homeDir: sandbox, env });
		expect(result.action).toBe("applied");
		expect(result.mode).toBe("explicit");
		expect(env.CLINE_DIR).toBe(root);
		expect(env.CLINE_DATA_DIR).toBe(join(root, "data"));
	});

	it("never rewrites an override that points at the official ~/.cline", () => {
		const official = join(sandbox, ".cline");
		const env = isolatedEnv({ CLINE_DIR: official });
		const result = applyAppDataRoot({ homeDir: sandbox, env });
		expect(result.mode).toBe("conflict");
		// The deliberate override survives byte-for-byte and is reported.
		expect(env.CLINE_DIR).toBe(official);
		expect(result.conflictKeys).toEqual(["CLINE_DIR"]);
		// Everything else still points at AutoCline's private tree.
		expect(env.CLINE_DATA_DIR).toBe(join(sandbox, ".autocline", "data"));
	});

	it("reports a conflict when only a sub-path escapes the root", () => {
		const escaped = join(sandbox, ".cline", "apps", "kanban");
		const env = isolatedEnv({ CLINE_KANBAN_DATA_DIR: escaped });
		const result = applyAppDataRoot({ homeDir: sandbox, env });
		expect(result.mode).toBe("conflict");
		expect(result.conflictKeys).toEqual(["CLINE_KANBAN_DATA_DIR"]);
		expect(env.CLINE_KANBAN_DATA_DIR).toBe(escaped);
		expect(env.CLINE_DIR).toBe(join(sandbox, ".autocline"));
	});

	it("writes no credentials, only path variables", () => {
		const env = isolatedEnv();
		applyAppDataRoot({ homeDir: sandbox, env });
		expect(Object.keys(env).filter((key) => /KEY|TOKEN|SECRET/.test(key))).toEqual(
			[],
		);
	});

	it("provisions a loopback Hub config on a first, empty root", () => {
		const env = isolatedEnv();
		applyAppDataRoot({ homeDir: sandbox, env });
		const root = join(sandbox, ".autocline");
		const configPath = join(root, "config", "hub.json");
		expect(env.CLINE_HUB_CONFIG).toBe(configPath);
		const document = JSON.parse(readFileSync(configPath, "utf8"));
		expect(document).toEqual({
			port: 25465,
			pathname: "/hub",
			listenHosts: ["127.0.0.1"],
		});
		// Never the official Hub, never a wildcard bind.
		expect(document.port).not.toBe(25463);
		expect(document.listenHosts).not.toContain("0.0.0.0");
		expect(statSync(configPath).mode & 0o777).toBe(0o600);
		expect(statSync(join(root, "config")).mode & 0o777).toBe(0o700);
	});

	it("never overwrites an existing Hub config", () => {
		const env = isolatedEnv();
		applyAppDataRoot({ homeDir: sandbox, env });
		const configPath = join(sandbox, ".autocline", "config", "hub.json");
		const edited = `{"port": 25500, "listenHosts": ["127.0.0.1"]}\n`;
		writeFileSync(configPath, edited);
		applyAppDataRoot({ homeDir: sandbox, env });
		expect(readFileSync(configPath, "utf8")).toBe(edited);
	});

	it("leaves a Hub config the user pointed outside the root alone", () => {
		const outside = join(sandbox, ".cline", "config", "hub.json");
		const env = isolatedEnv({ CLINE_HUB_CONFIG: outside });
		const result = applyAppDataRoot({ homeDir: sandbox, env });
		expect(result.conflictKeys).toEqual(["CLINE_HUB_CONFIG"]);
		expect(env.CLINE_HUB_CONFIG).toBe(outside);
		expect(existsSync(outside)).toBe(false);
	});
});

describe("internal path helpers", () => {
	it("is path-aware, not textual", () => {
		const root = join(sandbox, ".autocline");
		expect(isSameOrInsidePath(root, root)).toBe(true);
		expect(isSameOrInsidePath(join(root, "data"), root)).toBe(true);
		expect(isSameOrInsidePath(`${root}-other`, root)).toBe(false);
		expect(isSameOrInsidePath(join(sandbox, "project"), root)).toBe(false);
	});

	it("recognizes the AutoCline data dir and worktrees only", () => {
		const env = isolatedEnv();
		applyAppDataRoot({ homeDir: sandbox, env });
		const roots = resolveAutoClineInternalRoots(env);
		expect(roots.dataDir).toBe(join(sandbox, ".autocline", "data"));
		expect(isAutoClineInternalPath(roots.chatWorkspaceDir, roots)).toBe(true);
		expect(isAutoClineInternalPath(join(roots.root, "worktrees", "a", "b"), roots)).toBe(
			true,
		);
		expect(isAutoClineInternalPath(join(sandbox, "project"), roots)).toBe(false);
		expect(isAutoClineInternalPath("", roots)).toBe(false);
	});
});
