import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	adoptDesktopCliRuntime,
	applyDesktopHubDefaults,
	DESKTOP_HUB_PORT,
	ensureHubWithDesktopCli,
	resolveDesktopHubDiscoveryPath,
} from "./cli-runtime";
import { resolveClineDataDir } from "@cline/shared/storage";

describe("ensureHubWithDesktopCli", () => {
	it("asks the bundled CLI to start or reuse the Hub and returns only its URL", async () => {
		const run = vi.fn(
			async () =>
				'warming up\n{"url":"ws://127.0.0.1:25463/hub","authToken":"secret","cwd":"/work"}\n',
		);

		await expect(
			ensureHubWithDesktopCli("/opt/cline/cline-cli", "/work", {
				env: { PATH: "/usr/bin" },
				run,
			}),
		).resolves.toEqual({ url: "ws://127.0.0.1:25463/hub" });
		expect(run).toHaveBeenCalledWith(
			"/opt/cline/cline-cli",
			["hub", "ensure", "--json", "--cwd", "/work"],
			{
				cwd: "/work",
				env: {
					PATH: "/usr/bin",
					CLINE_NO_AUTO_UPDATE: "1",
					CLINE_HUB_LAUNCHER_CLIENT: "cline-desktop",
					CLINE_HUB_LAUNCHER_VERSION: expect.stringMatching(/^\d+\.\d+\.\d+/),
					CLINE_HUB_LAUNCHER_TRANSPORT: "local",
				},
				timeoutMs: 60_000,
			},
		);
	});

	it("passes an explicitly configured port and discovery record to the child CLI", async () => {
		// The packaged backend inherits CLINE_HUB_PORT / CLINE_HUB_DISCOVERY_PATH,
		// but the launcher identity can make the child CLI resolve different owner
		// defaults (e.g. 25465 instead of the configured port). The configured
		// endpoint must therefore travel as supported CLI options, not only env.
		const run = vi.fn(
			async () =>
				'{"url":"ws://127.0.0.1:52443/hub","authToken":"secret","cwd":"/work"}\n',
		);
		const discoveryPath = "/tmp/autocline-test/locks/hub/autocline/production.json";

		await expect(
			ensureHubWithDesktopCli("/opt/cline/cline-cli", "/work", {
				env: {
					PATH: "/usr/bin",
					CLINE_HUB_PORT: "52443",
					CLINE_HUB_DISCOVERY_PATH: discoveryPath,
				},
				run,
			}),
		).resolves.toEqual({ url: "ws://127.0.0.1:52443/hub" });
		expect(run).toHaveBeenCalledWith(
			"/opt/cline/cline-cli",
			[
				"hub",
				"ensure",
				"--json",
				"--cwd",
				"/work",
				"--port",
				"52443",
				"--discovery-path",
				discoveryPath,
			],
			{
				cwd: "/work",
				env: {
					PATH: "/usr/bin",
					CLINE_NO_AUTO_UPDATE: "1",
					CLINE_HUB_PORT: "52443",
					CLINE_HUB_DISCOVERY_PATH: discoveryPath,
					CLINE_HUB_LAUNCHER_CLIENT: "cline-desktop",
					CLINE_HUB_LAUNCHER_VERSION: expect.stringMatching(/^\d+\.\d+\.\d+/),
					CLINE_HUB_LAUNCHER_TRANSPORT: "local",
				},
				timeoutMs: 60_000,
			},
		);
	});

	it("passes each configured endpoint option independently", async () => {
		const run = vi.fn(async () => '{"url":"ws://127.0.0.1:52443/hub"}\n');

		await ensureHubWithDesktopCli("/opt/cline/cline-cli", "/work", {
			env: { CLINE_HUB_PORT: "52443" },
			run,
		});
		expect(run.mock.calls[0]?.[1]).toContain("--port");
		expect(run.mock.calls[0]?.[1]).not.toContain("--discovery-path");

		run.mockClear();
		await ensureHubWithDesktopCli("/opt/cline/cline-cli", "/work", {
			env: { CLINE_HUB_DISCOVERY_PATH: "/tmp/custom/production.json" },
			run,
		});
		expect(run.mock.calls[0]?.[1]).not.toContain("--port");
		expect(run.mock.calls[0]?.[1]).toContain("--discovery-path");
	});

	it("rejects when the CLI does not report a Hub URL", async () => {
		await expect(
			ensureHubWithDesktopCli("/opt/cline/cline-cli", "/work", {
				env: {},
				run: async () => "",
			}),
		).rejects.toThrow("did not report a Hub URL");
	});
});

