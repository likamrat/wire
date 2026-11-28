import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { BoardError } from "./store.mjs";
import { sourceFileStamp } from "./collector-io.mjs";
import { readMetadataProjection, validateMetadataProjection, metadataReadVersion, statMetadataFile,
    SOURCE_METADATA_MAX_BYTES, SOURCE_METADATA_READER_VERSION } from "./source-metadata.mjs";
import { readSourceModelCatalog, validateSourceModelCatalog, SOURCE_CATALOG_MAX_BYTES,
    readSourceProfileProjection, validateSourceProfile, SOURCE_PROFILE_MAX_BYTES } from "./source-profile.mjs";

const execute = promisify(execFile);
const helper = fileURLToPath(new URL("../scripts/read-copilot-metadata.mjs", import.meta.url));
const failure = (code, message, cause) => Object.assign(new BoardError(message, 503), { code, ...(cause ? { cause } : {}) });
const sourceReadFailure = error => error.code === "source_metadata_unavailable" && !(error instanceof BoardError)
    ? failure(error.code, error.message, error.cause ?? error) : error;
const metadataChanged = (message = "Source metadata changed during its read. Last good evidence was retained.", sourceChange = "metadata-read") =>
    Object.assign(new BoardError(message, 409), { code: "COLLECTION_SOURCE_CHANGED", sourceChange });
const databaseReplaced = () => metadataChanged("The Copilot database was replaced during the check. Its metadata was not accepted.", "metadata-identity");
const helperUnavailable = cause => failure("source_reader_unavailable",
    "The Windows source reader is unavailable or exceeded its limit. Use an existing Windows Node 24+ runtime through WSL interop; last good evidence was retained.", cause);
const helperEnvironment = () => Object.fromEntries(
    ["PATH", "WSL_INTEROP", "WSL_DISTRO_NAME", "LANG", "SystemRoot", "WINDIR", "PATHEXT", "TEMP", "TMP"]
        .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));

export function sourceMetadataStamp(files) {
    const file = files.databaseFile();
    try {
        const wal = statMetadataFile(file + "-wal", { optional: true });
        return sourceFileStamp(statMetadataFile(file)) + ":" + (wal ? sourceFileStamp(wal) : "absent");
    } catch (error) { throw sourceReadFailure(error); }
}

// Compare the entire bounded roster after an overlap. Observation times and display names
// do not grant access; use those from the independently fenced second transaction.
function collectionRosterProof({ adapter, schemaVersion, counts, unmappedWorkspaces, roster }) {
    const digest = createHash("sha256").update(JSON.stringify([adapter, schemaVersion, counts, unmappedWorkspaces]));
    for (const { checkedAt, name, project, ...membership } of roster) digest.update(JSON.stringify(membership));
    return digest.digest("hex");
}
export function readCollectionMetadata(files, verify, { run = execute } = {}) {
    return readSourceMetadata(files, { run, selection: { verify, proof: collectionRosterProof } });
}

export async function readSourceMetadata(files, { run = execute, profileOnly = false, modelCatalog = false, includeIdentity = false, selection } = {}) {
    try {
        if (profileOnly && modelCatalog || selection && (modelCatalog || profileOnly || typeof selection.verify !== "function" || typeof selection.proof !== "function")) {
            throw new TypeError("A selected metadata read requires its acquisition guard and membership proof.");
        }
        const options = { run, profileOnly, modelCatalog, includeIdentity: includeIdentity || !!selection, verify: selection?.verify };
        const { changed, value: first } = await readSourceMetadataOnce(files, { ...options, observeSelection: !!selection });
        if (!changed) return first;
        // A display revision can survive further WAL churn. A history stamp cannot:
        // only the independently fenced second transaction may supply it to the caller.
        const proof = selection?.proof(first);
        const { value: second } = await readSourceMetadataOnce(files, { ...options, expectedIdentity: selection && first.sourceIdentity });
        if (selection) {
            if (typeof proof !== "string" || !proof || selection.proof(second) !== proof) {
                throw metadataChanged("The Copilot chat mapping changed during verification. Its metadata was not accepted.", "membership");
            }
        } else if (second.sourceIdentity !== first.sourceIdentity || second.revision !== first.revision) {
            throw Object.assign(new BoardError("The selected app profile changed during its read.", 409),
                { code: "COLLECTION_SOURCE_CHANGED", sourceChange: "profile-read" });
        }
        return second;
    } catch (error) { throw sourceReadFailure(error); }
}

