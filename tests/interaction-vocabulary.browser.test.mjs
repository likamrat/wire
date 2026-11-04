import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, selectActivityOption } from "./helpers.mjs";
import { contrast, rgb } from "./color-measurements.mjs";

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
            for (const [name, label] of [
                ["missing", "Service target not recorded"], ["unclassified", "Recorded path not recognized"],
                ["unsupported", "Recorded target format unsupported"],
            ]) await expect(card(name).locator(".service-availability")).toHaveText(label);
            for (const name of ["hosted", "mixed", "known", "followup", "batch"]) await expect(card(name).locator(".service-availability")).toHaveCount(0);
            for (const name of ["hosted", "followup", "known"]) {
                await expect(card(name).locator(".call-reason-list")).toHaveCount(0, "Successful body-retention policy is not a problem bullet.");
                await expect(card(name)).not.toContainText("Response body excluded from retention");
            }
            await expect(card("hosted").locator(".recorded-category-label")).toHaveText("Operations:");
            await expect(card("hosted").locator(".request-card-categories")).toContainText("Search and retrieval");
            await expect(card("hosted").locator(".request-card-categories")).toContainText("Asked Copilot");
            await expect(card("hosted").locator('[data-service="Files"],[data-service="Mail"],[data-service="Teams"]')).toHaveCount(0);
            await expect(card("mixed").locator(".request-card-categories")).toContainText("Files");
            await expect(card("mixed").locator(".request-card-reason-text")).toHaveText("Payload too large; downloads are limited to 4 MB.");
            await expect(card("mixed").locator(".result-status")).toHaveText("Call #3 failed");
            await expect(page.locator("#activityList")).not.toContainText("Some service details unavailable");
            await expect(page.locator('[data-service-basis="Unknown"] .percentage-label')).toHaveText("Services not fully identified");
            await expect(page.locator(".percentage-gap-list")).toHaveAttribute("aria-label", "Service attribution limits");
            await expect(page.locator('[data-service-basis="Assistance"]')).toHaveAttribute("data-count", "4");
            await expect(page.locator('[data-service-basis="Search"]')).toHaveAttribute("data-count", "5");
            await expect(page.locator('[data-service-basis="Unknown"]')).toHaveAttribute("data-count", "3");
            await expect(page.locator('.percentage-content .percentage-service-scope')).toHaveText(
                "Search and Copilot rows count requests, not confirmed use of particular apps.");
            const paint = await card("unclassified").evaluate(node => ({
                note: getComputedStyle(node.querySelector(".service-availability")).color,
                muted: getComputedStyle(node.querySelector(".request-card-summary")).color,
                failure: getComputedStyle(document.querySelector('[data-view-key="request:attribution-mixed"] .result-status')).color,
            }));
            assert.equal(paint.note, paint.muted); assert.notEqual(paint.note, paint.failure);
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
            const context = page.locator('[data-reader-section="activity"] .reader-operation-context');
            await expect(context).toBeVisible();
            await expect(context).toHaveCount(1);
            await expect(context).toContainText("Calls #1\u20132 (Search and retrieval, Asked Copilot)");
            await expect(context).toContainText("not confirmed app use");
            await expect(context).toContainText("operation counts");
            await expect(context).toContainText("this limit alone needs no action");
            assert.equal(await context.evaluate(node => node.closest(".technical-detail,button") === null), true);
            await expect(page.locator('[data-attribution-kind="operation"]')).toHaveCount(0);
            await expect(assistance.locator(".call-reason-list")).toHaveCount(0);
        }
        await assistance.locator(".reader-call-identity-line").scrollIntoViewIfNeeded();
        if (proof) await page.screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-hosted-reader.png`) });
        if (phase !== "before") {
            await assistance.locator(".reader-call-toggle").click();
            await expect(assistance.locator(".technical-detail")).toContainText("Response bodies are excluded from activity retention.");
            await expect(assistance.locator(".technical-detail")).not.toContainText("counts this call as Asked Copilot");
            await assistance.locator(".reader-call-toggle").click();
        }
        await page.keyboard.press("Escape"); await expect(card("hosted")).toBeFocused();
        await card("mixed").click(); await settle();
        const failure = page.locator('[data-tool-call-id="mixed-2"]');
        await failure.locator(".reader-call-summary").scrollIntoViewIfNeeded();
        await expect(failure).toContainText("Payload too large; downloads are limited to 4 MB.");
        if (phase !== "before") {
            await expect(failure.locator(".service-availability")).toHaveCount(0, "The actual failed Files call has an identified service.");
            await expect(page.locator('[data-reader-section="activity"] .reader-operation-context')).toContainText(
                "Input files (Call #2) provide context, not app-use evidence.");
        }
        if (proof) await page.screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-mixed-reader.png`) });
        assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
        await page.keyboard.press("Escape"); await expect(card("mixed")).toBeFocused();
        await card("batch").click(); await settle();
        if (phase !== "before") {
            const batch = page.locator('[data-tool-call-id="batch-0"]');
            await expect(batch.locator(".api-result-entry")).toContainText("Returned target not identified");
            await expect(batch.locator(".api-result-entry")).toContainText("Not attributed to a target in this batch");
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
            await expect(card(name).locator(".service-availability")).toHaveText(label);
            await expect(call.locator(".service-availability")).toHaveCount(0);
            await expect(call.locator(".reader-attribution-context")).toBeVisible();
            await expect(page.locator('[data-reader-section="activity"] .reader-operation-context')).toHaveCount(0);
            await expect(call.locator(".reader-attribution-context")).toContainText(
                name === "missing" ? "source omission or a capture problem" : name === "unclassified" ? "cannot classify" : "cannot interpret");
            await expect(call.locator(".reader-attribution-context")).toContainText("service counts");
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
            await expect(page.locator('[data-view-key="percentage:services:exact"] .percentage-note')).toContainText("All selected records remain in the denominator.");
            await settle();
            if (proof) await page.screenshot({ path: path.join(proof, `${phase}-${theme}-detail-unreadable.png`) });
            await page.keyboard.press("Escape"); await settle();
        }
    }
    if (proof) await writeFile(path.join(proof, phase + "-observations.json"), JSON.stringify(observations, null, 2));
});

