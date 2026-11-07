import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DESKTOP_HUB_PORT } from "./cli-runtime";

/**
 * AutoCline ships beside the official Cline apps on the same machine, so it
 * must not share their state root. Without this module a Dock/Finder launch
 * inherits no `CLINE_DIR`, so the sidecar, the Hub daemon it starts, the
 * embedded CLI, and the hooks/kanban/artifact readers all fell back to
 * `~/.cline` - the official app's history, credentials and Hub record.
 *
 * AutoCline therefore owns one private root, `~/.autocline`, and everything it
 * persists resolves under it through the env knobs the SDK already honors
 * (`CLINE_DIR`, `CLINE_DATA_DIR`, `CLINE_HUB_*`, ...). This module only
 * *selects* that root once, in the backend process, before anything else
 * reads a path; every child (Hub daemon, CLI, agent tools) inherits the same
 * env, so a normal Dock/Finder launch lands in the new root on every start
 * without launcher scripts, launchctl, or a one-off shell env.
 *
 * What this module deliberately does NOT do:
 * - It never touches `~/.cline` or Cline.app's Hub (25463): no migration
 *   reads, no copies, no symlinks. A fresh AutoCline simply starts empty.
 * - It does not change the SDK's own defaults (`~/.cline` stays the default
 *   for the official CLI/JetBrains/VS Code hosts); only this app's process env
 *   is pointed elsewhere.
 */

/** Directory name (under `$HOME`) that AutoCline owns. */
export const AUTOCLINE_HOME_DIRECTORY_NAME = ".autocline";

/** Root AutoCline overrides the shared default with; explicit overrides win. */
export const AUTOCLINE_ROOT_ENV = "CLINE_AUTOCLINE_ROOT";

/**
 * Shared per-user state env knobs, in the order upstream resolvers consult
 * them. They are rewritten together so no reader can keep pointing at the
 * official root while another points at the new one.
 */
export const AUTOCLINE_SHARED_ROOT_ENV_KEYS = [
	"CLINE_DIR",
	"CLINE_DATA_DIR",
	"CLINE_SESSION_DATA_DIR",
	"CLINE_TEAM_DATA_DIR",
	"CLINE_CONNECTOR_DATA_DIR",
	"CLINE_DB_DATA_DIR",
	"CLINE_PROVIDER_SETTINGS_PATH",
	"CLINE_CONNECTOR_SETTINGS_PATH",
	"CLINE_MCP_SETTINGS_PATH",
	"CLINE_HOOKS_LOG_PATH",
	"CLINE_KANBAN_DATA_DIR",
	"CLINE_HUB_CONFIG",
] as const;

/** The env shape this module reads and rewrites (a plain string map). */
export type AppDataEnv = Record<string, string | undefined>;

export interface AppDataRootOptions {
	homeDir?: string;
	env?: AppDataEnv;
	/** Injectable for tests; defaults to `mkdirSync`. */
	mkdir?: (directory: string, mode: number) => void;
	/** Injectable for tests; defaults to `statSync`. */
	isDirectory?: (path: string) => boolean;
	/** Injectable for tests; defaults to `existsSync`. */
	fileExists?: (path: string) => boolean;
	/** Injectable for tests; defaults to an exclusive `writeFileSync`. */
	writeNewFile?: (path: string, contents: string, mode: number) => void;
}

/**
 * Loopback-only default listen config written on a first launch.
 *
 * `CLINE_HUB_CONFIG` is an explicit path, so the SDK's loader throws
 * `Hub config file not found` instead of falling back when the file is absent —
 * a fresh AutoCline root would otherwise fail to start its Hub at all. Bind
 * loopback only (the Hub authenticates with a bearer token, but a wildcard bind
 * would expose it on whatever network the machine is attached to) and reuse the
 * desktop's own Hub port so the config cannot pull the app onto the official
 * 25463 Hub.
 */
export function defaultHubConfigDocument(
	desktopHubPort = DESKTOP_HUB_PORT,
): { port: number; pathname: string; listenHosts: string[] } {
	return {
		port: desktopHubPort,
		pathname: "/hub",
		listenHosts: ["127.0.0.1"],
	};
}

