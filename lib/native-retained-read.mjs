import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { BoardError } from "./store.mjs";
import { projectRetainedNativeRecords } from "./retained-population.mjs";
import { NativeReadModelError, annotateNativeRetentionDiagnostic } from "./native-read-model.mjs";
import { MicrosoftSessionError } from "./microsoft-session.mjs";
import { ChatSourceDecodeError } from "./native-chat-source.mjs";

const fail = (code, status = 403) => Object.assign(new BoardError(`Native retained data unavailable (${code}).`, status), { code });
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function invoke(work) {
    try { return await work(); }
    catch (error) {
        if (error instanceof MicrosoftSessionError) throw fail(error.code === "lease-invalid" || error.code === "signed-out"
            ? "wire_access_revoked" : `wire_access_${error.code.replaceAll("-", "_")}`, error.status);
        if (error instanceof NativeReadModelError) throw annotateNativeRetentionDiagnostic(
            error, undefined, fail(`native-read-${error.code}`, 422));
        if (error instanceof ChatSourceDecodeError) throw fail(
            typeof error.code === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(error.code)
                ? `native-read-chat-${error.code}` : "native-read-chat-source-unqualified", 422);
        throw error;
    }
}
function freeze(value, seen = new WeakSet()) {
    if (value && typeof value === "object" && !seen.has(value)) {
        seen.add(value);
        for (const item of Object.values(value)) freeze(item, seen);
        Object.freeze(value);
    }
    return value;
}

