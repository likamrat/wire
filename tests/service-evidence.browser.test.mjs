import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController, buildSanitizedBundle } from "../lib/export.mjs";
import { serviceEvidenceFixture } from "./service-evidence-fixtures.mjs";
import { privateFixture, chooseTheme, selectActivityOption } from "./helpers.mjs";
import { createServiceCategories } from "../lib/service-categories.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";

test("requested-source help names recorded choices and only adds a real unsupported-source qualification", async t => {
    const browser = await chromium.launch(), page = await browser.newPage(), errors = [];
    t.after(async () => { await browser.close(); assert.deepEqual(errors, []); });
    page.on("pageerror", error => errors.push(error.message));
    await page.setContent("<main></main>");
    await page.addScriptTag({ content: `window.categories = (${createServiceCategories.toString()})();
        window.ux = (${createEvidenceUX.toString()})(${JSON.stringify(uxIcons)});` });
    for (const [capabilities, expected] of [
        [[{ name: "Email" }, { name: "TeamsMessages" }], "Requested sources: email and Teams messages."],
        [[{ name: "Email" }, { name: "InventedUnknown" }], "Requested sources: email. Some requested sources could not be identified."],
        [[{ name: "InventedUnknown" }], "Requested sources not identified. The recorded source choices are not recognized."],
    ]) {
        await page.evaluate(capabilities => {
            const scope = window.categories.requestedSearchScope({ tool: "workiq-retrieve", requestArgs: { capabilities }, toolSucceeded: false });
            document.querySelector("main").replaceChildren(window.ux.helpButton("Search and retrieval",
                [scope.label + ".", scope.description].filter(Boolean).join(" ")));
        }, capabilities);
        await page.getByRole("button", { name: "About Search and retrieval", exact: true }).click();
        await expect(page.getByRole("tooltip")).toHaveText(expected);
        await expect(page.getByRole("tooltip")).not.toContainText("returned results");
        await expect(page.getByRole("tooltip")).not.toContainText("InventedUnknown");
        await page.keyboard.press("Escape");
    }
});

const proofDir = process.env.WIRE_SERVICE_EVIDENCE_PROOFS;
async function shot(page, name) {
    if (!proofDir) return;
    await mkdir(proofDir, { recursive: true });
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(proofDir, name + ".png"), fullPage: true });
}
async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
    assert.deepEqual(await page.locator("#message:is(.error,.stale):visible").allTextContents(), []);
}
const dataService = item => item.locator("dt").filter({ hasText: /^Data service$/ }).evaluate(node => node.nextElementSibling.textContent);

