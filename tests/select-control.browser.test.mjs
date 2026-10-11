import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { createSelectControls } from "../web/select-control.mjs";
import { selectStyles } from "../web/select-styles.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { fixture, exportCatalogFor, chooseTheme, selectActivityOption, automaticScoreOffSummary } from "./helpers.mjs";

const proofDir = process.env.WORKIQ_SELECT_PROOFS;
const records = ["/me/events", "/me/messages", "/me/drive"].map((endpoint, index) => {
    const record = fixture(`synthetic-control-${index}`);
    record.project = index === 2 ? "A long synthetic project name that must remain fully readable in the option panel" : "Synthetic project " + (index + 1);
    record.projectId += index;
    record.toolCalls[0].requestedApiPath = endpoint;
    return record;
});
const isolated = process.env.WORKIQ_SELECT_ISOLATED === "1";
async function setup(run, options = {}) {
    const errors = [], rejected = [], requests = [];
    const shell = renderHtmlShell("a".repeat(64), "select-proof");
    const before = process.env.WORKIQ_SELECT_BEFORE ? await readFile(process.env.WORKIQ_SELECT_BEFORE, "utf8") : shell;
    const server = createServer(async (req, res) => {
        if (req.method === "GET" && ["/", "/before"].includes(req.url)) {
            res.setHeader("Content-Type", "text/html");
            res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'nonce-select-proof'; style-src 'unsafe-inline'; font-src data:; connect-src 'self'; base-uri 'none'");
            return res.end(req.url === "/before" ? before : isolated
                ? shell.replace("</body>", `<style>${selectStyles}</style><script nonce="select-proof">window.testControls=(${createSelectControls.toString()})((${createEvidenceUX.toString()})(${JSON.stringify(uxIcons)}));</script></body>`)
                : shell);
        }
        if (req.method === "GET" && req.url === "/favicon.ico") return res.writeHead(204).end();
        res.setHeader("Content-Type", "application/json");
        if (req.method === "POST" && req.url === "/api/evaluation/automatic/summary") return res.end(JSON.stringify(automaticScoreOffSummary()));
        if (req.method !== "POST" || req.url !== "/api/snapshot") {
            rejected.push(`${req.method} ${req.url}`);
            return res.writeHead(403).end('{"error":"Only synthetic snapshot reads are permitted."}');
        }
        let body = ""; for await (const chunk of req) body += chunk;
        const input = JSON.parse(body);
        requests.push(input);
        res.end(JSON.stringify({
            revision: 1, scenarios: records, exports: [], exportCatalog: exportCatalogFor(records),
            coverage: { since: "2026-09-01", until: "2026-09-30", notes: ["Synthetic control proof only."] },
            analytics: { ...buildActivityAnalytics(records, input), revision: 1 },
        }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    let browser;
    try {
        browser = await chromium.launch();
        const context = await browser.newContext({ colorScheme: "light", reducedMotion: "reduce", timezoneId: "America/Los_Angeles", ...options });
        context.setDefaultTimeout(5000);
        await context.addInitScript(() => {
            window.controlChanges = [];
            document.addEventListener("change", (event) => {
                if (event.target instanceof HTMLSelectElement) window.controlChanges.push({ id: event.target.id, value: event.target.value });
            });
            Object.defineProperty(navigator, "clipboard", { value: {
                readText: () => { throw new Error("Clipboard is excluded from control proof."); },
                writeText: () => { throw new Error("Clipboard is excluded from control proof."); },
            } });
        });
        context.on("page", (page) => {
            page.on("pageerror", (error) => errors.push(error.message));
            page.on("request", (request) => { if (new URL(request.url()).origin !== origin) rejected.push(request.url()); });
        });
        if (proofDir) await mkdir(proofDir, { recursive: true });
        await run({ context, origin, requests, shell });
        assert.deepEqual(errors, [], "No browser errors");
        assert.deepEqual(rejected, [], "No external traffic, private evidence reads, mutations, import, export or clipboard");
    } finally {
        await browser?.close();
        await new Promise((resolve) => server.close(resolve));
    }
}
async function ready(page) {
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    if (!await page.locator("#moreFilters").evaluate(node => node.open)) await page.locator("#moreFilters > summary").click();
}
async function choose(page, id, value) {
    await selectActivityOption(page, id, value);
    await ready(page);
}
async function capture(page, name) {
    if (proofDir) await page.screenshot({ path: path.join(proofDir, name + ".png"), fullPage: false });
}
async function geometry(page) {
    return page.evaluate(() => {
        const rect = (node) => {
            const box = node.getBoundingClientRect(), style = getComputedStyle(node);
            return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom,
                radius: style.borderRadius, color: style.color, background: style.backgroundColor, padding: style.padding };
        };
        const trigger = document.querySelector("#layerFilter-control");
        const label = trigger.querySelector(".select-value"), icon = trigger.querySelector(".select-chevron");
        return {
            trigger: rect(trigger), label: rect(label), icon: rect(icon),
            fieldRadius: getComputedStyle(document.documentElement).getPropertyValue("--radius-field").trim(),
            paint: { top: getComputedStyle(trigger, "::before").top, bottom: getComputedStyle(trigger, "::before").bottom },
            popup: rect(document.querySelector(".select-popup")), peer: [...document.querySelectorAll("#filters .select-trigger")].map(rect),
            rows: [...document.querySelectorAll(".select-option")].map((row) => {
                const label = row.querySelector(".select-option-label");
                return { ...rect(row), label: { ...rect(label), clipped: label.scrollHeight > label.clientHeight || label.scrollWidth > label.clientWidth } };
            }), overflow: document.documentElement.scrollWidth > innerWidth,
        };
    });
}
function contrast(foreground, background) {
    const luminance = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number).map((value) => {
        const channel = value / 255;
        return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return (values[0] + .05) / (values[1] + .05);
}

async function fieldGeometry(page, selector = "#filters .filter-field") {
    return page.locator(selector).evaluateAll((fields) => {
        const box = (node) => {
            const { x, y, width, height, right, bottom } = node.getBoundingClientRect();
            return { x, y, width, height, right, bottom };
        };
        const textBoxes = (node) => {
            const range = document.createRange();
            range.selectNodeContents(node);
            return [...range.getClientRects()].map((rect) => box({ getBoundingClientRect: () => rect }));
        };
        return fields.map((field) => {
            const label = field.querySelector("label"), trigger = field.querySelector(".select-trigger");
            const heading = label.closest(".help-heading"), help = heading?.querySelector(".ux-help");
            const paint = getComputedStyle(trigger, "::before");
            return {
                id: trigger.dataset.selectId, field: box(field), label: box(label), text: textBoxes(label),
                value: box(trigger.querySelector(".select-value")), valueText: textBoxes(trigger.querySelector(".select-value")),
                trigger: box(trigger), heading: heading ? box(heading) : null,
                help: help ? box(help) : null, icon: help ? box(help.querySelector("svg")) : null,
                inset: parseFloat(getComputedStyle(trigger).paddingLeft),
                paint: { left: trigger.getBoundingClientRect().left + parseFloat(paint.left),
                    top: trigger.getBoundingClientRect().top + parseFloat(paint.top),
                    height: trigger.getBoundingClientRect().height - parseFloat(paint.top) - parseFloat(paint.bottom) },
                lineHeight: parseFloat(getComputedStyle(label).lineHeight),
                fontSize: parseFloat(getComputedStyle(label).fontSize),
                valueFontSize: parseFloat(getComputedStyle(trigger).fontSize),
                labelFor: label.htmlFor, triggerId: trigger.id, labelId: label.id,
                labelledBy: trigger.getAttribute("aria-labelledby"),
            };
        });
    });
}

function assertFieldGeometry(fields, scale) {
    const center = (rect) => rect.y + rect.height / 2;
    for (const field of fields) {
        assert.equal(field.inset, Math.max(12, 8 * scale), "Label and value share a text-scaled painted-edge inset");
        assert.ok(Math.abs(field.text[0].x - field.valueText[0].x) <= 1, `${field.id}: label/value left edge`);
        assert.ok(Math.abs(field.valueText[0].x - field.paint.left - field.inset) <= 1, `${field.id}: shared painted-edge inset`);
        assert.equal(field.labelFor, field.triggerId);
        assert.ok(field.labelledBy.split(" ").includes(field.labelId));
        assert.ok(field.lineHeight >= field.fontSize * 1.4, "Readable label line height through text zoom");
        assert.ok(field.trigger.height >= 44);
        assert.ok(field.paint.height >= 36, "Wrapped selected values retain a complete painted field");
        assert.ok(field.field.x <= field.text[0].x && field.label.right <= field.field.right + 1);
        for (const line of field.text) assert.ok(line.x >= field.label.x - 1 && line.right <= field.label.right + 1, "Every wrapped label line stays inside its field");
        assert.ok(field.trigger.bottom <= field.field.bottom + 1, "Field owns its label and control");
        assert.ok(field.value.height >= field.valueFontSize * 1.4, "Selected value line box is not clipped by text zoom");
        if (field.help) {
            const last = field.text.at(-1);
            assert.ok(Math.abs(center(last) - center(field.icon)) <= 2, `${field.id}: info shares final label line`);
            assert.ok(field.help.x >= last.right + 3 && field.help.right <= field.field.right + 1, "Help target follows the final visible text line");
            for (const line of field.text) assert.ok(field.help.x >= line.right || field.help.y >= line.bottom || field.help.bottom <= line.y, "Help target cannot overlap any label line");
            assert.ok(field.help.bottom <= field.trigger.y - 3, "Help target is separate from dropdown");
            assert.ok(Math.abs(field.trigger.y - field.heading.bottom - 4) <= 1, "Shared field gap");
        }
        for (const peer of fields.filter((peer) => Math.abs(peer.trigger.y - field.trigger.y) <= 1)) {
            assert.ok(Math.abs(peer.text.at(-1).bottom - field.text.at(-1).bottom) <= 1, "Final text baselines align on each wrapped row");
        }
    }
}

test("select fields share label/value insets and baselines through themes, wrapping and text zoom", { timeout: 60000 }, async () => setup(async ({ context, origin, requests }) => {
    const page = await context.newPage(), measurements = [];
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 1466]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width, height: 1200 });
        await page.goto(origin); await ready(page); await chooseTheme(page, theme);
        await page.evaluate((scale) => document.documentElement.style.fontSize = `${scale * 16}px`, scale);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction(() => matchMedia("(max-width:699px)").matches ||
            parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--app-sidebar-width")) === document.querySelector("#sidebar").getBoundingClientRect().width);
        const beforeRequests = requests.length;
        const fields = await fieldGeometry(page);
        assert.equal(fields.length, 8, "Primary and secondary single-choice fields remain accessible alongside Author and Outcome.");
        assertFieldGeometry(fields, scale);
        if (width === 375 && scale === 2) for (const field of fields) {
            assert.ok(field.field.width >= 288, "Text zoom wraps complete fields instead of squeezing two narrow label columns");
        }
        measurements.push({ theme, width, scale, fields });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        for (const field of fields) {
            const help = page.locator(`#${field.labelId}`).locator("..").locator(".ux-help");
            await help.click();
            await page.getByRole("tooltip").waitFor({ state: "visible" });
            assert.equal(await page.locator(".select-popup:visible").count(), 0, "Help never opens or selects a dropdown");
            const tooltip = await page.getByRole("tooltip").boundingBox(), glyphBox = await help.locator("svg").boundingBox();
            assert.ok(Math.abs(tooltip.x - Math.max(8, Math.min(width - tooltip.width - 8, glyphBox.x + (glyphBox.width - tooltip.width) / 2))) <= 1, "Tooltip follows the visible help glyph, not trailing target padding");
            const afterHelp = (await fieldGeometry(page)).find((item) => item.id === field.id);
            assert.equal(afterHelp.text[0].x, field.text[0].x, "Help cannot shift label anchor");
            assert.equal(afterHelp.help.x, field.help.x);
            await page.keyboard.press("Escape");
            const trigger = page.locator(`#${field.triggerId}`);
            await trigger.focus(); await trigger.press("ArrowDown");
            const popup = await page.locator(".select-popup").boundingBox(), anchor = await trigger.boundingBox();
            assert.ok(Math.abs(popup.x - Math.max(8, Math.min(anchor.x, width - popup.width - 8))) <= 1, "Popup anchors to control, not the inset label");
            assert.ok(popup.y >= 8 && popup.y + popup.height <= 1193);
            const side = await page.locator(".select-popup").getAttribute("data-side");
            assert.ok(Math.abs(side === "bottom" ? popup.y - anchor.y - anchor.height - 6 : anchor.y - popup.y - popup.height - 6) <= 1);
            assert.ok(await trigger.evaluate((node) => parseFloat(getComputedStyle(node, "::before").outlineWidth) >= 2), "Visible keyboard focus");
            await trigger.press("Escape");
        }
        assert.equal(await page.evaluate(() => window.controlChanges.length), 0);
        assert.equal(requests.length, beforeRequests, "Exploring help and lists cannot change query/filter state");
        await page.locator("#scopeFilter-control").scrollIntoViewIfNeeded();
        assertFieldGeometry(await fieldGeometry(page, ".filter-field:has(#scopeFilter)"), scale);
        await page.evaluate(() => {
            const label = document.createElement("label");
            label.textContent = "Synthetic standalone field";
            const select = document.createElement("select");
            select.id = "standaloneField";
            select.append(new Option("Synthetic value", "synthetic"));
            label.append(select);
            document.querySelector("#workspace").append(label);
        });
        await page.locator("#standaloneField-control").waitFor();
        assertFieldGeometry(await fieldGeometry(page, ".select-field:has(#standaloneField)"), scale);
        await page.locator('label[for="projectFilter-control"]').evaluate((node) => {
            node.textContent = "GitHub Copilot project with a longer synthetic workspace label";
            document.querySelector("#projectFilter").selectedOptions[0].textContent =
                "A long synthetic selected project value that must remain accessible";
        });
        await page.waitForFunction(() => document.querySelector("#projectFilter-control").textContent.startsWith("A long synthetic"));
        assertFieldGeometry(await fieldGeometry(page), scale);
        await page.locator("#projectFilter-control").click();
        assert.equal(await page.getByRole("option", { name: "A long synthetic selected project value that must remain accessible", exact: true }).isVisible(), true);
        await page.keyboard.press("Escape");
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        if (proofDir) await page.locator("#filters").screenshot({ path: path.join(proofDir, `fields-${theme}-${width}-${scale}x.png`) });
    }
    if (proofDir) await writeFile(path.join(proofDir, "field-geometry.json"), JSON.stringify(measurements, null, 2));
}));

test("Activity uses an actual rounded popup and proportionate closed control in both themes and three widths", { timeout: 60000 }, async () => setup(async ({ context, origin, shell }) => {
    const measurements = [];
    if (proofDir && isolated) await writeFile(path.join(proofDir, "before-shell.html"), shell);
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
        const page = await context.newPage();
        await page.setViewportSize({ width, height: 1000 });
        if (isolated || process.env.WORKIQ_SELECT_BEFORE) {
            await page.goto(origin + "/before#activity");
            await ready(page);
            await chooseTheme(page, theme);
            await capture(page, `before-${theme}-${width}-closed`);
            await page.locator("#layerFilter").click();
            await capture(page, `before-${theme}-${width}-native-open`);
            assert.equal(await page.locator(".select-popup:visible").count(), 0, "Native popup has no themeable DOM surface");
            await page.keyboard.press("Escape");
        }
        await page.goto(origin + "/#activity");
        await ready(page);
        await chooseTheme(page, theme);
        const trigger = page.getByRole("combobox", { name: "Activity", exact: true });
        await trigger.waitFor({ state: "visible" });
        assert.equal(await trigger.evaluate((node) => node.tagName), "BUTTON", "The regression fails for a merely rounded native select");
        await capture(page, `after-${theme}-${width}-closed`);
        await trigger.click();
        assert.equal(await trigger.getAttribute("aria-expanded"), "true");
        assert.equal(await page.getByRole("listbox", { name: "Activity", exact: true }).count(), 1);
        assert.equal(await page.locator(".select-popup:popover-open").count(), 1, "Popup escapes scroll/chart clipping");
        await capture(page, `after-${theme}-${width}-open`);
        const metrics = await geometry(page);
        measurements.push({ theme, width, ...metrics });
        assert.equal(metrics.trigger.height, 44);
        assert.equal(metrics.trigger.radius, metrics.fieldRadius, "Trigger keeps the shared field styling");
        assert.deepEqual(metrics.paint, { top: "4px", bottom: "4px" }, "36px painted surface inside a 44px hit target");
        assert.equal(metrics.popup.radius, "12px", "The OPEN option surface, not only the trigger, is rounded");
        assert.ok(metrics.trigger.width <= 384, "Selected value does not inflate to fill a large track");
        assert.ok(Math.abs(metrics.label.y + metrics.label.height / 2 - metrics.icon.y - metrics.icon.height / 2) < 0.6);
        assert.ok(metrics.popup.x >= 8 && metrics.popup.right <= width - 7 && metrics.popup.bottom <= 993);
        assert.ok(!metrics.overflow);
        for (const peer of metrics.peer) assert.equal(peer.height, 44, "Related filters have equal hit heights");
        for (const peer of metrics.peer.filter((box) => Math.abs(box.y - metrics.trigger.y) < 20)) assert.equal(peer.y, metrics.trigger.y, "Peers on each filter track align");
        for (const row of metrics.rows) {
            assert.ok(row.height >= 36);
            const background = row.background === "rgba(0, 0, 0, 0)" ? metrics.popup.background : row.background;
            assert.ok(contrast(row.color, background) >= 4.5, "Option label has readable theme contrast");
            assert.equal(row.label.clipped, false, "Full choice identity is not cut off");
            assert.ok(row.label.x >= row.x && row.label.right <= row.right);
        }
        await page.keyboard.press("Escape");
        assert.equal(await trigger.getAttribute("aria-expanded"), "false");
        assert.equal(await trigger.evaluate((node) => node === document.activeElement), true);
        await page.close();
    }
    if (proofDir) await writeFile(path.join(proofDir, "geometry.json"), JSON.stringify(measurements, null, 2));
}));

