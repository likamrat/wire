import { createHash } from "node:crypto";

const ref = value => typeof value === "string" && /^[a-z]+-[a-f0-9]{32}$/.test(value);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
function requireThat(condition, code) { if (!condition) throw new TypeError(code); }
function count(value) {
    requireThat(Number.isSafeInteger(value) && value >= 0, "invalid-usage-count");
    return value;
}

// Consumes the supported ephemeral assistant.usage event; no subscription, discovery or persistence occurs here.
export function projectAttributedUsage(usage, message, scope) {
    requireThat(scope?.confirmed === true && scope.categories?.includes("usage"), "usage-capture-not-approved");
    requireThat(ref(scope.interactionRef) && ref(scope.sourceRef) && typeof scope.promptMessageId === "string"
        && scope.promptMessageId.length > 0, "invalid-usage-scope");
    requireThat(usage?.type === "assistant.usage" && message?.type === "assistant.message", "unsupported-usage-events");
    const data = usage.data, linked = message.data;
    requireThat(!usage.agentId && !message.agentId && !data?.parentToolCallId && !linked?.parentToolCallId, "subagent-usage-unverified");
    requireThat(typeof data?.apiCallId === "string" && data.apiCallId.length > 0
        && data.apiCallId === linked?.apiCallId && linked.originatingMessageId === scope.promptMessageId, "usage-interaction-unverified");
    requireThat(typeof data.model === "string" && data.model.length > 0 && data.model === linked.model
        && (!data.copilotUsage?.model || data.copilotUsage.model === data.model), "usage-model-mismatch");
    requireThat(Number.isSafeInteger(data.copilotUsage?.totalNanoAiu) && data.copilotUsage.totalNanoAiu >= 0, "attributable-charge-missing");
    const tokens = Object.fromEntries([
        ["input", "inputTokens"], ["output", "outputTokens"], ["cacheRead", "cacheReadTokens"],
        ["cacheWrite", "cacheWriteTokens"], ["reasoning", "reasoningTokens"],
    ].map(([name, key]) => [name, data[key] === undefined ? null : count(data[key])]));
    return {
        schemaVersion: 1, interactionRef: scope.interactionRef,
        apiCallRef: `usage-${digest([scope.sourceRef, data.apiCallId])}`,
        origin: "provider-recorded", model: data.model, boundary: "attributed-model-api-call",
        nanoAiu: data.copilotUsage.totalNanoAiu, value: data.copilotUsage.totalNanoAiu / 1e9, unit: "AI credits", tokens,
        billingBasis: "copilot_usage.totalNanoAiu", billingDefinitionVersion: 1,
    };
}
export function poolAttributedUsage(values, interactionRefs) {
    requireThat(Array.isArray(values) && Array.isArray(interactionRefs) && interactionRefs.every(ref)
        && new Set(interactionRefs).size === interactionRefs.length, "invalid-usage-membership");
    const selected = new Set(interactionRefs), calls = new Map();
    for (const value of values) {
        requireThat(value?.schemaVersion === 1 && ref(value.apiCallRef) && value.origin === "provider-recorded"
            && value.unit === "AI credits" && value.boundary === "attributed-model-api-call"
            && value.billingDefinitionVersion === 1 && value.billingBasis === "copilot_usage.totalNanoAiu", "invalid-usage-fact");
        requireThat(selected.has(value.interactionRef), "usage-outside-membership");
        count(value.nanoAiu);
        requireThat(value.value === value.nanoAiu / 1e9, "invalid-usage-value");
        const prior = calls.get(value.apiCallRef);
        requireThat(!prior || JSON.stringify(prior) === JSON.stringify(value), "conflicting-usage-call");
        calls.set(value.apiCallRef, value);
    }
    const unique = [...calls.values()], nanoAiu = unique.reduce((sum, value) => sum + value.nanoAiu, 0);
    count(nanoAiu);
    return {
        status: unique.length ? "measured-subtotal" : "not-measured",
        value: unique.length ? nanoAiu / 1e9 : null, unit: "AI credits", calls: calls.size,
        coverage: { covered: new Set(unique.map(value => value.interactionRef)).size, eligible: selected.size },
        boundary: "Captured, explicitly attributed model API calls only; no claim that all interaction usage was observed.",
        origin: "provider-recorded",
    };
}
