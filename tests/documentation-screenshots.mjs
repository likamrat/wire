import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { fixture, chooseTheme, navigateSettings, selectActivityOption } from "./helpers.mjs";
import { searchFixture } from "./live-search-fixture.mjs";
import { loadBoardState } from "../lib/store.mjs";

const output = process.env.WIRE_DOC_OUTPUT;
const proof = process.env.WIRE_DOC_PROOF;
const widgetsOnly = process.env.WIRE_DOC_CAPTURE === "widgets";
const reportsOnly = process.env.WIRE_DOC_CAPTURE === "reports";
const analyzeOnly = process.env.WIRE_DOC_CAPTURE === "analyze";
const sha256 = value => createHash("sha256").update(value).digest("hex");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const day = new Date().toISOString().slice(0, 10);
const at = (days, seconds = 0) => new Date(Date.parse(day + "T12:00:00Z") - days * 86400000 + seconds * 1000).toISOString();

function documentationRecords() {
    const prompts = [
        "Find the release review messages from jordan@example.invalid about Avery Chen and list the open questions.",
        "Read the rollout checklist and identify the remaining tasks.",
        "Prepare a PowerPoint outline for the Northstar launch review.",
        "List unresolved decisions from the mailbox review.",
        "Find the calendar agenda for the design review.",
        "Summarize the PowerPoint feedback from the launch planning chat.",
        "Read the service review notes and list the recorded follow-ups.",
        "Find the support plan for the next release.",
        "Inspect the available fields before reading the calendar.",
        "Read the architecture notes about regional failover.",
        "Find the launch checklist and the owner of the support handoff.",
        "Check whether the rollout planning thread has a final decision.",
        "Read last week's release checklist.",
        "Find the earlier design review agenda.",
        "List the open questions from the prior service review.",
        "Read the support handoff notes from last week.",
    ];
    return prompts.map((text, index) => {
        const row = fixture("documentation-" + index);
        const days = index < 12 ? 1 + index % 6 : index - 4;
        const startedAt = at(days);
        row.capturedAt = startedAt;
        row.sourceSessionId = "documentation-chat-" + index;
        row.sourceSessionName = ["Launch preparation", "Design review", "Service review", "Support handoff"][index % 4];
        row.project = "Northstar";
        row.projectId = "documentation-northstar";
        row.title = text;
        row.followUpPrompts = [];
        row.userPrompt = {
            text, status: "full", sourceTimestamp: startedAt, sourceEventId: "documentation-prompt-" + index,
            ...(index === 11 ? {} : { authorship: { actor: index % 3 === 1 ? "agent" : "user",
                basis: index % 3 === 1 ? "source-agent" : "source-user" } }),
        };
        if (index === 0) row.userPrompt.text += " Focus on the Northstar launch review and the support handoff. "
            + "Separate decisions that were recorded from questions that are still open. "
            + "For each open question, include the relevant message date and the team responsible for the next review. "
            + "Keep release readiness, customer communication, regional rollout, and support coverage in separate sections. "
            + "Do not treat an unanswered thread as agreement or infer a deadline from the meeting schedule. "
            + "Include conflicting answers with their original context, and distinguish the latest update from the earlier proposal. "
            + "End with a concise checklist of the decisions the reviewers still need to make.";
        row.toolCalls = Array.from({ length: index < 4 ? 2 : 1 }, (_, call) => {
            const failed = index < 4 && call === 0;
            const unknown = index === 11;
            const discovery = index === 8;
            const apiPath = ["/me/messages", "/me/drive/root", "/me/calendarView"][(index + call) % 3];
            const durationMs = failed ? 1800 + index * 240 : 240 + index * 60;
            return {
                ...row.toolCalls[0],
                tool: discovery ? "workiq-get_schema" : "workiq-fetch",
                toolCallId: `documentation-call-${index}-${call}`,
                startEventId: `documentation-start-${index}-${call}`,
                ...(unknown ? {} : { completionEventId: `documentation-end-${index}-${call}`,
                    completedAt: new Date(Date.parse(startedAt) + durationMs).toISOString(), durationMs }),
                startedAt,
                requestArgs: discovery ? { path: "/me/calendarView" } : { entityUrls: [apiPath] },
                requestedApiPath: apiPath,
                toolSucceeded: unknown ? null : !failed,
                reportedOutcome: unknown ? "unknown" : failed ? "failed" : "succeeded",
                apiResults: unknown || discovery ? [] : [{ index: 0, path: apiPath,
                    statusCode: failed ? [403, 404, 429, 503][index] : 200,
                    evidenceLevel: "intermediary-reported" }],
            };
        });
        if (index !== 11) row.originalModelEvidence = {
            version: 1, sourceSessionId: row.sourceSessionId, promptEventId: row.userPrompt.sourceEventId,
            promptMessageId: "documentation-message-" + index, partial: false, ambiguous: false,
            responses: [{
                eventId: "documentation-response-" + index, apiCallId: "documentation-api-" + index,
                at: at(days, 8), turnId: "documentation-turn-" + index,
                model: ["gpt-5.4", "claude-sonnet-4.6"][index % 2], modelStatus: "recorded",
            }],
        };
        return row;
    });
}

