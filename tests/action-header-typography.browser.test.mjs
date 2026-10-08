import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics, buildRequestActivity } from "../lib/activity-analytics.mjs";
import { serviceCategories } from "../lib/service-categories.mjs";
import { fixture, exportCatalogFor, chooseTheme } from "./helpers.mjs";

const proofDir = process.env.WORKIQ_ACTION_TYPOGRAPHY_PROOFS;
const exactPath = "/me/messages/{MessageId}?$select=subject&$filter=contains(subject,'\u65e5\u672c\u8a9e <not-markup>')";
const longPath = "/me/messages/" + "LiteralCase{}Segment".repeat(35) + "?$select=Subject&x=\u65e5\u672c\u8a9e";
function records() {
    const single = fixture("header-single");
    single.toolCalls[0].requestedApiPath = exactPath;
    single.toolCalls[0].requestArgs = { entityUrls: [exactPath] };
    single.toolCalls[0].apiResults = [
        { index: 0, statusCode: 200, path: exactPath, evidenceLevel: "intermediary-reported" },
        { index: 1, statusCode: 200, path: longPath, evidenceLevel: "intermediary-reported" },
    ];
    const multiple = fixture("header-multiple");
    multiple.toolCalls = ["/me/messages", "/me/drive/root/children", null].map((apiPath, index) => ({
        ...structuredClone(single.toolCalls[0]),
        tool: index === 1 ? "workiq-" + "LongToolIdentifier".repeat(12) : "workiq-fetch",
        toolCallId: `multiple-${index}`, startEventId: `multiple-start-${index}`,
        requestedApiPath: apiPath,
        requestArgs: apiPath ? { entityUrls: [index === 0 ? longPath : apiPath] } : {},
        apiResults: [],
    }));
    return [single, multiple];
}
async function setup(t) {
    const source = records(), original = JSON.stringify(source), requests = [], errors = [];
    const server = createServer(async (req, res) => {
        if (req.method === "GET") {
            res.setHeader("Content-Type", "text/html");
            res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'nonce-header-type'; style-src 'unsafe-inline'; font-src data:; connect-src 'self'; base-uri 'none'");
            return res.end(renderHtmlShell("a".repeat(64), "header-type"));
        }
        requests.push(req.url);
        res.setHeader("Content-Type", "application/json");
        if (req.url !== "/api/snapshot") {
            res.statusCode = 403;
            return res.end('{"error":"Header proof permits synthetic snapshot reads only."}');
        }
        let body = ""; for await (const part of req) body += part;
        res.end(JSON.stringify({
            revision: 1, scenarios: source, exports: [], coverage: { notes: [] },
            exportCatalog: exportCatalogFor(source), requestActivity: buildRequestActivity(source),
            analytics: { ...buildActivityAnalytics(source, JSON.parse(body)), revision: 1 },
        }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(6000);
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: {
        readText() { throw Error("Header proof never reads clipboard."); },
        writeText() { throw Error("Header proof never writes clipboard."); },
    } }));
    t.after(async () => {
        await browser.close();
        await new Promise(resolve => server.close(resolve));
        assert.deepEqual(errors, []);
        assert.ok(requests.every(url => url === "/api/snapshot"));
        assert.equal(JSON.stringify(source), original);
    });
    return { page, url: `http://127.0.0.1:${server.address().port}`, requests };
}
async function ready(page) {
    await page.waitForFunction(() => document.querySelector("#workspace")?.getAttribute("aria-busy") === "false");
}
async function measure(page) {
    await page.evaluate(() => document.fonts.ready);
    return page.evaluate(() => {
        const box = node => {
            const rect = node.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom, cy: rect.y + rect.height / 2 };
        };
        const style = node => {
            const css = getComputedStyle(node);
            return Object.fromEntries(["fontFamily", "fontSize", "fontWeight", "lineHeight", "whiteSpace", "overflowWrap",
                "wordBreak", "letterSpacing", "fontVariantLigatures", "padding", "backgroundColor", "color", "userSelect"].map(key => [key, css[key]]));
        };
        return {
            overflow: document.documentElement.scrollWidth - innerWidth,
            headers: [...document.querySelectorAll(".action-heading")].map(header => ({
                header: box(header), title: box(header.querySelector("h3")), titleText: header.querySelector("h3").textContent,
                service: header.querySelector(".service-cue") && box(header.querySelector(".service-cue")),
                label: header.querySelector(".service-cue>span") && box(header.querySelector(".service-cue>span")),
                icon: header.querySelector(".service-cue>.fluent-icon") && box(header.querySelector(".service-cue>.fluent-icon")),
                help: header.querySelector(".ux-help") && box(header.querySelector(".ux-help")),
                info: header.querySelector(".ux-help>svg") && box(header.querySelector(".ux-help>svg")),
            })),
            paths: [...document.querySelectorAll("code.api-path")].filter(node => node.checkVisibility()).map(node => ({
                text: node.textContent, style: style(node), box: box(node),
                context: node.closest(".journey-item") ? "timeline" : node.closest(".matched-action") ? "matching" : "summary",
                returned: !!node.closest(".returned-api-details"), overflow: node.scrollWidth - node.clientWidth,
            })),
        };
    });
}
function assertHeaders(value, label) {
    assert.ok(value.overflow <= 1, `${label}: document fits`);
    for (const header of value.headers) {
        assert.ok(header.title.x >= header.header.x && header.title.right <= header.header.right + 1);
        if (!header.service) continue;
        for (const node of [header.service, header.label, header.icon, header.help, header.info]) {
            assert.ok(node.x >= header.header.x - 1 && node.right <= header.header.right + 1, `${label}: header child fits`);
        }
        assert.ok(Math.abs(header.icon.cy - header.label.cy) < 1, `${label}: service icon/label centered`);
        assert.ok(Math.abs(header.help.cy - header.label.cy) < 1, `${label}: help/label centered`);
        assert.ok(Math.abs(header.info.cy - header.help.cy) < 1, `${label}: info glyph centered in target`);
        assert.equal(header.help.width, 44, `${label}: no inflated invisible hitbox`);
        assert.equal(header.help.height, 44);
        assert.ok(Math.abs(header.label.x - header.icon.right - 8) < 1, `${label}: service gap`);
        assert.ok(Math.abs(header.help.x - header.service.right - 4) < 1, `${label}: help gap`);
        const sameRow = header.title.right <= header.service.x;
        if (sameRow) {
            assert.ok(Math.abs(header.title.cy - header.service.cy) < 1, `${label}: common title/service center`);
            assert.ok(Math.abs(header.service.x - header.title.right - 16) < 1, `${label}: group gap`);
        } else assert.ok(header.service.y >= header.title.bottom, `${label}: natural wrapping, no overlap`);
    }
    for (const apiPath of value.paths) assert.ok(apiPath.overflow <= 1, `${label}: complete path wraps`);
}
async function assertTooltip(page, help) {
    await page.mouse.move(0, 0);
    await help.scrollIntoViewIfNeeded();
    await help.hover();
    const tooltip = page.getByRole("tooltip");
    await tooltip.waitFor({ state: "visible" });
    assert.equal(await help.evaluate(node => {
        const style = getComputedStyle(node, "::before"), bounds = node.getBoundingClientRect();
        return bounds.width - parseFloat(style.left) - parseFloat(style.right);
    }), 28, "Compact hover paint remains inside the 44px target");
    const anchor = await help.boundingBox(), tip = await tooltip.boundingBox(), width = page.viewportSize().width;
    const expectedX = Math.max(8, Math.min(width - tip.width - 8, anchor.x + (anchor.width - tip.width) / 2));
    assert.ok(Math.abs(tip.x - expectedX) <= 1, "Popup horizontally anchored to actual help target");
    const gap = tip.y >= anchor.y + anchor.height ? tip.y - anchor.y - anchor.height : anchor.y - tip.y - tip.height;
    assert.ok(Math.abs(gap - 8) <= 1, "Popup has 8px trigger gap");
    assert.ok(tip.x >= 8 && tip.x + tip.width <= width - 7);
    assert.ok(tip.y >= 8 && tip.y + tip.height <= page.viewportSize().height - 7);
    return { anchor, tip };
}

