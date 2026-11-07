export const CLINE_WORKSPACES_DIRECTORY_NAME = "workspaces";
export const CLINE_CHAT_WORKSPACE_DIRECTORY_NAME = "chat";

// Default data-dir anchors for the structural check below. The Node resolver
// derives the real location from resolveClineDataDir(), which defaults to
// `~/.cline/data`.
const CLINE_CONFIG_DIRECTORY_NAME = ".cline";
// AutoCline keeps its own state beside the official app's root; both are
// app-internal, so the chat workspace under either must not be offered as a
// user project.
const AUTOCLINE_CONFIG_DIRECTORY_NAME = ".autocline";
const CLINE_DATA_DIRECTORY_NAME = "data";
const CLINE_CONFIG_DIRECTORY_NAMES: readonly string[] = [
	CLINE_CONFIG_DIRECTORY_NAME,
	AUTOCLINE_CONFIG_DIRECTORY_NAME,
];

/**
 * Browser-safe structural check for the shared chat workspace that hosts
 * sessions started without a project: `.cline/data/workspaces/chat`. Matches
 * the directory itself only — project folders created inside it are regular
 * workspaces. Matches the default data-dir layout; explicit `CLINE_DATA_DIR`
 * overrides are not detectable from a bare path string.
 */
export function isChatWorkspacePath(path: string): boolean {
	const normalizedPath = path.trim();
	const isWindowsAbsolute =
		/^[A-Za-z]:[\\/]/.test(normalizedPath) || normalizedPath.startsWith("\\\\");
	const isPosixAbsolute = normalizedPath.startsWith("/");
	if (!isWindowsAbsolute && !isPosixAbsolute) {
		return false;
	}
	const segments = normalizedPath
		.split(isWindowsAbsolute ? /[\\/]+/ : /\/+/)
		.filter(Boolean);
	const chatDirectory = segments.at(-1) ?? "";
	const workspacesDirectory = segments.at(-2) ?? "";
	const dataDirectory = segments.at(-3) ?? "";
	const configDirectory = segments.at(-4) ?? "";
	return (
		CLINE_CONFIG_DIRECTORY_NAMES.includes(configDirectory) &&
		dataDirectory === CLINE_DATA_DIRECTORY_NAME &&
		workspacesDirectory === CLINE_WORKSPACES_DIRECTORY_NAME &&
		chatDirectory === CLINE_CHAT_WORKSPACE_DIRECTORY_NAME
	);
}
