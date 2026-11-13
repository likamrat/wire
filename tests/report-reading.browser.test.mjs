import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { fixture, privateFixture, chooseTheme, selectActivityOption } from "./helpers.mjs";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { loadBoardState, updateBoardState } from "../lib/store.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";

test("edited reports give actual HTML a reading pane without opening text inspection", { timeout: 60000 }, async t => {
    const records = Array.from({ length: 127 }, (_, index) => {
        const record = fixture(`reading-copies-${index}`);
        record.capturedAt = new Date().toISOString();
        record.followUpPrompts = [];
        record.userPrompt = { ...record.userPrompt, text: `Invented release review ${index + 1}. `
            + "Check the Cedar release checklist against the mailbox discussion. Keep recorded decisions separate from open questions. ".repeat(24),
            authorship: { actor: "agent", basis: "source-agent" } };
        record.toolCalls[0].startedAt = record.capturedAt;
        record.toolCalls[0].toolSucceeded = false;
        record.toolCalls[0].reportedOutcome = "failed";
        return record;
    });
    const cleanup = [], { context } = await privateFixture({ after: work => cleanup.push(work) }, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); for (const work of cleanup) await work(); });
    const page = await browser.newPage({ viewport: { width: 1800, height: 1100 } });
    await page.goto(runtime.url + "#reports");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await chooseTheme(page, "light");
    let response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator('[data-report-preset="errors"]').click();
    const initial = await (await response).json();
    response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.getByLabel("Report name", { exact: true }).fill("Cedar release call failures");
    const edited = await (await response).json();
    assert.deepEqual(edited.snapshot.reportPopulation, initial.snapshot.reportPopulation);
    await selectActivityOption(page, "preparedReportView", "text");
    await expect(page.locator(".prompt-report")).toBeVisible();
    await expect(page.locator(".prompt-original")).toBeHidden();
    await selectActivityOption(page, "preparedReportView", "product-report.html");
    const file = page.locator("#reportFileInspection .saved-file-preview:visible");
    await expect(file.frameLocator("iframe").locator("h1")).toHaveText("Cedar release call failures");
    const geometry = await file.locator("iframe").evaluate(node => ({
        height: node.getBoundingClientRect().height, viewport: innerHeight,
        inspectionOpen: document.querySelector("#reportTextInspection").checkVisibility(),
    }));
    if (process.env.WIRE_REPORT_READING_PROOFS) {
        await mkdir(process.env.WIRE_REPORT_READING_PROOFS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.WIRE_REPORT_READING_PROOFS, "edited-html.png"), fullPage: true, animations: "disabled" });
        await writeFile(path.join(process.env.WIRE_REPORT_READING_PROOFS, "edited-html.json"), JSON.stringify(geometry));
    }
    assert.ok(geometry.height >= Math.min(600, geometry.viewport * .6), JSON.stringify(geometry));
    assert.equal(geometry.inspectionOpen, false, "File reading must not open unrelated text editing.");
    await page.locator("#reportFileInspection").getByRole("button", { name: "Source", exact: true }).click();
    await page.getByRole("button", { name: "Last 7 days", exact: true }).click();
    response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#reportPeriodChoices [data-report-range='14']").click();
    const redated = await (await response).json();
    await expect(page.locator("#preparedReportView")).toHaveValue("product-report.html");
    assert.equal(await page.locator("#reportFileInspection pre:visible").textContent(), redated.files["product-report.html"]);
    response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.getByLabel("Report name", { exact: true }).fill("Cedar revised report");
    let prepared = await (await response).json();
    await expect(page.locator("#preparedReportView")).toHaveValue("product-report.html");
    await expect(page.locator("#reportFileInspection pre:visible")).toHaveText(prepared.files["product-report.html"]);
    await expect(page.getByLabel("Report name", { exact: true })).toBeFocused();

    await selectActivityOption(page, "preparedReportView", "text");
    const inspection = page.locator("#reportTextInspection");
    await inspection.getByRole("button", { name: "Next report copies", exact: true }).click();
    const second = prepared.promptReview[1];
    await expect(inspection.locator(".prompt-comparison")).toHaveAttribute("data-copy-key", second.key);
    await inspection.getByRole("button", { name: "Local original", exact: true }).click();
    assert.equal(await inspection.locator(".prompt-original pre").textContent(), second.original);
    await expect(inspection.locator(".prompt-report")).toBeHidden();
    await inspection.getByRole("button", { name: "Report copy", exact: true }).click();
    await inspection.getByText("Edit or omit this report copy", { exact: true }).click();
    await expect(inspection.locator(".prompt-report .report-read-copy")).toBeHidden();
    await inspection.getByRole("textbox").fill("A concise, invented release review for jordan@example.invalid.");
    response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await inspection.getByRole("button", { name: "Update report copy", exact: true }).click();
    prepared = await (await response).json();
    await expect(page.locator("#preparedReportView")).toHaveValue("text");
    await expect(inspection.locator(".prompt-comparison")).toHaveAttribute("data-copy-key", second.key);
    await expect(inspection.locator(".prompt-comparison h4")).toBeFocused();
    assert.equal(prepared.promptReview[1].original, second.original);
    assert.match(prepared.promptReview[1].text, /^A concise, invented release review/);
    assert.doesNotMatch(prepared.files["product-report.html"], /jordan@example\.invalid/);
    assert.deepEqual(prepared.snapshot.reportPopulation, initial.snapshot.reportPopulation);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await expect(inspection.locator(".prompt-original")).toBeHidden();
        if (process.env.WIRE_REPORT_READING_PROOFS) await page.screenshot({
            path: path.join(process.env.WIRE_REPORT_READING_PROOFS, `report-copy-${theme}.png`),
            animations: "disabled",
        });
    }
    await inspection.getByText("Edit or omit this report copy", { exact: true }).click();
    await inspection.getByRole("checkbox").check();
    response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await inspection.getByRole("button", { name: "Update report copy", exact: true }).click();
    prepared = await (await response).json();
    await expect(inspection.locator(".prompt-comparison")).toContainText("(omitted)");
    assert.doesNotMatch(prepared.files["product-report.html"], /A concise, invented release review/);
    await inspection.getByRole("button", { name: "Local original", exact: true }).click();
    assert.equal(await inspection.locator(".prompt-original pre").textContent(), second.original);
    await selectActivityOption(page, "preparedReportView", "product-report.html");
    await page.locator("#reportFileInspection").getByRole("button", { name: "Preview", exact: true }).click();
    await expect(file.frameLocator("iframe").locator("h1")).toHaveText("Cedar revised report");
    assert.equal(await file.locator("iframe").getAttribute("sandbox"), "");
    await page.setViewportSize({ width: 560, height: 950 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await file.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.ok((await file.locator("iframe").boundingBox()).height >= 400);
    if (process.env.WIRE_REPORT_READING_PROOFS) await page.screenshot({
        path: path.join(process.env.WIRE_REPORT_READING_PROOFS, "html-narrow-200.png"),
        animations: "disabled",
    });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.setViewportSize({ width: 1800, height: 1100 });
    const longTitle = "Cedar revised report: release review decisions, mailbox call failures and recorded follow-ups for the extended planning period";
    response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.getByLabel("Report name", { exact: true }).fill(longTitle);
    prepared = await (await response).json();
    await expect(file.frameLocator("iframe").locator("h1")).toHaveText(longTitle);
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const saved = (await loadBoardState(context)).exports[0], bytes = await readFile(saved.files["product-report.html"]);
    assert.deepEqual(bytes, Buffer.from(prepared.files["product-report.html"]));
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    await selectActivityOption(page, "savedReaderFormat", "html");
    await expect(page.frameLocator("#savedReportReader .saved-file-preview:visible iframe").locator("h1")).toHaveText(longTitle);
    await selectActivityOption(page, "savedReaderFormat", "report");
    await page.getByRole("button", { name: "Back to Reports", exact: true }).click();
    await expect(page.locator("#savedReportsPanel")).toBeVisible();
    assert.deepEqual(await readFile(saved.files["product-report.html"]), bytes);
    const row = page.locator(".saved-library-row").filter({ hasText: "Cedar revised report" });
    const title = row.locator(".saved-report-title");
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const beforeHover = await title.boundingBox();
        await title.hover();
        const measured = await row.evaluate(node => {
            const title = node.querySelector(".saved-report-title"), icon = title.querySelector("svg"),
                name = title.querySelector(".saved-report-name"), privacy = node.querySelector(".saved-report-privacy");
            const a = title.getBoundingClientRect(), b = icon.getBoundingClientRect(), c = name.getBoundingClientRect(),
                d = privacy.getBoundingClientRect(), glyph = privacy.querySelector("svg").getBoundingClientRect();
            return { leftInset: b.left - a.left, leadingGap: c.left - b.right, trailingGap: glyph.left - c.right,
                separateTargets: d.left >= a.right, color: getComputedStyle(title).backgroundColor };
        });
        if (process.env.WIRE_REPORT_READING_PROOFS) await page.screenshot({
            path: path.join(process.env.WIRE_REPORT_READING_PROOFS, `saved-title-hover-${theme}.png`),
            animations: "disabled",
        });
        assert.ok(measured.leftInset >= 8 && measured.leadingGap >= 10 && measured.trailingGap >= 16, JSON.stringify(measured));
        assert.equal(measured.separateTargets, true);
        assert.deepEqual(await title.boundingBox(), beforeHover, "Hover must not move the title or status action.");
        await title.focus();
        await expect(title).toBeFocused();
        await expect(row.locator(".saved-report-privacy")).toContainText("Detected personal details hidden");
    }
    await page.setViewportSize({ width: 560, height: 950 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await title.scrollIntoViewIfNeeded();
    await title.focus();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    const bounds = await row.evaluate(node => {
        const name = node.querySelector(".saved-report-name").getBoundingClientRect(),
            title = node.querySelector(".saved-report-title").getBoundingClientRect(),
            privacy = node.querySelector(".saved-report-privacy").getBoundingClientRect();
        return { contained: name.right <= title.right && name.bottom <= title.bottom,
            separate: title.right <= privacy.left || title.bottom <= privacy.top };
    });
    assert.deepEqual(bounds, { contained: true, separate: true });
    if (process.env.WIRE_REPORT_READING_PROOFS) await page.screenshot({
        path: path.join(process.env.WIRE_REPORT_READING_PROOFS, "saved-title-focus-narrow-200.png"),
        animations: "disabled",
    });
});

test("late regeneration retains the selected file mode and never publishes superseded text", { timeout: 30000 }, async t => {
    const record = fixture("late-reading");
    record.capturedAt = new Date().toISOString(); record.toolCalls[0].startedAt = record.capturedAt;
    record.userPrompt.text = "Read the invented Cedar planning notes from jordan@example.invalid.";
    const cleanup = [], { context } = await privateFixture({ after: work => cleanup.push(work) }, [record]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); for (const work of cleanup) await work(); });
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(runtime.url + "#reports");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    let response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator('[data-report-preset="all"]').click();
    const initial = await (await response).json();
    await selectActivityOption(page, "preparedReportView", "product-report.html");
    await page.locator("#reportFileInspection").getByRole("button", { name: "Source", exact: true }).click();
    const pending = Promise.withResolvers(), release = Promise.withResolvers();
    t.after(() => release.resolve());
    await page.route("**/api/preview", async route => {
        const result = await route.fetch(); pending.resolve();
        await release.promise; await route.fulfill({ response: result });
    }, { times: 1 });
    await page.getByLabel("Report name", { exact: true }).fill("Superseded name");
    await pending.promise;
    await page.getByLabel("Report name", { exact: true }).fill("Accepted name");
    assert.equal(await page.getByRole("button", { name: "Save report", exact: true }).count(), 0);
    response = page.waitForResponse(response => response.url().endsWith("/api/preview")
        && response.request().postDataJSON().options.title === "Accepted name");
    release.resolve();
    let prepared = await (await response).json();
    await expect(page.locator("#preparedReportView")).toHaveValue("product-report.html");
    assert.equal(await page.locator("#reportFileInspection pre:visible").textContent(), prepared.files["product-report.html"]);
    assert.doesNotMatch(prepared.files["product-report.html"], /Superseded name/);
    assert.deepEqual(prepared.snapshot.reportPopulation, initial.snapshot.reportPopulation);
    await page.getByRole("button", { name: "Save as: HTML", exact: true }).click();
    response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#formatOptions input[value=json]").check();
    prepared = await (await response).json();
    await expect(page.locator("#preparedReportView")).toHaveValue("product-report.html");
    assert.equal(await page.locator("#reportFileInspection pre:visible").textContent(), prepared.files["product-report.html"]);
    response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#formatOptions input[value=html]").uncheck();
    await response;
    await page.locator("#reportFileOptions").getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.locator("#preparedReportView")).toHaveValue("report");
    await selectActivityOption(page, "preparedReportView", "product-report.json");
    await page.locator("#reportPrivacyChoice").click();
    response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("[name=promptMode][value=none]").check();
    prepared = await (await response).json();
    await page.locator("#reportPrivacyOptions").getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.locator("#preparedReportView")).toHaveValue("product-report.json");
    assert.doesNotMatch(prepared.files["product-report.json"], /Read the invented Cedar planning/);
    await selectActivityOption(page, "preparedReportView", "text");
    await expect(page.locator(".prompt-original")).toBeHidden();
    await page.getByRole("button", { name: "Local original", exact: true }).click();
    assert.equal(await page.locator(".prompt-original pre").textContent(), record.userPrompt.text);
    await expect(page.locator(".report-copy-controls")).toHaveCount(0);
    assert.deepEqual(errors, []);
});