test("open popup flips and repositions on window/visual viewport changes without clipping or focus theft", { timeout: 30000 }, async () => setup(async ({ context, origin }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto(origin); await ready(page);
    await page.locator("#coverage > summary").click();
    const trigger = page.locator("#scopeFilter-control");
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    for (const width of [820, 375, 1200]) {
        await page.setViewportSize({ width, height: 700 });
        await page.evaluate(() => {
            window.dispatchEvent(new Event("resize"));
            window.visualViewport?.dispatchEvent(new Event("resize"));
            window.visualViewport?.dispatchEvent(new Event("scroll"));
        });
        if (await trigger.getAttribute("aria-expanded") === "true") await trigger.press("Escape");
        await trigger.scrollIntoViewIfNeeded();
        await trigger.click();
        const bounds = await page.locator(".select-popup").boundingBox();
        assert.ok(bounds.x >= 8 && bounds.x + bounds.width <= width - 7 && bounds.y >= 8 && bounds.y + bounds.height <= 693);
        const direction = await page.locator(".select-popup").getAttribute("data-side");
        assert.ok(["top", "bottom"].includes(direction));
        await trigger.press("Escape");
    }
    await page.evaluate(() => {
        const wrapper = document.querySelector('[data-select-for="scopeFilter"]');
        wrapper.style.cssText = "position:fixed;left:24px;bottom:20px;width:220px;z-index:7";
    });
    await trigger.click();
    assert.equal(await page.locator(".select-popup").getAttribute("data-side"), "top", "Bottom-edge trigger flips upward");
    const focused = await trigger.evaluate((node) => node === document.activeElement);
    assert.equal(focused, true);
    await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
        document.dispatchEvent(new Event("visibilitychange"));
    });
    await page.waitForFunction(() => document.querySelector(".select-popup").hidden);
    assert.equal(await page.evaluate(() => window.controlChanges.length), 0);
}));

