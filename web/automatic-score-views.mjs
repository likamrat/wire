// Serialized views. The owning client retains mutation receipts and performs transport.
export function mountAutomaticScoresRow(root, { onReview }) {
    const doc = root.ownerDocument;
    const section = doc.createElement("section");
    section.className = "settings-automatic-row";
    const title = doc.createElement("h3"), status = doc.createElement("p"), review = doc.createElement("button");
    title.id = "automaticScoresTitle";
    title.tabIndex = -1;
    title.textContent = "Automatic scores";
    status.id = "automaticScoreState";
    review.id = "automaticScoreReview";
    review.setAttribute("aria-describedby", status.id);
    section.setAttribute("aria-labelledby", title.id);
    status.setAttribute("role", "status");
    review.type = "button";
    review.addEventListener("click", event => onReview(event.currentTarget));
    const actions = doc.createElement("div");
    actions.className = "settings-automatic-actions";
    actions.append(review);
    section.append(title, status, actions);
    root.replaceChildren(section);
    const labels = {
        off: "Off", waiting: "Waiting", assessing: "Assessing approved chats",
        ready: "Ready", paused: "Paused",
    };
    function receive(value) {
        if (!value || !Object.hasOwn(labels, value.state) || typeof value.reason !== "string"
            || typeof value.busy !== "boolean") throw new TypeError("Invalid automatic-score status.");
        status.textContent = labels[value.state] + (value.reason ? ` - ${value.reason}` : "");
        review.textContent = value.state === "off" ? "Set up automatic scores" : "Review automatic scores";
        review.disabled = value.busy;
        section.dataset.scoringState = value.state;
    }
    receive({ state: "off", reason: "", busy: false });
    return { receive, focus: () => review.focus() };
}

