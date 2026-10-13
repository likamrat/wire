import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import { readSearchLinguistics, SEARCH_INTENT_POLICY_ID } from "./search-linguistics-assets.mjs";
import { createWordNet } from "./search-wordnet.mjs";
import { createSearchIntent, validSearchIntent } from "./search-intent.mjs";
import { SearchError } from "./search-model-assets.mjs";

const deny = () => { throw new SearchError("linguistics-network-denied"); };
globalThis.fetch = globalThis.WebSocket = globalThis.EventSource = deny;
http.request = http.get = https.request = https.get = net.connect = net.createConnection = deny;
net.Socket.prototype.connect = dns.lookup = dns.resolve = dgram.createSocket = deny;
syncBuiltinESMExports();
console.log = console.warn = console.error = console.info = console.debug = () => {};
if (!process.connected) process.exit(1);
process.once("disconnect", () => process.exit(1));
let engine, busy = false;
const send = message => {
    if (process.connected) process.send({ policyId: SEARCH_INTENT_POLICY_ID, ...message });
};
const validReference = item => item && typeof item.id === "string" && item.id.length > 0
    && typeof item.revision === "string" && /^[a-f0-9]{64}$/.test(item.revision);
process.on("message", async message => {
    if (busy) { send({ ok: false, code: "linguistics-busy" }); return; }
    busy = true;
    const start = performance.now();
    try {
        let payload;
        if (!engine) {
            if (message?.kind !== "initialize") throw new SearchError("linguistics-protocol");
            const files = await readSearchLinguistics(message.directory);
            // Import the same verified bytes, not a second read of a mutable module path.
            const { default: nlp } = await import(`data:text/javascript;base64,${files["compromise/builds/three/compromise-three.mjs"].toString("base64")}`);
            engine = createSearchIntent(nlp, createWordNet(files));
            payload = { kind: "ready" };
        } else if (message?.kind === "prepare") {
            if (!Array.isArray(message.items) || message.items.some(item => !validReference(item) || typeof item.text !== "string")) {
                throw new SearchError("linguistics-protocol");
            }
            const items = [];
            send({ kind: "computing" });
            for (const [index, item] of message.items.entries()) {
                await setImmediate();
                const intent = engine.parse(item.text, "record");
                if (!validSearchIntent(intent, item.text)) throw new SearchError("linguistics-protocol");
                items.push({ id: item.id, revision: item.revision, intent });
                if (index === 0) send({ kind: "computed" });
            }
            payload = { kind: "prepared", items };
        } else if (message?.kind === "match") {
            if (typeof message.query !== "string" || !Array.isArray(message.items)
                || message.items.some(item => !validReference(item) || typeof item.text !== "string" || !validSearchIntent(item.intent, item.text))) {
                throw new SearchError("linguistics-protocol");
            }
            send({ kind: "computing" });
            const query = engine.parse(message.query, "query");
            if (!validSearchIntent(query, message.query)) throw new SearchError("linguistics-protocol");
            send({ kind: "computed" });
            const hits = [];
            for (const item of message.items) {
                await setImmediate();
                if (engine.matches(query, item.intent)) hits.push({ id: item.id, revision: item.revision });
            }
            payload = { kind: "matched", hits };
        } else throw new SearchError("linguistics-protocol");
        send({ ok: true, ...payload, ms: performance.now() - start,
            rss: process.memoryUsage().rss, peakRss: process.resourceUsage().maxRSS * 1024 });
    } catch (error) {
        send({ ok: false, code: error instanceof SearchError ? error.code : "linguistics-failed" });
        process.disconnect();
    } finally { busy = false; }
});
