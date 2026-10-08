import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";

test("whole-context failure detail visual evidence", { timeout: 60000 }, async t => {
    const record = fixture("failure-visual");
    Object.assign(record, { title: "Invented file request", followUpPrompts: [],
        userPrompt: { text: "Read the example document and explain what happened.", status: "full", provenance: "human-authored" } });
    Object.assign(record.toolCalls[0], {
        tool: "workiq-fetch_blob", toolCallId: "invented-call-27", toolSucceeded: false, reportedOutcome: "failed", apiResults: [],
        startedAt: "2026-10-01T12:00:01.000Z", completedAt: "2026-10-01T12:00:01.738Z", durationMs: 738,
        requestedApiPath: "/drives/invented-drive/items/example-document/content",
        requestArgs: { path: "/drives/invented-drive/items/example-document/content" },
    });
    const { context } = await privateFixture(t, [record]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        writeText() { throw Error("Disabled in visual evidence"); }, readText() { throw Error("No OS clipboard"); },
    } }));
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [375, 1], [1440, 2], [375, 2]]) {
        await page.setViewportSize({ width, height: 1100 });
        await page.goto(runtime.url + "#request?request=failure-visual&range=capture");
        await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        const details = page.locator("#requestContent").getByText("Technical details", { exact: true });
        if (!await details.evaluate(node => node.parentElement.open)) await details.click();
        const args = page.locator("#requestContent").getByText("Exact recorded arguments / local only", { exact: true }).first();
        if (!await args.evaluate(node => node.parentElement.open)) await args.click();
        await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
        await page.evaluate(() => document.fonts.ready);
        if (process.env.WIRE_FAILURE_PROOFS) {
            await mkdir(process.env.WIRE_FAILURE_PROOFS, { recursive: true });
            await page.screenshot({ path: path.join(process.env.WIRE_FAILURE_PROOFS, `${theme}-${width}-${scale * 100}.png`), fullPage: true });
            const detailBounds = await page.locator(".technical-detail").boundingBox();
            await page.screenshot({ path: path.join(process.env.WIRE_FAILURE_PROOFS, `detail-${theme}-${width}-${scale * 100}.png`), fullPage: true, clip: detailBounds });
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${theme}/${width}/${scale} page overflow`);
    }
});

test("technical identifier copy stays next to its value and missing evidence is explained", { timeout: 30000 }, async t => {
    const record = fixture("failure-clarity");
    Object.assign(record.toolCalls[0], {
        tool: "workiq-fetch_blob", toolCallId: "invented-failed-call", toolSucceeded: false,
        reportedOutcome: "failed", apiResults: [], requestedApiPath: "/drives/invented/items/example/content",
        requestArgs: { path: "/drives/invented/items/example/content" },
    });
    const { context } = await privateFixture(t, [record]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        writeText: async text => { window.copiedText = text; }, readText() { throw Error("No OS clipboard"); },
    } }));
    await page.goto(runtime.url + "#request?request=failure-clarity&range=capture");
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
    await page.locator("#requestContent").getByText("Technical details", { exact: true }).click();
    const copy = page.getByRole("button", { name: "Copy tool call id", exact: true });
    const gap = await copy.evaluate(button => {
        const range = document.createRange();
        range.selectNodeContents(button.parentElement.querySelector("code"));
        return button.getBoundingClientRect().left - range.getBoundingClientRect().right;
    });
    assert.ok(gap >= 0 && gap <= 16, `Copy/value gap ${gap}px must be <=16px`);
    assert.doesNotMatch(await page.locator(".request-outcome").innerText(), /Failure details were not recorded/);
});

test("bounded failure, success, relationship and HTTP cases share honest details and exact accessible copy", { timeout: 60000 }, async t => {
    const cases = [
        ["legacy", false, [], null, "Failure cause unavailable in retained evidence"],
        ["source-absent", false, [], { version: 1, reason: "no-structured-error", code: null }, "source completion records failure"],
        ["excluded", false, [], { version: 1, reason: "error-details-excluded", code: null }, "excluded by WIRE"],
        ["tool-code", false, [], { version: 1, reason: "error-code-recorded", code: "failure", messageStatus: "text-excluded", messageSignal: "access-denial" }, "Tool error: failure; Tool error mentions access denial"],
        ["success", true, [{ index: 0, statusCode: 200 }], null, null],
        ["returned-failure", true, [{ index: 0, statusCode: 403, errorCode: "Forbidden" }], null, "Reported HTTP 403: Forbidden"],
    ];
    const records = cases.map(([name, success, apiResults, failureEvidence], index) => {
        const record = fixture(name), call = record.toolCalls[0];
        Object.assign(call, { toolCallId: index === 4 ? "invented-" + "long-identifier-".repeat(24) + "  " : `invented-${name}`,
            toolSucceeded: success, reportedOutcome: success ? "succeeded" : "failed", apiResults, failureEvidence,
            requestedApiPath: "/drives/" + "invented-long-path-".repeat(20) + "/content" });
        if (index === 1) call.parentInvocationEvidence = "source-field-absent";
        if (index === 4) Object.assign(call, { parentToolCallId: "invented-parent", parallelGroup: "invented-group" });
        if (index === 2) { record.sourceHost = "unknown"; record.workloadKind = "unknown"; }
        return record;
    });
    const owned = fixture("owned");
    owned.toolCalls = [];
    owned.httpRecords = [{ recordId: "invented-http", method: "GET", path: "/me/messages", status: 503,
        startedAt: "2026-09-30T12:00:01.000Z", endedAt: "2026-09-30T12:00:02.000Z", durationMs: 1000,
        observedGraphHttp: true, evidenceLevel: "owned-http" }];
    records.push(owned);
    const { context } = await privateFixture(t, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, reducedMotion: "reduce" });
    const errors = [], external = [], unexpectedWrites = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        const url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin) external.push(url.origin);
        if (request.method() !== "GET" && !["/api/connect", "/api/snapshot", "/api/collection/status", "/api/assessment/detail",
            "/api/assessment/overview", "/api/evaluation/automatic/summary"].includes(url.pathname)) unexpectedWrites.push(url.pathname);
    });
    t.after(async () => { await browser.close(); await runtime.close(); assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(unexpectedWrites, []); });
    await page.addInitScript(() => {
        window.clipboardWrites = [];
        Object.defineProperty(navigator, "clipboard", { value: {
            readText() { throw Error("No OS clipboard"); },
            writeText(text) { window.clipboardWrites.push(text); return new Promise((resolve, reject) => { window.resolveCopy = resolve; window.rejectCopy = reject; }); },
        } });
    });
    for (const [name, success, , , expected] of cases) {
        await page.goto(runtime.url + `#request?request=${name}&range=capture`);
        await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
        const outcome = await page.locator(".request-outcome").innerText();
        if (expected) assert.ok(outcome.includes(expected), outcome);
        else assert.equal(await page.locator(".action-error").count(), 0);
        assert.match(outcome, success ? /Worked/ : /Tool failed/);
        await page.locator("#requestContent").getByText("Technical details", { exact: true }).click();
        const facts = page.locator(".technical-facts");
        const field = label => facts.locator("dt").filter({ hasText: new RegExp(`^${label}$`) }).evaluate(node => node.nextElementSibling.textContent);
        assert.equal(await field("HTTP observed"), "No");
        if (name === "source-absent") assert.equal(await field("Parent invocation"), "Not supplied by source");
        if (name === "legacy") {
            assert.equal(await field("Parent invocation"), "Unavailable in retained evidence");
            assert.equal(await field("Parallel group"), "Not collected by this adapter");
            await facts.getByRole("button", { name: "About Parent invocation", exact: true }).focus();
            await page.keyboard.press("Enter");
            assert.match(await page.getByRole("tooltip").innerText(), /cannot establish.*source omitted.*earlier collection/);
            await page.keyboard.press("Escape");
            await facts.getByRole("button", { name: "About Parallel group", exact: true }).click();
            assert.match(await page.getByRole("tooltip").innerText(), /WIRE collection limit.*not evidence.*serially/);
            await page.keyboard.press("Escape");
        }
        if (name === "excluded") assert.equal(await field("Parallel group"), "Unavailable in retained evidence");
        if (name !== "success") continue;
        for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [375, 1], [1440, 2], [375, 2]]) {
            await page.setViewportSize({ width, height: 1100 });
            await chooseTheme(page, theme);
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            for (const [label, value] of [["tool call id", records[4].toolCalls[0].toolCallId], ["parent invocation", "invented-parent"], ["parallel group", "invented-group"]]) {
                const copy = facts.getByRole("button", { name: "Copy " + label, exact: true });
                const geometry = await copy.evaluate(button => {
                    const code = button.parentElement.querySelector("code"), cell = button.closest("dd");
                    const range = document.createRange(); range.selectNodeContents(code);
                    const text = range.getBoundingClientRect(), target = button.getBoundingClientRect();
                    return { gap: target.left - text.right, boxGap: target.left - code.getBoundingClientRect().right,
                        wrapped: text.height > parseFloat(getComputedStyle(code).lineHeight) + 1,
                        fontSize: parseFloat(getComputedStyle(code).fontSize), width: target.width, height: target.height,
                        font: getComputedStyle(code).fontFamily === getComputedStyle(cell).fontFamily,
                        size: getComputedStyle(code).fontSize === getComputedStyle(cell).fontSize };
                });
                assert.ok(geometry.width >= 44 && geometry.height >= 44);
                assert.ok(geometry.boxGap >= -1 && geometry.boxGap <= 16, JSON.stringify(geometry));
                if (!geometry.wrapped) assert.ok(geometry.gap >= -1 && geometry.gap <= 16, JSON.stringify(geometry));
                assert.ok(geometry.font && geometry.size);
                await copy.focus(); await page.keyboard.press("Enter");
                assert.equal(await copy.getAttribute("data-copy-state"), "pending");
                assert.equal(await page.evaluate(() => window.clipboardWrites.at(-1)), value);
                const count = await page.evaluate(() => window.clipboardWrites.length);
                await page.keyboard.press("Enter");
                assert.equal(await page.evaluate(() => window.clipboardWrites.length), count);
                await page.evaluate(() => window.resolveCopy());
                await page.waitForFunction(() => document.querySelector(".technical-facts .ux-copy[data-copy-state=success]"));
                assert.equal(await copy.getAttribute("data-copy-state"), "success");
                await copy.click();
                await page.evaluate(() => window.rejectCopy(new DOMException("Invented denial", "NotAllowedError")));
                await page.waitForFunction(() => document.querySelector(".technical-facts .ux-copy[data-copy-state=error]"));
                assert.equal(await copy.getAttribute("data-copy-state"), "error");
                assert.match(await copy.locator("..").getByRole("alert").innerText(), /permission was denied/);
                assert.ok(await copy.locator("..").getByRole("alert").isVisible());
            }
        }
        await page.evaluate(() => { document.documentElement.style.fontSize = "16px"; });
        await page.setViewportSize({ width: 1440, height: 1100 });
    }
    await page.goto(runtime.url + "#request?request=owned&range=capture&layer=http");
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
    assert.match(await page.locator("#requestContent").innerText(), /Explicit HTTP recorder[\s\S]*Recorded HTTP status 503/);
    assert.doesNotMatch(await page.locator("#requestContent").innerText(), /Tool error:|Tool failed|Failure cause unavailable/);
});