export function mountAutomaticScoresApproval(dialog, { setup, onSubmit, onCheck, onClose, ux }) {
    const doc = dialog.ownerDocument;
    if (!setup || !Number.isSafeInteger(setup.sourceRevision) || !Number.isSafeInteger(setup.approvalRevision)
        || !setup.source || !Number.isSafeInteger(setup.source.windowDays) || !Array.isArray(setup.chats)
        || !setup.method || setup.method.provider !== "github-copilot" || typeof setup.method.model !== "string"
        || typeof setup.method.rubricId !== "string" || !Number.isSafeInteger(setup.method.rubricVersion)
        || !Number.isFinite(setup.minimumSessionAiCredits) || setup.minimumSessionAiCredits <= 0) {
        throw new TypeError("Automatic-score approval needs a current source and scoring method.");
    }
    const scope = structuredClone(setup);
    let trigger, packet = null, pending = false, unknown = false, stale = false, closed = false;
    function el(tag, text, cls) {
        const node = doc.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (cls) node.className = cls;
        return node;
    }
    function button(text, action, cls = "quiet") {
        const node = el("button", text, cls);
        node.type = "button";
        node.addEventListener("click", action);
        return node;
    }
    const title = el("h2", "Automatic scores");
    title.id = "automaticScoreApprovalTitle";
    const close = button("Close", () => dialog.close());
    const head = el("div", undefined, "dialog-head"), body = el("div", undefined, "assessment-dialog-body");
    head.append(title, close);
    dialog.classList.add("assessment-dialog", "automatic-score-dialog");
    dialog.setAttribute("aria-labelledby", title.id);
    const destination = el("p", `GitHub Copilot - ${scope.method.model}`);
    const purpose = el("p", "AI reviews the answer, its support, and whether tool use matched the request; not permission.");
    const summary = el("p", scope.interactionRefs
        ? `Only the ${scope.interactionRefs.length} fixed retained requests under review, within the ${scope.source.windowDays}-day window. New requests are not included.`
        : `Existing and new completed requests in the chats you approve, within the ${scope.source.windowDays}-day collection window.`);
    const form = el("form"), chats = el("fieldset"), legend = el("legend", "Choose chats (up to 6)");
    const choices = [];
    chats.className = "automatic-score-chats";
    chats.append(legend);
    for (const chat of scope.chats) {
        if (typeof chat.chatRef !== "string" || typeof chat.name !== "string" || !Number.isSafeInteger(chat.outsideWindow)
            || chat.outsideWindow < 0) throw new TypeError("Invalid chat scope.");
        const label = el("label", undefined, "automatic-score-choice"), input = el("input"), copy = el("span", chat.name);
        input.type = "checkbox";
        input.value = chat.chatRef;
        input.checked = scope.snapshot?.approval?.state === "enabled" && scope.snapshot.approval.chatRefs.includes(chat.chatRef);
        if (chat.description) copy.append(el("small", chat.description, "settings-help"));
        if (chat.outsideWindow) copy.append(el("small", `${chat.outsideWindow} recorded request${chat.outsideWindow === 1 ? "" : "s"} outside the window will not be scored.`, "settings-help"));
        if (chat.deletedEvidence) copy.append(el("small", "Previously deleted or pruned evidence stays excluded.", "settings-help"));
        if (chat.priorUncertain) copy.append(el("small", "An earlier uncertain assessment will not be repeated.", "settings-help"));
        label.append(input, copy); chats.append(label); choices.push(input);
    }
    const limits = el("div", undefined, "automatic-score-limits");
    const callsLabel = el("label", "Total assessment allowance"), calls = el("input");
    calls.type = "number"; calls.min = "1"; calls.max = "6"; calls.step = "1"; calls.required = true;
    calls.inputMode = "numeric"; callsLabel.append(calls);
    const creditsLabel = el("label", "Total budget (AI credits)"), credits = el("input");
    const alreadySpent = scope.snapshot?.approval?.state === "enabled" ? scope.snapshot.usage?.spentAiCredits ?? 0 : 0;
    credits.type = "number"; credits.min = String(scope.minimumSessionAiCredits + alreadySpent); credits.step = "any"; credits.required = true;
    credits.inputMode = "decimal"; creditsLabel.append(credits);
    limits.append(callsLabel, creditsLabel);
    const budgetHelp = el("p", `Up to 6 assessments, shared across these chats. Each session needs at least ${scope.minimumSessionAiCredits} AI credits remaining; WIRE pauses below that balance and never tops it up. A ${scope.minimumSessionAiCredits}-credit allowance may cover only one assessment. Charges are post-paid and the limit is soft: an in-flight call may exceed it.`, "settings-help");
    const used = el("p", "", "settings-help");
    if (scope.snapshot?.approval?.state === "enabled" && scope.snapshot.usage) {
        used.textContent = `${scope.snapshot.usage.callsReserved} assessments reserved; ${scope.snapshot.usage.spentAiCredits.toLocaleString()} AI credits observed.`
            + (scope.snapshot.usage.costUnknown ? " Other charges remain unknown; new scoring is paused." : "");
    }
    used.hidden = !used.textContent;
    const chatLimit = el("p", "Choose no more than 6 chats.", "error");
    chatLimit.hidden = true;
    const disclosure = el("details", undefined, "reading-section");
    disclosure.append(el("summary", "What is sent and retained"),
        el("p", "The model shown above receives recorded prompts, final replies, returned tool evidence and inputs sent to tools. Credentials are excluded. No request is replayed and no new source is added."),
        el("p", "Temporary evaluation text is removed after processing. Model assessments and evaluator billing are retained locally. The allowance covers evaluator spending only."),
        el("p", "This approval is separate from saving Copilot replies locally. Collection is never resumed by scoring."),
        el("p", `Scoring method: ${scope.method.rubricId}, version ${scope.method.rubricVersion}.`));
    const consentLabel = el("label", undefined, "automatic-score-choice"), consent = el("input");
    consent.type = "checkbox"; consent.required = true;
    consentLabel.append(consent, el("span", "Allow this evidence to be sent for automatic scoring within this scope and allowance."));
    const status = el("p");
    status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite"); status.tabIndex = -1; status.hidden = true;
    const actions = el("div", undefined, "assessment-control-actions"), approve = el("button", "Approve automatic scores", "primary");
    approve.type = "submit";
    const cancel = button("Cancel", () => dialog.close()), check = button("Check approval result", () => onCheck(packet));
    check.hidden = true;
    actions.append(approve, cancel, check);
    form.append(chats, chatLimit, used, limits, budgetHelp, disclosure, consentLabel, status, actions);
    body.append(purpose, destination, summary, form);
    dialog.replaceChildren(head, body);
    function render() {
        const selected = choices.filter(input => input.checked).length;
        chatLimit.hidden = selected <= 6;
        const ready = selected > 0 && selected <= 6 && calls.validity.valid && credits.validity.valid && consent.checked;
        for (const input of [...choices, calls, credits, consent]) input.disabled = pending || unknown || stale;
        approve.disabled = pending || unknown || stale || !ready;
        approve.textContent = pending ? "Saving approval..." : "Approve automatic scores";
        check.hidden = !unknown;
        check.disabled = pending;
        cancel.textContent = pending || unknown ? "Close" : "Cancel";
        form.setAttribute("aria-busy", String(pending));
    }
    function setStatus(message, alert = false) {
        status.textContent = message; status.hidden = !message;
        status.setAttribute("role", alert ? "alert" : "status");
        render();
    }
    form.addEventListener("input", render);
    form.addEventListener("change", render);
    form.addEventListener("submit", event => {
        event.preventDefault();
        if (pending || unknown || approve.disabled || !form.reportValidity()) return;
        const random = [...crypto.getRandomValues(new Uint8Array(48))].map(value => value.toString(16).padStart(2, "0")).join("");
        packet = {
            schemaVersion: 1, mutationRef: "mutation-" + random.slice(0, 32), receiptToken: random.slice(32),
            expectedSourceRevision: scope.sourceRevision, expectedApprovalRevision: scope.approvalRevision,
            source: structuredClone(scope.source), method: structuredClone(scope.method),
            chatRefs: choices.filter(input => input.checked).map(input => input.value),
            interactionRefs: scope.interactionRefs ?? null,
            maxCalls: calls.valueAsNumber, maxAiCredits: credits.valueAsNumber,
            evidenceCategories: ["prompt", "answer", "references", "intent"], confirmed: true,
        };
        pending = true;
        setStatus("Saving your approval. Closing this dialog does not cancel an accepted approval.");
        onSubmit(structuredClone(packet));
    });
    dialog.onclose = () => {
        if (dialog.open || closed) return;
        closed = true;
        onClose?.();
        if (trigger?.isConnected && trigger.checkVisibility()) ux.restoreFocus(trigger);
    };
    render();
    return {
        open(from) { trigger = from; dialog.showModal(); close.focus(); },
        pending() { pending = true; render(); },
        rejected(message) { pending = false; unknown = false; packet = null; consent.checked = false; setStatus(message, true); },
        uncertain(message) { pending = false; unknown = true; setStatus(message + " Check the original result; no approval will be repeated.", true); },
        invalidate(message) {
            if (packet) { pending = false; unknown = true; }
            else { stale = true; consent.checked = false; }
            setStatus(message + " Close and review the current scope before making another change.", true);
        },
        complete() { pending = false; unknown = false; dialog.close(); },
    };
}

