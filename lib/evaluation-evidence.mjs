import { createHash } from "node:crypto";
import { textFindings } from "./privacy.mjs";
import { createEvaluationDiagnostic, withEvaluationDiagnostic } from "./evaluation-diagnostics.mjs";

export const EVALUATION_EVIDENCE_VERSION = 1;
export const EVALUATION_PACKET_LIMITS = Object.freeze({ itemBytes: 65536, packetBytes: 262144, references: 100 });
const digest = value => createHash("sha256").update(value).digest("hex");
const reference = (kind, value) => `${kind}-${digest(value).slice(0, 32)}`;
const validInstant = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const unavailable = reason => ({ status: "unavailable", reason });
function requireThat(condition, code) { if (!condition) throw new TypeError(code); }
function normalizedEvents(events) {
    requireThat(Array.isArray(events) && events.length <= 1000000, "invalid-original-events");
    const seen = new Map();
    for (const event of events) {
        requireThat(event && typeof event.id === "string" && event.id && typeof event.type === "string"
            && validInstant(event.timestamp) && event.data && typeof event.data === "object", "invalid-original-event");
        const prior = seen.get(event.id);
        requireThat(!prior || JSON.stringify(prior) === JSON.stringify(event), "conflicting-event");
        if (!prior) seen.set(event.id, event);
    }
    return [...seen.values()];
}
function locatedInteraction(events, interaction) {
    requireThat(interaction && /^[a-z]+-[a-f0-9]{32}$/.test(interaction.interactionRef)
        && typeof interaction.sourceSessionId === "string" && typeof interaction.promptEventId === "string"
        && validInstant(interaction.promptTimestamp) && typeof interaction.promptText === "string"
        && Array.isArray(interaction.toolCallIds) && interaction.toolCallIds.every(id => typeof id === "string" && id)
        && new Set(interaction.toolCallIds).size === interaction.toolCallIds.length, "invalid-interaction-identity");
    const start = events.findIndex(event => event.id === interaction.promptEventId && event.type === "user.message");
    requireThat(start >= 0 && events[start].timestamp === interaction.promptTimestamp
        && events[start].data.content === interaction.promptText, "original-prompt-mismatch");
    const end = events.findIndex((event, index) => index > start && event.type === "user.message");
    return { start, end: end < 0 ? events.length : end, prompt: events[start] };
}
function finalAnswer(events, { start, end, prompt }) {
    const rows = events.slice(start + 1, end);
    const answers = rows.filter(event => event.type === "assistant.message" && !event.agentId
        && !event.data.parentToolCallId && event.data.phase === "final_answer"
        && typeof event.data.content === "string" && event.data.content.length > 0
        && !event.data.toolRequests?.length && typeof event.data.turnId === "string"
        && (!event.data.originatingMessageId || event.data.originatingMessageId === prompt.data.messageId));
    const answer = answers.at(-1);
    if (!answer) return null;
    const index = events.indexOf(answer), following = events.slice(index + 1, end);
    if (!following.some(event => event.type === "assistant.turn_end" && event.data.turnId === answer.data.turnId)
        || following.some(event => ["assistant.message", "tool.execution_start", "assistant.turn_start"].includes(event.type))) return null;
    return answer;
}
function activeWork(events) {
    const turns = new Set(), tools = new Set();
    for (const event of events) {
        if (event.type === "assistant.turn_start") turns.add(event.data.turnId);
        if (event.type === "assistant.turn_end") turns.delete(event.data.turnId);
        if (event.type === "tool.execution_start") tools.add(event.data.toolCallId);
        if (event.type === "tool.execution_complete") tools.delete(event.data.toolCallId);
    }
    return turns.size + tools.size;
}
const intervalEvents = new Set([
    "user.message", "assistant.turn_start", "assistant.turn_end", "assistant.message", "assistant.reasoning",
    "tool.execution_start", "tool.execution_complete", "tool.execution_partial_result", "tool.execution_progress",
    "permission.requested", "permission.completed", "abort",
]);
function recordedCost(events, location, sourceComplete) {
    if (!sourceComplete) return unavailable("source-window-incomplete");
    const before = events.findLastIndex((event, index) => index < location.start && event.type === "session.usage_checkpoint");
    const after = events.findIndex((event, index) => index > location.start && event.type === "session.usage_checkpoint");
    if (before < 0 || after < 0) return unavailable("missing-billing-boundary");
    const prefix = events.slice(0, before + 1), interval = events.slice(before + 1, after);
    if (prefix[0]?.type !== "session.start" || prefix[0].parentId !== null) return unavailable("source-window-incomplete");
    for (let i = 1; i <= after; i++) {
        if (events[i].parentId !== events[i - 1].id || Date.parse(events[i].timestamp) < Date.parse(events[i - 1].timestamp)) {
            return unavailable("source-chain-incomplete");
        }
    }
    if (activeWork(prefix)) return unavailable("prior-work-crosses-boundary");
    if (prefix.some(event => event.agentId || event.type.startsWith("subagent."))) return unavailable("unverified-subagent-accounting");
    const prompts = interval.filter(event => event.type === "user.message");
    if (prompts.length !== 1 || prompts[0].id !== location.prompt.id) return unavailable("multiple-interactions-in-billing-interval");
    if (interval[0]?.id !== location.prompt.id) return unavailable("prior-work-crosses-boundary");
    if (interval.some(event => event.agentId || event.data.parentToolCallId || !intervalEvents.has(event.type))) {
        return unavailable("unattributed-billable-work");
    }
    if (activeWork(interval)) return unavailable("unfinished-billable-work");
    if (interval.at(-1)?.type !== "assistant.turn_end") return unavailable("unverified-billing-end");
    const a = events[before].data.totalNanoAiu, b = events[after].data.totalNanoAiu;
    if (![a, b].every(value => Number.isSafeInteger(value) && value >= 0)) return unavailable("invalid-billing-counter");
    if (b < a) return unavailable("billing-counter-reset");
    const models = [...new Set(interval.filter(event => event.type === "assistant.message").map(event => event.data.model))];
    if (models.some(model => typeof model !== "string" || !model)) return unavailable("billing-model-unavailable");
    return {
        status: "measured", reason: null, nanoAiu: b - a, aiCredits: (b - a) / 1e9,
        unit: "AI credits", attribution: "exclusive-checkpoint-interval",
        checkpointEventIds: [events[before].id, events[after].id], models,
        boundary: "All recorded billable work between two continuous, quiescent cumulative checkpoints belongs to this interaction.",
    };
}

