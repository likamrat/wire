import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { loadBoardState, replaceEvidence } from "../lib/store.mjs";
import { fixture, chooseTheme, closeAnalyzeFilters, navigateMain, openAnalyzeFilters, selectActivityOption } from "./helpers.mjs";
import { scopeRecords, privateQuery } from "./analysis-scope-fixture.mjs";
import { modelNames, modelRecords } from "./model-widget-fixture.mjs";
import { searchFixture } from "./live-search-fixture.mjs";
import { contrast, measureControlSurface } from "./color-measurements.mjs";

const proofs = process.env.WIRE_BREAKDOWN_PROOFS;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const card = (page, kind) => page.locator(`[data-percentage-card="${kind}"]`);
const label = (page, kind, category) => card(page, kind).locator(`[data-category="${category}"] .percentage-label`);
const exact = page => page.locator("#chartReferenceData");
const sorted = items => [...items].sort();
const secret = /INVENTED_PARITY_NEEDLE|parity-request-|parity-call-|test-call-overlap|deployment(?:%2F|\/)Exact/iu;

function records() {
    const extra = fixture("breakdown-coverage");
    extra.userPrompt = { text: `${privateQuery} invented coverage`, status: "full", authorship: { actor: "user", basis: "source-user" } };
    extra.followUpPrompts = [];
    extra.toolCalls = [
        ["workiq-fetch", ["/me/drive/root", "/unrecognized-resource"]],
        ["workiq-call_function", ["https://untrusted.example.invalid/me/drive/root"]],
        ["workiq-get_schema", ["/me/drive/root"]],
        ["workiq-retrieve", []],
    ].map(([tool, paths], i) => ({
        tool, toolCallId: `coverage-${i}`, startEventId: `coverage-start-${i}`,
        requestArgs: paths.length ? { entityUrls: paths } : {}, startedAt: "2026-09-30T12:00:00.000Z",
        reportedOutcome: "partial", apiResults: [],
    }));
    return [...scopeRecords(), extra];
}

async function setup(t, source = records(), { search = false, preview = false } = {}) {
    const cleanup = [], original = structuredClone(source), errors = [], denied = [], reads = [], urls = [], leakedTo = [];
    const { runtime, context } = await searchFixture({ after: fn => cleanup.push(fn) }, { records: source, reply: search });
    const before = await loadBoardState(context);
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "UTC", locale: "en-US", reducedMotion: "reduce" });
    page.setDefaultTimeout(5000);
    const allowed = new Set(["/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
        "/api/evaluation/automatic/summary", ...(preview ? ["/api/report-artifacts/list", "/api/preview", "/api/cancel-preview"] : []),
        ...(search ? ["/api/search/events", "/api/search/status", "/api/search/query", "/api/search/membership", "/api/search/cancel", "/api/search/close"] : [])]);
    await page.context().route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        urls.push(url.href);
        if (url.origin !== new URL(runtime.url).origin || !(request.method() === "GET" && !url.pathname.startsWith("/api/")
            || request.method() === "POST" && allowed.has(url.pathname))) {
            denied.push(`${request.method()} ${url.pathname}`); return route.abort();
        }
        if (request.method() === "POST") {
            // The on-device matcher alone receives the private search words.
            if (url.pathname !== "/api/search/query" && request.postData()?.includes(privateQuery)) leakedTo.push(url.pathname);
            if (url.pathname === "/api/snapshot") reads.push(request.postDataJSON());
        }
        return route.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) urls.push(frame.url()); });
    t.after(async () => {
        try {
            const storage = await page.evaluate(() => JSON.stringify([history.state, { ...localStorage }, { ...sessionStorage }]));
            assert.doesNotMatch(storage, new RegExp(privateQuery));
            assert.doesNotMatch(JSON.stringify(urls), secret);
            const after = await loadBoardState(context);
            assert.deepEqual(after.exports, before.exports);
            assert.deepEqual(after.personalEvaluation, before.personalEvaluation);
            assert.deepEqual(source, original); assert.deepEqual(errors, []); assert.deepEqual(denied, []); assert.deepEqual(leakedTo, []);
        } finally { await browser.close(); for (const fn of cleanup) await fn(); }
    });
    await page.goto(runtime.url); await ready(page);
    return { page, reads, context, revision: before.revision };
}