test("touch choices omit legacy explanatory paragraphs and preserve native form state", { timeout: 30000 }, async () => setup(async ({ context, origin }) => {
    const page = await context.newPage();
    await page.goto(origin + "/#activity"); await ready(page);
    const description = "Recorded Work IQ tool attempts; a successful tool result does not prove the whole task was correct.";
    await page.locator('#layerFilter option[value=tool]').evaluate((node, text) => node.dataset.description = text, description);
    const trigger = page.getByRole("combobox", { name: "Activity", exact: true });
    await trigger.tap();
    const row = page.getByRole("option", { name: "Work IQ calls", exact: true });
    assert.equal(await row.innerText(), "Work IQ calls");
    assert.equal(await row.locator(".select-option-description, .select-option-detail").count(), 0);
    assert.equal(await page.evaluate(() => window.controlChanges.length), 0, "Opening choices cannot commit");
    assert.equal(await row.getAttribute("aria-describedby"), null);
    assert.ok((await row.boundingBox()).height >= 44);
    await page.getByRole("option", { name: "Graph API call sites", exact: true }).tap();
    await ready(page);
    assert.equal(await page.locator("#layerFilter").inputValue(), "direct-request");
    assert.equal(await page.evaluate(() => window.controlChanges.length), 1);
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
}, { hasTouch: true, isMobile: true, viewport: { width: 375, height: 820 } }));

