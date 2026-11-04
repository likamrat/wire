import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, chooseTheme, selectActivityOption, navigateMain, revealAnalyzeRecords } from "./helpers.mjs";
import { searchFixture } from "./live-search-fixture.mjs";
import { contrast, distance, hue, pairwise, measureChartPaint } from "./color-measurements.mjs";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";

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

test("screen service roles stay distinct from green completion and red failures in cards and Analyze", { timeout: 120000 }, async t => {
    const charts = createDimensionalCharts(), samples = [], cleanup = [];
    const targets = ["/me/messages", "/me/events", "/me/drive", "/teams", "/me/people", "/planner/tasks",
        "/me/onenote/pages", "/groups", "/search/query", "/unclassified", "/$batch"];
    const evidence = ["people-worked", "people-failed", "files", "hosted", "all-services"].map((name, index) => {
        const record = fixture("clarity-" + name);
        record.sourceSessionName = "Invented service clarity review";
        record.followUpPrompts = [];
        record.userPrompt = { text: `Inspect the invented ${name} record.`, status: "full",
            sourceEventId: "clarity-prompt-" + name, sourceTimestamp: new Date(Date.UTC(2026, 8, 30, 12, 10 - index)).toISOString(),
            authorship: { actor: "user", basis: "source-user" } };
        const call = { ...record.toolCalls[0], startedAt: record.userPrompt.sourceTimestamp, requestedApiPath: null, durationMs: 1200,
            requestArgs: { entityUrls: [index < 2 ? "/me/people" : "/me/drive"] } };
        record.toolCalls = [call];
        if (index === 1) Object.assign(call, { reportedOutcome: "failed", toolSucceeded: false, apiResults: [{ index: 0, statusCode: 403 }] });
        if (index === 3) Object.assign(call, { tool: "workiq-ask", requestArgs: { question: "Invented request only; not service evidence." }, apiResults: [] });
        if (index === 4) {
            record.userPrompt.text += " Compare every recorded target without assuming that tool purpose proves service execution.".repeat(5);
            record.toolCalls = [...targets, ["/me/drive", "/unclassified"], ["/me/events", "/me/messages"], null, null].map((target, i) => ({
                ...call, toolCallId: "clarity-all-" + i, startEventId: "clarity-all-start-" + i,
                tool: i === 13 ? "workiq-get_schema" : i === 14 ? "workiq-retrieve" : "workiq-fetch",
                requestArgs: i === 13 ? { path: "/me/messages", operationType: "fetch" }
                    : target ? { entityUrls: Array.isArray(target) ? target : [target] } : {},
                toolSucceeded: i % 4 === 0 ? true : i % 4 === 1 ? false : null,
                reportedOutcome: ["succeeded", "failed", "partial", "unknown"][i % 4], apiResults: [],
            }));
            record.httpRecords = [200, 503, null, 302, null].map((status, i) => ({
                recordId: "clarity-http-" + i, classification: "direct-graph-http", synthetic: false,
                observedGraphHttp: status !== null, responseOrigin: status === null ? null : "https://graph.microsoft.com",
                method: "GET", apiVersion: "v1.0", responsePath: { path: i === 3 ? "/$batch" : "/me/people", query: [] },
                startedAt: call.startedAt, durationMs: 12, status, transportError: i === 2 ? "TimeoutError" : null,
            }));
        }
        return record;
    });
    const { context, runtime } = await searchFixture({ after: action => cleanup.push(action) }, { records: evidence, formats: [], reply: false });
    const before = await loadBoardState(context), errors = [], denied = [];
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(6000);
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET"
            && !["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
                "/api/evaluation/automatic/summary", "/api/report-artifacts/list"].includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        return route.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("Clipboard reads forbidden"); }, writeText() { throw Error("Clipboard writes forbidden"); },
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
    const row = name => page.locator(`.request-row[data-view-key="request:clarity-${name}"]`);
    async function paint() {
        return page.locator(".service-cue,.service-cue>span,.identity-gap,.recorded-result,.recorded-result-label,.percentage-label,.percentage-cue,.result-legend-icon").evaluateAll(nodes => {
            const rgba = value => value.startsWith("color(srgb")
                ? [...value.slice(11, -1).split("/")[0].trim().split(/\s+/).map(v => Number(v) * 255), Number(value.split("/")[1]?.replace(")", "") ?? 1)]
                : [...value.match(/[\d.]+/g).slice(0, 3).map(Number), Number(value.match(/[\d.]+/g)[3] ?? 1)];
            const background = node => {
                const ancestors = []; for (let current = node; current; current = current.parentElement) ancestors.unshift(current);
                let color = [255, 255, 255];
                for (const current of ancestors) {
                    const [r, g, b, a] = rgba(getComputedStyle(current).backgroundColor);
                    color = [r, g, b].map((v, i) => v * a + color[i] * (1 - a));
                }
                return `rgb(${color.join(",")})`;
            };
            return nodes.filter(node => node.checkVisibility({ visibilityProperty: true })).map(node => {
                const svg = node.matches(".percentage-cue") ? node.querySelector("svg") : node.querySelector(".wire-icon");
                return { label: node.textContent || node.closest("li")?.textContent, color: getComputedStyle(node).color,
                    background: background(node), service: node.dataset.service, outcome: node.dataset.outcome,
                    icon: svg?.dataset.lucideIcon, iconColor: svg ? getComputedStyle(svg).stroke : null,
                    iconWidth: svg?.getBoundingClientRect().width, fontWeight: getComputedStyle(node).fontWeight };
            });
        });
    }
    async function readable() {
        const rows = await paint();
        for (const item of rows) {
            assert.ok(contrast(item.color, item.background) >= 4.5, JSON.stringify(item));
            if (item.iconColor) assert.ok(contrast(item.iconColor, item.background) >= 3, JSON.stringify(item));
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        return rows;
    }
    async function widgetProof(palette) {
        const layouts = await page.locator(".percentage-legend-row").evaluateAll(nodes => nodes.map(node => {
            const box = element => element?.getBoundingClientRect().toJSON() ?? null;
            const label = node.querySelector(".percentage-label"), value = node.querySelector(".percentage-value"), svg = node.querySelector("svg");
            const initial = { row: box(node), label: box(label), value: box(value), svg: box(svg) };
            const style = svg?.getAttribute("style");
            if (svg) svg.style.display = "none";
            const withoutGlyph = { row: box(node), label: box(label), value: box(value) };
            if (svg) { if (style === null) svg.removeAttribute("style"); else svg.setAttribute("style", style); }
            return { name: label.textContent, control: label.matches("a,button"), initial, withoutGlyph,
                labelLineHeight: getComputedStyle(label).lineHeight, labelPadding: getComputedStyle(label).padding,
                glyphDecorative: !svg || svg.getAttribute("aria-hidden") === "true" && svg.getAttribute("focusable") === "false",
                rowGap: getComputedStyle(node).gap };
        }));
        for (const item of layouts) {
            assert.equal(item.initial.row.height, item.withoutGlyph.row.height, JSON.stringify(item));
            assert.deepEqual(item.initial.label, item.withoutGlyph.label, "Decorative widget glyph cannot enlarge or displace its label");
            assert.ok(item.glyphDecorative);
            if (item.control) assert.ok(item.initial.label.width >= 44 && item.initial.label.height >= 44);
            assert.ok(item.initial.value.left >= item.initial.label.right - 1 || item.initial.value.top >= item.initial.label.bottom - 1,
                "Legend action and count have nonoverlapping layout boxes");
        }
        const values = await page.locator(".percentage-legend-row").evaluateAll(nodes => nodes.map(node => ({
            category: node.dataset.category, basis: node.dataset.serviceBasis, label: node.querySelector(".percentage-label").textContent,
            kind: node.closest("[data-breakdown]")?.dataset.breakdown, labelColor: getComputedStyle(node.querySelector(".percentage-label")).color,
            count: node.dataset.count, value: node.querySelector(".percentage-value").textContent,
            color: getComputedStyle(node.querySelector(".percentage-cue") || node).color,
        })));
        const marks = await page.evaluate(measureChartPaint, ".percentage-face,.percentage-bar,.flat-time-segment,.flat-comparison-segment");
        assert.ok(marks.length > 0, "The applied layer has rendered chart marks");
        for (const value of values.filter(value => value.kind === "outcomes")) {
            assert.equal(value.color, palette.outcomes[value.category]);
            assert.equal(value.labelColor, value.color, "Outcome legend text and glyphs match the pill palette");
        }
        for (const mark of marks) {
            assert.ok(mark.local && mark.opacity === 1 && mark.colors.length > 0, JSON.stringify(mark));
            for (const color of mark.colors) assert.ok(contrast(color, mark.background) >= 3, JSON.stringify(mark));
            if (mark.category === "success") assert.ok(mark.colors.every(color => hue(color) > 100 && hue(color) < 150));
            if (["failure", "transport"].includes(mark.category)) assert.ok(mark.colors.every(color => hue(color) < 20 || hue(color) > 350));
        }
        if (!await page.locator("#meaning").evaluate(node => node.open)) await page.locator("#meaning>summary").click();
        const tables = page.locator("#percentageData .percentage-table");
        await expect(tables).toHaveCount(4);
        const tableRows = await tables.locator("tbody tr").evaluateAll(rows => rows.map(row => ({
            label: row.querySelector("th").textContent, count: row.querySelector("td").textContent,
        })));
        for (const value of values.filter(value => value.category)) {
            const expectedCount = value.category === "Search"
                ? String(Number(value.count) + Number(values.find(row => row.basis === "Search")?.count ?? 0)) : value.count;
            assert.ok(tableRows.some(row => row.label === value.label && row.count === expectedCount),
                `${value.label} retains its exact-data count, including the existing combined Search target/purpose table row`);
            assert.ok(value.count && value.value.includes(`(${value.count})`), JSON.stringify(value));
        }
        await readable();
        await page.locator("#meaning>summary").click();
        return { values, marks, layouts };
    }
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        const palette = await page.evaluate(({ servicePalette, outcomeTones }) => {
            const css = getComputedStyle(document.documentElement), probe = document.createElement("span");
            document.body.append(probe);
            const color = token => { probe.style.color = `var(--${token})`; return getComputedStyle(probe).color; };
            const result = {
                services: Object.fromEntries(Object.entries(servicePalette).map(([id, entry]) => [id, color(`chart-${entry.token}-label`)])),
                outcomes: Object.fromEntries(Object.entries(outcomeTones).map(([key, tone]) => [key, color(`chart-${tone}-label`)])),
                assistance: color("muted"),
                surfaces: Object.fromEntries(["page", "paper", "canvas", "hover"].map(key => [key, css.getPropertyValue(`--${key}`).trim()])),
            };
            probe.remove(); return result;
        }, { servicePalette: charts.servicePalette, outcomeTones: charts.outcomeTones });
        const audit = [...Object.entries(palette.services), ["Asked Copilot (operation)", palette.assistance]].map(([service, color]) => ({
            service, color, contrast: Math.min(...Object.values(palette.surfaces).map(surface => contrast(color, surface))),
            againstOutcomes: Object.fromEntries(Object.entries(palette.outcomes).map(([key, ink]) => [key, distance(color, ink)])),
        }));
        assert.ok(audit.every(row => row.contrast >= 4.5), JSON.stringify(audit));
        assert.ok(pairwise(palette.services)[0].distance >= 7, "Existing service-to-service palette separation is preserved");
        const outcomeContrast = Object.fromEntries(Object.entries(palette.outcomes).map(([key, color]) =>
            [key, Math.min(...Object.values(palette.surfaces).map(surface => contrast(color, surface)))]));
        assert.ok(Object.values(outcomeContrast).every(value => value >= 4.5), JSON.stringify(outcomeContrast));
        assert.ok(hue(palette.outcomes.success) > 100 && hue(palette.outcomes.success) < 150);
        assert.equal(palette.outcomes.transport, palette.outcomes.failure, "Connection failure shares red paint, not the failure label or glyph");
        assert.ok(distance(palette.services.People, palette.outcomes.success) > 10, "People cyan no longer collides with Worked");
        assert.ok(distance(palette.services.Files, palette.outcomes.success) > 5, "Files retains its teal identity beside green completion");
        for (const [width, scale] of [[1440, 1], [1440, 2], [375, 1], [375, 2]]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
            await navigateMain(page, "analyze"); await ready(page);
            const widgets = await widgetProof(palette);
            const serviceIds = widgets.values.filter(value => value.category).map(value => value.category);
            for (const id of ["Mail", "Calendar", "Files", "Teams", "People", "Tasks", "Notes", "Directory", "Search"]) assert.ok(serviceIds.includes(id), id);
            await page.locator("#percentageCharts").scrollIntoViewIfNeeded();
            await capture(page, `clarity-${theme}-${width}-${scale}-widgets`);
            await revealAnalyzeRecords(page);
            for (const name of ["people-worked", "people-failed", "files", "hosted"]) await rowSpacing(row(name));
            const normal = await readable();
            for (const name of ["people-worked", "files"]) { await row(name).hover(); await readable(); }
            await row("people-worked").locator(".request-card-open").focus(); await readable();
            await capture(page, `clarity-${theme}-${width}-${scale}-adjacent`);
            const assistance = normal.find(item => item.service === "Unknown" && item.icon === "message-circle");
            assert.equal(assistance.iconWidth, 18);
            assert.equal(assistance.color, theme === "light" ? "rgb(86, 86, 86)" : "rgb(184, 184, 184)");
            assert.ok(normal.filter(item => item.service).every(item => item.fontWeight === "400"));
            await row("hosted").locator(".request-card-open").click(); await readable();
            const detail = page.locator('#requestContent .journey-item[data-tool-call-id="test-call-clarity-hosted"]');
            if (!await detail.locator(".detail-disclosure").evaluate(node => node.open)) await detail.locator(".detail-disclosure>summary").click();
            await expect(detail.locator(".reader-call-evidence")).toBeVisible();
            await expect(detail.locator(".reader-call-evidence")).toContainText("recorded tool output does not identify a downstream service");
            await expect(detail.locator(".reader-call-evidence")).toContainText("not a service failure or a check of your current connection");
            await expect(detail.locator(".action-service-heading")).toHaveText("Asked Copilot, Service not shown");
            assert.equal(await detail.locator(".service-cue svg").evaluate(svg => svg.getBoundingClientRect().width), 18);
            await detail.locator(".reader-call-evidence").scrollIntoViewIfNeeded();
            await capture(page, `clarity-${theme}-${width}-${scale}-evidence-gap`);
            await page.locator("#closeContextSidebar").click();
            samples.push({ theme, width, scale, palette, audit, outcomeContrast, widgets, normal });
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => document.documentElement.style.fontSize = "100%");
        await page.locator('[data-chart="workload"]').click(); await ready(page);
        await readable();
        await capture(page, `clarity-${theme}-grouped-categories`);
        const showAll = page.getByRole("button", { name: "Show all", exact: true });
        if (await showAll.isVisible()) { await showAll.click(); await ready(page); }
        await readable();
        await capture(page, `clarity-${theme}-all-categories`);
        await selectActivityOption(page, "layerFilter", "http"); await ready(page);
        const http = await widgetProof(palette);
        assert.ok(http.values.some(value => value.category === "Platform metadata"), "Diagnostic service paint is exercised in its actual HTTP layer");
        const transport = page.locator('#outcomeChart .percentage-legend-row[data-category=transport]');
        await expect(transport).toContainText("Connection failed");
        await expect(transport.locator("svg")).toHaveAttribute("data-lucide-icon", "unplug");
        assert.equal(await transport.locator(".percentage-cue").evaluate(node => getComputedStyle(node).color), palette.outcomes.failure);
        await page.locator('[data-chart="workload"]').click(); await ready(page);
        await readable();
        await capture(page, `clarity-${theme}-http-categories`);
        await page.locator('[data-chart="time"]').click(); await ready(page);
        await capture(page, `clarity-${theme}-http-outcomes`);
        await selectActivityOption(page, "layerFilter", "tool"); await ready(page);
    }
    await page.emulateMedia({ forcedColors: "active" });
    await revealAnalyzeRecords(page);
    await expect(row("people-worked")).toContainText("1 Tool completed");
    await expect(row("people-failed")).toContainText("1 Tool failed");
    await expect(row("hosted")).toContainText("Service not shown");
    assert.equal(await row("people-worked").locator('[data-outcome="success"] svg').getAttribute("data-lucide-icon"), "check");
    assert.equal(await row("people-failed").locator('[data-outcome="failure"] svg').getAttribute("data-lucide-icon"), "circle-x");
    await row("people-worked").locator(".request-card-open").focus();
    await page.keyboard.press("Shift");
    assert.notEqual(await row("people-worked").locator(".request-card-open").evaluate(node => getComputedStyle(node).outlineStyle), "none");
    await capture(page, "clarity-forced-colors");
    if (proof) await writeFile(path.join(proof, "service-outcome-palette-and-paint.json"), JSON.stringify(samples, null, 2));
});
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

