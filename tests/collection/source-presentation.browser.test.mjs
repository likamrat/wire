import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { isPagePath } from "../../lib/page-path.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { renderHtmlShell } from "../../lib/render.mjs";
import { buildActivityAnalytics } from "../../lib/activity-analytics.mjs";
import { fixture, exportCatalogFor, navigateMain, navigateSettings, chooseTheme, openSourceEditor, UNBOUND_FIXTURE_BOOTSTRAP } from "../support/helpers.mjs";
import { contrast } from "../support/color-measurements.mjs";

const proofs = process.env.WORKIQ_SOURCE_PRESENTATION_PROOFS;
const paths = {
    appDbPath: "C:\\Synthetic source\\metadata\\data.db",
    sessionRoot: "C:\\Synthetic source\\history\\session-state",
};
const longPaths = {
    appDbPath: `C:\\Synthetic  source\\\u65e5\u672c\u8a9e\\${"unbroken".repeat(24)}\\metadata tail\\data.db`,
    sessionRoot: `C:\\Synthetic  history\\\u00c5ngstr\u00f6m\\${"history".repeat(28)}\\exact tail\\session-state`,
};
async function ready(page) { await expect(page.locator("#workspace")).toHaveAttribute("aria-busy", "false"); }
async function setup(t) {
    const records = [fixture("source-presentation")], writes = [], errors = [];
    let currentPaths = paths;
    const server = createServer(async (req, res) => {
        if (req.method === "GET" && isPagePath(req.url.split("?")[0])) {
            res.setHeader("Content-Type", "text/html");
            return res.end(renderHtmlShell("a".repeat(64), "source-presentation-proof", UNBOUND_FIXTURE_BOOTSTRAP));
        }
        if (req.method === "GET" && ["/favicon.ico", "/favicon.svg"].includes(req.url)) return res.writeHead(204).end();
        if (req.method === "GET" && req.url === "/assets/marked.mjs") {
            res.setHeader("Content-Type", "text/javascript");
            return res.end(await readFile(new URL("../../node_modules/marked/lib/marked.esm.js", import.meta.url)));
        }
        let body = ""; for await (const part of req) body += part;
        const input = body ? JSON.parse(body) : {};
        const collection = {
            revision: 1, configVersion: 1, state: "collecting-on-interval", connected: true,
            config: { approved: true, enabled: true, ...currentPaths, windowDays: 30, pollSeconds: 5 },
            cadence: { pollSeconds: 5 }, metrics: {},
        };
        res.setHeader("Content-Type", "application/json");
        if (req.url === "/api/snapshot") return res.end(JSON.stringify({
            revision: 1, scenarios: records, sessions: [], exports: [], exportCatalog: exportCatalogFor(records),
            coverage: { notes: [] }, collection, analytics: { ...buildActivityAnalytics(records, input), revision: 1 },
        }));
        if (req.url === "/api/collection/status") return res.end(JSON.stringify(collection));
        writes.push(req.url);
        res.writeHead(403).end(JSON.stringify({ error: "Source presentation proof does not permit mutations." }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
        window.sourceModality = "load";
        addEventListener("pointerdown", () => { window.sourceModality = "pointer"; }, true);
        addEventListener("keydown", () => { window.sourceModality = "keyboard"; }, true);
    });
    t.after(async () => {
        await browser.close(); await new Promise(resolve => server.close(resolve));
        assert.deepEqual(writes, [], "Navigation, presentation and cancel never mutate backend state");
        assert.deepEqual(errors, []);
    });
    if (proofs) await mkdir(proofs, { recursive: true });
    await page.goto(url + "settings?section=source-access&setting=source-paths"); await ready(page);
    return { page, url, setPaths: next => { currentPaths = next; } };
}
async function effectivePaper(page, selector) {
    return page.locator(selector).evaluate(node => {
        for (let surface = node; surface; surface = surface.parentElement) {
            const color = getComputedStyle(surface).backgroundColor;
            if (color !== "transparent" && color !== "rgba(0, 0, 0, 0)") return color;
        }
        throw new Error("The source view has no rendered opaque surface.");
    });
}
async function heading(page, id = "approvedSourceTitle") {
    await page.evaluate(() => document.fonts.ready);
    const measured = await page.locator("#" + id).evaluate(node => {
        const css = getComputedStyle(node), cue = getComputedStyle(node, "::before");
        return {
            active: document.activeElement.id, modality: window.sourceModality,
            focused: node === document.activeElement, focusVisible: node.matches(":focus-visible"),
            tag: node.tagName, tabIndex: node.tabIndex, className: node.className,
            size: css.fontSize, weight: css.fontWeight, family: css.fontFamily, lineHeight: css.lineHeight,
            border: css.borderWidth, outline: css.outlineStyle, outlineWidth: css.outlineWidth,
            radius: css.borderRadius, cursor: css.cursor, cue: cue.content, cueFill: cue.backgroundColor,
            cueWidth: cue.width,
        };
    });
    return { ...measured, paper: await effectivePaper(page, "#" + id) };
}
async function keyboardActivate(page, locator) {
    for (let step = 0; step < 40 && !await locator.evaluate(node => node === document.activeElement); step++) {
        await page.keyboard.press("Tab");
    }
    await expect(locator).toBeFocused();
    await page.keyboard.press("Enter");
}
async function save(name, data) {
    if (proofs) await writeFile(path.join(proofs, name + ".json"), JSON.stringify(data, null, 2));
}
async function captureSource(page, name) {
    if (!proofs) return;
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: viewport.width, height: await page.evaluate(() => Math.max(innerHeight, document.documentElement.scrollHeight)) });
    await page.evaluate(() => scrollTo(0, 0));
    await page.locator("[data-settings-section=source-access]").screenshot({ path: path.join(proofs, name + ".png") });
    await page.setViewportSize(viewport);
}

