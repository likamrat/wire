import { promptRecord } from "./prompt-authorship.mjs";

// Never subtract anything from the general checkpoint index. The one exception
// is local to (proposal call id, matching row signature) at EOF. In particular
// it cannot excuse a second row, an unknown field, or a context/hook identity.
export function checkpointPromptEvidence(rows, index, { id, hash, jsonPreimage, maxCurrentCalls }) {
    const byEvent = new Map(), byText = new Map();
    for (const row of rows) {
        if (row?.type !== "user.message" || !id(row.id) || !id(row.data?.content)) continue;
        const event = hash(row.id), text = hash(row.data.content);
        const signatures = index.get(event);
        // Even an unknown row claiming this event id makes the witness ambiguous.
        if (signatures?.length !== 1) continue;
        const witness = { signature: signatures[0], seen: false, verified: false };
        byEvent.set(event, witness);
        byText.set(text, byText.has(text) ? null : witness);
    }
    let remaining = maxCurrentCalls;
    return {
        noteCurrent(record) {
            if (!byText.size) return;
            const event = record.userPrompt?.sourceEventId;
            if (id(event) && (record.sample || record.synthetic || record.sourceHost !== "copilot-app")) byEvent.delete(hash(event));
            for (const calls of [record.toolCalls ?? [], record.graphActivities ?? []]) {
                // Overflow disables only this exception. Ordinary proof is unchanged.
                if (!Array.isArray(calls) || calls.length > remaining) { byText.clear(); return; }
                remaining -= calls.length;
                for (const call of calls) {
                    if (id(call?.toolCallId)) byText.delete(hash(call.toolCallId));
                    if (id(call?.parentToolCallId)) byText.delete(hash(call.parentToolCallId));
                }
            }
        },
        observe(event, prior, project) {
            if (!byText.size) return;
            const witness = byEvent.get(hash(event.id));
            if (!witness) return;
            if (witness.seen) { witness.verified = false; return; }
            witness.seen = true;
            const text = event.data.content;
            if (!prior || event.type !== "user.message" || !id(text) || byText.get(hash(text)) !== witness) return;
            // Do not interpret objects inside otherwise familiar prompt fields.
            // A second literal occurrence in the source is not a text-only witness.
            const values = Object.values(event.data);
            if (values.some(v => typeof v !== "string" && typeof v !== "boolean")
                || values.filter(v => v === text).length !== 1 || event.parentId === text) return;
            const retained = project();
            if (!retained || retained.data.content !== text || retained.data.wirePromptAuthorship.actor === "unknown") return;
            let occurrences = 0;
            const preimage = jsonPreimage(retained, { sorted: true, visitString: v => { if (v === text) occurrences++; } });
            witness.verified = occurrences === 1 && hash(preimage) === witness.signature
                && hash(jsonPreimage(promptRecord(retained), { sorted: true })) === prior;
        },
        permits(callKey, signature) {
            const witness = byText.get(callKey);
            return witness?.verified === true && witness.signature === signature;
        },
    };
}
