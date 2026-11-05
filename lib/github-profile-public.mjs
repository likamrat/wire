import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink, lstat } from "node:fs/promises";
import path from "node:path";
import { dataDirFor } from "./paths.mjs";
import { writeExclusive } from "./store.mjs";
import { validGitHubLogin } from "./github-profile-identity.mjs";
import { validSourceProfileLogin } from "./source-profile.mjs";

export const PROFILE_MAX_BYTES = 32768;
export const AVATAR_MAX_BYTES = 256 * 1024;
const cacheLimit = AVATAR_MAX_BYTES * 2;
const maxDimension = 512;

export class ProfileError extends Error {
    constructor(code) { super(code); this.code = code; }
}

export function profileAccountKey(identity) {
    const source = identity.source === "copilot-app-profile" ? `\0${identity.source}\0${identity.generation}` : "";
    return createHash("sha256").update(`github-profile-v1\0${identity.host}\0${identity.login.toLowerCase()}${source}`).digest("hex");
}

function validName(value) {
    return value === null || typeof value === "string" && value.length <= 200 && value.trim() === value && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function validProfile(profile, login, fromApp = false) {
    return profile && (Number.isSafeInteger(profile.id) && profile.id > 0 || fromApp && profile.id === null)
        && (fromApp ? validSourceProfileLogin(profile.login) : validGitHubLogin(profile.login))
        && profile.login.toLowerCase() === login.toLowerCase() && validName(profile.displayName);
}

export function validateAvatar(bytes, contentType) {
    if (!Buffer.isBuffer(bytes) || bytes.length > AVATAR_MAX_BYTES) throw new ProfileError("avatar-invalid");
    let width = 0, height = 0;
    if (contentType === "image/png" && bytes.length >= 33
        && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        && bytes.readUInt32BE(8) === 13 && bytes.toString("ascii", 12, 16) === "IHDR") {
        width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    } else if (contentType === "image/jpeg" && bytes.length >= 4 && bytes.readUInt16BE(0) === 0xffd8
        && bytes.readUInt16BE(bytes.length - 2) === 0xffd9) {
        let offset = 2;
        while (offset + 4 <= bytes.length) {
            if (bytes[offset++] !== 0xff) break;
            while (bytes[offset] === 0xff) offset++;
            const marker = bytes[offset++];
            if ([0xda, 0xd9].includes(marker)) break;
            const length = bytes.readUInt16BE(offset);
            if (length < 2 || offset + length > bytes.length) break;
            if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
                height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
            }
            offset += length;
        }
    }
    if (!width || !height || width > maxDimension || height > maxDimension) throw new ProfileError("avatar-invalid");
    return { bytes, contentType, digest: createHash("sha256").update(bytes).digest("hex") };
}

function avatarURL(value, id, base) {
    let url;
    try { url = new URL(value, base); } catch { throw new ProfileError("avatar-source-untrusted"); }
    if (url.protocol !== "https:" || url.hostname !== "avatars.githubusercontent.com" || url.port || url.username || url.password
        || url.hash || url.pathname !== `/u/${id}` || [...url.searchParams].some(([key, value]) => !["s", "v"].includes(key) || !/^\d{1,6}$/.test(value))) {
        throw new ProfileError("avatar-source-untrusted");
    }
    url.searchParams.set("s", "96");
    return url;
}

export function avatarSourceAccountId(value) {
    let parsed;
    try { parsed = new URL(value); } catch { throw new ProfileError("avatar-source-untrusted"); }
    const match = /^\/u\/([1-9]\d{0,15})$/.exec(parsed.pathname), id = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(id)) throw new ProfileError("avatar-source-untrusted");
    avatarURL(value, id);
    return id;
}

async function abortable(operation, signal) {
    signal.throwIfAborted();
    let abort;
    const cancelled = new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
    });
    try { return await Promise.race([operation, cancelled]); }
    finally { signal.removeEventListener("abort", abort); }
}

async function boundedBody(response, maxBytes, code, signal) {
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
        await response.body?.cancel();
        throw new ProfileError(code);
    }
    if (!response.body) throw new ProfileError(code);
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
        while (true) {
            signal.throwIfAborted();
            const { done, value } = await abortable(reader.read(), signal);
            if (done) break;
            size += value.length;
            if (size > maxBytes) throw new ProfileError(code);
            chunks.push(value);
        }
    } finally { await reader.cancel(); reader.releaseLock(); }
    return Buffer.concat(chunks, size);
}

function requestOptions(signal, accept) {
    return {
        method: "GET", redirect: "manual", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal,
        headers: { Accept: accept, "User-Agent": "WIRE-local-profile" },
    };
}

async function requireOK(response, kind) {
    if (response.ok) return;
    await response.body?.cancel();
    throw new ProfileError(response.status === 404 ? `${kind}-missing`
        : [403, 429].includes(response.status) ? `${kind}-rate-limited`
            : response.status >= 300 && response.status < 400 ? `${kind}-redirect-denied`
                : response.status < 500 ? `${kind}-unavailable` : `${kind}-http-error`);
}

