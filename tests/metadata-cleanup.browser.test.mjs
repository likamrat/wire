import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme, revealAnalyzeRecords } from "./helpers.mjs";

const proof = process.env.WIRE_METADATA_CLEANUP_PROOFS;
const baseline = process.env.WIRE_METADATA_CLEANUP_BASELINE;
const serve = baseline ? (await import(pathToFileURL(path.join(baseline, "lib", "server.mjs")))).startServer : startServer;
const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const settle = async page => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity)
        .every(animation => animation.playState !== "running"));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};

function records() {
    return [
        ["ask", "workiq-ask", { question: "Find the invented workshop planning notes." }],
        ["known", "workiq-fetch", { entityUrls: ["/me/drive/items/workshop"] }],
        ["mixed", "workiq-fetch", { entityUrls: ["/me/drive/items/workshop", "/unrecognized/target"] }],
        ["multiple", "workiq-fetch", { entityUrls: ["/me/drive/items/workshop", "/me/messages/workshop", "/teams/workshop/channels"] }],
        ["unknown", "workiq-fetch", {}],
        ["discovery", "workiq-search_paths", { query: "workshop" }],
        ["search", "workiq-retrieve", { query: "workshop" }],
    ].map(([id, tool, requestArgs], index) => {
        const record = fixture("metadata-cleanup-" + id);
        record.capturedAt = new Date(Date.UTC(2026, 9, 18, 12, 7 - index)).toISOString();
        record.userPrompt = { text: id === "ask" ? "Find the notes for the invented community workshop."
            : `Check the invented ${id} workshop record and explain what the saved evidence shows.`,
        status: "full", sourceEventId: `prompt-${id}`, sourceTimestamp: record.capturedAt,
        authorship: { actor: "user", basis: "source-user" } };
        record.followUpPrompts = [];
        record.toolCalls = [{ tool, requestArgs, toolCallId: `call-${id}`, startEventId: `start-${id}`,
            startedAt: record.capturedAt, durationMs: 73000, toolSucceeded: true, reportedOutcome: "succeeded", apiResults: [] }];
        return record;
    });
}

async function setup(t) {
    const cleanup = [], data = records();
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, data);
    const before = await loadBoardState(context), errors = [], denied = [];
    const runtime = await serve(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: { evaluatorFactory() { throw Error("No providers in metadata cleanup proof."); },
            readSource() { throw Error("No source reads in metadata cleanup proof."); } } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "UTC" });
    page.on("pageerror", error => errors.push(error.message));
    await page.context().route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET" || [
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary", "/api/report-artifacts/list",
        ].includes(url.pathname))) return route.continue();
        denied.push(url.pathname); return route.abort();
    });
    await page.context().addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        async writeText(text) { window.syntheticCopiedText = text; },
    } }));
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(await loadBoardState(context), before);
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url + "#analyze"); await ready(page); await settle(page);
    return { page, data, runtime };
}

function card(page, id) { return page.locator(`.request-card-open[href*="metadata-cleanup-${id}"]`); }

async function geometry(page, selector) {
    return page.locator(selector).evaluateAll(groups => groups.map(group => {
        const rect = node => node.getBoundingClientRect().toJSON();
        const text = node => {
            const range = document.createRange(); range.selectNodeContents(node);
            return [...range.getClientRects()].map(value => value.toJSON());
        };
        return { box: rect(group), text: group.textContent,
            fields: [...group.querySelectorAll(":scope > .recorded-category-field")].map(field => ({
                box: rect(field), key: rect(field.querySelector(".recorded-category-label")), text: field.textContent,
            })),
            cues: [...group.querySelectorAll(".service-cue")].map(cue => ({
                box: rect(cue), icon: rect(cue.querySelector(".wire-icon")), text: text(cue.lastElementChild),
                font: getComputedStyle(cue.lastElementChild).font,
            })),
            gaps: [...group.querySelectorAll(".service-availability")].map(gap => ({
                box: rect(gap), text: gap.textContent, lines: text(gap),
                font: getComputedStyle(gap.querySelector(".identity-gap")).font,
            })) };
    }));
}

