import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence, updateBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption } from "./helpers.mjs";
import { reportContents, cancelReportPreview } from "./report-journey-helpers.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const proofs = process.env.WIRE_ACTIVITY_PROOFS;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const settled = page => page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
async function capture(page, name, fullPage = false) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await settled(page);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(proofs, name + ".png"), fullPage });
}

function activityRecord(size = 6) {
    const record = fixture("activity-reader");
    record.userPrompt = { text: "Find the workshop checklist.", status: "full",
        sourceEventId: "prompt", sourceTimestamp: "2026-10-01T12:00:00Z",
        authorship: { actor: "user", basis: "source-user" } };
    record.followUpPrompts = [];
    record.toolCalls = Array.from({ length: size }, (_, index) => {
        const failed = size === 6 ? index === 2 || index === 3 : index === size - 1;
        return { tool: index === 2 ? "workiq-retrieve" : "workiq-fetch", toolCallId: "activity-" + (index + 1),
            startEventId: "event-" + index, startedAt: new Date(Date.parse("2026-10-01T12:00:01Z") + index * 1000).toISOString(),
            durationMs: index * 39, toolSucceeded: !failed, reportedOutcome: failed ? "failed" : "succeeded",
            requestArgs: index === 2 ? { query: "PRIVATE_CALL_ARGUMENT_" + (index + 1) }
                : { entityUrls: ["/me/drive/items/PRIVATE_CALL_ARGUMENT_" + (index + 1)] }, apiResults: [],
            ...failed ? { failureEvidence: { version: 1, reason: "error-code-recorded", code: "failure",
                messageStatus: "text-excluded", messageSignal: index === 2 ? "request-timeout" : "access-denial" } } : {} };
    });
    return record;
}

async function setup(t, record = activityRecord()) {
    const cleanup = [];
    const { context } = await privateFixture({ after: fn => cleanup.push(fn) }, [record]);
    let before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key]);
        } finally { for (const fn of cleanup) await fn(); }
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const errors = [];
    let snapshot;
    page.on("response", async response => {
        if (response.ok() && response.url().endsWith("/api/snapshot")) snapshot = await response.json();
    });
    const denied = [];
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && ![
            "/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview",
            "/api/preview", "/api/cancel-preview", "/api/evaluation/automatic/summary",
            "/api/search/query", "/api/search/status", "/api/search/events", "/api/search/cancel", "/api/search/open", "/api/search/membership",
        ].includes(url.pathname)) { denied.push(url.pathname); return route.abort(); }
        return route.continue();
    });
    await page.addInitScript(() => {
        window.testCopies = [];
        Object.defineProperty(navigator, "clipboard", { value: {
            readText() { throw Error("Native clipboard reads are forbidden."); },
            writeText(text) { window.testCopies.push(text); return Promise.resolve(); },
        } });
    });
    page.on("pageerror", error => errors.push(error.message));
    t.after(() => { assert.deepEqual(errors, []); assert.deepEqual(denied, []); });
    await page.goto(runtime.url);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    return { page, runtime, context, snapshot: () => snapshot,
        acceptFixtureChange: async () => { before = await loadBoardState(context); } };
}

test("one minimal card opens the full log with private input owned by its exact disclosure", async t => {
    const { page } = await setup(t);
    await chooseTheme(page, "dark");
    await expect(page.locator("#activityTitle")).toHaveText("Activity");
    await expect(page.locator("[data-analyze-mode],#callSort")).toHaveCount(0);
    const card = page.locator(".request-card-open");
    await expect(card).toContainText("Find the workshop checklist.");
    await expect(card).not.toContainText("workiq-fetch");
    const metadataType = await card.evaluate(node => {
        const time = getComputedStyle(node.querySelector(".request-card-time"));
        const problem = getComputedStyle(node.querySelector(".request-card-problem"));
        return { size: problem.fontSize, timeSize: time.fontSize, weight: problem.fontWeight };
    });
    assert.deepEqual(metadataType, { size: "14px", timeSize: "12px", weight: "400" });
    await capture(page, "analyze-dark", true);
    await card.click();
    await settled(page);
    await expect(page.locator("#requestContent .reader-call-row")).toHaveCount(6);
    const target = page.locator('[data-tool-call-id="activity-3"]');
    await expect(target).toBeFocused();
    assert.equal(await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop), 0);
    await expect(target.locator(".call-heading")).toContainText("Request timed out (MCP -32001)");
    await expect(target.locator(".call-heading")).not.toContainText("Tool failed");
    await expect(page.locator("#requestContent")).not.toContainText("PRIVATE_CALL_ARGUMENT");
    await capture(page, "six-call-dark");
    await target.locator(".reader-call-toggle").click();
    await expect(target).toContainText("PRIVATE_CALL_ARGUMENT_3");
    await expect(page.locator("#requestContent")).not.toContainText("PRIVATE_CALL_ARGUMENT_2");
    const copy = await target.getByRole("button", { name: "Copy recorded arguments", exact: true }).elementHandle();
    await capture(page, "exact-input");
    await target.locator(".reader-call-toggle").click();
    await expect(page.locator("#requestContent")).not.toContainText("PRIVATE_CALL_ARGUMENT");
    await copy.evaluate(node => node.click());
    assert.deepEqual(await page.evaluate(() => window.testCopies), []);
});

