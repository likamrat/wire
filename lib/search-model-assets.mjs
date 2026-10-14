import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class SearchError extends Error {
    constructor(code) { super(`Local search unavailable (${code}).`); this.code = code; }
}
export const searchHash = value => createHash("sha256").update(value).digest("hex");
const file = (name, bytes, sha256) => Object.freeze({ name, bytes, sha256 });
export const SEARCH_MODEL = Object.freeze({
    name: "Xenova/all-MiniLM-L6-v2",
    revision: "751bff37182d3f1213fa05d7196b954e230abad9",
    license: "Apache-2.0",
    dimensions: 384,
    maxTokens: 256,
    pooling: "attention-mask-mean-l2-v1",
    files: Object.freeze([
        file("config.json", 650, "7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7"),
        file("tokenizer.json", 711661, "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0"),
        file("tokenizer_config.json", 366, "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3"),
        file("onnx/model_quantized.onnx", 22972370, "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1"),
        file("README.md", 1767, "63ea99bf681a2e9eda4f6a537d5ed8fda95d1677111656da37e9cfd080c3af02"),
    ]),
});
export const SEARCH_RUNTIME = Object.freeze({
    version: "1.22.0", tokenizerVersion: "0.2.0", provider: "wasm", threads: 2,
    guard: "fixed-pthread-entry-v1",
    files: Object.freeze([
        file("dist/ort.node.min.mjs", 25489, "a78ac38b4cc73930f7995f36bbe3cda69e591c1aec5c79789b2bb2afcc6e6724"),
        file("dist/ort-wasm-simd-threaded.mjs", 20856, "30dd851d9c00622940500f71ddd2ff8820c5cb65270816080175b958705385a8"),
        file("dist/ort-wasm-simd-threaded.wasm", 11210254, "71aef04959c5c1b6de461b6538e2058e306610034a85aad2742d0c7fd4533fe4"),
    ]),
    tokenizer: file("dist/tokenizers.mjs", 98937, "1c4a848f86156201c033d6cd08c4cf81ae1088552acec3367f31ef086edf5af0"),
});
export const SEARCH_MODEL_ID = searchHash(JSON.stringify([SEARCH_MODEL, SEARCH_RUNTIME]));
export const defaultSearchModelDirectory = fileURLToPath(new URL(
    `../assets/search-models/all-MiniLM-L6-v2/${SEARCH_MODEL.revision}/`, import.meta.url));

export async function readVerifiedFile(directory, spec, kind = "model") {
    const target = path.join(directory, ...spec.name.split("/"));
    try {
        const info = await lstat(target);
        if (!info.isFile() || info.size !== spec.bytes) throw new SearchError(`${kind}-corrupt`);
        const bytes = await readFile(target);
        if (bytes.length !== spec.bytes || searchHash(bytes) !== spec.sha256) throw new SearchError(`${kind}-corrupt`);
        return bytes;
    } catch (error) {
        if (error instanceof SearchError) throw error;
        throw new SearchError(["ENOENT", "ENOTDIR"].includes(error.code) ? `${kind}-missing` : `${kind}-unreadable`);
    }
}
export async function readSearchModel(directory = defaultSearchModelDirectory) {
    const files = {};
    for (const spec of SEARCH_MODEL.files) files[spec.name] = await readVerifiedFile(directory, spec);
    return files;
}
