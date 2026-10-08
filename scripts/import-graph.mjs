import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createServer } from "node:net";
import { applyGraphImport } from "../lib/collection.mjs";
import { defaultDataDir } from "../lib/paths.mjs";
import { buildActivityAnalytics } from "../lib/activity-analytics.mjs";
import { mergeEvidenceWithState, resolveDataDir } from "../lib/store.mjs";
import { acquireCollectorLock } from "../lib/collector-io.mjs";

const { values } = parseArgs({ options: { file: { type: "string" }, "data-dir": { type: "string", default: defaultDataDir() } } });
if (!values.file) throw new Error("Pass --file with a previously captured private Graph history import. Stop the runtime before importing.");
const imported = JSON.parse(await readFile(values.file, "utf8"));
// Reserve the production writer endpoint before touching state, avoiding a
// check-then-start race with another runtime process.
const reservation = createServer((socket) => socket.destroy());
await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen({ port: 47831, host: "127.0.0.1", exclusive: true }, resolve);
});
let release;
try {
    release = await acquireCollectorLock(resolveDataDir({ dataDir: values["data-dir"] }));
    const state = await applyGraphImport({ dataDir: values["data-dir"] }, imported);
    const records = mergeEvidenceWithState(state);
    console.log(JSON.stringify({
        revision: state.revision,
        workIqCalls: buildActivityAnalytics(records).totals.count,
        recordedGraphRequestSites: buildActivityAnalytics(records, { layer: "direct-request" }).totals.count,
        outputVisibleStatuses: buildActivityAnalytics(records, { layer: "recorded-http" }).totals.count,
        codeReferences: buildActivityAnalytics(records, { layer: "code-reference" }).totals.count,
    }, null, 2));
} finally {
    await release?.();
    await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
}
