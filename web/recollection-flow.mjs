export const recollectionMarkup = `
<dialog id="recollectDialog" class="deletion-dialog" aria-labelledby="recollectTitle" aria-describedby="recollectBoundary">
  <div class="dialog-head"><h2 id="recollectTitle">Recollect from approved sources</h2><button id="recollectClose" type="button">Cancel</button></div>
  <div class="dialog-body">
  <p id="recollectBoundary">Read selected requests again from your approved Copilot history.</p>
  <form id="recollectForm">
    <p id="recollectWindow"></p>
    <fieldset><legend>Choose local Copilot chats</legend>
      <label for="recollectSearch" class="visually-hidden">Find a chat to recollect</label>
      <div class="search-input-row"><input id="recollectSearch" type="search" placeholder="Find a chat" autocomplete="off" spellcheck="false"><button id="recollectClearSearch" type="button" class="quiet" hidden>Clear search</button></div>
      <div class="recollect-selection"><p id="recollectSelected" role="status" aria-live="polite"></p><button id="recollectShowSelected" type="button" class="quiet" disabled>Show selected</button></div>
      <div id="recollectSources" tabindex="-1" aria-describedby="recollectSourceHelp"></div>
    </fieldset>
    <p id="recollectSourceHelp" class="muted">Choose up to 128 chats. Search stays in this panel.</p>
    <div class="recollect-dates"><label>From<input id="recollectFrom" type="date" required></label><label>To<input id="recollectTo" type="date" required></label></div>
    <p id="recollectZone" class="muted"></p>
    <label class="delete-choice"><input id="recollectPrompts" type="checkbox"><span>Also restore original prompts for these requests</span></label>
    <p class="muted">Off by default. Includes available prompts and associated follow-ups.</p>
    <div class="recollect-preview-action"><button id="recollectPreview" type="submit" disabled>Preview available evidence</button></div>
  </form>
  <div id="recollectConfirmation" hidden>
    <p id="recollectSummary"></p><p id="recollectScope"></p><p id="recollectClipped" hidden></p><p id="recollectPromptSummary"></p>
    <p id="recollectPreserved"></p>
    <details class="detail-disclosure"><summary id="recollectAvailabilityToggle">Source availability and limits</summary><p id="recollectBounds"></p><ul id="recollectAvailability"></ul><p id="recollectPolicy"></p><p class="muted">The preview expires after two minutes. Changes require a new preview. Refresh and restart never authorize recollection. This is a source reread, not an undo or backup restore.</p></details>
  </div>
  <p id="recollectStatus" role="status" aria-live="polite" aria-atomic="true" tabindex="-1"></p>
  <div class="delete-actions"><button id="recollectChange" type="button" class="quiet" hidden>Change scope</button><button id="recollectCheck" type="button" hidden>Check recollection result</button><button id="recollectConfirm" type="button" hidden>Recollect records</button></div>
  </div>
</dialog>`;

export const recollectionStyles = `
#recollectDialog {padding:0}
#recollectDialog .dialog-head {align-items:flex-start}
#recollectDialog .dialog-head h2 {min-width:0}
#recollectClose {flex:none}
#recollectDialog .dialog-body {padding:clamp(16px,3vw,28px)}
#recollectDialog .recollect-field {display:grid;gap:8px;margin-top:16px}
#recollectSources {width:100%;overflow-wrap:anywhere}
#recollectDialog .recollect-selection {display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:8px}
#recollectDialog .recollect-selection p {margin:0}
#recollectDialog .list-pager {flex-wrap:wrap}
#recollectSources .delete-choice {padding:4px 0}
#recollectDialog .recollect-dates {display:flex;flex-wrap:wrap;gap:12px;margin:16px 0}
#recollectDialog .recollect-dates label {display:grid;gap:6px;flex:1 1 12rem;min-width:0}
#recollectDialog input[type=checkbox] {appearance:auto;width:20px;height:20px;flex:none;accent-color:var(--accent)}
#recollectDialog .recollect-preview-action {margin-top:20px}
#recollectSummary {font-weight:600}
#recollectAvailability {padding-left:20px;overflow-wrap:anywhere}
#recollectAvailability li {margin-top:12px}
#recollectStatus:empty {display:none}
`;