test("filtered homepage failure entry is gesture-only and does not override explicit targets or Back", async t => {
    const { page, runtime } = await setup(t);
    await page.goto(runtime.url + "#analyze?tool=workiq-fetch&result=failure"); await ready(page);
    const card = page.locator(".request-card-open");
    await card.focus();
    const origin = (await card.boundingBox()).y;
    await page.keyboard.press("Enter"); await settled(page);
    await expect(page.locator('[data-tool-call-id="activity-4"]')).toBeFocused();
    await expect(page.locator('[data-tool-call-id="activity-3"]>.action-context')).toHaveText("Outside current view");
    await expect(page.locator(".reader-call-row")).toHaveCount(6);
    const first = await page.locator('[data-tool-call-id="activity-1"]').getAttribute("data-action-id");
    await capture(page, "filtered-failure");
    await page.goBack(); await ready(page); await settled(page);
    await expect(card).toBeFocused();
    assert.ok(Math.abs((await card.boundingBox()).y - origin) <= 1);
    await page.goto(runtime.url + "#request?" + new URLSearchParams({ request: "activity-reader", layer: "tool", call: first, result: "failure" }));
    await ready(page); await settled(page);
    await expect(page.locator("#selectedCall")).toHaveAttribute("data-tool-call-id", "activity-1");
    await expect(page.locator("#selectedCall")).toBeFocused();
    await expect(page.locator("#selectedCall")).toContainText("PRIVATE_CALL_ARGUMENT_1");
    await page.goto(runtime.url); await ready(page);
    await card.click(); await settled(page);
    await page.reload(); await ready(page); await settled(page);
    await expect(page.locator("#contextSidebarTitle")).toBeFocused();
    await expect(page.locator("#requestContent")).not.toContainText("PRIVATE_CALL_ARGUMENT");
});

test("Close then reopen the same red card restores valid manual reading before a failure hint", async t => {
    const { page } = await setup(t, activityRecord(26));
    const card = page.locator(".request-card-open"), body = page.locator("#contextSidebarBody");
    await card.click(); await settled(page);
    await expect(page.locator('[data-tool-call-id="activity-26"]')).toBeFocused();
    const initial = await body.evaluate(node => node.scrollTop);
    await body.hover(); await page.mouse.wheel(0, -320);
    await expect.poll(() => body.evaluate(node => node.scrollTop)).toBeLessThan(initial);
    const reading = page.locator('[data-tool-call-id="activity-20"] .reader-call-toggle');
    await reading.click();
    await expect(reading).toBeFocused();
    const remembered = await body.evaluate(node => node.scrollTop);
    assert.ok(remembered > 0);
    await page.locator("#closeContextSidebar").click(); await settled(page);
    await expect(card).toBeFocused();
    await expect(page.locator("#requestContent")).not.toContainText("PRIVATE_CALL_ARGUMENT_20");
    await card.click(); await settled(page);
    const restored = await body.evaluate(node => node.scrollTop);
    const focus = await page.evaluate(() => ({
        call: document.activeElement.closest("[data-tool-call-id]")?.dataset.toolCallId,
        toggle: document.activeElement.classList.contains("reader-call-toggle"),
    }));
    t.diagnostic(JSON.stringify({ initial, remembered, restored, focus }));
    assert.ok(Math.abs(restored - remembered) <= 1, "Same-card reopening must retain the user's reader position.");
    await expect(reading).toBeFocused();
    await expect(reading).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('[data-tool-call-id="activity-20"]')).toContainText("PRIVATE_CALL_ARGUMENT_20");
    await capture(page, "same-red-card-reopen");
});

