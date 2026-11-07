import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSyncStrippingUtf8Bom } from "@cline/shared/node";
import { DEFAULT_HUB_HOST, DEFAULT_HUB_PATHNAME } from "./defaults";

/**
 * File-based Hub listen configuration (AutoCline v1.2 §9.2).
 *
 * The Hub binds whatever host list the config file names, so adding a second
 * address (for example the host's Tailscale IP) is a config edit, not a source
 * change. Wildcard binds are rejected outright: the Hub authenticates with a
 * bearer token, but binding every interface puts it on whatever network the
 * machine happens to be attached to.
 *
 * Precedence for the listen list:
 *   1. `CLINE_HUB_LISTEN_HOSTS` (comma separated; replaces the file list)
 *   2. `listenHosts` / `hosts` in the config file
 *   3. hosts derived from the file's `listenUrls`
 * Absent all of the above the Hub keeps its historical loopback-only bind.
 */

export const HUB_CONFIG_ENV = "CLINE_HUB_CONFIG";
export const HUB_LISTEN_HOSTS_ENV = "CLINE_HUB_LISTEN_HOSTS";

const HUB_CONFIG_FILENAME = "hub.json";

const WILDCARD_HOSTS = new Set([
	"0.0.0.0",
	"::",
	"[::]",
	"0:0:0:0:0:0:0:0",
	"*",
]);

export interface HubConfigDocument {
	port?: number;
	pathname?: string;
	listenHosts?: string[];
	listenUrls?: string[];
	hosts?: string[];
}

export interface HubListenConfig {
	/** Hosts to bind, in config order, de-duplicated. Never a wildcard. */
	hosts: string[];
	/** Port shared by every bind. */
	port: number;
	/** WebSocket path; undefined falls back to the endpoint resolver. */
	pathname?: string;
	/** Documentation/health-check URLs; derived from hosts when not given. */
	urls: string[];
	/** Where the listen list came from, for logs and error messages. */
	source: "env" | "file" | "default";
	/** Config file path when one was found (or was requested explicitly). */
	configPath?: string;
}

export interface ResolveHubListenOptions {
	env?: NodeJS.ProcessEnv;
	/** Explicit config path (tests, `cline hub ensure --config`). */
	configPath?: string;
	/** Overrides the HOME used for the default config path. */
	homeDir?: string;
	/** Used to build derived URLs when the config does not name a port. */
	defaultPort: number;
	defaultPathname?: string;
}

/** True for addresses that would bind every interface. */
export function isWildcardListenHost(host: string): boolean {
	return WILDCARD_HOSTS.has(host.trim().toLowerCase());
}

function userConfigDir(homeDir: string, env: NodeJS.ProcessEnv): string {
	const xdg = env.XDG_CONFIG_HOME?.trim();
	return xdg ? join(xdg, "cline") : join(homeDir, ".config", "cline");
}

export function defaultHubConfigPath(
	options: { env?: NodeJS.ProcessEnv; homeDir?: string } = {},
): string {
	const env = options.env ?? process.env;
	const homeDir = options.homeDir ?? env.HOME?.trim() ?? homedir();
	return join(userConfigDir(homeDir, env), HUB_CONFIG_FILENAME);
}

function splitList(value: string): string[] {
	return value
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
}

function readStringArray(
	value: unknown,
	field: string,
	source: string,
): string[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (
		!Array.isArray(value) ||
		value.some((entry) => typeof entry !== "string")
	) {
		throw new Error(
			`Hub config ${source}: "${field}" must be an array of strings`,
		);
	}
	return value;
}

function readPort(value: unknown, source: string): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 0 ||
		value > 65_535
	) {
		throw new Error(
			`Hub config ${source}: "port" must be an integer between 0 and 65535`,
		);
	}
	return value;
}

function readPathname(value: unknown, source: string): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string" || !value.trim().startsWith("/")) {
		throw new Error(
			`Hub config ${source}: "pathname" must be a path starting with "/"`,
		);
	}
	return value.trim();
}

/** Parses a `hub.json` document; throws with the offending field named. */
export function parseHubConfig(
	raw: string,
	source = "hub.json",
): HubConfigDocument {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Hub config ${source} is not valid JSON`, {
			cause: error,
		});
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Hub config ${source} must be a JSON object`);
	}
	const record = parsed as Record<string, unknown>;
	return {
		port: readPort(record.port, source),
		pathname: readPathname(record.pathname, source),
		listenHosts: readStringArray(record.listenHosts, "listenHosts", source),
		hosts: readStringArray(record.hosts, "hosts", source),
		listenUrls: readStringArray(record.listenUrls, "listenUrls", source),
	};
}

/**
 * Validates the final listen list. Wildcards are a hard error: silently
 * narrowing to loopback would leave operators believing the Hub listens on the
 * Tailscale address they asked for.
 */
