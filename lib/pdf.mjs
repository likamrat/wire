import { BoardError } from "./store.mjs";
import { PRODUCT_NAME } from "./branding.mjs";

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
        await page.setContent(html, { waitUntil: "load", timeout: 30000 });
        await page.locator("details").evaluateAll((nodes) => nodes.forEach((node) => { node.open = true; }));
        await page.emulateMedia({ media: "print" });
        const bytes = await page.pdf({
            format: "A4", printBackground: true, preferCSSPageSize: true, timeout: 30000, tagged: true,
            displayHeaderFooter: true,
            headerTemplate: `<div style="font-size:8px;width:100%;text-align:center;color:#50647b">${PRODUCT_NAME} - local report</div>`,
            footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#50647b">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
        });
        if (attempted.length || bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("Invalid local PDF rendering.");
        return bytes;
    } catch (error) {
        if (error instanceof BoardError) throw error;
        throw new BoardError("Local PDF rendering failed. No files were exported. Deselect PDF or resolve the local renderer, then prepare a new review.", 500);
    } finally { await browser.close(); }
}
