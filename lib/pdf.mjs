import { BoardError } from "./store.mjs";
import { PRODUCT_NAME } from "./branding.mjs";
import { uiFontStack } from "./typeface.mjs";
import { tokens } from "../web/tokens.mjs";
import { escapeReportText } from "./report-presentation.mjs";
import { findPdfBrowser, openBrowserPage } from "./pdf-browser.mjs";

// Margin templates are separate white documents. Resolve their tokenless/dark fallback from the shared light palette.
const paletteDocument = () => `<!doctype html><html data-evidence-theme="light"><head><style>${tokens}</style></head><body style="color:var(--muted)"></body></html>`;
const readFallback = "getComputedStyle(document.body).color";
const openDetails = "document.querySelectorAll('details').forEach(node => { node.open = true; })";
function resolveMuted(fallback) {
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
}
function margins(muted) {
    const style = escapeReportText(`font-family:${uiFontStack};font-size:8px;width:100%;text-align:center;background:white;color:${muted}`);
    return {
        headerTemplate: `<div style="${style}">${PRODUCT_NAME} - local report</div>`,
        footerTemplate: `<div style="${style}">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`,
    };
}
function verified(bytes, attempted) {
    if (attempted.length || bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("Invalid local PDF rendering.");
    return bytes;
}
const unavailable = () => new BoardError("PDF renderer unavailable. Install Microsoft Edge or Google Chrome, or deselect PDF and prepare a new review. No files were exported.", 503);
const failed = () => new BoardError("Local PDF rendering failed. No files were exported. Deselect PDF or resolve the local renderer, then prepare a new review.", 500);

async function renderWithInstalledBrowser(executable, html) {
    let browser;
    try { browser = await openBrowserPage(executable); }
    catch { throw unavailable(); }
    try {
        const { page, sessionId, onEvent } = browser;
        const attempted = [];
        onEvent(message => {
            if (message.method !== "Fetch.requestPaused" || message.sessionId !== sessionId) return;
            attempted.push(true);
            void page("Fetch.failRequest", { requestId: message.params.requestId, errorReason: "BlockedByClient" }).catch(() => {});
        });
        await page("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
        await page("Emulation.setScriptExecutionDisabled", { value: true });
        await page("Emulation.setEmulatedMedia", { media: "print" });
        const { frameTree } = await page("Page.getFrameTree");
        const evaluate = async expression => {
            const { result, exceptionDetails } = await page("Runtime.evaluate", { expression, returnByValue: true });
            if (exceptionDetails) throw new Error("Local PDF page evaluation failed.");
            return result.value;
        };
        const setContent = async content => {
            await page("Page.setDocumentContent", { frameId: frameTree.frame.id, html: content });
            const deadline = Date.now() + 30000;
            while (await evaluate("document.readyState") !== "complete") {
                if (Date.now() > deadline) throw new Error("Local PDF page did not load.");
                await new Promise(resolve => setTimeout(resolve, 25));
            }
        };
        await setContent(paletteDocument());
        const fallback = await evaluate(readFallback);
        await setContent(html);
        await evaluate(openDetails);
        const muted = await evaluate(`(${resolveMuted})(${JSON.stringify(fallback)})`);
        const { data } = await page("Page.printToPDF", {
            paperWidth: 8.27, paperHeight: 11.7, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0,
            printBackground: true, preferCSSPageSize: true, generateTaggedPDF: true, displayHeaderFooter: true, ...margins(muted),
        });
        return verified(Buffer.from(data, "base64"), attempted);
    } catch (error) {
        if (error instanceof BoardError) throw error;
        throw failed();
    } finally { await browser.close(); }
}

async function renderWithPlaywright(html) {
    let browser;
    try {
        const { chromium } = await import("playwright");
        browser = await chromium.launch({ headless: true, chromiumSandbox: true, timeout: 30000 });
    } catch { throw unavailable(); }
    try {
        const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
        const attempted = [];
        await context.route("**/*", (route) => { attempted.push(true); return route.abort(); });
        const page = await context.newPage();
        await page.emulateMedia({ media: "print" });
        await page.setContent(paletteDocument());
        const fallback = await page.evaluate(readFallback);
        await page.setContent(html, { waitUntil: "load", timeout: 30000 });
        await page.evaluate(openDetails);
        const muted = await page.evaluate(resolveMuted, fallback);
        const bytes = await page.pdf({
            format: "A4", printBackground: true, preferCSSPageSize: true, timeout: 30000, tagged: true,
            displayHeaderFooter: true, ...margins(muted),
        });
        return verified(bytes, attempted);
    } catch (error) {
        if (error instanceof BoardError) throw error;
        throw failed();
    } finally { await browser.close(); }
}

// Prefer the installed Edge or Chrome; Playwright's Chromium remains a contributor fallback.
export async function renderPdf(html, { browser } = {}) {
    const executable = browser === undefined ? await findPdfBrowser() : browser;
    return executable ? renderWithInstalledBrowser(executable, html) : renderWithPlaywright(html);
}
