import { searchFieldMarkup } from "./search-field.mjs";

export function describeRecollection(phase, { preview, result, busy = false, error = false } = {}) {
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    const data = phase === "complete" ? result : preview;
    const exact = data?.mode === "verified-records-only";
    const records = count(exact ? data.counts?.[phase === "complete" ? "added" : "proposed"] : data?.counts?.records);
    const calls = n => `${n.toLocaleString()} verified call${n === 1 ? "" : "s"}`;
    const prompts = count(result?.counts?.restoredPrompts);
    const scopeAvailable = Boolean(preview?.scope?.from && preview?.scope?.to);
    return {
        records,
        scopeAvailable,
        canConfirm: phase === "preview" && !busy && scopeAvailable && records !== null && records > 0,
        confirmLabel: exact && records !== null ? `Add ${calls(records)}` : records === null ? "Read selected history again" : `Read ${records.toLocaleString()} record${records === 1 ? "" : "s"} again`,
        decisionPhase: phase === "preview" ? "confirm" : phase === "uncertain" ? busy ? "checking" : "unknown"
            : ["pending", "complete"].includes(phase) ? phase : error || ["not-started", "blocked"].includes(phase) ? "error" : "",
        title: phase === "complete" && exact && records !== null ? `${calls(records)} added`
            : phase === "preview" && exact && records !== null ? records ? `Add ${calls(records)}?` : "No verified calls proposed"
            : phase === "complete" ? records === null ? "Recollection completed" : `${records.toLocaleString()} record${records === 1 ? "" : "s"} read again`
            : phase === "not-started" ? "No recollection was committed"
            : phase === "blocked" ? "Recollection recovery unavailable"
            : phase === "uncertain" ? busy ? "Checking recollection result..." : "Result not yet confirmed"
            : phase === "pending" ? records === null ? "Reading confirmed history..." : `Reading ${records.toLocaleString()} record${records === 1 ? "" : "s"} again...`
            : phase === "reading" ? "More history to preview" : phase === "verifying" ? "Finish checking the confirmed selection"
            : phase === "preview" ? records === null ? "Preview record count unavailable" : records === 0 ? "No records available in this scope"
                : records === 1 ? "Read this record again?" : `Read these ${records.toLocaleString()} records again?`
            : "Choose history to read again",
        resultMessage: phase !== "complete" ? null : exact && records !== null ? `Added ${calls(records)}. Coverage of the selected day is incomplete. Saved reports and comparisons are unchanged.`
            : records === null ? "Recollection completed; the returned record count is unavailable."
            : `Recollected ${records.toLocaleString()} record${records === 1 ? "" : "s"}.${prompts ? ` Restored ${prompts.toLocaleString()} original prompt${prompts === 1 ? "" : "s"}.` : ""} Saved reports and comparisons are unchanged.`,
    };
}

export const recollectionMarkup = `
<dialog id="recollectDialog" class="deletion-dialog decision-frame" aria-labelledby="recollectTitle" aria-describedby="recollectBoundary">
  <div class="delete-heading"><span id="recollectIcon" class="delete-warning-icon" aria-hidden="true"></span><h2 id="recollectTitle">Choose history to read again</h2></div>
  <div class="decision-body">
  <p id="recollectScopeUnavailable" hidden>Earlier selected chats and dates are not available in this page. The original operation will not be repeated.</p>
  <p id="recollectBoundary">Read selected requests again from your approved Copilot history.</p>
  <form id="recollectForm">
    <p id="recollectWindow"></p>
    <label id="recollectOperationChoice" hidden>Operation
      <select id="recollectOperation"><option value="strict">Read selected history again</option><option value="verified-records-only">Review individually verified calls</option></select>
    </label>
    <fieldset><legend>Choose local Copilot chats</legend>
      <label for="recollectSearch" class="visually-hidden">Find a chat to recollect</label>
      ${searchFieldMarkup({ id: "recollectSearch", clearId: "recollectClearSearch", placeholder: "Find a chat" })}
      <div class="recollect-selection"><p id="recollectSelected" role="status" aria-live="polite"></p><button id="recollectShowSelected" type="button" class="quiet" disabled>Show selected</button></div>
      <div id="recollectSources" tabindex="-1" aria-describedby="recollectSourceHelp"></div>
    </fieldset>
    <p id="recollectSourceHelp" class="muted">Choose up to 128 chats and a date range before previewing. Search stays in this panel.</p>
    <div class="recollect-dates"><label><span id="recollectFromLabel">From</span><input id="recollectFrom" type="date" required></label><label id="recollectToChoice">To<input id="recollectTo" type="date" required></label></div>
    <p id="recollectZone" class="muted"></p>
    <label id="recollectPromptsChoice" class="delete-choice"><input id="recollectPrompts" type="checkbox"><span>Also restore original prompts for these requests</span></label>
    <p id="recollectPromptsHelp" class="muted">Off by default. Includes available prompts and associated follow-ups.</p>
    <label id="recollectCorrectionsChoice" class="delete-choice" hidden><input id="recollectCorrections" type="checkbox"><span>Also review source-verified corrections to saved calls</span></label>
  </form>
  <div id="recollectConfirmation" hidden>
    <div class="decision-scope"><p id="recollectScope"></p><button id="recollectChange" type="button" class="quiet" hidden>Change scope</button></div>
    <p id="recollectClipped" hidden></p>
    <section id="recollectChanges"><h3 id="recollectChangesTitle">What will change</h3><p id="recollectSummary"></p><ul id="recollectCorrectionList" data-recollection-private-list hidden></ul><p id="recollectPromptSummary"></p></section>
    <h3>What stays unchanged</h3>
    <p id="recollectPreserved"></p>
    <details class="detail-disclosure"><summary id="recollectAvailabilityToggle">Source availability and limits</summary><p id="recollectBounds"></p><ul id="recollectAvailability"></ul><p id="recollectPolicy"></p><p class="muted">The preview expires after two minutes. Changes require a new preview. Refresh and restart never authorize recollection. This is a source reread, not an undo or backup restore.</p></details>
  </div>
  <section id="recollectExactReview" hidden><h3 id="recollectExactTitle">Individually verified calls</h3><p id="recollectExactCounts"></p><ul id="recollectExactMembers" data-recollection-private-list></ul></section>
  <p id="recollectStatus" class="decision-status" role="status" aria-live="polite" aria-atomic="true" tabindex="-1"></p>
  </div>
  <div class="delete-actions"><button id="recollectClose" type="button">Cancel</button><button id="recollectPreview" type="submit" form="recollectForm" data-decision-action="check" aria-describedby="recollectSelected recollectSourceHelp" disabled>Preview available evidence</button><button id="recollectContinue" type="button" hidden>Read next part</button><button id="recollectCheck" type="button" data-decision-action="check" hidden>Check recollection result</button><button id="recollectConfirm" type="button" data-decision-action="commit" hidden>Read selected history again</button></div>
</dialog>`;

