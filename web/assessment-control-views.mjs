// Emits explicit packets; transport and lifecycle stay with the main client.
export function mountConsentSetup(root, { control, sourceLabel, currentSource = null, onSubmit, onCheck, onCancel, onRender }) {
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
    const boundary = el("p", "Saves recorded Copilot replies locally, excluding detected credentials. Replies may be incomplete or not final. This does not send them to another service.");
    const form = el("form"), option = el("div", undefined, "settings-choice-row"), input = el("input");
    const copy = el("div", undefined, "settings-row-copy"), heading = el("h3");
    const label = el("label", "Save Copilot replies locally");
    const summary = el("p", "Keep recorded Copilot replies on this device. Turning this off deletes saved replies, not activity or reports.", "settings-reply-help");
    input.id = `${root.id || "optionalEvidence"}-choice`;
    summary.id = `${input.id}-help`;
    label.htmlFor = input.id;
    heading.append(label);
    copy.append(heading, summary);
    input.type = "checkbox";
    input.setAttribute("role", "switch");
    input.setAttribute("aria-describedby", `${summary.id} ${applied.id}`);
    const target = el("label", undefined, "settings-switch"), track = el("span", undefined, "select-toggle");
    track.setAttribute("aria-hidden", "true");
    target.append(input, track);
    option.append(copy, target);
    const revoke = el("p", "Turning this off stops future capture and removes saved response text and dependent retained annotations. Saved reports and ordinary recorded activity stay available.");
    const renewalImpact = el("p", "Enabling capture for this source removes prior saved response text and dependent retained annotations. Ordinary collected activity and saved reports stay available.");
    const actions = el("div", undefined, "assessment-control-actions");
    const confirm = el("button", "Save response setting"), cancel = el("button", "Discard change"), check = el("button", "Check update result");
    const revokePrior = el("button", "Remove previously saved responses", "danger");
    confirm.type = "submit"; cancel.type = check.type = revokePrior.type = "button";
    const status = el("p");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.tabIndex = -1;
    const recoverySlot = el("div", undefined, "assessment-inline-recovery");
    recoverySlot.hidden = true;
    const details = el("div", undefined, "assessment-capture-details");
    details.append(scope, boundary);
    actions.append(confirm, cancel, revokePrior, check);
    form.append(option, applied, details, revoke, renewalImpact, actions, status, recoverySlot);
    section.append(form);
    root.replaceChildren(section);
    let localError = "";
    const locked = snapshot => ["pending", "unknown", "checking", "stale"].includes(snapshot.phase);
    const currentEnabled = consent => consent?.state === "enabled" && (!currentSource || currentSource.available === true
        && consent.sourceConfigRef === currentSource.sourceConfigRef && consent.sourceConfigRevision === currentSource.sourceConfigRevision);
    function render() {
        const finishPresentation = onRender?.();
        const snapshot = control.snapshot();
        const state = snapshot.applied?.state;
        const active = currentEnabled(snapshot.applied), inactiveGrant = state === "enabled" && !active;
        const idle = snapshot.draft === null && !locked(snapshot);
        const restoreChoiceFocus = idle && [confirm, cancel].includes(doc.activeElement);
        applied.textContent = inactiveGrant ? currentSource?.available === false
            ? "Response saving is inactive because its source is unavailable."
            : "Response saving is inactive because the approved source changed."
            : state === "revoked" ? "Response saving was turned off; saved replies were removed."
            : state === "enabled" ? idle ? "" : "Response saving is on."
            : state === "off" ? idle ? "" : "Response saving is off."
                : "The response-saving state is no longer current. Reload these settings.";
        if (snapshot.draft !== null && !locked(snapshot)) applied.textContent += " This change is not saved yet.";
        applied.hidden = !applied.textContent;
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
        details.hidden = snapshot.draft?.enabled !== true;
        status.textContent = localError || (snapshot.phase === "view" ? "" : snapshot.message);
        status.hidden = !status.textContent;
        status.setAttribute("role", localError || ["error", "unknown", "stale"].includes(snapshot.phase) ? "alert" : "status");
        form.setAttribute("aria-busy", String(["pending", "checking"].includes(snapshot.phase)));
        if (restoreChoiceFocus) input.focus();
        finishPresentation?.();
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
    return { render, focus: () => input.focus(), recoveryPresentation() {
        const offered = ["unknown", "checking"].includes(control.snapshot().phase);
        const visible = node => node.checkVisibility({ visibilityProperty: true, opacityProperty: true });
        return { check, status, slot: recoverySlot, offered,
            presented: offered && root.contains(section) && check.isConnected && status.isConnected
                && Boolean(status.textContent.trim()) && visible(root) && !root.closest("[inert]")
                && (visible(check) && visible(status) || recoverySlot.childElementCount > 0 && visible(recoverySlot)),
            delegate(value) {
                check.hidden = value || !offered;
                status.hidden = value || !status.textContent;
                recoverySlot.hidden = !value;
            } };
    } };
}

export function mountPersonalFeedback() {
    throw Object.assign(new Error("Personal feedback is no longer supported."), { code: "PERSONAL_FEEDBACK_RETIRED" });
}
