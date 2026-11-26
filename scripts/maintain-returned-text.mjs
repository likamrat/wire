import { parseArgs } from "node:util";
import { BoardError } from "../lib/store.mjs";
import { runReturnedTextRepair } from "../lib/returned-text-repair.mjs";

try {
    const { values } = parseArgs({ options: Object.fromEntries([
        "mode", "data-dir", "plan", "plan-sha256", "journal", "review-sha256", "source-manifest", "source-identity",
    ].map(name => [name, { type: "string" }])) });
    console.log(JSON.stringify(await runReturnedTextRepair({
        mode: values.mode, dataDir: values["data-dir"], planFile: values.plan, planSha256: values["plan-sha256"],
        journalFile: values.journal, reviewSha256: values["review-sha256"],
        sourceManifestFile: values["source-manifest"], sourceIdentity: values["source-identity"],
    })));
} catch (error) {
    console.error(error.code === "profile-contention" ? "Another process owns this WIRE session. No byte-size correction was dispatched."
        : error instanceof BoardError ? error.message
        : "Byte-size correction stopped. Inspect the same sealed journal before restarting; do not dispatch a replacement.");
    process.exitCode = 1;
}