test("source path search restores the original destination without re-focusing it during polling", async t => {
    const { page } = await setup(t);
    const title = page.locator("#approvedSourceTitle"), search = page.locator("#settingsSearch");
    await expect(title).toBeFocused();
    await navigateSettings(page, "regional");
    await search.fill("source paths");
    const hit = page.locator('#settingsSearchResults a[data-setting="source-paths"]');
    await keyboardActivate(page, hit);
    await expect(title).toBeFocused();
    await expect(page.locator("#approvedDatabase")).toHaveText(paths.appDbPath);
    await page.goBack(); await expect(hit).toBeFocused();
    await hit.click(); await expect(title).toBeFocused();
    await search.click();
    await page.waitForResponse(r => r.url().endsWith("/api/collection/status"));
    await expect(search).toBeFocused();
    await expect(page.locator("#sourceEditor")).toBeHidden();
});

test("readonly source roles, exact long paths and control geometry remain coherent in both themes and text scales", { timeout: 120000 }, async t => {
    const { page, setPaths } = await setup(t), measurements = [];
    setPaths(longPaths); await page.reload(); await ready(page);
    await page.locator("#approvedSourceDetails dt").first().evaluate(node => { node.textContent += " \u2014 synthetic unusually long descriptive role label"; });
    const cases = [375, 820, 1200, 2560].map(width => ({ width, narrow: false })).concat({ width: 2560, narrow: true });
    for (const theme of ["light", "dark"]) for (const scale of [1, 2]) for (const config of cases) {
        await page.setViewportSize({ width: config.width, height: 1000 });
        await chooseTheme(page, theme);
        await page.evaluate(({ scale, narrow }) => {
            document.documentElement.style.fontSize = `${scale * 100}%`;
            document.querySelector("#settingsView").style.width = narrow ? "375px" : "";
        }, { scale, narrow: config.narrow });
        const titleBefore = await heading(page);
        const values = await page.locator("#approvedSourceDetails .settings-paths").evaluate(node => {
            const style = getComputedStyle(node);
            return { family: style.fontFamily,
                overflow: document.documentElement.scrollWidth > innerWidth,
                rows: [...node.children].map(field => {
                    const css = getComputedStyle(field), box = field.getBoundingClientRect(), range = document.createRange();
                    range.selectNodeContents(field);
                    const rects = [...range.getClientRects()];
                    return { id: field.id, tag: field.tagName, text: field.textContent, visibleText: field.innerText,
                        family: css.fontFamily, size: css.fontSize, weight: css.fontWeight, lineHeight: css.lineHeight,
                        color: css.color, whiteSpace: css.whiteSpace, textOverflow: css.textOverflow,
                        clipped: field.scrollWidth > field.clientWidth || field.scrollHeight > field.clientHeight,
                        allGlyphsInside: rects.every(r => r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1),
                        lines: rects.length };
                }) };
        });
        values.paper = await effectivePaper(page, "#approvedSourceDetails .settings-paths");
        assert.equal(values.overflow, false, JSON.stringify({ theme, scale, ...config }));
        assert.deepEqual(values.rows.filter(row => row.tag === "DD").map(row => row.text), [...Object.values(longPaths), "Not read"]);
        for (const row of values.rows) {
            assert.equal(row.size, `${(row.tag === "DT" ? 14 : 16) * scale}px`, "Reference labels and exact reading values retain their distinct roles");
            assert.equal(row.family, values.family);
            assert.ok(contrast(row.color, values.paper) >= 4.5);
            assert.equal(row.clipped, false); assert.equal(row.allGlyphsInside, true);
            if (row.tag === "DD") {
                assert.equal(row.visibleText, row.text); assert.equal(row.whiteSpace, "break-spaces");
                assert.notEqual(row.textOverflow, "ellipsis");
                if (row.id === "approvedDatabase" || row.id === "approvedSessions") assert.ok(row.lines > 1);
            }
        }
        await openSourceEditor(page);
        await expect(page.locator("#approvedSourceDetails")).toBeHidden();
        await expect(page.locator("#sourceDatabase")).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(page.locator("#sourceSessions")).toBeFocused();
        const fields = await page.locator("#sourceEditor input").evaluateAll(nodes => nodes.map(node => {
            const css = getComputedStyle(node), box = node.getBoundingClientRect();
            return { x: box.x, width: box.width, height: box.height, size: css.fontSize, weight: css.fontWeight,
                family: css.fontFamily, lineHeight: css.lineHeight, padding: css.padding, radius: css.borderRadius,
                outline: css.outlineStyle, outlineWidth: css.outlineWidth, color: css.color,
                outlineColor: css.outlineColor, background: css.backgroundColor, borderColor: css.borderColor };
        }));
        const geometry = ({ outline, outlineWidth, outlineColor, ...rest }) => rest;
        assert.deepEqual(geometry(fields[0]), geometry(fields[1]));
        assert.ok(fields[0].height >= 44); assert.equal(fields[1].outline, "solid");
        assert.ok(contrast(fields[1].outlineColor, fields[1].background) >= 3);
        assert.ok(contrast(fields[1].borderColor, fields[1].background) >= 3);
        assert.ok(contrast(fields[1].color, fields[1].background) >= 4.5);
        await page.locator("#cancelSource").click();
        await expect(page.locator("#editSource")).toBeFocused();
        const titleAfter = await heading(page);
        for (const key of ["size", "weight", "lineHeight", "family"]) assert.equal(titleAfter[key], titleBefore[key]);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        measurements.push({ theme, scale, ...config, titleBefore, values, fields });
        if (proofs && [375, 1200].includes(config.width)) {
            await captureSource(page, `source-${theme}-${config.width}-${scale}`);
        }
    }
    await save("source-layout-matrix", measurements);
});

