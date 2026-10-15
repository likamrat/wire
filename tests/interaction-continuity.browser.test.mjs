import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, chooseTheme, selectActivityOption, navigateMain } from "./helpers.mjs";
import { searchFixture } from "./live-search-fixture.mjs";
import { contrast } from "./color-measurements.mjs";

const proof = process.env.WIRE_CONTINUITY_PROOFS;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const card = (page, name) => page.locator(`.request-row[data-view-key="request:continuity-${name}"]`);
const picker = (page, name) => page.locator(`[data-view-key="report:continuity-${name}"]`);

function records() {
    const data = ["calendar", "multiple", "partial", "hosted", "discovery", "missing", "empty"].map((name, index) => {
        const record = fixture("continuity-" + name);
        record.sourceSessionName = "Invented continuity review";
        record.followUpPrompts = [];
        record.userPrompt = { text: `Review the invented ${name} evidence for the Cedar PowerPoint handover.`,
            status: "full", sourceEventId: `continuity-prompt-${name}`,
            sourceTimestamp: new Date(Date.UTC(2026, 8, 30, 12, index)).toISOString(),
            authorship: { actor: "user", basis: "source-user" } };
        record.toolCalls[0] = { ...record.toolCalls[0], startedAt: record.userPrompt.sourceTimestamp, durationMs: 0,
            requestedApiPath: null, requestArgs: { entityUrls: ["/me/events"] } };
        return record;
    });
    data[0].toolCalls[0].toolSucceeded = false;
    data[0].toolCalls[0].reportedOutcome = "failed";
    data[1].toolCalls = [
        ["workiq-fetch", { entityUrls: ["/me/drive/root"] }, "succeeded"],
        ["workiq-call_function", { functionUrl: "/me/events" }, "failed"],
        ["workiq-retrieve", { entityUrl: "/me/messages" }, "partial"],
        ["workiq-ask", { question: "Invented request, not service evidence." }, "unknown"],
        ["workiq-fetch", {}, "unknown"],
    ].map(([tool, requestArgs, reportedOutcome], index) => ({
        ...data[1].toolCalls[0], tool, requestArgs, reportedOutcome,
        toolSucceeded: reportedOutcome === "succeeded" ? true : reportedOutcome === "failed" ? false : null,
        toolCallId: `continuity-multiple-${index}`, startEventId: `continuity-multiple-start-${index}`,
        startedAt: new Date(Date.UTC(2026, 8, 30, 12, 1, index)).toISOString(),
        apiResults: index < 2 ? [{ index: 0, statusCode: 200, evidenceLevel: "intermediary-reported" }] : [],
    }));
    data[2].toolCalls[0].requestArgs = { entityUrls: ["/me/drive/root", "/not-a-known-service/item"] };
    data[3].toolCalls[0] = { ...data[3].toolCalls[0], tool: "workiq-ask", requestArgs: { question: "Invented calendar and mail prose." },
        reportedOutcome: "unknown", toolSucceeded: null, apiResults: [] };
    data[4].toolCalls[0] = { ...data[4].toolCalls[0], tool: "workiq-get_schema",
        requestArgs: { path: "/me/drive/root", operationType: "fetch" }, apiResults: [] };
    data[5].userPrompt.status = "partial";
    data[5].toolCalls[0] = { ...data[5].toolCalls[0], requestArgs: {},
        reportedOutcome: "unknown", toolSucceeded: null, apiResults: [] };
    data[6].toolCalls = [];
    data[6].graphActivities = [{
        activityId: "continuity-reference", sourceSessionId: data[6].sourceSessionId, scenarioId: data[6].scenarioId,
        startEventId: "continuity-reference-start", toolCallId: "continuity-reference-call", tool: "shell",
        method: "GET", startedAt: data[6].userPrompt.sourceTimestamp,
        evidenceLevel: "code-reference", endpoint: { path: "/me/messages", method: "GET", apiVersion: "v1.0", queryShape: [] },
        workload: "Mail", httpStatus: null, statusBasis: "none", requestCount: null,
        countUnit: "recorded-request-site", confidence: "high", synthetic: false, sourceKind: "inline-command",
        requestBasis: "request-command", fallback: { association: "none", precedingWorkIqCallIds: [], causeProven: false }, evidenceRefs: [],
    }];
    return data;
}