async function choose(page, id, value) {
    await selectActivityOption(page, id, value); await ready(page); await closeAnalyzeFilters(page);
}
async function openExact(page, topic) {
    await page.locator("#openChartReference").click();
    const topics = page.locator("#chartReferenceTopics");
    if (!await topics.isVisible()) await page.locator("#chartReferenceTopicToggle").click();
    await topics.locator(`[data-reference-topic="${topic}"]`).click();
    await page.locator("#chartReferenceShowData").click();
    await expect(exact(page).locator("table")).toBeVisible();
    return exact(page);
}
async function tableRows(table) {
    return table.locator("tbody tr").evaluateAll(rows => Object.fromEntries(rows.map(row =>
        [row.cells[0].textContent, [...row.cells].slice(1).map(cell => cell.textContent)])));
}
async function parents(page, ids) {
    await expect.poll(() => page.locator("#activityList article").evaluateAll(nodes => nodes.map(n => n.dataset.viewKey).sort()))
        .toEqual(sorted(ids.map(id => `request:${id}`)));
}
async function backTo(page, control, address) {
    await page.goBack(); await ready(page);
    await expect(page).toHaveURL(address); await expect(control).toBeFocused();
}
async function capture(page, name, host) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await host.screenshot({ path: path.join(proofs, name + ".png"), animations: "disabled" });
    await writeFile(path.join(proofs, name + ".txt"), await host.ariaSnapshot());
}

test("Tools and Services independently reconcile with Guide exact counts, overlapping targets and operation-only evidence", async t => {
    const { page } = await setup(t);
    await expect(page.locator("#activityCount")).toHaveText("16");
    const tools = card(page, "tools"), services = card(page, "services");
    await expect(tools).toBeVisible(); await expect(services).toBeVisible();
    await expect(label(page, "tools", "tool:workiq-fetch")).toHaveAccessibleName(/12 of 16 Work IQ tool calls \(75%\)/);
    await expect(label(page, "services", "Files")).toHaveAccessibleName(/11 of 16 Work IQ tool calls \(68.8%\)/);
    await expect(services).toContainText("2 with missing service details");
    const origin = page.url();
    for (const [name, id] of [["Recorded path not recognized", "coverage-0"], ["Recorded target format unsupported", "coverage-1"],
        ["Discovery / preparation", "coverage-2"], ["Search requested", "coverage-3"], ["Asked Copilot", "parity-call-0-1"]]) {
        const action = services.getByRole("link", { name: `${name}: 1 of 16 Work IQ tool calls (6.3%). View matching records.`, exact: true });
        await action.press("Enter");
        await expect(page.locator("#activityList .widget-record")).toHaveCount(1);
        const session = id.startsWith("coverage") ? "test-session" : "parity-chat-0";
        await expect(page.locator("#activityList .widget-record")).toHaveAttribute("data-action-id", `call:${JSON.stringify([session, id])}`);
        await backTo(page, action, origin);
    }
    const expected = {
        tools: { "workiq-fetch": ["12", "75%"], ...Object.fromEntries(["workiq-ask", "workiq-call_function", "workiq-get_schema", "workiq-retrieve"].map(k => [k, ["1", "6.3%"]])) },
        services: { Files: ["11", "68.8%"], Calendar: ["1", "6.3%"], Mail: ["1", "6.3%"], "Search and retrieval": ["1", "6.3%"] },
    };
    for (const topic of ["tools", "services"]) {
        const table = await openExact(page, topic);
        await expect(table.locator("caption")).toContainText("16 Work IQ tool calls");
        assert.deepEqual(await tableRows(table), expected[topic]);
        assert.deepEqual(await table.locator("tfoot td").allTextContents(), ["16", "100%"]);
        if (topic === "services") await expect(table.locator("caption")).toContainText("Services can overlap");
        const action = table.getByRole("link", { name: topic === "tools" ? /^workiq-ask:/ : /^Mail:/ });
        const address = page.url();
        await action.press("Enter"); await ready(page);
        await parents(page, ["parity-request-0"]);
        await expect(page.locator("#activityListSummary")).toHaveText("1 interaction · 1 matching tool call");
        await backTo(page, action, address);
        await capture(page, `exact-${topic}`, table);
        await page.locator("#analyzeResultsSection").click();
    }
});

