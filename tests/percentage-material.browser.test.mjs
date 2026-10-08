import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { renderHtmlShell } from "../lib/render.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { fixture, chooseTheme, automaticScoreOffSummary } from "./helpers.mjs";
import { contrast, luminance, distance } from "./color-measurements.mjs";

const proofDir = process.env.WORKIQ_DONUT_PROOFS;
const baseline = process.env.WORKIQ_DONUT_BASELINE;
const cases = {
    dominant: [188, 25, 6, 0],
    tiny: [193, 25, 1, 0],
    missing: [0, 0, 219, 0],
    mixed: [100, 40, 40, 39],
    zero: [0, 0, 0, 0],
};
const keys = ["success", "failure", "unknown", "partial"];
const hash = value => createHash("sha256").update(value).digest("hex");
const cssRgb = channels => `rgb(${channels.join(",")})`;
const collection = {
    state: "paused", revision: 1, configVersion: 1, connected: true,
    config: { approved: true, enabled: false, windowDays: 30, pollSeconds: 300,
        appDbPath: "C:\\synthetic\\data.db", sessionRoot: "C:\\synthetic\\session-state" },
    lastCheckedAt: "2026-09-30T12:00:00Z", cadence: { pollSeconds: 300 }, metrics: {},
    discovery: { counts: { sessions: 1, dispositions: { eligible: 1 }, skippedByLimit: 0, unmappedWorkspaces: 0 } },
    historyCoverage: { eligible: 1, readable: 1, unavailable: 0, limited: 0, affected: 0, pending: 0 },
};

function sourceFor(name) {
    const outcomes = cases[name].flatMap((count, i) => Array(count).fill(keys[i]));
    if (!outcomes.length) return [];
    const record = fixture(`material-${name}`);
    record.title = "Synthetic donut material check";
    record.userPrompt.text = "SYNTHETIC ONLY: compare recorded call outcomes and activity categories.";
    record.followUpPrompts = [];
    record.toolCalls = outcomes.map((outcome, i) => {
        const endpoint = i < 175 ? "/me/messages" : i < 195 ? "/me/calendar" : i < 213 ? "/me/drive" : null;
        return {
            ...record.toolCalls[0], toolCallId: `material-${name}-${i}`, startEventId: `material-start-${name}-${i}`,
            startedAt: "2026-09-30T12:00:00Z",
            requestedApiPath: endpoint, requestArgs: endpoint ? { entityUrls: [endpoint] } : {},
            toolSucceeded: outcome === "success" ? true : outcome === "failure" ? false : undefined,
            reportedOutcome: outcome === "success" ? "succeeded" : outcome === "failure" ? "failed" : outcome === "partial" ? "partial" : undefined,
            apiResults: [],
        };
    });
    const actual = buildActivityAnalytics([record]).totals;
    keys.forEach((key, i) => assert.equal(actual[key], cases[name][i]));
    return [record];
}

async function ready(page) {
    await page.waitForFunction(() => document.querySelector(".percentage-section") &&
        document.querySelector("#workspace").getAttribute("aria-busy") === "false");
    await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
}

async function capture(page, locator, file) {
    await page.evaluate(() => window.scrollTo(0, 0));
    const clip = await locator.boundingBox();
    return page.screenshot({ clip, fullPage: true, ...(file ? { path: file } : {}) });
}

async function inspect(page) {
    return page.locator(".percentage-section").evaluate(root => ({
        total: Number(root.dataset.total),
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        geometry: [...root.querySelectorAll(".percentage-ring")].map(node => node.outerHTML),
        text: root.textContent,
        rows: [...root.querySelectorAll(".percentage-legend-row")].map(node => {
            const label = node.querySelector(".percentage-label"), css = getComputedStyle(label);
            return {
                category: node.dataset.category, count: node.dataset.count, percentage: node.dataset.percentage,
                label: label.textContent, aria: label.getAttribute("aria-label"), href: label.getAttribute("href"),
                height: label.getBoundingClientRect().height, color: css.color,
                background: getComputedStyle(node.closest(".percentage-card")).backgroundColor,
                icon: node.querySelector(".percentage-cue").innerHTML,
                cue: getComputedStyle(node.querySelector(".percentage-cue")).color,
            };
        }),
        columns: [...document.querySelectorAll(".dimensional-front,.dimensional-side")].map(node => ({
            geometry: node.getAttribute("d"), fill: getComputedStyle(node).fill,
            opacity: getComputedStyle(node).fillOpacity,
        })),
    }));
}

