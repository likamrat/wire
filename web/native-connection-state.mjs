// Serialized with the account presenter; pending identities never become new-owner authority.
export function createNativeConnectionState({ isOwnerCurrent, decodeReceipt }) {
    if (typeof isOwnerCurrent !== "function" || typeof decodeReceipt !== "function") {
        throw new TypeError("Native connection state requires current-owner and receipt validation.");
    }
    const pending = new Map(), generations = new Map();
    let error = null;
    const actions = ["microsoft-cancel", "microsoft-recover", "microsoft-connect"];
    const current = owner => owner !== null && owner !== undefined && isOwnerCurrent(owner) === true;
    const owned = operation => operation && pending.get(operation.id)?.operation === operation;
    function intent(status, owner) {
        const operations = [...pending.values()];
        if (operations.some(item => !current(item.operation.owner))) return null;
        let advertised = current(owner) && status?.microsoft ? status : null;
        if (advertised && (!Number.isSafeInteger(status.generation) || status.generation < 0 || !Array.isArray(status.microsoft.actions))) {
            throw new TypeError("Native connection state requires a current control projection.");
        }
        if (advertised && advertised.generation < (generations.get(owner) ?? 0)) advertised = null;
        if (operations.length) {
            const stopping = operations.find(item => item.operation.action !== "microsoft-connect");
            const item = stopping || operations[0];
            if (!stopping && item.operation.owner === owner && advertised?.microsoft.actions.includes("microsoft-cancel")) {
                return Object.freeze({ kind: "command", action: "microsoft-cancel", generation: status.generation, owner });
            }
            return item.inFlight ? null : Object.freeze({ kind: "receipt", id: item.operation.id, owner: item.operation.owner });
        }
        if (!advertised) return null;
        const action = actions.find(value => status.microsoft.actions.includes(value));
        return action ? Object.freeze({ kind: "command", action, generation: status.generation, owner }) : null;
    }
    function same(a, b) {
        return a && b && ["kind", "id", "action", "generation", "owner"].every(key => a[key] === b[key]);
    }
    return {
        snapshot(status, owner) {
            const operations = [...pending.values()];
            return {
                intent: intent(status, owner),
                phase: operations.some(item => !current(item.operation.owner)) ? "owner-lost"
                    : operations.some(item => item.inFlight) ? "working" : operations.length ? "unconfirmed" : "idle",
                pending: operations.map(item => ({ ...item.operation, inFlight: item.inFlight })),
                error: error && { ...error },
            };
        },
        begin(expected, status, owner, operationId) {
            if (!same(expected, intent(status, owner))) { error = { code: "changed" }; return null; }
            error = null;
            if (expected.kind === "receipt") {
                const item = pending.get(expected.id);
                item.inFlight = true;
                return item.operation;
            }
            if (typeof operationId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(operationId)
                || pending.has(operationId)) throw new TypeError("A new native connection action requires a new UUID.");
            const operation = Object.freeze({ id: operationId, action: expected.action,
                generation: expected.generation, owner: expected.owner });
            pending.set(operation.id, { operation, inFlight: true });
            return operation;
        },
        received(operation, value) {
            if (!owned(operation) || !current(operation.owner)) return false;
            if (value === null) { error = { code: "unconfirmed" }; return false; }
            const receipt = decodeReceipt(value, operation);
            generations.set(operation.owner, Math.max(generations.get(operation.owner) ?? 0, receipt.generation));
            if (["pending", "ambiguous"].includes(receipt.outcome)) { error = { code: "unconfirmed" }; return false; }
            pending.delete(operation.id);
            error = receipt.outcome === "completed" ? null : { code: "failed", reason: receipt.reason };
            return true;
        },
        failed(operation, { rejected = false } = {}) {
            if (!owned(operation)) return;
            if (rejected) pending.delete(operation.id);
            error = { code: rejected ? "not-started" : "unconfirmed" };
        },
        finished(operation) {
            if (owned(operation)) pending.get(operation.id).inFlight = false;
        },
        dispose() { pending.clear(); generations.clear(); error = null; },
    };
}
