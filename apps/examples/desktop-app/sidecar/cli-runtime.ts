import { execFile } from "node:child_process";
import { join } from "node:path";
import { setHubDaemonLauncher, setPluginSandboxLauncher } from "@cline/core";
import { withHubLauncherIdentity } from "@cline/shared";
import { resolveClineDataDir } from "@cline/shared/storage";
import { DESKTOP_CLIENT_CONTEXT } from "./client-context";

/** Absolute path of the Cline CLI binary the desktop shell bundles and launched us with. */
export const DESKTOP_CLI_PATH_ENV = "CLINE_DESKTOP_CLI_PATH";
/** Workspace root the shell resolved; the backend starts in its own resource directory. */
export const DESKTOP_WORKSPACE_ROOT_ENV = "CLINE_DESKTOP_WORKSPACE_ROOT";
/** Makes a compiled Bun executable run a script instead of its embedded entrypoint. */
export const BUN_BE_BUN_ENV = "BUN_BE_BUN";

/** Hub loopback port this desktop owns; env knobs below still override it. */
export const DESKTOP_HUB_PORT_ENV = "CLINE_HUB_PORT";
export const DESKTOP_HUB_PORT = 25465;
/** Hub discovery record this desktop owns, so Cline.app's Hub cannot be claimed. */
export const DESKTOP_HUB_DISCOVERY_PATH_ENV = "CLINE_HUB_DISCOVERY_PATH";

export function resolveDesktopHubDiscoveryPath(
	env: NodeJS.ProcessEnv = process.env,
	dataDir = resolveClineDataDir(),
): string {
	return (
		env[DESKTOP_HUB_DISCOVERY_PATH_ENV]?.trim() ||
		join(dataDir, "locks", "hub", "autocline", "production.json")
	);
}

/**
 * AutoCline runs beside the official Cline desktop app, which owns the shared
 * production Hub (port 25463 + `~/.cline/locks/hub/production.json`). Pointing
 * plain `cline hub ensure` at that record would attach this desktop to Cline's
 * Hub - or, if that Hub is older/newer, replace it under the other app. Stamp
 * this process's env (the Hub daemon and every CLI child inherit it) with a
 * desktop-owned port and discovery record instead. Explicit user overrides are
 * left untouched, and the discovery record itself is still written by the
 * normal Hub mechanism - nothing is copied or forged here.
 */
export function applyDesktopHubDefaults(
	env: NodeJS.ProcessEnv = process.env,
): void {
	if (!env[DESKTOP_HUB_PORT_ENV]?.trim()) {
		env[DESKTOP_HUB_PORT_ENV] = String(DESKTOP_HUB_PORT);
	}
	if (!env[DESKTOP_HUB_DISCOVERY_PATH_ENV]?.trim()) {
		env[DESKTOP_HUB_DISCOVERY_PATH_ENV] = resolveDesktopHubDiscoveryPath(env);
	}
}

export function resolveDesktopCliPath(
	env: NodeJS.ProcessEnv = process.env,
): string | undefined {
	return env[DESKTOP_CLI_PATH_ENV]?.trim() || undefined;
}

/**
 * The packaged backend is a script running on the bundled Cline CLI's embedded
 * runtime. Adopt that host before anything spawns: every child (the Hub
 * daemon, connectors, agent tools) must see the CLI binary as the CLI, not as
 * a script runner, and Hubs this process starts must be CLI-managed Hubs.
 */
