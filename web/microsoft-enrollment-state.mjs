export function createMicrosoftEnrollmentState() {
    let offer = null, pending = null, uncertain = false;
    function decode(value) {
        const keys = ["schemaVersion", "phase", "generation", "actions", "reason"];
        if (!value || Object.getPrototypeOf(value) !== Object.prototype
            || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))
            || value.schemaVersion !== 1 || !Number.isSafeInteger(value.generation) || value.generation < 0
            || !["available", "prepared", "unavailable"].includes(value.phase)
            || JSON.stringify(value.actions) !== JSON.stringify(value.phase === "available" ? ["prepare"] : [])
            || value.reason !== (value.phase === "available" ? null
                : value.phase === "prepared" ? "source-already-configured" : "enrollment-unavailable")) {
            throw new TypeError("Microsoft connection setup status is invalid.");
        }
        return { ...value, actions: [...value.actions] };
    }
    function view(generation) {
        const current = Boolean(offer && offer.generation === generation);
        return { phase: current ? offer.phase : null, pending: Boolean(pending), uncertain,
            canPrepare: current && offer.phase === "available" && !pending && !uncertain };
    }
    function receive(value, generation) {
        offer = null;
        const next = decode(value);
        if (next.generation !== generation) { offer = null; return false; }
        offer = next;
        return true;
    }
    const owns = command => pending?.operationId === command.operationId && pending.generation === command.generation;
    return {
        view, receive,
        begin(generation, operationId) {
            if (!view(generation).canPrepare || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(operationId)) {
                throw new Error("Read current Microsoft connection setup before connecting.");
            }
            pending = { operationId, generation };
            return { schemaVersion: 2, generation, operationId };
        },
        completed(command, value, generation) {
            if (!owns(command) || pending.retired) return false;
            if (!receive(value, generation) || offer.phase !== "prepared") throw new Error("Microsoft setup was not confirmed.");
            pending = null; uncertain = false; return true;
        },
        failed(command, { rejected = false } = {}) {
            if (!owns(command)) return;
            pending = null; uncertain ||= !rejected;
        },
        withdraw() {
            offer = null;
            if (pending) { pending.retired = true; uncertain = true; }
        },
    };
}
