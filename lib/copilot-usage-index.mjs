import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import path from "node:path";
import { statSync } from "node:fs";
import { findTextFindings } from "./privacy-text.mjs";

// The Copilot app keeps its own per-model-call accounting beside the approved chat database.
// Older journals never wrote per-call receipts, so this is the only exact source for them.
// It is read only, never copied, and each turn must agree with the chat's own journal first.
export const USAGE_INDEX_NAME = "session-store.db";
export const usageIndexFile = databaseFile => path.join(path.dirname(databaseFile), USAGE_INDEX_NAME);
const count = n => Number.isSafeInteger(n) && n >= 0;
const digest = value => createHash("sha256").update(value).digest("hex");
// The same screened identifier rule as journal receipts: an index value never carries a credential.
const safeModel = value => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,256}$/.test(value) && !findTextFindings(value).some(f => f.mandatory);
const rowKey = (sessionId, id) => digest(`usage-index:${sessionId}:${id}`);
// Store rows are written a few milliseconds after the reply they meter.
const ROUND_SLACK_MS = 50;

// Absent: null. Present but inaccessible, unreadable, of an unknown shape or beyond the per-chat bounds: a coded
// error, so a failed read is never mistaken for "no records" and never retires a total already verified.
const unreadable = (reason, cause) => Object.assign(new Error("Copilot's token records could not be read."), { code: "usage_index_unreadable", reason, cause });
// One chat's turns and calls are read whole or not at all; a chat past these bounds stays unmeasured.
export const USAGE_INDEX_LIMITS = Object.freeze({ turns: 5000, rows: 50000, promptBytes: 16 * 1024 * 1024 });
function present(file) {
    try { if (!statSync(file).isFile()) throw unreadable("not-a-file"); return true; }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return false; throw error.code === "usage_index_unreadable" ? error : unreadable("access", error); }
}
export function readUsageIndex(file, sessionId, { open = name => new DatabaseSync(name, { readOnly: true, timeout: 1000 }), exists = present, limits = USAGE_INDEX_LIMITS } = {}) {
    if (!exists(file)) return null;
    let db;
    try { db = open(file); } catch (error) { throw unreadable("open", error); }
    try {
        const columns = table => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
        const turns = columns("turns"), usage = columns("assistant_usage_events");
        if (!["session_id", "turn_index", "user_message", "assistant_response"].every(c => turns.has(c))
            || !["id", "session_id", "turn_index", "agent_id", "model", "input_tokens", "output_tokens", "cache_read_tokens",
                "cache_write_tokens", "created_at"].every(c => usage.has(c))) throw unreadable("schema");
        const bounded = (statement, limit) => { const rows = db.prepare(statement + " LIMIT ?").all(sessionId, limit + 1);
            if (rows.length > limit) throw unreadable("bounds"); return rows; };
        const turnRows = bounded("SELECT turn_index AS turn, user_message AS text, assistant_response IS NOT NULL AS complete FROM turns WHERE session_id = ? ORDER BY turn_index", limits.turns);
        if (turnRows.reduce((n, t) => n + Buffer.byteLength(String(t.text ?? "")), 0) > limits.promptBytes) throw unreadable("bounds");
        return {
            turns: turnRows.map(t => ({ turn: t.turn, text: t.text, complete: t.complete === 1 })),
            rows: bounded(`SELECT id, turn_index AS turn, agent_id AS agent, model, input_tokens AS input, output_tokens AS output,
                cache_read_tokens AS cacheRead, cache_write_tokens AS cacheWrite, created_at AS at FROM assistant_usage_events WHERE session_id = ? ORDER BY id`, limits.rows)
                .map(r => ({ ...r })),
            sessionId,
        };
    } catch (error) { throw error.code === "usage_index_unreadable" ? error : unreadable("query", error); } finally { db.close(); }
}

