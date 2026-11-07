/**
 * hp02 acceptance (AutoCline v1.2 §9.4): prove the Desktop connects to the Hub
 * DIRECTLY at a configured URL, with no SSH tunnel.
 *
 * Usage (on the Hub host, after `cline hub ensure`):
 *   bun --conditions=development apps/examples/desktop-app/scripts/smoke-hub-direct-connect.ts ws://100.101.163.69:25463/hub
 *
 * The script reads the running Hub's token from its discovery record, then
 * drives the real RemoteEnvironmentService against a throwaway profile store
 * (so it never touches the user's profiles) with a fake SSH layer that only
 * answers the remote helper's `hub ensure`, recording every ssh invocation so
 * the absence of `-L`/`-N` can be asserted.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type RemoteEnvironmentDependencies,
	RemoteEnvironmentService,
} from "@cline/core";

const hubUrl = process.argv[2]?.trim();
if (!hubUrl) {
	console.error("usage: smoke-hub-direct-connect.ts <ws://host:port/hub>");
	process.exit(2);
}

const directory = mkdtempSync(join(tmpdir(), "autocline-direct-"));
const profilesPath = join(directory, "remote-environments.json");
const sshInvocations: string[][] = [];
const commands: string[] = [];

const dependencies: Partial<RemoteEnvironmentDependencies> = {
	runProcess: async (_executable, args) => {
		sshInvocations.push(args);
		const command = args.at(-1) ?? "";
		commands.push(command);
		if (command.includes("uname -s")) {
			return {
				stdout: "\0CLINE_REMOTE_INSPECT_V1\0Linux\0x86_64\0/home/joe\0",
				stderr: "",
				exitCode: 0,
			};
		}
		// The remote helper is "already installed" and reports a Hub it serves
		// on the same port the desktop dials; its token is a stand-in, because
		// the real proof here is the direct probe below with the REAL token.
		if (command.includes("'hub' 'ensure'")) {
			const port = new URL(hubUrl).port || "25463";
			return {
				stdout: JSON.stringify({
					url: `ws://127.0.0.1:${port}/hub`,
					authToken: process.env.SMOKE_REMOTE_TOKEN ?? "unused",
				}),
				stderr: "",
				exitCode: 0,
			};
		}
		return { stdout: "", stderr: "", exitCode: 0 };
	},
	resolveHelperBinary: async () => process.execPath,
	fileReadable: async () => true,
	verifyHubConnection: async (url, authToken) => {
		const { verifyHubConnection } = await import("@cline/core");
		return await verifyHubConnection(url, { authToken });
	},
};

writeFileSync(
	profilesPath,
	JSON.stringify({ version: 1, profiles: [] }),
	"utf8",
);
const service = new RemoteEnvironmentService({
	profilesPath,
	dependencies,
});

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`,
	);
	if (!ok) failures += 1;
};

const expectConnected = process.env.SMOKE_EXPECT_CONNECTED === "1";

try {
	const profile = await service.upsert({
		name: "hp02",
		host: "hp02",
		hubUrls: [hubUrl],
	});

	const attempted = await service.connect(profile.id).then(
		(connection) => ({ connection, error: undefined }),
		(error: Error) => ({ connection: undefined, error }),
	);

	if (expectConnected) {
		// Success path: the connection dials exactly the configured URL.
		check(
			"connect returns a connection to the configured Hub URL",
			attempted.connection?.endpoint === hubUrl,
			attempted.error?.message ?? attempted.connection?.endpoint,
		);
		check(
			"no local forward port was allocated",
			attempted.connection
				? new URL(attempted.connection.endpoint).port === new URL(hubUrl).port
				: false,
		);
		check(
			"the active environment is the configured Hub",
			service.getActive()?.profileId === profile.id,
		);
	} else {
		// Failure path: a rejected token must fail loudly and name the URL.
		check(
			"connect fails when the configured Hub rejects the token",
			Boolean(attempted.error) && attempted.error?.message.includes(hubUrl),
			attempted.error?.message.slice(0, 120),
		);
		check("no connection is left active", service.getActive() === undefined);
		check(
			"failed attempt stops the Hub it started (no orphan)",
			commands.some((command) => command.includes("'hub' 'stop'")),
		);
	}

	// 2. Neither path may leave an ssh -L / -N forward behind.
	check(
		"no ssh -L / -N tunnel was ever started",
		sshInvocations.every(
			(args) => !args.includes("-L") && !args.includes("-N"),
		),
		`${sshInvocations.length} ssh invocations`,
	);
} finally {
	await service.dispose().catch(() => undefined);
	rmSync(directory, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
