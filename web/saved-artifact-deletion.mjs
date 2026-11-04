export function createSavedArtifactDeletion({ api, ux, onDeleted, onError, fallbackFocus, createEligibilityState }) {
    if (typeof api !== "function" || typeof api.publicationToken !== "function" || typeof api.isCurrent !== "function") {
        throw new TypeError("An access-aware API with publicationToken() and isCurrent() is required.");
    }
    const dialog = document.createElement("dialog");
    dialog.className = "deletion-dialog decision-frame";
    dialog.dataset.decisionKind = "destructive";
    dialog.setAttribute("aria-labelledby", "savedArtifactDeleteTitle");
    const title = document.createElement("h2"); title.id = "savedArtifactDeleteTitle";
    const heading = document.createElement("div"); heading.className = "delete-heading";
    const icon = document.createElement("span"); icon.className = "delete-warning-icon"; icon.setAttribute("aria-hidden", "true"); icon.append(ux.icon("warning"));
    heading.append(icon, title);
    const body = document.createElement("div"); body.className = "decision-body";
    const identity = document.createElement("p"); identity.className = "decision-object";
    const scope = document.createElement("p"), preservation = document.createElement("p"), dependents = document.createElement("p");
    const warning = document.createElement("p"); warning.className = "delete-irreversible"; warning.textContent = "Permanent local deletion. This cannot be undone.";
    const status = document.createElement("p"); status.className = "decision-status"; status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); status.tabIndex = -1;
    const footer = document.createElement("div"); footer.className = "delete-actions";
    function button(text, action, cls) {
        const node = document.createElement("button"); node.type = "button"; node.textContent = text;
        if (cls) node.className = cls; node.addEventListener("click", action); return node;
    }
    const cancel = button("Cancel", () => dialog.close());
    const confirm = button("Delete report", commit, "delete-object-confirm danger");
    const check = button("Check deletion result", checkResult);
    confirm.dataset.decisionAction = "commit"; check.dataset.decisionAction = "check";
    footer.append(cancel, check, confirm);
    body.append(identity, scope, preservation, dependents, warning, status);
    dialog.append(heading, body, footer);
    document.body.append(dialog);
    const recoveryNotice = document.createElement("div");
    recoveryNotice.className = "notice"; recoveryNotice.hidden = true;
    const messageHost = document.getElementById("message");
    if (messageHost) messageHost.after(recoveryNotice);
    else document.querySelector("main")?.prepend(recoveryNotice);
    const receiptKey = "wire.saved-artifact-deletion";
    let generation = 0, phase = "closed", preview = null, target = null, trigger = null, operationId = null, receiptToken = null;
    let taskActive = false, restoreOnClose = true;
    let accessAvailable = true, accessEpoch = 0, suppressedCloses = 0;
    const publication = () => ({ epoch: accessEpoch, token: api.publicationToken() });
    const current = access => accessAvailable && access?.epoch === accessEpoch && access.token != null
        && api.isCurrent(access.token) === true;
    const busy = () => taskActive || ["loading", "pending", "checking"].includes(phase);
    const dismissalLocked = () => phase === "pending";
    const eligibilityState = createEligibilityState?.();
    let eligibility = null;
    function eligibilityStamp(binding) {
        if (!binding || !binding.isCurrent() || !current(publication())) return null;
        const access = api.accessState();
        return { target: binding.target, revision: binding.getRevision(), publication: api.publicationToken(),
            owner: api.controlToken(), authorizationRevision: access.state?.authorizationRevision };
    }
    function clearEligibility(message = "Read current deletion availability before using Delete.") {
        const previous = eligibility;
        eligibility = null; eligibilityState?.invalidate(); previous?.controller.abort();
        previous?.onChange(false, message);
    }
    async function qualify(target, options) {
        clearEligibility();
        const binding = { ...options, target: { artifactKind: target.artifactKind, artifactId: target.artifactId },
            controller: new AbortController() };
        eligibility = binding;
        binding.onChange(false, "Checking deletion availability. Nothing is being deleted.");
        try {
            if (!eligibilityState || busy() || phase === "unknown") throw new Error("An earlier saved-item operation must be settled first.");
            const ticket = eligibilityState.begin(eligibilityStamp(binding));
            const result = await api("/api/artifact-deletion/eligibility", binding.target, { signal: binding.controller.signal });
            if (eligibility !== binding || binding.controller.signal.aborted) return false;
            const allowed = eligibilityState.receive(ticket, result, eligibilityStamp(binding));
            binding.onChange(allowed, allowed ? "Delete opens a separate preview and confirmation; nothing has been deleted."
                : "Deletion is not available for this saved item in the current access.");
            return allowed;
        } catch (error) {
            if (eligibility !== binding || binding.controller.signal.aborted) return false;
            eligibilityState?.invalidate();
            binding.onChange(false, error.status === 403 ? "Deletion is not available for this saved item in the current access."
                : "Deletion availability could not be verified. " + error.message);
            return false;
        }
    }
    function eligible(target) {
        if (!eligibility || target.artifactId !== eligibility.target.artifactId || target.artifactKind !== eligibility.target.artifactKind
            || busy() || phase === "unknown") return false;
        return eligibilityState.allowed(eligibilityStamp(eligibility));
    }
    function observeEligibility(revision) {
        if (eligibility && (revision !== undefined && revision !== eligibility.getRevision()
            || !eligibilityState.current(eligibilityStamp(eligibility)))) clearEligibility();
    }
    function showRecovery() {
        const access = publication();
        if (!current(access)) return;
        const text = document.createElement("p");
        text.textContent = "An earlier saved-item deletion needs checking. No deletion will be repeated.";
        const action = button("Check earlier saved-item deletion", async event => {
            if (!current(access)) return;
            await open(null, event.currentTarget);
            if (current(access) && phase === "unknown") await checkResult();
        });
        action.disabled = busy();
        recoveryNotice.replaceChildren(text, action);
        recoveryNotice.hidden = false;
    }
    function message(text, error = false) {
        if (!current(publication())) return;
        status.textContent = text; status.setAttribute("role", error ? "alert" : "status"); status.classList.toggle("error", error);
    }
    function paint() {
        if (!current(publication())) return;
        const displayPhase = phase === "preview" ? "confirm" : phase;
        if (dialog.dataset.decisionPhase !== displayPhase) {
            const role = phase === "complete" ? "check" : ["loading", "pending", "checking"].includes(phase) ? "pending" : "warning";
            const glyph = ux.icon(role);
            if (role === "pending") glyph.classList.add("pending-indicator");
            icon.replaceChildren(glyph);
            dialog.dataset.decisionPhase = displayPhase;
        }
        const object = target?.scope === "all-reports" ? "saved reports" : target?.artifactKind === "comparison" ? "saved comparison" : "report";
        if (phase === "preview") title.textContent = target?.scope === "all-reports" ? "Delete all saved reports?" : `Delete this ${object}?`;
        else if (phase !== "complete") title.textContent = {
            loading: "Review saved-item deletion", pending: `Deleting ${object}`, checking: "Checking deletion result",
            unknown: "Deletion result unknown", error: "Saved-item deletion unavailable", "not-started": "No saved-item deletion found",
        }[phase] ?? title.textContent;
        identity.hidden = !identity.textContent || phase === "complete";
        confirm.hidden = phase !== "preview" && phase !== "pending";
        confirm.disabled = phase !== "preview";
        check.hidden = !["unknown", "checking"].includes(phase);
        check.disabled = phase === "checking";
        cancel.disabled = dismissalLocked();
        cancel.textContent = ["loading", "checking", "complete", "not-started", "unknown", "error"].includes(phase) ? "Close" : "Cancel";
        warning.hidden = !["preview", "pending"].includes(phase);
        dialog.setAttribute("aria-busy", String(["loading", "pending", "checking"].includes(phase)));
        ux.pending(confirm, phase === "pending"); ux.pending(check, phase === "checking");
        if (phase === "unknown") showRecovery();
    }
    function validatePreview(value, expected) {
        const bulk = expected.scope === "all-reports";
        if (!value || typeof value.operationId !== "string" || !/^[a-f0-9]{64}$/.test(value.receiptToken)
            || (bulk ? !validBatch(value) : !value.artifact || value.artifact.artifactId !== expected.artifactId || value.artifact.artifactKind !== expected.artifactKind)
            || !value.counts
            || ["managedFiles", "managedCopies", "savedDependentComparisons"].some(key => !Number.isSafeInteger(value.counts[key]) || value.counts[key] < 0)) {
            throw new Error("The deletion preview did not confirm this saved object and its managed scope.");
        }
        return value;
    }
    function validBatch(value) {
        return value.scope === "all-reports" && Array.isArray(value.artifacts) && value.artifacts.length > 0
            && value.artifacts.every(item => item.artifactKind === "report" && /^export-[a-f0-9-]{36}$/.test(item.artifactId))
            && new Set(value.artifacts.map(item => item.artifactId)).size === value.artifacts.length
            && value.counts?.reports === value.artifacts.length
            && Number.isSafeInteger(value.counts.savedComparisons) && value.counts.savedComparisons >= 0;
    }
    function forget() {
        receiptToken = null; preview = null;
        recoveryNotice.hidden = true;
        try { sessionStorage.removeItem(receiptKey); }
        catch { onError("The completed deletion receipt could not be cleared from this panel. Checking it again will not repeat deletion."); }
    }
    async function cancelPreview(value) {
        const access = publication();
        if (!current(access) || !value?.operationId) return;
        try { await api("/api/artifact-deletion/cancel", { operationId: value.operationId }); }
        catch (error) { if (current(access)) onError("The saved-object preview could not be cancelled. Do not reuse it; it will expire. " + error.message); }
    }
    async function result(value, access) {
        if (!current(access)) return;
        if (!value || value.operationId !== operationId) throw new Error("This deletion receipt belongs to another operation.");
        if (value.phase === "complete") {
            const bulk = value.scope === "all-reports";
            if (value.kind !== "artifact-deletion" || (bulk ? !validBatch(value) : typeof value.artifact?.artifactId !== "string"
                || !["report", "comparison"].includes(value.artifact.artifactKind))) throw new Error("The receipt did not identify the deleted saved object.");
            if (target && (target.scope === "all-reports" ? !bulk || preview && JSON.stringify(value.artifacts) !== JSON.stringify(preview.artifacts)
                : bulk || value.artifact.artifactId !== target.artifactId || value.artifact.artifactKind !== target.artifactKind)) throw new Error("The completed deletion does not match the named saved object.");
            phase = "complete"; forget();
            preservation.textContent = ""; dependents.textContent = "";
            title.textContent = bulk ? `${value.counts.reports.toLocaleString()} saved reports deleted`
                : value.artifact.artifactKind === "comparison" ? "Saved comparison deleted" : "Saved report deleted";
            scope.textContent = bulk ? "Only the reports included in the confirmed preview were removed. Newer reports are not included."
                : `${target?.label || value.artifact.artifactId} was deleted from this app.`;
            message(bulk ? "Saved comparisons, collected activity, draft reports and external downloads are unchanged. Unsaved comparisons using the deleted reports are no longer valid."
                : "The saved " + (value.artifact.artifactKind === "comparison" ? "comparison" : "report") + " was deleted. Source activity and other saved objects are unchanged.");
            paint();
            const displayedGeneration = generation;
            const applied = await onDeleted(bulk ? { scope: value.scope, artifacts: value.artifacts } : value.artifact);
            if (!current(access)) return;
            if (applied === false) message("Deletion completed, but the saved list could not refresh. Use Retry; do not repeat deletion.", true);
            if (dialog.open && generation === displayedGeneration) cancel.focus();
        } else if (value.phase === "not-started") {
            phase = "not-started"; forget(); message("No committed deletion was found. Nothing was retried. Close this dialog and start a fresh preview if needed.");
        } else if (value.phase === "pending") {
            phase = "unknown"; message("Deletion is sealed but cleanup is not complete. Some files may already be removed. Check the original result after runtime recovery; no additional deletion will be sent.", true);
        } else if (value.phase === "in-progress") {
            phase = "unknown"; message("The original deletion is still in progress. Check its result; no additional deletion will be sent.");
        } else {
            phase = "unknown"; message("Saved-object cleanup is incomplete. Check the original operation after recovery; do not repeat deletion.", true);
        }
        paint();
    }
    async function commit() {
        const access = publication();
        if (!current(access) || phase !== "preview" || !preview || busy()) return;
        operationId = preview.operationId;
        receiptToken = preview.receiptToken;
        try { sessionStorage.setItem(receiptKey, JSON.stringify({ operationId, receiptToken })); }
        catch { message("The recovery receipt cannot be retained in this panel. Nothing was deleted.", true); return; }
        taskActive = true;
        phase = "pending"; message(target?.scope === "all-reports" ? "Deleting only the reviewed reports and their managed copies. Cleanup may finish in stages..."
            : "Deleting only this saved object's managed files and copies..."); paint(); status.focus();
        try { await result(await api("/api/artifact-deletion/confirm", { operationId, confirmed: true }), access); }
        catch (error) { if (current(access)) { phase = "unknown"; message(error.message + " Check the original deletion result; do not repeat it.", true); paint(); } }
        finally { if (current(access)) { taskActive = false; paint(); } }
    }
    async function checkResult() {
        const access = publication();
        if (!current(access) || phase !== "unknown" || !operationId || busy()) return;
        taskActive = true;
        phase = "checking"; paint();
        try { await result(await api("/api/artifact-deletion/status", { operationId, ...(receiptToken ? { receiptToken } : {}) }), access); }
        catch (error) { if (current(access)) { phase = "unknown"; message(error.message + " No deletion was repeated.", true); paint(); } }
        finally { if (current(access)) { taskActive = false; paint(); } }
    }
    async function open(value, from) {
        clearEligibility();
        const access = publication();
        if (!current(access) || busy()) return;
        restoreOnClose = true;
        trigger = from; target = value; preview = null;
        identity.textContent = ""; scope.textContent = ""; preservation.textContent = ""; dependents.textContent = "";
        body.scrollTop = 0;
        let stored;
        try { stored = sessionStorage.getItem(receiptKey); }
        catch { phase = "error"; title.textContent = "Saved-object deletion unavailable"; message("The panel cannot read its earlier deletion receipt. No new deletion was requested.", true); paint(); dialog.showModal(); cancel.focus(); return; }
        if (stored) {
            try {
                const receipt = /^[a-f0-9-]{36}$/.test(stored) ? { operationId: stored } : JSON.parse(stored);
                if (!/^[a-f0-9-]{36}$/.test(receipt.operationId) || receipt.receiptToken !== undefined && !/^[a-f0-9]{64}$/.test(receipt.receiptToken)) throw new Error("Invalid receipt.");
                operationId = receipt.operationId; receiptToken = receipt.receiptToken ?? null;
            } catch {
                phase = "error"; title.textContent = "Saved-object deletion unavailable";
                scope.textContent = ""; preservation.textContent = ""; dependents.textContent = "";
                message("The earlier deletion receipt is unreadable. No new deletion was requested.", true);
                paint(); if (!dialog.open) dialog.showModal(); cancel.focus(); return;
            }
            target = null; phase = "unknown";
            title.textContent = "Check an earlier saved-object deletion";
            scope.textContent = "A previous operation needs checking before another deletion.";
            preservation.textContent = "No new saved object has been selected for deletion.";
            dependents.textContent = "";
            message("Read the existing operation's result. It will not be repeated.");
            paint(); if (!dialog.open) dialog.showModal(); cancel.focus(); return;
        }
        if (!value) { recoveryNotice.hidden = true; return; }
        const bulk = value.scope === "all-reports";
        if (!bulk && (!["report", "comparison"].includes(value.artifactKind) || typeof value.artifactId !== "string")) throw new TypeError("A saved object identity is required.");
        const token = ++generation;
        taskActive = true;
        phase = "loading"; title.textContent = bulk ? "Delete all saved reports?" : `Delete ${value.artifactKind === "comparison" ? "saved comparison" : "report"} ${value.label || value.artifactId}?`;
        identity.textContent = bulk ? "" : value.label || value.artifactId;
        warning.textContent = bulk
            ? "Permanent local deletion. This cannot be undone. If interrupted, some files may remain. Use Check deletion result to see whether cleanup has finished."
            : "Permanent local deletion. This cannot be undone.";
        scope.textContent = "Reading the exact managed files and copies. Nothing is being deleted.";
        preservation.textContent = bulk ? "Saved comparisons, collected activity, draft reports and external downloads stay unchanged. Unsaved comparisons using these reports will become invalid."
            : value.artifactKind === "comparison"
            ? "Source reports, collected activity, other saved comparisons and external downloads stay unchanged."
            : "Collected activity, draft reports, other reports, saved comparisons and external downloads stay unchanged. Unsaved comparisons using this report will become invalid.";
        dependents.textContent = ""; message("");
        paint(); if (!dialog.open) dialog.showModal(); cancel.focus();
        try {
            const response = await api("/api/artifact-deletion/preview", bulk ? { scope: "all-reports" } : { artifactKind: value.artifactKind, artifactId: value.artifactId });
            if (!current(access)) return;
            if (token !== generation || !dialog.open) { await cancelPreview(response); return; }
            preview = validatePreview(response, value);
            scope.textContent = bulk
                ? `${preview.counts.reports.toLocaleString()} saved reports across all pages, regardless of search, will be deleted (${preview.counts.managedFiles.toLocaleString()} managed files in ${preview.counts.managedCopies.toLocaleString()} copies). New reports saved after this preview are not included.`
                : `${preview.counts.managedFiles} managed files and ${preview.counts.managedCopies} managed copies will be removed for this saved object.`;
            if (bulk) preservation.textContent = `${preview.counts.savedComparisons.toLocaleString()} saved comparison${preview.counts.savedComparisons === 1 ? " keeps its" : "s keep their"} frozen information${preview.counts.savedDependentComparisons ? `; ${preview.counts.savedDependentComparisons.toLocaleString()} will lose links to the deleted originals` : ""}. Collected activity, draft reports and external downloads stay unchanged. Unsaved comparisons using these reports will become invalid.`;
            dependents.textContent = !bulk && preview.counts.savedDependentComparisons
                ? `${preview.counts.savedDependentComparisons} saved comparison${preview.counts.savedDependentComparisons === 1 ? "" : "s"} ${preview.counts.savedDependentComparisons === 1 ? "keeps" : "keep"} frozen information. Links to this original report become unavailable.`
                : "";
            confirm.textContent = bulk ? `Delete ${preview.counts.reports.toLocaleString()} saved reports` : value.artifactKind === "comparison" ? "Delete saved comparison" : "Delete report";
            phase = "preview"; paint();
        } catch (error) { if (current(access) && token === generation) { phase = "error"; message(error.message + " Nothing was deleted.", true); paint(); } }
        finally {
            if (current(access)) {
                taskActive = false;
                if (!dialog.open && phase === "loading") phase = "closed";
                paint();
            }
        }
    }
    dialog.addEventListener("cancel", event => { if (dismissalLocked()) event.preventDefault(); });
    dialog.addEventListener("close", () => {
        if (suppressedCloses) { suppressedCloses--; return; }
        if (!current(publication())) return;
        if (dialog.open) return;
        generation++;
        if (phase === "preview") cancelPreview(preview);
        preview = null;
        if (operationId && ["pending", "checking", "unknown"].includes(phase)) showRecovery();
        if (!restoreOnClose) return;
        if (trigger?.isConnected && trigger.checkVisibility()) ux.restoreFocus(trigger);
        else {
            const fallback = fallbackFocus();
            if (fallback) { ux.restoreFocus(fallback); fallback.scrollIntoView({ block: "nearest" }); }
        }
    });
    try { if (sessionStorage.getItem(receiptKey)) showRecovery(); }
    catch {
        const notice = document.createElement("p");
        notice.textContent = "The panel cannot read its saved-item deletion receipt. No deletion has been requested.";
        if (current(publication())) { recoveryNotice.replaceChildren(notice); recoveryNotice.hidden = false; }
    }
    function withdrawAccess() {
        clearEligibility("Current access is required to check deletion availability.");
        if (!accessAvailable) return;
        accessAvailable = false; accessEpoch++; generation++;
        if (["pending", "checking"].includes(phase)) phase = "unknown";
        else if (!["unknown", "complete", "not-started"].includes(phase)) phase = "closed";
        target = null; preview = null; trigger = null; taskActive = false; restoreOnClose = false;
        if (dialog.open) { suppressedCloses++; dialog.close(); }
        for (const node of [title, identity, scope, preservation, dependents, status]) node.textContent = "";
        confirm.textContent = "Delete saved item";
        recoveryNotice.replaceChildren(); recoveryNotice.hidden = true;
        delete dialog.dataset.decisionPhase; dialog.removeAttribute("aria-busy");
        for (const node of [cancel, confirm, check]) node.disabled = true;
    }
    return {
        open, qualify, eligible, observeEligibility, clearEligibility,
        withdrawAccess,
        resumeAccess() {
            const access = publication();
            if (access.epoch === accessEpoch && access.token != null && api.isCurrent(access.token) === true) accessAvailable = true;
        },
        leave() {
            clearEligibility();
            restoreOnClose = false;
            if (dialog.open) dialog.close();
        },
        invalidate() {
            clearEligibility();
            if (!current(publication())) return;
            if (phase === "preview" || phase === "loading") {
                generation++; cancelPreview(preview); preview = null; phase = "error";
                message("Saved objects changed. Close this dialog and request a fresh deletion preview.", true); paint();
            }
        },
    };
}
