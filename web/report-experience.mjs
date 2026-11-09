export function reportWorkspacePresentation(route, journey = {}) {
    const saved = Boolean(route.bundle);
    const comparing = !saved && route.task === "compare";
    const prepared = !saved && !comparing && (route.task === "create" && journey.step === 3 || journey.saveUnconfirmed === true);
    return { landing: !saved && !comparing && !prepared, prepared, saved, comparing };
}

// Presentation only. The existing report draft, preparation and Save owners retain authority.
export function createReportExperience({ root, time, ux, read, choose, changeDates, changeFocus, current, createCalendar }) {
    const doc = root.ownerDocument, byId = id => doc.getElementById(id);
    const presets = [
        ["all", "All activity", "Your prompts and agent prompts, with Work IQ calls and results.", "report-all"],
        ["errors", "Errors & failures", "Find prompts whose Work IQ calls hit errors.", "warning"],
        ["completed", "Completed calls", "Prompts whose calls finished without recorded errors.", "check"],
        ["mine", "My prompts", "Your requests and the Work IQ calls that followed.", "account"],
        ["agent", "Agent prompts", "Requests written by your agents.", "report-agent"],
    ];
    const help = {
        errors: "At least one Work IQ call failed or reported an error. Other calls in the interaction may have completed.",
        completed: "The calls finished without a recorded error. The answer can still be wrong or incomplete.",
        privacy: "WIRE hides details it recognizes in prompts, included replies and notes, such as email addresses and phone numbers. It may miss names or sensitive context. Your saved chats stay unchanged.",
        formats: "HTML is a web page; PDF is for reading and printing. JSON keeps structured facts; Markdown is portable text.",
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
    function helpButton(key, label) {
        const node = button("", () => {}, "report-help ux-help");
        node.setAttribute("aria-label", label); node.append(ux.icon("info"));
        ux.tooltip(node, help[key], { anchor: node.querySelector("svg"), helpOnActivate: true });
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
    const gallery = el("section", "report-gallery"); gallery.id = "reportGallery";
    const period = el("div", "report-period-choices"); period.setAttribute("role", "group"); period.setAttribute("aria-label", "Report period");
    const periodCaption = el("p", "report-period-caption");
    period.append(el("span", "", "Period"));
    for (const range of ["7", "14", "30", "custom"]) {
        const control = button(range === "custom" ? "Custom dates" : `Last ${range} days`, () => {
            if (range === "custom") openCalendar();
            else changeDates({ range, ...time.preset(range, read().timeContext.timeZone) });
        });
        control.dataset.reportRange = range; period.append(control);
    }
    const tiles = el("div", "report-tiles"); tiles.setAttribute("role", "group"); tiles.setAttribute("aria-label", "Ready-made reports");
    for (const [id, title, description, glyph] of presets) {
        const row = el("article", "report-tile"); row.dataset.preset = id;
        const control = button("", event => choose(id, event.currentTarget), "report-tile-open"); control.dataset.reportPreset = id;
        control.id = "reportPreset-" + id;
        control.append(ux.icon(glyph), el("strong", "", title), el("span", "", description));
        const next = ux.icon("next"); next.classList.add("report-tile-next"); control.append(next);
        row.append(control);
        if (help[id]) row.append(helpButton(id, "About " + title.toLowerCase()));
        tiles.append(row);
    }
    const galleryHeading = el("div", "report-gallery-heading");
    galleryHeading.append(el("h2", "", "What would you like to include?"), period);
    gallery.append(galleryHeading, periodCaption, tiles);
    const stage = byId("reportStage1"), selection = popover("reportActivityOptions", "Choose activity");
    selection.classList.add("report-explicit-selection");
    for (const node of [...stage.children]) if (node.id !== "reportStepTitle1") selection.append(node);
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
    const privacy = popover("reportPrivacyOptions", "Prompts and replies");
    privacy.append(byId("promptOptions"), byId("additionalMasking")); done(privacy);
    const privacyButton = opener("Hide personal details", privacy);
    const formats = popover("reportFileOptions", "Save as"); formats.append(byId("formatOptions")); done(formats);
    const formatButton = opener("HTML", formats);
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
    const privacyGroup = el("div", "report-toolbar-group"), formatGroup = el("div", "report-toolbar-group");
    privacyGroup.append(privacyButton, helpButton("privacy", "About hiding personal details"));
    formatGroup.append(formatButton, helpButton("formats", "About report file formats"));
    choices.append(dateButton, privacyGroup, formatGroup, refineButton);
    const scopeCaption = el("p", "report-period-caption"); scopeCaption.id = "reportExperienceScope";
    toolbar.append(nameRow, choices, scopeCaption);
    byId("reportStage3").prepend(toolbar);

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
    function labelDates(value) {
        if (value.range === "capture") return "All retained dates";
        return `${time.formatDate(value.from, read().timeContext, true)} to ${time.formatDate(value.to, read().timeContext, true)}`;
    }
    function sync() {
        if (!current()) return;
        const value = read();
        toolbar.hidden = !value.prepared;
        gallery.hidden = value.paired && value.prepared;
        if (value.prepared && period.parentElement !== periodHost) periodHost.append(period);
        else if (!value.prepared && period.parentElement !== galleryHeading) galleryHeading.append(period);
        periodCaption.textContent = labelDates(value.dates);
        for (const control of period.querySelectorAll("button")) {
            control.setAttribute("aria-pressed", String(control.dataset.reportRange === value.dates.range));
            control.disabled = value.locked;
        }
        for (const control of tiles.querySelectorAll("[data-report-preset]")) control.disabled = value.locked || value.loading;
        const setLabel = (node, label) => { if (node.firstChild?.nodeType === 3) node.firstChild.data = label; };
        setLabel(dateButton, value.dates.range === "capture" ? "All retained dates" : value.dates.range === "custom" ? "Custom dates" : `Last ${value.dates.range} days`);
        dateButton.hidden = value.paired;
        setLabel(privacyButton, ({ masked: "Hide personal details", original: "Keep chat details", none: "Prompts left out" })[value.options.promptMode]);
        setLabel(formatButton, value.options.formats.map(format => format === "markdown" ? "Markdown" : format.toUpperCase()).join(" + ") || "Choose a format");
        privacyButton.classList.toggle("chat-details-kept", value.options.promptMode === "original");
        outcome.value = value.options.reportFocus?.outcome ?? "all"; service.value = value.options.reportFocus?.services[0] ?? "";
        outcome.disabled = service.disabled = value.locked || !value.options.reportFocus;
        scopeCaption.textContent = value.paired ? "The accepted comparison keeps its two periods and filters."
            : `${labelDates(value.dates)} · ${value.scopeLabel} · ${value.timeContext.timeZone}${value.options.resultText ? " · Masked error details included" : ""}`;
        for (const control of choices.querySelectorAll("button")) control.disabled = value.locked;
        const save = byId("reportSaveActions");
        if (save && save.parentElement !== saveSlot) saveSlot.append(save);
        for (const input of doc.querySelectorAll("[name=promptMode]")) input.checked = input.value === value.options.promptMode;
        for (const input of byId("formatOptions").querySelectorAll("input")) input.checked = value.options.formats.includes(input.value);
    }
    return {
        sync, openCalendar, showSelection,
        closeOptions() {
            for (const panel of [privacy, formats, refine, periodPanel, calendar, selection]) if (panel.matches(":popover-open")) panel.hidePopover();
        },
        withdrawAccess() {
            for (const panel of [privacy, formats, refine, periodPanel, calendar, selection]) if (panel.matches(":popover-open")) panel.hidePopover();
            calendarEditor.clear();
            periodCaption.textContent = scopeCaption.textContent = "";
        },
        resumeAccess: sync,
    };
}

export function decoratePreparedReport(source, { host = document, preview, notes, onNote, onCopy, current, refresh }) {
    const style = source.createElement("style");
    style.textContent = `
body{background:var(--report-sheet);color:var(--ink)}main{background:transparent}
:root{--font:var(--screen-font)}h1,h2,h3,h4,p,table,pre{color:inherit}
.report-author-note,.reading-notes{background:var(--report-note)}
.wire-example-editor{margin:20px 0;padding-top:12px;border-top:1px solid var(--rule);font-family:var(--font)}
.wire-example-editor summary{cursor:pointer;min-height:44px;align-content:center;color:var(--muted)}
.wire-example-editor label{display:block;margin:16px 0 10px}
.wire-example-editor textarea{display:block;width:100%;box-sizing:border-box;min-height:90px;padding:12px;border:1px solid var(--rule);border-radius:8px;background:var(--report-note);color:var(--ink);font:inherit;line-height:1.6;resize:vertical}
.wire-example-editor button{min-height:44px;padding:8px 14px;margin:12px 8px 0 0;border:1px solid var(--rule);border-radius:8px;background:var(--report-note);color:var(--ink);font:inherit;cursor:pointer}
.wire-example-editor :focus-visible{outline:2px solid var(--focus);outline-offset:3px}
.wire-example-editor .wire-omit{display:flex;align-items:center;gap:8px;min-height:44px}
`;
    source.head.append(style);
    function theme() {
        if (!current()) return;
        const values = host.defaultView.getComputedStyle(host.documentElement), dark = host.documentElement.dataset.evidenceTheme === "dark";
        source.documentElement.dataset.evidenceTheme = dark ? "dark" : "light";
        for (const key of ["ink", "muted", "rule", "control", "focus"]) source.documentElement.style.setProperty("--" + key, values.getPropertyValue("--" + key));
        source.documentElement.style.setProperty("--screen-font", values.getPropertyValue("--font"));
        source.documentElement.style.setProperty("--report-sheet", values.getPropertyValue("--report-sheet"));
        source.documentElement.style.setProperty("--report-note", values.getPropertyValue("--report-note"));
        refresh();
    }
    const observer = new host.defaultView.MutationObserver(theme);
    observer.observe(host.documentElement, { attributes: true, attributeFilter: ["data-evidence-theme", "style", "class"] }); theme();
    for (const section of source.querySelectorAll("[data-report-scenario]")) {
        const id = section.dataset.reportScenario;
        const record = preview.records.find(record => record.scenarioId === id);
        const editor = source.createElement("details"); editor.className = "wire-example-editor";
        const summary = source.createElement("summary"); summary.textContent = "Add a note or edit this example"; editor.append(summary);
        const label = source.createElement("label"), note = source.createElement("textarea");
        label.textContent = "Your note"; note.id = "note-" + id; label.htmlFor = note.id;
        note.setAttribute("placeholder", "What you expected, or why this matters");
        note.value = notes.find(entry => entry.scenarioId === id)?.text ?? "";
        const save = source.createElement("button"); save.type = "button"; save.textContent = "Update note";
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
        choose() {
            if (dialog || !current()) return Promise.resolve(null);
            trigger = doc.activeElement;
            dialog = doc.createElement("dialog"); dialog.className = "report-save-warning";
            dialog.setAttribute("aria-labelledby", "reportSaveWarningTitle"); dialog.setAttribute("aria-describedby", "reportSaveWarningCopy");
            const title = doc.createElement("h2"); title.id = "reportSaveWarningTitle";
            const glyph = doc.createElement("span"); glyph.append(icon("warning"));
            title.append(glyph, doc.createTextNode("Save details from your chats?"));
            const copy = doc.createElement("p"); copy.id = "reportSaveWarningCopy";
            copy.textContent = "Your prompts, chat replies and notes may include names, email addresses, project details or other sensitive information. WIRE can hide details it recognizes, but it may not catch everything sensitive.";
            const detail = doc.createElement("p"); detail.className = "muted";
            detail.textContent = "Saved on this device. Detected passwords and other credentials are removed.";
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
