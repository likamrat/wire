import test from "node:test";
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { privateFixture, fixture, navigateMain } from "./helpers.mjs";
import { createCopilotRuntimeAccess } from "../lib/runtime-access.mjs";
import { createExportController } from "../lib/export.mjs";
import { startServer } from "../lib/server.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { contrast } from "./color-measurements.mjs";
import { palettes } from "../web/theme.mjs";

test("report actions and call counts keep their columns while palettes distinguish add and remove", { timeout: 90000 }, async t => {
    const counts = [1, 3, 4, 12];
    const records = counts.map((n, i) => {
        const r = fixture(`column-${i}`);
        r.capturedAt = new Date().toISOString(); r.userPrompt.sourceTimestamp = r.capturedAt;
        r.toolCalls = Array.from({ length: n }, (_, j) => ({ ...r.toolCalls[0], toolCallId: `column-${i}-${j}`,
            startEventId: `start-${i}-${j}`, startedAt: r.capturedAt }));
        return r;
    });
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    const access = await createCopilotRuntimeAccess(context);
    const server = await startServer(context, createExportController(context), { port: 0, frontend: "react", access, collector: { timers: false } });
    const browser = await chromium.launch(process.env.WIRE_FRONTEND_BROWSER ? { channel: process.env.WIRE_FRONTEND_BROWSER } : {});
    t.after(async () => { await browser.close(); await server.close(); await access.close(); for (const fn of cleanup.reverse()) await fn(); });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    await page.goto(server.url + "#analyze");
    const rows = page.locator("#activityList .card-reading-actions"), action = rows.first().locator(".report-draft-trigger");
    await expect(rows).toHaveCount(4);
    const geometry = () => rows.evaluateAll(footers => footers.map(footer => {
        const b = footer.querySelector(".report-draft-trigger"), link = footer.querySelector(".card-panel-link");
        const rect = el => el.getBoundingClientRect();
        const text = node => { const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect(); };
        return [rect(b.querySelector("svg")).x, text(b.lastElementChild).x, rect(link.querySelector("svg")).x,
            text(link.lastChild).x, rect(footer).height];
    }));
    const picker = page.getByRole("dialog", { name: "Report drafts", exact: true });
    const notice = page.locator(".report-draft-confirmation");
    const ink = button => button.evaluate(node => {
        // Chromium can report interpolated colors in OKLab. Sample their actual sRGB paint.
        const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
        return [getComputedStyle(node).color, getComputedStyle(node, node.matches(".report-draft-trigger") ? "::before" : null).backgroundColor]
            .map(value => {
                ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
                return `rgb(${[...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).join(",")})`;
            });
    });
    for (const [width, scale] of [[1440, 1], [390, 1.25]]) {
        await page.setViewportSize({ width, height: 900 }); await page.evaluate(n => document.documentElement.style.fontSize = `${n * 100}%`, scale);
        await expect(action.locator("span")).toBeVisible(); await expect(action.locator("svg")).toHaveAttribute("data-lucide-icon", "clipboard-plus");
        const before = await geometry();
        for (const row of before) assert.deepEqual(row.slice(0, 4), before[0].slice(0, 4));
        for (const palette of Object.keys(palettes)) for (const theme of ["light", "dark"]) {
            await page.evaluate(([palette, theme]) => {
                document.documentElement.dataset.evidencePalette = palette; document.documentElement.dataset.evidenceTheme = theme;
            }, [palette, theme]);
            const verify = async control => { const [fg,bg] = await ink(control); assert.ok(contrast(fg,bg) >= 4.5, `${palette}/${theme}: ${fg} on ${bg}`); };
            await page.mouse.move(0, 0); await verify(action); await action.hover(); await verify(action);
            await action.click();
            await expect(picker.getByRole("button", { name: "New draft", exact: true })).toBeEnabled();
            if (await picker.getByRole("button", { name: "Add to Launch readiness" }).count() === 0) {
                await picker.getByRole("button", { name: "New draft", exact: true }).click();
                await picker.getByLabel("Draft name").fill("Launch readiness"); await picker.getByRole("button", { name: "Create draft and add" }).click();
            } else await picker.getByRole("button", { name: "Add to Launch readiness" }).click();
            await expect(notice).toHaveText("Added to Launch readiness"); await verify(notice);
            await expect(action.locator("svg")).toHaveAttribute("data-lucide-icon","clipboard-check");
            assert.deepEqual(await geometry(), before);
            await action.click(); await picker.getByRole("button", { name: "Remove from Launch readiness" }).click();
            await expect(notice).toHaveText("Removed from Launch readiness"); await verify(notice);
            await expect(notice.locator("svg")).toHaveAttribute("data-lucide-icon","clipboard-minus");
        }
    }
});

