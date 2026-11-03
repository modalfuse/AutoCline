import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
	access,
	chmod,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { URL } from "node:url";
import { resolveClineDataDir } from "@cline/shared/storage";
import { requestHubShutdown, verifyHubConnection } from "../hub/client";

export interface RemoteEnvironmentProfile {
	id: string;
	name: string;
	/** SSH destination used for git/file operations on the remote host. */
	host: string;
	user?: string;
	port?: number;
	identityFile?: string;
	/**
	 * Stable Hub URLs the desktop dials directly, in priority order (typically
	 * the host's Tailscale address and, on the host itself, loopback). This is
	the ONLY Hub connection path: there is no SSH tunnel or localhost forward.
	 */
	hubUrls?: string[];
	/** Legacy single Hub URL; folded into `hubUrls` when the session starts. */
	hubUrl?: string;
	createdAt: string;
	updatedAt: string;
}

export interface RemoteEnvironmentInput {
	id?: string;
	name: string;
	host: string;
	user?: string;
	port?: number;
	identityFile?: string;
	hubUrls?: string[];
	hubUrl?: string;
}

export type RemoteEnvironmentState =
	| "disconnected"
	| "testing"
	| "available"
	| "connecting"
	| "connected"
	| "error";

export interface RemoteEnvironmentStatus {
	profileId: string;
	state: RemoteEnvironmentState;
	updatedAt: string;
	message?: string;
	remotePlatform?: "linux" | "darwin";
	remoteArch?: "x64" | "arm64";
	remoteHome?: string;
}

export interface RemoteEnvironmentConnection {
	profile: RemoteEnvironmentProfile;
	profileId: string;
	state: "connected";
	/** The configured Hub URL the desktop is dialing (direct, never a tunnel). */
	endpoint: string;
	authToken: string;
	workspaceRoot: string;
	homeDir: string;
	platform: "linux" | "darwin";
	arch: "x64" | "arm64";
	/** The Hub URL as seen from the remote host (same host as `endpoint`). */
	remoteHubUrl: string;
	/**
	 * Port of the Hub as bound on the remote host. Deprecated: kept for
	 * compatibility with clients that read it; no local forward exists.
	 */
	localPort: number;
	connectedAt: string;
}

export interface RemoteCommandInput {
	command: string;
	args: string[];
	cwd?: string;
}

export interface RemoteCommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface RemoteHelperTarget {
	platform: "linux" | "darwin";
	arch: "x64" | "arm64";
}

export interface RemoteProcessOptions {
	timeoutMs: number;
	inputFile?: string;
	/** Combined stdout/stderr limit; defaults to 8 MiB. */
	maxOutputBytes?: number;
}

interface RemoteInspection extends RemoteHelperTarget {
	home: string;
}

export interface RemoteEnvironmentDependencies {
	runProcess(
		executable: string,
		args: string[],
		options: RemoteProcessOptions,
	): Promise<RemoteCommandResult>;
	/**
	 * Probes a configured Hub URL directly with the token the remote helper
	 * published. There is no tunnel equivalent on purpose: a Hub the desktop
	 * cannot reach directly is an error, not something to route around.
	 */
	verifyHubConnection(url: string, authToken: string): Promise<boolean>;
	hashFile(path: string): Promise<string>;
	resolveHelperBinary(target: RemoteHelperTarget): Promise<string | undefined>;
	fileReadable(path: string): Promise<boolean>;
	requestHubShutdown(url: string, authToken?: string): Promise<boolean>;
	now(): Date;
	randomId(): string;
}

export interface RemoteEnvironmentServiceOptions {
	profilesPath?: string;
	sshPath?: string;
	knownHostsPath?: string;
	connectTimeoutSeconds?: number;
	commandTimeoutMs?: number;
	hubShutdownTimeoutMs?: number;
	helperBinaryPath?: string;
	helperBinaryDirectory?: string;
	env?: NodeJS.ProcessEnv;
	onStatusChange?: (status: RemoteEnvironmentStatus) => void;
	onConnectionLost?: (status: RemoteEnvironmentStatus) => void;
	dependencies?: Partial<RemoteEnvironmentDependencies>;
}

interface ProfilesFile {
	version: 1;
	profiles: RemoteEnvironmentProfile[];
}

interface PendingHubCleanup {
	profile: RemoteEnvironmentProfile;
	helper: string;
	discoveryPath: string;
}

interface SharedHubCredential {
	endpoint: string;
	authToken: string;
	home: string;
	platform: RemoteInspection["platform"];
	arch: RemoteInspection["arch"];
}

interface ManagedConnection {
	/**
	 * Present only when this client started a private remote Hub. Direct
	 * hubUrls connections reuse a durable shared Hub and must not stop it.
	 */
	cleanup?: PendingHubCleanup;
	/** False when dialing a pre-existing Hub named in hubUrls. */
	ownsRemoteHub: boolean;
	connection: RemoteEnvironmentConnection;
}

const PROFILE_FILE_VERSION = 1;
// ConnectTimeout also bounds the banner exchange, so behind a ProxyJump the
// whole bastion hop has to finish within it.
const DEFAULT_CONNECT_TIMEOUT_SECONDS = 30;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_HUB_SHUTDOWN_TIMEOUT_MS = 2_000;
const REMOTE_HELPER_DIRECTORY = ".cline/remote";
const REMOTE_INSPECTION_SENTINEL = "CLINE_REMOTE_INSPECT_V1";
const HUB_PROTOCOLS = new Set(["ws:", "wss:"]);

function normalizeHubUrl(raw: string | undefined): string | undefined {
	const trimmed = raw?.trim();
	if (!trimmed) {
		return undefined;
	}
	try {
		const parsed = new URL(trimmed);
		return HUB_PROTOCOLS.has(parsed.protocol) ? parsed.toString() : trimmed;
	} catch {
		return trimmed;
	}
}

function hasHubField(input: RemoteEnvironmentInput): boolean {
	return input.hubUrls !== undefined;
}

function normalizeHubUrlList(raw: string[] | undefined): string[] {
	const urls: string[] = [];
	for (const candidate of raw ?? []) {
		const normalized = normalizeHubUrl(candidate);
		if (normalized && !urls.includes(normalized)) {
			urls.push(normalized);
		}
	}
	return urls;
}

/**
 * The ordered Hub URLs a profile connects through (AutoCline §9.3.1): only the
 * configured `hubUrls`/`hubUrl`, de-duplicated. An empty list means the profile
 * is not Hub-mode, and connecting it is refused rather than tunnelled.
 */
