import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";

const proofs = process.env.WIRE_CARD_PROOFS;
const longPrompt = "Please revise the workshop checklist without adding new sections or changing its scope. Several steps repeat or conflict: equipment checks must finish before the room opens. Preserve the remaining notes and confirm each correction.";
const shortPrompt = "Where did the workshop preparation stop? Continue checking the remaining equipment and explain what is still needed before opening.";

function records() {
    return Array.from({ length: 8 }, (_, index) => {
        const record = fixture("card-clarity-" + index);
        record.userPrompt = { text: index === 1 ? "" : index === 0 ? shortPrompt : longPrompt,
            status: "full", authorship: { actor: index === 0 ? "user" : "agent", basis: index === 0 ? "source-user" : "autopilot" },
            sourceEventId: "prompt-" + index, sourceTimestamp: new Date(Date.UTC(2026, 9, 18, 12, 8 - index)).toISOString() };
        record.followUpPrompts = index === 1 ? [{ ...record.userPrompt, sourceEventId: "empty-follow-up" }] : [];
        record.toolCalls = Array.from({ length: index === 2 ? 6 : 1 }, (_, call) => ({
            tool: index === 1 ? "workiq-retrieve" : "workiq-fetch",
            toolCallId: "clarity-call-" + index + "-" + call, startEventId: "clarity-start-" + index + "-" + call,
            startedAt: record.userPrompt.sourceTimestamp,
            requestArgs: index === 1 ? { query: "SYNTHETIC_ARGUMENT_NOT_A_PROMPT" }
                : { entityUrls: [index === 0 ? "/me/messages/synthetic-message"
                    : index === 2 && call >= 4 ? "/teams/synthetic-team/channels"
                        : index === 3 ? "/me/people" : "/me/drive/items/synthetic-file"] },
            reportedOutcome: index < 2 || call > 2 ? "failed" : "succeeded",
            toolSucceeded: !(index < 2 || call > 2), apiResults: [],
            ...index < 2 || call > 2 ? { failureEvidence: { version: 1, reason: "error-code-recorded", code: "failure",
                messageStatus: "text-excluded", messageSignal: call === 3 ? "access-denial"
                    : call === 4 ? "request-timeout" : "workiq-sign-in-required" } } : {},
        }));
        return record;
    });
}

async function setup(t, evidence = records(), { start = startServer } = {}) {
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, evidence);
    const before = await loadBoardState(context);
    const runtime = await start(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    const errors = [], denied = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET" || [
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary",
        ].includes(url.pathname))) return route.continue();
        denied.push(url.pathname); return route.abort();
    });
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
            const after = await loadBoardState(context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
        } finally { for (const fn of cleanup) await fn(); }
    });
    const snapshot = page.waitForResponse(response => new URL(response.url()).pathname === "/api/snapshot" && response.ok());
    await page.goto(runtime.url + "#analyze");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    return { page, revision: (await (await snapshot).json()).revision };
}

async function measure(page) {
    return page.locator(".request-card-open").evaluateAll(nodes => nodes.map(node => {
        const prompt = node.querySelector(".request-card-prompt"), style = getComputedStyle(prompt);
        const range = document.createRange(); range.selectNodeContents(prompt);
        const box = prompt.getBoundingClientRect();
        const lines = [...new Set([...range.getClientRects()].filter(rect => rect.height > 0 && rect.y < box.bottom)
            .map(rect => Math.round(rect.y)))];
        const card = node.getBoundingClientRect();
        return { card: card.toJSON(), prompt: box.toJSON(), lines: lines.length,
            font: style.fontFamily, fontSize: style.fontSize, lineHeight: style.lineHeight,
            weight: style.fontWeight,
            origin: node.querySelector(".request-card-origin").getBoundingClientRect().toJSON(),
            categories: node.querySelector(".request-card-categories").getBoundingClientRect().toJSON(),
            problem: node.querySelector(".request-card-problem").getBoundingClientRect().toJSON(),
            more: node.querySelector(".request-card-more-problems")?.getBoundingClientRect().toJSON() ?? null,
            metadata: node.querySelector(".request-card-summary").getBoundingClientRect().toJSON(),
            authors: [...node.querySelectorAll(".request-card-author")].flatMap(n => [...n.getClientRects()].map(r => r.toJSON())),
            time: node.querySelector(".request-card-time").getBoundingClientRect().toJSON(),
            text: prompt.textContent };
    }));
}

async function capture(page, name, metrics) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await page.mouse.move(0, 0);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: path.join(proofs, name + "-page.png"), fullPage: true });
    const clip = await page.locator("#activityList").evaluate(node => {
        const rect = node.getBoundingClientRect();
        return { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height };
    });
    await page.screenshot({ path: path.join(proofs, name + "-list.png"), fullPage: true, clip });
    if (await page.locator("#contextSidebar").isVisible()) {
        await page.locator("#contextSidebar").screenshot({ path: path.join(proofs, name + "-reader.png") });
    }

    await writeFile(path.join(proofs, name + ".json"), JSON.stringify(metrics, null, 2));
}

test("Activity gives origin, prompt, labelled services and meaningful problems distinct regions", async t => {
    const { page } = await setup(t);
    const first = page.locator('.request-card-open[href*="card-clarity-0"]');
    await expect(first.locator(".request-card-origin")).toHaveText("My prompt");
    await expect(first.locator(".request-card-categories")).toContainText("Service:");
    await expect(first.locator(".request-card-categories")).toContainText("Mail");
    await expect(first.locator(".request-card-problem")).toContainText("Work IQ required sign-in at the time");
    const mixed = page.locator('.request-card-open[href*="card-clarity-2"]');
    await expect(mixed.locator(".request-card-categories")).toContainText("Services:");
    await expect(mixed.locator(".request-card-categories .service-label-list > li")).toHaveCount(2);
    await expect(mixed.locator(".request-card-problem")).toContainText("Access was denied");
    await expect(mixed.locator(".request-card-problem")).toContainText("The tool did not respond in time");
    await expect(mixed.locator(".request-card-problem")).toContainText("Work IQ required sign-in at the time");
    await expect(mixed.locator(".request-card-reason")).toHaveCount(3);
    await expect(mixed.locator(".request-card-more-problems")).toHaveCount(0);
    await expect(first.locator(".request-card-more-problems")).toHaveCount(0);
    await expect(mixed.locator("button,input,a")).toHaveCount(0);
    const geometry = await mixed.evaluate(card => {
        const box = selector => card.querySelector(selector).getBoundingClientRect().toJSON();
        return { origin: box(".request-card-origin"), prompt: box(".request-card-prompt"),
            categories: box(".request-card-categories"), result: box(".request-card-problem"),
            metadata: box(".request-card-summary") };
    });
    assert.ok(geometry.prompt.top >= geometry.origin.bottom + 7);
    assert.ok(geometry.categories.top >= geometry.prompt.bottom + 15);
    assert.ok(geometry.result.top >= geometry.categories.bottom + 15);
    assert.ok(geometry.metadata.top >= geometry.result.bottom + 11);
});

test("Card reasons follow the same retained chronology as native first-failure entry", async t => {
    const record = records()[2];
    for (const [index, seconds] of [[3, 30], [4, 10], [5, 20]]) {
        record.toolCalls[index].startedAt = new Date(Date.parse(record.userPrompt.sourceTimestamp) + seconds * 1000).toISOString();
    }
    const { page } = await setup(t, [record]);
    const card = page.locator(".request-card-open");
    const problem = await card.locator(".request-card-problem").textContent();
    assert.ok(problem.indexOf("The tool did not respond in time") < problem.indexOf("Work IQ required sign-in at the time"));
    assert.ok(problem.indexOf("Work IQ required sign-in at the time") < problem.indexOf("Access was denied"));
    await expect(card.locator(".request-card-more-problems")).toHaveCount(0);
    await card.click();
    await expect(page.locator('[data-tool-call-id="clarity-call-2-4"]')).toBeFocused();
    await expect(page.locator('[data-tool-call-id="clarity-call-2-3"]')).toContainText("Access was denied");
});