test("report period closes when reading an embedded document and when leaving Reports", { timeout: 30000 }, async t => {
    const record = fixture("period-dismissal");
    record.capturedAt = new Date().toISOString();
    record.toolCalls[0].startedAt = record.capturedAt;
    const cleanup = [], { context } = await privateFixture({ after: work => cleanup.push(work) }, [record]);
    const access = await createCopilotRuntimeAccess(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false }, access });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); await access.close(); for (const work of cleanup) await work(); });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.setDefaultTimeout(5000);
    await page.goto(runtime.url + "#reports");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.locator('[data-report-preset="all"]').click();
    await expect(page.frameLocator(".report-contained-frame").locator("h1")).toHaveText("All activity");
    await page.getByRole("button", { name: "Last 7 days", exact: true }).click();
    await expect(page.locator("#reportPeriodChoices")).toBeVisible();
    await page.frameLocator(".report-contained-frame").locator("h1").click();
    await expect(page.locator("#reportPeriodChoices")).toBeHidden({ timeout: 1000 });
    const period = page.locator("#reportPeriodChoices");
    for (const target of ["chrome", "escape", "trigger"]) {
        await page.getByRole("button", { name: "Last 7 days", exact: true }).click();
        if (target === "chrome") await page.getByLabel("Report name", { exact: true }).click();
        else if (target === "escape") await page.keyboard.press("Escape");
        else await page.locator('[popovertarget="reportPeriodChoices"]').click();
        await expect(period).toBeHidden();
    }
    await page.getByRole("button", { name: "Last 7 days", exact: true }).click();
    let response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await period.locator("[data-report-range='14']").click();
    const accepted = await (await response).json();
    await expect(period).toBeHidden();
    await page.getByRole("button", { name: "Last 14 days", exact: true }).click();
    await period.locator("[data-report-range=custom]").click();
    const custom = page.locator("#reportCustomDates");
    await custom.getByLabel("From", { exact: true }).fill("2026-01-01");
    await custom.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.locator('[popovertarget="reportPeriodChoices"]')).toContainText("Last 14 days");
    await page.getByRole("button", { name: "Last 14 days", exact: true }).click();
    await period.locator("[data-report-range=custom]").click();
    await custom.getByLabel("From", { exact: true }).fill("2026-01-01");
    response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await custom.getByRole("button", { name: "Use dates", exact: true }).click();
    const changed = await (await response).json();
    assert.notDeepEqual(changed.snapshot.dateSelection, accepted.snapshot.dateSelection);
    await expect(custom).toBeHidden();
    await selectActivityOption(page, "preparedReportView", "product-report.html");
    await page.getByRole("button", { name: "Custom dates", exact: true }).click();
    await page.frameLocator("#reportFileInspection iframe").locator("h1").click();
    await expect(period).toBeHidden();
    await page.getByRole("combobox", { name: "Prepared report view", exact: true }).click();
    const fileBox = await page.locator("#reportFileInspection iframe").boundingBox();
    await page.mouse.click(fileBox.x + fileBox.width - 20, fileBox.y + 100);
    await expect(page.locator(".select-popup")).toBeHidden({ timeout: 1000 });
    await page.locator("#wireAccountTrigger").click();
    await expect(page.locator("#wireAccountMenu")).toBeVisible();
    await page.frameLocator("#reportFileInspection iframe").locator("h1").click();
    await expect(page.locator("#wireAccountMenu")).toBeHidden({ timeout: 1000 });
    await page.locator("#wireSearch").fill("Reports");
    await expect(page.locator("#wireSearchPanel")).toBeVisible();
    await page.mouse.click(fileBox.x + fileBox.width - 20, fileBox.y + 100);
    await expect(page.locator("#wireSearchPanel")).toBeHidden();
    await expect(page.locator("#wireSearch")).toHaveValue("Reports");
    await page.locator("#wireSearchClear").click();
    await page.getByRole("button", { name: "Custom dates", exact: true }).click();
    await page.getByRole("link", { name: "Back to Reports", exact: true }).click();
    await expect(period).toBeHidden();
    await expect(page.locator("#reportGallery")).toBeVisible();
    await page.locator('[data-report-preset="all"]').click();
    await expect(page.locator("#preparedReportView")).toHaveValue("product-report.html");
    await page.getByRole("button", { name: "Custom dates", exact: true }).click();
    await page.locator('nav [data-nav="analyze"]').click();
    await expect(period).toBeHidden();
    await expect(page.locator("#reportsView")).toBeHidden();
    await page.goBack();
    await expect(page.locator("#reportsView")).toBeVisible();
    await expect(page.locator(".report-options-popover:popover-open")).toHaveCount(0);
});

