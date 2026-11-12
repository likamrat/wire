import { parseArgs } from "node:util";
import { BoardError } from "../lib/store.mjs";
import { runPromptOriginRepair } from "../lib/prompt-origin-repair.mjs";

try {
    const { values } = parseArgs({ options: Object.fromEntries([
        "mode", "data-dir", "plan", "plan-sha256", "journal", "review-sha256", "source-manifest", "source-identity",
    ].map(name => [name, { type: "string" }])) });
    console.log(JSON.stringify(await runPromptOriginRepair({
        mode: values.mode, dataDir: values["data-dir"], planFile: values.plan, planSha256: values["plan-sha256"],
        journalFile: values.journal, reviewSha256: values["review-sha256"],
        sourceManifestFile: values["source-manifest"], sourceIdentity: values["source-identity"],
    })));
} catch (error) {
    console.error(error instanceof BoardError ? error.message
        : "Prompt-origin restoration failed. Keep the runtime stopped and inspect the same sealed journal; do not start a replacement operation.");
    process.exitCode = 1;
}
