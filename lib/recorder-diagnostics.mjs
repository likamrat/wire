import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { BoardError, resolveDataDir, writeExclusive } from "./store.mjs";
import { recordMetadataResult } from "./collection.mjs";

// Intent and outcome are separate immutable files. Reading an interrupted intent
// never dispatches a replacement request.
export function createRecorderDiagnostics(session, options = {}) {
    const directory = path.join(resolveDataDir(session), "recorder-attempts");
    const active = new Map(), unsaved = new Map();
    let queue = Promise.resolve();
    const validId = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
    async function read(file) {
        try { return JSON.parse(await readFile(path.join(directory, file), "utf8")); }
        catch (error) { if (error.code === "ENOENT") return null; throw error; }
    }
    async function files() {
        try { return (await readdir(directory)).filter(name => /^\d{13}-[a-f0-9-]{36}\.attempt\.json$/i.test(name)).sort().reverse(); }
        catch (error) { if (error.code === "ENOENT") return []; throw error; }
    }
    async function status(attemptId) {
        if (attemptId !== undefined && !validId(attemptId)) throw new BoardError("Invalid recorder attempt identity.");
        const name = (await files()).find(name => !attemptId || name.endsWith(`-${attemptId}.attempt.json`));
        if (!name) return { attempt: null };
        const intent = await read(name);
        if (!intent) throw new BoardError("Recorder attempt cannot be read. No request was replayed.", 503);
        const result = unsaved.get(intent.attemptId) ?? await read(name.replace(".attempt.json", ".result.json"));
        return { attempt: result ?? { ...intent, phase: active.has(intent.attemptId) ? "pending" : "interrupted" } };
    }
    async function run(intent, name) {
        let result;
        try { result = { ...intent, ...await recordMetadataResult(session, true, { ...options, attemptId: intent.attemptId }) }; }
        catch (error) {
            console.error("[workiq-recorder] diagnostic failed", { code: error.code ?? "INTERNAL" });
            result = { ...intent, phase: "error", recordSaved: false, evidenceSaved: false };
        }
        result.finishedAt = new Date().toISOString();
        try { await writeExclusive(path.join(directory, name.replace(".attempt.json", ".result.json")), JSON.stringify(result, null, 2)); }
        catch (error) {
            console.error("[workiq-recorder] outcome persistence failed", { code: error.code ?? "PERSISTENCE" });
            unsaved.set(intent.attemptId, { ...result, phase: "save-error", outcomeSaved: false });
        }
        active.delete(intent.attemptId);
    }
    async function begin({ confirmed, attemptId }) {
        if (confirmed !== true || !validId(attemptId)) throw new BoardError("Confirm the public request with a new recorder attempt identity.");
        const existing = await status(attemptId);
        if (existing.attempt) return existing;
        if (active.size) return status(active.keys().next().value);
        await mkdir(directory, { recursive: true });
        const intent = { attemptId, startedAt: new Date().toISOString(), phase: "pending" };
        const name = `${Date.now()}-${attemptId}.attempt.json`;
        await writeExclusive(path.join(directory, name), JSON.stringify(intent, null, 2));
        const operation = run(intent, name);
        active.set(attemptId, operation);
        return { attempt: intent };
    }
    return {
        exclusiveActivity(work) {
            const operation = queue.then(async () => {
                await Promise.all(active.values());
                const result = await work();
                unsaved.clear();
                return result;
            });
            queue = operation.catch(() => {});
            return operation;
        },
        start(input) {
            const operation = queue.then(() => begin(input));
            queue = operation.catch(() => {});
            return operation;
        },
        status,
        async close() { await queue; await Promise.all(active.values()); },
    };
}
