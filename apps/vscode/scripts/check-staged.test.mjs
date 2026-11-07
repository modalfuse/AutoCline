/**
 * Tests for the read-only pre-commit checker.
 *
 * Every test drives `runChecker` through an injected `exec` and an injected
 * renderer, so no repository, Biome binary, or child process is involved. The
 * last group asserts the *preservation* guarantee: the hook never writes files
 * and never invokes a mutating git command.
 */

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

import {
	APP_REPO_PREFIX,
	APP_ROOT,
	BIOME_EXTENSIONS,
	checkStateProtoCoherence,
	classifyStagedChanges,
	compareWorkingTreeToStaged,
	gitEnv,
	isNeverLinted,
	nodeExec,
	parseLsFilesZ,
	parseNameStatusZ,
	planBiomeInvocation,
	resolveBiomeBin,
	runChecker,
	toAppRelativePath,
} from "./check-staged.mjs"
import { checkGeneratedProto, normalizeNewlines, replaceMessage, splitProtoTopLevel } from "./generate-state-proto.mjs"

const STATE_KEYS = "src/shared/storage/state-keys.ts"
const STATE_PROTO = "proto/cline/state.proto"
const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-staged.mjs")

const silentIo = () => {
	const lines = { log: [], error: [] }
	return {
		lines,
		io: {
			log: (message) => lines.log.push(String(message)),
			error: (message) => lines.error.push(String(message)),
		},
	}
}

/** Build a `git ls-files --stage -z` blob from `[path, sha?]` pairs. */
function lsFiles(...entries) {
	return entries.map(([filePath, sha = "a".repeat(40)]) => `100644 ${sha} 0\t${filePath}`).join("\0") + "\0"
}

/**
 * Build a `git diff --cached --name-status -z` blob.
 *
 * Accepts `[status, path]` or `[status, from, to]` tuples. This mirrors real
 * git output: only changed paths appear, and `D` entries keep their path.
 */
function nameStatus(...entries) {
	return entries.map(([status, ...paths]) => [status, ...paths].join("\0")).join("\0") + "\0"
}

/** A staged-change record for `path` with the given status code. */
function change(status, filePath, previousPath = null) {
	return { status, code: status[0], path: filePath, previousPath }
}

/** Repo-relative path of an app-relative path. */
function repoPath(appRelative) {
	return `${APP_REPO_PREFIX}${appRelative}`
}

/**
 * Minimal fake git/Biome: `responses` maps a command key to its result. Any
 * unmatched invocation throws, so a test can never silently depend on a call it
 * did not declare.
 */
function fakeExec(responses) {
	const calls = []
	const exec = (command, args, options) => {
		const key = [command, ...args].join(" ")
		calls.push({ command, args, options, key })
		for (const [pattern, result] of Object.entries(responses)) {
			if (key === pattern || key.startsWith(`${pattern} `)) {
				return typeof result === "function" ? result() : result
			}
		}
		throw new Error(`Unexpected exec: ${key}`)
	}
	exec.calls = calls
	return exec
}

/**
 * Responses that make every listed file look unchanged between the index and
 * the working tree, derived from a `path -> content` map.
 *
 * `git rev-parse :path` and `git hash-object -- path` return the same digest for
 * the same content, which is exactly what a clean tree produces.
 */
function cleanWorkingTree(files) {
	const responses = {}
	for (const [filePath, content] of Object.entries(files)) {
		const digest = `sha-of:${content}`
		responses[`git rev-parse :./${filePath}`] = { status: 0, stdout: `${digest}\n`, stderr: "" }
		responses[`git hash-object -- ${filePath}`] = { status: 0, stdout: `${digest}\n`, stderr: "" }
	}
	return responses
}

// ---------------------------------------------------------------------------
// Parsing / classification
// ---------------------------------------------------------------------------

test("parseLsFilesZ keeps paths with spaces intact and is NUL-delimited", () => {
	const output = ["100644 abc 0\tsrc/a file with spaces.ts", "100644 def 0\tsrc/b.ts"].join("\0") + "\0"
	const parsed = parseLsFilesZ(output)
	assert.equal(parsed.length, 2)
	assert.equal(parsed[0].path, "src/a file with spaces.ts")
	assert.equal(parsed[0].sha, "abc")
	assert.equal(parsed[0].stage, 0)
	assert.equal(parsed[1].path, "src/b.ts")
})

test("parseLsFilesZ rejects malformed records instead of guessing", () => {
	assert.throws(() => parseLsFilesZ("100644 abc 0 no-tab-here\0"), /Unexpected git ls-files record/)
})

