import { randomBytes } from "node:crypto";
import { BoardError } from "./store.mjs";
import { createCopilotProfileIdentity, unavailableIdentity } from "./github-profile-identity.mjs";
import { createProfileCache, fetchPublicProfile, fetchPublicAvatar, profileAccountKey, ProfileError } from "./github-profile-public.mjs";

const freshMs = 6 * 60 * 60 * 1000;
const maxAgeMs = 7 * 24 * 60 * 60 * 1000;
const retryMs = 15 * 60 * 1000;
const token = () => randomBytes(32).toString("hex");

export function createGitHubProfile(context, options = {}) {
    const cache = createProfileCache(context), now = options.now ?? Date.now;
    const identitySource = createCopilotProfileIdentity({ ...options.copilot, now });
    let identity = unavailableIdentity(), account = null, record = null, generation = token(), pending, controller;
    let nextFetch = 0, closed = false, epoch = 0, issues = [], avatarReason = "identity-unavailable", freshness = "unavailable";

    function view() {
        if (identity.expiresAt !== undefined && now() >= identity.expiresAt) {
            reset(); identity = unavailableIdentity("account-snapshot-expired");
        }
        const verified = identity.state === "verified";
        issues = [...new Set(issues)];
        return {
            schemaVersion: 1, provider: "github", generation, identity: { ...identity },
            displayName: { value: record?.profile.displayName ?? null, source: record?.profile.displayName ? "github-public-profile" : "unavailable", freshness },
            avatar: { state: record?.avatar ? freshness : "unavailable", revision: record?.avatar ? `${generation}.${record.avatar.digest}` : null, reason: record?.avatar ? null : avatarReason },
            fallback: verified ? { kind: "initials", text: identity.login[0].toUpperCase(), source: "verified-login" }
                : { kind: "neutral", text: null, source: "unavailable" },
            issues: [...issues],
        };
    }
    function reset() {
        epoch++; generation = token(); record = null; account = null; nextFetch = 0; freshness = "unavailable";
        identity = unavailableIdentity(); avatarReason = "identity-unavailable"; issues = [];
        controller?.abort();
    }
    async function identify() {
        const observedEpoch = epoch;
        const next = await identitySource.read();
        if (closed || observedEpoch !== epoch) return false;
        const key = next.state === "verified" ? profileAccountKey(next) : null;
        const snapshotChanged = key !== null && key === account && next.generation !== identity.generation;
        if (key !== account || snapshotChanged) {
            const previous = account;
            reset(); account = key;
            const changedEpoch = epoch;
            if (previous) {
                try { await cache.clear(); } catch { issues.push("cache-clear-failed"); }
            }
            if (closed || changedEpoch !== epoch) return false;
        }
        identity = next;
        return key !== null;
    }
    async function update() {
        if (closed || !await identify()) return view();
        const expectedEpoch = epoch;
        if (!record && nextFetch === 0) {
            let cached;
            try { cached = await cache.read(identity, now(), maxAgeMs); }
            catch { issues.push("cache-read-failed"); }
            if (closed || expectedEpoch !== epoch) return view();
            record = cached ?? null;
            if (record) {
                freshness = now() - record.fetchedAt < freshMs ? "current" : "cached";
                nextFetch = record.fetchedAt + freshMs;
                avatarReason = "avatar-missing";
            }
        }
        if (record && now() - record.fetchedAt > maxAgeMs) { record = null; freshness = "unavailable"; generation = token(); }
        if (now() < nextFetch) { await identify(); return view(); }
        const expectedAccount = account;
        controller = new AbortController();
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.requestTimeoutMs ?? 5000)]);
        let candidate;
        let failure;
        let photoFailure = "avatar-missing";
        try {
            const result = await fetchPublicProfile(identity, { fetch: options.fetch, signal });
            candidate = { profile: result.profile, avatar: null, fetchedAt: now() };
            if (result.avatarSource) {
                try { candidate.avatar = await fetchPublicAvatar(result.avatarSource, result.profile.id, { fetch: options.fetch, signal }); }
                catch (error) { photoFailure = error instanceof ProfileError ? error.code : signal.aborted ? "avatar-timeout" : "avatar-offline"; }
            }
        } catch (error) { failure = error instanceof ProfileError ? error.code : signal.aborted ? "profile-timeout" : "profile-offline"; }
        // Metadata is checked again before any fetched/cached account data is published.
        if (closed || expectedEpoch !== epoch || !await identify() || account !== expectedAccount || expectedEpoch !== epoch) return view();
        controller = undefined;
        if (failure) {
            issues.push(failure); nextFetch = now() + retryMs;
            if (!["profile-timeout", "profile-offline", "profile-rate-limited", "profile-http-error"].includes(failure)) {
                record = null; generation = token();
                try { await cache.clear(); } catch { issues.push("cache-clear-failed"); }
            }
            freshness = record ? "cached" : "unavailable"; avatarReason = failure;
        } else {
            record = candidate; generation = token(); freshness = "current"; issues = [];
            avatarReason = record.avatar ? null : photoFailure;
            if (!record.avatar && photoFailure !== "avatar-missing") issues.push(photoFailure);
            nextFetch = now() + (record.avatar || photoFailure === "avatar-missing" ? freshMs : retryMs);
            if (record.avatar || photoFailure === "avatar-missing") {
                try { await cache.write(identity, record); } catch { issues.push("cache-write-failed"); }
            } else {
                try { await cache.clear(); } catch { issues.push("cache-clear-failed"); }
            }
            if (closed || expectedEpoch !== epoch) return view();
        }
        return view();
    }
    return {
        read() {
            if (!pending) {
                const operation = update();
                pending = operation;
                const clear = () => { if (pending === operation) pending = undefined; };
                void operation.then(clear, clear);
            }
            return pending;
        },
        async image(revision) {
            await this.read();
            this.assertImageCurrent(revision);
            return { bytes: Buffer.from(record.avatar.bytes), contentType: record.avatar.contentType };
        },
        assertImageCurrent(revision) {
            if (closed || identity.expiresAt !== undefined && now() >= identity.expiresAt
                || !record?.avatar || revision !== `${generation}.${record.avatar.digest}`) throw new BoardError("GitHub profile image is unavailable or changed.", 404);
        },
        invalidate() { identitySource.invalidate(); reset(); },
        async close() { closed = true; identitySource.close(); reset(); await pending; },
    };
}
