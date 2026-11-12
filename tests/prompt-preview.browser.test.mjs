import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { fixture, chooseTheme } from "./helpers.mjs";
import { searchFixture } from "./live-search-fixture.mjs";
import { loadBoardState } from "../lib/store.mjs";

const proofs = process.env.WIRE_PROMPT_PROOFS;
const exactPrompt = "Review the invented Cedar workshop notes and prepare a handoff for the next planning session.\n"
    + "Keep decisions, open questions and supporting references separate.\n\n"
    + Array.from({ length: 14 }, (_, index) =>
        `Part ${index + 1}: Read the retained workshop notes, compare the proposed milestones with the checklist, and explain which decisions are still open. Keep the original wording and source references.\n`
        + "  Do not treat a missing answer as agreement. Include the relevant recorded outcome, not a guess.").join("\n\n")
    + "\n\nClosing reference: violet-lantern handoff. Preserve <sample> markup and Caf\u00e9 wording literally.\n";

function record(id, text = exactPrompt, actor = "user") {
    const item = fixture(id);
    item.sourceSessionId = id + "-chat";
    item.sourceSessionName = "Invented Cedar planning";
    item.userPrompt = { text, status: "full", sourceEventId: id + "-message", sourceTimestamp: "2026-10-01T12:00:00Z",
        authorship: { actor, basis: actor === "unknown" ? "missing-source" : "source-" + actor } };
    item.followUpPrompts = [];
    item.toolCalls[0].requestArgs = { entityUrls: ["/me/drive/items/invented-cedar-notes"] };
    item.toolCalls[0].startedAt = "2026-10-01T12:00:01Z";
    item.toolCalls[0].durationMs = 900;
    return item;
}

