import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";
import { loadBoardState } from "../lib/store.mjs";
import { privateFixture, chooseTheme } from "./helpers.mjs";

test("the three adjacent Home explanation disclosures share typography and marker alignment", { timeout: 30000 }, async t => {
    const cleanup = [];
    const { context } = await privateFixture({ after: action => cleanup.push(action) });
    const before = await loadBoardState(context);
    const runtime = await startServer(context, createExportController(context), { port: 0, collector: { timers: false } });
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    const errors = [], requests = [], measurements = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.method() === "POST") requests.push(new URL(request.url()).pathname); });
    t.after(async () => {
        await browser.close(); await runtime.close();
        try {
            const after = await loadBoardState(context);
            for (const key of ["cards", "evidence", "exports", "pseudonymKey"]) assert.deepEqual(after[key], before[key]);
            assert.deepEqual(errors, []);
            assert.ok(requests.every(route => ["/api/snapshot", "/api/collection/status", "/api/assessment/overview",
                "/api/evaluation/automatic/summary"].includes(route)), "Only read-only snapshot, status and insight requests");
        } finally { for (const action of cleanup) await action(); }
    });
    await page.goto(runtime.url + "#home");
    await page.locator("#workspace[aria-busy=false]").waitFor();
    const selectors = ["#meaning>summary", "#serviceDefinitions>summary", "#coverage>summary"];
    const measure = () => page.evaluate(selectors => selectors.map(selector => {
        const node = document.querySelector(selector), style = getComputedStyle(node), marker = getComputedStyle(node, "::marker");
        const text = document.createRange(); text.setStart(node.firstChild, 0); text.setEnd(node.firstChild, 1);
        return { selector, text: node.textContent,
            typography: Object.fromEntries(["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "paddingTop", "paddingBottom"].map(key => [key, style[key]])),
            marker: { fontSize: marker.fontSize, fontWeight: marker.fontWeight },
            textInset: text.getBoundingClientRect().left - node.getBoundingClientRect().left,
            height: node.getBoundingClientRect().height };
    }), selectors);
    const proofs = process.env.WIRE_DISCLOSURE_TYPE_PROOFS;
    if (proofs) await mkdir(proofs, { recursive: true });
    for (const theme of ["light", "dark"]) for (const [width, scale] of [[1440, 1], [375, 1], [1440, 2], [375, 2]]) {
        await chooseTheme(page, theme);
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${scale * 100}%`; return document.fonts.ready; }, scale);
        const closed = await measure();
        for (const row of closed) {
            assert.equal(row.typography.fontSize, `${16 * scale}px`, `${row.text}: peer explanations use the same reading role`);
            assert.deepEqual(row.typography, closed[1].typography, `${theme}/${width}/${scale}: typography parity`);
            assert.deepEqual(row.marker, closed[1].marker, `${theme}/${width}/${scale}: marker parity`);
            assert.equal(row.textInset, closed[1].textInset, "Aligned disclosure text");
            assert.ok(row.height >= 44, "Accessible summary target");
        }
        measurements.push({ theme, width, scale, closed });
        if (proofs) {
            await page.locator(selectors[0]).scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(proofs, `disclosure-type-${theme}-${width}-${scale}.png`) });
        }
        for (const selector of selectors) {
            const summary = page.locator(selector);
            await summary.focus(); await page.keyboard.press("Enter");
            assert.equal(await summary.evaluate(node => node.parentElement.open), true);
            const opened = (await measure()).find(row => row.selector === selector);
            assert.deepEqual(opened.typography, closed.find(row => row.selector === selector).typography, "Opening does not change the heading role");
            await page.keyboard.press("Space");
            assert.equal(await summary.evaluate(node => node.parentElement.open), false);
        }
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    if (proofs) await writeFile(path.join(proofs, "typography-matrix.json"), JSON.stringify(measurements, null, 2));
});
