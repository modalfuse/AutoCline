#!/usr/bin/env node
/**
 * Generates proto message definitions from TypeScript source of truth.
 *
 * This script reads the field definitions from src/shared/storage/state-keys.ts
 * and generates the corresponding proto message definitions for Secrets and Settings.
 *
 * Usage:
 *   node scripts/generate-state-proto.mjs            # write the regenerated proto file
 *   node scripts/generate-state-proto.mjs --check    # read-only: fail if the proto is stale
 *
 * The generated proto content is written to proto/cline/state.proto,
 * replacing only the Secrets and Settings messages while preserving
 * the rest of the file (services, enums, other messages).
 *
 * With `--check` the script performs the exact same rendering path but never
 * writes; it exits non-zero when proto/cline/state.proto does not match what
 * generation would produce. Explicit generation (no flag) stays available for
 * maintainers and CI tasks that are allowed to write.
 */

import * as fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Project, SyntaxKind } from "ts-morph"

const STATE_KEYS_PATH = "src/shared/storage/state-keys.ts"
const STATE_PROTO_PATH = "proto/cline/state.proto"

/**
 * Compiler options resolved from `tsconfig.json` when it can be read. Only the
 * option values are used; parsed callers never hand ts-morph a tsconfig path so
 * no files are implicitly added to the project.
 */
export function resolveTsConfigOptions({ repoRoot, tsConfigFilePath = "tsconfig.json" }) {
	const resolvedPath = path.resolve(repoRoot, tsConfigFilePath)
	if (!fs.existsSync(resolvedPath)) {
		return { compilerOptions: {} }
	}
	const project = new Project({ tsConfigFilePath: resolvedPath, skipAddingFilesFromTsConfig: true })
	return { compilerOptions: project.getCompilerOptions() }
}

export const STATE_KEYS_RELATIVE_PATH = STATE_KEYS_PATH
export const STATE_PROTO_RELATIVE_PATH = STATE_PROTO_PATH

/**
 * Unix line-ending comparison: line-ending churn must not be mistaken for a
 * stale generated body.
 */
export function normalizeNewlines(text) {
	return text.replace(/\r\n/g, "\n")
}

/**
 * Compare generated content against an existing proto file.
 * Returns a structured result instead of throwing so callers can report it.
 * Never writes.
 */
export function checkGeneratedProto({ generatedContent, currentContent }) {
	const expected = normalizeNewlines(generatedContent)
	const actual = normalizeNewlines(currentContent ?? "")
	if (expected === actual) {
		return { ok: true, reason: null }
	}
	return { ok: false, reason: firstDifference(expected, actual) }
}

/**
 * First differing line of two full-file contents, for human-readable errors.
 *
 * Lines are compared only up to the point where both files actually have
 * content: the artificial trailing "" produced by `String.prototype.split` on a
 * file that ends with "\n" is not a real line and must not be reported as a
 * difference (that made a truncated file look like a blank line instead of a
 * missing one).
 *
 * A side whose content ended before the other side's is reported as
 * `<end of file>` — that is information: the other file has lines this one does
 * not have at all.
 */
export function firstDifference(expected, actual) {
	const expectedLines = expected.split("\n")
	const actualLines = actual.split("\n")
	const max = Math.max(expectedLines.length, actualLines.length)
	for (let index = 0; index < max; index++) {
		if (expectedLines[index] !== actualLines[index]) {
			const lineNumber = index + 1
			return (
				`first difference at line ${lineNumber}:\n` +
				`  expected: ${describeFileLine(expected, expectedLines, index)}\n` +
				`  actual:   ${describeFileLine(actual, actualLines, index)}`
			)
		}
	}
	return "contents differ only by trailing bytes"
}

/**
 * A line is only "present" when the file has characters at that position:
 * `split("\n")` yields a phantom final "" for a file ending in a newline, and an
 * empty file yields [""]. Both mean "the file has no such line".
 */
function describeFileLine(fileText, lines, index) {
	if (index >= lines.length) {
		return "<end of file>"
	}
	const line = lines[index]
	if (line === "" && index === lines.length - 1 && index > 0 && fileText.endsWith("\n")) {
		return "<end of file>"
	}
	if (line === "" && lines.length === 1) {
		return "<end of file>"
	}
	return JSON.stringify(line)
}

/**
 * Render one line of a file for an error message.
 *
 * A file that ends early is reported as `<end of file>` rather than as an empty
 * string, so "the file is missing these lines entirely" is never confused with
 * "the line exists but is blank". Only genuinely present blank lines render as
 * `""`.
 */
function describeLine(lines, index) {
	if (index >= lines.length) {
		return "<end of file>"
	}
	return JSON.stringify(lines[index])
}

