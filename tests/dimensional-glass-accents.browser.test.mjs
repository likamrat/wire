import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";
import { styles } from "../web/styles.mjs";
import { distance } from "./color-measurements.mjs";

const proofDir = process.env.WORKIQ_GLASS_ACCENT_PROOFS;
const charts = createDimensionalCharts();
const services = Object.keys(charts.servicePalette);

async function mount(page, theme, width = 1600, textSize = 16) {
    await page.setViewportSize({ width, height: 1000 });
    await page.setContent(`<html data-evidence-theme="${theme}" style="font-size:${textSize}px"><head><style>${styles}</style></head><body><main style="width:100%;max-width:none;margin:0;padding:20px"><section class="chart-panel"><h2>Synthetic service glass accents</h2><div id="chart"></div></section></main></body></html>`);
}

async function decode(decoder, buffer, points) {
    return decoder.evaluate(async ({ image, points }) => {
        const img = new Image();
        img.src = image;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.width; canvas.height = img.height;
        const context = canvas.getContext("2d");
        context.drawImage(img, 0, 0);
        return points.map(({ x, y }) => [...context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data].slice(0, 3));
    }, { image: `data:image/png;base64,${buffer.toString("base64")}`, points });
}

async function accentPixels(page, decoder) {
    const samples = await page.locator(".dimensional-column").evaluateAll(nodes => nodes.map(svg => {
        const height = +svg.dataset.frontHeight, width = +svg.dataset.frontWidth;
        const dx = +svg.getAttribute("width") - width, dy = +svg.dataset.depth, rise = +svg.dataset.rise;
        const front = svg.querySelector(".dimensional-front");
        const screen = (node, x, y) => {
            const point = new DOMPoint(x, y).matrixTransform(node.getScreenCTM());
            return { x: point.x + scrollX, y: point.y + scrollY };
        };
        return {
            service: svg.closest("[data-service]")?.dataset.service || svg.closest(".dimensional-category").querySelector(".group-name").textContent,
            total: +svg.dataset.total, height,
            points: [
                screen(front, width * .08, height * .32),
                screen(svg, dx * .18, rise + dy * .18 + height * .3),
                screen(svg, dx, rise + dy + height * .5),
            ],
        };
    }));
    const points = samples.flatMap(sample => sample.points);
    const on = await decode(decoder, await page.screenshot({ fullPage: true }), points);
    const hidden = await page.addStyleTag({ content: ".dimensional-glint,.dimensional-rim {visibility:hidden!important}" });
    const off = await decode(decoder, await page.screenshot({ fullPage: true }), points);
    await hidden.evaluate(node => node.remove());
    return samples.map((sample, index) => ({
        ...sample,
        pixels: Object.fromEntries(["front", "side", "rim"].map((face, offset) => {
            const painted = on[index * 3 + offset], bare = off[index * 3 + offset];
            return [face, { painted, bare, separation: distance(`rgb(${painted})`, `rgb(${bare})`) }];
        })),
    }));
}

test("Mail and Teams preserve equal glass count geometry with shared bounded accents", { timeout: 30000 }, async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ reducedMotion: "reduce" });
        const decoder = await browser.newPage();
        const proof = [];
        for (const theme of ["light", "dark"]) {
            await mount(page, theme);
            await page.addScriptTag({ content: `window.charts = (${createDimensionalCharts.toString()})();` });
            await page.evaluate(() => {
                const groups = [["Search", 100], ["Calendar", 21], ["Mail", 20], ["Teams", 20], ["Files", 6], ["People", 2]].map(([label, total]) => ({ id: label, label, total }));
                document.querySelector("#chart").append(window.charts.comparisonView({
                    groups, serviceMode: true, label: group => group.label, summary: group => `${group.label}: ${group.total}`,
                    onSelect() {}, tooltip() {}, unit: total => total === 1 ? "call" : "calls",
                }));
            });
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            const rows = await accentPixels(page, decoder);
            proof.push({ theme, rows });
            if (proofDir) {
                await mkdir(proofDir, { recursive: true });
                await page.locator(".chart-panel").screenshot({ path: path.join(proofDir, `glass-${theme}.png`) });
                await writeFile(path.join(proofDir, "glass-pixels.json"), JSON.stringify(proof, null, 2));
            }
            const mail = rows.find(row => row.service === "Mail");
            const teams = rows.find(row => row.service === "Teams");
            assert.equal(mail.height, teams.height);
            assert.deepEqual(rows.map(row => row.total), [100, 21, 20, 20, 6, 2]);
            // Perceptual image-difference floors for decoration, not WCAG text-contrast claims.
            assert.ok(mail.pixels.front.separation > 0, "The recovered glass front is visibly faceted");
            assert.ok(mail.pixels.rim.separation > 0, "A restrained specular spine makes the shared glass corner visible");
            assert.ok(await page.locator(".dimensional-glint,.dimensional-rim").count() > 0);
            const geometry = await page.locator(".dimensional-category").evaluateAll(nodes => nodes.filter(node => ["Mail", "Teams"].includes(node.querySelector(".group-name").textContent)).map(node =>
                [...node.querySelectorAll(".dimensional-glint,.dimensional-rim")].map(mark => ({
                    d: mark.getAttribute("d"), transform: mark.getAttribute("transform"),
                    fill: getComputedStyle(mark).fill, opacity: getComputedStyle(mark).opacity,
                    stroke: getComputedStyle(mark).stroke, strokeWidth: getComputedStyle(mark).strokeWidth,
                    strokeOpacity: getComputedStyle(mark).strokeOpacity,
                }))));
            assert.deepEqual(geometry[0], geometry[1], "Equal-height Mail and Teams share geometry and accent paint");
        }
    } finally { await browser.close(); }
});