test("same-card reopen rejects stale reading memory and keeps the fresh matching failure entry", async t => {
    const app = await setup(t, activityRecord(26)), { page, context } = app;
    const card = page.locator(".request-card-open"), body = page.locator("#contextSidebarBody");
    await card.click(); await settled(page);
    await expect(page.locator('[data-tool-call-id="activity-26"]')).toBeFocused();
    const initial = await body.evaluate(node => node.scrollTop);
    await body.hover(); await page.mouse.wheel(0, -320);
    await expect.poll(() => body.evaluate(node => node.scrollTop)).toBeLessThan(initial);
    await page.locator('[data-tool-call-id="activity-20"] .reader-call-toggle').click();
    const remembered = await body.evaluate(node => node.scrollTop), original = app.snapshot();
    await page.locator("#closeContextSidebar").click(); await settled(page);
    await updateBoardState(context, () => {});
    await app.acceptFixtureChange();
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(() => app.snapshot()?.revision).toBeGreaterThan(original.revision);
    await ready(page);
    await card.click(); await settled(page);
    await expect(page.locator('[data-tool-call-id="activity-26"]')).toBeFocused();
    await expect(page.locator('[data-tool-call-id="activity-26"]')).toBeInViewport();
    const current = app.snapshot(), top = await body.evaluate(node => node.scrollTop);
    t.diagnostic(JSON.stringify({ remembered, top, savedRevision: original.revision, currentRevision: current.revision,
        sameBasis: JSON.stringify(original.assessment.basis) === JSON.stringify(current.assessment.basis) }));
    assert.ok(Math.abs(top - remembered) > 1, "Stale reading must not displace the new entry target.");
});

test("changing the applied outcome dismisses private detail and preserves reading without a new outside-failure target", async t => {
    const { page } = await setup(t);
    await page.locator(".request-card-open").click(); await settled(page);
    await page.locator('[data-tool-call-id="activity-3"] .reader-call-toggle').click();
    await selectActivityOption(page, "outcomeFilter", "success"); await ready(page); await settled(page);
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    await expect(page.locator("#requestContent")).not.toContainText("PRIVATE_CALL_ARGUMENT");
    await expect(page.locator(".request-card-open [data-outcome=success]")).toHaveAttribute("data-count", "4");
    await expect(page.locator(".request-card-problem")).toHaveText("Matching tool calls worked.");
    await expect(page.locator(".request-card-open [data-outcome=failure]")).toHaveCount(0);
    await page.locator(".request-card-open").click(); await settled(page);
    await expect(page.locator('[data-tool-call-id="activity-3"]')).not.toBeFocused();
    await expect(page.locator('[data-tool-call-id="activity-3"] .reader-call-toggle')).toBeFocused();
    await expect(page.locator(".reader-scope")).toContainText("4 of 6");
    await expect(page.locator('[data-tool-call-id="activity-3"]>.action-context')).toHaveText("Outside current view");
    await capture(page, "filtered-success-full-context");
});

test("hidden and closed readers scrub private bodies and invalidate detached Copy controls", async t => {
    const { page } = await setup(t);
    await page.locator(".request-card-open").click(); await settled(page);
    const call = page.locator('[data-tool-call-id="activity-3"]');
    await call.locator(".reader-call-toggle").click();
    const oldCopy = await call.getByRole("button", { name: "Copy recorded arguments", exact: true }).elementHandle();
    await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        document.dispatchEvent(new Event("visibilitychange"));
    });

    await expect(page.locator("#requestContent")).not.toContainText("PRIVATE_CALL_ARGUMENT");
    await expect(page.locator("#requestContent .full-text-body")).toHaveCount(0);
    await oldCopy.evaluate(node => node.click());
    assert.deepEqual(await page.evaluate(() => window.testCopies), []);
    await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, value: false });
        document.dispatchEvent(new Event("visibilitychange"));
    });
    await ready(page); await settled(page);
    await expect(call).toContainText("PRIVATE_CALL_ARGUMENT_3");
    await page.locator("#closeContextSidebar").click(); await settled(page);
    await expect(page.locator("#requestContent")).not.toContainText("PRIVATE_CALL_ARGUMENT");
    await oldCopy.evaluate(node => node.click());
    assert.deepEqual(await page.evaluate(() => window.testCopies), []);
});

