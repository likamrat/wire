import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption, openAnalyzeFilters, closeAnalyzeFilters, navigateMain } from "./helpers.mjs";
import { contrast, rgb } from "./color-measurements.mjs";
import { searchFixture } from "./live-search-fixture.mjs";
import { modelRecords } from "./model-widget-fixture.mjs";

function records() {
    return [
        ["automatic", "workiq-retrieve", { query: "Invented planning notes" }],
        ["unknown", "workiq-retrieve", { query: "Invented planning notes" }],
        ["copilot", "workiq-ask", { question: "Find the planning owner." }],
        ["missing", "workiq-fetch", {}],
        ["unclassified", "workiq-fetch", { entityUrls: ["/invented-service/items"] }],
        ["partial", "workiq-fetch", { entityUrls: ["/me/messages", "/invented-service/items"] }],
        ["preparation", "workiq-get_schema", { path: "/me/messages" }],
    ].map(([name, tool, requestArgs], index) => {
        const record = fixture("wording-" + name), automatic = index < 2;
        record.userPrompt = { text: automatic ? "" : `Review the invented ${name} planning request.`, status: "full",
            sourceEventId: "wording-prompt-" + name, sourceTimestamp: "2026-10-17T12:00:00.000Z",
            authorship: index === 0 ? { actor: "agent", basis: "autopilot" }
                : index === 1 ? { actor: "unknown", basis: "conflicting-source" } : { actor: "user", basis: "source-user" },
            ...automatic ? { capture: { version: 1, kind: "automatic-continuation", original: "empty", hostContext: "not-collected", reason: null } } : {} };
        record.followUpPrompts = [];
        record.toolCalls = [{ tool, requestArgs, toolCallId: "wording-call-" + name, startEventId: "wording-start-" + name,
            startedAt: record.userPrompt.sourceTimestamp, durationMs: 325, toolSucceeded: true, reportedOutcome: "succeeded", apiResults: [] }];
        return record;
    });
}

test("one source needs no picker, card or reader badge, or source prefix on every chart point", async t => {
    const [record] = records().slice(2);
    const { runtime } = await searchFixture(t, { records: [record], frontend: "react", reply: false });
    const browser = await chromium.launch(); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1360, height: 940 } });
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const capture = async name => {
        if (!process.env.WIRE_EVIDENCE_PROOFS) return;
        await mkdir(process.env.WIRE_EVIDENCE_PROOFS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.WIRE_EVIDENCE_PROOFS, `single-source-${name}.png`), animations: "disabled" });
    };
    const ready = () => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.goto(runtime.url + "#analyze?source=github-copilot"); await ready();
    await expect(page.locator("#sourceFilter")).toHaveValue("github-copilot");
    await openAnalyzeFilters(page);
    await expect(page.locator("#sourceFilter-control")).toBeHidden();
    await expect(page.locator("#toolFilter-control")).toBeVisible();
    await capture("filters");
    await closeAnalyzeFilters(page);
    await expect(page.locator("#analyzeScopeCaption")).not.toContainText("GitHub Copilot");
    await expect(page.locator("#chart .time-slot a").first()).toHaveAccessibleName(/Work IQ tool call/);
    await expect(page.locator("#chart .time-slot a").first()).not.toHaveAccessibleName(/GitHub Copilot/);
    const card = page.locator("#activityList .activity-card");
    await expect(card).toContainText("Asked Copilot"); await expect(card).not.toContainText("GitHub Copilot");
    await card.locator(".request-card-open").click();
    await page.locator('[data-reader-section="source"] .reader-section-toggle').click();
    await expect(page.locator(".reader-source")).toBeVisible();
    await expect(page.locator(".reader-source")).not.toContainText("GitHub Copilot");
    await capture("reader");
    await page.keyboard.press("Escape");
    await page.locator("#wireSearch").fill("nonexistent invented phrase");
    await expect(page.locator("#wireSearchStatus")).toHaveText("No matches in the items WIRE could search. Saved replies are unavailable for Search.");
    await page.locator("#wireSearchClear").click(); await navigateMain(page, "trends");
    await page.locator("#trendsComparePeriods").click();
    await expect(page.getByRole("dialog", {name:"Compare periods"})).not.toContainText("GitHub Copilot");
    await capture("periods");
    await page.keyboard.press("Escape"); await navigateMain(page, "reports");
    await expect(page.locator("#reportCreatePanel")).not.toContainText("GitHub Copilot");
    assert.deepEqual(errors, []);
});

