import { describe, expect, it } from "vitest";
import {
	buildChildEnv,
	INLINED_BUILD_ENV_NAMES,
	sanitizeBuildEnv,
} from "./build-env-hygiene";

describe("sanitizeBuildEnv", () => {
	it("removes provider credentials the agent shell may carry", () => {
		const { env, removed } = sanitizeBuildEnv({
			PATH: "/usr/bin",
			LITELLM_API_KEY: "sk-litellm",
			LITELLM_BASE_URL: "http://127.0.0.1:4000/v1",
			ANTHROPIC_API_KEY: "sk-ant",
			OPENAI_API_KEY: "sk-openai",
			OPENROUTER_API_KEY: "sk-or",
			CLINE_API_KEY: "sk-cline",
			AWS_SECRET_ACCESS_KEY: "aws",
			GITHUB_TOKEN: "gh",
			SOME_SERVICE_PASSWORD: "pw",
		});
		expect(removed).toEqual([
			"ANTHROPIC_API_KEY",
			"AWS_SECRET_ACCESS_KEY",
			"CLINE_API_KEY",
			"GITHUB_TOKEN",
			"LITELLM_API_KEY",
			"LITELLM_BASE_URL",
			"OPENAI_API_KEY",
			"OPENROUTER_API_KEY",
			"SOME_SERVICE_PASSWORD",
		]);
		expect(env.LITELLM_API_KEY).toBeUndefined();
		expect(env.LITELLM_BASE_URL).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		// Non-credential configuration the build still needs survives.
		expect(env.PATH).toBe("/usr/bin");
	});

	it("keeps the ad-hoc signing identity the packaging script uses", () => {
		const { env, removed } = sanitizeBuildEnv({
			APPLE_SIGNING_IDENTITY: "-",
		});
		expect(removed).toEqual([]);
		expect(env.APPLE_SIGNING_IDENTITY).toBe("-");
	});

	it("never mutates or logs values", () => {
		const input = { OPENAI_API_KEY: "sk-openai", PATH: "/bin" };
		const snapshot = { ...input };
		const { removed } = sanitizeBuildEnv(input);
		expect(input).toEqual(snapshot);
		expect(removed.join()).not.toContain("sk-");
	});
});

describe("buildChildEnv", () => {
	it("drops a developer's telemetry key from a local build", () => {
		const { env, removed, inlined } = buildChildEnv({
			TELEMETRY_SERVICE_API_KEY: "tk",
			OTEL_TELEMETRY_ENABLED: "1",
			PATH: "/bin",
		});
		expect(env.TELEMETRY_SERVICE_API_KEY).toBeUndefined();
		expect(env.OTEL_TELEMETRY_ENABLED).toBeUndefined();
		expect(env.PATH).toBe("/bin");
		// A telemetry key is a credential; a toggle is not.
		expect(removed).toEqual(["TELEMETRY_SERVICE_API_KEY"]);
		expect(inlined).toEqual(["OTEL_TELEMETRY_ENABLED"]);
	});

	it("keeps the production telemetry config for a release build", () => {
		const { env, removed, inlined } = buildChildEnv(
			{
				AUTOCLINE_RELEASE_BUILD: "1",
				TELEMETRY_SERVICE_API_KEY: "tk",
				OTEL_TELEMETRY_ENABLED: "1",
				OPENAI_API_KEY: "sk-openai",
			},
			{ release: true },
		);
		expect(env.TELEMETRY_SERVICE_API_KEY).toBe("tk");
		expect(env.OTEL_TELEMETRY_ENABLED).toBe("1");
		// A provider key is still never a build input.
		expect(env.OPENAI_API_KEY).toBeUndefined();
		expect(removed).toEqual(["OPENAI_API_KEY"]);
		expect(inlined).toEqual([]);
	});

	it("never treats a provider credential as inline-able telemetry", () => {
		for (const name of INLINED_BUILD_ENV_NAMES) {
			expect(name).not.toMatch(/ANTHROPIC|OPENAI|OPENROUTER|LITELLM/);
		}
	});
});