test("a failed current read after visibility loss cannot repopulate private argument bodies", async t => {
    const { page } = await setup(t);
    await page.locator(".request-card-open").click(); await settled(page);
    await page.locator('[data-tool-call-id="activity-3"] .reader-call-toggle').click();
    await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.route("**/api/snapshot", route => route.fulfill({ status: 503, json: { error: "Synthetic current-read failure" } }));
    const failedRead = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.status() === 503);
    await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, value: false });
        document.dispatchEvent(new Event("visibilitychange"));
    });
    await failedRead; await ready(page);
    await expect(page.locator("#message")).toContainText("Synthetic current-read failure");
    assert.ok(!(await page.locator("#requestContent").innerHTML()).includes("PRIVATE_CALL_ARGUMENT"));
    await expect(page.locator('[data-tool-call-id="activity-3"] .reader-call-toggle')).toBeDisabled();
});

test("changed retained evidence forgets the old private disclosure state", async t => {
    const record = activityRecord(), app = await setup(t, record), { page, context } = app;
    await page.locator(".request-card-open").click(); await settled(page);
    await page.locator('[data-tool-call-id="activity-3"] .reader-call-toggle').click();
    await expect(page.locator("#requestContent")).toContainText("PRIVATE_CALL_ARGUMENT_3");
    record.toolCalls[2].requestArgs.query = "PRIVATE_CHANGED_ARGUMENT";
    await replaceEvidence(context, () => ({ records: [record] }));
    await app.acceptFixtureChange();
    const read = page.waitForResponse(response => response.url().endsWith("/api/snapshot") && response.ok());
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await read; await ready(page); await settled(page);
    await expect(page.locator('[data-tool-call-id="activity-3"] .reader-call-toggle')).toHaveAttribute("aria-expanded", "false");
    assert.ok(!(await page.locator("#requestContent").innerHTML()).includes("PRIVATE_CHANGED_ARGUMENT"));
});

test("forced colors retain keyboard focus and readable failure text without a second list mode", async t => {
    const { page } = await setup(t);
    await page.emulateMedia({ forcedColors: "active" });
    await page.locator(".request-card-open").focus();
    await page.keyboard.press("Enter"); await settled(page);
    const target = page.locator('[data-tool-call-id="activity-3"]');
    await expect(target).toBeFocused();
    const outline = await target.evaluate(node => ({ style: getComputedStyle(node).outlineStyle, width: parseFloat(getComputedStyle(node).outlineWidth) }));
    assert.notEqual(outline.style, "none"); assert.ok(outline.width >= 2);
    await expect(target).toContainText("Request timed out (MCP -32001)");
    await expect(target.locator(".reader-duration-label")).toHaveText("Tool latency:");
    await expect(target.locator(".reader-duration-label")).toBeVisible();
    await expect(page.locator(".reader-timing-column")).toHaveCount(0);
    await expect(page.locator("[data-analyze-mode]")).toHaveCount(0);
    await capture(page, "forced-reader");
});

test("unidentified retained calls do not put private arguments into disclosure identities", async t => {
    const record = activityRecord(1), tool = record.toolCalls[0];
    delete tool.toolCallId; delete tool.startEventId;
    Object.assign(tool, { tool: "workiq-retrieve", reportedOutcome: "succeeded", toolSucceeded: true,
        requestArgs: { query: "PRIVATE_UNIDENTIFIED_ARGUMENT" }, failureEvidence: null });
    const { page, runtime } = await setup(t, record);
    await page.goto(runtime.url + "#request?request=activity-reader"); await ready(page); await settled(page);
    assert.ok(!(await page.locator("#requestContent").innerHTML()).includes("PRIVATE_UNIDENTIFIED_ARGUMENT"));
    await page.locator(".reader-call-toggle").click();
    await expect(page.locator(".technical-detail")).toContainText("PRIVATE_UNIDENTIFIED_ARGUMENT");
    const attributes = await page.locator("#requestContent [id],#requestContent [data-view-key]").evaluateAll(nodes =>
        nodes.map(node => [node.id, node.dataset.viewKey]).flat().filter(Boolean).join(" "));
    assert.ok(!decodeURIComponent(attributes).includes("PRIVATE_UNIDENTIFIED_ARGUMENT"));
});