test("private Search, dates, authors and outcome union survive independent tool, service and outcome drilldowns and Back", async t => {
    const source = scopeRecords();
    source[9].userPrompt.authorship = { actor: "user", basis: "source-user" };
    const { page, reads } = await setup(t, source, { search: true });
    await selectActivityOption(page, "dateFilter", "custom");
    await page.locator("#fromFilter").fill("2026-09-30"); await page.locator("#toFilter").fill("2026-09-30");
    await page.locator("#applyDates").click(); await ready(page); await closeAnalyzeFilters(page);
    await choose(page, "outcomeFilter", ["failure", "success"]);
    await choose(page, "promptAuthorFilter", "user"); await choose(page, "serviceAssociationFilter", "Files");
    await expect(page.locator('[data-view-key="request:parity-request-9"]')).toBeVisible();
    const field = page.locator("#wireSearch");
    await field.fill(privateQuery); await selectActivityOption(page, "wireSearchScope", "analysis"); await field.focus();
    await expect(page.locator("#openAnalyzeFilters")).toHaveAccessibleDescription(/Search applied/i);
    await field.press("Escape");
    const ids = (...indexes) => indexes.map(i => `parity-request-${i}`);
    await parents(page, ids(0, 2, 4, 6));
    await expect(page.locator("#activityCount")).toHaveText("5");
    const origin = page.url();
    for (const [topic, key, count, indexes] of [["tools", "tool:workiq-ask", 1, [0]], ["services", "Files", 4, [0, 2, 4, 6]],
        ["outcomes", "failure", 3, [0, 6]]]) {
        const action = label(page, topic, key);
        await action.press("Enter"); await ready(page);
        await parents(page, ids(...indexes)); await expect(page.locator("#activityCount")).toHaveText(String(count));
        await expect(field).toHaveValue(privateQuery);
        const filters = reads.at(-1).filters;
        assert.deepEqual(filters.promptAuthors, ["user"]); assert.deepEqual(filters.services, ["Files"]);
        assert.equal(filters.from, "2026-09-30"); assert.equal(filters.to, "2026-09-30");
        if (topic === "services") assert.equal(new URL(page.url()).searchParams.has("withinServices"), false);
        assert.deepEqual(sorted(filters.outcomes), topic === "outcomes" ? ["failure"] : ["failure", "success"]);
        await page.goBack(); await ready(page); await expect(page).toHaveURL(origin);
        await parents(page, ids(0, 2, 4, 6)); await expect(page.locator("#activityCount")).toHaveText("5");
    }
    await openAnalyzeFilters(page);
    await page.getByRole("button", { name: "Remove missing-service context" }).click(); await ready(page);
    await closeAnalyzeFilters(page);
    await expect(page.locator("#activityCount")).toHaveText("4"); await parents(page, ids(0, 2, 4, 6));
    await openAnalyzeFilters(page);
    await page.locator("#addServiceContext").click(); await ready(page);
    await expect(page.locator("#activityCount")).toHaveText("5");
});

test("Back restores the activating breakdown link after private Search membership is read again", async t => {
    const { page } = await setup(t, scopeRecords(), { search: true });
    const field = page.locator("#wireSearch");
    await field.fill(`${privateQuery} request 0`); await selectActivityOption(page, "wireSearchScope", "analysis"); await field.focus();
    await expect(page.locator("#activityListSummary")).toHaveText("1 interaction · 3 matching tool calls");
    await field.press("Escape");
    const action = label(page, "tools", "tool:workiq-ask"), origin = page.url();
    await action.focus(); await expect(action).toBeFocused(); await page.keyboard.press("Enter");
    await expect(page.locator("#activityListSummary")).toHaveText("1 interaction · 1 matching tool call");
    await page.goBack(); await expect(page).toHaveURL(origin);
    await parents(page, ["parity-request-0"]);
    await expect(page.locator("#activityListSummary")).toHaveText("1 interaction · 3 matching tool calls");
    await expect(action).toBeFocused();
    await action.press("Enter");
    await expect(page.locator("#activityListSummary")).toHaveText("1 interaction · 1 matching tool call");
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    await page.route("**/api/search/query", async route => {
        entered.resolve(); await release.promise; await route.continue();
    }, { times: 1 });
    try {
        await page.goBack(); await entered.promise;
        await field.click();
        release.resolve();
        await expect(page.locator("#activityListSummary")).toHaveText("1 interaction · 3 matching tool calls");
        await expect(field).toBeFocused();
    } finally { release.resolve(); }
});

