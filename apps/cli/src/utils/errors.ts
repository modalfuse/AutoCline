/**
 * Formats an error for display in the CLI.
 *
 * Historically this also rewrote Cline provider / ClinePass subscription and
 * free-model limit errors into friendlier copy. Those providers were removed,
 * so the message is returned as-is.
 */
export function formatCliErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}
