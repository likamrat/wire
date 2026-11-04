// Shared, privacy-safe author vocabulary. Message association is deliberately separate.
export function createPromptAuthorship() {
    const actors = Object.freeze(["user", "agent", "unknown"]);
    function selection(value) {
        if (value == null || value === "" || value === "all") return [...actors];
        const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
        if (!values || values.some(actor => typeof actor !== "string")) throw new TypeError("Choose supported prompt authors.");
        const unique = [...new Set(values)];
        return [...actors.filter(actor => unique.includes(actor)), ...unique.filter(actor => !actors.includes(actor)).sort()];
    }
    function filterValue(value) {
        const values = selection(value);
        return values.length === actors.length && values.every(actor => actors.includes(actor)) ? undefined : values.join(",");
    }
    function validSelection(value) {
        return value === undefined || Array.isArray(value) && value.length > 0 && value.length <= actors.length
            && new Set(value).size === value.length && value.every(actor => actors.includes(actor));
    }
    function selectionLabel(value, { ownerVoice = true } = {}) {
        const values = selection(value), user = ownerVoice ? "My" : "User";
        if (!values.length) return "No prompt authors selected";
        if (values.some(actor => !actors.includes(actor))) return "Unrecognized prompt author selection";
        if (values.length === actors.length) return "All prompts (including unverified)";
        if (values.length === 1) return { user: `${user} prompts`, agent: "Agent prompts", unknown: "Author unverified" }[values[0]];
        return values.includes("unknown") ? `${values.includes("user") ? user : "Agent"} and unverified prompts` : `${user} and agent prompts`;
    }
    const bases = {
        "source-user": ["user", "The host explicitly recorded a user source."],
        "source-agent": ["agent", "The host explicitly recorded an inter-agent source."],
        "host-direct-input": ["user", "The original host record has the supported direct-input envelope and default user source."],
        "host-agent-envelope": ["agent", "The host added a cross-session sender envelope outside the displayed prompt text."],
        "autopilot": ["agent", "The host recorded an automatic continuation."],
        "parent-kickoff": ["agent", "The first message exactly matches a recorded kickoff from this chat's agent creator."],
        "system-source": ["unknown", "The host recorded this as system-supplied context, not a verified User or Agent prompt."],
        "missing-source": ["unknown", "The host did not record the author; the user.message role alone is not authorship."],
        "unsupported-source": ["unknown", "The recorded source does not identify a supported User or Agent author."],
        "conflicting-source": ["unknown", "Recorded author evidence conflicts."],
        "legacy-missing": ["unknown", "This older record did not retain verifiable author metadata."],
        "invalid-source": ["unknown", "WIRE could not verify the recorded host message format or author fields."],
    };
    function read(prompt) {
        const value = prompt?.authorship;
        if (value === undefined) return { actor: "unknown", basis: "legacy-missing" };
        if (!value || typeof value !== "object" || Array.isArray(value)
            || Object.keys(value).some(key => !["actor", "basis"].includes(key))
            || !Object.hasOwn(bases, value.basis) || bases[value.basis][0] !== value.actor) return { actor: "unknown", basis: "invalid-source" };
        return { actor: value.actor, basis: value.basis };
    }
    const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
    function hostEnvelope(event) {
        const data = event?.data ?? {};
        if (data.transformedContent === undefined) return null;
        // Some host versions omit execution mode; it is not sender evidence.
        if (event.type !== "user.message" || typeof data.content !== "string" || !data.content
            || typeof data.transformedContent !== "string"
            || !uuid.test(data.messageId ?? "") || !["idle", "queued", "steering"].includes(data.delivery)
            || data.agentMode !== undefined && !["interactive", "plan", "autopilot"].includes(data.agentMode)) return "invalid";
        let displayed = data.transformedContent, attachmentLength = 0;
        const imageReminder = "\n\n<system_reminder>\nThe user mentioned images and they have been attached to this message in the order they were mentioned.\n</system_reminder>";
        if (!displayed.endsWith(data.content) && displayed.endsWith(imageReminder)) {
            attachmentLength = imageReminder.length;
            displayed = displayed.slice(0, -imageReminder.length);
            if (!displayed.endsWith(data.content)) return "invalid";
        }
        if (!displayed.endsWith(data.content)) {
            const boundary = displayed.lastIndexOf("\n\n<canvas-context>");
            if (boundary < 0) return "invalid";
            const attachment = displayed.slice(boundary);
            if (!/^\n\n<canvas-context>[\s\S]*<\/canvas-context>\s*$/.test(attachment)
                || [...attachment.matchAll(/<\/?canvas-context\b/g)].length !== 2) return "unsupported";
            // The attachment body is opaque and untrusted; it never supplies an author.
            attachmentLength = attachment.length;
            displayed = displayed.slice(0, boundary);
            if (!displayed.endsWith(data.content)) return "invalid";
        }
        // Only inspect host-added bytes, never a tag supplied inside the displayed content.
        const prefix = displayed.slice(0, displayed.length - data.content.length);
        if (prefix.length + attachmentLength > 65536) return "unsupported";
        const stamp = prefix.match(/^<current_datetime>(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d))<\/current_datetime>\s*/);
        if (!stamp || !Number.isFinite(Date.parse(event.timestamp))
            || !Number.isFinite(Date.parse(stamp[1])) || Math.abs(Date.parse(stamp[1]) - Date.parse(event.timestamp)) > 1000) return "invalid";
        let rest = prefix.slice(stamp[0].length), sender = false;
        if (!rest.trim()) return "direct";
        while (rest.trim()) {
            const block = rest.match(/^<([a-z_]+)>([\s\S]*?)<\/\1>\s*/);
            if (!block || !["cross_session_message", "copilot_tauri_workspace", "copilot_working_context", "copilot_artifacts"].includes(block[1])) return "unsupported";
            if (block[1] === "cross_session_message") {
                const fields = [...block[2].matchAll(/^(from_(?:project_)?session_id):[ \t]*(\S+)[ \t]*$/gm)];
                if (sender || !fields.length || fields.length > 2 || new Set(fields.map(field => field[1])).size !== fields.length
                    || fields.some(field => !uuid.test(field[2]))) return "invalid";
                sender = true;
            }
            rest = rest.slice(block[0].length);
        }
        return sender ? "agent" : "unsupported";
    }
    function fromEvent(event, { agentCreatedFirstMessage = false } = {}) {
        const data = event?.data ?? {}, source = data.source;
        if (data.isAutopilotContinuation !== undefined && typeof data.isAutopilotContinuation !== "boolean") return { actor: "unknown", basis: "invalid-source" };
        const continuation = data.isAutopilotContinuation === true || source === "autopilot";
        const envelope = hostEnvelope(event);
        if (source === "user") return continuation || envelope === "agent"
            ? { actor: "unknown", basis: "conflicting-source" } : { actor: "user", basis: "source-user" };
        if (typeof source === "string" && /^agent-[^\s]{1,200}$/.test(source)) return { actor: "agent", basis: "source-agent" };
        if (continuation && (source === undefined || source === "autopilot")) return { actor: "agent", basis: "autopilot" };
        if (source === "system") return { actor: "unknown", basis: continuation ? "conflicting-source" : "system-source" };
        if (source === undefined && envelope === "agent") return { actor: "agent", basis: "host-agent-envelope" };
        if (source === undefined && envelope === "direct" && !agentCreatedFirstMessage) return { actor: "user", basis: "host-direct-input" };
        if (source === undefined && ["invalid", "unsupported"].includes(envelope)) return { actor: "unknown", basis: envelope === "invalid" ? "invalid-source" : "unsupported-source" };
        return { actor: "unknown", basis: source === undefined ? "missing-source" : "unsupported-source" };
    }
    function originKind(record, prompt = record?.userPrompt) {
        return ["copilot-app", "copilot-app-chat"].includes(record?.sourceHost)
            && typeof record.sourceSessionId === "string" && record.sourceSessionId.length > 0
            && typeof prompt?.sourceEventId === "string" && prompt.sourceEventId.length > 0
            && prompt.provenance !== "ui-action" ? "copilot-chat" : "unverified";
    }
    function label(prompt, { ownerVoice = true, originKind: kind = prompt?.originKind } = {}) {
        const actor = read(prompt).actor;
        return actor === "user" ? ownerVoice ? "My prompt" : "User prompt"
            : actor === "agent" ? "Agent prompt" : kind === "copilot-chat" ? "Copilot chat prompt" : "Prompt";
    }
    function reason(prompt) { return bases[read(prompt).basis][1]; }
    function correlateKickoff(prompt) {
        const current = read(prompt);
        if (current.actor === "user" && current.basis !== "host-direct-input" || ["conflicting-source", "invalid-source", "unsupported-source", "system-source"].includes(current.basis)) {
            return { actor: "unknown", basis: "conflicting-source" };
        }
        return current.actor === "agent" ? current : { actor: "agent", basis: "parent-kickoff" };
    }
    function merge(previous, next) {
        if (typeof previous?.sourceEventId === "string" && previous.sourceEventId && previous.sourceEventId === next?.sourceEventId
            && (previous.sourceTimestamp !== next.sourceTimestamp || previous.text !== next.text)) {
            return { actor: "unknown", basis: "conflicting-source" };
        }
        const before = read(previous), after = read(next);
        if (before.basis === "parent-kickoff" && after.basis === "host-direct-input") return before;
        if (after.basis === "parent-kickoff" && before.basis === "host-direct-input") return after;
        if (before.basis === "conflicting-source" || after.basis === "conflicting-source"
            || before.actor !== "unknown" && after.actor !== "unknown" && before.actor !== after.actor) {
            return { actor: "unknown", basis: "conflicting-source" };
        }
        if (before.actor !== "unknown" && ["invalid-source", "unsupported-source"].includes(after.basis)
            && previous.authorshipVersion > (next.authorshipVersion ?? 1)) return before;
        if (["legacy-missing", "missing-source"].includes(after.basis) && before.basis !== "legacy-missing") return before;
        return after;
    }
    function capture(prompt) {
        const value = prompt?.capture;
        if (value === undefined) return null;
        const reasons = [null, "credential-excluded", "unsupported-content", "malformed-line", "oversized-line",
            "initial-window", "context-evicted", "unlinked", "ambiguous-link", "unavailable"];
        if (!value || value.version !== 1 || Object.keys(value).some(key =>
            !["version", "kind", "original", "hostContext", "reason", "conflict"].includes(key))
            || !["message", "automatic-continuation", "unknown"].includes(value.kind)
            || !["recorded", "empty", "unavailable"].includes(value.original)
            || !["not-collected", "empty", "absent", "unknown"].includes(value.hostContext)
            || !reasons.includes(value.reason) || value.conflict !== undefined && typeof value.conflict !== "boolean") {
            return { version: 1, kind: "unknown", original: "unavailable", hostContext: "unknown", reason: "unavailable" };
        }
        const actual = prompt.status === "unavailable" || typeof prompt.text !== "string"
            || prompt.status !== "full" && !prompt.text.trim() ? "unavailable"
            : prompt.text.trim() ? "recorded" : "empty";
        return { ...value, original: actual, reason: actual !== value.original ? "unavailable" : value.reason };
    }
    function availability(prompt) {
        const evidence = capture(prompt), text = prompt?.status !== "unavailable" && typeof prompt?.text === "string" && prompt.text.trim();
        if (text) return { state: "recorded", notice: evidence?.reason === "ambiguous-link"
            ? "Recorded message links disagree. The first saved association is shown."
            : evidence?.conflict ? "The source changed this message. The first saved text is shown." : null };
        if (evidence?.conflict) return { state: "unavailable", notice: "The source changed this message. The first saved message had no text." };
        if (prompt?.status === "full" && typeof prompt.text === "string" && !prompt.text.trim()
            && (evidence?.kind === "automatic-continuation" && evidence.original === "empty" && evidence.reason === null
                || !evidence && read(prompt).basis === "autopilot")) {
            return { state: "automatic", notice: "No new message was sent." };
        }
        const notices = {
            "credential-excluded": "Prompt text was excluded for privacy.",
            "unsupported-content": "The recorded message format is not supported.",
            "malformed-line": "Prompt unavailable: a saved history entry could not be read.",
            "oversized-line": "Prompt unavailable: a saved history entry exceeded the read limit.",
            "initial-window": "Prompt unavailable: the beginning of this history was outside the read window.",
            "context-evicted": "Prompt unavailable: earlier message context exceeded the saved limit.",
            "unlinked": "No message could be linked to this activity.",
            "ambiguous-link": "The recorded message links disagree; no prompt was chosen.",
        };
        if (evidence?.reason && notices[evidence.reason]) return {
            state: ["unlinked", "ambiguous-link", "credential-excluded"].includes(evidence.reason) ? "unavailable" : "gap",
            notice: notices[evidence.reason],
        };
        if (evidence?.original === "empty" && evidence.reason === null) return { state: "empty", notice: "The recorded message was empty." };
        return { state: "unavailable", notice: prompt?.status === "full" && typeof prompt.text === "string"
            ? "No prompt text retained" : "Prompt text unavailable" };
    }
    function display(prompt, options) {
        const state = availability(prompt);
        const noNewMessage = state.state === "automatic" || prompt?.activityState === "automatic"
            && prompt.status === "unavailable" && prompt.text === null && prompt.availabilityNote === "No new message was sent.";
        const captured = capture(prompt);
        const automatic = noNewMessage || state.state === "recorded" && (read(prompt).basis === "autopilot"
            || captured?.kind === "automatic-continuation" && captured.reason === null && !captured.conflict);
        return { label: automatic ? `${read(prompt).actor === "agent" ? "Agent prompt" : "Author unverified"} (automatic continuation)`
            : label(prompt, options),
            notice: noNewMessage ? "Work continued without a new message." : state.notice, automatic };
    }
    return { version: 5, actors, selection, filterValue, validSelection, selectionLabel, originKind, read, fromEvent, label, display, reason, correlateKickoff, merge, capture, availability };
}