export function resolveRemoteHubUrls(
	profile: Pick<RemoteEnvironmentProfile, "hubUrls" | "hubUrl">,
): string[] {
	const urls: string[] = [];
	for (const candidate of [...(profile.hubUrls ?? []), profile.hubUrl]) {
		const normalized = normalizeHubUrl(candidate);
		if (normalized && !urls.includes(normalized)) {
			urls.push(normalized);
		}
	}
	return urls;
}

function hubUrlPort(url: string | undefined): number {
	if (!url) {
		return 0;
	}
	try {
		const parsed = new URL(url);
		return parsed.port
			? Number(parsed.port)
			: parsed.protocol === "wss:"
				? 443
				: 80;
	} catch {
		return 0;
	}
}

export class RemoteEnvironmentService {
	private readonly profilesPath: string;
	private readonly sshPath: string;
	private readonly knownHostsPath?: string;
	private readonly connectTimeoutSeconds: number;
	private readonly commandTimeoutMs: number;
	private readonly hubShutdownTimeoutMs: number;
	/** Optional absolute helper path on the *remote* host (never uploaded). */
	private readonly remoteHelperOverridePath?: string;
	private readonly dependencies: RemoteEnvironmentDependencies;
	private readonly onStatusChange?: (status: RemoteEnvironmentStatus) => void;
	/**
	 * Kept for API compatibility. Direct Hub connections report a lost Hub
	 * through the status change (`onStatusChange`) instead, because the desktop
	 * observes the socket directly and there is no tunnel process to watch.
	 */
	protected readonly onConnectionLost?: (
		status: RemoteEnvironmentStatus,
	) => void;
	private readonly statuses = new Map<string, RemoteEnvironmentStatus>();
	private readonly connections = new Map<string, ManagedConnection>();
	/** Auth for durable hubUrls Hubs — skip SSH on reconnect when still valid. */
	private readonly sharedHubCredentialCache = new Map<
		string,
		SharedHubCredential
	>();
	private sharedHubCredentialHydrated = false;
	private activeProfileId: string | undefined;
	private mutationTail: Promise<void> = Promise.resolve();

	public constructor(options: RemoteEnvironmentServiceOptions = {}) {
		const env = options.env ?? process.env;
		const configuredHelper =
			options.helperBinaryPath ?? env.CLINE_REMOTE_HELPER_BINARY;
		const configuredHelperDirectory =
			options.helperBinaryDirectory ?? env.CLINE_REMOTE_HELPER_DIRECTORY;
		const defaults = createDefaultDependencies(
			configuredHelper,
			configuredHelperDirectory,
		);

		this.profilesPath =
			options.profilesPath ??
			join(resolveClineDataDir(), "settings", "remote-environments.json");
		this.sshPath = options.sshPath ?? env.CLINE_SSH_PATH ?? "ssh";
		this.knownHostsPath =
			options.knownHostsPath ?? env.CLINE_SSH_KNOWN_HOSTS_FILE;
		this.connectTimeoutSeconds =
			options.connectTimeoutSeconds ?? DEFAULT_CONNECT_TIMEOUT_SECONDS;
		this.commandTimeoutMs =
			options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
		this.hubShutdownTimeoutMs =
			options.hubShutdownTimeoutMs ?? DEFAULT_HUB_SHUTDOWN_TIMEOUT_MS;
		// Same env can name a local hash source *or* a pre-installed remote path;
		// ensureHelper only uses it after checking the remote with `test -x`.
		this.remoteHelperOverridePath =
			options.helperBinaryPath ?? env.CLINE_REMOTE_HELPER_BINARY;
		this.onStatusChange = options.onStatusChange;
		this.onConnectionLost = options.onConnectionLost;
		this.dependencies = { ...defaults, ...options.dependencies };
	}

	public async list(): Promise<RemoteEnvironmentProfile[]> {
		const profiles = await this.readProfiles();
		return profiles
			.map((profile) => ({ ...profile }))
			.sort(
				(left, right) =>
					left.name.localeCompare(right.name) ||
					left.id.localeCompare(right.id),
			);
	}

	public async upsert(
		input: RemoteEnvironmentInput,
	): Promise<RemoteEnvironmentProfile> {
		return this.withMutation(async () => {
			const normalized = normalizeInput(input);
			const profiles = await this.readProfiles();
			const existingIndex = input.id
				? profiles.findIndex((profile) => profile.id === input.id)
				: -1;
			const now = this.dependencies.now().toISOString();
			const existing = existingIndex >= 0 ? profiles[existingIndex] : undefined;
			if (existing) {
				assertProfileUpdateAllowed(
					existing,
					normalized,
					this.connections.has(existing.id),
				);
			}
			const profile: RemoteEnvironmentProfile = {
				// Hub URLs are only cleared when the caller explicitly sends an empty
				// list; a rename that omits them keeps the existing endpoints.
				...(existing?.hubUrls && !hasHubField(input)
					? { hubUrls: existing.hubUrls }
					: {}),
				...(existing?.hubUrl && input.hubUrl === undefined
					? { hubUrl: existing.hubUrl }
					: {}),
				...normalized,
				id: existing?.id ?? normalized.id ?? this.dependencies.randomId(),
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
			};

			if (existingIndex >= 0) {
				profiles[existingIndex] = profile;
			} else {
				profiles.push(profile);
			}
			await this.writeProfiles(profiles);
			const connected = this.connections.get(profile.id);
			if (
				connected &&
				profilesUseSameConnection(connected.connection.profile, profile)
			) {
				connected.connection = {
					...connected.connection,
					profile: { ...profile },
				};
			}
			return { ...profile };
		});
	}

	public async delete(id: string): Promise<boolean> {
		return this.withMutation(async () => {
			const profiles = await this.readProfiles();
			const remaining = profiles.filter((profile) => profile.id !== id);
			if (remaining.length === profiles.length) {
				return false;
			}

			await this.disconnectProfile(id);
			await this.writeProfiles(remaining);
			this.statuses.delete(id);
			return true;
		});
	}

	public async test(id: string): Promise<RemoteEnvironmentStatus> {
		const profile = await this.requireProfile(id);
		this.setStatus(id, "testing", "Testing SSH connection");
		try {
			const inspection = await this.inspectRemote(profile);
			return this.setStatus(
				id,
				"available",
				"SSH connection succeeded",
				inspection,
			);
		} catch (error) {
			return this.setStatus(id, "error", errorMessage(error));
		}
	}

	public connect(id: string): Promise<RemoteEnvironmentConnection> {
		return this.withMutation(() => this.connectProfile(id));
	}

