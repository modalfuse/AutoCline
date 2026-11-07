#!/usr/bin/env node
/**
 * Read-only pre-commit checker.
 *
 * This replaces the previous `lint-staged` hook, which rewrote staged files,
 * re-staged them, and could also regenerate `state.proto`. That flow could
 * silently alter the exact bytes the author staged, and it made the hook depend
 * on writing to the git index.
 *
 * Everything here is preservation-safe:
 *   - The git index is only read (`git diff --cached --name-status -z`,
 *     `git ls-files --stage -z`, `git show :path`, `git rev-parse :path`,
 *     `git hash-object` without -w). No mutating git command — ever.
 *   - Biome runs in check-only mode. Mutating Biome flags must never appear
 *     below (a test asserts this).
 *   - `state.proto` coherence is verified by rendering in memory from the
 *     staged `state-keys.ts` blob and comparing it against the staged
 *     `state.proto` blob. Both blobs are read from the index, so an unchanged
 *     companion file is still validated. The generator is never invoked in
 *     write mode.
 *
 * Two invariants make the result trustworthy:
 *
 *  1. Only actual staged changes are inspected. `git ls-files --stage` lists
 *     every tracked entry whether or not it changed, so it cannot decide what
 *     to lint; `git diff --cached --name-status` can.
 *  2. What gets linted is what gets committed. Biome reads the working tree,
 *     so a staged blob whose working-tree file differs is rejected up front
 *     instead of being silently replaced by the (possibly different) working
 *     bytes.
 */

import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
	checkGeneratedProto,
	renderStateProto,
	resolveTsConfigOptions,
	STATE_KEYS_RELATIVE_PATH,
	STATE_PROTO_RELATIVE_PATH,
} from "./generate-state-proto.mjs"

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/**
 * Repository-relative prefix of this app inside the monorepo. The hook `cd`s
 * into `apps/vscode` before running, so git reports repo-relative paths while
 * Biome and the never-lint patterns are app-relative.
 */
export const APP_REPO_PREFIX = "apps/vscode/"

/** Extensions Biome lints. Mirrors the `lint-staged` block this hook replaces. */
export const BIOME_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc"]

