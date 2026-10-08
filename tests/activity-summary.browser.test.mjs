import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, openActivitySessions } from "./helpers.mjs";

const proof = process.env.WIRE_SUMMARY_PROOFS;
async function ready(page) {
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.locator("#activityInsights .assessment-grid, #activityInsights .assessment-empty, #activityInsights .assessment-unavailable").first().waitFor();
    await page.waitForFunction(() => document.querySelector("#activityInsights")?.getAttribute("aria-busy") !== "true");
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function setup(t, { metadata = 9, unattributed = false } = {}) {
    const specs = [["alpha-user", "alpha", "user", 2], ["alpha-agent", "alpha", "agent", 1],
        ["beta-user", "beta", "user", 2], ["gamma-unknown", "gamma", "unknown", 1]];
    const records = specs.map(([id, source, actor, calls]) => {
        const row = fixture(id);
        Object.assign(row, { sourceSessionId: source, sourceSessionName: `Synthetic ${source} chat` });
        row.userPrompt = { text: id === "alpha-user" ? "Synthetic needle request" : `Synthetic ${id} request`,
            status: "full", sourceEventId: `prompt-${id}`, sourceTimestamp: "2026-09-30T12:00:00Z",
            authorship: { actor, basis: { user: "source-user", agent: "source-agent", unknown: "legacy-missing" }[actor] } };
        row.toolCalls = Array.from({ length: calls }, (_, index) => ({
            ...structuredClone(row.toolCalls[0]), toolCallId: `${id}-${index}`, startEventId: `start-${id}-${index}`,
            startedAt: "2026-09-30T12:00:00Z", completedAt: "2026-09-30T12:00:01Z", durationMs: 1000,
            toolSucceeded: actor === "unknown" ? null : !(id === "beta-user" && index === 0),
            reportedOutcome: actor === "unknown" ? "unknown" : id === "beta-user" && index === 0 ? "failed" : "succeeded",
        }));
        return row;
    });
    if (unattributed) records.push({ ...fixture("unattributed"), sourceSessionId: null, sourceSessionName: null });
    const roster = Array.from({ length: metadata }, (_, index) => ({
        sessionId: `metadata-${index}`, name: `Archive-only chat ${index}`, eligible: true, scanned: true,
        projectId: "metadata-project", project: "Metadata project",
    }));
    const cleanups = [];
    const { context } = await privateFixture({ after: action => cleanups.push(action) }, records);
    await replaceEvidence(context, () => ({ records, importCoverage: { counts: {}, roster } }));
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 1100 }, reducedMotion: "reduce", timezoneId: "UTC" });
    const errors = [], requests = [];
    page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => requests.push({ url: request.url(), method: request.method(), input: request.postData() }));
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw new Error("No clipboard reads in summary proof."); },
        writeText() { throw new Error("No clipboard writes in summary proof."); },
    } }));
    t.after(async () => {
        await browser.close(); await runtime.close();
        try {
            assert.deepEqual(errors, []);
            const unexpected = requests.filter(request => new URL(request.url).origin !== new URL(runtime.url).origin
                || request.method !== "GET" && !["/api/snapshot", "/api/collection/status", "/api/assessment/detail",
                    "/api/assessment/overview", "/api/evaluation/automatic/summary"].includes(new URL(request.url).pathname));
            assert.deepEqual(unexpected, [], "Only isolated local reads; no model/provider/source-history/export actions");
            const after = await loadBoardState(context);
            for (const key of ["cards", "evidence", "exports", "pseudonymKey"]) assert.deepEqual(after[key], before[key], key);
        } finally { for (const action of cleanups) await action(); }
    });
    await page.goto(runtime.url + "#activity"); await ready(page);
    return { page, runtime, requests };
}
async function capture(page, name) {
    if (!proof) return;
    await mkdir(proof, { recursive: true });
    await page.mouse.move(0, 0);
    await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
    await page.screenshot({ path: path.join(proof, name + ".png"), fullPage: true });
    await page.locator("#activityInsights").evaluate(node => scrollTo(0, scrollY + node.getBoundingClientRect().top
        - document.querySelector(".app-header").getBoundingClientRect().height - 16));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(proof, name + "-context.png") });
    await page.locator("#activityListSummary:visible, #activityPager:visible, #activityList").first().evaluate(node =>
        scrollTo(0, scrollY + node.getBoundingClientRect().top - document.querySelector(".app-header").getBoundingClientRect().height - 80));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(proof, name + "-list-context.png") });
}
const summary = page => page.locator("#activityListSummary").innerText();

