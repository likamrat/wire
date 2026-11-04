// The report controller owns facts, privacy approval, and frozen files.
export function mountReportComparisonJourney(root, { api, renderer, timeContext, refresh, onError, inspectSource, openSaved, onRead, prepareBlockReason, beforePrepare, onStateChange, createSaveIdentity, createFileInspection }) {
    if (!root?.ownerDocument || typeof api?.publicationToken !== "function" || typeof api?.isCurrent !== "function" || typeof createSaveIdentity !== "function") {
        throw new TypeError("Mounted comparison journeys require publication authority and a save-identity factory.");
    }
    const saveVerifier = createSaveIdentity({ kind: "comparison", api });
    if (!saveVerifier || ["prepareSaveIdentity", "matchesSaveIdentity", "saveIdentity", "invalidatePrepared", "dispatched",
        "uncertain", "settled", "withdrawAccess", "resumeAccess"].some(method => typeof saveVerifier[method] !== "function")) {
        throw new TypeError("Comparison save-identity factory returned an invalid verifier interface.");
    }
    const doc = root.ownerDocument;
    let generation = 0, preview = null, approved = false, writing = false, unknownSave = false, comparison = null, artifacts = [], savedMode = false, savedArtifactId = null, artifactPending = false;
    let dispatchedSave = null, checkingSave = false, showingPrepared = false, preparing = false;
    let choicesLoaded = false, choicesLoading = false, inventoryIds = null, inventoryVersion = 0;
    let draftTitle = "", savedResult = null, savedDocumentTitle = "";
    let accessWithdrawn = false, saveChoices = null, recoveryEntries = null, recoveryVersion = 0;
    const pendingSignatures = new Map();
    const publication = () => api.publicationToken();
    const current = (token, access) => !accessWithdrawn && token === generation && access != null && api.isCurrent(access);
    function el(tag, text, cls) {
        const node = doc.createElement(tag);
        if (text !== undefined) node.textContent = text;
        if (cls) node.className = cls;
        return node;
    }
    function button(label, action, cls = "quiet") {
        const node = el("button", label, cls);
        node.type = "button"; node.addEventListener("click", event => { if (current(generation, publication()) && node.isConnected) action(event); }); return node;
    }
    function focusHeading(block = "start") {
        const target = header.hidden || heading.hidden ? doc.getElementById("pageTitle") || preparedFiles.querySelector('[role="tab"]') : heading;
        target?.focus({ preventScroll: true });
        target?.scrollIntoView({ block });
    }
    const heading = el("h2", "Compare saved reports"); heading.tabIndex = -1;
    heading.hidden = Boolean(doc.getElementById("pageTitle"));
    const header = el("header", undefined, "comparison-task-heading");
    const backChoices = button("Back to comparison choices", () => {
        if (accessWithdrawn || writing || dispatchedSave) return;
        showingPrepared = false; savedResult = null; paint();
        (baseline.closest(".select-control")?.querySelector("button") || baseline).focus({ preventScroll: true });
        (heading.hidden ? doc.getElementById("pageTitle") : heading)?.scrollIntoView({ block: "nearest" });
    });
    header.append(heading, backChoices);
    const selectors = el("div", undefined, "comparison-selectors");
    const baseline = el("select"), later = el("select");
    const identities = new Map();
    for (const [text, select] of [["Earlier report", baseline], ["Later report", later]]) {
        const choice = el("div", undefined, "comparison-report-choice"), label = el("label", text);
        const identity = button("Inspect " + text.toLowerCase(), event => { if (!accessWithdrawn) inspectSource(select.value, event.currentTarget); }, "quiet comparison-report-identity");
        identity.dataset.viewKey = "inspect-comparison-source:" + text;
        identity.hidden = true;
        identities.set(select, { identity });
        select.dataset.selectPresentation = "filter";
        label.append(select); choice.append(label, identity); selectors.append(choice);
    }
    const status = el("p"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    const content = el("div"), actions = el("div", undefined, "assessment-control-actions");
    const savedContent = el("div"), savedBack = button("Back to comparison draft", () => {
        if (accessWithdrawn || !savedMode) return;
        generation++; writing = false;
        savedMode = false; heading.textContent = "Compare saved reports"; paint();
        message(dispatchedSave ? pendingSaveMessage() : "");
        focusHeading("nearest");
    });
    const inspect = button("Compare reports", inspectPair, "primary"), discard = button("Discard comparison", () => invalidate("Draft discarded. Saved files are unchanged.", true));
    actions.append(discard, inspect);
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
    let fileInspection;
    function clearPreparedFiles() {
        fileInspection?.dispose(); fileInspection = null;
        preparedFiles.replaceChildren();
    }
    const prepare = button("Prepare comparison copy", prepareCopy, "primary");
    const copyOptions = el("section", undefined, "comparison-copy-options");
    const resultTextLabel = el("label", undefined, "attestation"), resultTextChoice = el("input");
    resultTextChoice.id = "comparisonResultText"; resultTextChoice.type = "checkbox";
    resultTextLabel.append(resultTextChoice, doc.createTextNode("Include result text already saved in the source reports (masked)"));
    const resultTermsLabel = el("label", "Additional result-text redactions"), resultTerms = el("textarea");
    resultTerms.id = "comparisonResultTerms"; resultTerms.rows = 2; resultTerms.maxLength = 100000;
    resultTermsLabel.htmlFor = resultTerms.id;
    const resultTermsField = el("div");
    resultTermsField.append(resultTermsLabel, resultTerms, el("p", "One literal term per line. No original-source content is fetched.", "muted"));
    const resultTextChanged = () => {
        if (accessWithdrawn || writing || dispatchedSave) return;
        if (comparison?.resultTextSources && !savedMode) {
            delete comparison.resultTextSources;
            renderer.render(content, comparison);
        }
        invalidate("Result-text choices changed. Prepare and review a fresh comparison copy.");
    };
    resultTextChoice.addEventListener("change", resultTextChanged);
    resultTerms.addEventListener("input", resultTextChanged);
    const titleField = el("div", undefined, "report-title-field"), titleLabel = el("label", "Report title"), titleInput = el("input");
    titleInput.id = "comparisonReportTitle"; titleInput.type = "text"; titleInput.maxLength = 200;
    titleInput.autocomplete = "off"; titleInput.spellcheck = false;
    titleInput.placeholder = "Report comparison"; titleLabel.htmlFor = titleInput.id;
    titleInput.addEventListener("input", () => {
        if (accessWithdrawn || writing || dispatchedSave) { titleInput.value = draftTitle; return; }
        draftTitle = titleInput.value;
        invalidate("Title changed. Prepare and review a fresh comparison copy.");
    });
    titleField.append(titleLabel, titleInput, el("p", "Private values in titles are masked.", "muted"));
    const preparationIssue = el("p", undefined, "comparison-prepare-issue");
    preparationIssue.id = "comparisonPrepareIssue"; preparationIssue.tabIndex = -1;
    preparationIssue.setAttribute("role", "status");
    copyOptions.append(titleField, formats, resultTextLabel, resultTermsField, preparationIssue, prepare);
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
        if (!accessWithdrawn && savedResult && !writing && !artifactPending) openSaved?.(savedResult.bundleId, event.currentTarget);
    }, "primary");
    root.replaceChildren(header, selectors, actions, status, openResult, savedBack, savedContent, content, reviewHost);
    root.hidden = true;
    const pair = () => ({ baselineId: baseline.value, laterId: later.value });
    const signature = () => JSON.stringify([pair(), timeContext(), draftTitle, resultTextChoice.checked, resultTerms.value]);
    const selectedFormats = () => [...formats.querySelectorAll("input:checked")].map(node => node.value);
    function message(text, error = false) {
        if (!current(generation, publication())) return;
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
        if (!current(generation, publication())) return;
        const issue = preview ? "" : prepareBlockReason?.() || "";
        if (preparationIssue.textContent !== issue) preparationIssue.textContent = issue;
        if (preparationIssue.hidden !== !issue) preparationIssue.hidden = !issue;
        const disabled = writing || artifactPending || Boolean(dispatchedSave) || !comparison || !selectedFormats().length || Boolean(issue);
        if (prepare.disabled !== disabled) prepare.disabled = disabled;
        if (issue) prepare.setAttribute("aria-describedby", preparationIssue.id);
        else prepare.removeAttribute("aria-describedby");
    }
    function paint() {
        if (!current(generation, publication())) return;
        if (dispatchedSave && saveChoices) {
            baseline.value = saveChoices.pair.baselineId;
            later.value = saveChoices.pair.laterId;
            for (const input of formats.querySelectorAll("input")) input.checked = saveChoices.formats.includes(input.value);
        }
        const valid = baseline.value && later.value && baseline.value !== later.value;
        const locked = Boolean(dispatchedSave);
        const reviewing = showingPrepared && Boolean(preview) && !unknownSave;
        const choicesHost = reviewing ? preparedFiles.querySelector(".comparison-inspection-actions") : header;
        if (choicesHost && backChoices.parentElement !== choicesHost) {
            if (choicesHost === header) header.append(backChoices);
            else choicesHost.prepend(backChoices);
        }
        heading.textContent = savedMode ? savedDocumentTitle || "Saved comparison"
            : reviewing ? preview.title || "Review comparison" : savedResult?.title || "Compare saved reports";
        titleInput.value = draftTitle; titleInput.disabled = writing || locked;
        resultTextChoice.disabled = resultTerms.disabled = writing || locked;
        resultTermsField.hidden = !resultTextChoice.checked;
        openResult.hidden = !savedResult || savedResult.available === false || !openSaved || savedMode;
        openResult.disabled = writing || artifactPending;
        backChoices.hidden = !reviewing && !savedResult || savedMode;
        backChoices.textContent = savedResult ? "Compare other reports" : "Back to comparison choices";
        backChoices.disabled = writing || locked;
        header.hidden = reviewing || heading.hidden && backChoices.hidden;
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
        if (!preview) clearPreparedFiles();
        root.setAttribute("aria-busy", String(writing));
        selectors.hidden = savedMode || reviewing || Boolean(savedResult);
        actions.hidden = savedMode || reviewing || Boolean(savedResult) || inspect.hidden && discard.hidden;
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
    async function cancelPrevious(previous, access = publication()) {
        const token = generation;
        if (!current(token, access) || !previous?.previewId) return;
        const previewId = previous.previewId;
        previous = null;
        try { await api("/api/report-comparison/cancel", { previewId }); }
        catch (error) { if (current(token, access)) onError("The old comparison preview could not be cancelled. Do not reuse it. " + error.message); }
    }
    function invalidate(text = "Comparison inputs changed. Compare and review again.", clear = false, { force = false } = {}) {
        if (accessWithdrawn) return false;
        if (dispatchedSave) {
            // Revoking a draft cannot settle or cancel a write already dispatched.
            if (force) {
                preview = comparison = null; approved = false; reviewCheck.checked = false;
                unknownSave = true;
                renderer.clear(content);
                clearPreparedFiles();
            }
            message(pendingSaveMessage(), true);
            paint();
            return false;
        }
        if (writing && !force) return false;
        saveVerifier.invalidatePrepared();
        if (force) writing = false;
        preparing = false;
        savedResult = null;
        generation++;
        const previous = preview;
        preview = null; approved = false; reviewCheck.checked = false;
        showingPrepared = false;
        if (clear) { baseline.value = ""; later.value = ""; draftTitle = ""; resultTextChoice.checked = false; resultTerms.value = ""; comparison = null; unknownSave = false; renderer.clear(content); }
        else if (!comparison) renderer.clear(content);
        cancelPrevious(previous);
        message(text);
        paint();
        return true;
    }
    function changed() {
        if (accessWithdrawn) return;
        if (dispatchedSave) { paint(); return; }
        comparison = null; unknownSave = false;
        invalidate(baseline.value && baseline.value === later.value ? "Choose two different saved reports." : "");
        renderer.clear(content);
    }
    baseline.addEventListener("change", changed); later.addEventListener("change", changed);
    reviewCheck.addEventListener("change", () => { if (!accessWithdrawn) { approved = false; paint(); } });
    async function inspectPair() {
        if (accessWithdrawn || dispatchedSave || inspect.disabled) return;
        onRead?.();
        invalidate("");
        const token = ++generation, access = publication();
        if (!current(token, access)) return;
        pendingSignatures.set(token, signature());
        writing = true; message("Reading the two selected reports..."); paint();
        try {
            const result = await api("/api/report-comparison/inspect", pair());
            if (!current(token, access) || pendingSignatures.get(token) !== signature()) return;
            comparison = result.comparison;
            renderer.render(content, comparison);
            message("");
            content.tabIndex = -1; content.focus({ preventScroll: true });
        } catch (error) { if (current(token, access)) message(error.message, true); }
        finally { pendingSignatures.delete(token); if (current(token, access)) { writing = false; paint(); } }
    }
    async function prepareCopy() {
        if (accessWithdrawn || dispatchedSave || writing || artifactPending) return;
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
        const token = ++generation, access = publication();
        if (!current(token, access)) return;
        pendingSignatures.set(token, signature());
        preparing = writing = true; message("Preparing a comparison copy for your review..."); paint();
        try {
            const result = await api("/api/report-comparison/preview", { ...pair(), ...(draftTitle.trim() ? { title: draftTitle } : {}),
                formats: selectedFormats(), timeContext: timeContext(), ...(resultTextChoice.checked ? { resultText: true,
                    manualTerms: resultTerms.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean) } : {}) });
            if (!current(token, access) || pendingSignatures.get(token) !== signature()) {
                cancelPrevious(result, access); return;
            }
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
            fileInspection?.dispose();
            if (typeof createFileInspection !== "function") throw new Error("Prepared file previews are unavailable in this view.");
            fileInspection = createFileInspection(filePanel, result.files, {
                id: "preparedComparisonFile",
                isCurrent: () => current(token, access) && preview?.previewId === result.previewId,
            });
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
                    onStateChange?.();
                    if (index === 1) doc.defaultView.scrollTo(0, 0);
                    else doc.defaultView.scrollBy(0, tab.getBoundingClientRect().top - top);
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
                controls[0].click();
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
        } catch (error) { if (current(token, access)) message(error.message, true); }
        finally { pendingSignatures.delete(token); if (current(token, access)) { preparing = writing = false; paint(); } }
    }
    async function confirmReview() {
        if (accessWithdrawn || dispatchedSave || approve.disabled || !preview) return;
        writing = true; paint();
        const token = generation, access = publication();
        if (!current(token, access)) { writing = false; return; }
        try {
            const result = await api("/api/report-comparison/review", { previewId: preview.previewId, disclosureReviewed: true, timeContext: timeContext() });
            if (!current(token, access)) return;
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
            message("Reviewed. Not saved yet.");
        } catch (error) { if (current(token, access)) { approved = false; message(error.message + " Prepare a fresh preview if it is no longer current.", true); } }
        finally {
            if (current(token, access)) {
                writing = false; paint();
                if (approved && showingPrepared && !savedMode) save.focus({ preventScroll: true });
            }
        }
    }
    async function saveCopy() {
        if (accessWithdrawn || dispatchedSave || writing || save.disabled || !preview) return;
        const token = generation, access = publication();
        if (!current(token, access)) return;
        writing = true; paint();
        let operation;
        try {
            operation = await saveVerifier.prepareSaveIdentity(preview);
            if (!current(token, access) || !operation) return;
            if (!saveVerifier.dispatched()) throw new Error("Report save authority changed before dispatch.");
        } catch (error) {
            if (current(token, access)) { writing = false; message("Save was not dispatched. " + error.message, true); paint(); }
            return;
        }
        operation.confirmed = false;
        saveChoices = { pair: pair(), formats: selectedFormats() };
        dispatchedSave = operation;
        writing = true; paint(); message("Saving the reviewed comparison...");
        try {
            let result = await api("/api/report-comparison/save", { previewId: operation.previewId, confirmed: true, timeContext: timeContext() });
            if (!current(token, access) || dispatchedSave !== operation) return;
            recoveryEntries = [result?.bundle]; result = null;
            const matches = await saveVerifier.matchesSaveIdentity(recoveryEntries[0]);
            if (!current(token, access) || dispatchedSave !== operation) return;
            if (!matches) throw new Error("The save receipt did not match the dispatched comparison.");
            operation.confirmed = true;
            preview = null; approved = false; reviewCheck.checked = false;
            let entries = await refresh();
            if (!current(token, access) || dispatchedSave !== operation) return;
            if (!Array.isArray(entries)) throw new Error("The saved comparison list could not be read.");
            // The receipt proves the write, not that the saved file still exists.
            const resolved = resolveSave(entries);
            entries = null;
            if (!await resolved && current(token, access)) settleSave(operation, false);
        } catch (error) {
            if (!current(token, access) || dispatchedSave !== operation) return;
            unknownSave = true; approved = false;
            saveVerifier.uncertain();
            message(error.message + " " + pendingSaveMessage(), true);
        } finally { if (current(token, access)) { writing = false; paint(); } }
    }
    function settleSave(operation, available, saved) {
        if (accessWithdrawn || dispatchedSave !== operation) return false;
        savedResult = { bundleId: operation.bundleId, title: saved?.title, available };
        dispatchedSave = null; unknownSave = false;
        saveChoices = recoveryEntries = null; recoveryVersion++;
        saveVerifier.settled();
        preview = comparison = null; approved = false; reviewCheck.checked = false;
        renderer.clear(content);
        message(available ? "Comparison saved locally. Original reports are unchanged." : unavailableResultMessage, !available);
        return true;
    }
    function resolveSave(entries) {
        const operation = dispatchedSave;
        if (accessWithdrawn || !operation || !unknownSave && !operation.confirmed) return false;
        return resolveVerifiedSave(entries);
    }
    async function resolveVerifiedSave(entries) {
        const operation = dispatchedSave, token = generation, access = publication(), version = ++recoveryVersion;
        if (!current(token, access)) return false;
        recoveryEntries = entries;
        entries = null;
        const index = recoveryEntries.findIndex(entry => entry.bundleId === operation.bundleId && entry.kind === "comparison");
        if (index < 0) return false;
        const matches = await saveVerifier.matchesSaveIdentity(recoveryEntries[index]);
        if (!current(token, access) || version !== recoveryVersion || dispatchedSave !== operation || !matches) return false;
        const settled = settleSave(operation, true, recoveryEntries[index]);
        paint();
        return settled;
    }
    function reconcileSave(entries) {
        const token = generation, access = publication();
        const result = resolveSave(entries);
        if (result && typeof result.catch === "function") result.catch(error => {
            if (current(token, access)) { message(error.message + " " + pendingSaveMessage(), true); paint(); }
        });
    }
    async function recoverSave() {
        const operation = dispatchedSave;
        const token = generation, access = publication();
        if (!current(token, access) || !operation || writing || checkingSave || artifactPending) return;
        checkingSave = true; paint();
        try {
            let loaded = await refresh();
            if (!current(token, access) || dispatchedSave !== operation) return;
            if (!Array.isArray(loaded)) throw new Error("The saved comparison list could not be read.");
            const resolved = resolveSave(loaded);
            loaded = null;
            if (await resolved || !current(token, access)) return;
            if (operation.confirmed && settleSave(operation, false)) return;
            message("The original comparison is not in the current saved list. " + pendingSaveMessage(), true);
        } catch (error) {
            if (current(token, access) && dispatchedSave === operation) message(error.message + " " + pendingSaveMessage(), true);
        } finally { if (current(token, access)) { checkingSave = false; paint(); } }
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
        if (!current(generation, publication())) return;
        artifacts = entries;
        choicesLoaded = true;
        const previous = saveChoices?.pair ?? pair();
        const reports = entries.filter(item => item.kind === "report");
        const titleOf = item => item.title?.trim() || "Untitled report";
        const preparedOf = item => item.preparedAtDisplay || item.preparedAt;
        for (const [select, selected] of [[baseline, previous.baselineId], [later, previous.laterId]]) {
            const blank = el("option", "Choose a report"); blank.value = "";
            select.replaceChildren(blank);
            for (const item of reports) {
                const hasNative = Number.isSafeInteger(item.nativeConversationCount) && item.nativeConversationCount >= 0;
                const github = Number.isSafeInteger(item.requestGroupCount) && item.requestGroupCount >= 0
                    ? `${item.requestGroupCount} ${hasNative ? "GitHub " : ""}interaction${item.requestGroupCount === 1 ? "" : "s"}` : "Interaction count unavailable";
                const groups = hasNative ? `${github}; ${item.nativeConversationCount} Microsoft conversation${item.nativeConversationCount === 1 ? "" : "s"}` : github;
                const prepared = preparedOf(item), title = titleOf(item);
                const preparation = prepared ? `Prepared ${prepared}` : "Preparation time unavailable";
                const metadata = [preparation, groups].filter(Boolean);
                const sameTitle = reports.filter(other => titleOf(other) === title);
                const duplicate = sameTitle.length > 1;
                const reference = duplicate && (!prepared || sameTitle.filter(other => preparedOf(other) === prepared).length > 1)
                    ? ` [${item.bundleId.slice(-8)}]` : "";
                const option = el("option", title + (duplicate && prepared ? ` / ${prepared}` : "") + reference);
                option.value = item.bundleId;
                option.dataset.optionLabel = title + reference;
                option.dataset.detail = metadata.join(" / ");
                option.disabled = !["available", "legacy-outcomes-only", "native-frozen-evidence"].includes(item.comparisonEligibility);
                if (option.disabled) {
                    const reason = item.comparisonEligibility === "period-report-has-two-cohorts-not-one-source"
                        ? "two-cohort period report; open directly" : "structured facts unavailable";
                    option.textContent += ` (${reason})`;
                    option.dataset.disabledReason = `${reason}.`;
                }
                select.append(option);
            }
            select.value = selected;
        }
        if (!savedResult && (previous.baselineId && !baseline.value || previous.laterId && !later.value)) {
            if (!dispatchedSave) { writing = false; comparison = null; unknownSave = false; }
            invalidate("A selected report was deleted or is unavailable. Choose current saved reports.", false, { force: Boolean(dispatchedSave) });
            renderer.clear(content);
        }
        reconcileSave(entries);
        if (authoritative) reconcileSavedResult(entries);
        paint();
    }
    async function open(bundleId, { retain = false, focus = true } = {}) {
        if (!current(generation, publication())) return;
        if (retain && (choicesLoaded || choicesLoading)) return;
        if (writing || artifactPending) { message("Wait for the current saved-object operation to finish."); return; }
        root.hidden = false;
        if (focus) focusHeading();
        if (bundleId) {
            savedMode = true; savedArtifactId = bundleId; savedDocumentTitle = ""; heading.textContent = "Saved comparison";
            const token = ++generation, access = publication();
            if (!current(token, access)) return;
            writing = true; message("Reading the saved comparison..."); paint();
            try {
                const result = await api("/api/report-comparison/open", { bundleId });
                if (!current(token, access)) return;
                savedDocumentTitle = result.canonicalTitle || result.artifact?.title || "";
                renderer.render(savedContent, result.comparison);
                message(result.sources?.some(source => source.available === false)
                    ? "An original report is unavailable. This saved comparison is unchanged." : "");
            } catch (error) { if (current(token, access)) message(error.message, true); }
            finally { if (current(token, access)) { writing = false; paint(); } }
            return;
        }
        savedMode = false; heading.textContent = "Compare saved reports"; paint();
        choicesLoading = true;
        const inventory = inventoryVersion;
        const token = generation, access = publication();
        if (!current(token, access)) { choicesLoading = false; return; }
        try {
            const result = await api("/api/report-artifacts/list", {});
            if (!current(token, access)) return;
            if (!Array.isArray(result.artifacts)) throw new Error("Saved report choices are unavailable.");
            if (inventory !== inventoryVersion) {
                choicesLoaded = false;
                throw new Error("Saved reports changed while their choices were loading. Return to Reports and reopen comparison choices.");
            }
            const pending = dispatchedSave;
            receive(result.artifacts);
            if (pending && !dispatchedSave) return;
            message(dispatchedSave ? pendingSaveMessage() : savedResult?.available === false ? unavailableResultMessage
                : result.artifacts.filter(item => item.kind === "report" && ["available", "legacy-outcomes-only", "native-frozen-evidence"].includes(item.comparisonEligibility)).length < 2
                    ? "Two saved reports with comparison data are needed." : "");
        } catch (error) { if (current(token, access)) message(error.message, true); }
        finally { if (current(token, access)) choicesLoading = false; }
    }
    function invalidateSavedReport(bundleId) {
        if (accessWithdrawn) return;
        const currentPair = saveChoices?.pair ?? pair();
        if (!savedResult && [currentPair.baselineId, currentPair.laterId].includes(bundleId)) {
            if (!dispatchedSave) { writing = false; comparison = null; }
            invalidate("An input report was deleted. This unfinished comparison is no longer valid.", true, { force: Boolean(dispatchedSave) });
        }
        if (savedResult?.bundleId === bundleId) reconcileSavedResult([]);
        // Cached choices need not contain a comparison saved after they were loaded.
        receive(artifacts.filter(item => item.bundleId !== bundleId), false);
    }
    function syncPresence(entries) {
        if (!current(generation, publication())) return;
        const ids = new Set(entries.map(entry => entry.bundleId));
        if (!inventoryIds || ids.size !== inventoryIds.size || [...ids].some(id => !inventoryIds.has(id))) { inventoryIds = ids; inventoryVersion++; }
        if (savedMode && savedArtifactId && !ids.has(savedArtifactId)) {
            renderer.clear(savedContent);
            message("This saved comparison was deleted. Its source reports are unchanged.");
        }
        for (const item of artifacts) if (!ids.has(item.bundleId)) invalidateSavedReport(item.bundleId);
        if (entries.some(entry => !artifacts.some(item => item.bundleId === entry.bundleId))) choicesLoaded = false;
        reconcileSave(entries);
        reconcileSavedResult(entries);
        artifactPending = false; paint();
    }
    function pendingArtifactCleanup() {
        if (!current(generation, publication())) return;
        artifactPending = true;
        message("Saved-object cleanup is pending. " + (dispatchedSave ? pendingSaveMessage() : "Comparison actions will resume after the saved list is current."));
        paint();
    }
    function withdrawAccess() {
        if (accessWithdrawn) return;
        accessWithdrawn = true; generation++; recoveryVersion++; inventoryVersion++;
        saveVerifier.withdrawAccess();
        if (dispatchedSave) { dispatchedSave = { ...saveVerifier.saveIdentity(), confirmed: dispatchedSave.confirmed }; unknownSave = true; }
        pendingSignatures.clear();
        preview = comparison = savedResult = null; artifacts = [];
        saveChoices = recoveryEntries = inventoryIds = null;
        draftTitle = savedDocumentTitle = ""; savedArtifactId = null;
        approved = writing = checkingSave = showingPrepared = preparing = choicesLoaded = choicesLoading = savedMode = artifactPending = false;
        for (const frame of root.querySelectorAll("iframe")) { frame.srcdoc = ""; frame.title = ""; frame.removeAttribute("src"); }
        for (const text of preparedFiles.querySelectorAll("pre")) text.textContent = "";
        clearPreparedFiles(); renderer.clear(content); renderer.clear(savedContent);
        titleInput.value = ""; reviewCheck.checked = false; resultTextChoice.checked = false; resultTerms.value = "";
        baseline.replaceChildren(); later.replaceChildren();
        for (const { identity } of identities.values()) { identity.hidden = true; }
        status.textContent = ""; preparationIssue.textContent = "";
        heading.textContent = "Compare saved reports";
        root.hidden = true;
    }
    function resumeAccess() {
        if (!saveVerifier.resumeAccess()) return false;
        if (!accessWithdrawn) return true;
        accessWithdrawn = false; generation++;
        if (dispatchedSave) message(pendingSaveMessage(), true);
        paint();
        return true;
    }
    paint();
    return { open, receive, syncPresence, pendingArtifactCleanup, invalidate, invalidateSavedReport, syncPreparation,
        withdrawAccess, resumeAccess, recoverSave, saveIdentity: () => saveVerifier.saveIdentity(),
        title: () => heading.textContent,
        isBusy: () => writing, hasPendingSave: () => Boolean(dispatchedSave), hasPreviewWork: () => Boolean(preview) || preparing };
}