test("capture documentation through the normal renderer with isolated light-theme data", {
    skip: !output || !proof,
    timeout: 240000,
}, async t => {
    await mkdir(output, { recursive: true });
    await mkdir(proof, { recursive: true });
    const records = documentationRecords(), cleanups = [];
    let browser, app, receipt;
    t.after(async () => {
        try { await browser?.close(); }
        finally { for (const cleanup of cleanups) await cleanup(); }
        if (app) await assert.rejects(stat(app.root), error => error.code === "ENOENT");
        if (receipt?.completed) {
            receipt.cleanup = { browserClosed: !browser.isConnected(), runtimeClosed: true, temporaryStoreRemoved: true };
            await writeFile(path.join(proof, "capture-receipt.json"), JSON.stringify(receipt, null, 2));
        }
    });
    app = await searchFixture({ after: cleanup => cleanups.push(cleanup) }, { records, reply: false });
    receipt = {
        sourceCommit: git("rev-parse", "HEAD"), sourceTree: git("rev-parse", "HEAD^{tree}"),
        sourceChanges: git("diff", "HEAD", "--name-only", "--", "lib", "web", "assets", "package.json", "package-lock.json"),
        fixtureDay: day, fixtureSha256: sha256(JSON.stringify(records)), fixture: "tests/documentation-screenshots.mjs",
        fixtureFileSha256: sha256(await readFile(new URL(import.meta.url))),
        fixtureHelpers: {},
        theme: "light", colorScheme: "light", timeZone: "UTC", collectionTimers: false,
        profile: "Neutral fallback; the synthetic source contains no account identity.",
        images: [], files: [], completed: false,
    };
    assert.equal(receipt.sourceChanges, "", "Capture only an immutable product source candidate.");
    for (const file of ["tests/helpers.mjs", "tests/live-search-fixture.mjs"]) {
        receipt.fixtureHelpers[file] = sha256(await readFile(file));
    }
    await writeFile(path.join(proof, "fixture.json"), JSON.stringify(records, null, 2));
    const originals = new Map(), seeded = new Map();
    const titles = ["Launch review", "Earlier release checklist", "Design review agenda",
        "Service follow-ups", "Support plan", "Architecture notes", "Call results"];
    for (const [index, title] of (analyzeOnly ? [] : widgetsOnly ? titles.slice(0, 1) : titles).entries()) {
        const state = await loadBoardState(app.context), owner = "documentation-saved-" + index;
        const selected = index === 0 ? [2, 5] : [[12], [4], [6], [7], [9], [10]][index - 1];
        const preview = await app.exports.preview(owner, undefined, {
            title, promptMode: "masked", formats: index === 0 ? ["json"] : ["html", "json"],
            dateSelection: { range: "custom", from: at(14).slice(0, 10), to: day },
            timeContext: { timeZone: "UTC", locale: "en-US" },
            reportFocus: { version: 1, preset: "all", outcome: "all", services: [] },
        }, { kind: "selected", revision: state.revision, scenarioIds: selected.map(item => records[item].scenarioId) });
        await app.exports.review(owner, preview.previewId, true, { timeZone: "UTC", locale: "en-US" });
        const { bundle } = await app.exports.confirm(owner, preview.previewId, true, { timeZone: "UTC", locale: "en-US" });
        seeded.set(title, bundle.bundleId);
        for (const file of Object.values(bundle.files)) originals.set(file, await readFile(file));
    }
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 },
        colorScheme: "light", timezoneId: "UTC", locale: "en-US" });
    page.setDefaultTimeout(15000);
    const errors = [], outside = [], mutations = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        const url = new URL(request.url());
        if (request.method() === "POST") mutations.push(url.pathname);
    });
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(app.runtime.url).origin && !["blob:", "data:"].includes(url.protocol)) {
            outside.push(url.href);
            return route.abort();
        }
        return route.continue();
    });
    const ready = () => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    async function capture(name, { locator = page, privateOnly = false, fullPage = false, top = false } = {}) {
        if (reportsOnly && !name.startsWith("report-") && name !== "saved-report") return;
        await expect(page.locator("html")).toHaveAttribute("data-evidence-theme", "light");
        assert.equal(await page.evaluate(() => matchMedia("(prefers-color-scheme: light)").matches), true);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction(() => document.getAnimations().every(animation =>
            animation.playState !== "running" || animation.effect?.getTiming().iterations === Infinity));
        if (top) {
            await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
            await expect.poll(() => page.evaluate(() => scrollY)).toBe(0);
        }
        await page.mouse.move(10, 70);
        const file = path.join(privateOnly ? proof : output, name + ".png");
        const bytes = await locator.screenshot({ path: file, ...(locator === page ? { fullPage } : {}) });
        receipt.images.push({ name, privateOnly, sha256: sha256(bytes), bytes: bytes.length,
            width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), viewport: page.viewportSize() });
    }
    async function preparedChange(action) {
        const response = page.waitForResponse(item => item.url().endsWith("/api/preview"));
        await action();
        const result = await response, body = await result.json();
        assert.equal(result.status(), 200, body.error);
        await expect(page.getByRole("button", { name: "Save report", exact: true })).toBeEnabled();
        return body;
    }
    async function finish() {
        assert.deepEqual(errors, []);
        assert.deepEqual(outside, []);
        assert.equal(mutations.some(route => /collection\/now|access\/command|delete|recollect/.test(route)), false);
        for (const [file, bytes] of originals) assert.deepEqual(await readFile(file), bytes);
        receipt.completed = true;
        receipt.browserVersion = browser.version();
        receipt.nodeVersion = process.version;
        await writeFile(path.join(proof, "capture-receipt.json"), JSON.stringify(receipt, null, 2));
    }

    await page.goto(app.runtime.url + (reportsOnly ? "#reports" : "#analyze"));
    await ready();
    await chooseTheme(page, "light");
    if (!reportsOnly) {
        await expect(page.locator("#activityListSummary")).toContainText("16 interactions with 20 matching Work IQ tool calls");
        await capture("analyze");
        await page.setViewportSize({ width: 2100, height: 1250 });
        await page.locator('#activityList .request-card-open[href*="documentation-0"]').click();
        await expect(page.locator("#contextSidebar")).toBeVisible();
        await expect(page.locator("#requestContent").getByRole("button", { name: "Show full prompt", exact: true })).toBeVisible();
        await capture("wire-overview", { top: true });
        if (analyzeOnly) {
            await finish();
            return;
        }
        await page.setViewportSize({ width: 1440, height: 1100 });
        await page.locator('#activityList .request-card-open[href*="documentation-0"]').scrollIntoViewIfNeeded();
        await capture("interaction");
        await page.getByRole("button", { name: "Close interaction", exact: true }).click();
        await expect(page.locator("#contextSidebar")).toBeHidden();
        await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"));
        await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
        await page.locator("#wireSearch").fill("POWER");
        await expect(page.locator(".wire-search-hit")).toHaveCount(3);
        await expect(page.locator(".wire-search-hit").first()).toBeVisible();
        await capture("literal-search");
        await page.locator("#wireSearchClear").click();
        if (widgetsOnly) {
            await page.locator("#comparePeriods").click();
            await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
            await capture("compare-periods");
            await page.getByRole("button", { name: "By tool", exact: true }).click();
            await capture("compare-by-tool", { privateOnly: true });
            await finish();
            return;
        }
    }

    await page.locator('nav [data-nav=reports]').click();
    await ready();
    await capture("report-choices", { fullPage: true });
    let prepared = await preparedChange(() => page.locator('[data-report-preset="errors"]').click());
    assert.equal(prepared.snapshot.reportPopulation.reference.length, 12);
    assert.equal(prepared.records.length, 4);
    const report = page.frameLocator(".report-contained-frame");
    await expect(report.locator("h1")).toHaveText("Errors & failures");
    await expect(report.locator("body")).toContainText("4 of 12 interactions had recorded errors.");
    await capture("report-preview");
    await expect(report.locator("body")).toContainText("Avery Chen");
    await page.locator("#reportPrivacyChoice").click();
    await page.locator("#additionalMasking summary").click();
    prepared = await preparedChange(() => page.locator("#manualTerms").fill("Avery Chen"));
    await expect(report.locator("body")).not.toContainText("Avery Chen");
    await capture("report-privacy");
    await page.locator("#reportPrivacyOptions").getByRole("button", { name: "Done", exact: true }).click();
    await selectActivityOption(page, "preparedReportView", "text");
    await expect(page.locator("#reportTextInspection .prompt-report")).toBeVisible();
    await capture("report-text");
    await selectActivityOption(page, "preparedReportView", "report");
    await report.locator(".wire-reading-interaction>summary").first().click();
    await report.locator('.report-nav a[href$="#examples"]').click();
    await capture("report-expanded");
    await report.locator(".wire-example-editor>summary").first().click();
    await report.getByLabel("Your note", { exact: true }).first()
        .fill("Expected a list of review messages. Check how the mailbox access error was explained.");
    prepared = await preparedChange(() => report.getByRole("button", { name: "Update note", exact: true }).first().click());
    await report.locator(".wire-reading-interaction>summary").first().click();
    await report.locator(".wire-example-editor>summary").first().click();
    await capture("report-example", { locator: report.locator(".wire-example-editor").first() });
    await page.getByRole("button", { name: "Expand sections", exact: true }).click();
    await page.getByRole("button", { name: "Collapse sections", exact: true }).click();
    await page.getByRole("button", { name: "Save as: HTML", exact: true }).click();
    for (const format of ["pdf", "json", "markdown"]) {
        prepared = await preparedChange(() => page.locator(`#formatOptions input[value="${format}"]`).check());
    }
    await page.locator("#reportFileOptions").getByRole("button", { name: "Done", exact: true }).click();
    for (const format of ["html", "pdf", "json", "md"]) {
        await selectActivityOption(page, "preparedReportView", "product-report." + format);
        const file = page.locator("#reportFileInspection .saved-file-preview:visible");
        if (format === "pdf") await file.locator('.saved-pdf-pages[aria-busy="false"]').waitFor();
        else if (format === "html") await expect(file.frameLocator("iframe").locator("h1")).toHaveText("Errors & failures");
        else await expect(file.locator(format === "json" ? ".saved-json-tree" : ".saved-markdown")).toBeVisible();
        if (format !== "pdf") {
            await page.locator("#reportFileInspection").getByRole("button", { name: "Source", exact: true }).click();
            assert.equal(await page.locator("#reportFileInspection pre:visible").textContent(), prepared.files["product-report." + format]);
            await page.locator("#reportFileInspection")
                .getByRole("button", { name: format === "json" ? "Tree" : "Preview", exact: true }).click();
        }
        await capture(format === "html" ? "report-file-preview" : "report-file-" + format,
            { privateOnly: format !== "html", top: true });
    }
    await selectActivityOption(page, "preparedReportView", "coverage-and-redaction-manifest.json");
    await page.locator("#reportFileInspection").getByRole("button", { name: "Source", exact: true }).click();
    assert.equal(await page.locator("#reportFileInspection pre:visible").textContent(),
        prepared.files["coverage-and-redaction-manifest.json"]);
    await page.locator("#reportFileInspection").getByRole("button", { name: "Tree", exact: true }).click();
    await capture("report-manifest", { privateOnly: true });
    await selectActivityOption(page, "preparedReportView", "report");
    await page.locator("#reportPrivacyChoice").click();
    prepared = await preparedChange(() => page.locator('[name=promptMode][value=original]').check());
    await page.locator("#reportPrivacyOptions").getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator(".report-save-warning")).toBeVisible();
    await capture("report-save-warning", { locator: page.locator(".report-save-warning") });
    const savedResponse = page.waitForResponse(item => item.url().endsWith("/api/export"));
    await page.getByRole("button", { name: "Hide details and save", exact: true }).click();
    assert.equal((await savedResponse).status(), 200);
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const state = await loadBoardState(app.context);
    const saved = state.exports.find(item => item.title === "Errors & failures");
    assert.equal(saved.promptMode, "masked");
    for (const [name, file] of Object.entries(saved.files)) {
        const bytes = await readFile(file);
        receipt.files.push({ name, sha256: sha256(bytes), bytes: bytes.length });
        originals.set(file, bytes);
    }
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    const savedFrame = page.frameLocator("#savedReportReader iframe");
    await expect(savedFrame.locator("h1")).toHaveText("Errors & failures");
    await expect(savedFrame.locator("body")).toContainText("4 of 12 interactions had recorded errors.");
    await savedFrame.locator(".wire-reading-interaction>summary").first().click();
    await savedFrame.locator('.report-nav a[href$="#examples"]').click();
    await capture("saved-report");
    if (reportsOnly) { await finish(); return; }
    await page.getByRole("button", { name: "Back to Reports", exact: true }).click();
    await page.locator("#savedReportSearch").fill("Launch review");
    await page.getByRole("button", { name: "View report: Launch review", exact: true }).click();
    await expect(page.frameLocator("#savedReportReader iframe").locator("h1")).toHaveText("Launch review");
    await capture("saved-json-only", { privateOnly: true });

    await page.getByRole("button", { name: "Back to Reports", exact: true }).click();
    await page.getByRole("link", { name: "Compare saved reports", exact: true }).click();
    const comparison = page.locator("#comparisonWorkspace");
    for (const [label, title] of [["Earlier report", "Earlier release checklist"], ["Later report", "Call results"]]) {
        await comparison.getByRole("combobox", { name: label, exact: true }).click();
        await page.locator(`.select-popup [data-value="${seeded.get(title)}"]`).click();
    }
    const comparisonResponse = page.waitForResponse(item => item.url().endsWith("/api/report-comparison/preview"));
    await comparison.getByRole("button", { name: "Compare reports", exact: true }).click();
    const comparisonPreview = await comparisonResponse;
    assert.equal(comparisonPreview.status(), 200);
    await expect(comparison.getByRole("button", { name: "Save comparison", exact: true })).toBeEnabled();
    await expect(comparison.locator(".comparison-prepared-files iframe")).toBeVisible();
    await capture("compare-saved-reports", { privateOnly: true, top: true });

    await page.locator("#comparePeriods").click();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");
    await capture("compare-periods");
    for (const name of ["Timeline", "By tool", "Timing"]) {
        await page.getByRole("button", { name, exact: true }).click();
        await capture("compare-" + name.toLowerCase().replaceAll(" ", "-"), { privateOnly: true });
    }
    const paired = await preparedChange(() => page.getByRole("button", { name: "Create report", exact: true }).click());
    assert.ok(paired.snapshot.periodComparison);
    await expect(page.locator("#reportLibraryLink")).toHaveText("Back to comparison");
    await capture("period-report", { privateOnly: true, top: true });
    await page.locator("#reportLibraryLink").click();
    await expect(page.locator("#periodComparisonStatus")).toHaveText("Comparison ready.");

    await page.locator('nav [data-nav=settings]').click();
    await navigateSettings(page, "display");
    await page.setViewportSize({ width: 1440, height: 760 });
    await capture("settings-display");
    await page.locator("#settingsSearch").fill("record");
    await expect(page.locator("#settingsSearchResults")).toBeVisible();
    await expect(page.locator("#settingsSearchResults")).toContainText("Privacy & saved data");
    await expect(page.locator("#settingsSearchResults")).toContainText("Collection status");
    await capture("settings-search");
    await finish();
});
