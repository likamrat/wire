const repo = "likamrat/wire";
export const releaseTag = /^v(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
export function newerRelease(tag, previous) {
    if (!releaseTag.test(tag) || !releaseTag.test(previous)) return false;
    const a = tag.slice(1).split(".").map(Number), b = previous.slice(1).split(".").map(Number);
    return a.some((n, i) => n > b[i] && a.slice(0, i).every((v, j) => v === b[j]));
}
export const releaseUrl = tag => `https://github.com/${repo}/releases/tag/${tag}`;
export const releaseFailure = message => Object.assign(new Error(message), { code: "WIRE_UPDATE_FAILED" });

async function request(fetcher, url, options) {
    let response;
    try {
        response = await fetcher(url, { credentials: "omit", cache: "no-cache", signal: AbortSignal.timeout(15000), ...options });
    } catch { throw Object.assign(releaseFailure("Could not reach GitHub to check published WIRE releases. Check your network and try again."), { temporary: true }); }
    if (response.status >= 400 && response.status !== 404) {
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
        error.temporary = exhausted || code === 429 || code >= 500 || deadline > now;
        throw error;
    }
    return response;
}

// GitHub's documented Latest link selects the published release. Inspect that
// one redirect only; neither a tag listing nor HTML is a publication record.
export async function latestPublicTag(fetcher = fetch) {
    const response = await request(fetcher, `https://github.com/${repo}/releases/latest`, { method: "HEAD", redirect: "manual" });
    const location = response.headers.get("location"), tag = location?.split("/").at(-1);
    if (![301,302,303,307,308].includes(response.status) || !releaseTag.test(tag ?? "")
        || location !== releaseUrl(tag) && location !== `/${repo}/releases/tag/${tag}`) {
        throw releaseFailure(`GitHub did not identify a latest stable WIRE release (HTTP ${response.status}). Nothing was installed.`);
    }
    return tag;
}

// The maintainer's preparation command requests Latest. Installed apps use the
// REST endpoint only for a newly verified tag's optional publisher-written notes.
export const latestRelease = (fetcher = fetch) => readReleaseRecord(fetcher);
export const publishedNotes = async (tag, fetcher = fetch) => (await readReleaseRecord(fetcher, tag)).notes;
async function readReleaseRecord(fetcher, tag) {
    if (tag !== undefined && !releaseTag.test(tag)) throw releaseFailure("Invalid WIRE release tag.");
    const response = await request(fetcher, `https://api.github.com/repos/${repo}/releases/${tag ? `tags/${tag}` : "latest"}`,
        { headers: { Accept: "application/vnd.github+json" }, redirect: "error" });
    if (response.status === 404 && !tag) return null;
    if (!response.ok) throw releaseFailure(`GitHub could not confirm the published WIRE release (HTTP ${response.status}).`);
    const reader = response.body?.getReader();
    const notesFailure = message => Object.assign(releaseFailure(message), { temporary: Boolean(tag) });
    if (!reader) throw notesFailure("GitHub returned an empty release response.");
    const chunks = [];
    let size = 0;
    try {
        for (;;) {
            const {done,value} = await reader.read().catch(() => { throw notesFailure("The GitHub release response was interrupted."); });
            if (done) break;
            if ((size += value.length) > 512 * 1024) {
                await reader.cancel();
                throw notesFailure("The GitHub release response exceeded the size limit.");
            }
            chunks.push(value);
        }
    } finally { reader.releaseLock(); }
    let record;
    try { record = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw notesFailure("GitHub returned an unreadable WIRE release."); }
    if (!record || record.draft !== false || record.prerelease !== false || !record.published_at || tag && record.tag_name !== tag
        || typeof record.tag_name !== "string" || !releaseTag.test(record.tag_name)
        || record.html_url !== releaseUrl(record.tag_name)) throw releaseFailure("The published WIRE release has no usable stable version.");
    if (typeof record.body !== "string" || !record.body.trim() || record.body.length > 64000)
        throw notesFailure("The published WIRE release has no usable release notes.");
    return { tag: record.tag_name, notes: record.body, url: record.html_url };
}