function overlapRecords() {
    const source = ["overlap", "mail-only", "files-only"].map(id => fixture(id));
    for (const [i, paths] of [["/me/drive/root", "/me/messages"], ["/me/messages"], ["/me/drive/root"]].entries()) {
        const call = source[i].toolCalls[0];
        call.startedAt = source[i].capturedAt; call.requestArgs = { entityUrls: paths }; delete call.requestedApiPath;
    }
    source[0].toolCalls.push({ ...source[0].toolCalls[0], toolCallId: "overlap-context", startEventId: "overlap-context",
        tool: "workiq-call_function", requestArgs: { functionUrl: "/teams" } });
    return source;
}
async function verifyCurrentPreview(page, ids, calls) {
    await navigateMain(page, "reports"); await page.locator("#reportDeskActivity").click();
    const picker = page.getByRole("dialog", { name: "Choose activity" });
    await picker.getByRole("radio", { name: /^Current Analyze view/ }).check();
    await picker.getByRole("button", { name: "Use activity" }).click();
    const preparing = page.waitForResponse(r => r.url().endsWith("/api/preview"));
    await page.getByRole("button", { name: "Prepare preview" }).click();
    const response = await preparing, value = await response.json();
    assert.equal(response.status(), 200, value.error);
    assert.deepEqual(sorted(response.request().postDataJSON().selection.scenarioIds), sorted(ids));
    assert.deepEqual(value.snapshot.records.map(r => r.toolCalls.map(c => c.tool)).sort((a, b) => a.length - b.length), calls);
}
test("Files then Mail intersects call membership; Current Analyze report takes the complete parent, not Mail-only or Files-only", async t => {
    const source = overlapRecords(), { page, context, reads } = await setup(t, source, { preview: true });
    await choose(page, "serviceAssociationFilter", "Files");
    await parents(page, ["overlap", "files-only"]);
    const mail = label(page, "services", "Mail"), origin = page.url();
    await mail.press("Enter"); await ready(page); await parents(page, ["overlap"]);
    await expect(page.locator("#activityCount")).toHaveText("1");
    for (const service of ["Files", "Mail"]) await expect(label(page, "services", service)).toHaveAccessibleName(/1 of 1 Work IQ tool call \(100%\)/);
    const call = page.getByRole("link", { name: "workiq-fetch: open call", exact: true });
    const refined = page.url();
    await call.press("Enter"); await expect(page.locator('[data-tool-call-id="test-call-overlap"]')).toBeFocused();
    await expect(page.locator('[data-tool-call-id="overlap-context"]')).toContainText("Outside current view");
    await backTo(page, call, refined);
    await backTo(page, mail, origin); await parents(page, ["overlap", "files-only"]);
    await page.goForward(); await ready(page); await parents(page, ["overlap"]);
    await verifyCurrentPreview(page, ["overlap"], [["workiq-fetch", "workiq-call_function"]]);

    // Re-enter via a legacy link to the same intersection after changing only the invented source.
    const next = structuredClone(source);
    next[2].toolCalls[0].requestArgs = { entityUrls: ["/me/drive/root", "/me/messages"] };
    await replaceEvidence(context, () => ({ records: next, importCoverage: { counts: {}, roster: [] } }));
    const legacy = new URL("/?services=Files&withinServices=Mail", refined).href;
    await page.goto(legacy); await ready(page);
    await parents(page, ["overlap", "files-only"]); await expect(page.locator("#activityCount")).toHaveText("2");
    assert.equal(new URL(page.url()).searchParams.has("withinServices"), false);
    assert.deepEqual(reads.at(-1).filters.services, ["Files"]);
    assert.ok(reads.every(input => !Object.hasOwn(input.filters, "withinServices")));
    await verifyCurrentPreview(page, ["overlap", "files-only"], [["workiq-fetch"], ["workiq-fetch", "workiq-call_function"]]);
    await page.goto(legacy); await ready(page);
    await choose(page, "serviceAssociationFilter", "Mail");
    assert.equal(new URL(page.url()).searchParams.has("withinServices"), false);
    await parents(page, ["overlap", "files-only", "mail-only"]);
});

