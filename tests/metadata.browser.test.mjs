import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { createInlineMetadata } from "../web/metadata.mjs";
import { metadataStyles } from "../web/metadata-styles.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { styles } from "../web/styles.mjs";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { fixture as sourceFixture, exportCatalogFor, chooseTheme, openActivitySessions } from "./helpers.mjs";

const proofDir = process.env.WORKIQ_METADATA_PROOFS;
const labels = [
    "Service not identified, Mail",
    "Mail",
    "Files and documents, Calendar, organizational directory and collaboration services",
    "SyntheticServiceIdentifierWithoutWordBreaks".repeat(3),
];
const requestHelp = "Synthetic request description.";
const serviceHelp = "Synthetic service definition. This control does not select the request.";
const records = [sourceFixture("metadata-synthetic")];
records[0].toolCalls[0].tool = "workiq-ask";
records[0].toolCalls[0].toolCallId = "metadata-0-unknown";
records[0].toolCalls[0].requestArgs = { question: "Synthetic fixture" };
delete records[0].toolCalls[0].requestedApiPath;
records[0].toolCalls.push({
    ...structuredClone(sourceFixture("metadata-mail").toolCalls[0]),
    toolCallId: "metadata-1-mail",
    requestedApiPath: "/me/messages", requestArgs: { entityUrls: ["/me/messages"] },
});

function componentShell() {
    return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>${styles}${metadataStyles}
    #metadata-fixture{width:min(724px,calc(100vw - 80px));margin:32px 40px;font-size:var(--type-caption)}
    #metadata-fixture>article{margin-block:24px;background:var(--paper)}
    </style></head><body><div id="metadata-fixture"></div><script nonce="metadata-fixture">
    const ux = (${createEvidenceUX.toString()})(${JSON.stringify(uxIcons)});
    const metadata = (${createInlineMetadata.toString()})(ux);
    window.metadataSideEffects = {clicks:0,keys:0,copies:0};
    for (const label of ${JSON.stringify(labels)}) {
        const card = document.createElement("article");
        const row = metadata.row([
            {label:"Request excerpt",helpLabel:"this request excerpt",help:${JSON.stringify(requestHelp)}},
            {label,helpLabel:"recorded services",help:${JSON.stringify(serviceHelp)}},
            {label:"Sep 30, 2026, 12:00 PM"},
        ]);
        card.addEventListener("click",()=>window.metadataSideEffects.clicks++);
        card.addEventListener("keydown",(event)=>{
            if(event.key==="Enter"||event.key===" ")window.metadataSideEffects.keys++;
        });
        card.append(row);
        document.querySelector("#metadata-fixture").append(card);
    }
    const copy=ux.copyButton({label:"Copy synthetic text",getText:()=>"Synthetic"});
    document.querySelector("#metadata-fixture").append(copy);
    </script></body></html>`;
}

async function fixture(run, contextOptions = {}) {
    const requests = [], errors = [], original = JSON.stringify(records);
    const server = createServer(async (req, res) => {
        if (req.method === "GET") {
            res.setHeader("Content-Type", "text/html");
            res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'nonce-metadata-fixture'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'");
            return res.end(req.url === "/component" ? componentShell() : renderHtmlShell("a".repeat(64), "metadata-fixture"));
        }
        requests.push(req.url);
        res.setHeader("Content-Type", "application/json");
        if (req.url !== "/api/snapshot") {
            res.statusCode = 403;
            return res.end('{"error":"Metadata proof permits synthetic snapshot reads only."}');
        }
        let text = ""; for await (const chunk of req) text += chunk;
        const input = JSON.parse(text);
        res.end(JSON.stringify({
            revision: 1, scenarios: records, exports: [], coverage: { notes: [] },
            exportCatalog: exportCatalogFor(records),
            analytics: { ...buildActivityAnalytics(records, input), revision: 1 },
        }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch();
    const context = await browser.newContext(contextOptions);
    context.setDefaultTimeout(5000);
    await context.addInitScript(() => {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
            writeText: () => { throw new Error("Metadata proof cannot write the clipboard."); },
            readText: () => { throw new Error("Metadata proof cannot read the clipboard."); },
        } });
    });
    context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    try {
        if (proofDir) await mkdir(proofDir, { recursive: true });
        await run({ context, url: `http://127.0.0.1:${server.address().port}`, requests });
        assert.deepEqual(errors, []);
        assert.ok(requests.every((url) => url === "/api/snapshot"), "Help cannot mutate or preview/export data");
        assert.equal(JSON.stringify(records), original, "Source fixture remains immutable");
    } finally {
        await browser.close();
        await new Promise((resolve) => server.close(resolve));
    }
}

async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
    await openActivitySessions(page);
}

