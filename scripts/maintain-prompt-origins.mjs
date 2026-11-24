import { parseArgs } from "node:util";
import { open } from "node:fs/promises";
import path from "node:path";
import { BoardError } from "../lib/store.mjs";
import { runPromptOriginRepair, reviewPromptOriginClass } from "../lib/prompt-origin-repair.mjs";
import { safeDeletionFile } from "../lib/deletion-storage.mjs";

async function previousPage(file, batch) {
    if (!path.isAbsolute(file)) throw new BoardError("Specify the absolute path of the previous private review page.", 422);
    const handle = await open(await safeDeletionFile(path.dirname(file), path.basename(file)), "r");
    try {
        const bytes = Buffer.alloc(8193), info = await handle.stat();
        if (!info.isFile() || info.size > 8192) throw new BoardError("Invalid previous review page.", 422);
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead !== info.size) throw new BoardError("Previous review page changed.", 409);
        const value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8").replace(/^\uFEFF/, ""));
        if (value.status !== "continue" || !value.continuation || value.batch !== batch) throw new BoardError("Expected the previous page of this batch.", 422);
        return value.continuation;
    } finally { await handle.close(); }
}

try {
    const { values } = parseArgs({ options: { ...Object.fromEntries([
        "mode", "data-dir", "batch", "previous", "plan", "plan-sha256", "journal", "review-sha256", "source-manifest", "source-identity",
    ].map(name => [name, { type: "string" }])), "include-older": { type: "boolean" }, "include-archived": { type: "boolean" },
        "counts-only": { type: "boolean" }, "originating-only": { type: "boolean" } } });
    if (["list", "review"].includes(values.mode)) {
        const review = values.mode === "review";
        if (Object.keys(values).some(key => !["mode", "data-dir", "include-older", "include-archived", "originating-only", ...(review ? ["batch", "previous"] : ["counts-only"])].includes(key))
            || review && !values.batch) throw new BoardError("List retained candidates first, then review one named batch.", 422);
        console.log(JSON.stringify(await reviewPromptOriginClass({ dataDir: values["data-dir"], batch: values.batch,
            includeOlder: values["include-older"], includeArchived: values["include-archived"], countsOnly: values["counts-only"], originatingOnly: values["originating-only"],
            continuation: values.previous === undefined ? undefined : await previousPage(values.previous, values.batch) })));
    } else {
        if (["batch", "previous", "include-older", "include-archived", "counts-only", "originating-only"].some(key => key in values)) throw new BoardError("A review batch does not authorize preparation or Apply.", 422);
        console.log(JSON.stringify(await runPromptOriginRepair({
            mode: values.mode, dataDir: values["data-dir"], planFile: values.plan, planSha256: values["plan-sha256"],
            journalFile: values.journal, reviewSha256: values["review-sha256"],
            sourceManifestFile: values["source-manifest"], sourceIdentity: values["source-identity"],
        })));
    }
} catch (error) {
    console.error(error instanceof BoardError ? error.message
        : "Prompt-origin restoration failed. Keep the runtime stopped and inspect the same sealed journal; do not start a replacement operation.");
    process.exitCode = 1;
}
