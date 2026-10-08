import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { replaceEvidence, loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";

const sessionId = "result-session", sessionName = "Synthetic result review";
const slice = "#activity?layer=tool&scope=all&from=2026-09-30&to=2026-09-30&service=Calendar&project=test-project";
function records() {
    const requests = [0, 1].map(index => {
        const row = fixture("mixed-result-" + index);
        row.sourceSessionId = sessionId;
        row.sourceSessionName = sessionName;
        row.userPrompt.text = "Synthetic mixed request " + index;
        row.toolCalls = Array.from({ length: 7 }, (_, i) => ({
            ...structuredClone(row.toolCalls[0]),
            toolCallId: `result-call-${index}-${i}`, startEventId: `result-start-${index}-${i}`,
            startedAt: "2026-09-30T12:00:00Z",
            toolSucceeded: i !== 6, reportedOutcome: i === 6 ? "failed" : "succeeded",
            apiResults: [{ index: 0, statusCode: i === 6 ? 403 : 200, ...(i === 6 ? { errorCode: "SyntheticDenied" } : {}) }],
        }));
        return row;
    });
    const outside = ["date", "service", "project", "session"].map(kind => {
        const row = structuredClone(requests[0]);
        row.scenarioId = "outside-" + kind;
        row.toolCalls = [{ ...row.toolCalls[0], toolCallId: "outside-" + kind, startEventId: "outside-start-" + kind }];
        if (kind === "date") row.toolCalls[0].startedAt = "2026-09-28T12:00:00Z";
        if (kind === "service") {
            row.toolCalls[0].requestedApiPath = "/me/messages";
            row.toolCalls[0].requestArgs = { entityUrls: ["/me/messages"] };
        }
        if (kind === "project") row.projectId = "outside-project";
        if (kind === "session") row.sourceSessionId = "other-session";
        return row;
    });
    return [...requests, ...outside, { ...structuredClone(requests[0]), scenarioId: "legacy-alias", isLegacy: true }];
}
async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
}
async function setup(t) {
    const source = records(), { context } = await privateFixture(t, source);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(), page = await browser.newPage({
        viewport: { width: 1200, height: 950 }, timezoneId: "America/Los_Angeles", reducedMotion: "reduce",
    });
    page.setDefaultTimeout(5000);
    const errors = [], posts = [], urls = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        urls.push(request.url());
        if (request.method() === "POST") posts.push(new URL(request.url()).pathname);
    });
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("No clipboard access in result proof."); },
        writeText() { throw Error("No clipboard access in result proof."); },
    } }));
    t.after(async () => {
        await browser.close(); await runtime.close();
        assert.deepEqual(errors, []);
        assert.ok(posts.every(url => ["/api/connect", "/api/snapshot", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview", "/api/evaluation/automatic/summary"].includes(url)), "Only local snapshot/status and versioned insight reads: " + JSON.stringify(posts));
    });
    await page.goto(runtime.url + slice); await ready(page);
    if (await page.locator("#collectionSetup").isVisible() && await page.locator("#collectionSetup").getAttribute("open") !== null) await page.locator("#collectionSetup>summary").click();
    return { page, source, context, runtime, urls };
}
function group(page) { return page.locator(`[data-session-id="${sessionId}"].session-group`); }
async function allMatching(page) {
    const ids = [];
    do {
        ids.push(...await page.locator(".matched-action").evaluateAll(nodes => nodes.map(node => node.dataset.actionId)));
        const next = page.getByRole("button", { name: /^Next matching / });
        if (!await next.count() || await next.isDisabled()) break;
        await next.click();
    } while (true);
    return ids;
}

test("search and both result pills fit their painted bounds at 375/820/1200 and 200% text", { timeout: 60000 }, async t => {
    const { page } = await setup(t), measurements = [], failures = [];
    const proof = process.env.WORKIQ_RESULT_PROOFS;
    if (proof) await mkdir(proof, { recursive: true });
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 950 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        await chooseTheme(page, theme);
        await page.keyboard.press("Escape");
        const measurement = await page.evaluate(() => {
            const rect = node => {
                const box = node.getBoundingClientRect();
                return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
            };
            const input = document.querySelector("#activitySearch"), style = getComputedStyle(input);
            const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d");
            ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            const available = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 20;
            const label = document.querySelector('label[for="activitySearch"]');
            const labelRange = document.createRange(); labelRange.selectNodeContents(label);
            const pills = [...document.querySelectorAll('[data-session-id="result-session"] .session-summary .recorded-result')].map(node => {
                const s = getComputedStyle(node), before = getComputedStyle(node, "::before");
                const text = [...node.childNodes].find(n => n.nodeType === Node.TEXT_NODE || n.nodeName === "SPAN");
                const range = document.createRange(); range.selectNodeContents(text);
                const textBox = range.getBoundingClientRect(), box = rect(node), icon = rect(node.querySelector("svg"));
                const backgroundHeight = s.backgroundImage !== "none" ? parseFloat(s.backgroundSize.split(" ")[1]) : box.height;
                const insetTop = before.content !== "none" ? parseFloat(before.top) : (box.height - backgroundHeight) / 2;
                const insetBottom = before.content !== "none" ? parseFloat(before.bottom) : (box.height - backgroundHeight) / 2;
                return { ...box, tag: node.tagName, outcome: node.dataset.outcome, decoration: s.textDecorationLine,
                    text: { x: textBox.x, y: textBox.y, right: textBox.right, bottom: textBox.bottom },
                    icon, paintTop: box.y + insetTop, paintBottom: box.bottom - insetBottom,
                    backgroundSize: s.backgroundSize, line: parseFloat(s.lineHeight), font: parseFloat(s.fontSize) };
            });
            return { input: rect(input), available, placeholderWidth: ctx.measureText(input.placeholder).width,
                label: rect(label), labelText: { right: labelRange.getBoundingClientRect().right },
                inputLine: parseFloat(style.lineHeight), inputFont: parseFloat(style.fontSize),
                overflow: document.documentElement.scrollWidth - innerWidth, pills };
        });
        measurements.push({ theme, width, scale, ...measurement });
        if (proof) {
            await page.locator(".section-heading:has(#activitySearch)").screenshot({ path: path.join(proof, `search-${theme}-${width}-${scale}x.png`) });
            await group(page).locator(".session-summary").screenshot({ path: path.join(proof, `results-${theme}-${width}-${scale}x.png`) });
        }
        const fail = message => failures.push(`${theme}/${width}/${scale}x: ${message}`);
        if (measurement.placeholderWidth > measurement.available) fail("placeholder is clipped");
        if (measurement.overflow > 1) fail("page overflows");
        if (measurement.labelText.right > measurement.label.right + 1) fail("label is clipped");
        for (const pill of measurement.pills) {
            if (pill.tag !== "A") fail(`${pill.outcome} is not a link`);
            if (pill.decoration !== "none") fail(`${pill.outcome} is underlined`);
            if (pill.height < 44) fail(`${pill.outcome} has a short hit target`);
            if (pill.text.right > pill.right - 8 || pill.icon.x < pill.x + 8
                || pill.text.y < pill.paintTop || pill.text.bottom > pill.paintBottom
                || pill.icon.y < pill.paintTop || pill.icon.bottom > pill.paintBottom) fail(`${pill.outcome} exceeds painted pill bounds`);
            if (pill.backgroundSize === "100% 28px") fail("rectangular fixed-height background clips the capsule");
        }
    }
    if (proof) await writeFile(path.join(proof, "bounds.json"), JSON.stringify(measurements, null, 2));
    assert.deepEqual(failures, []);
});

test("12 Worked and 2 Tool failed navigate canonical actions in exactly the originating slice", { timeout: 60000 }, async t => {
    const { page, source, runtime, context, urls } = await setup(t);
    const original = await loadBoardState(context);
    for (const [outcome, count] of [["success", 12], ["failure", 2]]) {
        await page.goto(runtime.url + slice); await ready(page);
        await page.locator("#activitySearch").fill(sessionName);
        const pill = group(page).locator(`a.result-link[data-outcome="${outcome}"]`);
        assert.equal(await pill.count(), 1, `${outcome} is actionable`);
        assert.equal(await pill.getAttribute("data-count"), String(count));
        assert.equal(await group(page).locator(".session-toggle").getAttribute("aria-expanded"), "false");
        assert.equal(await group(page).locator("a a,button a,a button").count(), 0);
        assert.match(await pill.getAttribute("aria-label"), new RegExp(`${count}.*${sessionName}`));
        const restPaint = await pill.evaluate(node => getComputedStyle(node, "::before").backgroundColor);
        await pill.hover();
        const hover = await pill.evaluate(node => ({ decoration: getComputedStyle(node).textDecorationLine, paint: getComputedStyle(node, "::before").backgroundColor }));
        assert.equal(hover.decoration, "none");
        assert.notEqual(hover.paint, restPaint);
        await page.mouse.down();
        const pressed = await pill.evaluate(node => ({ decoration: getComputedStyle(node).textDecorationLine, paint: getComputedStyle(node, "::before").backgroundColor }));
        assert.equal(pressed.decoration, "none");
        assert.notEqual(pressed.paint, hover.paint);
        await page.mouse.move(0, 0); await page.mouse.up();
        assert.equal(await group(page).locator(".session-toggle").getAttribute("aria-expanded"), "false");
        assert.equal(await page.getByRole("tooltip").isVisible(), false, "The pressed link keeps help dismissed with retained focus");
        await pill.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        assert.equal(await pill.evaluate(node => node === document.activeElement), true);
        await page.getByRole("tooltip").waitFor({ state: "visible" });
        assert.match(await page.getByRole("tooltip").innerText(), /recorded|retained/);
        const focusStyle = await pill.evaluate(node => ({ decoration: getComputedStyle(node).textDecorationLine, outline: getComputedStyle(node).outlineStyle }));
        assert.equal(focusStyle.decoration, "none");
        assert.notEqual(focusStyle.outline, "none");
        if (outcome === "success") await page.keyboard.press("Enter"); else await pill.click();
        await ready(page);
        const params = new URLSearchParams(page.url().split("?")[1]);
        assert.equal(params.get("session"), sessionId);
        assert.equal(params.get("result"), outcome);
        for (const [key, value] of new URLSearchParams(slice.split("?")[1])) assert.equal(params.get(key), value);
        assert.equal(await page.locator("#activitySearch").inputValue(), sessionName);
        assert.match(await page.locator("#sessionAnalysis").innerText(), /2 request groups with 14 Work IQ tool calls/);
        assert.match(await page.locator("#sessionAnalysis .session-scope").innerText(), new RegExp(`showing ${outcome === "success" ? "Worked" : "Tool failed"} only`));
        assert.deepEqual(await page.locator(".session-selected:visible").allInnerTexts(), ["0 in report"]);
        assert.equal(await page.locator(".request-row").count(), 0, "Result drilldown is actions, not mixed request cards");
        const actual = await allMatching(page);
        const expected = buildActivityAnalytics(source, { layer: "tool", timeContext: { timeZone: "America/Los_Angeles", locale: "en-US" }, filters: {
            scope: "all", from: "2026-09-30", to: "2026-09-30", workloads: ["Calendar"], projectIds: ["test-project"],
            sourceSessionIds: [sessionId], outcomes: [outcome],
        } }).rows.map(row => row.id);
        assert.equal(actual.length, count);
        assert.equal(new Set(actual).size, count);
        assert.deepEqual([...actual].sort(), expected.sort());
        if (outcome === "success") assert.equal(await page.locator(".matched-action .action-error").count(), 0);
        await page.locator(".matched-action .text-link").first().hover();
        assert.equal(await page.locator(".matched-action .text-link").first().evaluate(node => getComputedStyle(node).textDecorationLine), "none", "Ordinary context links also omit hover underlines");
        await page.locator(".matched-action .text-link").first().click(); await ready(page);
        assert.equal(await page.locator(".journey-item").count(), 6, "Full mixed request is still paged");
        assert.match(await page.locator(".full-request-results").textContent(), /7 Work IQ tool calls/);
        await page.goBack(); await ready(page);
        assert.match(page.url(), new RegExp(`result=${outcome}`));
        await page.reload(); await ready(page);
        assert.equal(await page.locator("#activitySearch").inputValue(), sessionName);
        assert.equal((await allMatching(page)).length, count);
        await page.locator("#pageHeadingActions").getByRole("link", { name: "Back to Copilot chats", exact: true }).click(); await ready(page);
        assert.equal(await page.locator("#activitySearch").inputValue(), sessionName);
        assert.equal(new URLSearchParams(page.url().split("?")[1]).has("session"), false);
    }
    assert.ok(urls.every(url => !decodeURIComponent(url).includes(sessionName)), "Private search never enters a request URL");
    const after = await loadBoardState(context);
    assert.deepEqual(after.cards, original.cards);
    assert.deepEqual(after.exports, original.exports);
});

test("a private request match narrows Worked without expanding to the session's other successful requests", { timeout: 15000 }, async t => {
    const { page, runtime } = await setup(t);
    await page.locator("#activitySearch").fill("Synthetic mixed request 0");
    const pill = group(page).locator('a.result-link[data-outcome="success"]');
    assert.equal(await pill.getAttribute("data-count"), "6");
    const href = await pill.getAttribute("href");
    await pill.click(); await ready(page);
    assert.equal((await allMatching(page)).length, 6);
    assert.match(await page.locator("#sessionAnalysis").innerText(), /1 request group with 7 Work IQ tool calls/);
    assert.ok((await page.locator(".matched-action .action-purpose").allTextContents()).every(text => text === "Synthetic mixed request 0"));
    await page.reload(); await ready(page);
    assert.equal((await allMatching(page)).length, 6);
    await page.locator("#pageHeadingActions").getByRole("link", { name: "Back to Copilot chats", exact: true }).click(); await ready(page);
    assert.equal(await page.locator("#activitySearch").inputValue(), "Synthetic mixed request 0");
    assert.equal(await group(page).locator('a.result-link[data-outcome="success"]').getAttribute("data-count"), "6");
    const fresh = await page.context().browser().newContext({ timezoneId: "America/Los_Angeles", locale: "en-US" });
    const deep = await fresh.newPage();
    try {
        await deep.goto(new URL(href, runtime.url).href); await ready(deep);
        assert.equal(new URLSearchParams(deep.url().split("?")[1]).get("session"), sessionId);
        assert.equal(new URLSearchParams(deep.url().split("?")[1]).get("result"), "success");
        assert.equal(await deep.locator("#activitySearch").inputValue(), "", "Copied URLs cannot contain private search");
        assert.equal((await allMatching(deep)).length, 12, "Fresh deep link retains every explicit URL filter");
        assert.match(await deep.locator("#viewingContext").innerText(), /Worked/);
    } finally { await fresh.close(); }
});

test("result links retain separate API and visible-status units; unknown, zero and code-only counts stay inert", { timeout: 30000 }, async t => {
    const { page, runtime, context } = await setup(t);
    await page.goto(runtime.url + slice.replace("layer=tool", "layer=reported-api")); await ready(page);
    await group(page).locator('a.result-link[data-outcome="success"]').click(); await ready(page);
    assert.equal((await allMatching(page)).length, 12);
    assert.match(await page.locator("#sessionAnalysis").innerText(), /2 request groups with 14 tool-returned API results/);
    assert.match(page.url(), /layer=reported-api/);
    const row = fixture("unobserved-request");
    row.sourceSessionId = sessionId;
    row.sourceSessionName = sessionName;
    row.toolCalls[0].toolSucceeded = null;
    row.toolCalls[0].reportedOutcome = "unknown";
    row.toolCalls[0].apiResults = [];
    row.graphActivities = [200, 403, null, "code"].map((status, index) => ({
        activityId: `graph-result-${index}`, sourceSessionId: sessionId, scenarioId: row.scenarioId,
        toolCallId: `shell-${index}`, startEventId: `shell-start-${index}`, startedAt: "2026-09-30T12:00:00Z",
        tool: "shell", evidenceLevel: status === "code" ? "code-reference" : status === null ? "requested-direct-graph" : "output-visible-http",
        endpoint: { path: "/me/events", method: "GET", apiVersion: "v1.0", queryShape: [] },
        workload: "Calendar", method: "GET", httpStatus: typeof status === "number" ? status : null,
        statusBasis: typeof status === "number" ? "explicit-output-status" : "none", requestCount: null,
        countUnit: "recorded-request-site", confidence: "high", synthetic: false, sourceKind: "inline-command",
        requestBasis: "request-command", fallback: { association: "none", precedingWorkIqCallIds: [], causeProven: false }, evidenceRefs: [],
    }));
    await replaceEvidence(context, () => ({ records: [row], importCoverage: { counts: {}, roster: [] } }));
    for (const layer of ["tool", "code-reference"]) {
        await page.goto(runtime.url + `#activity?session=${sessionId}&layer=${layer}`); await ready(page);
        assert.equal(await page.locator(".result-link:visible").count(), 0);
        assert.match(await page.locator("#sessionAnalysis").innerText(), layer === "tool" ? /No result recorded/ : /Execution not observed/);
    }
    for (const layer of ["direct-request", "recorded-http"]) for (const outcome of ["success", "failure"]) {
        await page.goto(runtime.url + `#activity?session=${sessionId}&layer=${layer}`); await ready(page);
        const summary = page.locator("#sessionAnalysis");
        assert.equal(await summary.locator('a[data-outcome="unknown"]').count(), 0);
        await summary.locator(`a.result-link[data-outcome="${outcome}"]`).click(); await ready(page);
        assert.equal((await allMatching(page)).length, 1);
        assert.match(page.url(), new RegExp(`layer=${layer}`));
        assert.match(await page.locator("#sessionAnalysis").innerText(), layer === "direct-request" ? /3 recorded Graph request sites/ : /2 Graph request sites with visible status/);
    }
    await page.goto(runtime.url + `#activity?session=${sessionId}&layer=tool&from=2026-01-01&to=2026-01-02`); await ready(page);
    assert.equal(await page.locator(".result-link:visible").count(), 0);
    assert.match(await page.locator("#sessionAnalysis").innerText(), /None in this scope/);
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), data = await response.json();
        delete data.sessionAnalysis;
        await route.fulfill({ response, json: data });
    });
    await page.reload(); await ready(page);
    assert.equal(await page.locator("#sessionAnalysis .result-link").count(), 0);
    assert.match(await page.locator("#sessionAnalysis").innerText(), /result counts unavailable/);
});

