// Shared, serialized presentation contract. Local history coverage is not an action outcome.
export function createCollectionStatus() {
    const dispositions = {
        eligible: "Copilot chats with a verified local history location",
        archived: "archived Copilot chats",
        "unmapped-invalid-id": "Copilot chats with an invalid identifier",
        "nonlocal-not-read": "Copilot chats hosted elsewhere",
        "ambiguous-project-mapping": "Copilot chats linked to more than one project",
        "unmapped-workspace-session": "Copilot chats without a verified workspace link",
    };
    const reasons = {
        missing: { label: "Saved Copilot chat history file not found", explanation: "The file was not found at its approved local location. Activity not already collected from this chat is unavailable.", guidance: "Review the approved source if its location has changed. Checking again cannot recreate an absent file.", aliases: "missing absent ENOENT" },
        permission: { label: "Access denied to saved Copilot chat history", explanation: "The operating system denied access to this chat's history file. Uncollected activity in it is unavailable.", guidance: "Check access to the approved source. This app cannot change file permissions; it can read the file only after access is restored.", aliases: "permission unreadable EACCES EPERM" },
        read: { label: "Saved Copilot chat history file could not be read", explanation: "A local file error prevented this chat's history from being read. Uncollected activity in it is unavailable.", guidance: "Check that the approved source is accessible. A later check may succeed if the file becomes readable.", aliases: "read error unreadable busy" },
        unsupported: { label: "Saved Copilot chat history could not be verified", explanation: "The file's opening record is incomplete, invalid, or does not match the supported chat identity and format. No new history was read from it.", guidance: "Review the approved source. There is no automatic repair; this app will not guess a file's format or chat identity.", aliases: "unsupported invalid source startup identity schema" },
        unknown: { label: "Saved Copilot chat history read failed for an unknown reason", explanation: "This chat's saved history could not be read. The available diagnostic does not establish the cause.", guidance: "Review the approved source and technical details for support. A later check may succeed, but there is no known automatic fix.", aliases: "unknown unreadable failed" },
        truncated: { label: "Older Copilot chat history exceeds the file read limit", explanation: "The initial read starts within the file's last 64 MiB. Earlier activity may be absent even when it falls inside the selected history window.", guidance: "There is no automatic import of the omitted portion. A wider history window or another check does not remove this size limit.", aliases: "truncated older tail size cap" },
        malformed: { label: "Some Copilot chat history entries have an invalid format", explanation: "Some entries could not be read as saved history records (invalid JSON). Only the activity in those skipped entries may be absent.", guidance: "Readable entries can still be collected. This app cannot reconstruct the skipped entries.", aliases: "malformed invalid JSON unreadable entries decoded" },
        oversized: { label: "Some Copilot chat history entries exceed the size limit", explanation: "Saved entries larger than 1 MiB were skipped. Activity in those entries may be absent; this does not make the whole file unavailable.", guidance: "Readable entries can still be collected. Another check does not remove the per-entry size limit.", aliases: "oversized large size cap" },
        context: { label: "Some request-to-action links may be incomplete", explanation: "Older connecting context was dropped from the collector's limited working memory. A request and its later action or result may not be linked.", guidance: "Collected evidence stays. This app does not infer absent links; this warning does not establish that a tool call failed.", aliases: "context not retained correlation evictions relationships" },
    };
    const checkSummaries = {
        missing: "The file was not found. Review its approved location; another check cannot recreate an absent file.",
        permission: "The operating system denied access. Check access to the approved source before checking again.",
        read: "A local file error prevented reading. Check source access; a later check may succeed.",
        unsupported: "The opening record or chat identity could not be verified. WIRE will not guess or repair the format.",
        unknown: "The diagnostic does not establish why this read failed. Review the source; no automatic fix is known.",
        truncated: "The initial read covers only the last 64 MiB. Another check or a wider window does not recover the omitted portion.",
        malformed: "Invalid JSON entries were skipped. Readable entries remain; skipped entries cannot be reconstructed.",
        oversized: "Entries over 1 MiB were skipped. Another check does not remove that size limit.",
        context: "Older linking context exceeded the collector's working-memory limit. Request, action or result links may be absent; collected evidence stays.",
    };
    function searchTerms(row) {
        return [row.name, row.project, row.sessionId, row.unavailable ? "Unavailable history" : "Limited history",
            ...row.reasons.flatMap(reason => [reason, reasons[reason]?.label, reasons[reason]?.aliases])];
    }
    function coverage(roster = [], cursors = [], evidenceIds = []) {
        const saved = new Map(cursors.map(row => [row.sessionId, row]));
        const retained = new Set(evidenceIds), issues = [], seen = new Set();
        const summary = { eligible: 0, readable: 0, pending: 0, unavailable: 0, limited: 0, affected: 0, groups: {}, excluded: {} };
        for (const source of roster) {
            if (seen.has(source.sessionId)) continue;
            seen.add(source.sessionId);
            if (!source.eligible) {
                const disposition = source.disposition ?? "unknown";
                summary.excluded[disposition] = (summary.excluded[disposition] ?? 0) + 1;
                continue;
            }
            summary.eligible++;
            const row = saved.get(source.sessionId), categories = [];
            if (row?.error) {
                categories.push(row.errorCode === "ENOENT" ? "missing"
                    : ["EACCES", "EPERM"].includes(row.errorCode) ? "permission"
                    : ["EIO", "EBUSY", "EMFILE", "ENFILE", "EISDIR", "ENOTDIR"].includes(row.errorCode) ? "read"
                    : ["HISTORY_STARTUP_INVALID", "HISTORY_IDENTITY_UNSUPPORTED"].includes(row.errorCode) ? "unsupported" : "unknown");
                summary.unavailable++;
            } else if (row?.scanned) summary.readable++;
            if (!row || (!row.error && (!row.scanned || (row.cursor?.backlogBytes ?? 0) > (row.cursor?.partialBytes ?? 0)))) summary.pending++;
            for (const [key, amount] of [["truncated", row?.cursor?.droppedBytes], ["malformed", row?.cursor?.malformedLines],
                ["oversized", row?.cursor?.oversizedLines], ["context", row?.diagnostics?.contextEvictions]]) {
                if (amount > 0) categories.push(key);
            }
            if (!categories.length) continue;
            if (!row.error) summary.limited++;
            summary.groups[categories[0]] = (summary.groups[categories[0]] ?? 0) + 1;
            issues.push({
                sessionId: source.sessionId, name: source.name || "Copilot chat name not recorded",
                project: source.project || null, projectId: source.projectId || null,
                reasons: categories, unavailable: Boolean(row.error), lastAttemptAt: row.lastAttemptAt ?? null,
                hasPriorEvidence: retained.has(source.sessionId),
            });
        }
        summary.affected = issues.length;
        return { summary, issues };
    }
    function view(status) {
        const c = status.historyCoverage ?? {};
        const allUnavailable = c.eligible > 0 && c.unavailable === c.eligible && !c.pending;
        const severity = status.error || allUnavailable || status.state === "stopped" ? "error"
            : c.affected || c.unavailable || c.limited ? "warning" : "normal";
        const label = !status.config ? "Set up collection"
            : status.error ? "Collection cannot check history"
            : status.state === "stopped" ? "Collection stopped"
            : status.state === "paused" ? "Collection paused"
            : !status.discovery || !status.lastCheckedAt ? "Checking history"
            : allUnavailable ? "History unavailable"
            : c.pending ? "Importing history"
            : status.state === "collecting" ? "Checking history"
            : c.eligible === 0 ? "No local Copilot chats to collect" : "Collection active";
        return { label, severity };
    }
    function entry(status, { hasEvidence = false, unavailable = false, reason = "" } = {}) {
        const retained = hasEvidence ? " Retained evidence is still available." : "";
        if (unavailable) return { severity: "error",
            text: (reason === "runtime_unavailable" ? "Local runtime unavailable. Start WIRE if it is stopped, then retry." : "Collection status unavailable. Retry the connection.")
                + (hasEvidence ? " Showing the last accepted view." : ""),
            action: "View collection status" };
        if (!status) return null;
        if (!status.config?.approved) return { severity: "normal",
            text: hasEvidence ? "Collection is not connected. Retained evidence is available." : "Connect local Copilot chats to collect Work IQ activity.",
            action: "Review source in Settings" };
        const state = view(status);
        if (state.severity === "error") return { severity: "error", text: state.label + "." + retained,
            action: state.label === "History unavailable" ? "View history issues" : "View collection status", issues: state.label === "History unavailable" };
        if (status.state === "paused") return { severity: "normal", text: "Collection is paused." + retained, action: "Open Settings" };
        // Routine checks and historical gaps belong in Collection status, not the entry viewport.
        if (!hasEvidence) {
            if (!status.discovery || !status.lastCheckedAt || status.historyCoverage?.pending) return {
                severity: "normal", text: "Reading approved Copilot chat history. No activity collected yet.", action: "View collection details" };
            if (status.historyCoverage?.eligible === 0) return {
                severity: "normal", text: "No verified local Copilot chat histories were found.", action: "Review source in Settings" };
        }
        return null;
    }
    return { reasons, checkSummaries, dispositions, coverage, view, entry, searchTerms };
}
