import test from "node:test";
import assert from "node:assert/strict";
import { reportContents, chooseReportScope } from "./report-journey-helpers.mjs";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { createControlHelp } from "../lib/control-help.mjs";
import { serviceCategories } from "../lib/service-categories.mjs";
import { fixture, exportCatalogFor, navigateMain, navigateSettings, chooseTheme, openActivitySessions, automaticScoreOffSummary } from "./helpers.mjs";

const help = createControlHelp(serviceCategories);
const proofDir = process.env.WORKIQ_HELP_PROOFS;
const records = ["/me/events", "/me/messages", "/me/drive"].map((endpoint, index) => {
    const record = fixture(`synthetic-help-${index}`);
    record.sourceSessionName = "Synthetic contextual help examples";
    record.workflowState = index ? "captured" : "ready_to_export";
    record.projectId = index === 2 ? null : "synthetic-help-project";
    record.project = index === 2 ? null : "Synthetic help project";
    record.promptAssociation = "Nearest preceding recorded message; association is inferred.";
    record.coverageNote = "Synthetic source limits only.";
    record.toolCalls[0].requestedApiPath = endpoint;
    record.toolCalls[0].requestArgs = { entityUrls: [endpoint] };
    record.toolCalls[0].startedAt = "2026-09-30T12:00:00Z";
    return record;
});