export const STATE_PROTO_RENDERED_MESSAGES = ["Secrets", "Settings"]

/**
 * Compare the line ranges of `state.proto` visible in the staged diff against the
 * freshly rendered output.
 *
 * `expectedContent` is what generation would produce for the *staged* state-keys
 * source; `stagedContent` is the staged `state.proto` blob. Only the changed
 * ranges are compared, because the staged file may legitimately contain
 * unrelated edits from an earlier commit. What this guarantees is that whatever
 * this commit *touches* in the generated messages matches `state-keys.ts`, so a
 * stale generated body can never be committed.
 */
export function checkStagedProtoMessages({ expectedContent, stagedContent, ranges }) {
	const expectedLines = normalizeNewlines(expectedContent).split("\n")
	const stagedLines = normalizeNewlines(stagedContent ?? "").split("\n")

	for (const range of ranges) {
		const expectedSlice = expectedLines.slice(range.start - 1, range.end)
		const stagedSlice = stagedLines.slice(range.start - 1, range.end)
		const result = compareLineRanges({ expectedLines: expectedSlice, actualLines: stagedSlice, range })
		if (!result.ok) {
			return result
		}
	}

	return { ok: true, reason: null }
}

/**
 * Line-based comparison for a *subset* of the proto file (1-based inclusive
 * range in the new/staged file).
 */
export function compareLineRanges({ expectedLines, actualLines, range }) {
	const lastIndex = Math.max(expectedLines.length, actualLines.length)
	for (let index = 0; index < lastIndex; index++) {
		if ((expectedLines[index] ?? null) !== (actualLines[index] ?? null)) {
			return {
				ok: false,
				reason:
					`first difference at line ${range.start + index}:` +
					` expected ${describeSliceLine(expectedLines, index)}` +
					` but staged ${describeSliceLine(actualLines, index)}`,
			}
		}
	}
	return { ok: true, reason: null }
}

/**
 * Render one line of a sliced range for an error message. A slice that ended
 * before this index means the file stopped early: report `<end of file>`
 * instead of an empty string so "missing lines" can never be confused with
 * "blank line".
 */
function describeSliceLine(lines, index) {
	if (index >= lines.length) {
		return JSON.stringify("<end of file>")
	}
	return JSON.stringify(lines[index])
}

/**
 * Parse a `git diff --cached --unified=0` output into the hunks (new-file line
 * numbers) of every hunk it contains. One file per invocation means the result
 * only depends on that file's staged changes.
 *
 * Only `+` line numbers are needed: they say exactly which line ranges of the
 * *staged* blob changed.
 */
export function parseUnifiedDiffHunks(diffText) {
	const hunks = []
	const headerPattern = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/
	for (const line of diffText.split("\n")) {
		const match = headerPattern.exec(line)
		if (!match) {
			continue
		}
		hunks.push({
			start: Number.parseInt(match[1], 10),
			count: match[2] === undefined ? 1 : Number.parseInt(match[2], 10),
		})
	}
	return hunks
}

/**
 * Turn unified-diff hunks (1-based, inclusive) into an array of
 * `{ start, end }` 1-based inclusive line ranges, merging overlapping ranges.
 */
export function hunksToLineRanges(hunks) {
	const ranges = []
	for (const hunk of hunks) {
		if (hunk.count <= 0) {
			continue
		}
		const range = { start: hunk.start, end: hunk.start + hunk.count - 1 }
		const previous = ranges[ranges.length - 1]
		if (previous && range.start <= previous.end + 1) {
			previous.end = Math.max(previous.end, range.end)
		} else {
			ranges.push(range)
		}
	}
	return ranges
}

function countBraces(line) {
	let depth = 0
	for (const char of line) {
		if (char === "{") {
			depth++
		} else if (char === "}") {
			depth--
		}
	}
	return depth
}

function declarationKeyword(line) {
	const match = line.match(/^[ \t]*([A-Za-z_]+)\b/)
	return match ? match[1] : ""
}

function declarationName(declarationText) {
	const match = declarationText.match(/^[ \t]*[A-Za-z_]+[ \t]+([A-Za-z0-9_]+)/)
	return match ? match[1] : ""
}

/**
 * Split the pending gap that precedes the *first* declaration into header text
 * and that declaration's own leading text.
 *
 * The header is the file's preamble (`syntax`, `package`, `option`, ...) and
 * must not absorb the blank line(s) that separate it from the first
 * declaration. Those blank lines are the declaration's `lead` instead, so they
 * survive byte-for-byte while `header` reports only the preamble.
 */
