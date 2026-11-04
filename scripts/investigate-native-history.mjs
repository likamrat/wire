import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, realpath, lstat, rm, open as openFile } from "node:fs/promises";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { createHistoryEngineering, historyEngineeringVisibleSummary } from "../lib/microsoft-history-engineering.mjs";
import { createMicrosoftNativeHost, profileOwners } from "../lib/microsoft-native-host.mjs";
import { prepareMicrosoftNativeConfiguration, readMicrosoftNativeConfiguration,
    isMicrosoftNativeEnrollmentPolicy } from "../lib/microsoft-native-configuration.mjs";
import { acquireCollectorLock } from "../lib/collector-io.mjs";
import { SESSION_REASONS } from "../lib/microsoft-session-state.mjs";
import { startServer } from "../lib/server.mjs";
import { createExportController } from "../lib/export.mjs";

const runFile = promisify(execFile);
let normalEntryOwner = null;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const codeOf = error => typeof error?.code === "string"
    && (/^NATIVE_[A-Z_]{1,90}$/.test(error.code) || SESSION_REASONS.includes(error.code))
    ? error.code : "NATIVE_ENGINEERING_FAILED";
const exists = async file => {
    try { await lstat(file); return true; }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
};
const closeControlLimit = 4096;
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const closeAddress = (custody, pid) => process.platform === "win32"
    ? `\\\\.\\pipe\\wire-history-preparation-${pid}-${custody.operationId}` : path.join(custody.root, "preparation.sock");

async function createPreparationControl(custody, outputFile, closePreparation, onFailure) {
    const binding = Object.freeze({ schemaVersion: 1, kind: "owned-preparation-close-ipc",
        operationId: custody.operationId, outputFile, ownerPid: process.pid,
        address: closeAddress(custody, process.pid), capability: randomBytes(32).toString("hex") });
    const sockets = new Set();
    let closing = false, closed;
    const server = net.createServer(socket => {
        sockets.add(socket);
        let body = Buffer.alloc(0), handled = false;
        const deadline = setTimeout(() => socket.destroy(), 1000);
        socket.on("error", () => socket.destroy());
        socket.once("close", () => { clearTimeout(deadline); sockets.delete(socket); });
        socket.on("data", chunk => {
            if (handled) { socket.destroy(); return; }
            if (body.length + chunk.length > closeControlLimit) { socket.destroy(); return; }
            body = Buffer.concat([body, chunk]);
            const end = body.indexOf(10);
            if (end < 0) return;
            handled = true;
            let request, reason = "invalid-request", disposition = "refused";
            try { request = JSON.parse(body.subarray(0, end).toString("utf8")); }
            catch (error) { if (!(error instanceof SyntaxError)) throw error; }
            if (end === body.length - 1 && exact(request, ["schemaVersion", "action", "operationId", "outputFile", "capability"])
                && request.schemaVersion === 1 && request.action === "close-preparation"
                && request.operationId === binding.operationId && request.outputFile === binding.outputFile
                && request.capability === binding.capability) {
                if (closing) reason = "preparation-ended";
                else {
                    try {
                        reason = closePreparation();
                        if (reason === null) { disposition = "accepted"; reason = "cancellation-requested"; }
                    } catch { reason = "control-failed"; onFailure(); }
                }
            }
            socket.end(JSON.stringify({ schemaVersion: 1, operationId: binding.operationId, disposition, reason }) + "\n");
        });
    });
    server.maxConnections = 1;
    try {
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(binding.address, () => { server.off("error", reject); resolve(); });
        });
    } catch { server.close(); fail("NATIVE_ENGINEERING_CONTROL_UNAVAILABLE"); }
    server.on("error", () => onFailure());
    return { binding, close() {
        if (!closed) {
            closing = true;
            closed = new Promise((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
                for (const socket of sockets) if (!socket.writableEnded) socket.end();
            });
        }
        return closed;
    } };
}

async function readControlMetadata(file) {
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink()) fail("NATIVE_ENGINEERING_CONTROL_BINDING");
    const handle = await openFile(file, "r");
    try {
        const current = await handle.stat();
        if (!current.isFile() || current.ino !== before.ino || current.dev !== before.dev || current.size > 16384) {
            fail("NATIVE_ENGINEERING_CONTROL_BINDING");
        }
        const buffer = Buffer.alloc(16385), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 16384) fail("NATIVE_ENGINEERING_CONTROL_BINDING");
        try { return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")); }
        catch { fail("NATIVE_ENGINEERING_CONTROL_BINDING"); }
    } finally { await handle.close(); }
}