test("one Activity summary separates matches from listed metadata-only chats and preserves the list pager", { timeout: 30000 }, async t => {
    const { page } = await setup(t);
    await capture(page, "mixed-list");
    assert.equal(await page.locator("#activityInsights .assessment-grid").count(), 1, "Summary cleanup does not remove the existing Insights view");
    assert.equal(await page.locator("#activityInsights .assessment-scope").count(), 0, "No repeated default count paragraph");
    assert.equal(await page.locator("#periodResult").innerText(), "3 Copilot chats / 4 request groups with 6 Work IQ tool calls.");
    assert.equal(await summary(page), "Also listed: 9 Copilot chats without matching evidence.");
    assert.equal(await page.locator("#activityPager>span").innerText(), "Listed Copilot chats 1-8 of 12");
    assert.equal(await page.locator("#activityPager").getAttribute("aria-label"), "Copilot chat list pages");
    assert.equal(await page.locator(".session-group").count(), 8);
    const before = await summary(page);
    await page.locator("#activityPager").getByRole("button", { name: "Next", exact: true }).click(); await ready(page);
    assert.equal(await summary(page), before, "Summary describes all matching evidence, not only the current page");
    assert.equal(await page.locator("#activityPager>span").innerText(), "Listed Copilot chats 9-12 of 12");
    assert.equal(await page.locator(".session-group").count(), 4);
    await page.locator("#activityPager").getByRole("button", { name: "Previous", exact: true }).click(); await ready(page);
    await page.locator("#coverage>summary").focus(); await page.keyboard.press("Enter");
    assert.match(await page.locator("#coverageBody .activity-list-explanation").innerText(), /filters and private search/);
    assert.match(await page.locator("#coverageBody .activity-list-explanation").innerText(), /full retained interaction/);
    assert.match(await page.locator("#coverageBody .activity-list-explanation").innerText(), /may have recorded history outside this view/);
    assert.equal(await page.locator("#coverage>summary").evaluate(node => getComputedStyle(node).outlineStyle), "solid");
});