function splitHeaderAndLead(pendingGap) {
	const segments = pendingGap.split("\n")
	// `split` on a text ending with "\n" yields a phantom final ""; keep it out
	// of the scan so it is not mistaken for a blank separator line.
	const lastIndex = segments.length - 1
	let blankStart = segments.length
	for (let index = lastIndex; index >= 0; index--) {
		if (segments[index] !== "") {
			break
		}
		blankStart = index
	}
	if (blankStart === segments.length) {
		return { header: pendingGap, lead: "" }
	}
	// The text ending at the last non-empty line, with the newline that
	// terminates it re-attached.
	const header = `${segments.slice(0, blankStart).join("\n")}\n`
	return { header, lead: pendingGap.slice(header.length) }
}

/**
 * Split proto text into a header (`syntax`, `package`, ...) and the ordered list
 * of every proto declaration found in the file.
 *
 * A declaration starts at a line whose first token is a top-level proto keyword
 * and ends at a balanced closing brace. This is deliberately simple but stable:
 * it only depends on brace balance, not on the contents of the messages we
 * rewrite.
 *
 * `header` is only the text that genuinely precedes any declaration: it stops
 * at the last non-blank preamble line, so the blank line that separates the
 * header from the first declaration is not folded into it. That blank line (and
 * any comment interleaved with it) is that declaration's `lead`; every
 * subsequent declaration likewise owns the gap that precedes it as its `lead`,
 * and the last declaration owns the file's trailing text as its `gap` (which
 * includes the newline that ends its closing brace, so a replacement body
 * without one still ends at the right place on the line following it).
 *
 * The reconstruction identity is
 * `header + declarations.map(d => d.lead + d.text + d.gap).join("")`, which is
 * exactly the input: no byte is inserted, dropped or moved. Because the file is
 * cut at each declaration's own boundaries, replacing one declaration's `text`
 * leaves every other declaration's bytes untouched, keeps the neighbouring
 * separators exactly where they were, and re-emitting an unchanged body
 * reproduces the input verbatim (a fixed point).
 */
export function splitProtoTopLevel(text) {
	const lines = text.split("\n")
	const declarations = []
	let headerText = ""
	let current = null
	let depth = 0
	// Gap text seen while no declaration is open: the lead of the next
	// declaration, or the trailing text at end of file.
	let pendingGap = ""

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]
		// Re-attach the newline that `split` consumed, except for the final
		// element which only exists because the file ended with "\n".
		const isLastLine = index === lines.length - 1
		const lineText = isLastLine ? line : `${line}\n`

		if (current !== null) {
			current.push(lineText)
			depth += countBraces(line)
			if (depth <= 0) {
				// The newline that terminated the closing brace belongs to the
				// trailing gap, not to the declaration body, so a replacement
				// body without a trailing newline still lands on the same bytes.
				const text = current.join("")
				if (text.endsWith("\n")) {
					current = null
					declarations[declarations.length - 1].text = text.slice(0, -1)
					pendingGap = "\n"
				} else {
					current = null
					declarations[declarations.length - 1].text = text
				}
				depth = 0
			}
			continue
		}

		if (/^[ \t]*(message|enum|service|extend|oneof)\b/.test(line)) {
			let lead = pendingGap
			if (declarations.length === 0) {
				const split = splitHeaderAndLead(pendingGap)
				headerText = split.header
				lead = split.lead
			}
			declarations.push({ lead, text: lineText, keyword: declarationKeyword(line), gap: "" })
			current = [lineText]
			pendingGap = ""
			depth = countBraces(line)
			continue
		}

		// Everything that is not a declaration start is kept verbatim as the
		// pending gap. It is handed either to the next declaration (as its
		// lead) or, if no declaration follows, to the last declaration's
		// trailing gap (or the header when the file has no declarations at
		// all), so no byte is lost.
		pendingGap += lineText
	}

	if (current !== null) {
		// Unterminated declaration at end of file: keep its bytes as they are.
		declarations[declarations.length - 1].text = current.join("")
	}

	// Whatever remains after the last declaration is its trailing gap, so the
	// concatenation of header + (lead + text + gap) for every declaration
	// reproduces the input byte-for-byte. With no declarations at all the whole
	// file is header text.
	if (declarations.length > 0) {
		declarations[declarations.length - 1].gap += pendingGap
	} else {
		headerText += pendingGap
	}

	return { header: headerText, declarations }
}

/**
 * Convert field name to valid snake_case proto field name.
 * Handles camelCase (apiKey -> api_key) and hyphens (openai-codex -> openai_codex).
 */
