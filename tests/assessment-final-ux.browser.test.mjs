import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { fixture, privateFixture, chooseTheme, openActivitySessions } from "./helpers.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { buildAssessmentModel } from "../lib/assessment-read-model.mjs";
import { executeAssessmentAction } from "../lib/assessment.mjs";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import * as contract from "../lib/assessment-contract.mjs";
import { createAssessmentPresentation } from "../web/assessment-presentation.mjs";

const checks = [
    { dimension: "accuracy", checkId: "semantic-answer-correctness", pass: "Correct", fail: "Not correct" },
    { dimension: "answer-trust", checkId: "answer-support-validity", pass: "Supported", fail: "Not supported" },
    { dimension: "action-trust", checkId: "action-authorization-compliance", pass: "Authorized", fail: "Not authorized" },
];
async function setup(t, records, judgments) {
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    let runtime, browser;
    const errors = [], calls = [], forbidden = [];
    t.after(async () => {
        try { await browser?.close(); assert.deepEqual(errors, []); assert.deepEqual(forbidden, []); }
        finally { try { await runtime?.close(); } finally { for (const action of cleanup) await action(); } }
    });
    for (const { scenarioId, checkId, verdict } of judgments) {
        const state = await loadBoardState(context), model = buildAssessmentModel(state);
        const interactionRef = model.catalog.find(row => row.scenarioId === scenarioId).interactionRef;
        await executeAssessmentAction(context, "synthetic-final-ux", "set_personal_assessment", {
            schemaVersion: 1, mutationRef: "mutation-" + randomUUID().replaceAll("-", ""), interactionRef,
            expectedBasis: model.basis, checkId, verdict, withdraw: false,
        });
    }
    const before = await loadBoardState(context);
    runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        const allowed = url.origin === new URL(runtime.url).origin && (
            request.method() === "GET" && ["/", "/favicon.svg", "/assets/assessment-contract.mjs"].includes(url.pathname)
            || request.method() === "POST" && ["/api/session", "/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview", "/api/assessment/mutation/status"].includes(url.pathname)
        );
        if (!allowed) { forbidden.push(`${request.method()} ${url.pathname}`); return route.abort(); }
        if (request.method() === "POST") calls.push(url.pathname);
        return route.continue();
    });
    await page.addInitScript(() => {
        window.syntheticCopies = [];
        Object.defineProperty(navigator, "clipboard", { value: {
            readText() { throw Error("No real clipboard reads."); },
            async writeText(text) { window.syntheticCopies.push(text); },
        } });
    });
    return { context, runtime, page, calls, before };
}
async function ready(page, selector = ".interaction-insights") {
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.locator(`${selector} .assessment-grid`).waitFor();
    await page.evaluate(() => document.fonts.ready);
}

test("detail labels Automatic and uses existing single personal verdict words without an objective percentage", { timeout: 30000 }, async t => {
    const cases = checks.flatMap(check => ["pass", "fail"].map(verdict => ({
        ...check, verdict, scenarioId: `${check.dimension}-${verdict}`, expected: check[verdict],
    })));
    const records = cases.map(item => fixture(item.scenarioId));
    const { context, runtime, page, before, calls } = await setup(t, records, cases);
    for (const item of cases) {
        await page.goto(runtime.url + "#request?request=" + item.scenarioId); await ready(page);
        const rows = page.locator(`.interaction-insights [data-dimension="${item.dimension}"]`);
        const personal = rows.filter({ hasText: "Your feedback" });
        const automatic = rows.filter({ hasNotText: "Your feedback" });
        assert.match(await automatic.textContent(), /Automatic/);
        assert.equal(await automatic.locator(".assessment-value").textContent(), "No result");
        assert.equal(await personal.locator(".assessment-value").textContent(), item.expected);
        assert.equal(await personal.locator(".assessment-origin").textContent(), "Your feedback");
        assert.doesNotMatch(await personal.locator(".assessment-value").textContent(), /%/);
        assert.equal(await personal.locator(".assessment-coverage").textContent(), "Results for 1 of 1 request");
    }
    const after = await loadBoardState(context);
    assert.deepEqual(after.evidence, before.evidence);
    assert.deepEqual(after.personalEvaluation.feedback, before.personalEvaluation.feedback);
    assert.equal(calls.includes("/api/assessment/feedback"), false);
});

