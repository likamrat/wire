import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buildSanitizedBundle } from "../lib/export.mjs";
import { renderHtmlReport } from "../lib/product-report.mjs";
import { createDimensionalReportChart, dimensionalReportStyles } from "../lib/dimensional-report.mjs";
import { renderPdf } from "../lib/pdf.mjs";
import { fixture } from "./helpers.mjs";

test("printed dimensional charts have exact front heights, local paint, complete labels and frozen PDF bytes", { timeout: 60000 }, async () => {
    const endpoints = ["/me/messages", "/me/events", "/me/drive/root/children", "/teams", "/unknown"];
    const records = endpoints.flatMap((endpoint, group) => Array.from({ length: [7, 4, 9, 5, 1][group] }, (_, index) => {
        const record = fixture(`synthetic-dimensional-report-${group}-${index}`);
        record.toolCalls[0].requestedApiPath = endpoint;
        record.toolCalls[0].requestArgs = { entityUrls: [endpoint] };
        record.toolCalls[0].toolSucceeded = index % 4 !== 0;
        record.toolCalls[0].reportedOutcome = index % 4 !== 0 ? "succeeded" : "failed";
        return record;
    }));
    const before = structuredClone(records);
    const bundle = await buildSanitizedBundle(records, "a".repeat(64), { promptMode: "none", formats: ["html", "pdf", "json", "markdown"] });
    const html = bundle.files["product-report.html"];
    assert.match(html, /Visual sizes are adjusted for readability/);
    assert.doesNotMatch(html, /Vertical edge height shows count on a common zero-based scale/);
    const options = { snapshot: bundle.snapshot, privacy: bundle.privacy };
    assert.equal(renderHtmlReport(bundle.records, options), renderHtmlReport(bundle.records, options), "Report SVG IDs are deterministic per document");
    assert.deepEqual(records, before);
    assert.doesNotMatch(html, /SYNTHETIC_PRIVATE_PROMPT|SYNTHETIC_PRIVATE_FOLLOWUP/);
    const browser = await chromium.launch();
    const requests = [];
    const proofDir = process.env.WORKIQ_DIMENSIONAL_PROOFS;
    try {
        const page = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 1100, height: 1000 } });
        await page.route("**/*", route => { requests.push(route.request().url()); return route.abort(); });
        await page.setContent(html);
        await page.emulateMedia({ media: "print" });
        const geometry = await page.locator(".dimensional-column").evaluateAll(nodes => nodes.map(svg => ({
            total: Number(svg.dataset.total), maximum: Number(svg.dataset.maximum),
            height: [...svg.querySelectorAll(".dimensional-front")].reduce((sum, face) => sum + face.height.baseVal.value * face.getScreenCTM().d, 0),
            ids: [...svg.querySelectorAll("linearGradient")].map(node => node.id),
            paints: [...svg.querySelectorAll(".dimensional-front")].map(node => getComputedStyle(node).fill),
        })));
        assert.ok(geometry.length >= 5);
        const ids = geometry.flatMap(column => column.ids);
        assert.equal(ids.length, new Set(ids).size);
        for (const column of geometry) {
            assert.ok(Math.abs(column.height - Math.max(36, Math.sqrt(column.total / column.maximum) * 280)) < .03, `Print geometry matches the disclosed readable scale: ${JSON.stringify(column)}`);
            for (const paint of column.paints) assert.match(paint, /^(?:url\("#dimensional-|rgb)/, "Only local material gradients or thin-band identity colors paint a front");
        }
        assert.ok(await page.locator(".dimensional-report-label").count() >= 5);
        const centers = await page.locator(".dimensional-report-category").evaluateAll(nodes => nodes.map(node => {
            const center = element => { const box = element.getBoundingClientRect(); return box.x + box.width / 2; };
            return {
                paint: (() => {
                    const faces = [...node.querySelectorAll(".dimensional-front,.dimensional-side,.dimensional-cap")].map(face => face.getBoundingClientRect());
                    return (Math.min(...faces.map(face => face.x)) + Math.max(...faces.map(face => face.right))) / 2;
                })(),
                value: center(node.querySelector("strong")),
                label: center(node.querySelector(".dimensional-report-label")),
                base: (() => {
                    const front = node.querySelector(".dimensional-front");
                    return new DOMPoint(0, front.y.baseVal.value + front.height.baseVal.value).matrixTransform(front.getScreenCTM()).y - node.closest(".dimensional-report-grid").getBoundingClientRect().y;
                })(),
            };
        }));
        for (const center of centers) {
            assert.ok(Math.abs(center.paint - center.label) <= 1, "Print painted silhouettes center on their labels");
            assert.ok(Math.abs(center.value - center.label) <= 1, "Print values use the same projected column centerline");
            assert.ok(Math.abs(center.base - centers[0].base) <= .03, "Every print scene retains the same local horizontal zero baseline");
        }
        assert.deepEqual(requests, [], "Printing cannot load external resources");
        if (proofDir) {
            await mkdir(proofDir, { recursive: true });
            await page.locator(".dimensional-report").first().screenshot({ path: path.join(proofDir, "report-print-chart.png") });
            await writeFile(path.join(proofDir, "dimensional-report.pdf"), bundle.files["product-report.pdf"]);
            const loading = getDocument({ data: new Uint8Array(bundle.files["product-report.pdf"]), useSystemFonts: true });
            const doc = await loading.promise;
            try {
                for (let number = 1; number <= doc.numPages; number++) {
                    const pdfPage = await doc.getPage(number);
                    const viewport = pdfPage.getViewport({ scale: 1.5 });
                    const rendered = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
                    await pdfPage.render({ canvasContext: rendered.context, viewport }).promise;
                    await writeFile(path.join(proofDir, `report-pdf-page-${number}.png`), rendered.canvas.toBuffer("image/png"));
                    doc.canvasFactory.destroy(rendered);
                }
            } finally { await loading.destroy(); }
        }
    } finally { await browser.close(); }
});

