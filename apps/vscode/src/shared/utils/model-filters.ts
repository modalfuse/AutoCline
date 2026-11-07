/**
 * Filters OpenRouter model IDs based on provider-specific rules.
 * Excludes Cline-specific models (e.g. `cline/...` catalog entries) from the
 * OpenRouter and Vercel AI Gateway pickers.
 * @param modelIds Array of model IDs to filter
 * @returns Filtered array of model IDs
 */
export function filterOpenRouterModelIds(modelIds: string[]): string[] {
	return modelIds.filter((id) => !id.startsWith("cline/"))
}
