export const boundedNativeStyles = `
.native-reference {margin-block:16px;min-width:0;container-type:inline-size}
.bounded-native-facts {display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,9rem),1fr));gap:12px 20px;margin:16px 0}
.bounded-native-facts dt {color:var(--muted);font-weight:var(--weight-regular)}
.bounded-native-facts dd {margin:4px 0 0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
#wireNativeSearch {padding-block:8px}
#wireNativeSearch.wire-search-set>p.notice {margin-inline:0}
.native-exact td {font-variant-numeric:tabular-nums}
.source-outcome-population {display:grid;grid-template-columns:6rem minmax(0,1fr);gap:8px 16px;align-items:center;padding-block:12px}
.source-outcome-population>h4 {grid-column:1/-1;font:var(--weight-medium) var(--type-small)/var(--leading-ui) var(--font);margin:0}
.source-outcome-population>.percentage-ring {width:6rem}
:is(.reader-message,.reader-source-record)>.report-document {padding:0;background:none;border:0;box-shadow:none;max-width:none;overflow-wrap:anywhere}
.reader-message {margin-block:0 24px;min-width:0}
.reader-section-content>.reader-message:last-child {margin-block-end:0}
.reader-source-record>h3 {margin-block:0 8px}
.reader-section-content>.reader-state {font-size:var(--type-body);font-weight:var(--weight-regular);line-height:var(--leading-ui)}
.reader-message-header {display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px}
.reader-message-header h3 {margin:0;font:var(--weight-regular) var(--type-body)/1.5 var(--font)}
.reader-message[data-author=user]>.report-document {border-inline-start:2px solid var(--screen-prompt-user);padding-inline-start:12px}
.reader-message[data-author=user]>.reader-message-header h3 {color:var(--screen-prompt-user)}
:is(.reader-message,.reader-source-record)>.report-document :is(h3,p,ul,ol,pre) {margin-block:0 12px}
:is(.reader-message,.reader-source-record)>.report-document pre {white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%}
:is(.reader-message,.reader-source-record)>.report-document table {display:block;max-width:100%;overflow:auto}
.native-reader-evidence {margin-block:12px}
.native-reader-evidence>p {margin-block:6px}
.native-reader-navigation {display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.reader-call-list {list-style:none;padding:0;margin:0}
.reader-call-list>.reader-call {margin-block:0 16px}
.reader-call-list .reader-call-identity {overflow-wrap:anywhere}
@container(max-width:22rem) {.source-outcome-population {grid-template-columns:4rem minmax(0,1fr);gap:8px}.source-outcome-population>.percentage-ring {width:4rem}}
`;

