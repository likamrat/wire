import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SearchError, SEARCH_MODEL, SEARCH_RUNTIME, SEARCH_MODEL_ID, readVerifiedFile, readSearchModel } from "./search-model-assets.mjs";
import { chunkSearchText } from "./search-chunks.mjs";

let networkAttempt = false, session, tokenizer, ort, busy = false, ready = false;
const deny = () => { networkAttempt = true; throw new SearchError("network-denied"); };
globalThis.fetch = globalThis.WebSocket = globalThis.EventSource = deny;
http.request = http.get = https.request = https.get = net.connect = net.createConnection = deny;
net.Socket.prototype.connect = dns.lookup = dns.resolve = dgram.createSocket = deny;
syncBuiltinESMExports();
console.log = console.warn = console.error = console.info = console.debug = () => {};
process.once("disconnect", () => process.exit(1));
if (!process.connected) process.exit(1);

async function initialize(directory) {
    const files = await readSearchModel(directory);
    let runtimeRoot, tokenizerRoot;
    try {
        runtimeRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("onnxruntime-web"))));
        tokenizerRoot = path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@huggingface/tokenizers"))));
    } catch { throw new SearchError("runtime-missing"); }
    const runtimeFiles = {};
    for (const spec of SEARCH_RUNTIME.files) runtimeFiles[spec.name] = await readVerifiedFile(runtimeRoot, spec, "runtime");
    await readVerifiedFile(tokenizerRoot, SEARCH_RUNTIME.tokenizer, "runtime");
    for (const [root, version] of [[runtimeRoot, SEARCH_RUNTIME.version], [tokenizerRoot, SEARCH_RUNTIME.tokenizerVersion]]) {
        if (JSON.parse(await readFile(path.join(root, "package.json"))).version !== version) throw new SearchError("runtime-corrupt");
    }
    ort = await import("onnxruntime-web");
    const { Tokenizer } = await import("@huggingface/tokenizers");
    if (ort.env.versions.web !== SEARCH_RUNTIME.version || ort.env.versions.common !== SEARCH_RUNTIME.version) {
        throw new SearchError("runtime-corrupt");
    }
    ort.env.logLevel = "fatal";
    ort.env.debug = ort.env.trace = false;
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = { mjs: pathToFileURL(path.join(runtimeRoot, "dist", "ort-wasm-simd-threaded.mjs")) };
    ort.env.wasm.wasmBinary = runtimeFiles["dist/ort-wasm-simd-threaded.wasm"];
    tokenizer = new Tokenizer(JSON.parse(files["tokenizer.json"]), JSON.parse(files["tokenizer_config.json"]));
    const config = JSON.parse(files["config.json"]);
    if (config.hidden_size !== 384 || config.num_hidden_layers !== 6 || config.model_type !== "bert") throw new SearchError("model-incompatible");
    session = await ort.InferenceSession.create(files["onnx/model_quantized.onnx"], {
        executionProviders: ["wasm"], enableProfiling: false, logSeverityLevel: 4,
    });
    if (JSON.stringify([...session.inputNames].sort()) !== JSON.stringify(["attention_mask", "input_ids", "token_type_ids"])
        || JSON.stringify(session.outputNames) !== JSON.stringify(["last_hidden_state"])) throw new SearchError("model-incompatible");
    await encode(tokenizer.encode("An example sentence.", { return_token_type_ids: true }));
}
async function encode(encoded) {
    const length = encoded.ids.length;
    if (length < 2 || length > SEARCH_MODEL.maxTokens || encoded.attention_mask.length !== length
        || encoded.token_type_ids?.length !== length) throw new SearchError("model-input-shape");
    const tensor = values => new ort.Tensor("int64", BigInt64Array.from(values, BigInt), [1, length]);
    const feed = { input_ids: tensor(encoded.ids), attention_mask: tensor(encoded.attention_mask), token_type_ids: tensor(encoded.token_type_ids) };
    let output;
    try {
        output = await session.run(feed);
        const hidden = output.last_hidden_state;
        if (hidden.type !== "float32" || JSON.stringify(hidden.dims) !== JSON.stringify([1, length, 384])
            || hidden.data.length !== length * 384) throw new SearchError("model-output-shape");
        const vector = new Float32Array(384);
        let count = 0;
        for (let token = 0; token < length; token++) if (encoded.attention_mask[token]) {
            count++;
            for (let dim = 0; dim < 384; dim++) vector[dim] += hidden.data[token * 384 + dim];
        }
        let norm = 0;
        for (let dim = 0; dim < 384; dim++) { vector[dim] /= count; norm += vector[dim] ** 2; }
        norm = Math.sqrt(norm);
        if (!Number.isFinite(norm) || norm <= 0) throw new SearchError("model-output-invalid");
        for (let dim = 0; dim < 384; dim++) vector[dim] /= norm;
        if (networkAttempt) throw new SearchError("network-denied");
        return vector;
    } finally {
        for (const value of Object.values(feed)) value.dispose();
        for (const value of Object.values(output ?? {})) value.dispose();
    }
}
function send(message) { if (process.connected) process.send(message); }
const memory = () => ({ rss: process.memoryUsage().rss, peakRss: process.resourceUsage().maxRSS * 1024 });
process.on("message", async message => {
    if (busy) { send({ ok: false, code: "model-busy" }); return; }
    busy = true;
    const started = performance.now();
    try {
        if (!ready) {
            if (message?.kind !== "initialize" || typeof message.directory !== "string") throw new SearchError("model-protocol");
            await initialize(message.directory);
            ready = true;
            send({ ok: true, kind: "ready", modelId: SEARCH_MODEL_ID, ms: performance.now() - started, ...memory() });
        } else {
            if (message?.kind !== "embed" || typeof message.text !== "string") throw new SearchError("model-protocol");
            send({ kind: "computing" });
            const chunks = [];
            for (const chunk of chunkSearchText(message.text, tokenizer, SEARCH_MODEL.maxTokens)) {
                chunks.push({ start: chunk.start, end: chunk.end, tokens: chunk.encoded.ids.length, vector: await encode(chunk.encoded) });
                if (chunks.length === 1) send({ kind: "computed" });
            }
            send({ ok: true, kind: "embedded", chunks, modelId: SEARCH_MODEL_ID, ms: performance.now() - started, ...memory() });
        }
    } catch (error) {
        send({ ok: false, code: networkAttempt ? "network-denied" : error instanceof SearchError ? error.code : "model-inference-failed" });
        process.disconnect();
    } finally { busy = false; }
});
