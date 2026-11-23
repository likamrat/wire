// Screen copy only: file names, format values and saved report bytes are unchanged.
export const reportFileChoices = {
    html: { name: "HTML", purpose: "Web page" },
    pdf: { name: "PDF", purpose: "Print document" },
    markdown: { name: "Markdown", purpose: "Editable text" },
    json: { name: "JSON", purpose: "Structured data" },
};

export function reportWorkspacePresentation(route, journey = {}) {
    const saved = Boolean(route.bundle);
    const prepared = !saved && (route.task === "create" && journey.step === 3 || journey.saveUnconfirmed === true);
    return { landing: !saved && !prepared, prepared, saved };
}

// Presentation only. The existing report draft, preparation and Save owners retain authority.
export function createReportExperience({ root, time, ux, read, choose, changeDates, changeFocus, openDeskActivity, closePreview, current, createCalendar, selectNamed, deleteNamed }) {
    const doc = root.ownerDocument, byId = id => doc.getElementById(id);
    const presets = [
        ["all", "All activity"], ["errors", "Errors & failures"],
        ["completed", "Completed calls"], ["mine", "Human prompts"], ["agent", "Agent prompts"],
    ];
    const help = {
        all: "",
        errors: "Compare interactions with a failed call or a recorded error against all eligible interactions. A completed call can contain an API error.",
        completed: "All calls completed without a recorded error. The answer can still be wrong.",
        mine: "Started by you, including any calls made by an agent.",
        agent: "Started by an agent. Unknown authors are excluded.",
    };
    function el(tag, cls, text) {
        const node = doc.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    function button(label, action, cls = "quiet") {
        const node = el("button", cls, label); node.type = "button";
        node.addEventListener("click", event => { if (node.isConnected && current() && !node.disabled) action(event); });
        return node;
    }
    function popover(id, title) {
        const panel = el("section", "report-options-popover"); panel.id = id;
        panel.setAttribute("popover", "auto"); panel.setAttribute("role", "dialog");
        const heading = el("h2", "", title); heading.id = id + "Title";
        panel.setAttribute("aria-labelledby", heading.id); panel.append(heading); root.append(panel);
        return panel;
    }
    function opener(label, panel) {
        const control = button(label, () => {}, "report-toolbar-choice");
        ux.anchoredChoices(panel);
        control.setAttribute("popovertarget", panel.id); control.append(ux.icon("chevron"));
        return control;
    }
    function done(panel) {
        const row = el("div", "report-popover-actions");
        row.append(button("Done", () => panel.hidePopover())); panel.append(row);
    }
    function closeOptions() {
        closeDelete();
        for (const panel of root.querySelectorAll(".report-options-popover:popover-open")) panel.hidePopover();
    }
    const gallery = el("section", "report-gallery"); gallery.id = "reportGallery";
    let deskFocus = "all";
    function selectField(id, caption) {
        const field = el("div", "report-form-field"), label = el("label", "", caption), select = el("select");
        label.htmlFor = select.id = id;
        field.append(label, select);
        return { field, select };
    }
    const { field: compactLabel, select: compactFocus } = selectField("reportDeskFocus", "Show");
    compactFocus.addEventListener("change", () => { if (current() && !read().locked) { deskFocus = compactFocus.value; sync(); } });
    for (const [id, title] of presets) {
        const option = el("option", "", title); option.value = id; compactFocus.append(option);
    }
    const desk = el("div", "report-desk"), outlineDescription = el("p", "report-outline-description");
    const outlineChoices = el("div", "report-outline-choices"), outlineAction = el("div", "report-outline-action");
    const prepare = button("Prepare preview", event => choose(compactFocus.value, event.currentTarget), "primary icon-action"); prepare.id = "prepareReportPreview";
    const prepareLabel = prepare.firstChild;
    prepare.prepend(ux.icon("read"));
    const prepareHint = el("p", "report-desk-hint"); prepareHint.id = "reportDeskHint"; prepareHint.setAttribute("role", "status");
    const scopeChoice = button("", () => { openDeskActivity(); showSelection(); }, "report-toolbar-choice");
    const scopeName = el("span"); scopeChoice.append(scopeName, ux.icon("chevron"));
    scopeChoice.id = "reportDeskActivity";
    const optionsRow = (label, node) => {
        const row = el("div", "report-outline-row"), caption = el("span", "report-outline-key", label);
        row.append(caption, node); return row;
    };
    const treatment = el("div", "report-before-prepare");
    const draftChoices = el("div", "report-draft-fields");
    const { field: namedRow, select: namedSelect } = selectField("namedReportDraft", "Report draft");
    const management = el("div", "report-draft-management");
    const deleteButton = button("Delete draft", reviewDelete, "quiet danger");
    management.append(namedSelect, deleteButton); namedRow.append(management);
    let deleteDecision;
    function closeDelete() {
        if (!deleteDecision) return;
        deleteDecision.querySelector("h2").firstChild.data = "";
        deleteDecision.close(); deleteDecision.remove(); deleteDecision = null;
    }
    function reviewDelete() {
        const { namedReport, draftCatalog } = read();
        const target = draftCatalog?.drafts.find(d => d.id === namedReport?.id);
        if (!target || deleteDecision) return;
        const dialog = deleteDecision = el("dialog", "deletion-dialog decision-frame");
        dialog.dataset.decisionKind = "destructive";
        dialog.dataset.decisionPhase = "confirm";
        const heading = el("div", "delete-heading"), title = el("h2", "", `Delete “${target.name}”?`);
        title.id = "deleteNamedDraftTitle"; heading.append(title); dialog.setAttribute("aria-labelledby", title.id);
        const body = el("div", "decision-body");
        body.append(el("p", "", "You can't undo this. WIRE keeps your activity, other drafts and all saved report files."));
        body.id = "deleteNamedDraftScope"; dialog.setAttribute("aria-describedby", body.id);
        const footer = el("div", "delete-actions"), cancel = button("Cancel", closeDelete);
        const confirm = button("Delete draft", async () => {
            cancel.disabled = confirm.disabled = true;
            try { await deleteNamed(target.id, draftCatalog); }
            finally {
                if (deleteDecision === dialog) {
                    closeDelete();
                    (deleteButton.checkVisibility() ? deleteButton : !namedRow.hidden ? byId("namedReportDraft-control") : scopeChoice)?.focus({ preventScroll: true });
                }
            }
        }, "danger");
        confirm.dataset.decisionAction = "commit";
        dialog.oncancel = event => { event.preventDefault(); if (!confirm.disabled) closeDelete(); };
        footer.append(cancel, confirm); dialog.append(heading, body, footer); root.append(dialog);
        dialog.showModal(); cancel.focus();
    }
    let optionSignature;
    let replacePrompt = null;
    namedSelect.onchange = () => {
        const value = read(), id = namedSelect.value;
        if (!current() || namedSelect.disabled) return;
        if (!value.resumePreset) { selectNamed(id); return; }
        namedSelect.value = value.namedReport?.id ?? "";
        replacePrompt?.remove();
        replacePrompt = el("div", "context-help-note");
        replacePrompt.append(el("p", "", "Switch draft and discard the unfinished preview? Saved reports will not change."),
            button("Switch draft", () => { replacePrompt.remove(); replacePrompt = null; selectNamed(id); }),
            button("Keep preview", () => { replacePrompt.remove(); replacePrompt = null; byId("namedReportDraft-control")?.focus(); }));
        namedRow.after(replacePrompt);
        queueMicrotask(() => { if (current() && replacePrompt?.isConnected) replacePrompt.querySelector("button").focus(); });
    };
    desk.append(namedRow, draftChoices, outlineDescription, outlineChoices, treatment, outlineAction, prepareHint);
    gallery.append(el("h2", "", "New report"), desk);
    const stage = byId("reportStage1"), selection = popover("reportActivityOptions", "Choose activity");
    selection.classList.add("report-explicit-selection");
    const selectionHeader = el("header", "report-selection-header"), selectionBody = el("div", "report-selection-body");
    const closeSelection = button("Close", () => {
        selection.hidePopover();
        (read().prepared ? refineButton : scopeChoice).focus({ preventScroll: true });
    });
    selectionHeader.append(selection.firstElementChild, closeSelection);
    for (const node of [...stage.children]) if (node.id !== "reportStepTitle1" && node.id !== "reportActivityActions") selectionBody.append(node);
    selection.append(selectionHeader, selectionBody, byId("reportActivityActions"));
    selection.addEventListener("toggle", event => {
        if (event.newState === "closed" && doc.activeElement === doc.body && current()) (read().prepared ? refineButton : scopeChoice).focus({ preventScroll: true });
    });
    stage.append(gallery); byId("reportStepTitle1").hidden = true;
    byId("reportContinue").textContent = "Show report";
    byId("reportContinue").addEventListener("click", () => selection.hidePopover());
    byId("exportBtn").addEventListener("click", () => selection.hidePopover());
    const toolbar = el("section", "report-edit-toolbar"); toolbar.id = "reportEditToolbar"; toolbar.hidden = true;
    const nameRow = el("div", "report-name-row");
    nameRow.append(root.querySelector(".report-title-field"));
    const saveSlot = el("div", "report-save-slot"); saveSlot.id = "reportSaveSlot"; nameRow.append(saveSlot);
    const choices = el("div", "report-toolbar-choices");
    const periodPanel = popover("reportPeriodChoices", "Dates");
    const dateButton = el("button");
    dateButton.id = "reportDeskDates";
    const privacy = popover("reportPrivacyOptions", "Report text");
    const promptOptions = byId("promptOptions"), legend = promptOptions.querySelector("legend");
    legend.after(promptOptions.querySelector('[value="masked"]').closest("label"));
    for (const input of promptOptions.querySelectorAll("input")) {
        const row = input.closest("label"); row.dataset.promptMode = input.value;
        row.querySelector("strong").prepend(ux.icon("report-" + input.value));
    }
    privacy.append(byId("additionalMasking")); done(privacy);
    const privacyButton = opener("Mask detected details", privacy);
    privacyButton.id = "reportPrivacyChoice";
    privacyButton.setAttribute("aria-describedby", "reportPrivacyHint");
    const privacyGroup = el("div", "report-privacy-control"), privacyRow = el("div", "report-toolbar-group");
    const privacyLabel = el("label", "", "Report text"); privacyLabel.htmlFor = privacyButton.id;
    const privacyHint = el("p", "report-privacy-hint"); privacyHint.id = "reportPrivacyHint";
    privacyRow.append(privacyLabel, privacyButton); privacyGroup.append(privacyRow, privacyHint);
    let privacyMode;
    const formats = popover("reportFileOptions", "Formats");
    formats.firstElementChild.classList.add("visually-hidden");
    const formatOptions = byId("formatOptions");
    formats.append(formatOptions);
    const formatButton = opener("HTML", formats);
    const formatLabel = formatButton.firstChild;
    formatButton.prepend(ux.icon("report-files"));
    const refine = popover("reportIncludeOptions", "Choose what to include");
    const author = root.querySelector(".report-author-choice");
    refine.append(author);
    function select(id, label, entries) {
        const field = el("div", "report-field"), caption = el("label", "", label), control = el("select");
        caption.htmlFor = id; control.id = id;
        for (const [value, text] of entries) { const option = el("option", "", text); option.value = value; control.append(option); }
        field.append(caption, control); refine.append(field); return control;
    }
    const outcome = select("reportOutcome", "Calls to include", [
        ["all", "All calls"], ["errors", "With errors or failures"], ["completed", "Completed, no recorded errors"], ["unknown", "Outcome unknown"],
    ]);
    const service = select("reportService", "Service", [["", "All services"], ...read().services.map(value => [value, value])]);
    outcome.addEventListener("change", () => { if (current()) changeFocus({ outcome: outcome.value }); });
    service.addEventListener("change", () => { if (current()) changeFocus({ services: service.value ? [service.value] : [] }); });
    refine.append(byId("reportResultText").closest("label"), byId("reportRecordedContext").closest("label"), byId("reportRecordedContextHelp"));
    const scope = button("Change activity selection", () => { refine.hidePopover(); showSelection(); });
    refine.append(scope); done(refine);
    const refineButton = opener("Change what's included", refine);
    const formatGroup = el("div", "report-toolbar-group");
    formatGroup.append(formatButton);
    choices.append(dateButton, formatGroup, refineButton, privacyGroup);
    const datesRow = optionsRow("Dates", dateButton), fileRow = optionsRow("Formats", formatGroup);
    draftChoices.append(compactLabel, datesRow);
    const activityRow = optionsRow("Activity source", scopeChoice), draftMembership = el("span", "report-draft-membership");
    activityRow.append(draftMembership);
    outlineChoices.append(activityRow, fileRow);
    outlineAction.append(prepare);
    const useActivity = button("Use activity", () => { selection.hidePopover(); scopeChoice.focus({ preventScroll: true }); }, "primary");
    byId("reportActivityActions").append(useActivity);
    const scopeCaption = el("p", "report-period-caption"); scopeCaption.id = "reportExperienceScope";
    toolbar.append(nameRow, choices, scopeCaption);
    byId("reportStage3").prepend(toolbar);
    // Keep the prepared reader mounted: moving its iframe between hosts would reload its document.
    const drawer = el("dialog", "report-preview-drawer"); drawer.id = "reportPreviewDrawer";
    const drawerHeader = el("header", "report-drawer-header"), drawerTitle = el("h2", "", "Report preview");
    drawerTitle.id = "reportDrawerTitle"; drawerTitle.tabIndex = -1;
    drawer.setAttribute("aria-labelledby", drawerTitle.id);
    const backSlot = el("div", "report-drawer-back");
    drawerHeader.append(drawerTitle, backSlot);
    const previewStage = byId("reportStage3"), errors = byId("reportJourneyError"), retry = errors.nextElementSibling;
    const messageAnchor = doc.createComment("report messages"); errors.before(messageAnchor);
    const background = el("section", "report-draft-background");
    background.append(el("h2", "", "New report"));
    const backgroundScope = el("p"); background.append(backgroundScope);
    background.hidden = true;
    previewStage.before(background);
    const activityNotice = el("p", "muted", "Recorded activity has changed. This preview still shows the activity it was prepared with.");
    activityNotice.id = "reportPreviewActivityNotice"; activityNotice.hidden = true; activityNotice.setAttribute("role", "status");
    previewStage.before(drawer); drawer.append(drawerHeader, activityNotice, previewStage);
    drawer.addEventListener("cancel", event => {
        event.preventDefault();
        if (current() && !read().locked) closePreview();
    });
    const narrow = doc.defaultView.matchMedia("(max-width: 62em)");
    const openDrawer = () => narrow.matches ? drawer.showModal() : drawer.show();
    narrow.addEventListener("change", () => {
        if (!drawer.open || drawer.matches(":modal") === narrow.matches) return;
        const focus = drawer.contains(doc.activeElement) ? doc.activeElement : drawerTitle;
        const openPanels = [...drawer.querySelectorAll(":popover-open")];
        drawer.close(); openDrawer();
        for (const panel of openPanels) panel.showPopover();
        focus.focus({ preventScroll: true });
    });

    const calendar = el("div"); calendar.id = "reportCustomDates"; calendar.hidden = true;
    periodPanel.firstElementChild.classList.add("visually-hidden");
    periodPanel.append(calendar);
    const calendarEditor = createCalendar({ root: calendar, id: "reportDate", inputIds: { from: "reportDatefrom", to: "reportDateto" }, time, ux,
        context: () => read().timeContext, current, onChange: () => { applyDates.disabled = !calendarEditor.valid(); } });
    const calendarActions = el("div", "report-popover-actions");
    const applyDates = button("Apply dates", () => {
        if (!calendarEditor.valid()) return;
        const dates = calendarEditor.value(); datePicker.close(); changeDates({ range: "custom", ...dates });
    }, "primary");
    calendarActions.append(button("Cancel", () => datePicker.close()), applyDates);
    calendar.append(calendarActions);
    const datePicker = ux.datesPicker({ panel: periodPanel, trigger: dateButton, editor: calendar, optionKey: "reportRange",
        current: () => current() && !read().locked && !read().nativeScope && !read().paired && !read().unavailable,
        selected: () => read().dates.range, onClose: () => calendarEditor.clear(),
        onPreset: range => changeDates({ range, ...time.preset(range, read().timeContext.timeZone) }),
        onCustom() {
            const value = read();
            calendarEditor.reset(value.dates.range === "capture" ? time.preset("7", value.timeContext.timeZone) : value.dates);
        } });
    function openCalendar() { datePicker.expand(); }
    function showSelection() {
        if (read().locked) return;
        selection.showPopover();
        selection.querySelector('input[name="reportScope"]:checked')?.focus();
    }
    function selectionReturn(row) {
        if (!selection.matches(":popover-open") || !row || !selection.contains(row)) return null;
        const origin = row.querySelector("[data-card-origin]") ?? row.querySelector(".request-card-open");
        if (!origin) return null;
        const target = new WeakRef(origin), top = selectionBody.scrollTop;
        return () => {
            const link = target.deref();
            if (!current() || read().locked || !(read().prepared ? refineButton : scopeChoice).checkVisibility() || !link || !selection.contains(link)) return;
            selection.showPopover();
            selectionBody.scrollTop = top;
            ux.restoreFocus(link);
        };
    }
    function labelDates(value) {
        if (value.range === "capture") return "All retained dates";
        const context = read().timeContext, civil = bound => bound?.length === 10;
        const label = bound => civil(bound) ? time.formatDate(bound, context, true) : time.formatTime(bound, context);
        if (!value.from) return value.to ? `Through ${label(value.to)}` : "All retained dates";
        if (!value.to) return `From ${label(value.from)}`;
        return civil(value.from) && civil(value.to) ? time.formatCivilRange(value.from, value.to, context)
            : value.from === value.to ? label(value.from) : `${label(value.from)} to ${label(value.to)}`;
    }
    function sync() {
        if (!current()) return;
        const value = read();
        const draftOptions = value.draftCatalog?.drafts ?? [];
        namedRow.hidden = !draftOptions.length || value.prepared;
        namedSelect.disabled = value.locked || value.loading;
        deleteButton.hidden = !draftOptions.some(d => d.id === value.namedReport?.id);
        deleteButton.disabled = namedSelect.disabled;
        const signature = JSON.stringify([value.timeContext.locale, value.timeContext.timeZone, draftOptions.map(d => [d.id, d.name, d.revision, d.createdAt])]);
        if (signature !== optionSignature) {
            optionSignature = signature;
            namedSelect.replaceChildren(new Option("New report", ""), ...draftOptions.map(d => {
                const option = new Option(d.name, d.id);
                if (d.createdAt) option.dataset.detail = "Created " + time.formatDate(d.createdAt, value.timeContext, true);
                return option;
            }));
        }
        namedSelect.value = value.namedReport?.id ?? "";
        toolbar.hidden = !value.prepared;
        gallery.hidden = value.paired && value.prepared;
        if (privacyGroup.parentElement !== choices) choices.append(privacyGroup);
        const privacyHost = value.prepared ? privacy : treatment;
        if (promptOptions.parentElement !== privacyHost) privacyHost.prepend(promptOptions);
        legend.classList.toggle("visually-hidden", value.prepared);
        legend.textContent = value.prepared ? "Report text" : "Chat details in this report";
        if (value.prepared) {
            if (dateButton.parentElement !== choices) choices.prepend(dateButton);
            if (formatGroup.parentElement !== choices) dateButton.after(formatGroup);
        } else {
            if (dateButton.parentElement !== datesRow) datesRow.append(dateButton);
            if (formatGroup.parentElement !== fileRow) fileRow.append(formatGroup);
        }
        selection.dataset.desk = String(!value.prepared);
        useActivity.hidden = value.prepared;
        byId("additionalMasking").hidden = !value.prepared;
        if (doc.activeElement !== byId("manualTerms")) byId("manualTerms").value = value.options.manualTerms.join("\n");
        datePicker.sync();
        const focus = value.nativeScope ? "all" : deskFocus;
        compactFocus.disabled = value.locked || value.loading || value.nativeScope; compactFocus.value = focus;
        outlineDescription.textContent = value.nativeScope ? "Includes retained Microsoft conversations. Use Compare to report on two date ranges." : help[focus];
        outlineDescription.hidden = !outlineDescription.textContent;
        scopeName.textContent = value.scopeLabel;
        scopeChoice.setAttribute("aria-label", "Activity source: " + value.scopeLabel);
        scopeChoice.disabled = prepare.disabled = value.locked || value.loading;
        scopeChoice.disabled ||= Boolean(value.namedReport);
        scopeChoice.hidden = Boolean(value.namedReport);
        draftMembership.hidden = !value.namedReport;
        prepare.disabled ||= !value.options.formats.length;
        const named = value.namedReport && draftOptions.find(d => d.id === value.namedReport.id);
        draftMembership.textContent = !value.namedReport ? "" : !named || named.unavailable ? "Draft selection unavailable"
            : `${named.scenarioIds.length} ${named.scenarioIds.length === 1 ? "interaction" : "interactions"} in this draft`;
        const updated = value.namedReport && named?.revision !== value.namedReport.revision;
        const resume = !updated && value.resumePreset === focus;
        prepareLabel.data = resume ? "Resume preview" : updated ? "Prepare updated draft" : "Prepare preview";
        const scopeIssue = !resume && (value.namedReport ? !named?.scenarioIds.length || named.unavailable
            ? "This draft has no complete available selection. Choose another draft or update its interactions." : "" : value.explicitScope && value.scopeIssue);
        prepare.disabled ||= Boolean(scopeIssue);
        prepareHint.textContent = value.locked ? "Finish or check the current save before preparing another report."
            : value.unavailable ? "Waiting for activity to load." : !value.options.formats.length ? "Choose at least one file format to preview the report." : scopeIssue || "";
        prepareHint.hidden = !prepareHint.textContent;
        if (prepareHint.hidden) prepare.removeAttribute("aria-describedby"); else prepare.setAttribute("aria-describedby", prepareHint.id);
        datePicker.showRange(labelDates(value.dates));
        dateButton.hidden = value.paired;
        const mode = value.options.promptMode;
        backgroundScope.textContent = value.paired ? "Period comparison" : `${compactFocus.selectedOptions[0].textContent} · ${labelDates(value.dates)}`;
        if (privacyMode !== mode) {
            privacyMode = mode;
            privacyButton.replaceChildren(ux.icon("report-" + mode),
                doc.createTextNode(({ masked: "Mask detected details", original: "Keep chat details", none: "Leave out prompts and replies" })[mode]),
                ux.icon("chevron"));
        }
        privacyButton.dataset.promptMode = mode;
        privacyButton.setAttribute("aria-label", "Report text: " + privacyButton.textContent);
        privacyHint.textContent = value.preparing ? "Updating the report. Save is unavailable."
            : ({ masked: "Masking can miss names and sensitive wording.",
                original: "Personal details may be included. Detected credentials are still removed.",
                none: "Calls and counts stay. Notes and error messages may still contain personal details." })[mode];
        const formatSummary = [...formatOptions.querySelectorAll("label")].filter(row =>
            value.options.formats.includes(row.querySelector("input").value)).map(row => row.textContent.trim()).join(", ") || "None";
        formatLabel.data = value.prepared ? "Formats: " + formatSummary : formatSummary;
        formatButton.setAttribute("aria-label", "Formats: " + formatSummary);
        formatGroup.hidden = value.prepared && value.saved;
        privacyButton.classList.toggle("chat-details-kept", value.options.promptMode === "original");
        outcome.value = value.options.reportFocus?.outcome ?? "all"; service.value = value.options.reportFocus?.services[0] ?? "";
        outcome.disabled = service.disabled = value.locked || !value.options.reportFocus;
        scopeCaption.textContent = value.paired ? "" : value.scopeLabel;
        scope.hidden = Boolean(value.namedReport);
        scopeCaption.hidden = !scopeCaption.textContent;
        for (const control of choices.querySelectorAll("button")) control.disabled = value.locked;
        formatButton.disabled = value.locked || value.unavailable;
        dateButton.disabled = formatButton.disabled || value.nativeScope;
        privacyButton.disabled = value.locked || value.unavailable;
        const save = byId("reportSaveActions");
        if (save && save.parentElement !== saveSlot) saveSlot.append(save);
        promptOptions.disabled = value.locked || value.unavailable;
        for (const input of promptOptions.querySelectorAll("input")) input.checked = input.value === value.options.promptMode;
        for (const input of byId("formatOptions").querySelectorAll("input")) input.checked = value.options.formats.includes(input.value);
    }
    function syncDrawer(open, title) {
        background.hidden = !open;
        if (open) {
            drawerTitle.textContent = title;
            if (!drawer.open) {
                drawerHeader.after(errors, retry);
                for (const panel of [privacy, formats, refine, periodPanel, selection]) drawer.append(panel);
                openDrawer();
                drawerTitle.focus({ preventScroll: true });
            }
        } else if (drawer.open) {
            closeOptions(); drawer.close();
            messageAnchor.after(errors, retry);
            for (const panel of [privacy, formats, refine, periodPanel, selection]) root.append(panel);
        }
    }
    return {
        sync, syncDrawer, backSlot, openCalendar, showSelection, selectionReturn,
        hasDeskDraft: () => deskFocus !== "all" || periodPanel.matches(":popover-open") && !calendar.hidden,
        resetDeskFocus() { deskFocus = "all"; },
        closeOptions,
        withdrawAccess() {
            optionSignature = undefined; namedSelect.replaceChildren(); namedRow.hidden = true;
            draftMembership.textContent = "";
            replacePrompt?.remove(); replacePrompt = null;
            syncDrawer(false);
            closeOptions();
            deskFocus = "all";
            calendarEditor.clear();
            datePicker.showRange("");
            scopeCaption.textContent = scopeName.textContent = "";
            backgroundScope.textContent = "";
            scopeChoice.removeAttribute("aria-label");
        },
        resumeAccess: sync,
    };
}

export function decoratePreparedReport(source, { host = document, preview, notes, onNote, onCopy, current, refresh }) {
    const style = source.createElement("style");
    style.textContent = `
html,body{background:var(--report-sheet);color:var(--ink)}main{background:transparent}
:root{--font:var(--screen-font)}h1,h2,h3,h4,p,table,pre{color:inherit}
.report-author-note,.reading-notes{background:var(--report-note)}
.wire-example-editor{margin:20px 0;padding-top:12px;border-top:1px solid var(--rule);font-family:var(--font);background:transparent}
.wire-example-editor summary{cursor:pointer;min-height:44px;align-content:center;color:var(--muted)}
.wire-example-editor label{display:block;margin:16px 0 10px}
.wire-example-editor textarea{display:block;width:100%;box-sizing:border-box;min-height:90px;padding:12px;border:1px solid var(--rule);border-radius:8px;background:var(--report-note);color:var(--ink);font:inherit;line-height:1.6;resize:vertical}
.wire-example-editor button{min-height:44px;padding:8px 14px;margin:12px 8px 0 0;border:1px solid var(--rule);border-radius:8px;background:var(--report-note);color:var(--ink);font:inherit;cursor:pointer}
.wire-example-editor :focus-visible{outline:2px solid var(--focus);outline-offset:3px}
.wire-example-editor .wire-omit{display:flex;align-items:center;gap:8px;min-height:44px}
`;
    source.head.append(style);
    if (preview.snapshot?.presentation?.productVersion === 1) {
        source.querySelector("main>.report-facts")?.remove();
    }
    function theme() {
        if (!current()) return;
        const values = host.defaultView.getComputedStyle(host.documentElement), dark = host.documentElement.dataset.evidenceTheme === "dark";
        source.documentElement.dataset.evidenceTheme = dark ? "dark" : "light";
        for (const key of ["ink", "muted", "rule", "control", "focus", "danger", "warning", "chart-success"]) source.documentElement.style.setProperty("--" + key, values.getPropertyValue("--" + key));
        // The editable screen copy can adopt chart inks. Never inject into a saved original.
        const alternate = host.documentElement.dataset.evidencePalette && host.documentElement.dataset.evidencePalette !== "petrol";
        for (const key of values) {
            if (!/^--chart-(?:service-|teal-|pink-|cyan-|orange-|slate-|violet-)/.test(key)) continue;
            if (alternate) source.documentElement.style.setProperty(key, values.getPropertyValue(key));
            else source.documentElement.style.removeProperty(key);
        }
        source.documentElement.style.setProperty("--screen-font", values.getPropertyValue("--font"));
        source.documentElement.style.setProperty("--report-sheet", values.getPropertyValue("--report-sheet"));
        source.documentElement.style.setProperty("--report-note", values.getPropertyValue("--report-note"));
        refresh();
    }
    const observer = new host.defaultView.MutationObserver(theme);
    observer.observe(host.documentElement, { attributes: true, attributeFilter: ["data-evidence-theme", "data-evidence-palette", "style", "class"] }); theme();
    for (const group of source.querySelectorAll(".wire-reading-section")) {
        const section = group.querySelector(":scope>section[id]");
        if (section) group.id = "reading-" + section.id;
    }
    for (const section of source.querySelectorAll("[data-report-scenario]")) {
        const id = section.dataset.reportScenario;
        const group = section.closest(".wire-reading-interaction");
        if (group) group.id = "reading-" + id;
        const record = preview.records.find(record => record.scenarioId === id);
        const editor = source.createElement("details"); editor.className = "wire-example-editor"; editor.id = "editor-" + id;
        const summary = source.createElement("summary"); summary.textContent = "Add a note or edit this example"; editor.append(summary);
        const label = source.createElement("label"), note = source.createElement("textarea");
        label.textContent = "Your note"; note.id = "note-" + id; label.htmlFor = note.id;
        note.setAttribute("placeholder", "What you expected, or why this matters");
        note.value = notes.find(entry => entry.scenarioId === id)?.text ?? "";
        const save = source.createElement("button"); save.type = "button"; save.textContent = "Update note";
        save.id = "update-note-" + id;
        save.addEventListener("click", () => { if (current() && save.isConnected) onNote(id, note.value); });
        editor.append(label, note, save);
        const copy = preview.promptReview?.find(copy => record?.prompts.some(prompt => prompt.key === copy.key) && copy.kind === "origin");
        if (copy && preview.promptMode !== "none" && copy.original !== null) {
            const copyKey = copy.key, copyLabel = source.createElement("label"), input = source.createElement("textarea");
            input.id = "copy-" + id; copyLabel.htmlFor = input.id; copyLabel.textContent = "Prompt in this report";
            input.value = copy.text ?? ""; input.disabled = copy.omitted;
            const omitLabel = source.createElement("label"), omit = source.createElement("input");
            omit.type = "checkbox"; omit.checked = copy.omitted; omitLabel.className = "wire-omit";
            omit.addEventListener("change", () => { input.disabled = omit.checked; });
            omitLabel.append(omit, source.createTextNode("Leave out this prompt"));
            const apply = source.createElement("button"); apply.type = "button"; apply.textContent = "Update prompt copy";
            apply.id = "update-copy-" + id;
            apply.addEventListener("click", () => { if (current() && apply.isConnected) onCopy(copyKey, input.value, omit.checked); });
            editor.append(copyLabel, input, omitLabel, apply);
        }
        section.append(editor);
    }
    preview = null; notes = null;
    return () => observer.disconnect();
}

export function createReportSaveWarning({ doc = document, icon, current }) {
    let dialog = null, settle = null, trigger = null;
    function close(choice = null) {
        const resolve = settle; settle = null;
        if (dialog) { dialog.close(); dialog.remove(); dialog = null; }
        if (current() && trigger?.isConnected) trigger.focus({ preventScroll: true });
        trigger = null; resolve?.(choice);
    }
    return {
        choose(formats = []) {
            if (dialog || !current()) return Promise.resolve(null);
            trigger = doc.activeElement;
            dialog = doc.createElement("dialog"); dialog.className = "report-save-warning";
            dialog.setAttribute("aria-labelledby", "reportSaveWarningTitle"); dialog.setAttribute("aria-describedby", "reportSaveWarningCopy");
            const title = doc.createElement("h2"); title.id = "reportSaveWarningTitle";
            const glyph = doc.createElement("span"); glyph.append(icon("report-original"));
            title.append(glyph, doc.createTextNode("Save details from your chats?"));
            const copy = doc.createElement("p"); copy.id = "reportSaveWarningCopy";
            const files = formats.join(", ");
            copy.textContent = `${files || "Your saved files"} will include original chat wording. Anyone you share the files with could read names, email addresses, project details or other sensitive information.`;
            const detail = doc.createElement("p"); detail.className = "muted";
            detail.textContent = "WIRE saves the files on this device and sends nothing. It removes passwords and other credentials it detects. Masking can still miss names and sensitive wording.";
            const actions = doc.createElement("div"); actions.className = "report-warning-actions";
            for (const [choice, label, cls] of [["masked", "Mask detected details and save", "primary"], ["original", "Save with chat details", "chat-details-kept"], [null, "Go back", "quiet report-warning-back"]]) {
                const button = doc.createElement("button"); button.type = "button"; button.className = cls;
                if (!choice) { button.append(icon("back")); button.autofocus = true; }
                button.append(doc.createTextNode(label)); button.addEventListener("click", () => close(current() ? choice : null)); actions.append(button);
            }
            dialog.append(title, copy, detail, actions); doc.body.append(dialog);
            dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
            const result = new Promise(resolve => { settle = resolve; }); dialog.showModal();
            actions.lastElementChild.focus();
            return result;
        },
        cancel: () => close(),
        withdrawAccess: () => close(),
    };
}