test("aggregate with only one rated interaction leads with its full selected coverage", { timeout: 30000 }, async t => {
    const records = ["rated", "unrated-a", "unrated-b"].map(fixture);
    const { context, runtime, page } = await setup(t, records, [{
        scenarioId: "rated", checkId: checks[0].checkId, verdict: "pass",
    }]);
    await page.goto(runtime.url + "#home"); await ready(page, "#homeInsights");
    const rows = page.locator('#homeInsights [data-dimension="accuracy"]');
    assert.match(await rows.filter({ hasNotText: "Your feedback" }).textContent(), /Automatic/);
    const personal = rows.filter({ hasText: "Your feedback" });
    assert.equal(await personal.locator(".assessment-value").textContent(), "1 passed \u00b7 0 failed");
    assert.equal(await personal.locator(".assessment-coverage").textContent(), "Results for 1 of 3 requests");
    assert.equal((await loadBoardState(context)).personalEvaluation.feedback.records.length, 1);
});

test("one personal Not-sure judgment stays unassessed rather than a pass, failure or percentage", { timeout: 30000 }, async t => {
    const record = fixture("not-sure");
    const { context, runtime, page } = await setup(t, [record], [{ scenarioId: record.scenarioId, checkId: checks[0].checkId, verdict: "unassessed" }]);
    await page.goto(runtime.url + "#request?request=not-sure"); await ready(page);
    const rows = page.locator('.interaction-insights [data-dimension="accuracy"]');
    const personal = rows.filter({ hasText: "Your feedback" });
    assert.equal(await personal.locator(".assessment-value").textContent(), "No result");
    const automatic = rows.filter({ hasNotText: "Your feedback" });
    assert.equal(await automatic.locator(".assessment-origin").textContent(), "Automatic");
    assert.equal(await automatic.locator(".assessment-value").textContent(), "No result");
    assert.equal((await loadBoardState(context)).personalEvaluation.feedback.records[0].assessment.verdict, "unassessed");
});

test("Graph empty state and visible-status help describe recorded request sites without changing layers", { timeout: 30000 }, async t => {
    const { runtime, page } = await setup(t, [fixture("graph-empty")], []);
    await page.goto(runtime.url + "#home?layer=direct-request"); await page.locator('#workspace[aria-busy="false"]').waitFor();
    assert.match(await page.locator("#chart").textContent(), /No qualifying recorded Graph request sites/);
    assert.equal(await page.locator("#layerFilter").inputValue(), "direct-request");
    await page.goto(runtime.url + "#home?layer=recorded-http"); await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.locator("#meaning>summary").click();
    assert.match(await page.locator("#meaningBody").innerText(), /subset of recorded Graph request sites, not extra requests/);
    assert.equal(await page.locator("#layerFilter").inputValue(), "recorded-http");
    assert.equal(await page.locator("#activityCount").textContent(), "0");
});