test("model shares count distinct matching interactions, including missing names, rather than tool calls or responses", async t => {
    const source = modelRecords();
    const schema = source.find(r => r.toolCalls[0].tool === "workiq-get_schema").toolCalls[0];
    delete schema.toolSucceeded; schema.reportedOutcome = "unknown";
    const { page } = await setup(t, source);
    const models = card(page, "models");
    await expect(models.locator(".percentage-denominator")).toHaveText("9 matching interactions");
    await expect(card(page, "tools").locator(".percentage-denominator")).toHaveText("11 Work IQ tool calls");
    const action = label(page, "models", modelNames[0]), origin = page.url();
    await expect(action).toHaveAccessibleName(/2 of 9 matching interactions \(22.2%\)/);
    await action.press("Enter");
    await expect(page.locator("#activityListSummary")).toContainText("2 matching interactions");
    const keys = await page.locator("#activityList .request-row").evaluateAll(rows => rows.map(row => row.dataset.viewKey));
    assert.deepEqual(sorted(keys.map(key => source.find(r => key === `request:${r.scenarioId}`)?.userPrompt.sourceEventId)),
        ["model-prompt-0", "model-prompt-1"], "An alias is not a third interaction");
    await backTo(page, action, origin);
    const table = await openExact(page, "models");
    await expect(table.locator("caption")).toHaveText("9 interactions; models can overlap.");
    assert.deepEqual(await tableRows(table), Object.fromEntries(modelNames.map((name, i) => [name, [i < 2 ? "2" : "1"]])));
    await table.getByText("Definitions and coverage", { exact: true }).click();
    await expect(table.locator(".percentage-note")).toContainText("1 partial / 2 not recorded / 2 not verified / 1 conflicting");
    await page.locator("#analyzeResultsSection").click();
    await choose(page, "toolFilter", "workiq-get_schema");
    await expect(models.locator(".percentage-denominator")).toHaveText("1 matching interaction");
    await expect(models.locator(".percentage-empty")).toHaveText("WIRE can’t tell which models these interactions used.");
    await expect(label(page, "outcomes", "unknown")).toHaveAccessibleName(/1 of 1 Work IQ tool call \(100%\). View matching records/);
    await expect(label(page, "outcomes", "failure")).toHaveAccessibleName(/0 of 1 Work IQ tool call \(0%\). Read definition/);
});

test("returned API entries use their own denominator and exact Mail entry; a zero code-reference cohort has no share", async t => {
    const { page } = await setup(t);
    await choose(page, "layerFilter", "reported-api");
    const services = card(page, "services");
    await expect(services.locator(".percentage-denominator")).toHaveText("13 tool-returned API results");
    const mail = label(page, "services", "Mail"), origin = page.url();
    await expect(mail).toHaveAccessibleName(/1 of 13 tool-returned API results \(7.7%\)/);
    await mail.press("Enter"); await ready(page);
    await parents(page, ["parity-request-0"]);
    await expect(services.locator(".percentage-denominator")).toHaveText("1 tool-returned API result");
    const all = page.getByRole("link", { name: "View all 1 tool-returned API result", exact: true });
    const refined = page.url();
    await all.click();
    const entry = page.locator("#activityList .widget-record");
    await expect(entry).toHaveCount(1); await expect(entry).toContainText("/me/messages");
    await backTo(page, all, refined);
    await backTo(page, mail, origin);
    await choose(page, "layerFilter", "code-reference");
    await expect(page.locator("#activityCount")).toHaveText("0");
    const data = await openExact(page, "outcomes");
    await expect(data.locator("caption")).toContainText("code references");
    assert.deepEqual(await data.locator("tfoot td").allTextContents(), ["0", "Not applicable"]);
    await expect(data.locator("a")).toHaveCount(0);
});

test("a positive outcome opens its matching evidence; zero opens a definition", async t => {
    const failed = fixture("breakdown-failed");
    Object.assign(failed.toolCalls[0], { toolSucceeded: false, reportedOutcome: "failed", apiResults: [] });
    const { page, revision } = await setup(t, [failed, fixture("breakdown-completed")]);
    await expect(page.locator("#periodResult")).toHaveAttribute("data-revision", String(revision));
    const outcomes = page.getByRole("region", { name: "Tool call results", exact: true });
    await expect(outcomes.getByRole("img")).toHaveAccessibleName(/2 Work IQ tool calls/);
    await expect(outcomes.locator(".outcome-share-strip>span")).toHaveCount(2);
    await expect(outcomes.locator(".outcome-distribution>.percentage-legend:not(.outcome-zeros)>li")).toHaveCount(2);
    await expect(outcomes.locator(".outcome-zeros .percentage-value")).toHaveText("0% (0)");
    const failure = outcomes.getByRole("link", { name: /Tool failed: 1 of 2 Work IQ tool calls \(50%\). View matching records/ });
    const origin = page.url();
    await failure.press("Enter");
    await parents(page, ["breakdown-failed"]);
    await backTo(page, failure, origin);
    const zero = outcomes.getByRole("link", { name: /No result recorded: 0 of 2 Work IQ tool calls \(0%\). Read definition/ });
    await zero.click(); await expect(page.locator("#meaning")).toHaveAttribute("data-reference-topic", "outcomes");
    await page.locator("#chartReferenceShowData").click();
    assert.deepEqual((await tableRows(exact(page)))["No result recorded"], ["0", "0%"]);
});