	private async connectProfile(
		id: string,
	): Promise<RemoteEnvironmentConnection> {
		const profile = await this.requireProfile(id);
		// upsert() rejects host/user/port changes via assertProfileUpdateAllowed,
		// even while disconnected. A different destination needs a new profile,
		// so editing this profile cannot redirect it while old cleanup is pending.
		// Finish cleanup before starting another Hub; retries use the current SSH key.
		await this.retryPendingCleanup(id);
		const previousManaged = this.connections.get(id);
		const current = previousManaged?.connection;
		if (current && profilesUseSameConnection(current.profile, profile)) {
			this.activeProfileId = id;
			return { ...current, profile: { ...current.profile } };
		}

		this.setStatus(id, "connecting", "Connecting to remote environment");
		try {
			const hubUrls = resolveRemoteHubUrls(profile);
			if (hubUrls.length === 0) {
				throw new Error(
					`Remote environment "${profile.name}" has no hubUrls. AutoCline connects to the Hub directly at a configured URL ` +
						'(for example ws://100.101.163.69:25463/hub) and never opens an SSH tunnel; add "hubUrls" to the profile.',
				);
			}
			const endpoint = hubUrls[0] as string;

			await this.hydrateSharedHubCredentials();
			// Fast path: reuse a verified shared-Hub token — no SSH round-trips.
			const cached = this.sharedHubCredentialCache.get(id);
			if (
				cached &&
				cached.endpoint === endpoint &&
				(await this.dependencies.verifyHubConnection(
					endpoint,
					cached.authToken,
				))
			) {
				const connectedAt = this.dependencies.now().toISOString();
				const connection: RemoteEnvironmentConnection = {
					profile: { ...profile },
					profileId: id,
					state: "connected",
					endpoint,
					authToken: cached.authToken,
					workspaceRoot: cached.home,
					homeDir: cached.home,
					platform: cached.platform,
					arch: cached.arch,
					remoteHubUrl: `ws://127.0.0.1:${hubUrlPort(endpoint) || 25463}/hub`,
					localPort: hubUrlPort(endpoint),
					connectedAt,
				};
				const managed: ManagedConnection = {
					connection,
					ownsRemoteHub: false,
				};
				this.connections.set(id, managed);
				this.activeProfileId = id;
				this.setStatus(id, "connected", "Connected", {
					platform: cached.platform,
					arch: cached.arch,
					home: cached.home,
				});
				if (previousManaged && previousManaged !== managed) {
					const sameHub =
						previousManaged.connection.authToken === connection.authToken &&
						previousManaged.connection.endpoint === connection.endpoint;
					if (!sameHub) {
						await this.stopManagedHub(previousManaged);
					}
				}
				return { ...connection, profile: { ...connection.profile } };
			}

			// hubUrls mode: no helper ensure. Skip validateDirectory — inspect already
			// returned $HOME, which always exists. Two SSH calls remain (inspect +
			// auth lookup); reconnects hit the disk/memory credential cache above.
			const inspection = await this.inspectRemote(profile);
			const hub = await this.resolveSharedRemoteHub(
				profile,
				inspection.home,
				endpoint,
			);
			const remoteHubUrl = `ws://127.0.0.1:${hub.port}${hub.pathname}`;
			if (
				!(await this.dependencies.verifyHubConnection(endpoint, hub.authToken))
			) {
				throw new Error(
					`could not connect to ${endpoint}${hubUrls.length > 1 ? ` (also configured: ${hubUrls.slice(1).join(", ")})` : ""}`,
				);
			}

			await this.rememberSharedHubCredential(id, {
				endpoint,
				authToken: hub.authToken,
				home: inspection.home,
				platform: inspection.platform,
				arch: inspection.arch,
			});

			const connectedAt = this.dependencies.now().toISOString();
			const connection: RemoteEnvironmentConnection = {
				profile: { ...profile },
				profileId: id,
				state: "connected",
				endpoint,
				authToken: hub.authToken,
				workspaceRoot: inspection.home,
				homeDir: inspection.home,
				platform: inspection.platform,
				arch: inspection.arch,
				remoteHubUrl,
				localPort: hubUrlPort(endpoint),
				connectedAt,
			};
			const managed: ManagedConnection = {
				connection,
				ownsRemoteHub: false,
			};
			this.connections.set(id, managed);
			this.activeProfileId = id;
			this.setStatus(id, "connected", "Connected", inspection);
			if (previousManaged && previousManaged !== managed) {
				const sameHub =
					previousManaged.connection.authToken === connection.authToken &&
					previousManaged.connection.endpoint === connection.endpoint;
				if (!sameHub) {
					await this.stopManagedHub(previousManaged);
				}
			}
			return { ...connection, profile: { ...connection.profile } };
		} catch (error) {
			this.setStatus(id, "error", errorMessage(error));
			throw error;
		}
	}

	public disconnect(id?: string): Promise<boolean> {
		return this.withMutation(() => this.disconnectProfile(id));
	}

	private async disconnectProfile(id?: string): Promise<boolean> {
		const targetId = id ?? this.activeProfileId;
		if (!targetId) {
			return false;
		}
		const managed = this.connections.get(targetId);
		if (!managed) {
			await this.retryPendingCleanup(targetId);
			if (this.activeProfileId === targetId) {
				this.activeProfileId = undefined;
			}
			return false;
		}

		this.connections.delete(targetId);
		if (this.activeProfileId === targetId) {
			this.activeProfileId = undefined;
		}
		// Stand the connection down gracefully first. A Hub that vanished mid
		// session is reported as lost; otherwise this is a normal disconnect.
		const reachable = await this.stopManagedHub(managed);
		if (!reachable) {
			// Nothing could stop the Hub directly, so the owned remote Hub is
			// recorded for the SSH cleanup retry instead of being forgotten.
			if (managed.ownsRemoteHub && managed.cleanup) {
				await this.persistPendingCleanup(managed.cleanup).catch(() => undefined);
			}
			// The Hub is gone: report the loss so the UI stops showing a live
			// session instead of a clean disconnect it never asked for.
			const status = this.setStatus(
				targetId,
				"error",
				`Lost connection to the Hub at ${managed.connection.endpoint}`,
			);
			this.onConnectionLost?.(status);
			return true;
		}
		this.setStatus(targetId, "disconnected", "Disconnected");
		return true;
	}

	public getActive(): RemoteEnvironmentConnection | undefined {
		if (!this.activeProfileId) {
			return undefined;
		}
		return this.getConnection(this.activeProfileId);
	}

	public getConnection(id: string): RemoteEnvironmentConnection | undefined {
		const connection = this.connections.get(id)?.connection;
		return connection
			? { ...connection, profile: { ...connection.profile } }
			: undefined;
	}