// Serialized into the page; dependencies stay inside the mount function.
export function mountRecollection({ api, time, timeContext, search, pageSources, ux, onCommitted }) {
    const $ = id => document.getElementById(id), dialog = $("recollectDialog");
    const storageKey = "workiq-evidence.recollection-operation";
    let phase = "editing", token = 0, preview, receipt, trigger, busy = false, sourcesReady = false;
    let sources = [], selectedOnly = false;
    const selectedSources = new Set();
    const locked = () => ["pending", "uncertain"].includes(phase);
    function period(from, to, context) {
        const first = from.includes("T") ? time.day(from, context.timeZone) : from;
        const last = to.includes("T") ? time.day(to, context.timeZone) : to;
        return first === last ? time.formatDate(first, context, true)
            : `${time.formatDate(first, context, first.slice(0, 4) !== last.slice(0, 4))} to ${time.formatDate(last, context, true)}`;
    }
    function selectionCount() {
        $("recollectSelected").textContent = `${selectedSources.size} selected`;
        $("recollectShowSelected").disabled = !selectedSources.size && !selectedOnly;
        $("recollectShowSelected").textContent = selectedOnly ? "Show all chats" : "Show selected";
        for (const input of $("recollectSources").querySelectorAll("input")) input.disabled = selectedSources.size >= 128 && !input.checked;
    }
    function renderSources(reset = true) {
        const query = $("recollectSearch").value;
        const matches = sources.filter(source => (!selectedOnly || selectedSources.has(source.sourceSessionId))
            && search.matches(query, [source.name]));
        $("recollectClearSearch").hidden = !query;
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
        $("recollectStatus").textContent = text;
        $("recollectStatus").classList.toggle("error", error);
    }
    function update() {
        $("recollectForm").inert = busy || locked();
        $("recollectForm").hidden = phase === "preview" || phase === "complete" || locked();
        $("recollectConfirmation").hidden = !preview || phase === "editing" || phase === "complete";
        $("recollectPreview").disabled = busy || !sourcesReady || locked();
        $("recollectConfirm").hidden = phase !== "preview" && phase !== "pending";
        $("recollectConfirm").disabled = busy || phase !== "preview" || !preview?.counts.records;
        $("recollectChange").hidden = phase !== "preview";
        $("recollectCheck").hidden = phase !== "uncertain";
        $("recollectCheck").disabled = busy;
        $("recollectClose").disabled = phase === "pending";
        $("recollectClose").textContent = ["complete", "uncertain"].includes(phase) ? "Close" : "Cancel";
        ux.pending($("recollectPreview"), busy && phase === "editing");
        ux.pending($("recollectConfirm"), phase === "pending");
        ux.pending($("recollectCheck"), busy && phase === "uncertain");
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
        $("recollectTitle").textContent = "Recollect from approved sources";
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
        sources = []; selectedSources.clear(); selectedOnly = false; $("recollectSearch").value = ""; selectionCount();
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
    async function showResult(result) {
        if (result.operationId !== receipt?.operationId) throw new Error("Recollection receipt does not match this operation.");
        if (result.phase === "complete") {
            phase = "complete";
            sessionStorage.removeItem(storageKey);
            $("recollectTitle").textContent = "Evidence recollected";
            const c = result.counts;
            status(`Recollected ${c.records} request record${c.records === 1 ? "" : "s"}.${c.restoredPrompts ? ` Restored ${c.restoredPrompts} original prompt${c.restoredPrompts === 1 ? "" : "s"}.` : ""} Saved reports and comparisons are unchanged.`);
            update(); dialog.scrollTop = 0; $("recollectClose").focus();
            if (!await onCommitted()) status("Recollection completed, but the view could not refresh. Use Refresh stored data. Do not repeat the operation.", true);
        } else if (result.phase === "not-started") {
            phase = "editing"; preview = undefined; receipt = undefined;
            sessionStorage.removeItem(storageKey);
            status("No committed recollection was found. Nothing was replayed. Preview again if you still want to recollect.");
            sourcesReady = sources.length > 0;
            if (!sourcesReady) await readSources();
        } else {
            phase = "uncertain";
            status("The result is not yet confirmed. Check this operation's receipt; do not repeat recollection.", true);
        }
        update();
    }
    $("recollectForm").addEventListener("submit", async event => {
        event.preventDefault();
        if (busy || locked()) return;
        if (!selectedSources.size) { status("Choose at least one chat.", true); $("recollectSearch").focus(); return; }
        edit();
        const version = token;
        busy = true; update();
        status("Reading available source events for this preview. Nothing is being recollected.");
        try {
            const result = await api("/api/recollection/preview", scope());
            if (version !== token || !dialog.open) return;
            preview = result; phase = "preview";
            const c = result.counts;
            $("recollectTitle").textContent = "Recollect this evidence?";
            const kinds = [[c.reauthorized, "previously deleted"], [c.newRecords, "newly available"], [c.promptOnly, "existing with prompt restoration"]]
                .filter(([count]) => count).map(([count, label]) => `${count} ${label}`).join(", ");
            $("recollectSummary").textContent = `${c.records} request record${c.records === 1 ? "" : "s"}${kinds ? `: ${kinds}` : ""}.${c.alreadyPresent ? ` ${c.alreadyPresent} already-present records will not be duplicated.` : ""}`;
            const context = result.scope.timeContext;
            const chats = result.availability.length <= 3 ? result.availability.map(row => row.name).join("; ") : `${result.availability.length} selected chats (listed in source details)`;
            $("recollectScope").textContent = `${chats}. ${period(result.scope.from, result.scope.to, context)} (${time.displayLabel(context)}).`;
            const clipped = Date.parse(result.scope.since) > Date.parse(result.scope.bounds.from)
                || Date.parse(result.scope.until) < Date.parse(result.scope.bounds.to) - 1;
            $("recollectClipped").hidden = !clipped;
            $("recollectClipped").textContent = clipped ? `Only approved history from ${time.formatMoment(result.scope.since, context)} to ${time.formatMoment(result.scope.until, context)} is included.` : "";
            $("recollectBounds").textContent = `Exact approved bounds: ${time.formatTime(result.scope.since, context)} through ${time.formatTime(result.scope.until, context)}. Reads are limited to 32 MiB across this selection and the last 64 MiB of each file.`;
            $("recollectPromptSummary").textContent = result.scope.restorePrompts
                ? `Restore ${c.restoredPrompts} original prompt${c.restoredPrompts === 1 ? "" : "s"} for these requests.`
                : "Deleted original prompts stay deleted.";
            $("recollectPreserved").textContent = "Responses and feedback stay deleted. Saved reports, comparisons and Copilot sources stay unchanged.";
            $("recollectPolicy").textContent = result.boundary;
            $("recollectAvailability").replaceChildren(...result.availability.map(row => {
                const li = document.createElement("li");
                const gaps = [[row.droppedBytes, "earlier bytes outside the bounded tail"], [row.unreadBytes, "unread bytes"],
                    [row.malformedLines, "malformed lines"], [row.oversizedLines, "oversized lines"],
                    [row.credentialExclusions, "credential exclusions"], [row.missingResults, "calls without a recorded result"]]
                    .filter(([count]) => count).map(([count, label]) => `${count} ${label}`).join("; ");
                li.textContent = `${row.name}: ${row.problem || "Available history read."}${gaps ? ` ${gaps}.` : ""}`;
                return li;
            }));
            $("recollectConfirm").textContent = `Recollect ${c.records} record${c.records === 1 ? "" : "s"}`;
            const partial = result.availability.some(row => row.problem || row.droppedBytes || row.unreadBytes || row.malformedLines || row.oversizedLines || row.credentialExclusions || row.missingResults);
            status(c.records ? (partial ? "Some history is unavailable or incomplete. Only the records shown will be recollected. See source details."
                : "") : "No eligible records are available in this scope. Nothing can be recollected.");
            dialog.scrollTop = 0; $("recollectClose").focus();
        } catch (error) { if (version === token) status(`Preview failed. Nothing changed. ${error.message}`, true); }
        finally { busy = false; update(); }
    });
    $("recollectConfirm").addEventListener("click", async () => {
        if (phase !== "preview" || busy || !preview?.counts.records) return;
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
        if (busy || !receipt) return;
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
    $("recollectSearch").addEventListener("input", () => renderSources());
    $("recollectClearSearch").addEventListener("click", () => { $("recollectSearch").value = ""; renderSources(); $("recollectSearch").focus(); });
    $("recollectShowSelected").addEventListener("click", () => { selectedOnly = !selectedOnly; $("recollectSearch").value = ""; renderSources(); });
    for (const id of ["recollectFrom", "recollectTo", "recollectPrompts"]) $(id).addEventListener("input", () => { edit(); status(""); });
    $("recollectClose").addEventListener("click", () => dialog.close());
    dialog.addEventListener("cancel", event => { if (phase === "pending") event.preventDefault(); });
    dialog.addEventListener("close", () => {
        token++;
        if (!locked()) { cancelPreview(); phase = "editing"; }
        if (trigger?.isConnected) ux.restoreFocus(trigger);
    });
    dialog.addEventListener("keydown", event => {
        if (event.key !== "Tab") return;
        const controls = [...dialog.querySelectorAll("button,input,select,summary")].filter(node => !node.disabled && !node.closest("[inert]") && node.checkVisibility());
        if (!controls.length) { event.preventDefault(); $("recollectStatus").focus(); return; }
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    });
    $("recollectActivity").addEventListener("click", async () => {
        trigger = document.activeElement;
        if (!locked()) {
            phase = "editing"; preview = undefined; receipt = undefined; sourcesReady = false;
            $("recollectPrompts").checked = false; $("recollectFrom").value = ""; $("recollectTo").value = "";
            $("recollectTitle").textContent = "Recollect from approved sources";
            try {
                const stored = JSON.parse(sessionStorage.getItem(storageKey) || "null");
                if (stored && /^[a-f0-9-]{36}$/.test(stored.operationId) && /^[a-f0-9]{64}$/.test(stored.receiptToken)) {
                    receipt = stored; phase = "uncertain";
                }
            } catch { status("Recovery storage is unavailable. Confirmation requires a saved receipt.", true); }
        }
        update(); dialog.showModal(); dialog.scrollTop = 0; $("recollectClose").focus();
        if (phase === "uncertain") status("A previous recollection needs checking. Read its saved receipt before starting another operation.", true);
        else await readSources();
    });
    return { isOpen: () => dialog.open, invalidate() {
        if (!locked() && dialog.open) { edit(); status("The connection or display time zone changed. Read the source list and preview again.", true); readSources(); }
    } };
}