test("older Activity disclosure owns its following tool and service breakdowns", { timeout: 30000 }, async t => {
    const cleanup = [], { context } = await privateFixture({ after: work => cleanup.push(work) },
        [fixture("older-activity-a"), fixture("older-activity-b")]);
    const controller = createExportController(context), state = await loadBoardState(context);
    const prepared = await controller.preview("older-reader", undefined,
        { title: "Archived activity example", formats: ["html"], promptMode: "none" },
        { kind: "all", revision: state.revision });
    assert.equal(prepared.snapshot.reportPopulation, undefined, "Use the supported older non-preset report structure.");
    await controller.review("older-reader", prepared.previewId, true);
    const bundle = (await controller.confirm("older-reader", prepared.previewId, true)).bundle;
    const originals = new Map();
    for (const file of Object.values(bundle.files)) originals.set(file, await readFile(file));
    const savedState = await loadBoardState(context);
    const runtime = await startServer(context, controller, { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); for (const work of cleanup) await work(); });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [], outside = [], downloads = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("download", item => downloads.push(item));
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin !== new URL(runtime.url).origin) {
            outside.push(route.request().url()); return route.abort();
        }
        return route.continue();
    });
    await page.goto(runtime.url + "#reports");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.getByRole("button", { name: "Files for Archived activity example", exact: true }).click();
    await page.getByRole("dialog", { name: "Files for Archived activity example", exact: true })
        .getByRole("button", { name: "HTML", exact: true }).click();
    const frame = page.frameLocator("#savedReportReader .saved-file-preview:visible iframe");
    await expect(frame.locator("#breakdowns")).toBeVisible();
    assert.equal(await frame.locator("#breakdowns").evaluate(node =>
        node.parentElement.localName === "main" && node.previousElementSibling.id === "overview"), true);
    const breakdownText = await frame.locator("#breakdowns").textContent();
    await selectActivityOption(page, "savedReaderFormat", "report");
    const activity = frame.locator(".wire-reading-section:has(> #overview)");
    await expect(activity).not.toHaveAttribute("open", "");
    await expect(frame.locator("#overview table")).toBeHidden();
    await expect(frame.locator("#breakdowns")).toBeHidden();
    await activity.locator(":scope>summary").click();
    await expect(frame.locator("#overview table")).toBeVisible();
    await expect(frame.locator("#breakdowns")).toBeVisible();
    assert.equal(await frame.locator("#breakdowns").textContent(), breakdownText);
    await activity.locator(":scope>summary").focus();
    await page.keyboard.press("Enter");
    await expect(frame.locator("#breakdowns")).toBeHidden();
    await frame.locator('.report-nav a[href$="#overview"]').click();
    await expect(frame.locator("#breakdowns")).toBeVisible();
    await expect(frame.locator("#overview,#breakdowns,#timing,#examples")).toHaveCount(4);
    await expect(activity.locator("#timing")).toHaveCount(0);
    await expect(frame.locator("main>.report-nav,main>.report-footer")).toHaveCount(2);
    assert.equal(await frame.locator("#breakdowns").evaluate(node =>
        node.closest("details") === document.querySelector("#overview").closest("details")), true);
    const proofs = process.env.WIRE_REPORT_READING_PROOFS;
    if (proofs) {
        await mkdir(proofs, { recursive: true });
        await activity.locator(":scope>summary").click();
        await page.screenshot({ path: path.join(proofs, "older-activity-closed.png") });
        await activity.locator(":scope>summary").click();
        await page.screenshot({ path: path.join(proofs, "older-activity-open.png") });
    }
    assert.deepEqual(await loadBoardState(context), savedState);
    for (const [file, bytes] of originals) assert.deepEqual(await readFile(file), bytes);
    assert.deepEqual(errors, []); assert.deepEqual(outside, []); assert.deepEqual(downloads, []);
});