export const promptAuthorship = createPromptAuthorship();

// Original text is immutable; legacy copies must not acquire inferred capture facts.
export function mergePromptMetadata(prior, next) {
    return {
        ...prior, authorship: promptAuthorship.merge(prior, next),
        ...(next.authorshipVersion ? { authorshipVersion: Math.max(prior.authorshipVersion ?? 1, next.authorshipVersion) } : {}),
        ...(prior.capture && (prior.text !== next.text || prior.sourceTimestamp !== next.sourceTimestamp || next.capture?.conflict
            || next.capture?.reason === "ambiguous-link")
            ? { capture: { ...promptAuthorship.capture(prior),
                ...(prior.text !== next.text || prior.sourceTimestamp !== next.sourceTimestamp || next.capture?.conflict ? { conflict: true } : {}),
                ...(next.capture?.reason === "ambiguous-link" ? { reason: "ambiguous-link" } : {}) } } : {}),
    };
}

export function promptAvailabilityFields(prompt) {
    const availability = promptAuthorship.availability(prompt);
    return prompt?.capture || availability.state === "automatic"
        ? { activityState: availability.state, ...(availability.notice ? { availabilityNote: availability.notice } : {}) } : {};
}

export function promptCapture(event, reason = null) {
    const data = event?.data ?? {};
    return {
        version: 1,
        kind: data.isAutopilotContinuation === true || data.source === "autopilot" ? "automatic-continuation" : "message",
        original: reason || typeof data.content !== "string" ? "unavailable" : data.content.trim() ? "recorded" : "empty",
        hostContext: typeof data.transformedContent === "string" ? data.transformedContent.length ? "not-collected" : "empty"
            : data.transformedContent === undefined ? "absent" : "unknown",
        reason: reason ?? (typeof data.content !== "string" ? "unsupported-content" : null),
    };
}