async function adjacentReportAction(page, name) {
    const source = page.locator("#requestReportContinue"), target = page.locator("#requestReportToggle");
    await target.evaluate(node => {
        window.reportActionClicks = 0;
        node.addEventListener("click", () => window.reportActionClicks++);
    });
    const initial = await target.textContent();
    const expected = initial === "Add to report" ? "Remove from report" : "Add to report";
    await source.hover(); await expect(page.getByRole("tooltip")).toBeVisible();
    const tooltip = await page.getByRole("tooltip").boundingBox(), box = await target.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect(target).toHaveText(expected); await expect(target).toBeFocused();
    assert.equal(await page.evaluate(() => window.reportActionClicks), 1);
    await expect(page.getByRole("tooltip")).toBeHidden();
    const keyboardSource = await source.isDisabled() ? source.locator("..") : source;
    await keyboardSource.focus(); await expect(page.getByRole("tooltip")).toBeVisible();
    await page.keyboard.press("Shift+Tab"); await expect(target).toBeFocused();
    await page.keyboard.press("Enter"); await expect(target).toHaveText(initial);
    assert.equal(await page.evaluate(() => window.reportActionClicks), 2);
    await expect(page.getByRole("tooltip")).toBeHidden();
    await capture(page, name);
    return { tooltip, target: box, initial, pointerResult: expected, keyboardResult: initial, clicks: 2 };
}