test("action header and literal API path share measured roles across themes, widths and root text scales", { timeout: 90000 }, async t => {
    const { page, url, requests } = await setup(t), matrix = [];
    await page.goto(url + "/#request?request=header-single"); await ready(page);
    await page.locator(".request-outcome .returned-api-details>summary").click();
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        const label = `${theme}-${width}-${scale * 100}`, geometry = await measure(page);
        assertHeaders(geometry, label);
        assert.equal(geometry.headers[0].titleText, "workiq-fetch");
        const copies = geometry.paths.filter(value => value.text === exactPath);
        assert.ok(copies.some(value => value.context === "summary" && !value.returned));
        assert.ok(copies.some(value => value.context === "timeline"));
        assert.ok(copies.some(value => value.returned), "Expanded structured result path is the same role");
        for (const value of geometry.paths) {
            assert.deepEqual(value.style, copies[0].style, `${label}: computed font and treatment equality`);
            assert.equal(value.style.fontSize, `${14 * scale}px`);
            assert.equal(value.style.fontWeight, "400");
            assert.equal(value.style.lineHeight, `${22.4 * scale}px`);
            assert.match(value.style.fontFamily, /Cascadia Mono/);
            assert.equal(value.style.userSelect, "text");
        }
        assert.equal(await page.locator("not-markup").count(), 0);
        const help = page.locator(".action-service-heading>.ux-help").first(), before = requests.length;
        const tooltip = await assertTooltip(page, help);
        assert.equal(await page.getByRole("tooltip").textContent(), serviceCategories.describe("Mail").description);
        assert.equal(requests.length, before, "Help cannot initiate a data action");
        await page.keyboard.press("Escape");
        matrix.push({ label, ...geometry, tooltip });
        if (proofDir && ((width === 1200 && scale === 1) || (width === 375 && scale === 2))) {
            await mkdir(proofDir, { recursive: true });
            await page.locator(".journey-item").first().screenshot({ path: path.join(proofDir, label + ".png") });
        }
    }
    const help = page.locator(".action-service-heading>.ux-help").first();
    await page.mouse.move(0, 0);
    await page.locator(".journey-item>details>summary").focus(); await page.keyboard.press("Shift+Tab");
    assert.equal(await help.evaluate(node => document.activeElement === node), true);
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    assert.equal(await help.getAttribute("aria-describedby"), "evidence-tooltip");
    assert.ok(await help.evaluate(node => getComputedStyle(node).outlineStyle !== "none"));
    await page.keyboard.press("Escape"); await page.keyboard.press("Enter");
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    await page.keyboard.press("Escape"); await page.keyboard.press("Space");
    await page.getByRole("tooltip").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await help.hover(); await page.mouse.move(1, 1);
    await page.getByRole("tooltip").waitFor({ state: "hidden" });
    assert.equal(await help.getAttribute("aria-describedby"), null);
    if (proofDir) await writeFile(path.join(proofDir, "font-geometry-matrix.json"), JSON.stringify(matrix, null, 2));
});

