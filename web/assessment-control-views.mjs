// Emits explicit packets; transport and lifecycle stay with the main client.
export function mountConsentSetup(root, { control, sourceLabel, currentSource = null, onSubmit, onCheck, onCancel }) {
    const doc = root.ownerDocument;
    function el(tag, text, cls) {
        const node = doc.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (cls) node.className = cls;
        return node;
    }
    const section = el("section");
    const applied = el("p", "", "assessment-applied"), scope = el("p", sourceLabel, "assessment-source");
    applied.id = `${root.id || "optionalEvidence"}-state`;
    applied.setAttribute("role", "status");
    const boundary = el("p", "Only assistant replies already recorded in your approved local Copilot source are saved. They may be partial, not a verified final answer. This setting does not run new queries, fetch citations or send text for model assessment.");
    const limit = el("p", "Up to 64 KiB per item, 20 items and 256 KiB per interaction. Credential-screened; incomplete text stays labeled.");
    const unsupported = el("p", "Usage and explicit authorization evidence are not supported by this source.");
    const form = el("form"), option = el("label", undefined, "settings-choice-row"), input = el("input");
    input.type = "checkbox";
    input.setAttribute("aria-describedby", applied.id);
    option.append(input, el("span", "Save Copilot replies locally"));
    const revoke = el("p", "Turning this off stops future capture and removes linked optional local evidence and unsaved insights. Saved reports and ordinary recorded activity stay available.");
    const renewalImpact = el("p", "Enabling capture for this source removes prior optional response evidence and linked unsaved insights. Ordinary collected activity and saved reports stay available.");
    const actions = el("div", undefined, "assessment-control-actions");
    const confirm = el("button", "Save response setting"), cancel = el("button", "Discard change"), check = el("button", "Check update result");
    const revokePrior = el("button", "Remove previously saved responses", "danger");
    confirm.type = "submit"; cancel.type = check.type = revokePrior.type = "button";
    const status = el("p");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.tabIndex = -1;
    const details = el("details", undefined, "assessment-capture-details");
    details.append(el("summary", "What gets saved"), scope, boundary, limit, unsupported);
    actions.append(confirm, cancel, revokePrior, check);
    form.append(option, revoke, renewalImpact, actions, status);
    section.append(applied, form, details);
    root.replaceChildren(section);
    let localError = "";
    const locked = snapshot => ["pending", "unknown", "checking", "stale"].includes(snapshot.phase);
    const currentEnabled = consent => consent?.state === "enabled" && (!currentSource || currentSource.available === true
        && consent.sourceConfigRef === currentSource.sourceConfigRef && consent.sourceConfigRevision === currentSource.sourceConfigRevision);
    function render() {
        const snapshot = control.snapshot();
        const state = snapshot.applied?.state;
        const active = currentEnabled(snapshot.applied), inactiveGrant = state === "enabled" && !active;
        const idle = snapshot.draft === null && !locked(snapshot);
        const restoreChoiceFocus = idle && [confirm, cancel].includes(doc.activeElement);
        applied.textContent = inactiveGrant ? currentSource?.available === false
            ? "Response saving is inactive because its source is unavailable."
            : "Response saving is inactive because the approved source changed."
            : state === "enabled" ? "Response saving is on."
            : ["revoked", "off"].includes(state) ? "Response saving is off."
                : "The response-saving state is no longer current. Reload these settings.";
        if (snapshot.draft !== null && !locked(snapshot)) applied.textContent += " This change is not saved yet.";
        input.checked = snapshot.draft?.enabled ?? active;
        input.disabled = locked(snapshot) || currentSource?.available === false;
        confirm.disabled = locked(snapshot) || snapshot.draft === null;
        confirm.hidden = idle;
        confirm.textContent = snapshot.phase === "pending" ? "Saving..." : snapshot.draft === null ? "Save response setting"
            : input.checked ? "Turn on response saving" : "Turn off and delete responses";
        confirm.classList.toggle("danger", snapshot.draft !== null && (snapshot.draft.enabled === false || inactiveGrant));
        check.hidden = !["unknown", "checking"].includes(snapshot.phase);
        check.disabled = snapshot.phase === "checking";
        cancel.disabled = ["pending", "checking"].includes(snapshot.phase);
        cancel.hidden = idle || ["unknown", "checking", "stale"].includes(snapshot.phase);
        revokePrior.hidden = !inactiveGrant || snapshot.draft !== null;
        revokePrior.disabled = locked(snapshot);
        revoke.hidden = state !== "enabled" || snapshot.draft?.enabled !== false;
        renewalImpact.hidden = !inactiveGrant || snapshot.draft?.enabled !== true;
        status.textContent = localError || (snapshot.phase === "view" ? "" : snapshot.message);
        status.hidden = !status.textContent;
        status.setAttribute("role", localError || ["error", "unknown", "stale"].includes(snapshot.phase) ? "alert" : "status");
        form.setAttribute("aria-busy", String(["pending", "checking"].includes(snapshot.phase)));
        if (restoreChoiceFocus) input.focus();
    }
    input.addEventListener("change", () => {
        localError = "";
        if (input.checked === currentEnabled(control.snapshot().applied)) control.cancel();
        else control.edit({ enabled: input.checked, categories: input.checked ? ["answer"] : [] });
        render();
    });
    revokePrior.addEventListener("click", () => {
        localError = "";
        control.edit({ enabled: false, categories: [] });
        render();
        confirm.focus();
    });
    form.addEventListener("submit", event => {
        event.preventDefault();
        localError = "";
        let packet;
        try {
            const random = [...crypto.getRandomValues(new Uint8Array(48))].map(value => value.toString(16).padStart(2, "0")).join("");
            packet = control.begin("mutation-" + random.slice(0, 32), random.slice(32));
        }
        catch (error) { localError = error.message; render(); status.focus(); return; }
        render();
        onSubmit(packet);
    });
    check.addEventListener("click", () => {
        const packet = control.check();
        render();
        onCheck(packet);
    });
    cancel.addEventListener("click", () => {
        if (!locked(control.snapshot())) control.cancel();
        localError = "";
        render();
        onCancel();
    });
    render();
    return { render, focus: () => input.focus() };
}

