import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { privateFixture, fixture, navigateMain, navigateSettings, chooseTheme } from "./helpers.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";

function contrast(a, b) {
    const luminance = color => {
        assert.match(color, /^(rgb\(|color\(srgb )/);
        return color.match(/[\d.]+/g).slice(0, 3).map(Number)
            .map(x => color.startsWith("color(") ? x : x / 255)
            .map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4)
            .reduce((sum, x, i) => sum + x * [.2126, .7152, .0722][i], 0);
    };
    const one = luminance(a), two = luminance(b);
    return (Math.max(one, two) + .05) / (Math.min(one, two) + .05);
}

async function metrics(button) {
    return button.evaluate(node => {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        const texts = [];
        while (walker.nextNode()) if (walker.currentNode.textContent.trim()) {
            const range = document.createRange();
            range.selectNodeContents(walker.currentNode);
            texts.push(range.getBoundingClientRect());
        }
        const rect = node.getBoundingClientRect(), style = getComputedStyle(node), paint = getComputedStyle(node, "::before");
        const left = Math.min(...texts.map(rect => rect.left)), right = Math.max(...texts.map(rect => rect.right));
        const top = Math.min(...texts.map(rect => rect.top)), bottom = Math.max(...texts.map(rect => rect.bottom));
        return {
            xOffset: (left + right - rect.left - rect.right) / 2,
            yOffset: (top + bottom - rect.top - rect.bottom) / 2,
            height: rect.height, overflow: node.scrollWidth > node.clientWidth,
            foreground: style.color, background: paint.backgroundColor, border: paint.borderTopColor,
            faceInset: parseFloat(paint.top),
            paper: getComputedStyle(document.getElementById("deleteDialog")).backgroundColor,
            danger: style.getPropertyValue("--danger").trim(),
        };
    });
}

test("destructive confirmation keeps a readable filled face and separate native hit target in every theme/size/state", { timeout: 60000 }, async t => {
    const record = fixture("pill");
    record.toolCalls = Array.from({ length: 320 }, (_, index) => ({
        ...record.toolCalls[0], toolCallId: `pill-${index}`, startEventId: `pill-start-${index}`,
    }));
    const { context } = await privateFixture(t, [record]);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    t.after(async () => { await browser.close(); await runtime.close(); });
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    await page.goto(runtime.url);
    await page.locator("#workspace[aria-busy=false]").waitFor();
    await navigateMain(page, "settings");
    await navigateSettings(page, "data");
    const proof = process.env.DELETION_PILL_PROOF_DIR;
    if (proof) await mkdir(proof, { recursive: true });
    for (const theme of ["light", "dark"]) {
        await chooseTheme(page, theme);
        await page.locator("#deleteActivity").click();
        await page.locator("#deleteAll").check();
        await page.locator("#deletePreview").click();
        const button = page.locator("#deleteConfirm");
        await page.waitForFunction(() => document.querySelector("#deleteConfirm").textContent === "Delete 320 records");
        for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
            await page.setViewportSize({ width, height: 1000 });
            await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; }, scale);
            await page.locator("#deleteCancel").focus();
            await page.mouse.move(1, 1);
            for (const state of ["rest", "hover", "focus", "pressed"]) {
                if (state === "hover") await button.hover();
                if (state === "focus") { await page.mouse.move(1, 1); await button.focus(); }
                if (state === "pressed") { await button.hover(); await page.mouse.down(); }
                const value = await metrics(button), label = `${theme}/${width}/${scale}/${state}`;
                assert.ok(Math.abs(value.xOffset) <= 1, `${label}: horizontal label offset ${value.xOffset}`);
                assert.ok(Math.abs(value.yOffset) <= 2, `${label}: vertical label offset ${value.yOffset}`);
                assert.ok(value.height >= 44, label);
                assert.equal(value.overflow, false, label);
                assert.equal(value.faceInset, 6, `${label}: visible face is inset from the native target`);
                assert.ok(contrast(value.foreground, value.background) >= 4.5, `${label}: readable text`);
                assert.ok(contrast(value.background, value.paper) >= 3, `${label}: visible destructive face`);
                if (state === "rest") assert.equal(value.background, value.border, `${label}: the deliberate confirmation uses a filled danger action`);
                if (state === "pressed") {
                    await page.mouse.move(1, 1);
                    await page.mouse.up();
                    await page.evaluate(() => getSelection()?.removeAllRanges());
                }
            }
            if (proof) {
                await page.locator("#deleteCancel").focus();
                await page.locator("#deleteDialog .delete-actions").screenshot({ path: path.join(proof, `pill-${theme}-${width}-${scale * 100}.png`) });
            }
        }
        await page.keyboard.press("Escape");
        await page.evaluate(() => { document.documentElement.style.fontSize = "100%"; });
        await page.setViewportSize({ width: 1200, height: 1000 });
    }
    assert.equal((await loadBoardState(context)).deletion, undefined, "Geometry checks never confirm deletion");
});
