import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { recollectionFixture } from "./recollection-fixture.mjs";
import { chooseTheme, navigateSettings } from "./helpers.mjs";
import { loadBoardState } from "../lib/store.mjs";

const proofs = process.env.WIRE_RESPONSE_SETTINGS_PROOFS;

test("response settings explains the choice beside its checkbox without unrelated cancellation or technical paragraphs", { timeout: 30000 }, async t => {
    const cleanups = [];
    const f = await recollectionFixture({ after: cleanup => cleanups.push(cleanup) });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1466, height: 1100 }, reducedMotion: "reduce" });
    const blocked = [], errors = [];
    const before = await loadBoardState(f.context);
    const bytes = await Promise.all([...f.files, f.dbPath].map(file => readFile(file)));
    t.after(async () => {
        try {
            await browser.close();
            assert.deepEqual(errors, []);
            assert.deepEqual(blocked, [], "Only local reads are allowed during layout and draft cancellation");
            assert.deepEqual((await loadBoardState(f.context)).personalEvaluation, before.personalEvaluation);
            assert.deepEqual(await Promise.all([...f.files, f.dbPath].map(file => readFile(file))), bytes);
        } finally { for (const cleanup of cleanups) await cleanup(); }
    });
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin === new URL(f.runtime.url).origin && (request.method() === "GET" ||
            ["/api/session", "/api/snapshot", "/api/collection/status", "/api/assessment/consent", "/api/evaluation/automatic/summary"].includes(url.pathname))) return route.continue();
        blocked.push(`${request.method()} ${url.pathname}`);
        return route.abort();
    });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(f.runtime.url + "#settings?section=connection");
    await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false");
    await page.locator("#editSource").click();
    await page.locator("#sourceDatabase").fill(f.dbPath + ".unsaved");
    await page.locator("#cancelSource").click();
    await navigateSettings(page, "privacy");
    const pane = page.locator("#assessmentSetup");
    await pane.locator("input[type=checkbox]").waitFor();
    if (proofs) await mkdir(proofs, { recursive: true });
    const evidence = [];
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.evaluate(() => document.fonts.ready);
        await page.mouse.move(0, 0);
        evidence.push(await page.evaluate(() => {
            const root = document.getElementById("assessmentSetup"), input = root.querySelector("input[type=checkbox]");
            const label = input.closest("label"), text = label.querySelector("span");
            return {
                unrelatedNotice: document.getElementById("settingsMessage").checkVisibility(),
                label: text.textContent, gap: text.getBoundingClientRect().left - input.getBoundingClientRect().right,
                visibleParagraphs: [...root.querySelectorAll("p")].filter(node => node.checkVisibility()).length,
                visibleButtons: [...root.querySelectorAll("button")].filter(node => node.checkVisibility()).map(node => node.textContent),
                technicalDetails: Boolean(root.querySelector("details:not([open])")),
            };
        }));
        if (proofs) await page.screenshot({ path: path.join(proofs, `${theme}-response-settings.png`) });
    }
    if (proofs) await writeFile(path.join(proofs, "response-settings.json"), JSON.stringify(evidence, null, 2));
    for (const value of evidence) {
        assert.equal(value.unrelatedNotice, false, "Connection draft cancellation cannot describe this separate response setting");
        assert.equal(value.label, "Save Copilot replies locally");
        assert.ok(value.gap >= 7 && value.gap <= 9, "Checkbox belongs beside its words");
        assert.equal(value.visibleParagraphs, 1, "Only the current state needs a paragraph; the label names this local collection choice");
        assert.deepEqual(value.visibleButtons, [], "No idle Save/Cancel actions when there is no change");
        assert.equal(value.technicalDetails, true);
    }
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1466]) for (const scale of [1, 2]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1100 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const choice = pane.getByRole("checkbox", { name: "Save Copilot replies locally", exact: true });
        await choice.focus();
        await page.keyboard.press("Space");
        await expect(choice).toBeChecked();
        await expect(pane.getByRole("button", { name: "Turn on response saving", exact: true })).toBeEnabled();
        await expect(pane.locator(".assessment-applied")).toHaveText("Response saving is off. This change is not saved yet.");
        const layout = await pane.evaluate(root => {
            const choice = root.querySelector("label"), input = choice.querySelector("input"), text = choice.querySelector("span");
            return {
                gap: text.getBoundingClientRect().left - input.getBoundingClientRect().right,
                target: choice.getBoundingClientRect().height,
                focus: getComputedStyle(input).outlineStyle,
                overflow: document.documentElement.scrollWidth > innerWidth,
                clipped: [...root.querySelectorAll("button,summary,label,p")].filter(node => node.checkVisibility())
                    .some(node => node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight),
                actionLeft: root.querySelector("button[type=submit]").getBoundingClientRect().left,
                choiceLeft: choice.getBoundingClientRect().left,
            };
        });
        assert.equal(layout.focus, "solid");
        assert.ok(layout.gap >= 7 && layout.gap <= 9);
        assert.ok(layout.target >= 44);
        assert.equal(layout.overflow, false);
        assert.equal(layout.clipped, false);
        assert.equal(layout.actionLeft, layout.choiceLeft, "The next action stays with the choice, not across the page");
        if (proofs && (width === 375 || width === 1466 && scale === 1)) {
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: path.join(proofs, `${theme}-${width}-${scale}-draft.png`), fullPage: true });
        }
        await pane.getByRole("button", { name: "Discard change", exact: true }).click();
        await expect(choice).not.toBeChecked();
        await expect(choice).toBeFocused();
        await expect(pane.getByRole("button")).toHaveCount(0);
        await pane.locator("details>summary").focus();
        await page.keyboard.press("Enter");
        await expect(pane.getByText(/Only assistant replies already recorded/)).toBeVisible();
        await expect(pane.getByText(/Up to 64 KiB/)).toBeVisible();
        if (proofs && width === 375 && scale === 2) {
            await page.evaluate(() => scrollTo(0, 0));
            await page.screenshot({ path: path.join(proofs, `${theme}-details.png`), fullPage: true });
        }
        await page.keyboard.press("Enter");
        await expect(pane.locator("details")).not.toHaveAttribute("open", "");
    }
});
