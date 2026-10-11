import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SAVED_REPORT_MAX_BYTES } from "./report-artifacts.mjs";

export class PdfCorpusError extends Error {
    constructor(code) { super(`Saved PDF text is unavailable (${code}).`); this.code = code; }
}

export function pdfParserEnvironment() {
    return Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"]
        .filter(key => typeof process.env[key] === "string").map(key => [key, process.env[key]]));
}

export function pdfDocumentText(bytes, { signal } = {}) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > SAVED_REPORT_MAX_BYTES) return Promise.reject(new PdfCorpusError("pdf-byte-limit"));
    if (signal?.aborted) return Promise.reject(new PdfCorpusError("pdf-cancelled"));
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = fork(fileURLToPath(new URL("./search-corpus-pdf-worker.mjs", import.meta.url)), [], {
                execPath: process.execPath, execArgv: ["--disallow-code-generation-from-strings"], serialization: "advanced",
                stdio: ["ignore", "ignore", "ignore", "ipc"], env: pdfParserEnvironment(),
            });
        } catch { reject(new PdfCorpusError("pdf-parser-unavailable")); return; }
        let result, failed;
        const cancel = () => { failed = "pdf-cancelled"; child.kill(); };
        signal?.addEventListener("abort", cancel, { once: true });
        child.once("error", () => { failed ??= "pdf-parser-unavailable"; child.kill(); });
        child.once("message", message => {
            if (message?.ok === true && typeof message.text === "string" && Buffer.byteLength(message.text) <= SAVED_REPORT_MAX_BYTES
                && Number.isSafeInteger(message.pages) && message.pages > 0
                && Number.isSafeInteger(message.pagesWithText) && message.pagesWithText > 0 && message.pagesWithText <= message.pages) {
                result = { content: message.text, pages: message.pages, pagesWithText: message.pagesWithText };
            } else {
                failed ??= ["pdf-parser-unavailable", "pdf-no-text", "pdf-byte-limit", "pdf-external-resource", "pdf-invalid", "pdf-encrypted", "pdf-evaluation-policy"]
                    .includes(message?.code) ? message.code : "pdf-invalid";
                child.kill();
            }
        });
        child.once("close", code => {
            signal?.removeEventListener("abort", cancel);
            if (failed || code !== 0 || !result) reject(new PdfCorpusError(failed ?? "pdf-parser-failed"));
            else resolve(result);
        });
        child.send({ bytes, maxBytes: SAVED_REPORT_MAX_BYTES }, error => {
            if (error) { failed ??= "pdf-parser-unavailable"; child.kill(); }
        });
        if (signal?.aborted) cancel();
    });
}