export async function requestHistoryPreparationClose(custodyFile) {
    if (typeof custodyFile !== "string" || !path.isAbsolute(custodyFile) || !custodyFile.endsWith(".custody")) {
        fail("NATIVE_ENGINEERING_CONTROL_BINDING");
    }
    const outputFile = custodyFile.slice(0, -".custody".length);
    const [custody, start] = await Promise.all([readControlMetadata(custodyFile), readControlMetadata(outputFile + ".started")]);
    const binding = custody.preparationClose;
    if (start.schemaVersion !== 1 || start.stage !== "preparation" || start.normalEntry !== true
        || typeof start.operationId !== "string" || !/^[a-f0-9-]{36}$/i.test(start.operationId)
        || typeof start.candidate !== "string" || !/^[a-f0-9]{40}$/.test(start.candidate)
        || custody.schemaVersion !== 1 || custody.operationId !== start.operationId
        || !exact(binding, ["schemaVersion", "kind", "operationId", "outputFile", "ownerPid", "address", "capability"])
        || binding.schemaVersion !== 1 || binding.kind !== "owned-preparation-close-ipc"
        || binding.operationId !== start.operationId || binding.outputFile !== outputFile
        || !Number.isSafeInteger(binding.ownerPid) || binding.ownerPid < 1
        || typeof custody.root !== "string" || !path.isAbsolute(custody.root)
        || path.dirname(custody.root) !== await realpath(os.tmpdir())
        || !/^wire-history-engineering-[A-Za-z0-9]+$/.test(path.basename(custody.root))
        || custody.profileDirectory !== path.join(custody.root, "data", "microsoft-native", "profile")
        || binding.address !== closeAddress(custody, binding.ownerPid)
        || typeof binding.capability !== "string" || !/^[a-f0-9]{64}$/.test(binding.capability)) {
        fail("NATIVE_ENGINEERING_CONTROL_BINDING");
    }
    if (await exists(outputFile)) return { schemaVersion: 1, operationId: start.operationId,
        disposition: "terminal-record-present", reason: "read-original-result" };
    const request = JSON.stringify({ schemaVersion: 1, action: "close-preparation",
        operationId: binding.operationId, outputFile, capability: binding.capability }) + "\n";
    if (Buffer.byteLength(request) > closeControlLimit) fail("NATIVE_ENGINEERING_CONTROL_BINDING");
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ path: binding.address });
        let sent = false, done = false, body = Buffer.alloc(0);
        const finish = (error, value) => {
            if (done) return;
            done = true; clearTimeout(deadline); socket.destroy();
            if (error) reject(Object.assign(new Error(error), { code: error }));
            else resolve(value);
        };
        const deadline = setTimeout(() => finish(sent ? "NATIVE_ENGINEERING_CLOSE_UNCONFIRMED" : "NATIVE_ENGINEERING_CONTROL_UNAVAILABLE"), 3000);
        socket.once("connect", () => { sent = true; socket.write(request); });
        socket.on("error", () => finish(sent ? "NATIVE_ENGINEERING_CLOSE_UNCONFIRMED" : "NATIVE_ENGINEERING_CONTROL_UNAVAILABLE"));
        socket.on("data", chunk => {
            if (body.length + chunk.length > closeControlLimit) { finish("NATIVE_ENGINEERING_CLOSE_UNCONFIRMED"); return; }
            body = Buffer.concat([body, chunk]);
            const end = body.indexOf(10);
            if (end < 0) return;
            let reply;
            try { reply = JSON.parse(body.subarray(0, end).toString("utf8")); }
            catch { finish("NATIVE_ENGINEERING_CLOSE_UNCONFIRMED"); return; }
            if (end !== body.length - 1 || !exact(reply, ["schemaVersion", "operationId", "disposition", "reason"])
                || reply.schemaVersion !== 1 || reply.operationId !== binding.operationId
                || !["accepted", "refused"].includes(reply.disposition)
                || (reply.disposition === "accepted") !== (reply.reason === "cancellation-requested")
                || !["cancellation-requested", "connect-started", "preparation-ended", "invalid-request", "control-failed"].includes(reply.reason)) {
                finish("NATIVE_ENGINEERING_CLOSE_UNCONFIRMED"); return;
            }
            finish(null, reply);
        });
        socket.once("close", () => { if (!done) finish("NATIVE_ENGINEERING_CLOSE_UNCONFIRMED"); });
    });
}