// Pure and read-only. It never discovers history, creates consent, retains a packet, or calls a provider.
export function evaluateRecordedBoundaries(originalEvents, interaction, { sourceComplete = false } = {}) {
    const events = normalizedEvents(originalEvents), location = locatedInteraction(events, interaction);
    const startup = events.find(event => event.type === "session.start");
    requireThat(!startup || startup.data.sessionId === interaction.sourceSessionId && startup.data.version === 1, "original-source-mismatch");
    const answer = finalAnswer(events, location);
    const duration = answer ? Date.parse(answer.timestamp) - Date.parse(location.prompt.timestamp) : -1;
    const latency = answer && duration >= 0 ? {
        status: "measured", reason: null, valueMs: duration,
        boundary: "recorded-request-to-final-answer", promptEventId: location.prompt.id, answerEventId: answer.id,
        association: answer.data.originatingMessageId ? "explicit-message-link" : "single-recorded-message-interval",
    } : unavailable("final-answer-boundary-unavailable");
    return { schemaVersion: EVALUATION_EVIDENCE_VERSION, latency, cost: recordedCost(events, location, sourceComplete) };
}

export function buildEvaluationPacket(originalEvents, interaction, grant) {
    requireThat(grant?.confirmed === true, "evaluation-capture-not-approved");
    requireThat(grant.interactionRefs?.includes(interaction?.interactionRef), "interaction-outside-grant");
    requireThat(["answer", "references", "intent"].every(category => grant.categories?.includes(category)), "evidence-category-not-approved");
    requireThat(/^sourceconfig-[a-f0-9]{32}$/.test(grant.sourceConfigRef) && Number.isSafeInteger(grant.sourceConfigRevision)
        && grant.sourceConfigRevision >= 0, "invalid-source-grant");
    const events = normalizedEvents(originalEvents), location = locatedInteraction(events, interaction);
    const answer = finalAnswer(events, location);
    requireThat(answer, "final-answer-boundary-unavailable");
    function withinLimit(kind, measured, limit) {
        if (measured <= limit) return;
        const error = new TypeError("evidence-limit");
        throw withEvaluationDiagnostic(error, createEvaluationDiagnostic(error, {
            stage: "packet-build", sendInvoked: false,
            size: { kind, measured, limit, unit: kind === "references" ? "items" : "bytes" },
        }));
    }
    function document(kind, event, text, material = kind) {
        requireThat(typeof text === "string" && text.trim(), "empty-evaluation-evidence");
        withinLimit(material, Buffer.byteLength(text), EVALUATION_PACKET_LIMITS.itemBytes);
        requireThat(!textFindings(text).some(finding => finding.mandatory), "credential-excluded");
        return {
            ref: reference(kind, `${interaction.sourceSessionId}:${event.id}:${text}`),
            eventRef: reference("event", `${interaction.sourceSessionId}:${event.id}`),
            text, sha256: digest(text),
        };
    }
    const prompt = document("prompt", location.prompt, location.prompt.data.content);
    const response = document("answer", answer, answer.data.content);
    const references = [], actions = [];
    for (const toolCallId of interaction.toolCallIds) {
        const starts = events.slice(location.start + 1, location.end).filter(event => event.type === "tool.execution_start" && event.data.toolCallId === toolCallId);
        const ends = events.slice(location.start + 1, events.indexOf(answer)).filter(event => event.type === "tool.execution_complete" && event.data.toolCallId === toolCallId);
        requireThat(starts.length === 1 && ends.length === 1 && events.indexOf(ends[0]) > events.indexOf(starts[0]), "incomplete-tool-evidence");
        const start = starts[0], end = ends[0], result = end.data.result;
        requireThat(!start.agentId && !end.agentId && !start.data.parentToolCallId, "unverified-action-association");
        const args = document("arguments", start, JSON.stringify(start.data.arguments ?? {}));
        const tool = start.data.toolName;
        requireThat(typeof tool === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(tool), "invalid-tool-identity");
        actions.push({ ref: reference("action", `${interaction.sourceSessionId}:${toolCallId}`), tool,
            arguments: args, completion: typeof end.data.success === "boolean" ? end.data.success : null });
        const texts = new Map();
        for (const [text, kind] of [
            [typeof result?.content === "string" ? result.content : null, "reference-content"],
            [result?.structuredContent && typeof result.structuredContent === "object" ? JSON.stringify(result.structuredContent) : null, "reference-structured"],
        ]) if (typeof text === "string" && text.trim() && !texts.has(text)) texts.set(text, kind);
        for (const [text, kind] of texts) references.push({ ...document("reference", end, text, kind), actionRef: actions.at(-1).ref, provenance: "recorded-tool-return" });
    }
    withinLimit("references", references.length, EVALUATION_PACKET_LIMITS.references);
    const packet = {
        schemaVersion: EVALUATION_EVIDENCE_VERSION, interactionRef: interaction.interactionRef,
        origin: "recorded-source", sourceConfigRef: grant.sourceConfigRef, sourceConfigRevision: grant.sourceConfigRevision,
        authority: { kind: "capture-only", evaluatorAuthorized: false },
        prompt, answer: response, references, actions,
        evidenceBoundary: "Only the selected recorded Work IQ/API action results; not hidden hosted actions, reasoning, fetched citation targets or complete external truth.",
    };
    withinLimit("packet", Buffer.byteLength(JSON.stringify(packet)), EVALUATION_PACKET_LIMITS.packetBytes);
    return packet;
}
