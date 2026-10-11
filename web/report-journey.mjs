// Serialized into the page. Presentation state only; the export controller owns every privacy gate.
export function createReportJourney({ root, cancelReview, clearSelection, chooseRequests, showSourceIssues, downloadFile, openSavedReport, onStateChange } = {}) {
    const labels = ["Setup", "Review", "Save locally"];
    const questions = ["Set up your report", "Review your report", "Save your reviewed report"];
    const modes = { none: "No prompts", masked: "Masked prompts", original: "Original prompts" };
    let step = 1, reached = 1, phase = "draft", preview, bundle, failure = "";
    let model = { requestCount: 0, scope: "selected", scopeReady: false, scopeIssue: "", promptMode: "masked", formats: ["html"], timeLabel: "", entry: null };
    let nodes;
    const positions = new Map();
    const suspendedControls = new Map();
    function rememberStep() {
        if (!nodes) return;
        const panel = nodes.panels[step - 1], focus = root.ownerDocument.activeElement;
        if (!panel.contains(focus)) return;
        positions.set(step, { focus, top: focus.getBoundingClientRect().top, previewId: preview?.previewId,
            scrollers: [...panel.querySelectorAll("*")].filter(node => node.scrollLeft || node.scrollTop)
                .map(node => ({ node, left: node.scrollLeft, top: node.scrollTop })) });
    }
    const snapshot = () => ({ step, reached, phase, hasPreview: Boolean(preview), completed: Boolean(bundle), ...structuredClone(model) });
    const ready = () => model.scopeReady && model.requestCount > 0;
    const formatNames = () => model.formats.map(value => value === "markdown" ? "Markdown" : value.toUpperCase()).join(", ");
    const isWriting = () => phase === "writing";
    function reason(target) {
        if (isWriting()) return "Wait for the current local save to finish.";
        if (target === 1) return "";
        if (target === 3 && phase === "saved") return "";
        if (!ready()) return model.scopeIssue || "Choose at least one readable request in Setup.";
        if (!preview) return model.formats.length ? "Choose the report contents, then scan and preview in Setup." : "Choose at least one format in Setup.";
        if (target === 2) return "";
        return ["reviewed", "saved"].includes(phase) ? "" : "Review the actual report and explicitly approve disclosure in Review.";
    }
    function text(node, value) {
        if (node && node.textContent !== value) node.textContent = value;
    }
    function paint(focus = false, reading = null) {
        onStateChange?.();
        if (!nodes) return;
        root.dataset.reportStep = String(step);
        root.dataset.reportPhase = phase;
        nodes.panels.forEach((panel, index) => { panel.hidden = index + 1 !== step; });
        nodes.steps.forEach((control, index) => {
            const target = index + 1, blocked = reason(target);
            control.disabled = Boolean(blocked) || target > reached;
            control.setAttribute("aria-describedby", nodes.stepHints[index].id);
            text(nodes.stepHints[index], target === step ? "Current step" : blocked || (target > reached ? `Continue from step ${step}.` : target < step ? "Revisit this step" : "Ready"));
            control.dataset.visited = String(target < step && !blocked);
            if (target === step) control.setAttribute("aria-current", "step");
            else control.removeAttribute("aria-current");
        });
        text(nodes.progress, phase === "saved" ? "Report saved" : phase === "unavailable" ? "Saved report unavailable" : `Step ${step} of 3`);
        text(nodes.summary, bundle ? "Saved files use the reviewed snapshot." : model.requestCount ? `${({ selected: "Selected requests", current: "Current view", all: "All collected activity" })[model.scope]} / ${model.authorLabel ? model.authorLabel + " / " : ""}${modes[model.promptMode]} / ${formatNames() || "Choose a format"}` : "Nothing is included automatically.");
        text(nodes.context, model.entry
            ? `GitHub Copilot chat: ${model.entry.sessionName || "Copilot chat name not recorded"} / ${model.entry.projectId ? "Copilot project: " + (model.entry.projectName || "Name unavailable") : "Copilot chat without a project"}. Complete eligible groups across all retained dates and services; new groups are not added automatically.`
            : "");
        nodes.context.hidden = !nodes.context.textContent;
        text(nodes.gap, ready() ? "" : model.scopeIssue || (model.entry ? "No readable requests in this Copilot chat. Return to the chat or check source issues." : "Choose at least one readable interaction in Analyze, or use another scope above."));
        nodes.gap.hidden = ready();
        nodes.issues.hidden = ready() || !model.entry || !showSourceIssues;
        text(nodes.choose, model.entry ? "Back to Copilot chat" : "Choose interactions in Analyze");
        nodes.choose.hidden = ready();
        nodes.choose.classList.toggle("primary", !ready());
        nodes.backButtons.forEach(control => {
            control.disabled = isWriting();
            if (control.dataset.target === "2") text(control, preview ? "Back to review" : "Back to setup");
        });
        const returnToSave = nodes.reviewActions.querySelector("#reportReturnToSave");
        if (returnToSave) returnToSave.hidden = phase !== "reviewed";
        if (nodes.reviewControl) nodes.reviewControl.hidden = phase === "reviewed";
        text(nodes.scan, preview ? "Return to review" : "Scan and preview");
        nodes.error.hidden = !failure;
        text(nodes.error, failure);
        if (nodes.feedback) nodes.feedback.hidden = Boolean(failure);
        nodes.reviewHost.setAttribute("aria-busy", String(phase === "scanning"));
        for (const control of root.querySelectorAll("[data-review-control]")) {
            if (!model.scopeReady) {
                if (!suspendedControls.has(control)) suspendedControls.set(control, control.disabled);
                control.disabled = true;
            } else if (suspendedControls.has(control)) {
                if (preview && ["ready", "reviewed"].includes(phase)) control.disabled = suspendedControls.get(control);
                suspendedControls.delete(control);
            }
        }
        text(nodes.headings[2], phase === "saved" ? "Your report is saved" : phase === "unavailable" ? "Saved report unavailable"
            : phase === "writing" ? "Saving your report" : phase === "blocked" && step === 3 ? "Save not confirmed" : "Save your reviewed report");
        if (focus) {
            const samePreview = step < 2 || reading?.previewId === preview?.previewId;
            const prior = reading?.focus;
            const replacement = step === 2 ? nodes.reviewActions.querySelector("#reportReturnToSave") : null;
            const target = prior?.isConnected && prior.checkVisibility() && !prior.disabled ? prior
                : replacement?.checkVisibility() && !replacement.disabled ? replacement : null;
            if (reading && samePreview && target && nodes.panels[step - 1].contains(target)) {
                for (const saved of reading.scrollers) if (saved.node.isConnected) saved.node.scrollTo(saved.left, saved.top);
                target.focus({ preventScroll: true });
                root.ownerDocument.defaultView.scrollBy(0, target.getBoundingClientRect().top - reading.top);
                return;
            }
            const heading = nodes.headings[step - 1];
            heading.focus({ preventScroll: true });
            heading.scrollIntoView({ block: "nearest" });
        }
    }
    function go(target) {
        if (!Number.isInteger(target) || target < 1 || target > 3 || reason(target)) return false;
        const returning = target < step;
        rememberStep();
        if (["saved", "unavailable"].includes(phase) && target < 3) {
            bundle = undefined;
            phase = "draft";
            reached = 1;
            failure = "";
            nodes?.saveHost.replaceChildren();
            nodes?.saveActions.replaceChildren();
        }
        if (phase === "scanning" && target < 2) {
            cancelReview?.();
            phase = "draft";
            if (nodes) nodes.reviewHost.replaceChildren();
        }
        step = target;
        reached = Math.max(reached, target);
        paint(true, returning ? positions.get(target) : null);
        return true;
    }
    function invalidate(message) {
        if (isWriting() || phase === "saved" || phase === "unavailable") return;
        const hadPreview = Boolean(preview) || phase === "scanning";
        suspendedControls.clear();
        preview = undefined;
        phase = "draft";
        reached = Math.min(reached, 1);
        if (nodes) {
            for (const control of root.querySelectorAll("[data-review-control]")) {
                control.disabled = true;
                if (control.type === "checkbox") control.checked = false;
            }
            nodes.saveHost.replaceChildren();
            nodes.saveActions.replaceChildren();
        }
        if ((hadPreview || message !== undefined || failure) && step >= 2) {
            failure = message ?? "This preview is no longer current. Return to Setup and scan again before approving or saving.";
        }
        paint();
    }
    function invalidateSavedReport(bundleId) {
        if (bundle?.bundleId !== bundleId) return false;
        bundle = preview = undefined;
        phase = "unavailable";
        reached = 1;
        failure = "";
        if (nodes) {
            const message = nodes.el("p", "", "This saved report is no longer available. Its downloads have been removed. Source activity and other saved reports are unchanged.");
            message.setAttribute("role", "status");
            nodes.saveHost.replaceChildren(message, nodes.el("p", "report-saved-id", bundleId),
                nodes.button("Start a new report", () => clearSelection?.(), "primary"));
        }
        paint();
        return true;
    }
    function clear() {
        if (isWriting()) return false;
        positions.clear();
        suspendedControls.clear();
        preview = bundle = undefined;
        step = reached = 1;
        phase = "draft";
        failure = "";
        model = { ...model, requestCount: 0, scope: "selected", scopeReady: false, entry: null };
        nodes?.reviewHost.replaceChildren();
        nodes?.saveHost.replaceChildren();
        nodes?.reviewActions.replaceChildren();
        nodes?.saveActions.replaceChildren();
        paint(true);
        return true;
    }
    if (root) {
        const doc = root.ownerDocument, byId = id => doc.getElementById(id);
        function el(tag, cls, value) {
            const node = doc.createElement(tag);
            if (cls) node.className = cls;
            if (value !== undefined) node.textContent = value;
            return node;
        }
        function button(label, action, cls = "quiet") {
            const node = el("button", cls, label);
            node.type = "button";
            node.addEventListener("click", action);
            return node;
        }
        const shell = el("div", "report-journey"), nav = el("nav", "report-progress"), list = el("ol");
        shell.id = "reportCreatePanel";
        nav.setAttribute("aria-label", "Report creation steps");
        const progress = el("p", "report-progress-label"), summary = el("p", "report-choice-summary"), context = el("p", "report-entry-context");
        progress.setAttribute("role", "status");
        const steps = [], stepHints = [], panels = [], headings = [], backButtons = [];
        labels.forEach((label, index) => {
            const item = el("li"), control = button("", () => go(index + 1), "report-step");
            const number = el("span", "report-step-number", String(index + 1)), title = el("span", "", label);
            number.setAttribute("aria-hidden", "true");
            control.append(number, title);
            control.setAttribute("aria-label", `${index + 1}. ${label}`);
            const hint = el("small", "report-step-hint report-step-hint-hidden");
            hint.id = `reportStepHint${index + 1}`;
            item.append(control, hint);
            list.append(item);
            steps.push(control); stepHints.push(hint);
            const panel = el("section", "report-stage"), heading = el("h3", "", questions[index]);
            panel.id = `reportStage${index + 1}`;
            heading.id = `reportStepTitle${index + 1}`;
            heading.tabIndex = -1;
            panel.setAttribute("aria-labelledby", heading.id);
            control.setAttribute("aria-controls", panel.id);
            panel.append(heading);
            panels.push(panel); headings.push(heading);
        });
        nav.append(list);
        const existingStart = root.querySelector(".report-start");
        existingStart.firstElementChild.classList.add("report-heading-context");
        existingStart.querySelector("p").textContent = "Set up the included interactions and contents, review the actual copies, then save locally.";
        const scan = byId("exportBtn"), scanWrapper = scan.closest(".ux-disabled-help") || scan;
        const controls = root.querySelector(".report-preview-controls");
        controls.append(summary);
        shell.append(progress, nav, existingStart, context);
        const error = el("p", "notice error report-journey-error");
        error.id = "reportJourneyError";
        error.setAttribute("role", "alert");
        error.tabIndex = -1;
        shell.append(error);
        const gap = el("p", "report-scope-gap"), choose = button("Choose interactions in Analyze", () => chooseRequests?.(), "primary");
        gap.id = "reportScopeGap";
        const issues = button("View source issues", () => showSourceIssues?.(), "quiet");
        const scope = root.querySelector(".export-scope"), choices = scope.querySelector(".scope-choices");
        const selectedChoice = choices.querySelector('[value="selected"]').closest("label");
        choices.prepend(selectedChoice);
        const scopeDetails = byId("scopeDetails");
        scopeDetails.append(byId("scopeSummary"), byId("reportMatchingContext"));
        // Keep detailed units/exclusions available without making them the first task.
        for (const paragraph of [...scope.querySelectorAll(":scope > .scope-explanation")]) {
            scopeDetails.append(paragraph);
        }
        const scopeLayout = el("div", "report-scope-layout");
        const authorChoice = root.querySelector(".report-author-choice");
        scopeLayout.append(scope, authorChoice);
        panels[0].append(scopeLayout);
        const firstFooter = el("div", "report-stage-actions");
        firstFooter.append(gap, choose, issues, scanWrapper);
        panels[0].append(root.querySelector(".report-options"), byId("reportTimeContext"), firstFooter, scopeDetails, byId("reportRequests"));
        // Revisiting unchanged choices returns to the same frozen review; it never records approval.
        scan.addEventListener("click", event => {
            if (!preview) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            go(2);
        }, true);
        const reviewHost = el("div", "report-review-body"), saveHost = el("div", "report-save-body");
        reviewHost.id = "reportReviewBody";
        saveHost.id = "reportSaveBody";
        panels[1].append(reviewHost);
        panels[2].append(saveHost);
        const reviewActions = el("div", "report-next-actions"), saveActions = el("div", "report-next-actions");
        for (const [panel, label, target] of [[panels[1], "Back to setup", 1], [panels[2], "Back to review", 2]]) {
            const footer = el("div", "report-stage-actions"), back = button(label, () => go(target === 2 && !preview ? 1 : target));
            back.dataset.target = String(target);
            backButtons.push(back);
            footer.append(back, target === 1 ? reviewActions : saveActions);
            panel.append(footer);
        }
        const toolbar = root.querySelector(".report-toolbar");
        toolbar.hidden = true;
        root.insertBefore(shell, byId("savedReportsPanel"));
        shell.append(...panels);
        nodes = { panels, steps, stepHints, headings, backButtons, progress, summary, context, gap, choose, issues, scan, error, reviewHost, saveHost, reviewActions, saveActions, el, button };
        paint();
    }
    return {
        snapshot, reason, go, invalidate, clear,
        get reviewHost() { return nodes?.reviewHost; },
        get saveHost() { return nodes?.saveHost; },
        isReviewOpen: () => (Boolean(preview) || step >= 2 && phase !== "saved") && (!root || !root.hidden),
        update(patch) {
            model = { ...model, ...structuredClone(patch) };
            paint();
        },
        beginScan() {
            if (isWriting() || phase === "scanning" || !ready() || !model.formats.length) return null;
            rememberStep();
            preview = bundle = undefined;
            failure = "";
            phase = "scanning";
            step = reached = 2;
            nodes?.reviewHost.replaceChildren();
            nodes?.saveHost.replaceChildren();
            nodes?.reviewActions.replaceChildren();
            nodes?.saveActions.replaceChildren();
            paint(true);
            return nodes?.reviewHost;
        },
        previewReady(value, { confirm, feedback } = {}) {
            if (phase !== "scanning" || !value?.previewId || value.privacy?.allSelectedFieldsScanned !== true) return false;
            preview = value;
            phase = "ready";
            failure = "";
            if (nodes) {
                const body = nodes.reviewHost, { el } = nodes;
                body.querySelector(".privacy-steps")?.remove();
                const comparison = body.querySelector(".prompt-comparisons");
                if (comparison) {
                    const disclosure = el("details", "detail-disclosure report-copy-inspection");
                    const prompts = value.promptReview || [];
                    const missing = prompts.filter(prompt => prompt.status !== "full" || prompt.original === null).length;
                    const removals = prompts.reduce((total, prompt) => total + prompt.changes.length, 0);
                    disclosure.append(el("summary", "", `Inspect ${prompts.length} ${value.snapshot?.recordedContext ? "report" : "prompt"} copies / ${removals} removals / ${missing} incomplete sources`));
                    comparison.replaceWith(disclosure);
                    disclosure.append(comparison);
                    const frame = body.querySelector(".report-frame");
                    if (frame) disclosure.before(frame.parentElement);
                }
                const summary = el("dl", "report-save-summary");
                for (const [label, content] of [
                    ["Requests", `${value.records.length} request group${value.records.length === 1 ? "" : "s"} / ${model.authorLabel}`],
                    ["Prompt copies", modes[value.promptMode]],
                    ["Files", value.formats.map(format => format === "markdown" ? "Markdown" : format.toUpperCase()).join(", ")],
                ]) {
                    const row = el("div");
                    row.append(el("dt", "", label), el("dd", "", content));
                    summary.append(row);
                }
                nodes.saveHost.append(summary);
                const snapshotDetails = body.querySelector(".report-snapshot-details");
                if (snapshotDetails) nodes.saveHost.append(snapshotDetails.cloneNode(true));
                nodes.saveHost.append(el("p", "report-save-boundary", "Writes these reviewed copies to local files. Nothing is uploaded."));
                if (confirm) nodes.saveActions.append(confirm.closest(".ux-disabled-help") || confirm);
                nodes.feedback = feedback;
                const review = body.querySelector("button[data-review-control]");
                review?.classList.add("primary");
                if (review) {
                    nodes.reviewControl = review.closest(".ux-disabled-help") || review;
                    nodes.reviewActions.append(nodes.reviewControl);
                }
                body.querySelector(".dialog-actions")?.remove();
                const returnToSave = nodes.button("Continue to save", () => go(3), "primary");
                returnToSave.id = "reportReturnToSave";
                returnToSave.hidden = true;
                nodes.reviewActions.append(returnToSave);
            }
            paint(true);
            return true;
        },
        reviewed() {
            if (phase !== "ready" || !preview) return false;
            rememberStep();
            phase = "reviewed";
            step = reached = 3;
            if (nodes) {
                nodes.reviewActions.querySelector("#reportReturnToSave").hidden = false;
                nodes.reviewControl?.setAttribute("hidden", "");
                if (nodes.feedback) nodes.saveHost.append(nodes.feedback);
            }
            paint(true);
            return true;
        },
        writing(value) {
            if (value && phase === "reviewed") phase = "writing";
            else if (!value && phase === "writing") phase = "blocked";
            paint();
        },
        failed(message) {
            phase = "blocked";
            failure = message;
            preview = undefined;
            reached = Math.min(reached, 2);
            if (nodes) {
                for (const control of root.querySelectorAll("[data-review-control]")) control.disabled = true;
            }
            paint();
            nodes?.error.focus({ preventScroll: true });
            nodes?.error.scrollIntoView({ block: "nearest" });
        },
        invalidateSavedReport,
        syncPresence(entries) {
            if (bundle && !entries.some(entry => entry.bundleId === bundle.bundleId)) invalidateSavedReport(bundle.bundleId);
        },
        saved(value, { available = true } = {}) {
            if (!value?.bundleId || !value.files || !Object.keys(value.files).length) throw new Error("Saved report file links are unavailable.");
            bundle = structuredClone(value);
            const savedBundle = bundle;
            preview = undefined;
            phase = "saved";
            step = reached = 3;
            failure = "";
            if (!available) { invalidateSavedReport(value.bundleId); return; }
            if (nodes) {
                const { el, button, saveHost } = nodes;
                const message = el("p", "report-save-success", "Local files are ready. Disclosure reviewed, not a privacy certification.");
                message.setAttribute("role", "status");
                const details = el("details", "detail-disclosure");
                details.append(el("summary", "", "Saved report details"), el("p", "report-saved-id", value.bundleId));
                if (value.bundleDir) details.append(el("p", "report-saved-location", "Saved folder: " + value.bundleDir));
                saveHost.replaceChildren(message);
                if (value.files["product-report.html"] && openSavedReport) saveHost.append(button("Open saved report", event => openSavedReport(value, event.currentTarget), "primary"));
                else if (!value.files["product-report.html"]) saveHost.append(el("p", "muted", "HTML was not saved. Read one of the saved downloads below."));
                const downloads = el("div", "report-downloads");
                for (const name of Object.keys(value.files)) {
                    const control = button(`Download ${name}`, async () => {
                        control.disabled = true;
                        try { await downloadFile(value, name, () => bundle === savedBundle); }
                        catch (error) { if (bundle === savedBundle) { failure = `Download failed: ${error.message}`; paint(); } }
                        finally { control.disabled = false; }
                    });
                    downloads.append(control);
                }
                saveHost.append(downloads, details, button("Start a new report", () => clearSelection?.()));
                nodes.saveActions.replaceChildren();
                for (const control of root.querySelectorAll("[data-review-control]")) control.disabled = true;
            }
            paint(true);
        },
    };
}