export function historyInvestigationEnvironment(custody, environment = process.env) {
    const isolated = { ...environment };
    for (const name of Object.keys(isolated)) {
        const key = name.toUpperCase();
        if (["NODE_TEST_CONTEXT", "WORKIQ_EVIDENCE_DATA_DIR", "COPILOT_HOME", "GH_CONFIG_DIR"].includes(key)
            || key.startsWith("WIRE_") || /^(?:GH|GITHUB|COPILOT)(?:_[A-Z0-9]+)*_TOKEN$/.test(key)) delete isolated[name];
    }
    return { ...isolated, WORKIQ_EVIDENCE_DATA_DIR: custody.dataDir,
        COPILOT_HOME: path.join(custody.root, "empty-copilot"), GH_CONFIG_DIR: path.join(custody.root, "empty-github") };
}

export async function createEngineeringCustody(operationId) {
    if (!/^[a-f0-9-]{36}$/i.test(operationId)) fail("NATIVE_ENGINEERING_CUSTODY");
    const parent = await realpath(os.tmpdir());
    const root = await mkdtemp(path.join(parent, "wire-history-engineering-"));
    const marker = { kind: "wire-history-engineering", operationId, pid: process.pid };
    await writeFile(path.join(root, "engineering-owner.json"), JSON.stringify(marker), { flag: "wx", mode: 0o600 });
    const dataDir = path.join(root, "data");
    await mkdir(dataDir, { mode: 0o700 });
    return { root, operationId, dataDir, profileDirectory: path.join(dataDir, "microsoft-native", "profile") };
}

export async function cleanupEngineeringCustody(custody, { inspectOwners = profileOwners } = {}) {
    const { root, operationId, profileDirectory, dataDir } = custody;
    if (await realpath(root) !== root || path.dirname(root) !== await realpath(os.tmpdir())
        || !/^wire-history-engineering-[A-Za-z0-9]+$/.test(path.basename(root))
        || dataDir !== path.join(root, "data") || profileDirectory !== path.join(dataDir, "microsoft-native", "profile")) {
        fail("NATIVE_ENGINEERING_CUSTODY");
    }
    const marker = JSON.parse(await readFile(path.join(root, "engineering-owner.json"), "utf8"));
    if (Object.keys(marker).sort().join(",") !== "kind,operationId,pid" || marker.kind !== "wire-history-engineering"
        || marker.operationId !== operationId || marker.pid !== process.pid) fail("NATIVE_ENGINEERING_CUSTODY");
    const owners = await inspectOwners(profileDirectory);
    if (!Array.isArray(owners) || owners.length || await exists(path.join(dataDir, "microsoft-native", "native-owner.lock"))) {
        fail("NATIVE_ENGINEERING_CUSTODY_NOT_RELEASED");
    }
    // This is the one fresh engineering root, never an adopted profile or a product data directory.
    await rm(root, { recursive: true });
    const remainingOwners = await inspectOwners(profileDirectory);
    if (remainingOwners.length || await exists(root)) fail("NATIVE_ENGINEERING_CLEANUP_FAILED");
    return { browserOwners: 0, nativeLockReleased: true, profileRemoved: true, rootRemoved: true };
}

async function stopRecordedOwners(custody, recorded) {
    const owners = await profileOwners(custody.profileDirectory);
    if (!owners.length) return;
    if (owners.some(pid => !recorded.includes(pid))) fail("NATIVE_ENGINEERING_CUSTODY_NOT_RELEASED");
    const directory = custody.profileDirectory.replaceAll("'", "''");
    for (const pid of owners) await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"; `
        + `if($p){if($p.Name -ne 'msedge.exe' -or !$p.CommandLine -or !$p.CommandLine.Contains('${directory}')){throw 'Custody changed'}; Stop-Process -Id ${pid} -Force}`],
    { windowsHide: true, timeout: 5000, encoding: "utf8" });
}

export async function verifyHistoryInvestigationCandidate(expectedCommit) {
    if (typeof expectedCommit !== "string" || !/^[a-f0-9]{40}$/.test(expectedCommit)) fail("NATIVE_ENGINEERING_CANDIDATE_REQUIRED");
    const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const head = await runFile("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", windowsHide: true, timeout: 10000 });
    const status = await runFile("git", ["status", "--porcelain", "--untracked-files=normal"],
        { cwd, encoding: "utf8", windowsHide: true, timeout: 10000 });
    if (head.stdout.trim() !== expectedCommit || status.stdout.trim()) fail("NATIVE_ENGINEERING_CANDIDATE_CHANGED");
    return expectedCommit;
}