	/**
	 * Marks an already-established direct Hub connection as active without
	 * doing any SSH work. A client uses this to roll back a host switch when
	 * the new Hub runtime cannot be initialized.
	 */
	public activateConnection(id: string): boolean {
		if (!this.connections.has(id)) {
			return false;
		}
		this.activeProfileId = id;
		return true;
	}

	public getStatuses(): RemoteEnvironmentStatus[] {
		return [...this.statuses.values()]
			.map((status) => ({ ...status }))
			.sort((left, right) => left.profileId.localeCompare(right.profileId));
	}

	public async run(
		id: string,
		input: RemoteCommandInput,
	): Promise<RemoteCommandResult> {
		const profile = await this.requireProfile(id);
		validateCommandInput(input);
		let cwd = input.cwd;
		if (!cwd) {
			cwd = this.connections.get(id)?.connection.workspaceRoot;
		}
		if (cwd) {
			const home =
				this.connections.get(id)?.connection.homeDir ??
				(await this.inspectRemote(profile)).home;
			cwd = resolveRemotePath(cwd, home);
		}
		return this.execRemote(profile, { ...input, cwd });
	}

	public dispose(): Promise<void> {
		return this.withMutation(async () => {
			// Resolve each connection's teardown when it is reached, not up front:
			// withMutation serializes operations, so a connection queued by an earlier
			// call may already be gone by the time this loop runs.
			for (const id of [...this.connections.keys()]) {
				await this.disconnectProfile(id);
			}
			// Every connection is gone, so nothing may stay "active".
			this.activeProfileId = undefined;
			await this.retryPendingCleanup();
		});
	}

	/**
	 * Resolve a helper already present on the remote host. AutoCline never
	 * uploads the ~180MB CLI binary over SSH: place it once under
	 * `~/.cline/remote/` (shared with stock Cline) or point
	 * `CLINE_REMOTE_HELPER_BINARY` at an executable path on the remote.
	 */
	private async ensureHelper(
		profile: RemoteEnvironmentProfile,
		inspection: RemoteInspection,
	): Promise<string> {
		const remoteDirectory = joinRemote(
			inspection.home,
			REMOTE_HELPER_DIRECTORY,
		);
		const prefix = `cline-${inspection.platform}-${inspection.arch}-`;
		let expectedHelper: string | undefined;

		const localHelper = await this.dependencies.resolveHelperBinary(inspection);
		if (localHelper && (await this.dependencies.fileReadable(localHelper))) {
			const hash = await this.dependencies.hashFile(localHelper);
			expectedHelper = joinRemote(
				remoteDirectory,
				`${prefix}${hash.slice(0, 16)}`,
			);
			const existing = await this.execRemoteAllowFailure(profile, {
				command: "test",
				args: ["-x", expectedHelper],
			});
			if (existing.exitCode === 0) {
				return expectedHelper;
			}
		}

		const reused = await this.findReusableRemoteHelper(
			profile,
			remoteDirectory,
			prefix,
		);
		if (reused) {
			if (expectedHelper && reused !== expectedHelper) {
				await this.linkRemoteHelper(
					profile,
					remoteDirectory,
					reused,
					expectedHelper,
				);
				return expectedHelper;
			}
			return reused;
		}

		const remoteOverride = this.remoteHelperOverridePath?.trim();
		if (remoteOverride) {
			const overrideOk = await this.execRemoteAllowFailure(profile, {
				command: "test",
				args: ["-x", remoteOverride],
			});
			if (overrideOk.exitCode === 0) {
				return remoteOverride;
			}
		}

		throw new Error(
			`No remote helper found for ${inspection.platform}/${inspection.arch} under ${remoteDirectory}. ` +
				"AutoCline never uploads the helper over SSH. Install the Cline CLI helper once on the remote " +
				`(or reuse the stock Cline helper already in ~/.cline/remote/), then reconnect. ` +
				"Optionally set CLINE_REMOTE_HELPER_BINARY to an executable path on the remote host.",
		);
	}

