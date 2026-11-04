import { randomBytes } from "node:crypto";
import { copilotIdentityFromStatus, COPILOT_ACCOUNT_SNAPSHOT_SOURCE, COPILOT_ACCOUNT_LEASE_MS } from "./github-profile-identity.mjs";

function unavailable(reason) {
    return { state: "unavailable", reason, host: null, login: null, authType: null };
}

function activeAccount(value) {
    if (!value || value.kind !== "activeAccount") return unavailable("active-account-invalid");
    if (value.account == null && value.authInfo == null) return { ...unavailable("copilot-signed-out"), state: "signed-out" };
    const account = value.account, auth = value.authInfo;
    if (!account || !auth || account.active !== true || account.kind !== "githubDotCom"
        || typeof account.selectionId !== "string" || !account.selectionId || account.selectionId.length > 1024) {
        return unavailable("active-account-unqualified");
    }
    const selected = copilotIdentityFromStatus({ isAuthenticated: true, authType: auth.type, host: account.host, login: account.login });
    const effective = copilotIdentityFromStatus({ isAuthenticated: true, authType: auth.type, host: auth.host, login: auth.login });
    if (selected.state !== "verified" || effective.state !== "verified") return unavailable("active-account-source-unverified");
    if (selected.host !== effective.host || selected.login.toLowerCase() !== effective.login.toLowerCase()) return unavailable("active-account-conflict");
    return {
        state: "observed", reason: null, host: selected.host, login: selected.login, authType: "user",
        selectionId: account.selectionId,
    };
}

function fingerprint(value) {
    return JSON.stringify([value.state, value.reason, value.host, value.login?.toLowerCase(), value.authType, value.selectionId]);
}

// Read only the already-joined host. No session creation, credentials, account
// enumeration, model call or host event is required for this bounded snapshot.
export function createCopilotAccountSnapshot(getSession, { now = Date.now, timeoutMs = 1800 } = {}) {
    const instance = randomBytes(16).toString("hex");
    let revision = 1, last, lastSession, lastSessionId, pending, epoch = 0, closed = false;
    function project(value, checkedAt) {
        const key = fingerprint(value);
        if (last !== key) { if (last !== undefined) revision++; last = key; }
        return {
            schemaVersion: 1, source: COPILOT_ACCOUNT_SNAPSHOT_SOURCE, scope: "existing-host-session",
            state: value.state, reason: value.reason, host: value.host, login: value.login, authType: value.authType,
            generation: `${instance}.${revision}`, checkedAt,
            expiresAt: value.state === "unavailable" ? checkedAt : checkedAt + COPILOT_ACCOUNT_LEASE_MS,
        };
    }
    return {
        read() {
            if (closed) return Promise.resolve(project(unavailable("host-reader-closed"), now()));
            let session;
            try { session = getSession(); }
            catch { return Promise.resolve(project(unavailable("host-snapshot-unavailable"), now())); }
            const sessionId = session?.sessionId;
            if (session !== lastSession || sessionId !== lastSessionId) {
                lastSession = session; lastSessionId = sessionId; epoch++; revision++; last = undefined;
            }
            if (pending) return pending.result;
            const expected = epoch, checkedAt = now();
            if (!session?.rpc?.accounts?.get || !session?.rpc?.gitHubAuth?.getStatus) {
                return Promise.resolve(project(unavailable("host-snapshot-unsupported"), checkedAt));
            }
            let retired = false, timer;
            const request = {};
            const sameSession = () => {
                try { return getSession() === session && session.sessionId === sessionId; } catch { return false; }
            };
            const current = () => !closed && epoch === expected && sameSession() && !retired;
            const work = (async () => {
                const first = activeAccount(await session.rpc.accounts.get({ query: { kind: "activeAccount" } }));
                if (!current()) return unavailable("host-snapshot-invalidated");
                if (first.state === "unavailable") return first;
                const status = copilotIdentityFromStatus(await session.rpc.gitHubAuth.getStatus());
                if (!current()) return unavailable("host-snapshot-invalidated");
                const second = activeAccount(await session.rpc.accounts.get({ query: { kind: "activeAccount" } }));
                if (!current()) return unavailable("host-snapshot-invalidated");
                if (fingerprint(first) !== fingerprint(second)) return unavailable("active-account-changed");
                if (first.state === "signed-out") return status.state === "signed-out" ? first : unavailable("session-account-conflict");
                if (status.state !== "verified" || status.host !== first.host || status.login.toLowerCase() !== first.login.toLowerCase()) {
                    return unavailable("session-account-conflict");
                }
                return second;
            })().catch(() => unavailable("host-snapshot-unavailable"));
            let workDone = false, resultDone = false;
            const clear = () => { if (workDone && resultDone && pending === request) pending = undefined; };
            void work.then(() => { workDone = true; clear(); });
            request.result = Promise.race([work, new Promise(resolve => {
                timer = setTimeout(() => { retired = true; resolve(unavailable("host-snapshot-timeout")); }, timeoutMs);
            })]).then(value => {
                if (closed || epoch !== expected || !sameSession()) value = unavailable("host-snapshot-invalidated");
                if (now() - checkedAt >= COPILOT_ACCOUNT_LEASE_MS || now() < checkedAt) value = unavailable("host-snapshot-expired");
                return project(value, checkedAt);
            }).finally(() => { clearTimeout(timer); resultDone = true; clear(); });
            pending = request;
            return request.result;
        },
        invalidate() { epoch++; revision++; last = undefined; },
        close() { closed = true; epoch++; revision++; last = undefined; },
    };
}

// The binding is a trusted host's qualification decision, never tool/browser input.
export function createCopilotAccountBridge(getSession, { expectedSessionId, binding, ...options } = {}) {
    const validSessionId = value => typeof value === "string" && value.length > 0 && value.length <= 1024 && value.trim() === value;
    if (typeof getSession !== "function"
        || expectedSessionId !== undefined && !validSessionId(expectedSessionId)
        || binding !== undefined && (binding !== "copilot-app" || !validSessionId(expectedSessionId))) {
        throw new TypeError("A qualified Copilot account bridge requires an explicit existing host-session pin.");
    }
    let closed = false;
    function boundSession() {
        if (closed) return undefined;
        try {
            const session = getSession();
            return validSessionId(session?.sessionId)
                && (expectedSessionId === undefined || session.sessionId === expectedSessionId) ? session : undefined;
        } catch { return undefined; }
    }
    const reader = createCopilotAccountSnapshot(boundSession, options);
    const rejected = () => ({
        resultType: "rejected",
        textResultForLlm: "Account snapshot requires empty input and the current bound host session; no account result.",
    });
    return {
        copilot: Object.freeze({ binding, readSnapshot: () => reader.read() }),
        tool: {
            name: "wire_github_account_snapshot",
            description: "Read bounded, credential-free current-account metadata from this existing Copilot host for identity qualification. This is not an app-account binding attestation and does not enable WIRE profile lookup.",
            parameters: { type: "object", additionalProperties: false, properties: {}, required: [] },
            async handler(input, invocation) {
                if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length) return rejected();
                const session = boundSession(), sessionId = session?.sessionId;
                if (!session || invocation?.sessionId !== sessionId) { reader.invalidate(); return rejected(); }
                const snapshot = await reader.read();
                if (boundSession() !== session || session.sessionId !== sessionId || invocation?.sessionId !== sessionId) {
                    reader.invalidate(); return rejected();
                }
                return { resultType: "success", textResultForLlm: JSON.stringify(snapshot) };
            },
        },
        invalidate() { reader.invalidate(); },
        close() { closed = true; reader.close(); },
    };
}