/** Paths Biome itself must not lint (they are generated or vendored). */
export const NEVER_LINT_PATTERNS = [/^protos\//, /^src\/generated\//, /^webview-ui\/build\//, /^dist/, /^node_modules\//]

export function hasBiomeExtension(filePath) {
	return BIOME_EXTENSIONS.some((extension) => filePath.endsWith(extension))
}

export function isNeverLinted(filePath) {
	return NEVER_LINT_PATTERNS.some((pattern) => pattern.test(filePath))
}

/**
 * Strip the `apps/vscode/` prefix from a repository-relative path.
 *
 * Returns `null` for paths outside this app: the checker only owns files it can
 * lint with `apps/vscode/biome.jsonc` and render with the app-local generator.
 */
export function toAppRelativePath(repoRelativePath) {
	if (!repoRelativePath.startsWith(APP_REPO_PREFIX)) {
		return null
	}
	return repoRelativePath.slice(APP_REPO_PREFIX.length)
}

/**
 * Split `git ls-files --stage -z` output into entries.
 *
 * Each record looks like `<mode> <sha> <stage>\t<path>` and records are NUL
 * separated, so paths containing spaces (or newlines) survive intact.
 */
export function parseLsFilesZ(output) {
	const entries = []
	for (const record of output.split("\0")) {
		if (record.length === 0) {
			continue
		}
		const tabIndex = record.indexOf("\t")
		if (tabIndex === -1) {
			throw new Error(`Unexpected git ls-files record: ${JSON.stringify(record)}`)
		}
		const [mode, sha, stage] = record.slice(0, tabIndex).split(" ")
		entries.push({
			path: record.slice(tabIndex + 1),
			mode,
			sha,
			stage: Number.parseInt(stage, 10),
		})
	}
	return entries
}

/**
 * Parse `git diff --cached --name-status -z` output into stage records.
 *
 * This is the authoritative list of actual staged changes: unlike
 * `git ls-files`, entries unchanged since `HEAD` do not appear at all. Deleted
 * paths appear with status `D`, which is why the `ls-files` all-zero-SHA
 * convention cannot be used to infer deletions.
 *
 * The format is `status\0path\0` per entry, with `R<score>`/`C<score>` followed
 * by two paths (`old\0new\0`). Records are NUL separated, so paths containing
 * spaces or newlines stay intact.
 */

/**
 * A path field is only usable when it is present *and* non-empty. Splitting on
 * NUL leaves a trailing empty field for every well-formed record, so an empty
 * field in the middle of a record means the output was truncated.
 */
function isPresentPath(field) {
	return field !== undefined && field.length > 0
}

export function parseNameStatusZ(output) {
	const records = []
	const fields = output.split("\0")
	let index = 0
	while (index < fields.length) {
		const status = fields[index]
		if (status === undefined || status.length === 0) {
			index++
			continue
		}
		const code = status[0]
		if (code === "R" || code === "C") {
			const from = fields[index + 1]
			const to = fields[index + 2]
			if (!isPresentPath(from) || !isPresentPath(to)) {
				throw new Error(`Truncated git name-status record: ${JSON.stringify(status)}`)
			}
			records.push({ status, code, path: to, previousPath: from })
			index += 3
			continue
		}
		const filePath = fields[index + 1]
		if (!isPresentPath(filePath)) {
			throw new Error(`Truncated git name-status record: ${JSON.stringify(status)}`)
		}
		records.push({ status, code, path: filePath, previousPath: null })
		index += 2
	}
	return records
}

/** Git's marker for a file removed from the index: an all-zero object id. */
export const DELETED_SHA_PLACEHOLDER = "0".repeat(40)

/**
 * Classify the actual staged change set into the file lists the checker needs.
 *
 * `changes` come from `git diff --cached --name-status -z`; `unmergedPaths`
 * come from `git ls-files --stage -z` (stage != 0), because an unmerged entry
 * has no single staged blob and therefore never renders in the cached diff.
 *
 * Paths are converted to app-relative form. Changes outside `apps/vscode` are
 * recorded in `outsideApp` and never linted: they belong to other packages and
 * cannot be judged with this app's Biome config.
 */
export function classifyStagedChanges({ changes, unmergedPaths = [] }) {
	const groups = {
		lintable: [],
		stateKeys: [],
		stateProto: [],
		deleted: [],
		unmerged: [],
		outsideApp: [],
		other: [],
	}

	for (const unmergedPath of [...new Set(unmergedPaths)].sort()) {
		groups.unmerged.push(unmergedPath)
	}

	for (const change of [...changes].sort((a, b) => a.path.localeCompare(b.path))) {
		const appRelative = toAppRelativePath(change.path)
		if (appRelative === null) {
			groups.outsideApp.push(change.path)
			continue
		}

		// A deletion has no surviving bytes to lint or render. The source side of
		// a rename/copy is not linted either; only the destination path is.
		if (change.code === "D") {
			groups.deleted.push(appRelative)
			continue
		}

		if (appRelative === STATE_KEYS_RELATIVE_PATH) {
			groups.stateKeys.push(appRelative)
			continue
		}
		if (appRelative === STATE_PROTO_RELATIVE_PATH) {
			groups.stateProto.push(appRelative)
			continue
		}
		if (isNeverLinted(appRelative) || !hasBiomeExtension(appRelative)) {
			groups.other.push(appRelative)
			continue
		}
		groups.lintable.push(appRelative)
	}

	return groups
}

/**
 * Build the read-only Biome invocation for the given staged paths.
 *
 * Mutating flags are deliberately absent: the hook must never rewrite what the
 * author staged. Unknown extensions are ignored rather than fatal so a stray
 * `.md`/`.snap` cannot break the hook.
 */
export function planBiomeInvocation({ biomeBin, files, stagedDir, configPath }) {
	return {
		command: biomeBin,
		args: [
			"check",
			"--diagnostic-level=error",
			"--files-ignore-unknown=true",
			"--no-errors-on-unmatched",
			"--config-path",
			configPath,
			...files.map((file) => path.join(stagedDir, file)),
		],
	}
}

/**
 * Verify that the staged `state.proto` matches what the staged `state-keys.ts`
 * would generate.
 *
 * Both blobs come from the index (`git show :path`), so a companion file that is
 * unchanged since `HEAD` is still validated against the version being committed.
 * The comparison covers the entire file rather than only the touched hunks: a
 * stale generated body elsewhere in the message is just as uncommittable as one
 * on a changed line, and hunk ranges are an unreliable proxy for "what
 * generation would produce".
 *
 * `render` is injected so tests can supply a deterministic renderer; production
 * callers pass `renderStateProto`. Nothing is written in any case.
 */
export function checkStateProtoCoherence({
	stagedStateKeys,
	stagedProto,
	compilerOptions,
	render = renderStateProto,
	log = () => {},
}) {
	// No generated input in this commit: nothing to prove.
	if (stagedStateKeys === null || stagedStateKeys === undefined) {
		if (stagedProto === null || stagedProto === undefined) {
			return { ok: true, reason: null, skipped: true }
		}
		// Only `state.proto` is staged. Rendering needs the corresponding TS
		// source, and comparing against the working tree would validate bytes that
		// are not being committed, so refuse instead of guessing.
		return {
			ok: false,
			reason:
				`${STATE_PROTO_RELATIVE_PATH} is staged without ${STATE_KEYS_RELATIVE_PATH}.` +
				`\nStage ${STATE_KEYS_RELATIVE_PATH} too (or unstage ${STATE_PROTO_RELATIVE_PATH}) so the generated proto can be verified.`,
		}
	}

	const expectedContent = render({
		stateKeysSource: stagedStateKeys,
		protoSource: stagedProto ?? null,
		compilerOptions,
		log,
	})

	return checkGeneratedProto({ generatedContent: expectedContent, currentContent: stagedProto ?? "" })
}

/**
 * Determine whether the working-tree copy of a staged file still matches the
 * staged blob.
 *
 * Biome reads the working tree, so any difference means the bytes being linted
 * are not the bytes being committed. Returns `{ same, reason }`; `reason` is
 * null when they match.
 */
export function compareWorkingTreeToStaged({ exec, cwd, filePath }) {
	const stagedBlob = exec("git", ["rev-parse", `:${indexPathSpec(filePath)}`], { cwd })
	if (stagedBlob.status !== 0) {
		return { same: false, reason: `git rev-parse :${indexPathSpec(filePath)} failed: ${stagedBlob.stderr.trim()}` }
	}

	// `git hash-object` without `-w` only hashes the working-tree file: no object
	// is created and the index is untouched.
	const working = exec("git", ["hash-object", "--", filePath], { cwd })
	if (working.status !== 0) {
		return { same: false, reason: `git hash-object ${filePath} failed: ${working.stderr.trim()}` }
	}

	if (stagedBlob.stdout.trim() !== working.stdout.trim()) {
		return {
			same: false,
			reason:
				`${filePath} has staged changes that are not in the working tree.` +
				`\nThe hook lints the working tree, so it cannot prove the staged bytes are clean.` +
				`\nStage the working-tree contents (git add ${filePath}) or unstage the file, then retry.`,
		}
	}

	return { same: true, reason: null }
}

/**
 * Run the whole pre-commit check.
 *
 * `exec` is injected (`(command, args, options) => { status, stdout, stderr }`)
 * so tests can drive every branch without a real repository, a real Biome
 * binary, or any filesystem writes.
 *
 * Returns `0` when the staged state is committable, non-zero otherwise. It never
 * mutates the index, the working tree, or any file.
 */
export function runChecker({
	exec,
	cwd = APP_ROOT,
	biomeBin,
	configPath = "biome.jsonc",
	render = renderStateProto,
	resolveCompilerOptions = resolveTsConfigOptions,
	io = { log: console.log, error: console.error },
}) {
	// Conflicts first: an unmerged entry has no single staged blob, so nothing
	// else can be decided until they are resolved.
	const lsFiles = exec("git", ["ls-files", "--stage", "-z"], { cwd })
	if (lsFiles.status !== 0) {
		io.error(`git ls-files failed: ${lsFiles.stderr.trim()}`)
		return 1
	}

	const unmergedPaths = parseLsFilesZ(lsFiles.stdout)
		.filter((entry) => entry.stage !== 0)
		.map((entry) => entry.path)

	if (unmergedPaths.length > 0) {
		io.error("Unmerged paths are staged; resolve them before committing:")
		for (const filePath of [...new Set(unmergedPaths)].sort()) {
			io.error(`  ${filePath}`)
		}
		return 1
	}

	// The actual staged change set: tracked-but-unchanged files do not appear.
	const nameStatus = exec("git", ["diff", "--cached", "--name-status", "-z"], { cwd })
	if (nameStatus.status !== 0) {
		io.error(`git diff --cached failed: ${nameStatus.stderr.trim()}`)
		return 1
	}

	const groups = classifyStagedChanges({ changes: parseNameStatusZ(nameStatus.stdout) })

	if (groups.lintable.length === 0 && groups.stateKeys.length === 0 && groups.stateProto.length === 0) {
		io.log("No staged changes need read-only checks")
		return 0
	}

	// Biome lints the working tree, so prove the working tree still holds the
	// staged bytes before trusting any lint result. This runs before linting so a
	// fixed-but-unstaged file can never be reported as clean.
	const changedInApp = [...new Set([...groups.lintable, ...groups.stateKeys, ...groups.stateProto])].sort()
	for (const filePath of changedInApp) {
		const comparison = compareWorkingTreeToStaged({ exec, cwd, filePath })
		if (!comparison.same) {
			io.error(comparison.reason)
			return 1
		}
	}

	if (groups.lintable.length > 0) {
		const invocation = planBiomeInvocation({ biomeBin, files: groups.lintable, stagedDir: cwd, configPath })
		io.log(`biome check on ${groups.lintable.length} staged file(s)`)
		const biomeResult = exec(invocation.command, invocation.args, { cwd })
		if (biomeResult.stdout) {
			io.log(biomeResult.stdout.trimEnd())
		}
		if (biomeResult.status !== 0) {
			if (biomeResult.stderr) {
				io.error(biomeResult.stderr.trimEnd())
			}
			io.error("biome check failed. Fix the errors above and stage the fixes (the hook never rewrites files).")
			return biomeResult.status === null ? 1 : biomeResult.status
		}
	}

	if (groups.stateKeys.length === 0 && groups.stateProto.length === 0) {
		return 0
	}

	// Read both blobs from the index. `git show :path` resolves unchanged files
	// against `HEAD`, so a committed `state-keys.ts` pairs with a staged
	// `state.proto` even when only one of them appears in the diff.
	const stagedStateKeys = readStagedFile({ exec, cwd, filePath: STATE_KEYS_RELATIVE_PATH, io })
	if (stagedStateKeys === null) {
		return 1
	}

	const stagedProto = readStagedFile({ exec, cwd, filePath: STATE_PROTO_RELATIVE_PATH, io })
	if (stagedProto === null) {
		return 1
	}

	const { compilerOptions } = resolveCompilerOptions({ repoRoot: cwd })

	const result = checkStateProtoCoherence({ stagedStateKeys, stagedProto, compilerOptions, render })

	if (result.skipped) {
		io.log(`No generated proto inputs staged; skipping ${STATE_PROTO_RELATIVE_PATH} check`)
		return 0
	}

	if (!result.ok) {
		io.error(`${STATE_PROTO_RELATIVE_PATH} is out of date with the staged ${STATE_KEYS_RELATIVE_PATH}.`)
		io.error(result.reason)
		io.error("Run 'node scripts/generate-state-proto.mjs' and stage the result.")
		return 1
	}

	io.log(`${STATE_PROTO_RELATIVE_PATH} matches the staged ${STATE_KEYS_RELATIVE_PATH}`)
	return 0
}

/**
 * Build the `<rev>:<path>` argument that addresses a file in the git index.
 *
 * `cwd` is `apps/vscode`, a *subdirectory* of the repository, and git resolves
 * the path after the colon relative to the repository root — never relative to
 * `cwd`. Bare `:src/shared/...` therefore does not resolve against real git
 * (exit 128), while `:./src/shared/...` is the documented way to anchor the
 * path at the current directory. The filesystem-side argument to
 * `git hash-object` stays app-relative, which is correct for `cwd`.
 */
export function indexPathSpec(filePath) {
	return `./${filePath}`
}

/** Read a file straight out of the git index. Returns null on failure. */
function readStagedFile({ exec, cwd, filePath, io }) {
	const spec = indexPathSpec(filePath)
	const result = exec("git", ["show", `:${spec}`], { cwd })
	if (result.status !== 0) {
		io.error(`git show :${spec} failed: ${result.stderr.trim()}`)
		return null
	}
	return result.stdout
}

/**
 * Environment for every git child.
 *
 * `GIT_OPTIONAL_LOCKS=0` stops git from opportunistically refreshing the index
 * (a write to `.git/index`) while we are only reading. `GIT_INDEX_FILE` is
 * inherited from the parent so we observe the index the commit will use instead
 * of guessing `$GIT_DIR/index`.
 */
export function gitEnv(baseEnv = process.env) {
	const env = { ...baseEnv, GIT_OPTIONAL_LOCKS: "0" }
	if (baseEnv.GIT_INDEX_FILE !== undefined) {
		env.GIT_INDEX_FILE = baseEnv.GIT_INDEX_FILE
	}
	return env
}

/** Real `exec` used by the CLI entrypoint. Never writes anything. */
export function nodeExec(command, args, { cwd }) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf-8",
		maxBuffer: 64 * 1024 * 1024,
		env: command === "git" ? gitEnv() : process.env,
	})
	return {
		status: result.error ? 1 : result.status,
		stdout: result.stdout ?? "",
		stderr: result.error ? `${result.error.message}\n` : (result.stderr ?? ""),
	}
}

/**
 * Resolve the Biome binary. Staged content is checked with the app-local
 * Biome so the hook obeys `apps/vscode/biome.jsonc` regardless of what the root
 * workspace would resolve.
 */
export function resolveBiomeBin({ cwd = APP_ROOT } = {}) {
	return path.join(cwd, "node_modules", ".bin", "biome")
}

function isDirectInvocation() {
	const entry = process.argv[1]
	if (!entry) {
		return false
	}
	try {
		return import.meta.url === pathToFileURL(path.resolve(entry)).href
	} catch {
		return false
	}
}

if (isDirectInvocation()) {
	try {
		process.exitCode = runChecker({
			exec: nodeExec,
			cwd: APP_ROOT,
			biomeBin: resolveBiomeBin({ cwd: APP_ROOT }),
		})
	} catch (error) {
		console.error("pre-commit check failed:", error)
		process.exitCode = 1
	}
}