describe("applyDesktopHubDefaults", () => {
	it("gives the desktop its own loopback port and discovery record", () => {
		const env: NodeJS.ProcessEnv = {};

		applyDesktopHubDefaults(env);

		// Not the official Cline Hub (25463) nor its discovery record
		// (`~/.cline/locks/hub/production.json`).
		expect(DESKTOP_HUB_PORT).toBe(25465);
		expect(env.CLINE_HUB_PORT).toBe("25465");
		expect(env.CLINE_HUB_DISCOVERY_PATH).toBe(
			resolveDesktopHubDiscoveryPath(env),
		);
		// Same data dir the Hub itself uses, with the official record name
		// shifted into its own `autocline/` directory.
		expect(env.CLINE_HUB_DISCOVERY_PATH).toBe(
			join(
				resolveClineDataDir(),
				"locks",
				"hub",
				"autocline",
				"production.json",
			),
		);
		expect(
			resolveDesktopHubDiscoveryPath(
				{},
				join("/tmp/autocline-data"),
			),
		).toBe(
			join(
				"/tmp/autocline-data",
				"locks",
				"hub",
				"autocline",
				"production.json",
			),
		);
		expect(env.CLINE_HUB_DISCOVERY_PATH).not.toBe(
			join(resolveClineDataDir(), "locks", "hub", "production.json"),
		);
	});

	it("honors an explicit port and discovery path override", () => {
		const env: NodeJS.ProcessEnv = {
			CLINE_HUB_PORT: "31111",
			CLINE_HUB_DISCOVERY_PATH: "/tmp/custom/production.json",
		};

		applyDesktopHubDefaults(env);

		expect(env.CLINE_HUB_PORT).toBe("31111");
		expect(env.CLINE_HUB_DISCOVERY_PATH).toBe("/tmp/custom/production.json");
	});

	it("fills in only the missing half when one knob is overridden", () => {
		const env: NodeJS.ProcessEnv = { CLINE_HUB_PORT: "31111" };

		applyDesktopHubDefaults(env);

		expect(env.CLINE_HUB_PORT).toBe("31111");
		expect(env.CLINE_HUB_DISCOVERY_PATH).toBe(resolveDesktopHubDiscoveryPath(env));
	});

	it("does not lend the desktop Hub daemon the official record it would replace", () => {
		// The desktop bundles its own `cline-cli`, so `hub ensure` would launch a
		// daemon of this build. Pointed at the official record, that daemon would
		// attach to - or replace - the user's Cline.app Hub when the versions
		// differ. The adopted discovery path must therefore not be the official one.
		const official = join(resolveClineDataDir(), "locks", "hub", "production.json");
		const env: NodeJS.ProcessEnv = { PATH: "/usr/bin" };

		applyDesktopHubDefaults(env);

		expect(env.CLINE_HUB_DISCOVERY_PATH).not.toBe(official);
		expect(env.CLINE_HUB_DISCOVERY_PATH?.startsWith(resolveClineDataDir())).toBe(
			true,
		);
	});

	it("leaves the official discovery record name untouched", () => {
		const env: NodeJS.ProcessEnv = {};

		applyDesktopHubDefaults(env);

		expect(env.CLINE_HUB_DISCOVERY_PATH?.endsWith("/locks/hub/autocline/production.json")).toBe(
			true,
		);
	});

});

describe("adoptDesktopCliRuntime", () => {
	it("routes Hub spawns through the bundled CLI and restores the workspace cwd", () => {
		const env: NodeJS.ProcessEnv = {
			BUN_BE_BUN: "1",
			CLINE_DESKTOP_CLI_PATH:
				"/Applications/Cline.app/Contents/MacOS/cline-cli",
			CLINE_DESKTOP_WORKSPACE_ROOT: "/Users/dev/project",
		};
		const chdir = vi.fn();
		const setLauncher = vi.fn();
		const setPluginLauncher = vi.fn();

		expect(
			adoptDesktopCliRuntime({ env, chdir, setLauncher, setPluginLauncher }),
		).toEqual({
			cliPath: "/Applications/Cline.app/Contents/MacOS/cline-cli",
		});

		expect(env.BUN_BE_BUN).toBeUndefined();
		expect(env.CLINE_DESKTOP_WORKSPACE_ROOT).toBeUndefined();
		expect(env.CLINE_DESKTOP_CLI_PATH).toBe(
			"/Applications/Cline.app/Contents/MacOS/cline-cli",
		);
		expect(chdir).toHaveBeenCalledWith("/Users/dev/project");
		expect(setPluginLauncher).toHaveBeenCalledWith({
			command: env.CLINE_DESKTOP_CLI_PATH,
			argsPrefix: ["--plugin-sandbox"],
		});
		expect(setLauncher).toHaveBeenCalledWith({
			command: "/Applications/Cline.app/Contents/MacOS/cline-cli",
		});
	});

	it("keeps the default Hub launcher when no bundled CLI is provided", () => {
		const chdir = vi.fn();
		const setLauncher = vi.fn();
		const setPluginLauncher = vi.fn();

		expect(
			adoptDesktopCliRuntime({
				env: {},
				chdir,
				setLauncher,
				setPluginLauncher,
			}),
		).toEqual({
			cliPath: undefined,
		});
		expect(chdir).not.toHaveBeenCalled();
		expect(setLauncher).not.toHaveBeenCalled();
		expect(setPluginLauncher).not.toHaveBeenCalled();
	});
});