test("optional feedback is reachable before one keyboard-accessible disclosure containing every recorded definition", { timeout: 30000 }, async t => {
    const record = fixture("feedback-placement");
    const { context, runtime, page } = await setup(t, [record], [{ scenarioId: record.scenarioId, checkId: checks[0].checkId, verdict: "pass" }]);
    const state = await loadBoardState(context), model = buildAssessmentModel(state);
    const detail = [...model.details.values()][0];
    const expected = createAssessmentPresentation(contract).summarize(detail.metrics);
    const definitions = [...Object.values(expected.groups).flat(), ...expected.diagnostics].flatMap(row => row.details.slice(2));
    await page.goto(runtime.url + "#request?request=" + record.scenarioId); await ready(page);
    const trigger = page.locator(".interaction-insights").getByRole("button", { name: "Details and feedback", exact: true });
    for (const [width, size] of [[320, 100], [320, 200], [375, 100], [1200, 100]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(size => { document.documentElement.style.fontSize = `${size}%`; }, size);
        await page.evaluate(() => document.fonts.ready);
        await trigger.click();
        const dialog = page.getByRole("dialog", { name: "Insight details", exact: true });
        const give = dialog.getByRole("button", { name: "Give personal feedback", exact: true });
        const disclosure = dialog.locator("details").filter({ has: page.getByText("Recorded measures and definitions", { exact: true }) });
        assert.equal(await dialog.locator("details").count(), 1);
        assert.equal(await disclosure.evaluate(node => node.open), false);
        assert.equal(await dialog.locator(".assessment-definition:visible").count(), 0);
        assert.match(await dialog.textContent(), /personal.*automatic/i);
        const bounds = await give.evaluate(node => ({ top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom }));
        assert.ok(bounds.top >= 0 && bounds.bottom <= 1000, `Feedback is reachable without scrolling past definitions at ${width}/${size}.`);
        assert.equal(await give.evaluate(node => Boolean(node.compareDocumentPosition(node.closest("dialog").querySelector("details")) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
        await dialog.getByRole("button", { name: "Close", exact: true }).focus();
        await page.keyboard.press("Tab");
        assert.equal(await dialog.getByRole("combobox", { name: "Personal feedback (optional)", exact: true }).evaluate(node => node === document.activeElement), true);
        await disclosure.locator("summary").focus(); await page.keyboard.press("Enter");
        assert.equal(await disclosure.evaluate(node => node.open), true);
        const text = await disclosure.textContent();
        for (const definition of definitions) assert.ok(text.includes(definition), `Preserved: ${definition}`);
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => ![...document.querySelectorAll("dialog")].some(node => node.open));
        assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
    }
});

test("recorded results and Insights stay ahead of an expanded exact Prompt through refresh and Back", { timeout: 45000 }, async t => {
    const record = fixture("long-prompt");
    const text = "ARTIFICIAL long prompt\n  Exact spacing  \n" + "Long retained source text \u65e5\u672c\u8a9e e\u0301 <not-markup>. ".repeat(160) + "\nLAST_CHARACTER";
    record.userPrompt.text = text;
    const { context, runtime, page } = await setup(t, [record], checks.map((check, index) => ({
        scenarioId: record.scenarioId, checkId: check.checkId, verdict: index === 1 ? "pass" : "fail",
    })));
    await page.goto(runtime.url + "#activity"); await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.locator("#activitySearch").fill("long prompt");
    await openActivitySessions(page);
    const origin = page.url();
    await page.getByRole("link", { name: "View interaction", exact: true }).click(); await ready(page);
    const prompt = page.locator(".request-original"), insights = page.locator(".interaction-insights");
    assert.equal(await page.locator("#requestContent").evaluate(node =>
        node.firstElementChild.classList.contains("request-outcome") && node.firstElementChild.nextElementSibling.classList.contains("interaction-insights")), true);
    for (const theme of ["light", "dark"]) for (const width of [320, 375, 414, 768, 820, 1200, 2560]) for (const size of [100, 200]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(size => { document.documentElement.style.fontSize = `${size}%`; scrollTo(0, 0); }, size);
        await page.evaluate(() => document.fonts.ready);
        const toggle = prompt.locator(".full-text-toggle");
        if (await toggle.getAttribute("aria-expanded") === "true") await toggle.click();
        const before = await insights.evaluate(node => node.getBoundingClientRect().top + scrollY);
        await toggle.click();
        assert.equal(await prompt.locator("pre").textContent(), text);
        const position = await page.evaluate(() => ({
            insightTop: document.querySelector(".interaction-insights").getBoundingClientRect().top + scrollY,
            insightBottom: document.querySelector(".interaction-insights").getBoundingClientRect().bottom,
            promptTop: document.querySelector(".request-original").getBoundingClientRect().top,
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
            loaded: getComputedStyle(document.body).fontFamily.startsWith("Arial") && document.fonts.check("14px Arial"),
        }));
        assert.equal(position.insightTop, before, "Expanding the Prompt cannot move Insights down.");
        assert.ok(position.insightBottom <= position.promptTop + 1);
        assert.equal(position.overflow, false, `${theme}/${width}/${size}`);
        assert.equal(position.loaded, true);
    }
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await prompt.getByRole("button", { name: "Copy prompt", exact: true }).click();
    assert.deepEqual(await page.evaluate(() => window.syntheticCopies), [text]);
    const pre = prompt.locator("pre");
    await pre.focus();
    const top = await pre.evaluate(node => node.getBoundingClientRect().top);
    await replaceEvidence(context, () => ({ records: [record, fixture("unrelated")], importCoverage: { counts: { includedSessions: 1, includedProjects: 1 }, roster: [] } }));
    const refreshed = page.waitForResponse(response => response.url().endsWith("/api/snapshot"));
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await refreshed; await ready(page);
    assert.equal(await pre.textContent(), text);
    assert.equal(await pre.evaluate(node => node === document.activeElement), true);
    assert.ok(Math.abs(await pre.evaluate(node => node.getBoundingClientRect().top) - top) <= 1);
    assert.equal(await page.locator("#activitySelectionSummary").textContent(), "No requests selected");
    await page.locator("#contextBack").click(); await page.locator('#workspace[aria-busy="false"]').waitFor();
    assert.equal(page.url(), origin);
    assert.equal(await page.locator("#activitySearch").inputValue(), "long prompt");
    await page.getByRole("link", { name: "View interaction", exact: true }).click(); await ready(page);
    assert.equal(await prompt.locator(".full-text-toggle").getAttribute("aria-expanded"), "true");
    assert.equal(await pre.textContent(), text);
});

test("native Back, Forward and Reports hash navigation close old assessment dialogs without reopening them", { timeout: 30000 }, async t => {
    const record = fixture("dialog-navigation");
    const { runtime, page } = await setup(t, [record], []);
    await page.goto(runtime.url + "#activity"); await page.locator('#workspace[aria-busy="false"]').waitFor();
    await openActivitySessions(page);
    await page.getByRole("link", { name: "View interaction", exact: true }).click(); await ready(page);
    await page.getByRole("button", { name: "Details and feedback", exact: true }).click();
    assert.equal(await page.locator(".assessment-dialog[open]").count(), 1);
    await page.goBack();
    await page.locator("#activityView").waitFor({ state: "visible" });
    assert.equal(await page.locator(".assessment-dialog[open]").count(), 0);
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest("#activityView")) || ["pageTitle", "main"].includes(document.activeElement?.id)), true);
    await page.goForward(); await ready(page);
    assert.equal(await page.locator(".assessment-dialog[open]").count(), 0);
    await page.getByRole("button", { name: "Details and feedback", exact: true }).click();
    await page.evaluate(() => { location.hash = "#reports"; });
    await page.locator("#reportsView").waitFor({ state: "visible" });
    assert.equal(await page.locator(".assessment-dialog[open]").count(), 0);
    assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest("#reportsView")) || ["pageTitle", "main"].includes(document.activeElement?.id)), true);
});

