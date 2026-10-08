// Serialized with the client. Completion belongs to a check AND an applied snapshot.
export function createFreshActivity() {
    let sequence = 0, phase = "idle", check = null, message = "", context = "", coverage = "", details = "";
    return {
        snapshot: () => ({ token: sequence, phase, check, message, context, coverage, details }),
        busy: () => ["checking", "applying", "waiting"].includes(phase),
        fail(token, error) {
            if (token !== sequence || !["checking", "applying"].includes(phase)) return false;
            phase = "error";
            message = check ? "Check finished; view not updated." : "Local check not confirmed.";
            context = `Previous view kept. ${error}`;
            coverage = ""; details = "";
            return true;
        },
        defer() {
            if (phase === "applying") {
                phase = "waiting";
                message = "Check finished; view waiting.";
                context = "Close the current review or finish editing to apply it. Your preview stays frozen.";
            }
        },
        retryApply() {
            if (["error", "waiting"].includes(phase) && check) {
                phase = "applying";
                message = "Applying checked activity...";
                context = "Reading stored evidence; collection is not repeated.";
            }
        },
        begin() {
            if (["checking", "applying", "waiting"].includes(phase)) return null;
            sequence++;
            phase = "checking"; check = null; message = "Checking local Copilot history...";
            context = ""; coverage = ""; details = "";
            return sequence;
        },
        collected(token, receipt) {
            if (token !== sequence || phase !== "checking") return false;
            if (receipt?.schemaVersion !== 2 || !receipt.id || !Number.isSafeInteger(receipt.revision) || !receipt.configVersion
                || !Number.isFinite(Date.parse(receipt.completedAt)) || !["complete", "partial"].includes(receipt.outcome)
                || !Array.isArray(receipt.changes?.items) || !Number.isSafeInteger(receipt.changes.added) || !Number.isSafeInteger(receipt.changes.updated)) {
                throw new Error("The runtime did not confirm a completed local check. The previous view is kept.");
            }
            if (receipt.changes.added + receipt.changes.updated > 0 && (!Number.isSafeInteger(receipt.beforeRevision) || receipt.revision <= receipt.beforeRevision)) {
                throw new Error("The check claimed new evidence without a newer committed revision. Refresh stored data; no collection was repeated.");
            }
            check = receipt; phase = "applying"; message = "Applying checked activity...";
            return true;
        },
        applied(revision, configVersion, rows) {
            if (phase === "error" && !check) {
                message = "Stored data refreshed; check still unconfirmed.";
                context = "Only stored evidence was read. " + context.replace(/^(Previous view kept|Only stored evidence was read)\. /, "");
            }
            if (!["applying", "waiting", "complete", "partial"].includes(phase) || !check || revision < check.revision) return false;
            if (configVersion !== check.configVersion) {
                if (phase === "applying") throw new Error("The approved source changed during this check. Review the current connection before checking again.");
                phase = "idle"; check = null;
                message = "Collection settings changed.";
                context = "Check the current approved source for new activity.";
                coverage = ""; details = "";
                return false;
            }
            const { added, updated, items } = check.changes;
            const changes = added + updated;
            const visible = items.filter(item => rows.some(row => item.rowId
                ? row.id === item.rowId || row.parentCallId === item.rowId
                : row.sourceSessionId === item.sourceSessionId && (item.kind === "tool" ? row.toolCallId === item.id : row.activityId === item.id))).length;
            const counts = [added ? `${added.toLocaleString()} new` : "", updated ? `${updated.toLocaleString()} updated` : ""].filter(Boolean).join(", ");
            message = changes ? `${counts} activity record${changes === 1 ? "" : "s"}.` : "No new recorded activity.";
            context = changes && visible < changes
                ? `${visible ? "Some updates are" : "Updates are"} outside this view's filters or evidence layer.`
                : "";
            coverage = "";
            details = check.coverageChanged ? "Source coverage changed. " : "";
            const elapsed = Date.parse(check.completedAt) - Date.parse(check.startedAt);
            if (Number.isFinite(elapsed) && elapsed >= 0) details += `Checked ${check.sourcesChecked.toLocaleString()} of ${check.eligibleSources.toLocaleString()} eligible Copilot chats in ${elapsed.toLocaleString()} ms. `;
            if (check.eligibleSources === 0) details += "No eligible local chats were found. This does not establish that there is no activity elsewhere in Copilot. ";
            if (check.outcome === "partial") {
                phase = "partial";
                const gaps = [], summary = [];
                if (check.coverage?.unavailable) gaps.push(`${check.coverage.unavailable.toLocaleString()} ${check.coverage.unavailable === 1 ? "history" : "histories"} unavailable`);
                if (check.coverage?.limited) gaps.push(`${check.coverage.limited.toLocaleString()} with limits`);
                if (check.pendingSources || check.sourcesChecked < check.eligibleSources) gaps.push("more history remains to read");
                if (check.partialSources) gaps.push("unfinished log entries");
                if (check.skippedSources) gaps.push("source discovery limit reached");
                for (const [amount, label] of [[check.coverage?.unavailable, "unavailable"], [check.coverage?.limited, "with limits"],
                    [check.pendingSources, "still reading"], [check.partialSources, "awaiting a saved entry"],
                    [check.skippedSources, "beyond the discovery limit"], [check.eligibleSources - check.sourcesChecked, "not checked this cycle"]]) {
                    if (amount > 0) summary.push(`${amount.toLocaleString()} ${label}`);
                }
                coverage = summary.length ? `Chat history: ${summary.join(" · ")}` : "History coverage incomplete";
                details += `Partial check: ${gaps.join("; ") || "coverage is incomplete"}. Results cover only the history read. Missing history is not a Work IQ service error.`;
                if (check.pendingSources || check.sourcesChecked < check.eligibleSources) details += " Further checks can continue reading pending history.";
                if (check.partialSources) details += " An unfinished entry can be read after Copilot finishes saving it.";
                if (check.skippedSources) details += " Chats beyond the discovery limit were not checked; repeating the check does not remove that limit.";
            } else phase = "complete";
            details = details.trim();
            return true;
        },
    };
}
