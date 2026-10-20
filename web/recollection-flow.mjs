import { searchFieldMarkup } from "./search-field.mjs";

export function describeRecollection(phase, { preview, result, busy = false, error = false } = {}) {
    const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
    const records = count(phase === "complete" ? result?.counts?.records : preview?.counts?.records);
    const prompts = count(result?.counts?.restoredPrompts);
    const scopeAvailable = Boolean(preview?.scope?.from && preview?.scope?.to);
    return {
        records,
        scopeAvailable,
        canConfirm: phase === "preview" && !busy && scopeAvailable && records !== null && records > 0,
        confirmLabel: records === null ? "Read selected history again" : `Read ${records.toLocaleString()} record${records === 1 ? "" : "s"} again`,
        decisionPhase: phase === "preview" ? "confirm" : phase === "uncertain" ? busy ? "checking" : "unknown"
            : ["pending", "complete"].includes(phase) ? phase : error || ["not-started", "blocked"].includes(phase) ? "error" : "",
        title: phase === "complete" ? records === null ? "Recollection completed" : `${records.toLocaleString()} record${records === 1 ? "" : "s"} read again`
            : phase === "not-started" ? "No recollection was committed"
            : phase === "blocked" ? "Recollection recovery unavailable"
            : phase === "uncertain" ? busy ? "Checking recollection result..." : "Result not yet confirmed"
            : phase === "pending" ? records === null ? "Reading confirmed history..." : `Reading ${records.toLocaleString()} record${records === 1 ? "" : "s"} again...`
            : phase === "preview" ? records === null ? "Preview record count unavailable" : records === 0 ? "No records available in this scope"
                : records === 1 ? "Read this record again?" : `Read these ${records.toLocaleString()} records again?`
            : "Choose history to read again",
        resultMessage: phase !== "complete" ? null : records === null ? "Recollection completed; the returned record count is unavailable."
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
    <fieldset><legend>Choose local Copilot chats</legend>
      <label for="recollectSearch" class="visually-hidden">Find a chat to recollect</label>
      ${searchFieldMarkup({ id: "recollectSearch", clearId: "recollectClearSearch", placeholder: "Find a chat" })}
      <div class="recollect-selection"><p id="recollectSelected" role="status" aria-live="polite"></p><button id="recollectShowSelected" type="button" class="quiet" disabled>Show selected</button></div>
      <div id="recollectSources" tabindex="-1" aria-describedby="recollectSourceHelp"></div>
    </fieldset>
    <p id="recollectSourceHelp" class="muted">Choose up to 128 chats and a date range before previewing. Search stays in this panel.</p>
    <div class="recollect-dates"><label>From<input id="recollectFrom" type="date" required></label><label>To<input id="recollectTo" type="date" required></label></div>
    <p id="recollectZone" class="muted"></p>
    <label class="delete-choice"><input id="recollectPrompts" type="checkbox"><span>Also restore original prompts for these requests</span></label>
    <p class="muted">Off by default. Includes available prompts and associated follow-ups.</p>
  </form>
  <div id="recollectConfirmation" hidden>
    <div class="decision-scope"><p id="recollectScope"></p><button id="recollectChange" type="button" class="quiet" hidden>Change scope</button></div>
    <p id="recollectClipped" hidden></p>
    <section id="recollectChanges"><h3 id="recollectChangesTitle">What will change</h3><p id="recollectSummary"></p><p id="recollectPromptSummary"></p></section>
    <h3>What stays unchanged</h3>
    <p id="recollectPreserved"></p>
    <details class="detail-disclosure"><summary id="recollectAvailabilityToggle">Source availability and limits</summary><p id="recollectBounds"></p><ul id="recollectAvailability"></ul><p id="recollectPolicy"></p><p class="muted">The preview expires after two minutes. Changes require a new preview. Refresh and restart never authorize recollection. This is a source reread, not an undo or backup restore.</p></details>
  </div>
  <p id="recollectStatus" class="decision-status" role="status" aria-live="polite" aria-atomic="true" tabindex="-1"></p>
  </div>
  <div class="delete-actions"><button id="recollectClose" type="button">Cancel</button><button id="recollectPreview" type="submit" form="recollectForm" data-decision-action="check" aria-describedby="recollectSelected recollectSourceHelp" disabled>Preview available evidence</button><button id="recollectCheck" type="button" data-decision-action="check" hidden>Check recollection result</button><button id="recollectConfirm" type="button" data-decision-action="commit" hidden>Read selected history again</button></div>
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
#recollectDialog input[type=checkbox] {appearance:auto;width:20px;height:20px;flex:none;accent-color:var(--accent)}
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
    const $ = id => document.getElementById(id), dialog = $("recollectDialog");
    const storageKey = "workiq-evidence.recollection-operation";
    let phase = "editing", token = 0, preview, receipt, trigger, busy = false, sourcesReady = false;
    let result, statusError = false, viewNeedsRead = false, mounted = false;
    let sources = [], selectedOnly = false;
    const selectedSources = new Set();
    const locked = () => ["pending", "uncertain", "blocked"].includes(phase);
    const validReceipt = value => typeof value?.operationId === "string"
        && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value.operationId)
        && typeof value?.receiptToken === "string" && /^[a-f0-9]{64}$/.test(value.receiptToken);
    const snapshot = () => ({ phase, busy, needsReceipt: ["uncertain", "blocked"].includes(phase), hasReceipt: Boolean(receipt), operationId: receipt?.operationId,
        message: ["pending", "uncertain", "complete", "not-started", "blocked"].includes(phase) ? $("recollectStatus").textContent : "",
        result, viewNeedsRead });
    const notify = () => { if (mounted) onChanged?.(snapshot()); };
    function allowed(action) {
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
        $("recollectSelected").textContent = `${selectedSources.size} selected`;
        $("recollectShowSelected").disabled = !selectedSources.size && !selectedOnly;
        $("recollectShowSelected").hidden = !selectedSources.size && !selectedOnly;
        $("recollectShowSelected").textContent = selectedOnly ? "Show all chats" : "Show selected";
        for (const input of $("recollectSources").querySelectorAll("input")) input.disabled = selectedSources.size >= 128 && !input.checked;
    }
    function renderSources(reset = true) {
        const query = $("recollectSearch").value;
        const matches = sources.filter(source => (!selectedOnly || selectedSources.has(source.sourceSessionId))
            && search.matches(query, [source.name]));
        searchField.sync();
        pageSources($("recollectSources"), matches, source => {
            const label = document.createElement("label"), input = document.createElement("input"), name = document.createElement("span");
            label.className = "delete-choice";
            input.type = "checkbox"; input.value = source.sourceSessionId;
            input.checked = selectedSources.has(source.sourceSessionId);
            input.disabled = selectedSources.size >= 128 && !input.checked;
            name.textContent = source.name + (source.available ? "" : " - history unavailable");
            label.append(input, name);
            return label;
        }, reset);
        if (!matches.length) {
            const empty = document.createElement("p");
            empty.textContent = selectedOnly ? "No selected chats match this search." : "No chats match. Try another name.";
            $("recollectSources").append(empty);
        }
        selectionCount();
    }
    function status(text, error = false) {
        statusError = error;
        if ($("recollectStatus").textContent !== text) $("recollectStatus").textContent = text;
        $("recollectStatus").classList.toggle("error", error);
        notify();
    }
    function update() {
        const view = describe(phase, { preview, result, busy, error: statusError });
        const reason = canAct?.(["uncertain", "blocked"].includes(phase) ? "receipt" : "preview");
        $("recollectTitle").textContent = view.title;
        dialog.dataset.decisionPhase = view.decisionPhase;
        dialog.dataset.operationId = receipt?.operationId || preview?.operationId || "";
        $("recollectForm").inert = busy || locked();
        $("recollectForm").hidden = ["preview", "complete", "not-started"].includes(phase) || locked();
        $("recollectBoundary").hidden = phase !== "editing";
        $("recollectScopeUnavailable").hidden = view.scopeAvailable || !["pending", "uncertain", "complete"].includes(phase);
        $("recollectConfirmation").hidden = !view.scopeAvailable || phase === "editing";
        $("recollectChanges").hidden = phase === "complete";
        $("recollectChangesTitle").textContent = phase === "preview" ? "What will change" : "Confirmed selection";
        $("recollectPreview").hidden = phase !== "editing";
        $("recollectPreview").disabled = busy || !sourcesReady || !selectedSources.size
            || !$("recollectFrom").value || !$("recollectTo").value || locked() || Boolean(reason);
        $("recollectConfirm").hidden = phase !== "preview" && phase !== "pending";
        $("recollectConfirm").disabled = !view.canConfirm || Boolean(reason);
        $("recollectConfirm").textContent = view.confirmLabel;
        $("recollectChange").hidden = phase !== "preview";
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
        if (!preview) return;
        const operationId = preview.operationId;
        preview = undefined;
        api("/api/recollection/cancel", { operationId }).catch(error => {
            status(`Preview cancellation could not be confirmed. No recollection was requested; it will expire. ${error.message}`, true);
        });
    }
    function edit() {
        if (locked()) return;
        token++;
        cancelPreview();
        phase = "editing";
        update();
    }
    function scope() {
        return { sourceSessionIds: [...selectedSources],
            from: $("recollectFrom").value, to: $("recollectTo").value, timeContext: timeContext(),
            restorePrompts: $("recollectPrompts").checked };
    }
    async function readSources() {
        const version = ++token;
        $("recollectSources").replaceChildren();
        sources = []; selectedSources.clear(); selectedOnly = false; searchField.sync(""); selectionCount();
        busy = true; sourcesReady = false; update();
        status("Reading eligible chats from your approved local source. No evidence is being changed.");
        try {
            const result = await api("/api/recollection/sources", {});
            if (version !== token || !dialog.open) return;
            sources = result.sources.toSorted((a, b) => a.name.localeCompare(b.name) || a.sourceSessionId.localeCompare(b.sourceSessionId));
            renderSources();
            $("recollectWindow").textContent = `Approved history: ${period(result.since, result.until, timeContext())} (${result.windowDays} days).`;
            $("recollectZone").textContent = `Dates are inclusive, in ${time.displayLabel(timeContext())}.`;
            sourcesReady = result.sources.length > 0;
            status(sourcesReady ? (result.skippedSources ? `${result.skippedSources} chats are outside the discovery limit and cannot be selected.` : "")
                : "No eligible local chats are available from the approved source.");
        } catch (error) {
            if (version === token) status(`Source list unavailable. Nothing changed. ${error.message}`, true);
        } finally { busy = false; update(); }
    }
    async function showResult(next) {
        if (next.operationId !== receipt?.operationId) throw new Error("Recollection receipt does not match this operation.");
        if (next.phase === "complete") {
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
                viewNeedsRead = !await onCommitted(next);
                if (viewNeedsRead) status(`${completed.resultMessage} The view could not refresh. Read stored activity; do not repeat recollection.`, true);
            }
            notify();
        } else if (next.phase === "not-started") {
            phase = "not-started"; preview = undefined; receipt = undefined;
            sessionStorage.removeItem(storageKey);
            status("No committed recollection was found. Nothing was replayed. Close this panel and choose history again if you still want to reread.");
        } else {
            phase = "uncertain";
            status("The result is not yet confirmed. Check this operation's receipt; do not repeat recollection.", true);
        }
        update();
    }
    $("recollectForm").addEventListener("submit", async event => {
        event.preventDefault();
        if (busy || locked() || !allowed("preview")) return;
        if (!selectedSources.size) { status("Choose at least one chat.", true); $("recollectSearch").focus(); return; }
        edit();
        const version = token;
        busy = true; update();
        status("Reading available source events for this preview. Nothing is being recollected.");
        try {
            const result = await api("/api/recollection/preview", scope());
            if (version !== token || !dialog.open) return;
            if (!validReceipt(result)
                || !result.scope?.timeContext || !Array.isArray(result.availability)
                || !["from", "to", "since", "until"].every(key => Number.isFinite(Date.parse(result.scope?.[key])))
                || !Number.isFinite(Date.parse(result.scope?.bounds?.from)) || !Number.isFinite(Date.parse(result.scope?.bounds?.to))) {
                throw new Error("The runtime did not return a complete reviewed scope and receipt. Nothing can be confirmed.");
            }
            const c = result.counts;
            const view = describe("preview", { preview: result });
            const kinds = [[c?.reauthorized, "previously deleted"], [c?.newRecords, "newly available"], [c?.promptOnly, "existing with prompt restoration"]]
                .filter(([count]) => Number.isSafeInteger(count) && count > 0).map(([count, label]) => `${count.toLocaleString()} ${label}`).join(", ");
            $("recollectSummary").textContent = view.records === null ? "The preview record count is unavailable. Nothing can be confirmed."
                : `${view.records.toLocaleString()} record${view.records === 1 ? "" : "s"}${kinds ? `: ${kinds}` : ""}.${Number.isSafeInteger(c?.alreadyPresent) && c.alreadyPresent > 0 ? ` ${c.alreadyPresent.toLocaleString()} already-present records will not be duplicated.` : ""}`;
            const context = result.scope.timeContext;
            const chats = result.availability.length <= 3 ? result.availability.map(row => row.name).join("; ") : `${result.availability.length} selected chats (listed in source details)`;
            $("recollectScope").textContent = `${chats}. ${period(result.scope.from, result.scope.to, context)} (${time.displayLabel(context)}).`;
            const clipped = Date.parse(result.scope.since) > Date.parse(result.scope.bounds.from)
                || Date.parse(result.scope.until) < Date.parse(result.scope.bounds.to) - 1;
            $("recollectClipped").hidden = !clipped;
            $("recollectClipped").textContent = clipped ? `Only approved history from ${time.formatMoment(result.scope.since, context)} to ${time.formatMoment(result.scope.until, context)} is included.` : "";
            $("recollectBounds").textContent = `Exact approved bounds: ${time.formatTime(result.scope.since, context)} through ${time.formatTime(result.scope.until, context)}. Reads are limited to 32 MiB across this selection and the last 64 MiB of each file.`;
            $("recollectPromptSummary").textContent = result.scope.restorePrompts
                ? Number.isSafeInteger(c?.restoredPrompts) && c.restoredPrompts >= 0
                    ? `${c.restoredPrompts.toLocaleString()} original prompt${c.restoredPrompts === 1 ? "" : "s"} selected for restoration.`
                    : "Original prompts are selected for restoration; the available count was not returned."
                : "Deleted original prompts stay deleted.";
            $("recollectPreserved").textContent = "Responses and historical annotations stay deleted. Saved reports, comparisons and Copilot sources stay unchanged.";
            $("recollectPolicy").textContent = result.boundary;
            $("recollectAvailability").replaceChildren(...result.availability.map(row => {
                const li = document.createElement("li");
                const gaps = [[row.droppedBytes, "earlier bytes outside the bounded tail"], [row.unreadBytes, "unread bytes"],
                    [row.malformedLines, "malformed lines"], [row.oversizedLines, "oversized lines"],
                    [row.credentialExclusions, "credential exclusions"], [row.unsupportedPromptContents, "unsupported message formats"],
                    [row.missingResults, "calls without a recorded result"]]
                    .filter(([count]) => count).map(([count, label]) => `${count} ${label}`).join("; ");
                li.textContent = `${row.name}: ${row.problem || "Available history read."}${gaps ? ` ${gaps}.` : ""}`;
                return li;
            }));
            const partial = result.availability.some(row => row.problem || row.droppedBytes || row.unreadBytes || row.malformedLines || row.oversizedLines || row.credentialExclusions || row.unsupportedPromptContents || row.missingResults);
            preview = result; phase = "preview";
            status(view.records === null ? "The preview did not return a usable record count. Change scope and preview again; nothing was recollected."
                : view.records ? (partial ? "Some history is unavailable or incomplete. Only the records shown will be recollected. See source details."
                    : "") : "No eligible records are available in this scope. Nothing can be recollected.", view.records === null);
            dialog.querySelector(".decision-body").scrollTop = 0; $("recollectClose").focus();
        } catch (error) { if (version === token) status(`Preview failed. Nothing changed. ${error.message}`, true); }
        finally { busy = false; update(); }
    });
    $("recollectConfirm").addEventListener("click", async () => {
        if (!describe(phase, { preview, busy }).canConfirm || !allowed("confirm")) return;
        receipt = { operationId: preview.operationId, receiptToken: preview.receiptToken };
        try { sessionStorage.setItem(storageKey, JSON.stringify(receipt)); }
        catch { status("This browser cannot save the recovery receipt. Nothing recollected. Allow session storage before confirming.", true); return; }
        phase = "pending"; update(); status("Re-reading and committing only the confirmed source records. Keep this panel open.");
        $("recollectStatus").focus();
        try { await showResult(await api("/api/recollection/confirm", { operationId: receipt.operationId, confirmed: true })); }
        catch (error) {
            phase = "uncertain";
            status(`${error.message} Use Check recollection result. No mutation will be replayed.`, true);
        } finally { update(); }
    });
    $("recollectCheck").addEventListener("click", async () => {
        if (busy || !receipt || !allowed("receipt")) return;
        busy = true; update();
        try { await showResult(await api("/api/recollection/status", receipt)); }
        catch (error) { status(`Could not read this operation's result. ${error.message} No recollection was repeated.`, true); }
        finally { busy = false; update(); }
    });
    $("recollectChange").addEventListener("click", () => { edit(); status(""); $("recollectSources").focus(); });
    $("recollectSources").addEventListener("input", event => {
        const input = event.target;
        if (input.type !== "checkbox") return;
        if (input.checked && selectedSources.size >= 128) { input.checked = false; status("Choose up to 128 chats.", true); return; }
        if (input.checked) selectedSources.add(input.value); else selectedSources.delete(input.value);
        edit(); selectionCount(); status("");
    });
    const searchField = searchFields.mount($("recollectSearch"), { clearLabel: "Clear search", onInput: () => renderSources() });
    $("recollectShowSelected").addEventListener("click", () => { selectedOnly = !selectedOnly; searchField.sync(""); renderSources(); });
    for (const id of ["recollectFrom", "recollectTo", "recollectPrompts"]) $(id).addEventListener("input", () => { edit(); status(""); });
    $("recollectClose").addEventListener("click", () => dialog.close());
    dialog.addEventListener("cancel", event => { if (phase === "pending") event.preventDefault(); });
    dialog.addEventListener("close", () => {
        token++;
        if (!locked() && !["complete", "not-started"].includes(phase)) { cancelPreview(); phase = "editing"; }
        if (trigger?.isConnected && trigger.checkVisibility()) ux.restoreFocus(trigger.disabled ? trigger.closest(".ux-disabled-help") || trigger : trigger);
        notify();
    });
    dialog.addEventListener("keydown", event => {
        if (event.key !== "Tab") return;
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
            status("The saved recollection receipt could not be read or verified. An earlier operation may be unconfirmed. Recollection is blocked; the saved entry has not been changed. Stored activity is still available.", true);
        }
    }
    async function open(initiator = document.activeElement) {
        if (!allowed(["uncertain", "blocked"].includes(phase) ? "receipt" : "open")) return false;
        trigger = initiator;
        if (!locked()) {
            phase = "editing"; preview = undefined; receipt = undefined; result = undefined; viewNeedsRead = false; sourcesReady = false;
            $("recollectPrompts").checked = false; $("recollectFrom").value = ""; $("recollectTo").value = "";
            restoreReceipt();
        }
        update(); if (!dialog.open) dialog.showModal();
        dialog.querySelector(".decision-body").scrollTop = 0; $("recollectClose").focus();
        if (phase === "uncertain") status("A previous recollection needs checking. Read its saved receipt before starting another operation.", true);
        else if (phase !== "blocked") await readSources();
        return true;
    }
    $("recollectActivity").addEventListener("click", event => open(event.currentTarget));
    restoreReceipt(); update(); mounted = true;
    return { open, snapshot, isOpen: () => dialog.open, viewApplied(operationId) {
        if (phase === "complete" && viewNeedsRead && operationId === result?.operationId) {
            viewNeedsRead = false; status(describe(phase, { result }).resultMessage, describe(phase, { result }).records === null);
        }
    }, invalidate() {
        if (["editing", "preview"].includes(phase) && dialog.open) {
            edit(); status("The connection or display time zone changed. Read the source list and preview again.", true); readSources();
        }
    } };
}