export const automaticScoreStyles = `
.settings-automatic-row {padding-block:var(--space-xl);margin-top:var(--space-xl);border-top:1px solid var(--rule)}
.settings-automatic-row>h3 {font-size:var(--type-reading);line-height:var(--leading-ui);font-weight:var(--weight-strong)}
.settings-automatic-row>p {margin-block:var(--space-sm)}
.settings-automatic-row>button {min-height:44px}
.assessment-heading-actions {display:flex;flex-wrap:wrap;gap:var(--space-sm);min-width:0}
.assessment-heading-actions>button {max-width:100%}
.automatic-score-chats {border:0;padding:0;min-width:0}
.automatic-score-dialog label.automatic-score-choice {display:flex;flex-direction:row;align-items:center;gap:var(--space-sm);min-height:44px;margin-block:var(--space-sm)}
.automatic-score-choice>input {width:auto;flex:none;min-height:0;margin:0}
.automatic-score-choice>span {min-width:0;overflow-wrap:anywhere}
.automatic-score-choice small {display:block}
.automatic-score-limits {display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:var(--space-lg)}
.automatic-score-limits label,.automatic-score-limits input {min-width:0;max-width:100%}
@media(max-width:480px) {
 .automatic-score-limits {grid-template-columns:1fr;gap:0}
 .automatic-score-dialog>.dialog-head {display:grid;grid-template-columns:minmax(0,1fr)}
 .automatic-score-dialog>.dialog-head h2 {grid-row:2}
 .automatic-score-dialog>.dialog-head button {grid-row:1;justify-self:end}
}
`;