test("late entry retains labelled per-call timing, identity and exact target without taking user scroll", async t => {
    const { page, runtime } = await setup(t, activityRecord(26)), evidence = [];
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [390, 2]]) {
        await page.goto("about:blank");
        await page.goto(runtime.url); await ready(page);
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => document.documentElement.style.fontSize = "100%");
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await page.locator(".request-card-open").click(); await settled(page);
        const target = page.locator('[data-tool-call-id="activity-26"]');
        await expect(target).toBeFocused();
        await expect(page.locator("#contextSidebarTitle")).toHaveText("Find the workshop checklist.");
        await expect(page.locator(".reader-call-row")).toHaveCount(26);
        const box = await page.locator("#contextSidebarBody").evaluate(body => {
            const rect = node => { const box = node.getBoundingClientRect(); return { top: box.top, bottom: box.bottom }; };
            return { viewport: rect(body), label: rect(body.querySelector('[data-tool-call-id="activity-26"] .reader-duration-label')),
                heading: rect(body.querySelector('[data-reader-section=activity]>.reader-section-heading')),
                target: rect(body.querySelector('[data-tool-call-id="activity-26"]')),
                identity: rect(document.querySelector("#contextSidebarTitle")), scroll: body.scrollTop };
        });
        assert.ok(box.label.top >= box.viewport.top && box.label.bottom <= box.viewport.bottom);
        assert.ok(box.heading.top >= box.identity.bottom && box.target.top >= box.heading.bottom + 4);
        assert.ok(box.target.bottom <= box.viewport.bottom - 4);
        await expect(target.locator("data.call-duration")).toHaveAttribute("value", "975");
        await expect(page.locator(".reader-timing-column")).toHaveCount(0);
        await expect(page.locator(".reader-call-row .reader-duration-label")).toHaveCount(26);
        await capture(page, `late-${theme}-${width}-${scale}`);
        await page.locator("#contextSidebarBody").hover();
        await page.mouse.wheel(0, -220);
        await expect.poll(() => page.locator("#contextSidebarBody").evaluate(node => node.scrollTop)).toBeLessThan(box.scroll);
        await expect(target).toBeFocused();
        evidence.push({ theme, width, scale, ...box });
        const action = await target.getAttribute("data-action-id");
        await page.goto(runtime.url + "#request?" + new URLSearchParams({ request: "activity-reader", layer: "tool", call: action }));
        await ready(page); await settled(page);
        await expect(page.locator("#selectedCall")).toBeFocused();
        const exact = await page.locator("#selectedCall").evaluate(node => ({
            targetTop: node.getBoundingClientRect().top,
            headingBottom: document.querySelector('[data-reader-section=activity]>.reader-section-heading').getBoundingClientRect().bottom,
            readingBottom: node.querySelector(".call-heading").getBoundingClientRect().bottom,
            viewportBottom: document.querySelector("#contextSidebarBody").getBoundingClientRect().bottom,
        }));
        assert.ok(exact.targetTop >= exact.headingBottom + 4 && exact.readingBottom <= exact.viewportBottom);
        await expect(page.locator(".reader-timing-column")).toHaveCount(0);
        await expect(page.locator("#selectedCall .reader-duration-label")).toHaveText("Tool latency:");
        evidence.push({ theme, width, scale, entry: "explicit", ...exact });
        await capture(page, `late-explicit-${theme}-${width}-${scale}`);
    }
    if (proofs) await writeFile(path.join(proofs, "late-entry.json"), JSON.stringify(evidence, null, 2));
});