export const recollectionStyles = `
#recollectDialog #recollectBoundary {color:var(--muted);margin:0 0 16px}
#recollectDialog #recollectForm {margin:0}
#recollectDialog .recollect-field {display:grid;gap:8px;margin-top:16px}
#recollectSources {width:100%;overflow-wrap:anywhere}
#recollectDialog .recollect-selection {display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:8px}
#recollectDialog .recollect-selection p {margin:0}
#recollectDialog .list-pager {flex-wrap:wrap}
#recollectSources .delete-choice {padding:8px 0;align-items:flex-start}
#recollectSources .delete-choice input {margin-top:2px}
#recollectDialog input[type=date] {min-width:0;border-radius:10px}
#recollectDialog .recollect-dates {display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}
#recollectDialog .recollect-dates label {display:grid;gap:6px;flex:1 1 12rem;min-width:0}
#recollectDialog .recollect-dates label[hidden] {display:none}
#recollectExactMembers {padding-inline-start:20px;overflow-wrap:anywhere}
#recollectExactMembers li + li {margin-top:8px}
#recollectDialog input[type=checkbox] {appearance:auto;width:20px;height:20px;flex:none;accent-color:var(--toggle-on)}
#recollectSummary {font-weight:600}
#recollectChanges {margin:16px 0;padding:4px 0 4px 16px;border-left:3px solid var(--accent)}
#recollectChanges h3 {margin:0}
#recollectChanges p {margin:8px 0}
#recollectAvailability {padding-left:20px;overflow-wrap:anywhere}
#recollectAvailability li {margin-top:12px}
#recollectStatus:empty {display:none}
#recollectDialog #recollectConfirmation {margin:0;padding:0}
`;

