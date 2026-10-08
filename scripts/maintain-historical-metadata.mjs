import { parseArgs } from "node:util";
import { BoardError } from "../lib/store.mjs";
import { runHistoricalMaintenance } from "../lib/historical-maintenance.mjs";

try {
    const { values } = parseArgs({ options: Object.fromEntries([
        "mode", "data-dir", "plan", "plan-sha256", "journal", "review-sha256", "source-manifest", "source-identity",
    ].map(name => [name, { type: "string" }])) });
    const result = await runHistoricalMaintenance({
        mode: values.mode, dataDir: values["data-dir"], planFile: values.plan, planSha256: values["plan-sha256"],
        journalFile: values.journal, reviewSha256: values["review-sha256"],
        sourceManifestFile: values["source-manifest"], sourceIdentity: values["source-identity"],
    });
    console.log(JSON.stringify(result));
} catch (error) {
    console.error(error instanceof BoardError ? error.message
        : "Maintenance failed. Keep runtime stopped and inspect the private pre/postimage journal; do not blindly retry.");
    process.exitCode = 1;
}
