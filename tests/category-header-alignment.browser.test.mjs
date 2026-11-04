import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { fixture, privateFixture, chooseTheme } from "./helpers.mjs";

const ready = page => expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
const settled = async page => {
    await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
};

async function setup(t) {
    const records = Array.from({ length: 4 }, (_, index) => {
        const record = fixture("category-alignment-" + index);
        record.capturedAt = new Date(Date.UTC(2026, 9, 18, 12, 4 - index)).toISOString();
        record.userPrompt = { text: index === 1 ? "" : [
            "Continue checking the workshop notes and explain what still needs attention.",
            "",
            "Check the workshop handover across mail, shared files and Teams, then look for the remaining notes.",
            "Check what the retained evidence can tell us about the unfinished workshop request.",
        ][index], status: "full", sourceEventId: "category-prompt-" + index, sourceTimestamp: record.capturedAt,
            authorship: { actor: index === 1 ? "agent" : "user", basis: index === 1 ? "autopilot" : "source-user" },
            ...index === 1 ? { capture: { version: 1, kind: "automatic-continuation", original: "empty",
                hostContext: "not-collected", reason: null } } : {} };
        record.followUpPrompts = [];
        record.toolCalls = Array.from({ length: index === 2 ? 2 : 1 }, (_, call) => ({
            tool: index < 2 || call === 1 ? "workiq-retrieve" : "workiq-fetch",
            toolCallId: `alignment-call-${index}-${call}`, startEventId: `alignment-start-${index}-${call}`,
            startedAt: record.capturedAt, durationMs: 300,
            requestArgs: index < 2 || call === 1 ? { query: "SYNTHETIC_WORKSHOP_LOOKUP" }
                : index === 2 ? { entityUrls: ["/me/messages/example", "/me/drive/items/example", "/teams/example/channels"] } : {},
            toolSucceeded: index === 3 ? null : call === 1,
            reportedOutcome: index === 3 ? "unknown" : call === 1 ? "succeeded" : "failed",
            apiResults: [],
            ...index !== 3 && call === 0 ? { failureEvidence: { version: 1, reason: "error-code-recorded",
                code: "failure", messageStatus: "text-excluded",
                messageSignal: index === 2 ? "access-denial" : "workiq-sign-in-required" } } : {},
        }));
        return record;
    });
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) }, records);
    const before = await loadBoardState(context), errors = [], denied = [];
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false },
        evaluation: {
            evaluatorFactory() { throw Error("No providers in category alignment proof."); },
            readSource() { throw Error("No source-history reads in category alignment proof."); },
        } });
    const browser = await chromium.launch();
    t.after(async () => {
        try {
            await browser.close(); await runtime.close();
            assert.deepEqual(await loadBoardState(context), before);
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
        } finally { for (const action of cleanup) await action(); }
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(error.message));
    await page.context().route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(runtime.url).origin && (request.method() === "GET" || [
            "/api/snapshot", "/api/collection/status", "/api/assessment/overview", "/api/assessment/detail",
            "/api/evaluation/automatic/summary",
        ].includes(url.pathname))) return route.continue();
        denied.push(url.pathname); return route.abort();
    });
    await page.goto(runtime.url + "#analyze");
    await ready(page);
    await page.evaluate(() => document.fonts.ready);
    return { page, runtime };
}

async function geometry(page, selector) {
    return page.locator(selector).evaluateAll(fields => fields.filter(field => field.checkVisibility()
        && field.querySelector(".recorded-category-label")).map(field => {
        const textRect = node => {
            const range = document.createRange();
            range.selectNodeContents(node);
            return [...range.getClientRects()].filter(rect => rect.height > 0).map(rect => rect.toJSON());
        };
        const key = field.querySelector(".recorded-category-label"), style = getComputedStyle(key);
        return {
            key: key.textContent, keyRect: textRect(key)[0], field: field.getBoundingClientRect().toJSON(),
            font: style.font, values: [...field.querySelectorAll(".service-cue")].map(cue => {
                const value = cue.querySelector(":scope > span"), icon = cue.querySelector(":scope > .wire-icon");
                return { text: value.textContent, rects: textRect(value), font: getComputedStyle(value).font,
                    icon: icon.getBoundingClientRect().toJSON(), cue: cue.getBoundingClientRect().toJSON() };
            }),
            separated: [...field.querySelectorAll(".service-label-list>li+li:not(.service-label-gap)")].map(item =>
                getComputedStyle(item).borderInlineStartWidth),
            gaps: [...field.querySelectorAll(".identity-gap")].map(node => ({ text: node.textContent, rect: textRect(node)[0] })),
        };
    }));
}