test("Services and operations ends with its request rows and opens their matching calls", async t => {
    const { runtime } = await searchFixture(t, { records: records().slice(0, 3), frontend: "react", reply: false });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.stack));
    await page.goto(runtime.url);
    const card = page.getByRole("region", { name: "Services and operations", exact: true });
    for (const [label, count] of [["Search requested", 2], ["Asked Copilot", 1]]) {
        const row = card.getByRole("link", { name: new RegExp(`^${label}: ${count} of 3 Work IQ tool calls`) });
        await expect(card.locator(".percentage-content > :last-child")).toHaveRole("list");
        await row.click();
        assert.deepEqual(errors, []);
        await expect(page.locator("#activityListSummary")).toContainText(`${count} matching tool call`);
        await page.goBack();
    }
});

test("Analyze widget links explain the mark and open its exact calls or originating interactions", async t => {
    const [first, second, third] = modelRecords();
    first.userPrompt.text = "Find the launch brief and check which mailbox items need new IDs.";
    second.userPrompt.text = "Check the search endpoint for the handover notes.";
    third.userPrompt.text = "Look up the mail schema before preparing the next request.";
    const call = (key, tool, requestArgs, at, failed = false) => ({
        toolCallId: key, startEventId: key + "-start", startedAt: at,
        tool, requestArgs, toolSucceeded: !failed, reportedOutcome: failed ? "failed" : "succeeded", apiResults: [],
    });
    first.toolCalls = [
        call("convert", "workiq-do_action", { actionUrl: "/me/translateExchangeIds" }, first.capturedAt),
        call("both", "workiq-fetch", { entityUrls: ["/users/invented-user/translateExchangeIds", "/businessapps/me", "/me/messages"] }, first.capturedAt),
        call("find", "workiq-retrieve", { query: "Find the launch brief" }, first.capturedAt),
    ];
    second.toolCalls = [call("endpoint", "workiq-fetch", { entityUrls: ["/search/query"] }, second.capturedAt, true)];
    third.toolCalls = [call("schema", "workiq-get_schema", { path: "/me/messages", operationType: "fetch" }, third.capturedAt, true)];
    const { runtime } = await searchFixture(t, { records: [first, second, third], frontend: "react", reply: false });
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, timezoneId: "UTC", reducedMotion: "reduce" });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/*", route => new URL(route.request().url()).origin === new URL(runtime.url).origin ? route.continue() : route.abort());
    const response = page.waitForResponse(res => new URL(res.url()).pathname === "/api/snapshot" && res.ok());
    await page.goto(runtime.url);
    const { analytics } = await (await response).json(), ids = names => analytics.rows.filter(r => names.includes(r.toolCallId)).map(r => r.id).sort();
    const service = name => page.locator('[data-breakdown="services"]').getByRole("link", { name: new RegExp("^" + name + ":") });
    const summary = page.locator("#activityListSummary"), matches = page.locator("#activityList .widget-record");
    const back = async link => { await page.goBack(); await expect(link).toBeFocused(); };
    const keyOpen = async link => { await link.focus(); await page.keyboard.press("Enter"); };
    const directory = process.env.WIRE_WIDGET_PROOF;
    if (directory) await mkdir(directory, { recursive: true });
    const tools = page.locator('[data-breakdown="tools"]');
    for (const [name, words, n] of [["workiq-retrieve", /matching items and passages/, 1], ["workiq-fetch", /requested API paths/, 2]]) {
        const row = tools.locator(`[data-category="tool:${name}"]`), action = row.getByRole("link");
        const value = row.locator(".percentage-value");
        await value.scrollIntoViewIfNeeded();
        const box = await value.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
        await page.mouse.move(x, y);
        await expect(page.getByRole("tooltip")).toContainText(words);
        await expect(row.locator("svg")).toHaveCount(0);
        await page.mouse.click(x, y);
        await expect(summary).toContainText(`${n} matching tool call`);
        await back(action);
    }
    for (const [label, names, words] of [
        ["Exchange ID conversion", ["convert", "both"], /mail, events or contacts/],
        ["Business app not named", ["both"], /businessapps\/me/],
        ["Search endpoint", ["endpoint"], /recorded target is a search endpoint/],
        ["Search requested", ["find"], /which apps were searched/],
    ]) {
        const action = service(label);
        await action.hover();
        await expect(page.getByRole("tooltip")).toContainText(words);
        await expect(action).toHaveAccessibleName(new RegExp(`${names.length} of 5`));
        if (directory && label === "Exchange ID conversion") await page.screenshot({ path: path.join(directory, "widget-hover.png") });
        await keyOpen(action);
        await expect(summary).toHaveText(`${label}: ${names.length} matching tool call${names.length === 1 ? "" : "s"}`);
        assert.deepEqual((await matches.evaluateAll(nodes => nodes.map(n => n.dataset.actionId))).sort(), ids(names));
        if (label === "Business app not named") {
            await matches.getByRole("link").click();
            await expect(page.locator("#selectedCall")).toHaveAttribute("data-tool-call-id", "both");
            await page.goBack(); await expect(matches).toHaveCount(1);
        }
        await back(action);
    }
    await chooseTheme(page, "dark");
    const author = page.locator('[data-breakdown=authors] [data-prompt-actor=agent] a');
    const model = page.locator('[data-breakdown=models] [data-category="gpt-5.4"] a');
    for (const [link, expected] of [[author, [third]], [model, [first, second]]]) {
        await keyOpen(link);
        await expect(summary).toContainText(`${expected.length} matching interaction`);
        const cards = page.locator("#activityList .activity-card");
        assert.deepEqual((await cards.evaluateAll(nodes => nodes.map(node => node.dataset.viewKey))).sort(), expected.map(s => "request:" + s.scenarioId).sort());
        assert.doesNotMatch(page.url(), /gpt-5|model-request/);
        await back(link);
    }
    const zeroAuthor = page.locator('[data-breakdown=authors] [data-prompt-actor=unknown] a');
    await keyOpen(zeroAuthor); await expect(page.locator("#chartReferenceTopicTitle")).toContainText(/prompt|author/i);
    await back(zeroAuthor);
    const total = page.locator(".percentage-total-link");
    await keyOpen(total); await expect(summary).toContainText("5 matching tool calls"); await expect(matches).toHaveCount(5);
    await back(total);
    const headline = page.locator("#periodResult a").first();
    await keyOpen(headline); await expect(matches).toHaveCount(5); await back(headline);
    for (const [link, owners] of [
        [page.locator("#outcomeChart [data-category=failure] .percentage-label"), [second, third]],
        [page.locator(".time-segment-link[data-segment=failure]").last(), [second]],
    ]) {
        await keyOpen(link);
        await expect(summary).toContainText(`${owners.length} matching tool call`);
        assert.deepEqual((await page.locator("#activityList .activity-card").evaluateAll(nodes => nodes.map(node => node.dataset.viewKey))).sort(),
            owners.map(s => "request:" + s.scenarioId).sort());
        await back(link);
    }
    const zeroDay = page.locator(".time-zero[href]").first();
    await keyOpen(zeroDay); await expect(page.locator("#chartReferenceTopicTitle")).toContainText(/calls|time/i); await back(zeroDay);
    const day = page.locator(".time-column").last();
    await keyOpen(day); await expect(summary).toContainText("4 matching tool calls"); await back(day);
    if (directory) {
        await page.locator("#outcomeChart").scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(directory, "widget-outcomes.png") });
    }
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await mobile.goto(runtime.url);
    const mobileRow = mobile.locator('[data-service-basis="business-app-not-named"]');
    await expect(mobileRow.getByRole("link")).toHaveAccessibleDescription(/businessapps\/me/);
    await expect(mobileRow.getByRole("link")).toHaveCSS("min-width", "44px");
    const mobileValue = mobileRow.locator(".percentage-value");
    await mobileValue.scrollIntoViewIfNeeded();
    const box = await mobileValue.boundingBox();
    await mobile.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(mobile.locator("#activityListSummary")).toHaveText("Business app not named: 1 matching tool call");
    assert.deepEqual(errors, []);
});

test("service evidence explains significance at its call without warning on ordinary operations", { timeout: 60000 }, async t => {
    const call = (tool, requestArgs = {}) => ({
        tool, requestArgs, toolSucceeded: true, reportedOutcome: "succeeded", apiResults: [],
        resultEvidence: { version: 1, contentStatus: "body-excluded" },
    });
    const search = () => call("workiq-retrieve", { query: "Invented workshop reference notes" });
    const ask = () => call("workiq-ask", { question: "Explain the recorded workshop plans." });
    const fetch = entityUrls => call("workiq-fetch", entityUrls ? { entityUrls } : {});
    const definitions = [
        ["hosted", [search(), ask()]],
        ["mixed", [search(), { ...ask(), requestArgs: { question: "Explain the recorded workshop plans.", fileUrls: ["https://example.invalid/invented-handout"] } }, { ...fetch(["/me/drive/items/invented-pack"]), toolSucceeded: false, reportedOutcome: "failed",
            failureEvidence: { version: 1, diagnostic: { version: 1, source: "completion-error", status: "recorded",
                message: "Payload too large; downloads are limited to 4 MB." } } }, search(), ask()]],
        ["known", [fetch(["/me/drive/root"])]],
        ["followup", [search(), search(), ask()]],
        ["missing", [fetch()]],
        ["unclassified", [fetch(["/invented-service/items"])]],
        ["unsupported", [fetch(["https://untrusted.invalid/me/messages"])]],
        ["batch", [{ ...fetch(["/me/messages", "/me/calendar/events"]), apiResults: [{ index: 0, statusCode: 200 }] }]],
    ];
    const evidence = definitions.map(([name, calls], index) => {
        const record = fixture("attribution-" + name);
        record.userPrompt = { text: name === "mixed"
            ? "Find the workshop reference files, ask for an explanation of their intended use, and download the briefing pack. Keep the recorded operations separate from the services their target paths identify."
            : `Review the invented ${name} workshop plans using the recorded search and assistance operations. Preserve the source notes and report only what the recorded calls establish.`,
        status: "full", sourceEventId: name + "-prompt", sourceTimestamp: `2026-10-18T12:0${7 - index}:00Z`,
        authorship: { actor: "agent", basis: "source-agent" } };
        record.followUpPrompts = [];
        record.toolCalls = calls.map((value, offset) => ({ ...value, toolCallId: `${name}-${offset}`, startEventId: `${name}-start-${offset}`,
            startedAt: new Date(Date.parse(record.userPrompt.sourceTimestamp) + offset * 1000).toISOString() }));
        return record;
    });
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, evidence);
    const before = await loadBoardState(context);
    const start = process.env.WIRE_EVIDENCE_BASELINE
        ? (await import(pathToFileURL(path.join(process.env.WIRE_EVIDENCE_BASELINE, "lib", "server.mjs")).href)).startServer : startServer;
    const runtime = await start(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "no-preference" });
    const errors = [], denied = [], observations = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET" || [
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
        ].includes(url.pathname))) return route.continue();
        denied.push(url.pathname); return route.abort();
    });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key]);
        } finally { for (const fn of cleanup) await fn(); }
    });
    const phase = process.env.WIRE_SERVICE_CLARITY_PHASE ?? "after", proof = process.env.WIRE_SERVICE_CLARITY_PROOFS;
    if (proof) await mkdir(proof, { recursive: true });
    const card = name => page.locator(`.request-card-open[href*="attribution-${name}"]`);
    const settle = () => page.waitForFunction(() => !document.documentElement.getAnimations({ subtree: true })
        .some(animation => animation.playState === "running" && Number.isFinite(animation.effect.getComputedTiming().iterations)));
    await page.goto(runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.evaluate(() => document.fonts.ready);
    for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await settle();
        if (phase !== "before") {
            await expect(page.locator("#activityList .service-availability,#activityList .request-card-categories")).toHaveCount(0);
            for (const name of ["hosted", "followup", "known"]) {
                await expect(card(name).locator(".call-reason-list")).toHaveCount(0, "Successful body-retention policy is not a problem bullet.");
                await expect(card(name)).not.toContainText("Response body excluded from retention");
            }
            await expect(card("hosted")).not.toContainText(/Tools:|Operations:|Services:/);
            await expect(card("hosted").locator('[data-service="Files"],[data-service="Mail"],[data-service="Teams"]')).toHaveCount(0);
            await expect(card("mixed")).not.toContainText("Payload too large");
            await expect(card("mixed").locator(".request-card-exception")).toHaveText("1 tool call failed");
            await expect(page.locator("#activityList")).not.toContainText("Some service details unavailable");
            for (const reason of ["missing-target", "unsupported-target", "unrecognized-path"])
                await expect(page.locator(`[data-service-basis="${reason}"]`)).toHaveAttribute("data-count", "1");
            await expect(page.locator('[data-service-basis="Assistance"]')).toHaveAttribute("data-count", "4");
            await expect(page.locator('[data-service-basis="Search"]')).toHaveAttribute("data-count", "5");
            const paint = await card("mixed").evaluate(node => ({
                exception: getComputedStyle(node.querySelector(".request-card-exception")).color,
                metadata: getComputedStyle(node.querySelector(".request-card-summary")).color,
            }));
            assert.equal(paint.exception, paint.metadata);
            observations.push({ theme, width, ...paint });
        }
        if (proof) {
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-page.png`), fullPage: true });
            for (const name of ["hosted", "mixed", "unclassified", "unsupported"]) await card(name).screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-${name}.png`) });
        }
        await card("hosted").click(); await settle();
        const assistance = page.locator('[data-tool-call-id="hosted-1"]');
        if (phase !== "before") {
            await expect(assistance.locator(".reader-call-toggle")).toHaveAttribute("aria-expanded", "false");
            await expect(assistance.getByText("Asked Copilot", {exact:true})).toBeVisible();
            await expect(assistance).not.toContainText("which apps, if any");
            await expect(assistance.locator(".recorded-result")).toHaveAttribute("data-outcome", "success");
            await expect(page.locator('[data-attribution-kind="operation"]')).toHaveCount(0);
            await expect(assistance.locator(".call-reason-list")).toHaveCount(0);
        }
        await assistance.locator(".reader-call-identity-line").scrollIntoViewIfNeeded();
        if (proof) await page.screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-hosted-reader.png`) });
        if (phase !== "before") {
            await assistance.locator(".reader-call-toggle").click();
            await expect(assistance.locator(".technical-detail")).toContainText("Response bodies are excluded from activity retention.");
            await expect(assistance.locator(".technical-detail")).toContainText("which apps, if any, Copilot used");
            await assistance.locator(".reader-call-toggle").click();
        }
        await page.keyboard.press("Escape"); await expect(card("hosted")).toBeFocused();
        await card("mixed").click(); await settle();
        const failure = page.locator('[data-tool-call-id="mixed-2"]');
        await failure.locator(".reader-call-summary").scrollIntoViewIfNeeded();
        await expect(failure).toContainText("Payload too large; downloads are limited to 4 MB.");
        await expect(failure.locator(".reader-entry-label")).toHaveText("Call #3");
        await expect(failure.locator(".result-status")).toHaveText("1 tool call failed");
        if (phase !== "before") {
            await expect(failure.locator(".service-availability")).toHaveCount(0, "The actual failed Files call has an identified service.");
            const ask = page.locator('[data-tool-call-id="mixed-1"]');
            await ask.locator(".reader-call-toggle").click();
            await expect(ask).toContainText("The files listed in the request don’t tell us that either.");
        }
        if (proof) await page.screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-mixed-reader.png`) });
        assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
        await page.keyboard.press("Escape"); await expect(card("mixed")).toBeFocused();
        await card("batch").click(); await settle();
        if (phase !== "before") {
            const batch = page.locator('[data-tool-call-id="batch-0"]');
            await expect(batch.locator(".api-result-entry")).toContainText("No path returned for this batch entry.");
            await expect(batch.getByRole("button", { name: "About batch target" })).toHaveCount(1);
            if (proof) {
                await batch.locator(".api-result-entry").scrollIntoViewIfNeeded();
                await page.screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-batch-reader.png`) });
            }
        }
        await page.keyboard.press("Escape"); await settle();
        if (phase !== "before" && width === 1440) for (const [name, label] of [
            ["missing", "Service target not recorded"],
            ["unclassified", "Recorded path not recognized"],
            ["unsupported", "Recorded target format unsupported"],
        ]) {
            await card(name).click(); await settle();
            const call = page.locator(`[data-tool-call-id="${name}-0"]`);
            await expect(card(name)).not.toContainText(label);
            await expect(call.locator(".service-availability")).toHaveCount(0);
            await expect(call.locator(".reader-attribution-context")).toBeVisible();
            await expect(page.locator('[data-reader-section="activity"] .reader-operation-context')).toHaveCount(0);
            await expect(call.locator(".reader-attribution-context")).toContainText(
                name === "missing" ? "source omission or a capture problem" : name === "unclassified" ? "does not identify a named app" : "cannot interpret");
            await expect(call.locator(".reader-attribution-context")).toContainText("The call still counts; its result is shown separately.");
            await expect(call.locator(".reader-call-toggle")).toHaveAttribute("aria-expanded", "false");
            if (proof) await page.screenshot({ path: path.join(proof, `${phase}-${theme}-detail-${name}.png`) });
            await page.keyboard.press("Escape"); await settle();
        }
    }
    if (phase !== "before") {
        await page.setViewportSize({ width: 1440, height: 1000 });
        const response = page.waitForResponse(value => new URL(value.url()).pathname === "/api/snapshot" && value.ok());
        await page.goto(runtime.url + "#analyze?services=Files&includeMissingService=true");
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        const selection = (await (await response).json()).analytics.serviceInvolvement.selection;
        assert.equal(selection.knownMatchIds.length, 2);
        assert.equal(selection.contextOnlyIds.length, 7);
        await expect(page.locator("#serviceFocusScope")).toContainText("2 known matches");
        await expect(page.locator("#serviceFocusScope")).toContainText("7 context-only");
        if (proof) await page.screenshot({ path: path.join(proof, `${phase}-filter-context.png`) });
        await page.route("**/api/snapshot", async route => {
            const response = await route.fetch(), data = await response.json();
            delete data.requestActivity.tool;
            await route.fulfill({ response, json: data });
        });
        for (const theme of ["light", "dark"]) {
            await chooseTheme(page, theme);
            await page.goto(runtime.url + "#request?request=attribution-missing&layer=reported-api");
            await page.reload();
            await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
            await expect(page.locator('[data-tool-call-id="missing-0"] .reader-attribution-context')).toContainText("could not read");
            await expect(page.locator('[data-tool-call-id="missing-0"] .reader-attribution-context')).toContainText("not a recorded service failure");
            await expect(page.locator("#requestContent")).not.toContainText("1 of 0");
            await expect(page.locator('[data-view-key="percentage:services:exact"] .percentage-note')).toContainText("Percentages use all selected records");
            await settle();
            if (proof) await page.screenshot({ path: path.join(proof, `${phase}-${theme}-detail-unreadable.png`) });
            await page.keyboard.press("Escape"); await settle();
        }
    }
    if (proof) await writeFile(path.join(proof, phase + "-observations.json"), JSON.stringify(observations, null, 2));
});