async function capture(page, name) {
    if (!proof) return;
    await mkdir(proof, { recursive: true });
    await page.screenshot({ path: path.join(proof, name + ".png"), fullPage: true });
    await page.screenshot({ path: path.join(proof, name + "-viewport.png") });
}
async function outcomes(node) {
    return node.locator(".recorded-result").evaluateAll(nodes =>
        Object.fromEntries(nodes.map(value => [value.dataset.outcome, Number(value.dataset.count)])));
}
async function metadata(node) {
    return node.evaluate(node => {
        const font = element => {
            const css = getComputedStyle(element);
            return [css.fontFamily, css.fontSize, css.fontWeight, css.fontStyle];
        };
        const box = element => { const { x, y, width, height } = element.getBoundingClientRect(); return { x, y, width, height }; };
        const textBox = element => {
            const range = document.createRange(); range.selectNodeContents(element);
            const { y, bottom } = range.getBoundingClientRect(); return { y, bottom };
        };
        return {
            tools: [...node.querySelectorAll(".card-tool-name")].map(value => value.textContent),
            services: [...node.querySelectorAll(".service-cue")].map(value => ({ id: value.dataset.service,
                label: value.textContent, color: getComputedStyle(value).color, icon: value.querySelector("svg")?.dataset.lucideIcon })),
            pills: [...node.querySelectorAll(".recorded-result")].map(value => ({ key: value.dataset.outcome,
                count: Number(value.dataset.count), color: getComputedStyle(value).color, radius: getComputedStyle(value).borderRadius,
                icon: value.querySelector("svg")?.dataset.lucideIcon, font: font(value.querySelector(".recorded-result-label")) })),
            overflow: [...node.querySelectorAll(".identity-overflow")].map(value => ({
                text: value.textContent, font: font(value), previousFont: font(value.previousElementSibling),
                before: value.previousSibling.textContent, display: getComputedStyle(value).display,
                background: getComputedStyle(value).backgroundColor, border: getComputedStyle(value).borderWidth,
                box: box(value), previous: box(value.previousElementSibling),
                textBox: textBox(value), previousTextBox: textBox(value.previousElementSibling.lastElementChild ?? value.previousElementSibling),
                focusable: value.matches("a,button,[tabindex]"),
            })),
        };
    });
}

async function rowSpacing(node) {
    const measured = await node.evaluate(node => {
        const heading = node.matches(".call-heading"), calls = node.matches(".matched-action");
        const selectors = heading ? [".action-heading>h3", ".action-service-heading", ".call-outcome-row"]
            : calls ? [".call-identity-facts>div:first-child", ".call-identity-facts>div:nth-child(2)", ".card-outcomes"]
                : [".interaction-identity>.identity-group:first-child", ".interaction-identity>.identity-group:nth-child(2)", ".interaction-summary>.recorded-results"];
        const box = element => {
            const { top, bottom, height, width } = element.getBoundingClientRect();
            return { top, bottom, height, width };
        };
        const rows = selectors.map(selector => {
            const element = node.querySelector(selector);
            if (!element) return null;
            const css = getComputedStyle(element), bands = [];
            const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                const text = walker.currentNode;
                if (!text.textContent.trim() || text.parentElement.closest("svg,.visually-hidden")) continue;
                const range = document.createRange(); range.selectNodeContents(text);
                for (const rect of range.getClientRects()) if (rect.width && rect.height && !bands.some(top => Math.abs(top - rect.top) <= 1)) bands.push(rect.top);
            }
            return { ...box(element), lineHeight: parseFloat(css.lineHeight), textLines: bands.length,
                marginTop: parseFloat(css.marginTop), marginBottom: parseFloat(css.marginBottom),
                icons: [...element.querySelectorAll(".wire-icon")].map(box),
                controls: [...element.querySelectorAll("button,a,input,[role=button]")].filter(value => value.checkVisibility()).map(box) };
        });
        return { rows, gaps: rows.slice(1).map((row, index) => row && rows[index] ? row.top - rows[index].bottom : null) };
    });
    assert.ok(measured.rows.every(Boolean), "Tools, services and recorded outcomes each have their own nonempty row");
    assert.ok(measured.gaps.every(gap => Math.abs(gap - 4) <= 1), `Adjacent metadata rows use only the compact gap: ${JSON.stringify(measured)}`);
    for (const row of measured.rows.slice(0, 2)) {
        assert.equal(row.marginTop, 0); assert.equal(row.marginBottom, 0);
        assert.ok(row.textLines >= 1);
        if (!row.controls.length) {
            assert.ok(row.height <= row.textLines * row.lineHeight + (row.textLines - 1) * 2 + 1,
                `Noninteractive glyphs cannot add baseline slack or reserve a control-height row: ${JSON.stringify(row)}`);
        } else assert.ok(row.controls.every(control => control.height >= 44 && control.width >= 44));
        assert.ok(row.icons.every(icon => icon.top >= row.top - 1 && icon.bottom <= row.bottom + 1 && icon.height <= row.lineHeight + 1),
            `Metadata glyphs fit the actual text row: ${JSON.stringify(row)}`);
    }
    const [tools, services] = measured.rows;
    if (tools.textLines === 1 && services.textLines === 1 && !tools.controls.length && !services.controls.length) {
        assert.ok(Math.abs(tools.height - services.height) <= 1, "A service icon does not make a single-line row taller than text-only tools");
    }
    return measured;
}

