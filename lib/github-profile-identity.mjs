const loginPattern = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;
export const COPILOT_ACCOUNT_SNAPSHOT_SOURCE = "copilot-host-active-account";
export const COPILOT_ACCOUNT_LEASE_MS = 15000;

export function validGitHubLogin(value) {
    return typeof value === "string" && loginPattern.test(value) && !value.includes("--");
}

export function unavailableIdentity(reason = "account-match-unavailable") {
    return { state: "unavailable", reason, host: null, login: null };
}

export function copilotIdentityFromStatus(status) {
    if (!status || typeof status.isAuthenticated !== "boolean") return unavailableIdentity("auth-status-invalid");
    if (!status.isAuthenticated) return { ...unavailableIdentity("copilot-signed-out"), state: "signed-out" };
    if (status.authType !== "user") return unavailableIdentity("auth-source-unverified");
    if (!["github.com", "https://github.com", "https://github.com/"].includes(status.host)) return unavailableIdentity("github-host-unsupported");
    if (!validGitHubLogin(status.login)) return unavailableIdentity("auth-status-invalid");
    return { state: "verified", reason: null, host: "github.com", login: status.login };
}

function identityFromSnapshot(snapshot, now) {
    if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.source !== COPILOT_ACCOUNT_SNAPSHOT_SOURCE
        || snapshot.scope !== "existing-host-session" || !/^[a-f0-9]{32}\.[1-9]\d{0,15}$/.test(snapshot.generation ?? "")) {
        return unavailableIdentity("account-snapshot-invalid");
    }
    if (snapshot.state === "unavailable") return unavailableIdentity("account-snapshot-unavailable");
    if (!Number.isSafeInteger(snapshot.checkedAt) || !Number.isSafeInteger(snapshot.expiresAt)
        || snapshot.checkedAt > now || snapshot.expiresAt <= now || snapshot.expiresAt <= snapshot.checkedAt
        || snapshot.expiresAt - snapshot.checkedAt > COPILOT_ACCOUNT_LEASE_MS) return unavailableIdentity("account-snapshot-expired");
    let identity;
    if (snapshot.state === "signed-out") identity = { ...unavailableIdentity("copilot-signed-out"), state: "signed-out" };
    else if (snapshot.state === "observed") identity = copilotIdentityFromStatus({
        isAuthenticated: true, authType: snapshot.authType, host: snapshot.host, login: snapshot.login,
    });
    else return unavailableIdentity("account-snapshot-invalid");
    return { ...identity, generation: snapshot.generation, checkedAt: snapshot.checkedAt, expiresAt: snapshot.expiresAt };
}

// Only the host integration can establish this binding. A newly spawned CLI,
// environment token, browser input or filesystem account name is not a binding.
export function createCopilotProfileIdentity({ binding, getAuthStatus, readSnapshot, timeoutMs = 2000, now = Date.now } = {}) {
    const source = typeof readSnapshot === "function" ? readSnapshot : getAuthStatus;
    if (binding !== "copilot-app" || typeof source !== "function") return { read: async () => unavailableIdentity(), invalidate() {}, close() {} };
    let pending, epoch = 0, closed = false;
    return {
        async read() {
            if (closed) return unavailableIdentity("identity-source-closed");
            const expected = epoch;
            if (!pending) {
                const request = { epoch: expected, expired: false, promise: Promise.resolve().then(source)
                    .then(value => typeof readSnapshot === "function" ? identityFromSnapshot(value, now()) : copilotIdentityFromStatus(value))
                    .catch(() => unavailableIdentity("auth-status-unavailable")) };
                pending = request;
                void request.promise.finally(() => { if (pending === request) pending = undefined; });
            }
            const request = pending;
            if (request.epoch !== expected) return unavailableIdentity("identity-source-invalidated");
            if (request.expired) return unavailableIdentity("auth-status-timeout");
            let timer;
            try {
                const result = await Promise.race([request.promise, new Promise(resolve => {
                    timer = setTimeout(() => { request.expired = true; resolve(unavailableIdentity("auth-status-timeout")); }, timeoutMs);
                })]);
                return closed || epoch !== expected ? unavailableIdentity("identity-source-invalidated")
                    : request.expired ? unavailableIdentity("auth-status-timeout") : result;
            } finally { clearTimeout(timer); }
        },
        invalidate() { epoch++; },
        close() { closed = true; epoch++; },
    };
}
