import { BoardError } from "./store.mjs";
import { PRODUCT_NAME } from "./branding.mjs";
import { uiFontStack } from "./typeface.mjs";
import { tokens } from "../web/tokens.mjs";
import { escapeReportText } from "./report-presentation.mjs";

export async function renderPdf(html) {
    let browser;
    try {
        const { chromium } = await import("playwright");
        browser = await chromium.launch({ headless: true, timeout: 30000 });
    } catch {
        throw new BoardError("PDF renderer unavailable. Install the declared runtime dependencies and run npx playwright install chromium locally, or deselect PDF and prepare a new review. No files were exported.", 503);
    }
    try {
        const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
        const attempted = [];
        await context.route("**/*", (route) => { attempted.push(true); return route.abort(); });
        const page = await context.newPage();
        await page.emulateMedia({ media: "print" });
        // Margin templates are separate white documents. Resolve their tokenless/dark fallback from the shared light palette.
        await page.setContent(`<!doctype html><html data-evidence-theme="light"><head><style>${tokens}</style></head><body style="color:var(--muted)"></body></html>`);
        const fallback = await page.evaluate(() => getComputedStyle(document.body).color);
        await page.setContent(html, { waitUntil: "load", timeout: 30000 });
        await page.locator("details").evaluateAll((nodes) => nodes.forEach((node) => { node.open = true; }));
        const muted = await page.evaluate(fallback => {
            const value = getComputedStyle(document.documentElement).getPropertyValue("--muted").trim();
            if (!value || !CSS.supports("color", value)) return fallback;
            const probe = document.createElement("span");
            probe.style.setProperty("color", value, "important");
            document.body.append(probe);
            const color = getComputedStyle(probe).color;
            probe.remove();
            const channels = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color);
            if (!channels) return fallback;
            const linear = channels.slice(1).map(value => Number(value) / 255).map(value =>
                value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
            const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
            return 1.05 / (luminance + 0.05) >= 4.5 ? color : fallback;
        }, fallback);
        const marginStyle = escapeReportText(`font-family:${uiFontStack};font-size:8px;width:100%;text-align:center;background:white;color:${muted}`);
        const bytes = await page.pdf({
            format: "A4", printBackground: true, preferCSSPageSize: true, timeout: 30000, tagged: true,
            displayHeaderFooter: true,
            headerTemplate: `<div style="${marginStyle}">${PRODUCT_NAME} - local report</div>`,
            footerTemplate: `<div style="${marginStyle}">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`,
        });
        if (attempted.length || bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("Invalid local PDF rendering.");
        return bytes;
    } catch (error) {
        if (error instanceof BoardError) throw error;
        throw new BoardError("Local PDF rendering failed. No files were exported. Deselect PDF or resolve the local renderer, then prepare a new review.", 500);
    } finally { await browser.close(); }
}
