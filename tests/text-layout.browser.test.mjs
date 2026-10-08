import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { styles } from "../web/styles.mjs";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { createEvidenceUX } from "../web/ux.mjs";
import { uxIcons } from "../web/ux-icons.mjs";
import { createSelectControls } from "../web/select-control.mjs";

const longLabel = "Synthetic label " + "longunbrokentoken".repeat(25) + " \u65e5\u672c\u8a9e";

async function mount(t) {
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ reducedMotion: "reduce" });
    page.setDefaultTimeout(5000);
    return page;
}

async function doubleText(page) {
    await page.evaluate(() => {
        const nodes = [...document.querySelectorAll("body *")];
        const sheet = document.createElement("style");
        sheet.textContent = nodes.map((node, i) => {
            node.dataset.zoomText = i;
            return `[data-zoom-text="${i}"]{font-size:${parseFloat(getComputedStyle(node).fontSize) * 2}px!important}`;
        }).join("\n");
        document.head.append(sheet);
    });
}

test("chart dates and exact counts remain within their readable scroll region at doubled text", async t => {
    const page = await mount(t);
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.setContent(`<html data-evidence-theme="${theme}"><head><style>${styles}</style></head><body><main style="margin:0;width:100%;padding:16px"><div class="chart-panel" id="chart"></div></main></body></html>`);
        await page.addScriptTag({ content: `window.chart=(${createDimensionalCharts.toString()})();window.ux=(${createEvidenceUX.toString()})(${JSON.stringify(uxIcons)});` });
        await page.evaluate(() => {
            document.querySelector("#chart").append(window.chart.timeView({
                points: [1, 999999].map(total => ({ total, success: total, failure: 0, unknown: 0, partial: 0, other: 0, transport: 0 })),
                label: () => "Sep 30, 2026", summary: point => `${point.total} synthetic actions on September 30, 2026`,
                onSelect: () => {}, tooltip: window.ux.tooltip,
            }));
        });
        await doubleText(page);
        const geometry = await page.locator(".dimensional-time-labels>span").evaluateAll(nodes => nodes.map(node => {
            const box = node.getBoundingClientRect(), parent = node.closest(".dimensional-scroll").getBoundingClientRect();
            return { bottom: box.bottom, boundary: parent.bottom };
        }));
        assert.ok(geometry.every(box => box.bottom <= box.boundary + 1), `${theme}/${width}: date label must not be clipped by the fixed-height lane: ${JSON.stringify(geometry)}`);
        const count = page.locator(".time-column").last();
        await count.focus();
        const tooltip = page.getByRole("tooltip");
        assert.equal(await tooltip.isVisible(), false);
        assert.match(await count.getAttribute("aria-label"), /999999 synthetic actions/);
        const bounds = await count.locator(".dimensional-count").boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= 1000);
    }
});

test("full select options, code and long tooltips wrap or scroll without clipping", async t => {
    const page = await mount(t);
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
        await page.setViewportSize({ width, height: 620 });
        await page.setContent(`<html data-evidence-theme="${theme}"><head><style>${styles}</style></head><body><main style="margin:0;width:100%;padding:16px"><label>Project<select id="long"><option>Short</option></select></label><div id="code"></div><div id="help"></div></main></body></html>`);
        await page.addScriptTag({ content: `window.ux=(${createEvidenceUX.toString()})(${JSON.stringify(uxIcons)});window.controls=(${createSelectControls.toString()})(window.ux);` });
        await page.evaluate(text => {
            const option = document.createElement("option");
            option.textContent = text; option.value = "long"; option.selected = true;
            document.querySelector("select").append(option);
            window.controls.sync();
            document.querySelector("#code").append(window.ux.codeBlock("  echo " + text + "\n\tsecond command\n", { label: "Synthetic multiline code" }));
            document.querySelector("#help").append(window.ux.helpButton("synthetic long help", text.repeat(6)));
        }, longLabel);
        await page.locator(".select-trigger").click();
        await doubleText(page);
        const option = page.locator(".select-option-label").last();
        assert.equal(await option.textContent(), longLabel);
        assert.equal(await option.evaluate(node => node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1), true);
        await page.keyboard.press("Escape");
        const pre = page.locator("pre");
        assert.equal(await pre.textContent(), "  echo " + longLabel + "\n\tsecond command\n");
        assert.equal(await pre.evaluate(node => getComputedStyle(node).whiteSpace), "pre");
        assert.equal(await pre.evaluate(node => node.scrollWidth > node.clientWidth && getComputedStyle(node).overflowX === "auto"), true);
        await page.getByRole("button", { name: "About synthetic long help" }).focus();
        const tooltip = page.getByRole("tooltip");
        await tooltip.waitFor();
        assert.equal(await tooltip.textContent(), longLabel.repeat(6));
        await page.locator("#evidence-tooltip").evaluate(node => { node.style.fontSize = "28px"; });
        await page.evaluate(() => window.dispatchEvent(new Event("resize")));
        const box = await tooltip.boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 620);
        assert.equal(await tooltip.evaluate(node => getComputedStyle(node).overflowY), "auto");
    }
});

test("enlarged technical fact labels never overlap their values", async t => {
    const page = await mount(t);
    for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200]) {
        await page.setViewportSize({ width, height: 900 });
        await page.setContent(`<html data-evidence-theme="${theme}" style="font-size:32px"><head><style>${styles}</style></head><body><main style="margin:0;width:100%;padding:16px"><dl class="facts"><dt>Provenance</dt><dd>human-authored</dd><dt>Timestamp</dt><dd>Sep 29, 2026, 12:22:29 PM</dd><dt>Reported status</dt><dd>200</dd></dl></main></body></html>`);
        const clipped = await page.locator(".facts dt,.facts dd").evaluateAll(nodes =>
            nodes.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.tagName));
        assert.deepEqual(clipped, [], `${theme}/${width}: complete technical labels and values fit separate cells at 200% text`);
    }
});
