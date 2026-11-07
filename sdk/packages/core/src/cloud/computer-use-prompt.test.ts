import { describe, expect, it } from "vitest";
import { MODEL_COLLECTIONS_BY_PROVIDER_ID } from "@cline/llms";
import { cloudModelSupportsImages } from "./computer-use-prompt";

describe("cloudModelSupportsImages", () => {
	it("reports image support for a cloud model present in the bundled OpenRouter metadata", () => {
		expect(
			cloudModelSupportsImages("anthropic/claude-sonnet-4.5"),
		).toBe(true);
	});

	it("reports no image support for a bundled text-only cloud model", () => {
		expect(cloudModelSupportsImages("z-ai/glm-5.2")).toBe(false);
	});

	it("fails closed for models missing from the bundled catalog", () => {
		expect(cloudModelSupportsImages("model")).toBe(false);
	});

	it("resolves canonical cloud IDs through OpenRouter metadata, not the removed local cline collection", () => {
		const modelId = "anthropic/claude-sonnet-4.5";
		// The local `cline` collection no longer carries this canonical ID.
		expect(MODEL_COLLECTIONS_BY_PROVIDER_ID.cline?.models?.[modelId]).toBeUndefined();
		// But the retained OpenRouter metadata does, and it supports images.
		expect(MODEL_COLLECTIONS_BY_PROVIDER_ID.openrouter?.models?.[modelId]).toBeDefined();
		expect(cloudModelSupportsImages(modelId)).toBe(true);
	});
});