test("normal entry explains invented search, preparation and service gaps without changing filtered calls", { timeout: 30000 }, async t => {
    const source = serviceEvidenceFixture();
    const records = [
        ["assistance", source.toolCalls[0]],
        ["retrieval", { ...source.toolCalls[0], tool: "workiq-retrieve", requestArgs: {
            query: "Invented search", capabilities: [{ name: "TeamsMessages" }, { name: "Email" }], strategy: "grounding",
        } }],
        ["profile", { ...source.toolCalls[1], requestArgs: { entityUrls: ["/me?$select=creationType"] } }],
        ["preparation", source.toolCalls[5]],
    ].map(([name, call]) => ({ ...structuredClone(source), scenarioId: `meaning-${name}`, toolCalls: [{
        ...call, toolCallId: `meaning-${name}`, startEventId: `meaning-start-${name}`,
    }] }));
    const { context } = await privateFixture(t, records);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(runtime.url + "#analyze"); await ready(page);
    assert.equal(await page.locator("#activityList .request-row").count(), 4);
    for (const [category, explanation] of [
        ["Search and retrieval", /tool name alone does not identify the services searched/],
        ["Discovery", /does not run the data operation/],
        ["Asked Copilot", /Its record does not identify a service or API path/],
    ]) {
        await page.getByRole("button", { name: `About ${category}; recorded activity categories`, exact: true }).click();
        assert.match(await page.getByRole("tooltip").innerText(), explanation);
        if (category === "Search and retrieval") {
            assert.match(await page.getByRole("tooltip").innerText(), /Requested sources: Teams messages and email/);
            assert.doesNotMatch(await page.getByRole("tooltip").innerText(), /does not show which sources returned results/);
        } else assert.doesNotMatch(await page.getByRole("tooltip").innerText(), /Requested sources/);
        await page.keyboard.press("Escape");
    }
    for (const [category, tool, name] of [["People", "workiq-fetch", "profile"], ["Search", "workiq-retrieve", "retrieval"],
        ["Unknown", "workiq-ask", "assistance"], ["Discovery", "workiq-get_schema", "preparation"]]) {
        const snapshot = page.waitForResponse(response => new URL(response.url()).pathname === "/api/snapshot" && response.ok());
        await selectActivityOption(page, "serviceFilter", category); await ready(page);
        const { analytics } = await (await snapshot).json();
        assert.equal(analytics.totals.count, 1);
        assert.deepEqual(analytics.rows.map(row => [row.toolCallId, row.tool, row.outcome]), [[`meaning-${name}`, tool, "success"]]);
        assert.equal(await page.locator("#activityList .request-row").count(), 1);
        assert.equal(await page.locator("#activityList .card-tool-name").innerText(), tool);
    }
    await page.goto(runtime.url + "#analyze?mode=calls&service=Search"); await ready(page);
    assert.equal(await page.locator("#activityList .matched-action").count(), 1);
    const retrieval = page.locator("#activityList .matched-action");
    await retrieval.getByRole("button", { name: "About Search and retrieval", exact: true }).click();
    assert.match(await page.getByRole("tooltip").innerText(), /Requested sources: Teams messages and email/);
    assert.doesNotMatch(await page.getByRole("tooltip").innerText(), /does not show which sources returned results/);
    assert.equal(await retrieval.locator("dt").filter({ hasText: /^Purpose:/ }).count(), 0, "Scope qualifies existing help, not a new card row");
    await page.keyboard.press("Escape");
    await retrieval.getByRole("link", { name: "Open exact call in context", exact: true }).click(); await ready(page);
    const readerCall = page.locator('[data-tool-call-id="meaning-retrieval"]');
    assert.equal(await readerCall.locator(".action-service-heading .service-cue").innerText(), "Search and retrieval");
    await readerCall.getByRole("button", { name: "About Search and retrieval", exact: true }).click();
    assert.match(await page.getByRole("tooltip").innerText(), /Requested sources: Teams messages and email/);
    assert.doesNotMatch(await page.getByRole("tooltip").innerText(), /does not show which sources returned results/);
    assert.equal(await readerCall.locator("dt").filter({ hasText: /^Purpose$/ }).count(), 0, "Reader scope stays in its existing category help");
    assert.deepEqual(errors, []);
});

