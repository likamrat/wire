// Prepared copies alone permit parent measurement; saved readers keep their opaque sandbox.
export function createPreparedReportFrame(html, frozenFrame, { onError, doc = document } = {}) {
    if (typeof frozenFrame !== "function" || typeof onError !== "function") throw new TypeError("Prepared reports require sanitization and an error handler.");
    const frame = frozenFrame(html, doc), view = doc.defaultView;
    frame.title = "Prepared report";
    frame.setAttribute("sandbox", "allow-same-origin");
    frame.style.height = "1px";
    let active = true, source, scheduled = 0, lastWidth = -1, selfResizes = 0;
    const bodySize = new view.ResizeObserver(schedule);
    const frameSize = new view.ResizeObserver(() => {
        if (frame.clientWidth !== lastWidth) { lastWidth = frame.clientWidth; refresh(); }
    });
    const textSize = new view.MutationObserver(refresh);
    const removal = new view.MutationObserver(changes => {
        if (!frame.isConnected && changes.some(change => [...change.removedNodes].some(node => node === frame || node.contains?.(frame)))) dispose();
    });
    function current() { return active && frame.isConnected && source === frame.contentDocument; }
    function schedule() {
        if (!active || scheduled) return;
        scheduled = view.requestAnimationFrame(measure);
    }
    function refresh() { selfResizes = 0; schedule(); }
    function measure() {
        scheduled = 0;
        if (!current() || !frame.checkVisibility()) return;
        const fontSize = view.getComputedStyle(doc.documentElement).fontSize;
        if (source.documentElement.style.fontSize !== fontSize) source.documentElement.style.fontSize = fontSize;
        const body = source.body, style = frame.contentWindow.getComputedStyle(body);
        const frameStyle = view.getComputedStyle(frame);
        const edges = frameStyle.boxSizing === "border-box"
            ? ["borderTopWidth", "borderBottomWidth", "paddingTop", "paddingBottom"].reduce((sum, key) => sum + (parseFloat(frameStyle[key]) || 0), 0) : 0;
        const height = Math.ceil(Math.max(body.scrollHeight, body.getBoundingClientRect().height)
            + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0) + edges);
        if (Math.abs(parseFloat(frame.style.height) - height) <= 1) { selfResizes = 0; return; }
        // Viewport-relative content can otherwise grow its own viewport indefinitely.
        if (++selfResizes > 8) {
            dispose();
            onError("The prepared report layout did not settle. Prepare the report again.");
            return;
        }
        frame.style.height = height + "px";
    }
    function navigate(event) {
        const link = event.target.closest?.("a[href]");
        if (!link || !current()) return;
        event.preventDefault();
        const id = link.getAttribute("href").split("#")[1];
        const target = id && source.getElementById(id);
        if (!target) return;
        for (let parent = target.parentElement; parent; parent = parent.parentElement) if (parent.localName === "details") parent.open = true;
        measure();
        const toolbar = frame.closest(".report-review-body")?.querySelector(".report-inspection-tabs");
        const offset = (toolbar?.getBoundingClientRect().bottom ?? parseFloat(view.getComputedStyle(doc.documentElement).scrollPaddingTop)) || 0;
        const top = view.scrollY + frame.getBoundingClientRect().top + target.getBoundingClientRect().top - offset - 12;
        if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
        target.focus({ preventScroll: true });
        view.scrollTo({ top });
    }
    function loaded() {
        if (!active || !frame.isConnected) return;
        source = frame.contentDocument;
        if (!source?.body) {
            dispose();
            onError("The prepared report could not be displayed. Prepare a new preview.");
            return;
        }
        source.addEventListener("click", navigate);
        source.addEventListener("toggle", refresh, true);
        source.fonts.addEventListener("loadingdone", refresh);
        bodySize.observe(source.body);
        source.fonts.ready.then(refresh);
        schedule();
    }
    function dispose() {
        if (!active) return;
        active = false;
        view.cancelAnimationFrame(scheduled);
        bodySize.disconnect(); frameSize.disconnect(); textSize.disconnect(); removal.disconnect();
        frame.removeEventListener("load", loaded);
        source?.removeEventListener("click", navigate);
        source?.removeEventListener("toggle", refresh, true);
        source?.fonts.removeEventListener("loadingdone", refresh);
        source = undefined;
        frame.srcdoc = "";
        frame.remove();
    }
    frame.addEventListener("load", loaded);
    frameSize.observe(frame);
    textSize.observe(doc.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
    textSize.observe(doc.head, { childList: true, subtree: true, characterData: true });
    removal.observe(doc.body, { childList: true, subtree: true });
    return { frame, dispose };
}