test("Category keys share the value text baseline and reader identity uses spacing rather than a dot", async t => {
    const { page } = await setup(t), measurements = [], violations = [];
    const directory = process.env.WIRE_CATEGORY_HEADER_PROOFS;
    if (directory) await mkdir(directory, { recursive: true });
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [820, 1], [390, 1], [390, 2], [1440, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        await page.locator("#activityListSummary").scrollIntoViewIfNeeded();
        await settled(page);
        const list = await geometry(page, "#activityList .recorded-category");
        const name = `${theme}-${width}-${scale}`;
        if (directory) {
            await page.evaluate(() => scrollTo(0, 0));
            await settled(page);
            await page.screenshot({ path: path.join(directory, name + "-cards.png"), fullPage: true });
        }
        const readers = [];
        for (const index of [1, 2]) {
            await page.locator(`.request-card-open[href*="category-alignment-${index}"]`).click();
            await expect(page.locator("#contextSidebar")).toBeVisible();
            await settled(page);
            const fields = await geometry(page, "#requestContent .reader-call-secondary .recorded-category");
            const headings = await page.locator(".reader-call-identity-line").evaluateAll(nodes => nodes.map(node => ({
                text: node.textContent, label: node.closest("button").querySelector(".context-entry-label").textContent,
                tool: node.querySelector(".reader-tool-name")?.textContent,
                name: node.closest("button")?.getAttribute("aria-label").replace(/\s+/g, " ").trim(),
                box: node.getBoundingClientRect().toJSON(),
                ordinal: node.closest("button").querySelector(".context-entry-label").getBoundingClientRect().toJSON(),
                toolBox: node.querySelector(".reader-tool-name")?.getBoundingClientRect().toJSON(),
                disclosure: node.querySelector(".reader-call-disclosure")?.getBoundingClientRect().toJSON(),
            })));
            readers.push({ index, fields, headings });
            if (directory) await page.screenshot({ path: path.join(directory, `${name}-reader-${index}.png`) });
            for (const heading of headings) {
                if (heading.text.includes("\u00b7")) violations.push(`${name}: decorative dot in ${heading.text}`);
                if (!heading.name.includes(heading.tool + " " + heading.label + " ")) violations.push(`${name}: identity is not separated in its accessible name`);
                if (heading.toolBox.right > heading.box.right + 1 || heading.disclosure.right > heading.box.right + 1) {
                    violations.push(`${name}: header overflows its disclosure`);
                }
            }
            await page.goBack();
            await page.locator("#contextSidebar").waitFor({ state: "hidden" });
            await settled(page);
        }
        for (const field of [...list, ...readers.flatMap(reader => reader.fields)]) {
            const first = field.values[0]?.rects[0] ?? field.gaps[0]?.rect;
            if (first) {
                const delta = first.top - field.keyRect.top;
                if (delta < -0.5 || delta < field.keyRect.height && Math.abs(delta) > 0.5) {
                    violations.push(`${name}: ${field.key} key/value text offset ${delta}px`);
                }
            }
            for (const value of field.values) {
                assert.equal(value.font, field.font);
                const text = value.rects[0], iconCenter = value.icon.top + value.icon.height / 2;
                if (Math.abs(iconCenter - (text.top + text.height / 2)) > 1.5) violations.push(`${name}: ${value.text} icon is not centered on its first text line`);
                if (value.cue.right > field.field.right + 1) violations.push(`${name}: category overflows`);
            }
            for (const border of field.separated) assert.equal(border, "1px");
        }
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        assert.ok(overflow <= 1, name);
        measurements.push({ theme, width, scale, list, readers });
    }
    if (directory) await writeFile(path.join(directory, "geometry.json"), JSON.stringify({ measurements, violations }, null, 2));
    assert.equal(violations.length, 0, violations.slice(0, 12).join("\n"));
});

test("The dot-free call header keeps exact identity, result, disclosure and selected-card return", async t => {
    const { page, runtime } = await setup(t);
    const card = page.locator('.request-card-open[href*="category-alignment-1"]');
    await card.scrollIntoViewIfNeeded();
    await card.focus();
    const origin = { url: page.url(), top: (await card.boundingBox()).y };
    await page.keyboard.press("Enter");
    await settled(page);
    const call = page.locator('[data-tool-call-id="alignment-call-1-0"]'), toggle = call.locator(".reader-call-toggle");
    const exactCall = await call.getAttribute("data-action-id");
    assert.ok(exactCall);
    await expect(toggle).toHaveAccessibleName("Inspect recorded evidence: workiq-retrieve Call 1 failed. Work IQ required sign-in at the time");
    await expect(toggle.locator(".reader-call-summary")).toContainText("Work IQ required sign-in at the time");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const owner = await toggle.getAttribute("aria-controls");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(`[id=${JSON.stringify(owner)}]`)).toBeVisible();
    await expect(call.locator(".technical-detail")).toContainText("SYNTHETIC_WORKSHOP_LOOKUP");
    await toggle.locator(".reader-call-summary").evaluate(node => {
        const range = document.createRange(); range.selectNodeContents(node);
        window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
    });
    await toggle.evaluate(node => node.click());
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await toggle.click();
    await expect(call.locator(".technical-detail")).toBeEmpty();
    await page.goBack();
    await page.locator("#contextSidebar").waitFor({ state: "hidden" });
    await settled(page);
    await expect(card).toBeFocused();
    assert.equal(page.url(), origin.url);
    assert.ok(Math.abs((await card.boundingBox()).y - origin.top) < 2);
    await page.goto(runtime.url + "#request?" + new URLSearchParams({
        request: "category-alignment-1", call: exactCall, origin: "analyze",
    }));
    await ready(page); await settled(page);
    await expect(page.locator("#selectedCall")).toBeFocused();
    await expect(page.locator("#selectedCall .reader-call-toggle")).toHaveAttribute("aria-expanded", "true");
});

test("Forced colors keep wrapped metadata and the dot-free disclosure readable", async t => {
    const { page } = await setup(t);
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.emulateMedia({ forcedColors: "active" });
    await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
    await page.locator('.request-card-open[href*="category-alignment-2"]').click();
    await settled(page);
    const toggle = page.locator(".reader-call-toggle").first();
    await expect(toggle).toHaveAccessibleName("Inspect recorded evidence: workiq-fetch Call 1 failed. Access was denied");
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    assert.equal(await toggle.evaluate(node => getComputedStyle(node).forcedColorAdjust), "auto");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1));
    for (const field of await geometry(page, "#requestContent .reader-call-secondary .recorded-category")) {
        for (const value of field.values) {
            const text = value.rects[0], center = value.icon.top + value.icon.height / 2;
            assert.ok(Math.abs(center - text.top - text.height / 2) <= 1.5);
            assert.ok(value.cue.right <= field.field.right + 1);
        }
    }
});