// Read-only named scans need a selected-mapping observation, not a claim that
// the whole producer database stayed idle. Never expose a publication stamp.
export async function observeSourceMetadataSelection(files, { run = execute, verify, proof } = {}) {
    if (typeof verify !== "function" || typeof proof !== "function") {
        throw new TypeError("A selected metadata observation requires its acquisition guard and membership proof.");
    }
    try {
        const options = { run, profileOnly: false, includeIdentity: true, verify, observeSelection: true };
        const { value: first } = await readSourceMetadataOnce(files, options);
        const selected = proof(first);
        if (typeof selected !== "string" || !selected) throw new TypeError("A selected metadata observation requires a nonempty membership proof.");
        const { value: second } = await readSourceMetadataOnce(files, { ...options, expectedIdentity: first.sourceIdentity });
        if (proof(second) !== selected) {
            throw metadataChanged("The selected chat mapping changed during verification. Its metadata was not accepted.", "membership");
        }
        const { metadataStamp, ...observation } = second;
        return observation;
    } catch (error) { throw sourceReadFailure(error); }
}

async function readSourceMetadataOnce(files, { run, profileOnly, modelCatalog, includeIdentity, verify, observeSelection = false, expectedIdentity }) {
    if (verify) await verify();
    files.assertCurrent();
    const before = sourceMetadataStamp(files);
    const databaseIdentity = () => {
        const info = statMetadataFile(files.databaseFile(), { bigint: true });
        return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
    };
    const beforeIdentity = databaseIdentity();
    const sourceIdentity = (profileOnly || modelCatalog || includeIdentity) && createHash("sha256").update(beforeIdentity).digest("hex");
    if (expectedIdentity && sourceIdentity !== expectedIdentity) throw databaseReplaced();
    let stamp = before;
    let projection, changed = false;
    if (!files.windowsDatabase) {
        try { projection = (modelCatalog ? readSourceModelCatalog : profileOnly ? readSourceProfileProjection : readMetadataProjection)(files.databaseFile()); }
        catch (error) { throw Object.assign(new BoardError(error.message, error.status ?? 503), { code: error.code }); }
    } else {
        const env = helperEnvironment();
        let translated;
        try {
            translated = await run("wslpath", ["-w", helper], { timeout: 2000, maxBuffer: 16384, encoding: "utf8", env });
        } catch (error) { throw helperUnavailable(error); }
        const script = translated?.stdout?.replace(/\r?\n$/, "");
        if (!script || /[\u0000-\u001f]/.test(script) || !/^(?:[a-z]:[\\/]|\\\\)/i.test(script)) throw helperUnavailable();
        if (verify) {
            await verify();
            files.assertCurrent();
            if (databaseIdentity() !== beforeIdentity) throw databaseReplaced();
        }
        let output, failed = false;
        try {
            const result = await run("node.exe", [script, files.windowsDatabase, ...(modelCatalog ? ["--model-catalog"] : profileOnly ? ["--profile"] : observeSelection ? ["--observe-selection"] : [])],
                { timeout: 5000, maxBuffer: modelCatalog ? SOURCE_CATALOG_MAX_BYTES + 1024 : profileOnly ? SOURCE_PROFILE_MAX_BYTES : SOURCE_METADATA_MAX_BYTES, encoding: "utf8", windowsHide: true, env });
            output = result.stdout;
        } catch (error) {
            if (error.stdout && !error.killed && error.code === 1) { output = error.stdout; failed = true; }
            else throw helperUnavailable(error);
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
        if (Object.hasOwn(response, "changedDuringRead") && (!observeSelection || response.changedDuringRead !== true)) {
            throw failure("source_metadata_invalid", "The source reader returned an unexpected read fence.");
        }
        // Bind the host-local stamp to the helper's actual SQL read, not process-launch latency.
        stamp = sourceMetadataStamp(files);
        changed = metadataReadVersion(files.databaseFile()) !== response.readVersion || sourceMetadataStamp(files) !== stamp
            || response.changedDuringRead === true;
        if (databaseIdentity() !== beforeIdentity) throw databaseReplaced();
        projection = response.projection;
    }
    if (verify) await verify();
    files.assertCurrent();
    changed = sourceMetadataStamp(files) !== stamp || changed;
    if (databaseIdentity() !== beforeIdentity) throw databaseReplaced();
    if (changed && !modelCatalog && !profileOnly && !observeSelection) throw metadataChanged(expectedIdentity
        ? "The Copilot database changed again during verification. The history check could not use this read." : undefined);
    try { (modelCatalog ? validateSourceModelCatalog : profileOnly ? validateSourceProfile : validateMetadataProjection)(projection); }
    catch (error) { throw Object.assign(new BoardError(error.message, error.status ?? 503), { code: error.code }); }
    return { changed, value: { ...projection, metadataStamp: stamp, ...(sourceIdentity ? { sourceIdentity } : {}) } };
}
