import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { fixture, privateFixture, chooseTheme, selectActivityOption } from "./helpers.mjs";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { loadBoardState } from "../lib/store.mjs";

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
    await report.locator('.report-nav a[href$="#examples"]').click();
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