// Both access bindings use this same lease/publication boundary. The source
// callback, not a tuple/hash recipe here, must supply already-authorized records.
export function createNativeRetainedRead(lifecycle, readAuthorized) {
    if (typeof readAuthorized !== "function") throw fail("native-provenance-unqualified", 503);
    const revisionFor = readAuthorized.revision;
    if (revisionFor !== undefined && typeof revisionFor !== "function") throw fail("native-read-source-revision-unqualified", 503);
    const preAccount = Object.hasOwn(readAuthorized, "preAccount") ? readAuthorized.preAccount : undefined;
    if (preAccount !== undefined && preAccount !== "metadata-only") throw fail("native-read-preaccount-policy-invalid", 503);
    const frames = new WeakMap();
    let current = null, closed = false, cached = null;
    const unsubscribe = lifecycle.subscribeAuthorizationChange(event => {
        if (!event.retained || current?.generation !== event.generation) cached = null;
        current = event;
    });
    function assertCurrent(lease) {
        if (closed || !current?.retained || current.generation !== lease.generation) throw fail("wire_access_revoked");
    }
    function sourceRevision(lease) {
        const value = revisionFor(lease);
        if (value && typeof value.then === "function") {
            Promise.resolve(value).catch(() => {});
            throw fail("native-read-source-revision-unqualified", 503);
        }
        if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw fail("native-read-source-revision-unqualified", 503);
        return value;
    }
    function sameRevision(lease, revision) {
        return revisionFor && cached?.partition === lease.partition && cached.sourceRevision === revision;
    }
    async function admit(lease, work) {
        const result = await invoke(() => lifecycle.admit(lease, () => {
            try { return { value: work() }; }
            catch (error) {
                if (!(error instanceof BoardError)) throw error;
                return { error };
            }
        }));
        if (Object.hasOwn(result, "error")) return invoke(() => { throw result.error; });
        return result.value;
    }
    async function scan() {
        if (closed) throw fail("wire_access_revoked");
        if (preAccount === "metadata-only") {
            const status = await invoke(() => lifecycle.status());
            if (status.wire === "signed-in" && status.authorization.retained === true
                && status.authorization.microsoftPartition === null) {
                const lease = await invoke(() => lifecycle.lease("retained"));
                return admit(lease, () => {
                    assertCurrent(lease);
                    if (!Number.isSafeInteger(status.authorizationRevision) || status.authorizationRevision < 0
                        || lease.generation !== status.generation || current.revision !== status.authorizationRevision) {
                        throw fail("native-read-stale", 409);
                    }
                    cached = null;
                    const frame = Object.freeze({ kind: "native-account-unavailable", reason: "microsoft-account-not-configured",
                        records: Object.freeze([]), generation: lease.generation, authorizationRevision: status.authorizationRevision,
                        revision: digest(["native-account-unavailable-v1", lease.generation, status.authorizationRevision]) });
                    frames.set(frame, { lease, unavailableRevision: status.authorizationRevision });
                    return frame;
                });
            }
        }
        const lease = await invoke(() => lifecycle.lease("microsoft-retained"));
        assertCurrent(lease);
        const revision = revisionFor ? await invoke(() => sourceRevision(lease)) : null;
        let value = sameRevision(lease, revision) ? cached : null;
        if (!value) {
            await setImmediate();
            assertCurrent(lease);
            const envelopes = await invoke(() => readAuthorized(lease));
            await setImmediate();
            assertCurrent(lease);
            if (revisionFor && await invoke(() => sourceRevision(lease)) !== revision) throw fail("native-read-stale", 409);
            value = sameRevision(lease, revision) ? cached : null;
            if (!value) {
                const projection = freeze(await invoke(() => projectRetainedNativeRecords(envelopes)));
                value = { partition: lease.partition, sourceRevision: revision, projection,
                    revision: digest(revisionFor ? ["native-source-revision-v1", revision, projection] : projection) };
            }
            await setImmediate();
        }
        return admit(lease, () => {
            assertCurrent(lease);
            if (revisionFor && sourceRevision(lease) !== revision) throw fail("native-read-stale", 409);
            if (revisionFor) cached = value;
            const frame = Object.freeze({ ...value.projection, revision: value.revision, generation: lease.generation });
            frames.set(frame, { lease, sourceRevision: revision });
            return frame;
        });
    }
    async function publish(frame, work) {
        const owned = frames.get(frame);
        if (!owned || typeof work !== "function") throw fail("native-read-frame-invalid", 422);
        const { lease } = owned;
        const unavailable = owned.unavailableRevision !== undefined;
        assertCurrent(lease);
        if (!unavailable && !revisionFor) {
            const fresh = await scan();
            if (fresh.revision !== frame.revision || fresh.generation !== frame.generation) throw fail("native-read-stale", 409);
        }
        return admit(lease, () => {
            assertCurrent(lease);
            if (unavailable ? current.revision !== owned.unavailableRevision
                : revisionFor && sourceRevision(lease) !== owned.sourceRevision) throw fail("native-read-stale", 409);
            const value = work();
            if (value && typeof value.then === "function") {
                Promise.resolve(value).catch(() => {});
                throw fail("native-publication-must-be-synchronous", 422);
            }
            return value;
        });
    }
    function assertFrameCurrent(frame) {
        if (closed) throw fail("wire_access_revoked");
        const owned = frames.get(frame);
        if (!owned) throw fail("native-read-frame-invalid", 422);
        const unavailable = owned.unavailableRevision !== undefined;
        if (!unavailable && !revisionFor) throw fail("native-read-source-revision-unqualified", 503);
        if (typeof lifecycle.assertRetainedLeaseCurrent !== "function") throw fail("native-read-lease-unqualified", 503);
        try {
            const checked = lifecycle.assertRetainedLeaseCurrent(owned.lease);
            if (checked && typeof checked.then === "function") Promise.resolve(checked).catch(() => undefined);
            if (checked !== true) throw fail("native-read-lease-unqualified", 503);
        } catch (error) {
            if (!(error instanceof MicrosoftSessionError)) throw error;
            throw fail(error.code === "lease-invalid" || error.code === "signed-out"
                ? "wire_access_revoked" : `wire_access_${error.code.replaceAll("-", "_")}`, error.status);
        }
        assertCurrent(owned.lease);
        if (unavailable ? current.revision !== owned.unavailableRevision
            : sourceRevision(owned.lease) !== owned.sourceRevision) throw fail("native-read-stale", 409);
        return true;
    }
    return Object.freeze({
        scan, publish, assertCurrent: assertFrameCurrent,
        close() { closed = true; cached = null; unsubscribe(); },
    });
}