// Serialized into the page; dependencies stay inside the mount function.
export function mountRecollection({ api, time, timeContext, search, pageSources, ux, searchFields, describe, canAct, onChanged, onNotice, onCommitted }) {
    if (typeof api !== "function" || typeof api.publicationToken !== "function" || typeof api.isCurrent !== "function") {
        throw new TypeError("An access-aware API with publicationToken() and isCurrent() is required.");
    }
    const $ = id => document.getElementById(id), dialog = $("recollectDialog");
    const storageKey = "workiq-evidence.recollection-operation";
    let phase = "editing", token = 0, preview, part, expiryTimer, receipt, trigger, busy = false, sourcesReady = false;
    let result, statusError = false, viewNeedsRead = false, mounted = false;
    const exactMode = "verified-records-only";
    let exact = false, exactAvailable = false, newOnly = false, correctionsAvailable = false;
    let sources = [], sourceMatches = [], selectedOnly = false;
    let accessAvailable = true, accessEpoch = 0, suppressedCloses = 0;
    const publication = () => ({ epoch: accessEpoch, token: api.publicationToken() });
    const current = access => accessAvailable && access?.epoch === accessEpoch && access.token != null
        && api.isCurrent(access.token) === true;
    const blockedMessage = "The saved recollection receipt could not be read or verified. An earlier operation may be unconfirmed. Recollection is blocked; the saved entry has not been changed. Stored activity is still available.";
    const selectedSources = new Set();
    const locked = () => ["pending", "uncertain", "blocked"].includes(phase);
    const validReceipt = value => typeof value?.operationId === "string"
        && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.operationId)
        && typeof value?.receiptToken === "string" && /^[a-f0-9]{64}$/.test(value.receiptToken);
    const snapshot = () => ({ phase, busy, needsReceipt: ["uncertain", "blocked"].includes(phase), hasReceipt: Boolean(receipt), operationId: receipt?.operationId,
        message: ["pending", "uncertain", "complete", "not-started", "blocked"].includes(phase) ? $("recollectStatus").textContent : "",
        result, viewNeedsRead });
    const notify = () => { if (mounted && current(publication())) onChanged?.(snapshot()); };
    function allowed(action) {
        if (!current(publication())) return false;
        const reason = canAct?.(action);
        if (!reason) return true;
        if (dialog.open) status(reason, true); else onNotice?.(reason);
        return false;
    }
    function period(from, to, context) {
        const first = from.includes("T") ? time.day(from, context.timeZone) : from;
        const last = to.includes("T") ? time.day(to, context.timeZone) : to;
        return first === last ? time.formatDate(first, context, true)
            : `${time.formatDate(first, context, first.slice(0, 4) !== last.slice(0, 4))} to ${time.formatDate(last, context, true)}`;
    }
    function selectionCount() {
        ux.setOwnedText($("recollectSelected"), `${selectedSources.size} selected`);
        $("recollectShowSelected").disabled = !selectedSources.size && !selectedOnly;
        $("recollectShowSelected").hidden = !selectedSources.size && !selectedOnly;
        $("recollectShowSelected").textContent = selectedOnly ? "Show all chats" : "Show selected";
        for (const input of $("recollectSources").querySelectorAll("input")) input.disabled = selectedSources.size >= (exact ? 1 : 128) && !input.checked;
    }
    function chooseOperation(useExact) {
        exact = exactAvailable && useExact;
        $("recollectOperationChoice").hidden = !exactAvailable;
        $("recollectOperation").disabled = !exactAvailable;
        $("recollectOperation").value = exact ? exactMode : "strict";
        $("recollectSourceHelp").textContent = exact
            ? "Choose one chat and one day. Only missing, individually verified calls can be added. This is not a review of the full day."
            : "Choose up to 128 chats and a date range before previewing. Search stays in this panel.";
        $("recollectFromLabel").textContent = exact ? "Day" : "From";
        $("recollectToChoice").hidden = $("recollectTo").disabled = exact;
        $("recollectPromptsChoice").hidden = $("recollectPromptsHelp").hidden = $("recollectPrompts").disabled = newOnly || exact;
        $("recollectCorrectionsChoice").hidden = $("recollectCorrections").disabled = !correctionsAvailable || exact;
        if (exact || newOnly) $("recollectPrompts").checked = false;
        if (exact || !correctionsAvailable) $("recollectCorrections").checked = false;
        selectionCount();
    }
    function eraseSourceRows(root) {
        for (const field of root.querySelectorAll("label.delete-choice input")) {
            ux.removeOwnedAttribute(field, "value");
            field.value = ""; field.checked = false;
        }
        for (const text of root.querySelectorAll("label.delete-choice span, [data-page-position]")) ux.setOwnedText(text);
    }
    function erasePreviewValues() {
        for (const node of dialog.querySelectorAll("[data-recollection-private-list]")) ux.setOwnedText(node);
        for (const id of ["recollectAvailability", "recollectScope", "recollectClipped", "recollectSummary",
            "recollectPromptSummary", "recollectBounds", "recollectPolicy", "recollectExactCounts"]) ux.setOwnedText($(id));
        $("recollectExactReview").hidden = true;
    }
    function renderSources(reset = true) {
        const access = publication();
        if (!current(access)) return;
        const query = $("recollectSearch").value;
        sourceMatches.length = 0;
        const matches = sourceMatches = sources.filter(source => (!selectedOnly || selectedSources.has(source.sourceSessionId))
            && search.matches(query, [source.name]));
        searchField.sync();
        pageSources($("recollectSources"), matches, source => {
            const label = document.createElement("label"), input = document.createElement("input"), name = document.createElement("span");
            label.className = "delete-choice";
            input.type = "checkbox"; input.value = source.sourceSessionId;
            input.checked = selectedSources.has(source.sourceSessionId);
            input.disabled = selectedSources.size >= (exact ? 1 : 128) && !input.checked;
            name.textContent = source.name + (source.available ? "" : " - history unavailable");
            label.append(input, name);
            return label;
        }, reset, () => current(access), eraseSourceRows);
        if (!matches.length) {
            const empty = document.createElement("p");
            empty.textContent = selectedOnly ? "No selected chats match this search." : "No chats match. Try another name.";
            $("recollectSources").append(empty);
        }
        selectionCount();
    }
    function status(text, error = false) {
        if (!current(publication())) return;
        statusError = error;
        if ($("recollectStatus").textContent !== text) ux.setOwnedText($("recollectStatus"), text);
        $("recollectStatus").classList.toggle("error", error);
        notify();
    }
    function update() {
        if (!current(publication())) return;
        const view = describe(phase, { preview, result, busy, error: statusError });
        const reason = canAct?.(["uncertain", "blocked"].includes(phase) ? "receipt" : "preview");
        ux.setOwnedText($("recollectTitle"), view.title);
        dialog.dataset.decisionPhase = view.decisionPhase;
        dialog.dataset.operationId = receipt?.operationId || preview?.operationId || "";
        const continuing = phase === "reading" || phase === "verifying";
        $("recollectForm").inert = busy || locked() || continuing;
        $("recollectForm").hidden = ["preview", "complete", "not-started"].includes(phase) || locked() || continuing;
        $("recollectBoundary").hidden = phase !== "editing";
        $("recollectScopeUnavailable").hidden = view.scopeAvailable || !["pending", "uncertain", "complete"].includes(phase);
        $("recollectConfirmation").hidden = !view.scopeAvailable || phase === "editing";
        $("recollectChanges").hidden = phase === "complete";
        $("recollectChangesTitle").textContent = phase === "preview" ? "What will change" : "Confirmed selection";
        $("recollectPreview").hidden = phase !== "editing";
        $("recollectPreview").disabled = busy || !sourcesReady || !selectedSources.size
            || !$("recollectFrom").value || (exact ? selectedSources.size !== 1 : !$("recollectTo").value) || locked() || Boolean(reason);
        $("recollectConfirm").hidden = phase !== "preview" && phase !== "pending";
        $("recollectConfirm").disabled = !view.canConfirm || Boolean(reason);
        $("recollectContinue").hidden = !continuing;
        $("recollectContinue").disabled = !continuing || busy || Boolean(reason);
        $("recollectContinue").textContent = phase === "verifying" ? "Continue verification and save if complete" : "Read next part";
        ux.setOwnedText($("recollectConfirm"), view.confirmLabel);
        $("recollectChange").hidden = phase !== "preview";
        $("recollectChange").disabled = busy || locked();
        $("recollectCheck").hidden = phase !== "uncertain";
        $("recollectCheck").disabled = busy || Boolean(reason);
        $("recollectClose").disabled = phase === "pending";
        $("recollectClose").textContent = ["complete", "uncertain", "not-started", "blocked"].includes(phase) ? "Close" : "Cancel";
        ux.pending($("recollectPreview"), busy && phase === "editing");
        ux.pending($("recollectConfirm"), phase === "pending");
        ux.pending($("recollectCheck"), busy && phase === "uncertain");
        const icon = phase === "complete" ? "check" : ["uncertain", "blocked"].includes(phase) && !busy ? "unobserved" : busy || phase === "pending" ? "pending" : "activity";
        if ($("recollectIcon").dataset.icon !== icon) {
            $("recollectIcon").replaceChildren(ux.icon(icon));
            $("recollectIcon").dataset.icon = icon;
        }
        $("recollectIcon").firstElementChild.classList.toggle("pending-indicator", busy || phase === "pending");
        notify();
    }
    function cancelPreview() {
        clearTimeout(expiryTimer);
        const access = publication();
        if (!current(access) || !preview && !part) return;
        const operationId = part?.operationId ?? preview.operationId;
        part = undefined;
        preview = undefined;
        api("/api/recollection/cancel", { operationId }).catch(error => {
            if (!current(access)) return;
            status(`Preview cancellation could not be confirmed. No recollection was requested; it will expire. ${error.message}`, true);
        });
    }
    function edit() {
        if (!current(publication()) || locked()) return;
        token++;
        cancelPreview();
        erasePreviewValues();
        phase = "editing";
        update();
    }
    function expirePreview() {
        const expiring = part ?? preview;
        if (!["preview", "reading", "verifying"].includes(phase) || !expiring || !current(publication()) || Date.parse(expiring.expiresAt) > Date.now()) return false;
        const verification = phase === "verifying";
        preview = part = undefined;
        phase = verification ? "uncertain" : "editing";
        erasePreviewValues();
        status(verification ? "Verification expired. Check the original receipt; do not repeat confirmation."
            : "The preview expired. Nothing was saved. Preview again.", true);
        update();
        return true;
    }
    function scope() {
        return { sourceSessionIds: [...selectedSources],
            from: $("recollectFrom").value, to: $(exact ? "recollectFrom" : "recollectTo").value, timeContext: timeContext(),
            ...(exact ? { mode: exactMode, restorePrompts: false } : { restorePrompts: $("recollectPrompts").checked,
                ...($("recollectCorrections").checked ? { correctExisting: true } : {}) }) };
    }
    async function readSources() {
        const access = publication();
        if (!current(access)) return;
        const version = ++token;
        ux.setOwnedText($("recollectWindow")); ux.setOwnedText($("recollectZone"));
        eraseSourceRows($("recollectSources")); $("recollectSources").replaceChildren();
        sources = []; selectedSources.clear(); selectedOnly = false; searchField.sync("");
        exactAvailable = false; chooseOperation(false);
        busy = true; sourcesReady = false; update();
        status("Reading eligible chats from your approved local source. No evidence is being changed.");
        try {
            const result = await api("/api/recollection/sources", {});
            if (!current(access) || version !== token || !dialog.open) return;
            exactAvailable = result.exactRecordsAvailable === true;
            newOnly = result.newOnly === true;
            correctionsAvailable = result.correctionsAvailable === true;
            chooseOperation(false);
            $("recollectCorrections").checked = false;
            sources = result.sources.toSorted((a, b) => a.name.localeCompare(b.name) || a.sourceSessionId.localeCompare(b.sourceSessionId));
            renderSources();
            $("recollectWindow").textContent = `Approved history: ${period(result.since, result.until, timeContext())} (${result.windowDays} days).`
                + (result.newOnly ? " Deleted activity stays excluded." : "");
            $("recollectZone").textContent = `Dates are inclusive, in ${time.displayLabel(timeContext())}.`;
            sourcesReady = result.sources.length > 0;
            status(sourcesReady ? (result.skippedSources ? `${result.skippedSources} chats are outside the discovery limit and cannot be selected.` : "")
                : "No eligible local chats are available from the approved source.");
        } catch (error) {
            if (current(access) && version === token) status(`Source list unavailable. Nothing changed. ${error.message}`, true);
        } finally { if (current(access) && version === token) { busy = false; update(); } }
    }
    function checkExact(data, complete) {
        const c = data.counts;
        const natural = n => Number.isSafeInteger(n) && n >= 0;
        const ids = complete ? data.memberIds : Array.isArray(data.exactMembers) && data.exactMembers.map(m => m?.memberId);
        if (data.mode !== exactMode || data.coverage !== "day-incomplete" || !natural(data.omittedRegions)
            || !["proposed", "added", "excluded", "unknown"].every(key => natural(c?.[key]))
            || c.unknown > c.proposed || c.added > c.proposed || !complete && c.added !== 0
            || !Array.isArray(ids) || ids.length !== c.proposed || new Set(ids).size !== ids.length
            || ids.some(id => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
            || !complete && (data.exactMembers.some(m => typeof m.tool !== "string" || !m.tool.trim()
                || !Number.isFinite(Date.parse(m.startedAt)) || Date.parse(m.startedAt) < Date.parse(data.scope.since)
                || Date.parse(m.startedAt) > Date.parse(data.scope.until) || time.day(m.startedAt, data.scope.timeContext.timeZone) !== data.scope.from
                || typeof m.outcome !== "string" || !m.outcome.trim())
                || data.exactMembers.filter(m => m.outcome === "unknown").length !== c.unknown)) {
            throw new Error("The runtime did not identify a consistent set of individually verified calls.");
        }
        if (complete && preview) {
            const reviewed = new Set(preview.exactMembers.map(m => m.memberId));
            if (["proposed", "excluded", "unknown"].some(key => c[key] !== preview.counts[key])
                || data.omittedRegions !== preview.omittedRegions || ids.some(id => !reviewed.has(id))) {
                throw new Error("The receipt does not match the reviewed calls.");
            }
        }
    }
    function renderExact(data, complete) {
        const c = data.counts;
        $("recollectExactTitle").textContent = complete ? "Verified calls on this receipt" : "Verified calls proposed";
        ux.setOwnedText($("recollectExactCounts"), `Day coverage is incomplete. ${c.proposed.toLocaleString()} proposed; ${c.added.toLocaleString()} added; `
            + `${c.excluded.toLocaleString()} excluded. Unknown outcomes among proposed calls: ${c.unknown.toLocaleString()}. Omitted regions: ${data.omittedRegions.toLocaleString()}.`);
        const list = $("recollectExactMembers");
        ux.setOwnedText(list);
        const rows = complete ? data.memberIds.map(id => `Source-qualified record ID: ${id}`) : data.exactMembers.map(m =>
            `${m.tool} · ${time.formatMoment(m.startedAt, data.scope.timeContext)} · Outcome: ${m.outcome}. Source-qualified record ID: ${m.memberId}`);
        for (const row of rows) {
            const li = document.createElement("li"); li.textContent = row; list.append(li);
        }
        $("recollectExactReview").hidden = false;
    }
    async function showResult(next, access) {
        if (!current(access)) return;
        if (next.operationId !== receipt?.operationId) throw new Error("Recollection receipt does not match this operation.");
        if (next.phase === "complete") {
            if ((preview && (preview.mode === exactMode) !== (next.mode === exactMode))
                || (next.mode !== exactMode && (exact || next.memberIds || next.coverage === "day-incomplete" || next.counts?.proposed != null))) {
                throw new Error("The receipt does not match the reviewed operation.");
            }
            if (next.mode === exactMode) { checkExact(next, true); renderExact(next, true); }
            result = next;
            phase = "complete";
            viewNeedsRead = true;
            sessionStorage.removeItem(storageKey);
            const completed = describe(phase, { result });
            status(completed.resultMessage, completed.records === null);
            update();
            dialog.querySelector(".decision-body").scrollTop = 0;
            if (dialog.open) $("recollectClose").focus();
            const deferred = canAct?.("view");
            if (deferred) status(`${completed.resultMessage} ${deferred} Read stored activity when ready; do not repeat recollection.`);
            else {
                const applied = await onCommitted(next);
                if (!current(access)) return;
                viewNeedsRead = !applied;
                if (viewNeedsRead) status(`${completed.resultMessage} The view could not refresh. Read stored activity; do not repeat recollection.`, true);
            }
            notify();
        } else if (next.phase === "not-started") {
            phase = "not-started"; preview = undefined; receipt = undefined;
            erasePreviewValues();
            sessionStorage.removeItem(storageKey);
            status("No committed recollection was found. Nothing was replayed. Close this panel and choose history again if you still want to reread.");
        } else {
            phase = "uncertain";
            status(next.phase === "verification-incomplete"
                ? "No records saved yet. The original panel is waiting for another verification step. Check this receipt after completion or expiry."
                : "The result is not yet confirmed. Check this operation's receipt; do not repeat recollection.", true);
        }
        update();
    }
    function showPart(value, expected, original) {
        if (value.phase !== expected || !/^[a-f0-9-]{36}$/.test(value.operationId) || !/^[a-f0-9-]{36}$/.test(value.continuation)
            || value.mode !== undefined && (value.mode === exactMode) !== exact
            || !Number.isFinite(Date.parse(value.expiresAt)) || original && (value.operationId !== original.operationId || value.expiresAt !== original.expiresAt)
            || !Number.isSafeInteger(value.progress?.remainingBytes) || value.progress.remainingBytes < 1
            || !Number.isSafeInteger(value.progress.bytesRead) || value.progress.bytesRead < 1 || value.progress.bytesRead > 32 * 1024 ** 2
            || !Number.isSafeInteger(value.progress.totalBytesRead) || value.progress.totalBytesRead < value.progress.bytesRead
            || value.progress.totalBytesRead > 96 * 1024 ** 2) {
            throw new Error("The runtime did not return a valid bounded reading step.");
        }
        part = value; phase = expected;
        clearTimeout(expiryTimer);
        if (expirePreview()) return;
        expiryTimer = setTimeout(expirePreview, Date.parse(value.expiresAt) - Date.now());
        status(`${value.progress.remainingBytes.toLocaleString()} bytes remain in this chat. Nothing has been saved. `
            + (expected === "reading" ? "Read the next part before reviewing any changes." : "Continue to finish verifying the selection you confirmed."));
    }
    async function readPreview(continuation) {
        const access = publication();
        if (busy || locked() || !allowed("preview")) return;
        if (!selectedSources.size) { status("Choose at least one chat.", true); $("recollectSearch").focus(); return; }
        if (exact && (!exactAvailable || selectedSources.size !== 1 || !$("recollectFrom").value)) {
            status("Choose exactly one chat and one day to review individually verified calls.", true); return;
        }
        if (continuation ? expirePreview() || phase !== "reading" : phase !== "editing") return;
        if (!continuation) edit();
        const version = token;
        busy = true; update();
        status("Reading available source events for this preview. Nothing is being recollected.");
        try {
            const result = await api("/api/recollection/preview", continuation
                ? { operationId: continuation.operationId, continuation: continuation.continuation, ...(exact ? { mode: exactMode } : {}) } : scope());
            if (!current(access)) return;
            if (version !== token || !dialog.open) {
                if (typeof result?.operationId === "string") await api("/api/recollection/cancel", { operationId: result.operationId });
                return;
            }
            if (result.phase === "reading") { showPart(result, "reading", continuation); return; }
            if ((result.mode === exactMode) !== exact || !validReceipt(result) || !Number.isFinite(Date.parse(result.expiresAt))
                || continuation && (result.operationId !== continuation.operationId || result.expiresAt !== continuation.expiresAt)
                || !result.scope?.timeContext || !Array.isArray(result.availability)
                || !["from", "to", "since", "until"].every(key => Number.isFinite(Date.parse(result.scope?.[key])))
                || !Number.isFinite(Date.parse(result.scope?.bounds?.from)) || !Number.isFinite(Date.parse(result.scope?.bounds?.to))) {
                throw new Error("The runtime did not return a complete reviewed scope and receipt. Nothing can be confirmed.");
            }
            if (exact) {
                const s = result.scope;
                if (s.sourceSessionIds?.length !== 1 || !selectedSources.has(s.sourceSessionIds[0])
                    || s.from !== $("recollectFrom").value || s.to !== s.from || s.timeContext.timeZone !== timeContext().timeZone
                    || s.restorePrompts || s.correctExisting || result.availability.length !== 1
                    || result.availability[0]?.sourceSessionId !== s.sourceSessionIds[0]) {
                    throw new Error("The verified calls are not bound to the selected chat and day.");
                }
                checkExact(result, false);
            }
            part = undefined; clearTimeout(expiryTimer); erasePreviewValues();
            const c = result.counts;
            const view = describe("preview", { preview: result });
            if (exact) {
                renderExact(result, false);
                $("recollectSummary").textContent = "Add only the listed calls that are missing from stored activity. Existing calls will not be corrected.";
                $("recollectCorrectionList").hidden = true;
            } else {
                const kinds = [[c?.reauthorized, "previously deleted"], [c?.newRecords, "newly available"], [c?.promptOnly, "existing with prompt restoration"],
                    [c?.verifiedCompletions, "saved unknowns with verified completion"], [c?.verifiedMetadata, "saved calls with verified result details"]]
                    .filter(([count]) => Number.isSafeInteger(count) && count > 0).map(([count, label]) => `${count.toLocaleString()} ${label}`).join(", ");
                $("recollectSummary").textContent = view.records === null ? "The preview record count is unavailable. Nothing can be confirmed."
                    : `${view.records.toLocaleString()} record${view.records === 1 ? "" : "s"}${kinds ? `: ${kinds}` : ""}.${Number.isSafeInteger(c?.alreadyPresent) && c.alreadyPresent > 0 ? ` ${c.alreadyPresent.toLocaleString()} already-present records will not be duplicated.` : ""}`
                        + (c?.unresolved ? ` ${c.unresolved.toLocaleString()} saved calls could not be verified for correction and will stay unchanged.` : "")
                        + (c?.checkpointConflicts ? ` Conflicting saved checkpoint evidence: ${c.checkpointConflicts.toLocaleString()}.` : "");
                const corrections = result.correctable ?? [];
                if (result.scope.correctExisting && (!Array.isArray(result.correctable) || corrections.length > 32
                    || corrections.length !== c.verifiedCompletions + c.verifiedMetadata)) throw new Error("Saved-call corrections were not identified. Preview again.");
                $("recollectCorrectionList").hidden = !corrections.length;
                $("recollectCorrectionList").replaceChildren(...corrections.map(item => {
                    const li = document.createElement("li");
                    li.textContent = `${item.tool} (${time.formatMoment(item.startedAt, result.scope.timeContext)}): ${item.kind === "completion"
                        ? "change unknown to verified tool completion" : "add verified result details; outcome unchanged"}. Call: ${item.toolCallId}`;
                    return li;
                }));
            }
            const context = result.scope.timeContext;
            const chats = result.availability.length <= 3 ? result.availability.map(row => row.name).join("; ") : `${result.availability.length} selected chats (listed in source details)`;
            $("recollectScope").textContent = `${chats}. ${period(result.scope.from, result.scope.to, context)} (${time.displayLabel(context)}).`;
            const clipped = Date.parse(result.scope.since) > Date.parse(result.scope.bounds.from)
                || Date.parse(result.scope.until) < Date.parse(result.scope.bounds.to) - 1;
            $("recollectClipped").hidden = !clipped;
            $("recollectClipped").textContent = clipped ? `Only approved history from ${time.formatMoment(result.scope.since, context)} to ${time.formatMoment(result.scope.until, context)} is included.` : "";
            $("recollectBounds").textContent = `Exact approved bounds: ${time.formatTime(result.scope.since, context)} through ${time.formatTime(result.scope.until, context)}. `
                + (result.continued ? "Each step reads at most 32 MiB. Confirming this review also requires stepped verification of the same chat."
                    : "Reads are limited to 32 MiB across this selection and the last 64 MiB of each file.");
            $("recollectPromptSummary").textContent = result.scope.restorePrompts
                ? Number.isSafeInteger(c?.restoredPrompts) && c.restoredPrompts >= 0
                    ? `${c.restoredPrompts.toLocaleString()} original prompt${c.restoredPrompts === 1 ? "" : "s"} selected for restoration.`
                    : "Original prompts are selected for restoration; the available count was not returned."
                : exact ? "Original prompts will not be restored." : "Deleted original prompts stay deleted.";
            $("recollectPreserved").textContent = "Responses and historical annotations stay deleted. Saved reports, comparisons and Copilot sources stay unchanged.";
            $("recollectPolicy").textContent = exact ? "Only individually verified calls are in scope. Omitted regions are not reviewed." : result.boundary + (Number.isSafeInteger(c?.suppressedSourceStarts)
                ? ` ${c.suppressedSourceStarts.toLocaleString()} suppressed source call starts and ${c.excludedDeleted.toLocaleString()} deleted candidate records were excluded.`
                : "");
            $("recollectAvailability").replaceChildren(...result.availability.map(row => {
                const li = document.createElement("li");
                const gaps = [[row.droppedBytes, "earlier bytes outside the bounded tail"], [row.unreadBytes, "unread bytes"],
                    [row.malformedLines, "malformed lines"], [row.oversizedLines, "oversized lines"],
                    [row.credentialExclusions, "credential exclusions"], [row.unsupportedPromptContents, "unsupported message formats"],
                    [row.missingResults, "calls without a recorded result"]]
                    .filter(([count]) => count).map(([count, label]) => `${count} ${label}`).join("; ");
                li.textContent = exact ? `${row.name}: day coverage incomplete.` : `${row.name}: ${row.problem || "Available history read."}${gaps ? ` ${gaps}.` : ""}`;
                return li;
            }));
            const partial = result.availability.some(row => row.problem || row.droppedBytes || row.unreadBytes || row.malformedLines || row.oversizedLines || row.credentialExclusions || row.unsupportedPromptContents || row.missingResults);
            preview = result; phase = "preview";
            if (expirePreview()) return;
            expiryTimer = setTimeout(expirePreview, Date.parse(result.expiresAt) - Date.now());
            status(exact ? view.records ? "" : "No verified calls were proposed. This does not establish that no calls are missing."
                : view.records === null ? "The preview did not return a usable record count. Change scope and preview again; nothing was recollected."
                : view.records ? (partial ? "Some history is unavailable or incomplete. Only the records shown will be recollected. See source details."
                    : "") : "No eligible records are available in this scope. Nothing can be recollected.", view.records === null);
            dialog.querySelector(".decision-body").scrollTop = 0; $("recollectClose").focus();
        } catch (error) {
            if (current(access) && version === token) {
                if (continuation) { busy = false; edit(); }
                else erasePreviewValues();
                status(`Preview failed. Nothing changed. ${error.message}`, true);
            }
        }
        finally { if (current(access) && version === token) { busy = false; update(); } }
    }
    $("recollectForm").addEventListener("submit", event => {
        event.preventDefault(); void readPreview();
    });
    async function confirmPreview(continuation) {
        const access = publication();
        if (busy || !dialog.open || expirePreview() || !allowed("confirm") || (continuation ? phase !== "verifying" : !describe(phase, { preview, busy }).canConfirm)) return;
        if (exact && (!exactAvailable || preview?.mode !== exactMode || selectedSources.size !== 1
            || !selectedSources.has(preview.scope.sourceSessionIds[0]) || preview.scope.from !== $("recollectFrom").value
            || preview.scope.timeContext.timeZone !== timeContext().timeZone)) {
            if (continuation) {
                cancelPreview(); phase = "uncertain"; erasePreviewValues();
                status("The scope changed. Check the original receipt before starting another review.", true); update();
            } else { edit(); status("The selection changed. Preview the verified calls again.", true); }
            return;
        }
        if (!continuation) receipt = { operationId: preview.operationId, receiptToken: preview.receiptToken };
        try { sessionStorage.setItem(storageKey, JSON.stringify(receipt)); }
        catch { status("This browser cannot save the recovery receipt. Nothing recollected. Allow session storage before confirming.", true); return; }
        clearTimeout(expiryTimer);
        part = undefined; phase = "pending"; update(); status("Re-reading and committing only the confirmed source records. Keep this panel open.");
        $("recollectStatus").focus();
        try {
            const next = await api("/api/recollection/confirm", { operationId: receipt.operationId,
                ...(continuation ? { continuation: continuation.continuation } : { confirmed: true }), ...(exact ? { mode: exactMode } : {}) });
            if (!current(access)) return;
            if (next.phase === "verifying") showPart(next, "verifying", preview);
            else await showResult(next, access);
        }
        catch (error) {
            if (!current(access)) return;
            if (error.recollection?.outcome === "not-saved" && error.recollection.operationId === receipt?.operationId
                && error.outcome !== "unknown") {
                // Only the server can prove this operation refused before the writer.
                try { sessionStorage.removeItem(storageKey); }
                catch {
                    phase = "uncertain";
                    status(`Nothing was saved. ${error.message} The saved receipt could not be cleared. Use Check recollection result.`, true);
                    return;
                }
                phase = "not-started"; preview = receipt = result = undefined;
                erasePreviewValues();
                status(`Nothing was saved. ${error.message}`, true);
                return;
            }
            phase = "uncertain";
            status(`${error.message} Use Check recollection result. No mutation will be replayed.`, true);
        } finally { if (current(access)) update(); }
    }
    $("recollectConfirm").addEventListener("click", () => { void confirmPreview(); });
    $("recollectContinue").addEventListener("click", () => {
        if (part && phase === "reading") void readPreview(part);
        else if (part && phase === "verifying") void confirmPreview(part);
    });
    $("recollectCheck").addEventListener("click", async () => {
        const access = publication();
        if (busy || !receipt || !allowed("receipt")) return;
        busy = true; update();
        try { await showResult(await api("/api/recollection/status", receipt), access); }
        catch (error) { if (current(access)) status(`Could not read this operation's result. ${error.message} No recollection was repeated.`, true); }
        finally { if (current(access)) { busy = false; update(); } }
    });
    $("recollectChange").addEventListener("click", () => { if (!current(publication())) return; edit(); status(""); $("recollectSources").focus(); });
    $("recollectOperation").addEventListener("change", () => {
        if (!exactAvailable || phase !== "editing" || busy || !current(publication())) return;
        chooseOperation($("recollectOperation").value === exactMode);
        edit(); status(exact && selectedSources.size > 1 ? "Deselect chats until one remains." : "");
    });
    $("recollectSources").addEventListener("input", event => {
        if (!current(publication())) return;
        const input = event.target;
        if (input.type !== "checkbox") return;
        if (input.checked && selectedSources.size >= (exact ? 1 : 128)) {
            input.checked = false; status(exact ? "Choose one chat." : "Choose up to 128 chats.", true); return;
        }
        if (input.checked) selectedSources.add(input.value); else selectedSources.delete(input.value);
        edit(); selectionCount(); status("");
    });
    const searchField = searchFields.mount($("recollectSearch"), { clearLabel: "Clear search", onInput: () => renderSources() });
    $("recollectShowSelected").addEventListener("click", () => { if (!current(publication())) return; selectedOnly = !selectedOnly; searchField.sync(""); renderSources(); });
    for (const id of ["recollectFrom", "recollectTo", "recollectPrompts", "recollectCorrections"]) $(id).addEventListener("input", () => { edit(); status(""); });
    $("recollectClose").addEventListener("click", () => dialog.close());
    dialog.addEventListener("cancel", event => { if (phase === "pending") event.preventDefault(); });
    dialog.addEventListener("close", () => {
        if (suppressedCloses) { suppressedCloses--; return; }
        if (!current(publication())) return;
        token++;
        if (!locked()) busy = false;
        if (!locked()) {
            if (phase === "verifying") {
                cancelPreview(); phase = "uncertain";
                status("Verification stopped. Check the original receipt before starting another review.", true);
            }
            erasePreviewValues();
            if (!["complete", "not-started", "uncertain"].includes(phase)) { cancelPreview(); phase = "editing"; }
        }
        if (trigger?.isConnected && trigger.checkVisibility()) ux.restoreFocus(trigger.disabled ? trigger.closest(".ux-disabled-help") || trigger : trigger);
        notify();
    });
    dialog.addEventListener("keydown", event => {
        if (!current(publication()) || event.key !== "Tab") return;
        const controls = [...dialog.querySelectorAll("button,input,select,summary")].filter(node => !node.disabled && !node.closest("[inert]") && node.checkVisibility());
        if (!controls.length) { event.preventDefault(); $("recollectStatus").focus(); return; }
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    });
    function restoreReceipt() {
        try {
            const raw = sessionStorage.getItem(storageKey);
            if (raw === null) return;
            const stored = JSON.parse(raw);
            if (!validReceipt(stored)) throw new Error("Invalid retained recollection receipt.");
            receipt = { operationId: stored.operationId, receiptToken: stored.receiptToken }; phase = "uncertain";
            status("A previous recollection needs checking. Read its saved receipt before starting another operation.", true);
        } catch {
            receipt = undefined; phase = "blocked";
            status(blockedMessage, true);
        }
    }
    async function open(initiator = document.activeElement) {
        if (!allowed(["uncertain", "blocked"].includes(phase) ? "receipt" : "open")) return false;
        trigger = initiator;
        if (!locked()) {
            phase = "editing"; preview = undefined; receipt = undefined; result = undefined; viewNeedsRead = false; sourcesReady = false;
            $("recollectPrompts").checked = $("recollectCorrections").checked = false;
            erasePreviewValues(); $("recollectCorrectionList").hidden = true;
            exactAvailable = false; chooseOperation(false);
            $("recollectFrom").value = ""; $("recollectTo").value = "";
            restoreReceipt();
        }
        update(); if (!dialog.open) dialog.showModal();
        dialog.querySelector(".decision-body").scrollTop = 0; $("recollectClose").focus();
        if (phase === "uncertain") status("A previous recollection needs checking. Read its saved receipt before starting another operation.", true);
        else if (phase === "blocked") status(blockedMessage, true);
        else await readSources();
        return true;
    }
    $("recollectActivity").addEventListener("click", event => open(event.currentTarget));
    restoreReceipt(); update(); mounted = true;
    function withdrawAccess() {
        if (!accessAvailable) return;
        clearTimeout(expiryTimer);
        accessAvailable = false; accessEpoch++; token++;
        if (phase === "pending" || phase === "verifying") phase = "uncertain";
        if (!["uncertain", "blocked", "complete", "not-started"].includes(phase)) phase = "editing";
        sources.length = 0; sourceMatches.length = 0; selectedSources.clear(); selectedOnly = false;
        preview = part = undefined; result = undefined; trigger = null; busy = false; sourcesReady = false; viewNeedsRead = false;
        eraseSourceRows($("recollectSources"));
        erasePreviewValues();
        for (const id of ["recollectTitle", "recollectWindow", "recollectZone", "recollectSelected", "recollectStatus", "recollectConfirm"]) {
            ux.setOwnedText($(id));
        }
        ux.removeOwnedAttribute(dialog, "data-operation-id");
        for (const id of ["recollectSearch", "recollectFrom", "recollectTo"]) {
            ux.removeOwnedAttribute($(id), "value"); $(id).value = "";
        }
        if (dialog.open) { suppressedCloses++; dialog.close(); }
        $("recollectSources").replaceChildren(); $("recollectAvailability").replaceChildren();
        $("recollectCorrectionList").replaceChildren(); $("recollectCorrectionList").hidden = true;
        exact = exactAvailable = correctionsAvailable = false;
        $("recollectOperation").value = "strict"; $("recollectOperation").disabled = $("recollectOperationChoice").hidden = true;
        $("recollectCorrections").checked = false; $("recollectCorrectionsChoice").hidden = true;
        searchField.sync(""); $("recollectSearch").readOnly = true;
        $("recollectFrom").value = ""; $("recollectTo").value = ""; $("recollectPrompts").checked = false;
        for (const id of ["recollectTitle", "recollectWindow", "recollectZone", "recollectSelected", "recollectScope",
            "recollectClipped", "recollectSummary", "recollectPromptSummary", "recollectPreserved", "recollectBounds", "recollectPolicy", "recollectStatus"]) $(id).textContent = "";
        $("recollectConfirm").textContent = "Read selected history again";
        $("recollectForm").hidden = true; $("recollectForm").inert = true; $("recollectConfirmation").hidden = true;
        delete dialog.dataset.operationId; delete dialog.dataset.decisionPhase;
        for (const button of dialog.querySelectorAll("button")) button.disabled = true;
    }
    return { open, snapshot, isOpen: () => dialog.open, withdrawAccess,
        resumeAccess() {
            const access = publication();
            if (access.epoch === accessEpoch && access.token != null && api.isCurrent(access.token) === true) {
                accessAvailable = true; $("recollectSearch").readOnly = false;
            }
        }, viewApplied(operationId) {
        if (!current(publication())) return;
        if (phase === "complete" && viewNeedsRead && operationId === result?.operationId) {
            viewNeedsRead = false; status(describe(phase, { result }).resultMessage, describe(phase, { result }).records === null);
        }
    }, invalidate() {
        if (!current(publication())) return;
        if (exact && phase === "verifying" && dialog.open) {
            cancelPreview(); phase = "uncertain"; erasePreviewValues();
            status("The connection or display time zone changed. Check the original receipt before starting another review.", true); update();
        } else if ((["editing", "preview"].includes(phase) || exact && phase === "reading") && dialog.open) {
            edit(); status("The connection or display time zone changed. Read the source list and preview again.", true); readSources();
        }
    } };
}