for (const outcome of ["complete", "lost-response"]) {
    test(`pending feedback survives navigation with ${outcome}, without replay or an old dialog returning`, { timeout: 30000 }, async t => {
        const record = fixture("pending-navigation");
        const { context, runtime, page } = await setup(t, [record], []);
        let entered, release, finished, submitted = false, writes = 0, responseStatus;
        const pending = new Promise(resolve => { entered = resolve; });
        const hold = new Promise(resolve => { release = resolve; });
        const done = new Promise(resolve => { finished = resolve; });
        await page.route("**/api/assessment/feedback", async route => {
            writes++;
            const response = await route.fetch();
            responseStatus = response.status(); submitted = true; entered();
            await hold;
            try {
                if (outcome === "complete") await route.fulfill({ response });
                else await route.abort("connectionreset");
            } finally { finished(); }
        });
        try {
            await page.goto(runtime.url + "#activity"); await page.locator('#workspace[aria-busy="false"]').waitFor();
            await openActivitySessions(page);
            await page.getByRole("link", { name: "View interaction", exact: true }).click(); await ready(page);
            await page.getByRole("button", { name: "Details and feedback", exact: true }).click();
            await page.getByRole("button", { name: "Give personal feedback", exact: true }).click();
            const feedback = page.getByRole("dialog", { name: "Your feedback: answer correctness", exact: true });
            await feedback.getByRole("combobox", { name: "Your assessment", exact: true }).click();
            await page.getByRole("option", { name: "Correct", exact: true }).click();
            await feedback.getByRole("button", { name: "Save feedback", exact: true }).click();
            await pending;
            assert.equal(responseStatus, 200);
            assert.equal(await page.evaluate(() => {
                const receipt = JSON.parse(sessionStorage.getItem("wire.assessment.pending"));
                return /^mutation-[a-f0-9]{32}$/.test(receipt.mutationRef) && /^[a-f0-9]{64}$/.test(receipt.receiptToken);
            }), true);
            if (outcome === "complete") {
                await page.goBack(); await page.locator("#activityView").waitFor({ state: "visible" });
                assert.equal(await page.locator(".assessment-dialog[open]").count(), 0);
                assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest("#activityView")) || ["pageTitle", "main"].includes(document.activeElement?.id)), true);
                await page.goForward(); await ready(page);
            } else {
                await page.evaluate(() => { location.hash = "#reports"; });
                await page.locator("#reportsView").waitFor({ state: "visible" });
                assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest("#reportsView")) || ["pageTitle", "main"].includes(document.activeElement?.id)), true);
            }
            assert.equal(await page.locator(".assessment-dialog[open]").count(), 0);
            assert.equal(await page.locator(".assessment-dialog form").count(), 0, "The abandoned feedback draft is not retained in an old dialog.");
            assert.notEqual(await page.evaluate(() => sessionStorage.getItem("wire.assessment.pending")), null);
            release(); await done;
            if (outcome === "lost-response") {
                const check = page.getByRole("button", { name: "Check earlier update", exact: true });
                await check.waitFor(); await check.click();
            }
            await page.waitForFunction(() => sessionStorage.getItem("wire.assessment.pending") === null);
            assert.equal(await page.locator(".assessment-dialog[open]").count(), 0);
            assert.equal(await page.evaluate(() => document.activeElement?.closest(".assessment-dialog") === null && document.activeElement?.checkVisibility()), true);
            assert.equal(writes, 1);
            assert.equal((await loadBoardState(context)).personalEvaluation.feedback.records.length, 1);
            if (outcome === "lost-response") {
                assert.equal(new URL(page.url()).hash, "#reports");
                assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest("#reportsView")) || ["pageTitle", "main"].includes(document.activeElement?.id)), true);
            }
        } finally {
            release();
            if (submitted) await done;
        }
    });
}