async function pixels(page, card) {
    const ring = card.locator(".percentage-ring");
    const probes = await ring.evaluate(svg => {
        const box = svg.getBoundingClientRect();
        const point = (face, radius, fraction, depth = 0) => {
            const angle = fraction * Math.PI * 2 + Math.PI / 2;
            const p = new DOMPoint(radius * Math.cos(angle), radius * Math.sin(angle) + depth / .68)
                .matrixTransform(face.getScreenCTM());
            return { x: p.x - box.x, y: p.y - box.y };
        };
        return [...svg.querySelectorAll(".percentage-slice")].map(face => {
            const start = +face.dataset.start, end = +face.dataset.end;
            const wall = [...svg.querySelectorAll(".percentage-outer-wall")].find(node => node.dataset.category === face.dataset.category);
            return {
                category: face.dataset.category, count: +face.dataset.count,
                stroke: getComputedStyle(face).stroke, opacity: getComputedStyle(face).fillOpacity,
                samples: [.15, .35, .55, .75, .9].flatMap(along => [.25, .5, .75].map(across =>
                    point(face, 66 + 38 * across, start + (end - start) * along))),
                wall: wall ? point(wall, 104, (+wall.dataset.start + +wall.dataset.end) / 2, 11) : null,
                background: getComputedStyle(svg.closest(".percentage-card")).backgroundColor,
            };
        });
    });
    const image = await capture(page, ring);
    const measured = await page.evaluate(async ({ image, probes }) => {
        const img = new Image(); img.src = image; await img.decode();
        const canvas = document.createElement("canvas"); canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext("2d"); ctx.drawImage(img, 0, 0);
        const pixel = p => [...ctx.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data].slice(0, 3);
        return probes.map(probe => ({ ...probe, samples: probe.samples.map(pixel), wall: probe.wall && pixel(probe.wall) }));
    }, { image: `data:image/png;base64,${image.toString("base64")}`, probes });
    return {
        imageHash: hash(image),
        slices: measured.map(slice => ({
            ...slice,
            meanLuminance: slice.samples.reduce((sum, rgb) => sum + luminance(cssRgb(rgb)), 0) / slice.samples.length,
            maxLuminance: Math.max(...slice.samples.map(rgb => luminance(cssRgb(rgb)))),
            boundaryContrast: contrast(slice.stroke, slice.background),
        })),
    };
}