test("Read more starts at the actual reader top after motion without changing ordinary saved reading positions", { timeout: 90000 }, async t => {
    const evidence = ["top-first", "top-second", "top-ordinary"].map((id, index) => {
        const record = records()[2];
        record.scenarioId = id;
        record.followUpPrompts = [];
        record.userPrompt = { ...record.userPrompt, sourceEventId: id + "-prompt",
            text: index === 2 ? "Inspect the recorded workshop calls."
                : `Read the ${index === 0 ? "first" : "second"} workshop preparation notes. `
                    + "Keep each original planning detail with the task it describes. ".repeat(30) };
        record.toolCalls = (index === 2 ? record.toolCalls : record.toolCalls.slice(3, 4)).map((call, offset) => ({ ...call, toolCallId: id + "-call-" + offset,
            startEventId: id + "-start-" + offset }));
        return record;
    });
    const { page } = await setup(t, evidence);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const phase = process.env.WIRE_READER_TOP_PHASE ?? "after", proof = process.env.WIRE_READER_TOP_PROOFS, measurements = [];
    if (proof) await mkdir(proof, { recursive: true });
    const body = page.locator("#contextSidebarBody");
    const settle = async () => {
        await page.waitForFunction(() => !document.documentElement.getAnimations({ subtree: true })
            .some(animation => animation.playState === "running" && Number.isFinite(animation.effect.getComputedTiming().iterations)));
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const close = async () => {
        await page.keyboard.press("Escape");
        await expect(page.locator("#contextSidebar")).not.toBeVisible();
        await settle();
    };
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [768, 1], [390, 2]]) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => document.documentElement.style.fontSize = "100%");
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => scrollTo(0, 0));
        await settle();
        for (const [visit, id, input] of [
            ["first", "top-first", "pointer"], ["same", "top-first", "keyboard"],
            ["another", "top-second", "pointer"], ["return", "top-first", "keyboard"],
        ]) {
            const card = page.locator(`.request-card-open[href*="${id}"]`);
            const more = card.locator(".request-card-read-more");
            await expect(more).toBeVisible();
            await more.scrollIntoViewIfNeeded();
            await card.focus();
            await settle();
            const pageBefore = await page.evaluate(() => scrollY);
            const anchorBefore = await card.evaluate(node => ({ top: node.getBoundingClientRect().top,
                documentTop: node.getBoundingClientRect().top + scrollY,
                headerHeight: document.querySelector(".app-header").getBoundingClientRect().height }));
            if (input === "pointer") {
                const box = await more.boundingBox();
                await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            } else await page.keyboard.press("Enter");
            await expect(page.locator("#contextSidebar")).toBeVisible();
            await settle();
            const measurement = await body.evaluate(node => {
                const promptHeading = node.querySelector('[data-reader-section="prompt"] .reader-section-heading');
                const viewport = node.getBoundingClientRect(), first = promptHeading.getBoundingClientRect();
                return { scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, viewportHeight: node.clientHeight,
                    viewportTop: viewport.top, firstContentTop: first.top, firstContentBottom: first.bottom,
                    focusIsOriginal: document.activeElement === node.querySelector('[data-reader-section="prompt"] .full-text-content') };
            });
            measurements.push({ theme, width, scale, visit, input, ...measurement });
            if (proof) {
                await writeFile(path.join(proof, phase + "-positions.json"), JSON.stringify(measurements, null, 2));
                if (visit === "first" || visit === "same") await page.screenshot({
                    path: path.join(proof, `${phase}-${theme}-${width}-${visit}.png`),
                });
            }
            if (phase !== "before") {
                assert.equal(measurement.scrollTop, 0, JSON.stringify(measurements.at(-1)));
                assert.ok(measurement.firstContentTop >= measurement.viewportTop);
                assert.ok(measurement.firstContentBottom <= measurement.viewportTop + measurement.viewportHeight);
                assert.equal(measurement.focusIsOriginal, true);
                await settle();
                assert.equal(await body.evaluate(node => node.scrollTop), 0, "Focus and settled layout must not move the reset reader.");
            }
            const expandPrompt = body.getByRole("button", { name: "Show full prompt", exact: true });
            if (await expandPrompt.isVisible()) await expandPrompt.click();
            await body.evaluate(node => node.scrollTop = node.scrollHeight - node.clientHeight);
            assert.ok(await body.evaluate(node => node.scrollTop) > 0, "The next entry must override a genuinely scrolled reader.");
            await close();
            await expect(card).toBeFocused();
            const pageAfter = await page.evaluate(() => scrollY);
            const anchorAfter = await card.evaluate(node => ({ top: node.getBoundingClientRect().top,
                documentTop: node.getBoundingClientRect().top + scrollY,
                headerHeight: document.querySelector(".app-header").getBoundingClientRect().height }));
            Object.assign(measurements.at(-1), { pageBefore, pageAfter, anchorBefore, anchorAfter });
            if (proof) await writeFile(path.join(proof, phase + "-positions.json"), JSON.stringify(measurements, null, 2));
            if (phase !== "before") assert.ok(Math.abs(anchorAfter.top - anchorBefore.top) <= 1,
                "Closing preserves the card's visible reading position across page reflow: " + JSON.stringify(measurements.at(-1)));
        }
    }
    if (phase !== "before") {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => document.documentElement.style.fontSize = "100%");
        const first = page.locator('.request-card-open[href*="top-first"] .request-card-read-more');
        await first.click();
        await settle();
        for (const [visit, more] of [
            ["same-open", first],
            ["another-open", page.locator('.request-card-open[href*="top-second"] .request-card-read-more')],
        ]) {
            await body.evaluate(node => node.scrollTop = node.scrollHeight - node.clientHeight);
            await more.click();
            await settle();
            const top = await body.evaluate(node => node.scrollTop);
            assert.equal(top, 0, visit + " must reset an already open reader.");
            await expect(page.locator('[data-reader-section="prompt"] .full-text-content')).toBeFocused();
            measurements.push({ theme: "dark", width: 1440, scale: 1, visit, input: "pointer", scrollTop: top });
        }
        await close();
        const ordinary = page.locator('.request-card-open[href*="top-ordinary"]');
        await expect(ordinary.locator(".request-card-read-more")).toBeHidden();
        await ordinary.click();
        await settle();
        await body.evaluate(node => node.scrollTop = node.scrollHeight - node.clientHeight);
        const saved = await body.evaluate(node => node.scrollTop);
        assert.ok(saved > 0);
        await close();
        await ordinary.click();
        await settle();
        assert.equal(await body.evaluate(node => node.scrollTop), saved, "Ordinary non-Read-more entry keeps its saved reading position.");
        if (proof) await writeFile(path.join(proof, phase + "-positions.json"), JSON.stringify({
            entries: measurements, ordinarySavedPosition: saved, ordinaryRestoredPosition: await body.evaluate(node => node.scrollTop),
        }, null, 2));
    }
});