async function setup(run, options = {}) {
    const errors = [], requests = [], rejected = [];
    const server = createServer(async (req, res) => {
        if (req.method === "GET" && req.url === "/") {
            res.setHeader("Content-Type", "text/html");
            res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'nonce-help-proof'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'");
            return res.end(renderHtmlShell("a".repeat(64), "help-proof"));
        }
        if (req.method === "GET" && req.url === "/favicon.ico") return res.writeHead(204).end();
        if (req.method === "POST" && req.url === "/api/evaluation/automatic/summary") {
            let body = ""; for await (const part of req) body += part;
            const input = JSON.parse(body);
            if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) {
                rejected.push("Nonempty automatic-summary input");
                return res.writeHead(400).end('{"error":"Automatic summary only accepts an empty object."}');
            }
            res.setHeader("Content-Type", "application/json");
            return res.end(JSON.stringify(automaticScoreOffSummary()));
        }
        if (req.method === "POST" && ["/api/collection/status", "/api/record/status"].includes(req.url)) {
            res.setHeader("Content-Type", "application/json");
            return res.end(JSON.stringify(req.url === "/api/record/status" ? { attempt: null }
                : { state: "needs-setup", config: { approved: false, enabled: false }, historyIssues: [] }));
        }
        if (req.method !== "POST" || req.url !== "/api/snapshot") {
            rejected.push(`${req.method} ${req.url}`);
            return res.writeHead(403).end('{"error":"Help proof permits synthetic snapshot and status reads only."}');
        }
        let text = ""; for await (const part of req) text += part;
        const input = JSON.parse(text);
        requests.push(input);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
            revision: 1, scenarios: records, exports: [], exportCatalog: exportCatalogFor(records),
            coverage: { since: "2026-09-01", until: "2026-09-30", notes: ["Synthetic help proof; no private collection is accessed."] },
            analytics: { ...buildActivityAnalytics(records, input), revision: 1 },
        }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const browser = await chromium.launch();
    try {
        const context = await browser.newContext({ viewport: { width: 1200, height: 1000 }, timezoneId: "America/Los_Angeles", reducedMotion: "reduce", ...options });
        context.setDefaultTimeout(5000);
        await context.addInitScript(() => {
            window.helpControlChanges = [];
            document.addEventListener("change", event => window.helpControlChanges.push({ id: event.target.id, value: event.target.value }));
            Object.defineProperty(navigator, "clipboard", { value: {
                readText() { throw new Error("Help proof must not read the clipboard."); },
                writeText() { throw new Error("Help proof must not write the clipboard."); },
            } });
        });
        context.on("page", page => {
            page.on("pageerror", error => errors.push(error.message));
            page.on("request", request => { if (new URL(request.url()).origin !== origin) rejected.push(request.url()); });
        });
        if (proofDir) await mkdir(proofDir, { recursive: true });
        await run({ context, origin, requests });
        assert.deepEqual(errors, []);
        assert.deepEqual(rejected, [], "No import, recording, privacy review, export, download or external traffic");
    } finally {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}
async function ready(page) {
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    await openActivitySessions(page);
}
const triggerFor = (page, id) => page.locator(`[data-select-id="${id}"]`);
async function openMoreFilters(page) {
    const more = page.locator("#moreFilters");
    if (!await more.evaluate(node => node.open)) await more.locator(":scope > summary").click();
}
async function readTooltip(page, control, expected) {
    await control.focus();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    if (expected) assert.equal(await page.getByRole("tooltip").innerText(), expected);
    await page.keyboard.press("Escape");
}

test("filter menus contain exact choices, not explanatory paragraphs or hover popups", { timeout: 40000 }, async () => setup(async ({ context, origin, requests }) => {
    const page = await context.newPage();
    await page.goto(origin); await ready(page);
    const before = page.url(), reads = requests.length;
    for (const id of ["dateFilter", "serviceFilter", "outcomeFilter", "projectFilter", "layerFilter", "scopeFilter"]) {
        if (["serviceFilter", "projectFilter", "layerFilter", "scopeFilter"].includes(id)) await openMoreFilters(page);
        const trigger = triggerFor(page, id), selected = await page.locator("#" + id).inputValue();
        await trigger.click();
        const options = await page.locator("#" + id + " option").evaluateAll(nodes => nodes.map(node => ({ value: node.value, label: node.label })));
        for (const option of options) {
            const row = page.getByRole("option", { name: option.label, exact: true });
            await row.hover();
            assert.equal(await row.innerText(), option.label);
            assert.equal(await row.getAttribute("aria-describedby"), null);
            assert.equal(await row.locator(".select-option-description, .select-option-detail, [title], button, input, a").count(), 0);
            assert.equal(await page.getByRole("tooltip").isVisible(), false);
            assert.equal(await trigger.getAttribute("aria-describedby"), await page.locator("#" + id).getAttribute("aria-describedby"));
            assert.equal(await page.locator("#" + id).inputValue(), selected);
        }
        await page.keyboard.press("Escape");
        assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    }
    assert.equal(page.url(), before);
    assert.equal(requests.length, reads);
    assert.deepEqual(await page.evaluate(() => window.helpControlChanges), []);
}));

test("Activity field help explains the selected evidence unit, and exploration commits only on Enter", { timeout: 25000 }, async () => setup(async ({ context, origin, requests }) => {
    const page = await context.newPage();
    await page.goto(origin + "/#activity"); await ready(page);
    await openMoreFilters(page);
    await page.getByRole("button", { name: "About Activity", exact: true }).click();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    assert.equal(await page.getByRole("tooltip").innerText(), `${help.layers.tool} ${help.fields.layerFilter}`);
    await page.keyboard.press("Escape");
    await page.mouse.move(0, 0);
    const trigger = triggerFor(page, "layerFilter"), reads = requests.length;
    await trigger.focus(); await page.keyboard.press("ArrowDown"); await page.keyboard.press("End");
    const code = page.getByRole("option", { name: "Graph code references", exact: true });
    assert.equal(await code.innerText(), "Graph code references");
    assert.equal(await trigger.getAttribute("aria-activedescendant"), await code.getAttribute("id"));
    assert.equal(await trigger.getAttribute("aria-describedby"), null);
    assert.equal(await page.locator("#layerFilter").inputValue(), "tool");
    await page.keyboard.press("Escape");
    assert.equal(requests.length, reads);
    await trigger.press("Space"); await trigger.press("ArrowDown"); await trigger.press("Enter"); await ready(page);
    assert.equal(await page.locator("#layerFilter").inputValue(), "direct-request");
    assert.equal(await trigger.locator(".select-value").innerText(), "Graph API call sites");
    assert.deepEqual(await page.evaluate(() => window.helpControlChanges), [{ id: "layerFilter", value: "direct-request" }]);
    await trigger.click();
    assert.equal(await page.getByRole("option", { name: "Graph statuses", exact: true }).innerText(), "Graph statuses");
    await page.locator("#pageTitle").click();
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    await readTooltip(page, page.getByRole("button", { name: "About Activity", exact: true }), `${help.layers["direct-request"]} ${help.fields.layerFilter}`);
}));

test("touch sees a full choice label and selects it with one tap", { timeout: 20000 }, async () => setup(async ({ context, origin, requests }) => {
    const page = await context.newPage();
    await page.goto(origin + "/#activity"); await ready(page);
    await openMoreFilters(page);
    const before = page.url(), reads = requests.length, trigger = triggerFor(page, "layerFilter");
    await trigger.tap();
    const row = page.getByRole("option", { name: "Graph statuses", exact: true });
    await row.scrollIntoViewIfNeeded();
    assert.equal(await row.innerText(), "Graph statuses");
    assert.equal(await row.locator(".select-option-description, .select-option-detail").count(), 0);
    assert.equal(page.url(), before);
    assert.equal(requests.length, reads);
    assert.deepEqual(await page.evaluate(() => window.helpControlChanges), []);
    await row.tap(); await ready(page);
    assert.equal(await page.locator("#layerFilter").inputValue(), "recorded-http");
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    assert.equal(await trigger.locator(".select-value").innerText(), "Graph statuses");
    assert.deepEqual(await page.evaluate(() => window.helpControlChanges), [{ id: "layerFilter", value: "recorded-http" }]);
}, { viewport: { width: 375, height: 900 }, isMobile: true, hasTouch: true }));

test("full option identities wrap rather than clip in both themes, narrow widths and enlarged text", { timeout: 40000 }, async () => setup(async ({ context, origin }) => {
    const page = await context.newPage(), proof = [];
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.goto(origin + "/#activity"); await ready(page);
        await openMoreFilters(page);
        await chooseTheme(page, theme);
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await triggerFor(page, "layerFilter").click();
        for (const [index, layer] of Object.keys(help.layers).entries()) {
            const row = page.locator(`.select-option[data-value="${layer}"]`);
            await row.hover();
            const measure = await row.evaluate(node => {
                const rect = value => { const b = value.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
                const label = node.querySelector(".select-option-label"), popup = node.closest(".select-popup");
                const css = getComputedStyle(label);
                return { row: rect(node), label: rect(label), popup: rect(popup), viewport: innerWidth,
                    overflow: document.documentElement.scrollWidth - innerWidth, textOverflow: label.scrollWidth - label.clientWidth,
                    clippedText: label.scrollHeight - label.clientHeight, whiteSpace: css.whiteSpace,
                    nestedActions: node.querySelectorAll("button,a,input").length };
            });
            assert.ok(measure.overflow <= 1, `${theme}/${width}: no page overflow`);
            assert.ok(measure.popup.left >= 7 && measure.popup.right <= width - 7);
            assert.ok(measure.label.left >= measure.popup.left && measure.label.right <= measure.popup.right);
            assert.ok(measure.label.bottom <= measure.row.bottom + 1);
            assert.ok(measure.clippedText <= 1 && measure.textOverflow <= 1, `${theme}/${width}/${scale}/${layer}: full identity wraps without truncation`);
            assert.notEqual(measure.whiteSpace, "nowrap");
            assert.equal(measure.nestedActions, 0);
            proof.push({ theme, width, scale, layer, ...measure });
            if (proofDir && [0, 5].includes(index)) await page.screenshot({ path: path.join(proofDir, `choices-${theme}-${width}-${scale}-${index === 0 ? "top" : "bottom"}.png`) });
        }
        await page.keyboard.press("Escape");
    }
    if (proofDir) await writeFile(path.join(proofDir, "help-measurements.json"), JSON.stringify(proof, null, 2));
}));

test("Settings choices stay concise with field-level limitations and explicit timezone identity", { timeout: 25000 }, async () => setup(async ({ context, origin }) => {
    const page = await context.newPage();
    await page.goto(origin + "/#settings?section=collection"); await ready(page);
    for (const [id, helpId, expected] of [
        ["collectionWindow", null, ["7 days", "30 days", "90 days"]],
        ["collectionCadence", null, ["Every 5 seconds", "Every 15 seconds", "Every 30 seconds", "Every 60 seconds"]],
    ]) {
        const trigger = triggerFor(page, id);
        assert.equal(await trigger.getAttribute("aria-describedby"), helpId);
        if (helpId) assert.equal(await page.locator("#" + helpId).isVisible(), true);
        await trigger.click();
        assert.deepEqual(await page.getByRole("option").allInnerTexts(), expected);
        await page.keyboard.press("End"); await page.keyboard.press("Enter");
        assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
        assert.equal(await page.getByRole("tooltip").isVisible(), false);
    }
    assert.equal(await page.locator("#historyWindowHelp").count(), 0);
    assert.equal(await page.locator("#eventCadenceHelp").count(), 0);
    assert.equal(await page.locator("#collectionPreferenceDetails").count(), 0);
    await navigateSettings(page, "display");
    await triggerFor(page, "displayTimeZone").click();
    const automatic = page.getByRole("option", { name: "Device default (America/Los_Angeles)", exact: true });
    assert.equal(await automatic.locator(".select-option-detail").count(), 0);
    const names = await page.locator("#displayTimeZone option").evaluateAll(nodes => nodes.map(node => node.label));
    assert.deepEqual(await page.locator(".select-option-label").allTextContents(), names);
    await page.keyboard.press("Escape");
}));

test("report scopes, privacy and source meanings are available before actions without duplicate copy help", { timeout: 25000 }, async () => setup(async ({ context, origin, requests }) => {
    const page = await context.newPage();
    await page.goto(origin); await ready(page);
    await openMoreFilters(page);
    for (const name of ["Activity"]) {
        const control = page.getByRole("button", { name: "About " + name, exact: true });
        await readTooltip(page, control);
    }
    assert.equal(await page.locator("#meaning").evaluate(node => node.open), false);
    assert.equal(await page.locator("#countTable").isVisible(), false);
    await page.locator("#meaning > summary").click();
    assert.equal(await page.locator("#countTable").isVisible(), true);
    assert.match(await page.locator("#chartReadingNotes").innerText(), /Weeks start Monday/i);
    for (const [chart, text] of [["time", help.charts.time], ["workload", help.charts.activityCategory], ["endpoint", help.charts.endpoint]]) {
        await readTooltip(page, page.locator(`[data-chart=${chart}]`), text);
    }
    await page.locator("#coverage > summary").click();
    await readTooltip(page, page.getByRole("button", { name: "About Collection", exact: true }), `${help.fields.scopeFilter} ${help.options.scopeFilter.history}`);
    await readTooltip(page, page.locator("#checkActivity"), help.actions.checkActivity);
    assert.equal(await page.locator("#coverage").getByRole("link", { name: "Collection status", exact: true }).isVisible(), true);
    await navigateMain(page, "collection-status");
    await page.locator("#recorderDiagnostics>summary").click();
    await page.waitForFunction(() => !document.querySelector("#recordBtn").disabled);
    await readTooltip(page, page.locator("#recordBtn"), help.actions.recordBtn);
    await navigateMain(page, "reports");
    const before = requests.length;
    await reportContents(page);
    for (const [value, description] of Object.entries(help.reportScopes)) {
        await chooseReportScope(page, value);
        assert.equal(await page.locator("#reportScopeChoiceHelp").innerText(), description, `${value}: the selected scope is explained before preview`);
    }
    await chooseReportScope(page, "selected");
    assert.equal(await page.locator("[name=reportScope]:checked").inputValue(), "selected");
    assert.equal(await page.locator("[name=promptMode]:checked").inputValue(), "masked");
    assert.equal(await page.locator("[name=promptMode]").count(), 3);
    assert.equal(await page.locator("#formatOptions input[type=checkbox]").count(), 4);
    await chooseReportScope(page, "all");
    await reportContents(page);
    await page.locator("[name=promptMode][value=original]").check();
    assert.match(await page.locator("#reportsView").innerText(), /Detected credentials are still removed/);
    assert.match(await page.locator("#reportsView").innerText(), /saving locally is not permission to share/);
    await page.locator("[name=promptMode][value=masked]").check();
    await readTooltip(page, page.locator("#exportBtn"), help.actions.exportBtn);
    await page.getByRole("button", { name: "1. Activity", exact: true }).click();
    await page.locator(".report-scope-details > summary").click();
    await readTooltip(page, page.getByRole("button", { name: "About Ready for report", exact: true }), help.reviewStates.ready_to_export);
    assert.equal(requests.length, before);
    await navigateMain(page, "activity");
    await openActivitySessions(page);
    assert.equal(await page.getByRole("button", { name: "Search this Analyze scope", exact: true }).isVisible(), true);
    await page.locator("#activityList .request-link").first().click();
    await ready(page);
    const reader = page.locator(".request-original .full-text-toggle");
    if (await reader.getAttribute("aria-expanded") === "false") await reader.click();
    assert.match(await page.locator("#reader-copy-notice").innerText(), /unmasked.*Other apps.*clipboard/);
    assert.match(await page.locator(".request-link-details").innerText(), /recorded message ID.*not inferred task boundaries/);
    const copy = page.locator("#selectedContext").getByRole("button", { name: "Copy prompt", exact: true });
    await copy.focus(); await page.getByRole("tooltip").waitFor({ state: "visible" });
    assert.equal(await copy.locator("svg").count(), 1);
    assert.deepEqual(await page.locator("button button, a button, label button")
        .evaluateAll(nodes => nodes.filter(node => node.checkVisibility()).map(node => node.outerHTML)), [],
    "No exposed control on any page nests another interactive control");
    assert.deepEqual(await page.locator("#requestContent").locator("button button, a button, label button")
        .evaluateAll(nodes => nodes.map(node => node.outerHTML)), []);
    assert.equal(await page.getByRole("button", { name: "About Copy prompt", exact: true }).count(), 0);
    await page.keyboard.press("Escape");
    await page.locator("#requestContent summary").filter({ hasText: /^Technical source record$/ }).first().click();
    await readTooltip(page, page.getByRole("button", { name: "About Provenance", exact: true }), help.facts.Provenance);
    const journey = page.locator(".journey-item[data-context-kind=action]").first();
    await journey.locator("summary").filter({ hasText: /^Technical details$/ }).click();
    for (const label of ["Execution success", "HTTP observed", "Duration", "Tool call ID", "Result attribution"]) {
        await readTooltip(page, journey.getByRole("button", { name: "About " + label, exact: true }), help.facts[label]);
    }
}));