	/** Newest executable `cline-{platform}-{arch}-*` under the remote helper directory. */
	private async findReusableRemoteHelper(
		profile: RemoteEnvironmentProfile,
		remoteDirectory: string,
		prefix: string,
	): Promise<string | undefined> {
		// Use a brace group after the pipe so `exit` sets the pipeline status.
		// A bare `ls | while ...; done; exit 1` always exits 1 because `exit`
		// inside `while` only ends the pipe subshell, then the trailing `exit 1`
		// runs — which made every existing helper look missing.
		const script =
			`dir=${shellQuote(remoteDirectory)}; pref=${shellQuote(prefix)}; ` +
			'ls -1t "$dir"/"$pref"* 2>/dev/null | { ' +
			'while IFS= read -r f; do ' +
			'test -x "$f" || continue; test -d "$f" && continue; ' +
			`printf '%s\n' "$f"; exit 0; done; exit 1; }`;
		const listed = await this.execRemoteAllowFailure(profile, {
			command: "sh",
			args: ["-c", script],
		});
		if (listed.exitCode !== 0) {
			return undefined;
		}
		const candidate = listed.stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => line.length > 0);
		return candidate;
	}

	/** Point the content-addressed name at an already-installed helper (no upload). */
	private async linkRemoteHelper(
		profile: RemoteEnvironmentProfile,
		remoteDirectory: string,
		sourceHelper: string,
		targetHelper: string,
	): Promise<void> {
		await this.execRemote(profile, {
			command: "mkdir",
			args: ["-p", remoteDirectory],
		});
		await this.execRemote(profile, {
			command: "chmod",
			args: ["700", remoteDirectory],
		});
		const linkTarget =
			sourceHelper.startsWith(`${remoteDirectory}/`)
				? sourceHelper.slice(remoteDirectory.length + 1)
				: sourceHelper;
		await this.execRemote(profile, {
			command: "ln",
			args: ["-sfn", linkTarget, targetHelper],
		});
	}

	/**
	 * Asks the Hub to stop, reporting whether it was reachable: `false` means
	 * the desktop could not talk to it, which is how a lost Hub is noticed
	 * without a tunnel process to watch.
	 */
	private async stopManagedHub(managed: ManagedConnection): Promise<boolean> {
		// Shared Hubs named in hubUrls outlive the desktop session; only detach.
		if (!managed.ownsRemoteHub) {
			return true;
		}
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let reachable = true;
		try {
			await Promise.race([
				this.dependencies
					.requestHubShutdown(
						managed.connection.endpoint,
						managed.connection.authToken,
					)
					.catch(() => {
						reachable = false;
						return false;
					}),
				new Promise<boolean>((resolve) => {
					timeout = setTimeout(() => resolve(false), this.hubShutdownTimeoutMs);
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
		return reachable;
	}

	/**
	 * Reads the auth token of the durable Hub already listening at `endpoint`
	 * from the remote host's discovery records. Does not start or stop a Hub.
	 */
	private sharedHubCredentialsPath(): string {
		return `${this.profilesPath}.shared-hub-credentials.json`;
	}

	private async hydrateSharedHubCredentials(): Promise<void> {
		if (this.sharedHubCredentialHydrated) {
			return;
		}
		this.sharedHubCredentialHydrated = true;
		try {
			const raw = await readFile(this.sharedHubCredentialsPath(), "utf8");
			const parsed: unknown = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return;
			}
			for (const [id, value] of Object.entries(
				parsed as Record<string, unknown>,
			)) {
				if (!value || typeof value !== "object" || Array.isArray(value)) {
					continue;
				}
				const record = value as Record<string, unknown>;
				const endpoint =
					typeof record.endpoint === "string" ? record.endpoint.trim() : "";
				const authToken =
					typeof record.authToken === "string" ? record.authToken : "";
				const home = typeof record.home === "string" ? record.home : "";
				const platform = normalizePlatform(
					typeof record.platform === "string" ? record.platform : "",
				);
				const arch = normalizeArch(
					typeof record.arch === "string" ? record.arch : "",
				);
				if (!endpoint || !authToken || !home || !platform || !arch) {
					continue;
				}
				this.sharedHubCredentialCache.set(id, {
					endpoint,
					authToken,
					home,
					platform,
					arch,
				});
			}
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") {
				return;
			}
			// Corrupt cache must not block connect; fall through to SSH discovery.
		}
	}

	private async rememberSharedHubCredential(
		id: string,
		credential: SharedHubCredential,
	): Promise<void> {
		this.sharedHubCredentialCache.set(id, credential);
		const payload: Record<string, SharedHubCredential> = Object.fromEntries(
			this.sharedHubCredentialCache,
		);
		const path = this.sharedHubCredentialsPath();
		const directory = dirname(path);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const temporary = `${path}.${this.dependencies.randomId()}.tmp`;
		try {
			await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
				mode: 0o600,
			});
			await rename(temporary, path);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	private async resolveSharedRemoteHub(
		profile: RemoteEnvironmentProfile,
		home: string,
		endpoint: string,
	): Promise<{ port: number; pathname: string; authToken: string }> {
		const result = await this.execRemote(
			profile,
			remoteHubAuthLookupCommand(home, endpoint),
		);
		try {
			return parseRemoteHubResult(result.stdout);
		} catch (error) {
			throw new Error(
				`Could not find a running Hub discovery record for ${endpoint} on the remote host. ` +
					"Start the shared Hub there (for example `cline hub ensure --port 25463`) before connecting.",
				{ cause: error },
			);
		}
	}

	private async inspectRemote(
		profile: RemoteEnvironmentProfile,
	): Promise<RemoteInspection> {
		const script =
			`printf '\\000${REMOTE_INSPECTION_SENTINEL}\\000%s\\000%s\\000%s\\000' ` +
			'"$(uname -s)" "$(uname -m)" "$HOME"';
		const result = await this.execRemote(profile, {
			command: "sh",
			args: ["-c", script],
		});
		const fields = result.stdout.split("\0");
		const sentinelIndex = fields.lastIndexOf(REMOTE_INSPECTION_SENTINEL);
		const rawPlatform = fields[sentinelIndex + 1];
		const rawArch = fields[sentinelIndex + 2];
		const home = fields[sentinelIndex + 3] ?? "";
		if (sentinelIndex < 0 || fields[sentinelIndex + 4] !== "") {
			throw new Error("The SSH host returned an invalid inspection payload");
		}
		const platform = normalizePlatform(rawPlatform?.trim());
		const arch = normalizeArch(rawArch?.trim());
		if (!platform || !arch) {
			throw new Error(
				`Remote target ${rawPlatform || "unknown"}/${rawArch || "unknown"} is unsupported in SSH; ` +
					"only Linux and macOS on x64 or arm64 are supported.",
			);
		}
		if (!home.startsWith("/") || /[\0\r\n]/.test(home)) {
			throw new Error("The SSH host returned an invalid HOME directory");
		}
		return { platform, arch, home };
	}

	private async validateDirectory(
		profile: RemoteEnvironmentProfile,
		directory: string,
	): Promise<void> {
		const result = await this.execRemoteAllowFailure(profile, {
			command: "test",
			args: ["-d", directory],
		});
		if (result.exitCode !== 0) {
			throw new Error(
				`Remote directory does not exist or is not a directory: ${directory}`,
			);
		}
	}

	private async execRemote(
		profile: RemoteEnvironmentProfile,
		input: RemoteCommandInput,
	): Promise<RemoteCommandResult> {
		const result = await this.execRemoteAllowFailure(profile, input);
		if (result.exitCode !== 0) {
			throw processFailure(`run remote command ${input.command}`, result);
		}
		return result;
	}

	private async execRemoteAllowFailure(
		profile: RemoteEnvironmentProfile,
		input: RemoteCommandInput,
	): Promise<RemoteCommandResult> {
		validateCommandInput(input);
		const command = buildRemoteCommand(input.command, input.args, input.cwd);
		return this.dependencies.runProcess(
			this.sshPath,
			[...this.buildCommandArgs(profile), command],
			{ timeoutMs: this.commandTimeoutMs },
		);
	}

	// Like scp and sftp, one-shot commands skip the LocalForward/RemoteForward
	// an ssh_config alias declares; binding them would collide with the user's
	// own sessions to that alias.
	private buildCommandArgs(profile: RemoteEnvironmentProfile): string[] {
		return [
			...this.buildSshArgs(profile),
			"-o",
			"ClearAllForwardings=yes",
			this.destination(profile),
		];
	}

	private buildSshArgs(profile: RemoteEnvironmentProfile): string[] {
		const args = [
			"-o",
			"BatchMode=yes",
			"-o",
			`ConnectTimeout=${this.connectTimeoutSeconds}`,
			"-o",
			"StrictHostKeyChecking=yes",
		];
		if (profile.port) {
			args.push("-p", String(profile.port));
		}
		if (this.knownHostsPath) {
			args.push("-o", `UserKnownHostsFile=${this.knownHostsPath}`);
		}
		if (profile.identityFile) {
			args.push("-i", expandLocalHome(profile.identityFile));
		}
		return args;
	}

	private destination(profile: RemoteEnvironmentProfile): string {
		return profile.user ? `${profile.user}@${profile.host}` : profile.host;
	}

	private async requireProfile(id: string): Promise<RemoteEnvironmentProfile> {
		const profile = (await this.readProfiles()).find(
			(candidate) => candidate.id === id,
		);
		if (!profile) {
			throw new Error(`Remote environment profile not found: ${id}`);
		}
		return profile;
	}

	private setStatus(
		profileId: string,
		state: RemoteEnvironmentState,
		message?: string,
		inspection?: RemoteInspection,
	): RemoteEnvironmentStatus {
		const status: RemoteEnvironmentStatus = {
			profileId,
			state,
			updatedAt: this.dependencies.now().toISOString(),
			...(message ? { message } : {}),
			...(inspection
				? {
						remotePlatform: inspection.platform,
						remoteArch: inspection.arch,
						remoteHome: inspection.home,
					}
				: {}),
		};
		this.statuses.set(profileId, status);
		const snapshot = { ...status };
		this.onStatusChange?.(snapshot);
		return snapshot;
	}

	private async persistPendingCleanup(
		cleanup: PendingHubCleanup,
	): Promise<void> {
		const directory = `${this.profilesPath}.cleanup`;
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const key = createHash("sha256")
			.update(cleanup.discoveryPath)
			.digest("hex");
		const path = join(directory, `${key}.json`);
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			await writeFile(temporary, JSON.stringify(cleanup), { mode: 0o600 });
			await rename(temporary, path);
		} finally {
			await rm(temporary, { force: true });
		}
	}

	private async retryPendingCleanup(profileId?: string): Promise<void> {
		const directory = `${this.profilesPath}.cleanup`;
		let files: string[];
		try {
			files = await readdir(directory);
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") return;
			throw error;
		}
		const profiles = await this.readProfiles();
		for (const file of files.filter((file) => file.endsWith(".json"))) {
			const path = join(directory, file);
			const cleanup: PendingHubCleanup = JSON.parse(
				await readFile(path, "utf8"),
			);
			if (profileId && cleanup.profile.id !== profileId) continue;
			// An identity-file edit is allowed while disconnected; destination edits
			// are rejected by assertProfileUpdateAllowed. Use the current credentials
			// for retries, but still verify the destination before reusing them from
			// persisted state (the profile may have been removed or the file edited).
			const profile = profiles.find(
				(profile) =>
					profile.id === cleanup.profile.id &&
					profile.host === cleanup.profile.host &&
					profile.user === cleanup.profile.user &&
					profile.port === cleanup.profile.port,
			);
			const cleanupProfile = profile ?? cleanup.profile;
			const available = await this.execRemoteAllowFailure(cleanupProfile, {
				command: "test",
				args: ["-x", cleanup.helper],
			});
			// Cache removal must not strand the durable cleanup record. Restore
			// a compatible helper, still targeting the original owned discovery.
			const helper =
				available.exitCode === 0
					? cleanup.helper
					: await this.ensureHelper(
							cleanupProfile,
							await this.inspectRemote(cleanupProfile),
						);
			await this.execRemote(
				cleanupProfile,
				remoteHubStopCommand(helper, cleanup.discoveryPath),
			);
			await rm(path, { force: true });
		}
	}

	private async readProfiles(): Promise<RemoteEnvironmentProfile[]> {
		let raw: string;
		try {
			raw = await readFile(this.profilesPath, "utf8");
		} catch (error) {
			if (isNodeError(error) && error.code === "ENOENT") {
				return [];
			}
			throw error;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			throw new Error(
				`Failed to parse remote environment profiles at ${this.profilesPath}`,
				{ cause: error },
			);
		}
		if (!isProfilesFile(parsed)) {
			throw new Error(
				`Invalid remote environment profiles file at ${this.profilesPath}`,
			);
		}
		return parsed.profiles.map((profile) => ({ ...profile }));
	}

	private async writeProfiles(
		profiles: RemoteEnvironmentProfile[],
	): Promise<void> {
		const directory = dirname(this.profilesPath);
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const temporaryPath = join(
			directory,
			`.${this.dependencies.randomId()}.remote-environments.tmp`,
		);
		const payload: ProfilesFile = { version: PROFILE_FILE_VERSION, profiles };
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(temporaryPath, "wx", 0o600);
			await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
			await handle.sync();
			await handle.close();
			handle = undefined;
			await rename(temporaryPath, this.profilesPath);
			await chmod(this.profilesPath, 0o600);
		} catch (error) {
			await handle?.close().catch(() => undefined);
			await rm(temporaryPath, { force: true }).catch(() => undefined);
			throw error;
		}
	}

	private withMutation<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.mutationTail.then(operation, operation);
		this.mutationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

function createDefaultDependencies(
	configuredHelper?: string,
	configuredHelperDirectory?: string,
): RemoteEnvironmentDependencies {
	return {
		runProcess: runRemoteProcess,
		verifyHubConnection: (url, authToken) =>
			verifyHubConnection(url, { authToken }),
		hashFile,
		resolveHelperBinary: async (target) => {
			if (configuredHelper) {
				return configuredHelper;
			}
			const filename = remoteHelperBinaryFilename(target);
			const executableDirectory = dirname(process.execPath);
			const candidates = [
				...(configuredHelperDirectory
					? [join(configuredHelperDirectory, filename)]
					: []),
				join(executableDirectory, "remote-helpers", filename),
			];
			for (const candidate of candidates) {
				try {
					await access(candidate, constants.R_OK);
					return candidate;
				} catch {
					// Try the next packaged/development resource location.
				}
			}
			return undefined;
		},
		fileReadable: async (path) => {
			try {
				await access(path, constants.R_OK);
				return true;
			} catch {
				return false;
			}
		},
		requestHubShutdown,
		now: () => new Date(),
		randomId: randomUUID,
	};
}

/** File name of the Cline CLI binary built for `target`, as clients bundle it. */
export function remoteHelperBinaryFilename(target: RemoteHelperTarget): string {
	const triple =
		target.platform === "darwin"
			? target.arch === "arm64"
				? "aarch64-apple-darwin"
				: "x86_64-apple-darwin"
			: target.arch === "arm64"
				? "aarch64-unknown-linux-gnu"
				: "x86_64-unknown-linux-gnu";
	return `cline-${triple}`;
}

/**
 * SSH one-shot that prints discovery JSON for the Hub already listening at
 * `endpoint` (matched by exact URL in `urls`/`url`, else by port).
 */
function remoteHubAuthLookupCommand(
	home: string,
	endpoint: string,
): RemoteCommandInput {
	const script = [
		"import json,glob,sys",
		"endpoint=sys.argv[1]",
		"home=sys.argv[2]",
		"from urllib.parse import urlparse",
		"u=urlparse(endpoint)",
		"port=int(u.port or (443 if u.scheme in ('wss','https') else 80))",
		"paths=[]",
		"for pattern in (home+'/.cline/data/locks/hub/owners/*.json', home+'/.cline/data/remote/*.json'):",
		" paths.extend(sorted(glob.glob(pattern)))",
		"matched=None",
		"for path in paths:",
		" if path.endswith('.lock') or 'journal' in path or path.endswith('.instance.lock'):",
		"  continue",
		" try:",
		"  data=json.load(open(path))",
		" except Exception:",
		"  continue",
		" if not isinstance(data,dict) or not data.get('authToken'):",
		"  continue",
		" urls=list(data.get('urls') or [])",
		" if data.get('url'): urls.append(data['url'])",
		" if endpoint in urls or data.get('port')==port:",
		"  matched=data; break",
		"if not matched:",
		" sys.stderr.write('no hub discovery for '+endpoint+'\\n'); sys.exit(1)",
		"print(json.dumps({'url': matched.get('url') or ('ws://127.0.0.1:%d/hub'%port), 'port': matched.get('port') or port, 'pathname': '/hub', 'authToken': matched['authToken']}))",
	].join("\n")
	return {
		command: "python3",
		args: ["-c", script, endpoint, home],
	};
}

const LEGACY_REMOTE_HELPER_PREFIX = "cline-remote-helper-";

function remoteHubStopCommand(
	cli: string,
	discoveryPath: string,
): RemoteCommandInput {
	// Cleanup records persisted by earlier releases name the dedicated helper
	// binary they staged, which only understands its own stop flag.
	if (basename(cli).startsWith(LEGACY_REMOTE_HELPER_PREFIX)) {
		return {
			command: cli,
			args: ["--remote-hub-stop", "--discovery-path", discoveryPath],
		};
	}
	return {
		command: "env",
		args: [
			"CLINE_NO_AUTO_UPDATE=1",
			cli,
			"hub",
			"stop",
			"--discovery-path",
			discoveryPath,
		],
	};
}

export async function runRemoteProcess(
	executable: string,
	args: string[],
	options: RemoteProcessOptions,
): Promise<RemoteCommandResult> {
	const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
	if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1)
		throw new Error("maxOutputBytes must be a positive integer");
	return new Promise((resolve, reject) => {
		const child = spawn(executable, args, {
			stdio: [options.inputFile ? "pipe" : "ignore", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let bytes = 0;
		let settled = false;
		let failure: Error | undefined;
		let input: ReturnType<typeof createReadStream> | undefined;
		let escalation: ReturnType<typeof setTimeout> | undefined;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		const stopInput = () => {
			input?.destroy();
			child.stdin?.destroy();
		};
		const signalTree = (signal: NodeJS.Signals) => {
			if (!child.pid) return;
			if (process.platform === "win32") {
				// taskkill includes ProxyCommand descendants; child.kill alone does not.
				const killer = spawn(
					"taskkill",
					["/pid", String(child.pid), "/T", "/F"],
					{ stdio: "ignore" },
				);
				killer.on("error", () => child.kill(signal));
			} else {
				try {
					process.kill(-child.pid, signal);
				} catch {
					child.kill(signal);
				}
			}
		};
		const finish = (error?: Error, code?: number) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearTimeout(escalation);
			clearTimeout(deadline);
			stopInput();
			child.stdout?.destroy();
			child.stderr?.destroy();
			if (error) reject(error);
			else if (
				code === 0 &&
				options.inputFile &&
				!child.stdin?.writableFinished
			)
				reject(new Error(`${executable} exited before the upload completed`));
			else
				resolve({
					stdout: Buffer.concat(stdout).toString("utf8"),
					stderr: Buffer.concat(stderr).toString("utf8"),
					exitCode: code ?? 1,
				});
		};
		const terminate = (error: Error) => {
			if (settled || failure) return;
			failure = error;
			stopInput();
			signalTree("SIGTERM");
			escalation = setTimeout(() => {
				signalTree("SIGKILL");
				// An inherited pipe must not keep cleanup waiting forever.
				deadline = setTimeout(() => finish(failure), 500);
			}, 500);
		};
		const timer = setTimeout(
			() =>
				terminate(
					new Error(`${executable} timed out after ${options.timeoutMs}ms`),
				),
			options.timeoutMs,
		);
		const capture = (target: Buffer[], chunk: Buffer) => {
			if (settled || failure) return;
			bytes += chunk.length;
			if (bytes > maxOutputBytes) {
				terminate(
					new Error(`${executable} output exceeded ${maxOutputBytes} bytes`),
				);
				return;
			}
			target.push(chunk);
		};
		child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk));
		child.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk));
		child.once("error", (error) => terminate(error));
		// Drain late ProxyCommand diagnostics before resolving a successful command.
		child.once("close", (code, signal) =>
			finish(
				failure ??
					(signal
						? new Error(`${executable} exited from signal ${signal}`)
						: undefined),
				code ?? 1,
			),
		);
		if (options.inputFile && child.stdin) {
			input = createReadStream(options.inputFile);
			// ssh exiting mid-upload surfaces here as EPIPE; its exit code and
			// stderr explain why, so stop writing and let it close.
			child.stdin.on("error", stopInput);
			input.once("error", terminate);
			input.pipe(child.stdin);
		}
	});
}

