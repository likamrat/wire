// The shared transport owns access. This owner only schedules guarded presentation reads.
export function createAccountProfile({ api, present, provider = "github", visible = () => true }) {
    if (typeof api !== "function" || typeof present !== "function"
        || !["github", "microsoft"].includes(provider)
        || ["accessState", "publicationToken", "isCurrent"].some(name => typeof api[name] !== "function")) {
        throw new TypeError("Account profiles require the shared publication interface.");
    }
    let token = null, revision = 0, pending = null, again = false, timer, disposed = false, connection = null;
    let currentUntil = 0;
    const synchronous = value => value !== null && value !== undefined && typeof value.then !== "function";
    function current(owner, version) {
        return !disposed && visible() && synchronous(owner) && token === owner && revision === version
            && api.isCurrent(owner) === true && !disposed && token === owner && revision === version;
    }
    function withdrawAccess() {
        revision++; token = null; again = false; connection = null; currentUntil = 0;
        clearTimeout(timer);
    }
    function refresh() {
        const owner = token, version = revision;
        if (!current(owner, version)) return Promise.resolve(false);
        if (pending) {
            again ||= pending.owner !== owner || pending.version !== version;
            return pending.promise;
        }
        clearTimeout(timer);
        const request = { owner, version };
        pending = request;
        request.promise = (async () => {
            try {
                if (Date.now() >= currentUntil && present({ phase: "loading", profile: null }, owner) !== true
                    || !current(owner, version)) return false;
                const profile = await api("/api/profile/" + provider);
                if (!current(owner, version)) return false;
                if (present({ phase: "ready", profile }, owner) !== true || !current(owner, version)) return false;
                currentUntil = provider === "github" && profile.identity?.state === "verified"
                    ? Math.min(...[profile.identity.expiresAt, profile.avatar?.expiresAt].filter(Number.isFinite)) : 0;
                if (profile.identity?.state === "verified" || Number.isFinite(profile.refreshAt)) {
                    const deadlines = [Date.now() + 15000, profile.refreshAt, profile.identity.expiresAt, profile.avatar?.expiresAt]
                        .filter(value => Number.isFinite(value));
                    const deadline = Math.min(...deadlines);
                    const remaining = deadline - Date.now();
                    // Renew before presentation expiry; its hard clearing timers stay in force.
                    const lead = provider === "github" && profile.identity?.state === "verified" ? Math.min(5000, remaining / 2) : 0;
                    if (remaining > 0) timer = setTimeout(() => { void refresh(); }, remaining - lead);
                }
                return true;
            } catch {
                if (current(owner, version)) { currentUntil = 0; present({ phase: "error", profile: null }, owner); }
                return false;
            } finally {
                if (pending === request) pending = null;
                if (again && !disposed) { again = false; void refresh(); }
            }
        })();
        return request.promise;
    }
    function receiveAccess() {
        if (disposed) return Promise.resolve(false);
        const view = api.accessState(), candidate = api.publicationToken();
        if (view.mode !== "enforced" || !view.readable || !visible() || !synchronous(candidate)
            || provider === "microsoft" && view.collectionMode !== "source-aware") {
            withdrawAccess(); return Promise.resolve(false);
        }
        const nextConnection = provider === "microsoft" ? view.state?.microsoft?.state ?? "unavailable" : null;
        if (candidate === token && nextConnection === connection) return pending?.promise ?? Promise.resolve(false);
        withdrawAccess(); token = candidate; connection = nextConnection;
        return refresh();
    }
    return {
        receiveAccess, refresh, withdrawAccess,
        dispose() { withdrawAccess(); disposed = true; },
    };
}