test("app uncertainty belongs to the exact expanded call, not the prompt or a neighboring call", { timeout: 60000 }, async t => {
    const make = (id, tools, minute) => {
        const record = fixture(id);
        record.userPrompt = { text: `Review the invented ${id} workshop plan.`, status: "full",
            sourceEventId: id + "-prompt", sourceTimestamp: `2026-10-18T12:0${minute}:00Z`,
            authorship: { actor: "user", basis: "source-user" } };
        record.followUpPrompts = [];
        record.toolCalls = tools.map((tool, index) => ({
            tool, toolCallId: `${id}-${index}`, startEventId: `${id}-start-${index}`,
            startedAt: new Date(Date.parse(record.userPrompt.sourceTimestamp) + index * 1000).toISOString(),
            requestArgs: tool === "workiq-fetch" ? { entityUrls: ["/me/drive/items/invented-pack"] }
                : tool === "workiq-ask" ? { question: "Explain the saved workshop plan.", ...(id === "op-mixed" ? { fileUrls: ["https://example.invalid/plan"] } : {}) }
                    : { query: "Invented workshop plan" },
            toolSucceeded: tool !== "workiq-fetch", reportedOutcome: tool === "workiq-fetch" ? "failed" : "succeeded",
            resultEvidence: { version: 1, contentStatus: "body-excluded" }, apiResults: [],
            ...(tool === "workiq-fetch" ? { failureEvidence: { version: 1, diagnostic: { version: 1, source: "completion-error",
                status: "recorded", message: "Payload too large; downloads are limited to 4 MB." } } } : {}),
        }));
        return record;
    };
    const evidence = [
        make("op-two", ["workiq-retrieve", "workiq-ask"], 0),
        make("op-three", ["workiq-ask", "workiq-retrieve", "workiq-retrieve"], 1),
        make("op-long", Array.from({ length: 9 }, () => "workiq-retrieve"), 2),
        make("op-mixed", ["workiq-retrieve", "workiq-ask", "workiq-fetch", "workiq-retrieve"], 3),
    ];
    evidence[0].followUpPrompts = [structuredClone(evidence[1].userPrompt)];
    evidence[1].followUpPrompts = [structuredClone(evidence[2].userPrompt)];
    const cleanup = [], { context, runtime } = await searchFixture({ after: fn => cleanup.push(fn) }, { records: evidence, reply: false });
    const before = await loadBoardState(context), errors = [], denied = [];
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "no-preference" });
    t.after(async () => {
        try {
            await browser.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key]);
        } finally { for (const fn of cleanup) await fn(); }
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin) return route.continue();
        denied.push(url.pathname); return route.abort();
    });
    const proof = process.env.WIRE_OPERATION_GROUP_PROOFS, phase = process.env.WIRE_OPERATION_GROUP_PHASE ?? "after";
    if (proof) await mkdir(proof, { recursive: true });
    const observations = [], settle = () => page.waitForFunction(() => !document.documentElement.getAnimations({ subtree: true })
        .some(animation => animation.playState === "running" && Number.isFinite(animation.effect.getComputedTiming().iterations)));
    await page.goto(runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    for (const theme of ["light", "dark"]) for (const width of [1440, 390]) {
        await page.setViewportSize({ width: 1440, height: 1000 }); await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 }); await settle();
        for (const [id, count] of [["op-two", 2], ["op-three", 3], ["op-long", 9], ["op-mixed", 4]]) {
            const card = page.locator(".request-card-open").filter({hasText:`Review the invented ${id} workshop plan.`});
            await card.click(); await settle();
            const activity = page.locator('[data-reader-section="activity"]');
            const metrics = await activity.evaluate(node => {
                const notes = [...node.querySelectorAll('.reader-operation-context, [data-attribution-kind="operation"]')];
                return { explanations: notes.length, characters: notes.reduce((sum, note) => sum + note.textContent.length, 0),
                    explanationHeight: notes.reduce((sum, note) => sum + note.getBoundingClientRect().height, 0),
                    callRows: node.querySelectorAll(".reader-call-row").length };
            });
            observations.push({ theme, width, id, ...metrics });
            if (phase !== "before") {
                await expect(activity).not.toContainText("which apps");
                await expect(activity.locator(".reader-call-row")).toHaveCount(count);
                if (id === "op-mixed") {
                    const ask = activity.locator('[data-tool-call-id="op-mixed-1"]');
                    await ask.locator(".reader-call-toggle").click();
                    await expect(ask).toContainText("which apps, if any, Copilot used");
                    await expect(ask).toContainText("files listed in the request");
                    await ask.locator(".reader-call-toggle").click();
                    await expect(activity.locator('[data-tool-call-id="op-mixed-2"]')).toContainText("Payload too large; downloads are limited to 4 MB.");
                    await expect(activity.locator('[data-tool-call-id="op-mixed-2"] .reader-entry-label')).toHaveText("Call #3");
                }
            }
            await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop = 0);
            if (proof) await page.screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-${id}.png`) });
            assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
            if (phase !== "before" && id === "op-three") {
                if (width === 1440) {
                    const source = page.locator('[data-reader-section="source"] > .reader-section-heading .reader-section-toggle');
                    if (await source.getAttribute("aria-expanded") !== "true") await source.click();
                    await expect(source).toHaveAttribute("aria-expanded", "true"); await settle();
                    const linked = page.locator(".reader-linked-context");
                    if (!await linked.evaluate(node => node.open)) await linked.locator(":scope > summary").click();
                    await settle();
                    const earlier = linked.locator('[data-tool-call-id="op-two-1"]');
                    await expect(earlier).toBeVisible();
                    await expect(earlier.getByText("Asked Copilot", {exact:true})).toBeVisible();
                    if (proof) {
                        await earlier.scrollIntoViewIfNeeded();
                        await page.screenshot({ path: path.join(proof, `${phase}-${theme}-linked-groups.png`) });
                    }
                }
            }
            await page.keyboard.press("Escape"); await expect(card).toBeFocused(); await settle();
        }
    }
    if (phase !== "before") {
        await page.goto(runtime.url + "#analyze?tool=workiq-retrieve");
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        await page.locator(".request-card-open").filter({hasText:"Review the invented op-mixed workshop plan."}).click();
        await expect(page.locator("#requestContent .reader-scope")).toContainText("2 of 4");
        await expect(page.locator('[data-reader-section="activity"]')).not.toContainText("which apps");
        await expect(page.locator('[data-reader-section="activity"] .reader-call-row')).toHaveCount(4);
    }
    if (proof) await writeFile(path.join(proof, phase + "-scopes.json"), JSON.stringify(observations, null, 2));
});

test("one author/service vocabulary and Asked Copilot color survive cards, reader, legend, hover and enlarged text", { timeout: 60000 }, async t => {
    const cleanup = [], errors = [], unexpected = [];
    const { context } = await privateFixture({ after: fn => cleanup.push(fn) }, records());
    const before = await loadBoardState(context);
    const start = process.env.WIRE_EVIDENCE_BASELINE
        ? (await import(pathToFileURL(path.join(process.env.WIRE_EVIDENCE_BASELINE, "lib", "server.mjs")).href)).startServer : startServer;
    const runtime = await start(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const proof = process.env.WIRE_EVIDENCE_PROOFS, phase = process.env.WIRE_EVIDENCE_PROOF_PHASE ?? "after";
    if (proof) await mkdir(proof, { recursive: true });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const req = route.request(), url = new URL(req.url());
        if (url.origin === new URL(runtime.url).origin && (req.method() === "GET" || [
            "/api/snapshot", "/api/connect", "/api/collection/status", "/api/assessment/detail", "/api/assessment/overview",
            "/api/evaluation/automatic/summary",
        ].includes(url.pathname))) return route.continue();
        unexpected.push(url.pathname); return route.abort();
    });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key]);
        } finally { for (const fn of cleanup) await fn(); }
    });
    const card = name => page.locator(`[data-view-key="request:wording-${name}"] .request-card-open`);
    await page.goto(runtime.url);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    if (phase !== "before") {
        await expect(card("automatic").locator(".request-card-author")).toHaveText("Agent prompt (automatic continuation)");
        await expect(card("automatic")).toContainText("Work continued without a new message.");
        await expect(card("unknown").locator(".request-card-author")).toHaveText("Author unverified (automatic continuation)");
        await expect(card("unknown").locator(".request-card-author")).toHaveAttribute("data-prompt-actor", "unknown");
        await expect(card("copilot")).not.toContainText("Not shown");
        await expect(card("copilot").locator(".service-availability")).toHaveCount(0);
        await expect(page.locator("#activityList .request-card-categories,#activityList .service-cue")).toHaveCount(0);
        await expect(card("preparation").locator(".service-availability")).toHaveCount(0);
        await card("automatic").click();
        await expect(page.locator('[data-reader-section="prompt"] .reader-section-title')).toHaveText("Agent prompt (automatic continuation)");
        await expect(page.locator('[data-reader-section="prompt"] .ux-copy')).toHaveCount(0);
        await page.locator("#closeContextSidebar").click();
    }
    const observations = [];
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 100], [390, 200]]) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => document.documentElement.style.fontSize = "100%");
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale}%`, scale);
        if (proof) await card("automatic").screenshot({ path: path.join(proof, `vocabulary-${phase}-${theme}-${width}-automatic.png`) });
        await card("copilot").scrollIntoViewIfNeeded();
        if (proof) await card("copilot").screenshot({ path: path.join(proof, `vocabulary-${phase}-${theme}-${width}-card.png`) });
        await card("copilot").click();
        const cue = page.locator("#requestContent [data-operation=operation-ask]").first();
        const cueStyle = await cue.evaluate(node => {
            const style = getComputedStyle(node), root = getComputedStyle(document.documentElement);
            const icon = node.querySelector(".wire-icon"), range = document.createRange(); range.selectNodeContents(node.querySelector("span"));
            const first = range.getClientRects()[0], rect = icon.getBoundingClientRect();
            return { color: style.color, assistance: root.getPropertyValue("--screen-activity-assistance").trim(),
                muted: root.getPropertyValue("--muted").trim(), failure: root.getPropertyValue("--chart-failure").trim(),
                success: root.getPropertyValue("--chart-success").trim(),
                paper: root.getPropertyValue("--paper").trim(), context: root.getPropertyValue("--context-paper").trim(), iconHeight: rect.height, lineHeight: parseFloat(style.lineHeight),
                centerOffset: Math.abs(rect.y + rect.height / 2 - first.y - first.height / 2) };
        });
        if (phase !== "before") {
            assert.ok(contrast(cueStyle.color, cueStyle.paper) >= 4.5);
            assert.ok(contrast(cueStyle.color, cueStyle.context) >= 4.5);
            assert.deepEqual(rgb(cueStyle.color), rgb(cueStyle.assistance));
            assert.notDeepEqual(rgb(cueStyle.color), rgb(cueStyle.muted), "Assistance must not remain unknown grey");
            assert.notDeepEqual(rgb(cueStyle.color), rgb(cueStyle.failure)); assert.notDeepEqual(rgb(cueStyle.color), rgb(cueStyle.success));
            assert.ok(cueStyle.centerOffset <= 1.5, JSON.stringify(cueStyle));
            const legend = page.locator('.percentage-legend-row[data-service-basis="Assistance"] .percentage-cue');
            assert.equal(await legend.evaluate(node => getComputedStyle(node).color), cueStyle.color);
            await expect(page.locator("#requestContent").getByText("Asked Copilot", {exact:true}).first()).toBeVisible();
            await expect(page.locator("#requestContent")).not.toContainText("Service not shown");
            await expect(page.locator("#requestContent")).not.toContainText("not relevant");
        }
        if (proof) await page.locator("#contextSidebar").screenshot({ path: path.join(proof, `vocabulary-${phase}-${theme}-${width}-reader.png`) });
        assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
        observations.push({ theme, width, textScale: scale, ...cueStyle,
            paperContrast: contrast(cueStyle.color, cueStyle.paper), readerContrast: contrast(cueStyle.color, cueStyle.context) });
        await page.locator("#closeContextSidebar").click();
        await page.waitForFunction(() => !document.querySelector("#contextSidebar").open);
    }
    if (proof) await writeFile(path.join(proof, `vocabulary-${phase}-measurements.json`), JSON.stringify(observations, null, 2));
    if (phase === "before") return;
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => document.documentElement.style.fontSize = "100%");
    await selectActivityOption(page, "promptAuthorFilter", ["agent"]);
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await expect(page.locator(".request-card-open")).toHaveCount(1);
    await expect(card("automatic")).toBeVisible();
    assert.deepEqual(await page.locator("#promptAuthorFilter option").evaluateAll(nodes => nodes.map(node => node.value)), ["user", "agent", "unknown"]);
});