async function hashFile(path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.once("error", reject);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.once("end", () => resolve(hash.digest("hex")));
	});
}

function normalizeInput(input: RemoteEnvironmentInput): Omit<
	RemoteEnvironmentProfile,
	"id" | "createdAt" | "updatedAt"
> & {
	id?: string;
} {
	const name = input.name.trim();
	const host = input.host.trim();
	const user = input.user?.trim() || undefined;
	const identityFile = input.identityFile?.trim() || undefined;
	if (!name) {
		throw new Error("Remote environment name is required");
	}
	if (!host || host.startsWith("-") || /[\s\0]/.test(host)) {
		throw new Error(
			"SSH host must be a hostname, address, or SSH config alias without whitespace",
		);
	}
	if (user && (!/^[A-Za-z0-9._-]+$/.test(user) || user.startsWith("-"))) {
		throw new Error("SSH user contains unsupported characters");
	}
	if (
		input.port !== undefined &&
		(!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535)
	) {
		throw new Error("SSH port must be an integer between 1 and 65535");
	}
	if (identityFile && /[\0\r\n]/.test(identityFile)) {
		throw new Error("SSH identity file cannot contain newlines or NUL bytes");
	}
	if (input.id && /[\0\r\n]/.test(input.id)) {
		throw new Error("Remote environment id is invalid");
	}
	const hubUrls = normalizeHubUrlList(input.hubUrls);
	const hubUrl = normalizeHubUrl(input.hubUrl);
	return {
		id: input.id,
		name,
		host,
		...(user ? { user } : {}),
		...(input.port ? { port: input.port } : {}),
		...(identityFile ? { identityFile } : {}),
		...(hubUrls.length > 0 ? { hubUrls } : {}),
		...(hubUrl ? { hubUrl } : {}),
	};
}