// Undefined means a verified prefix is still being read; null means its boundary is unavailable.
export function observeFirstPrompt(previous, event) {
    if (previous !== undefined) return previous;
    if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") return null;
    if (event.type !== "user.message") return undefined;
    return typeof event.id === "string" && event.id ? event.id : null;
}

export function promptRecord(event, context) {
    if (!event) return { text: null, status: "unavailable", provenance: "unavailable",
        authorship: { actor: "unknown", basis: "missing-source" } };
    const text = event.data?.content;
    return {
        text: typeof text === "string" ? text : null,
        status: typeof text === "string" ? "full" : "unavailable",
        provenance: "recorded-user-message-origin-unverified",
        authorship: event.data?.wirePromptAuthorship === undefined ? promptAuthorship.fromEvent(event, context)
            : promptAuthorship.read({ authorship: event.data.wirePromptAuthorship }),
        authorshipVersion: event.data?.wirePromptAuthorship === undefined ? promptAuthorship.version
            : event.data.wirePromptAuthorshipVersion ?? 1,
        sourceEventId: event.id, sourceTimestamp: event.timestamp,
        ...(event.data?.wirePromptCapture ? { capture: promptAuthorship.capture({
            capture: event.data.wirePromptCapture, text: typeof text === "string" ? text : null,
            status: typeof text === "string" ? "full" : "unavailable",
        }) } : {}),
    };
}