test("pending, failed and incompatible reads keep the accepted breakdown; retry adopts the narrowed population", async t => {
    const { page, revision } = await setup(t);
    const tools = card(page, "tools"), original = await tools.innerText(), held = Promise.withResolvers();
    await page.route("**/api/snapshot", async route => {
        await held.promise;
        await route.fulfill({ status: 503, json: { error: "Invented snapshot failure" } });
    }, { times: 1 });
    try {
        await selectActivityOption(page, "toolFilter", "workiq-ask");
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "true");
        await closeAnalyzeFilters(page);
        assert.equal(await tools.innerText(), original);
        await expect(page.locator("#periodResult")).toHaveAttribute("data-revision", String(revision));
    } finally { held.resolve(); }
    await ready(page);
    await expect(page.locator("#periodResult")).toContainText("Previous results");
    assert.equal(await tools.innerText(), original);
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), json = await response.json();
        json.analytics.serviceInvolvement.definition.version++;
        await route.fulfill({ response, json });
    }, { times: 1 });
    await choose(page, "toolFilter", "workiq-ask");
    await expect(page.locator("#periodResult")).toContainText("Previous results");
    assert.equal(await tools.innerText(), original);
    await page.route("**/api/snapshot", async route => {
        const response = await route.fetch(), json = await response.json();
        json.revision = json.analytics.revision = revision - 1;
        await route.fulfill({ response, json });
    }, { times: 1 });
    await choose(page, "toolFilter", "workiq-ask");
    await expect(page.locator("#message")).toContainText("older snapshot was rejected");
    await expect(page.locator("#periodResult")).toHaveAttribute("data-revision", String(revision));
    assert.equal(await tools.innerText(), original);
    await choose(page, "toolFilter", "workiq-ask");
    await expect(page.locator("#activityCount")).toHaveText("1");
    await expect(tools.locator(".percentage-label")).toHaveText("workiq-ask");
    await parents(page, ["parity-request-0"]);
    const data = await openExact(page, "tools");
    assert.deepEqual(await tableRows(data), { "workiq-ask": ["1", "100%"] });
});

test("independent breakdowns retain readable rows, linear marks and keyboard access on desktop and narrow enlarged text", async t => {
    const { page } = await setup(t);
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${100 * scale}%`; }, scale);
        await page.evaluate(() => document.fonts.ready);
        const widgets = ["tools", "services", "models"].map(kind => card(page, kind));
        const boxes = await Promise.all(widgets.map(widget => widget.boundingBox()));
        for (const [i, a] of boxes.entries()) for (const b of boxes.slice(i + 1)) {
            assert.ok(Math.min(a.x + a.width, b.x + b.width) <= Math.max(a.x, b.x) + 1
                || Math.min(a.y + a.height, b.y + b.height) <= Math.max(a.y, b.y) + 1, "No widgets cover each other");
        }
        for (const widget of widgets.slice(0, 2)) {
            const rows = widget.locator(".percentage-legend-row");
            assert.ok(await rows.count() > 0);
            const measures = await rows.evaluateAll(nodes => nodes.map(row => {
                const label = row.querySelector(".percentage-label"), track = row.querySelector(".percentage-bar-track");
                return { clipped: label.scrollWidth > label.clientWidth + 1, width: track.getBoundingClientRect().width,
                    fill: track.firstElementChild.getBoundingClientRect().width, count: Number(row.dataset.count) };
            }));
            for (const { clipped, width, fill, count } of measures) {
                assert.equal(clipped, false); assert.ok(width > 0 && Math.abs(fill - width * count / 16) < .1);
            }
            const action = rows.first().getByRole("link").first();
            await page.keyboard.press("Tab"); await action.focus(); await expect(action).toBeFocused();
            const surface = await action.evaluate(measureControlSurface);
            assert.ok(contrast(surface.ink, surface.face) >= 4.5);
            const focus = await rows.first().evaluate(measureControlSurface);
            assert.ok(focus.focus && focus.focusWidth >= 2, "Keyboard focus outlines the whole row");
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await capture(page, `${theme}-${width}-text${scale}`, card(page, "services"));
    }
});