test("light donut materials restrain glare without changing canonical geometry, meanings, navy or columns", { timeout: 180000 }, async t => {
    const variants = [];
    if (baseline) {
        const module = await import(pathToFileURL(path.join(baseline, "lib", "render.mjs")));
        variants.push(["before", module.renderHtmlShell]);
    }
    variants.push(["after", renderHtmlShell]);
    if (proofDir) await mkdir(proofDir, { recursive: true });
    const browser = await chromium.launch(), reports = [], comparisons = new Map();
    t.after(() => browser.close());
    for (const [phase, render] of variants) {
        const context = await browser.newContext({ reducedMotion: "reduce", deviceScaleFactor: 1 });
        try {
            let records = [];
            const page = await context.newPage(), errors = [], denied = [];
            page.on("pageerror", error => errors.push(error.message));
            await page.route("**/*", async route => {
                const request = route.request(), url = new URL(request.url());
                if (url.origin === "http://donut-material.test" && request.method() === "GET" && url.pathname === "/") {
                    await route.fulfill({ contentType: "text/html", body: render("a".repeat(64), "donut-material") }); return;
                }
                if (url.origin === "http://donut-material.test" && request.method() === "POST" && url.pathname === "/api/snapshot") {
                    const analytics = { ...buildActivityAnalytics(records, request.postDataJSON()), revision: 1 };
                    await route.fulfill({ json: { revision: 1, scenarios: records, exports: [], coverage: { notes: [] }, collection, analytics } }); return;
                }
                if (url.origin === "http://donut-material.test" && request.method() === "POST" && url.pathname === "/api/evaluation/automatic/summary") {
                    await route.fulfill({ json: automaticScoreOffSummary() }); return;
                }
                denied.push(request.url());
                await route.abort("blockedbyclient");
            });
            for (const [name, counts] of Object.entries(cases)) for (const theme of ["light", "dark"]) for (const width of [1920, 375]) {
                records = sourceFor(name);
                await page.setViewportSize({ width, height: 1100 });
                await page.goto(`http://donut-material.test/?fixture=${name}-${theme}-${width}#home?chart=workload`);
                await ready(page); await chooseTheme(page, theme); await ready(page);
                await page.mouse.move(0, 0);
                const result = await inspect(page);
                assert.equal(result.total, counts.reduce((a, b) => a + b, 0));
                assert.equal(result.overflow, false);
                const materials = [];
                for (const card of await page.locator(".percentage-card").all()) {
                    if (await card.locator(".percentage-ring").count()) materials.push(await pixels(page, card));
                }
                for (const row of result.rows) {
                    assert.ok(row.height >= 44);
                    assert.ok(row.icon.length, "A non-color category cue remains present");
                    assert.ok(contrast(row.color, row.background) >= 4.5);
                    assert.ok(contrast(row.cue, row.background) >= 3);
                }
                for (const material of materials) for (const slice of material.slices) {
                    assert.ok(slice.boundaryContrast >= 3, `${theme} ${slice.category} boundary`);
                    if (phase === "after" && theme === "light" && slice.category === "success") {
                        assert.ok(slice.maxLuminance < .65, `Broad Worked highlight is not near-white: ${slice.maxLuminance}`);
                        assert.ok(slice.meanLuminance < .5, `Worked cap avoids a luminous cyan field: ${slice.meanLuminance}`);
                    }
                }
                const comparisonKey = `${name}-${theme}-${width}`;
                if (phase === "before") comparisons.set(comparisonKey, { result, materials });
                else if (comparisons.has(comparisonKey)) {
                    const before = comparisons.get(comparisonKey);
                    assert.deepEqual(result, before.result, "Exact SVGs, labels, links, counts, layout, cues and columns are unchanged");
                    if (theme === "dark") assert.deepEqual(materials, before.materials, "Navy donut pixels and materials remain byte-identical");
                    if (theme === "light" && counts[0]) {
                        const oldSuccess = before.materials[0].slices.find(slice => slice.category === "success");
                        const newSuccess = materials[0].slices.find(slice => slice.category === "success");
                        assert.ok(newSuccess.meanLuminance < oldSuccess.meanLuminance * .7, "The composed surface, not just a token, loses excess brightness");
                    }
                }
                if (proofDir) {
                    if (["dominant", "tiny"].includes(name)) {
                        await page.evaluate(() => window.scrollTo(0, 0));
                        await page.screenshot({ path: path.join(proofDir, `${phase}-${comparisonKey}-page.png`), fullPage: true });
                    }
                    await capture(page, page.locator(".percentage-section"), path.join(proofDir, `${phase}-${comparisonKey}-charts.png`));
                }
                if (phase === "after" && name === "dominant") {
                    const link = page.locator('[data-percentage-card=outcomes] .percentage-label[href]').first();
                    await page.keyboard.press("Tab");
                    await link.focus();
                    assert.ok(await page.locator(".percentage-active.percentage-face").count() > 0);
                    assert.equal(await link.evaluate(node => getComputedStyle(node).outlineStyle), "solid");
                    const active = await page.locator(".percentage-active.percentage-face").first().evaluate(node => ({
                        opacity: getComputedStyle(node).fillOpacity, filter: getComputedStyle(node).filter,
                    }));
                    assert.equal(active.opacity, "1");
                    assert.equal(active.filter, theme === "light" ? "brightness(0.9)" : "brightness(1.15)");
                    await page.emulateMedia({ forcedColors: "active" });
                    assert.equal(await page.locator(".percentage-active.percentage-face").first().evaluate(node =>
                        getComputedStyle(node).filter), "none", "System high-contrast colors are not dimmed");
                    await page.emulateMedia({ forcedColors: "none" });
                    const destination = new URL(await link.getAttribute("href"), page.url()).hash;
                    await page.keyboard.press("Enter");
                    await page.waitForURL(url => url.hash === destination);
                }
                if (phase === "after" && materials[0]?.slices.length > 2 && theme === "light") {
                    const samples = materials[0].slices.map(slice => cssRgb(slice.samples[7]));
                    for (let a = 0; a < samples.length; a++) for (let b = a + 1; b < samples.length; b++) {
                        assert.ok(distance(samples[a], samples[b]) > 6,
                            `${name}/${width}: ${materials[0].slices[a].category} ${samples[a]} / ${materials[0].slices[b].category} ${samples[b]} remain visibly distinct`);
                    }
                }
                reports.push({ phase, name, theme, width, total: result.total, geometryHash: hash(JSON.stringify(result)),
                    minimumTextContrast: result.rows.length ? Math.min(...result.rows.map(row => contrast(row.color, row.background))) : null,
                    minimumCueContrast: result.rows.length ? Math.min(...result.rows.map(row => contrast(row.cue, row.background))) : null,
                    materials });
            }
            assert.deepEqual(errors, []);
            assert.deepEqual(denied, [], "Only synthetic page, snapshot and disabled-evaluation summary reads occur");
        } finally { await context.close(); }
    }
    if (proofDir) await writeFile(path.join(proofDir, "material-measurements.json"), JSON.stringify(reports, null, 2));
});