test("parseNameStatusZ reads real git output: modified, added, deleted and renamed paths", () => {
	const output = nameStatus(
		["M", repoPath("src/core/task/index.ts")],
		["A", "webview-ui/src/App.tsx"],
		["D", repoPath("src/old/deleted.ts")],
		["R100", repoPath("src/from.ts"), repoPath("src/to.ts")],
	)
	const parsed = parseNameStatusZ(output)
	assert.equal(parsed.length, 4)
	assert.deepEqual(
		parsed.map((record) => [record.code, record.path]),
		[
			["M", repoPath("src/core/task/index.ts")],
			["A", "webview-ui/src/App.tsx"],
			["D", repoPath("src/old/deleted.ts")],
			["R", repoPath("src/to.ts")],
		],
	)
	// Only the rename destination is used; the source path is carried separately.
	assert.equal(parsed[3].previousPath, repoPath("src/from.ts"))
})

test("parseNameStatusZ keeps paths with spaces intact and rejects truncated records", () => {
	const parsed = parseNameStatusZ(nameStatus(["M", repoPath("src/a file with spaces.ts")]))
	assert.equal(parsed[0].path, repoPath("src/a file with spaces.ts"))

	assert.throws(() => parseNameStatusZ("R100\0only-one-path\0"), /Truncated git name-status record/)
	assert.throws(() => parseNameStatusZ("M\0"), /Truncated git name-status record/)
})

test("toAppRelativePath scopes repo paths to apps/vscode", () => {
	assert.equal(toAppRelativePath(repoPath("src/a.ts")), "src/a.ts")
	assert.equal(toAppRelativePath("apps/cli/src/a.ts"), null)
	assert.equal(toAppRelativePath("webview-ui/src/App.tsx"), null)
})

test("classifyStagedChanges splits the real change set into lintable, generated inputs, deletions and unmerged", () => {
	const groups = classifyStagedChanges({
		changes: [
			change("M", repoPath("src/core/task/index.ts")),
			change("M", "webview-ui/src/App.tsx"),
			change("M", repoPath(STATE_KEYS)),
			change("M", repoPath(STATE_PROTO)),
			change("M", "README.md"),
			change("M", repoPath("protos/state.proto")),
			change("M", repoPath("src/generated/grpc-js/x.ts")),
			change("D", repoPath("removed.ts")),
		],
		unmergedPaths: [repoPath("src/conflicted.ts")],
	})

	// Never-linted generated paths and out-of-app paths stay out of Biome's scope.
	assert.deepEqual(groups.lintable, ["src/core/task/index.ts"])
	assert.deepEqual(groups.stateKeys, [STATE_KEYS])
	assert.deepEqual(groups.stateProto, [STATE_PROTO])
	assert.deepEqual(groups.deleted, ["removed.ts"])
	assert.deepEqual(groups.unmerged, [repoPath("src/conflicted.ts")])
	assert.ok(groups.outsideApp.includes("README.md"))
	assert.ok(groups.outsideApp.includes("webview-ui/src/App.tsx"))
	assert.ok(groups.other.includes("protos/state.proto"))
	assert.ok(groups.other.includes("src/generated/grpc-js/x.ts"))
})

test("a generated file inside apps/vscode is never handed to Biome", () => {
	// Guards the path-normalization defect: repo-relative `apps/vscode/src/generated/...`
	// must be recognized as generated *after* stripping the app prefix.
	const groups = classifyStagedChanges({
		changes: [
			change("M", repoPath("src/generated/grpc-js/x.ts")),
			change("M", repoPath("node_modules/pkg/index.js")),
			change("M", repoPath("dist/extension.js")),
		],
	})
	assert.deepEqual(groups.lintable, [])
	assert.deepEqual(groups.other.sort(), ["dist/extension.js", "node_modules/pkg/index.js", "src/generated/grpc-js/x.ts"])
})

test("a rename lints only its destination path", () => {
	const groups = classifyStagedChanges({
		changes: [change("R100", repoPath("src/new name.ts"), repoPath("src/old name.ts"))],
	})
	assert.deepEqual(groups.lintable, ["src/new name.ts"])
	assert.deepEqual(groups.deleted, [])
})