test("targetless assistance is named on interaction and call cards without hiding real service gaps", { timeout: 30000 }, async t => {
    const source = serviceEvidenceFixture(), ask = source.toolCalls[0];
    const call = (name, requestArgs, tool = "workiq-ask") => ({
        ...ask, tool, toolCallId: `card-${name}`, startEventId: `card-start-${name}`, requestArgs,
    });
    const records = [
        ["assistance", [call("assistance", { question: "Invented help request", timeZone: "UTC" })], "Asked Copilot"],
        ["preauth", [{ ...call("preauth", { question: "Invented blocked request" }), toolSucceeded: false, reportedOutcome: "failed",
            failureEvidence: { version: 1, messageStatus: "text-excluded", messageSignal: "workiq-sign-in-required" } }], "Asked Copilot"],
        ["unsupported", [call("unsupported", { entityUrl: "https://untrusted.invalid/me/messages" })], "Service not shown"],
        ["known", [call("known", { entityUrl: "/me/messages" })], "Mail"],
        ["partial", [call("partial", { entityUrls: ["/me/messages", "/unrecognized/resource"] })], "More than one service"],
        ["mixed", [call("mixed-assistance", { question: "Invented help request" }), call("mixed-missing", {}, "workiq-fetch")],
            "Asked Copilot, Service not shown"],
    ];
    const evidence = records.map(([name, toolCalls]) => ({ ...structuredClone(source), scenarioId: `card-${name}`, toolCalls }));
    const { context } = await privateFixture(t, evidence);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const snapshot = page.waitForResponse(response => new URL(response.url()).pathname === "/api/snapshot" && response.ok());
    await page.goto(runtime.url + "#analyze"); await ready(page);
    const { analytics } = await (await snapshot).json();
    assert.equal(analytics.totals.count, 7);
    assert.deepEqual(analytics.rows.map(row => row.toolCallId).sort(), evidence.flatMap(record => record.toolCalls.map(call => call.toolCallId)).sort());
    assert.ok(analytics.rows.every(row => row.outcome === (row.toolCallId === "card-preauth" ? "failure" : "success")));
    assert.equal(analytics.serviceInvolvement.definition.version, 1);
    for (const [name, , label] of records) {
        const card = page.locator(`[data-view-key="request:card-${name}"]`);
        assert.equal(await card.locator(".request-meta").textContent(), label);
    }
    const assistance = page.locator('[data-view-key="request:card-assistance"]');
    await expect(assistance.locator("[data-fluent-icon=chat_sparkle_24_regular]")).toHaveCount(1);
    await expect(page.locator('[data-view-key="request:card-unsupported"] [data-fluent-icon=question_circle_24_regular]')).toHaveCount(1);
    await expect(page.locator('[data-view-key="request:card-mixed"] [data-fluent-icon=question_circle_24_regular]')).toHaveCount(1);
    await assistance.getByRole("button", { name: "About Asked Copilot; recorded activity categories", exact: true }).click();
    assert.match(await page.getByRole("tooltip").innerText(), /Its record does not identify a service or API path/);
    await page.keyboard.press("Escape");
    const preauth = page.locator('[data-view-key="request:card-preauth"]');
    await expect(preauth.locator("[data-fluent-icon=chat_sparkle_24_regular]")).toHaveCount(1);
    await preauth.getByRole("button", { name: "About Asked Copilot; recorded activity categories", exact: true }).click();
    await expect(page.getByRole("tooltip")).toContainText("Recorded attempt");
    await expect(page.getByRole("tooltip")).toContainText("not confirmation of delivery");
    await page.keyboard.press("Escape");
    const mixed = page.locator('[data-view-key="request:card-mixed"]');
    await mixed.getByRole("button", { name: "About Asked Copilot, Service not shown; recorded activity categories", exact: true }).click();
    assert.match(await page.getByRole("tooltip").innerText(), /Asked Copilot:.*Service not shown:/);
    await page.keyboard.press("Escape");
    await page.goto(runtime.url + "#analyze?mode=calls"); await ready(page);
    const callLabels = new Map(records.flatMap(([, calls, label]) => calls.map(call => [call.toolCallId,
        call.toolCallId === "card-mixed-assistance" ? "Asked Copilot" : call.toolCallId === "card-mixed-missing" ? "Service not shown" : label])));
    for (const row of analytics.rows) {
        const card = page.locator(`[data-action-id=${JSON.stringify(row.id)}]`);
        assert.equal(await card.locator(".action-service .service-cue").textContent(), callLabels.get(row.toolCallId));
    }
    const filteredSnapshot = page.waitForResponse(response => new URL(response.url()).pathname === "/api/snapshot" && response.ok());
    await selectActivityOption(page, "serviceFilter", "Unknown"); await ready(page);
    const filtered = (await (await filteredSnapshot).json()).analytics;
    const expected = analytics.rows.filter(row => row.workload === "Unknown");
    assert.deepEqual(filtered.rows.map(row => row.id), expected.map(row => row.id));
    assert.equal(filtered.totals.count, 5);
    assert.equal(await page.locator("#activityList .matched-action").count(), 5);
    assert.deepEqual(errors, []);
});

test("a single-group legend explains the missing evidence without repeating the total", { timeout: 15000 }, async t => {
    const record = serviceEvidenceFixture(), call = record.toolCalls[0];
    record.toolCalls = Array.from({ length: 5 }, (_, index) => ({ ...call, toolCallId: `copy-call-${index}`, startEventId: `copy-start-${index}` }));
    const { context } = await privateFixture(t, [record]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(); t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, colorScheme: "dark" });
    await page.goto(runtime.url + "#home?bucket=week&service=Unknown"); await ready(page);
    const composition = page.locator('[data-percentage-card="services"]');
    assert.match(await composition.innerText(), /5 with missing service details/);
    assert.match(await composition.locator(".percentage-gap-list").innerText(), /Not in this record\s+5/);
    assert.equal(await composition.locator(".percentage-legend-row").count(), 0, "Missing details are not a fabricated service");
    for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 1100 });
        await page.evaluate(size => { document.documentElement.style.fontSize = size; }, width === 375 ? "200%" : "100%");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        if (proofDir) {
            await mkdir(proofDir, { recursive: true });
            const visibleCopy = width === 375 ? composition.locator(".percentage-coverage") : composition;
            await visibleCopy.screenshot({ path: path.join(proofDir, `single-group-dark-${width}.png`) });
        }
    }
});