function profilesUseSameConnection(
	left: RemoteEnvironmentProfile,
	right: RemoteEnvironmentProfile,
): boolean {
	return (
		left.host === right.host &&
		left.user === right.user &&
		left.port === right.port &&
		left.identityFile === right.identityFile
	);
}

function assertProfileUpdateAllowed(
	existing: RemoteEnvironmentProfile,
	next: Pick<
		RemoteEnvironmentProfile,
		"host" | "user" | "port" | "identityFile"
	>,
	connected: boolean,
): void {
	if (
		existing.host !== next.host ||
		existing.user !== next.user ||
		existing.port !== next.port
	) {
		throw new Error(
			"SSH host, user, and port cannot be changed for an existing remote environment. Create a new remote environment instead.",
		);
	}
	if (connected && existing.identityFile !== next.identityFile) {
		throw new Error(
			"Disconnect the remote environment before changing its SSH identity file.",
		);
	}
}

function validateCommandInput(input: RemoteCommandInput): void {
	if (!input.command || /[\0\r\n]/.test(input.command)) {
		throw new Error(
			"Remote command must be non-empty and cannot contain newlines or NUL bytes",
		);
	}
	if (
		!Array.isArray(input.args) ||
		input.args.some(
			(argument) => typeof argument !== "string" || argument.includes("\0"),
		)
	) {
		throw new Error(
			"Remote command arguments must be strings without NUL bytes",
		);
	}
	if (input.cwd && /[\0\r\n]/.test(input.cwd)) {
		throw new Error(
			"Remote working directory cannot contain newlines or NUL bytes",
		);
	}
}