export function assertHistoryInvestigationActive(engineering, signal) {
    const failure = engineering.summary().firstFailure;
    if (failure || signal?.aborted) fail(failure?.code ?? "NATIVE_ENGINEERING_CANCELLED");
}

export async function runHistoryInvestigation({ expectedAccount, authorizationReference, outputFile,
    normalEntry = false, expectedCommit, enrollmentPolicyFile, signal, cancelPreparation,
    emit = value => console.log(JSON.stringify(value)) }) {
    if (typeof authorizationReference !== "string" || !/^[A-Za-z0-9_-]{8,160}$/.test(authorizationReference)
        || typeof outputFile !== "string" || !path.isAbsolute(outputFile) || typeof emit !== "function"
        || typeof normalEntry !== "boolean" || signal !== undefined && !(signal instanceof AbortSignal)
        || normalEntry && !(signal instanceof AbortSignal)
        || cancelPreparation !== undefined && (!normalEntry || typeof cancelPreparation !== "function" || Buffer.byteLength(outputFile) > 1024)
        || enrollmentPolicyFile !== undefined
            && (!normalEntry || typeof enrollmentPolicyFile !== "string" || !path.isAbsolute(enrollmentPolicyFile))) fail("NATIVE_ENGINEERING_BINDING");
    if (signal?.aborted) fail("NATIVE_ENGINEERING_CANCELLED");
    const candidate = normalEntry || expectedCommit !== undefined ? await verifyHistoryInvestigationCandidate(expectedCommit) : null;
    const enrollmentPolicy = enrollmentPolicyFile ? await readMicrosoftNativeConfiguration(enrollmentPolicyFile) : null;
    if (enrollmentPolicy && (!isMicrosoftNativeEnrollmentPolicy(enrollmentPolicy)
        || enrollmentPolicy.expectedAccount.toLowerCase() !== expectedAccount?.toLowerCase())) fail("NATIVE_ENGINEERING_BINDING");
    const operationId = randomUUID();
    let rejectNormalEntry, host, timer, hostClose;
    let closeFailure = null;
    const closeHost = () => !host ? Promise.resolve() : hostClose ??= (async () => {
        try { await host?.close(); }
        catch (error) { closeFailure ??= codeOf(error); }
    })();
    const engineering = createHistoryEngineering({ expectedAccount, salt: [...randomBytes(32)],
        onEvent: event => {
            if (event.type === "connect-started") {
                if (timer || !host) fail("NATIVE_ENGINEERING_BINDING");
                timer = setTimeout(() => {
                    if (!engineering.complete) engineering.recordFailure("NATIVE_ENGINEERING_DEADLINE");
                    void closeHost();
                }, Math.max(1, Math.min(280000, Date.parse(event.shutdownAt) - Date.now())));
            }
            try { emit({ ...event, operationId }); }
            finally { if (event.type === "failure") rejectNormalEntry?.(Object.assign(new Error(), { code: event.code })); }
        } });
    if (await exists(outputFile)) fail("NATIVE_ENGINEERING_ALREADY_ATTEMPTED");
    await writeFile(outputFile + ".started", JSON.stringify({ schemaVersion: 1, operationId, authorizationReference,
        stage: "preparation", startedAt: new Date().toISOString(), ...(candidate ? { candidate, normalEntry } : {}) }), { flag: "wx", mode: 0o600 });
    let custody, runtime, preparationControl, controlFailure = null, restoreEnvironment, releaseControl, release, cancel,
        releaseFailure = null, cleanupFailure = null, cleanup = null;
    const startedAt = new Date().toISOString(), previousConsole = { info: console.info, error: console.error };
    // The host's broad diagnostic logger is not the engineering evidence sink.
    console.info = () => {};
    console.error = () => {};
    try {
        if (normalEntry) {
            if (normalEntryOwner !== null) fail("NATIVE_ENGINEERING_ALREADY_ACTIVE");
            normalEntryOwner = operationId;
        }
        custody = await createEngineeringCustody(operationId);
        if (cancelPreparation) preparationControl = await createPreparationControl(custody, outputFile, () => {
            if (engineering.connectionStarted) return "connect-started";
            if (signal.aborted) return "preparation-ended";
            cancelPreparation();
            if (!signal.aborted) fail("NATIVE_ENGINEERING_CONTROL_FAILED");
            return null;
        }, () => {
            controlFailure ??= "NATIVE_ENGINEERING_CONTROL_FAILED";
            if (!engineering.connectionStarted) {
                engineering.recordFailure(controlFailure);
                void closeHost();
            } else emit({ type: "preparation-control-error", operationId, code: controlFailure });
        });
        if (normalEntry) {
            const isolated = historyInvestigationEnvironment(custody), previous = new Map();
            await mkdir(isolated.COPILOT_HOME, { mode: 0o700 });
            await mkdir(isolated.GH_CONFIG_DIR, { mode: 0o700 });
            const keyFor = name => process.platform === "win32" ? name.toUpperCase() : name;
            const target = new Map(Object.entries(isolated).map(([name, value]) => [keyFor(name), value]));
            for (const name of new Set([...Object.keys(process.env), ...Object.keys(isolated)])) {
                const key = keyFor(name), value = target.get(key);
                if (previous.has(key) || process.env[name] === value) continue;
                previous.set(key, { name, value: process.env[name] });
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
            restoreEnvironment = () => {
                for (const { name, value } of previous.values()) {
                    if (value === undefined) delete process.env[name];
                    else process.env[name] = value;
                }
            };
        }
        if (normalEntry) await writeFile(outputFile + ".custody", JSON.stringify({ schemaVersion: 1, operationId,
            root: custody.root, profileDirectory: custody.profileDirectory,
            ...(preparationControl ? { preparationClose: preparationControl.binding } : {}) }), { flag: "wx", mode: 0o600 });
        release = await acquireCollectorLock(custody.dataDir);
        const context = { dataDir: custody.dataDir, sessionId: operationId };
        const configuration = await prepareMicrosoftNativeConfiguration(context, expectedAccount, {
            check() { if (signal?.aborted) fail("NATIVE_ENGINEERING_CANCELLED"); }, dispatched() {},
        }, enrollmentPolicy);
        assertHistoryInvestigationActive(engineering, signal);
        host = await createMicrosoftNativeHost(context, { configuration, sourceAware: true, engineering });
        cancel = () => {
            engineering.recordFailure("NATIVE_ENGINEERING_CANCELLED");
            void closeHost();
        };
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) { cancel(); fail("NATIVE_ENGINEERING_CANCELLED"); }
        if (normalEntry) {
            await release();
            release = null;
            runtime = await startServer(context, createExportController(context), {
                port: 0, access: host.access, collector: { timers: false }, githubProfile: { copilot: {} },
            });
            await new Promise((resolve, reject) => {
                rejectNormalEntry = reject;
                const refuseStopped = () => {
                    try { assertHistoryInvestigationActive(engineering, signal); return false; }
                    catch (error) { reject(error); return true; }
                };
                if (refuseStopped()) return;
                let connecting = false;
                releaseControl = host.access.subscribeControl(value => {
                    if (["signing-in", "handoff"].includes(value.microsoft?.state)) connecting = true;
                    if (value.microsoft?.state === "connected" && engineering.complete) resolve();
                    else if (connecting && (value.wire === "signed-out"
                        || ["disconnected", "unavailable", "reconnect-required", "recovery-required"].includes(value.microsoft?.state))) {
                        reject(Object.assign(new Error(), { code: "NATIVE_ENGINEERING_CONNECTION_INCOMPLETE" }));
                    }
                });
                if (refuseStopped()) return;
                emit({ type: "normal-entry-ready", operationId, url: runtime.url, candidate,
                    settingsUrl: runtime.url + "#settings?section=connection&setting=microsoft-connection",
                    route: "Settings > Microsoft > Connect", scope: "both-source-list-responses-no-detail", acquisitionEnabled: false,
                    microsoft: "not-started", preparationClose: preparationControl ? "owned-ipc" : "original-process-cancellation",
                    userVisibility: "unconfirmed",
                    isolation: { sources: "empty", credentials: "not-inherited", githubIdentity: "unbound" } });
            });
        } else for (const action of ["wire-sign-in", "microsoft-connect"]) {
            const receipt = await host.access.command(operationId, { schemaVersion: 1, action,
                operationId: randomUUID(), generation: (await host.access.status()).generation }, () => true);
            if (receipt.outcome !== "completed") fail("NATIVE_ENGINEERING_CONNECTION_INCOMPLETE");
        }
    } catch (error) {
        engineering.recordFailure(codeOf(error));
    } finally {
        clearTimeout(timer);
        if (cancel) signal?.removeEventListener("abort", cancel);
        rejectNormalEntry = null;
        releaseControl?.();
        try { await preparationControl?.close(); } catch { controlFailure ??= "NATIVE_ENGINEERING_CONTROL_CLOSE_FAILED"; }
        await closeHost();
        try { await runtime?.close(); } catch (error) { closeFailure ??= codeOf(error); }
        try { await release?.(); } catch (error) { releaseFailure = codeOf(error); }
        if (custody) {
            try {
                await stopRecordedOwners(custody, engineering.browserOwnerIds);
                if (runtime?.server.listening) fail("NATIVE_ENGINEERING_RUNTIME_CLEANUP_FAILED");
                cleanup = await cleanupEngineeringCustody(custody);
            } catch (error) { cleanupFailure = codeOf(error); }
        }
        console.info = previousConsole.info;
        console.error = previousConsole.error;
        if (normalEntryOwner === operationId && !runtime?.server.listening) {
            restoreEnvironment?.();
            normalEntryOwner = null;
        }
    }
    return finishHistoryInvestigation({ engineering, operationId, authorizationReference, startedAt,
        cleanup: { disposition: cleanup ? "removed" : custody ? "not-verified" : "not-created",
            ...cleanup, closeFailure, releaseFailure, failure: cleanupFailure, ...(controlFailure ? { controlFailure } : {}) },
        custodyRoot: custody?.root ?? null, candidate, normalEntry, outputFile, emit });
}

