// Presentation only: callers supply the authorized text, never a lookup for hidden originals.
export function createTextAccess(ux, presentation, authorship, metadata) {
    const bindings = new WeakMap();
    const caption = (source, options) => authorship?.label(source, options) ?? "Prompt";
    function retained(source) {
        return source?.status !== "unavailable" && typeof source?.text === "string" && source.text.trim() ? source.text : null;
    }
    function describePrompt(source) {
        if (retained(source) !== null) return { hasText: true, label: caption(source), notice: null };
        const author = authorship?.read(source), empty = source?.status === "full"
            && typeof source.text === "string" && !source.text.trim();
        return {
            hasText: false,
            label: empty && author?.basis === "autopilot" ? "Automatic continuation"
                : author?.actor === "user" ? "My activity" : author?.actor === "agent" ? "Agent activity" : "Author unverified",
            notice: empty ? "No prompt text retained" : "Prompt text unavailable",
        };
    }
    function excerpt(source, limit = 170) {
        const text = retained(source);
        if (text === null) return "Prompt not available";
        const compact = text.replace(/\s+/gu, " ").trim();
        const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(compact);
        let end = compact.length, count = 0;
        for (const part of graphemes) {
            if (count++ === limit) { end = part.index; break; }
        }
        if (end < compact.length && /\S/u.test(compact[end])) {
            const boundary = compact.slice(0, end).search(/\s+\S*$/u);
            if (boundary > 0) end = boundary;
        }
        return end < compact.length ? compact.slice(0, end).trimEnd() + "..." : compact;
    }
    function render(source, { key, navigationNode, label, copyLabel, allowCopy = true, mode = "preview", notice, copyNoticeId, subject = "request", originKind, initialOpen, contentFirst = false, compactProvenance = false, inlinePreview = false, visibility, actionsHost, headingLabel }) {
        if (typeof key !== "string" || !key) throw new TypeError("Text access needs a stable presentation key.");
        if (!["request", "response"].includes(subject)) throw new TypeError("Unsupported private text subject.");
        const promptLabel = caption(source, { originKind }), noun = subject === "response" ? "response" : "prompt";
        const complete = mode === "complete", partial = ["partial", "truncated"].includes(source?.status);
        const inline = inlinePreview && !complete;
        const initiallyOpen = initialOpen ?? (complete && (subject === "response" || retained(source)?.length <= 1200));
        label ??= "Read " + (complete ? "" : partial ? "retained " : "full ") + noun;
        copyLabel ??= "Copy " + noun;
        const text = retained(source), preview = text === null && subject === "response" ? "Original not available" : excerpt(source);
        const authorNote = label => metadata.item(label, { helpLabel: "prompt author", help: authorship.reason(source)
            + " Author unverified describes message provenance, not an account sign-in failure." });
        const authorGap = {
            "missing-source": "Who sent this was not recorded",
            "legacy-missing": "This older record has no sender details",
            "conflicting-source": "Recorded sender details disagree",
            "unsupported-source": "The recorded sender format is not supported",
            "system-source": "Recorded as system-supplied context",
            "invalid-source": "Recorded sender details could not be verified",
        }[authorship?.read(source).basis] || "Recorded sender details could not be verified";
        const root = document.createElement("div");
        root.className = "full-text" + (complete ? " full-text-complete" : "") + (complete && contentFirst ? " full-text-content-first" : "");
        if (visibility) root.classList.add("reader-owned-text");
        root.dataset.textSubject = subject;
        root.dataset.viewKey = "text:" + key;
        const header = document.createElement("div");
        header.className = "full-text-header";
        const readerActions = document.createElement("div");
        readerActions.className = "full-text-reader-actions";
        const qualifiers = document.createElement("div");
        qualifiers.className = "full-text-qualifiers";
        const heading = document.createElement(visibility && subject === "response" && actionsHost ? "span"
            : subject === "response" && !contentFirst ? "h3" : "h2");
        heading.id = "text-heading-" + encodeURIComponent(key);
        heading.textContent = headingLabel ?? (subject === "response" ? contentFirst ? "Recorded response" : "Retained response text"
            : complete && text === null ? describePrompt(source).label : promptLabel);
        if (visibility && subject === "request" && authorship?.read(source).actor === "unknown") heading.textContent = "Author unverified";
        if (visibility && subject === "response" && actionsHost) heading.classList.add("visually-hidden");
        if (subject === "request") heading.dataset.promptActor = authorship?.read(source).actor ?? "unknown";
        if (complete) {
            header.append(heading);
            if (contentFirst) {
                if (allowCopy) {
                    if (actionsHost) actionsHost.append(readerActions);
                    else header.append(readerActions);
                }
                header.append(qualifiers);
            }
            root.append(header);
        }
        if (complete && subject === "request" && (authorship?.read(source).actor ?? "unknown") === "unknown") {
            const author = authorship && !contentFirst ? authorNote(authorGap) : document.createElement("span");
            author.classList.add("reader-state");
            if (contentFirst || !authorship) author.textContent = authorship ? authorGap : "Author unverified";
            (contentFirst ? qualifiers : header).append(author);
        }
        const reading = document.createElement("p");
        reading.id = "text-excerpt-" + encodeURIComponent(key);
        reading.classList.add(complete ? "full-text-unavailable" : "full-text-preview");
        reading.textContent = complete && text !== null ? `${noun === "prompt" ? "Prompt" : "Response"} text is hidden.`
            : complete && subject === "request" ? describePrompt(source).notice + "." : preview;
        const passage = inline ? document.createElement("div") : root;
        if (inline) {
            passage.className = "full-text-passage";
            root.append(passage);
        }
        passage.append(reading);
        let previewState;
        if (!complete) {
            const provenance = document.createElement("div");
            provenance.className = "full-text-provenance";
            const unverified = subject === "request" && authorship?.read(source).actor === "unknown";
            const hint = unverified ? authorNote(compactProvenance ? "Prompt" : heading.textContent + " / " + authorGap) : document.createElement("span");
            hint.classList.add("full-text-preview-label");
            if (!unverified) hint.textContent = heading.textContent;
            hint.dataset.promptActor = authorship?.read(source).actor ?? "unknown";
            provenance.append(hint);
            root.prepend(provenance);
            if (!inline && text !== null && text !== preview) {
                previewState = document.createElement("p");
                previewState.className = "full-text-preview-state";
                previewState.textContent = partial ? "Preview / retained fragment" : `Preview / full retained ${noun} available`;
                root.append(previewState);
            }
        }
        if (source?.status === "partial" || source?.status === "truncated") {
            const note = document.createElement("p");
            note.className = complete ? "reader-state reader-state-partial" : "full-text-availability";
            note.textContent = complete ? "Partial text" : "Only part of the original was recorded. Missing text is not reconstructed.";
            if (complete) {
                (contentFirst ? qualifiers : header).append(note);
                const explanation = document.createElement("p");
                explanation.className = "full-text-availability";
                explanation.textContent = "Only part of the original was recorded. Missing text is not reconstructed.";
                if (!contentFirst) root.append(explanation);
            } else root.append(note);
        }
        if (complete && !contentFirst && allowCopy) header.append(readerActions);
        let details;
        if (complete && !contentFirst && (allowCopy || subject === "request" && authorship || notice)) {
            details = document.createElement("details");
            details.className = "reader-details";
            const summary = document.createElement("summary");
            summary.textContent = `About this ${noun}${allowCopy ? " & copying" : ""}`;
            details.append(summary);
            if (subject === "request" && authorship) {
                const reason = document.createElement("p");
                reason.textContent = authorship.reason(source);
                details.append(reason);
            }
            if (allowCopy || notice) {
                const explanation = document.createElement("p");
                explanation.textContent = !allowCopy ? notice : text === null ? `No ${noun} text is available to copy.` : notice
                    ?? `Copy includes the complete retained ${noun} text only, without masking. Other apps and clipboard history may access your system clipboard.`;
                details.append(explanation);
            }
            root.append(details);
        }
        const actions = document.createElement("div");
        actions.className = "full-text-actions";
        if (navigationNode) {
            navigationNode.classList.add("button-link");
            navigationNode.setAttribute("aria-describedby", reading.id);
            actions.append(navigationNode);
            root.append(actions);
        }
        if (text === null || !complete && text === preview) return root;
        const control = document.createElement("button");
        control.type = "button";
        control.className = "full-text-toggle";
        control.id = "text-toggle-" + encodeURIComponent(key);
        const bodyId = "text-body-" + encodeURIComponent(key), stateKey = "text:" + key;
        control.setAttribute("aria-controls", bodyId);
        if (complete) {
            if (!visibility) readerActions.append(control);
            if (!allowCopy && readerActions.childElementCount) {
                if (contentFirst && actionsHost) actionsHost.append(readerActions);
                else header.append(readerActions);
            }
        }
        else if (inline) passage.append(document.createTextNode(" "), control);
        else {
            actions.append(control);
            if (!actions.parentNode) root.append(actions);
        }
        function paint() {
            const open = visibility ? visibility.isOpen() : presentation.isOpen(stateKey, initiallyOpen);
            control.setAttribute("aria-expanded", String(open));
            const actionLabel = inline ? open ? "Read less" : "Read more" : open ? "Hide " + noun : label;
            ux.utility(control, open ? "hide" : "read", actionLabel, open ? "Hide " + noun : "Read " + noun);
            reading.hidden = open;
            if (previewState) previewState.hidden = open;
            root.querySelector(".full-text-body")?.remove();
            readerActions.querySelector(".ux-copy")?.remove();
            readerActions.querySelector(".ux-copy-status")?.remove();
            readerActions.querySelector(".reader-copy-scope")?.remove();
            if (open) {
                const body = document.createElement("div");
                body.id = bodyId;
                body.className = "full-text-body";
                if (complete) {
                    body.setAttribute("role", "region");
                    body.setAttribute("aria-labelledby", heading.id);
                }
                const noticeId = "text-notice-" + encodeURIComponent(key);
                if (notice && (!complete || !allowCopy && contentFirst)) {
                    const privacy = document.createElement("p");
                    privacy.id = noticeId;
                    privacy.className = complete ? "full-text-privacy" : "context-help-note";
                    privacy.textContent = notice;
                    body.append(privacy);
                }
                if (complete || !allowCopy) {
                    const pre = document.createElement("pre");
                    pre.className = "full-text-content";
                    pre.tabIndex = 0;
                    pre.setAttribute("aria-label", "Exact recorded " + noun + " text");
                    pre.textContent = text;
                    if (allowCopy) {
                        const copy = ux.copyButton({ label: copyLabel,
                            getText: () => pre.isConnected && (!visibility || visibility.isCurrent() && visibility.isOpen()) ? pre.textContent : null,
                            tooltip: "Copy " + noun });
                        const scope = document.createElement("span");
                        scope.id = noticeId;
                        scope.className = "reader-copy-scope";
                        scope.textContent = contentFirst
                            ? "Copy uses unmasked text. Other apps and clipboard history may access it."
                            : "Copies original text, unmasked.";
                        copy.setAttribute("aria-describedby", copyNoticeId ?? noticeId);
                        readerActions.append(copy);
                        if (!copyNoticeId) readerActions.append(scope);
                    }
                    body.append(pre);
                } else {
                    body.append(ux.codeBlock(text, { label: subject === "response" ? "Exact retained text / local only" : promptLabel + " / local only", copyLabel, prose: true, ...(notice ? { tooltip: notice } : {}) }));
                }
                if (inline) passage.insertBefore(body, control);
                else if (complete && contentFirst) reading.after(body);
                else root.insertBefore(body, details ?? null);
            }
        }
        control.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            presentation.setOpen(stateKey, !presentation.isOpen(stateKey, initiallyOpen));
            paint();
        });
        const unsubscribe = visibility?.subscribe(() => { if (root.isConnected) paint(); });
        bindings.set(root, () => {
            unsubscribe?.();
            root.querySelector(".full-text-body")?.remove();
            if (actionsHost || !allowCopy) readerActions.remove();
            else readerActions.replaceChildren();
        });
        paint();
        return root;
    }
    return { excerpt, render, caption, describePrompt,
        release(root) { bindings.get(root)?.(); bindings.delete(root); },
        isOpen: (key, initial = true) => presentation.isOpen("text:" + key, initial),
        setOpen: (key, open) => presentation.setOpen("text:" + key, open) };
}
