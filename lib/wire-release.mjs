const repo = "likamrat/wire";
export const releaseTag = /^v(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
export function newerRelease(tag, previous) {
    if (!releaseTag.test(tag) || !releaseTag.test(previous)) return false;
    const a = tag.slice(1).split(".").map(Number), b = previous.slice(1).split(".").map(Number);
    return a.some((n, i) => n > b[i] && a.slice(0, i).every((v, j) => v === b[j]));
}
export const releaseUrl = tag => `https://github.com/${repo}/releases/tag/${tag}`;
export const releaseFailure = message => Object.assign(new Error(message), { code: "WIRE_UPDATE_FAILED" });

export async function latestRelease(fetcher = fetch) {
    return (await readReleaseFeed(fetcher)).release;
}

export async function readReleaseFeed(fetcher = fetch, previous) {
    let response;
    try {
        response = await fetcher(`https://api.github.com/repos/${repo}/releases/latest`, {
            headers: { Accept: "application/vnd.github+json", ...(previous?.etag && { "If-None-Match": previous.etag }) },
            redirect: "error", signal: AbortSignal.timeout(15000),
        });
    } catch { throw releaseFailure("Could not reach GitHub to check published WIRE releases. Check your network and try again."); }
    if (response.status === 304 && previous?.etag) return previous;
    if (response.status === 404) return { release: null }; // Fixed public repository, no published stable release.
    if (!response.ok) {
        const code = response.status, now = Date.now();
        const exhausted = [403, 429].includes(code) && response.headers.get("x-ratelimit-remaining") === "0";
        const retry = response.headers.get("retry-after"), reset = response.headers.get("x-ratelimit-reset");
        const retryAfter = /^\d{1,12}$/.test(retry) ? now + Number(retry) * 1000 : retry?.endsWith(" GMT") ? Date.parse(retry) : 0;
        const resetAt = exhausted && /^\d{1,12}$/.test(reset) ? Number(reset) * 1000 : 0;
        const deadline = Math.max(Number.isFinite(retryAfter) ? retryAfter : 0, resetAt);
        const message = exhausted || code === 429 ? `GitHub's release check rate limit was reached (HTTP ${code}).`
            : deadline > now ? `GitHub asked WIRE to wait before checking releases again (HTTP ${code}).`
            : `GitHub release check failed (HTTP ${code}). Check again later.`;
        const error = releaseFailure(message);
        if (deadline > now) error.retryAt = deadline;
        throw error;
    }
    const reader = response.body?.getReader();
    if (!reader) throw releaseFailure("GitHub returned an empty release response.");
    const chunks = [];
    let size = 0;
    try {
        for (;;) {
            const {done,value} = await reader.read();
            if (done) break;
            if ((size += value.length) > 512 * 1024) {
                await reader.cancel();
                throw releaseFailure("The GitHub release response exceeded the size limit.");
            }
            chunks.push(value);
        }
    } finally { reader.releaseLock(); }
    let record;
    try { record = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw releaseFailure("GitHub returned an unreadable WIRE release."); }
    if (!record || record.draft !== false || record.prerelease !== false || !record.published_at
        || typeof record.tag_name !== "string" || !releaseTag.test(record.tag_name)
        || record.html_url !== releaseUrl(record.tag_name) || typeof record.body !== "string"
        || !record.body.trim() || record.body.length > 64000) {
        throw releaseFailure("The published WIRE release has no usable stable version or release notes.");
    }
    return { etag: response.headers.get("etag"), release: { tag: record.tag_name, notes: record.body, url: record.html_url } };
}
