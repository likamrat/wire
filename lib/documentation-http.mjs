import { randomBytes } from "node:crypto";
import { BoardError } from "./store.mjs";

export const DOCUMENTATION_PATH = "/api/documentation";
const assetPrefix = `${DOCUMENTATION_PATH}/asset/`;
const lifetimeMs = 30 * 60 * 1000;
const types = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

const validate = (input, fields) => {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !fields.includes(key)))
        throw new BoardError("The documentation request does not match its route.", 422);
};

// Image tickets let <img> elements load one panel's guide images without the panel capability in the URL.
// A ticket names a revision, never a file system path, and expires with the panel.
export function createDocumentationRoutes(source, { ownerActive, now = Date.now }) {
    const tickets = new Map();
    function prune() {
        for (const [token, ticket] of tickets) if (now() >= ticket.expiresAt || !ownerActive(ticket.owner)) tickets.delete(token);
    }
    function ticketFor(owner, revision) {
        prune();
        let found = [...tickets].find(([, ticket]) => ticket.owner === owner && ticket.revision === revision);
        if (!found) {
            if (tickets.size >= 512) throw new BoardError("Too many open documentation views.", 429);
            found = [randomBytes(32).toString("hex"), { owner, revision }];
            tickets.set(...found);
        }
        found[1].expiresAt = now() + lifetimeMs;
        return `${assetPrefix}${found[0]}/`;
    }
    const sourceError = error => error?.status
        ? Object.assign(new BoardError(error.message, error.status), { code: error.code }) : error;
    return {
        matches: url => url === DOCUMENTATION_PATH || url?.startsWith(DOCUMENTATION_PATH + "/"),
        matchesAsset: url => url?.startsWith(assetPrefix),
        async handle(url, input, owner) {
            try {
                if (url === `${DOCUMENTATION_PATH}/catalog`) {
                    validate(input, ["source"]);
                    if (!["official", "checkout"].includes(input.source ?? "official")) throw new BoardError("Unknown documentation source.", 422);
                    return await source.catalog(input.source ?? "official");
                }
                if (url === `${DOCUMENTATION_PATH}/page`) {
                    validate(input, ["revision", "guide"]);
                    if (typeof input.guide !== "string" || !/^[a-z0-9._-]{0,80}$/.test(input.guide)) throw new BoardError("Unknown guide.", 404);
                    const page = await source.page(input.revision, input.guide);
                    return { ...page, assetBase: ticketFor(owner, page.revision) };
                }
                if (url === `${DOCUMENTATION_PATH}/check`) {
                    validate(input, ["force"]);
                    return await source.check({ force: input.force === true });
                }
                if (url === `${DOCUMENTATION_PATH}/version`) {
                    validate(input, []);
                    return { version: await source.version() };
                }
            } catch (error) { throw sourceError(error); }
            throw new BoardError("Unknown documentation route.", 404);
        },
        async asset(req, res) {
            prune();
            if (req.method !== "GET") throw new BoardError("Method not allowed.", 405);
            if (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") throw new BoardError("Same-origin documentation images only.", 403);
            const m = /^\/api\/documentation\/asset\/([a-f0-9]{64})\/([A-Za-z0-9._%/-]+)$/.exec(req.url);
            const ticket = m && tickets.get(m[1]);
            if (!ticket) throw new BoardError("Documentation image expired or unavailable.", 404);
            let file;
            try { file = decodeURIComponent(m[2]); } catch { throw new BoardError("Documentation image not found.", 404); }
            const type = types[file.split(".").at(-1).toLowerCase()];
            const bytes = type ? await source.asset(ticket.revision, file).catch(error => { throw sourceError(error); }) : null;
            if (!bytes) throw new BoardError("Documentation image not found.", 404);
            res.writeHead(200, { "Content-Type": type, "Content-Length": bytes.length, "X-Content-Type-Options": "nosniff",
                "Cross-Origin-Resource-Policy": "same-origin", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
                "Cache-Control": ticket.revision.startsWith("git:") ? "private, max-age=1800" : "no-store" });
            res.end(bytes);
        },
        release(owner) { for (const [token, ticket] of tickets) if (ticket.owner === owner) tickets.delete(token); },
        close() { tickets.clear(); },
    };
}