test("a source draft preserves the focused path and text selection through polling", async t => {
    const { page } = await setup(t);
    await openSourceEditor(page);
    const input = page.locator("#sourceSessions");
    await input.fill(longPaths.sessionRoot);
    await input.evaluate(node => node.setSelectionRange(7, 12));
    const held = await input.elementHandle();
    await page.waitForResponse(r => r.url().endsWith("/api/collection/status"));
    assert.deepEqual(await held.evaluate(node => [node === document.activeElement, node.selectionStart, node.selectionEnd]), [true, 7, 12]);
    await navigateMain(page, "analyze"); await page.goBack(); await ready(page);
    await expect(input).toHaveValue(longPaths.sessionRoot);
    await page.locator("#cancelSource").click();
    await expect(page.locator("#editSource")).toBeFocused();
    await expect(page.locator("#approvedSessions")).toHaveText(paths.sessionRoot);
});

test("source values preserve repeated spaces inside their glyph bounds at variable path wrap boundaries", async t => {
    const { page } = await setup(t);
    await page.setViewportSize({ width: 2560, height: 1000 });
    await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
    const failures = await page.locator("#approvedDatabase").evaluate(node => {
        const failures = [];
        for (let length = 0; length <= 160; length++) {
            node.textContent = `C:\\Synthetic\\${"w".repeat(length)}\\source-a-\u00e9\u4f8b-space  pair-long-folder-name-long-folder-name-\\data.db`;
            const box = node.getBoundingClientRect(), range = document.createRange();
            range.selectNodeContents(node);
            const lines = [...range.getClientRects()];
            const outside = lines.filter(line => line.left < box.left - 1 || line.right > box.right + 1 || line.top < box.top - 1 || line.bottom > box.bottom + 1);
            if (outside.length || node.scrollWidth > node.clientWidth || node.innerText !== node.textContent) {
                const outsideCharacters = [];
                for (let index = 0; index < node.textContent.length; index++) {
                    range.setStart(node.firstChild, index); range.setEnd(node.firstChild, index + 1);
                    if ([...range.getClientRects()].some(rect => rect.right > box.right + 1)) outsideCharacters.push({ index, character: node.textContent[index] });
                }
                failures.push({ length, text: node.textContent, box: box.toJSON(),
                    outside: outside.map(line => line.toJSON()), outsideCharacters, scrollWidth: node.scrollWidth,
                    clientWidth: node.clientWidth, whitespacePreserved: node.innerText === node.textContent });
            }
        }
        return failures;
    });
    await save("source-space-boundaries", failures);
    assert.deepEqual(failures, [], "Exact repeated whitespace must wrap inside the field, not hang beyond its edge");
});