test("all app-authored dropdown options retain their value and dispatch each actual change once", { timeout: 60000 }, async () => setup(async ({ context, origin }) => {
    const page = await context.newPage();
    await page.goto(origin); await ready(page);
    for (const id of ["dateFilter", "serviceFilter", "outcomeFilter", "projectFilter", "layerFilter", "bucketFilter", "scopeFilter"]) {
        if (id === "scopeFilter") await page.locator("#coverage > summary").click();
        const options = await page.locator("#" + id + " option").evaluateAll((nodes) => nodes.map((node) => ({ value: node.value, label: node.label })));
        for (const option of options) {
            const prior = await page.locator("#" + id).evaluate(node => [...node.selectedOptions].map(option => option.value));
            const changes = await page.evaluate(() => window.controlChanges.length);
            await page.locator(`#${id}-control`).click();
            const actual = await page.getByRole("option").evaluateAll((nodes) => nodes.map((node) => ({ value: node.dataset.value, label: node.querySelector("span").textContent })));
            const current = await page.locator("#" + id + " option").evaluateAll((nodes) => nodes.map((node) => ({ value: node.value, label: node.label })));
            assert.deepEqual(actual, current, `${id}: every current option maps exactly`);
            if (id === "outcomeFilter") {
                await page.keyboard.press("Escape");
                await selectActivityOption(page, id, option.value);
            } else await page.locator(`.select-option[data-value=${JSON.stringify(option.value)}]`).click();
            await ready(page);
            assert.equal(await page.locator("#" + id).inputValue(), option.value);
            assert.equal(await page.evaluate(() => window.controlChanges.length), changes + Number(prior.length !== 1 || prior[0] !== option.value), `${id}: no duplicate change`);
            if (option.label.length > 60) {
                const trigger = page.locator(`#${id}-control`);
                assert.equal(await trigger.locator(".select-value").textContent(), option.label, "Accessible selection preserves the complete label");
                assert.equal(await page.getByRole("tooltip").isVisible(), false, "Committing an option does not reopen help");
                await page.mouse.move(0, 0);
                await trigger.hover();
                assert.equal(await trigger.locator(".select-value").evaluate(node => node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1), true,
                    "Long selections wrap visibly instead of requiring a truncation tooltip");
                await trigger.press("Escape");
            }
        }
        if (id === "layerFilter") await choose(page, id, "tool");
        if (id === "dateFilter") await choose(page, id, "capture");
        if (["serviceFilter", "outcomeFilter", "projectFilter"].includes(id)) await choose(page, id, "all");
    }
}));