test("card previews use real line space and Read more opens the prompt while coverage stays outside failure bullets", { timeout: 90000 }, async t => {
    const identifier = "13579bdf-2468-4ace-9bdf-0123456789ab";
    const opening = `You own the workshop reference pack under rehearsal coordinator${identifier}. This is a standalone preparation task. `;
    const fitting = opening + "Read the available briefing notes, preserve the existing schedule, and identify the files needed by the rehearsal team before preparing the handout.";
    const long = "You are checking the workshop notes and the returned search results for the rehearsal team. "
        + "Start with the handout index and identify the latest briefing pack for the equipment demonstration. "
        + "Compare the room checklist with the preparation schedule and note any conflicting setup times. "
        + "Separate the documents that can be downloaded from the references that only provide a summary. "
        + "For each reference, preserve the recorded title and explain which rehearsal question it answers. "
        + "Do not treat a missing attachment as evidence that the planning team did not prepare it. "
        + "Check whether the facilitator notes include the accessibility arrangements and the equipment handover. "
        + "Keep the original workshop scope: this is a review of existing material, not a request to rewrite it. "
        + "List any unresolved dependencies beside the corresponding preparation step rather than adding another summary. "
        + "If a recorded request returned an error, identify that request and keep its returned results separate. "
        + "Finish by stating which files are ready for the rehearsal team and which references could not be read. "
        + "FINAL ORIGINAL INSTRUCTION: leave the retained notes unchanged.";
    const diagnostic = text => ({ version: 1, status: "recorded", source: "workiq-error-json", message: text });
    const record = (id, text, total, failedIndex) => {
        const value = records()[0];
        value.scenarioId = id;
        value.userPrompt = { ...value.userPrompt, text, sourceEventId: id + "-prompt",
            authorship: { actor: "agent", basis: "source-agent" } };
        value.toolCalls = Array.from({ length: total }, (_, index) => ({
            tool: "workiq-fetch", toolCallId: `${id}-${index}`, startEventId: `${id}-start-${index}`,
            startedAt: new Date(Date.parse(value.userPrompt.sourceTimestamp) + index * 1000).toISOString(),
            requestArgs: { entityUrls: ["/me/drive/items/invented-handout"] },
            toolSucceeded: index !== failedIndex, reportedOutcome: index === failedIndex ? "failed" : "succeeded",
            apiResults: [], ...(index === failedIndex ? { failureEvidence: { version: 1,
                diagnostic: diagnostic("Payload too large; downloads are limited to 4 MB.") } } : {}),
        }));
        return value;
    };
    const download = record("readable-download", fitting, 5, 2), partial = record("readable-partial", long, 15, 8);
    partial.toolCalls[8].failureEvidence = { version: 1, code: "failure" };
    partial.toolCalls[8].resultEvidence = { version: 1, contentStatus: "partial", resultCount: null };
    const message = "The supplied comparison is not supported in this filter query.";
    partial.toolCalls[8].apiResults = [0, 1, 2].map(index => ({ index, statusCode: index < 2 ? 400 : 200,
        ...(index < 2 ? { errorCode: "BadRequest", errorDiagnostic: diagnostic(message) } : {}) }));
    const baseline = process.env.WIRE_READABLE_BASELINE;
    const start = baseline ? (await import(pathToFileURL(path.join(baseline, "lib", "server.mjs")).href)).startServer : startServer;
    const { page } = await setup(t, [download, partial], { start });
    await page.goto(page.url().split("#")[0] + "#analyze?result=failure");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => {
        window.copied = [];
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => window.copied.push(text) } });
    });
    const phase = process.env.WIRE_READABLE_PHASE ?? "after", proof = process.env.WIRE_READABLE_PROOFS, measures = [];
    if (proof) await mkdir(proof, { recursive: true });
    const first = page.locator('.request-card-open[href*="readable-download"]');
    const second = page.locator('.request-card-open[href*="readable-partial"]');
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1920, 1], [1440, 1], [768, 1], [390, 2]]) {
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.evaluate(() => document.documentElement.style.fontSize = "100%");
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1080 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction(() => !document.documentElement.getAnimations({ subtree: true })
            .some(animation => animation.playState === "running" && Number.isFinite(animation.effect.getComputedTiming().iterations)));
        if (phase !== "before") {
            await expect(first.locator(".request-card-prompt")).toHaveText(fitting);
            await expect(second.locator(".request-card-prompt")).toHaveText(long);
            if (theme === "light" && width === 1920) {
                const session = await page.context().newCDPSession(page);
                let accessibleName;
                try {
                    const { root } = await session.send("DOM.getDocument");
                    const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId,
                        selector: '.request-card-open[href*="readable-partial"]' });
                    const { nodes } = await session.send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
                    accessibleName = nodes.find(node => node.role?.value === "link")?.name?.value;
                } finally { await session.detach(); }
                if (process.env.WIRE_ACCESSIBLE_PROOF) await writeFile(process.env.WIRE_ACCESSIBLE_PROOF, JSON.stringify({
                    accessibleName, length: accessibleName?.length, originalPromptLength: long.length,
                    hiddenTailInName: accessibleName?.includes("FINAL ORIGINAL INSTRUCTION"),
                }, null, 2));
                assert.ok(accessibleName?.length < 220, `The actual link name must be concise, not ${accessibleName?.length} characters.`);
                assert.match(accessibleName, /^Read more of prompt: You are checking the workshop notes/);
                assert.ok(!accessibleName.includes("FINAL ORIGINAL INSTRUCTION"), "The hidden original must not be announced as the link's name.");
            }
            for (const card of [first, second]) {
                const prompt = card.locator(".request-card-prompt");
                const geometry = await prompt.evaluate(node => {
                    const css = getComputedStyle(node), box = node.getBoundingClientRect(), lines = new Map();
                    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
                    while (walker.nextNode()) {
                        const range = document.createRange(); range.selectNodeContents(walker.currentNode);
                        for (const rect of range.getClientRects()) if (rect.height && rect.bottom <= box.bottom + 1 && rect.top >= box.top) {
                            const key = Math.round(rect.top), line = lines.get(key) ?? { left: rect.left, right: rect.right };
                            line.left = Math.min(line.left, rect.left); line.right = Math.max(line.right, rect.right);
                            lines.set(key, line);
                        }
                    }
                    const last = [...lines.values()].at(-1);
                    return { width: node.clientWidth, height: node.clientHeight, naturalHeight: node.scrollHeight,
                        lineHeight: parseFloat(css.lineHeight), visibleLines: lines.size,
                        lastLineUse: last ? (last.right - last.left) / node.clientWidth : 0, text: node.textContent };
                });
                const omitted = geometry.naturalHeight > geometry.height + 1;
                await expect(card.locator(".request-card-read-more")).toBeVisible({ visible: omitted });
                await expect(card).toHaveAccessibleName(omitted ? /^Read more of prompt: / : /^View interaction: /);
                assert.equal(await card.locator(".request-card-read-more").evaluate(node => node.closest("a")?.getAttribute("href")),
                    await card.getAttribute("href"), "Read more activates the existing real native link.");
                assert.ok(geometry.height <= geometry.lineHeight * 2 + 1);
                if (omitted) {
                    assert.equal(geometry.visibleLines, 2);
                    assert.ok(geometry.lastLineUse > .6, JSON.stringify(geometry));
                }
                if (width >= 1440 && card === first) assert.equal(omitted, false, "The complete fitting prompt uses available card width.");
                await expect(prompt).not.toContainText("\u2026");
                const typography = await card.evaluate(node => [".result-status", ".call-reason-text"].map(selector => {
                    const css = getComputedStyle(node.querySelector(selector)); return [css.fontFamily, css.fontSize, css.fontWeight];
                }));
                assert.deepEqual(typography[0], typography[1]);
                measures.push({ theme, viewport: width, scale, card: card === first ? "download" : "partial", ...geometry, omitted, typography });
            }
            await expect(second.locator(".call-reason-list > li")).toHaveCount(1);
            await expect(second.locator(".call-reason-list")).not.toContainText(/total.*unknown|part of the response/);
            await expect(second.locator(".returned-coverage")).toContainText("3 returned entries");
            await expect(second.locator(".returned-coverage")).toContainText("total is unknown");
            assert.equal(await second.locator(".returned-coverage").evaluate(node => node.closest("li.call-reason-item") === null), true);
            await expect(second.locator(".result-status")).toHaveText("Call #9 failed");
            await expect(second.locator(".request-card-count")).toHaveText("1 of 15 Work IQ tool calls matches this view");
            await expect(second.locator("a,button,[role=button]")).toHaveCount(0, "Read more belongs to the real card link, not a nested control.");
        }
        if (proof) {
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-page.png`), fullPage: true });
            for (const [name, card] of [["download", first], ["partial", second]]) {
                await card.screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-${name}.png`) });
                if (width === 390 && name === "partial") {
                    await card.locator(".request-card-count").scrollIntoViewIfNeeded();
                    await expect(card.locator(".request-card-count")).toBeInViewport();
                    await page.screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-partial-tail.png`) });
                }
            }
        }
        if (phase !== "before") {
            await expect(second.locator(".request-card-read-more")).toBeVisible();
            await second.focus(); await page.keyboard.press("Enter");
            const original = page.locator('[data-reader-section="prompt"] .full-text-content');
            await expect(original).toBeFocused();
            assert.equal(await original.textContent(), long);
            await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
            assert.equal(await page.evaluate(() => window.copied.at(-1)), long);
            if (proof && [1920, 390].includes(width)) {
                await original.evaluate(node => node.scrollIntoView({ block: "start" }));
                await page.screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-prompt-reader.png`) });
                await original.evaluate(node => node.scrollIntoView({ block: "end" }));
                await page.screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-prompt-tail.png`) });
            }
            const call = page.locator('[data-tool-call-id="readable-partial-8"]');
            await expect(call.locator(".api-result-entry")).toHaveCount(3);
            await expect(call.locator(".returned-coverage")).toHaveCount(1);
            await expect(call.locator(".returned-coverage")).toContainText("3 returned entries");
            const readerType = await call.evaluate(node => [".reader-call-summary .recorded-result-label", ".reader-error-message"].map(selector => {
                const css = getComputedStyle(node.querySelector(selector)); return [css.fontFamily, css.fontSize, css.fontWeight];
            }));
            assert.deepEqual(readerType[0], readerType[1]);
            await call.locator(".reader-call-identity-line").scrollIntoViewIfNeeded();
            if (proof && [1920, 390].includes(width)) await page.screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-result-reader.png`) });
            await page.keyboard.press("Escape"); await expect(second).toBeFocused();
            await second.locator(".request-card-read-more").click();
            await expect(original).toBeFocused();
            await page.keyboard.press("Escape"); await expect(second).toBeFocused();
        } else {
            await second.click();
            if (proof && [1920, 390].includes(width)) await page.screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-result-reader.png`) });
            await page.keyboard.press("Escape");
        }
    }
    if (phase !== "before") {
        await page.setViewportSize({ width: 1920, height: 1080 });
        await page.evaluate(() => document.documentElement.style.fontSize = "100%");
        await expect(first.locator(".request-card-read-more")).toBeHidden();
        await page.setViewportSize({ width: 390, height: 1080 });
        await expect(first.locator(".request-card-read-more")).toBeVisible();
        await page.setViewportSize({ width: 1920, height: 1080 });
        await expect(first.locator(".request-card-read-more")).toBeHidden();
        await page.evaluate(() => {
            window.heldCardPreview = document.querySelector(".request-card-prompt");
            window.heldCardName = window.heldCardPreview.closest("a").getAttributeNode("aria-label");
        });
        await page.goto(page.url().split("#")[0] + "#analyze?result=success");
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        assert.equal(await page.evaluate(() => window.heldCardPreview.textContent), "", "Replaced preview text is retired with its observer.");
        assert.equal(await page.evaluate(() => window.heldCardName.value), "", "Retirement clears the old accessible-name attribute handle.");
    }
    if (proof) await writeFile(path.join(proof, phase + "-measurements.json"), JSON.stringify(measures, null, 2));
});

test("filtered calls own subordinate grouped returned errors without merging calls or losing entry identity", { timeout: 60000 }, async t => {
    const message = "You do not have the required permissions to access this item.";
    const batch = (name, different = false) => {
        const record = records()[0];
        record.scenarioId = "grouped-" + name;
        record.userPrompt = { ...record.userPrompt, sourceEventId: name + "-prompt",
            text: `Review the invented ${name} workshop plans and check which documents can be accessed.` };
        record.toolCalls = Array.from({ length: 6 }, (_, index) => ({
            tool: "workiq-fetch", toolCallId: `${name}-call-${index}`, startEventId: `${name}-start-${index}`,
            startedAt: new Date(Date.parse(record.userPrompt.sourceTimestamp) + index * 1000).toISOString(),
            requestArgs: { entityUrls: ["/planner/tasks/invented-a", "/groups/invented-b"] },
            toolSucceeded: index !== 5, reportedOutcome: index === 5 ? "failed" : "succeeded",
            ...(index === 5 ? { failureEvidence: { version: 1, code: "failure" },
                resultEvidence: { version: 1, resultCount: 5, contentStatus: "body-excluded" } } : {}),
            apiResults: index !== 5 ? [] : Array.from({ length: 5 }, (_, offset) => ({
                index: offset, statusCode: offset < 3 ? 403 : 200, evidenceLevel: "intermediary-reported",
                ...(offset < 3 ? { errorDiagnostic: { version: 1, status: "recorded", source: "workiq-error-json",
                    message: different && offset === 2 ? "This revision is restricted to its owner." : message } } : {}),
            })),
        }));
        return record;
    };
    const primary = batch("permission"), different = batch("different", true), multiple = batch("multiple");
    multiple.toolCalls.push({ ...structuredClone(multiple.toolCalls[5]), toolCallId: "multiple-call-6",
        startEventId: "multiple-start-6", startedAt: new Date(Date.parse(multiple.userPrompt.sourceTimestamp) + 6000).toISOString() });
    const { page, revision } = await setup(t, [primary, different, multiple]);
    await page.goto(page.url().split("#")[0] + "#analyze?result=failure");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => {
        window.copied = [];
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => window.copied.push(value) } });
    });
    const phase = process.env.WIRE_GROUP_PHASE ?? "after", proof = process.env.WIRE_GROUP_PROOFS, measurements = [];
    if (proof) await mkdir(proof, { recursive: true });
    const card = page.locator('.request-card-open[href*="grouped-permission"]');
    let returnedId;
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [390, 2]]) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => document.documentElement.style.fontSize = "100%");
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await page.waitForFunction(() => !document.documentElement.getAnimations({ subtree: true })
            .some(animation => animation.playState === "running" && Number.isFinite(animation.effect.getComputedTiming().iterations)));
        if (phase !== "before") {
            await expect(card.locator(".result-status")).toHaveText("Call #6 failed");
            await expect(card.locator(".request-card-count")).toHaveText("1 of 6 Work IQ tool calls matches this view");
            await expect(card.locator(".call-reason-list > li")).toHaveCount(1);
            await expect(card.locator(".call-reason-list")).toContainText("Returned entries 1\u20133");
            assert.equal((await card.textContent()).split(message).length - 1, 1);
            const geometry = await card.evaluate(node => {
                const status = node.querySelector(".result-status"), list = node.querySelector(".call-reason-list");
                const a = status.getBoundingClientRect(), b = list.getBoundingClientRect();
                return { statusBottom: a.bottom, listTop: b.top, statusLeft: a.left, listLeft: b.left,
                    statusColor: getComputedStyle(status).color, proseColor: getComputedStyle(list).color,
                    listStyle: getComputedStyle(list).listStyleType };
            });
            assert.ok(geometry.listTop >= geometry.statusBottom);
            assert.notEqual(geometry.statusColor, geometry.proseColor);
            assert.equal(geometry.listStyle, "disc");
            measurements.push({ theme, width, scale, ...geometry });
            await expect(page.locator('.request-card-open[href*="grouped-different"] .call-reason-list > li')).toHaveCount(2);
            const groups = page.locator('.request-card-open[href*="grouped-multiple"] .request-card-reason');
            await expect(groups).toHaveCount(2);
            await expect(groups.nth(0).locator(".result-status")).toHaveText("Call #6 failed");
            await expect(groups.nth(1).locator(".result-status")).toHaveText("Call #7 failed");
            for (const group of await groups.all()) await expect(group.locator(".call-reason-list > li")).toHaveCount(1);
        }
        if (proof) {
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-page.png`), fullPage: true });
            for (const name of ["permission", "different", "multiple"]) {
                const target = page.locator(`.request-card-open[href*="grouped-${name}"]`);
                await target.screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-${name}.png`) });
            }
        }
        await card.focus(); await page.keyboard.press("Enter");
        const call = page.locator('[data-tool-call-id="permission-call-5"]');
        await expect(call.locator(".api-result-entry")).toHaveCount(5);
        await page.waitForFunction(() => !document.documentElement.getAnimations({ subtree: true })
            .some(animation => animation.playState === "running" && Number.isFinite(animation.effect.getComputedTiming().iterations)));
        if (phase !== "before") {
            await expect(call.locator(".reader-entry-label")).toHaveText("Call #6");
            if (theme === "light" && width === 1440) await expect(call).toBeFocused();
            await expect(call.locator(".returned-api-entries")).toHaveAttribute("aria-label", "Returned results for Call #6");
            await expect(call.locator(".reader-call-summary")).not.toContainText(message);
            await expect(call.locator(".reader-error-message")).toHaveText([message, message, message]);
            await expect(call.locator(".api-result-entry .recorded-result-label").nth(2)).toContainText("Returned entry 3");
        }
        const ids = await call.locator(".api-result-entry").evaluateAll(nodes => nodes.map(node => node.dataset.resultId));
        assert.equal(new Set(ids).size, 5);
        returnedId = ids[2];
        await call.locator(".reader-call-identity-line").evaluate(node => {
            const body = node.closest("#contextSidebarBody");
            const sticky = body.querySelector('[data-reader-section="activity"] > .reader-section-heading');
            body.scrollTop += node.getBoundingClientRect().top - body.getBoundingClientRect().top
                - (sticky?.getBoundingClientRect().height ?? 0) - 16;
        });
        if (proof) await page.screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-reader.png`) });
        if (proof && width === 390) {
            await call.locator(".api-result-entry").first().locator(".recorded-results").scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-reader-entry.png`) });
        }
        const original = page.locator('[data-reader-section="prompt"] .full-text-content');
        assert.equal(await original.textContent(), primary.userPrompt.text);
        const copy = page.getByRole("button", { name: "Copy prompt", exact: true });
        await copy.scrollIntoViewIfNeeded();
        const beforeCopy = (await page.locator('[data-reader-section="activity"]').boundingBox()).y;
        const box = await copy.boundingBox(); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await expect(copy).toHaveAttribute("data-copy-state", "success");
        assert.equal(await page.evaluate(() => window.copied.at(-1)), primary.userPrompt.text);
        assert.equal((await page.locator('[data-reader-section="activity"]').boundingBox()).y, beforeCopy);
        assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
        await page.keyboard.press("Escape"); await expect(card).toBeFocused();
    }
    if (phase !== "before") {
        const exact = new URL(page.url());
        exact.hash = "#request?" + new URLSearchParams({ request: primary.scenarioId, call: returnedId,
            layer: "reported-api", callRevision: String(revision) });
        await page.goto(exact.href);
        await expect(page.locator("#selectedCall")).toHaveAttribute("data-result-id", returnedId);
        await expect(page.locator("#selectedCall")).toBeFocused();
        await expect(page.locator('[data-tool-call-id="permission-call-5"] .reader-entry-label')).toContainText("Call #6");
        assert.deepEqual(Object.fromEntries(new URLSearchParams(new URL(page.url()).hash.split("?")[1])),
            Object.fromEntries(new URLSearchParams(exact.hash.split("?")[1])));
    }
    if (proof) await writeFile(path.join(proof, phase + "-measurements.json"), JSON.stringify(measurements, null, 2));
});

test("card and reader keep neutral explanations under owning statuses without repeated failure bookkeeping", { timeout: 60000 }, async t => {
    const message = "Payload too large; downloads are limited to 4 MB.";
    const diagnostic = text => ({ version: 1, source: "completion-error", status: "recorded", message: text });
    const download = records()[0];
    download.scenarioId = "hierarchy-download";
    download.userPrompt.text = "Find the workshop reference files and download the briefing pack for the rehearsal.";
    download.toolCalls = ["workiq-retrieve", "workiq-get_schema", "workiq-fetch", "workiq-ask", "workiq-fetch"].map((tool, index) => ({
        tool, toolCallId: `hierarchy-call-${index}`, startEventId: `hierarchy-start-${index}`,
        startedAt: new Date(Date.parse(download.userPrompt.sourceTimestamp) + index * 1000).toISOString(),
        requestArgs: tool === "workiq-fetch" ? { entityUrls: ["/me/drive/items/invented-briefing-pack"] } : { query: "Invented workshop" },
        reportedOutcome: index === 2 ? "failed" : "succeeded", toolSucceeded: index !== 2, apiResults: [],
        ...(index === 2 ? { failureEvidence: { version: 1, diagnostic: diagnostic(message) } }
            : { resultEvidence: { version: 1, contentStatus: "body-excluded", statusCode: 200 } }),
    }));
    const multiple = structuredClone(download);
    multiple.scenarioId = "hierarchy-multiple";
    multiple.userPrompt = { ...download.userPrompt, sourceEventId: "hierarchy-multiple-prompt",
        text: "Check the workshop handouts and the rehearsal schedule before opening the room." };
    multiple.toolCalls = [download.toolCalls[2], download.toolCalls[2]].map((call, index) => ({
        ...call, toolCallId: `hierarchy-multiple-${index}`, startEventId: `hierarchy-multiple-start-${index}`,
        failureEvidence: { version: 1, diagnostic: diagnostic(index ? "The rehearsal schedule is locked." : message) },
    }));
    const returned = structuredClone(download);
    returned.scenarioId = "hierarchy-returned";
    returned.userPrompt = { ...download.userPrompt, sourceEventId: "hierarchy-returned-prompt",
        text: "Fetch the workshop documents and their archived revisions." };
    returned.toolCalls = [{ ...download.toolCalls[4], toolCallId: "hierarchy-returned-call", startEventId: "hierarchy-returned-start",
        resultEvidence: { version: 1, contentStatus: "body-excluded", resultCount: 3 },
        apiResults: [{ index: 0, statusCode: 200 }, { index: 1, statusCode: 403,
            errorDiagnostic: diagnostic("The archived document is restricted.") },
        { index: 2, statusCode: 404, errorDiagnostic: diagnostic("The requested revision is no longer available.") }] }];
    const { page } = await setup(t, [download, multiple, returned]);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => {
        window.copied = [];
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => window.copied.push(text) } });
    });
    const phase = process.env.WIRE_HIERARCHY_PHASE ?? "after", proof = process.env.WIRE_HIERARCHY_PROOFS, measurements = [];
    if (proof) await mkdir(proof, { recursive: true });
    const card = page.locator('.request-card-open[href*="hierarchy-download"]');
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [390, 2]]) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => document.documentElement.style.fontSize = "100%");
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await page.waitForFunction(() => !document.documentElement.getAnimations({ subtree: true })
            .some(animation => animation.playState === "running" && Number.isFinite(animation.effect.getComputedTiming().iterations)));
        if (phase !== "before") {
            await expect(card.locator(".request-card-reason-text")).toHaveText(message);
            await expect(card.locator(".result-status")).toHaveText("Call #3 failed");
            await expect(card.locator(".request-card-problem")).not.toContainText(/1 of 5|Recorded error:/);
            await expect(card.locator(".request-card-count")).toHaveText("5 recorded calls / 4 completed / 1 failed");
            const paint = await card.evaluate(node => {
                const prose = node.querySelector(".request-card-reason-text"), status = node.querySelector(".result-status");
                return { prose: getComputedStyle(prose).color, ink: getComputedStyle(node.querySelector(".request-card-prompt")).color,
                    status: getComputedStyle(status).color, icon: getComputedStyle(status.querySelector(".wire-icon")).color,
                    proseSize: parseFloat(getComputedStyle(prose).fontSize), statusSize: parseFloat(getComputedStyle(status).fontSize),
                    proseTop: prose.getBoundingClientRect().top, statusBottom: status.getBoundingClientRect().bottom };
            });
            assert.equal(paint.prose, paint.ink);
            assert.notEqual(paint.prose, paint.status);
            assert.equal(paint.status, paint.icon);
            assert.equal(paint.proseSize, paint.statusSize);
            assert.ok(paint.proseTop >= paint.statusBottom);
            measurements.push({ theme, width, scale, ...paint });
            const failures = page.locator('.request-card-open[href*="hierarchy-multiple"] .request-card-reason-text');
            await expect(failures).toHaveCount(2);
            await expect(failures.nth(1)).toHaveText("The rehearsal schedule is locked.");
            const entries = page.locator('.request-card-open[href*="hierarchy-returned"] .request-card-reason-text');
            await expect(entries).toContainText("Returned entry 2: The archived document is restricted.");
            await expect(entries).toContainText("Returned entry 3: The requested revision is no longer available.");
        }
        if (proof) {
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-page.png`), fullPage: true });
            await page.mouse.move(0, 0);
            if (width === 390) {
                await card.locator(".request-card-problem").evaluate(node => node.scrollIntoView({ block: "center" }));
                await page.screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-download.png`) });
            } else await card.screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-download.png`) });
            if (width === 1440) for (const name of ["multiple", "returned"]) {
                await page.locator(`.request-card-open[href*="hierarchy-${name}"]`).screenshot({
                    path: path.join(proof, `${phase}-${theme}-${width}-${name}.png`),
                });
            }
        }
        await card.focus(); await page.keyboard.press("Enter");
        const call = page.locator('[data-tool-call-id="hierarchy-call-2"]');
        if (phase !== "before") {
            await expect(call.locator(".result-cause")).toHaveText(message);
            await expect(call.locator(".result-status")).toHaveText("Call #3 failed");
            const colors = await call.locator(".reader-call-summary").evaluate(node => ({
                prose: getComputedStyle(node.querySelector(".result-cause")).color,
                status: getComputedStyle(node.querySelector(".result-status")).color,
            }));
            assert.notEqual(colors.prose, colors.status);
            assert.equal(colors.prose, measurements.at(-1).prose);
        }
        await call.scrollIntoViewIfNeeded();
        if (proof) await page.screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-reader.png`) });
        const copy = page.getByRole("button", { name: "Copy prompt", exact: true });
        await copy.scrollIntoViewIfNeeded();
        const beforeCopy = (await page.locator('[data-reader-section="activity"]').boundingBox()).y;
        const box = await copy.boundingBox(); await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await expect(copy).toHaveAttribute("data-copy-state", "success");
        assert.equal(await page.evaluate(() => window.copied.at(-1)), download.userPrompt.text);
        assert.equal((await page.locator('[data-reader-section="activity"]').boundingBox()).y, beforeCopy);
        assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
        await page.keyboard.press("Escape"); await expect(card).toBeFocused();
        for (const name of ["multiple", "returned"]) {
            await page.locator(`.request-card-open[href*="hierarchy-${name}"]`).click();
            if (name === "returned") {
                const call = page.locator('[data-tool-call-id="hierarchy-returned-call"]');
                if (phase !== "before") {
                    await expect(call.locator(".reader-call-summary .result-cause")).toHaveCount(0);
                    await expect(call.locator(".api-result-entry")).toHaveCount(3);
                    await expect(call.locator(".api-result-entry").nth(1).locator(".recorded-result-label"))
                        .toHaveText("Returned entry 2: Tool-reported HTTP 403");
                    await expect(call.locator(".reader-error-message")).toHaveText([
                        "The archived document is restricted.", "The requested revision is no longer available.",
                    ]);
                    await expect(call).not.toContainText("Recorded error");
                }
                await call.locator(".api-result-entry").nth(1).scrollIntoViewIfNeeded();
            } else {
                await expect(page.locator("#requestContent .reader-call-row")).toHaveCount(2);
                await page.locator("#requestContent .reader-call-row").first().scrollIntoViewIfNeeded();
            }
            if (proof) await page.screenshot({ path: path.join(proof, `${phase}-${theme}-${width}-${name}-reader.png`) });
            await page.keyboard.press("Escape");
            await expect(page.locator("#contextSidebar")).not.toBeVisible();
        }
    }
    if (phase !== "before") {
        await page.route("**/api/snapshot", async route => {
            const response = await route.fetch(), data = await response.json();
            delete data.requestActivity["reported-api"];
            await route.fulfill({ response, json: data });
        });
        await page.goto(page.url().split("#")[0] + "#request?request=hierarchy-returned");
        await page.reload();
        await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
        const fallback = page.locator('[data-tool-call-id="hierarchy-returned-call"]');
        await expect(fallback.locator(".api-result-entry")).toHaveCount(0);
        await expect(fallback.locator(".result-cause")).toContainText("Returned entry 2: The archived document is restricted.");
        await expect(fallback.locator(".result-cause")).toContainText("Returned entry 3: The requested revision is no longer available.");
    }
    if (proof) await writeFile(path.join(proof, phase + "-measurements.json"), JSON.stringify(measurements, null, 2));
});

test("recognized joined UUIDs gain a visible preview gap without inserting text or altering separated originals", { timeout: 60000 }, async t => {
    const uuid = "13579bdf-2468-4ace-9bdf-0123456789ab";
    const cases = [
        ["joined", "Owner" + uuid, 1],
        ["separated", "Owner " + uuid, 0],
        ["newline", "Owner\n" + uuid, 0],
        ["uppercase", "Runner" + uuid.toUpperCase(), 1],
        ["url", "https://example.invalid/Owner" + uuid, 0],
        ["path", "C:\\Records\\Owner" + uuid, 0],
        ["ambiguous", "abc" + uuid, 0],
        ["incomplete", "Owner" + uuid.slice(0, -1), 0],
    ];
    const evidence = cases.map(([name, text], index) => {
        const record = records()[0];
        record.scenarioId = "identifier-" + name;
        record.userPrompt = { ...record.userPrompt, text, sourceEventId: "identifier-prompt-" + name,
            sourceTimestamp: new Date(Date.UTC(2026, 9, 18, 12, 8 - index)).toISOString() };
        record.toolCalls = [{ ...record.toolCalls[0], toolCallId: "identifier-call-" + name,
            startEventId: "identifier-start-" + name, startedAt: record.userPrompt.sourceTimestamp }];
        return record;
    });
    const { page } = await setup(t, evidence);
    await page.evaluate(() => {
        window.copied = [];
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
            writeText: async text => window.copied.push(text),
        } });
    });
    const proof = process.env.WIRE_IDENTIFIER_PROOFS, measurements = [];
    if (proof) await mkdir(proof, { recursive: true });
    const joined = page.locator('.request-card-open[href*="identifier-joined"]');
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [390, 2]]) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => document.documentElement.style.fontSize = "100%");
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        for (const [name, text, count] of cases) {
            const prompt = page.locator(`.request-card-open[href*="identifier-${name}"] .request-card-prompt`);
            await expect(prompt.locator(".text-preview-identifier")).toHaveCount(count);
            assert.equal(await prompt.textContent(), text.replace(/\s+/gu, " "));
            assert.equal(await prompt.evaluate(node => {
                const range = document.createRange(); range.selectNodeContents(node);
                const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
                const text = selection.toString(); selection.removeAllRanges(); return text;
            }), text.replace(/\s+/gu, " "), "Selection still contains the original preview characters only.");
        }
        await joined.scrollIntoViewIfNeeded();
        const geometry = await joined.locator(".text-preview-identifier").evaluate(node => {
            const before = document.createRange(), after = document.createRange(), previous = node.previousSibling;
            before.setStart(previous, previous.length - 1); before.setEnd(previous, previous.length);
            after.setStart(node.firstChild, 0); after.setEnd(node.firstChild, 1);
            const left = before.getBoundingClientRect(), right = after.getBoundingClientRect(), style = getComputedStyle(node);
            return { gap: right.left - left.right, sameLine: Math.abs(left.top - right.top) < 1,
                margin: parseFloat(style.marginInlineStart), fontSize: parseFloat(style.fontSize) };
        });
        assert.equal(geometry.sameLine, true);
        assert.ok(geometry.gap >= geometry.fontSize * .2, JSON.stringify(geometry));
        assert.ok(Math.abs(geometry.gap - geometry.margin) <= 1, JSON.stringify(geometry));
        measurements.push({ theme, width, scale, ...geometry });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        if (proof) {
            await page.mouse.move(0, 0);
            await joined.screenshot({ path: path.join(proof, `${theme}-${width}-${scale}-joined.png`) });
            await page.locator('.request-card-open[href*="identifier-separated"]').screenshot({
                path: path.join(proof, `${theme}-${width}-${scale}-separated.png`),
            });
        }
        await joined.click();
        const original = page.locator('[data-reader-section="prompt"] .full-text-content');
        assert.equal(await original.textContent(), cases[0][1]);
        await expect(original.locator(".text-preview-identifier")).toHaveCount(0);
        await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
        assert.equal(await page.evaluate(() => window.copied.at(-1)), cases[0][1]);
        await page.keyboard.press("Escape");
        await expect(joined).toBeFocused();
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => document.documentElement.style.fontSize = "100%");
    await page.getByRole("link", { name: "Create report", exact: true }).click();
    const preview = page.locator("#reportList .request-card-prompt").filter({ hasText: cases[0][1] });
    await expect(preview.locator(".text-preview-identifier")).toHaveCount(1);
    assert.equal(await preview.textContent(), cases[0][1], "The existing shared preview path uses the same visual-only treatment.");
    if (proof) await writeFile(path.join(proof, "spacing.json"), JSON.stringify(measurements, null, 2));
});

test("all scoped failures stay visible from card to reader with exact prompt copying and deliberate omission", { timeout: 90000 }, async t => {
    const diagnostic = (message, details = []) => ({ version: 1, source: "completion-error", status: "recorded", message, details });
    const record = records()[2];
    record.userPrompt.text = "Coordinate the orchard rehearsal with owner\nrecord-42. "
        + "Keep the checklist literal, including **notes**, <placeholders> and arrows -> that belong to its text. "
        + "Read every remaining instruction before changing the schedule.";
    const parentMessage = "The rehearsal item is locked.";
    const detailMessage = "The retained version is no longer current.";
    const tailMessage = "MCP server 'workiq': MCP request failed: Transport " + "InventedTransportLayer<".repeat(12)
        + " error: HTTP 503 Service Unavailable: upstream connection timeout";
    record.toolCalls = [
        ...record.toolCalls.slice(0, 2).map((call, index) => ({ ...call, resultEvidence: { version: 1,
            contentStatus: "body-excluded", ...(index ? { statusCode: 200 } : {}) } })),
        ...[parentMessage, parentMessage, tailMessage].map((message, index) => ({
            ...record.toolCalls[3], toolCallId: `all-failures-${index}`, startEventId: `all-failures-start-${index}`,
            startedAt: new Date(Date.parse(record.userPrompt.sourceTimestamp) + (index + 2) * 1000).toISOString(),
            failureEvidence: { version: 1, diagnostic: diagnostic(message, index === 0 ? [{ message: detailMessage }] : []) },
        })),
        { ...record.toolCalls[0], toolCallId: "returned-failures", startEventId: "returned-failures-start",
            startedAt: new Date(Date.parse(record.userPrompt.sourceTimestamp) + 5000).toISOString(),
            resultEvidence: { version: 1, contentStatus: "body-excluded", resultCount: 9 },
            apiResults: Array.from({ length: 9 }, (_, index) => ({ index, statusCode: index ? 403 : 200,
                ...(index ? { errorCode: "ItemLocked", errorDiagnostic: diagnostic(`Returned item ${index} cannot be changed.`) } : {}) })),
        },
        { ...record.toolCalls[0], toolCallId: "unknown-result", startEventId: "unknown-result-start",
            startedAt: new Date(Date.parse(record.userPrompt.sourceTimestamp) + 6000).toISOString(),
            reportedOutcome: "unknown", toolSucceeded: null },
    ];
    const late = structuredClone(record);
    late.scenarioId = "late-failure";
    late.userPrompt = { ...record.userPrompt, sourceEventId: "late-prompt", text: "Ownerrecord-42 kept this literal joined source text. "
        + "Review the recorded work without inserting source words or guessing a separator. "
        + "Continue through the complete original after opening its reader." };
    late.toolCalls = [...record.toolCalls.slice(0, 2), ...record.toolCalls.slice(0, 2), record.toolCalls[2]]
        .map((call, index) => ({ ...call, toolCallId: `late-${index}`, startEventId: `late-start-${index}`,
            startedAt: new Date(Date.parse(record.userPrompt.sourceTimestamp) + index * 1000).toISOString() }));
    const { page } = await setup(t, [record, late]);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.evaluate(() => {
        window.copied = [];
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
            writeText: async text => window.copied.push(text),
        } });
    });
    const card = page.locator(`.request-card-open[href*="${record.scenarioId}"]`);
    const lateCard = page.locator('.request-card-open[href*="late-failure"]');
    const proof = process.env.WIRE_CARD_TEXT_PROOFS;
    if (proof) await mkdir(proof, { recursive: true });
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [768, 1], [390, 2]]) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => document.documentElement.style.fontSize = "100%");
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await expect(card.locator(".request-card-prompt")).toContainText("owner record-42");
        await expect(lateCard.locator(".request-card-prompt")).toContainText("Ownerrecord-42");
        await expect(lateCard.locator(".request-card-prompt")).not.toContainText("Owner record-42");
        assert.equal(await card.locator(".request-card-prompt").textContent(), record.userPrompt.text.replace(/\s+/gu, " "));
        await expect(card.locator(".request-card-prompt")).not.toContainText("...");
        const reasons = card.locator(".request-card-reason");
        await expect(reasons).toHaveCount(4);
        await expect(reasons.nth(0).locator(".result-status")).toHaveText("Call #3 failed");
        await expect(reasons.nth(0).locator(".request-card-reason-text")).toContainText(parentMessage);
        await expect(reasons.nth(0)).toContainText(detailMessage);
        await expect(reasons.nth(1).locator(".result-status")).toHaveText("Call #4 failed");
        await expect(reasons.nth(1).locator(".request-card-reason-text")).toHaveText(parentMessage);
        await expect(reasons.nth(2)).toContainText("Transport ... error: HTTP 503 Service Unavailable: upstream connection timeout");
        await expect(reasons.nth(3).locator(".result-status")).toHaveText("Call #6 completed");
        for (let index = 1; index < 9; index++) await expect(reasons.nth(3)).toContainText(`Returned item ${index} cannot be changed.`);
        await expect(card).not.toContainText(/more failure|more returned errors|response body excluded|reported status 200/);
        await expect(lateCard.locator(".request-card-count")).toHaveText("5 recorded calls / 4 completed / 1 failed");
        await expect(lateCard.locator(".result-status")).toHaveText("Call #5 failed");
        await expect(lateCard).not.toContainText(/more failure|response body excluded|reported status 200/);
        const colors = await reasons.evaluateAll(nodes => nodes.map(node => ({
            text: getComputedStyle(node.querySelector(".request-card-reason-text")).color,
            status: getComputedStyle(node.querySelector(".result-status")).color,
            icon: getComputedStyle(node.querySelector(".wire-icon")).color,
        })));
        assert.equal(colors[0].status, colors[0].icon);
        assert.notEqual(colors[0].text, colors[0].status);
        assert.equal(colors[3].text, colors[0].text, "All explanation prose uses neutral primary ink.");
        assert.notEqual(colors[3].status, colors[0].status, "Returned API errors do not paint successful execution as a failed tool.");
        await card.scrollIntoViewIfNeeded();
        await page.mouse.move(0, 0);
        if (proof) {
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: path.join(proof, `${theme}-${width}-${scale}-page.png`), fullPage: true });
            await card.evaluate(node => {
                node.scrollIntoView({ block: "start" });
                scrollBy(0, -document.querySelector(".app-header").getBoundingClientRect().height - 16);
            });
            if (width === 390) {
                await page.screenshot({ path: path.join(proof, `${theme}-${width}-${scale}-card.png`) });
                await card.locator(".request-card-summary").evaluate(node => node.scrollIntoView({ block: "end" }));
                await page.screenshot({ path: path.join(proof, `${theme}-${width}-${scale}-card-tail.png`) });
            } else await card.screenshot({ path: path.join(proof, `${theme}-${width}-${scale}-card.png`) });
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        await card.focus();
        await page.keyboard.press("Enter");
        await expect(page.locator("#contextSidebar")).toBeVisible();
        if (theme === "light" && width === 1440) await expect(page.locator('[data-tool-call-id="all-failures-0"]')).toBeFocused();
        const firstFailure = page.locator('[data-tool-call-id="all-failures-0"]');
        await expect(firstFailure.locator(".reader-call-summary")).toContainText(detailMessage);
        await firstFailure.locator(".reader-call-toggle").click();
        await expect(firstFailure.locator(".technical-detail")).toContainText(detailMessage);
        await firstFailure.locator(".reader-call-toggle").click();
        await expect(page.locator('[data-tool-call-id="all-failures-1"] .reader-call-summary')).toContainText(parentMessage);
        await expect(page.locator('[data-tool-call-id="all-failures-2"] .reader-call-summary')).toContainText("HTTP 503 Service Unavailable: upstream connection timeout");
        const returned = page.locator('[data-tool-call-id="returned-failures"]');
        await expect(returned.locator(".api-result-entry")).toHaveCount(9);
        for (let index = 1; index < 9; index++) await expect(returned.locator(".api-result-entry").nth(index)).toContainText(`Returned item ${index} cannot be changed.`);
        await expect(returned.getByRole("button", { name: /Next returned/ })).toHaveCount(0);
        const success = page.locator('[data-tool-call-id="clarity-call-2-0"] .recorded-result').first();
        const failure = page.locator('[data-tool-call-id="all-failures-0"] .result-status').first();
        assert.notEqual(await success.evaluate(node => getComputedStyle(node).color), await failure.evaluate(node => getComputedStyle(node).color));
        const original = page.locator('[data-reader-section="prompt"] .full-text-content');
        assert.equal(await original.textContent(), record.userPrompt.text);
        const copy = page.getByRole("button", { name: "Copy prompt", exact: true });
        await copy.scrollIntoViewIfNeeded();
        const beforeCopy = (await page.locator('[data-reader-section="activity"]').boundingBox()).y;
        const box = await copy.boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await expect(copy).toHaveAttribute("data-copy-state", "success");
        assert.equal((await page.locator('[data-reader-section="activity"]').boundingBox()).y, beforeCopy);
        assert.equal(await page.evaluate(() => window.copied.at(-1)), record.userPrompt.text);
        await page.locator('[data-tool-call-id="all-failures-0"]').scrollIntoViewIfNeeded();
        if (proof) await page.locator("#contextSidebar").screenshot({ path: path.join(proof, `${theme}-${width}-${scale}-reader.png`) });
        await returned.locator(".api-result-entry").last().scrollIntoViewIfNeeded();
        if (proof) await page.locator("#contextSidebar").screenshot({ path: path.join(proof, `${theme}-${width}-${scale}-reader-tail.png`) });
        assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
        await page.keyboard.press("Escape");
        await expect(page.locator("#contextSidebar")).not.toBeVisible();
        await expect(card).toBeFocused();
    }
    await lateCard.click();
    assert.equal(await page.locator('[data-reader-section="prompt"] .full-text-content').textContent(), late.userPrompt.text);
    await page.getByRole("button", { name: "Copy prompt", exact: true }).click();
    assert.equal(await page.evaluate(() => window.copied.at(-1)), late.userPrompt.text);
    await page.keyboard.press("Escape");
    await page.goto(page.url().split("#")[0] + "#analyze?result=failure");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(card.locator(".request-card-reason")).toHaveCount(3);
    await expect(card.locator(".request-card-reason").nth(0).locator(".result-status")).toHaveText("Call #3 failed");
    await expect(card.locator(".request-card-reason").nth(2).locator(".result-status")).toHaveText("Call #5 failed");
    if (proof) await writeFile(path.join(proof, "journey.json"), JSON.stringify({
        source: "Invented records only; temporary retained store and random local HTTP port.",
        themes: ["light", "dark"], sizes: [[1440, 1], [768, 1], [390, 2]],
        cardCalls: 7, toolFailures: 3, returnedErrors: 8, returnedEntriesVisibleWithoutPaging: 9,
        lateFailure: { calls: 5, completed: 4, failed: 1, visible: true },
        equalTextDifferentCalls: "Both retained", sourceSpacing: "Preserved without guessing",
        originalPromptCopies: "Exact", copyLayoutShift: 0, pageOverflow: false, readerOverflow: false,
        filteredCallNumbers: [3, 4, 5], hostMode: "Browser renderer; normal motion",
        liveDeployment: false, providerReads: false,
    }, null, 2));
});

test("Reader call disclosure groups identity and result without a blank target row and labels its service", async t => {
    const { page } = await setup(t);
    await page.locator('.request-card-open[href*="card-clarity-0"]').click();
    const call = page.locator('#requestContent [data-tool-call-id="clarity-call-0-0"]');
    const toggle = call.locator(".reader-call-toggle");
    await expect(toggle.locator(".reader-call-summary")).toContainText("Work IQ required sign-in at the time");
    await expect(call.locator(".reader-call-secondary .recorded-category")).toContainText("Service:");
    await expect(call.locator(".reader-call-secondary .recorded-category")).toContainText("Mail");
    await expect(call.locator(".reader-call-secondary .reader-call-duration")).toContainText("Tool latency:");
    await expect(toggle.locator("button,a,input")).toHaveCount(0);
    const geometry = await toggle.evaluate(toggle => {
        const identity = toggle.querySelector(".reader-call-identity-line").getBoundingClientRect();
        const result = toggle.querySelector(".reader-call-summary").getBoundingClientRect();
        return { height: toggle.getBoundingClientRect().height, gap: result.top - identity.bottom };
    });
    assert.ok(geometry.height >= 44);
    assert.ok(geometry.gap >= 5 && geometry.gap <= 7);
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(call.locator(".technical-detail")).toContainText("/me/messages/synthetic-message");
    await toggle.locator(".reader-call-summary").evaluate(node => {
        const range = document.createRange();
        range.selectNodeContents(node);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
    });
    await toggle.evaluate(node => node.click());
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await toggle.click();
    await expect(call.locator(".technical-detail")).toBeEmpty();
});

test("service identity is stated once for an inherited target and keeps independently returned attribution", async t => {
    const record = records()[0];
    record.userPrompt.text = "Check the invented workshop messages and preparation records.";
    const call = (id, tool, requestArgs, apiResults) => ({
        toolCallId: id, startEventId: id + "-start", tool, requestArgs, apiResults,
        startedAt: record.userPrompt.sourceTimestamp, durationMs: 640,
        toolSucceeded: true, reportedOutcome: "succeeded",
    });
    const result = (index, path) => ({ index, statusCode: 200, evidenceLevel: "intermediary-reported",
        ...(path === undefined ? {} : { path }) });
    record.toolCalls = [
        call("service-inherited", "workiq-fetch", { entityUrls: ["/me/messages/invented-workshop"] }, [result(0)]),
        call("service-returned", "workiq-fetch", { entityUrls: ["/me/messages/invented-workshop"] },
            [result(7, "/me/messages/invented-reply"), result(7, "/me/calendar/events/invented-visit")]),
        call("service-batch", "workiq-fetch", { entityUrls: ["/me/messages", "/me/drive/root", "/unrecognized/target"] },
            [result(0, "/me/drive/items/invented-checklist"), result(1)]),
        call("service-missing", "workiq-fetch", {}, [result(0)]),
        call("service-preparation", "workiq-get_schema", { path: "/me/messages" }, [result(0)]),
        call("service-search", "workiq-retrieve", { query: "Invented workshop" }, []),
        call("service-assistance", "workiq-ask", { question: "Explain this invented workshop checklist." }, []),
    ];
    const { page, revision } = await setup(t, [record]);
    const observations = [];
    const proof = process.env.WIRE_SERVICE_CLARITY_PROOFS;
    if (proof) await mkdir(proof, { recursive: true });
    for (const theme of ["light", "dark"]) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await chooseTheme(page, theme);
        const card = page.locator(".request-card-open");
        await expect(card).toHaveCount(1);
        const cardIdentity = await card.locator(".request-card-categories").innerText();
        for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: 1000 });
            await card.scrollIntoViewIfNeeded();
            if (proof) await card.screenshot({ path: path.join(proof, `${theme}-${width}-card.png`) });
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        await card.click();
        await expect(page.locator("#contextSidebar")).toBeVisible();
        const activity = page.locator('[data-reader-section="activity"]');
        const row = id => activity.locator(`[data-tool-call-id="${id}"]`);
        const inherited = row("service-inherited");
        const values = await activity.locator("[data-tool-call-id]").evaluateAll(nodes => nodes.map(node => ({
            id: node.dataset.toolCallId,
            identity: node.querySelector(".reader-call-services")?.innerText.replace(/\s+/g, " ").trim() ?? "",
            attribution: node.querySelector(".reader-attribution-context")?.innerText ?? null,
            returned: [...node.querySelectorAll(".api-result-entry")].map(entry => ({
                id: entry.dataset.resultId,
                label: entry.querySelector(".action-service")?.previousElementSibling.textContent ?? null,
                service: entry.querySelector(".action-service")?.textContent.trim() ?? null,
                path: entry.querySelector(".api-path-value").innerText,
                attribution: entry.querySelector(".path-attribution")?.nextElementSibling.textContent ?? null,
            })),
        })));
        observations.push({ theme, cardIdentity, values });
        for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: 1000 });
            for (const id of ["service-inherited", "service-returned", "service-batch", "service-missing"]) {
                await row(id).scrollIntoViewIfNeeded();
                await page.mouse.move(0, 0);
                if (proof) await page.locator("#contextSidebar").screenshot({ path: path.join(proof, `${theme}-${width}-${id}.png`) });
                assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth <= node.clientWidth + 1));
            }
        }
        await page.setViewportSize({ width: 768, height: 1000 });
        await inherited.scrollIntoViewIfNeeded();
        if (proof) await page.locator("#contextSidebar").screenshot({ path: path.join(proof, `${theme}-768-service-inherited.png`) });
        const toggle = inherited.locator(".reader-call-toggle");
        await expect(toggle).toHaveAttribute("aria-expanded", "false");
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-expanded", "true");
        await expect(inherited.locator(".technical-detail")).toContainText("/me/messages/invented-workshop");
        await expect(inherited.locator(".api-result-entry")).toHaveCount(1);
        if (proof) await page.locator("#contextSidebar").screenshot({ path: path.join(proof, `${theme}-768-expanded.png`) });
        await toggle.click();
        await expect(inherited.locator(".technical-detail")).toBeEmpty();
        await expect(inherited.locator(".api-result-entry")).toHaveCount(1);
        await expect(inherited.locator(".api-result-entry")).toBeVisible();
        await page.locator("#closeContextSidebar").click();
        await expect(page.locator("#contextSidebar")).not.toBeVisible();
    }
    if (proof) await writeFile(path.join(proof, "service-observations.json"), JSON.stringify(observations, null, 2));
    for (const { cardIdentity, values } of observations) {
        assert.match(cardIdentity, /^Services and operations:/);
        const byId = new Map(values.map(value => [value.id, value]));
        const inherited = byId.get("service-inherited");
        assert.equal(inherited.identity, "Service: Mail");
        assert.equal(inherited.returned[0].service, null);
        assert.equal(inherited.returned[0].attribution, "Call target; no separate path returned.");
        const returned = byId.get("service-returned");
        assert.equal(returned.identity, "Service: Mail");
        assert.deepEqual(returned.returned.map(value => [value.label, value.service]),
            [["Result service", "Mail"], ["Result service", "Calendar"]]);
        assert.deepEqual(returned.returned.map(value => value.path),
            ["/me/messages/invented-reply", "/me/calendar/events/invented-visit"]);
        assert.equal(byId.get("service-batch").identity, "Services: Mail Files");
        assert.match(byId.get("service-batch").attribution, /recorded path does not identify a named app.*call still counts.*result is shown separately/);
        assert.equal(byId.get("service-batch").returned[0].service, "Files");
        assert.match(byId.get("service-batch").returned[1].service, /Returned target not identified/);
        assert.equal(byId.get("service-batch").returned[1].path, "Not attributed to a target in this batch");
        assert.equal(byId.get("service-missing").identity, "");
        assert.match(byId.get("service-missing").attribution, /No usable service target.*source omission or a capture problem/);
        assert.match(byId.get("service-missing").returned[0].service, /Service target not recorded/);
        assert.equal(byId.get("service-preparation").identity, "Operation: Schema lookup");
        assert.equal(byId.get("service-preparation").returned[0].path, "Not recorded");
        assert.equal(byId.get("service-search").identity, "Operation: Search and retrieval");
        assert.equal(byId.get("service-assistance").identity, "Operation: Asked Copilot");
    }
    const selectedId = observations[0].values.find(value => value.id === "service-returned").returned[1].id;
    const exact = new URL(page.url());
    exact.hash = "#request?" + new URLSearchParams({ request: record.scenarioId, call: selectedId, layer: "reported-api", callRevision: String(revision) });
    await page.goto(exact.href);
    await expect(page.locator("#selectedCall")).toHaveAttribute("data-result-id", selectedId);
    await expect(page.locator("#selectedCall")).toBeFocused();
    await expect(page.locator("#selectedCall .action-service")).toHaveText("Calendar");
    await expect(page.locator('[data-tool-call-id="service-returned"] .reader-call-services')).toHaveText("Service: Mail");
    const copy = page.locator('[data-reader-section="prompt"]').getByRole("button", { name: "Copy prompt", exact: true });
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => {} } }));
    await copy.scrollIntoViewIfNeeded();
    const activityTop = (await page.locator('[data-reader-section="activity"]').boundingBox()).y;
    const buttonBox = await copy.boundingBox();
    await page.mouse.click(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2);
    await expect(copy).toHaveAttribute("data-copy-state", "success");
    assert.equal((await page.locator('[data-reader-section="activity"]').boundingBox()).y, activityTop);
});

test("Agent author cues use a distinct shared role while Teams keeps its service purple", async t => {
    const { page } = await setup(t);
    const card = page.locator('.request-card-open[href*="card-clarity-2"]');
    for (const [theme, author, teams] of [
        ["light", "rgb(128, 96, 24)", "rgb(104, 66, 186)"],
        ["dark", "rgb(226, 194, 123)", "rgb(173, 136, 240)"],
    ]) {
        await chooseTheme(page, theme);
        const colors = await card.evaluate(card => ({
            author: getComputedStyle(card.querySelector("[data-prompt-actor=agent]")).color,
            teams: getComputedStyle(card.querySelector("[data-service=Teams]")).color,
        }));
        assert.deepEqual(colors, { author, teams });
        await card.click();
        const reader = page.locator('[data-reader-section="prompt"]');
        assert.equal(await reader.locator(".reader-section-heading [data-prompt-actor]").evaluate(node => getComputedStyle(node).color), author);
        assert.equal(await reader.locator(".full-text-body").evaluate(node => getComputedStyle(node).borderInlineStartColor), author);
        assert.equal(await page.locator('#requestContent .reader-call-services [data-service=Teams]').first()
            .evaluate(node => getComputedStyle(node).color), teams);
        await page.goBack();
    }
    await page.getByRole("link", { name: "Create report", exact: true }).click();
    const agent = page.locator('#reportList .full-text:has([data-prompt-actor=agent])').first();
    await expect(agent).toBeVisible();
    await expect(page.locator("#reportList .interaction-identity").first()).toContainText("Service:");
    for (const [theme, color] of [["light", "rgb(128, 96, 24)"], ["dark", "rgb(226, 194, 123)"]]) {
        await chooseTheme(page, theme);
        const ink = await agent.evaluate(node => ({
            label: getComputedStyle(node.querySelector("[data-prompt-actor=agent]")).color,
            edge: getComputedStyle(node.querySelector(":scope > .full-text-preview, :scope > .full-text-body")).borderInlineStartColor,
        }));
        assert.deepEqual(ink, { label: color, edge: color });
    }
});

test("Source details starts collapsed only for new reading state and preserves later intent", async t => {
    const { page } = await setup(t);
    const card = page.locator('.request-card-open[href*="card-clarity-0"]');
    await card.click();
    const source = page.locator('[data-reader-section="source"]');
    const toggle = source.locator(".reader-section-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(source.locator(".reader-section-clip")).toBeHidden();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await page.goBack();
    await card.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await toggle.click();
    await page.goBack();
    await card.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator('[data-reader-section="activity"] .reader-section-clip')).toBeVisible();
});

test("Activity bands remain separate at wide and enlarged widths without clipping meaningful text", async t => {
    const { page } = await setup(t);
    const views = [];
    for (const [width, scale] of [[1440, 1], [1024, 1.4], [820, 2], [390, 1], [390, 2]]) {
        for (const theme of ["dark", "light"]) {
            await page.setViewportSize({ width, height: 1000 });
            await chooseTheme(page, theme);
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
            await page.waitForFunction(() => !document.documentElement.getAnimations({ subtree: true })
                .some(animation => animation.playState === "running" && Number.isFinite(animation.effect.getComputedTiming().iterations)));
            const metrics = await measure(page), name = `${width}-${scale}-${theme}`;
            await capture(page, name, metrics);
            views.push({ name, metrics });
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), name + ": no page overflow");
        }
    }
    assert.equal(views[0].metrics.length, 8);
    assert.equal(views[0].metrics[0].fontSize, "16px");
    assert.equal(views[0].metrics[0].card.width, 1196);
    for (const { name, metrics } of views) {
        assert.ok(metrics.every(row => row.authors.every(box => box.left >= row.card.left && box.right <= row.card.right)),
            name + ": author must remain wholly readable");
        for (const row of metrics) {
            assert.match(row.font, /Asta Sans/);
            assert.equal(row.weight, "400");
            assert.ok(row.card.height >= 44, name + ": full-card target");
            assert.ok(row.prompt.top >= row.origin.bottom + 7, name + ": origin is not merged into prompt or category");
            assert.ok(row.categories.top >= row.prompt.bottom + 15, name + ": categories have their own band");
            assert.ok(row.problem.top >= row.categories.bottom + 15, name + ": result stays separate from categories");
            assert.ok(row.problem.right <= row.card.right, name + ": problem fits without clipping");
            if (row.more) {
                assert.ok(row.more.top >= row.problem.bottom + 11, name + ": additional reasons have a visible continuation cue");
                assert.ok(row.metadata.top >= row.more.bottom + 11, name + ": continuation is not hidden in metadata");
            }
            assert.ok(row.time.top >= row.problem.bottom + 11 && row.time.right <= row.card.right, name + ": time stays secondary and readable");
        }
    }
    for (const [width, scale] of [[1440, 1], [1024, 1.4], [390, 1], [390, 2]]) {
        for (const theme of ["dark", "light"]) {
            await page.setViewportSize({ width, height: 1000 });
            await chooseTheme(page, theme);
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
            await page.locator('.request-card-open[href*="card-clarity-2"]').click();
            const native = await page.locator("#contextSidebar").evaluate(pane => {
                const body = pane.querySelector("#contextSidebarBody"), footer = pane.querySelector("#contextSidebarFooter");
                return { overflow: body.scrollWidth > body.clientWidth + 1,
                    footerCovered: body.getBoundingClientRect().bottom > footer.getBoundingClientRect().top + 1,
                    calls: [...pane.querySelectorAll(".reader-call-toggle")].map(toggle => {
                        const identity = toggle.querySelector(".reader-call-identity-line").getBoundingClientRect();
                        const result = toggle.querySelector(".reader-call-summary").getBoundingClientRect();
                        return { height: toggle.getBoundingClientRect().height, gap: result.top - identity.bottom };
                    }) };
            });
            assert.equal(native.overflow, false);
            assert.equal(native.footerCovered, false);
            assert.equal(native.calls.length, 6);
            assert.ok(native.calls.every(call => call.height >= 44 && call.gap >= 5 && call.gap <= 7));
            await capture(page, `${width}-${scale}-${theme}-native-reader`, native);
            await page.goBack();
        }
    }
});

test("An empty retained agent message remains recognizable without pretending its arguments are a prompt", async t => {
    const { page } = await setup(t);
    const card = page.locator('.request-card-open[href*="card-clarity-1"]');
    await expect(card).not.toContainText("Prompt not available");
    await expect(card.locator(".request-card-author")).toHaveText("Automatic continuation");
    await expect(card).toContainText("No new message was sent.");
    await expect(card).toContainText("workiq-retrieve");
    await expect(card).not.toContainText("SYNTHETIC_ARGUMENT_NOT_A_PROMPT");
    await card.click();
    await expect(page.locator("#requestContent")).toContainText("Work IQ required sign-in at the time");
    await expect(page.locator("#requestContent .reader-call-row")).toHaveCount(1);
    await expect(page.locator("#requestContent")).not.toContainText(shortPrompt);
    await expect(page.locator("#requestContent")).not.toContainText(longPrompt);
    const prompt = page.locator('[data-reader-section="prompt"]');
    await expect(prompt).toContainText("Automatic continuation");
    await expect(prompt).toContainText("No new message was sent.");
    await expect(prompt.locator("pre, .ux-copy")).toHaveCount(0);
    await capture(page, "automatic-reader", []);
    await page.goBack();
    await expect(card).toBeFocused();
});

test("bounded card preview still opens the full exact authorized message and returns to its link", async t => {
    const { page } = await setup(t);
    const card = page.locator('.request-card-open[href*="card-clarity-2"]');
    await expect(card.locator("button,input,a")).toHaveCount(0);
    await card.focus(); await page.keyboard.press("Enter");
    await expect(page.locator('[data-reader-section="prompt"] .full-text-content')).toHaveText(longPrompt);
    await expect(page.locator("#requestContent .reader-call-row")).toHaveCount(6);
    await page.goBack();
    await expect(card).toBeFocused();
});

test("unavailable and empty nonautomatic records retain their own identity without false continuation or recovery", async t => {
    const evidence = records();
    evidence[0].userPrompt = { ...evidence[0].userPrompt, text: null, status: "unavailable" };
    evidence[1].userPrompt = { ...evidence[1].userPrompt, text: "EXCLUDED_TEXT_MUST_NOT_APPEAR", status: "unavailable" };
    evidence[2].userPrompt = { ...evidence[2].userPrompt, text: "", authorship: { actor: "unknown", basis: "conflicting-source" } };
    const { page } = await setup(t, evidence);
    for (const [index, label, notice] of [[0, "My activity", "Prompt text unavailable"],
        [1, "Agent activity", "Prompt text unavailable"], [2, "Author unverified", "No prompt text retained"]]) {
        const card = page.locator(`.request-card-open[href*="card-clarity-${index}"]`);
        await expect(card.locator(".request-card-author")).toHaveText(label);
        await expect(card).toContainText(notice);
        await expect(card).not.toContainText("Automatic continuation");
        await card.click();
        const prompt = page.locator('[data-reader-section="prompt"]');
        await expect(prompt).toContainText(notice + ".");
        await expect(prompt.locator("pre, .ux-copy")).toHaveCount(0);
        await expect(page.locator("#requestContent")).not.toContainText("EXCLUDED_TEXT_MUST_NOT_APPEAR");
        await page.goBack();
    }
});

test("cards and the reader distinguish observed automatic control, known gaps and unknown absence", async t => {
    const evidence = records();
    evidence[1].userPrompt = { ...evidence[1].userPrompt,
        authorship: { actor: "unknown", basis: "conflicting-source" },
        capture: { version: 1, kind: "automatic-continuation", original: "empty", hostContext: "not-collected", reason: null } };
    evidence[0].userPrompt = { text: null, status: "unavailable", authorship: { actor: "unknown", basis: "missing-source" },
        capture: { version: 1, kind: "unknown", original: "unavailable", hostContext: "unknown", reason: "malformed-line" } };
    evidence[2].userPrompt = { text: "", status: "full", authorship: { actor: "unknown", basis: "legacy-missing" } };
    const { page } = await setup(t, evidence);
    for (const [index, label, notice] of [
        [1, "Automatic continuation", "No new message was sent."],
        [0, "Author unverified", "Prompt unavailable: a saved history entry could not be read."],
        [2, "Author unverified", "No prompt text retained"],
    ]) {
        const card = page.locator(`.request-card-open[href*="card-clarity-${index}"]`);
        await expect(card.locator(".request-card-author")).toHaveText(label);
        await expect(card.locator(".request-card-author")).toHaveAttribute("data-prompt-actor", "unknown");
        await expect(card).toContainText(notice);
        if (index === 1) {
            await expect(card.locator(".request-card-prompt")).toHaveText("Prompt: No new message was sent.");
            const ink = await card.locator(".request-card-author").evaluate(node => getComputedStyle(node).color);
            const agent = await page.locator('.request-card-open[href*="card-clarity-3"] .request-card-author')
                .evaluate(node => getComputedStyle(node).color);
            assert.notEqual(ink, agent, "Automatic kind must not acquire verified Agent paint.");
        }
        await card.click();
        const prompt = page.locator('[data-reader-section="prompt"]');
        await expect(prompt).toContainText(notice);
        await expect(prompt.locator("pre, .ux-copy")).toHaveCount(0);
        if (index === 1) {
            await expect(prompt.locator("h2")).toHaveText("Automatic continuation");
            await expect(prompt).not.toContainText("Prompt unavailable");
        } else await expect(prompt).not.toContainText("No new message was sent");
        await capture(page, `capture-state-${index}`, []);
        await page.goBack();
    }
});

test("immutable first-saved prompt text keeps its shared qualification in card and full reader", async t => {
    const record = records()[0];
    record.userPrompt = { ...record.userPrompt,
        authorship: { actor: "unknown", basis: "conflicting-source" },
        capture: { version: 1, kind: "message", original: "recorded", hostContext: "unknown", reason: null, conflict: true } };
    const { page } = await setup(t, [record]);
    const notice = "The source changed this message. The first saved text is shown.";
    const card = page.locator(".request-card-open");
    await expect(card.locator(".request-card-origin")).toHaveText("Author unverified");
    await expect(card.locator(".request-card-prompt")).toHaveText(shortPrompt);
    await expect(card.locator(".request-card-availability")).toHaveText(notice);
    await expect(card.locator(".request-card-categories")).toContainText("Mail");
    await card.click();
    const prompt = page.locator('[data-reader-section="prompt"]');
    await expect(prompt.locator(".full-text-content")).toHaveText(shortPrompt);
    await expect(prompt).toContainText(notice);
    await capture(page, "immutable-source-qualified", []);
});
