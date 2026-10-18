import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { recollectionFixture } from "./recollection-fixture.mjs";
import { chooseTheme, navigateSettings, openSourceEditor } from "./helpers.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { contrast } from "./color-measurements.mjs";

const proofs = process.env.WIRE_RESPONSE_SETTINGS_PROOFS;

test("response settings has one explained switch row, native draft semantics and separate confirmation", { timeout: 30000 }, async t => {
    const cleanups = [];
    const f = await recollectionFixture({ after: cleanup => cleanups.push(cleanup) });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1466, height: 1100 }, reducedMotion: "no-preference" });
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
    await openSourceEditor(page);
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
            const title = root.querySelector("h3"), track = root.querySelector(".select-toggle");
            return {
                unrelatedNotice: document.getElementById("settingsMessage").checkVisibility(),
                label: title.textContent,
                track: { width: track.getBoundingClientRect().width, height: track.getBoundingClientRect().height },
                alignment: Math.abs(title.getBoundingClientRect().y + title.getBoundingClientRect().height / 2
                    - (track.getBoundingClientRect().y + track.getBoundingClientRect().height / 2)),
                visibleParagraphs: [...root.querySelectorAll("p")].filter(node => node.checkVisibility()).length,
                visibleButtons: [...root.querySelectorAll("button")].filter(node => node.checkVisibility()).map(node => node.textContent),
                technicalDetails: Boolean(root.querySelector("details:not([open])")),
            };
        }));
        if (proofs) await page.screenshot({ path: path.join(proofs, `${theme}-response-settings.png`), fullPage: true });
    }
    if (proofs) await writeFile(path.join(proofs, "response-settings.json"), JSON.stringify(evidence, null, 2));
    for (const value of evidence) {
        assert.equal(value.unrelatedNotice, false, "Connection draft cancellation cannot describe this separate response setting");
        assert.equal(value.label, "Save Copilot replies locally");
        assert.deepEqual(value.track, { width: 32, height: 20 }, "Reuse filter switch geometry, not an oversized control");
        assert.ok(value.alignment <= 1, "Painted track centers on the label line, not the description");
        assert.equal(value.visibleParagraphs, 1, "The local saving and off/deletion consequence stays visible before editing");
        assert.deepEqual(value.visibleButtons, [], "No idle Save/Cancel actions when there is no change");
        assert.equal(value.technicalDetails, false, "No standing explanation disclosure for an on/off choice");
    }
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1466]) for (const scale of [1, 2]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1100 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const choice = pane.getByRole("switch", { name: "Save Copilot replies locally", exact: true });
        await expect(choice).toHaveAccessibleDescription(/Keep recorded Copilot replies on this device.*Turning this off deletes/);
        await choice.focus();
        await page.keyboard.press("Space");
        await expect(choice).toBeChecked();
        await expect(pane.getByRole("button", { name: "Turn on response saving", exact: true })).toBeEnabled();
        await expect(pane.locator(".assessment-applied")).toHaveText("Response saving is off. This change is not saved yet.");
        await expect(pane.getByText(/Saves recorded Copilot replies locally, excluding detected credentials/)).toBeVisible();
        await expect(pane.getByText(/Replies may be incomplete or not final/)).toBeVisible();
        await expect.poll(() => pane.locator(".select-toggle").evaluate(node => getComputedStyle(node, "::after").transform))
            .toBe("matrix(1, 0, 0, 1, 12, 0)");
        const boundaryOrder = await pane.evaluate(root => {
            const boundary = root.querySelector(".assessment-capture-details"), submit = root.querySelector("button[type=submit]");
            return Boolean(boundary.compareDocumentPosition(submit) & Node.DOCUMENT_POSITION_FOLLOWING);
        });
        assert.equal(boundaryOrder, true, "Capture scope and limitations precede explicit confirmation");
        const layout = await pane.evaluate(root => {
            const choice = root.querySelector(".settings-switch"), input = choice.querySelector("input"), track = choice.querySelector(".select-toggle");
            const paint = getComputedStyle(track), thumb = getComputedStyle(track, "::after");
            return {
                target: choice.getBoundingClientRect().height,
                nativeTarget: { width: input.getBoundingClientRect().width, height: input.getBoundingClientRect().height },
                focus: paint.outlineStyle,
                fill: paint.backgroundColor, thumb: thumb.backgroundColor,
                overflow: document.documentElement.scrollWidth > innerWidth,
                clipped: [...root.querySelectorAll("button,summary,label,p")].filter(node => node.checkVisibility())
                    .some(node => node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight),
                actionLeft: root.querySelector("button[type=submit]").getBoundingClientRect().left,
                choiceLeft: root.querySelector("h3").getBoundingClientRect().left,
            };
        });
        assert.equal(layout.focus, "solid");
        assert.ok(contrast(layout.fill, layout.thumb) >= 3);
        assert.ok(layout.target >= 44);
        assert.deepEqual(layout.nativeTarget, { width: 44, height: 44 });
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
        await expect(pane.locator(".assessment-capture-details")).toBeHidden();
        await pane.locator("h3 label").click();
        await expect(choice).toBeChecked();
        await choice.click();
        await expect(choice).not.toBeChecked();
        await expect(pane.getByRole("button")).toHaveCount(0);
    }
    await page.emulateMedia({ forcedColors: "active" });
    const choice = pane.getByRole("switch", { name: "Save Copilot replies locally", exact: true });
    const paint = () => pane.locator(".select-toggle").evaluate(node => ({
        fill: getComputedStyle(node).backgroundColor, thumb: getComputedStyle(node, "::after").backgroundColor,
        focus: getComputedStyle(node).outlineStyle,
    }));
    const off = await paint();
    await choice.focus(); await page.keyboard.press("Space");
    await expect(choice).toBeChecked();
    await expect.poll(() => pane.locator(".select-toggle").evaluate(node => getComputedStyle(node, "::after").transform))
        .toBe("matrix(1, 0, 0, 1, 12, 0)");
    const on = await paint();
    assert.notEqual(off.fill, on.fill);
    assert.ok(contrast(on.fill, on.thumb) >= 3);
    assert.equal(on.focus, "solid");
    if (proofs) await page.screenshot({ path: path.join(proofs, "reply-forced-colors-focus.png"), fullPage: true });
    await pane.getByRole("button", { name: "Discard change", exact: true }).click();
    await expect(choice).not.toBeChecked();
});
