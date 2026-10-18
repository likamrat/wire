// The report controller owns facts, privacy approval, and frozen files.
export function mountReportComparisonJourney(root, { api, renderer, timeContext, refresh, onError, inspectSource, openSaved, onRead, prepareBlockReason, beforePrepare, onStateChange }) {
    const doc = root.ownerDocument;
    let generation = 0, preview = null, approved = false, writing = false, unknownSave = false, comparison = null, artifacts = [], savedMode = false, savedArtifactId = null, artifactPending = false;
    let dispatchedSave = null, checkingSave = false, showingPrepared = false, preparing = false;
    let choicesLoaded = false, choicesLoading = false, inventoryIds = null;
    let draftTitle = "", savedResult = null, savedDocumentTitle = "";
    function el(tag, text, cls) {
        const node = doc.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (cls) node.className = cls;
        return node;
    }
    function button(label, action, cls = "quiet") {
        const node = el("button", label, cls);
        node.type = "button"; node.addEventListener("click", action); return node;
    }
    function focusHeading(block = "start") {
        const target = header.hidden ? doc.getElementById("pageTitle") || preparedFiles.querySelector('[role="tab"]') : heading;
        target?.focus({ preventScroll: true });
        target?.scrollIntoView({ block });
    }
    const heading = el("h2", "Compare saved reports"); heading.tabIndex = -1;
    const header = el("header", undefined, "comparison-task-heading");
    const backChoices = button("Back to comparison choices", () => {
        if (writing || dispatchedSave) return;
        showingPrepared = false; savedResult = null; paint();
        (baseline.closest(".select-control")?.querySelector("button") || baseline).focus({ preventScroll: true });
        heading.scrollIntoView({ block: "nearest" });
    });
    header.append(heading, backChoices);
    const intro = el("p", "Compare the frozen facts from two saved reports, not current activity.", "comparison-task-intro");
    const selectors = el("div", undefined, "comparison-selectors");
    const baseline = el("select"), later = el("select");
    const identities = new Map();
    for (const [text, select] of [["Earlier report", baseline], ["Later report", later]]) {
        const choice = el("div", undefined, "comparison-report-choice"), label = el("label", text);
        const identity = button("Inspect " + text.toLowerCase(), event => inspectSource(select.value, event.currentTarget), "quiet comparison-report-identity");
        identity.dataset.viewKey = "inspect-comparison-source:" + text;
        identity.hidden = true;
        identities.set(select, { identity });
        select.dataset.selectPresentation = "filter";
        label.append(select); choice.append(label, identity); selectors.append(choice);
    }
    const status = el("p"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    const content = el("div"), actions = el("div", undefined, "assessment-control-actions");
    const savedContent = el("div"), savedBack = button("Back to comparison draft", () => {
        if (!savedMode) return;
        generation++; writing = false;
        savedMode = false; heading.textContent = "Compare saved reports"; paint();
        message(dispatchedSave ? pendingSaveMessage() : "Your unfinished comparison choices are kept.");
        heading.focus({ preventScroll: true });
    });
    const inspect = button("Compare reports", inspectPair, "primary"), discard = button("Discard comparison", () => invalidate("Comparison draft discarded. Saved reports and comparisons are unchanged.", true));
    actions.append(inspect); header.append(discard);
    const formats = el("fieldset");
    formats.append(el("legend", "Files to save"));
    const formatChoices = el("div", undefined, "comparison-format-choices");
    formats.append(formatChoices);
    for (const [value, title] of [["html", "HTML"], ["pdf", "PDF"], ["json", "JSON"], ["markdown", "Markdown"]]) {
        const label = el("label"), input = el("input");
        input.type = "checkbox"; input.value = value; input.checked = value === "html";
        label.append(input, doc.createTextNode(title)); formatChoices.append(label);
        input.addEventListener("change", () => invalidate("Formats changed. Prepare and review a fresh comparison copy."));
    }
    const reviewHost = el("section", undefined, "comparison-review");
    const preparedFiles = el("section", undefined, "comparison-prepared-files");
    const prepare = button("Prepare comparison copy", prepareCopy, "primary");
    const copyOptions = el("section", undefined, "comparison-copy-options");
    const titleField = el("div", undefined, "report-title-field"), titleLabel = el("label", "Report title"), titleInput = el("input");
    titleInput.id = "comparisonReportTitle"; titleInput.type = "text"; titleInput.maxLength = 200;
    titleInput.autocomplete = "off"; titleInput.spellcheck = false;
    titleInput.placeholder = "Report comparison"; titleLabel.htmlFor = titleInput.id;
    titleInput.addEventListener("input", () => {
        if (writing || dispatchedSave) { titleInput.value = draftTitle; return; }
        draftTitle = titleInput.value;
        invalidate("Title changed. Prepare and review a fresh comparison copy.");
    });
    titleField.append(titleLabel, titleInput, el("p", "Private values in titles are masked.", "muted"));
    const preparationIssue = el("p", undefined, "comparison-prepare-issue");
    preparationIssue.id = "comparisonPrepareIssue"; preparationIssue.tabIndex = -1;
    preparationIssue.setAttribute("role", "status");
    copyOptions.append(titleField, formats, preparationIssue, prepare);
    const reviewLabel = el("label"), reviewCheck = el("input");
    reviewCheck.type = "checkbox";
    reviewLabel.append(reviewCheck, doc.createTextNode("I reviewed this frozen comparison for disclosure."));
    const approve = button("Approve for local saving", confirmReview, "primary");
    const save = button("Save comparison", saveCopy, "primary");
    const readSaved = button("Read saved comparisons", recoverSave, "primary");
    const decision = el("section", undefined, "comparison-disclosure"), decisionActions = el("div", undefined, "comparison-decision-actions");
    decisionActions.append(approve, save);
    decision.append(reviewLabel, decisionActions);
    reviewHost.append(copyOptions, preparedFiles, decision, readSaved);
    const openResult = button("Open saved comparison", event => {
        if (savedResult && !writing && !artifactPending) openSaved?.(savedResult.bundleId, event.currentTarget);
    }, "primary");
    root.replaceChildren(header, intro, selectors, actions, status, openResult, savedBack, savedContent, content, reviewHost);
    root.hidden = true;
    const pair = () => ({ baselineId: baseline.value, laterId: later.value });
    const signature = () => JSON.stringify([pair(), timeContext(), draftTitle]);
    const selectedFormats = () => [...formats.querySelectorAll("input:checked")].map(node => node.value);
    function message(text, error = false) {
        status.textContent = text;
        status.hidden = !text;
        status.setAttribute("role", error ? "alert" : "status");
        status.classList.toggle("error", error);
    }
    function pendingSaveMessage() {
        return dispatchedSave?.confirmed
            ? "The comparison save was confirmed, but its current availability has not been checked. Read saved comparisons; do not save it again."
            : "The comparison save is not confirmed and may have completed. Read saved comparisons; this save will not be repeated.";
    }
    function syncPreparation() {
        const issue = preview ? "" : prepareBlockReason?.() || "";
        if (preparationIssue.textContent !== issue) preparationIssue.textContent = issue;
        if (preparationIssue.hidden !== !issue) preparationIssue.hidden = !issue;
        const disabled = writing || artifactPending || Boolean(dispatchedSave) || !comparison || !selectedFormats().length || Boolean(issue);
        if (prepare.disabled !== disabled) prepare.disabled = disabled;
        if (issue) prepare.setAttribute("aria-describedby", preparationIssue.id);
        else prepare.removeAttribute("aria-describedby");
    }
    function paint() {
        if (dispatchedSave) {
            baseline.value = dispatchedSave.pair.baselineId;
            later.value = dispatchedSave.pair.laterId;
            for (const input of formats.querySelectorAll("input")) input.checked = dispatchedSave.formats.includes(input.value);
        }
        const valid = baseline.value && later.value && baseline.value !== later.value;
        const locked = Boolean(dispatchedSave);
        const reviewing = showingPrepared && Boolean(preview) && !unknownSave;
        const choicesHost = reviewing ? preparedFiles.querySelector(".comparison-inspection-actions") : header;
        if (choicesHost && backChoices.parentElement !== choicesHost) {
            if (choicesHost === header) header.insertBefore(backChoices, discard);
            else choicesHost.prepend(backChoices);
        }
        header.hidden = reviewing;
        heading.textContent = savedMode ? savedDocumentTitle || "Saved comparison"
            : reviewing ? preview.title || "Review comparison" : dispatchedSave?.title || savedResult?.title || "Compare saved reports";
        titleInput.value = draftTitle; titleInput.disabled = writing || locked;
        openResult.hidden = !savedResult || savedResult.available === false || !openSaved || savedMode;
        openResult.disabled = writing || artifactPending;
        intro.hidden = savedMode || reviewing || unknownSave || Boolean(savedResult);
        backChoices.hidden = !reviewing && !savedResult || savedMode;
        backChoices.textContent = savedResult ? "Compare other reports" : "Back to comparison choices";
        backChoices.disabled = writing || locked;
        inspect.hidden = Boolean(comparison) && !unknownSave;
        discard.hidden = savedMode || reviewing || Boolean(savedResult) || !baseline.value && !later.value && !locked;
        inspect.disabled = writing || artifactPending || locked || !valid;
        baseline.disabled = later.disabled = writing || artifactPending || locked;
        discard.disabled = writing || locked;
        formats.disabled = writing || locked;
        reviewHost.hidden = !comparison && !preview && !unknownSave;
        copyOptions.hidden = !comparison || reviewing || unknownSave;
        prepare.textContent = preview ? "Return to review" : "Prepare comparison copy";
        syncPreparation();
        decision.hidden = !reviewing;
        reviewLabel.hidden = !preview || unknownSave;
        approve.hidden = !preview || unknownSave || approved;
        reviewCheck.disabled = writing || locked || approved;
        approve.disabled = writing || artifactPending || locked || !reviewCheck.checked || approved;
        save.hidden = !preview || unknownSave || !approved;
        save.disabled = writing || artifactPending || locked || !approved || !reviewCheck.checked;
        readSaved.hidden = !unknownSave;
        readSaved.disabled = writing || artifactPending || checkingSave;
        preparedFiles.hidden = !reviewing;
        if (!preview) preparedFiles.replaceChildren();
        root.setAttribute("aria-busy", String(writing));
        selectors.hidden = savedMode || reviewing || Boolean(savedResult);
        actions.hidden = savedMode || reviewing || Boolean(savedResult) || Boolean(comparison) && !unknownSave;
        content.hidden = savedMode || reviewing || unknownSave;
        savedBack.hidden = savedContent.hidden = !savedMode;
        if (savedMode) reviewHost.hidden = true;
        for (const select of [baseline, later]) {
            const { identity } = identities.get(select);
            const description = select.selectedOptions[0]?.dataset.detail;
            identity.hidden = !description;
            identity.disabled = writing || artifactPending;
        }
        onStateChange?.();
    }
    async function cancelPrevious(previous) {
        if (!previous?.previewId) return;
        try { await api("/api/report-comparison/cancel", { previewId: previous.previewId }); }
        catch (error) { onError("The old comparison preview could not be cancelled. Do not reuse it. " + error.message); }
    }
    function invalidate(text = "Comparison inputs changed. Compare and review again.", clear = false, { force = false } = {}) {
        if (dispatchedSave) {
            // Revoking a draft cannot settle or cancel a write already dispatched.
            if (force) {
                preview = comparison = null; approved = false; reviewCheck.checked = false;
                unknownSave = true;
                renderer.clear(content);
                preparedFiles.replaceChildren();
            }
            message(pendingSaveMessage(), true);
            paint();
            return false;
        }
        if (writing && !force) return false;
        if (force) writing = false;
        preparing = false;
        savedResult = null;
        generation++;
        const previous = preview;
        preview = null; approved = false; reviewCheck.checked = false;
        showingPrepared = false;
        if (clear) { baseline.value = ""; later.value = ""; draftTitle = ""; comparison = null; unknownSave = false; renderer.clear(content); }
        else if (!comparison) renderer.clear(content);
        cancelPrevious(previous);
        message(text);
        paint();
        return true;
    }
    function changed() {
        if (dispatchedSave) { paint(); return; }
        comparison = null; unknownSave = false;
        invalidate("Choose two different reports, then compare their frozen facts.");
        renderer.clear(content);
    }
    baseline.addEventListener("change", changed); later.addEventListener("change", changed);
    reviewCheck.addEventListener("change", () => { approved = false; paint(); });
    async function inspectPair() {
        if (dispatchedSave || inspect.disabled) return;
        onRead?.();
        invalidate("");
        const token = ++generation, selected = signature();
        writing = true; message("Reading the two selected reports..."); paint();
        try {
            const result = await api("/api/report-comparison/inspect", pair());
            if (token !== generation || selected !== signature()) return;
            comparison = result.comparison;
            renderer.render(content, comparison);
            message("");
            content.tabIndex = -1; content.focus({ preventScroll: true });
        } catch (error) { if (token === generation) message(error.message, true); }
        finally { if (token === generation) { writing = false; paint(); } }
    }
    async function prepareCopy() {
        if (dispatchedSave || writing || artifactPending) return;
        if (!comparison || !selectedFormats().length) {
            message(!comparison ? "Compare two saved reports before preparing a copy." : "Choose at least one file format.", true);
            paint(); return;
        }
        if (preview) {
            onRead?.();
            showingPrepared = true; paint();
            focusHeading("nearest");
            return;
        }
        const blocked = prepareBlockReason?.() || "";
        if (blocked) {
            message(""); paint();
            preparationIssue.focus({ preventScroll: true });
            preparationIssue.scrollIntoView({ block: "nearest" });
            return;
        }
        const refused = beforePrepare?.() || "";
        if (refused) { message(refused, true); paint(); return; }
        onRead?.();
        const token = ++generation, selected = signature();
        preparing = writing = true; message("Preparing a comparison copy for your review..."); paint();
        try {
            const result = await api("/api/report-comparison/preview", { ...pair(), ...(draftTitle.trim() ? { title: draftTitle } : {}), formats: selectedFormats(), timeContext: timeContext() });
            if (token !== generation || selected !== signature()) { cancelPrevious(result); return; }
            if (result?.kind !== "comparison" || typeof result.previewId !== "string" || !result.previewId || typeof result.bundleId !== "string" || !result.bundleId
                || !result.comparison || result.privacy?.allSelectedFieldsScanned !== true
                || typeof result.previewHtml !== "string" || !result.files || !Object.keys(result.files).length) throw new Error("A complete reviewed-comparison preview was not returned.");
            preview = result; approved = false; reviewCheck.checked = false;
            comparison = result.comparison; renderer.render(content, comparison);
            const frame = el("iframe", undefined, "report-frame");
            frame.title = result.title || "Prepared comparison copy";
            frame.setAttribute("sandbox", "");
            frame.setAttribute("referrerpolicy", "no-referrer");
            frame.srcdoc = result.previewHtml;
            const reportPanel = el("section"), filePanel = el("section", undefined, "comparison-exact-files");
            reportPanel.append(frame);
            for (const [name, value] of Object.entries(result.files)) {
                if (typeof value === "string") {
                    const detail = el("details", undefined, "comparison-exact-file"), text = el("pre", value);
                    text.tabIndex = 0;
                    text.setAttribute("aria-label", name);
                    detail.append(el("summary", name), text);
                    filePanel.append(detail);
                } else filePanel.append(el("p", name));
            }
            const tabs = el("nav", undefined, "report-inspection-tabs"), tabList = el("div", undefined, "report-inspection-choices");
            tabs.setAttribute("aria-label", "Comparison inspection");
            tabList.setAttribute("role", "tablist");
            const views = [[reportPanel, "Report"], [filePanel, `Files (${Object.keys(result.files).length})`]], controls = [];
            views.forEach(([panel, label], index) => {
                const tab = button(label, () => {
                    const top = tab.getBoundingClientRect().top;
                    views.forEach(([other], i) => { other.hidden = i !== index; });
                    controls.forEach((control, i) => {
                        control.setAttribute("aria-selected", String(i === index)); control.tabIndex = i === index ? 0 : -1;
                    });
                    doc.defaultView.scrollBy(0, tab.getBoundingClientRect().top - top);
                });
                tab.id = `comparisonInspectionTab${index}`; panel.id = `comparisonInspectionPanel${index}`;
                tab.setAttribute("role", "tab"); panel.setAttribute("role", "tabpanel");
                tab.setAttribute("aria-controls", panel.id); panel.setAttribute("aria-labelledby", tab.id);
                tab.setAttribute("aria-selected", String(index === 0)); tab.tabIndex = index === 0 ? 0 : -1;
                panel.hidden = index !== 0;
                controls.push(tab); tabList.append(tab);
            });
            tabList.addEventListener("keydown", event => {
                const current = controls.indexOf(doc.activeElement);
                if (current < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const next = event.key === "Home" ? 0 : event.key === "End" ? controls.length - 1
                    : (current + (event.key === "ArrowRight" ? 1 : -1) + controls.length) % controls.length;
                controls[next].click(); controls[next].focus();
            });
            const tabActions = el("div", undefined, "comparison-inspection-actions");
            tabActions.append(button("Disclosure & save", () => {
                decision.scrollIntoView({ block: "center" });
                const control = approved ? save : reviewCheck;
                if (!control.disabled) control.focus({ preventScroll: true });
            }));
            tabs.append(tabList, tabActions);
            preparedFiles.replaceChildren(tabs, reportPanel, filePanel);
            showingPrepared = true;
            message("");
            paint();
            focusHeading();
        } catch (error) { if (token === generation) message(error.message, true); }
        finally { if (token === generation) { preparing = writing = false; paint(); } }
    }
    async function confirmReview() {
        if (dispatchedSave || approve.disabled || !preview) return;
        writing = true; paint();
        const token = generation;
        try {
            const result = await api("/api/report-comparison/review", { previewId: preview.previewId, disclosureReviewed: true, timeContext: timeContext() });
            if (token !== generation) return;
            const manifestName = "coverage-and-redaction-manifest.json";
            if (result?.previewId !== preview.previewId || result.bundleId !== preview.bundleId || result.kind !== "comparison"
                || result.privacy?.reviewerConfirmed !== true || result.privacy?.allSelectedFieldsScanned !== true
                || !result.comparison || typeof result.files?.[manifestName] !== "string" || result.title !== preview.title) {
                throw new Error("The runtime did not confirm disclosure for this comparison.");
            }
            const manifest = preparedFiles.querySelector(`pre[aria-label="${manifestName}"]`);
            if (!manifest) throw new Error("The reviewed comparison manifest is no longer available. Prepare a fresh copy.");
            manifest.textContent = result.files[manifestName];
            preview.files[manifestName] = result.files[manifestName];
            preview.privacy = result.privacy;
            approved = true;
            message("Disclosure approved. Not saved yet.");
        } catch (error) { if (token === generation) { approved = false; message(error.message + " Prepare a fresh preview if it is no longer current.", true); } }
        finally {
            if (token === generation) {
                writing = false; paint();
                if (approved && showingPrepared && !savedMode) save.focus({ preventScroll: true });
            }
        }
    }
    async function saveCopy() {
        if (dispatchedSave || save.disabled || !preview) return;
        const token = generation;
        const operation = {
            previewId: preview.previewId, bundleId: preview.bundleId, title: preview.title,
            pair: pair(), formats: selectedFormats(), confirmed: false,
        };
        dispatchedSave = operation;
        writing = true; paint(); message("Saving the reviewed comparison...");
        try {
            const result = await api("/api/report-comparison/save", { previewId: operation.previewId, confirmed: true, timeContext: timeContext() });
            if (dispatchedSave !== operation) return;
            if (result?.bundle?.bundleId !== operation.bundleId || result.bundle.kind !== "comparison" || result.bundle.title !== operation.title) throw new Error("The save receipt did not match the dispatched comparison.");
            operation.confirmed = true;
            preview = null; approved = false; reviewCheck.checked = false;
            const entries = await refresh();
            if (dispatchedSave !== operation) return;
            if (!Array.isArray(entries)) throw new Error("The saved comparison list could not be read.");
            // The receipt proves the write, not that the saved file still exists.
            if (!resolveSave(entries)) settleSave(operation, false);
        } catch (error) {
            if (dispatchedSave !== operation) return;
            unknownSave = true; approved = false;
            message(error.message + " " + pendingSaveMessage(), true);
        } finally { if (token === generation) { writing = false; paint(); } }
    }
    function settleSave(operation, available) {
        if (dispatchedSave !== operation) return false;
        savedResult = { bundleId: operation.bundleId, title: operation.title, available };
        dispatchedSave = null; unknownSave = false;
        preview = comparison = null; approved = false; reviewCheck.checked = false;
        renderer.clear(content);
        message(available ? "Comparison saved locally. Original reports are unchanged." : unavailableResultMessage, !available);
        return true;
    }
    function resolveSave(entries) {
        const operation = dispatchedSave;
        if (!operation || !unknownSave && !operation.confirmed) return false;
        const saved = entries.find(entry => entry.bundleId === operation.bundleId && entry.kind === "comparison" && entry.title === operation.title);
        return saved ? settleSave(operation, true) : false;
    }
    async function recoverSave() {
        const operation = dispatchedSave;
        if (!operation || writing || checkingSave || artifactPending) return;
        checkingSave = true; paint();
        try {
            const loaded = await refresh();
            if (dispatchedSave !== operation) return;
            if (!Array.isArray(loaded)) throw new Error("The saved comparison list could not be read.");
            if (resolveSave(loaded) || operation.confirmed && settleSave(operation, false)) return;
            message("The original comparison is not in the current saved list. " + pendingSaveMessage(), true);
        } catch (error) {
            if (dispatchedSave === operation) message(error.message + " " + pendingSaveMessage(), true);
        } finally { checkingSave = false; paint(); }
    }
    const unavailableResultMessage = "This saved comparison is no longer available.";
    function reconcileSavedResult(entries) {
        if (!savedResult || dispatchedSave) return;
        const available = entries.some(entry => entry.bundleId === savedResult.bundleId
            && entry.kind === "comparison" && entry.title === savedResult.title);
        if (savedResult.available !== available) {
            savedResult.available = available;
            message(available ? "Saved comparison available." : unavailableResultMessage, !available);
        }
    }
    function receive(entries, authoritative = true) {
        artifacts = entries;
        choicesLoaded = true;
        const previous = dispatchedSave?.pair ?? pair();
        for (const [select, selected] of [[baseline, previous.baselineId], [later, previous.laterId]]) {
            const blank = el("option", "Choose a saved report"); blank.value = "";
            select.replaceChildren(blank);
            for (const item of entries.filter(item => item.kind === "report")) {
                const groups = Number.isSafeInteger(item.requestGroupCount) && item.requestGroupCount >= 0
                    ? `${item.requestGroupCount} interaction${item.requestGroupCount === 1 ? "" : "s"}` : "Interaction count unavailable";
                const mode = ({ none: "No prompts", masked: "Masked prompts", original: "Original prompts" })[item.promptMode];
                const prepared = item.preparedAtDisplay || item.preparedAt;
                const option = el("option", [item.title, prepared || "Preparation time unavailable", groups, mode].filter(Boolean).join(" · "));
                option.value = item.bundleId;
                option.dataset.detail = [
                    (item.formats ?? []).map(format => format === "markdown" ? "Markdown" : format.toUpperCase()).join(", "),
                    `Report ID: ${item.bundleId}`,
                ].filter(Boolean).join(" · ");
                option.disabled = !["available", "legacy-outcomes-only"].includes(item.comparisonEligibility);
                if (option.disabled) option.textContent += item.comparisonEligibility === "period-report-has-two-cohorts-not-one-source"
                    ? " (two-cohort period report; open directly)" : " (structured facts unavailable)";
                select.append(option);
            }
            select.value = selected;
        }
        if (!savedResult && (previous.baselineId && !baseline.value || previous.laterId && !later.value)) {
            if (!dispatchedSave) { writing = false; comparison = null; unknownSave = false; }
            invalidate("A selected report was deleted or is unavailable. Choose current saved reports.", false, { force: Boolean(dispatchedSave) });
            renderer.clear(content);
        }
        resolveSave(entries);
        if (authoritative) reconcileSavedResult(entries);
        paint();
    }
    async function open(bundleId, { retain = false, focus = true } = {}) {
        if (retain && (choicesLoaded || choicesLoading)) return;
        if (writing || artifactPending) { message("Wait for the current saved-object operation to finish."); return; }
        root.hidden = false;
        if (focus) focusHeading();
        if (bundleId) {
            savedMode = true; savedArtifactId = bundleId; savedDocumentTitle = ""; heading.textContent = "Saved comparison";
            const token = ++generation;
            writing = true; message("Reading the saved comparison..."); paint();
            try {
                const result = await api("/api/report-comparison/open", { bundleId });
                if (token !== generation) return;
                savedDocumentTitle = result.canonicalTitle || result.artifact?.title || "";
                renderer.render(savedContent, result.comparison);
                message(result.sources?.some(source => source.available === false)
                    ? "Saved comparison. An original report is no longer available; these frozen facts are unchanged."
                    : "Saved comparison. Original report facts remain frozen.");
            } catch (error) { if (token === generation) message(error.message, true); }
            finally { if (token === generation) { writing = false; paint(); } }
            return;
        }
        savedMode = false; heading.textContent = "Compare saved reports"; paint();
        choicesLoading = true;
        const inventory = inventoryIds;
        try {
            const result = await api("/api/report-artifacts/list", {});
            if (!Array.isArray(result.artifacts)) throw new Error("Saved report choices are unavailable.");
            if (inventory !== inventoryIds) {
                choicesLoaded = false;
                throw new Error("Saved reports changed while their choices were loading. Return to Reports and reopen comparison choices.");
            }
            const pending = dispatchedSave;
            receive(result.artifacts);
            if (pending && !dispatchedSave) return;
            message(dispatchedSave ? pendingSaveMessage() : savedResult?.available === false ? unavailableResultMessage
                : result.artifacts.filter(item => item.kind === "report" && ["available", "legacy-outcomes-only"].includes(item.comparisonEligibility)).length < 2
                    ? "Two saved reports with structured facts are needed. Save reports first, then return here to compare them." : "");
        } catch (error) { message(error.message, true); }
        finally { choicesLoading = false; }
    }
    function invalidateSavedReport(bundleId) {
        const currentPair = dispatchedSave?.pair ?? pair();
        if (!savedResult && [currentPair.baselineId, currentPair.laterId].includes(bundleId)) {
            if (!dispatchedSave) { writing = false; comparison = null; }
            invalidate("An input report was deleted. This unfinished comparison is no longer valid.", true, { force: Boolean(dispatchedSave) });
        }
        if (savedResult?.bundleId === bundleId) reconcileSavedResult([]);
        // Cached choices need not contain a comparison saved after they were loaded.
        receive(artifacts.filter(item => item.bundleId !== bundleId), false);
    }
    function syncPresence(entries) {
        const ids = new Set(entries.map(entry => entry.bundleId));
        if (!inventoryIds || ids.size !== inventoryIds.size || [...ids].some(id => !inventoryIds.has(id))) inventoryIds = ids;
        if (savedMode && savedArtifactId && !ids.has(savedArtifactId)) {
            renderer.clear(savedContent);
            message("This saved comparison was deleted. Its source reports are unchanged.");
        }
        for (const item of artifacts) if (!ids.has(item.bundleId)) invalidateSavedReport(item.bundleId);
        if (entries.some(entry => !artifacts.some(item => item.bundleId === entry.bundleId))) choicesLoaded = false;
        resolveSave(entries);
        reconcileSavedResult(entries);
        artifactPending = false; paint();
    }
    function pendingArtifactCleanup() {
        artifactPending = true;
        message("Saved-object cleanup is pending. " + (dispatchedSave ? pendingSaveMessage() : "Comparison actions will resume after the saved list is current."));
        paint();
    }
    paint();
    return { open, receive, syncPresence, pendingArtifactCleanup, invalidate, invalidateSavedReport, syncPreparation,
        title: () => heading.textContent,
        isBusy: () => writing, hasPendingSave: () => Boolean(dispatchedSave), hasPreviewWork: () => Boolean(preview) || preparing };
}