export function validateListenHosts(hosts: string[], source: string): string[] {
	const trimmed = hosts.map((host) => host.trim()).filter(Boolean);
	if (trimmed.length === 0) {
		throw new Error(
			`Hub listen configuration from ${source} names no hosts; refusing to start without an explicit bind list`,
		);
	}
	const wildcards = trimmed.filter(isWildcardListenHost);
	if (wildcards.length > 0) {
		throw new Error(
			`Refusing to bind Hub to wildcard address(es) ${wildcards.join(", ")} from ${source}. ` +
				"List concrete addresses instead (e.g. 127.0.0.1 and the host's Tailscale IP).",
		);
	}
	const seen = new Set<string>();
	const result: string[] = [];
	for (const host of trimmed) {
		if (host.includes("://") || /[\s\0]/.test(host)) {
			throw new Error(
				`Hub listen host "${host}" from ${source} must be a bare address or hostname`,
			);
		}
		if (seen.has(host)) {
			continue;
		}
		seen.add(host);
		result.push(host);
	}
	return result;
}

function hostsFromListenUrls(
	urls: string[],
	source: string,
): string[] | undefined {
	if (urls.length === 0) {
		return undefined;
	}
	return urls.map((raw) => {
		let parsed: URL;
		try {
			parsed = new URL(raw);
		} catch (error) {
			throw new Error(
				`Hub config ${source}: "listenUrls" entry "${raw}" is not a valid URL`,
				{ cause: error },
			);
		}
		// `URL.hostname` keeps IPv6 literals bracketed, which is what
		// `server.listen` expects.
		return parsed.hostname;
	});
}

function loadConfigFile(
	configPath: string,
	explicit: boolean,
): HubConfigDocument | undefined {
	if (!existsSync(configPath)) {
		if (explicit) {
			throw new Error(`Hub config file not found: ${configPath}`);
		}
		return undefined;
	}
	let raw: string;
	try {
		raw = readFileSyncStrippingUtf8Bom(configPath);
	} catch (error) {
		throw new Error(`Hub config file is not readable: ${configPath}`, {
			cause: error,
		});
	}
	return parseHubConfig(raw, configPath);
}

export function buildHubListenUrls(
	hosts: string[],
	port: number,
	pathname: string = DEFAULT_HUB_PATHNAME,
): string[] {
	return hosts.map((host) => {
		const bracketed =
			host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
		return `ws://${bracketed}:${port}${pathname}`;
	});
}

/**
 * The port the Hub listen config names, when it names one. A `port` in
 * `~/.config/cline/hub.json` is the single source of truth for a standalone
 * Hub; CLI flags and env still win because callers pass explicit endpoints.
 */
export function resolveHubConfigPort(options: {
	env?: NodeJS.ProcessEnv;
	defaultPort: number;
}): number {
	return resolveHubListenConfig({
		env: options.env,
		defaultPort: options.defaultPort,
	}).port;
}

/**
 * Resolves the Hub listen list from env + config file, rejecting wildcards.
 */
export function resolveHubListenConfig(
	options: ResolveHubListenOptions,
): HubListenConfig {
	const env = options.env ?? process.env;
	const homeDir = options.homeDir ?? env.HOME?.trim() ?? homedir();
	const pathname = options.defaultPathname ?? DEFAULT_HUB_PATHNAME;
	const explicitPath =
		options.configPath?.trim() || env[HUB_CONFIG_ENV]?.trim();
	const configPath = explicitPath || defaultHubConfigPath({ env, homeDir });
	const document = loadConfigFile(configPath, Boolean(explicitPath));
	const fileSource = configPath;

	const envHostsRaw = env[HUB_LISTEN_HOSTS_ENV]?.trim();
	const port = document?.port ?? options.defaultPort;
	const resolvedPathname = document?.pathname ?? pathname;
	const fallback = (): HubListenConfig => {
		const hosts = [DEFAULT_HUB_HOST];
		return {
			hosts,
			port,
			pathname: resolvedPathname,
			urls: buildHubListenUrls(hosts, port, resolvedPathname),
			source: "default",
			...(document ? { configPath } : {}),
		};
	};

	let candidateHosts: string[] | undefined;
	let listSource = fileSource;
	if (envHostsRaw) {
		candidateHosts = splitList(envHostsRaw);
		listSource = `env ${HUB_LISTEN_HOSTS_ENV}`;
	} else if (document) {
		candidateHosts =
			document.listenHosts ??
			document.hosts ??
			hostsFromListenUrls(document.listenUrls ?? [], fileSource);
	}
	if (!candidateHosts || candidateHosts.length === 0) {
		return fallback();
	}

	const hosts = validateListenHosts(candidateHosts, listSource);
	const urls =
		!envHostsRaw && document?.listenUrls && document.listenUrls.length > 0
			? [...document.listenUrls]
			: buildHubListenUrls(hosts, port, resolvedPathname);
	return {
		hosts,
		port,
		pathname: resolvedPathname,
		urls,
		source: envHostsRaw ? "env" : "file",
		configPath,
	};
}

/** The config file the daemon reads, so docs and diagnostics agree. */
export function hubConfigFilePath(
	env: NodeJS.ProcessEnv = process.env,
): string {
	return env[HUB_CONFIG_ENV]?.trim() || defaultHubConfigPath({ env });
}