test("keyboard exploration, typeahead, Escape, Tab, labels and outside dismissal do not replay changes", { timeout: 30000 }, async () => setup(async ({ context, origin, requests }) => {
    const page = await context.newPage();
    await page.goto(origin + "/#activity"); await ready(page);
    const trigger = page.getByRole("combobox", { name: "Activity", exact: true });
    const count = requests.length;
    await page.locator('label[for="layerFilter-control"]').click();
    assert.equal(await trigger.evaluate((node) => node === document.activeElement), true);
    if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.press("ArrowDown");
    await trigger.press("End");
    assert.match(await trigger.getAttribute("aria-activedescendant"), /option-5$/);
    await trigger.press("Home");
    assert.match(await trigger.getAttribute("aria-activedescendant"), /option-0$/);
    await trigger.press("ArrowDown");
    assert.match(await trigger.getAttribute("aria-activedescendant"), /option-1$/);
    await trigger.press("g");
    assert.match(await trigger.getAttribute("aria-activedescendant"), /option-2$/);
    await trigger.press("g");
    assert.match(await trigger.getAttribute("aria-activedescendant"), /option-5$/);
    await trigger.press("Escape");
    assert.equal(await page.locator("#layerFilter").inputValue(), "tool");
    assert.equal(requests.length, count, "Read-only exploration performs no fetch or mutation");
    await trigger.press("Space"); await trigger.press("End"); await trigger.press("Tab");
    assert.equal(await trigger.getAttribute("aria-expanded"), "false");
    assert.equal(await trigger.evaluate((node) => node === document.activeElement), false);
    assert.equal(await page.locator("#layerFilter").inputValue(), "tool", "Tab dismisses uncommitted exploration");
    await trigger.click();
    await page.evaluate(() => {
        window.underlyingClicks = 0;
        document.querySelector("nav [data-nav=reports]").addEventListener("click", () => window.underlyingClicks++);
    });
    await page.locator("nav [data-nav=reports]").click();
    assert.equal(await page.evaluate(() => window.underlyingClicks), 0, "First outside click only dismisses");
    assert.equal(await trigger.evaluate((node) => node === document.activeElement), true);
    await trigger.press("ArrowDown"); await trigger.press("ArrowDown"); await trigger.press("Enter"); await ready(page);
    assert.equal(await page.locator("#layerFilter").inputValue(), "direct-request");
    assert.equal(await page.evaluate(() => window.controlChanges.length), 1);
}));