test("the Unknown-filtered entry explains its actual calls before any disclosure is opened", { timeout: 30000 }, async t => {
    const { context } = await privateFixture(t, [serviceEvidenceFixture()]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const unexpected = [], errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        const url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin || request.method() !== "GET" &&
            !["/api/connect", "/api/snapshot", "/api/assessment/overview", "/api/assessment/detail", "/api/evaluation/automatic/summary"].includes(url.pathname)) unexpected.push(url.pathname);
    });
    await page.goto(runtime.url + "#activity?bucket=week&service=Unknown"); await ready(page);
    const explanation = page.locator("#serviceEvidenceSummary");
    assert.equal(await explanation.isVisible(), true, "The exact filtered entry must explain the service gap without opening hidden help.");
    assert.match(await explanation.innerText(), /3 of 3 Work IQ tool calls/);
    assert.match(await explanation.innerText(), /Asked Copilot[\s\S]*workiq-ask/);
    assert.match(await explanation.innerText(), /Path not recognized/);
    assert.match(await explanation.innerText(), /No target recorded/);
    assert.doesNotMatch(await explanation.innerText(), /Invented question|INVENTED-PRIVATE|\/unsupported\/resource/);
    assert.equal(await explanation.locator("[data-evidence-count]").evaluateAll(nodes =>
        nodes.reduce((sum, node) => sum + Number(node.dataset.evidenceCount), 0)), 3);
    for (const theme of ["light", "dark"]) for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 1100 }); await chooseTheme(page, theme);
        await page.evaluate(size => { document.documentElement.style.fontSize = size; }, width === 375 ? "200%" : "100%");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        assert.equal(await explanation.isVisible(), true);
        if (proofDir) {
            await mkdir(proofDir, { recursive: true });
            await explanation.screenshot({ path: path.join(proofDir, `filtered-evidence-${theme}-${width}.png`) });
        }
    }
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
    await page.goto(runtime.url + "#home?bucket=week&service=Unknown"); await ready(page);
    const composition = page.locator('[data-percentage-card="services"]');
    const reasonLines = await composition.locator(".percentage-gap-list > div").allTextContents();
    assert.equal(reasonLines.length, 3);
    assert.deepEqual(await composition.locator(".percentage-gap-list dd").allTextContents(), ["1", "1", "1"]);
    assert.match(reasonLines.join(" "), /Not in this record.*Path not recognized.*No target recorded/);
    assert.match(await composition.locator(".percentage-denominator").innerText(), /Work IQ tool calls/);
    if (proofDir) {
        await mkdir(proofDir, { recursive: true });
        await composition.screenshot({ path: path.join(proofDir, "multiple-groups-dark-1280.png") });
    }
    assert.equal(await composition.locator(".percentage-label").count(), 0);
    assert.equal(await composition.locator("details").evaluate(node => node.open), false);
    await page.goto(runtime.url + "#request?request=service-evidence&service=Unknown"); await ready(page);
    assert.equal(await explanation.isVisible(), false, "A full request must not be described as only the originating Unknown slice.");
    const ask = page.locator('[data-tool-call-id="service-evidence-call-0"]');
    assert.match(await ask.innerText(), /Downstream API path[\s\S]*Not recorded/);
    assert.match(await ask.innerText(), /HTTP method[\s\S]*Not recorded[\s\S]*API version[\s\S]*Not recorded/);
    for (const suffix of ["service=Files", "service=Unknown&result=failure"]) {
        await page.goto(runtime.url + "#activity?" + suffix); await ready(page);
        assert.equal(await explanation.isVisible(), false, "Known services and empty Unknown slices do not show irrelevant evidence explanations.");
    }
    assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
});