export async function fetchPublicProfile(identity, { fetch: fetcher = globalThis.fetch, signal } = {}) {
    const response = await abortable(fetcher(`https://api.github.com/users/${encodeURIComponent(identity.login)}`, requestOptions(signal, "application/vnd.github+json")), signal);
    await requireOK(response, "profile");
    if (!/^application\/(?:json|vnd\.github\+json)(?:;|$)/i.test(response.headers.get("content-type") ?? "")) {
        await response.body?.cancel(); throw new ProfileError("profile-invalid");
    }
    let body;
    try { body = JSON.parse((await boundedBody(response, PROFILE_MAX_BYTES, "profile-too-large", signal)).toString("utf8")); }
    catch (error) { if (error instanceof SyntaxError) throw new ProfileError("profile-invalid"); throw error; }
    const profile = { id: body?.id, login: body?.login, displayName: typeof body?.name === "string" ? body.name.trim() || null : null };
    if (!validProfile(profile, identity.login) || body.type !== "User") throw new ProfileError("profile-account-mismatch");
    return { profile, avatarSource: body.avatar_url || null };
}

export async function fetchPublicAvatar(source, id, { fetch: fetcher = globalThis.fetch, signal } = {}) {
    let url = avatarURL(source, id);
    for (let hop = 0; hop <= 2; hop++) {
        const response = await abortable(fetcher(url.href, requestOptions(signal, "image/png,image/jpeg")), signal);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
            await response.body?.cancel();
            if (hop === 2) throw new ProfileError("avatar-redirect-limit");
            const location = response.headers.get("location");
            if (!location) throw new ProfileError("avatar-source-untrusted");
            url = avatarURL(location, id, url);
            continue;
        }
        await requireOK(response, "avatar");
        const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
        if (!["image/png", "image/jpeg"].includes(contentType)) {
            await response.body?.cancel(); throw new ProfileError("avatar-type-unsupported");
        }
        return validateAvatar(await boundedBody(response, AVATAR_MAX_BYTES, "avatar-too-large", signal), contentType);
    }
}

export function createProfileCache(context) {
    const directory = path.join(dataDirFor(context), "github-profile");
    const file = path.join(directory, "profile.json");
    return {
        async read(identity, now, maxAge) {
            let handle;
            try {
                const info = await lstat(file);
                if (!info.isFile() || info.isSymbolicLink() || info.size > cacheLimit) throw new ProfileError("cache-invalid");
                handle = await open(file, "r");
                const buffer = Buffer.alloc(cacheLimit + 1);
                let count = 0;
                while (count < buffer.length) {
                    const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null);
                    if (!bytesRead) break;
                    count += bytesRead;
                }
                if (count > cacheLimit) throw new ProfileError("cache-invalid");
                const cached = JSON.parse(buffer.subarray(0, count).toString("utf8"));
                if (cached.schemaVersion !== 1 || cached.accountKey !== profileAccountKey(identity)) return null;
                if (!Number.isSafeInteger(cached.fetchedAt) || cached.fetchedAt > now || now - cached.fetchedAt > maxAge) return null;
                if (!validProfile(cached.profile, identity.login, identity.source === "copilot-app-profile")) throw new ProfileError("cache-invalid");
                let avatar = null;
                if (cached.avatar) {
                    if (typeof cached.avatar.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(cached.avatar.data)) throw new ProfileError("cache-invalid");
                    avatar = validateAvatar(Buffer.from(cached.avatar.data, "base64"), cached.avatar.contentType);
                    if (avatar.digest !== cached.avatar.digest) throw new ProfileError("cache-invalid");
                }
                return { profile: { id: cached.profile.id, login: cached.profile.login, displayName: cached.profile.displayName }, avatar, fetchedAt: cached.fetchedAt };
            } catch (error) {
                if (error.code === "ENOENT") return null;
                throw new ProfileError("cache-read-failed");
            } finally { await handle?.close(); }
        },
        async write(identity, record) {
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const temporary = path.join(directory, `.profile-${randomUUID()}.tmp`);
            try {
                await writeExclusive(temporary, JSON.stringify({
                    schemaVersion: 1, accountKey: profileAccountKey(identity), fetchedAt: record.fetchedAt, profile: record.profile,
                    avatar: record.avatar ? { contentType: record.avatar.contentType, digest: record.avatar.digest, data: record.avatar.bytes.toString("base64") } : null,
                }));
                await rename(temporary, file);
            } finally {
                try { await unlink(temporary); } catch (error) { if (error.code !== "ENOENT") throw new ProfileError("cache-cleanup-failed"); }
            }
        },
        async clear() {
            try { await unlink(file); } catch (error) { if (error.code !== "ENOENT") throw new ProfileError("cache-clear-failed"); }
        },
    };
}