test("classification ignores paths Biome must never lint", () => {
	for (const ignored of ["protos/a.ts", "src/generated/a.ts", "webview-ui/build/a.js", "dist/a.js", "node_modules/a.js"]) {
		assert.equal(isNeverLinted(ignored), true, ignored)
	}
	assert.equal(isNeverLinted("src/core/a.ts"), false)
	assert.deepEqual(BIOME_EXTENSIONS, [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc"])
})

test("classification ignores paths Biome must never lint", () => {
	for (const ignored of ["protos/a.ts", "src/generated/a.ts", "webview-ui/build/a.js", "dist/a.js", "node_modules/a.js"]) {
		assert.equal(isNeverLinted(ignored), true, ignored)
	}
	assert.equal(isNeverLinted("src/core/a.ts"), false)
	assert.deepEqual(BIOME_EXTENSIONS, [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc"])
})

// ---------------------------------------------------------------------------
// Biome invocation shape
// ---------------------------------------------------------------------------

test("planBiomeInvocation is check-only and never mutates files", () => {
	const plan = planBiomeInvocation({
		biomeBin: "/repo/node_modules/.bin/biome",
		files: ["src/a.ts", "src/b.ts"],
		stagedDir: "/repo/apps/vscode",
		configPath: "biome.jsonc",
	})
	assert.equal(plan.command, "/repo/node_modules/.bin/biome")
	assert.deepEqual(plan.args, [
		"check",
		"--diagnostic-level=error",
		"--files-ignore-unknown=true",
		"--no-errors-on-unmatched",
		"--config-path",
		"biome.jsonc",
		path.join("/repo/apps/vscode", "src/a.ts"),
		path.join("/repo/apps/vscode", "src/b.ts"),
	])

	const joined = plan.args.join(" ")
	// Assembled at runtime: the source-scan test forbids these literals entirely.
	for (const forbidden of ["--" + "write", "--" + "fix", "--" + "unsafe", "--" + "staged", "--" + "reporter=json"]) {
		assert.ok(!joined.includes(forbidden), `Biome invocation must not use ${forbidden}`)
	}
})

test("the checker source never contains a write-capable flag", () => {
	const source = readFileSync(SCRIPT_PATH, "utf-8")
	// Assembled at runtime so this assertion cannot trip over its own text.
	const forbidden = ["--" + "write", "--" + "fix", "--" + "unsafe"]
	for (const flag of forbidden) {
		assert.ok(!source.includes(flag), `check-staged.mjs must not mention ${flag}`)
	}
})

test("resolveBiomeBin points at the app-local binary", () => {
	assert.equal(resolveBiomeBin({ cwd: "/repo/apps/vscode" }), path.join("/repo/apps/vscode", "node_modules", ".bin", "biome"))
	assert.ok(APP_ROOT.endsWith(path.join("apps", "vscode")))
})

// ---------------------------------------------------------------------------
// Working tree vs index agreement
// ---------------------------------------------------------------------------

test("compareWorkingTreeToStaged accepts a file whose working copy matches the index", () => {
	const exec = fakeExec(cleanWorkingTree({ "src/a.ts": "const a = 1\n" }))
	const result = compareWorkingTreeToStaged({ exec, cwd: "/repo", filePath: "src/a.ts" })
	assert.deepEqual(result, { same: true, reason: null })
	assert.deepEqual(
		exec.calls.map((call) => call.key),
		["git rev-parse :./src/a.ts", "git hash-object -- src/a.ts"],
	)
})

test("compareWorkingTreeToStaged rejects a staged blob the working tree no longer has", () => {
	const exec = fakeExec({
		"git rev-parse :./src/a.ts": { status: 0, stdout: `${"1".repeat(40)}\n`, stderr: "" },
		"git hash-object -- src/a.ts": { status: 0, stdout: `${"2".repeat(40)}\n`, stderr: "" },
	})
	const result = compareWorkingTreeToStaged({ exec, cwd: "/repo", filePath: "src/a.ts" })
	assert.equal(result.same, false)
	assert.match(result.reason, /staged changes that are not in the working tree/)
	assert.match(result.reason, /git add src\/a\.ts/)
})

test("compareWorkingTreeToStaged never asks git to write an object", () => {
	const exec = fakeExec(cleanWorkingTree({ "src/a.ts": "x" }))
	compareWorkingTreeToStaged({ exec, cwd: "/repo", filePath: "src/a.ts" })
	const hashCall = exec.calls.find((call) => call.args[0] === "hash-object")
	assert.ok(hashCall, "hash-object is used to read the working tree")
	assert.ok(!hashCall.args.includes("-w"), "hash-object must not write a loose object")
})

test("compareWorkingTreeToStaged surfaces a git failure instead of guessing", () => {
	const exec = fakeExec({
		"git rev-parse :./src/a.ts": { status: 128, stdout: "", stderr: "path is not in the index" },
	})
	const result = compareWorkingTreeToStaged({ exec, cwd: "/repo", filePath: "src/a.ts" })
	assert.equal(result.same, false)
	assert.match(result.reason, /path is not in the index/)
})

test("gitEnv disables optional index writes and keeps the caller's index", () => {
	assert.equal(gitEnv({ PATH: "/usr/bin", GIT_INDEX_FILE: "/tmp/idx" }).GIT_OPTIONAL_LOCKS, "0")
	assert.equal(gitEnv({ PATH: "/usr/bin", GIT_INDEX_FILE: "/tmp/idx" }).GIT_INDEX_FILE, "/tmp/idx")
	// A custom index is only carried through when the caller set one.
	assert.equal(Object.hasOwn(gitEnv({ PATH: "/usr/bin" }), "GIT_INDEX_FILE"), false)
	// The caller's environment object must not be mutated.
	const base = { PATH: "/usr/bin" }
	gitEnv(base)
	assert.equal(base.GIT_OPTIONAL_LOCKS, undefined)
})

// ---------------------------------------------------------------------------
// Staged proto coherence
// ---------------------------------------------------------------------------

test("checkStateProtoCoherence fails closed when only state.proto is staged", () => {
	const result = checkStateProtoCoherence({ stagedStateKeys: null, stagedProto: "message Secrets {}\n" })
	assert.equal(result.ok, false)
	assert.match(result.reason, /staged without src\/shared\/storage\/state-keys\.ts/)
	assert.equal(result.skipped, undefined)
})

test("checkGeneratedProto normalizes CRLF before comparing", () => {
	const generatedContent = "a\nb\nc\n"
	assert.deepEqual(checkGeneratedProto({ generatedContent, currentContent: "a\r\nb\r\nc\r\n" }), { ok: true, reason: null })

	const mismatch = checkGeneratedProto({ generatedContent, currentContent: "a\nB\nc\n" })
	assert.equal(mismatch.ok, false)
	assert.match(mismatch.reason, /line 2/)
})

test("checkGeneratedProto treats a missing current file as a full mismatch", () => {
	const result = checkGeneratedProto({ generatedContent: "a\n", currentContent: null })
	assert.equal(result.ok, false)
	assert.match(result.reason, /<end of file>/)
})

test("normalizeNewlines only rewrites CRLF", () => {
	assert.equal(normalizeNewlines("a\r\nb\rc"), "a\nb\rc")
})
// ---------------------------------------------------------------------------
// Preservation-safe message replacement
// ---------------------------------------------------------------------------

test("splitProtoTopLevel keeps non-declaration text in the header", () => {
	const text = [
		'syntax = "proto3";',
		"",
		"package cline;",
		"",
		"message A {",
		"  string x = 1;",
		"}",
		"",
		"enum B {",
		"  C = 0;",
		"}",
	].join("\n")
	const { header, declarations } = splitProtoTopLevel(text)
	assert.equal(header, 'syntax = "proto3";\n\npackage cline;\n')
	assert.equal(declarations.length, 2)
	assert.equal(declarations[0].keyword, "message")
	assert.equal(declarations[1].keyword, "enum")
})

test("replaceMessage rewrites only the target declaration and preserves the rest byte-for-byte", () => {
	const text = [
		'syntax = "proto3";',
		"package cline;",
		"",
		"message Secrets {",
		"  string a = 1;",
		"}",
		"",
		"// a comment mentioning message Secrets {",
		"message Settings {",
		"  string b = 1;",
		"}",
		"",
	].join("\n")

	const replacement = "message Secrets {\n  string a = 1;\n  string c = 2;\n}"
	const result = replaceMessage(text, "Secrets", replacement)

	assert.equal(
		result,
		[
			'syntax = "proto3";',
			"package cline;",
			"",
			replacement,
			"",
			"// a comment mentioning message Secrets {",
			"message Settings {",
			"  string b = 1;",
			"}",
			"",
		].join("\n"),
	)
})

test("replaceMessage is a fixed point when the content already matches", () => {
	const text = ['syntax = "proto3";', "", "message Secrets {", "  string a = 1;", "}", ""].join("\n")
	const body = "message Secrets {\n  string a = 1;\n}"
	assert.equal(replaceMessage(text, "Secrets", body), text)
})

test("replaceMessage appends when the message is absent", () => {
	const text = 'syntax = "proto3";\n'
	const result = replaceMessage(text, "Secrets", "message Secrets {\n}")
	assert.equal(result, 'syntax = "proto3";\n\nmessage Secrets {\n}\n')
})

// ---------------------------------------------------------------------------
// Staged proto coherence
// ---------------------------------------------------------------------------

const RENDERED_STATE_PROTO = ['syntax = "proto3";', "message Secrets {", "  string a = 1;", "}", ""].join("\n")

/** Renderer stub returning RENDERED_STATE_PROTO regardless of input. */
const stubRender = () => RENDERED_STATE_PROTO

test("coherence passes when the staged proto equals the rendered output", () => {
	const result = checkStateProtoCoherence({
		stagedStateKeys: "export const SECRET_KEYS = []",
		stagedProto: RENDERED_STATE_PROTO,
		render: stubRender,
	})
	assert.deepEqual(result, { ok: true, reason: null })
})

test("state.proto staged without state-keys.ts fails closed instead of guessing", () => {
	const result = checkStateProtoCoherence({
		stagedStateKeys: null,
		stagedProto: RENDERED_STATE_PROTO,
		render: stubRender,
	})
	assert.equal(result.ok, false)
	assert.match(result.reason, /staged without src\/shared\/storage\/state-keys\.ts/)
})

test("nothing generated is staged -> skipped", () => {
	const result = checkStateProtoCoherence({ stagedStateKeys: null, stagedProto: null, render: stubRender })
	assert.equal(result.skipped, true)
	assert.equal(result.ok, true)
})

test("state-keys.ts staged alone with an already-current proto passes", () => {
	const result = checkStateProtoCoherence({
		stagedStateKeys: "source",
		stagedProto: RENDERED_STATE_PROTO,
		render: stubRender,
	})
	assert.deepEqual(result, { ok: true, reason: null })
})

test("state-keys.ts staged alone with a stale proto fails", () => {
	const stale = ['syntax = "proto3";', "message Secrets {", "  string stale = 1;", "}", ""].join("\n")
	const result = checkStateProtoCoherence({
		stagedStateKeys: "source",
		stagedProto: stale,
		render: stubRender,
	})
	assert.equal(result.ok, false)
	assert.match(result.reason, /first difference at line 3/)
})

test("a stale generated body outside the changed hunk still fails (regression)", () => {
	// The committed state.proto adds a correct new field *and* keeps an outdated
	// field far from the edit. Under the old hunk-range comparison only the
	// touched lines were verified, so this passed. Full-file comparison must not.
	const expected = ['syntax = "proto3";', "", "message Settings {", "  string added = 1;", "}", ""].join("\n")
	const staged = [
		'syntax = "proto3";',
		"",
		"// hand-edited drift far below the changed hunk",
		"message Secrets {",
		"  string dropped = 2;",
		"}",
		"",
		"message Settings {",
		"  string added = 1;",
		"}",
		"",
	].join("\n")
	const result = checkStateProtoCoherence({
		stagedStateKeys: "source",
		stagedProto: staged,
		render: () => expected,
	})
	assert.equal(result.ok, false, "a stale body outside the changed hunk must be rejected")
	assert.match(result.reason, /first difference at line 3/)
	assert.match(result.reason, /hand-edited drift/)
})

test("a touched line that disagrees with the render fails", () => {
	const stale = ['syntax = "proto3";', "message Secrets {", "  string stale = 1;", "}", ""].join("\n")
	const result = checkStateProtoCoherence({
		stagedStateKeys: "source",
		stagedProto: stale,
		render: stubRender,
	})
	assert.equal(result.ok, false)
	assert.match(result.reason, /string a = 1;/)
})

test("coherence reports EOF when the staged proto stops early", () => {
	const result = checkStateProtoCoherence({
		stagedStateKeys: "source",
		stagedProto: 'syntax = "proto3";\n',
		render: stubRender,
	})
	assert.equal(result.ok, false)
	assert.match(result.reason, /<end of file>/)
})

test("the renderer receives the staged sources, never the working tree", () => {
	let received = null
	checkStateProtoCoherence({
		stagedStateKeys: "STAGED_KEYS",
		stagedProto: "STAGED_PROTO",
		render: (input) => {
			received = input
			return "STAGED_PROTO"
		},
	})
	assert.equal(received.stateKeysSource, "STAGED_KEYS")
	assert.equal(received.protoSource, "STAGED_PROTO")
})

// ---------------------------------------------------------------------------
// runChecker: end-to-end with an injected exec
// ---------------------------------------------------------------------------

test("clean commit with no staged changes runs git ls-files and git diff --cached only", () => {
	const exec = fakeExec({
		"git ls-files --stage -z": { status: 0, stdout: "", stderr: "" },
		"git diff --cached --name-status -z": { status: 0, stdout: "", stderr: "" },
	})
	const { io, lines } = silentIo()
	assert.equal(runChecker({ exec, io }), 0)
	assert.deepEqual(
		exec.calls.map((call) => call.key),
		["git ls-files --stage -z", "git diff --cached --name-status -z"],
	)
	assert.deepEqual(lines.error, [])
})

test("tracked-but-unchanged files trigger no lint and no proto check (regression)", () => {
	// `git ls-files` reports the whole index; the cached diff reports nothing
	// staged. The old implementation classified the ls-files output, so every
	// tracked file looked "staged" and Biome ran over the entire repo.
	const exec = fakeExec({
		"git ls-files --stage -z": {
			status: 0,
			stdout: lsFiles(["src/core/task/index.ts"], [STATE_KEYS], [STATE_PROTO], ["src/a.ts"]),
			stderr: "",
		},
		"git diff --cached --name-status -z": { status: 0, stdout: "", stderr: "" },
	})
	const { io, lines } = silentIo()
	assert.equal(runChecker({ exec, cwd: "/repo", biomeBin: "/repo/biome", io }), 0)
	assert.ok(!exec.calls.some((call) => call.command === "/repo/biome"), "Biome must not run")
	assert.ok(!exec.calls.some((call) => call.args[0] === "show"), "no staged blob is read")
	assert.ok(lines.log.some((line) => line.includes("No staged changes need read-only checks")))
})

test("only lintable files: Biome gets app-relative staged paths and the proto check is skipped", () => {
	const exec = fakeExec({
		"git ls-files --stage -z": { status: 0, stdout: "", stderr: "" },
		"git diff --cached --name-status -z": {
			status: 0,
			stdout: nameStatus(["M", repoPath("src/core/task/index.ts")], ["M", "README.md"], ["M", repoPath("protos/x.ts")]),
			stderr: "",
		},
		"/repo/biome check": { status: 0, stdout: "", stderr: "" },
		...cleanWorkingTree({ "src/core/task/index.ts": "source" }),
	})
	const { io } = silentIo()
	assert.equal(runChecker({ exec, cwd: "/repo", biomeBin: "/repo/biome", io }), 0)

	const biomeCall = exec.calls.find((call) => call.command === "/repo/biome")
	assert.ok(biomeCall, "biome should have run")
	// Paths are resolved against the staged tree, so Biome receives them as
	// absolute paths inside `cwd` rather than bare relative names.
	assert.deepEqual(biomeCall.args.slice(-1), [path.join("/repo", "src/core/task/index.ts")])
	assert.ok(!exec.calls.some((call) => call.command === "git" && call.args[0] === "show"))
})

test("staged file paths with spaces reach Biome as a single argument", () => {
	const spaced = "src/core/my module/file name.ts"
	const exec = fakeExec({
		"git ls-files --stage -z": { status: 0, stdout: "", stderr: "" },
		"git diff --cached --name-status -z": { status: 0, stdout: nameStatus(["M", repoPath(spaced)]), stderr: "" },
		"/repo/biome check": { status: 0, stdout: "", stderr: "" },
		...cleanWorkingTree({ [spaced]: "source" }),
	})
	assert.equal(runChecker({ exec, cwd: "/repo", biomeBin: "/repo/biome", io: silentIo().io }), 0)

	const biomeCall = exec.calls.find((call) => call.command === "/repo/biome")
	assert.equal(biomeCall.args.at(-1), path.join("/repo", spaced))
})

test("a non-zero Biome status is propagated and the proto check is not reached", () => {
	const exec = fakeExec({
		"git ls-files --stage -z": { status: 0, stdout: "", stderr: "" },
		"git diff --cached --name-status -z": {
			status: 0,
			stdout: nameStatus(["M", repoPath("src/a.ts")], ["M", repoPath(STATE_KEYS)]),
			stderr: "",
		},
		"/repo/biome check": { status: 1, stdout: "src/a.ts:1:1 lint/suspicious/noExplicitAny", stderr: "" },
		...cleanWorkingTree({ "src/a.ts": "source", [STATE_KEYS]: "keys" }),
	})
	const { io, lines } = silentIo()
	assert.equal(runChecker({ exec, cwd: "/repo", biomeBin: "/repo/biome", io }), 1)
	assert.ok(!exec.calls.some((call) => call.args[0] === "show"))
	assert.ok(lines.error.some((line) => line.includes("biome check failed")))
	assert.ok(lines.log.some((line) => line.includes("noExplicitAny")))
})

test("a fatal Biome status (2) is propagated verbatim", () => {
	const exec = fakeExec({
		"git ls-files --stage -z": { status: 0, stdout: "", stderr: "" },
		"git diff --cached --name-status -z": { status: 0, stdout: nameStatus(["M", repoPath("src/a.ts")]), stderr: "" },
		"/repo/biome check": { status: 2, stdout: "", stderr: "configuration error" },
		...cleanWorkingTree({ "src/a.ts": "source" }),
	})
	const { io, lines } = silentIo()
	assert.equal(runChecker({ exec, cwd: "/repo", biomeBin: "/repo/biome", io }), 2)
	assert.ok(lines.error.some((line) => line.includes("configuration error")))
})

test("unmerged (conflicted) paths fail fast before any linting", () => {
	const exec = fakeExec({
		"git ls-files --stage -z": {
			status: 0,
			stdout: `100644 ${"a".repeat(40)} 1\tsrc/conflicted.ts\0`,
			stderr: "",
		},
	})
	const { io, lines } = silentIo()
	assert.equal(runChecker({ exec, cwd: "/repo", biomeBin: "/repo/biome", io }), 1)
	assert.deepEqual(
		exec.calls.map((call) => call.key),
		["git ls-files --stage -z"],
	)
	assert.ok(lines.error.some((line) => line.includes("Unmerged paths")))
	assert.ok(lines.error.some((line) => line.includes("src/conflicted.ts")))
})

test("a failing git ls-files aborts with status 1", () => {
	const exec = fakeExec({ "git ls-files --stage -z": { status: 128, stdout: "", stderr: "not a git repository" } })
	const { io, lines } = silentIo()
	assert.equal(runChecker({ exec, io }), 1)
	assert.ok(lines.error.some((line) => line.includes("not a git repository")))
})

test("a failing git diff --cached aborts with status 1", () => {
	const exec = fakeExec({
		"git ls-files --stage -z": { status: 0, stdout: "", stderr: "" },
		"git diff --cached --name-status -z": { status: 128, stdout: "", stderr: "bad revision" },
	})
	const { io, lines } = silentIo()
	assert.equal(runChecker({ exec, cwd: "/repo", biomeBin: "/repo/biome", io }), 1)
	assert.ok(lines.error.some((line) => line.includes("bad revision")))
})

test("an unchanged, already-valid state.proto companion is read from the index and accepted (regression)", () => {
	// Only `state-keys.ts` is staged. `state.proto` is untouched, so it never
	// appears in the cached diff, yet the commit still ships it: the hook must
	// validate the index blob instead of silently skipping the coherence check.
	//
	// The staged key source is renderable, and the renderer answers with the
	// proto that is genuinely in the index, so an accepted run means the two
	// index blobs really agree.
	const stagedKeys = "export const SECRETS_KEYS = ['apiKey'] as const\n"
	const stagedProto = ['syntax = "proto3";', "message Secrets {", "  string apiKey = 1;", "}", ""].join("\n")
	const exec = fakeExec({
		"git ls-files --stage -z": { status: 0, stdout: "", stderr: "" },
		"git diff --cached --name-status -z": { status: 0, stdout: nameStatus(["M", repoPath(STATE_KEYS)]), stderr: "" },
		[`git show :./${STATE_KEYS}`]: { status: 0, stdout: stagedKeys, stderr: "" },
		[`git show :./${STATE_PROTO}`]: { status: 0, stdout: stagedProto, stderr: "" },
		...cleanWorkingTree({ [STATE_KEYS]: stagedKeys }),
	})
	const { io, lines } = silentIo()
	const render = ({ stateKeysSource }) => {
		assert.equal(stateKeysSource, stagedKeys, "the renderer must receive the staged blob")
		return stagedProto
	}
	assert.equal(
		runChecker({
			exec,
			cwd: "/repo",
			biomeBin: "/repo/biome",
			io,
			render,
			resolveCompilerOptions: () => ({ compilerOptions: {} }),
		}),
		0,
	)
	assert.ok(
		exec.calls.some((call) => call.key === `git show :./${STATE_PROTO}`),
		"the untouched companion must still be read from the index",
	)
	assert.ok(lines.log.some((line) => line.includes("matches the staged")))
})

test("staged bytes that differ from the working tree are rejected before Biome runs (regression)", () => {
	// The author staged a lint error, then fixed it locally without staging.
	// Biome would report the working tree as clean; the hook must refuse first.
	const exec = fakeExec({
		"git ls-files --stage -z": { status: 0, stdout: "", stderr: "" },
		"git diff --cached --name-status -z": { status: 0, stdout: nameStatus(["M", repoPath("src/a.ts")]), stderr: "" },
		"git rev-parse :./src/a.ts": { status: 0, stdout: `${"1".repeat(40)}\n`, stderr: "" },
		"git hash-object -- src/a.ts": { status: 0, stdout: `${"2".repeat(40)}\n`, stderr: "" },
	})
	const { io, lines } = silentIo()
	assert.equal(runChecker({ exec, cwd: "/repo", biomeBin: "/repo/biome", io }), 1)
	assert.ok(!exec.calls.some((call) => call.command === "/repo/biome"), "Biome must not run on unproven bytes")
	assert.ok(lines.error.some((line) => line.includes("staged changes that are not in the working tree")))
})

test("the inverse mismatch (valid staged, invalid working tree) is rejected too (regression)", () => {
	const exec = fakeExec({
		"git ls-files --stage -z": { status: 0, stdout: "", stderr: "" },
		"git diff --cached --name-status -z": { status: 0, stdout: nameStatus(["M", repoPath("src/a.ts")]), stderr: "" },
		"git rev-parse :./src/a.ts": { status: 0, stdout: `${"3".repeat(40)}\n`, stderr: "" },
		"git hash-object -- src/a.ts": { status: 0, stdout: `${"4".repeat(40)}\n`, stderr: "" },
	})
	const { io, lines } = silentIo()
	assert.equal(runChecker({ exec, cwd: "/repo", biomeBin: "/repo/biome", io }), 1)
	assert.ok(!exec.calls.some((call) => call.command === "/repo/biome"))
	assert.ok(
		lines.error.some((line) => line.includes("git add src/a.ts")),
		"the fix is spelled out for the author",
	)
})

test("the working tree of a staged state-keys.ts is compared as well", () => {
	const exec = fakeExec({
		"git ls-files --stage -z": { status: 0, stdout: "", stderr: "" },
		"git diff --cached --name-status -z": { status: 0, stdout: nameStatus(["M", repoPath(STATE_KEYS)]), stderr: "" },
		[`git rev-parse :./${STATE_KEYS}`]: { status: 0, stdout: "aaa\n", stderr: "" },
		[`git hash-object -- ${STATE_KEYS}`]: { status: 0, stdout: "bbb\n", stderr: "" },
	})
	const { io, lines } = silentIo()
	assert.equal(runChecker({ exec, cwd: "/repo", biomeBin: "/repo/biome", io }), 1)
	assert.ok(!exec.calls.some((call) => call.args[0] === "show"))
	assert.ok(lines.error.some((line) => line.includes(STATE_KEYS)))
})

test("a stale staged state.proto fails the run with actionable output", () => {
	// The committed proto lags the committed key source, so the renderer's
	// output cannot equal the staged blob and the hook must fail with guidance.
	const stagedKeys = "export const SECRETS_KEYS = ['apiKey'] as const\n"
	const stagedProto = ['syntax = "proto3";', "message Secrets {", "  string stale = 1;", "}", ""].join("\n")
	const renderableProto = ['syntax = "proto3";', "message Secrets {", "  string apiKey = 1;", "}", ""].join("\n")
	const exec = fakeExec({
		"git ls-files --stage -z": { status: 0, stdout: "", stderr: "" },
		"git diff --cached --name-status -z": {
			status: 0,
			stdout: nameStatus(["M", repoPath(STATE_KEYS)], ["M", repoPath(STATE_PROTO)]),
			stderr: "",
		},
		[`git show :./${STATE_KEYS}`]: { status: 0, stdout: stagedKeys, stderr: "" },
		[`git show :./${STATE_PROTO}`]: { status: 0, stdout: stagedProto, stderr: "" },
		...cleanWorkingTree({ [STATE_KEYS]: "keys", [STATE_PROTO]: "proto" }),
	})
	const { io, lines } = silentIo()
	const render = () => renderableProto
	assert.equal(
		runChecker({
			exec,
			cwd: "/repo",
			biomeBin: "/repo/biome",
			io,
			render,
			resolveCompilerOptions: () => ({ compilerOptions: {} }),
		}),
		1,
	)
	assert.ok(lines.error.some((line) => line.includes("out of date with the staged")))
	assert.ok(lines.error.some((line) => line.includes("generate-state-proto.mjs")))
})

test("a staged deletion is reported, never linted and never read as a blob", () => {
	const exec = fakeExec({
		"git ls-files --stage -z": { status: 0, stdout: "", stderr: "" },
		"git diff --cached --name-status -z": {
			status: 0,
			stdout: nameStatus(["D", repoPath("src/removed.ts")]),
			stderr: "",
		},
	})
	const { io, lines } = silentIo()
	assert.equal(runChecker({ exec, cwd: "/repo", biomeBin: "/repo/biome", io }), 0)
	assert.ok(!exec.calls.some((call) => call.command === "/repo/biome"))
	assert.ok(!exec.calls.some((call) => call.args[0] === "show"))
	assert.ok(!lines.error.some((line) => line.includes("rev-parse")))
})

// ---------------------------------------------------------------------------
// Preservation guarantees
// ---------------------------------------------------------------------------

test("the checker never issues a mutating git command", () => {
	const ALLOWED_GIT_SUBCOMMANDS = new Set(["ls-files", "show", "diff", "rev-parse", "hash-object"])
	const ALL_FORBIDDEN = ["add", "reset", "stash", "checkout", "restore", "commit", "update-index", "apply", "clean"]

	// The exact git invocations the CLI entrypoint can perform.
	const invocations = [
		["ls-files", "--stage", "-z"],
		["diff", "--cached", "--name-status", "-z"],
		["show", `:./${STATE_KEYS}`],
		["rev-parse", ":./src/a.ts"],
		["hash-object", "--", "src/a.ts"],
	]
	for (const args of invocations) {
		assert.ok(ALLOWED_GIT_SUBCOMMANDS.has(args[0]), `unexpected git subcommand: ${args[0]}`)
		for (const forbidden of ALL_FORBIDDEN) {
			assert.notEqual(args[0], forbidden)
		}
	}
	// `hash-object` is only ever used to *read* the working tree.
	const hashInvocation = invocations.find((args) => args[0] === "hash-object")
	assert.ok(!hashInvocation.includes("-w"), "hash-object must not write an object")

	// And the module only ever shells out to `git` / the Biome binary.
	const source = readFileSync(SCRIPT_PATH, "utf-8")
	for (const forbidden of ALL_FORBIDDEN) {
		assert.ok(!new RegExp(`"${forbidden}"`).test(source), `check-staged.mjs must not reference git ${forbidden}`)
	}
})

test("the checker module never imports or uses a file writer", () => {
	const source = readFileSync(SCRIPT_PATH, "utf-8")

	assert.ok(!/from\s+"node:fs"|require\("node:fs"\)/.test(source), "staged content must come from git, not the working tree")
	assert.ok(!source.includes("writeFile"), "the hook must never write files")
	assert.ok(!/shell:\s*true/.test(source), "no shell interpolation")
})

test("the husky pre-commit hook is read-only", () => {
	const hookPath = path.resolve(APP_ROOT, "..", "..", ".husky", "pre-commit")
	const hook = readFileSync(hookPath, "utf-8")

	assert.ok(hook.includes("gitleaks"), "the hook must still scan for secrets")
	assert.ok(hook.includes("check-staged.mjs"), "the hook must run the read-only checker")
	for (const forbidden of ["lint-staged", "git add", "git stash", "git checkout", "git restore", "git reset"]) {
		assert.ok(!hook.includes(forbidden), `pre-commit must not contain ${forbidden}`)
	}
})

test("nodeExec reports a failed spawn as a non-zero status without throwing", () => {
	const result = nodeExec(path.join(APP_ROOT, "definitely-not-a-real-binary-xyz"), [], { cwd: APP_ROOT })
	assert.equal(result.status, 1)
	assert.equal(typeof result.stdout, "string")
	assert.match(result.stderr, /\S/)
})
