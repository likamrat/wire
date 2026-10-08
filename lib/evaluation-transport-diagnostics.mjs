import { boundedNumericErrorCode } from "./evaluation-diagnostics.mjs";

// The installed SDK passes this owned connection to the session; observe no payload or response text.
export function observeSessionSendRpc(connection) {
    if (!connection || typeof connection.sendRequest !== "function") {
        throw Object.assign(new TypeError("The installed SDK transport cannot be observed."), { code: "evaluator-transport-observer-unavailable" });
    }
    const original = connection.sendRequest;
    let calls = 0, state = "not-observed", started, ended, messageIdReturned = false, numericErrorCode = null, restored = false;
    function observed(...args) {
        if (args[0] !== "session.send") return Reflect.apply(original, this, args);
        calls++;
        if (calls > 1) return Reflect.apply(original, this, args);
        started = performance.now(); state = "pending";
        const failed = error => {
            ended = performance.now(); state = "rejected"; numericErrorCode = boundedNumericErrorCode(error?.code);
            throw error;
        };
        let result;
        try { result = Reflect.apply(original, this, args); } catch (error) { return failed(error); }
        return Promise.resolve(result).then(value => {
            ended = performance.now(); state = "resolved"; messageIdReturned = typeof value?.messageId === "string" && value.messageId.length > 0;
            return value;
        }, failed);
    }
    connection.sendRequest = observed;
    return {
        snapshot: () => ({ origin: "sdk-rpc-call", method: "session.send", calls, state, messageIdReturned, numericErrorCode,
            elapsedMs: started === undefined ? null : Math.round(((ended ?? performance.now()) - started) * 1000) / 1000 }),
        restore() {
            if (restored) return;
            if (connection.sendRequest !== observed) throw new Error("SDK transport observer changed; restoration refused.");
            connection.sendRequest = original; restored = true;
        },
    };
}
