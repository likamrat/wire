import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BoardError } from "./store.mjs";
import { sourceFileStamp } from "./collector-io.mjs";
import { readMetadataProjection, validateMetadataProjection, SOURCE_METADATA_MAX_BYTES } from "./source-metadata.mjs";

const execute = promisify(execFile);
const helper = fileURLToPath(new URL("../scripts/read-copilot-metadata.mjs", import.meta.url));
const failure = (code, message, cause) => Object.assign(new BoardError(message, 503), { code, ...(cause ? { cause } : {}) });
const helperEnvironment = () => Object.fromEntries(
    ["PATH", "WSL_INTEROP", "WSL_DISTRO_NAME", "LANG", "SystemRoot", "WINDIR", "PATHEXT", "TEMP", "TMP"]
        .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));

export function sourceMetadataStamp(files) {
    const file = files.databaseFile();
    let wal = "absent";
    try { wal = sourceFileStamp(statSync(file + "-wal")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    return sourceFileStamp(statSync(file)) + ":" + wal;
}

export async function readSourceMetadata(files, { run = execute } = {}) {
    files.assertCurrent();
    const before = sourceMetadataStamp(files);
    let projection;
    if (!files.windowsDatabase) {
        try { projection = readMetadataProjection(files.databaseFile()); }
        catch (error) { throw Object.assign(new BoardError(error.message, error.status ?? 503), { code: error.code }); }
    } else {
        let output, failed = false;
        try {
            const env = helperEnvironment();
            const translated = await run("wslpath", ["-w", helper], { timeout: 2000, maxBuffer: 16384, encoding: "utf8", env });
            const script = translated.stdout.replace(/\r?\n$/, "");
            if (!script || /[\u0000-\u001f]/.test(script) || !/^(?:[a-z]:[\\/]|\\\\)/i.test(script)) {
                throw new Error("The source-native reader code path is unavailable.");
            }
            const result = await run("node.exe", [script, files.windowsDatabase],
                { timeout: 5000, maxBuffer: SOURCE_METADATA_MAX_BYTES, encoding: "utf8", windowsHide: true, env });
            output = result.stdout;
        } catch (error) {
            if (error.stdout && !error.killed && error.code === 1) { output = error.stdout; failed = true; }
            else throw failure("source_reader_unavailable",
                "The Windows source reader is unavailable or exceeded its limit. Use an existing Windows Node 24+ runtime through WSL interop; last good evidence was retained.", error);
        }
        let response;
        try { response = JSON.parse(output); }
        catch (error) { throw failure("source_metadata_invalid", "The source reader returned invalid metadata. Last good evidence was retained.", error); }
        if (response?.schemaVersion !== 1) throw failure("source_metadata_invalid", "The source reader protocol is unsupported.");
        if (response.error) {
            const { code, status, message } = response.error;
            if (!["source_mapping_unsupported", "source_metadata_unavailable", "source_metadata_invalid", "source_reader_unavailable"].includes(code)
                || ![422, 503].includes(status) || typeof message !== "string" || message.length > 2000) {
                throw failure("source_metadata_invalid", "The source reader returned an invalid failure.");
            }
            throw Object.assign(new BoardError(message, status), { code });
        }
        if (failed) throw failure("source_reader_unavailable", "The source reader exited unsuccessfully. Last good evidence was retained.");
        if (response.platform !== "win32") throw failure("source_metadata_invalid", "The source reader did not run on the Windows source host.");
        projection = response.projection;
    }
    files.assertCurrent();
    if (sourceMetadataStamp(files) !== before) {
        throw Object.assign(new BoardError("Source metadata changed during its read. Last good evidence was retained.", 409),
            { code: "COLLECTION_SOURCE_CHANGED", sourceChange: "metadata-read" });
    }
    try { validateMetadataProjection(projection); }
    catch (error) { throw Object.assign(new BoardError(error.message, error.status ?? 503), { code: error.code }); }
    return { ...projection, metadataStamp: before };
}
