import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
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

async function setup(t, evidence = records()) {
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, evidence);
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
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
    await page.goto(runtime.url + "#analyze");
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(() => document.fonts.ready);
    return { page };
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

test("Activity gives origin, prompt, labelled categories and meaningful problems distinct regions", async t => {
    const { page } = await setup(t);
    const first = page.locator('.request-card-open[href*="card-clarity-0"]');
    await expect(first.locator(".request-card-origin")).toHaveText("My prompt");
    await expect(first.locator(".request-card-categories")).toContainText("Category:");
    await expect(first.locator(".request-card-categories")).toContainText("Mail");
    await expect(first.locator(".request-card-problem")).toContainText("Sign-in was required");
    const mixed = page.locator('.request-card-open[href*="card-clarity-2"]');
    await expect(mixed.locator(".request-card-categories")).toContainText("Categories:");
    await expect(mixed.locator(".request-card-categories .service-label-list > li")).toHaveCount(2);
    await expect(mixed.locator(".request-card-problem")).toContainText("Access was denied");
    await expect(mixed.locator(".request-card-problem")).toContainText("Request timed out");
    await expect(mixed.locator(".request-card-problem")).not.toContainText("Sign-in was required");
    await expect(mixed.locator(".request-card-more-problems")).toHaveText("1 more failure reason in the reader");
    await expect(first.locator(".request-card-more-problems")).toHaveCount(0);
    await expect(mixed.locator("button,input,a")).toHaveCount(0);
    const geometry = await mixed.evaluate(card => {
        const box = selector => card.querySelector(selector).getBoundingClientRect().toJSON();
        return { origin: box(".request-card-origin"), prompt: box(".request-card-prompt"),
            categories: box(".request-card-categories"), result: box(".request-card-problem"),
            more: box(".request-card-more-problems"), metadata: box(".request-card-summary") };
    });
    assert.ok(geometry.prompt.top >= geometry.origin.bottom + 7);
    assert.ok(geometry.categories.top >= geometry.prompt.bottom + 15);
    assert.ok(geometry.result.top >= geometry.categories.bottom + 15);
    assert.ok(geometry.more.top >= geometry.result.bottom + 11);
    assert.ok(geometry.metadata.top >= geometry.more.bottom + 11);
});

test("Card reasons follow the same retained chronology as native first-failure entry", async t => {
    const record = records()[2];
    for (const [index, seconds] of [[3, 30], [4, 10], [5, 20]]) {
        record.toolCalls[index].startedAt = new Date(Date.parse(record.userPrompt.sourceTimestamp) + seconds * 1000).toISOString();
    }
    const { page } = await setup(t, [record]);
    const card = page.locator(".request-card-open");
    const problem = await card.locator(".request-card-problem").textContent();
    assert.ok(problem.indexOf("Request timed out") < problem.indexOf("Sign-in was required"));
    assert.ok(!problem.includes("Access was denied"));
    await expect(card.locator(".request-card-more-problems")).toHaveText("1 more failure reason in the reader");
    await card.click();
    await expect(page.locator('[data-tool-call-id="clarity-call-2-4"]')).toBeFocused();
    await expect(page.locator('[data-tool-call-id="clarity-call-2-3"]')).toContainText("Access was denied");
});

test("Reader call disclosure groups identity and result without a blank target row and labels its category", async t => {
    const { page } = await setup(t);
    await page.locator('.request-card-open[href*="card-clarity-0"]').click();
    const call = page.locator('#requestContent [data-tool-call-id="clarity-call-0-0"]');
    const toggle = call.locator(".reader-call-toggle");
    await expect(toggle.locator(".reader-call-summary")).toContainText("Sign-in was required");
    await expect(call.locator(".reader-call-secondary .recorded-category")).toContainText("Category:");
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
    await expect(page.locator("#reportList .interaction-identity").first()).toContainText("Categories:");
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
    await expect(page.locator("#requestContent")).toContainText("Sign-in was required");
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