async function settled(page) {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForFunction(() => !document.getAnimations().some(animation => animation.playState === "running"));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function setup(t, records, { frozen = false } = {}) {
    const cleanup = [];
    const app = await searchFixture({ after: action => cleanup.push(action) }, { records, formats: frozen ? ["html"] : [], reply: false });
    const before = await loadBoardState(app.context);
    const frozenFiles = new Map();
    for (const bundle of app.bundles) for (const file of Object.values(bundle.files)) frozenFiles.set(file, await readFile(file));
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const errors = [], denied = [];
    page.setDefaultTimeout(10000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        const reads = ["/api/session", "/api/snapshot", "/api/collection/status", "/api/assessment/detail",
            "/api/assessment/overview", "/api/search/query", "/api/search/status", "/api/search/events",
            "/api/search/cancel", "/api/search/open", "/api/search/membership"];
        if (url.origin !== new URL(app.runtime.url).origin || request.method() !== "GET" && !reads.includes(url.pathname)) {
            denied.push(url.pathname); return route.abort();
        }
        return route.continue();
    });
    await page.addInitScript(() => {
        window.promptCopies = [];
        Object.defineProperty(navigator, "clipboard", { value: {
            readText() { throw Error("No system clipboard reads in prompt proof."); },
            async writeText(text) { window.promptCopies.push(text); },
        } });
    });
    t.after(async () => {
        try {
            await browser.close();
            const after = await loadBoardState(app.context);
            for (const key of ["evidence", "cards", "exports", "personalEvaluation"]) assert.deepEqual(after[key], before[key], key);
            for (const [file, bytes] of frozenFiles) assert.deepEqual(await readFile(file), bytes, "Frozen report unchanged");
            assert.deepEqual(errors, []); assert.deepEqual(denied, []);
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(app.runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await settled(page);
    return { ...app, page };
}

const prompt = page => page.locator('[data-reader-section="prompt"]');
const content = page => prompt(page).locator(".full-text-content");
const bottomToggle = page => prompt(page).locator(".full-text-body > .prompt-preview-toggle");
const topToggle = page => prompt(page).locator(".full-text-reader-actions > .prompt-preview-toggle");
const card = (page, id) => page.locator(`.request-card-open[href*="request=${id}"]`);

async function open(page, id) {
    await card(page, id).click();
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await settled(page);
}

async function geometry(page) {
    return content(page).evaluate(node => {
        const style = getComputedStyle(node), body = document.querySelector("#contextSidebarBody");
        return { height: node.getBoundingClientRect().height, lineHeight: parseFloat(style.lineHeight),
            fullHeight: node.scrollHeight, overflow: style.overflowY, font: style.fontFamily, weight: style.fontWeight,
            horizontalOverflow: body.scrollWidth > body.clientWidth + 1 };
    });
}

async function collapsed(page) {
    await expect(bottomToggle(page)).toHaveText("Show full prompt");
    await expect(bottomToggle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(topToggle(page)).toBeHidden();
    const size = await geometry(page);
    assert.ok(Math.abs(size.height - size.lineHeight * 6) <= 1, JSON.stringify(size));
    assert.ok(size.fullHeight > size.height);
    assert.equal(size.overflow, "clip", "No nested prompt scroller");
    assert.equal(size.horizontalOverflow, false);
    assert.match(size.font, /Asta Sans/); assert.equal(size.weight, "400");
    return size;
}

async function capture(page, name) {
    if (!proofs) return;
    await mkdir(proofs, { recursive: true });
    await settled(page);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: path.join(proofs, name + ".png") });
}

test("long prompt previews preserve exact text, author, Copy and accessible repeated disclosure in both themes", async t => {
    const records = ["user", "agent", "unknown"].map(actor => record("long-" + actor, exactPrompt, actor));
    const { page } = await setup(t, records, { frozen: true });
    const measurements = [];
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        for (const actor of ["user", "agent", "unknown"]) {
            const id = "long-" + actor;
            await open(page, id);
            measurements.push({ theme, actor, ...await collapsed(page) });
            await expect(prompt(page).locator(".reader-section-title")).toHaveText(
                { user: "My prompt", agent: "Agent prompt", unknown: "Author unverified" }[actor]);
            await expect(prompt(page).locator(".reader-interaction-time")).toHaveText(
                await card(page, id).locator(".request-card-time").textContent());
            await expect(prompt(page).locator(".reader-interaction-time")).toBeInViewport();
            assert.equal(await content(page).textContent(), exactPrompt);
            await expect(page.locator('[data-reader-section="activity"] .reader-section-heading')).toBeInViewport();
            if (actor === "agent") await capture(page, "prompt-" + theme + "-collapsed");
            await prompt(page).getByRole("button", { name: "Copy prompt", exact: true }).click();
            assert.equal(await page.evaluate(() => window.promptCopies.at(-1)), exactPrompt);
            const copy = await prompt(page).getByRole("button", { name: "Copy prompt", exact: true }).elementHandle();
            await bottomToggle(page).focus();
            for (let iteration = 0; iteration < 2; iteration++) {
                await page.keyboard.press(iteration ? "Space" : "Enter");
                await expect(topToggle(page)).toBeFocused();
                await expect(topToggle(page)).toHaveAttribute("aria-expanded", "true");
                assert.equal(await content(page).textContent(), exactPrompt);
                const expanded = await geometry(page);
                assert.ok(Math.abs(expanded.height - expanded.fullHeight) <= 1);
                if (actor === "agent" && iteration === 0) await capture(page, "prompt-" + theme + "-expanded");
                if (iteration === 0) {
                    await bottomToggle(page).scrollIntoViewIfNeeded();
                    await bottomToggle(page).focus();
                    assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop) > 500);
                }
                await page.keyboard.press("Enter");
                await expect(bottomToggle(page)).toBeFocused();
                await collapsed(page);
                assert.ok(await page.locator("#contextSidebarBody").evaluate(node => node.scrollTop) <= 12);
                await expect(page.locator('[data-reader-section="activity"] .reader-section-heading')).toBeInViewport();
            }
            await page.keyboard.press("Escape");
            await expect(page.locator("#contextSidebar")).not.toBeVisible();
            await expect(card(page, id)).toBeFocused();
            const count = await page.evaluate(() => window.promptCopies.length);
            await copy.evaluate(node => node.click());
            assert.equal(await page.evaluate(() => window.promptCopies.length), count, "Detached Copy stays invalid");
        }
    }
    if (proofs) await writeFile(path.join(proofs, "prompt-measurements.json"), JSON.stringify(measurements, null, 2));
});

