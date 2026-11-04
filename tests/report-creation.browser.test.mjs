import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, navigateMain, chooseTheme, selectActivityOption } from "./helpers.mjs";

test("ordinary Reports entry chooses activity, configures contents, then approves and saves in one reading workspace", { timeout: 60000 }, async t => {
    const records = [fixture("harbor-notes"), fixture("review-meetings")];
    records[0].userPrompt.text = "Find the Harbor launch decisions and rollout checklist. Summarize outstanding owners for morgan@example.invalid.";
    records[1].userPrompt.text = "Find next week's review meetings.";
    records[1].sourceSessionId = "another-invented-chat";
    for (const [index, record] of records.entries()) {
        record.sourceSessionName = index ? "Weekly reviews" : "Harbor launch";
        record.followUpPrompts = [];
        record.userPrompt.authorship = { actor: index ? "agent" : "user", basis: index ? "source-agent" : "source-user" };
        Object.assign(record.toolCalls[0], {
            startedAt: record.capturedAt, completedAt: new Date(Date.parse(record.capturedAt) + (index ? 800 : 1400)).toISOString(),
            completionEventId: "completed-" + index, durationMs: index ? 800 : 1400,
        });
    }
    Object.assign(records[0].toolCalls[0], { requestedApiPath: "/me/messages", requestArgs: { entityUrls: ["/me/messages"] } });
    records[0].toolCalls.push({ ...structuredClone(records[0].toolCalls[0]), toolCallId: "harbor-file-call", startEventId: "harbor-file-start",
        completionEventId: "harbor-file-end", requestedApiPath: "/me/drive/items/rollout-checklist", requestArgs: { entityUrls: ["/me/drive/items/rollout-checklist"] },
        toolSucceeded: false, reportedOutcome: "failed", durationMs: 400,
        completedAt: new Date(Date.parse(records[0].capturedAt) + 400).toISOString(),
        apiResults: [{ index: 0, statusCode: 403, evidenceLevel: "intermediary-reported" }] });
    const { context } = await privateFixture(t, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); runtime.server.closeAllConnections(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const writes = [], errors = [];
    page.on("request", request => { if (request.method() === "POST") writes.push(new URL(request.url()).pathname); });
    page.on("pageerror", error => errors.push(error.message));
    const proofs = process.env.WIRE_REPORT_LIFECYCLE_PROOFS;
    if (proofs) await mkdir(proofs, { recursive: true });
    const capture = async name => {
        if (!proofs) return;
        await page.evaluate(() => document.fonts.ready);
        if (!await page.locator(":modal").count()) await page.evaluate(() => scrollTo(0, 0));
        await page.screenshot({ path: path.join(proofs, name + ".png"), fullPage: !await page.locator(":modal").count() });
    };
    await page.goto(runtime.url);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await navigateMain(page, "reports");
    await chooseTheme(page, "dark");
    assert.equal(await page.locator("#savedReportsPanel").isVisible(), true);
    await capture("01-empty-library");
    await page.getByRole("link", { name: "Create a report", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Continue to contents", exact: true }).isDisabled(), true);
    assert.equal(await page.locator("#promptOptions").isVisible(), false);
    await page.getByRole("radio", { name: /All collected activity/ }).check();
    assert.match(await page.locator("#previewSelectionSummary").innerText(), /2 chats 2 interactions/);
    assert.match(await page.locator("#reportScopeChoiceHelp").innerText(), /dates.*filters.*search/i);
    await capture("02-activity");
    await page.getByRole("button", { name: "Continue to contents", exact: true }).click();
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-step"), "2");
    await page.locator("#formatOptions input[value=markdown]").check();
    await page.locator("#formatOptions input[value=pdf]").check();
    await page.locator("#formatOptions input[value=json]").check();
    await capture("03-contents");
    if (proofs) {
        await chooseTheme(page, "light"); await page.setViewportSize({ width: 375, height: 1000 });
        await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
        await capture("04-contents-narrow-enlarged");
        await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.waitForFunction(() => !document.querySelector("#contextSidebar").matches(":modal"));
        await chooseTheme(page, "dark");
    }
    const preparedResponse = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.getByRole("button", { name: "Prepare report", exact: true }).click();
    const prepared = await (await preparedResponse).json();
    await page.locator("#reportsView[data-report-phase=ready]").waitFor();
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-step"), "3");
    await page.frameLocator(".report-frame").locator("h1").waitFor();
    await page.waitForFunction(() => {
        const frame = document.querySelector(".report-frame");
        return frame.clientHeight > 1000 && frame.contentDocument.documentElement.scrollHeight <= frame.clientHeight + 1;
    });
    await capture("05-review");
    await page.getByRole("tab", { name: /^Files \(/ }).click();
    const files = page.locator("#reportFileInspection");
    assert.equal(await files.getByRole("button", { name: /Download/ }).count(), 0);
    for (const [name, value] of Object.entries(prepared.files)) {
        await page.locator(`#preparedReportFile [data-file-name="${name}"]`).click();
        assert.equal(await page.locator(`#preparedReportFile [data-file-name="${name}"]`).getAttribute("aria-current"), "true");
        if (name.endsWith(".pdf")) {
            await files.locator('.saved-pdf-pages[aria-busy="false"]').waitFor();
            assert.equal(await files.getByRole("button", { name: "Source", exact: true }).isVisible(), false);
        } else {
            await files.locator(name.endsWith(".html") ? ".report-frame" : name.endsWith(".md") ? ".saved-markdown" : ".saved-json-tree").waitFor();
            await files.getByRole("button", { name: "Source", exact: true }).click();
            assert.equal(await files.locator(`pre[aria-label="${name}"]`).textContent(), value, "Source is the exact prepared text, not the rendered DOM");
            await files.getByRole("button", { name: name.endsWith(".json") ? "Tree" : "Preview", exact: true }).click();
        }
        if (proofs) {
            if (name.endsWith(".html")) await files.frameLocator("iframe").locator("h1").waitFor();
            else if (!name.endsWith(".pdf")) await files.locator(name.endsWith(".md") ? ".saved-markdown" : ".saved-json-tree").waitFor();
            await page.locator(".report-inspection-tabs").evaluate(node =>
                scrollTo(0, scrollY + node.getBoundingClientRect().top - document.querySelector(".app-header").getBoundingClientRect().bottom));
            await page.screenshot({ path: path.join(proofs, "prepared-" + name + ".png") });
        }
    }
    assert.equal(writes.includes("/api/privacy-review") || writes.includes("/api/export"), false, "Rendering a file is not disclosure approval or Save");
    await page.getByRole("tab", { name: "Report", exact: true }).click();
    await page.setViewportSize({ width: 375, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await page.getByRole("button", { name: "Review & save", exact: true }).click();
    const decision = await page.locator(".attestation input[data-review-control]").evaluate(node => ({
        top: node.getBoundingClientRect().top,
        toolbarBottom: document.querySelector(".report-inspection-tabs").getBoundingClientRect().bottom,
    }));
    assert.ok(decision.top >= decision.toolbarBottom, "Enlarged text must not hide disclosure behind the sticky inspector");
    if (proofs) await page.screenshot({ path: path.join(proofs, "05b-review-decision-narrow.png") });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await page.locator(".report-frame").evaluate(node => { window.preparedFrameBeforeApproval = node; });
    assert.equal(await page.getByRole("button", { name: "Save report", exact: true }).isVisible(), false);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    await page.locator(".attestation input[data-review-control]").check();
    await page.getByRole("button", { name: "Approve for local saving", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=reviewed]").waitFor();
    assert.equal(await page.locator("#reportsView").getAttribute("data-report-step"), "3");
    assert.equal(await page.locator("#reportReviewBody").isVisible(), true);
    assert.equal(await page.locator(".report-frame").evaluate(node => node === window.preparedFrameBeforeApproval), true, "Approval must not replace the reading document");
    await page.getByRole("tab", { name: /^Files \(/ }).click();
    await page.locator('#preparedReportFile [data-file-name="coverage-and-redaction-manifest.json"]').click();
    await page.locator("#reportFileInspection").getByRole("button", { name: "Source", exact: true }).click();
    assert.match(await page.locator("#reportFileInspection").innerText(), /"reviewerConfirmed": true/);
    assert.equal((await loadBoardState(context)).exports.length, 0);
    if (proofs) {
        await page.locator(".report-inspection-tabs").evaluate(node =>
            scrollTo(0, scrollY + node.getBoundingClientRect().top - document.querySelector(".app-header").getBoundingClientRect().bottom));
        await page.screenshot({ path: path.join(proofs, "prepared-manifest-source.png") });
    }
    await page.getByRole("tab", { name: "Report", exact: true }).click();
    if (proofs) {
        await page.getByRole("button", { name: "Review & save", exact: true }).click();
        await page.screenshot({ path: path.join(proofs, "06-approved-in-place.png") });
    }
    await page.getByRole("button", { name: "Save report", exact: true }).click();
    await page.locator("#reportsView[data-report-phase=saved]").waitFor();
    const saved = (await loadBoardState(context)).exports;
    assert.equal(saved.length, 1);
    const hashes = {};
    for (const [name, file] of Object.entries(saved[0].files)) {
        const bytes = await readFile(file);
        hashes[name] = createHash("sha256").update(bytes).digest("hex");
        if (proofs) await writeFile(path.join(proofs, name), bytes);
    }
    await capture("07-saved");
    await page.getByRole("button", { name: "Open saved report", exact: true }).click();
    await page.frameLocator("#savedReportReader iframe").locator("h1").waitFor();
    await capture("08-frozen-reader");
    await page.locator("#savedReportReader").getByRole("button", { name: "Back to report library", exact: true }).click();
    assert.equal(await page.locator("#savedReportsPanel").isVisible(), true, "The reader's library action returns directly to the library after saving");
    await capture("09-library");
    await page.getByRole("link", { name: "Create a report", exact: true }).click();
    assert.equal(await page.getByRole("button", { name: "Continue to contents", exact: true }).isDisabled(), true);
    assert.equal(await page.locator("[name=reportScope]:checked").inputValue(), "selected");
    for (const [name, file] of Object.entries(saved[0].files)) assert.equal(createHash("sha256").update(await readFile(file)).digest("hex"), hashes[name]);
    assert.equal(writes.filter(value => value === "/api/preview").length, 1);
    assert.equal(writes.filter(value => value === "/api/privacy-review").length, 1);
    assert.equal(writes.filter(value => value === "/api/export").length, 1);
    assert.deepEqual(errors, []);
    assert.equal(writes.some(value => /\/evaluation\/run|\/collection\/now/.test(value)), false);
    if (proofs) {
        const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
        const task = getDocument({ data: new Uint8Array(await readFile(saved[0].files["product-report.pdf"])), useSystemFonts: false, disableFontFace: true });
        try {
            const pdf = await task.promise, pages = [];
            for (let number = 1; number <= pdf.numPages; number++) {
                const page = await pdf.getPage(number);
                pages.push((await page.getTextContent()).items.map(item => item.str ?? "").join(" "));
                if (number !== 1 && number !== pdf.numPages) continue;
                const viewport = page.getViewport({ scale: 1.25 });
                const surface = pdf.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
                await page.render({ canvasContext: surface.context, viewport }).promise;
                await writeFile(path.join(proofs, `pdf-page-${number}.png`), surface.canvas.toBuffer("image/png"));
                pdf.canvasFactory.destroy(surface);
            }
            await writeFile(path.join(proofs, "receipt.json"), JSON.stringify({ synthetic: true, writes, errors, hashes, pdfPages: pages, frozenBytesUnchanged: true }, null, 2));
        } finally { await task.destroy(); }
    }
});
