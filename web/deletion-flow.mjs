export function createDeletionFlow() {
    let version = 0, state = { phase: "editing", scope: { scope: "range" }, preview: null };
    const locked = () => ["pending", "uncertain"].includes(state.phase);
    return {
        token: () => version,
        snapshot: () => structuredClone(state),
        edit(scope) {
            if (locked()) return null;
            version++;
            state = { phase: "editing", scope: structuredClone(scope), preview: null };
            return version;
        },
        accept(token, preview) {
            if (token !== version || locked()) return false;
            state = { ...state, phase: "preview", preview };
            return true;
        },
        begin() {
            if (state.phase !== "preview" || !state.preview?.counts.records && !state.preview?.counts.localCopies) return null;
            state = { ...state, phase: "pending", operationId: state.preview.operationId };
            return state.operationId;
        },
        uncertain(message) { state = { ...state, phase: "uncertain", message }; },
        result(result) {
            if (result.operationId !== state.operationId) throw new Error("Deletion receipt does not match the confirmed operation.");
            state = { ...state, phase: ["pending", "in-progress"].includes(result.phase) ? "uncertain" : result.phase, result };
        },
    };
}

export function mountDeletion({ api, flow, timeContext, ux, onCommitted }) {
    const $ = id => document.getElementById(id);
    const dialog = $("deleteDialog"), form = $("deleteScopeForm");
    let trigger, previewBusy = false, readBusy = false;
    const key = "workiq-evidence.deletion-operation";
    const setStatus = (message, error = false) => {
        $("deleteStatus").textContent = message;
        $("deleteStatus").classList.toggle("error", error);
    };
    function scope() {
        const value = { scope: $("deleteAll").checked ? "all" : "range", timeContext: timeContext() };
        return value.scope === "all" ? value : { ...value, from: $("deleteFrom").value, to: $("deleteTo").value };
    }
    function edited() {
        const previous = flow.snapshot();
        if (flow.edit(scope()) === null) return;
        cancelPreview(previous);
        $("deleteDateFields").hidden = $("deleteAll").checked;
        $("deleteConfirmation").hidden = true;
        $("deleteConfirm").disabled = true;
        $("deleteScopeForm").hidden = false;
        $("deleteChangeScope").hidden = true;
        $("deleteCancel").textContent = "Cancel";
        $("deleteTitle").textContent = "Delete collected activity";
        setStatus("");
    }
    function cancelPreview(previous) {
        if (previous.phase !== "preview") return;
        api("/api/deletion/cancel", { operationId: previous.preview.operationId }).catch(() => {
            setStatus("The previous preview could not be cancelled on the runtime. It cannot be used here and will expire; no deletion was requested.", true);
        });
    }
    function update() {
        const state = flow.snapshot(), pending = state.phase === "pending", uncertain = state.phase === "uncertain";
        form.inert = pending || uncertain;
        $("deletePreview").disabled = previewBusy || pending || uncertain;
        $("deleteConfirm").disabled = pending || uncertain || !state.preview || (!state.preview.counts.records && !state.preview.counts.localCopies);
        $("deleteConfirm").hidden = !["preview", "pending", "uncertain"].includes(state.phase) || (!state.preview?.counts.records && !state.preview?.counts.localCopies);
        $("deleteCancel").disabled = pending;
        $("deleteCheck").hidden = !uncertain;
        $("deleteCheck").disabled = readBusy;
        $("deleteChangeScope").disabled = pending || uncertain;
        ux.pending($("deletePreview"), previewBusy);
        ux.pending($("deleteConfirm"), pending);
        ux.pending($("deleteCheck"), readBusy);
    }
    async function showResult(result) {
        flow.result(result);
        if (result.phase === "complete") {
            try { sessionStorage.removeItem(key); } catch { /* The visible operation receipt remains available. */ }
            $("deleteConfirmation").hidden = true;
            form.hidden = true;
            $("deleteChangeScope").hidden = true;
            $("deleteCancel").textContent = "Close";
            $("deleteTitle").textContent = "Collected activity deleted";
            setStatus(`Deleted ${result.counts.records} records${result.linkedInsights?.interactions ? " and linked insights" : ""}. Saved reports and comparisons, source files and collection preferences are unchanged. New activity can still be collected.`);
            update();
            $("deleteCancel").focus();
            if (!await onCommitted()) setStatus(`Deleted ${result.counts.records} records. The view could not refresh; use Retry. Do not repeat deletion. Saved reports are unchanged.`, true);
        } else if (result.phase === "not-started") {
            flow.edit(scope());
            form.hidden = false;
            $("deleteChangeScope").hidden = true;
            $("deleteConfirmation").hidden = true;
            setStatus("No committed deletion was found for this operation. Nothing will be retried. Preview again if you still want to delete.");
            try { sessionStorage.removeItem(key); } catch { /* No mutation can be replayed from storage. */ }
        } else if (result.phase === "in-progress") {
            setStatus("The confirmed deletion is still in progress. Check the result again; no additional deletion will be sent.");
        } else {
            setStatus("Deletion cleanup is incomplete. Activity and exports are blocked until the runtime completes the sealed cleanup. Restart the runtime, then check this result. Do not start another deletion.", true);
        }
        update();
    }
    async function check() {
        if (readBusy) return;
        readBusy = true; update();
        try { await showResult(await api("/api/deletion/status", { operationId: flow.snapshot().operationId })); }
        catch (error) { setStatus(`${error.message} Check the saved result; no deletion was repeated.`, true); }
        finally { readBusy = false; update(); }
    }
    async function preview(event) {
        event.preventDefault();
        if (previewBusy || ["pending", "uncertain"].includes(flow.snapshot().phase)) return;
        edited();
        const token = flow.token();
        previewBusy = true; update();
        setStatus("Reading the exact local records and supporting copies. Nothing is being deleted.");
        try {
            const result = await api("/api/deletion/preview", scope());
            if (!flow.accept(token, result)) return;
            const c = result.counts;
            $("deleteSummary").textContent = result.scope.scope === "all"
                ? `All collected activity: ${c.records} records across ${c.requestGroups} current request groups.`
                : `${result.scope.from} through ${result.scope.to}, inclusive (${result.scope.timeContext.timeZone}): ${c.records} records across ${c.requestGroups} current request groups.`;
            $("deleteZone").textContent = `Time zone: ${result.scope.timeContext.timeZone}. Dates use each record's start time, not completion. Calls without a start use their recorded group capture time; Graph sites never borrow it. ${result.scope.bounds ? `UTC bounds: ${result.scope.bounds.from} up to (not including) ${result.scope.bounds.to}.` : "Includes unknown-time records and retained recovery copies."}`;
            const units = [[c.toolCalls - (c.anonymousToolCalls ?? 0), "tool call"],
                [c.graphRecords - (c.anonymousGraphRecords ?? 0), "Graph record"],
                [c.diagnostics - (c.anonymousDiagnostics ?? 0), "HTTP diagnostic"], [c.other, "other record"],
                [c.anonymousRecords ?? 0, "local record without a source identifier"]]
                .filter(([count]) => count).map(([count, label]) => `${count} ${label}${count === 1 ? "" : "s"}`).join("; ");
            $("deleteBreakdown").textContent = (units ? units + "." : "Only supporting local copies remain.")
                + `${c.anonymousRecords ? " Unidentified local copies are matched by their retained start/request fingerprint, not verified distinct invocations. Ambiguous repeated occurrences cannot be deleted by this flow." : ""}`
                + `${c.partialGroups ? ` ${c.partialGroups} request groups keep their out-of-range records.` : ""}${c.retainedOnly ? ` ${c.retainedOnly} records exist only in retained local copies.` : ""}${c.undatedPreserved ? ` ${c.undatedPreserved} unknown-time records are preserved.` : ""}`;
            $("deleteCopies").textContent = `${c.localCopies} supporting local file${c.localCopies === 1 ? "" : "s"} will be cleaned. ${c.savedReports} saved report${c.savedReports === 1 ? " stays" : "s stay"} available and retain${c.savedReports === 1 ? "s its" : " their"} previous copies.`;
            if (c.savedComparisons) $("deleteCopies").textContent += ` ${c.savedComparisons} saved comparison${c.savedComparisons === 1 ? " also keeps its" : "s also keep their"} frozen copies.`;
            const linked = result.linkedInsights;
            if (linked?.interactions && (!$("deleteLinkedInsights") || !$("deleteLinkedDetails"))) throw new Error("Linked insight effects cannot be shown. Reload this panel before confirming.");
            if ($("deleteLinkedInsights")) {
                $("deleteLinkedInsights").hidden = !linked?.interactions;
                $("deleteLinkedInsights").textContent = linked?.interactions
                    ? `Linked insights for ${linked.interactions} interaction${linked.interactions === 1 ? "" : "s"} will be cleared or recomputed.` : "";
            }
            if ($("deleteLinkedDetails")) {
                $("deleteLinkedDetails").hidden = !linked?.interactions;
                $("deleteLinkedDetails").textContent = linked?.interactions
                    ? `Linked cleanup: ${linked.capturedItems} captured items and ${linked.feedbackRevisions} personal feedback revisions. These are not additional source records.` : "";
            }
            $("deleteConfirm").textContent = c.records ? `Delete ${c.records} record${c.records === 1 ? "" : "s"}` : "Delete supporting copies";
            $("deleteConfirmation").hidden = !c.records && !c.localCopies;
            if (!c.records && !c.localCopies) setStatus("No collected records match this scope. Nothing to delete.");
            else {
                form.hidden = true;
                $("deleteChangeScope").hidden = false;
                $("deleteTitle").textContent = result.scope.scope === "all" ? "Delete all collected activity?" : "Delete activity in this date range?";
                setStatus("");
                $("deleteCancel").focus();
            }
        } catch (error) {
            if (token === flow.token()) {
                edited();
                setStatus(`Preview failed. Nothing deleted. ${error.message}`, true);
            }
        }
        finally { previewBusy = false; update(); }
    }
    async function confirm() {
        const operationId = flow.begin();
        if (!operationId) return;
        try { sessionStorage.setItem(key, operationId); }
        catch {
            flow.uncertain("Operation receipt could not be stored.");
            await showResult({ operationId, phase: "not-started" });
            setStatus("This browser cannot save the recovery receipt. Nothing deleted. Allow session storage before retrying.", true);
            return;
        }
        update();
        setStatus("Deleting the confirmed records and cleaning local copies. Keep this panel open.");
        $("deleteStatus").focus();
        try { await showResult(await api("/api/deletion/confirm", { operationId, confirmed: true })); }
        catch (error) {
            flow.uncertain(error.message);
            setStatus(`${error.message} Use Check deletion result to read this operation's receipt. No deletion will be repeated.`, true);
        } finally { update(); }
    }
    function open() {
        trigger = document.activeElement;
        if (!["pending", "uncertain"].includes(flow.snapshot().phase)) {
            $("deleteRange").checked = true;
            $("deleteFrom").value = "";
            $("deleteTo").value = "";
            edited();
            let receipt;
            try { receipt = sessionStorage.getItem(key); }
            catch { setStatus("Session storage is unavailable. Confirmation will be blocked unless a recovery receipt can be saved.", true); }
            if (receipt && /^[a-f0-9-]{36}$/.test(receipt)) {
                flow.accept(flow.token(), { operationId: receipt, counts: { records: 1 } });
                flow.begin(); flow.uncertain("A prior deletion response needs checking.");
                setStatus("A prior deletion needs checking. Read its saved result before starting another deletion.", true);
            }
        }
        update();
        if (!dialog.open) dialog.showModal();
        $("deleteCancel").focus();
    }
    form.addEventListener("submit", preview);
    for (const id of ["deleteAll", "deleteRange", "deleteFrom", "deleteTo"]) $(id).addEventListener("input", () => { edited(); update(); });
    $("deleteConfirm").addEventListener("click", confirm);
    $("deleteCheck").addEventListener("click", check);
    $("deleteChangeScope").addEventListener("click", () => { edited(); update(); $("deleteRange").focus(); });
    $("deleteCancel").addEventListener("click", () => dialog.close());
    dialog.addEventListener("cancel", event => { if (flow.snapshot().phase === "pending") event.preventDefault(); });
    dialog.addEventListener("keydown", event => {
        if (event.key !== "Tab") return;
        const controls = [...dialog.querySelectorAll("button,input,a[href],summary")].filter(node => !node.disabled && !node.closest("[inert]") && node.checkVisibility());
        if (!controls.length) { event.preventDefault(); $("deleteStatus").focus(); return; }
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || !controls.includes(document.activeElement))) {
            event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !controls.includes(document.activeElement))) {
            event.preventDefault(); first.focus();
        }
    });
    dialog.addEventListener("close", () => {
        const previous = flow.snapshot();
        if (!["pending", "uncertain"].includes(previous.phase)) { flow.edit(scope()); cancelPreview(previous); }
        if (trigger?.isConnected) ux.restoreFocus(trigger);
    });
    $("deleteActivity").addEventListener("click", open);
    $("deleteWarningIcon").append(ux.icon("warning"));
    return { open, isOpen: () => dialog.open,
        invalidate() {
            if (flow.snapshot().phase === "preview") {
                edited(); update();
                setStatus("The connection or display time zone changed. Preview again before confirming.", true);
            }
        },
    };
}
