import path from "node:path";
import { readMetadataProjection, SOURCE_METADATA_MAX_BYTES } from "../lib/source-metadata.mjs";

try {
    const file = process.argv[2];
    if (process.platform !== "win32" || Number(process.versions.node.split(".")[0]) < 24
        || process.argv.length !== 3 || typeof file !== "string" || !/^[a-z]:[\\/]/i.test(file)
        || path.basename(file).toLowerCase() !== "data.db" || /[\u0000-\u001f]/.test(file)
        || file.split(/[\\/]/).some(part => part === "." || part === "..")) {
        throw Object.assign(new Error("A compatible Windows Node runtime and one approved metadata database are required."),
            { code: "source_reader_unavailable", status: 503 });
    }
    const output = JSON.stringify({ schemaVersion: 1, platform: process.platform, projection: readMetadataProjection(file) });
    if (Buffer.byteLength(output) > SOURCE_METADATA_MAX_BYTES) {
        throw Object.assign(new Error("The metadata projection exceeds the bounded reader output."), { code: "source_metadata_invalid", status: 503 });
    }
    process.stdout.write(output);
} catch (error) {
    process.stdout.write(JSON.stringify({ schemaVersion: 1, error: {
        code: error.code ?? "source_metadata_unavailable", status: error.status ?? 503,
        message: error.code?.startsWith("source_") ? error.message : "The approved source metadata could not be read.",
    } }));
    process.exitCode = 1;
}
