import rates from "./retail-pricing.json" with { type: "json" };
import { promptAuthorship } from "./prompt-authorship.mjs";

export const pricingSnapshot = rates;
export const tokenKinds = ["freshInput", "cacheRead", "cacheWrite", "output"];
const count = n => Number.isSafeInteger(n) && n >= 0;
const sum = (values, read) => values.reduce((n, value) => n + read(value), 0);
const columns = fn => Object.fromEntries(tokenKinds.map(kind => [kind, fn(kind)]));
export function priceUsage(calls, snapshot = pricingSnapshot) {
    if (!calls?.length) return null;
    const steps = calls.map(({ model, at, tokens }) => {
        const complete = tokenKinds.every(k => count(tokens?.[k]));
        if (!complete && !(count(tokens?.input) && count(tokens.output) && tokens.freshInput === null
            && [tokens.cacheRead,tokens.cacheWrite].every(n => n === null || count(n))
            && (tokens.cacheRead ?? 0) + (tokens.cacheWrite ?? 0) <= tokens.input)) throw new TypeError("Invalid recorded token counts.");
        const input = complete ? tokens.freshInput + tokens.cacheRead + tokens.cacheWrite : tokens.input, total = input + tokens.output;
        if (!count(total)) throw new RangeError("Token total exceeds exact integer precision.");
        const name = Object.hasOwn(snapshot.aliases, model) ? snapshot.aliases[model] : model;
        const rate = Object.hasOwn(snapshot.models, name) ? snapshot.models[name] : null;
        const factor = rate?.aboveInput !== undefined && input > rate.aboveInput ? rate.multiplier : 1;
        const amounts = rate && complete ? columns(k => tokens[k] * rate[k] * (k === "output" && factor !== 1 ? rate.outputMultiplier ?? factor : factor) / 1000000) : null;
        return { model: name, at, tokens, total, amounts, usd: amounts ? sum(tokenKinds, k => amounts[k]) : null,
            ...(amounts ? {} : { reason: !rate ? "model-not-listed" : "cache-split-missing" }) };
    });
    const tokens = columns(k => steps.every(s => s.tokens[k] !== null) ? sum(steps, s => s.tokens[k]) : null), total = sum(steps, s => s.total);
    if (!count(total)) throw new RangeError("Interaction token total exceeds exact integer precision.");
    const amounts = steps.every(s => s.amounts) ? columns(k => sum(steps, s => s.amounts[k])) : null;
    return { steps, tokens, total, amounts, usd: amounts ? sum(steps, s => s.usd) : null, rateDate: snapshot.date };
}

// One entry per canonical interaction (not per tool hit, assistant chunk or model).
export function usageSummary(interactions) {
    const tokenKinds = ["freshInput", "cacheRead", "cacheWrite", "output"];
    const sum = (values, read) => values.reduce((n, value) => n + read(value), 0);
    const models = new Map(), entries = [...interactions], metered = entries.filter(Boolean);
    const priced = metered.filter(u => u.usd !== null);
    for (const usage of metered) {
        const seen = new Set();
        for (const step of usage.steps) {
            const row = models.get(step.model) ?? { model: step.model, interactions: 0, total: 0, usd: null, input: 0, output: 0 };
            if (!seen.has(step.model)) row.interactions++;
            seen.add(step.model);
            row.total += step.total; row.output += step.tokens.output; row.input += step.total - step.tokens.output;
            // A partially priced interaction is excluded from both the dollar total and its model shares.
            if (usage.usd !== null) row.usd = (row.usd ?? 0) + step.usd;
            models.set(step.model, row);
        }
    }
    const tokens = metered.length ? Object.fromEntries(tokenKinds.map(k => [k, metered.every(u=>u.tokens[k] !== null) ? sum(metered, u=>u.tokens[k]) : null])) : null;
    const total = tokens ? sum(metered, u=>u.total) : null;
    if (total !== null && !Number.isSafeInteger(total)) throw new RangeError("Population token total exceeds exact integer precision.");
    return { eligible: entries.length, metered: metered.length, priced: priced.length, unpriced: metered.length - priced.length,
        total, tokens, usd: priced.length ? sum(priced, u => u.usd) : null,
        cacheReadShare: tokens?.cacheRead != null && total > tokens.output ? tokens.cacheRead / (total - tokens.output) : null,
        models: [...models.values()].sort((a, b) => b.total - a.total || a.model.localeCompare(b.model)) };
}

export const formatUsd = value => value === null ? "Unpriced" : value > 0 && value < .01 ? "<$0.01" : `~$${value.toFixed(2)}`;

export function usageMembers(records) {
    const groups = new Map();
    for (const record of records) {
        const key = promptAuthorship.interactionIdentity(record), existing = groups.get(key);
        const usage = !record.assessmentMembershipPruned && ["copilot-app", "copilot-app-chat"].includes(record.sourceHost)
            ? priceUsage(record.usageCalls) : null;
        const bytes = new Map((record.toolCalls ?? []).filter(c => Number.isSafeInteger(c.returnedTextBytes) && c.returnedTextBytes >= 0
            && c.promptLink && c.promptLink.promptEventId === record.userPrompt?.sourceEventId).map(c => [c.toolCallId, c.returnedTextBytes]));
        if (existing) {
            if (usage && existing.usage && JSON.stringify(existing.usage) !== JSON.stringify(usage)) existing.conflict = true;
            existing.usage ??= usage;
            for (const [id, n] of bytes) existing.bytes.set(id, n);
        } else groups.set(key, { key, record, usage, bytes });
    }
    return [...groups.values()].map(group => ({ ...group, usage: group.conflict ? null : group.usage }));
}
