import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs/promises";
import { syncBuiltinESMExports, registerHooks } from "node:module";

export function forbidSearchAi(t, { pdf = false, onPdf = () => {} } = {}) {
    let attempts = 0, origin;
    const originalFork = childProcess.fork, readFile = fs.readFile, fetch = globalThis.fetch;
    const fork = t.mock.method(childProcess, "fork", (...args) => {
        if (pdf && String(args[0]).endsWith("search-corpus-pdf-worker.mjs")) {
            const child = originalFork(...args);
            onPdf(child);
            return child;
        }
        attempts++;
        throw new Error("Text Search must not attempt inference or a model helper.");
    });
    const reads = t.mock.method(fs, "readFile", (...args) => {
        if (/search-models|search-linguistics|tokenizer\.json|\.onnx(?:$|[\\/])|onnxruntime|@huggingface/i.test(String(args[0]))) {
            attempts++;
            throw new Error("Text Search must not read inference assets.");
        }
        return readFile(...args);
    });
    const imports = registerHooks({ resolve(specifier, context, next) {
        if (/search-model|search-linguistics|search-ranking|search-intent|onnxruntime|@huggingface|copilot-sdk/.test(specifier)) {
            attempts++;
            throw new Error("Text Search must not load an inference dependency.");
        }
        return next(specifier, context);
    } });
    syncBuiltinESMExports();
    t.after(() => { imports.deregister(); fork.mock.restore(); reads.mock.restore(); syncBuiltinESMExports(); });
    t.mock.method(globalThis, "fetch", (input, options) => {
        if (!origin || new URL(typeof input === "string" ? input : input.url).origin !== origin) {
            attempts++;
            throw new Error("Text Search must not acquire assets or contact a provider.");
        }
        return fetch(input, options);
    });
    return {
        connect(runtime) { origin = new URL(runtime.url).origin; },
        verify() { assert.equal(attempts, 0, "Text Search must not attempt model initialization or a fallback."); },
    };
}
