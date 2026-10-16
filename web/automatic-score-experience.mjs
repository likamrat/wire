export function createAutomaticScoreExperience({ root, api, ux, mountRow, mountApproval, createClient, refresh, onChanged, onNotice, onStatus, formatTimestamp }) {
    const client = createClient({ api, storage: {
        getItem: key => sessionStorage.getItem(key),
        setItem: (key, value) => sessionStorage.setItem(key, value),
        removeItem: key => sessionStorage.removeItem(key),
    } });
    const modal = document.createElement("dialog");
    let dialog = modal;
    dialog.className = "assessment-dialog automatic-score-dialog";
    document.body.append(dialog);
    let current = null, view = null, scopeStamp = null, generation = 0, observing = null, trigger = null, stopping = false;
    const isOpen = () => dialog === modal ? dialog.open : dialog.isConnected && !dialog.hidden;
    function closeView() {
        if (dialog === modal) dialog.close();
        else {
            dialog.hidden = true;
            if (trigger?.isConnected && trigger.checkVisibility()) ux.restoreFocus(trigger);
        }
    }
    const stopKey = "wire.automaticScore.stop";
    let stopReceipt = null, stopStorageWarning = false;
    try {
        const value = sessionStorage.getItem(stopKey);
        if (value) {
            const parsed = JSON.parse(value);
            if (!/^mutation-[a-f0-9]{32}$/.test(parsed.mutationRef ?? "") || !/^[a-f0-9]{64}$/.test(parsed.receiptToken ?? "")) throw new Error("Invalid stop receipt.");
            stopReceipt = parsed;
        }
    } catch { stopStorageWarning = true; }
    function el(tag, text, cls) {
        const node = document.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (cls) node.className = cls;
        return node;
    }
    function button(text, action, cls = "quiet") {
        const node = el("button", text, cls);
        node.type = "button"; node.addEventListener("click", action);
        return node;
    }
    const reasons = {
        "not-approved": "", revoked: "", processed: "",
        eligible: "Waiting for the next normal check.", "final-reply-not-recorded": "No final reply recorded yet.",
        "no-eligible-evidence": "No eligible completed interaction yet.",
        "source-changed": "Review the approved source.", "method-changed": "Review the scoring method.",
        "collection-paused": "Collection is paused.", "cleanup-pending": "Cleanup must finish.",
        "in-progress": "", "another-assessment-in-progress": "An earlier assessment is finishing.",
        "unknown-billing": "An earlier charge is still unknown.", "allowance-used": "Allowance used.",
        "session-credit-minimum": "Scoring paused: Copilot needs at least 30 AI credits remaining. No automatic top-up.",
        "unresolved-attempt": "An interrupted assessment needs review; it will not be repeated.",
        "evaluation-failed": "The evaluator could not finish.", "evaluation-error": "Scoring needs attention.", stopping: "Stopping and clearing scores.",
    };
    const row = mountRow(root, { onReview: from => open(from) });
    const stop = button("Stop automatic scores", from => reviewStop(from.currentTarget), "danger");
    root.querySelector(".settings-automatic-actions").append(stop);
    const stamp = data => JSON.stringify([data.source, data.method, data.approvalRevision]);
    function renderRow() {
        const pending = client.snapshot();
        const snapshot = current?.snapshot;
        onStatus?.(pending.receipt || pending.storageBlocked ? { state: "paused", reason: pending.message || "Check the earlier approval result. No request will be repeated." }
            : snapshot ? { state: snapshot.state, reason: reasons[snapshot.reason],
                reasonCode: stopReceipt || stopping || stopStorageWarning ? null : snapshot.reason } : null);
        if (pending.receipt || pending.storageBlocked) row.receive({
            state: "paused", reason: pending.message || "Check the earlier approval result.", busy: false,
        });
        else row.receive({
            state: snapshot?.state ?? "off", reason: snapshot?.state === "ready" && snapshot.exclusions?.length
                ? `${snapshot.exclusions.length} request${snapshot.exclusions.length === 1 ? "" : "s"} not assessed.`
                : snapshot ? reasons[snapshot.reason] ?? "Scoring needs attention." : "",
            busy: stopping,
        });
        stop.hidden = !(snapshot?.approval?.state === "enabled" || pending.receipt || pending.storageBlocked || stopReceipt || stopStorageWarning);
        stop.disabled = stopping;
    }
    async function observe() {
        if (observing) return observing;
        observing = (async () => {
            try {
                const data = await api("/api/evaluation/automatic/summary", {});
                if (data.schemaVersion !== 1 || !data.snapshot || !Object.hasOwn(reasons, data.snapshot.reason)) throw new Error("Automatic-score status is unavailable.");
                if (isOpen() && scopeStamp && !client.snapshot().receipt && scopeStamp !== stamp(data)) view?.invalidate("The score approval or source changed.");
                current = data; renderRow();
            } catch (error) {
                row.receive({ state: "paused", reason: error.message, busy: false });
                onStatus?.(null);
            }
        })().finally(() => { observing = null; });
        return observing;
    }
    function frame(title) {
        view = null; scopeStamp = null;
        const heading = el("h2", title); heading.id = "automaticScoreDialogTitle";
        const close = button("Close", closeView), head = el("div", undefined, "dialog-head"), body = el("div", undefined, "assessment-dialog-body");
        close.setAttribute("aria-label", "Close automatic scores");
        close.replaceChildren(ux.icon("close"));
        ux.tooltip(close, "Close scores");
        head.append(heading, close); dialog.replaceChildren(head, body);
        dialog.setAttribute("aria-labelledby", heading.id);
        dialog.onclose = () => { if (trigger?.isConnected && trigger.checkVisibility()) ux.restoreFocus(trigger); };
        if (dialog !== modal) dialog.hidden = false;
        else if (!dialog.open) dialog.showModal();
        close.focus({ preventScroll: true });
        return body;
    }
    async function finish(expectedView = null, expectedBody = null) {
        if (expectedView && view === expectedView) expectedView.complete();
        if (expectedBody && dialog.contains(expectedBody) && isOpen()) closeView();
        onChanged();
        await observe();
        await refresh();
    }
    async function applyResult(result, expectedView) {
        if (["complete", "purged"].includes(result.phase)) await finish(expectedView);
        else if (result.phase === "not-started") expectedView?.rejected("No approval was saved. Review the current scope before trying again.");
        else expectedView?.uncertain("The original approval is still pending.");
        renderRow();
    }
    async function submit(packet) {
        const submittedView = view;
        try { await applyResult(await client.submit("approve", packet), submittedView); }
        catch (error) {
            if (error.code === "approval_superseded") return;
            if (client.snapshot().phase === "not-started" || error.code === "request_rejected") submittedView?.rejected(error.message);
            else if (client.snapshot().phase === "complete") onNotice("Approval is saved, but this view could not refresh. Use Retry; do not approve again.");
            else submittedView?.uncertain(error.message);
            renderRow();
        }
    }
    async function checkApproval() {
        const checkedView = view;
        checkedView?.pending();
        try { await applyResult(await client.check(), checkedView); }
        catch (error) { if (error.code !== "approval_superseded") checkedView?.uncertain(error.message); renderRow(); }
    }
    async function open(from) {
        ux.hideTooltip?.();
        trigger = from;
        if (dialog !== modal) dialog.remove();
        const inlineHost = from?.closest("#requestContent") ? from.closest(".interaction-insights") : null;
        dialog = inlineHost ? el("section", undefined, "assessment-inline automatic-score-dialog") : modal;
        if (inlineHost) inlineHost.append(dialog);
        const opened = ++generation, body = frame("Automatic scores");
        const isCurrent = () => opened === generation && isOpen() && dialog.contains(body);
        if (stopReceipt || stopping) {
            body.append(el("p", "Read the earlier stop result before approving scores again."),
                button("Check stop result", () => checkStop(body)));
            return;
        }
        const receipt = client.snapshot();
        if (receipt.receipt || receipt.storageBlocked) {
            body.append(el("p", receipt.message || "Read the earlier approval result. Nothing will be repeated."));
            if (receipt.receipt) body.append(button("Check approval result", async () => {
                try {
                    await checkApproval();
                    if (isOpen() && !client.snapshot().receipt) {
                        body.replaceChildren(el("p", client.snapshot().message || "The earlier result is known. Close and review the current scope."));
                        dialog.querySelector(".dialog-head button")?.focus();
                    }
                } catch (error) { body.append(el("p", error.message, "error")); }
            }));
            body.append(button("Stop automatic scores", () => reviewStop(from), "danger"));
            return;
        }
        body.append(el("p", "Reading the approved source and chat scope..."));
        try {
            const setup = await client.setup();
            if (!isCurrent()) return;
            if (!setup.source) {
                body.replaceChildren(el("p", "Connect a supported local Copilot source before setting up automatic scores."));
                return;
            }
            const previous = setup.snapshot?.approval;
            if (previous?.state === "enabled" && (previous.sourceConfigRef !== setup.source.sourceConfigRef
                || previous.sourceConfigRevision !== setup.source.sourceConfigRevision
                || Object.keys(setup.method).some(key => previous.method[key] !== setup.method[key]))) {
                body.replaceChildren(el("p", "The source or scoring method changed. Stop the previous scope before approving a new one."),
                    button("Stop automatic scores", () => reviewStop(from), "danger"));
                return;
            }
            scopeStamp = stamp(setup);
            setup.chats = setup.chats.map(chat => ({ ...chat, description: [
                `${chat.requestGroups} request${chat.requestGroups === 1 ? "" : "s"}`,
                chat.latestAt ? formatTimestamp(chat.latestAt) : "Date unavailable", `Chat ${chat.shortId}`,
            ].join(" - ") }));
            view = mountApproval(dialog, {
                setup, ux, inline: dialog !== modal, onSubmit: submit, onCheck: checkApproval,
                onClose: () => { view = null; scopeStamp = null; },
            });
            view.open(from);
        } catch (error) { if (isCurrent()) body.replaceChildren(el("p", error.message, "error")); }
    }
    function clearStopReceipt() {
        stopReceipt = null;
        try { sessionStorage.removeItem(stopKey); stopStorageWarning = false; }
        catch { stopStorageWarning = true; onNotice("Scoring stopped, but this panel could not clear its stop receipt. Read current status before another change."); }
    }
    async function checkStop(body) {
        if (!stopReceipt) {
            await observe();
            body.append(el("p", current?.snapshot?.state === "off" ? "Automatic scoring is off." : "Stop is not confirmed. Read current status before another change."));
            return;
        }
        try {
            const result = await api("/api/evaluation/automatic/status", { schemaVersion: 1, ...stopReceipt });
            if (result.mutationRef !== stopReceipt.mutationRef) throw new Error("The stop receipt does not match.");
            if (result.phase === "complete") { client.confirmStopped(result); clearStopReceipt(); await finish(null, body); }
            else if (result.phase === "not-started") {
                clearStopReceipt();
                body.append(el("p", "No stop was recorded. Close and confirm Stop again if you still want to stop scoring."));
            }
            else body.append(el("p", "The original stop is not complete. No stop request was repeated."));
        } catch (error) { body.append(el("p", error.message, "error")); }
    }
    function reviewStop(from) {
        generation++;
        ux.hideTooltip?.();
        trigger = from;
        const body = frame("Stop automatic scores");
        if (stopReceipt) {
            body.append(el("p", "An earlier stop needs checking. It will not be repeated."), button("Check stop result", () => checkStop(body)));
            return;
        }
        body.append(el("p", "Stop new scoring and remove current automatic model assessments. Recorded activity, locally saved replies and frozen reports stay unchanged."),
            el("p", "An already submitted assessment may still be charged."));
        const confirm = button("Stop and remove scores", async () => {
            const bytes = [...crypto.getRandomValues(new Uint8Array(48))].map(value => value.toString(16).padStart(2, "0")).join("");
            stopReceipt = { mutationRef: "mutation-" + bytes.slice(0, 32), receiptToken: bytes.slice(32) };
            try { sessionStorage.setItem(stopKey, JSON.stringify(stopReceipt)); }
            catch { stopStorageWarning = true; }
            stopping = true; confirm.disabled = true; renderRow();
            let stopConfirmed = false;
            const status = el("p", "Stopping and waiting for owned cleanup..."); status.setAttribute("role", "status"); body.append(status);
            try {
                const result = await api("/api/evaluation/automatic/revoke", { schemaVersion: 1, confirmed: true, ...stopReceipt });
                if (result.mutationRef !== stopReceipt.mutationRef || result.phase !== "complete") throw new Error("Stop completion is not confirmed.");
                client.confirmStopped(result);
                stopConfirmed = true;
                clearStopReceipt(); await finish(null, body);
            } catch (error) {
                if (stopConfirmed) onNotice("Scoring stopped, but this view could not refresh. Use Retry.");
                else if (error.code === "request_rejected") {
                    clearStopReceipt(); confirm.disabled = false;
                    status.textContent = error.message + " Stop was not sent. Review and confirm again.";
                } else {
                    status.textContent = error.message + " Check the original stop result; do not repeat it.";
                    body.append(button("Check stop result", () => checkStop(body)));
                }
            } finally { stopping = false; await observe(); renderRow(); }
        }, "danger");
        body.append(confirm, button("Cancel", closeView));
    }
    renderRow();
    return {
        observe, open, isOpen,
        isOpenIn: host => isOpen() && host.contains(dialog),
        invalidatePendingViewReads() { generation++; },
        invalidate(message) { view?.invalidate(message); },
        leave() {
            generation++;
            if (dialog === modal && dialog.open) dialog.close();
            if (dialog !== modal) dialog.remove();
            dialog = modal; dialog.replaceChildren();
            view = null; scopeStamp = null;
        },
    };
}