test("Analyze and its reader edit distinct named drafts through Prepare, Save and verified Open", { timeout: 90000 }, async t => {
    const records = ["x", "y"].map((id, i) => {
        const r = fixture(id);
        r.capturedAt = new Date().toISOString(); r.userPrompt.text = i ? "Find the handoff schedule." : "Find the release checklist.";
        r.userPrompt.sourceTimestamp = r.capturedAt; r.userPrompt.authorship = { actor: "user", basis: "source-user" }; r.toolCalls[0].startedAt = r.capturedAt;
        r.toolCalls[0].toolSucceeded = !i; r.toolCalls[0].reportedOutcome = i ? "failed" : "succeeded";
        return r;
    });
    const cleanup = [], { context } = await privateFixture({ after: fn => cleanup.push(fn) }, records);
    const access = await createCopilotRuntimeAccess(context);
    const server = await startServer(context, createExportController(context), { port: 0, frontend: "react", access, collector: { timers: false } });
    const browser = await chromium.launch(process.env.WIRE_FRONTEND_BROWSER ? { channel: process.env.WIRE_FRONTEND_BROWSER } : {});
    t.after(async () => { await browser.close(); await server.close(); await access.close(); for (const fn of cleanup.reverse()) await fn(); });
    const profile = await browser.newContext({ viewport: { width: 1280, height: 880 } });
    const page = await profile.newPage();
    page.setDefaultTimeout(6000);
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    const proof = process.env.WIRE_FRONTEND_PROOFS;
    async function capture(name) {
        if (!proof) return;
        await mkdir(proof, { recursive: true });
        await page.screenshot({ path: path.join(proof, `draft-${name}.png`) });
    }
    await page.goto(server.url + "#analyze");
    const card = id => page.locator(`#activityList [data-view-key="request:${id}"]`);
    const action = id => card(id).locator(".report-draft-trigger");
    const panel = page.getByRole("dialog", { name: "Report drafts", exact: true });
    const reader = page.locator("#contextSidebar"), readerAction = reader.locator(".reader-section-jumps .report-draft-trigger");
    const delayedList = Promise.withResolvers(), releaseList = Promise.withResolvers();
    await page.route("**/api/report-drafts/list", async route => {
        delayedList.resolve(); await releaseList.promise; await route.continue();
    }, { times: 1 });
    t.after(() => releaseList.resolve());
    const staleTab = await profile.newPage();
    await staleTab.goto(server.url + "#analyze");
    await expect(staleTab.locator("#activityList .report-draft-trigger").first()).toBeVisible();
    await action("x").click();
    await delayedList.promise;
    await expect(panel.getByRole("searchbox")).toBeVisible();
    try {
        await expect(panel.getByRole("searchbox", { name: "Search drafts" })).toBeFocused();
        await expect(panel).toContainText("Loading drafts");
        await expect(panel).not.toContainText("No drafts yet.");
        await expect(panel.getByRole("button", { name: "New draft", exact: true })).toBeDisabled();
    } finally { releaseList.resolve(); }
    await expect(panel).toContainText("No drafts yet.");
    await expect(panel.getByLabel("Draft name", { exact: true })).toBeHidden();
    await expect(panel.getByRole("link", { name: "Saved library" })).toHaveAttribute("href", /reports\?.*task=library/);
    await capture("empty");
    await panel.getByRole("button", { name: "New draft", exact: true }).click();
    await expect(panel.getByRole("searchbox")).toBeVisible();
    const fieldHeights = await panel.locator("input").evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().height));
    assert.ok(fieldHeights.every(h => h > 0 && h <= 40), `Compact search and name fields: ${fieldHeights}`);
    await capture("create");
    await panel.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(panel.getByRole("button", { name: "New draft", exact: true })).toBeFocused();
    await panel.getByRole("button", { name: "New draft", exact: true }).press("Enter");
    await panel.getByLabel("Draft name").fill("Release review");
    await panel.getByRole("button", { name: "Create draft and add" }).click();
    await expect(action("x")).toContainText("Release review");
    // This panel's accepted Analyze snapshot predates creation in the other panel.
    await staleTab.locator("#activityList .report-draft-trigger").first().click();
    const stalePicker = staleTab.getByRole("dialog", { name: "Report drafts", exact: true });
    await expect(stalePicker.locator(".draft-choice")).toHaveText(/Release review/);
    await stalePicker.getByRole("link", { name: "Saved library", exact: true }).click();
    await expect(staleTab).toHaveURL(/\/reports\?.*task=library/);
    await expect(stalePicker).toHaveCount(0);
    await staleTab.close();
    await card("y").locator(".request-card-open").click(); await expect(readerAction).toBeVisible();
    await page.waitForFunction(() => !document.querySelector("#contextSidebar").getAnimations().length);
    await page.waitForFunction(() => document.querySelector("#contextSidebar").dataset.mode === "docked" && !document.getAnimations().some(a => a.playState === "running"));
    const anchor = () => page.evaluate(() => [location.href, scrollY, document.querySelector("#contextSidebarBody").scrollTop]);
    // The first access/status publication and sidebar sizing can still settle after the entrance animation.
    await page.evaluate(() => new Promise(resolve => {
        let prior, stableAt = performance.now();
        function frame() {
            const sample = [scrollY, document.querySelector("#main").offsetWidth, document.documentElement.scrollHeight].join(":");
            if (sample !== prior) { prior = sample; stableAt = performance.now(); }
            if (performance.now() - stableAt >= 1100) resolve(); else requestAnimationFrame(frame);
        }
        frame();
    }));
    const before = await anchor();
    await capture("reader");
    const source = reader.getByRole("button", { name: "Source", exact: true });
    const style = b => b.evaluate(n => {
        const s = getComputedStyle(n), g = getComputedStyle(n.querySelector("svg"));
        return [s.fontSize, s.minHeight, s.columnGap, s.textDecorationLine, g.width, g.height, n.getBoundingClientRect().y];
    });
    assert.deepEqual(await style(readerAction), await style(source));
    await readerAction.hover(); assert.equal((await style(readerAction))[3], "none");
    await page.mouse.down(); assert.equal((await style(readerAction))[3], "none"); await page.mouse.up();
    await page.keyboard.press("Escape"); await expect(readerAction).toBeFocused();
    await readerAction.click(); await expect(panel.getByRole("button", { name: "Add to Release review" })).toBeVisible();
    await capture("picker");
    await panel.getByRole("searchbox").fill("name that does not exist");
    await expect(panel).toContainText("No matching drafts."); await expect(panel).not.toContainText("No drafts yet.");
    await expect(panel.getByLabel("Draft name", { exact: true })).toBeHidden();
    await panel.getByRole("button", { name: "Clear draft search" }).click();
    await panel.getByRole("searchbox").press("ArrowDown");
    await expect(panel.getByRole("button", { name: "Add to Release review" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(readerAction).toContainText("Release review"); await expect(readerAction).toBeFocused();
    assert.deepEqual(await anchor(), before);
    await readerAction.click(); await panel.getByRole("button", { name: "New draft" }).click();
    await panel.getByLabel("Draft name").fill("Handoff"); await panel.getByRole("button", { name: "Create draft and add" }).click();
    await expect(readerAction).toContainText("(+1)");
    await readerAction.click(); await panel.getByRole("searchbox").fill("lease");
    await expect(panel.getByRole("button", { name: "Remove from Handoff" })).toHaveCount(0);
    await capture("filter"); await panel.getByRole("button", { name: "Remove from Release review" }).click();
    await expect(readerAction).toContainText("Handoff"); await expect(readerAction).not.toContainText("Release review");
    assert.deepEqual(await anchor(), before); await capture("added");
    await page.locator("#closeContextSidebar").click(); await page.reload();
    await expect(action("x")).toContainText("Release review"); await expect(action("y")).toContainText("Handoff");
    await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => document.documentElement.style.fontSize = "125%");
    await card("y").locator(".request-card-open").click(); await readerAction.click();
    await panel.getByRole("searchbox").fill("review"); await capture("narrow-filter"); await page.keyboard.press("Escape");
    await expect(readerAction).toBeFocused(); await expect(reader).toBeVisible(); await page.locator("#closeContextSidebar").click();
    await page.setViewportSize({ width: 1280, height: 880 }); await page.evaluate(() => document.documentElement.style.removeProperty("font-size"));
    for (const [i, draftName] of ["Release review", "Handoff"].entries()) {
        await navigateMain(page, "reports");
        await page.locator("#namedReportDraft").selectOption({ label: draftName });
        await page.getByRole("button", { name: /^Formats:/ }).click();
        await page.locator("#formatOptions input[value=json]").check();
        await page.keyboard.press("Escape");
        const preparing = page.waitForResponse(r => r.url().endsWith("/api/preview"));
        await page.locator("#prepareReportPreview").click(); const response = await preparing, prepared = await response.json();
        assert.equal(response.status(), 200, prepared.error);
        assert.equal(prepared.snapshot.selectionScope.requestGroups, 1);
        assert.ok(JSON.stringify(prepared.snapshot).includes(records[i].userPrompt.text));
        assert.ok(!JSON.stringify(prepared.snapshot).includes(records[1-i].userPrompt.text));
        if (!i) {
            // A later edit from a second panel must not recapture the currently prepared selection.
            const other = await page.context().newPage(); await other.goto(server.url + "#analyze");
            const otherButton = other.locator('#activityList [data-view-key="request:y"] .report-draft-trigger');
            await otherButton.click(); await other.getByRole("button", { name: "Add to Release review", exact: true }).click();
            await expect(otherButton).toContainText("(+1)"); await other.close();
        }
        await page.getByRole("button", { name: "Save report", exact: true }).click();
        await expect(page.locator("#reportsView")).toHaveAttribute("data-report-phase", "saved");
        const bundle = (await loadBoardState(context)).exports.find(b => b.bundleId === prepared.bundleId);
        const json = JSON.parse(await readFile(bundle.files["product-report.json"], "utf8"));
        assert.ok(JSON.stringify(json).includes(records[i].userPrompt.text));
        assert.ok(!JSON.stringify(json).includes(records[1-i].userPrompt.text));
        await page.getByRole("button", { name: "Open saved report", exact: true }).click();
        await expect(page.locator("#savedReportReader .saved-brief")).toBeVisible();
        const reopened = page.waitForResponse(r => r.url().endsWith("/api/report/open"));
        await page.reload();
        const verified = await reopened; assert.equal(verified.status(), 200);
        const documentText = JSON.stringify(await verified.json());
        assert.ok(documentText.includes(records[i].userPrompt.text));
        assert.ok(!documentText.includes(records[1-i].userPrompt.text));
        await expect(page.locator("#savedReportReader .saved-brief")).toBeVisible();
        await capture(`reopened-${i}`);
        await page.goto(server.url + "#analyze");
    }
    assert.deepEqual(errors, []);
});
