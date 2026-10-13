import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { fixture, chooseTheme, selectActivityOption } from "./helpers.mjs";
import { searchFixture } from "./live-search-fixture.mjs";

const proofDir = process.env.WORKIQ_SCALE_PROOFS;
const records = [["2026-09-01", 2], ["2026-09-02", 1], ["2026-10-05", 1]].map(([date, total], index) => {
    const row = fixture(`scale-label-${index}`);
    row.userPrompt.text = "Invented time-scale label example";
    row.capturedAt = `${date}T12:00:00Z`;
    row.toolCalls = Array.from({ length: total }, (_, ordinal) => ({
        ...row.toolCalls[0], toolCallId: `scale-${index}-${ordinal}`, startEventId: `scale-start-${index}-${ordinal}`,
        startedAt: row.capturedAt, requestArgs: { entityUrls: ["/me/messages"] }, requestedApiPath: "/me/messages",
    }));
    return row;
});

async function setup(t) {
    const original = structuredClone(records), requests = [], responses = [], errors = [];
    const server = createServer(async (req, res) => {
        if (req.method === "GET" && req.url === "/") {
            res.setHeader("Content-Type", "text/html");
            res.end(renderHtmlShell("a".repeat(64), "scale-labels")); return;
        }
        if (req.method === "GET" && req.url === "/favicon.svg") {
            res.writeHead(204).end(); return;
        }
        let body = ""; for await (const chunk of req) body += chunk;
        requests.push(req.url);
        res.setHeader("Content-Type", "application/json");
        if (req.method !== "POST" || req.url !== "/api/snapshot") {
            res.writeHead(403); res.end('{"error":"Only invented snapshot reads are served."}'); return;
        }
        const input = JSON.parse(body), analytics = buildActivityAnalytics(records, input);
        responses.push({ input, analytics });
        res.end(JSON.stringify({ revision: 1, scenarios: records, exports: [], coverage: { notes: [] }, analytics: { ...analytics, revision: 1 } }));
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, timezoneId: "UTC", reducedMotion: "reduce" });
    page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(4000);
    t.after(async () => {
        await browser.close(); await new Promise(resolve => server.close(resolve));
        assert.deepEqual(records, original);
        assert.deepEqual(errors, []);
        assert.ok(requests.every(route => ["/api/snapshot", "/api/evaluation/automatic/summary"].includes(route)), JSON.stringify(requests));
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/#home?bucket=month`);
    await ready(page);
    return { page, responses };
}

async function ready(page) {
    await page.locator('#workspace[aria-busy="false"]').waitFor();
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
}

async function measure(page) {
    return page.locator("#bucketControl").evaluate(control => {
        const button = control.querySelector(".select-trigger"), value = button.querySelector(".select-value");
        const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
        const text = document.createRange(); text.selectNodeContents(value);
        return {
            label: value.textContent, value: rect(value), ink: rect(text), trigger: rect(button), control: rect(control),
            heading: rect(control.closest(".chart-heading")), title: rect(document.getElementById("chartTitle")),
            scrollWidth: value.scrollWidth, clientWidth: value.clientWidth, font: getComputedStyle(value).fontSize,
            textOverflow: getComputedStyle(value).textOverflow, pageOverflow: document.documentElement.scrollWidth - innerWidth,
        };
    });
}

test("production time-scale caption and value share a baseline without changing buckets or filters", async t => {
    const app = await searchFixture(t, { records, reply: false });
    const browser = await chromium.launch(), page = await browser.newPage({
        viewport: { width: 1600, height: 1000 }, reducedMotion: "reduce", timezoneId: "UTC",
    });
    const errors = [], inputs = [], measurements = [], failures = [];
    t.after(async () => { await browser.close(); assert.deepEqual(errors, []); });
    await page.route("**/*", route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== new URL(app.runtime.url).origin ||
            request.method() === "POST" && !["/api/snapshot", "/api/collection/status", "/api/assessment/overview",
                "/api/assessment/detail", "/api/evaluation/automatic/summary"].includes(url.pathname)) {
            errors.push("Unexpected request " + url.pathname);
            return route.abort();
        }
        return route.continue();
    });
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => { if (request.url().endsWith("/api/snapshot")) inputs.push(request.postDataJSON()); });
    await page.goto(app.runtime.url + "#analyze?bucket=week&range=custom&from=2026-09-01&to=2026-10-05"); await ready(page);
    assert.ok(await page.evaluate(async () => (await document.fonts.load('500 16px "Asta Sans"')).length > 0));
    if (proofDir) await mkdir(proofDir, { recursive: true });
    const filters = inputs.at(-1).filters, count = await page.locator("#activityCount").innerText();
    assert.equal(filters.from, "2026-09-01"); assert.equal(filters.to, "2026-10-05");
    for (const [width, scale] of [[1600, 1], [375, 1], [375, 2]]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.evaluate(scale => document.documentElement.style.fontSize = `${scale * 100}%`, scale);
        await chooseTheme(page, width === 1600 ? "dark" : "light"); await ready(page);
        const widths = [];
        for (const bucket of ["week", "day", "month"]) {
            await selectActivityOption(page, "bucketFilter", bucket); await ready(page);
            await page.locator("#bucketControl").scrollIntoViewIfNeeded();
            const geometry = await page.locator("#bucketControl").evaluate(control => {
                const rect = node => {
                    const { x, y, width, height, right, bottom } = node.getBoundingClientRect();
                    return { x, y, width, height, right, bottom };
                };
                const text = node => {
                    const range = document.createRange(); range.selectNodeContents(node);
                    return rect(range);
                };
                const caption = control.querySelector(".bucket-label"), value = control.querySelector(".select-value");
                return { control: rect(control), caption: rect(caption), captionText: text(caption), value: rect(value), valueText: text(value),
                    trigger: rect(control.querySelector(".select-trigger")), title: rect(document.getElementById("chartTitle")),
                    heading: rect(control.closest(".chart-heading")), font: getComputedStyle(value).fontFamily,
                    overflow: document.documentElement.scrollWidth - innerWidth };
            });
            widths.push(geometry.trigger.width);
            measurements.push({ width, scale, bucket, ...geometry });
            if (geometry.caption.width <= 1) failures.push(`${width}/${scale}/${bucket}: time-scale caption is visually hidden`);
            if (geometry.captionText.right <= geometry.valueText.x &&
                Math.abs(geometry.captionText.bottom - geometry.valueText.bottom) > 3 * scale) {
                failures.push(`${width}/${scale}/${bucket}: caption text bottom ${geometry.captionText.bottom} versus value ${geometry.valueText.bottom}`);
            }
            assert.ok(geometry.trigger.height >= 44 && geometry.overflow <= 1);
            assert.ok(geometry.control.x >= geometry.heading.x - 1 && geometry.control.right <= geometry.heading.right + 1);
            assert.ok(geometry.title.bottom <= geometry.control.y + 1 || geometry.title.right <= geometry.control.x);
            assert.equal(await page.locator("#bucketFilter").inputValue(), bucket);
            assert.equal(inputs.at(-1).bucket, bucket);
            assert.deepEqual(inputs.at(-1).filters, filters);
            assert.equal(await page.locator("#activityCount").innerText(), count);
            assert.match(geometry.font, /Asta Sans/);
            const expected = buildActivityAnalytics(records, inputs.at(-1)).timeSeries.points;
            assert.deepEqual(await page.locator(".dimensional-count").allTextContents(),
                expected.map(point => `${point.total} ${point.total === 1 ? "call" : "calls"}`), "Selected scale retains exact bucket counts");
            const trigger = page.locator("#bucketFilter-control");
            await trigger.focus(); await trigger.press("ArrowDown");
            const popup = await page.locator(".select-popup").boundingBox(), anchor = await trigger.boundingBox();
            const side = await page.locator(".select-popup").getAttribute("data-side");
            assert.ok(popup.x >= 8 && popup.x + popup.width <= width - 7);
            assert.ok(Math.abs(side === "top" ? anchor.y - popup.y - popup.height - 6 : popup.y - anchor.y - anchor.height - 6) <= 1);
            if (proofDir && bucket === "week") await page.screenshot({ path: path.join(proofDir, `time-scale-${width}-${scale}-open.png`) });
            await trigger.press("Escape");
            assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
            assert.equal(await page.locator("#bucketFilter").inputValue(), bucket);
            if (proofDir && bucket === "week") await page.screenshot({ path: path.join(proofDir, `time-scale-${width}-${scale}-closed.png`) });
        }
        assert.ok(Math.max(...widths) - Math.min(...widths) <= 1, "Changing Weekly/Daily/Monthly keeps stable intrinsic width");
        for (const mode of ["workload", "endpoint", "time"]) {
            await page.locator(`[data-chart="${mode}"]`).click(); await ready(page);
            assert.equal(await page.locator("#bucketControl").isVisible(), mode === "time");
            assert.equal(await page.locator("#bucketFilter").inputValue(), "month");
            assert.deepEqual(inputs.at(-1).filters, filters);
            assert.equal(await page.locator("#activityCount").innerText(), count);
        }
    }
    await page.locator("#bucketControl").evaluate(node => node.style.maxWidth = "8rem");
    const wrapped = await page.locator("#bucketControl").evaluate(node => {
        const caption = node.querySelector(".bucket-label").getBoundingClientRect();
        const trigger = node.querySelector(".select-trigger").getBoundingClientRect(), control = node.getBoundingClientRect();
        return { captionBottom: caption.bottom, triggerTop: trigger.top, triggerRight: trigger.right, controlRight: control.right };
    });
    if (wrapped.triggerTop < wrapped.captionBottom || wrapped.triggerRight > wrapped.controlRight + 1) {
        failures.push("A genuinely constrained enlarged-text group must wrap caption and control without overlap");
    }
    assert.equal(await page.locator("#bucketFilter").inputValue(), "month");
    await page.locator("#bucketControl").evaluate(node => node.style.removeProperty("max-width"));
    if (proofDir) await writeFile(path.join(proofDir, "production-time-scale.json"), JSON.stringify({ measurements, wrapped, failures }, null, 2));
    assert.deepEqual(failures, []);
});

