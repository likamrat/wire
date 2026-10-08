import { projectAttributedUsage } from "./evaluation-usage.mjs";

function requireThat(condition, code) { if (!condition) throw new TypeError(code); }

// Opt-in subscription only; this module is not connected to the WIRE extension or runtime.
export function createUsageObserver({ session, currentGrant, resolveInteraction, onUsage, onError, pendingLimit = 128 }) {
    requireThat(session && typeof session.on === "function" && typeof session.sessionId === "string"
        && [currentGrant, resolveInteraction, onUsage, onError].every(value => typeof value === "function"), "invalid-usage-observer");
    requireThat(Number.isSafeInteger(pendingLimit) && pendingLimit > 0 && pendingLimit <= 1000, "invalid-observer-limit");
    const initial = currentGrant();
    requireThat(initial?.confirmed === true && initial.categories?.includes("usage")
        && initial.sourceSessionId === session.sessionId && Number.isSafeInteger(initial.revision), "usage-observer-not-approved");
    const signature = grant => JSON.stringify([grant?.sourceRef, grant?.sourceSessionId, grant?.revision, grant?.categories, grant?.confirmed]);
    const expected = signature(initial), prompts = new Map(), messages = new Map(), usage = new Map(), delivered = new Set();
    let stopped = false, pending = Promise.resolve();
    function stillApproved() {
        requireThat(!stopped && signature(currentGrant()) === expected, "usage-grant-changed");
    }
    function bounded(map, key, value) {
        if (!map.has(key) && map.size >= pendingLimit) {
            onError(new Error("usage-observer-capacity"));
            return;
        }
        const prior = map.get(key);
        requireThat(!prior || JSON.stringify(prior) === JSON.stringify(value), "conflicting-usage-observation");
        map.set(key, value);
    }
    async function deliver() {
        for (const [apiCallId, event] of usage) {
            const message = messages.get(apiCallId), promptId = message && prompts.get(message.data.originatingMessageId);
            if (!message || !promptId) continue;
            stillApproved();
            const interactionRef = await resolveInteraction(promptId);
            stillApproved();
            requireThat(interactionRef, "usage-interaction-not-retained");
            const row = projectAttributedUsage(event, message, {
                ...initial, interactionRef, promptMessageId: message.data.originatingMessageId,
            });
            if (!delivered.has(row.apiCallRef)) {
                requireThat(delivered.size < 100000, "usage-observer-delivery-limit");
                // The persistence callback must recheck this exact grant/revision in its serialized write.
                await onUsage(row, { sourceRef: initial.sourceRef, consentRevision: initial.revision });
                delivered.add(row.apiCallRef);
            }
            usage.delete(apiCallId); messages.delete(apiCallId);
        }
    }
    const unsubscribe = session.on(event => {
        if (stopped || !["user.message", "assistant.message", "assistant.usage"].includes(event.type)) return;
        const input = event.data;
        const projected = event.type === "user.message" ? { type: event.type, id: event.id, data: { messageId: input?.messageId } }
            : event.type === "assistant.message" ? { type: event.type, agentId: event.agentId, data: {
                apiCallId: input?.apiCallId, originatingMessageId: input?.originatingMessageId, model: input?.model, parentToolCallId: input?.parentToolCallId,
            } } : { type: event.type, agentId: event.agentId, data: {
                apiCallId: input?.apiCallId, model: input?.model, parentToolCallId: input?.parentToolCallId,
                inputTokens: input?.inputTokens, outputTokens: input?.outputTokens, cacheReadTokens: input?.cacheReadTokens,
                cacheWriteTokens: input?.cacheWriteTokens, reasoningTokens: input?.reasoningTokens,
                copilotUsage: input?.copilotUsage ? { model: input.copilotUsage.model, totalNanoAiu: input.copilotUsage.totalNanoAiu } : undefined,
            } };
        pending = pending.then(async () => {
            stillApproved();
            const data = projected.data;
            if (projected.type === "user.message" && typeof projected.id === "string" && typeof data?.messageId === "string") {
                bounded(prompts, data.messageId, projected.id);
            } else if (projected.type === "assistant.message" && typeof data?.apiCallId === "string" && typeof data?.originatingMessageId === "string") {
                bounded(messages, data.apiCallId, projected);
            } else if (projected.type === "assistant.usage" && typeof data?.apiCallId === "string") {
                bounded(usage, data.apiCallId, projected);
            }
            await deliver();
        }).catch(error => { onError(error); });
    });
    return {
        flush: () => pending,
        stop() { stopped = true; unsubscribe(); prompts.clear(); messages.clear(); usage.clear(); delivered.clear(); },
    };
}
