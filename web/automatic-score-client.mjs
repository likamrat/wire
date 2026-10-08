// Serialized into the owning panel after integration. No eager request or model work.
export function createAutomaticScoreClient({ api, storage }) {
    const key = "wire.automaticScore.pending";
    const routes = {
        approve: "/api/evaluation/automatic/approve",
    };
    let receipt = null, phase = "idle", message = "", requestPending = false, storageBlocked = false, generation = 0;
    function validReceipt(value) {
        return value && Object.getPrototypeOf(value) === Object.prototype
            && Object.keys(value).length === 4 && value.schemaVersion === 1
            && Object.hasOwn(routes, value.kind)
            && /^mutation-[a-f0-9]{32}$/.test(value.mutationRef ?? "")
            && /^[a-f0-9]{64}$/.test(value.receiptToken ?? "");
    }
    try {
        const saved = storage.getItem(key);
        if (saved !== null) {
            const value = JSON.parse(saved);
            if (!validReceipt(value)) throw new Error("Invalid automatic-score receipt.");
            receipt = value; phase = "unknown";
            message = "Check the earlier approval result. Nothing will be repeated.";
        }
    } catch {
        phase = "blocked"; storageBlocked = true;
        message = "This panel cannot recover its earlier automatic-score receipt. No new approval will be sent.";
    }
    function snapshot() {
        return { phase, message, requestPending, storageBlocked, receipt: receipt ? { ...receipt } : null };
    }
    function clearReceipt() {
        try {
            storage.removeItem(key);
            if (storage.getItem(key) !== null) throw new Error("Receipt removal was not retained.");
            receipt = null; storageBlocked = false;
        } catch {
            storageBlocked = true;
            message = "The result is known, but this panel could not clear its receipt. Check that result again before another change.";
        }
    }
    function accept(result) {
        if (!result || result.schemaVersion !== 1 || result.mutationRef !== receipt?.mutationRef
            || !["complete", "pending", "not-started", "purged"].includes(result.phase)) {
            throw new Error("The automatic-score receipt does not match this operation.");
        }
        phase = result.phase;
        message = result.phase === "pending" ? "The original approval change is still pending. No new change was sent." : "";
        if (["complete", "not-started", "purged"].includes(result.phase)) {
            clearReceipt();
        }
        return result;
    }
    function unknown(error) {
        phase = "unknown";
        message = `${error.message} Check the original approval result; do not submit it again.`;
    }
    const superseded = () => Object.assign(new Error("This approval response was superseded by a confirmed Stop."), { code: "approval_superseded" });
    return {
        snapshot,
        confirmStopped(result) {
            if (result?.schemaVersion !== 1 || result.kind !== "revoke" || result.phase !== "complete"
                || !Number.isSafeInteger(result.data?.approvalRevision) || result.data.approvalRevision < 1) {
                throw new TypeError("A completed Stop generation is required.");
            }
            generation++; requestPending = false; phase = "idle"; message = "";
            clearReceipt();
        },
        setup: () => api("/api/evaluation/automatic/setup", {}),
        async submit(kind, packet) {
            // Stop is a separate fail-safe path, never blocked by an unresolved positive approval.
            if (!Object.hasOwn(routes, kind)) throw new TypeError("This client sends score approvals only.");
            if (requestPending || receipt || storageBlocked) throw new Error("Check the earlier automatic-score receipt before another change.");
            const next = { schemaVersion: 1, kind, mutationRef: packet?.mutationRef, receiptToken: packet?.receiptToken };
            if (!validReceipt(next) || packet.schemaVersion !== 1 || packet.confirmed !== true) throw new TypeError("Explicit automatic-score approval and receipt identity are required.");
            const input = structuredClone(packet), saved = JSON.stringify(next);
            try {
                storage.setItem(key, saved);
                if (storage.getItem(key) !== saved) throw new Error("Receipt retention was not confirmed.");
            } catch {
                storageBlocked = true; phase = "blocked";
                message = "The approval receipt cannot be retained in this panel. Nothing was sent.";
                throw Object.assign(new Error(message), { code: "request_rejected" });
            }
            receipt = next; phase = "pending"; requestPending = true; message = "Saving approval.";
            const started = generation;
            try {
                const result = await api(routes[kind], input);
                if (started !== generation) throw superseded();
                return accept(result);
            }
            catch (error) {
                if (started !== generation) throw superseded();
                if (error.code === "request_rejected") { phase = "not-started"; message = error.message; clearReceipt(); }
                else unknown(error);
                throw error;
            } finally { if (started === generation) requestPending = false; }
        },
        async check() {
            if (requestPending) throw new Error("An automatic-score receipt read or update is already pending.");
            if (!receipt) throw new Error("No recoverable automatic-score receipt is available.");
            requestPending = true;
            const started = generation;
            try {
                const result = await api("/api/evaluation/automatic/status", {
                    schemaVersion: 1, mutationRef: receipt.mutationRef, receiptToken: receipt.receiptToken,
                });
                if (started !== generation) throw superseded();
                return accept(result);
            } catch (error) {
                if (started !== generation) throw superseded();
                unknown(error); throw error;
            }
            finally { if (started === generation) requestPending = false; }
        },
    };
}
