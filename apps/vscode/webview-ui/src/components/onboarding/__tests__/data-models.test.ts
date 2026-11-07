import type { OnboardingModel, OnboardingModelGroup } from "@shared/proto/cline/state"
import { describe, expect, it } from "vitest"
import { getClineUIOnboardingGroups, getRecommendedModelsData } from "../data-models"

function model(id: string, group: string): OnboardingModel {
	return {
		id,
		name: id,
		group,
		badge: "",
		score: 0,
		latency: 0,
		info: undefined,
	} as OnboardingModel
}

function groupOf(models: OnboardingModel[]): OnboardingModelGroup {
	return { models } as OnboardingModelGroup
}

describe("getClineUIOnboardingGroups", () => {
	it("buckets free and frontier/open-source models", () => {
		const result = getClineUIOnboardingGroups(
			groupOf([model("free-model", "free"), model("anthropic/claude", "frontier"), model("z-ai/glm", "open source")]),
		)

		expect(result.free[0].models.map((m) => m.id)).toEqual(["free-model"])
		expect(result.power.flatMap((g) => g.models.map((m) => m.id))).toEqual(["anthropic/claude", "z-ai/glm"])
	})

	it("returns empty groups when no models are present", () => {
		const result = getClineUIOnboardingGroups(groupOf([]))
		expect(result.free).toEqual([])
		expect(result.power).toEqual([])
	})
})

describe("getRecommendedModelsData", () => {
	it("keeps recommended/free responses", () => {
		const result = getRecommendedModelsData({
			recommended: [{ id: "anthropic/claude", name: "Claude", description: "", tags: [] }],
			free: [{ id: "free-model", name: "Free", description: "", tags: [] }],
		})

		expect(result?.recommended.map((m) => m.id)).toEqual(["anthropic/claude"])
		expect(result?.free.map((m) => m.id)).toEqual(["free-model"])
	})

	it("returns undefined when every recommended bucket is empty", () => {
		expect(getRecommendedModelsData({ recommended: [], free: [] })).toBeUndefined()
	})
})