test("every supported time-scale label fits selected control and menu without width jumps or header overflow", async t => {
    const { page, responses } = await setup(t), measurements = [], failures = [];
    const choices = await page.locator("#bucketFilter").evaluate(node => [...node.options].map(option => ({ value: option.value, label: option.label })));
    assert.deepEqual(choices, [{ value: "week", label: "Weekly" }, { value: "day", label: "Daily" }, { value: "month", label: "Monthly" }]);
    if (proofDir) await mkdir(proofDir, { recursive: true });
    for (const theme of ["light", "dark"]) for (const [width, scale, panel] of [[1200, 1, null], [1200, 2, null], [375, 1, null], [375, 2, null], [1200, 2, 290]]) {
        await page.setViewportSize({ width, height: 1000 }); await chooseTheme(page, theme);
        await page.evaluate(({ scale, panel }) => {
            document.documentElement.style.fontSize = `${scale * 100}%`;
            document.querySelector(".chart-panel").style.width = panel ? `${panel}px` : "";
        }, { scale, panel });
        await ready(page);
        const widths = [];
        for (const option of choices) {
            await selectActivityOption(page, "bucketFilter", option.value); await ready(page);
            const row = await measure(page);
            widths.push(row.trigger.width);
            measurements.push({ theme, width, scale, panel, option, ...row });
            const context = `${theme}/${width}/text${scale}/panel${panel}/${option.label}`;
            assert.equal(row.label, option.label);
            assert.equal(await page.locator("#bucketFilter").inputValue(), option.value);
            if (row.scrollWidth > row.clientWidth + .5 || row.ink.width > row.value.width + .5) failures.push(`${context}: selected label clipped ${row.ink.width}px into ${row.value.width}px`);
            if (row.pageOverflow > 1 || row.control.x < row.heading.x - 1 || row.control.right > row.heading.right + 1) failures.push(`${context}: control escapes header/page`);
            assert.ok(row.trigger.height >= 44, "Visible selector keeps its target height");
            assert.equal(row.font, `${14 * scale}px`, "Do not shrink text to make Monthly fit");
            assert.ok(row.title.bottom <= row.control.y + 1 || row.title.right <= row.control.x, "Title and selector reflow as whole controls rather than overlapping");
            assert.match(await page.locator("#chartTitle").textContent(), new RegExp(`\\(${option.label}\\)`));
            const expected = responses.at(-1).analytics;
            assert.equal(responses.at(-1).input.bucket, option.value);
            assert.equal(expected.totals.count, 4);
            assert.deepEqual(await page.locator(".dimensional-count").allTextContents(), expected.timeSeries.points.map(point => `${point.total} ${point.total === 1 ? "call" : "calls"}`));
            if (proofDir && option.value === "month") {
                await page.evaluate(() => { document.activeElement.blur(); scrollTo(0, 0); });
                const clip = await page.locator(".chart-heading").boundingBox();
                await page.screenshot({ path: path.join(proofDir, `${theme}-${width}-text${scale}-panel${panel}-monthly.png`), fullPage: true, clip });
            }
            const trigger = page.getByRole("combobox", { name: "Time scale", exact: true });
            await trigger.click();
            const popup = page.locator(".select-popup:visible");
            assert.deepEqual(await popup.locator(".select-option-label").allTextContents(), choices.map(choice => choice.label));
            const menu = await popup.evaluate(node => ({
                x: node.getBoundingClientRect().x, right: node.getBoundingClientRect().right,
                y: node.getBoundingClientRect().y, bottom: node.getBoundingClientRect().bottom, side: node.dataset.side,
                clipped: [...node.querySelectorAll(".select-option-label")].some(label => label.scrollWidth > label.clientWidth + 1),
                rowHeights: [...node.querySelectorAll(".select-option")].map(option => option.getBoundingClientRect().height),
            }));
            assert.equal(menu.clipped, false);
            assert.ok(menu.x >= 0 && menu.right <= width + 1, "Popup anchoring remains within the viewport");
            assert.ok(menu.rowHeights.every(height => height >= 36), "Menu targets preserve their existing minimum");
            const anchor = await trigger.boundingBox();
            assert.ok(Math.abs(menu.side === "top" ? anchor.y - menu.bottom - 6 : menu.y - anchor.y - anchor.height - 6) < 1, "Popup remains anchored to the actual trigger edge");
            await page.keyboard.press("Escape");
            assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
            assert.equal(await trigger.evaluate(node => getComputedStyle(node, "::before").outlineStyle), "solid");
            assert.equal(await page.locator("#bucketFilter").inputValue(), option.value);
        }
        assert.ok(Math.max(...widths) - Math.min(...widths) < 1, "Selecting a different scale does not resize the trigger");
    }
    if (proofDir) await writeFile(path.join(proofDir, "time-scale-labels.json"), JSON.stringify({ choices, measurements, failures }, null, 2));
    assert.deepEqual(failures, []);
    const sizer = page.locator("#bucketFilter-control .select-option-sizer");
    assert.equal(await sizer.getAttribute("aria-hidden"), "true");
    assert.deepEqual(await sizer.locator("span").allTextContents(), choices.map(option => option.label));
    assert.equal(await sizer.locator("button,a,input,[tabindex]").count(), 0);
    assert.equal(await sizer.evaluate(node => getComputedStyle(node).visibility), "hidden");
    assert.equal(await page.locator(".select-control").filter({ hasNot: page.locator("#bucketFilter") }).locator(".select-option-sizer").count(), 0, "Ordinary dropdown sizing is unchanged");
});

test("time-scale keyboard choice, Back and restored route retain the exact bucket and counts", async t => {
    const { page, responses } = await setup(t);
    const trigger = page.getByRole("combobox", { name: "Time scale", exact: true });
    for (const [label, value] of [["Daily", "day"], ["Weekly", "week"], ["Monthly", "month"]]) {
        await trigger.focus(); await page.keyboard.press("ArrowDown"); await page.keyboard.press(label[0]); await page.keyboard.press("Enter"); await ready(page);
        assert.equal(await page.locator("#bucketFilter").inputValue(), value);
        assert.equal(responses.at(-1).input.bucket, value);
        assert.ok((await trigger.textContent()).includes(label));
        assert.match(page.url(), new RegExp(`bucket=${value}`));
    }
    for (const value of ["week", "day", "month"]) {
        await page.goBack(); await ready(page);
        assert.equal(await page.locator("#bucketFilter").inputValue(), value);
        assert.equal(responses.at(-1).analytics.totals.count, 4);
    }
    await page.reload(); await ready(page);
    assert.equal(await page.locator("#bucketFilter").inputValue(), "month");
    assert.equal((await measure(page)).label, "Monthly");
});
