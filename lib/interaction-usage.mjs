import { promptAuthorship } from "./prompt-authorship.mjs";

export const tokenKinds = ["freshInput", "cacheRead", "cacheWrite", "output"];
const count = n => Number.isSafeInteger(n) && n >= 0;
const sum = (values, read) => values.reduce((n, value) => n + read(value), 0);
const columns = fn => Object.fromEntries(tokenKinds.map(kind => [kind, fn(kind)]));
export function recordedUsage(calls) {
    if (!calls?.length) return null;
    const steps = calls.map(({ model, at, tokens }) => {
        const complete = tokenKinds.every(k => count(tokens?.[k]));
        if (!complete && !(count(tokens?.input) && count(tokens.output) && tokens.freshInput === null
            && [tokens.cacheRead,tokens.cacheWrite].every(n => n === null || count(n))
            && (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0) <= tokens.input)) throw new TypeError("Invalid recorded token counts.");
        const input = complete ? tokens.freshInput + tokens.cacheRead + tokens.cacheWrite : tokens.input, total = input + tokens.output;
        if (!count(total)) throw new RangeError("Token total exceeds exact integer precision.");
        return { model, at, tokens, total };
    });
    const tokens = columns(k => steps.every(s => s.tokens[k] !== null) ? sum(steps, s => s.tokens[k]) : null), total = sum(steps, s => s.total);
    if (!count(total)) throw new RangeError("Interaction token total exceeds exact integer precision.");
    return { steps, tokens, total };
}

// One entry per canonical interaction (not per tool hit, assistant chunk or model).
export function usageSummary(interactions) {
    const tokenKinds = ["freshInput", "cacheRead", "cacheWrite", "output"];
    const sum = (values, read) => values.reduce((n, value) => n + read(value), 0);
    const models = new Map(), entries = [...interactions], metered = entries.filter(Boolean);
    for (const usage of metered) {
        const seen = new Set();
        for (const step of usage.steps) {
            const row = models.get(step.model) ?? { model: step.model, interactions: 0, total: 0, input: 0, output: 0 };
            if (!seen.has(step.model)) row.interactions++;
            seen.add(step.model);
            row.total += step.total; row.output += step.tokens.output; row.input += step.total - step.tokens.output;
            models.set(step.model, row);
        }
    }
    const tokens = metered.length ? Object.fromEntries(tokenKinds.map(k => [k, metered.every(u=>u.tokens[k] !== null) ? sum(metered, u=>u.tokens[k]) : null])) : null;
    const total = tokens ? sum(metered, u=>u.total) : null;
    if (total !== null && !Number.isSafeInteger(total)) throw new RangeError("Population token total exceeds exact integer precision.");
    return { eligible: entries.length, metered: metered.length, total, tokens,
        cacheReadShare: tokens?.cacheRead != null && total > tokens.output ? tokens.cacheRead / (total - tokens.output) : null,
        models: [...models.values()].sort((a, b) => b.total - a.total || a.model.localeCompare(b.model)) };
}

export const usageQuestions = {
    all: "All interaction usage",
    author: "Human vs. Agent prompts",
    tool: "Tools in high-usage interactions",
    model: "Model mix and cache reuse",
};
export const usageThresholds = [30000, 60000];
// Assign the whole interaction once, to its first dated matching record in this scope.
export function firstUsageDays(rows) {
    const first = new Map();
    for (const {originId,date} of rows) if (originId && date && (!first.has(originId) || date < first.get(originId))) first.set(originId,date);
    return first;
}
export const usageTools = ["search_paths", "get_schema", "retrieve", "fetch", "ask", "list_agents", "fetch_blob",
    "call_function", "do_action", "create_entity", "update_entity", "delete_entity"].map(name => `workiq-${name}`);