test("one interaction vocabulary connects compact cards, exact calls and report inspection without losing scope or identity", { timeout: 180000 }, async t => {
    const cleanup = [], evidence = records(), samples = [], spacingSamples = [], spacingVariants = {};
    const { context, runtime } = await searchFixture({ after: action => cleanup.push(action) },
        { records: evidence, formats: [], reply: false });
    const before = await loadBoardState(context);
    const browser = await chromium.launch(), browserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 },
        reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC" });
    const page = await browserContext.newPage(), denied = [], errors = [];
    page.setDefaultTimeout(8000);
    const reads = ["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
        "/api/evaluation/automatic/summary", "/api/report-artifacts/list",
        "/api/search/query", "/api/search/events", "/api/search/open", "/api/search/cancel", "/api/search/close"];
    await browserContext.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" && !reads.includes(url.pathname)) {
            denied.push(request.method() + " " + url.pathname);
            return route.abort();
        }
        return route.continue();
    });
    browserContext.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    page.on("pageerror", error => errors.push(error.message));
    await browserContext.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("Real clipboard reads forbidden"); },
        async writeText(text) { window.continuityCopy = text; },
    } }));
    t.after(async () => {
        try {
            await browser.close();
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url); await ready(page); await page.evaluate(() => document.fonts.ready);
    await page.locator("#resultsLink").click();
    await expect(card(page, "multiple").locator(".card-tool-name")).toHaveCount(2);
    await expect(card(page, "multiple").locator(".identity-overflow")).toHaveText(["More tools", "More services"]);
    await expect(card(page, "multiple")).toContainText("Service details incomplete");
    assert.deepEqual(await outcomes(card(page, "multiple")), { success: 1, failure: 1, unknown: 2, partial: 1 });
    await expect(card(page, "partial").locator('[data-service="Files"]')).toHaveCount(1);
    await expect(card(page, "partial")).toContainText("Service details incomplete");
    await expect(card(page, "hosted")).toContainText("workiq-ask");
    await expect(card(page, "hosted")).toContainText("Asked Copilot");
    await expect(card(page, "hosted")).toContainText("Service not shown");
    await expect(card(page, "hosted").locator('[data-service="Mail"],[data-service="Calendar"]')).toHaveCount(0);
    await expect(card(page, "discovery")).toContainText("Schema lookup");
    await expect(card(page, "discovery").locator('[data-service="Files"]')).toHaveCount(0);
    await expect(card(page, "missing")).toContainText("Service not shown");
    await expect(card(page, "missing")).toContainText("1 No result recorded");

    const link = card(page, "calendar").locator(".request-card-open");
    await expect(card(page, "calendar").locator("button,input,a")).toHaveCount(1);
    const text = await link.locator(".request-card-prompt").textContent();
    await link.locator(".request-card-prompt").evaluate(node => {
        const range = document.createRange(); range.selectNodeContents(node);
        getSelection().removeAllRanges(); getSelection().addRange(range);
    });
    await link.dispatchEvent("click", { button: 0 });
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    assert.equal(await page.evaluate(() => getSelection().toString()), text);
    await page.evaluate(() => getSelection().removeAllRanges());
    const popupPromise = browserContext.waitForEvent("page");
    await link.click({ modifiers: ["Control"] });
    const popup = await popupPromise;
    await expect(popup.locator("#contextSidebar[open]")).toBeVisible();
    await expect(page.locator("#contextSidebar[open]")).toHaveCount(0);
    await popup.close();

    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator("#resultsLink").click();
    await link.scrollIntoViewIfNeeded();
    const anchor = await link.boundingBox();
    await page.mouse.click(anchor.x + 20, anchor.y + 20);
    await page.locator("#contextSidebar").evaluate(node => {
        const animation = node.getAnimations()[0];
        if (!animation) throw Error("Expected the real sidebar entry animation");
        animation.pause(); animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
    });
    await capture(page, "entry-in-flight");
    assert.ok(Math.abs((await link.boundingBox()).y - anchor.y) <= 3);
    await page.locator("#contextSidebar").evaluate(node => node.getAnimations()[0].finish());
    await page.emulateMedia({ reducedMotion: "reduce" });
    const call = page.locator('[data-tool-call-id="test-call-continuity-calendar"]');
    assert.deepEqual(await outcomes(call.locator(".journey-result")), { failure: 1 });
    assert.deepEqual(await outcomes(call.locator(".call-api-summary")), { success: 1 });
    await expect(call.locator(".action-heading h3")).toHaveText("workiq-fetch");
    await expect(call.locator(".service-cue")).toHaveText("Calendar");
    const compact = await metadata(card(page, "calendar"));
    const detailed = await metadata(call.locator(".call-heading"));
    assert.deepEqual(detailed.services, compact.services);
    assert.deepEqual(detailed.pills, compact.pills);
    await page.locator("#requestReportToggle").click();
    await page.locator("#requestReportContinue").click();
    await expect(picker(page, "calendar").locator("input")).toBeChecked();
    assert.deepEqual(await metadata(picker(page, "calendar")), compact);
    await picker(page, "calendar").locator(".request-link").click();
    assert.deepEqual(await metadata(call.locator(".call-heading")), detailed);
    await page.getByRole("button", { name: "Back to activity", exact: true }).click();
    await expect(picker(page, "calendar").locator("input")).toBeChecked();

    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [1440, 2], [375, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await chooseTheme(page, theme);
        await navigateMain(page, "analyze"); await ready(page);
        await page.locator("#resultsLink").click();
        const multiple = card(page, "multiple"), values = await metadata(multiple);
        assert.equal(values.tools.length, 2);
        assert.equal(values.services.filter(value => value.id !== "Unknown").length, 2);
        assert.ok(values.overflow.every(value => !value.focusable && value.display === "inline"
            && value.border === "0px" && value.background === "rgba(0, 0, 0, 0)" && value.before === ", "));
        for (const overflow of values.overflow) assert.deepEqual(overflow.font, overflow.previousFont);
        if (width === 1440) for (const overflow of values.overflow) {
            assert.ok(Math.abs(overflow.textBox.bottom - overflow.previousTextBox.bottom) <= 1, "Overflow shares its group's text baseline");
        }
        assert.ok(values.pills.every(value => value.font[2] === "400" && value.font[3] === "normal" && value.icon));
        const spacing = { theme, width, scale, cards: {}, calls: [], detail: [], picker: {}, peek: [] };
        for (const name of ["calendar", "multiple", "partial", "hosted", "discovery", "missing"]) {
            spacing.cards[name] = await rowSpacing(card(page, name));
            await expect(card(page, name).locator(".request-card-time")).toHaveCount(1);
        }
        await capture(page, `${theme}-${width}-${scale}-analyze`);
        await page.locator('[data-analyze-mode="calls"]').click(); await ready(page);
        const calls = page.locator("#activityList>.matched-action");
        for (let index = 0; index < await calls.count(); index++) spacing.calls.push(await rowSpacing(calls.nth(index)));
        await calls.first().scrollIntoViewIfNeeded();
        await capture(page, `${theme}-${width}-${scale}-calls`);
        await page.locator('[data-analyze-mode="interactions"]').click(); await ready(page);
        await multiple.locator(".request-card-open").click();
        const heading = page.locator("#requestContent .call-heading");
        assert.deepEqual((await heading.locator("h3").allTextContents()).sort(),
            ["workiq-fetch", "workiq-ask", "workiq-call_function", "workiq-fetch", "workiq-retrieve"].sort());
        for (const service of ["Mail", "Calendar", "Files"]) await expect(heading.locator(`[data-service="${service}"]`)).toHaveCount(1);
        await expect(heading.filter({ hasText: "Service not shown" })).toHaveCount(2);
        for (let index = 0; index < await heading.count(); index++) spacing.detail.push(await rowSpacing(heading.nth(index)));
        const dimensions = await page.evaluate(() => {
            const sidebar = document.querySelector("#contextSidebar"), close = document.querySelector("#closeContextSidebar");
            const box = close.getBoundingClientRect(), first = document.querySelector(".call-heading h3");
            const css = getComputedStyle(first);
            return { overflow: document.documentElement.scrollWidth - innerWidth, modal: sidebar.matches(":modal"),
                close: { width: box.width, height: box.height }, font: css.fontFamily, weight: css.fontWeight,
                ink: css.color, paper: getComputedStyle(sidebar).backgroundColor };
        });
        assert.ok(dimensions.overflow <= 1); assert.ok(dimensions.close.width >= 44 && dimensions.close.height >= 44);
        assert.equal(dimensions.weight, "400"); assert.match(dimensions.font, /Asta Sans/);
        assert.ok(contrast(dimensions.ink, dimensions.paper) >= 4.5);
        if (width === 375) assert.equal(dimensions.modal, true);
        await capture(page, `${theme}-${width}-${scale}-detail`);
        await page.locator("#contextSidebarBody").evaluate(body => {
            body.scrollTop += body.querySelector(".call-heading").getBoundingClientRect().top - body.getBoundingClientRect().top - 8;
        });
        await capture(page, `${theme}-${width}-${scale}-detail-rows`);
        if (await page.locator("#requestReportToggle").textContent() === "Add to report") await page.locator("#requestReportToggle").click();
        await page.locator("#requestReportContinue").click();
        const report = picker(page, "multiple");
        assert.deepEqual((await metadata(report)).tools, values.tools);
        assert.deepEqual((await metadata(report)).services, values.services);
        assert.deepEqual((await metadata(report)).pills, values.pills);
        for (const name of ["calendar", "multiple", "partial", "hosted"]) spacing.picker[name] = await rowSpacing(picker(page, name));
        await capture(page, `${theme}-${width}-${scale}-picker`);
        await report.locator(".request-link").click();
        await expect(page.locator("#contextSidebar[open]")).toBeVisible();
        for (let index = 0; index < await heading.count(); index++) spacing.peek.push(await rowSpacing(heading.nth(index)));
        await capture(page, `${theme}-${width}-${scale}-peek`);
        await page.getByRole("button", { name: "Back to activity", exact: true }).click();
        await expect(report.locator("input")).toBeChecked();
        samples.push({ theme, width, scale, values, dimensions });
        spacingSamples.push(spacing);
    }

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => document.documentElement.style.fontSize = "100%");
    await navigateMain(page, "analyze"); await ready(page);
    await selectActivityOption(page, "outcomeFilter", "failure"); await ready(page);
    const filtered = card(page, "multiple");
    await expect(filtered.locator(".card-tool-name")).toHaveText("workiq-call_function");
    await expect(filtered.locator(".service-cue")).toHaveText("Calendar");
    assert.deepEqual(await outcomes(filtered), { failure: 1 });
    await filtered.locator(".request-card-open").click();
    await expect(page.locator(".reader-scope")).toContainText("1 of 5");
    assert.deepEqual(await outcomes(page.locator(".full-request-results [data-result-layer=tool]")),
        { success: 1, failure: 1, unknown: 2, partial: 1 });
    await page.locator("#requestReportContinue").click();
    assert.deepEqual(await outcomes(picker(page, "multiple")), { success: 1, failure: 1, unknown: 2, partial: 1 });
    await navigateMain(page, "analyze"); await ready(page);
    await page.locator('[data-analyze-mode="calls"]').click(); await ready(page);
    const matching = page.locator(".matched-action").filter({ hasText: "workiq-call_function" });
    await expect(matching.locator(".service-cue")).toHaveText("Calendar");
    assert.deepEqual(await outcomes(matching), { failure: 1 });
    await matching.locator(".request-link").click();
    await expect(page.locator("#selectedCall .action-heading h3")).toHaveText("workiq-call_function");
    await page.locator("#closeContextSidebar").click();
    await selectActivityOption(page, "outcomeFilter", "all"); await ready(page);
    await page.locator('[data-analyze-mode="interactions"]').click(); await ready(page);
    await selectActivityOption(page, "layerFilter", "reported-api"); await ready(page);
    await expect(card(page, "calendar").locator(".recorded-results")).toHaveAttribute("data-result-layer", "reported-api");
    assert.deepEqual(await outcomes(card(page, "calendar")), { success: 1 });
    await expect(card(page, "calendar")).toContainText("1 HTTP 2xx");
    await card(page, "calendar").locator(".request-card-open").click();
    await page.locator("#requestReportContinue").click();
    await expect(picker(page, "calendar").locator(".recorded-results")).toHaveAttribute("data-result-layer", "tool");
    assert.deepEqual(await outcomes(picker(page, "calendar")), { failure: 1 });
    await navigateMain(page, "analyze"); await ready(page);
    await selectActivityOption(page, "layerFilter", "code-reference"); await ready(page);
    await expect(card(page, "empty")).toContainText("Execution not observed");
    await expect(card(page, "empty")).not.toContainText("Worked");
    await expect(card(page, "empty").locator(".card-tool-name")).toHaveText("shell");
    await selectActivityOption(page, "layerFilter", "tool"); await ready(page);

    await page.locator("#pageAction").click();
    await page.locator("#reportRequestSearch").fill("empty");
    await expect(picker(page, "empty")).toContainText("No recorded Work IQ tool calls");
    await expect(picker(page, "empty").locator(".recorded-result,.service-cue")).toHaveCount(0);
    await expect(picker(page, "empty").locator(".interaction-identity")).toHaveCount(0);
    await picker(page, "empty").locator(".request-link").click();
    await expect(page.locator("#requestContent")).toContainText("Execution not observed");
    await page.getByRole("button", { name: "Back to activity", exact: true }).click();
    let snapshotCase = "missing-tool";
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), data = await response.json();
        if (snapshotCase === "missing-tool") {
            for (const rows of [data.analytics.rows, data.requestActivity.tool]) {
                for (const row of rows) if (row.scenarioId === "continuity-missing") row.tool = null;
            }
            for (const tool of data.scenarios.find(row => row.scenarioId === "continuity-missing").toolCalls) tool.tool = null;
        } else delete data.requestActivity.tool;
        await route.fulfill({ response, json: data });
    });
    await navigateMain(page, "analyze");
    await page.reload(); await ready(page);
    await expect(card(page, "missing")).toContainText("Tool not recorded");
    await expect(card(page, "missing")).toContainText("1 No result recorded");
    spacingVariants.missingTool = await rowSpacing(card(page, "missing"));
    await card(page, "missing").locator(".request-card-open").click();
    await expect(page.locator("#requestContent .call-heading h3")).toHaveText("Tool not recorded");
    spacingVariants.missingToolDetail = await rowSpacing(page.locator("#requestContent .call-heading"));
    await page.locator("#closeContextSidebar").click();
    snapshotCase = "unavailable";
    await page.locator("#pageAction").click();
    await page.reload(); await ready(page);
    await page.locator("#reportRequestSearch").fill("calendar");
    await expect(picker(page, "calendar")).toContainText("result counts unavailable");
    await expect(picker(page, "calendar")).not.toContainText("No recorded Work IQ tool calls");
    await expect(picker(page, "calendar").locator(".recorded-result")).toHaveCount(0);
    spacingVariants.unavailable = await rowSpacing(picker(page, "calendar"));
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    spacingVariants.unavailable200 = await rowSpacing(picker(page, "calendar"));
    await capture(page, "unavailable-rows-200");
    await page.evaluate(() => document.documentElement.style.fontSize = "100%");
    await page.unroute("**/api/snapshot");
    await page.reload(); await ready(page);
    await navigateMain(page, "settings"); await ready(page);
    await expect(page.locator("#settingsView")).toBeVisible();
    await expect(page.locator('#settingsView [data-fluent-icon]')).toHaveCount(0);
    const search = page.locator("#wireSearch");
    const capsule = await search.boundingBox();
    await search.fill("POWER");
    await expect(page.locator(".wire-search-hit mark").first()).toHaveText(/^power$/i);
    assert.deepEqual(await search.boundingBox(), capsule);
    await expect(page.locator(".wire-search-kind").first()).toHaveText("Interaction");
    const hit = page.locator(".wire-search-hit").first();
    await hit.click();
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await page.locator("#closeContextSidebar").click();
    await expect(search).toHaveValue("POWER");
    await expect(hit).toBeFocused();
    await capture(page, "settings-search-return");
    if (proof) {
        await writeFile(path.join(proof, "continuity-measurements.json"), JSON.stringify(samples, null, 2));
        await writeFile(path.join(proof, "dedicated-row-spacing.json"), JSON.stringify(spacingSamples, null, 2));
        await writeFile(path.join(proof, "row-gap-variants.json"), JSON.stringify(spacingVariants, null, 2));
    }
});