async function geometry(row) {
    return row.evaluate((node) => {
        const rect = (box) => ({ x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom });
        const box = (node) => rect(node.getBoundingClientRect());
        const textRects = (node) => {
            const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
            const boxes = [];
            while (walker.nextNode()) {
                if (!walker.currentNode.textContent.trim()) continue;
                const range = document.createRange();
                range.selectNodeContents(walker.currentNode);
                boxes.push(...[...range.getClientRects()].filter((r) => r.width > 0).map(rect));
            }
            return boxes;
        };
        return {
            bounds: box(node), overflow: node.scrollWidth - node.clientWidth,
            items: [...node.querySelectorAll(".metadata-item")].map((item) => {
                const label = item.querySelector(".metadata-label");
                const help = item.querySelector(".metadata-help"), svg = help?.querySelector("svg");
                let iconCenter = null;
                if (svg) {
                    const paint = svg.getBBox();
                    iconCenter = new DOMPoint(paint.x + paint.width / 2, paint.y + paint.height / 2).matrixTransform(svg.getScreenCTM()).y;
                }
                return { label: label.textContent, text: textRects(label), box: box(item),
                    help: help ? box(help) : null, icon: svg ? box(svg) : null, iconCenter,
                    separator: item.querySelector(".metadata-separator") ? textRects(item.querySelector(".metadata-separator"))[0] : null };
            }),
        };
    });
}

function assertGeometry(measure, { scale = 1, coarse = false } = {}) {
    const center = (box) => box.y + box.height / 2;
    const overlaps = (a, b) => a.x < b.right - .1 && a.right > b.x + .1 && a.y < b.bottom - .1 && a.bottom > b.y + .1;
    assert.ok(measure.overflow <= 1, `Row overflow: ${measure.overflow}`);
    for (const item of measure.items) {
        assert.ok(item.box.x >= measure.bounds.x - 1 && item.box.right <= measure.bounds.right + 1, "Metadata fits its row");
        if (item.help) {
            const last = item.text.at(-1);
            assert.ok(Math.abs(item.iconCenter - center(last)) <= 2, `Icon/text center error: ${item.iconCenter - center(last)} at ${scale}x (${item.label})`);
            assert.ok(item.help.width >= 44 && item.help.height >= 44, "Help keeps a full accessible target");
            assert.ok(item.help.width <= Math.max(44, 24 * scale) + 1, "Target follows the shared help token");
            const gap = item.icon.x - last.right;
            assert.ok(gap >= 4 && gap <= 8, `Label/icon gap stays independent of target width: ${gap}, ${item.label}`);
            for (const other of measure.items) for (const text of other.text) assert.ok(!overlaps(item.help, text), "Info target cannot overlap label text");
            for (const other of measure.items) if (other !== item && other.help) assert.ok(!overlaps(item.help, other.help), "Info targets cannot overlap");
        }
        if (item.separator) {
            assert.ok(Math.abs(center(item.separator) - center(item.text[0])) <= 2, "Separator shares first text line");
            assert.ok(item.text[0].x - item.separator.right >= 3 && item.text[0].x - item.separator.right <= 5, "Tight separator gap");
        }
    }
    for (const item of measure.items) {
        const previous = measure.items[measure.items.indexOf(item) - 1];
        if (previous && Math.abs(item.box.y - previous.box.y) < 2) {
            assert.ok(Math.abs(center(item.text[0]) - center(previous.text[0])) <= 2, "Adjacent metadata text has one baseline");
            assert.ok(item.box.x - previous.box.right >= 3 && item.box.x - previous.box.right <= 5, "Consistent group spacing");
        }
    }
}

test("metadata component centers text, official icons and separators through wrapping and 200% text", { timeout: 45000 }, async () => fixture(async ({ context, url }) => {
    const page = await context.newPage(), measurements = [];
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1200 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.goto(url + "/component");
        await page.evaluate((scale) => document.documentElement.style.fontSize = `${scale * 16}px`, scale);
        const rows = page.locator(".inline-metadata");
        assert.equal(await rows.count(), labels.length);
        for (let index = 0; index < labels.length; index++) {
            const measure = await geometry(rows.nth(index));
            assert.equal(measure.items[1].label, labels[index], "Labels and category combinations are unchanged");
            assertGeometry(measure, { scale });
            measurements.push({ theme, width, scale, index, ...measure });
        }
        assert.equal(await page.locator(".metadata-separator:not([aria-hidden=true])").count(), 0);
        assert.equal(await page.locator("button button, a button, label button").count(), 0);
        const copy = await page.locator(".ux-copy").boundingBox();
        assert.ok(copy.width >= (width <= 600 ? 44 : 40), "Metadata styles cannot shrink copy controls");
    }
    if (proofDir) await writeFile(path.join(proofDir, "metadata-component-geometry.json"), JSON.stringify(measurements, null, 2));
}));