async function auditTargets(page, selector) {
    const measured = await page.locator(selector).evaluateAll(nodes => nodes.filter(node => node.checkVisibility()).map(node => {
        const rect = node => node.getBoundingClientRect().toJSON(), box = rect(node), style = getComputedStyle(node);
        const label = node.closest(".full-text-header")?.querySelector("h2,h3")
            || node.closest(".context-sidebar-header")?.querySelector("#contextSidebarTitle");
        const text = label ? rect(label) : null;
        const siblings = [...(node.parentElement?.children ?? [])].filter(sibling => sibling !== node
            && sibling.matches("button,a") && sibling.checkVisibility()).map(rect);
        const x = box.x + box.width / 2, y = box.y + box.height / 2;
        const hit = x >= 0 && x < innerWidth && y >= 0 && y < innerHeight ? document.elementFromPoint(x, y) : null;
        return { target: node.id || node.getAttribute("aria-label") || node.className,
            box, text, siblings, padding: style.padding, margin: style.margin, lineHeight: style.lineHeight,
            glyph: node.querySelector("svg") ? rect(node.querySelector("svg")) : null,
            hit: hit ? hit === node || node.contains(hit) : null,
            hitTarget: hit ? { tag: hit.tagName, id: hit.id, class: hit.className,
                tooltip: hit.closest(".ux-tooltip")?.textContent, tooltipBox: hit.closest(".ux-tooltip") ? rect(hit.closest(".ux-tooltip")) : null } : null, disabled: node.disabled };
    }));
    const overlaps = (a, b) => a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
    for (const item of measured) {
        assert.ok(item.box.width >= 44 && item.box.height >= 44, JSON.stringify(item));
        assert.ok(!item.text || !overlaps(item.box, item.text), "Neighboring utility does not intercept the heading text");
        assert.ok(item.siblings.every(sibling => !overlaps(item.box, sibling)), "Neighboring utility hit boxes do not overlap");
    }
    return measured;
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
            const icons = [...element.querySelectorAll(".wire-icon")];
            const glyphs = icons.map(icon => ({
                asset: icon.dataset.lucideIcon, display: box(icon),
                localPaint: Object.fromEntries(["x", "y", "width", "height"].map(key => [key, icon.getBBox()[key]])),
                stroke: getComputedStyle(icon).strokeWidth, padding: getComputedStyle(icon).padding,
                margin: getComputedStyle(icon).margin, position: getComputedStyle(icon).position,
                decorative: icon.getAttribute("aria-hidden") === "true" && icon.getAttribute("focusable") === "false",
            }));
            const initial = box(element), iconStyles = icons.map(icon => icon.getAttribute("style"));
            for (const icon of icons) icon.style.display = "none";
            const withoutGlyph = box(element);
            icons.forEach((icon, index) => {
                if (iconStyles[index] === null) icon.removeAttribute("style");
                else icon.setAttribute("style", iconStyles[index]);
            });
            // Keep width and wrapping fixed while isolating the SVG's vertical baseline contribution.
            for (const icon of icons) icon.style.height = "0px";
            const withoutGlyphHeight = box(element);
            icons.forEach((icon, index) => {
                if (iconStyles[index] === null) icon.removeAttribute("style");
                else icon.setAttribute("style", iconStyles[index]);
            });
            return { ...initial, withoutGlyph, withoutGlyphHeight, glyphs, padding: css.padding, gap: css.gap,
                lineHeight: parseFloat(css.lineHeight), textLines: bands.length,
                marginTop: parseFloat(css.marginTop), marginBottom: parseFloat(css.marginBottom),
                icons: [...element.querySelectorAll(".wire-icon")].map(box),
                controls: [...element.querySelectorAll("button,a,input,[role=button]")].filter(value => value.checkVisibility()).map(box) };
        });
        return { rows, gaps: rows.slice(1).map((row, index) => row && rows[index] ? row.top - rows[index].bottom : null) };
    });
    assert.ok(measured.rows.every(Boolean), "Tools, services and recorded outcomes each have their own nonempty row");
    for (const row of measured.rows) {
        assert.equal(row.height, row.withoutGlyphHeight.height,
            "A decorative glyph cannot determine metadata row height when its width/wrapping lane stays fixed: " + JSON.stringify(row));
        assert.ok(row.glyphs.every(glyph => glyph.decorative));
    }
    assert.ok(measured.gaps.every((gap, index) => Math.abs(gap - [4, 8][index]) <= 1),
        `Tools/services stay compact; outcomes have an intentional 8px separation, without glyph slack: ${JSON.stringify(measured)}`);
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
    await revealAnalyzeRecords(page);
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
    await revealAnalyzeRecords(page);
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
        await revealAnalyzeRecords(page);
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
        spacing.detailControls = await auditTargets(page, "#contextSidebar[open] .full-text-reader-actions>button,#contextSidebar[open] #closeContextSidebar,#contextSidebar[open] #contextSidebarFooter button");
        if (width === 375 && scale === 2) spacing.detailAction = await adjacentReportAction(page, `${theme}-detail-adjacent-action`);
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
        spacing.pickerControls = await auditTargets(page, "#reportList .report-selection-toggle,#reportList .request-link");
        await report.locator(".request-link").click();
        await expect(page.locator("#contextSidebar[open]")).toBeVisible();
        for (let index = 0; index < await heading.count(); index++) spacing.peek.push(await rowSpacing(heading.nth(index)));
        await capture(page, `${theme}-${width}-${scale}-peek`);
        spacing.peekControls = await auditTargets(page, "#contextSidebar[open] .full-text-reader-actions>button,#contextSidebar[open] #closeContextSidebar,#contextSidebar[open] #contextSidebarFooter button");
        if (width === 375 && scale === 2) spacing.peekAction = await adjacentReportAction(page, `${theme}-peek-adjacent-action`);
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
    await expect(card(page, "empty")).not.toContainText("Tool completed");
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