// Serialized into the page. Presentation state only; the export controller owns every privacy gate.
export function createReportJourney({ root, cancelReview, clearSelection, readCurrent, showSourceIssues, downloadFile, openSavedReport, icon, utility, onStateChange, presentStep, requestStep } = {}) {
    const labels = ["Activity", "Contents", "Review & save"];
    const questions = ["Activity to include", "Choose contents", "Review and save your report"];
    const number = new Intl.NumberFormat();
    let step = 1, reached = 1, phase = "draft", preview, bundle, failure = "";
    let saveUnconfirmed = false, contentsPresented = false;
    let model = { requestCount: 0, scope: "selected", scopeReady: false, scopeIssue: "", promptMode: "masked", formats: ["html"], timeLabel: "", entry: null };
    let nodes;
    const positions = new Map();
    const suspendedControls = new Map();
    function rememberStep() {
        if (!nodes || step === 2 && presentStep) return;
        const panel = nodes.panels[step - 1], focus = root.ownerDocument.activeElement;
        if (!panel.contains(focus)) return;
        positions.set(step, { focus, top: focus.getBoundingClientRect().top, previewId: preview?.previewId,
            scrollers: [...panel.querySelectorAll("*")].filter(node => node.scrollLeft || node.scrollTop)
                .map(node => ({ node, left: node.scrollLeft, top: node.scrollTop })) });
    }
    const snapshot = () => ({ step, reached, phase, saveUnconfirmed, hasPreview: Boolean(preview), completed: Boolean(bundle), ...structuredClone(model) });
    const ready = () => model.scopeReady && model.requestCount > 0;
    const isWriting = () => phase === "writing";
    function reason(target) {
        if (isWriting()) return "Wait for the current local save to finish.";
        if (saveUnconfirmed) return "Check save status before preparing another report. The local write may have completed.";
        if (target === 1) return "";
        if (target === 3 && phase === "saved") return "";
        if (target === 2 && reached >= 2) return "";
        if (!ready()) return model.scopeIssue || "Choose at least one readable interaction in Activity.";
        if (target === 2) return "";
        if (!preview) return model.formats.length ? "Prepare the report in Contents before reviewing it." : "Choose at least one format in Contents.";
        return "";
    }
    function text(node, value) {
        if (node && node.textContent !== value) node.textContent = value;
    }
    function paint(focus = false, reading = null) {
        onStateChange?.();
        if (!nodes) { presentStep?.({ step, focus }); return; }
        root.dataset.reportStep = String(step);
        root.dataset.reportPhase = phase;
        nodes.panels.forEach((panel, index) => {
            if (presentStep && index === 1) return;
            panel.hidden = index + 1 !== step && !(presentStep && step === 2 && index === 0);
        });
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
        text(nodes.scopeName, ({ selected: "Selected interactions", current: "Current Analyze view", all: "All collected activity", period: "Paired periods" })[model.scope]
            + (model.authorFiltered ? ` · ${model.authorLabel}` : ""));
        const chats = Number.isSafeInteger(model.sourceSessionCount) && model.sourceSessionCount >= 0
            ? `${number.format(model.sourceSessionCount)} ${model.sourceSessionCount === 1 ? "chat" : "chats"}` : "Chat count unavailable";
        text(nodes.activityCount, model.scope === "period"
            ? `${number.format(model.requestCount)} supporting ${model.requestCount === 1 ? "interaction" : "interactions"}`
            : `${chats} · ${number.format(model.requestCount)} ${model.requestCount === 1 ? "interaction" : "interactions"} included`);
        nodes.activityCount.hidden = !model.scopeReady;
        const activityVisible = step === 1 || Boolean(presentStep && step === 2);
        nodes.start.hidden = !activityVisible;
        text(nodes.context, model.entry
            ? `${model.entry.sessionName || "Copilot chat name not recorded"} · Saved activity across all retained dates and services. New interactions are not added automatically.`
            : "");
        nodes.context.hidden = !nodes.context.textContent || !activityVisible;
        text(nodes.gap, ready() ? "" : model.scopeIssue || (model.entry ? "No readable interactions in this chat. Check source issues or choose another scope." : "Choose an interaction or another scope to continue."));
        nodes.gap.hidden = ready();
        nodes.issues.hidden = ready() || !model.entry || !showSourceIssues;
        nodes.next.disabled = !ready() || isWriting() || saveUnconfirmed;
        nodes.next.hidden = contentsPresented;
        nodes.backButtons.forEach(control => {
            control.disabled = isWriting() || saveUnconfirmed;
        });
        if (nodes.reviewControl) nodes.reviewControl.hidden = phase === "reviewed";
        nodes.reviewActions.hidden = ["reviewed", "writing", "saved", "unavailable"].includes(phase) || saveUnconfirmed;
        nodes.saveActions.hidden = !["reviewed", "writing"].includes(phase);
        nodes.reviewHost.hidden = ["saved", "unavailable"].includes(phase);
        nodes.saveHost.hidden = !["saved", "unavailable"].includes(phase) && !saveUnconfirmed;
        text(nodes.scan, preview ? "Return to review" : "Prepare report");
        text(nodes.prepareIssue, model.prepareIssue || "");
        nodes.prepareIssue.hidden = Boolean(preview) || !model.prepareIssue;
        nodes.error.hidden = !failure;
        nodes.retry.hidden = !failure || saveUnconfirmed || !readCurrent || isWriting();
        text(nodes.error, failure);
        if (nodes.feedback) nodes.feedback.hidden = Boolean(failure);
        nodes.reviewHost.setAttribute("aria-busy", String(phase === "scanning"));
        for (const fields of root.querySelectorAll(".report-copy-controls")) fields.disabled = isWriting() || saveUnconfirmed;
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
            : phase === "writing" ? "Saving your report" : saveUnconfirmed ? "Save not confirmed" : "Review and save your report");
        nodes.headings[2].classList.toggle("visually-hidden", ["ready", "reviewed"].includes(phase));
        if (presentStep?.({ step, focus, contents: nodes.panels[1], footer: nodes.contentFooter })) return;
        if (focus) {
            const samePreview = step < 3 || reading?.previewId === preview?.previewId;
            const prior = reading?.focus;
            const replacement = step === 3 && phase === "reviewed" ? nodes.saveActions.querySelector("button") : null;
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
        if (requestStep && !requestStep(() => go(target))) return false;
        const returning = target < step;
        rememberStep();
        if (["saved", "unavailable"].includes(phase) && target < 3) {
            bundle = undefined;
            phase = "draft";
            reached = 1;
            failure = "";
            nodes?.reviewHost.replaceChildren();
            nodes?.saveHost.replaceChildren();
            nodes?.saveActions.replaceChildren();
        }
        if (phase === "scanning" && target < 3) {
            cancelReview?.();
            phase = "draft";
            if (nodes) nodes.reviewHost.replaceChildren();
        }
        if (phase === "blocked" && target < 3) { phase = "draft"; failure = ""; }
        step = target;
        reached = Math.max(reached, target);
        paint(true, returning ? positions.get(target) : null);
        return true;
    }
    function invalidate(message) {
        if (isWriting() || saveUnconfirmed || phase === "saved" || phase === "unavailable") return;
        const hadPreview = Boolean(preview) || phase === "scanning";
        suspendedControls.clear();
        preview = undefined;
        phase = "draft";
        reached = Math.min(reached, 2);
        if (nodes) {
            for (const control of root.querySelectorAll("[data-review-control]")) {
                control.disabled = true;
                if (control.type === "checkbox") control.checked = false;
            }
            nodes.saveHost.replaceChildren();
            nodes.saveActions.replaceChildren();
        }
        if ((hadPreview || message !== undefined || failure) && step === 3) {
            failure = message ?? "This report changed. Return to Contents and prepare it again before approving or saving.";
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
        if (isWriting() || saveUnconfirmed) return false;
        positions.clear();
        suspendedControls.clear();
        preview = bundle = undefined;
        saveUnconfirmed = false;
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
        const progress = el("p", "report-progress-label visually-hidden"), summary = el("div", "report-content-context"), context = el("p", "report-entry-context");
        const scopeName = el("span", "report-content-scope");
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
            const panel = el("section", "report-stage"), heading = el("h2", "", questions[index]);
            panel.hidden = index !== 0;
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
        const scan = byId("exportBtn"), scanWrapper = scan.closest(".ux-disabled-help") || scan;
        summary.append(scopeName, byId("previewSelectionSummary"));
        shell.append(progress, nav, context);
        const error = el("p", "notice error report-journey-error");
        error.id = "reportJourneyError";
        error.setAttribute("role", "alert");
        error.tabIndex = -1;
        shell.append(error);
        const retry = button("Read current activity", async () => {
            retry.disabled = true;
            try { if (await readCurrent()) go(2); }
            finally { retry.disabled = false; }
        });
        retry.dataset.storedRefreshRetry = "";
        shell.append(retry);
        const gap = el("p", "report-scope-gap"), next = button("Continue to contents", () => go(2), "primary");
        next.id = "reportContinue";
        gap.id = "reportScopeGap";
        const issues = button("View source issues", () => showSourceIssues?.(), "quiet");
        const scope = root.querySelector(".export-scope"), choices = scope.querySelector(".scope-choices");
        const selectedChoice = choices.querySelector('[value="selected"]').closest("label");
        choices.append(selectedChoice, choices.querySelector('[value="current"]').closest("label"), choices.querySelector('[value="all"]').closest("label"));
        const scopeDetails = byId("scopeDetails");
        scopeDetails.append(byId("scopeSummary"), byId("reportMatchingContext"), byId("reportTimeContext"));
        // Keep detailed units/exclusions available without making them the first task.
        for (const paragraph of [...scope.querySelectorAll(":scope > .scope-explanation")]) {
            scopeDetails.append(paragraph);
        }
        const scopeLayout = el("div", "report-scope-layout");
        const authorChoice = root.querySelector(".report-author-choice");
        const authorControl = el("div", "report-author-control");
        if (icon) authorControl.append(icon("filter"));
        authorControl.append(byId("reportPromptAuthorFilter"));
        authorChoice.querySelector("label").after(authorControl);
        const requests = byId("reportRequests"), pickerTools = el("div", "report-picker-tools");
        pickerTools.append(requests.querySelector(".scoped-search"), authorChoice);
        requests.prepend(pickerTools);
        scopeLayout.append(scope);
        panels[0].append(scopeLayout);
        const firstFooter = el("div", "report-stage-actions report-activity-actions"), firstActions = el("div", "report-next-actions");
        firstFooter.id = "reportActivityActions";
        const activitySummary = el("div", "report-activity-summary"), activityCount = el("p");
        activityCount.id = "reportActivitySummary"; activityCount.setAttribute("role", "status");
        const outsidePage = el("p", "context-help-note");
        outsidePage.id = "reportPageSelectionSummary"; outsidePage.setAttribute("role", "status");
        activitySummary.append(activityCount, outsidePage, byId("reportPopulationNote"));
        firstActions.append(existingStart, next);
        firstFooter.append(gap, issues, activitySummary, firstActions);
        root.querySelector(".report-text-options").append(byId("additionalMasking"));
        panels[0].append(requests, firstFooter, scopeDetails);
        const contentFooter = el("div", "report-stage-actions"), activityBack = button("Back to activity", () => go(1));
        contentFooter.id = "reportContentsActions";
        const prepareIssue = el("p", "report-scope-gap");
        prepareIssue.id = "reportPrepareIssue"; prepareIssue.setAttribute("role", "status");
        backButtons.push(activityBack);
        contentFooter.append(prepareIssue, activityBack, scanWrapper);
        panels[1].append(summary, root.querySelector(".report-options"), contentFooter);
        // Revisiting unchanged choices returns to the same frozen review; it never records approval.
        scan.addEventListener("click", event => {
            if (!preview) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            go(3);
        }, true);
        const reviewHost = el("div", "report-review-body"), saveHost = el("div", "report-save-body");
        reviewHost.id = "reportReviewBody";
        saveHost.id = "reportSaveBody";
        panels[2].append(reviewHost, saveHost);
        const reviewActions = el("div", "report-next-actions"), saveActions = el("div", "report-next-actions");
        const reviewFooter = el("div", "report-stage-actions"), back = button("Back to contents", () => go(2));
        reviewFooter.id = "reportDecision";
        reviewFooter.tabIndex = -1;
        backButtons.push(back);
        reviewFooter.append(back, reviewActions, saveActions);
        panels[2].append(reviewFooter);
        root.insertBefore(shell, byId("savedReportsPanel"));
        shell.append(...panels);
        nodes = { panels, steps, stepHints, headings, backButtons, progress, scopeName, context, gap, next, issues, scan, error, retry, reviewHost, saveHost, reviewActions, saveActions, contentFooter, prepareIssue, activityCount, el, button, start: existingStart };
        paint();
    }
    return {
        snapshot, reason, go, invalidate, clear,
        setContentsPresented(presented) {
            if (contentsPresented === presented) return;
            contentsPresented = presented;
            if (nodes) nodes.next.hidden = presented;
        },
        get reviewHost() { return nodes?.reviewHost; },
        get saveHost() { return nodes?.saveHost; },
        isReviewOpen: () => !saveUnconfirmed && (Boolean(preview) || phase === "scanning") && (!root || !root.hidden),
        update(patch) {
            model = { ...model, ...structuredClone(patch) };
            paint();
        },
        beginScan() {
            if (isWriting() || saveUnconfirmed || phase === "scanning" || !ready() || !model.formats.length) return null;
            rememberStep();
            preview = bundle = undefined;
            failure = "";
            phase = "scanning";
            step = reached = 3;
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
                if (confirm) nodes.saveActions.append(confirm.closest(".ux-disabled-help") || confirm);
                nodes.feedback = feedback;
                const review = body.querySelector("button[data-review-control]");
                review?.classList.add("primary");
                if (review) {
                    nodes.reviewControl = review.closest(".ux-disabled-help") || review;
                    nodes.reviewActions.append(nodes.reviewControl);
                }
                body.querySelector(".dialog-actions")?.remove();
            }
            paint(true);
            return true;
        },
        reviewed() {
            if (phase !== "ready" || !preview) return false;
            phase = "reviewed";
            paint();
            nodes?.saveActions.querySelector("button")?.focus();
            return true;
        },
        writing(value) {
            if (value && phase === "reviewed") phase = "writing";
            else if (!value && phase === "writing") phase = "blocked";
            paint();
        },
        failed(message, { saveRejected = false } = {}) {
            // Draft invalidation can revoke disclosure, but cannot determine a dispatched write's outcome.
            saveUnconfirmed ||= isWriting() && !saveRejected;
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
            saveUnconfirmed = false;
            const savedBundle = bundle;
            preview = undefined;
            phase = "saved";
            step = reached = 3;
            failure = "";
            if (!available) { invalidateSavedReport(value.bundleId); return; }
            if (nodes) {
                const { el, button, saveHost } = nodes;
                const message = el("p", "report-save-success visually-hidden", "Report saved on this device.");
                message.setAttribute("role", "status");
                const details = el("details", "detail-disclosure");
                details.append(el("summary", "", "Saved report details"), el("p", "report-saved-id", value.bundleId));
                if (value.bundleDir) details.append(el("p", "report-saved-location", "Saved folder: " + value.bundleDir));
                saveHost.replaceChildren(message);
                const actions = el("div", "report-saved-actions");
                if (value.files["product-report.html"] && openSavedReport) actions.append(button("Open saved report", event => openSavedReport(value, event.currentTarget), "primary"));
                else if (!value.files["product-report.html"]) saveHost.append(el("p", "muted", "HTML was not saved. Read one of the saved downloads below."));
                actions.append(button("View saved reports", () => root.ownerDocument.getElementById("reportLibraryLink").click()));
                saveHost.append(actions);
                const downloads = el("div", "report-downloads");
                downloads.setAttribute("role", "group");
                downloads.setAttribute("aria-label", "Download saved files");
                downloads.append(el("span", "report-download-label", "Download"));
                for (const name of Object.keys(value.files)) {
                    const label = name === "coverage-and-redaction-manifest.json" ? "Manifest" : name.endsWith(".html") ? "HTML"
                        : name.endsWith(".pdf") ? "PDF" : name.endsWith(".md") ? "Markdown" : "JSON";
                    const control = button(label, async () => {
                        control.disabled = true;
                        try { await downloadFile(value, name, () => bundle === savedBundle); }
                        catch (error) { if (bundle === savedBundle) { failure = `Download failed: ${error.message}`; paint(); } }
                        finally { control.disabled = false; }
                    });
                    control.setAttribute("aria-label", `Download ${name}`);
                    if (utility) utility(control, "download", `Download ${name}`, `Download ${label}`);
                    const file = el("span", "report-file-action");
                    file.append(el("span", "", label), control);
                    (name === "coverage-and-redaction-manifest.json" ? details : downloads).append(file);
                }
                saveHost.append(downloads, details, button("Start a new report", () => clearSelection?.()));
                nodes.saveActions.replaceChildren();
                for (const control of root.querySelectorAll("[data-review-control]")) control.disabled = true;
            }
            paint(true);
        },
    };
}
