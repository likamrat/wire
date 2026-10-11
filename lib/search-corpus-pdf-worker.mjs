import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";

let externalAttempt = false, parserDiagnostic = false, loading;
const diagnostic = () => { parserDiagnostic = true; };
console.log = console.warn = console.error = console.info = diagnostic;
const deny = () => { externalAttempt = true; throw new Error("PDF external access disabled."); };
globalThis.fetch = deny;
globalThis.WebSocket = deny;
http.request = http.get = https.request = https.get = net.connect = net.createConnection = deny;
net.Socket.prototype.connect = deny;
syncBuiltinESMExports();

class NoBinaryData {
    async fetch() { return deny(); }
}
class NoRendering {
    create() { return deny(); }
    reset() { return deny(); }
    destroy() {}
}
process.once("disconnect", () => { process.exit(1); });
if (!process.connected) process.exit(1);
process.once("message", async ({ bytes, maxBytes } = {}) => {
    let response;
    try {
        let evaluationBlocked = false;
        try { Function("return 1")(); }
        catch (error) { evaluationBlocked = error instanceof EvalError; }
        if (!evaluationBlocked) throw Object.assign(new Error(), { code: "pdf-evaluation-policy" });
        if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(maxBytes) || bytes.byteLength > maxBytes) {
            throw Object.assign(new Error(), { code: "pdf-byte-limit" });
        }
        let getDocument;
        try { ({ getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs")); }
        catch { throw Object.assign(new Error(), { code: "pdf-parser-unavailable" }); }
        parserDiagnostic = false;
        loading = getDocument({
            data: new Uint8Array(bytes), verbosity: 1, stopAtErrors: true,
            useWorkerFetch: false, useSystemFonts: false, useWasm: false, disableFontFace: true,
            enableXfa: false, enableHWA: false, enableWebGPU: false,
            isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
            disableRange: true, disableStream: true, disableAutoFetch: true,
            BinaryDataFactory: NoBinaryData, CanvasFactory: NoRendering, FilterFactory: NoRendering,
        });
        const document = await loading.promise, pages = [];
        let size = 0, pagesWithText = 0;
        for (let number = 1; number <= document.numPages; number++) {
            const page = await document.getPage(number);
            try {
                const reader = page.streamTextContent().getReader(), parts = [];
                try {
                    while (true) {
                        const chunk = await reader.read();
                        if (chunk.done) break;
                        for (const item of chunk.value.items) if (typeof item.str === "string") {
                            const part = item.str + (item.hasEOL ? "\n" : "");
                            size += Buffer.byteLength(part);
                            if (size > maxBytes) throw Object.assign(new Error(), { code: "pdf-byte-limit" });
                            parts.push(part);
                        }
                    }
                } finally { await reader.cancel(); reader.releaseLock(); }
                const text = parts.join("");
                if (text.trim()) pagesWithText++;
                size++;
                if (size > maxBytes) throw Object.assign(new Error(), { code: "pdf-byte-limit" });
                pages.push(text);
            } finally { page.cleanup(); }
        }
        if (externalAttempt) throw Object.assign(new Error(), { code: "pdf-external-resource" });
        if (!pagesWithText) throw Object.assign(new Error(), { code: "pdf-no-text" });
        response = { ok: true, text: pages.join("\n"), pages: document.numPages, pagesWithText };
    } catch (error) {
        response = { ok: false, code: externalAttempt ? "pdf-external-resource"
            : error.name === "PasswordException" ? "pdf-encrypted" : error.code ?? "pdf-invalid" };
    } finally {
        try { await loading?.destroy(); }
        catch { response = { ok: false, code: "pdf-invalid" }; }
    }
    // PDF.js can repair cross-reference data even with stopAtErrors. Never publish a diagnostic-bearing repair.
    if (parserDiagnostic && !["pdf-parser-unavailable", "pdf-byte-limit", "pdf-external-resource", "pdf-encrypted", "pdf-evaluation-policy"].includes(response?.code)) {
        response = { ok: false, code: "pdf-invalid" };
    }
    process.removeAllListeners("disconnect");
    if (process.connected) process.send(response, () => process.disconnect());
});