test("all service tones retain shared face-bounded accents, count scale and tiny eligibility across themes and widths", { timeout: 90000 }, async () => {
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ reducedMotion: "reduce" });
        const decoder = await browser.newPage();
        const proof = [];
        for (const theme of ["light", "dark"]) for (const width of [375, 820, 1200, 2560]) for (const textSize of [16, 32]) {
            await mount(page, theme, width, textSize);
            const counts = [{ total: 100, maximum: 100 }, { total: 20, maximum: 100 }, { total: 2, maximum: 100 }, { total: 1, maximum: 200 }, { total: 1, maximum: 100000 }, { total: 0, maximum: 100 }];
            await page.locator("#chart").evaluate((node, markup) => {
                node.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:20px";
                node.innerHTML = markup;
            }, services.flatMap(service => counts.map(count => `<div data-service="${service}" data-total="${count.total}" data-maximum="${count.maximum}">${charts.svg({ ...count, service })}<span>${service}: ${count.total}</span></div>`)).join(""));
            const geometry = await page.locator("#chart > div").evaluateAll(nodes => nodes.map(node => {
                const svg = node.querySelector("svg");
                if (!svg) return { service: node.dataset.service, zero: true, total: +node.dataset.total };
                const front = svg.querySelector(".dimensional-front"), glints = [...svg.querySelectorAll(".dimensional-glint")];
                const cap = svg.querySelector(".dimensional-cap"), rim = svg.querySelector(".dimensional-rim");
                const capEdges = cap?.getAttribute("d").match(/[ML][^MLZ]+/g);
                const bounds = glints.every(glint => {
                    const face = svg.querySelector(glint.classList.contains("dimensional-glint-front") ? ".dimensional-front" : ".dimensional-side");
                    return Array.from({ length: 65 }, (_, i) => glint.getPointAtLength(glint.getTotalLength() * i / 64)).every(point =>
                        face.isPointInFill(new DOMPoint(point.x, point.y).matrixTransform(glint.getScreenCTM()).matrixTransform(face.getScreenCTM().inverse())));
                });
                return {
                    service: node.dataset.service, total: +svg.dataset.total, maximum: +svg.dataset.maximum,
                    height: front.height.baseVal.value, capCount: svg.querySelectorAll(".dimensional-cap").length,
                    glints: glints.length, spines: svg.querySelectorAll(".dimensional-spine").length, bounded: bounds,
                    depth: +svg.dataset.depth, width: +svg.getAttribute("width"),
                    capSeam: !cap || (rim.getAttribute("d") === [capEdges[0], capEdges[3], capEdges[2]].join("")
                        && rim.getAttribute("clip-path") === cap.getAttribute("clip-path")),
                    tokens: glints.map(glint => [getComputedStyle(glint).fill, getComputedStyle(glint).opacity]),
                    rimWidth: rim && getComputedStyle(rim).strokeWidth,
                    inert: [...svg.querySelectorAll(".dimensional-glint,.dimensional-rim")].every(mark => getComputedStyle(mark).pointerEvents === "none"),
                };
            }));
            for (const row of geometry) {
                if (row.zero) { assert.equal(row.total, 0); continue; }
                const expected = Math.max(36, Math.sqrt(row.total / row.maximum) * 280);
                assert.ok(Math.abs(row.height - expected) < .0001);
                assert.equal(row.capCount, 1);
                assert.equal(row.glints, expected >= 12 ? 2 : 0);
                assert.equal(row.spines, expected >= 12 ? 1 : 0, "No reflective spine paints over a minimum result band");
                assert.equal(row.width, 116);
                assert.ok(row.depth > 0);
                assert.ok(row.capSeam, "Only the actual front seam is highlighted, clipped inside the finished top");
                assert.ok(row.bounded && row.inert, `${theme}/${width}/${textSize}/${row.service}: decorative face containment`);
                if (row.rimWidth) assert.equal(row.rimWidth, "0.65px");
            }
            const faceted = geometry.filter(row => row.glints);
            for (const row of faceted) assert.deepEqual(row.tokens, faceted[0].tokens, "No service-specific accent exception");
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            // Raster proof includes large, 40px and 4px marks at every viewport/text size.
            await page.locator("#chart > div").evaluateAll(nodes => nodes.filter(node => +node.dataset.total < 2).forEach(node => node.remove()));
            const rows = await accentPixels(page, decoder);
            for (const row of rows) {
                assert.equal(row.pixels.front.separation > 0, row.height >= 12, `${theme}/${width}/${textSize}/${row.service}/${row.total}: minimum bands omit glints`);
                // A 4px data edge no longer gets background color from a filled
                // cap. Its accent must remain visible and face-bounded, not be
                // brightened to imitate the old plate. Larger accents keep the floor.
                assert.equal(row.pixels.side.separation > 0, row.height >= 12, "Glints stay off minimum bands");
            }
            proof.push({ theme, width, textSize, geometry, pixels: rows });
            if (proofDir) {
                await mkdir(proofDir, { recursive: true });
                await page.locator(".chart-panel").screenshot({ path: path.join(proofDir, `all-tones-${theme}-${width}-${textSize}.png`) });
            }
        }
        if (proofDir) await writeFile(path.join(proofDir, "all-tones.json"), JSON.stringify(proof, null, 2));
        await page.emulateMedia({ forcedColors: "active" });
        assert.equal(await page.locator(".dimensional-glint,.dimensional-rim").evaluateAll(nodes => nodes.every(node => getComputedStyle(node).display === "none")), true);
        assert.equal(await page.locator(".dimensional-front").evaluateAll(nodes => nodes.every(node => getComputedStyle(node).fillOpacity === "1")), true);
    } finally { await browser.close(); }
});
