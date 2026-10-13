// Serialized with the client. Source completion needs its receipt AND an applied snapshot.
export function createFreshActivity({ sourceUnknown = false, sourceWarning = "" } = {}) {
    let sequence = 0, phase = "idle", check = null, message = "", context = "", coverage = "", details = "";
    let sourceFailure = null, readFailed = false;
    const sourceMessage = reason => reason === "source_paths_invalid" ? "Source paths need attention."
        : reason === "source_metadata_unavailable" ? "Local history could not be read."
        : reason === "source_mapping_unsupported" ? "Local history format is not supported."
        : "Local history check failed.";
    const sourceContext = () => sourceFailure.reason === "source_paths_invalid"
        ? "The saved paths must be absolute and name data.db and session-state."
        : sourceFailure.error;
    if (sourceUnknown) {
        phase = "unconfirmed";
        message = "Earlier source check unconfirmed.";
        context = "Only stored activity can be refreshed; the earlier check will not be repeated.";
    }
    return {
        snapshot: () => ({ token: sequence, phase, check, message, context, coverage, details, sourceUnknown, sourceWarning,
            sourceBlocked: Boolean(sourceWarning), sourceFailure, readFailed,
            recovery: readFailed || sourceUnknown || sourceWarning ? "stored" : sourceFailure ? "source" : null }),
        busy: () => ["checking", "applying", "waiting"].includes(phase),
        blockSource(reason) {
            sourceWarning = reason;
            if (phase === "checking") {
                phase = "error";
                message = "Source check not started.";
                context = "Previous view kept.";
            }
        },
        fail(token, error, { rejected = false, reason = "", configVersion, revision, lastCheckId } = {}) {
            if (token !== sequence || !["checking", "applying"].includes(phase)) return false;
            const checking = phase === "checking";
            if (checking) {
                const knownSourceFailure = ["source_paths_invalid", "source_metadata_unavailable", "source_mapping_unsupported"].includes(reason);
                sourceUnknown = !rejected && !knownSourceFailure;
                sourceFailure = sourceUnknown ? null : { reason, error, configVersion, revision, lastCheckId };
            }
            readFailed = !checking;
            phase = "error";
            message = check ? "Check finished; view not updated." : checking
                ? sourceFailure ? sourceMessage(reason) : "Local check not confirmed." : "Stored view not updated.";
            const cause = reason === "runtime_unavailable" ? "WIRE could not be reached."
                : reason === "invalid_response" ? "WIRE returned an unreadable response." : error;
            context = sourceFailure && checking ? `Previous view kept. ${sourceContext()}`
                : sourceUnknown && checking ? `Previous view kept. ${cause} Source check outcome unknown; it will not be repeated.`
                : `Previous view kept. ${cause}` + (sourceUnknown ? " Source check outcome unknown; it will not be repeated." : "");
            coverage = ""; details = "";
            return true;
        },
        defer() {
            if (phase === "applying") {
                phase = "waiting";
                message = check ? "Check finished; view waiting." : "Stored view waiting.";
                context = "Close the current review or finish editing to apply it. Your preview stays frozen.";
            }
        },
        retryApply({ configVersion } = {}) {
            if (["error", "waiting", "unconfirmed", "applying"].includes(phase)) {
                if (check && configVersion !== undefined && configVersion !== check.configVersion) check = null;
                phase = "applying";
                message = check ? "Applying checked activity..." : "Reading stored activity...";
                context = "Reading stored evidence; collection is not repeated.";
            }
        },
        begin({ checkSource = true } = {}) {
            if (["checking", "applying", "waiting"].includes(phase) || checkSource && (sourceUnknown || sourceWarning)) return null;
            sequence++;
            phase = checkSource ? "checking" : "applying"; check = null;
            if (checkSource) sourceFailure = null;
            readFailed = false;
            message = checkSource ? "Checking local Copilot history..." : "Reading stored activity...";
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
                throw new Error("The check claimed new evidence without a newer committed revision. Retry the stored read; no collection was repeated.");
            }
            check = receipt; phase = "applying"; message = "Applying checked activity...";
            sourceUnknown = false;
            return true;
        },
        applied(revision, configVersion, rows) {
            if (sourceFailure?.configVersion !== undefined && configVersion !== undefined && configVersion !== sourceFailure.configVersion) {
                sourceFailure = null;
                if (!readFailed && !check && ["error", "complete"].includes(phase)) phase = "applying";
            }
            if (phase === "applying" && !check) {
                phase = sourceUnknown ? "unconfirmed" : "complete";
                readFailed = false;
                message = sourceUnknown ? "Stored data refreshed; source check unconfirmed."
                    : sourceFailure ? sourceMessage(sourceFailure.reason) : "Stored activity refreshed.";
                context = sourceUnknown
                    ? "The source check outcome is unknown; it will not be repeated."
                    : sourceFailure ? `Stored activity refreshed; local history was not checked again. ${sourceContext()}`
                    : "No source history was checked.";
                return true;
            }
            if (phase === "error" && !check) {
                if (sourceFailure && !readFailed) {
                    message = sourceMessage(sourceFailure.reason);
                    context = `Stored activity refreshed; local history was not checked again. ${sourceContext()}`;
                }
                return false;
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
            readFailed = false;
            details = details.trim();
            return true;
        },
    };
}
