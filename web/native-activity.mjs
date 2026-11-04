// Present the accepted native conversation without converting it to a GitHub interaction.
export function createNativeActivityPresentation({ api, ux, presentation, createReaderSections, sourceLabel, excerpt, timing, results, capturedAt, pagedList }) {
    if (typeof api?.publicationToken !== "function" || typeof api?.isCurrent !== "function") {
        throw new TypeError("Native presentation requires the shared publication interface.");
    }
    const authorized = token => token != null && typeof token.then !== "function" && api.isCurrent(token) === true;
    const isNative = record => record?.recordKind === "native-conversation";
    const present = fact => fact?.availability === "recorded";
    const text = fact => present(fact) && typeof fact.value?.text === "string" ? fact.value.text : null;
    const names = { user: "My prompt", assistant: "Assistant reply", tool: "Tool message", unknown: "Author unverified" };
    function messagePresentation(message) {
        const author = message.value?.author, representation = message.value?.representation;
        if (author === "user") return { section: "prompt", kind: "prompt", label: representation === "follow-up" ? "Follow-up" : names.user };
        if (author === "assistant") return { section: "response", kind: "reply",
            label: representation === "reply-fragment" ? "Assistant reply fragment" : names.assistant };
        if (author === "tool") return { section: "activity", kind: "tool", label: names.tool };
        if (message.reason === "native-thinking-fragment-author-unqualified") {
            return { section: "activity", kind: "thinking", label: "Thinking fragment (author unverified)" };
        }
        if (message.reason === "native-text-delta-author-unqualified" || representation === "reply-fragment") {
            return { section: "activity", kind: "text-fragment", label: "Text fragment (author unverified)" };
        }
        return { section: "activity", kind: "unverified", label: "Recorded text (author unverified)" };
    }
    const availability = {
        "absent-in-response": "Not in the recorded source", "excluded-by-policy": "Not retained", "credential-excluded": "Excluded for privacy",
        unsupported: "Unsupported by this source", unqualified: "Not verified", conflicting: "Conflicting evidence",
        "recorded-empty": "Recorded empty", "explicit-null": "Recorded null",
    };
    const toolLabels = results.labels("tool");
    const outcome = { succeeded: toolLabels.success, failed: toolLabels.failure, cancelled: "Cancelled", unknown: toolLabels.unknown };
    const factLabels = {
        task: "Task update", task_step: "Task step", task_steps: "Task steps", task_reasoning: "Task note",
        "unsupported-task": "Task update unavailable", clarification: "Clarification requested",
        confirmation: "Confirmation requested", "trigger-plugin": "Action requested",
        "unsupported-trigger-extension": "Request details unavailable",
        "native-invocation": "Recorded invocation", "unsupported-native-invocation": "Invocation details unavailable",
        "provider-progress": "Provider progress",
    };
    const factAnchor = fact => "native-source-fact-" + encodeURIComponent(fact.key);
    function dateContextLabel(basis) {
        if (basis === undefined || basis === null) return null;
        if (basis !== "ordinary-message-created") throw new TypeError("The message-date context basis is unavailable.");
        return "Message-date context; call dates unavailable.";
    }
    function sourceFacts(conversation) {
        if (conversation.sourceObservations !== undefined && !Array.isArray(conversation.sourceObservations)) {
            throw new TypeError("Recorded Chat updates are unavailable.");
        }
        return (conversation.sourceObservations ?? []).flatMap(group => {
            if (group.unit !== "chat-source-observation-set" || group.status !== "source-facts-only" || !Array.isArray(group.facts)) {
                throw new TypeError("Recorded Chat updates require the accepted source-fact contract.");
            }
            for (const fact of group.facts) {
                if (!Object.hasOwn(factLabels, fact.kind) || typeof fact.key !== "string" || !fact.key) {
                    throw new TypeError("Recorded Chat update identity or kind is unavailable.");
                }
                if (fact.kind === "provider-progress" && (!fact.fields?.text || typeof fact.fields.text.availability !== "string"
                    || present(fact.fields.text) && typeof fact.fields.text.value !== "string")) {
                    throw new TypeError("Recorded provider progress text is unavailable.");
                }
            }
            return group.facts;
        });
    }
    const recordedText = field => present(field) && typeof field.value === "string" && field.value.trim() ? field.value : null;
    function factTitle(fact) {
        if (fact.kind === "provider-progress") {
            const field = fact.fields.text;
            return present(field) ? field.value.trim() ? field.value : "Recorded progress text is blank."
                : availability[field.availability] || "Progress text unavailable.";
        }
        if (fact.kind === "clarification" && present(fact.fields.questions)) {
            const question = fact.fields.questions.value[0];
            return typeof question === "string" ? question.trim() ? question : "The recorded question is empty." : question.question;
        }
        return recordedText(fact.fields.name) || recordedText(fact.fields.stepTitle)
            || (fact.kind === "confirmation" ? "A confirmation was requested."
                : fact.kind === "trigger-plugin" ? "Action details are not verified."
                    : fact.kind.startsWith("unsupported-") ? "The recorded format is not supported."
                        : "A source update was recorded.");
    }
    const cards = new Set();
    let cardRevision = 0;
    const node = (tag, className, value) => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (value !== undefined) element.textContent = value;
        return element;
    };
    function clear(root, retire = false) {
        ux.withdrawAccess([root]);
        for (const element of [root, ...root.querySelectorAll("*")]) {
            for (const child of element.childNodes) if (child.nodeType === Node.TEXT_NODE) child.data = "";
            if (element === root && !retire) continue;
            for (const attribute of [...element.attributes]) {
                if (element === root && !attribute.name.startsWith("data-")) continue;
                if (element.namespaceURI !== "http://www.w3.org/2000/svg" || !(element.localName === "svg" && ["width", "height", "viewBox"].includes(attribute.name))
                    && !(element.localName === "rect" && ["width", "height", "x", "y", "rx", "ry"].includes(attribute.name))
                    && !(element.localName === "circle" && ["cx", "cy", "r"].includes(attribute.name))
                    && !(element.localName === "ellipse" && ["cx", "cy", "rx", "ry"].includes(attribute.name))
                    && !(["line", "linearGradient"].includes(element.localName) && ["x1", "x2", "y1", "y2"].includes(attribute.name))
                    && !(element.localName === "stop" && attribute.name === "offset")) attribute.value = "";
                element.removeAttributeNode(attribute);
                attribute.value = "";
            }
        }
        root.replaceChildren();
    }
    function recognition(record) {
        const messages = record.nativeConversation.messages;
        const message = messages.find(message => text(message) !== null && message.value.author === "user")
            || messages.find(message => text(message) !== null);
        const fact = !message && sourceFacts(record.nativeConversation)[0];
        if (fact) return { label: factLabels[fact.kind], text: excerpt({ text: factTitle(fact) }), author: "unknown" };
        return { label: message ? messagePresentation(message).label : "Conversation",
            text: message ? message.value.text.trim() ? excerpt(message.value) : "Recorded message is empty." : "No recorded message text",
            author: message?.value.author === "user" ? "user" : "unknown" };
    }
    function card({ record, href, rows, layer, onOpen, contextDateBasis }) {
        const revision = cardRevision;
        const publication = api.publicationToken(), events = new AbortController();
        if (!authorized(publication) || revision !== cardRevision) return null;
        const dateContext = dateContextLabel(contextDateBasis);
        if (dateContext && rows.length) throw new TypeError("Message-date context cannot contain measured call rows.");
        const row = node("article", "request-row activity-card"), action = node("a", "request-card-open");
        row.dataset.viewKey = "request:" + record.scenarioId;
        row.dataset.sourceId = record.sourceId;
        action.href = href;
        action.setAttribute("aria-controls", "contextSidebar");
        action.setAttribute("aria-expanded", "false");
        const prompt = recognition(record);
        const origin = node("p", "request-card-origin request-card-author", sourceLabel(record.sourceId) + " \u00b7 " + prompt.label);
        origin.dataset.promptActor = prompt.author;
        action.append(origin, node("p", "request-card-prompt", prompt.text));
        const tools = [...new Set(rows.flatMap(row => row.nativeToolNames || []))];
        if (tools.length) action.append(node("p", "request-card-categories", "Tools: " + tools.slice(0, 2).join(", ")
            + (tools.length > 2 ? ", More tools" : "")));
        const summary = results.summarize(rows);
        action.append(node("p", "request-card-problem", dateContext || (rows.length
            ? results.entries(layer, summary).map(entry => `${entry.count} ${entry.label.toLowerCase()}`).join(" / ")
            : record.nativeConversation.calls.length ? "No calls match this view." : "No tool calls recorded.")));
        const facts = node("div", "request-card-summary");
        facts.append(node("span", "request-card-time", "Captured: " + capturedAt(record.nativeConversation.observations[0]?.capture.capturedAt)));
        action.append(facts);
        action.addEventListener("click", event => {
            if (!record || !authorized(publication) || revision !== cardRevision || !record) { event.preventDefault(); return; }
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            if (!window.getSelection()?.isCollapsed && action.contains(window.getSelection()?.anchorNode)) { event.preventDefault(); return; }
            event.preventDefault();
            onOpen(record.scenarioId);
        }, { signal: events.signal });
        row.append(action);
        cards.add(() => { events.abort(); record = null; rows = null; onOpen = null; clear(row, true); });
        return row;
    }
    function clearCards() {
        cardRevision++;
        for (const release of cards) release();
        cards.clear();
    }
    function mountReader({ root, record, target, isCurrent, contextDateBasis }) {
        const token = api.publicationToken(), events = new AbortController();
        let active = true, conversation = record.nativeConversation;
        const current = () => active && root.isConnected && authorized(token) && active && isCurrent();
        if (!current()) return null;
        const dateContext = dateContextLabel(contextDateBasis);
        const sections = createReaderSections({ root, presentation, ux, isCurrent: current });
        const key = name => JSON.stringify(["native-reader", conversation.key, name]);
        const prompts = conversation.messages.filter(message => message.value?.author === "user");
        const responses = conversation.messages.filter(message => message.value?.author === "assistant");
        const activityMessages = conversation.messages.some(message => messagePresentation(message).section === "activity");
        let updates = sourceFacts(conversation);
        const promptTitle = prompts.some(message => message.unit === "message-representation-part") ? "My prompt text"
            : prompts.length === 1 ? "My prompt" : "Recorded prompts";
        const replyTitle = responses.some(message => message.unit === "message-representation-part") ? "Assistant reply text"
            : responses.length === 1 ? "Assistant reply" : "Assistant replies";
        const prompt = sections.add("prompt", promptTitle,
            { key: key("prompt"), collapsible: false });
        const activity = sections.add("activity", "Recorded activity", { key: key("activity"), collapsible: false });
        const replies = sections.add("response", replyTitle, { key: key("response"), collapsible: false });
        const source = sections.add("source", "Source details", { key: key("source"), initialOpen: false });
        const updatesSection = updates.length ? sections.add("updates", "Recorded updates", { key: key("updates") }) : null;
        const emptyMessages = !updates.length && !conversation.messages.length;
        if (dateContext) root.append(node("p", "reader-state", dateContext));
        root.append(...(emptyMessages || prompts.length ? [prompt.element] : []),
            ...(updatesSection ? [updatesSection.element] : []),
            ...(!updates.length || conversation.calls.length || conversation.returnedResults.length
                || activityMessages ? [activity.element] : []),
            ...(emptyMessages || responses.length ? [replies.element] : []), source.element);
        const field = (label, value) => {
            const group = node("div"), term = node("dt", "", label), definition = node("dd");
            definition.append(value);
            group.append(term, definition);
            return group;
        };
        const fields = pairs => {
            const list = node("dl", "reader-fields");
            for (const [label, value] of pairs) if (value !== undefined && value !== null) list.append(field(label, value instanceof Node ? value : String(value)));
            return list;
        };
        function duration(milliseconds) {
            const value = node("data", "call-duration"), [primary, equivalent] = timing.duration(milliseconds).split(" (");
            value.value = String(milliseconds);
            value.append(node("span", "duration-primary", primary));
            if (equivalent) value.append(" ", node("span", "duration-equivalent", "(" + equivalent));
            return value;
        }
        function copyText(value, label, className = "reader-message-text") {
            const body = node(className === "reader-message-text" ? "p" : "pre",
                className === "reader-message-text" ? "reader-request-text " + className : className, value);
            if (className === "reader-message-text") {
                const wrapper = node("div", "reader-input");
                const copy = ux.copyButton({ label: "Copy " + label.toLowerCase(),
                    tooltip: "Copy original text (unmasked)",
                    getText: () => current() && body.isConnected && body.checkVisibility() ? body.textContent : null });
                copy.setAttribute("aria-description", "Copies original text, unmasked.");
                wrapper.append(body, copy);
                return wrapper;
            }
            return ux.attachCopy(body, { label, copyLabel: "Copy " + label.toLowerCase(), tooltip: "Copy original text (unmasked)",
                getText: () => current() && body.isConnected && body.checkVisibility() ? body.textContent : null });
        }
        function factField(parent, label, field, { omitAbsent = false } = {}) {
            if (!field || omitAbsent && field.availability === "absent-in-response") return;
            const value = present(field) ? String(field.value)
                : ({ "recorded-empty": "Empty in the source", "explicit-null": "Source supplied no value" })[field.availability]
                    || availability[field.availability] || "Unavailable";
            const line = node("p", "native-update-detail");
            line.append(node("span", "muted", label + ": "), document.createTextNode(value));
            parent.append(line);
        }
        function taskStatus(parent, fields) {
            if (!fields.statusLiteral) return;
            factField(parent, "Source status", fields.statusLiteral);
        }
        function taskChildren(parent, field, title) {
            if (field === undefined) return;
            if (!Array.isArray(field)) { factField(parent, title, field); return; }
            if (!field.length) { parent.append(node("p", "reader-state", `No ${title.toLowerCase()} listed.`)); return; }
            const list = node("ul", "native-update-list");
            for (const child of field) {
                const item = node("li");
                if (child.kind === "unsupported-task-child") item.append(node("p", "reader-state", "Details unavailable for this entry."));
                else {
                    const name = recordedText(child.fields.stepTitle);
                    if (name) item.append(node("p", "", name));
                    else factField(item, "Title", child.fields.stepTitle);
                    taskStatus(item, child.fields);
                }
                list.append(item);
            }
            parent.append(list);
        }
        function paintUpdates() {
            clear(updatesSection.body);
            if (!current() || !updatesSection.visibility.isOpen()) return;
            let statusQualification = false;
            for (const fact of updates) {
                const item = node("article", "native-source-fact"), fields = fact.fields;
                item.id = factAnchor(fact);
                item.dataset.factKind = fact.kind;
                item.tabIndex = -1;
                const label = fact.kind === "clarification" && fields.actionId.value === "clarification_request_browser_take_control"
                    ? "Browser control requested" : factLabels[fact.kind];
                item.append(node("h3", "reader-context-heading", label));
                if (["task", "task_step", "task_steps", "task_reasoning"].includes(fact.kind)) {
                    const title = recordedText(fields.name) || recordedText(fields.stepTitle);
                    if (title) item.append(node("p", "native-update-title", title));
                    else {
                        factField(item, "Title", fields.name, { omitAbsent: true });
                        factField(item, "Step", fields.stepTitle, { omitAbsent: true });
                    }
                    if (recordedText(fields.name) && recordedText(fields.stepTitle) && fields.name.value !== fields.stepTitle.value) {
                        factField(item, "Step", fields.stepTitle);
                    }
                    taskStatus(item, fields);
                    taskChildren(item, fields.steps, "Steps");
                    taskChildren(item, fields.reasoningItems, "Notes");
                    if (!statusQualification && [fields, ...[fields.steps, fields.reasoningItems].flatMap(children => Array.isArray(children)
                        ? children.map(child => child.fields) : [])].some(fields => fields.status?.availability === "unqualified")) {
                        item.append(node("p", "context-help-note", "Status wording is unverified, not a tool result."));
                        statusQualification = true;
                    }
                    if (fields.annotation && fields.annotation.availability !== "absent-in-response") {
                        const labels = { tool: "Tool annotation", artifact: "Artifact annotation", skillActivation: "Skill annotation" };
                        item.append(node("p", "reader-state", present(fields.annotationType)
                            ? `${labels[fields.annotationType.value]} recorded; its details are not verified.`
                            : "Annotation details are not verified."));
                    }
                } else if (fact.kind === "clarification") {
                    if (present(fields.questions)) for (const question of fields.questions.value) {
                        item.append(node("p", "native-update-title", typeof question === "string"
                            ? question.trim() ? question : "The recorded question is empty." : question.question));
                        if (typeof question !== "string" && question.options.length) {
                            const options = node("ul", "native-update-list");
                            options.setAttribute("aria-label", "Recorded choices");
                            for (const option of question.options) {
                                const choice = node("li", "", option.label);
                                if (option.description) choice.append(node("p", "muted", option.description));
                                if (option.submitResponse !== option.label) choice.append(node("p", "muted", "Reply text: " + option.submitResponse));
                                options.append(choice);
                            }
                            item.append(options);
                        }
                    }
                    else factField(item, "Question", fields.questions);
                    item.append(node("p", "context-help-note", "Recorded request; no response or approval is established."));
                    factField(item, "Requested action", fields.actionId);
                    const functions = new Set();
                    for (const invocation of fact.invocations) {
                        const name = recordedText(invocation.fields.functionName);
                        if (!name || name === fields.actionId.value || functions.has(name)) continue;
                        functions.add(name);
                        factField(item, "Requested function", invocation.fields.functionName);
                    }
                } else if (fact.kind === "confirmation") {
                    factField(item, "Requested action", fields.actionId, { omitAbsent: true });
                    const actions = new Set([recordedText(fields.actionId)]);
                    for (const submit of fact.submitActions) {
                        const name = recordedText(submit.fields.actionId);
                        if (!name || actions.has(name)) continue;
                        actions.add(name);
                        factField(item, "Proposed action", submit.fields.actionId);
                    }
                    if (present(fields.cardCount)) item.append(node("p", "reader-state", fields.cardCount.value === 0
                        ? "No confirmation cards recorded." : `${fields.cardCount.value} confirmation ${fields.cardCount.value === 1 ? "card" : "cards"} recorded.`));
                    else factField(item, "Confirmation cards", fields.cardCount);
                    if (present(fields.isConsequential)) item.append(node("p", "context-help-note", fields.isConsequential.value
                        ? "Marked consequential by the source. Approval is not recorded here."
                        : "Not marked consequential by the source. Approval is not recorded here."));
                    else item.append(node("p", "context-help-note", "The request does not establish approval or execution."));
                } else if (fact.kind === "provider-progress") {
                    if (present(fields.text)) item.append(copyText(fields.text.value, "Recorded progress text"));
                    else factField(item, "Text", fields.text);
                } else if (fact.kind === "native-invocation") {
                    factField(item, "Tool", fields.toolName);
                    item.append(node("p", "context-help-note", "Invocation details belong to the recorded call; this is not an additional execution."));
                } else {
                    for (const [name, label] of [["toolName", "Source tool"], ["functionName", "Source function"]]) {
                        factField(item, label, fields[name], { omitAbsent: true });
                    }
                    for (const invocation of fact.invocations ?? []) {
                        factField(item, "Source function", invocation.fields.functionName, { omitAbsent: true });
                    }
                    item.append(node("p", "reader-state", fact.kind === "trigger-plugin"
                        ? "Action details are not verified; this request does not establish execution."
                        : "The recorded format is not supported."));
                }
                if (!current()) { clear(item, true); return; }
                updatesSection.body.append(item);
            }
        }
        if (updatesSection) {
            updatesSection.visibility.subscribe(paintUpdates);
            paintUpdates();
            if (!current()) {
                active = false; events.abort();
                clear(root, true); sections.dispose();
                updates = []; conversation = null; record = null;
                return null;
            }
        }
        function renderMessage(message) {
            const value = text(message), author = message.value?.author;
            const display = messagePresentation(message);
            const owner = display.section === "response" ? replies.body : display.section === "prompt" ? prompt.body : activity.body;
            const item = node("article", "reader-native-message");
            item.id = "native-message-" + encodeURIComponent(message.observationKey);
            item.dataset.observationKey = message.observationKey;
            item.dataset.sourceKey = message.sourceKey;
            item.dataset.messageKind = display.kind;
            item.tabIndex = -1;
            const label = display.label;
            item.setAttribute("aria-label", label);
            if (owner === prompt.body && prompts.length !== 1 || owner === activity.body) {
                const heading = node("h3", "reader-context-heading", label);
                if (author === "user") heading.dataset.promptActor = "user";
                item.append(heading);
            }
            if (message.value?.representation === "card-text") item.append(node("p", "muted", "Card text representation"));
            else if (owner === replies.body && responses.length > 1) item.append(node("p", "muted",
                message.value?.representation === "reply-fragment" ? "Reply fragment" : "Plain text representation"));
            item.append(value === null ? node("p", "reader-state", availability[message.availability] || "Message unavailable")
                : value === "" ? node("p", "reader-state", "Recorded message is empty.") : copyText(value, label));
            return item;
        }
        const messageLists = [], messagePageSize = 50;
        for (const section of [prompt, activity, replies]) {
            const messages = conversation.messages.filter(message => messagePresentation(message).section === section.name);
            if (!messages.length) continue;
            const host = node("div", "reader-native-messages");
            section.body.append(host);
            const pageKey = key("messages:" + section.name);
            const paint = () => {
                if (!current()) return;
                if (messages.length <= messagePageSize) {
                    clear(host);
                    for (const message of messages) host.append(renderMessage(message));
                    return;
                }
                if (typeof pagedList !== "function") throw new TypeError("Large native conversations require the existing bounded list owner.");
                pagedList(host, messages, { key: pageKey, size: messagePageSize, noun: "recorded text entries",
                    pageLabel: "Recorded text page", jump: true, renderItem: renderMessage,
                    isCurrent: current, beforeReplace: clear });
            };
            messageLists.push({ messages, pageKey, paint, host });
            paint();
        }
        if (!prompt.body.children.length && emptyMessages) prompt.body.append(node("p", "reader-state", "No recorded prompt text."));
        if (!replies.body.children.length && emptyMessages) replies.body.append(node("p", "reader-state", "No assistant reply text was retained from this source."));
        if (!conversation.calls.length && !updates.length) activity.body.append(node("p", "reader-state", "No tool calls are recorded for this conversation."));
        function returnedEntry(observationKey, result) {
            const item = node("section", "reader-native-result");
            item.dataset.observationKey = observationKey;
            item.dataset.resultIndex = String(result.index);
            if (target.nativeResult?.observationKey === observationKey && target.nativeResult.index === result.index) {
                item.id = "selectedCall"; item.tabIndex = -1; item.setAttribute("aria-current", "true");
                item.append(node("h3", "context-selected-label", "Selected returned result"));
            }
            item.append(fields([["Returned entry", result.index],
                ["Intermediary-reported HTTP status", result.statusCode === null ? "Unknown" : result.statusCode],
                ["Error code", result.errorCode], ["Pagination", result.paginationPresent === true ? "Present" : "Unknown"]]));
            return item;
        }
        const details = new Set();
        for (const [index, call] of conversation.calls.entries()) {
            const item = node("article", "journey-item reader-call-row");
            item.dataset.actionId = call.key;
            item.dataset.nativeCallId = call.nativeCallId;
            const heading = node("header", "call-heading"), identity = node("h3", "reader-call-identity");
            const toggle = node("button", "reader-call-toggle");
            toggle.type = "button";
            const name = call.nativeToolNames.length ? call.nativeToolNames.join(", ") : "Tool name unavailable";
            const line = node("span", "reader-call-identity-line", `Call ${index + 1} \u00b7 Tool: ${name}`);
            const chevron = ux.icon("disclosure");
            chevron.classList.add("reader-call-disclosure");
            line.append(chevron);
            const result = node("span", "reader-call-summary", outcome[call.outcome.state]);
            if (call.outcome.state === "failed") result.classList.add("result-tone-failure");
            toggle.append(line, result); identity.append(toggle); heading.append(identity);
            item.append(heading);
            for (const conflict of call.conflicts) item.append(node("p", "reader-state",
                conflict === "native-tool-name-conflict" ? "Recorded tool names disagree." : "Recorded tool outcomes disagree."));
            const body = node("div", "technical-detail"), detailKey = key("call:" + call.key);
            body.id = "native-call-" + encodeURIComponent(call.key);
            toggle.setAttribute("aria-controls", body.id);
            const selected = target.status === "available" && target.actionId === call.key;
            if (selected && !target.nativeResult) { item.id = "selectedCall"; item.tabIndex = -1; item.setAttribute("aria-current", "true"); }
            function paint() {
                clear(body);
                if (!current()) return;
                const open = presentation.isOpen(detailKey, selected);
                body.hidden = !open; toggle.setAttribute("aria-expanded", String(open));
                if (!open) return;
                body.append(fields([["Native call ID", call.nativeCallId], ["Service", "Not identified in this record"]]));
                const inputs = call.observations.filter(observation => observation.fields.input);
                if (!inputs.length) body.append(node("p", "reader-state", "Input not recorded."));
                for (const observation of inputs) {
                    const fact = observation.fields.input;
                    body.append(fact.availability === "recorded-empty" ? fields([["Input", "Recorded empty string"]])
                        : present(fact) || fact.availability === "explicit-null"
                        ? copyText(typeof fact.value === "string" ? fact.value : JSON.stringify(fact.value, null, 2), "Recorded input", "recorded-arguments")
                        : fields([["Input", availability[fact.availability] || "Unavailable"]]));
                }
                for (const observation of call.observations) {
                    const elapsed = observation.fields.callElapsed;
                    if (elapsed) body.append(fields([["Recorded duration", present(elapsed)
                        ? duration(elapsed.value) : availability[elapsed.availability] || "Unavailable"],
                        ["Measurement boundary", elapsed.boundary]]));
                    const failure = observation.fields.failure;
                    if (failure) {
                        const value = failure.value;
                        const diagnostic = present(failure) && value?.diagnostic ? results.diagnosticDetails(value.diagnostic) : [];
                        const signal = value?.messageStatus === "text-excluded" ? {
                            "access-denial": "The recorded error reports access denied",
                            "request-timeout": "The recorded request timed out",
                            "pending-call-dropped-before-response": "The call ended before a response arrived",
                        }[value.messageSignal] : null;
                        const reason = signal || value?.code && value.code !== "failure" && value.code
                            || ({ "sensitive-excluded": "Error text excluded for privacy",
                                "size-excluded": "Error text exceeded the saving limit", "unsupported-format": "Error format was not supported",
                                "not-supplied": "The source did not supply a failure reason" })[value?.messageStatus] || "Error text was not saved";
                        body.append(fields(diagnostic.length ? diagnostic
                            : [["Recorded error", present(failure) ? reason : availability[failure.availability] || "Unavailable"]]));
                    }
                    if (present(observation.fields.resultEvidence)) body.append(fields(results.resultDetails(observation.fields.resultEvidence.value)));
                    const returned = observation.outcomes.nestedApi;
                    if (returned) {
                        body.append(fields([["Returned results", present(returned) ? `${returned.observed.length} observed` : "Not recorded"],
                            ["Declared requests", returned.declaredRequestCount]]));
                        for (const result of returned.observed) body.append(returnedEntry(observation.observationKey, result));
                    }
                    const references = observation.fields.resultReferences;
                    if (references) body.append(fields([["Source references", present(references) ? references.value.cardinality : "Unavailable"]]),
                        node("p", "context-help-note", "References are not executed API requests or successful results."));
                }
            }
            toggle.addEventListener("click", () => {
                if (!current()) return;
                presentation.setOpen(detailKey, !presentation.isOpen(detailKey, selected)); paint();
            }, { signal: events.signal });
            details.add(body);
            item.append(body); activity.body.append(item);
            paint();
        }
        for (const returned of conversation.returnedResults.filter(result => result.callKeys.length !== 1)) {
            activity.body.append(node("p", "context-help-note", "These returned results have no single verified parent call."));
            for (const result of returned.observed) activity.body.append(returnedEntry(returned.observationKey, result));
        }
        for (const reference of conversation.resultReferences.filter(reference => reference.callKeys.length !== 1)) {
            activity.body.append(fields([["Source references", present(reference) ? reference.value.cardinality : "Unavailable"]]),
                node("p", "context-help-note", "References are not executed API requests or successful results."));
        }
        function paintSource() {
            clear(source.body);
            if (!current() || !source.visibility.isOpen()) return;
            source.body.append(fields([["Source", sourceLabel(record.sourceId)], ["Harness", conversation.scope.harness],
                ["Surface", conversation.scope.surface],
                ["Call dates", "Not verified"], ["Reply latency", "Not supported by this source"]]));
            for (const task of conversation.taskOutcomes) source.body.append(fields([["Recorded task state", task.state]]));
            for (const coverage of conversation.coverage) source.body.append(node("p", "context-help-note", coverage.meaning));
            for (const observation of conversation.observations) if (observation.fields.approval) {
                const approval = observation.fields.approval;
                source.body.append(fields([["Recorded approval", present(approval) ? approval.value ? "Approved" : "Not approved" : "Unavailable"]]));
            }
            const models = new Set();
            for (const observation of conversation.observations) if (observation.fields.model) {
                const model = observation.fields.model, signature = JSON.stringify(model);
                if (models.has(signature)) continue;
                models.add(signature);
                source.body.append(fields([["Recorded model", present(model) ? model.value : availability[model.availability] || "Unavailable"],
                    ["Model scope", model.scope]]));
            }
            const toggle = node("button", "quiet reader-identifiers-toggle", "Record identifiers"), identifiers = node("div", "reader-identifiers");
            const identifiersKey = key("identifiers");
            toggle.type = "button";
            identifiers.id = "native-source-identifiers-" + encodeURIComponent(conversation.key);
            toggle.setAttribute("aria-controls", identifiers.id);
            function paintIdentifiers() {
                clear(identifiers);
                if (!current() || !source.visibility.isOpen()) return;
                identifiers.hidden = !presentation.isOpen(identifiersKey, false);
                toggle.setAttribute("aria-expanded", String(!identifiers.hidden));
                if (identifiers.hidden) return;
                identifiers.append(fields([["Conversation ID", conversation.scope.conversationId]]));
                for (const fact of updates) identifiers.append(fields([
                    ["Recorded update", factLabels[fact.kind]], ["Fact identity", fact.key],
                    ["Source document", fact.source.sourceDocument], ["Original field", fact.source.pointer],
                    ["Decoded location", fact.source.decodedPointer],
                ]));
                for (const observation of conversation.observations) identifiers.append(fields([
                ["Observation", observation.observationKey], ["Source record", observation.sourceKey],
                ["Captured at", observation.capture.capturedAt], ["Source page", observation.ordering.pageOrdinal],
                ["Source frame", observation.ordering.frameOrdinal], ["Source record position", observation.ordering.recordOrdinal],
                ]));
            }
            toggle.addEventListener("click", () => {
                if (!current() || !toggle.isConnected) return;
                presentation.setOpen(identifiersKey, !presentation.isOpen(identifiersKey, false));
                paintIdentifiers();
            }, { signal: events.signal });
            source.body.append(toggle, identifiers);
            paintIdentifiers();
        }
        source.visibility.subscribe(paintSource);
        paintSource();
        sections.refresh();
        return {
            ...sections,
            revealTarget(id) {
                if (!current()) return null;
                if (updatesSection && updates.some(fact => factAnchor(fact) === id)) {
                    if (!updatesSection.isOpen()) updatesSection.apply(true, false);
                    if (!current()) return null;
                    return [...updatesSection.body.children].find(element => element.id === id) ?? null;
                }
                for (const list of messageLists) {
                    const index = list.messages.findIndex(message => "native-message-" + encodeURIComponent(message.observationKey) === id);
                    if (index < 0) continue;
                    presentation.setPage(list.pageKey, Math.floor(index / messagePageSize));
                    list.paint();
                    if (!current()) return null;
                    return [...list.host.querySelectorAll(".reader-native-message")].find(element => element.id === id) ?? null;
                }
                return null;
            },
            dispose() {
                if (!active) return;
                active = false; events.abort();
                for (const body of details) clear(body);
                clear(root, true);
                sections.dispose();
                updates = [];
                for (const list of messageLists) list.messages.length = 0;
                messageLists.length = 0;
                prompts.length = responses.length = 0;
                conversation = null; record = null;
            },
        };
    }
    return { isNative, recognition, card, clearCards, mountReader, clear, withdrawAccess: clearCards };
}
