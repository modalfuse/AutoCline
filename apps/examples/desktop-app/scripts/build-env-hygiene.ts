/**
 * Keeps whatever credential the developer's *agent* environment carries (for
 * example a temporary `LITELLM_API_KEY` the coding CLI authenticates with) out
 * of the desktop build and its child processes.
 *
 * Why this is needed — verified with harmless sentinel experiments against
 * Bun 1.4 (`bun build --target bun`):
 *
 *   1. Plain member reads (`process.env.FOO`) are NOT inlined by Bun. A bundle
 *      built with `FOO=SENTINEL bun build` contains no sentinel literal.
 *   2. Bun DOES inline `process.env.FOO` when the build is given
 *      `--define process.env.FOO=...`, and the value becomes a literal in the
 *      emitted file. Both the desktop backend bundle
 *      (scripts/telemetry-define-args.ts) and the compiled CLI
 *      (apps/cli/script/compile-binary.ts, BUILD_TIME_INLINED_ENV_VARS) drive
 *      inlining that way from the *build* process environment.
 *   3. Bun always inlines `NODE_ENV` ("production") and `process.env[n]`
 *      dynamic reads are left alone.
 *
 * So the only way a key can reach a product artifact through this pipeline is
 * by sitting in the build process env under a name the build reads. This module
 * removes those names from every child process the build spawns (bun build,
 * tauri, cargo, bun install, ...) — they never appear on a command line and are
 * never printed.
 */

/**
 * Names that must never survive into a build child. Kept deliberately broad so
 * a different vendor's key is as blocked as the coding CLI's temporary one;
 * nothing here is needed to compile the app (prod telemetry/notarization vars
 * are *not* in this list, so release builds still work unchanged).
 */
export const BUILD_SECRET_ENV_PATTERNS: readonly RegExp[] = [
	/(^|_)API_KEY$/,
	/(^|_)API_TOKEN$/,
	/(^|_)ACCESS_TOKEN$/,
	/(^|_)SECRET$/,
	/(^|_)SECRET_KEY$/,
	/(^|_)SECRET_ACCESS_KEY$/,
	/(^|_)PASSWORD$/,
	/(^|_)PRIVATE_KEY$/,
	/(^|_)AUTH_TOKEN$/,
	/(^|_)BEARER_TOKEN$/,
	/^(ANTHROPIC|OPENAI|OPENROUTER|GEMINI|GOOGLE|VERTEX|DEEPSEEK|MISTRAL|GROQ|XAI|COHERE|AZURE_OPENAI|FIREWORKS|TOGETHER|CEREBRAS|SAMBANOVA|OLLAMA|QWEN|DASHSCOPE|MOONSHOT|ZHIPU|SILICONFLOW|OPENCODE|GITHUB|GH)_/,
	// The coding CLI's own provider wiring (endpoint, models, key). Harmless to
	// drop for a build, and dropping the whole prefix means a future
	// `LITELLM_*` credential name cannot slip through unreviewed.
	/^LITELLM_/,
];

/** Never treated as secret even though the pattern list would match. */
const ALLOWED_KEYS = new Set<string>([
	// Local-only ad-hoc signing the packaging script performs: `--sign -`.
	"APPLE_SIGNING_IDENTITY",
]);

/**
 * Names allowed to survive a release build even though they look like
 * credentials: the telemetry export keys are inlined by design for a release
 * (see telemetryDefineArgs), so a release build must be able to read them.
 */
const RELEASE_ALLOWED_KEYS = new Set<string>([
	"TELEMETRY_SERVICE_API_KEY",
	"ERROR_SERVICE_API_KEY",
]);

function isSecretName(name: string): boolean {
	if (!name || ALLOWED_KEYS.has(name)) {
		return false;
	}
	return BUILD_SECRET_ENV_PATTERNS.some((pattern) => pattern.test(name));
}

/** True for a name `sanitizeBuildEnv` withholds — exported for the summary log. */
export function isCredentialEnvName(name: string): boolean {
	return isSecretName(name);
}