export async function finishHistoryInvestigation(input) {
    if (input.cleanup.disposition === "not-verified") {
        // Custody must outlive failed persistence or user-supplied notification callbacks.
        setInterval(() => {}, 1000);
        try { input.emit({ type: "cleanup-required", operationId: input.operationId, ...(input.normalEntry
            ? { custody: "retained", location: "private-custody-file" } : { root: input.custodyRoot }) }); }
        catch { console.error(JSON.stringify({ type: "cleanup-notification-failed", code: "NATIVE_ENGINEERING_PUBLICATION_FAILED" })); }
    }
    return persistHistoryInvestigationResult(input);
}

export async function persistHistoryInvestigationResult({ engineering, operationId, authorizationReference, startedAt,
    cleanup, custodyRoot, candidate, normalEntry, outputFile, emit }) {
    const result = { schemaVersion: 1, operationId, authorizationReference, startedAt, finishedAt: new Date().toISOString(),
        source: engineering.summary(), cleanup, custodyRoot, ...(candidate ? { candidate, normalEntry } : {}) };
    await writeFile(outputFile, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    emit({ type: "result", operationId, ...(normalEntry ? { schemaVersion: 1, candidate, cleanup } : result),
        source: historyEngineeringVisibleSummary(result.source) });
    return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const cancellation = new AbortController();
    const cancel = () => cancellation.abort();
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    try {
        const { values } = parseArgs({ options: { "expected-account": { type: "string" },
            "authorization-reference": { type: "string" }, output: { type: "string" },
            "expected-commit": { type: "string" }, "normal-entry": { type: "boolean", default: false },
            "enrollment-policy": { type: "string" }, "close-preparation": { type: "string" } } });
        if (values["close-preparation"] !== undefined) {
            if (values["normal-entry"] || ["expected-account", "authorization-reference", "output", "expected-commit", "enrollment-policy"]
                .some(name => values[name] !== undefined)) fail("NATIVE_ENGINEERING_CONTROL_BINDING");
            const reply = await requestHistoryPreparationClose(values["close-preparation"]);
            console.log(JSON.stringify(reply));
            if (reply.disposition === "refused") process.exitCode = 2;
        } else {
            const result = await runHistoryInvestigation({ expectedAccount: values["expected-account"],
            authorizationReference: values["authorization-reference"], outputFile: values.output,
            expectedCommit: values["expected-commit"], normalEntry: values["normal-entry"],
            enrollmentPolicyFile: values["enrollment-policy"], signal: cancellation.signal,
            ...(values["normal-entry"] ? { cancelPreparation: cancel } : {}) });
            if (result.cleanup.disposition !== "not-verified") process.exit(result.source.outcome === "observed" ? 0 : 1);
        }
    } catch (error) {
        console.error(JSON.stringify({ type: "engineering-failed", code: codeOf(error) }));
        process.exitCode = 1;
    } finally {
        process.off("SIGINT", cancel);
        process.off("SIGTERM", cancel);
    }
}
