// Screen copy only: file names, format values and saved report bytes are unchanged.
export const reportFileChoices = {
    html: { name: "HTML", purpose: "Web page", description: "Open the formatted report in a browser." },
    pdf: { name: "PDF", purpose: "Print document", description: "Keep a fixed layout for reading or printing." },
    json: { name: "JSON", purpose: "Structured data", description: "Use the recorded facts in a script or analysis tool." },
    markdown: { name: "Markdown", purpose: "Editable text", description: "Edit or quote the file in a text editor." },
};

export function reportWorkspacePresentation(route, journey = {}) {
    const saved = Boolean(route.bundle);
    const prepared = !saved && (route.task === "create" && journey.step === 3 || journey.saveUnconfirmed === true);
    return { landing: !saved && !prepared, prepared, saved };
}

// Presentation only. The existing report draft, preparation and Save owners retain authority.
export function createReportExperience({ root, time, ux, read, choose, changeDates, changeFocus, openDeskActivity, closePreview, current, createCalendar, fileLabel }) {
    const doc = root.ownerDocument, byId = id => doc.getElementById(id);
    const presets = [
        ["all", "All activity", "report-all"], ["errors", "Errors & failures", "warning"],
        ["completed", "Completed calls", "check"], ["mine", "Human prompts", "account"], ["agent", "Agent prompts", "report-agent"],
    ];
    const help = {
        all: "Includes prompts with unknown authors.",
        errors: "At least one call failed or reported an error. Other calls may have completed.",
        completed: "All calls completed without a recorded error. The answer can still be wrong.",
        mine: "Started by you, including any calls made by an agent.",
        agent: "Started by an agent. Unknown authors are excluded.",
        formats: "Choose the files that Save report will write on this device. Viewing a file does not change this choice.",
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
        control.setAttribute("popovertarget", panel.id); control.append(ux.icon("chevron"));
        return control;
    }
    function done(panel) {
        const row = el("div", "report-popover-actions");
        row.append(button("Done", () => panel.hidePopover())); panel.append(row);
    }
    function closeOptions() {
        for (const panel of root.querySelectorAll(".report-options-popover:popover-open")) panel.hidePopover();
    }
    const gallery = el("section", "report-gallery"); gallery.id = "reportGallery";
    const period = el("div", "report-period-choices"); period.setAttribute("role", "group"); period.setAttribute("aria-label", "Report period");
    const periodCaption = el("p", "report-period-caption");
    for (const range of ["7", "14", "30", "custom"]) {
        const control = button(range === "custom" ? "Custom dates" : `Last ${range} days`, () => {
            if (range === "custom") openCalendar();
            else { closeOptions(); changeDates({ range, ...time.preset(range, read().timeContext.timeZone) }); }
        });
        control.dataset.reportRange = range; period.append(control);
    }
    let deskFocus = "all";
    const compactFocus = el("select"); compactFocus.id = "reportDeskFocus"; compactFocus.dataset.nativeSelect = "";
    const compactLabel = el("label", "report-desk-compact", "Report focus"), nativeChoice = el("span", "native-choice");
    const nativeChevron = ux.icon("chevron"); nativeChevron.classList.add("native-choice-chevron");
    nativeChoice.append(compactFocus, nativeChevron); compactLabel.append(nativeChoice);
    compactFocus.addEventListener("change", () => { if (current() && !read().locked) { deskFocus = compactFocus.value; sync(); } });
    for (const [id, title] of presets) {
        const option = el("option", "", title); option.value = id; compactFocus.append(option);
    }
    const desk = el("div", "report-desk"), outlineDescription = el("p", "report-outline-description");
    const outlineChoices = el("div", "report-outline-choices"), outlineAction = el("div", "report-outline-action");
    const prepare = button("Prepare preview", event => choose(deskFocus, event.currentTarget), "primary icon-action"); prepare.id = "prepareReportPreview";
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
    desk.append(treatment, draftChoices, outlineDescription, outlineChoices, outlineAction, prepareHint);
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
    const periodPanel = popover("reportPeriodChoices", "Report period"), periodHost = el("div");
    periodPanel.append(periodHost);
    const dateButton = opener("Last 7 days", periodPanel);
    dateButton.id = "reportDeskDates";
    const privacy = popover("reportPrivacyOptions", "Report text");
    const promptOptions = byId("promptOptions"), legend = promptOptions.querySelector("legend");
    legend.after(promptOptions.querySelector('[value="masked"]').closest("label"));
    for (const input of promptOptions.querySelectorAll("input")) {
        const row = input.closest("label"); row.dataset.promptMode = input.value;
        row.querySelector("strong").prepend(ux.icon(({masked:"hide",none:"report-no-text",original:"warning"})[input.value]));
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
    const formats = popover("reportFileOptions", "Files to save"); formats.append(byId("formatOptions")); done(formats);
    const formatButton = opener("Files to save: HTML", formats);
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
    const datesRow = optionsRow("Dates", dateButton), fileRow = optionsRow("Files to save", formatGroup);
    draftChoices.append(compactLabel, datesRow);
    outlineChoices.append(optionsRow("Activity", scopeChoice), fileRow);
    outlineAction.append(el("p","screen-explanation","Preparing does not save or send anything."), prepare);
    periodHost.append(period, periodCaption);
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

    const calendar = popover("reportCustomDates", "Custom dates");
    const calendarEditor = createCalendar({ root: calendar, id: "reportDate", inputIds: { from: "reportDatefrom", to: "reportDateto" }, time, ux,
        context: () => read().timeContext, current, onChange: () => { applyDates.disabled = !calendarEditor.valid(); } });
    const calendarActions = el("div", "report-popover-actions");
    const applyDates = button("Use dates", () => {
        if (!calendarEditor.valid()) return;
        calendar.hidePopover(); changeDates({ range: "custom", ...calendarEditor.value() });
    }, "primary");
    calendarActions.append(button("Cancel", () => calendar.hidePopover()), applyDates);
    calendar.append(calendarActions);
    function openCalendar() {
        const value = read(), dates = value.dates.range === "capture" ? time.preset("7", value.timeContext.timeZone) : value.dates;
        calendarEditor.reset(dates);
        periodPanel.hidePopover(); calendar.showPopover(); calendarEditor.focus();
    }
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
        periodCaption.textContent = `Presets include today · ${value.timeContext.timeZone}`;
        for (const control of period.querySelectorAll("button")) {
            control.setAttribute("aria-pressed", String(control.dataset.reportRange === value.dates.range));
            control.disabled = value.locked;
        }
        compactFocus.disabled = value.locked || value.loading; compactFocus.value = deskFocus;
        outlineDescription.textContent = help[deskFocus];
        scopeName.textContent = value.scopeLabel;
        scopeChoice.setAttribute("aria-label", "Activity: " + value.scopeLabel);
        scopeChoice.disabled = prepare.disabled = value.locked || value.loading;
        prepare.disabled ||= !value.options.formats.length;
        const resume = value.resumePreset === deskFocus;
        prepareLabel.data = resume ? "Resume preview" : "Prepare preview";
        const scopeIssue = !resume && value.explicitScope && value.scopeIssue;
        prepare.disabled ||= Boolean(scopeIssue);
        prepareHint.textContent = value.locked ? "Finish or check the current save before preparing another report."
            : value.unavailable ? "Waiting for a current activity snapshot." : !value.options.formats.length ? "Choose at least one file to prepare a preview." : scopeIssue || "";
        prepareHint.hidden = !prepareHint.textContent;
        if (prepareHint.hidden) prepare.removeAttribute("aria-describedby"); else prepare.setAttribute("aria-describedby", prepareHint.id);
        const setLabel = (node, label) => { if (node.firstChild?.nodeType === 3) node.firstChild.data = label; };
        setLabel(dateButton, labelDates(value.dates));
        dateButton.hidden = value.paired;
        const mode = value.options.promptMode;
        backgroundScope.textContent = value.paired ? "Period comparison" : `${compactFocus.selectedOptions[0].textContent} · ${labelDates(value.dates)}`;
        if (privacyMode !== mode) {
            privacyMode = mode;
            privacyButton.replaceChildren(ux.icon(({ masked: "hide", original: "warning", none: "report-no-text" })[mode]),
                doc.createTextNode(({ masked: "Mask detected details", original: "Keep chat details", none: "Leave out prompts and replies" })[mode]),
                ux.icon("chevron"));
        }
        privacyButton.dataset.promptMode = mode;
        privacyButton.setAttribute("aria-label", "Report text: " + privacyButton.textContent);
        privacyHint.textContent = value.preparing ? "Updating the report. Save is unavailable."
            : ({ masked: "Masking can miss names and sensitive wording.",
                original: "Personal details may be included. Detected credentials are still removed.",
                none: "Calls and counts stay. Notes and error messages may still contain personal details." })[mode];
        const formatSummary = value.options.formats.map(format => value.prepared
            ? format === "markdown" ? "Markdown" : format.toUpperCase() : fileLabel(format)).join(", ") || "Choose a file";
        formatLabel.data = value.prepared ? "Files to save: " + formatSummary : formatSummary;
        formatButton.setAttribute("aria-label", "Files to save: " + formatSummary);
        formatGroup.hidden = value.prepared && value.saved;
        privacyButton.classList.toggle("chat-details-kept", value.options.promptMode === "original");
        outcome.value = value.options.reportFocus?.outcome ?? "all"; service.value = value.options.reportFocus?.services[0] ?? "";
        outcome.disabled = service.disabled = value.locked || !value.options.reportFocus;
        scopeCaption.textContent = value.paired ? "" : value.scopeLabel;
        scopeCaption.hidden = !scopeCaption.textContent;
        for (const control of choices.querySelectorAll("button")) control.disabled = value.locked;
        dateButton.disabled = formatButton.disabled = value.locked || value.unavailable;
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
                for (const panel of [privacy, formats, refine, periodPanel, calendar, selection]) drawer.append(panel);
                openDrawer();
                drawerTitle.focus({ preventScroll: true });
            }
        } else if (drawer.open) {
            closeOptions(); drawer.close();
            messageAnchor.after(errors, retry);
            for (const panel of [privacy, formats, refine, periodPanel, calendar, selection]) root.append(panel);
        }
    }
    return {
        sync, syncDrawer, backSlot, openCalendar, showSelection, selectionReturn,
        hasDeskDraft: () => deskFocus !== "all" || calendar.matches(":popover-open"),
        resetDeskFocus() { deskFocus = "all"; },
        closeOptions,
        withdrawAccess() {
            syncDrawer(false);
            closeOptions();
            deskFocus = "all";
            calendarEditor.clear();
            periodCaption.textContent = scopeCaption.textContent = scopeName.textContent = "";
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
            const glyph = doc.createElement("span"); glyph.append(icon("warning"));
            title.append(glyph, doc.createTextNode("Save details from your chats?"));
            const copy = doc.createElement("p"); copy.id = "reportSaveWarningCopy";
            const files = formats.join(", ");
            copy.textContent = `${files || "Your saved files"} will include original chat wording. Anyone you share the files with could read names, email addresses, project details or other sensitive information.`;
            const detail = doc.createElement("p"); detail.className = "muted";
            detail.textContent = "Saving creates local files. Nothing is sent. Detected passwords and other credentials are removed.";
            const actions = doc.createElement("div"); actions.className = "report-warning-actions";
            for (const [choice, label, cls] of [["masked", "Hide details and save", "primary"], ["original", "Save with chat details", "chat-details-kept"], [null, "Go back", "quiet report-warning-back"]]) {
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
        withdrawAccess: () => close(),
    };
}
