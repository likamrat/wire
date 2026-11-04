import { realpathSync } from "node:fs";
import path from "node:path";
import { BoardError, resolveDataDir } from "./store.mjs";
import { collectorHostIdentity, hash, readJson } from "./collector-io.mjs";
import { hostPaths } from "./host-paths.mjs";

export const sourceFingerprint = config => hash(JSON.stringify([config.appDbPath, config.sessionRoot, config.windowDays]));
const bindings = new WeakMap();
const refused = () => Object.assign(new BoardError(
    "This collection belongs to another or unqualified host. Use a separate WIRE data directory; no existing cursors were adopted.", 409),
{ code: "source_store_foreign" });
const sameOwner = (left, right) => left?.platform === right?.platform && left?.machine === right?.machine;

function accessFor(config, ownerHost) {
    let roots;
    const resolve = () => {
        if (!roots) {
            const database = hostPaths.local(config.appDbPath), history = hostPaths.local(config.sessionRoot);
            roots = { database, history, windowsDatabase: hostPaths.windowsSource(config.appDbPath) };
        }
        return roots;
    };
    const assertCurrent = () => {
        const current = resolve();
        if (current.windowsDatabase) for (const file of [current.database, current.history]) {
            if (path.resolve(realpathSync(file)) !== path.resolve(file)) throw refused();
        }
    };
    return {
        ownerHost,
        assertCurrent,
        databaseFile: () => resolve().database,
        historyRoot: () => resolve().history,
        get windowsDatabase() { return resolve().windowsDatabase; },
        historyFile(id) {
            if (typeof id !== "string" || !id || id === "." || id === ".." || /[/\\\u0000-\u001f]/.test(id)) throw refused();
            const file = path.join(resolve().history, id, "events.jsonl");
            if (resolve().windowsDatabase && path.resolve(realpathSync(file)) !== path.resolve(file)) throw refused();
            return file;
        },
    };
}

export function sourceHost(config) {
    const binding = bindings.get(config);
    if (binding) {
        if (sourceFingerprint(config) !== binding.fingerprint) throw refused();
        return binding.access;
    }
    const access = accessFor(config);
    bindings.set(config, { fingerprint: sourceFingerprint(config), access });
    return access;
}

export function shareSourceHost(from, to) {
    const binding = bindings.get(from);
    if (binding && sourceFingerprint(to) === binding.fingerprint) bindings.set(to, binding);
}

export async function bindSourceHost(context, config) {
    if (!config) return;
    const directory = path.join(resolveDataDir(context), "collector");
    if (await readJson(path.join(directory, "host-handover.json"))) throw refused();
    const index = await readJson(path.join(directory, "index.json"));
    const host = await collectorHostIdentity(), ownerHost = Object.freeze({ platform: host.platform, machine: host.machine });
    if (index?.ownerHost && !sameOwner(index.ownerHost, ownerHost)) throw refused();
    const cursors = Object.values(index?.sources ?? {}).map(row => row.cursor).filter(Boolean);
    if (cursors.some(cursor => cursor.host && !sameOwner(cursor.host, ownerHost))) throw refused();
    const access = accessFor(config, ownerHost);
    // A readable Windows path does not establish ownership of legacy Windows cursors.
    if (!index?.ownerHost && cursors.length && access.windowsDatabase) throw refused();
    bindings.set(config, { fingerprint: sourceFingerprint(config), access });
}
