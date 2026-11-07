import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DESKTOP_NOTICE_ID,
	getClineCliMigrationNotice,
	markClineCliMigrationNoticeShown,
	resolveCliNoticeStatePath,
} from "./notice";

const tempDirs: string[] = [];

function createTempDataDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "cline-cli-notice-"));
	tempDirs.push(dir);
	return dir;
}

describe("migration notice", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns the desktop notice for a fresh data dir", () => {
		const dataDir = createTempDataDir();

		const notice = getClineCliMigrationNotice(dataDir);
		expect(notice?.id).toBe(DESKTOP_NOTICE_ID);
		expect(notice?.url).toBe("https://cline.bot/desktop");
	});

	it("has no ClinePass promo notice left", () => {
		const dataDir = createTempDataDir();

		const notice = getClineCliMigrationNotice(dataDir);
		expect(notice?.id).not.toBe("cline-cli-cline-pass-intro");
		expect(JSON.stringify(notice)).not.toContain("ClinePass");
	});

	it("shows when only the legacy Kanban notice was marked as shown", () => {
		const dataDir = createTempDataDir();
		const noticePath = resolveCliNoticeStatePath(dataDir);
		mkdirSync(dirname(noticePath), { recursive: true, mode: 0o700 });
		writeFileSync(
			noticePath,
			`${JSON.stringify(
				{ shown: { "cline-cli-tui-default": true } },
				null,
				2,
			)}\n`,
			"utf8",
		);

		expect(getClineCliMigrationNotice(dataDir)?.id).toBe(DESKTOP_NOTICE_ID);
	});

	it("ignores the retired ClinePass notice id", () => {
		const dataDir = createTempDataDir();
		const noticePath = resolveCliNoticeStatePath(dataDir);
		mkdirSync(dirname(noticePath), { recursive: true, mode: 0o700 });
		writeFileSync(
			noticePath,
			`${JSON.stringify(
				{ shown: { "cline-cli-cline-pass-intro": true } },
				null,
				2,
			)}\n`,
			"utf8",
		);

		expect(getClineCliMigrationNotice(dataDir)?.id).toBe(DESKTOP_NOTICE_ID);
	});

	it("does not show after the notice is marked as shown", () => {
		const dataDir = createTempDataDir();

		markClineCliMigrationNoticeShown(dataDir);

		expect(getClineCliMigrationNotice(dataDir)).toBeUndefined();
	});

	it("shows after the notice is marked as shown when forced", () => {
		const dataDir = createTempDataDir();

		markClineCliMigrationNoticeShown(dataDir);

		expect(
			getClineCliMigrationNotice(dataDir, {
				CLINE_FORCE_CLINE_CLI_NOTICE: "1",
			})?.id,
		).toBe(DESKTOP_NOTICE_ID);
	});

	it("does not show when disabled through the environment", () => {
		const dataDir = createTempDataDir();

		expect(
			getClineCliMigrationNotice(dataDir, {
				CLINE_DISABLE_CLINE_PASS_NOTICE: "1",
			}),
		).toBeUndefined();
	});

	it("shows when forced even if disabled through the environment", () => {
		const dataDir = createTempDataDir();

		expect(
			getClineCliMigrationNotice(dataDir, {
				CLINE_DISABLE_CLINE_PASS_NOTICE: "1",
				CLINE_FORCE_CLINE_CLI_NOTICE: "1",
			}),
		).toBeDefined();
	});

	it("marks the desktop notice as shown by id", () => {
		const dataDir = createTempDataDir();

		markClineCliMigrationNoticeShown(dataDir, DESKTOP_NOTICE_ID);

		const rawState = readFileSync(resolveCliNoticeStatePath(dataDir), "utf8");
		expect(rawState).toContain('"cline-cli-desktop-launch": true');
		expect(getClineCliMigrationNotice(dataDir)).toBeUndefined();
	});
});