test("long reports keep complete evidence behind working navigation and real format previews", { timeout: 90000 }, async t => {
    const records = Array.from({ length: 52 }, (_, index) => {
        const record = fixture("reading-" + index);
        record.capturedAt = new Date().toISOString();
        record.followUpPrompts = [];
        record.userPrompt = { text: `Review the invented release ${index + 1} and list unresolved decisions. `
            + "Keep mailbox discussions separate from the rollout checklist. Preserve open questions and do not infer missing approvals. ".repeat(index < 6 ? 16 : 1),
            status: "full", sourceTimestamp: record.capturedAt, sourceEventId: "reading-prompt-" + index,
            authorship: { actor: index % 2 ? "agent" : "user", basis: index % 2 ? "source-agent" : "source-user" } };
        record.toolCalls = Array.from({ length: 3 }, (_, call) => ({
            ...structuredClone(record.toolCalls[0]), toolCallId: `reading-call-${index}-${call}`,
            startEventId: `reading-start-${index}-${call}`, startedAt: record.capturedAt, durationMs: 120 * (call + 1),
            requestArgs: { entityUrls: [call === 1 ? "/me/messages" : "/me/drive/root"] },
            toolSucceeded: index >= 6, reportedOutcome: index < 6 ? "failed" : "succeeded",
            apiResults: [{ index: 0, statusCode: index < 6 ? [403, 404, 429][call] : 200 }],
        }));
        return record;
    });
    const cleanup = [], { context } = await privateFixture({ after: work => cleanup.push(work) }, records);
    // Make the first hash-sorted pattern reference target the last visible interaction.
    await updateBoardState(context, state => { state.pseudonymKey = "1".padStart(64, "0"); });
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); for (const work of cleanup) await work(); });
    const page = await browser.newPage({ viewport: { width: 1800, height: 1100 }, timezoneId: "America/Los_Angeles" });
    page.setDefaultTimeout(10000);
    const errors = [], outside = [], posts = [], downloads = [], proof = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("download", item => downloads.push(item));
    page.on("request", request => { if (request.method() === "POST") posts.push({
        path: new URL(request.url()).pathname, body: request.postDataJSON(),
    }); });
    await page.route("**/*", route => {
        if (new URL(route.request().url()).origin !== new URL(runtime.url).origin) {
            outside.push(route.request().url()); return route.abort();
        }
        return route.continue();
    });
    const folder = process.env.WIRE_REPORT_READING_PROOFS;
    async function capture(name) {
        if (!folder) return;
        await mkdir(folder, { recursive: true });
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== "running"));
        await page.screenshot({ path: path.join(folder, name + ".png") });
    }
    await page.goto(runtime.url + "#reports");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    let response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator('[data-report-preset="errors"]').click();
    let prepared = await (await response).json();
    const population = structuredClone(prepared.snapshot.reportPopulation);
    assert.equal(population.reference.length, 52); assert.equal(prepared.records.length, 6);
    const report = page.frameLocator(".report-contained-frame");
    await expect(report.locator(".wire-reading-interaction")).toHaveCount(6);
    await expect(report.locator(".wire-reading-interaction[open]")).toHaveCount(0);
    await expect(report.locator(".example-calls tbody tr")).toHaveCount(36);
    assert.doesNotMatch(await report.locator("main>.report-facts").textContent(), /Timezone|Prepared|Prompts|Text/);
    assert.match(await report.locator(".wire-reading-meta").textContent(), /Timezone/);
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const measured = await report.locator("body").evaluate(body => ({
            body: getComputedStyle(body).backgroundColor, root: getComputedStyle(document.documentElement).backgroundColor,
            width: body.getBoundingClientRect().width, viewport: innerWidth, height: body.scrollHeight,
            frameHeight: innerHeight, failed: getComputedStyle(body.querySelector(".wire-reading-outcome-failure")).color,
            danger: getComputedStyle(document.documentElement).getPropertyValue("--danger").trim(),
        }));
        assert.equal(measured.root, measured.body, "The root and body paint the same report sheet, without black gutters.");
        assert.ok(Math.abs(measured.width - measured.viewport) < 1);
        assert.ok(measured.height < 3000 && measured.frameHeight < 1100);
        assert.notEqual(measured.failed, await report.locator("body").evaluate(node => getComputedStyle(node).color));
        proof.push({ theme, ...measured }); await capture("prepared-" + theme);
    }
    const patternLink = report.locator('#patterns a[href*="#"]').first();
    const targetId = (await patternLink.getAttribute("href")).split("#")[1];
    await patternLink.click();
    await expect(report.locator(".wire-reading-interaction[open]")).toHaveCount(1);
    assert.equal(await report.locator(`[id="${targetId}"]`).evaluate(node => document.activeElement === node), true);
    assert.equal(await report.locator(`[id="${targetId}"]`).evaluate(node =>
        node.closest("details").querySelector("summary").getBoundingClientRect().top
            >= document.querySelector(".report-nav").getBoundingClientRect().bottom), true);
    assert.equal(await report.locator(".wire-reading-interaction").last().evaluate((node, id) =>
        node.contains(document.getElementById(id)), targetId), true);
    await report.locator('.report-nav a[href$="#examples"]').click();
    await expect(report.locator(".wire-reading-interaction").last()).toHaveAttribute("open", "");
    await report.locator(".wire-reading-interaction>summary").last().focus();
    assert.equal(await report.locator(".wire-reading-interaction>summary").last().evaluate(node =>
        document.hasFocus() && document.activeElement === node), true);
    await page.keyboard.press("Enter");
    await expect(report.locator(".wire-reading-interaction").last()).not.toHaveAttribute("open", "");
    await report.locator(".wire-reading-interaction>summary").last().focus();
    await page.keyboard.press("Enter");
    await expect(report.locator(".wire-reading-interaction").last()).toHaveAttribute("open", "");
    await capture("prepared-interactions");
    await page.getByRole("button", { name: "Expand sections", exact: true }).click();
    await expect(report.locator(".wire-reading-interaction[open]")).toHaveCount(6);
    assert.ok(await report.locator("body").evaluate(node => node.scrollHeight > 8000));
    await page.getByRole("button", { name: "Collapse sections", exact: true }).click();
    await expect(report.locator(".wire-reading-interaction[open]")).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.locator(".report-contained-frame").scrollIntoViewIfNeeded();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    assert.equal(await report.locator("body").evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await capture("prepared-narrow-200");
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.setViewportSize({ width: 1800, height: 1100 });

    await page.getByRole("button", { name: "Save as: HTML", exact: true }).click();
    for (const format of ["pdf", "json", "markdown"]) {
        response = page.waitForResponse(response => response.url().endsWith("/api/preview"));
        await page.locator(`#formatOptions input[value="${format}"]`).check();
        const result = await response; prepared = await result.json();
        assert.equal(result.status(), 200, prepared.error);
        assert.deepEqual(prepared.snapshot.reportPopulation, population);
        assert.ok(result.request().postDataJSON().options.formats.includes(format));
        assert.ok(prepared.files["product-report." + (format === "markdown" ? "md" : format)]);
    }
    await page.locator("#reportFileOptions").getByRole("button", { name: "Done", exact: true }).click();
    const previewCount = posts.filter(item => item.path === "/api/preview").length;
    await report.locator(".wire-reading-interaction>summary").first().click();
    const preparedPosition = await report.locator("body").evaluate(() => scrollY);
    for (const format of ["html", "pdf", "json", "markdown"]) {
        const name = "product-report." + (format === "markdown" ? "md" : format);
        await selectActivityOption(page, "preparedReportView", name);
        const file = page.locator("#reportFileInspection .saved-file-preview:visible");
        if (format === "html") {
            await expect(file.frameLocator("iframe").locator("h1")).toHaveText("Errors & failures");
            await expect(file.frameLocator("iframe").locator("[data-wire-reader]")).toHaveCount(0);
        } else if (format === "pdf") {
            await file.locator('.saved-pdf-pages[aria-busy="false"]').waitFor();
            await expect(file.locator(".saved-pdf-sheet canvas")).toHaveCount(1);
            await page.setViewportSize({ width: 390, height: 1000 });
            await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
            await file.scrollIntoViewIfNeeded();
            await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
            assert.ok((await file.boundingBox()).height >= 160);
            await capture("prepared-pdf-narrow-200");
            await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
            await page.setViewportSize({ width: 1800, height: 1100 });
            await file.locator('.saved-pdf-pages[aria-busy="false"]').waitFor();
        } else await expect(file.locator(format === "json" ? ".saved-json-tree" : ".saved-markdown")).toBeVisible();
        if (format !== "pdf") {
            await page.locator("#reportFileInspection").getByRole("button", { name: "Source", exact: true }).click();
            assert.equal(await page.locator("#reportFileInspection pre:visible").textContent(), prepared.files[name]);
            await page.locator("#reportFileInspection").getByRole("button", { name: format === "json" ? "Tree" : "Preview", exact: true }).click();
        }
        proof.push({ preparedFormat: format, selected: await page.locator("#preparedReportView").inputValue(), file: name });
        await capture("prepared-file-" + format);
    }
    assert.equal(posts.filter(item => item.path === "/api/preview").length, previewCount, "Viewing files does not rebuild or recapture the report.");
    await selectActivityOption(page, "preparedReportView", "coverage-and-redaction-manifest.json");
    await page.locator("#reportFileInspection").getByRole("button", { name: "Source", exact: true }).click();
    assert.equal(await page.locator("#reportFileInspection pre:visible").textContent(), prepared.files["coverage-and-redaction-manifest.json"]);
    await selectActivityOption(page, "preparedReportView", "report");
    await expect(report.locator(".wire-reading-interaction")).toHaveCount(6);
    await expect(report.locator(".wire-reading-interaction[open]")).toHaveCount(1);
    assert.equal(await report.locator("body").evaluate(() => scrollY), preparedPosition);
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
    const state = await loadBoardState(context), saved = state.exports[0], savedBytes = new Map();
    for (const format of ["html", "pdf", "json", "markdown"]) {
        const name = "product-report." + (format === "markdown" ? "md" : format);
        const bytes = await readFile(saved.files[name]); savedBytes.set(name, bytes);
        assert.deepEqual(bytes, typeof prepared.files[name] === "string" ? Buffer.from(prepared.files[name])
            : Buffer.from(prepared.files[name].data, "base64"));
    }
    assert.doesNotMatch(savedBytes.get("product-report.html").toString(), /wire-reading|data-wire-reader/);
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    const savedFrame = page.locator("#savedReportReader .saved-file-preview:visible").frameLocator("iframe");
    await expect(savedFrame.locator(".wire-reading-interaction")).toHaveCount(6);
    assert.equal(await page.locator("#savedReportReader iframe").getAttribute("sandbox"), "");
    await savedFrame.locator('#patterns a[href*="#"]').first().click();
    await expect(savedFrame.locator(".wire-reading-interaction[open]")).toHaveCount(1);
    const originalFrame = await page.locator("#savedReportReader iframe").elementHandle();
    await capture("saved-report");
    for (const format of ["html", "pdf", "json", "markdown"]) {
        await selectActivityOption(page, "savedReaderFormat", format);
        const file = page.locator("#savedReportReader .saved-file-preview:visible");
        if (format === "html") await expect(file.frameLocator("iframe").locator("h1")).toHaveText(saved.title);
        else if (format === "pdf") await file.locator('.saved-pdf-pages[aria-busy="false"]').waitFor();
        else await expect(file.locator(format === "json" ? ".saved-json-tree" : ".saved-markdown")).toBeVisible();
        await capture("saved-file-" + format);
        const downloaded = page.waitForEvent("download");
        await page.locator("#savedReportReader").getByRole("button", { name: "Download", exact: true }).click();
        const item = await downloaded;
        assert.deepEqual(await readFile(await item.path()), savedBytes.get(item.suggestedFilename()));
        proof.push({ savedFormat: format, selected: await page.locator("#savedReaderFormat").inputValue(),
            file: item.suggestedFilename(), bytesMatch: true });
    }
    await selectActivityOption(page, "savedReaderFormat", "report");
    await expect(savedFrame.locator(".wire-reading-interaction[open]")).toHaveCount(1);
    assert.equal(await originalFrame.evaluate(node => node.isConnected && node.checkVisibility()), true);
    await page.getByRole("button", { name: "Expand sections", exact: true }).click();
    await expect(savedFrame.locator(".wire-reading-interaction[open]")).toHaveCount(6);
    await page.getByRole("button", { name: "Collapse sections", exact: true }).click();
    await expect(savedFrame.locator(".wire-reading-section[open],.wire-reading-interaction[open]")).toHaveCount(0);
    await page.getByRole("button", { name: "Back to Reports", exact: true }).click();
    await expect(page.locator("#reportGallery")).toBeVisible();
    await expect(page.locator(".saved-report-title")).toHaveCount(1);
    assert.equal(downloads.length, 4, "Only the four explicit Download actions downloaded anything.");
    assert.deepEqual(await loadBoardState(context), state);
    for (const [name, bytes] of savedBytes) assert.deepEqual(await readFile(saved.files[name]), bytes);
    assert.deepEqual(errors, []); assert.deepEqual(outside, []);
    if (folder) await writeFile(path.join(folder, "proof.json"), JSON.stringify({ proof, errors, outside, downloads: downloads.length }, null, 2));
});
