import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { loadBoardState } from "../lib/store.mjs";
import { collectedReportSource } from "./collected-report-fixture.mjs";
import { navigateMain } from "./helpers.mjs";
import { chooseReportScope, reportContents, scanReport, findReportCopy } from "./report-journey-helpers.mjs";

for (const recordedContext of [false, true]) test(`ordinary launch keeps the reviewed GitHub report${recordedContext ? " and edited reply context" : ""} frozen during automatic same-chat collection`,
    { timeout: 90000 }, async t => {
        const app = await collectedReportSource(t, { recordedAnswers: recordedContext });
        const configFile = path.join(app.context.dataDir, "collector", "config.json"), config = await readFile(configFile);
        await app.collector.close();
        const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
            name !== "NODE_TEST_CONTEXT" && !name.startsWith("WIRE_")
            && !["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].includes(name)));
        const child = fork(new URL("../scripts/start.mjs", import.meta.url), ["--port", "0"], {
            env: { ...environment, WORKIQ_EVIDENCE_DATA_DIR: app.context.dataDir, GH_CONFIG_DIR: path.join(app.root, "no-profile") },
            execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        const exited = new Promise(resolve => child.once("exit", resolve));
        let browser, readyTimer, stderr = "", output = "";
        app.beforeCleanup(async () => {
            clearTimeout(readyTimer);
            await browser?.close();
            if (child.connected) child.disconnect();
            const killTimer = setTimeout(() => child.kill(), 5000);
            try { assert.equal(await exited, 0); }
            finally { clearTimeout(killTimer); }
        });
        child.stderr.on("data", chunk => { stderr += chunk; });
        const url = await new Promise((resolve, reject) => {
            readyTimer = setTimeout(() => reject(new Error("Disposable ordinary launcher timed out: " + stderr)), 15000);
            child.once("error", reject);
            child.once("exit", () => reject(new Error("Disposable ordinary launcher exited before readiness: " + stderr)));
            child.stdout.on("data", chunk => {
                output += chunk;
                const found = /ready at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(output);
                if (found) resolve(found[1]);
            });
        });
        clearTimeout(readyTimer);
        browser = await chromium.launch();
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const errors = [], external = [], mutations = [], previews = [];
        page.on("pageerror", error => errors.push(error.message));
        page.on("request", request => {
            const route = new URL(request.url()).pathname;
            if (route === "/api/preview") previews.push(request.postDataJSON());
            if (/^\/api\/(?:export|access\/command|collection\/.*(?:configure|enabled|enroll|now))$/.test(route)) mutations.push(route);
        });
        await page.route("**/*", route => {
            if (new URL(route.request().url()).origin === new URL(url).origin) return route.continue();
            external.push(route.request().url());
            return route.abort();
        });
        await page.goto(url);
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await navigateMain(page, "reports");
        await chooseReportScope(page, "all");
        await reportContents(page);
        await page.locator("#reportTitle").fill("Stable collected GitHub report");
        await page.locator(`[name=promptMode][value=${recordedContext ? "original" : "none"}]`).check();
        await page.locator("#reportRecordedContext").setChecked(recordedContext);
        for (const format of ["html", "json", "pdf", "markdown"]) {
            await page.locator(`#formatOptions input[value=${format}]`).setChecked(["html", "json"].includes(format));
        }
        let preview = await scanReport(page);
        assert.equal(preview.collectedSourceFrozen, true);
        assert.equal(preview.snapshot.selectionScope.requestGroups, 1);
        if (recordedContext) {
            const copy = await findReportCopy(page, "Recorded reply to Original reviewed request.");
            await copy.getByText("Edit or omit this report copy", { exact: true }).click();
            await copy.locator(".report-copy-controls textarea").fill("The reply edit I reviewed stays unchanged.");
            const rebuilt = page.waitForResponse(response => response.url().endsWith("/api/preview"));
            await page.getByRole("button", { name: "Rebuild preview", exact: true }).click();
            preview = await (await rebuilt).json();
            await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
        }
        await page.locator(".attestation input[data-review-control]").check();
        const reviewing = page.waitForResponse(response => response.url().endsWith("/api/privacy-review"));
        await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
        const reviewed = await (await reviewing).json();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "reviewed");
        if (recordedContext) assert.ok(reviewed.contextReview.some(copy => copy.edited && copy.text === "The reply edit I reviewed stays unchanged."));
        const preparedCount = previews.length;
        await app.appendOnly();
        await expect.poll(async () => (await loadBoardState(app.context, { readOnly: true })).evidence.length, { timeout: 20000 }).toBe(2);
        await expect(page.locator("#newDataNotice")).toContainText("preview stays frozen", { timeout: 15000 });
        await expect(page.locator("#newDataNotice")).toBeVisible();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "reviewed");
        await expect(page.getByRole("button", { name: "Save report", exact: true })).toBeEnabled();
        assert.equal(previews.length, preparedCount);
        if (process.env.WIRE_REPORT_PROOFS) {
            await mkdir(process.env.WIRE_REPORT_PROOFS, { recursive: true });
            await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
            await page.screenshot({ path: path.join(process.env.WIRE_REPORT_PROOFS,
                `github-automatic-${recordedContext ? "edited-context" : "no-prompts"}-review.png`) });
        }
        const saving = page.waitForResponse(response => response.url().endsWith("/api/export"));
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        const response = await saving, saved = await response.json();
        assert.equal(response.status(), 200, saved.error);
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
        const state = await loadBoardState(app.context, { readOnly: true });
        assert.equal(state.evidence.length, 2, "Publication cannot write its pinned source back over newer collection.");
        const entry = state.exports.find(item => item.bundleId === saved.bundle.bundleId);
        assert.equal(entry.selectionScope.requestGroups, 1);
        for (const [name, contents] of Object.entries(reviewed.files)) {
            assert.deepEqual(await readFile(entry.files[name]), Buffer.from(contents));
        }
        assert.deepEqual(await readFile(configFile), config, "No hidden Pause or collection reconfiguration.");
        assert.deepEqual(mutations, ["/api/export"]);
        await navigateMain(page, "analyze");
        await expect(page.locator("#activityList .activity-card")).toHaveCount(2);
        await navigateMain(page, "reports");
        await page.getByRole("button", { name: "Open saved report", exact: true }).click();
        await expect(page.frameLocator("#savedReportReader iframe").locator("h1")).toHaveText("Stable collected GitHub report");
        assert.deepEqual(errors, []);
        assert.deepEqual(external, []);
    });