export function usageMembers(records) {
    const groups = new Map();
    for (const record of records) {
        const key = promptAuthorship.interactionIdentity(record), existing = groups.get(key);
        const usage = !record.assessmentMembershipPruned && ["copilot-app", "copilot-app-chat"].includes(record.sourceHost)
            ? recordedUsage(record.usageCalls) : null;
        const starts = new Set(usage ? record.usageCalls.flatMap(r => r.linkedToolStarts ?? []) : []);
        const actor = promptAuthorship.read(record.userPrompt).actor;
        const calls = new Map((record.toolCalls ?? []).filter(c => c.toolCallId || c.startEventId).map(c => [
            c.toolCallId ?? c.startEventId, { tool: c.tool, bytes: count(c.returnedTextBytes) && (starts.has(c.startEventId)
                || c.promptLink && c.promptLink.promptEventId === record.userPrompt?.sourceEventId) ? c.returnedTextBytes : null },
        ]));
        if (existing) {
            if (usage && existing.usage && JSON.stringify(existing.usage) !== JSON.stringify(usage)) existing.conflict = true;
            existing.usage ??= usage;
            if (existing.actor !== actor) existing.actor = "unknown";
            for (const [id, call] of calls) {
                const prior = existing.calls.get(id);
                if (!prior) existing.calls.set(id, call);
                else if (prior.tool !== call.tool) existing.calls.set(id,{tool:null,bytes:null,conflict:true});
                else if (!prior.conflict && call.bytes !== null) {
                    if (prior.bytes !== null && prior.bytes !== call.bytes) { prior.bytes = null; prior.conflict = true; }
                    else prior.bytes = call.bytes;
                }
            }
        } else groups.set(key, { key, record, usage, actor, calls });
    }
    return [...groups.values()].map(group => {
        if (group.conflict) for (const call of group.calls.values()) call.bytes = null;
        return { ...group, usage: group.conflict ? null : group.usage,
            bytes: new Map([...group.calls].filter(([, c]) => c.bytes !== null).map(([id, c]) => [id, c.bytes])) };
    });
}

// Restrict analytical membership inside the caller's already-authorized population.
// Repeated tools share one interaction reading; returned bytes remain per tool call.
export function usageQuestionGroups(members, question, threshold = 30000, {
    toolLabel = name => usageTools.includes(name) ? name : null, modelLabel = name => name, author, tool,
} = {}) {
    if (!Object.hasOwn(usageQuestions, question) || !usageThresholds.includes(threshold)) throw new TypeError("Unsupported token usage question.");
    const scoped = members.filter(m => (!author || m.actor === author) && (!tool || [...m.calls.values()].some(c => c.tool === tool)));
    const selected = question === "tool" ? scoped.filter(m => m.usage && m.usage.total >= threshold && [...m.calls.values()].some(c => toolLabel(c.tool))) : scoped;
    const grouped = new Map();
    function add(label, member) {
        if (!grouped.has(label)) grouped.set(label, []);
        grouped.get(label).push(member);
    }
    for (const member of selected) {
        if (question === "author") add(({ user: "Human", agent: "Agent", unknown: "Sender unclear" })[member.actor], member);
        else if (question === "tool") {
            for (const name of new Set([...member.calls.values()].map(c => toolLabel(c.tool)).filter(Boolean))) add(name, member);
        } else if (question === "model" && member.usage) {
            const models = Map.groupBy(member.usage.steps, s => modelLabel(s.model));
            for (const [label, steps] of models) {
                const tokens = columns(k => steps.every(s => s.tokens[k] !== null) ? sum(steps, s => s.tokens[k]) : null);
                add(label, { ...member, usage: { steps, tokens, total: sum(steps, s => s.total) } });
            }
        } else if (question === "all") add(usageQuestions.all, member);
    }
    const groups = [...grouped].map(([label, items]) => {
        const summary = usageSummary(items.map(m => m.usage));
        const calls = question === "tool" ? items.flatMap(m => [...m.calls.values()].filter(c => toolLabel(c.tool) === label)) : [];
        const sized = calls.filter(c => c.bytes !== null);
        return { label, items, summary, ...(question === "tool" ? { context: {
            calls: calls.length, sized: sized.length, tokens: sized.length ? Math.round(sum(sized, c => c.bytes) / 4) : null,
        } } : {}) };
    }).sort((a, b) => (b.summary.total ?? -1) - (a.summary.total ?? -1) || a.label.localeCompare(b.label));
    return { selected, unranked: scoped.filter(m => !m.usage).length, groups };
}