test("long tools, multiple and unknown services wrap while matching-action paths retain the same typography", { timeout: 45000 }, async t => {
    const { page, url } = await setup(t);
    await page.goto(url + "/#request?request=header-multiple"); await ready(page);
    assert.equal(await page.locator(".action-heading").count(), 3);
    assert.equal(await page.locator(".action-heading .service-cue[data-service=Unknown]").count(), 1);
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
        assertHeaders(await measure(page), `long/${theme}/${width}/${scale}`);
    }
    const before = (await measure(page)).paths.find(value => value.text === longPath);
    await page.goto(url + "/#activity?session=test-session&result=success"); await ready(page);
    const matches = (await measure(page)).paths.filter(value => value.context === "matching");
    assert.ok(matches.some(value => value.text === longPath));
    await page.evaluate(() => { document.documentElement.style.fontSize = "32px"; });
    assert.deepEqual((await measure(page)).paths.find(value => value.text === longPath).style, before.style);
    await page.goto(url + "/#request?request=header-multiple"); await ready(page);
    await page.locator(".action-heading").first().evaluate(node => node.querySelector(".action-service-heading").remove());
    assertHeaders(await measure(page), "component without service metadata");
    const endpoint = buildActivityAnalytics(records(), {}).filterOptions.endpoints.find(entry => entry.label.startsWith("/me/messages"));
    await page.goto(url + "/#request?request=header-multiple&endpoint=" + encodeURIComponent(endpoint.id)); await ready(page);
    await page.locator(".request-view-context>summary").click();
    const context = page.locator(".context-source>code.api-path");
    assert.equal(await context.textContent(), endpoint.label, "Filter context preserves the analytical label, not a substituted raw path");
    assert.deepEqual((await measure(page)).paths.find(value => value.text === endpoint.label).style, before.style);
});