test("routine operation explanations appear once per interaction without merging call evidence", { timeout: 60000 }, async t => {
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
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, evidence);
    const before = await loadBoardState(context), errors = [], denied = [];
    const start = process.env.WIRE_EVIDENCE_BASELINE
        ? (await import(pathToFileURL(path.join(process.env.WIRE_EVIDENCE_BASELINE, "lib", "server.mjs")))).startServer : startServer;
    const runtime = await start(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "no-preference" });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key]);
        } finally { for (const fn of cleanup) await fn(); }
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET" || [
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
        ].includes(url.pathname))) return route.continue();
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
        for (const [id, scope, count] of [["op-two", "Calls #1\u20132", 2], ["op-three", "Calls #1\u20133", 3],
            ["op-long", "Calls #1\u20139", 9], ["op-mixed", "Calls #1\u20132, #4", 4]]) {
            const card = page.locator(`.request-card-open[href*="${id}"]`);
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
                await expect(activity.locator('.reader-operation-context, [data-attribution-kind="operation"]')).toHaveCount(1,
                    "The ordinary reading explanation must not repeat as more routine calls are displayed.");
                const note = activity.locator(".reader-operation-context");
                await expect(note).toHaveCount(1);
                await expect(note).toHaveAttribute("data-context-group", id);
                await expect(note).toContainText(scope);
                await expect(note).toContainText("not confirmed app use");
                await expect(note).toContainText("operation counts");
                await expect(note).toContainText("needs no action");
                await expect(note).not.toContainText("history repair");
                await expect(activity.locator('.reader-attribution-context[data-attribution-kind="operation"]')).toHaveCount(0);
                await expect(activity.locator(".reader-call-row")).toHaveCount(count);
                if (id === "op-mixed") {
                    await expect(note).toContainText("Input files (Call #2) provide context");
                    await expect(activity.locator('[data-tool-call-id="op-mixed-2"]')).toContainText("Payload too large; downloads are limited to 4 MB.");
                    await expect(activity.locator('[data-tool-call-id="op-mixed-2"] .reader-entry-label')).toHaveText("Call #3");
                }
                const scopeText = await note.innerText();
                assert.ok(scopeText.length < 350, scopeText);
                observations.at(-1).scopeText = scopeText;
            }
            await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop = 0);
            if (proof) await page.screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-${id}.png`) });
            assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
            if (phase !== "before" && id === "op-three") {
                const all = page.locator("#requestContent .reader-operation-context");
                await expect(all).toHaveCount(3, "Linked prompt groups retain separate scopes instead of one cross-interaction definition.");
                await expect(all.filter({ hasText: "Calls #1\u20132" })).toHaveAttribute("data-context-group", "op-two");
                await expect(all.filter({ hasText: "Calls #1\u20139" })).toHaveAttribute("data-context-group", "op-long");
                if (width === 1440) {
                    const source = page.locator('[data-reader-section="source"] > .reader-section-heading .reader-section-toggle');
                    if (await source.getAttribute("aria-expanded") !== "true") await source.click();
                    await expect(source).toHaveAttribute("aria-expanded", "true"); await settle();
                    const linked = page.locator(".reader-linked-context");
                    if (!await linked.evaluate(node => node.open)) await linked.locator(":scope > summary").click();
                    await settle();
                    const earlier = all.filter({ hasText: "Calls #1\u20132" });
                    await expect(earlier).toBeVisible();
                    assert.equal(await earlier.evaluate(node => node.closest('[data-context-group="op-two"]').dataset.contextGroup), "op-two");
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
        await page.locator('.request-card-open[href*="op-mixed"]').click();
        await expect(page.locator("#requestContent .reader-scope")).toContainText("2 of 4");
        const note = page.locator('[data-reader-section="activity"] .reader-operation-context');
        await expect(note).toContainText("Calls #1\u20132, #4");
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
        await expect(card("missing")).toContainText("Service target not recorded");
        await expect(card("unclassified")).toContainText("Recorded path not recognized");
        await expect(card("partial")).toContainText("Mail");
        await expect(card("partial")).toContainText("Recorded path not recognized");
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
        const cue = card("copilot").locator("[data-service-icon=Assistance]");
        if (proof) await card("copilot").screenshot({ path: path.join(proof, `vocabulary-${phase}-${theme}-${width}-card.png`) });
        const cueStyle = await cue.evaluate(node => {
            const style = getComputedStyle(node), root = getComputedStyle(document.documentElement);
            const icon = node.querySelector(".wire-icon"), range = document.createRange(); range.selectNodeContents(node.querySelector("span"));
            const first = range.getClientRects()[0], rect = icon.getBoundingClientRect();
            return { color: style.color, muted: root.getPropertyValue("--muted").trim(), failure: root.getPropertyValue("--chart-failure").trim(),
                success: root.getPropertyValue("--chart-success").trim(), card: getComputedStyle(node.closest(".activity-card")).backgroundColor,
                paper: root.getPropertyValue("--paper").trim(), context: root.getPropertyValue("--context-paper").trim(), iconHeight: rect.height, lineHeight: parseFloat(style.lineHeight),
                centerOffset: Math.abs(rect.y + rect.height / 2 - first.y - first.height / 2) };
        });
        if (phase !== "before") {
            assert.ok(contrast(cueStyle.color, cueStyle.paper) >= 4.5);
            assert.ok(contrast(cueStyle.color, cueStyle.context) >= 4.5);
            assert.ok(contrast(cueStyle.color, cueStyle.muted) > 1.05, "Assistance must not remain unknown grey");
            assert.notDeepEqual(rgb(cueStyle.color), rgb(cueStyle.failure)); assert.notDeepEqual(rgb(cueStyle.color), rgb(cueStyle.success));
            assert.ok(cueStyle.centerOffset <= 1.5, JSON.stringify(cueStyle));
            await card("copilot").hover();
            assert.equal(await cue.evaluate(node => getComputedStyle(node).color), cueStyle.color);
            await card("copilot").focus();
            assert.equal(await cue.evaluate(node => getComputedStyle(node).color), cueStyle.color);
            const legend = page.locator('.percentage-legend-row[data-service-basis="Assistance"] .percentage-cue');
            assert.equal(await legend.evaluate(node => getComputedStyle(node).color), cueStyle.color);
        }
        await card("copilot").click();
        const readerCue = page.locator("#requestContent [data-service-icon=Assistance]");
        if (phase !== "before") {
            assert.equal(await readerCue.evaluate(node => getComputedStyle(node).color), cueStyle.color);
            await expect(page.locator("#requestContent .reader-operation-context")).toContainText("Call #1 (Asked Copilot) records a request");
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