test("shared metadata groups and title role survive both themes, narrow columns and 200% text", async t => {
    const { page } = await setup(t), measurements = [];
    if (proof) await mkdir(proof, { recursive: true });
    if (!baseline) {
        await expect(page.locator("#openAnalysisSearch")).toHaveCount(0);
        await expect(page.locator("#activityListScope")).toBeHidden();
        await expect(page.locator("#activityListContext")).not.toContainText(/All dates|Current collection/);
        await expect(page.locator("#wireSearch")).toHaveCount(1);
        await expect(card(page, "ask").locator(".recorded-category-field")).toHaveText(["Category: Asked Copilot", "Service: Not shown"]);
        await expect(card(page, "known").locator(".service-availability")).toHaveCount(0);
        await expect(card(page, "mixed").locator(".service-availability")).toHaveText("Service details: Incomplete");
        await expect(card(page, "multiple").locator(".service-cue")).toHaveCount(3);
        await expect(card(page, "unknown").locator(".recorded-category-field")).toHaveText(["Service: Not shown"]);
        await expect(card(page, "discovery").locator(".service-availability")).toHaveCount(0);
        await expect(page.locator(".service-label-list .identity-gap")).toHaveCount(0);
    }
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [820, 1], [390, 1], [390, 2], [1440, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await revealAnalyzeRecords(page); await settle(page);
        const title = await page.evaluate(() => {
            const font = selector => {
                const style = getComputedStyle(document.querySelector(selector));
                return { family: style.fontFamily, size: style.fontSize };
            };
            return { headline: font("#activityListSummary"), widget: font("#outcomeChart h3"),
                loaded: document.fonts.check('16px "Asta Sans"') };
        });
        if (!baseline) assert.deepEqual(title.headline, title.widget);
        assert.ok(title.loaded);
        const list = await geometry(page, "#activityList .recorded-category");
        const name = `${theme}-${width}-${scale}`;
        if (proof) {
            await page.screenshot({ path: path.join(proof, name + "-header.png") });
            await card(page, "ask").screenshot({ path: path.join(proof, name + "-card.png") });
            await page.locator("#activityList").screenshot({ path: path.join(proof, name + "-all-cards.png") });
        }
        const readers = [];
        for (const id of ["ask", "mixed", "multiple", "unknown", "discovery", "search"]) {
            await card(page, id).click(); await settle(page);
            const fields = await geometry(page, "#requestContent .reader-call-services");
            if (!baseline) {
                const listText = await card(page, id).locator(".recorded-category").textContent();
                await expect(page.locator("#requestContent .reader-call-services")).toHaveText(listText);
                await expect(page.locator(".reader-call-secondary")).toContainText("1:13 min");
                await expect(page.locator(".reader-call-summary")).toContainText("Worked");
            }
            readers.push({ id, fields });
            if (proof && ["ask", "mixed", "multiple", "unknown"].includes(id)) {
                await page.screenshot({ path: path.join(proof, `${name}-reader-${id}.png`) });
            }
            await page.locator("#closeContextSidebar").click();
            await page.locator("#contextSidebar").waitFor({ state: "hidden" }); await settle(page);
            await expect(card(page, id)).toBeFocused();
        }
        for (const group of [...list, ...readers.flatMap(reader => reader.fields)]) {
            for (const field of group.fields) assert.ok(field.box.right <= group.box.right + 1, `${name}: ${field.text}`);
            for (const cue of group.cues) {
                assert.ok(cue.box.right <= group.box.right + 1, `${name}: cue overflow`);
                assert.ok(Math.abs(cue.icon.top + cue.icon.height / 2 - cue.text[0].top - cue.text[0].height / 2) <= 1.5,
                    `${name}: icon/text alignment`);
            }
            for (const gap of group.gaps) {
                assert.ok(gap.box.right <= group.box.right + 1, `${name}: availability overflow`);
                assert.match(gap.text, /^Service(?: details)?: /);
                if (group.cues.length) assert.equal(gap.font, group.cues[0].font);
            }
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        measurements.push({ theme, width, scale, title, list, readers });
    }
    if (proof) await writeFile(path.join(proof, "measurements.json"), JSON.stringify(measurements, null, 2));
});

test("missing-service presentation keeps exact call disclosure, prompt copy and selected-card return", async t => {
    const { page, data } = await setup(t);
    const target = card(page, "ask");
    await target.scrollIntoViewIfNeeded(); await settle(page);
    const origin = { url: page.url(), y: (await target.boundingBox()).y };
    await target.focus(); await page.keyboard.press("Enter"); await settle(page);
    const toggle = page.locator(".reader-call-toggle");
    await expect(toggle).toHaveAccessibleName("Inspect recorded evidence: Call 1 workiq-ask Worked");
    await toggle.focus(); await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".technical-detail")).toContainText("Find the invented workshop planning notes.");
    const copy = page.getByRole("button", { name: "Copy prompt", exact: true });
    await copy.click();
    assert.equal(await page.evaluate(() => window.syntheticCopiedText), data[0].userPrompt.text);
    await page.goBack(); await page.locator("#contextSidebar").waitFor({ state: "hidden" }); await settle(page);
    await expect(target).toBeFocused();
    assert.equal(page.url(), origin.url);
    assert.ok(Math.abs((await target.boundingBox()).y - origin.y) < 2);
});

test("onscreen report summaries share availability fields while keeping bounded inline identities", { skip: Boolean(baseline) }, async t => {
    const { page } = await setup(t);
    await page.getByRole("link", { name: "Create report", exact: true }).click(); await settle(page);
    const entry = id => page.locator(`#reportList [data-view-key="report:metadata-cleanup-${id}"]`);
    const multiple = entry("multiple").locator(".recorded-category");
    await expect(multiple.locator(".service-cue")).toHaveCount(2);
    await expect(multiple.locator(".identity-overflow")).toHaveText("More services");
    assert.match(await multiple.locator(".identity-list").textContent(), /Mail,\s+Files, More services/);
    await expect(multiple.locator("button,a")).toHaveCount(0);
    await expect(entry("ask").locator(".service-availability")).toHaveText("Service: Not shown");
    await expect(entry("mixed").locator(".service-availability")).toHaveText("Service details: Incomplete");
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [390, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await settle(page);
        for (const id of ["ask", "mixed", "multiple"]) {
            const group = entry(id).locator(".recorded-category");
            await group.evaluate(node => node.scrollIntoView({ block: "center" })); await settle(page);
            assert.ok(await group.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
            if (proof) await group.screenshot({ path: path.join(proof, `${theme}-${width}-${scale}-picker-${id}.png`) });
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
});