export function mountPersonalFeedback(dialog, { control, checkId, automaticLabel, onSubmit, onCheck, onClose }) {
    const doc = dialog.ownerDocument;
    const labels = {
        "semantic-answer-correctness": { title: "Answer correctness", pass: "Correct", fail: "Not correct" },
        "answer-support-validity": { title: "Answer support", pass: "Supported", fail: "Not supported" },
        "action-authorization-compliance": { title: "Action authorization", pass: "Authorized", fail: "Not authorized" },
    };
    const wording = labels[checkId];
    if (!wording) throw new TypeError("Feedback is only available for the supported personal verdicts.");
    function el(tag, text) {
        const node = doc.createElement(tag);
        if (text !== undefined) node.textContent = text;
        return node;
    }
    const title = el("h2", "Your feedback: " + wording.title.toLowerCase());
    title.id = `feedback-title-${checkId}`;
    dialog.setAttribute("aria-labelledby", title.id);
    const note = el("p", "Optional personal feedback. This does not change the recorded request, response or tool outcomes.");
    const automatic = el("p", "Automatic check: " + automaticLabel), saved = el("p");
    const form = el("form"), label = el("label", "Your assessment"), select = el("select");
    for (const [value, text] of [["", "Choose a verdict"], ["pass", wording.pass], ["fail", wording.fail], ["unassessed", "Not sure"]]) {
        const option = el("option", text);
        option.value = value;
        select.append(option);
    }
    label.append(select);
    const actions = el("div");
    actions.className = "assessment-control-actions";
    const save = el("button", "Save feedback"), cancel = el("button", "Cancel"), withdraw = el("button", "Withdraw feedback"), check = el("button", "Check update result");
    save.type = "submit"; cancel.type = withdraw.type = check.type = "button";
    const status = el("p");
    status.setAttribute("aria-live", "polite"); status.tabIndex = -1;
    actions.append(save, withdraw, check);
    form.append(label, actions, status);
    const header = el("div"); header.className = "dialog-head";
    header.append(title, cancel);
    const body = el("div"); body.className = "assessment-dialog-body";
    body.append(note, automatic, saved, form);
    dialog.replaceChildren(header, body);
    let trigger, localError = "";
    const locked = snapshot => ["pending", "unknown", "checking", "stale"].includes(snapshot.phase);
    function render() {
        const snapshot = control.snapshot(), prior = snapshot.applied;
        select.value = snapshot.draft?.withdraw ? "" : snapshot.draft?.verdict ?? "";
        select.disabled = locked(snapshot);
        save.disabled = locked(snapshot) || snapshot.draft === null;
        save.textContent = snapshot.phase === "pending" ? "Saving feedback..." : "Save feedback";
        cancel.disabled = false;
        cancel.textContent = locked(snapshot) ? "Close" : "Cancel";
        withdraw.hidden = !prior || prior.withdrawn;
        withdraw.disabled = locked(snapshot);
        check.hidden = !["unknown", "checking"].includes(snapshot.phase);
        check.disabled = snapshot.phase === "checking";
        saved.textContent = snapshot.phase === "stale" ? "Feedback must be reloaded for the current evidence."
            : prior ? prior.withdrawn ? "Your previous feedback was withdrawn."
            : `Saved feedback: ${prior.verdict === "pass" ? wording.pass : prior.verdict === "fail" ? wording.fail : "Not sure"} (revision ${prior.revision}).`
            : "No active personal feedback.";
        status.textContent = localError || snapshot.message + (["pending", "checking", "unknown"].includes(snapshot.phase)
            ? " Closing this panel does not cancel the update. Its result can be checked without sending it again." : "");
        status.hidden = !status.textContent;
        status.setAttribute("role", localError || ["error", "unknown", "stale"].includes(snapshot.phase) ? "alert" : "status");
        form.setAttribute("aria-busy", String(["pending", "checking"].includes(snapshot.phase)));
    }
    function submit() {
        let packet;
        try {
            const random = [...crypto.getRandomValues(new Uint8Array(48))].map(value => value.toString(16).padStart(2, "0")).join("");
            packet = control.begin("mutation-" + random.slice(0, 32), random.slice(32));
        }
        catch (error) { localError = error.message; render(); status.focus(); return; }
        render();
        onSubmit(packet);
    }
    select.addEventListener("change", () => {
        localError = "";
        if (select.value) control.edit({ verdict: select.value, withdraw: false });
        else control.cancel();
        render();
    });
    form.addEventListener("submit", event => { event.preventDefault(); submit(); });
    withdraw.addEventListener("click", () => { control.edit({ verdict: "unassessed", withdraw: true }); submit(); });
    check.addEventListener("click", () => {
        const packet = control.check();
        render();
        onCheck(packet);
    });
    cancel.addEventListener("click", () => {
        if (!locked(control.snapshot())) control.cancel();
        dialog.close();
    });
    dialog.oncancel = () => {
        if (!locked(control.snapshot())) control.cancel();
    };
    dialog.onclose = () => {
        if (dialog.open) return;
        onClose?.();
        if (trigger?.isConnected && trigger.checkVisibility() && (!trigger.closest("dialog") || trigger.closest("dialog").open)) trigger.focus({ preventScroll: true });
    };
    render();
    return {
        render,
        open(button) { trigger = button; render(); dialog.showModal(); cancel.focus(); },
    };
}
