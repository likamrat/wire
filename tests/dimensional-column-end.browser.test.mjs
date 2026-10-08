import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { contrast, distance } from "./color-measurements.mjs";
import { styles } from "../web/styles.mjs";

const charts = createDimensionalCharts();
const values = (success, failure = 0, unknown = 0) => ({ success, failure, unknown, partial: 0, other: 0, transport: 0 });
const cases = [
    { total: 50, values: values(40, 10) },
    { total: 121, values: values(113, 7, 1) },
    { total: 2, values: values(2) },
    { total: 20, service: "Mail" },
];

test("a neutral finished top closes every glossy column without adding a data layer or a perimeter outline", async t => {
    const browser = await chromium.launch(), page = await browser.newPage({ viewport: { width: 1000, height: 760 }, reducedMotion: "reduce" });
    const decoder = await browser.newPage(), proof = [];
    t.after(() => browser.close());
    await page.route("**/*", route => route.abort());
    for (const theme of ["light", "dark"]) {
        await page.setContent(`<html data-evidence-theme="${theme}"><style>${styles}
            main{width:100%;max-width:none;margin:0;padding:24px}
            #ends{display:flex;align-items:end;justify-content:space-around;gap:32px;padding:40px 16px;background:var(--paper)}
            .case{position:relative}.case>span{display:block;text-align:center;margin-bottom:16px}
            </style><body><main><h2>Invented column finish examples</h2><div id="ends">${cases.map(options =>
                `<div class="case"><span>${options.total} calls</span>${charts.svg({ ...options, maximum: 121, width: 84, plotHeight: 480 })}</div>`).join("")}</div></main></body></html>`);
        await page.evaluate(() => document.fonts.ready);
        const measured = await page.locator(".dimensional-column").evaluateAll(nodes => nodes.map(svg => {
            const cap = svg.querySelector(".dimensional-cap"), box = cap.getBBox();
            const p = new DOMPoint(box.x + box.width / 2, box.y + box.height / 2).matrixTransform(cap.getScreenCTM());
            const style = getComputedStyle(cap), rim = svg.querySelector(".dimensional-rim:not(.dimensional-spine)");
            return {
                x: p.x, y: p.y, fill: style.fill, opacity: style.fillOpacity, stroke: style.stroke,
                capCount: svg.querySelectorAll(".dimensional-cap").length,
                semanticCount: cap.hasAttribute("data-count") || cap.hasAttribute("data-segment") || !!cap.closest("[data-segment]"),
                perimeter: rim?.getAttribute("d").endsWith("Z"),
                background: getComputedStyle(svg.closest("#ends")).backgroundColor,
                total: +svg.dataset.total, edgeHeight: +svg.dataset.frontHeight,
            };
        }));
        for (const cap of measured) {
            assert.equal(cap.opacity, "1", "The ending is a surface, not the background showing through");
            assert.match(cap.fill, /-end"\)$/);
            assert.equal(cap.stroke, "none", "Closure does not depend on outlining an empty hole");
            assert.equal(cap.capCount, 1); assert.equal(cap.semanticCount, false); assert.equal(cap.perimeter, false);
            assert.equal(cap.edgeHeight, Math.max(36, Math.sqrt(cap.total / 121) * 480));
        }
        const pixels = await decoder.evaluate(async ({ image, points }) => {
            const img = new Image(); img.src = image; await img.decode();
            const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
            const context = canvas.getContext("2d"); context.drawImage(img, 0, 0);
            return points.map(p => `rgb(${[...context.getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data].slice(0, 3)})`);
        }, { image: `data:image/png;base64,${(await page.screenshot()).toString("base64")}`, points: measured });
        for (const [index, pixel] of pixels.entries()) {
            assert.ok(contrast(pixel, measured[index].background) > 1.2, "The actual neutral plane separates from the panel in both themes");
            assert.ok(distance(pixel, pixels[0]) < 2, "Service and outcome stacks share the same non-semantic end material");
        }
        proof.push({ theme, measured, pixels });
        if (process.env.WORKIQ_END_PROOFS) {
            await mkdir(process.env.WORKIQ_END_PROOFS, { recursive: true });
            await page.locator("main").screenshot({ path: path.join(process.env.WORKIQ_END_PROOFS, `end-${theme}.png`) });
        }
    }
    if (process.env.WORKIQ_END_PROOFS) await writeFile(path.join(process.env.WORKIQ_END_PROOFS, "end-material.json"), JSON.stringify(proof, null, 2));
});