function buildRemoteCommand(
	command: string,
	args: string[],
	cwd?: string,
): string {
	const invocation = [command, ...args].map(shellQuote).join(" ");
	return cwd
		? `cd ${shellQuote(cwd)} && exec ${invocation}`
		: `exec ${invocation}`;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function resolveRemotePath(path: string, home: string): string {
	const resolved =
		path === "~"
			? home
			: path.startsWith("~/")
				? joinRemote(home, path.slice(2))
				: path;
	if (!resolved.startsWith("/") || /[\0\r\n]/.test(resolved)) {
		throw new Error(`Remote path must be absolute or start with ~/: ${path}`);
	}
	return resolved;
}

function joinRemote(base: string, suffix: string): string {
	return `${base.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

function normalizePlatform(
	value: string | undefined,
): "linux" | "darwin" | undefined {
	if (value?.toLowerCase() === "linux") {
		return "linux";
	}
	if (value?.toLowerCase() === "darwin") {
		return "darwin";
	}
	return undefined;
}

function normalizeArch(value: string | undefined): "x64" | "arm64" | undefined {
	switch (value?.toLowerCase()) {
		case "x86_64":
		case "amd64":
			return "x64";
		case "aarch64":
		case "arm64":
			return "arm64";
		default:
			return undefined;
	}
}

function parseRemoteHubResult(stdout: string): {
	port: number;
	pathname: string;
	authToken: string;
} {
	const lines = stdout.trim().split("\n").filter(Boolean);
	let parsed: unknown;
	try {
		parsed = JSON.parse(lines.at(-1) ?? "");
	} catch (error) {
		throw new Error(
			"Remote remote helper returned invalid hub discovery JSON",
			{ cause: error },
		);
	}
	if (!parsed || typeof parsed !== "object") {
		throw new Error("Remote remote helper returned invalid hub discovery data");
	}
	const record = parsed as Record<string, unknown>;
	if (typeof record.authToken !== "string" || !record.authToken) {
		throw new Error("Remote remote helper did not return a hub auth token");
	}

	let port = typeof record.port === "number" ? record.port : undefined;
	let pathname = typeof record.pathname === "string" ? record.pathname : "/hub";
	if (typeof record.url === "string") {
		let url: URL;
		try {
			url = new URL(record.url);
		} catch (error) {
			throw new Error("Remote remote helper returned an invalid hub URL", {
				cause: error,
			});
		}
		if (
			!isLoopbackHost(url.hostname) ||
			!["ws:", "wss:", "http:", "https:"].includes(url.protocol)
		) {
			throw new Error("Remote remote helper hub URL must use a loopback host");
		}
		port = Number(
			url.port ||
				(url.protocol === "https:" || url.protocol === "wss:" ? 443 : 80),
		);
		pathname = url.pathname || "/hub";
	}
	if (!Number.isInteger(port) || (port ?? 0) < 1 || (port ?? 0) > 65_535) {
		throw new Error("Remote remote helper returned an invalid hub port");
	}
	if (!pathname.startsWith("/") || /[\0\r\n]/.test(pathname)) {
		throw new Error("Remote remote helper returned an invalid hub path");
	}
	return { port: port as number, pathname, authToken: record.authToken };
}

function isLoopbackHost(host: string): boolean {
	return (
		host === "127.0.0.1" ||
		host === "localhost" ||
		host === "::1" ||
		host === "[::1]"
	);
}

function processFailure(action: string, result: RemoteCommandResult): Error {
	const stderr = result.stderr.trim();
	const stdout = result.stdout.trim();
	const details = [
		...(stderr ? [`stderr:\n${stderr}`] : []),
		...(stdout ? [`stdout:\n${stdout}`] : []),
	];
	return new Error(
		`Failed to ${action} (exit ${result.exitCode})${
			details.length > 0 ? `:\n${details.join("\n")}` : ""
		}`,
	);
}

function expandLocalHome(path: string): string {
	return path === "~"
		? homedir()
		: path.startsWith("~/")
			? join(homedir(), path.slice(2))
			: path;
}

function isProfilesFile(value: unknown): value is ProfilesFile {
	if (!value || typeof value !== "object") {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		record.version === PROFILE_FILE_VERSION &&
		Array.isArray(record.profiles) &&
		record.profiles.every(isProfile)
	);
}

function isProfile(value: unknown): value is RemoteEnvironmentProfile {
	if (!value || typeof value !== "object") {
		return false;
	}
	const profile = value as Record<string, unknown>;
	return (
		typeof profile.id === "string" &&
		typeof profile.name === "string" &&
		typeof profile.host === "string" &&
		(profile.user === undefined || typeof profile.user === "string") &&
		(profile.port === undefined || typeof profile.port === "number") &&
		(profile.identityFile === undefined ||
			typeof profile.identityFile === "string") &&
		typeof profile.createdAt === "string" &&
		typeof profile.updatedAt === "string"
	);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