test("long names, paths and identity details wrap in full without losing selection semantics", { timeout: 30000 }, async () => setup(async ({ context, origin }) => {
    const page = await context.newPage();
    const choices = [
        { value: "project", label: "Synthetic project with a complete distinguishing name for a specific saved investigation" },
        { value: "path", label: "C:\\Synthetic\\Projects\\A-very-long-unbroken-project-folder-name-that-distinguishes-this-source\\session-state" },
        { value: "zone", label: "Los Angeles (America/Los_Angeles)" },
        { value: "report", label: "1 request group · No prompts · Prepared 30 Sep 2026, 12:00",
            detail: "HTML, JSON · Report ID: export-11111111-1111-4111-8111-111111111111" },
    ];
    for (const theme of ["light", "dark"]) for (const scale of [1, 2]) {
        await page.setViewportSize({ width: 375, height: 1000 });
        await page.goto(origin); await ready(page); await chooseTheme(page, theme);
        await page.evaluate(({ choices, scale }) => {
            document.documentElement.style.fontSize = `${scale * 100}%`;
            const field = document.createElement("label"), select = document.createElement("select");
            field.textContent = "Synthetic full identities"; select.id = "identityChoices";
            for (const choice of choices) {
                const option = new Option(choice.label, choice.value);
                if (choice.detail) option.dataset.detail = choice.detail;
                select.append(option);
            }
            field.append(select); document.querySelector("#workspace").append(field);
        }, { choices, scale });
        const trigger = page.locator("#identityChoices-control");
        await trigger.click();
        for (const choice of choices) {
            const row = page.getByRole("option", { name: choice.label, exact: true });
            await row.scrollIntoViewIfNeeded();
            const metrics = await row.evaluate(node => [...node.querySelectorAll(".select-option-label, .select-option-detail")].map(text => {
                const box = text.getBoundingClientRect(), rowBox = node.getBoundingClientRect(), css = getComputedStyle(text);
                return { clipped: text.scrollWidth > text.clientWidth || text.scrollHeight > text.clientHeight,
                    inside: box.left >= rowBox.left && box.right <= rowBox.right && box.bottom <= rowBox.bottom,
                    ellipsis: css.textOverflow === "ellipsis", nowrap: css.whiteSpace === "nowrap" };
            }));
            assert.ok(metrics.every(item => !item.clipped && item.inside && !item.ellipsis && !item.nowrap));
            assert.equal(await row.innerText(), [choice.label, choice.detail].filter(Boolean).join("\n"));
        }
        const report = page.getByRole("option", { name: choices[3].label, exact: true });
        assert.equal(await report.getAttribute("aria-describedby"), await report.locator(".select-option-detail").getAttribute("id"));
        await trigger.press("Home"); await trigger.press("c"); await trigger.press("Enter");
        assert.equal(await page.locator("#identityChoices").inputValue(), "path", "Typeahead uses the full unchanged option identity");
        assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
        assert.equal(await trigger.locator(".select-value").textContent(), choices[1].label);
    }
}));

