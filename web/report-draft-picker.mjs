// Shared by the renderer bundle and the standalone shell.
export function createReportDraftPicker({ api, ux, searchFields, normalize, blocked, changed, announce, erase, libraryLink }) {
    let catalog = null, owner = null, lastId = null, writing = false, timer = null, notice = null;
    const keys = new WeakMap();
    const el = (tag, cls, text) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined) n.textContent = text;
        return n;
    };
    function confirm(trigger, text, included) {
        clearTimeout(timer); if (notice) { erase(notice); notice.remove(); }
        notice = el("div", "report-draft-confirmation", text);
        notice.dataset.membership = included ? "added" : "removed";
        notice.prepend(ux.icon(included ? "report-member" : "report-remove"));
        notice.setAttribute("role", "status");
        (trigger.closest("dialog:modal") || document.body).append(notice);
        timer = setTimeout(() => { if (notice) { erase(notice); notice.remove(); notice = null; } }, 3500);
    }
    function close(restore = false) {
        if (!owner) return;
        const { panel, trigger, field, events } = owner;
        owner = null;
        events.abort(); field.dispose();
        if (restore && trigger.isConnected) trigger.focus({ preventScroll: true });
        if (panel.matches(":popover-open")) panel.hidePopover();
        erase(panel); panel.remove(); trigger.setAttribute("aria-expanded", "false");
    }
    function paint(b) {
        const id = keys.get(b);
        const member = catalog?.drafts.filter(d => d.scenarioIds.includes(id)) ?? [];
        const label = member.length ? `In report: ${member[0].name}${member.length > 1 ? ` (+${member.length - 1})` : ""}` : "Add to report";
        b.classList.toggle("in-draft", Boolean(member.length));
        const role = member.length ? "report-member" : "report-add";
        if (b.firstElementChild.dataset.iconRole !== role) b.firstElementChild.replaceWith(ux.icon(role));
        if (b.lastElementChild.textContent !== label) b.lastElementChild.textContent = label;
        const name = member.length ? `Report drafts: ${member.map(d => d.name).join(", ")}. Add or remove interaction` : label;
        b.setAttribute("aria-label", name);
        b.title = name;
    }
    function accept(value) {
        if (value && catalog?.source === value.source
            && (value.boardRevision < catalog.boardRevision || value.revision < catalog.revision)) return;
        if (value?.version === catalog?.version) return;
        close(); catalog = value ?? null;
        for (const b of document.querySelectorAll("button.report-draft-trigger")) paint(b);
    }
    function make(id) {
        const authority = api.publicationToken();
        const b = el("button", "report-draft-trigger");
        b.type = "button"; b.setAttribute("aria-haspopup", "dialog"); b.setAttribute("aria-expanded", "false");
        b.append(ux.icon("report-add"), el("span")); keys.set(b, id); paint(b);
        b.onclick = () => {
            if (!b.isConnected || writing || !api.isCurrent(authority)) return;
            if (owner?.trigger === b) { close(true); return; }
            const reason = blocked();
            if (reason) { announce(reason, "stale"); return; }
            if (catalog && api.publicationToken()) show(b, id);
        };
        return b;
    }
    function show(trigger, id) {
        close();
        const publication = api.publicationToken(), source = catalog.source, events = new AbortController(), opt = { signal: events.signal };
        let offered = null, readFailed = false;
        const panel = el("section", "report-draft-picker"), heading = el("h2", "", "Report drafts");
        panel.setAttribute("popover", "manual"); panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", heading.textContent);
        const fieldRoot = el("div", "search-capsule"), searchIcon = el("span", "wire-search-icon"), input = el("input", "search-capsule-input");
        const clear = el("button", "quiet search-capsule-clear"); clear.type = "button"; clear.hidden = true;
        const searchLabel = el("label", "draft-search-label", "Search drafts");
        input.id = "draftPickerSearch"; searchLabel.htmlFor = input.id;
        input.type = "search"; input.autocomplete = "off"; input.spellcheck = false; input.placeholder = "Search by name";
        searchIcon.append(ux.icon("search")); fieldRoot.append(searchIcon, input, clear);
        const list = el("div", "report-draft-options"), create = el("button", "quiet", "New draft");
        list.setAttribute("aria-busy", "true");
        create.type = "button";
        const form = el("form"), label = el("label", "", "Draft name"), name = el("input"), submit = el("button", "", "Create draft and add");
        name.maxLength = 100; name.required = true; name.autocomplete = "off"; label.append(name); submit.type = "submit";
        const cancel = el("button", "quiet", "Cancel"); cancel.type = "button";
        const actions = el("div", "draft-create-actions"); actions.append(submit, cancel); form.append(label, actions); form.hidden = true;
        const status = el("p", "draft-picker-status"); status.setAttribute("role", "status");
        const footer = el("div", "draft-picker-footer"); footer.append(create, libraryLink());
        create.prepend(ux.icon("zoom-in")); create.disabled = true;
        create.setAttribute("aria-expanded", "false");
        submit.disabled = true; name.oninput = () => { submit.disabled = !name.value.trim(); };
        panel.append(heading, searchLabel, fieldRoot, list, status, form, footer);
        function current() { return owner?.panel === panel && trigger.isConnected && api.isCurrent(publication) && !blocked(); }
        async function edit(command, text) {
            if (!current() || !offered || writing) return;
            writing = true; panel.setAttribute("aria-busy", "true");
            try {
                const result = await api("/api/report-drafts/edit", { expected: offered.version, scenarioId: id, ...command });
                if (!api.isCurrent(publication)) return;
                if (current()) close(true);
                lastId = result.draftId; accept(result.catalog); changed(); confirm(trigger, text, command.included);
            } catch (error) {
                if (!api.isCurrent(publication)) return;
                close(true);
                announce(`${error.message} Check current draft membership before trying again.`, "stale");
                try {
                    const latest = await api("/api/report-drafts/list", {});
                    if (api.isCurrent(publication)) { accept(latest); changed(); }
                } catch (readError) { if (api.isCurrent(publication)) announce(readError.message, "stale"); }
            } finally { writing = false; }
        }
        form.onsubmit = e => { e.preventDefault(); const title = name.value.trim(); if (title) void edit({ name: title, included: true }, `Added to ${title}`); };
        function toggleCreate(show) {
            form.hidden = !show; create.hidden = show; create.setAttribute("aria-expanded", String(show));
            if (!show) { name.value = ""; submit.disabled = true; }
            place(); (show ? name : create).focus({ preventScroll: true });
        }
        create.onclick = () => toggleCreate(true);
        cancel.onclick = () => toggleCreate(false);
        function place() {
            if (!trigger.isConnected) { close(); return; }
            const r = trigger.getBoundingClientRect(), w = document.documentElement.clientWidth, h = innerHeight;
            panel.style.maxWidth = `${w - 16}px`;
            panel.style.left = `${Math.max(8, Math.min(r.left, w - panel.offsetWidth - 8))}px`;
            const up = r.bottom + panel.offsetHeight + 8 > h && r.top > h - r.bottom;
            panel.style.top = `${Math.max(8, Math.min(up ? r.top - panel.offsetHeight - 4 : r.bottom + 4, h - panel.offsetHeight - 8))}px`;
        }
        function filter() {
            if (list.hasChildNodes()) erase(list);
            list.replaceChildren();
            const needle = normalize(input.value.trim());
            const rows = (offered?.drafts ?? []).filter(d => normalize(d.name).includes(needle)).sort((a,b) => Number(b.id === lastId) - Number(a.id === lastId));
            for (const d of rows) {
                const included = d.scenarioIds.includes(id), row = el("button", "draft-choice");
                row.type = "button"; row.append(ux.icon("reports"), el("span", "", d.name));
                if (included) row.append(el("small", "", "Remove"), ux.icon("select-check"));
                row.setAttribute("aria-label", `${included ? "Remove from" : "Add to"} ${d.name}`);
                row.onclick = () => void edit({ id: d.id, included: !included }, `${included ? "Removed from" : "Added to"} ${d.name}`);
                list.append(row);
            }
            status.textContent = readFailed ? "Drafts unavailable. Refresh Analyze and try again."
                : !offered ? "Loading drafts…" : !offered.drafts.length ? "No drafts yet." : !rows.length ? "No matching drafts." : "";
            status.hidden = !status.textContent;
            if (panel.isConnected) place();
        }
        const field = searchFields.mount(input, { clearLabel: "Clear draft search", onInput: filter });
        owner = { panel, trigger, events, field }; filter();
        (trigger.closest("dialog:modal") || document.body).append(panel); panel.showPopover(); place();
        trigger.setAttribute("aria-expanded", "true");
        input.focus({ preventScroll: true });
        // A draft may have been created in another tab since the last Analyze snapshot.
        void (async () => {
            try {
                const latest = await api("/api/report-drafts/list", {});
                if (owner?.panel !== panel || !api.isCurrent(publication)) return;
                if (!latest || latest.source !== source || catalog?.source !== source) {
                    readFailed = true;
                } else {
                    if (latest.revision >= catalog.revision && latest.boardRevision >= catalog.boardRevision) catalog = latest;
                    offered = catalog;
                    for (const b of document.querySelectorAll("button.report-draft-trigger")) paint(b);
                    create.disabled = false;
                }
            } catch (error) {
                if (owner?.panel !== panel || !api.isCurrent(publication)) return;
                readFailed = true;
                status.title = error.message;
            }
            list.setAttribute("aria-busy", "false");
            filter();
        })();
        document.addEventListener("pointerdown", e => { if (!panel.contains(e.target) && !trigger.contains(e.target)) close(); }, { ...opt, capture: true });
        document.addEventListener("focusin", e => { if (!panel.contains(e.target) && e.target !== trigger) close(); }, opt);
        document.addEventListener("keydown", e => {
            if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(true); }
            if (["ArrowUp", "ArrowDown"].includes(e.key) && (e.target === input || list.contains(e.target))) {
                const rows = [...list.children]; if (!rows.length) return;
                e.preventDefault(); const i = rows.indexOf(document.activeElement);
                rows[i < 0 ? e.key === "ArrowDown" ? 0 : rows.length - 1
                    : (i + (e.key === "ArrowDown" ? 1 : rows.length - 1) + rows.length) % rows.length].focus();
            }
            if (e.key === "Enter" && e.target === input && !e.isComposing) { e.preventDefault(); list.firstElementChild?.click(); }
        }, { ...opt, capture: true });
        window.addEventListener("resize", place, opt);
        document.addEventListener("scroll", place, { ...opt, capture: true });
    }
    return { make, accept, close, read: () => catalog, withdrawAccess() {
        close(); clearTimeout(timer); if (notice) { erase(notice); notice.remove(); }
        notice = null; catalog = null; lastId = null;
    } };
}