test("metadata component help supports hover keyboard and focus without selecting its card", { timeout: 20000 }, async () => fixture(async ({ context, url }) => {
    const page = await context.newPage();
    await page.goto(url + "/component");
    const row = page.locator(".inline-metadata").first(), help = row.getByRole("button", { name: "About recorded services", exact: true });
    const before = await geometry(row), beforeUrl = page.url();
    await help.hover();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    assert.equal(await page.getByRole("tooltip").textContent(), serviceHelp);
    await page.getByRole("tooltip").hover();
    await page.waitForTimeout(250);
    assert.equal(await page.getByRole("tooltip").isVisible(), true, "Tooltip remains hoverable");
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("tooltip").isVisible(), false);
    await row.locator(".metadata-help").first().focus();
    await page.keyboard.press("Tab");
    assert.equal(await help.evaluate((node) => node === document.activeElement), true, "Natural keyboard order");
    assert.equal(await help.getAttribute("aria-describedby"), "evidence-tooltip");
    assert.ok(await help.evaluate((node) => parseFloat(getComputedStyle(node).outlineWidth) >= 2), "Keyboard focus ring");
    assert.deepEqual(await geometry(row), before, "Focus/help cannot shift layout");
    for (const key of ["Enter", "Space"]) {
        await page.keyboard.press("Escape");
        await page.keyboard.press(key);
        await page.getByRole("tooltip").waitFor({ state: "visible" });
    }
    await help.click();
    assert.deepEqual(await page.evaluate(() => window.metadataSideEffects), { clicks: 0, keys: 0, copies: 0 });
    assert.equal(page.url(), beforeUrl);
    await page.keyboard.press("Escape");
    assert.equal(await help.getAttribute("aria-describedby"), null);
}));

test("metadata component touch targets stay distinct and dismiss without navigation", { timeout: 20000 }, async () => fixture(async ({ context, url }) => {
    const page = await context.newPage();
    await page.goto(url + "/component");
    const row = page.locator(".inline-metadata").first(), beforeUrl = page.url();
    assertGeometry(await geometry(row), { coarse: true });
    const help = row.getByRole("button", { name: "About recorded services", exact: true });
    await help.tap();
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    assert.equal(await page.getByRole("tooltip").textContent(), serviceHelp);
    await page.touchscreen.tap(8, 8);
    assert.equal(await page.getByRole("tooltip").isVisible(), false);
    assert.deepEqual(await page.evaluate(() => window.metadataSideEffects), { clicks: 0, keys: 0, copies: 0 });
    assert.equal(page.url(), beforeUrl);
    assert.ok((await page.locator(".ux-copy").boundingBox()).width >= 44);
}, { viewport: { width: 375, height: 1200 }, hasTouch: true, isMobile: true }));

test("integrated metadata renders in Activity and request details without source or action changes", { timeout: 45000 }, async () => fixture(async ({ context, url, requests }) => {
    const page = await context.newPage(), measurements = [];
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
        await page.goto(url + "/#activity");
        await ready(page);
        await chooseTheme(page, theme);
        const row = page.locator(".request-meta").first();
        assert.equal(await row.locator(".metadata-item").count(), 2, "Shared metadata keeps service and time, without repeating the Request text label");
        const measure = await geometry(row);
        assert.equal(measure.items[0].label, "Service not identified, Mail");
        assertGeometry(measure);
        measurements.push({ theme, width, ...measure });
        if (proofDir) await row.screenshot({ path: path.join(proofDir, `metadata-after-${theme}-${width}.png`) });
        const help = row.getByRole("button", { name: "About recorded services", exact: true }), beforeUrl = page.url(), reads = requests.length;
        await help.click();
        await page.getByRole("tooltip").waitFor({ state: "visible" });
        assert.equal(await help.getAttribute("aria-describedby"), "evidence-tooltip");
        assert.match(await page.getByRole("tooltip").textContent(), /Service not identified:/);
        assert.match(await page.getByRole("tooltip").textContent(), /Mail:/);
        assert.equal(page.url(), beforeUrl);
        assert.equal(requests.length, reads);
        assert.equal(await page.locator(".request-row input[type=checkbox]:checked").count(), 0);
        await page.keyboard.press("Escape");
        await page.locator(".request-link").first().click();
        await ready(page);
        assert.ok(await page.locator(".request-outcome .metadata-help").count() > 0, "Request result shares metadata variant");
        assert.ok(await page.locator(".journey-item .action-service-heading>.ux-help").count() > 0, "Action services use their own centered header target");
        await page.locator(".journey-item .action-service-heading>.ux-help").first().click();
        await page.getByRole("tooltip").waitFor({ state: "visible" });
        assert.match(page.url(), /#request/);
        await page.keyboard.press("Escape");
        await page.locator(".journey-item summary").filter({ hasText: "Technical details" }).first().click();
        assert.ok(await page.locator(".facts dt .metadata-help").count() > 0, "Technical metadata shares the variant");
    }
    if (proofDir) await writeFile(path.join(proofDir, "metadata-integrated-geometry.json"), JSON.stringify(measurements, null, 2));
}));