test("synthetic saved HTML/PDF preserves small volumes and centers across print scenes on the same maximum", { timeout: 60000 }, async () => {
    const groups = [9, 28, 9, 121, 50].map((total, index) => ({
        label: `Synthetic week ${index + 1}`, total, success: total - (index === 2 ? 3 : 0),
        failure: index === 2 ? 3 : 0, unknown: 0, partial: 0, other: 0, transport: 0,
    }));
    const chart = createDimensionalReportChart()({ layer: "tool-call", unit: "synthetic actions", visibleGroups: groups });
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
        *{box-sizing:border-box}body{margin:24px;font-family:Arial;color:#18344d}h1{font-size:20px}
        ${dimensionalReportStyles}
        @page{size:A4;margin:16mm}
        </style></head><body><h1>SYNTHETIC ONLY - small column geometry</h1>${chart}<table><caption>Exact synthetic counts</caption>${groups.map(group => `<tr><td>${group.label}</td><td>${group.total}</td><td>${group.success}</td><td>${group.failure}</td></tr>`).join("")}</table></body></html>`;
    const proofDir = process.env.WORKIQ_SMALL_COLUMN_PROOFS;
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({ javaScriptEnabled: false });
        await page.route("**/*", route => { throw new Error(`Unexpected synthetic report network request: ${route.request().url()}`); });
        await page.setContent(html);
        for (const media of ["screen", "print"]) for (const width of [375, 820, 1200]) {
            await page.setViewportSize({ width, height: 1100 });
            await page.emulateMedia({ media });
            const rows = await page.locator(".dimensional-report-category").evaluateAll(nodes => nodes.map(node => {
                const center = element => { const b = element.getBoundingClientRect(); return b.x + b.width / 2; };
                const svg = node.querySelector("svg");
                const faces = [...svg.querySelectorAll(".dimensional-front,.dimensional-side,.dimensional-cap")].map(face => face.getBoundingClientRect());
                return {
                    total: Number(svg.dataset.total), maximum: Number(svg.dataset.maximum),
                    height: [...svg.querySelectorAll(".dimensional-front")].reduce((sum, face) => sum + face.height.baseVal.value * face.getScreenCTM().d, 0),
                    center: (Math.min(...faces.map(face => face.x)) + Math.max(...faces.map(face => face.right))) / 2,
                    value: center(node.querySelector("strong")), label: center(node.querySelector(".dimensional-report-label")),
                    cap: svg.querySelectorAll(".dimensional-cap").length,
                    side: svg.querySelectorAll(".dimensional-side").length,
                };
            }));
            assert.deepEqual(rows.map(row => row.total), [9, 28, 9, 121, 50]);
            for (const row of rows) {
                assert.equal(row.maximum, 121);
                assert.ok(Math.abs(row.height - Math.max(36, Math.sqrt(row.total / 121) * 280)) < .03);
                assert.ok(Math.abs(row.center - row.value) < 1 && Math.abs(row.center - row.label) < 1);
                assert.equal(row.cap, 1);
                assert.ok(row.side >= 1);
            }
            if (proofDir && width === 820) {
                await mkdir(proofDir, { recursive: true });
                await page.screenshot({ path: path.join(proofDir, `small-report-${media}.png`), fullPage: true });
            }
        }
        const bytes = await renderPdf(html);
        const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
        const pdf = await loading.promise;
        try {
            const texts = [];
            for (let number = 1; number <= pdf.numPages; number++) {
                const pdfPage = await pdf.getPage(number);
                const content = await pdfPage.getTextContent();
                texts.push(content.items.map(item => item.str).join(" "));
                for (const item of content.items.filter(item => item.str?.trim())) {
                    assert.ok(item.transform[4] >= 0 && item.transform[4] + item.width <= pdfPage.view[2] + 1, `${item.str}: printed text stays inside the page horizontally`);
                    assert.ok(item.transform[5] >= 0 && item.transform[5] + item.height <= pdfPage.view[3] + 1, `${item.str}: printed text stays inside the page vertically`);
                }
                if (proofDir) {
                    const viewport = pdfPage.getViewport({ scale: 1.5 });
                    const rendered = pdf.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
                    await pdfPage.render({ canvasContext: rendered.context, viewport }).promise;
                    await writeFile(path.join(proofDir, `small-report-pdf-page-${number}.png`), rendered.canvas.toBuffer("image/png"));
                    pdf.canvasFactory.destroy(rendered);
                }
            }
            for (const group of groups) assert.ok(texts.join(" ").includes(group.label));
            for (const value of ["9", "28", "121", "50"]) assert.match(texts.join(" "), new RegExp(`\\b${value}\\b`));
            if (proofDir) {
                await writeFile(path.join(proofDir, "small-report.html"), html);
                await writeFile(path.join(proofDir, "small-report.pdf"), bytes);
                await writeFile(path.join(proofDir, "small-report-pdf-text.json"), JSON.stringify({ pages: pdf.numPages, texts }, null, 2));
            }
        } finally { await loading.destroy(); }
    } finally { await browser.close(); }
});

test("script-free report label lanes reserve enlarged spacing and share one level datum across chunks", { timeout: 30000 }, async () => {
    const labels = [
        "workiq-retrieve", "workiq-search_paths", "workiq-ask", "/chats/{id}/messages",
        "/sites/{site-id}/lists/{list-id}/items/{item-id}/fields", `/${"longunbrokenpath".repeat(5)}`, "/me/events",
    ];
    const groups = [75, 34, 28, 12, 11, 7, 5].map((total, index) => ({
        label: labels[index], total, success: total, failure: 0, unknown: 0, partial: 0, other: 0, transport: 0,
    }));
    const chart = createDimensionalReportChart()({ layer: "tool-call", unit: "synthetic actions", visibleGroups: groups });
    const html = `<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:16px;font-family:Arial}${dimensionalReportStyles}</style></head><body>${chart}</body></html>`;
    const browser = await chromium.launch(), measurements = [];
    try {
        const page = await browser.newPage({ javaScriptEnabled: false });
        for (const scale of [1, 2]) for (const width of [375, 1200]) {
            await page.setViewportSize({ width, height: 1100 });
            await page.setContent(html);
            await page.locator("html").evaluate((node, scale) => { node.style.fontSize = `${scale * 100}%`; }, scale);
            const scenes = await page.locator(".dimensional-report-scroll").evaluateAll(nodes => nodes.map(scroll => {
                const box = scroll.getBoundingClientRect(), grid = scroll.querySelector(".dimensional-report-grid").getBoundingClientRect();
                const labels = [...scroll.querySelectorAll(".dimensional-report-label")].map(label => {
                    const range = document.createRange(); range.selectNodeContents(label);
                    return { text: label.textContent, bottom: Math.max(...[...range.getClientRects()].map(rect => rect.bottom)) };
                });
                const bases = [...scroll.querySelectorAll(".dimensional-front")].map(front => {
                    const point = new DOMPoint(0, front.y.baseVal.value + front.height.baseVal.value).matrixTransform(front.getScreenCTM());
                    return point.y - grid.y;
                });
                return { labels, bases, gap: box.y + scroll.clientTop + scroll.clientHeight - Math.max(...labels.map(label => label.bottom)) };
            }));
            assert.deepEqual(scenes.flatMap(scene => scene.labels.map(label => label.text)), labels);
            for (const scene of scenes) {
                assert.ok(scene.gap >= scale * 16 - .1, `Intrinsic report label bottom has ${scene.gap}px, expected ${scale * 16}`);
                assert.ok(scene.bases.every(base => Math.abs(base - scenes[0].bases[0]) < .03));
            }
            measurements.push({ scale, width, scenes });
        }
        const proofDir = process.env.WORKIQ_LEVEL_PROOFS;
        if (proofDir) {
            await mkdir(proofDir, { recursive: true });
            await writeFile(path.join(proofDir, "report-label-spacing.json"), JSON.stringify(measurements, null, 2));
            await writeFile(path.join(proofDir, "level-report.html"), html);
        }
    } finally { await browser.close(); }
});