export interface BuildEnvSanitization {
	/** Env object to hand to child processes (a copy; input untouched). */
	env: Record<string, string>;
	/** Credential names removed, sorted — names only, never values. */
	removed: string[];
	/**
	 * Non-credential telemetry names also withheld from a local build, sorted.
	 * Empty for a release build, which keeps them by design.
	 */
	inlined: string[];
}

/**
 * Returns a copy of `env` without credential-looking variables. Callers use the
 * copy for child processes only, so the developer's own CLI session keeps its
 * key while the build does not.
 */
export function sanitizeBuildEnv(
	env: Record<string, string | undefined> = process.env,
): BuildEnvSanitization {
	const next: Record<string, string> = {};
	const removed: string[] = [];
	for (const [key, value] of Object.entries(env)) {
		if (isSecretName(key)) {
			removed.push(key);
			continue;
		}
		next[key] = value ?? "";
	}
	removed.sort();
	return { env: next, removed, inlined: [] };
}

/**
 * Names that are withheld from build children but are not credentials: they are
 * telemetry config the build may legitimately inline. Reported separately so the
 * "withholding credentials" summary stays truthful.
 */
export const INLINED_BUILD_ENV_NAMES: readonly string[] = [
	"OTEL_TELEMETRY_ENABLED",
	"OTEL_METRICS_EXPORTER",
	"OTEL_LOGS_EXPORTER",
	"OTEL_TRACES_EXPORTER",
	"OTEL_EXPORTER_OTLP_PROTOCOL",
	"OTEL_EXPORTER_OTLP_ENDPOINT",
	"OTEL_EXPORTER_OTLP_HEADERS",
	"OTEL_METRIC_EXPORT_INTERVAL",
	"CLINE_TRACE_SAMPLE_PERCENT",
	"CLINE_TRACE_RECORD_CONTENT",
	"CLINE_CODE_CLOUD_AGENTS",
	"TELEMETRY_SERVICE_API_KEY",
	"ERROR_SERVICE_API_KEY",
];

/**
 * Non-credential variables a local build must also not inherit: a developer's
 * shell may export a dogfood telemetry endpoint or a trace sampler, and inlining
 * either would point a distributable build at somebody else's collector.
 */
const LOCAL_BUILD_WITHHELD_ENV_NAMES = new Set<string>(INLINED_BUILD_ENV_NAMES);

function isWithheldForLocalBuild(name: string): boolean {
	return isSecretName(name) || LOCAL_BUILD_WITHHELD_ENV_NAMES.has(name);
}

/** A release build keeps the by-design telemetry keys, drops every other key. */
function isWithheldForReleaseBuild(name: string): boolean {
	return isSecretName(name) && !RELEASE_ALLOWED_KEYS.has(name);
}

export const RELEASE_BUILD_ENV = "AUTOCLINE_RELEASE_BUILD";

/**
 * The sanitized env a desktop build must run with. Always drops every
 * credential name; only restores the deliberately inlined telemetry values, and
 * only for a release build (`AUTOCLINE_RELEASE_BUILD=1`), so a local build can
 * never bake a developer's telemetry key into the artifacts.
 */
export function buildChildEnv(
	env: Record<string, string | undefined> = process.env,
	options: { release?: boolean } = {},
): BuildEnvSanitization {
	const release = options.release ?? env[RELEASE_BUILD_ENV] === "1";
	const withheld: string[] = [];
	const next: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		if (release ? isWithheldForReleaseBuild(key) : isWithheldForLocalBuild(key)) {
			withheld.push(key);
			continue;
		}
		next[key] = value ?? "";
	}
	withheld.sort();
	if (release) {
		// A release build is expected to carry the production telemetry config,
		// which by design is inlined into the artifacts.
		return { env: next, removed: withheld, inlined: [] };
	}
	return {
		env: next,
		removed: withheld.filter((name) => isCredentialEnvName(name)),
		inlined: withheld.filter((name) => !isCredentialEnvName(name)),
	};
}