test("search keeps native long-query editing, help stays isolated and refresh retains a successful action", { timeout: 30000 }, async t => {
    const { page, context, source } = await setup(t);
    const input = page.getByRole("searchbox", { name: "Find a Copilot chat or request group", exact: true });
    const long = "Synthetic long private query ".repeat(20);
    await input.fill(long);
    assert.equal(await input.inputValue(), long);
    await page.keyboard.press("Home"); await page.keyboard.type("START ");
    assert.equal(await input.inputValue(), "START " + long);
    await page.keyboard.press("End"); await page.keyboard.type(" END");
    assert.equal(await input.inputValue(), "START " + long + " END");
    assert.equal(await input.evaluate(node => node.selectionStart), ("START " + long + " END").length);
    await input.fill(sessionName);
    const currentUrl = page.url();
    await page.getByRole("button", { name: "About Find a Copilot chat or request group", exact: true }).click();
    assert.equal(page.url(), currentUrl);
    assert.equal(await input.inputValue(), sessionName);
    assert.match(await page.getByRole("tooltip").innerText(), /project names or GitHub Copilot chat names/);
    await page.keyboard.press("Escape");
    await group(page).locator('a.result-link[data-outcome="success"]').click(); await ready(page);
    const action = page.locator(".matched-action .text-link").first();
    await action.focus();
    const href = await action.getAttribute("href"), beforeUrl = page.url();
    const incoming = fixture("incoming-result");
    incoming.sourceSessionId = "other-session";
    await replaceEvidence(context, () => ({ records: [...source, incoming], importCoverage: { counts: {}, roster: [] } }));
    await page.waitForResponse(response => response.url().endsWith("/api/snapshot"), { timeout: 15000 }); await ready(page);
    assert.equal(page.url(), beforeUrl);
    assert.equal(await input.inputValue(), sessionName);
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute("href")), href);
    assert.equal((await allMatching(page)).length, 12);
});