function toProtoFieldName(str) {
	return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`).replace(/-/g, "_")
}

// Fields that should use int64 instead of int32
const INT64_FIELDS = new Set(["planModeThinkingBudgetTokens", "actModeThinkingBudgetTokens"])

// Fields that should use double instead of int32
const DOUBLE_FIELDS = new Set()

/**
 * Infer proto type from TypeScript type expression
 * @param {string} typeText - The TypeScript type expression
 * @param {string} [fieldName] - Optional field name for field-specific overrides
 */
function inferProtoType(typeText, fieldName) {
	// Remove 'undefined' from union types
	const cleanType = typeText
		.replace(/\s*\|\s*undefined/g, "")
		.replace(/undefined\s*\|\s*/g, "")
		.trim()

	// Handle common types
	if (cleanType === "string") {
		return "string"
	}
	if (cleanType === "boolean") {
		return "bool"
	}
	if (cleanType === "number") {
		// Some number fields need specific numeric types
		if (fieldName && INT64_FIELDS.has(fieldName)) {
			return "int64"
		}
		if (fieldName && DOUBLE_FIELDS.has(fieldName)) {
			return "double"
		}
		return "int32"
	}

	// Handle Record<string, string> as map<string, string>
	if (/Record\s*<\s*string\s*,\s*string\s*>/.test(cleanType)) {
		return "map<string, string>"
	}

	// Handle specific known types that map to proto messages/enums
	// Order matters! More specific types must come before generic ones
	// (e.g., OpenAiCompatibleModelInfo before ModelInfo)
	// Check known types BEFORE string literals, since types like `"act" as Mode`
	// contain quotes but should map to proto enums
	const knownTypes = [
		// Specific model info types first
		["OpenAiCompatibleModelInfo", "OpenAiCompatibleModelInfo"],
		["LiteLLMModelInfo", "LiteLLMModelInfo"],
		["OcaModelInfo", "OcaModelInfo"],
		// Generic ModelInfo last (catches OpenRouterModelInfo, etc.)
		["ModelInfo", "OpenRouterModelInfo"],
		// Other types - order matters for substring matching
		["AutoApprovalSettings", "AutoApprovalSettings"],
		["BrowserSettings", "BrowserSettings"],
		["OpenaiReasoningEffort", "OpenaiReasoningEffort"],
		["PlanActMode", "PlanActMode"],
		["ApiProvider", "string"],
		["LanguageModelChatSelector", "LanguageModelChatSelector"], // Must come before "Mode" check
	]

	for (const [tsType, protoType] of knownTypes) {
		if (cleanType.includes(tsType)) {
			return protoType
		}
	}

	// Check for Mode type separately with word boundary to avoid matching "VsCodeLmModelSelector"
	// This handles TS `Mode` type which maps to proto `PlanActMode`
	if (/\bMode\b/.test(cleanType)) {
		return "PlanActMode"
	}

	// Handle specific string literal unions (treat as string)
	// This comes after known types check since some types like `"act" as Mode` contain quotes
	if (cleanType.includes('"') || cleanType.includes("'")) {
		return "string"
	}

	// Default to string for complex types we can't map
	return "string"
}

/**
 * Parse the SECRETS_KEYS array from state-keys.ts
 */
function parseSecretsKeys(sourceFile) {
	const secretsDecl = sourceFile.getVariableDeclaration("SECRETS_KEYS")
	if (!secretsDecl) {
		throw new Error("Could not find SECRETS_KEYS declaration")
	}

	let initializer = secretsDecl.getInitializer()
	if (!initializer) {
		throw new Error("SECRETS_KEYS has no initializer")
	}

	// Handle 'as const' expression
	if (initializer.getKind() === SyntaxKind.AsExpression) {
		initializer = initializer.getExpression()
	}

	if (initializer.getKind() !== SyntaxKind.ArrayLiteralExpression) {
		throw new Error(`SECRETS_KEYS is not an array literal (got ${SyntaxKind[initializer.getKind()]})`)
	}

	const keys = []
	for (const element of initializer.getElements()) {
		const text = element.getText()
		// Remove quotes and handle special prefixes
		const key = text.replace(/^['"]|['"]$/g, "")
		// Skip prefixed keys like "cline:clineAccountId"
		if (!key.includes(":")) {
			keys.push(key)
		}
	}

	return keys
}

/**
 * Parse field definitions from an object literal in state-keys.ts
 */
function parseFieldDefinitions(sourceFile, variableName) {
	const decl = sourceFile.getVariableDeclaration(variableName)
	if (!decl) {
		throw new Error(`Could not find ${variableName} declaration`)
	}

	const initializer = decl.getInitializer()
	if (!initializer) {
		throw new Error(`${variableName} has no initializer`)
	}

	// Handle 'satisfies' expression
	let objectLiteral = initializer
	if (initializer.getKind() === SyntaxKind.SatisfiesExpression) {
		objectLiteral = initializer.getExpression()
	}

	if (objectLiteral.getKind() !== SyntaxKind.ObjectLiteralExpression) {
		throw new Error(`${variableName} is not an object literal`)
	}

	const fields = []
	for (const prop of objectLiteral.getProperties()) {
		if (prop.getKind() !== SyntaxKind.PropertyAssignment) {
			continue
		}

		const name = prop.getName()
		const propInit = prop.getInitializer()

		if (!propInit || propInit.getKind() !== SyntaxKind.ObjectLiteralExpression) {
			continue
		}

		// Get the 'default' property to infer the type
		const defaultProp = propInit.getProperty("default")
		if (!defaultProp) {
			continue
		}

		let typeText = "string"
		const defaultInit = defaultProp.getInitializer()
		if (defaultInit) {
			// Check for 'as' expression to get the type
			if (defaultInit.getKind() === SyntaxKind.AsExpression) {
				const typeNode = defaultInit.getTypeNode()
				if (typeNode) {
					typeText = typeNode.getText()
				}
			} else {
				// Infer from literal
				const text = defaultInit.getText()
				if (text === "true" || text === "false") {
					typeText = "boolean"
				} else if (/^\d+$/.test(text)) {
					typeText = "number"
				} else if (/^\d+\.\d+$/.test(text)) {
					typeText = "number"
				}
			}
		}

		fields.push({
			name,
			tsType: typeText,
			protoType: inferProtoType(typeText, name),
		})
	}

	return fields
}

/**
 * Convert snake_case to camelCase for mapping proto fields back to TS keys
 */
function snakeToCamel(str) {
	return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
}

/**
 * Normalize a property key to the camelCase form parsed from proto field names.
 * Example: "openai-codex-oauth-credentials" -> "openaiCodexOauthCredentials".
 * We do this before looking up existing field numbers so regenerated proto fields
 * reuse their old numbers instead of being treated as new fields.
 */
function normalizePropertyNameForProtoLookup(fieldName) {
	return snakeToCamel(toProtoFieldName(fieldName))
}

/**
 * Fail fast when two distinct property keys collapse to the same normalized lookup key.
 * Collisions make field-number preservation ambiguous and can cause proto renumbering.
 */
function assertNoNormalizedFieldNameCollisions(fields) {
	const normalizedToOriginalNames = new Map()

	for (const field of fields) {
		const normalizedName = normalizePropertyNameForProtoLookup(field.name)
		const names = normalizedToOriginalNames.get(normalizedName) ?? new Set()
		names.add(field.name)
		normalizedToOriginalNames.set(normalizedName, names)
	}

	for (const [normalizedName, names] of normalizedToOriginalNames) {
		if (names.size > 1) {
			const sortedNames = [...names].sort()
			throw new Error(
				`Field-name collision after proto normalization: ${sortedNames.join(", ")} all normalize to "${normalizedName}". Rename one field to keep proto field-number mapping unambiguous.`,
			)
		}
	}
}

/**
 * Parse field numbers from an existing proto message definition
 * Returns a map of camelCase field names to their field numbers
 */
function parseProtoMessageFieldNumbers(protoContent, messageName) {
	const fieldNumbers = {}

	// Match the message block (handles single-level nesting for now)
	const messageRegex = new RegExp(`message\\s+${messageName}\\s*\\{([^}]*(?:\\{[^}]*\\}[^}]*)*)\\}`, "s")
	const match = protoContent.match(messageRegex)

	if (!match) {
		return fieldNumbers
	}

	const messageBody = match[1]

	// Match field definitions: optional/required/repeated type name = number;
	// Supports scalar/message types and map fields.
	const fieldRegex = /(?:optional|required|repeated)?\s*(?:map<[^>]+>|[\w.]+)\s+(\w+)\s*=\s*(\d+)\s*;/g
	const matches = messageBody.matchAll(fieldRegex)

	for (const fieldMatch of matches) {
		const snakeName = fieldMatch[1]
		const fieldNum = Number.parseInt(fieldMatch[2], 10)
		const camelName = snakeToCamel(snakeName)
		fieldNumbers[camelName] = fieldNum
	}

	return fieldNumbers
}

/**
 * Parse `reserved` statements from an existing proto message definition so they
 * survive regeneration (removed fields must keep their numbers/names reserved).
 */
function parseProtoMessageReservedStatements(protoContent, messageName) {
	const messageRegex = new RegExp(`message\\s+${messageName}\\s*\\{([^}]*(?:\\{[^}]*\\}[^}]*)*)\\}`, "s")
	const match = protoContent.match(messageRegex)

	if (!match) {
		return []
	}

	return [...match[1].matchAll(/^[ \t]*(reserved\b[^\n]*)$/gm)].map((m) => m[1].trim())
}

/**
 * Extract the set of field numbers covered by `reserved` statements
 * (single numbers, comma lists, and `N to M` ranges; name reservations are ignored).
 */
function parseReservedFieldNumbers(reservedStatements) {
	const reservedNumbers = new Set()

	for (const statement of reservedStatements) {
		// Strip the keyword, trailing semicolon, and any comment
		const body = statement
			.replace(/^reserved\b/, "")
			.replace(/;.*$/, "")
			.trim()

		// Name reservations (quoted) carry no numbers
		if (body.includes('"') || body.includes("'")) {
			continue
		}

		for (const part of body.split(",")) {
			const rangeMatch = part.trim().match(/^(\d+)\s+to\s+(\d+|max)$/)
			if (rangeMatch) {
				const start = Number.parseInt(rangeMatch[1], 10)
				// "to max" reserves everything upward; represent with Infinity
				const end = rangeMatch[2] === "max" ? Number.POSITIVE_INFINITY : Number.parseInt(rangeMatch[2], 10)
				if (end === Number.POSITIVE_INFINITY) {
					throw new Error(`"reserved ${part.trim()}" leaves no field numbers available for new fields`)
				}
				for (let n = start; n <= end; n++) {
					reservedNumbers.add(n)
				}
			} else if (/^\d+$/.test(part.trim())) {
				reservedNumbers.add(Number.parseInt(part.trim(), 10))
			}
		}
	}

	return reservedNumbers
}

/**
 * Load field number mappings and reserved statements from an existing proto file
 * content (in-memory). Returns empty mappings when the proto is missing.
 */
function loadFieldNumbersFromProto(protoContent, log = () => {}) {
	if (typeof protoContent !== "string") {
		// Proto file doesn't exist, start fresh
		return { Secrets: {}, Settings: {}, SecretsReserved: [], SettingsReserved: [] }
	}

	const secrets = parseProtoMessageFieldNumbers(protoContent, "Secrets")
	const settings = parseProtoMessageFieldNumbers(protoContent, "Settings")
	const secretsReserved = parseProtoMessageReservedStatements(protoContent, "Secrets")
	const settingsReserved = parseProtoMessageReservedStatements(protoContent, "Settings")

	log(`  Found ${Object.keys(secrets).length} existing Secrets fields`)
	log(`  Found ${Object.keys(settings).length} existing Settings fields`)

	return { Secrets: secrets, Settings: settings, SecretsReserved: secretsReserved, SettingsReserved: settingsReserved }
}

/**
 * Assign field numbers, preserving existing assignments and adding new ones.
 * Reserved numbers are never handed out to new fields.
 */
function assignFieldNumbers(fields, existingNumbers, startNumber = 1, reservedNumbers = new Set()) {
	const result = {}
	let nextNumber = startNumber

	assertNoNormalizedFieldNameCollisions(fields)

	// Find the highest existing number
	for (const num of Object.values(existingNumbers)) {
		if (num >= nextNumber) {
			nextNumber = num + 1
		}
	}

	// Preserve existing assignments
	for (const field of fields) {
		// Normalize before lookup so keys like "openai-codex-oauth-credentials"
		// reuse existing proto numbers instead of being treated as new fields.
		const normalizedFieldName = normalizePropertyNameForProtoLookup(field.name)
		const normalizedFieldNumber = existingNumbers[normalizedFieldName]
		const rawFieldNumber = existingNumbers[field.name]

		if (normalizedFieldNumber !== undefined && rawFieldNumber !== undefined && normalizedFieldNumber !== rawFieldNumber) {
			throw new Error(
				`Ambiguous proto field-number mapping for "${field.name}": normalized key "${normalizedFieldName}" -> ${normalizedFieldNumber}, raw key "${field.name}" -> ${rawFieldNumber}.`,
			)
		}

		const existingFieldNumber = normalizedFieldNumber ?? rawFieldNumber
		if (existingFieldNumber !== undefined) {
			if (reservedNumbers.has(existingFieldNumber)) {
				throw new Error(
					`Field "${field.name}" uses number ${existingFieldNumber}, which is also covered by a reserved statement. Remove the field or the reservation.`,
				)
			}
			result[field.name] = existingFieldNumber
		}
	}

	// Assign new numbers for new fields, skipping reserved numbers
	for (const field of fields) {
		if (result[field.name] === undefined) {
			while (reservedNumbers.has(nextNumber)) {
				nextNumber++
			}
			result[field.name] = nextNumber++
		}
	}

	return result
}

/**
 * Generate proto message definition
 */
function generateProtoMessage(messageName, fields, fieldNumbers, reservedStatements = []) {
	const lines = [`message ${messageName} {`]

	// Re-emit reserved statements so removed field numbers/names stay reserved
	for (const statement of reservedStatements) {
		lines.push(`  ${statement}`)
	}

	// Sort fields by field number for consistent output
	const sortedFields = [...fields].sort((a, b) => fieldNumbers[a.name] - fieldNumbers[b.name])

	for (const field of sortedFields) {
		const snakeName = toProtoFieldName(field.name)
		const fieldNum = fieldNumbers[field.name]
		// Map types cannot have the 'optional' modifier in proto3
		const prefix = field.protoType.startsWith("map<") ? "" : "optional "
		lines.push(`  ${prefix}${field.protoType} ${snakeName} = ${fieldNum};`)
	}

	lines.push("}")
	return lines.join("\n")
}

/**
 * Generate Secrets message from SECRETS_KEYS
 */
function generateSecretsMessage(secretsKeys, fieldNumbers, reservedStatements) {
	const fields = secretsKeys.map((key) => ({
		name: key,
		protoType: "string",
	}))

	return generateProtoMessage("Secrets", fields, fieldNumbers, reservedStatements)
}

/**
 * Maximum shift allowed when matching a message that drifted from its
 * declaration keyword. `state.proto` is small; this keeps matching local so a
 * distant message that happens to contain the same text is never substituted.
 */
const MAX_MESSAGE_DRIFT = 4

/**
 * Replace a single top-level message declaration in `protoContent` by position
 * (not by a greedy regex):
 *   - the `message <messageName> { ... }` declaration is replaced;
 *   - if its keyword drifted (`enums Secrets {`) the first declaration with that
 *     name is replaced instead, keeping the previous regex match semantics;
 *   - every other declaration is preserved byte-for-byte.
 *
 * `message Settings` can never be matched when replacing `Secrets`, so a comment
 * or nested block elsewhere in the file can no longer be mistaken for the start
 * of the message being rewritten.
 */
export function replaceMessage(protoContent, messageName, newMessageContent, log = () => {}) {
	const { header, declarations } = splitProtoTopLevel(protoContent)

	// Index of the `message <name>` declaration in the current file. When the
	// keyword drifted (e.g. a corrupted `enums Secrets {`) it is -1 and the first
	// declaration named `<name>` is replaced instead, which keeps the replacement
	// limited to a single declaration.
	const nominalIndex = declarations.findIndex((declaration) => {
		return declarationName(declaration.text) === messageName && declaration.keyword === "message"
	})

	let replacedIndex = -1
	for (let index = 0; index < declarations.length; index++) {
		const declaration = declarations[index]
		if (declarationName(declaration.text) !== messageName) {
			continue
		}
		if (nominalIndex === -1) {
			replacedIndex = index
			break
		}
		if (Math.abs(index - nominalIndex) <= MAX_MESSAGE_DRIFT) {
			replacedIndex = index
			break
		}
	}

	if (replacedIndex === -1) {
		log(`Warning: ${messageName} message not found in proto file, appending`)
		const separator = protoContent.endsWith("\n") || protoContent.length === 0 ? "\n" : "\n\n"
		return `${protoContent}${separator}${newMessageContent}\n`
	}

	// Each declaration owns exactly its own bytes plus the verbatim text that
	// precedes it (its `lead`) and the verbatim text that follows it (its
	// `gap`: blank lines, comments, the newline that ended its closing brace).
	// Joining with "" therefore reproduces every unrelated byte exactly, the
	// replaced declaration keeps its own lead and trailing gap so the
	// separators around it stay put, and an unchanged body re-emits the file
	// unchanged (a fixed point) while a new body only occupies the
	// declaration's own slot.
	const body = declarations
		.map((declaration, index) => {
			if (index !== replacedIndex) {
				return declaration.lead + declaration.text + declaration.gap
			}
			return declaration.lead + newMessageContent + declaration.gap
		})
		.join("")

	return header + body
}

/**
 * Render the generated proto content. Pure with respect to the filesystem:
 * the TS source and the existing proto content are passed in explicitly, so
 * callers can render from staged blobs as well as from the working tree.
 *
 * @param {object} input
 * @param {string} input.stateKeysSource contents of src/shared/storage/state-keys.ts
 * @param {string|null} input.protoSource contents of proto/cline/state.proto (null when absent)
 * @param {object} [input.compilerOptions] ts-morph compiler options (from tsconfig.json)
 * @param {(message: string) => void} [input.log]
 * @returns {string} the would-be proto file content (nothing is written)
 */
export function renderStateProto({ stateKeysSource, protoSource, compilerOptions, log = () => {} }) {
	const project = new Project({ compilerOptions, skipAddingFilesFromTsConfig: true })

	const sourceFile = project.createSourceFile(STATE_KEYS_PATH, stateKeysSource, { overwrite: true })

	const secretsKeys = parseSecretsKeys(sourceFile)
	log(`Found ${secretsKeys.length} secret keys`)

	const apiHandlerFields = parseFieldDefinitions(sourceFile, "API_HANDLER_SETTINGS_FIELDS")
	const userSettingsFields = parseFieldDefinitions(sourceFile, "USER_SETTINGS_FIELDS")
	const settingsFields = [...apiHandlerFields, ...userSettingsFields]
	log(`Found ${settingsFields.length} settings fields`)

	const existingFieldNumbers = loadFieldNumbersFromProto(protoSource, log)

	// Assign field numbers (preserving existing, adding new ones, never reusing reserved ones)
	const secretsFieldNumbers = assignFieldNumbers(
		secretsKeys.map((k) => ({ name: k })),
		existingFieldNumbers.Secrets,
		1,
		parseReservedFieldNumbers(existingFieldNumbers.SecretsReserved),
	)
	const settingsFieldNumbers = assignFieldNumbers(
		settingsFields,
		existingFieldNumbers.Settings,
		1,
		parseReservedFieldNumbers(existingFieldNumbers.SettingsReserved),
	)

	const secretsMessage = generateSecretsMessage(secretsKeys, secretsFieldNumbers, existingFieldNumbers.SecretsReserved)
	const settingsMessage = generateProtoMessage(
		"Settings",
		settingsFields,
		settingsFieldNumbers,
		existingFieldNumbers.SettingsReserved,
	)

	let protoContent = protoSource ?? ""
	protoContent = replaceMessage(protoContent, "Secrets", secretsMessage, log)
	protoContent = replaceMessage(protoContent, "Settings", settingsMessage, log)

	return protoContent
}

/**
 * Compare generated content against the current proto file content.
 * Returns a structured result instead of throwing so callers can report it.
 * Never writes.
 */
export function parseCliArgs(argv) {
	const options = { check: false, help: false }
	for (const arg of argv) {
		if (arg === "--check") {
			options.check = true
		} else if (arg === "--help" || arg === "-h") {
			options.help = true
		} else {
			throw new Error(`Unknown argument: ${arg}. Supported flags: --check, --help`)
		}
	}
	return options
}

/**
 * Run the generator CLI.
 *
 * `--check` is strictly read-only: it renders the would-be proto content with
 * the same `renderStateProto` path used for generation and fails when the
 * on-disk proto does not match. Without the flag the regenerated content is
 * written, keeping explicit generation available.
 */
export function main(argv = process.argv.slice(2), io = { log: console.log, error: console.error }) {
	const options = parseCliArgs(argv)

	if (options.help) {
		io.log("Usage: node scripts/generate-state-proto.mjs [--check]")
		return 0
	}

	io.log(
		options.check
			? "Checking generated proto definitions against TypeScript source..."
			: "Generating proto definitions from TypeScript source...",
	)

	const stateKeysSource = fs.readFileSync(STATE_KEYS_PATH, "utf-8")
	const currentProtoContent = readIfPresent(STATE_PROTO_PATH)

	const { compilerOptions } = resolveTsConfigOptions({ repoRoot: process.cwd() })

	const generatedContent = renderStateProto({
		stateKeysSource,
		protoSource: currentProtoContent,
		compilerOptions,
		log: (message) => io.log(`  ${message.trimStart()}`),
	})

	if (options.check) {
		const result = checkGeneratedProto({ generatedContent, currentContent: currentProtoContent })
		if (!result.ok) {
			io.error(`${STATE_PROTO_PATH} is out of date with ${STATE_KEYS_PATH}.`)
			io.error(result.reason)
			io.error("Run 'node scripts/generate-state-proto.mjs' to update it, then stage the result.")
			return 1
		}
		io.log(`${STATE_PROTO_PATH} is up to date`)
		return 0
	}

	if (currentProtoContent === generatedContent) {
		io.log(`${STATE_PROTO_PATH} is already up to date, nothing written`)
		return 0
	}

	fs.writeFileSync(STATE_PROTO_PATH, generatedContent)
	io.log(`Updated ${STATE_PROTO_PATH}`)
	io.log("\nGeneration complete! Run 'bun run protos' to regenerate TypeScript from protos.")
	return 0
}

function readIfPresent(filePath) {
	try {
		return fs.readFileSync(filePath, "utf-8")
	} catch (error) {
		if (error && error.code === "ENOENT") {
			return null
		}
		throw error
	}
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
		process.exitCode = main()
	} catch (error) {
		console.error("Error:", error)
		process.exitCode = 1
	}
}