export function adoptDesktopCliRuntime(
	options: {
		env?: NodeJS.ProcessEnv;
		chdir?: (directory: string) => void;
		setLauncher?: typeof setHubDaemonLauncher;
		setPluginLauncher?: typeof setPluginSandboxLauncher;
	} = {},
): { cliPath?: string } {
	const env = options.env ?? process.env;
	const chdir = options.chdir ?? ((directory) => process.chdir(directory));
	const setLauncher = options.setLauncher ?? setHubDaemonLauncher;
	delete env[BUN_BE_BUN_ENV];
	// The shell starts the runtime outside the workspace so it cannot pick up a
	// workspace .env or bunfig.toml; workspace-relative code expects that cwd.
	const workspaceRoot = env[DESKTOP_WORKSPACE_ROOT_ENV]?.trim();
	delete env[DESKTOP_WORKSPACE_ROOT_ENV];
	if (workspaceRoot) {
		chdir(workspaceRoot);
	}
	const cliPath = resolveDesktopCliPath(env);
	if (cliPath) {
		setLauncher({ command: cliPath });
		(options.setPluginLauncher ?? setPluginSandboxLauncher)({
			command: cliPath,
			argsPrefix: ["--plugin-sandbox"],
		});
	}
	return { cliPath };
}

const HUB_ENSURE_TIMEOUT_MS = 60_000;

/**
 * Endpoint options the `hub ensure` subcommand documents. The backend's
 * configured Hub endpoint is inherited as env, but a child CLI that resolves a
 * different owner default (launcher identity, packaged defaults) would then
 * probe a different port and discovery record than this backend uses. Passing
 * the configured values as explicit CLI options makes the endpoint the child's
 * own input instead of a launcher-dependent default.
 */
export function hubEndpointArgs(
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const args: string[] = [];
	const port = env[DESKTOP_HUB_PORT_ENV]?.trim();
	if (port) {
		args.push("--port", port);
	}
	const discoveryPath = env[DESKTOP_HUB_DISCOVERY_PATH_ENV]?.trim();
	if (discoveryPath) {
		args.push("--discovery-path", discoveryPath);
	}
	return args;
}

export type RunCliCommand = (
	command: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<string>;

const runCliCommand: RunCliCommand = (command, args, options) =>
	new Promise((resolve, reject) => {
		execFile(
			command,
			args,
			{
				cwd: options.cwd,
				env: options.env,
				timeout: options.timeoutMs,
				windowsHide: true,
				maxBuffer: 1024 * 1024,
			},
			(error, stdout, stderr) => {
				if (error) {
					const detail = String(stderr).trim();
					reject(
						new Error(detail ? `${error.message}: ${detail}` : error.message),
					);
					return;
				}
				resolve(String(stdout));
			},
		);
	});

/**
 * Has the bundled CLI start the shared Hub, or reuse a compatible healthy
 * one, before the session manager connects. Returns the Hub URL (never the
 * auth token, which callers may log).
 */
export async function ensureHubWithDesktopCli(
	cliPath: string,
	workspaceRoot: string,
	options: { env?: NodeJS.ProcessEnv; run?: RunCliCommand } = {},
): Promise<{ url: string }> {
	const run = options.run ?? runCliCommand;
	const env = withHubLauncherIdentity(
		{ ...(options.env ?? process.env), CLINE_NO_AUTO_UPDATE: "1" },
		{
			client: DESKTOP_CLIENT_CONTEXT.name,
			version: DESKTOP_CLIENT_CONTEXT.version,
			transport: "local",
		},
	);
	const stdout = await run(
		cliPath,
		[
			"hub",
			"ensure",
			"--json",
			"--cwd",
			workspaceRoot,
			...hubEndpointArgs(env),
		],
		{
			cwd: workspaceRoot,
			// The CLI spawns the daemon, so stamp the desktop as its launcher
			// here or the hub's telemetry would say the CLI started it.
			env,
			timeoutMs: HUB_ENSURE_TIMEOUT_MS,
		},
	);
	const line = stdout
		.split(/\r?\n/)
		.map((value) => value.trim())
		.filter((value) => value.startsWith("{"))
		.at(-1);
	const parsed = line ? (JSON.parse(line) as { url?: unknown }) : undefined;
	if (typeof parsed?.url !== "string" || !parsed.url) {
		throw new Error("cline hub ensure did not report a Hub URL");
	}
	return { url: parsed.url };
}
