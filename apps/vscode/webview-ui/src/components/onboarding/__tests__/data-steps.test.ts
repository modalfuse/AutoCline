import { describe, expect, it } from "vitest"
import { getUserTypeSelections, NEW_USER_TYPE } from "../data-steps"

describe("getUserTypeSelections", () => {
	it("leads with the free option, then frontier models, then BYOK", () => {
		const selections = getUserTypeSelections()
		expect(selections.map((s) => s.type)).toEqual([NEW_USER_TYPE.FREE, NEW_USER_TYPE.POWER, NEW_USER_TYPE.BYOK])
	})
})