export function mountBoundedNative({ api, ux, results, createState, sourceLabel, openConversation, presentHit, matchPolicyId, active,
    dimensional, onFilter = () => {}, formatDate = value => value, conversationHref = () => "#",
    onInventories = () => {}, onGroup = () => {}, onAnalysis = () => {}, onPage = () => {},
    createReaderSections, presentation, renderText, savedSummary = () => "" }) {
    const $ = id => document.getElementById(id);
    const state = createState(), search = createState(), analysis = createState();
    const models = new Set([state, search, analysis]), requests = new Map();
    let analysisInput = null, analysisContext = null;
    const inventories = new Map(), cardNodes = new Map(), readers = new Set(), readerPages = new Map();
    const readingOrigins = new Map();
    let readingAuthority = null;
    const references = new Set();
    let inventoryBasis = "", inventoryContext = null, inventoryView = null, groupBinding = null;
    let input = null, frame = null, restricted = "", searchInput = null, searchKey = "", searchTimer, searchEpoch = 0, seedKey = "", selectedSources = [];
    const node = (tag, text, className) => {
        const value = document.createElement(tag);
        if (text !== undefined) value.textContent = text;
        if (className) value.className = className;
        return value;
    };
    const searchHost = node("section", undefined, "wire-search-set");
    searchHost.id = "wireNativeSearch"; $("wireSearchPanel").append(searchHost);
    searchHost.hidden = true;
    const number = value => value.toLocaleString();
    const targetKey = target => JSON.stringify([target.conversationId, target.sourceId, target.revision, target.sourceRevision, target.ordinal ?? null]);
    function authorityBasis(value) {
        const current = value?.readback?.current ?? value?.current, deletion = value?.readback?.deletionVersion ?? value?.deletionVersion;
        if (!current || !Number.isSafeInteger(deletion) || deletion < 0 || !Number.isSafeInteger(current.generation)
            || current.generation < 0 || !["configurationRevision", "privacyRevision"].every(key =>
                current[key] === null || Number.isSafeInteger(current[key]) && current[key] >= 0)) return null;
        return JSON.stringify([current.generation, current.configurationRevision, current.privacyRevision, deletion]);
    }
    function forgetReading(saved) {
        for (const { model } of Object.values(saved.pages)) { model.withdraw(); models.delete(model); }
    }
    function retireReaderAuthority(revision) {
        for (const dispose of [...readers]) dispose(false);
        for (const saved of readerPages.values()) forgetReading(saved);
        readerPages.clear(); readingOrigins.clear(); readingAuthority = null;
        const owner = api.publicationToken();
        if (owner && Number.isSafeInteger(revision) && revision >= 0) readingAuthority = { owner, revision, basis: null };
    }
    function observeReaderAuthority(value) {
        const owner = api.publicationToken(), basis = authorityBasis(value);
        if (!owner || !basis || !Number.isSafeInteger(value.revision) || value.revision < 0) return;
        if (readingAuthority?.owner === owner && value.revision < readingAuthority.revision) return;
        if (readingAuthority && (readingAuthority.owner !== owner || readingAuthority.basis !== basis)) {
            retireReaderAuthority();
        }
        readingAuthority = { owner, revision: value.revision, basis };
    }
    function acceptReaderTarget(target, value) {
        if (value?.revision !== target.revision || value?.sourceRevision !== target.sourceRevision
            || !state.sourceIds.includes(target.sourceId) || !/^[a-f0-9]{64}$/.test(target.conversationId)
            || !authorityBasis(value)) return false;
        state.readback(value.readback);
        observeReaderAuthority(value);
        const owner = api.publicationToken(), authority = authorityBasis(value);
        if (!owner || readingAuthority?.owner !== owner || readingAuthority.basis !== authority) return false;
        const key = targetKey(target);
        readingOrigins.delete(key); readingOrigins.set(key, { owner, authority });
        while (readingOrigins.size > 8) readingOrigins.delete(readingOrigins.keys().next().value);
        return true;
    }
    function hasReaderTarget(target) {
        const origin = readingOrigins.get(targetKey(target));
        return Boolean(origin && api.isCurrent(origin.owner) && readingAuthority?.owner === origin.owner && readingAuthority.basis === origin.authority);
    }
    const unit = layer => layer === "tool" ? "native tool calls" : layer === "reported-api" ? "returned-result observations" : "selected records";
    const callUnit = (layer, count) => layer === "tool" ? count === 1 ? "tool call" : "tool calls"
        : layer === "reported-api" ? count === 1 ? "returned result" : "returned results" : "records";
    const outcomeLabels = layer => results.labels(layer);
    let chartType = "time";
    function clear(root) {
        for (const chart of root.querySelectorAll(".dimensional-scroll")) dimensional?.disposeView(chart);
        ux.withdrawAccess([root]);
        for (const item of [root, ...root.querySelectorAll("*")]) {
            for (const child of item.childNodes) if (child.nodeType === Node.TEXT_NODE) child.data = "";
            for (const attribute of [...item.attributes]) if (item !== root && !["class", "type"].includes(attribute.name)) {
                if (item.namespaceURI !== "http://www.w3.org/2000/svg" || !(item.localName === "svg" && ["width", "height", "viewBox"].includes(attribute.name))
                    && !(item.localName === "rect" && ["width", "height", "x", "y", "rx", "ry"].includes(attribute.name))
                    && !(item.localName === "circle" && ["cx", "cy", "r"].includes(attribute.name))
                    && !(item.localName === "ellipse" && ["cx", "cy", "rx", "ry"].includes(attribute.name))
                    && !(["line", "linearGradient"].includes(item.localName) && ["x1", "x2", "y1", "y2"].includes(attribute.name))
                    && !(item.localName === "stop" && attribute.name === "offset")) attribute.value = "";
                item.removeAttributeNode(attribute); attribute.value = "";
            }
        }
        root.replaceChildren();
    }
    function button(text, action, disabled = false) {
        const owner = api.publicationToken(), value = node("button", text, "quiet");
        value.type = "button"; value.disabled = disabled;
        value.addEventListener("click", () => { if (value.isConnected && api.isCurrent(owner) && !value.disabled) action(); });
        return value;
    }
    function facts(pairs) {
        const list = node("dl", undefined, "bounded-native-facts");
        for (const [label, text] of pairs) {
            const row = node("div"); row.append(node("dt", label), node("dd", text)); list.append(row);
        }
        return list;
    }
    async function read(model, endpoint, body, paint, context, previous = false, resume = null) {
        requests.get(model)?.abort();
        const controller = new AbortController(), owner = api.publicationToken();
        requests.set(model, controller);
        if (!owner) return false;
        let ticket;
        try {
            ticket = resume ? model.resume(resume, owner) : model.begin(body, owner, context, previous); paint();
            const result = await api(endpoint, resume ? ticket.input : body, { signal: controller.signal });
            if (controller.signal.aborted || !api.isCurrent(owner)) return false;
            const accepted = model.receive(ticket, result, owner);
            if (accepted) paint();
            return accepted;
        } catch (error) {
            if (!controller.signal.aborted && api.isCurrent(owner)) {
                if (ticket) model.fail(ticket, error);
                paint(error);
            }
            return false;
        } finally {
            if (requests.get(model) === controller) requests.delete(model);
        }
    }
    function pager(root, model, endpoint, original, paint, total, context) {
        const current = model.snapshot();
        if (!current.value) return;
        const page = current.value.page, controls = node("div", undefined, "pager");
        controls.setAttribute("aria-label", "Microsoft page controls");
        controls.append(node("span", current.value.kind === "native-retained-detail"
            ? `${number(page.items.length)} on this page / ${number(total)} in conversation`
            : `${number(page.items.length)} of ${number(total)} shown`));
        if (page.nextCursor) controls.append(button("Next Microsoft page", () => void read(model, endpoint, model.next(), paint, context)));
        if (original.page.after || page.nextCursor || page.items.length < total) controls.append(button("First Microsoft page", () => void read(model, endpoint,
            { ...original, revision: current.value.revision, page: { limit: page.limit, after: null } }, paint, context)));
        root.append(controls);
    }
    function scopedFilter(values) {
        onFilter({ source: selectedSources.length === 1 ? selectedSources[0] : "microsoft-365", ...values });
    }
    function exactTable(value, matches = () => true, topic = chartType) {
        const details = node("details", undefined, "detail-disclosure native-exact");
        details.append(node("summary", "Exact counts and coverage"));
        const keys = Object.keys(value.aggregates.outcomes).filter(key => ["success", "failure", "unknown"].includes(key) || value.aggregates.outcomes[key]);
        const labels = outcomeLabels(value.aggregates.layer);
        function tableFor(title, entries, first, extra = []) {
            const table = node("table", undefined, "percentage-table"), head = node("thead"), heading = node("tr");
            table.append(node("caption", title));
            const headings = [first, ...extra, "Count", ...keys.map(key => labels[key])];
            for (const label of headings) { const cell = node("th", label); cell.scope = "col"; heading.append(cell); }
            head.append(heading); table.append(head);
            const body = node("tbody");
            for (const entry of entries.filter(matches)) {
                const row = node("tr"), label = node("th"); label.scope = "row";
                label.append(entry.action ?? document.createTextNode(entry.label)); row.append(label);
                for (const [index, count] of [...(entry.extra ?? []), entry.count, ...keys.map(key => entry.outcomes[key])].entries()) {
                    const cell = node("td", number(count)); cell.dataset.label = headings[index + 1]; row.append(cell);
                }
                body.append(row);
            }
            table.append(body); details.append(table);
        }
        tableFor("Selected Microsoft sources", (value.sourceGroups ?? []).map(source => ({
            ...source, label: sourceLabel(source.sourceId), extra: [source.conversations],
        })), "Source", ["Conversations"]);
        tableFor("Recorded tools", [...(value.toolGroups?.groups ?? []),
            ...(value.toolGroups?.other ? [{ ...value.toolGroups.other, label: "Other tools" }] : [])], "Tool");
        const timed = topic === "time", category = ["categories", "workload"].includes(topic), path = ["paths", "endpoint"].includes(topic);
        const grouped = category && ["workload", "service"].includes(value.grouping.groupBy) || path && value.grouping.groupBy === "endpoint";
        const groups = timed ? value.timeSeries.points ?? [] : [...value.grouping.groups,
            ...(value.grouping.other ? [{ ...value.grouping.other, id: "group:other", label: "Other groups" }] : [])];
        if (timed || grouped) tableFor(timed ? "Dated calls and results" : path ? "Selected paths" : "Selected categories", groups.map(group => ({
            ...group, label: timed ? formatDate(group.date) : group.label,
            action: group.count && group.id !== "group:other" ? button(timed ? formatDate(group.date) : group.label,
                () => timed ? scopedFilter({ range: "custom", from: group.from, to: group.to }) : onGroup(group.id)) : null,
        })), timed ? "Date" : path ? "Path" : "Category");
        else if (category || path) details.append(node("p", `${path ? "Path" : "Category"} grouping is unavailable in this saved view.`, "reader-state"));
        details.append(
            facts([["Message observations", number(value.aggregates.messages)], ["Message parts", number(value.aggregates.parts)],
                ["Task updates", number(value.aggregates.taskStates)], ["Retained observations", number(value.aggregates.variants)]]),
            node("p", "Saved history may be incomplete.", "settings-help"));
        return details;
    }
    function paintQuery() {
        const value = state.snapshot().value;
        if (value) observeReaderAuthority(value);
        onPage();
    }
    function card({ item, view, onOpen = openConversation, selection = null }) {
        const owner = api.publicationToken(), events = new AbortController(), article = node("article", undefined, "request-row activity-card");
        let retired = false;
        article.dataset.sourceId = item.sourceId; article.dataset.viewKey = "request:" + item.id;
        let target = { conversationId: item.id, sourceId: item.sourceId, revision: view.revision, sourceRevision: view.sourceRevision };
        const action = node("a", undefined, "request-card-open");
        action.href = conversationHref(target); action.setAttribute("aria-controls", "contextSidebar");
        action.addEventListener("click", event => {
            if (retired || !action.isConnected || !api.isCurrent(owner)) { event.preventDefault(); return; }
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            if (!window.getSelection()?.isCollapsed && action.contains(window.getSelection()?.anchorNode)) { event.preventDefault(); return; }
            event.preventDefault(); acceptReaderTarget(target, view); onOpen(target);
        }, { signal: events.signal });
        const kind = item.presentation?.kind, author = node("p", sourceLabel(item.sourceId) + " \u00b7 "
            + ({ prompt: "My prompt", reply: "Assistant reply", context: "Recorded context" }[kind] ?? "Conversation"),
        "request-card-origin request-card-author");
        author.dataset.promptActor = kind === "prompt" ? "user" : "unknown";
        const recognition = item.presentation ? [...renderText(item.title).children].map(child => child.textContent).join(" ")
            : "Message preview unavailable";
        action.append(author, node("p", recognition, "request-card-prompt"));
        const tools = (item.presentation?.tools ?? []).slice(0, 2);
        if (item.selectedRows) action.append(node("p", tools.length ? "Tools: " + tools.join(", ")
            + (item.presentation.toolCount > tools.length ? " / More tools" : "") : "Tool name unavailable", "request-card-categories"));
        const problem = node("p", undefined, "request-card-problem"), labels = outcomeLabels(view.aggregates.layer);
        for (const [key, count] of Object.entries(item.outcomes).filter(([, count]) => count)) {
            const label = view.aggregates.layer === "tool" ? ({ failure: "failed", unknown: "unverified" }[key] ?? labels[key].toLowerCase())
                : labels[key].toLowerCase();
            const part = node("span", `${number(count)} ${label}`, "result-tone-" + key
                + (["failure", "transport"].includes(key) ? " request-card-failure-text" : ""));
            if (problem.childNodes.length) problem.append(" / ");
            problem.append(part);
        }
        if (!item.selectedRows) problem.textContent = item.presentation?.contextDateBasis
            ? "Message in the selected dates; call dates unavailable." : "No recorded calls in this selection.";
        action.append(problem);
        const facts = node("div", undefined, "request-card-summary");
        const dates = item.presentation?.activityDateRange, dated = dates?.datedRows > 0;
        const dateLabel = view.aggregates.layer === "reported-api" ? "Result recorded" : "Call started";
        const date = dated ? dateLabel + ": " + formatDate(dates.firstAt)
            + (formatDate(dates.lastAt) !== formatDate(dates.firstAt) ? " - " + formatDate(dates.lastAt) : "")
            + (dates.undatedRows ? ` / ${number(dates.undatedRows)} undated` : "") : "Activity date unavailable";
        facts.append(node("span", date, "request-card-time"));
        if (item.selectedRows) facts.append(node("span", `${number(item.selectedRows)} ${callUnit(view.aggregates.layer, item.selectedRows)}`, "request-card-count"));
        action.append(facts);
        if (selection) article.append(selection);
        article.append(action);
        cardNodes.set(article, () => {
            if (retired) return;
            retired = true; events.abort();
            item = view = onOpen = selection = target = null;
            clear(article);
            for (const attribute of [...article.attributes]) { attribute.value = ""; article.removeAttributeNode(attribute); }
            cardNodes.delete(article);
        });
        return article;
    }
    function clearCards(root = $("activityList")) {
        if (!root || typeof root.contains !== "function") throw new TypeError("Card retirement requires its consumer root.");
        let retired = 0;
        for (const [card, release] of cardNodes) if (card === root || root.contains(card)) { release(); retired++; }
        return retired;
    }
    function seed(snapshot, analytics, restriction = "", group, view = {}) {
        chartType = view.chartType ?? "time";
        const key = JSON.stringify([snapshot?.revision, snapshot?.sourceRevision, snapshot?.selectionRef, snapshot?.status, snapshot?.reason, analytics, restriction]);
        if (seedKey === key) return;
        seedKey = key;
        for (const reference of references) clear(reference);
        references.clear();
        requests.get(state)?.abort(); state.withdraw();
        frame = snapshot; restricted = restriction;
        groupBinding = group ?? null;
        const selected = analytics.filters?.sources;
        selectedSources = selected?.length ? selected.filter(source => state.sourceIds.includes(source)) : [...state.sourceIds];
        input = { schemaVersion: 1, revision: snapshot?.revision ?? null, sources: [...state.sourceIds],
            analytics: structuredClone(analytics), page: { limit: snapshot?.page?.limit ?? analytics.limit ?? 10, after: null } };
        if (snapshot?.status === "bounded" && selectedSources.length && !restricted) {
            const { status, ...value } = snapshot;
            const ticket = state.begin(groupBinding?.request ?? input, api.publicationToken(), groupBinding?.context);
            state.receive(ticket, value, api.publicationToken());
            observeReaderAuthority(value);
        }
    }
    function inventoryPaint(dimension) { onInventories(dimension); }
    function syncInventories(snapshot, analytics, unavailable = false) {
        const key = JSON.stringify([snapshot?.revision, snapshot?.sourceRevision, snapshot?.selectionRef, analytics, unavailable]);
        if (key === inventoryBasis) return;
        inventoryBasis = key; inventoryView = null; inventoryContext = null;
        for (const model of inventories.values()) { requests.get(model)?.abort(); model.withdraw(); }
        if (!active() || unavailable || snapshot?.status !== "bounded" || !snapshot.viewId) { inventoryPaint(); return; }
        inventoryView = { viewId: snapshot.viewId, revision: snapshot.revision };
        inventoryContext = { sources: [...state.sourceIds], analytics: structuredClone(analytics), original: snapshot };
        inventoryPaint();
    }
    function inventory(dimension) {
        const value = inventories.get(dimension)?.snapshot();
        return { ...(value ?? { loading: false, value: null, error: "" }), bound: inventoryView !== null };
    }
    function pageInventory(dimension, next) {
        if (!inventoryView) return;
        if (!inventories.has(dimension)) { const model = createState(); inventories.set(dimension, model); models.add(model); }
        const model = inventories.get(dimension);
        if (model.snapshot().loading) return;
        return read(model, "/api/retained/microsoft/inventory", next ? model.next()
            : { schemaVersion: 1, ...inventoryView, dimension, page: { limit: 100, after: null } },
            () => inventoryPaint(dimension), inventoryContext);
    }
    function cancelInventory(dimension) {
        const model = inventories.get(dimension);
        if (!model?.snapshot().loading) return;
        requests.get(model)?.abort(); requests.delete(model); model.withdraw();
        inventoryPaint(dimension);
    }
    function mountReader({ root, conversationId, sourceId, revision, sourceRevision, ordinal, scope, isCurrent }) {
        for (const dimension of inventories.keys()) cancelInventory(dimension);
        const owner = api.publicationToken(), held = [], releases = [];
        let disposed = false, rawTarget = ordinal;
        const current = () => !disposed && root.isConnected && api.isCurrent(owner) && isCurrent();
        const sections = createReaderSections({ root, presentation, ux, isCurrent: current });
        const key = name => JSON.stringify(["native-reader", sourceRevision, conversationId, name]);
        const memoryKey = key(JSON.stringify([revision, ordinal ?? null]));
        for (const [identity, saved] of readerPages) if (saved.owner !== owner || saved.sourceRevision !== sourceRevision) {
            forgetReading(saved); readerPages.delete(identity);
        }
        const remembered = readerPages.get(memoryKey);
        readerPages.delete(memoryKey);
        if (ordinal === undefined) rawTarget = remembered?.rawTarget ?? rawTarget;
        else if (remembered?.pages.observations) {
            const { model } = remembered.pages.observations;
            model.withdraw(); models.delete(model);
            delete remembered.pages.observations;
        }
        const prompt = sections.add("prompt", "Messages", { key: key("prompt"), collapsible: false });
        const activity = sections.add("activity", "Recorded activity", { key: key("activity"), collapsible: false, metadata: "Call order unverified" });
        const callOrder = activity.element.querySelector(".reader-section-context");
        callOrder.hidden = true;
        const context = sections.add("context", "Context", { key: key("context"), initialOpen: false });
        const source = sections.add("source", "Source details", { key: key("source"), initialOpen: ordinal !== undefined });
        root.append(prompt.element, activity.element, context.element, source.element);
        // An exact target owns the reveal; set it before subscriptions can start a read.
        if (ordinal !== undefined) source.apply(true, false);
        const request = section => ({ schemaVersion: 1, revision, sources: [sourceId], conversationId,
            sourceRevision, section, page: { limit: 10, after: null } });
        const restoreModel = name => remembered?.pages[name]?.model ?? createState();
        const messages = restoreModel("messages"), calls = restoreModel("calls"), contextual = restoreModel("context"), raw = restoreModel("observations");
        for (const model of [messages, calls, contextual, raw]) { held.push(model); models.add(model); }
        const syncBusy = () => root.setAttribute("aria-busy", String(held.some(model => model.snapshot().loading)));
        function verified(model, error) {
            const state = model.snapshot(), value = state.value;
            if (value && (value.revision !== revision || value.sourceRevision !== sourceRevision)) {
                model.withdraw(); return { value: null, loading: false, error: "The saved conversation changed. Reopen its current activity card." };
            }
            return error ? { ...state, error: error.message } : state;
        }
        function status(host, state, retry, label = "Read first page again") {
            host.append(node("p", state.error || (state.loading ? "Reading saved activity..." : "Saved activity is unavailable."), "reader-state"));
            if (!state.loading) host.append(button(label, retry));
        }
        function exactText(text, label, visible) {
            const body = node("pre", text);
            return ux.attachCopy(body, { label, copyLabel: "Copy " + label.toLowerCase(), tooltip: "Copy original text (unmasked)",
                getText: () => current() && visible() && body.isConnected && body.checkVisibility() ? text : null });
        }
        const availability = fact => ({
            "recorded-empty": "Empty in the recorded source.", "explicit-null": "Recorded null.",
            "excluded-by-policy": "Not retained.", "credential-excluded": "Not shown for privacy.",
            unsupported: "Unsupported source format.", unqualified: "Not verified.", conflicting: "Conflicting evidence.",
            "absent-in-response": "Not present in the recorded source.",
        })[fact?.availability] ?? "Not recorded.";
        function field(host, label, fact, visible = current) {
            if (["recorded", "recorded-empty"].includes(fact?.availability)) {
                const text = typeof fact.value === "string" ? fact.value : JSON.stringify(fact.value, null, 2);
                host.append(exactText(text ?? "", label, visible));
            } else host.append(node("p", label + ": " + availability(fact), "reader-state"));
        }
        function richText(text) {
            const body = renderText(text);
            // Report headings are disclosures; a conversation must not hide its reply behind them.
            for (const detail of [...body.querySelectorAll("details")].reverse()) {
                const summary = detail.querySelector(":scope > summary"), heading = node("h3");
                if (summary) { heading.append(...summary.childNodes); summary.remove(); }
                detail.replaceWith(...(heading.childNodes.length ? [heading] : []), ...detail.childNodes);
            }
            return body;
        }
        function inspect(at) {
            rawTarget = at;
            if (!source.isOpen()) source.apply(true, false);
            else void loadRaw(at);
            source.element.scrollIntoView({ block: "nearest", behavior: "auto" });
        }
        function original(at) {
            return button("Open source record", () => inspect(at));
        }
        function messageBlock(item, contextual = false) {
            const message = item.fields.message, author = message?.value?.author;
            const partsLabel = `Text fragment${item.messageParts.length === 1 ? "" : "s"} (author unverified)`;
            const partsOnly = !message && !item.outcomes.task && item.messageParts.length > 0;
            const label = author === "user" ? message.value.representation === "follow-up" ? "Follow-up" : "My prompt"
                : author === "assistant" ? "Assistant reply" : item.outcomes.task ? "Task: " + item.outcomes.task.state
                    : partsOnly ? partsLabel : "Recorded context";
            const block = node("section", undefined, "reader-message"), heading = node("header", undefined, "reader-message-header");
            block.dataset.nativeOrdinal = String(item.ordinal);
            block.dataset.author = author ?? "unknown";
            heading.append(node("h3", label));
            block.append(heading);
            if (item.retention.current === false) block.append(node("p", "Earlier saved version", "reader-state"));
            const visible = () => !contextual || context.isOpen();
            if (message?.availability === "recorded" && typeof message.value?.text === "string") {
                const text = message.value.text;
                block.append(text.trim() ? richText(text) : node("p", "Recorded message is empty.", "reader-state"));
                const copy = ux.copyButton({ label: author === "user" ? "Copy prompt" : author === "assistant" ? "Copy reply" : "Copy recorded context",
                    tooltip: "Copy original text (unmasked)",
                    getText: () => current() && visible() && block.isConnected && block.checkVisibility() ? text : null });
                copy.setAttribute("aria-description", "Copies original text, unmasked.");
                heading.append(copy);
            } else if (message) field(block, "Message", message, visible);
            const partsHeading = partsOnly ? heading : node("header", undefined, "reader-message-header");
            if (item.messageParts.length && !partsOnly) { partsHeading.append(node("h3", partsLabel)); block.append(partsHeading); }
            for (const [index, part] of item.messageParts.entries()) {
                if (part.availability === "recorded" && typeof part.value?.text === "string") {
                    const multiple = item.messageParts.length > 1;
                    const title = multiple ? node("div", undefined, "reader-message-header") : partsHeading;
                    const copy = ux.copyButton({ label: "Copy text fragment" + (multiple ? " " + (index + 1) : ""), tooltip: "Copy original text (unmasked)",
                        getText: () => current() && visible() && block.isConnected && block.checkVisibility() ? part.value.text : null });
                    copy.setAttribute("aria-description", "Copies original text, unmasked.");
                    if (multiple) title.append(node("p", "Fragment " + (index + 1), "reader-state"));
                    title.append(copy);
                    if (multiple) block.append(title);
                    block.append(richText(part.value.text));
                } else field(block, "Text fragment", part, visible);
            }
            if (item.outcomes.task && ["user", "assistant"].includes(author)) block.append(node("p", "Task: " + item.outcomes.task.state, "reader-state"));
            for (const fact of item.sourceFacts) {
                for (const name of ["text", "name", "stepTitle", "questions"]) {
                    const value = fact.fields?.[name];
                    if (value?.availability === "recorded") block.append(richText(typeof value.value === "string"
                        ? value.value : JSON.stringify(value.value, null, 2)));
                    else if (value && value.availability !== "absent-in-response") field(block, name === "questions" ? "Questions" : "Recorded text", value, visible);
                }
                if (fact.fields.statusLiteral?.availability === "recorded") block.append(node("p",
                    "Source status: " + fact.fields.statusLiteral.value + " (meaning unverified)", "reader-state"));
                for (const name of ["steps", "reasoningItems"]) if (Array.isArray(fact.fields[name])) {
                    const list = node("ul");
                    for (const child of fact.fields[name]) {
                        const entry = node("li"), fields = child.fields;
                        if (fields.stepTitle?.availability === "recorded") entry.append(richText(fields.stepTitle.value));
                        if (fields.statusLiteral?.availability === "recorded") entry.append(node("p",
                            "Source status: " + fields.statusLiteral.value + " (meaning unverified)", "reader-state"));
                        if (!entry.childNodes.length) entry.append(node("p", "Task entry details unavailable.", "reader-state"));
                        list.append(entry);
                    }
                    block.append(list);
                }
            }
            if (contextual) block.append(original(item.ordinal));
            return block;
        }
        function pagination(host, model, section, paint) {
            const value = model.snapshot().value;
            if (!value || value.sectionCount <= value.page.items.length) return;
            const bar = node("div", undefined, "pager"), snapshot = model.snapshot();
            bar.setAttribute("aria-label", section === "calls" ? "Recorded calls pages" : section === "context" ? "Recorded context pages" : "Conversation pages");
            bar.append(node("span", `${number(snapshot.pageOffset + 1)}-${number(snapshot.pageOffset + value.page.items.length)} of ${number(value.sectionCount)} ${section === "calls" ? "calls" : "saved observations"}`));
            const previous = button("Previous", () => void read(model, "/api/retained/microsoft/detail", model.previous(), paint, undefined, true), !snapshot.pageIndex);
            const next = button("Next", () => void read(model, "/api/retained/microsoft/detail", model.next(), paint), !value.page.nextCursor);
            bar.append(previous, next); host.append(bar);
        }
        function paintMessages(error) {
            if (!current()) return;
            syncBusy();
            clear(prompt.body); clear(prompt.actions);
            const state = verified(messages, error);
            if (!state.value) { status(prompt.body, state, loadMessages); return; }
            for (const item of state.value.page.items) prompt.body.append(messageBlock(item));
            if (!state.value.sectionCount) {
                prompt.body.append(node("p", "No verified prompt or reply text.", "reader-state"));
                if (!context.isOpen()) context.apply(true, false);
            }
            pagination(prompt.body, messages, "messages", paintMessages);
        }
        function paintContext(error) {
            if (!current()) return;
            syncBusy();
            clear(context.body);
            const state = verified(contextual, error);
            context.element.hidden = Boolean(state.value && !state.value.sectionCount);
            context.toggle.querySelector("span").textContent = "Context" + (state.value ? ` (${number(state.value.sectionCount)} saved ${state.value.sectionCount === 1 ? "record" : "records"})` : "");
            if (!context.isOpen()) return;
            if (!state.value) { status(context.body, state, loadContext); return; }
            for (const item of state.value.page.items) context.body.append(messageBlock(item, true));
            pagination(context.body, contextual, "context", paintContext);
        }
        function paintCalls(error) {
            if (!current()) return;
            syncBusy();
            clear(activity.body);
            const state = verified(calls, error);
            callOrder.hidden = !state.value || state.value.sectionCount < 2;
            if (!state.value) { status(activity.body, state, loadCalls); return; }
            const list = node("ol", undefined, "reader-call-list");
            list.setAttribute("aria-label", "Recorded calls in this conversation");
            for (const [index, item] of state.value.page.items.entries()) {
                const call = item.callSummaries[0], row = node("li", undefined, "reader-call reader-call-row");
                row.dataset.nativeCallId = call.id;
                const heading = node("h3", undefined, "call-heading"), toggle = node("button", undefined, "reader-call-toggle");
                toggle.type = "button";
                const line = node("span", undefined, "reader-call-identity-line");
                const chevron = ux.icon("disclosure"); chevron.classList.add("reader-call-disclosure");
                line.append(node("span", call.tool ?? "Tool name unavailable", "reader-call-identity"), chevron);
                const callNumber = calls.snapshot().pageOffset + index + 1;
                const outcome = node("span", `Call ${number(callNumber)}: ` + {
                    success: results.labels("tool").success, failure: "failed", unknown: "result unverified" }[call.outcome],
                    "reader-call-summary result-tone-" + call.outcome + (call.outcome === "failure" ? " request-card-failure-text" : ""));
                toggle.append(line, outcome); heading.append(toggle); row.append(heading);
                const body = node("div", undefined, "reader-call-detail");
                let open = presentation.isOpen(key("call:" + call.id), false);
                toggle.setAttribute("aria-expanded", String(open));
                body.id = "native-call-" + call.id; toggle.setAttribute("aria-controls", body.id);
                const paint = () => {
                    clear(body); body.hidden = !open;
                    if (!open || !current()) return;
                    const visible = () => open && body.isConnected;
                    if (!item.inputFacts.length) field(body, "Input", null);
                    const inputs = new Map();
                    for (const fact of item.inputFacts) {
                        const signature = JSON.stringify(fact.input);
                        if (!inputs.has(signature)) inputs.set(signature, []);
                        inputs.get(signature).push(fact);
                    }
                    for (const [index, group] of [...inputs.values()].entries()) {
                        const fact = group[0];
                        const evidence = item.evidenceFacts.find(entry => entry.ordinal === fact.ordinal);
                        if (evidence?.retention.current === false) body.append(node("p", "Earlier saved input", "reader-state"));
                        field(body, inputs.size > 1 ? `Input ${number(index + 1)}` : "Input", fact.input, visible);
                        if (group.length > 1) body.append(node("p", `Same input in ${number(group.length)} saved observations.`, "reader-state"));
                        body.append(original(fact.ordinal));
                    }
                    for (const fact of item.evidenceFacts) {
                        const evidence = node("div", undefined, "native-reader-evidence");
                        const failed = fact.fields.failure;
                        const diagnostic = failed?.availability === "recorded" && failed.value?.diagnostic
                            ? results.diagnosticDetails(failed.value.diagnostic) : [];
                        for (const [label, text] of diagnostic) evidence.append(node("p", label + ": " + text, "reader-state"));
                        if (failed && !diagnostic.length) evidence.append(node("p", failed.availability === "recorded"
                            ? failed.value?.code ? "Recorded error code: " + failed.value.code
                                : failed.value?.messageSignal ? "Recorded error signal: " + failed.value.messageSignal : "Failure reason was not retained."
                            : "Failure reason: " + availability(failed), "reader-state"));
                        if (fact.fields.resultEvidence?.availability === "recorded") {
                            for (const [label, text] of results.resultDetails(fact.fields.resultEvidence.value)) {
                                evidence.append(node("p", label + ": " + text, "reader-state"));
                            }
                        }
                        if (call.outcome === "unknown" && fact.outcomes.tool && fact.outcomes.tool.state !== "unknown") {
                            evidence.append(node("p", "Source tool outcome: " + fact.outcomes.tool.state, "reader-state"));
                        }
                        if (fact.fields.approval) field(evidence, "Recorded approval", fact.fields.approval, visible);
                        const elapsed = fact.fields.callElapsed;
                        if (elapsed) evidence.append(node("p", elapsed.availability === "recorded"
                            ? `Provider tool duration: ${elapsed.value} ${elapsed.unit}.` : "Provider tool duration: " + availability(elapsed), "reader-state"));
                        const returned = fact.outcomes.nestedApi;
                        if (returned) {
                            evidence.append(node("p", returned.observed?.length ? "Returned results"
                                : (returned.declaredRequestCount !== null ? `${returned.declaredRequestCount} requested; no` : "No")
                                    + " individual results recorded.", "reader-state"));
                            for (const result of returned.observed ?? []) evidence.append(node("p", result.statusCode !== null
                                ? "HTTP " + result.statusCode : result.errorCode ? "Error: " + result.errorCode : "Status not recorded."));
                            if (returned.observed?.length && returned.declaredRequestCount !== null) evidence.append(node("p",
                                `${returned.declaredRequestCount} requested.`, "reader-state"));
                        }
                        if (fact.fields.resultReferences) field(evidence, "Result references", fact.fields.resultReferences, visible);
                        if (evidence.childNodes.length) {
                            if (fact.retention.current === false) evidence.prepend(node("p", "Earlier saved evidence", "reader-state"));
                            evidence.append(original(fact.ordinal)); body.append(evidence);
                        }
                    }
                    if (!body.childNodes.length) body.append(original(item.ordinal));
                };
                toggle.addEventListener("click", () => {
                    if (!current() || !toggle.isConnected) return;
                    const selection = window.getSelection();
                    if (selection && !selection.isCollapsed && toggle.contains(selection.anchorNode)) return;
                    open = !open; presentation.setOpen(key("call:" + call.id), open);
                    toggle.setAttribute("aria-expanded", String(open)); paint();
                });
                row.append(body); list.append(row); paint();
            }
            activity.body.append(list);
            if (!list.childNodes.length) activity.body.append(node("p", "No tool calls were recorded.", "reader-state"));
            pagination(activity.body, calls, "calls", paintCalls);
        }
        function paintRaw(error) {
            if (!current() || !source.isOpen()) return;
            syncBusy();
            clear(source.body);
            source.body.append(node("p", sourceLabel(sourceId), "request-card-origin"));
            const state = verified(raw, error);
            if (!state.value) { status(source.body, state, () => loadRaw(rawTarget),
                rawTarget === undefined ? "Read first page again" : "Retry original observation"); return; }
            for (const item of state.value.page.items) {
                const block = node("section", undefined, "reader-source-record");
                block.dataset.nativeOrdinal = String(item.ordinal);
                block.append(node("h3", `Source record ${number(item.ordinal + 1)}`));
                const message = item.fields.message;
                if (message?.availability === "recorded" && typeof message.value?.text === "string") block.append(richText(message.value.text));
                for (const part of item.messageParts) if (part.availability === "recorded" && typeof part.value?.text === "string") block.append(richText(part.value.text));
                const details = node("details", undefined, "detail-disclosure"); details.append(node("summary", "Source fields"));
                details.addEventListener("toggle", () => {
                    if (!current() || !details.isConnected || !source.isOpen()) return;
                    for (const child of [...details.children].slice(1)) { clear(child); child.remove(); }
                    if (details.open) details.append(exactText(JSON.stringify(item, null, 2), "Source fields", () => source.isOpen() && details.open));
                });
                block.append(details); source.body.append(block);
                if (state.value.focusOrdinal === item.ordinal) {
                    block.tabIndex = -1;
                    queueMicrotask(() => { if (current() && source.isOpen() && block.isConnected) { block.focus({ preventScroll: true }); block.scrollIntoView({ block: "nearest" }); } });
                }
            }
            pager(source.body, raw, "/api/retained/microsoft/detail", request("observations"), paintRaw, state.value.aggregates.variants);
        }
        function loadSection(name, model, paint, input = request(name)) {
            const resume = remembered?.pages[name]?.receipt;
            if (resume) delete remembered.pages[name];
            return read(model, "/api/retained/microsoft/detail", input, paint, undefined, false, resume);
        }
        const loadMessages = () => loadSection("messages", messages, paintMessages);
        const loadCalls = () => loadSection("calls", calls, paintCalls);
        const loadContext = () => loadSection("context", contextual, paintContext);
        function loadRaw(at) {
            const body = request("observations");
            if (at !== undefined) Object.assign(body, { at, sourceRevision });
            return loadSection("observations", raw, paintRaw, body);
        }
        releases.push(source.visibility.subscribe(open => {
            if (open && !raw.snapshot().value && !raw.snapshot().loading) void loadRaw(rawTarget);
            else if (!open) { requests.get(raw)?.abort(); raw.withdraw(); clear(source.body); syncBusy(); }
        }));
        releases.push(context.visibility.subscribe(() => paintContext()));
        void loadMessages(); void loadCalls(); void loadContext();
        if (source.isOpen()) void loadRaw(rawTarget);
        function dispose(remember = true) {
            if (disposed) return;
            disposed = true; releases.forEach(release => release()); sections.dispose();
            const pages = {};
            for (const [name, model] of Object.entries({ messages, calls, context: contextual, observations: raw })) {
                requests.get(model)?.abort(); requests.delete(model);
                const receipt = remember && api.isCurrent(owner) ? model.suspend(owner) : null;
                if (receipt) pages[name] = { model, receipt };
                else { model.withdraw(); models.delete(model); }
            }
            if (Object.keys(pages).length) {
                while (readerPages.size >= 8) {
                    const [identity, saved] = readerPages.entries().next().value;
                    forgetReading(saved); readerPages.delete(identity);
                }
                readerPages.set(memoryKey, { owner, sourceRevision, rawTarget, pages });
            }
            clear(root); root.removeAttribute("aria-busy"); readers.delete(dispose);
        }
        readers.add(dispose);
        return { ...sections, dispose, revealTarget: () => null,
            retains: nextScope => nextScope === scope && current()
                && hasReaderTarget({ conversationId, sourceId, revision, sourceRevision, ordinal }) };
    }
    function paintSearch(error) {
        clear(searchHost);
        searchHost.hidden = !active() || !searchInput;
        if (searchHost.hidden) return;
        searchHost.append(node("h3", "Microsoft matches"));
        const current = search.snapshot(), value = current.value;
        if (!value || error) {
            searchHost.append(node("p", error?.message || current.error || "Searching Microsoft activity...", "notice"));
            if (!current.loading) searchHost.append(button("Retry Microsoft Search",
                () => void read(search, "/api/retained/microsoft/search", { ...searchInput, revision: null, page: { limit: 20, after: null } }, paintSearch)));
            return;
        }
        if (value.matchPolicyId !== matchPolicyId) {
            search.withdraw(); paintSearch(new Error("The native literal Search policy changed. Reload before searching.")); return;
        }
        observeReaderAuthority(value);
        searchHost.append(node("p", `${number(value.aggregates.matched)} ${value.aggregates.matched === 1 ? "match" : "matches"} across saved dates.`
            + (value.aggregates.unavailableText ? ` Text unavailable in ${number(value.aggregates.unavailableText)} saved observations.` : "")));
        const list = node("ol", undefined, "wire-search-results");
        for (const hit of value.page.items) {
            const shown = presentHit(hit), row = node("li");
            row.dataset.searchCategory = hit.type;
            const action = button("", () => {
                const target = { conversationId: hit.target.conversationId, sourceId: hit.source.sourceId, ordinal: hit.target.ordinal,
                    revision: value.revision, sourceRevision: value.sourceRevision };
                acceptReaderTarget(target, value); openConversation(target);
            });
            action.className = "wire-search-hit"; action.dataset.nativeSearchId = hit.id;
            const body = node("span", undefined, "wire-search-body");
            for (const [key, className] of [["title", "wire-search-title"], ["excerpt", "wire-search-excerpt"]]) {
                const text = node("span", undefined, className);
                for (const part of shown[key]) text.append(part.match ? node("mark", part.text) : document.createTextNode(part.text));
                if (text.childNodes.length) body.append(text);
            }
            body.append(node("span", sourceLabel(hit.source.sourceId), "wire-search-source"));
            action.append(body); row.append(action); list.append(row);
        }
        searchHost.append(list);
        if (value.page.nextCursor || value.page.items.length < value.aggregates.matched) {
            pager(searchHost, search, "/api/retained/microsoft/search", searchInput, paintSearch, value.aggregates.matched);
        }
    }
    function paintAnalysis(error) {
        const current = analysis.snapshot(), value = current.value;
        if (value && value.textSelection.matchPolicyId !== matchPolicyId) {
            analysis.withdraw(); paintAnalysis(new Error("The native Analyze literal-match policy changed. Read current activity.")); return;
        }
        clear(searchHost);
        searchHost.hidden = !active() || !analysisInput;
        if (!searchHost.hidden) {
            searchHost.append(node("h3", "Microsoft Analyze matches"));
            searchHost.append(node("p", error?.message || current.error || (value
                ? `${number(value.aggregates.selectedRows)} matching ${unit(value.aggregates.layer)} in ${number(value.aggregates.conversations)} conversations.`
                : "Searching Microsoft activity..."), "notice"));
            if (error || current.error) searchHost.append(button("Retry Microsoft Analyze Search",
                () => void read(analysis, "/api/retained/microsoft/analyze", analysisInput, paintAnalysis, analysisContext)));
        }
        onAnalysis(analysisInput ? { ...current, error: error?.message || current.error, query: analysisInput.query,
            binding: { endpoint: "/api/retained/microsoft/analyze", request: analysisInput, context: analysisContext } } : null);
    }
    function searchChanged({ query, scope, types, sources, revision, pending, base, analytics }) {
        const key = JSON.stringify([query, scope, types, sources, revision, pending, base?.status, base?.reason,
            base?.sourceRevision, base?.selectionRef]);
        if (key === searchKey) return;
        searchKey = key; searchEpoch++; clearTimeout(searchTimer);
        requests.get(search)?.abort(); search.withdraw(); requests.get(analysis)?.abort(); analysis.withdraw();
        analysisInput = analysisContext = null; onAnalysis(null);
        searchInput = null; clear(searchHost); searchHost.hidden = true;
        if (!active() || !query.trim() || !sources.length) return;
        for (const dimension of inventories.keys()) cancelInventory(dimension);
        searchHost.hidden = false;
        if (scope === "analysis") {
            analysisInput = base?.status === "bounded" && !pending ? { schemaVersion: 1, revision: base.revision,
                viewId: base.viewId, query, types, page: { limit: base.page.limit, after: null } } : null;
            analysisContext = analysisInput ? { sources: [...state.sourceIds], analytics, original: base } : null;
            if (!analysisInput) {
                searchHost.append(node("p", "Refresh Microsoft activity before searching.", "notice"));
                onAnalysis({ loading: pending, value: null, error: pending ? "" : "Current native Analyze base unavailable.", query, binding: null });
                return;
            }
            paintAnalysis();
            const epoch = searchEpoch;
            searchTimer = setTimeout(() => { if (epoch === searchEpoch) {
                void read(analysis, "/api/retained/microsoft/analyze", analysisInput, paintAnalysis, analysisContext);
            } }, 120);
            return;
        }
        if (pending) { searchHost.append(node("p", "Waiting for the current source selection.")); return; }
        if (base?.status !== "bounded") {
            searchHost.append(node("p", "Microsoft saved activity is unavailable for Search.", "notice"));
            return;
        }
        searchInput = { schemaVersion: 1, revision: null, sources, query, types, page: { limit: 20, after: null } };
        const epoch = searchEpoch;
        searchTimer = setTimeout(() => { if (epoch === searchEpoch) void read(search, "/api/retained/microsoft/search", searchInput, paintSearch); }, 120);
    }
    return {
        seed, card, mountReader, searchChanged, syncInventories, inventory, pageInventory, cancelInventory,
        acceptReaderTarget, hasReaderTarget, observeReaderAuthority, retireReaderAuthority,
        readerRevision: () => readingAuthority?.revision ?? null,
        clearCards,
        presentation: () => ({ ...state.snapshot(), error: restricted || state.snapshot().error, selected: selectedSources.length > 0,
            savedSummary: frame?.status === "bounded" ? savedSummary(frame) : "" }),
        async pageAt(index) {
            if (restricted || !Number.isSafeInteger(index) || index < 0) return false;
            while (state.snapshot().value && state.snapshot().pageIndex !== index) {
                const previous = state.snapshot().pageIndex > index;
                if (!previous && !state.snapshot().value.page.nextCursor) return false;
                if (!await read(state, groupBinding?.endpoint ?? (groupBinding ? "/api/retained/microsoft/drilldown" : "/api/retained/microsoft/query"),
                    previous ? state.previous() : state.next(), paintQuery, groupBinding?.context, previous)) return false;
            }
            return Boolean(state.snapshot().value && state.snapshot().pageIndex === index);
        },
        renderExact(host, topic, isCurrent, matches) {
            for (const previous of references) if (!previous.isConnected) { clear(previous); references.delete(previous); }
            const value = state.snapshot().value, section = node("section", undefined, "bounded-native-summary native-reference");
            section.append(node("h3", "Microsoft 365"));
            if (restricted || !value || !isCurrent()) section.append(node("p", "Microsoft exact counts are unavailable for this view.", "notice"));
            else if (["services", "models"].includes(topic)) section.append(node("p", topic === "services"
                ? "Service targets were not recorded." : "Original response model names are unavailable."));
            else {
                section.append(node("p", `${number(value.aggregates.selectedRows)} ${callUnit(value.aggregates.layer, value.aggregates.selectedRows)}.`));
                if (topic === "paths") section.append(node("p", "Paths are unavailable.", "reader-state"));
                const data = exactTable(value, matches, topic);
                data.open = true;
                data.firstElementChild.remove();
                section.append(data);
            }
            section.addEventListener("click", event => { if (!isCurrent()) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
            host.append(section); references.add(section);
        },
        current: () => state.snapshot().value,
        invalidate(reason) {
            seedKey = "";
            for (const reference of references) clear(reference);
            references.clear();
            for (const release of cardNodes.values()) release();
            requests.get(state)?.abort(); state.withdraw(); restricted = reason; paintQuery();
        },
        withdrawAccess() {
            for (const dispose of [...readers]) dispose();
            searchEpoch++; clearTimeout(searchTimer);
            for (const request of requests.values()) request.abort();
            requests.clear();
            for (const model of models) model.withdraw();
            for (const saved of readerPages.values()) for (const { model } of Object.values(saved.pages)) models.delete(model);
            readerPages.clear();
            readingOrigins.clear(); readingAuthority = null;
            input = frame = searchInput = null; searchKey = restricted = seedKey = ""; selectedSources = [];
            analysisInput = analysisContext = null;
            inventoryBasis = ""; inventoryContext = inventoryView = groupBinding = null;
            clear(searchHost); searchHost.hidden = true;
            for (const reference of references) clear(reference);
            references.clear();
            for (const release of cardNodes.values()) release();
        },
        resumeAccess() {},
    };
}