test("dialog, scroll, disabled, empty, loading, stale and dynamically replaced options stay honest", { timeout: 30000 }, async () => setup(async ({ context, origin }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 375, height: 650 });
    await page.goto(origin); await ready(page);
    await page.evaluate(() => {
        const dialog = document.querySelector("#overlay");
        document.querySelector("#detail").innerHTML = '<label>Test scope<select id="testScope"><option value="0">First scope</option><option value="1" disabled data-disabled-reason="This saved scope is unavailable in the current snapshot.">Unavailable scope</option>' +
            Array.from({ length: 30 }, (_, i) => `<option value="${i + 2}">Synthetic scope ${i + 2} with a deliberately long descriptive label</option>`).join("") +
            '</select></label><button type="button" id="afterScope">After scope</button>';
        dialog.showModal();
    });
    const trigger = page.getByRole("combobox", { name: "Test scope", exact: true });
    await trigger.click(); await trigger.press("ArrowDown");
    assert.match(await trigger.getAttribute("aria-activedescendant"), /option-2$/, "Disabled option is skipped");
    const disabled = page.getByRole("option", { name: "Unavailable scope", exact: true });
    assert.equal(await disabled.getAttribute("aria-disabled"), "true");
    assert.equal(await disabled.locator(".select-option-detail").innerText(), "This saved scope is unavailable in the current snapshot.");
    assert.equal(await disabled.getAttribute("aria-describedby"), await disabled.locator(".select-option-detail").getAttribute("id"));
    await disabled.dispatchEvent("click");
    assert.equal(await page.locator("#testScope").inputValue(), "0");
    assert.equal(await trigger.getAttribute("aria-expanded"), "true");
    await trigger.press("End");
    assert.ok(await page.locator(".select-popup").evaluate((node) => node.scrollTop > 0));
    assert.equal(await page.locator("#overlay .select-popup:popover-open").count(), 1, "Top-layer list remains inside dialog focus/inert scope");
    assert.equal(await page.locator(".select-option").last().evaluate((node) => {
        const box = node.getBoundingClientRect();
        return document.elementFromPoint(box.x + 5, box.y + box.height / 2)?.closest(".select-option") === node;
    }), true, "Actual option is on top and hit-testable");
    await trigger.press("Escape");
    assert.equal(await page.locator("#overlay").evaluate((node) => node.open), true, "Escape closes only the list");
    await trigger.click();
    await page.locator("#testScope").evaluate((node) => node.replaceChildren(new Option("Replacement scope", "fresh")));
    await page.waitForFunction(() => document.querySelector("#testScope-control").getAttribute("aria-expanded") === "false");
    assert.equal(await trigger.textContent(), "Replacement scope");
    assert.equal(await page.evaluate(() => window.controlChanges.length), 0, "Replacing options cannot commit a stale row");
    for (const state of ["loading", "stale"]) {
        await page.locator("#testScope").evaluate((node, state) => node.dataset.selectState = state, state);
        await page.waitForFunction(() => document.querySelector("#testScope-control").disabled);
        assert.match(await trigger.textContent(), state === "loading" ? /Loading/ : /Refresh to choose/);
    }
    await page.locator("#testScope").evaluate((node) => { delete node.dataset.selectState; node.replaceChildren(); });
    await page.waitForFunction(() => document.querySelector("#testScope-control").textContent.includes("No options"));
    assert.equal(await trigger.isDisabled(), true);
    await page.locator("#testScope").evaluate((node) => node.append(new Option("Available scope", "available")));
    await page.waitForFunction(() => !document.querySelector("#testScope-control").disabled);
    await trigger.click();
    await page.locator("#testScope").evaluate((node) => node.hidden = true);
    await page.waitForFunction(() => document.querySelector(".select-popup").hidden);
    assert.equal(await trigger.isVisible(), false);
    await page.locator("#overlay").evaluate((node) => node.close());
    assert.equal(await page.evaluate(() => window.controlChanges.length), 0);
}));