test("reader date matches its card in the chosen zone and keeps missing-message timing qualified", async t => {
    const dated = record("dated", "Read the invented Cedar notes.");
    dated.userPrompt.sourceTimestamp = "2026-10-01T06:59:00Z";
    dated.toolCalls[0].startedAt = "2026-10-01T07:02:00Z";
    const fallback = record("fallback", "Read the next invented Cedar note.", "agent");
    delete fallback.userPrompt.sourceTimestamp;
    fallback.toolCalls[0].startedAt = "2026-10-02T07:03:00Z";
    const missing = record("missing-time", "Read an undated invented Cedar note.", "unknown");
    delete missing.userPrompt.sourceTimestamp;
    missing.toolCalls[0].startedAt = null;
    const { page, runtime } = await setup(t, [dated, fallback, missing]);
    await page.evaluate(() => localStorage.setItem("workiq-evidence.time-zone", "America/Los_Angeles"));
    await page.goto(runtime.url);
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await settled(page);
    for (const [id, expected] of [
        ["dated", "Sep 30, 2026, 11:59 PM"],
        ["fallback", "First timed action: Oct 2, 2026, 12:03 AM"],
        ["missing-time", "Request time: Not recorded"],
    ]) {
        await open(page, id);
        const date = prompt(page).locator(".reader-interaction-time");
        await expect(date).toHaveText(expected);
        await expect(date).toHaveText(await card(page, id).locator(".request-card-time").textContent());
        await expect(date).toBeInViewport();
        await expect(page.locator('[data-reader-section="source"]')).toHaveAttribute("data-open", "false");
        const placement = await date.evaluate(node => ({
            belowPrompt: node.getBoundingClientRect().top >= node.previousElementSibling.getBoundingClientRect().bottom,
            aboveActivity: node.getBoundingClientRect().bottom <= document.querySelector('[data-reader-section="activity"]').getBoundingClientRect().top,
        }));
        assert.deepEqual(placement, { belowPrompt: true, aboveActivity: true });
    }
    await open(page, "dated");
    await chooseTheme(page, "dark");
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    await settled(page);
    await expect(prompt(page).locator(".reader-interaction-time")).toBeInViewport();
    assert.equal(await page.locator("#contextSidebarBody").evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
    await capture(page, "reader-date-narrow");
    await page.evaluate(() => localStorage.setItem("workiq-evidence.time-zone", "UTC"));
    await page.reload();
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await expect(prompt(page).locator(".reader-interaction-time")).toHaveText("Oct 1, 2026, 6:59 AM");
});

test("overflow is six actual lines, rechecks width and text size, and does not leak to another interaction", async t => {
    const six = "Cedar notes.\nOne decision.\nTwo questions.\nThree references.\nFour tasks.\nFive owners.";
    const seven = six + "\nSix milestones.";
    const records = [record("six-lines", six), record("seven-lines", seven),
        record("other-long"), record("resize", "Review the invented Cedar workshop notes and preserve the original source references. ".repeat(6))];
    const { page } = await setup(t, records);
    await open(page, "six-lines");
    await expect(bottomToggle(page)).toBeHidden();
    assert.equal(await content(page).textContent(), six);
    await capture(page, "prompt-six-lines-no-toggle");
    await open(page, "seven-lines"); await collapsed(page);
    await bottomToggle(page).click();
    await expect(topToggle(page)).toBeVisible();
    await open(page, "other-long"); await collapsed(page);
    await open(page, "seven-lines");
    await expect(topToggle(page)).toHaveAttribute("aria-expanded", "true");
    await topToggle(page).click();
    await open(page, "resize");
    await collapsed(page);
    await page.locator("#expandInteraction").click();
    await expect(page.locator("#contextSidebar")).toHaveAttribute("data-mode", "expanded");
    await expect(bottomToggle(page)).toBeHidden();
    await page.locator("#expandInteraction").click();
    await expect(page.locator("#contextSidebar")).toHaveAttribute("data-mode", "docked");
    await collapsed(page);
    await page.locator("#readerResize").focus(); await page.keyboard.press("Home");
    await collapsed(page);
    await capture(page, "prompt-narrow-docked");
    await chooseTheme(page, "dark");
    await page.setViewportSize({ width: 390, height: 1000 });
    await page.evaluate(() => document.documentElement.style.fontSize = "200%");
    await expect(page.locator("#contextSidebar")).toHaveAttribute("data-mode", "overlay");
    await settled(page);
    await collapsed(page);
    await expect(bottomToggle(page)).toBeInViewport();
    await capture(page, "prompt-dark-narrow-enlarged");
    await bottomToggle(page).click();
    await expect(topToggle(page)).toBeFocused();
    await page.keyboard.press("Enter");
    await collapsed(page);
    await expect(bottomToggle(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
});

test("Search opens the full long prompt and Back preserves the literal result and its focus", async t => {
    const { page } = await setup(t, [record("search-long")]);
    await open(page, "search-long");
    await collapsed(page);
    await page.locator("#closeContextSidebar").click();
    await page.locator("#wireSearch").fill("violet-lantern");
    const hit = page.locator('.wire-search-hit[data-search-type="interaction"]');
    await expect(hit).toHaveCount(1);
    await expect(hit.locator("mark")).toHaveText("violet-lantern");
    await hit.focus(); await page.keyboard.press("Enter");
    await expect(page.locator("#contextSidebar[open]")).toBeVisible();
    await expect(topToggle(page)).toHaveAttribute("aria-expanded", "true");
    assert.equal(await content(page).textContent(), exactPrompt);
    const expanded = await geometry(page);
    assert.ok(Math.abs(expanded.height - expanded.fullHeight) <= 1, "The Search destination is not clipped");
    await bottomToggle(page).scrollIntoViewIfNeeded();
    await capture(page, "prompt-search-ending");
    await page.goBack();
    await expect(page.locator("#contextSidebar")).not.toBeVisible();
    await expect(page.locator("#wireSearch")).toHaveValue("violet-lantern");
    await expect(hit).toBeFocused();
    await capture(page, "prompt-search-return");
    assert.ok(!page.url().includes("violet"));
});
