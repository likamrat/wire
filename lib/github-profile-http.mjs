import { randomBytes } from "node:crypto";
import { BoardError } from "./store.mjs";

export const GITHUB_PROFILE_PATH = "/api/profile/github";
const imagePrefix = `${GITHUB_PROFILE_PATH}/avatar/`;
const lifetimeMs = 60 * 1000;

// Image tickets authorize only one panel's current avatar, never general API
// access. No account names, source URLs or panel capabilities enter image URLs.
export function createGitHubProfileRoutes(profile, { ownerActive, now = Date.now }) {
    const tickets = new Map();
    function prune() {
        for (const [owner, item] of tickets) if (now() >= item.expiresAt || !ownerActive(owner)) tickets.delete(owner);
    }
    return {
        matchesImage(url) { return url?.startsWith(imagePrefix); },
        async read(owner) {
            prune();
            const result = await profile.read();
            if (!ownerActive(owner)) throw new BoardError("Local panel connection expired.", 403);
            let url = null;
            if (result.avatar.revision) {
                let ticket = tickets.get(owner);
                if (!ticket || ticket.revision !== result.avatar.revision) {
                    if (!ticket && tickets.size >= 128) throw new BoardError("Too many active profile panels.", 429);
                    ticket = { token: randomBytes(32).toString("hex"), revision: result.avatar.revision, expiresAt: now() + lifetimeMs };
                    tickets.set(owner, ticket);
                }
                url = imagePrefix + ticket.token;
            } else tickets.delete(owner);
            const { revision, ...avatar } = result.avatar;
            return { ...result, avatar: { ...avatar, url, expiresAt: url ? tickets.get(owner).expiresAt : null } };
        },
        async image(req, res) {
            prune();
            if (req.method !== "GET") throw new BoardError("Method not allowed.", 405);
            if (req.headers["sec-fetch-site"] !== "same-origin") throw new BoardError("Same-origin profile images only.", 403);
            const id = req.url.slice(imagePrefix.length);
            if (!/^[a-f0-9]{64}$/.test(id)) throw new BoardError("Profile image not found.", 404);
            const match = [...tickets].find(([, item]) => item.token === id);
            if (!match) throw new BoardError("Profile image expired or unavailable.", 404);
            const [owner, ticket] = match;
            const image = await profile.image(ticket.revision);
            if (!ownerActive(owner) || now() >= ticket.expiresAt || tickets.get(owner) !== ticket) throw new BoardError("Profile image expired or unavailable.", 404);
            profile.assertImageCurrent(ticket.revision);
            res.writeHead(200, {
                "Content-Type": image.contentType, "Content-Length": image.bytes.length,
                "Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-origin", "X-Content-Type-Options": "nosniff",
            });
            res.end(image.bytes);
        },
        release(owner) { tickets.delete(owner); },
        close() { tickets.clear(); },
    };
}