test("filtered, private-search, author-narrow, metadata-only and empty copy preserves the original counts", { timeout: 45000 }, async t => {
    const { page, runtime } = await setup(t);
    const cases = [
        ["#activity?result=failure", "", "Copilot chat 1-1 of 1", "1 Copilot chat / 1 request group with 1 Work IQ tool call."],
        ["#activity?service=Calendar", "", "Copilot chats 1-3 of 3", "3 Copilot chats / 4 request groups with 6 Work IQ tool calls."],
        ["#activity?authors=user", "", "Copilot chats 1-2 of 2", "2 Copilot chats / 2 request groups with 4 Work IQ tool calls."],
        ["#activity?project=metadata-project", "The listed Copilot chats have no matching evidence in this view.", "Listed Copilot chats 1-8 of 9", "0 Copilot chats / 0 request groups with 0 Work IQ tool calls."],
    ];
    for (const [route, text, pager, matching] of cases) {
        await page.goto(runtime.url + route); await ready(page);
        assert.equal(await summary(page), text, route);
        assert.equal(await page.locator("#periodResult").innerText(), matching, "Existing matching facts remain in their single view summary");
        assert.equal(await page.locator("#activityPager>span").innerText(), pager);
        assert.doesNotMatch(await summary(page), /no recorded history|no history/);
        if (route.includes("result=failure")) assert.match(await page.locator("#activityInsights").innerText(), /2\s*\/\s*2 calls timed/,
            "The one matching failed call still selects its full two-call interaction for Insights");
        await capture(page, route.slice(1).replaceAll(/[?=&]/g, "-"));
    }
    await page.goto(runtime.url + "#activity"); await ready(page);
    await page.locator("#activitySearch").fill("needle"); await ready(page);
    assert.equal(await summary(page), "");
    assert.equal(await page.locator("#periodResult").innerText(), "1 Copilot chat / 1 request group with 2 Work IQ tool calls.");
    assert.equal(await page.locator("#activityPager>span").innerText(), "Copilot chat 1-1 of 1");
    assert.doesNotMatch(page.url(), /needle/);
    await capture(page, "private-search");
    await openActivitySessions(page);
    await page.locator(".request-row input[type=checkbox]").first().check();
    const selected = await page.locator("#activitySelectionSummary").textContent();
    await page.locator("#activitySearch").fill("Archive-only"); await ready(page);
    assert.equal(await summary(page), "The listed Copilot chats have no matching evidence in this view.");
    assert.equal(await page.locator("#activityPager>span").innerText(), "Listed Copilot chats 1-8 of 9");
    assert.equal(await page.locator("#activitySelectionSummary").textContent(), selected, "Search/copy changes do not change report inclusion");
    await capture(page, "metadata-only-search");
    await page.locator("#activitySearch").fill("No such invented text"); await ready(page);
    assert.equal(await summary(page), "");
    assert.equal(await page.locator("#activityPager").innerText(), "");
    assert.match(await page.locator("#activityList").innerText(), /No requests match/);
    await capture(page, "empty-search");
});

test("all-match copy keeps canonical source exclusions without extra default prose", { timeout: 30000 }, async t => {
    const all = await setup(t, { metadata: 0 });
    assert.equal(await summary(all.page), "");
    assert.equal(await all.page.locator("#activityListSummary").isVisible(), false);
    assert.equal(await all.page.locator("#periodResult").innerText(), "3 Copilot chats / 4 request groups with 6 Work IQ tool calls.");
    assert.equal(await all.page.locator("#activityPager>span").innerText(), "Copilot chats 1-3 of 3");
    await capture(all.page, "all-matching");
    const missing = await setup(t, { metadata: 0, unattributed: true });
    await missing.page.goto(missing.runtime.url + "#activity?scope=all"); await ready(missing.page);
    assert.equal(await summary(missing.page), "");
    assert.equal(await missing.page.locator("#periodResult").innerText(), "3 Copilot chats / 4 request groups with 6 Work IQ tool calls.", "A source-less tool fixture does not acquire a fabricated canonical identity");
    assert.equal(await missing.page.locator("#activityPager>span").innerText(), "Copilot chats 1-3 of 3");
});

test("summary and pager remain readable at normal and enlarged narrow sizes in both themes", { timeout: 30000 }, async t => {
    const { page } = await setup(t), measurements = [];
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1200, 1], [375, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1100 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${100 * scale}%`, scale);
        await chooseTheme(page, theme);
        const value = await page.locator("#activityListSummary").evaluate(node => ({
            text: node.textContent, font: getComputedStyle(node).fontSize,
            clipped: node.scrollWidth > node.clientWidth + 1,
            pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        }));
        assert.equal(value.clipped, false);
        assert.equal(value.pageOverflow, false);
        assert.equal(value.font, `${14 * scale}px`, "Keep the established readable type role");
        measurements.push({ theme, width, scale, ...value });
        await capture(page, `summary-${theme}-${width}-${scale}`);
    }
    if (proof) await writeFile(path.join(proof, "summary-layout.json"), JSON.stringify(measurements, null, 2));
});
