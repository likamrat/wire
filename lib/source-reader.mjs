import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { BoardError } from "./store.mjs";
import { sourceFileStamp } from "./collector-io.mjs";
import { readMetadataProjection, validateMetadataProjection, metadataReadVersion,
    SOURCE_METADATA_MAX_BYTES, SOURCE_METADATA_READER_VERSION } from "./source-metadata.mjs";
import { readSourceProfileProjection, validateSourceProfile, SOURCE_PROFILE_MAX_BYTES } from "./source-profile.mjs";

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

export async function readSourceMetadata(files, { run = execute, profileOnly = false } = {}) {
    const options = { run, profileOnly };
    const { profileMetadataChanged, value: first } = await readSourceMetadataOnce(files, options);
    if (!profileMetadataChanged) return first;
    // Unrelated app writes share this WAL. Recheck the selected profile once,
    // using a new read-only transaction, rather than requiring the entire DB to idle.
    const { value: second } = await readSourceMetadataOnce(files, options);
    if (second.sourceIdentity !== first.sourceIdentity || second.revision !== first.revision) {
        throw Object.assign(new BoardError("The selected app profile changed during its read.", 409),
            { code: "COLLECTION_SOURCE_CHANGED", sourceChange: "profile-read" });
    }
    return second;
}

async function readSourceMetadataOnce(files, { run, profileOnly }) {
    files.assertCurrent();
    const before = sourceMetadataStamp(files);
    const databaseIdentity = () => {
        const info = statSync(files.databaseFile(), { bigint: true });
        return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
    };
    const beforeIdentity = databaseIdentity();
    let stamp = before;
    let projection, profileMetadataChanged = false;
    if (!files.windowsDatabase) {
        try { projection = (profileOnly ? readSourceProfileProjection : readMetadataProjection)(files.databaseFile()); }
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
            const result = await run("node.exe", [script, files.windowsDatabase, ...(profileOnly ? ["--profile"] : [])],
                { timeout: 5000, maxBuffer: profileOnly ? SOURCE_PROFILE_MAX_BYTES : SOURCE_METADATA_MAX_BYTES, encoding: "utf8", windowsHide: true, env });
            output = result.stdout;
        } catch (error) {
            if (error.stdout && !error.killed && error.code === 1) { output = error.stdout; failed = true; }
            else throw failure("source_reader_unavailable",
                "The Windows source reader is unavailable or exceeded its limit. Use an existing Windows Node 24+ runtime through WSL interop; last good evidence was retained.", error);
        }
        let response;
        try { response = JSON.parse(output); }
        catch (error) { throw failure("source_metadata_invalid", "The source reader returned invalid metadata. Last good evidence was retained.", error); }
        if (response?.schemaVersion !== SOURCE_METADATA_READER_VERSION) throw failure("source_metadata_invalid", "The source reader protocol is unsupported.");
        if (response.error) {
            const { code, status, message } = response.error;
            if (!["source_mapping_unsupported", "source_metadata_unavailable", "source_metadata_invalid", "source_reader_unavailable", "COLLECTION_SOURCE_CHANGED"].includes(code)
                || ![409, 422, 503].includes(status) || typeof message !== "string" || message.length > 2000) {
                throw failure("source_metadata_invalid", "The source reader returned an invalid failure.");
            }
            throw Object.assign(new BoardError(message, status), { code,
                ...(code === "COLLECTION_SOURCE_CHANGED" ? { sourceChange: "metadata-read" } : {}) });
        }
        if (failed) throw failure("source_reader_unavailable", "The source reader exited unsuccessfully. Last good evidence was retained.");
        if (response.platform !== "win32") throw failure("source_metadata_invalid", "The source reader did not run on the Windows source host.");
        if (!/^[a-f0-9]{64}$/.test(response.readVersion ?? "")) throw failure("source_metadata_invalid", "The source reader omitted its verified read version.");
        // Bind the host-local stamp to the helper's actual SQL read, not process-launch latency.
        stamp = sourceMetadataStamp(files);
        const metadataChanged = metadataReadVersion(files.databaseFile()) !== response.readVersion || sourceMetadataStamp(files) !== stamp;
        if (databaseIdentity() !== beforeIdentity || !profileOnly && metadataChanged) {
            throw Object.assign(new BoardError("Source metadata changed after its read. Last good evidence was retained.", 409),
                { code: "COLLECTION_SOURCE_CHANGED", sourceChange: "metadata-read" });
        }
        profileMetadataChanged = profileOnly && metadataChanged;
        projection = response.projection;
    }
    files.assertCurrent();
    const metadataChanged = sourceMetadataStamp(files) !== stamp;
    if (!profileOnly && metadataChanged || databaseIdentity() !== beforeIdentity) {
        throw Object.assign(new BoardError("Source metadata changed during its read. Last good evidence was retained.", 409),
            { code: "COLLECTION_SOURCE_CHANGED", sourceChange: "metadata-read" });
    }
    profileMetadataChanged ||= profileOnly && metadataChanged;
    try { (profileOnly ? validateSourceProfile : validateMetadataProjection)(projection); }
    catch (error) { throw Object.assign(new BoardError(error.message, error.status ?? 503), { code: error.code }); }
    return { profileMetadataChanged, value: { ...projection, metadataStamp: stamp,
        ...(profileOnly ? { sourceIdentity: createHash("sha256").update(beforeIdentity).digest("hex") } : {}) } };
}