// Returns the indexed model calls for one retained prompt, or null with a named reason.
export function indexedUsage(events, record, index, unavailable = () => null) {
    if (!index?.turns.length || index.sessionId !== record.sourceSessionId) return unavailable("index-unavailable");
    const users = events.filter(e => e.type === "user.message" && !e.agentId);
    const ui = users.findIndex(e => e.id === record.userPrompt?.sourceEventId && e.timestamp === record.userPrompt.sourceTimestamp);
    const prompt = users[ui], text = prompt?.data.content;
    if (!prompt || typeof text !== "string" || text !== record.userPrompt.text || prompt.data.wireUsageExcluded) return unavailable("index-prompt-unbound");
    // A turn is identified by its exact prompt text and occurrence; any difference in counts is ambiguous.
    const sameText = users.filter(e => e.data.content === text), turns = index.turns.filter(t => t.text === text);
    if (sameText.length !== turns.length) return unavailable("index-prompt-unbound");
    const turn = turns[sameText.indexOf(prompt)];
    // The exchange runs to the journal prompt that owns the next indexed turn. Steering
    // messages own no turn, so their rounds stay with this one as the app recorded them.
    const later = index.turns.filter(t => t.turn > turn.turn);
    let end = Infinity;
    if (later.length) {
        const next = later[0], candidates = users.filter(e => e.data.content === next.text);
        const owner = candidates[index.turns.filter(t => t.text === next.text && t.turn < next.turn).length];
        if (!owner || events.indexOf(owner) < events.indexOf(prompt)) return unavailable("index-boundary");
        end = Date.parse(owner.timestamp);
    }
    // The app's last turn may never be marked answered. Its calls count once the journal shows the
    // next independent prompt; a later call in the same turn retires the stored total.
    const unfinished = !later.length && !turn.complete;
    if (unfinished) {
        const next = events.find(e => events.indexOf(e) > events.indexOf(prompt) && !e.agentId
            && (e.type === "user.message" && e.data.wireDelivery !== "steering" || e.type === "session.shutdown"));
        if (!next) return unavailable("index-turn-open");
        end = Date.parse(next.timestamp);
    }
    const at = Date.parse(prompt.timestamp), rounds = [];
    let open = null;
    for (const e of events) {
        if (e.agentId || e.data?.parentToolCallId) continue;
        if (e.type === "assistant.turn_start") open = { start: Date.parse(e.timestamp), reply: null };
        else if (e.type === "assistant.message" && open && open.reply === null) open.reply = Date.parse(e.timestamp);
        else if (e.type === "assistant.turn_end" && open) { rounds.push({ ...open, end: Date.parse(e.timestamp) }); open = null; }
    }
    // A round can open just before its prompt is logged; place it by its first reply.
    const place = r => r.reply ?? r.end, mine = rounds.filter(r => place(r) >= at && place(r) < end);
    if (open && (open.reply ?? open.start) < end) return unavailable("index-turn-open");
    const rows = index.rows.filter(r => r.turn === turn.turn), main = rows.filter(r => !r.agent);
    if (!main.length || !mine.length) return unavailable("index-no-calls");
    const inside = (r, round) => Date.parse(r.at) >= round.start && Date.parse(r.at) <= round.end + ROUND_SLACK_MS;
    if (main.some(r => mine.filter(round => inside(r, round)).length !== 1) || mine.some(round => !main.some(r => inside(r, round))))
        return unavailable("index-incomplete");
    const calls = [];
    for (const r of rows) {
        const call = indexedCall(index.sessionId, r, unfinished);
        if (!call) return unavailable("index-invalid-row");
        calls.push(call);
    }
    return calls.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function indexedCall(sessionId, r, unfinished) {
    const read = r.cacheRead, write = r.cacheWrite;
    if (!safeModel(r.model) || !count(r.input) || !count(r.output) || !Number.isFinite(Date.parse(r.at))
        || [read, write].some(n => n !== null && !count(n)) || (read ?? 0) + (write ?? 0) > r.input) return null;
    const key = rowKey(sessionId, r.id);
    return { receiptId: `wire-usage-index-${key}`, apiCallId: `!${key}`, origin: null, at: new Date(Date.parse(r.at)).toISOString(), model: r.model,
        tokens: read === null || write === null ? { input: r.input, freshInput: null, cacheRead: read, cacheWrite: write, output: r.output }
            : { freshInput: r.input - read - write, cacheRead: read, cacheWrite: write, output: r.output },
        source: "copilot-usage-index", ...(r.agent ? { subagent: true } : {}), ...(unfinished ? { unfinished: true } : {}) };
}

// A stored indexed total stays exact only while the app still records the same calls for that turn.
export function indexedTurnUnchanged(index, calls) {
    const rows = new Map(index.rows.map(r => [`wire-usage-index-${rowKey(index.sessionId, r.id)}`, r]));
    const turns = new Set(calls.map(c => rows.get(c.receiptId)?.turn));
    if (turns.size !== 1 || turns.has(undefined)) return false;
    const [turn] = turns, current = index.rows.filter(r => r.turn === turn);
    // The same row IDs are not enough: a corrected amount, model or time in place also makes the total stale.
    const same = calls.every(c => { const r = rows.get(c.receiptId), now = r && indexedCall(index.sessionId, r, c.unfinished === true);
        return now && JSON.stringify(now) === JSON.stringify(c); });
    return same && current.length === calls.length && (index.turns.find(t => t.turn === turn)?.complete === true || calls.every(c => c.unfinished));
}