test("whole category view and detail explain remaining service evidence without question marks or reconstructed chart icons", { timeout: 90000 }, async t => {
    const { context } = await privateFixture(t, [serviceEvidenceFixture()]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(7000);
    const errors = [], external = [], mutations = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
        const url = new URL(request.url());
        if (url.origin !== new URL(runtime.url).origin) external.push(url.origin);
        if (request.method() !== "GET" && !["/api/connect", "/api/snapshot", "/api/collection/status", "/api/assessment/detail",
            "/api/assessment/overview", "/api/evaluation/automatic/summary"].includes(url.pathname)) mutations.push(url.pathname);
    });
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("No clipboard access in service proof."); },
        writeText() { throw Error("No clipboard access in service proof."); },
    } }));
    t.after(async () => { await browser.close(); await runtime.close(); assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(mutations, []); });
    for (const theme of ["light", "dark"]) for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(runtime.url + "#home?range=capture&chart=workload"); await ready(page);
        await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
        await chooseTheme(page, theme);
        assert.equal(await page.locator(".percentage-section").getAttribute("data-total"), "6");
        assert.match(await page.locator("#chart").innerText(), /Service not shown/);
        assert.equal(await page.locator(".dimensional-category-label svg").count(), 0);
        const composition = page.locator('[data-percentage-card="services"]');
        assert.match(await composition.innerText(), /3 with missing service details/);
        assert.equal(await composition.locator('[data-category="Unknown"]').count(), 0);
        if (!await composition.locator("details").evaluate(node => node.open)) await composition.locator("summary").click();
        const explanation = await composition.locator(".percentage-exact").innerText();
        assert.match(explanation, /Its record does not identify a service or API path/);
        assert.match(explanation, /target path was recorded/);
        assert.match(explanation, /No service target/);
        if (!await page.locator("#serviceDefinitions").evaluate(node => node.open)) await page.locator("#serviceDefinitions > summary").click();
        assert.match(await page.locator("#serviceDefinitions").innerText(), /Its record does not identify a service or API path/);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await shot(page, `remaining-${theme}-${width}-chart`);
        await page.goto(runtime.url + "#request?request=service-evidence&range=capture"); await ready(page);
        const ask = page.locator('[data-tool-call-id="service-evidence-call-0"]');
        assert.match(await ask.innerText(), /Asked Copilot/);
        assert.equal(await dataService(ask), "Not in this record");
        const unrecognized = page.locator('[data-tool-call-id="service-evidence-call-3"]');
        assert.match(await unrecognized.innerText(), /Service not shown/);
        assert.equal(await dataService(unrecognized), "Path not recognized");
        const missing = page.locator('[data-tool-call-id="service-evidence-call-4"]');
        assert.equal(await dataService(missing), "No target recorded");
        assert.match(await page.locator('[data-tool-call-id="service-evidence-call-2"]').textContent(), /Files[\s\S]*Tool failed/);
        assert.match(await page.locator('[data-tool-call-id="service-evidence-call-5"]').innerText(), /Schema lookup[\s\S]*Not applicable[\s\S]*Schema path/);
        await ask.getByRole("button", { name: "About Asked Copilot", exact: true }).click();
        assert.match(await page.getByRole("tooltip").innerText(), /Its record does not identify a service or API path/);
        await page.keyboard.press("Escape");
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await shot(page, `remaining-${theme}-${width}-detail`);
        if (width === 375) {
            await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
            await shot(page, `remaining-${theme}-${width}-200-detail`);
        }
    }
    await page.goto(runtime.url + "#home?range=capture&chart=workload"); await ready(page);
    await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
    await selectActivityOption(page, "serviceFilter", "Unknown"); await ready(page);
    assert.equal(await page.locator(".percentage-section").getAttribute("data-total"), "3");
    assert.match(page.url(), /service=Unknown/);
    await selectActivityOption(page, "outcomeFilter", ["failure"]); await ready(page);
    assert.equal(await page.locator(".percentage-section").getAttribute("data-total"), "0");
    assert.match(await page.locator('[data-percentage-card="services"]').innerText(), /No matching activity/);
});

test("new readable report retains the neutral evidence reasons and safe shared-file paths", { timeout: 30000 }, async t => {
    const record = serviceEvidenceFixture(); record.toolCalls.splice(4, 1);
    const bundle = await buildSanitizedBundle([record], "e".repeat(64), { formats: ["html"], promptMode: "none" });
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ reducedMotion: "reduce" });
    await page.setContent(bundle.files["product-report.html"]);
    assert.match(await page.locator(".service-glossary").innerText(), /Service not shown/);
    assert.match(await page.locator("#operations").innerText(), /Its record does not identify a service or API path/);
    assert.match(await page.locator("#operations").innerText(), /\/shares\/\{id\}\/driveItem/);
    assert.doesNotMatch(await page.locator("main").innerText(), /INVENTED-PRIVATE|ANOTHER-INVENTED|INVENTED-SCHEMA/);
    for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await shot(page, `remaining-report-${width}`);
    }
});