test("a success with missing service evidence, partial result and missing prompt stay truthful without failure entry", async t => {
    for (const [outcome, label] of [["succeeded", "Worked"], ["partial", "Partly worked"], ["unknown", "No result recorded"]]) {
        await t.test(outcome, async t => {
            const record = activityRecord(1);
            Object.assign(record.toolCalls[0], {
                tool: "workiq-ask", reportedOutcome: outcome, toolSucceeded: outcome === "succeeded" ? true : null,
                requestArgs: { question: "PRIVATE_CALL_ARGUMENT_1" }, failureEvidence: null,
            });
            if (outcome === "unknown") record.userPrompt = { text: null, status: "unavailable",
                authorship: { actor: "unknown", basis: "missing-source" } };
            const { page } = await setup(t, record);
            await expect(page.locator(".request-card-open .request-card-problem")).toContainText(new RegExp(label, "i"));
            if (outcome === "unknown") await expect(page.locator(".request-card-open")).toContainText("Prompt text unavailable");
            await page.locator(".request-card-open").click(); await settled(page);
            await expect(page.locator("#contextSidebarTitle")).toBeFocused();
            await expect(page.locator(".reader-call-services")).toContainText("Asked Copilot");
            await expect(page.locator(".call-heading [data-outcome=failure]")).toHaveCount(0);
            await expect(page.locator(".call-heading")).toContainText(label);
            assert.ok(!(await page.locator("#requestContent").innerHTML()).includes("PRIVATE_CALL_ARGUMENT_1"));
            await capture(page, "one-call-" + outcome);
        });
    }
});

test("the whole interaction continues through report reading and returns with scope, selection and reader position", async t => {
    const { page, runtime } = await setup(t);
    await chooseTheme(page, "dark");
    await page.goto(runtime.url + "#analyze?tool=workiq-fetch&result=failure"); await ready(page);
    await expect(page.locator(".request-card-open [data-outcome=failure]")).toContainText("Access was denied");
    await expect(page.locator(".request-card-open [data-outcome=failure]")).toHaveAttribute("data-count", "1");
    await expect(page.locator(".request-card-count")).toContainText("1 of 6");
    const originURL = page.url();
    await page.locator(".request-card-open").focus();
    const origin = (await page.locator(".request-card-open").boundingBox()).y;
    await page.keyboard.press("Enter"); await settled(page);
    await page.locator('[data-tool-call-id="activity-3"] .reader-call-toggle').click();
    await page.locator("#contextSidebarBody").hover();
    const beforeWheel = await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop);
    await page.mouse.wheel(0, 180);
    await expect.poll(() => page.locator("#contextSidebarBody").evaluate(node => node.scrollTop)).toBeGreaterThan(beforeWheel);
    const beforeReading = await page.locator("#contextSidebarBody").evaluate(node => ({
        top: node.scrollTop, height: node.scrollHeight, viewport: node.clientHeight,
    }));
    const top = beforeReading.top;
    await page.locator("#requestReportToggle").click();
    await page.locator("#requestReportContinue").click(); await ready(page);
    await expect(page.locator('input[data-report-request="activity-reader"]')).toBeChecked();
    await reportContents(page);
    const preparing = page.waitForResponse(response => response.url().endsWith("/api/preview"));
    await page.locator("#exportBtn").click();
    const prepared = await preparing;
    assert.equal(prepared.status(), 200, await prepared.text());
    await capture(page, "report-reading", true);
    await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "ready");
    const frame = page.frameLocator("iframe.report-frame:visible");
    const countRow = frame.locator("tr").filter({ has: frame.getByText("Work IQ tool calls", { exact: true }) });
    await expect(countRow.locator("th,td").nth(1)).toHaveText("6");
    await cancelReportPreview(page);
    await page.goBack(); await ready(page); await settled(page);
    await expect(page.locator("#requestReportToggle")).toHaveText("Remove from report");
    await expect(page.locator("#requestReportContinue")).toBeFocused();
    await expect(page.locator("#toolFilter")).toHaveValue("workiq-fetch");
    await expect(page.locator("#outcomeFilter")).toHaveValues(["failure"]);
    const afterReading = await page.locator("#contextSidebarBody").evaluate(node => ({
        top: node.scrollTop, height: node.scrollHeight, viewport: node.clientHeight,
    }));
    assert.ok(Math.abs(afterReading.top - top) <= 1, JSON.stringify({ beforeReading, afterReading }));
    await expect(page.locator('[data-tool-call-id="activity-3"]')).toContainText("PRIVATE_CALL_ARGUMENT_3");
    await page.locator("#closeContextSidebar").click(); await settled(page);
    await expect(page.locator(".request-card-open")).toBeFocused();
    assert.equal(page.url(), originURL);
    assert.ok(Math.abs((await page.locator(".request-card-open").boundingBox()).y - origin) <= 1);
    await expect(page.locator("#requestContent")).not.toContainText("PRIVATE_CALL_ARGUMENT");
});
