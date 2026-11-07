import { beforeAll, describe, expect, it, vi } from "vitest";
import { handleCommand } from "./commands";
import { createSidecarContext } from "./context";
import { LOCAL_ENVIRONMENT_ID, type SidecarContext } from "./types";

/**
 * Regression guard for the desktop "list_provider_catalog" command: the Hub
 * schema for `providers.list` is strict (`z.object({}).strict()` server-side),
 * so the request payload must be empty. A leftover `isClinePassEnabled` flag
 * made the Hub reject the command. The test also asserts the catalog keeps
 * reporting an already-saved provider credential so the settings view can show
 * it, without ever printing the credential value.
 */

type HubCommandCall = {
	name: string;
	input: Record<string, unknown>;
};

const providerCatalog = {
	settingsPath: "/tmp/test-provider-settings.json",
	providers: [
		{
			id: "cline",
			name: "Cline",
			models: 3,
			color: "#ffffff",
			letter: "C",
			enabled: true,
			configured: true,
			authDescription: "Sign in with Cline",
			baseUrlDescription: "Default",
			modelTools: [],
			auth: { fields: [] },
		},
		{
			id: "cline-pass",
			name: "ClinePass",
			models: 1,
			color: "#000000",
			letter: "P",
			enabled: true,
			configured: true,
			authDescription: "Sign in with Cline",
			baseUrlDescription: "Default",
			modelTools: [],
			auth: { fields: [] },
		},
		{
			id: "litellm",
			name: "LiteLLM",
			models: 2,
			color: "#123456",
			letter: "L",
			enabled: true,
			configured: true,
			defaultModelId: "deepseek-chat",
			authDescription: "API key",
			baseUrlDescription: "Endpoint",
			modelTools: [],
			auth: { fields: [] },
		},
	],
};

const hubCalls: HubCommandCall[] = [];

function createContext(): { ctx: SidecarContext } {
	const ctx = createSidecarContext("/local/workspace");
	const hubClient = {
		command: vi.fn(async (name: string, input: Record<string, unknown>) => {
			hubCalls.push({ name, input });
			if (name === "providers.list") {
				return { ok: true, payload: providerCatalog };
			}
			throw new Error(`unexpected hub command: ${name}`);
		}),
		getUrl: () => "ws://127.0.0.1:1234/hub",
	};
	ctx.runtimeBindings.set(LOCAL_ENVIRONMENT_ID, {
		hubClient,
	} as unknown as Parameters<typeof ctx.runtimeBindings.set>[1]);
	return { ctx };
}

beforeAll(() => {
	// Never reach a real hub / model provider from this test.
	vi.stubEnv("CLINE_DATA_DIR", "/tmp/cline-list-provider-catalog-test");
});

describe("desktop list_provider_catalog command", () => {
	it("sends no deprecated fields to providers.list", async () => {
		hubCalls.length = 0;
		const { ctx } = createContext();

		await handleCommand(ctx, "list_provider_catalog");

		expect(hubCalls.map((call) => call.name)).toEqual(["providers.list"]);
		const payload = hubCalls[0]?.input;
		expect(payload).toEqual({});
		// Strict Hub schema: any extra key is rejected, so assert absence too.
		expect(payload).not.toHaveProperty("isClinePassEnabled");
	});

	it("loads saved credentials and hides Cline billing providers", async () => {
		hubCalls.length = 0;
		const { ctx } = createContext();

		const result = (await handleCommand(ctx, "list_provider_catalog")) as {
			providers: Array<{
				id?: string;
				configured?: boolean;
				defaultModelId?: string;
			}>;
			settingsPath?: string;
		};

		expect(result.providers.map((provider) => provider.id)).toEqual([
			"litellm",
		]);
		expect(result.providers[0]?.configured).toBe(true);
		expect(result.providers[0]?.defaultModelId).toBe("deepseek-chat");
		expect(result.settingsPath).toBe(providerCatalog.settingsPath);
		// The Hub reply must be forwarded untouched apart from the filter.
		expect(JSON.stringify(hubCalls[0]?.input)).toBe("{}");
	});
});