export function serializeHubConfigDocument(): string {
	return `${JSON.stringify(defaultHubConfigDocument(), null, 2)}\n`;
}

export interface AppDataRootSelection {
	/**
	 * Nothing was changed: every shared-root path already resolved under the
	 * AutoCline root.
	 */
	action: "unchanged";
	root: string;
	dataDir: string;
	/**
	 * `explicit`: this app's own override selected the AutoCline root.
	 * `conflict`: an explicit env value pointed outside the root (e.g. the
	 *   official `~/.cline`); those values were left exactly as given.
	 */
	mode: "explicit" | "conflict";
	/** Env keys this call set (blank/absent before) or rewrote. */
	changedKeys: string[];
	/**
	 * Env keys that already pointed outside the root and were left untouched.
	 * Non-empty means the caller should warn the user about mixed state.
	 */
	conflictKeys: string[];
}

export interface AppDataRootApplied
	extends Omit<AppDataRootSelection, "action"> {
	action: "applied";
}

export type ApplyAppDataRootResult = AppDataRootSelection | AppDataRootApplied;

/** True when `target` is `base` or lives inside it (path-aware, not textual). */
export function isSameOrInsidePath(target: string, base: string): boolean {
	const relativePath = relative(base, target);
	return (
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`))
	);
}

function canonical(path: string): string {
	return resolve(path).replace(/[\\/]+$/, "") || resolve(path);
}

export function resolveAutoClineRoot(
	env: AppDataEnv = process.env,
	homeDir?: string,
): string {
	const explicit = env[AUTOCLINE_ROOT_ENV]?.trim();
	if (explicit) {
		return canonical(explicit);
	}
	return join(
		homeDir?.trim() ||
			env.HOME?.trim() ||
			env.USERPROFILE?.trim() ||
			homedir(),
		AUTOCLINE_HOME_DIRECTORY_NAME,
	);
}

/**
 * Resolves the shared-root env a fresh AutoCline process must carry. Pure: it
 * never touches the filesystem, so callers can inspect the decision before
 * anything is created.
 */
export function resolveAppDataRootEnv(
	options: AppDataRootOptions = {},
	env: AppDataEnv = options.env ?? process.env,
): Record<string, string> {
	const root = resolveAutoClineRoot(env, options.homeDir);
	const dataDir = join(root, "data");
	return {
		[AUTOCLINE_ROOT_ENV]: root,
		CLINE_DIR: root,
		CLINE_DATA_DIR: dataDir,
		CLINE_SESSION_DATA_DIR: join(dataDir, "sessions"),
		CLINE_TEAM_DATA_DIR: join(dataDir, "teams"),
		CLINE_CONNECTOR_DATA_DIR: join(dataDir, "connectors"),
		CLINE_DB_DATA_DIR: join(dataDir, "db"),
		CLINE_PROVIDER_SETTINGS_PATH: join(dataDir, "settings", "providers.json"),
		CLINE_CONNECTOR_SETTINGS_PATH: join(dataDir, "connectors", "settings.json"),
		CLINE_MCP_SETTINGS_PATH: join(
			dataDir,
			"settings",
			"cline_mcp_settings.json",
		),
		CLINE_HOOKS_LOG_PATH: join(dataDir, "logs", "hooks.jsonl"),
		// Kanban-style session logs used by the desktop session views.
		CLINE_KANBAN_DATA_DIR: join(root, "apps", "kanban"),
		// AutoCline's own Hub listen config; `~/.config/cline/hub.json` belongs
		// to the official installation.
		CLINE_HUB_CONFIG: join(root, "config", "hub.json"),
	};
}

/**
 * True when every incoming shared-root value already lives under `root`,
 * i.e. this process (or its launcher) already selected the AutoCline root.
 */
export function incomingValuesAreInsideRoot(
	env: AppDataEnv,
	root: string,
): boolean {
	for (const key of AUTOCLINE_SHARED_ROOT_ENV_KEYS) {
		const value = env[key]?.trim();
		if (value && !isSameOrInsidePath(canonical(value), canonical(root))) {
			return false;
		}
	}
	return true;
}

/** The env-only mode decision, split out so it can be tested directly. */
export function selectAppDataRootMode(
	env: AppDataEnv,
	root: string,
): AppDataRootSelection["mode"] {
	// "explicit" only when the caller itself selected this exact root; a root
	// that merely resolves here from the default home leaves any escaping
	// value as a conflict.
	const requested = env[AUTOCLINE_ROOT_ENV]?.trim();
	return requested && resolve(requested) === root ? "explicit" : "conflict";
}


/**
 * Creates AutoCline's private root and data dir at 0700 so sessions, history and
 * settings stay readable only by this user, then verifies both exist.
 */
function ensureRootDirectories(
	root: string,
	dataDir: string,
	mkdir: (directory: string, mode: number) => void,
	isDirectory: (path: string) => boolean,
): void {
	mkdir(root, 0o700);
	mkdir(dataDir, 0o700);
	if (!isDirectory(root) || !isDirectory(dataDir)) {
		throw new Error(
			`AutoCline data root is not a directory: ${root} (data: ${dataDir})`,
		);
	}
}

/**
 * Makes the Hub config file exist before any Hub/CLI child starts.
 *
 * `CLINE_HUB_CONFIG` names an *explicit* path, so the loader throws instead of
 * using the ambient default when the file is missing; an empty root therefore
 * could not start a Hub. Write the loopback default only when the file is
 * absent and only under the AutoCline root (`exclusive`, so a concurrent launch
 * cannot clobber a config the user already edited).
 */
export function ensureHubConfigFile(
	env: AppDataEnv = process.env,
	options: Pick<AppDataRootOptions, "mkdir" | "fileExists" | "writeNewFile"> & {
		root: string;
	} = { root: resolveAutoClineRoot(env) },
): string | undefined {
	const configPath = env.CLINE_HUB_CONFIG?.trim();
	if (!configPath) {
		return undefined;
	}
	// A config the user pointed outside the root is not ours to create.
	if (!isSameOrInsidePath(canonical(configPath), canonical(options.root))) {
		return undefined;
	}
	const fileExists = options.fileExists ?? ((path: string) => existsSync(path));
	if (fileExists(configPath)) {
		return undefined;
	}
	const mkdir =
		options.mkdir ??
		((directory: string, mode: number) =>
			mkdirSync(directory, { recursive: true, mode }));
	const directory = dirname(configPath);
	mkdir(directory, 0o700);
	const writeNewFile =
		options.writeNewFile ??
		((path: string, contents: string, mode: number) =>
			writeFileSync(path, contents, { encoding: "utf8", mode, flag: "wx" }));
	try {
		writeNewFile(configPath, serializeHubConfigDocument(), 0o600);
	} catch (error) {
		// Another launch won the race: its file is as good as ours.
		if (!fileExists(configPath)) {
			throw error;
		}
	}
	return configPath;
}

/**
 * Full claim path used when an incoming value escapes the root.
 *
 * A value that already points somewhere dies: it is kept exactly as the caller
 * gave it (never rewritten, so an explicit `CLINE_DIR=~/.cline` survives) and
 * reported in `conflictKeys`. Keys nobody set are filled with the AutoCline
 * paths, and the private root is still created so the app has somewhere to
 * write.
 */
export function claimAppDataRoot(
	env: AppDataEnv,
	expected: Record<string, string>,
	root: string,
	dataDir: string,
	mkdir: (directory: string, mode: number) => void,
	isDirectory: (path: string) => boolean,
): AppDataRootApplied {
	ensureRootDirectories(root, dataDir, mkdir, isDirectory);
	const mode = selectAppDataRootMode(env, root);
	const changedKeys: string[] = [];
	const conflictKeys: string[] = [];
	for (const [key, value] of Object.entries(expected)) {
		const incoming = env[key]?.trim();
		if (!incoming) {
			env[key] = value;
			changedKeys.push(key);
			continue;
		}
		if (!isSameOrInsidePath(canonical(incoming), canonical(root))) {
			conflictKeys.push(key);
		}
	}
	return { action: "applied", root, dataDir, mode, changedKeys, conflictKeys };
}

/**
 * Selects AutoCline's private root for this process and every child it spawns.
 *
 *   still missing get filled in (second launch, Hub daemon respawn, CLI
 *   children).
 * - An explicit override outside the root (most dangerously
 *   `CLINE_DIR=~/.cline`) is reported as a `conflict` and left exactly as
 *   given. Pointing AutoCline at the official root would mix two apps' state,
 *   and silently dropping a deliberate override would ignore the user, so the
 *   caller logs the conflict instead of guessing.
 * - Otherwise the AutoCline env is written into `env` (process-global by
 *   default) so the SDK resolvers, the Hub discovery paths and the sidecar's
 *   own readers agree on one root for the rest of this process's life.
 *
 * Only path variables are written - never credentials.
 */
export function applyAppDataRoot(
	options: AppDataRootOptions = {},
): ApplyAppDataRootResult {
	const env = options.env ?? process.env;
	const mkdir =
		options.mkdir ??
		((directory: string, mode: number) =>
			mkdirSync(directory, { recursive: true, mode }));
	const isDirectory =
		options.isDirectory ?? ((path: string) => statSync(path).isDirectory());


	const overrides: AppDataRootOptions = { homeDir: options.homeDir };
	const expected = resolveAppDataRootEnv(overrides, env);
	const root = expected[AUTOCLINE_ROOT_ENV];
	const dataDir = expected.CLINE_DATA_DIR;
	// "explicit" only when the caller itself selected this exact root; a root
	// that merely happens to resolve here (default home, or a value that was
	// overridden) leaves any escaping value as a conflict.
	const mode = selectAppDataRootMode(env, root);

	if (incomingValuesAreInsideRoot(env, root)) {
		const changedKeys: string[] = [];
		for (const [key, value] of Object.entries(expected)) {
			if (!env[key]?.trim()) {
				env[key] = value;
				changedKeys.push(key);
			}
		}
		ensureRootDirectories(root, dataDir, mkdir, isDirectory);
		// Fail here, at startup, if the Hub config cannot be provisioned: every
		// Hub/CLI child inherits this process's env, and `CLINE_HUB_CONFIG` is an
		// explicit path whose absence makes the loader throw.
		ensureHubConfigFile(env, { root, ...options });
		return {
			action: changedKeys.length === 0 ? "unchanged" : "applied",
			root,
			dataDir,
			mode,
			changedKeys,
			conflictKeys: [],
		};
	}

	// At least one incoming value escapes the root: claim it without touching
	// the conflicting values so an explicit `CLINE_DIR=~/.cline` is preserved.
	const claimed = claimAppDataRoot(
		env,
		expected,
		root,
		dataDir,
		mkdir,
		isDirectory,
	);
	ensureHubConfigFile(env, { root, ...options });
	return claimed;
}

/** AutoCline-owned locations that must never be offered as a user project. */
export interface AutoClineInternalRoots {
	root: string;
	dataDir: string;
	worktreesDir: string;
	chatWorkspaceDir: string;
}

/** Resolves the app-internal roots for the current (post-apply) env. */
export function resolveAutoClineInternalRoots(
	env: AppDataEnv = process.env,
): AutoClineInternalRoots {
	// `applyAppDataRoot` runs before this, so both vars are set in practice;
	// the `~/.autocline` fallback here only covers a bare real-process env and
	// must never point at the official app's root.
	const root = canonical(
		env.CLINE_DIR?.trim() ||
			env.CLINE_DATA_DIR?.trim()?.replace(/[\\/]data$/, "") ||
			join(env.HOME ?? env.USERPROFILE ?? "", ".autocline"),
	);
	const dataDir = canonical(env.CLINE_DATA_DIR?.trim() || join(root, "data"));
	return {
		root,
		dataDir,
		worktreesDir: join(root, "worktrees"),
		chatWorkspaceDir: join(dataDir, "workspaces", "chat"),
	};
}

/**
 * Whether a path is AutoCline's own internal area (data dir or generated task
 * worktrees). Path-aware, so a real project that merely contains a directory
 * named `.autocline` under the user's own tree is not swept in.
 */
export function isAutoClineInternalPath(
	path: string,
	roots: AutoClineInternalRoots = resolveAutoClineInternalRoots(),
): boolean {
	const normalized = path.trim();
	if (!normalized) {
		return false;
	}
	const absolute = canonical(normalized);
	return (
		isSameOrInsidePath(absolute, roots.dataDir) ||
		isSameOrInsidePath(absolute, roots.worktreesDir)
	);
}
