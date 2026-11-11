// Serialized into the nonce-authorized shell; keep this factory self-contained.
export function createSelectControls(ux, { decorateOption = () => {}, pagingFor = () => null, onClose = () => {}, matchesOption } = {}) {
    const controls = new Map();
    const events = new AbortController();
    let sequence = 0, active = null, typeBuffer = "", typeTime = 0, frame = 0;
    let dismissedPointer = null, popupRevision = 0, withdrawalRevision = 0;
    const popup = document.createElement("div");
    const list = document.createElement("div");
    popup.className = "select-popup";
    list.id = "evidence-select-listbox";
    list.setAttribute("role", "listbox");
    popup.append(list);
    popup.setAttribute("popover", "manual");
    popup.hidden = true;
    document.body.append(popup);

    function listen(node, name, handler, options = {}) {
        node.addEventListener(name, handler, { ...options, signal: events.signal });
    }
    function clearAttribute(node, name) {
        const attribute = node.getAttributeNode(name);
        if (!attribute) return;
        // Only SVG geometry needs detaching first; private values stay blank before removal.
        if (node.namespaceURI !== "http://www.w3.org/2000/svg" || !(node.localName === "svg" && ["width", "height", "viewBox"].includes(name))
            && !(node.localName === "rect" && ["width", "height", "x", "y", "rx", "ry"].includes(name))
            && !(node.localName === "circle" && ["cx", "cy", "r"].includes(name))
            && !(node.localName === "ellipse" && ["cx", "cy", "rx", "ry"].includes(name))
            && !(["line", "linearGradient"].includes(node.localName) && ["x1", "x2", "y1", "y2"].includes(name))
            && !(node.localName === "stop" && name === "offset")) attribute.value = "";
        node.removeAttribute(name);
        attribute.value = "";
    }
    function clearRendered(node, retained) {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        for (let text = walker.nextNode(); text; text = walker.nextNode()) text.data = "";
        for (const child of node.querySelectorAll("*")) {
            if (child === retained) continue;
            if (child.matches("input,textarea")) { child.value = ""; child.defaultValue = ""; }
            for (const attribute of [...child.attributes]) clearAttribute(child, attribute.name);
        }
    }
    function attribute(node, name, value) {
        if (value == null) {
            clearAttribute(node, name);
        } else if (node.getAttribute(name) !== String(value)) {
            clearAttribute(node, name);
            node.setAttribute(name, String(value));
        }
    }
    function optionsFor(select) {
        return [...select.options].filter((option) => !option.hidden && !option.parentElement.hidden).map((option) => ({
            node: option, value: option.value, label: option.label,
            displayLabel: option.dataset.optionLabel || option.label, count: option.dataset.count,
            disabled: option.disabled || option.parentElement.matches("optgroup:disabled"),
            group: option.parentElement.matches("optgroup") ? option.parentElement.label : "",
            detail: [option.dataset.detail,
                (option.disabled || option.parentElement.matches("optgroup:disabled")) && option.dataset.disabledReason
                    ? `Unavailable: ${option.dataset.disabledReason}` : ""].filter(Boolean).join("; "),
        }));
    }
    function selectedValues(entry) { return entry.options.filter(option => option.node.selected).map(option => option.value); }
    function selectionKey(entry) { return entry.multiple ? JSON.stringify(selectedValues(entry)) : entry.select.value; }
    function unavailable(entry) {
        return entry.select.matches(":disabled") || ["loading", "stale"].includes(entry.select.dataset.selectState);
    }
    function visible(entry) {
        return entry.trigger.isConnected && entry.trigger.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
    }
    function close(restore = false) {
        popupRevision++;
        const entry = active;
        active = null;
        typeBuffer = "";
        if (typeof popup.hidePopover === "function" && popup.matches(":popover-open")) popup.hidePopover();
        popup.hidden = true;
        if (entry) {
            entry.draft = null;
            entry.updateDraft = null;
            attribute(entry.trigger, "aria-expanded", "false");
            attribute(entry.trigger, "aria-activedescendant", null);
            attribute(entry.trigger, "aria-describedby", entry.select.getAttribute("aria-describedby"));
            if (restore && visible(entry) && !entry.trigger.disabled) entry.trigger.focus({ preventScroll: true });
        }
        clearRendered(popup, list);
        list.replaceChildren();
        popup.replaceChildren(list);
        ux.hideTooltip();
        if (entry) onClose(entry.select);
    }
    function position(keepActive = true) {
        frame = 0;
        if (!active) return;
        if (!visible(active) || unavailable(active)) { close(); return; }
        const box = active.trigger.getBoundingClientRect();
        const viewport = window.visualViewport;
        const left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
        const width = viewport?.width || document.documentElement.clientWidth;
        const height = viewport?.height || innerHeight;
        const gap = 6, edge = 8;
        if (box.bottom <= top || box.top >= top + height || box.right <= left || box.left >= left + width) { close(); return; }
        const boundary = active.trigger.closest(".filter-scroll")?.getBoundingClientRect();
        if (boundary && (box.right <= boundary.left || box.left >= boundary.right)) { close(); return; }
        // Measuring the CSS height limit can temporarily clamp a scrolled list.
        const scrollTop = popup.scrollTop;
        popup.style.setProperty("--select-available-width", Math.max(0, width - edge * 2) + "px");
        popup.style.setProperty("--select-anchor-width", box.width + "px");
        popup.style.maxHeight = "";
        const availableBelow = top + height - box.bottom - gap - edge;
        const availableAbove = box.top - top - gap - edge;
        const limit = Math.min(parseFloat(getComputedStyle(popup).maxHeight), height - edge * 2);
        const wanted = Math.min(popup.scrollHeight, limit);
        const above = availableBelow < wanted && availableAbove > availableBelow;
        const available = Math.max(0, above ? availableAbove : availableBelow);
        popup.style.maxHeight = Math.min(limit, available) + "px";
        const popupWidth = popup.getBoundingClientRect().width;
        const anchorLeft = getComputedStyle(active.wrapper).justifySelf === "end" ? box.right - popupWidth : box.left;
        popup.style.left = Math.max(left + edge, Math.min(anchorLeft, left + width - popupWidth - edge)) + "px";
        const popupHeight = popup.getBoundingClientRect().height;
        const anchorTop = above ? box.top - popupHeight - gap : box.bottom + gap;
        popup.style.top = Math.max(top + edge, Math.min(anchorTop, top + height - popupHeight - edge)) + "px";
        popup.dataset.side = above ? "top" : "bottom";
        popup.scrollTop = scrollTop;
        if (keepActive && active.index >= 0) highlight(active.index);
    }
    function schedulePosition(event) {
        if (event?.target instanceof Node && (event.target === popup || popup.contains(event.target))) return;
        if (active && !frame) {
            const revision = popupRevision;
            frame = requestAnimationFrame(() => { if (revision === popupRevision) position(); });
        }
    }
    function highlight(index, scroll = true) {
        if (!active || index < 0 || active.options[index]?.disabled || list.querySelector(`[data-option-index="${index}"]`)?.hidden) return;
        active.index = index;
        [...popup.querySelectorAll(".select-option")].forEach((row, i) => {
            attribute(row, "data-active", i === index ? "true" : null);
        });
        const row = popup.querySelector(`[data-option-index="${index}"]`);
        attribute(active.trigger, "aria-activedescendant", row.id);
        attribute(active.trigger, "aria-describedby", [active.select.getAttribute("aria-describedby"), row.getAttribute("aria-describedby")].filter(Boolean).join(" ") || null);
        if (scroll) {
            const rowBox = row.getBoundingClientRect(), box = popup.getBoundingClientRect();
            if (rowBox.top < box.top + 6) popup.scrollTop -= box.top + 6 - rowBox.top;
            else if (rowBox.bottom > box.bottom - 6) popup.scrollTop += rowBox.bottom - box.bottom + 6;
        }
    }
    function open(entry, edge) {
        syncEntry(entry);
        if (entry.trigger.disabled || !visible(entry)) return;
        close();
        active = entry;
        const revision = popupRevision;
        const current = () => active === entry && revision === popupRevision;
        entry.index = -1;
        list.replaceChildren();
        popup.replaceChildren(list);
        entry.draft = entry.multiple ? new Set(selectedValues(entry)) : null;
        attribute(list, "aria-multiselectable", entry.multiple ? "true" : null);
        popup.classList.toggle("select-popup-multiple", entry.multiple);
        popup.classList.toggle("select-popup-filter", entry.filter);
        let lastGroup = "";
        entry.options.forEach((option, index) => {
            if (option.group && option.group !== lastGroup) {
                const heading = document.createElement("div");
                heading.className = "select-group";
                heading.setAttribute("role", "presentation");
                heading.textContent = option.group;
                list.append(heading);
            }
            lastGroup = option.group;
            const row = document.createElement("div");
            row.className = "select-option";
            row.id = entry.trigger.id + "-option-" + index;
            row.dataset.optionIndex = index;
            row.dataset.value = option.value;
            row.setAttribute("role", "option");
            row.setAttribute("aria-selected", String(option.node.selected));
            row.setAttribute("aria-disabled", String(option.disabled));
            const label = document.createElement("span");
            label.className = "select-option-label";
            label.id = row.id + "-label";
            label.textContent = option.displayLabel;
            decorateOption(label, { id: entry.select.id, value: option.value, label: option.displayLabel });
            row.setAttribute("aria-labelledby", label.id);
            const check = entry.filter && entry.multiple ? document.createElement("span") : ux.icon("select-check");
            check.classList.add(entry.filter && entry.multiple ? "select-toggle" : "select-check");
            check.setAttribute("aria-hidden", "true");
            row.append(label, check);
            if (option.count !== undefined) {
                const count = document.createElement("span");
                count.id = row.id + "-count";
                count.className = "select-option-count";
                count.textContent = option.count;
                row.insertBefore(count, check);
                row.setAttribute("aria-labelledby", label.id + " " + count.id);
            }
            if (option.detail) {
                const detail = document.createElement("span");
                detail.id = row.id + "-detail";
                detail.className = "select-option-detail";
                detail.textContent = option.detail;
                row.setAttribute("aria-describedby", detail.id);
                row.append(detail);
            }
            list.append(row);
        });
        if (entry.select.dataset.optionSearch === "true" && typeof matchesOption === "function") {
            const finder = document.createElement("input");
            const found = document.createElement("p"); found.className = "select-draft-hint"; found.setAttribute("role", "status"); found.hidden = true;
            finder.type = "search"; finder.placeholder = "Find an option"; finder.setAttribute("aria-label", "Find an option");
            finder.className = "select-option-search"; finder.autocomplete = "off";
            finder.addEventListener("input", () => {
                if (!current()) return;
                for (const row of list.querySelectorAll(".select-option")) row.hidden = !matchesOption(finder.value, entry.options[Number(row.dataset.optionIndex)].displayLabel);
                const next = [...list.querySelectorAll(".select-option")].find(row => !row.hidden && row.getAttribute("aria-disabled") !== "true");
                found.textContent = next ? "" : "No matching options."; found.hidden = Boolean(next);
                entry.index = -1;
                if (next) highlight(Number(next.dataset.optionIndex), false);
                position(false);
            });
            finder.addEventListener("keydown", event => {
                if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); }
                else if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); entry.trigger.focus(); }
                else if (event.key === "Enter") { event.preventDefault(); commit(entry.index); }
            });
            popup.prepend(finder); popup.append(found);
        }
        const paging = pagingFor(entry.select);
        if (paging) {
            const footer = document.createElement("div"), note = document.createElement("p");
            footer.className = "select-footer";
            note.className = "select-draft-hint";
            note.textContent = paging.label;
            footer.append(note);
            for (const [label, action] of [["Next Microsoft options", paging.next], ["First Microsoft options", paging.first]]) {
                if (typeof action !== "function") continue;
                const button = document.createElement("button");
                button.type = "button"; button.className = "quiet"; button.textContent = label;
                button.addEventListener("click", async () => {
                    if (!current()) return;
                    close(true);
                    const turn = popupRevision, access = withdrawalRevision;
                    await action();
                    if (access === withdrawalRevision && turn === popupRevision && document.activeElement === entry.trigger
                        && visible(entry) && !entry.trigger.disabled) open(entry);
                }, { signal: events.signal });
                footer.append(button);
            }
            popup.append(footer);
        }
        if (entry.multiple) {
            const all = document.createElement("button"), footer = document.createElement("div");
            const apply = document.createElement("button"), cancel = document.createElement("button"), hint = document.createElement("p");
            const allCaption = entry.filter ? document.createElement("span") : all;
            all.type = apply.type = cancel.type = "button";
            all.className = "select-all";
            all.setAttribute("role", "checkbox");
            if (entry.filter) {
                const marker = document.createElement("span");
                marker.className = "select-toggle";
                marker.setAttribute("aria-hidden", "true");
                allCaption.className = "select-all-label";
                all.append(allCaption, marker);
            }
            allCaption.textContent = entry.select.dataset.allLabel || "All results";
            footer.className = "select-footer";
            apply.textContent = "Apply";
            apply.className = entry.filter ? "select-apply" : "primary select-apply";
            cancel.textContent = "Cancel";
            hint.className = entry.filter ? "select-validation" : "select-draft-hint";
            hint.id = entry.trigger.id + "-draft-hint";
            hint.setAttribute("role", "status");
            apply.setAttribute("aria-describedby", hint.id);
            footer.append(apply, cancel);
            const immediate = entry.select.dataset.selectCommit === "immediate";
            apply.hidden = cancel.hidden = footer.hidden = immediate;
            popup.prepend(all);
            popup.append(hint, footer);
            entry.updateDraft = () => {
                if (!current()) return;
                const eligible = entry.options.filter(option => !option.disabled);
                const count = eligible.filter(option => entry.draft.has(option.value)).length;
                all.setAttribute("aria-checked", count === eligible.length ? "true" : count ? "mixed" : "false");
                allCaption.textContent = entry.filter ? entry.select.dataset.allLabel || "All results"
                    : `${count === eligible.length ? "Deselect" : "Select"} ${entry.select.dataset.allLabel?.toLowerCase() || "all results"}`;
                if (entry.select.hasAttribute("data-empty-value")) allCaption.textContent = "Clear selection";
                apply.disabled = entry.draft.size === 0;
                hint.hidden = (entry.filter || immediate) && entry.draft.size > 0;
                attribute(apply, "aria-describedby", hint.hidden ? null : hint.id);
                hint.textContent = entry.draft.size ? entry.filter || immediate ? "" : entry.select.dataset.draftHint || "Choose options, then Apply."
                    : entry.select.dataset.emptyHint || "Select at least one result.";
                for (const row of list.querySelectorAll(".select-option")) row.setAttribute("aria-selected", String(entry.draft.has(row.dataset.value)));
                if (!popup.hidden) position(false);
            };
            all.addEventListener("click", () => {
                if (!current()) return;
                const eligible = entry.options.filter(option => !option.disabled);
                if (entry.select.hasAttribute("data-empty-value")) entry.draft = new Set([entry.select.dataset.emptyValue]);
                else if (eligible.every(option => entry.draft.has(option.value))) entry.draft.clear();
                else eligible.forEach(option => entry.draft.add(option.value));
                entry.updateDraft();
                if (entry.select.dataset.selectCommit === "immediate" && entry.draft.size) applyDraft(entry);
            });
            apply.addEventListener("click", () => { if (current()) applyDraft(entry); });
            cancel.addEventListener("click", () => { if (current()) close(true); });
            entry.updateDraft();
        }
        attribute(list, "aria-labelledby", entry.trigger.getAttribute("aria-labelledby"));
        attribute(list, "aria-label", entry.trigger.getAttribute("aria-label"));
        (entry.trigger.closest("dialog[open]") || document.body).append(popup);
        popup.hidden = false;
        // Fixed positioning is the explicit compatibility path, never a native select popup.
        if (typeof popup.showPopover === "function") popup.showPopover();
        attribute(entry.trigger, "aria-expanded", "true");
        entry.trigger.focus({ preventScroll: true });
        ux.hideTooltip();
        const enabled = entry.options.map((option, index) => option.disabled ? -1 : index).filter((index) => index >= 0);
        const selected = entry.options.findIndex((option) => option.node.selected && !option.disabled);
        position();
        highlight(edge === "first" ? enabled[0] : edge === "last" ? enabled.at(-1) : selected >= 0 ? selected : enabled[0]);
        if (typeof paging?.load === "function") {
            const access = withdrawalRevision;
            Promise.resolve(paging.load()).then(loaded => {
                if (loaded === false || !current() || access !== withdrawalRevision) return;
                const draft = entry.draft && new Set(entry.draft), focused = entry.options[entry.index]?.value;
                close(true);
                const turn = popupRevision;
                // Let the existing close callback apply the completed option page first.
                queueMicrotask(() => {
                    if (access !== withdrawalRevision || turn !== popupRevision || document.activeElement !== entry.trigger
                        || !visible(entry) || entry.trigger.disabled) return;
                    open(entry);
                    if (active !== entry) return;
                    if (draft) { entry.draft = draft; entry.updateDraft?.(); }
                    const index = entry.options.findIndex(option => option.value === focused && !option.disabled);
                    if (index >= 0) highlight(index);
                });
            });
        }
    }
    function commit(index) {
        const revision = withdrawalRevision;
        const entry = active, option = entry?.options[index];
        if (!entry || !option || option.disabled) return;
        // A replaced option cannot commit a stale value into a newer snapshot.
        if (!entry.select.contains(option.node) || unavailable(entry)) { close(); sync(); return; }
        if (entry.multiple) {
            if (entry.draft.has(option.value)) entry.draft.delete(option.value);
            else entry.draft.add(option.value);
            if (entry.select.hasAttribute("data-empty-value")) {
                const empty = entry.select.dataset.emptyValue;
                if (option.value === empty || !entry.draft.size) entry.draft = new Set([empty]);
                else entry.draft.delete(empty);
            }
            highlight(index, false);
            entry.updateDraft();
            if (entry.select.dataset.selectCommit === "immediate" && entry.draft.size) applyDraft(entry);
            return;
        }
        const changed = entry.select.selectedIndex !== option.node.index
            || entry.select.dataset.pendingValue !== undefined && entry.select.dataset.pendingValue !== option.value;
        close();
        if (changed) {
            entry.select.selectedIndex = option.node.index;
            entry.select.dispatchEvent(new Event("input", { bubbles: true }));
            if (revision !== withdrawalRevision) return;
            entry.select.dispatchEvent(new Event("change", { bubbles: true }));
        }
        if (revision !== withdrawalRevision) return;
        sync();
        if (revision !== withdrawalRevision) return;
        if (visible(entry) && !entry.trigger.disabled) entry.trigger.focus({ preventScroll: true });
        ux.hideTooltip();
    }
    function applyDraft(entry) {
        const revision = withdrawalRevision;
        if (active !== entry || !entry.draft?.size || unavailable(entry)) return;
        if (entry.options.some(option => !entry.select.contains(option.node))) { close(); sync(); return; }
        const values = entry.options.filter(option => entry.draft.has(option.value)).map(option => option.value);
        const key = JSON.stringify(values);
        const changed = key !== selectionKey(entry)
            || entry.select.dataset.pendingValue !== undefined && entry.select.dataset.pendingValue !== key;
        close();
        if (changed) {
            for (const option of entry.options) option.node.selected = values.includes(option.value);
            entry.select.dispatchEvent(new Event("input", { bubbles: true }));
            if (revision !== withdrawalRevision) return;
            entry.select.dispatchEvent(new Event("change", { bubbles: true }));
        }
        if (revision !== withdrawalRevision) return;
        sync();
        if (revision !== withdrawalRevision) return;
        if (visible(entry) && !entry.trigger.disabled) entry.trigger.focus({ preventScroll: true });
        ux.hideTooltip();
    }
    function keydown(event, entry) {
        if (event.ctrlKey || event.metaKey || event.isComposing) return;
        const opened = active === entry;
        if (event.key === "Tab") {
            const finder = opened && popup.querySelector(".select-option-search");
            if (finder && !event.shiftKey) { event.preventDefault(); finder.focus(); }
            else if (opened && entry.multiple && entry.select.dataset.selectCommit !== "immediate" && !event.shiftKey) {
                event.preventDefault();
                popup.querySelector(".select-apply:not(:disabled), .select-footer button:last-child").focus();
            } else if (opened) close();
            return;
        }
        if (event.key === "Escape") {
            if (opened) { event.preventDefault(); event.stopPropagation(); close(true); }
            return;
        }
        if (["Enter", " "].includes(event.key) && (entry.multiple || !(event.key === " " && typeBuffer && performance.now() - typeTime <= 700))) {
            event.preventDefault();
            if (opened) commit(entry.index); else open(entry);
            return;
        }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            if (!opened) { open(entry, event.key === "Home" ? "first" : event.key === "End" ? "last" : undefined); return; }
            if (event.altKey && event.key === "ArrowUp") { close(true); return; }
            const enabled = entry.options.map((option, index) => option.disabled || list.querySelector(`[data-option-index="${index}"]`)?.hidden ? -1 : index).filter((index) => index >= 0);
            const current = enabled.indexOf(entry.index);
            highlight(event.key === "Home" ? enabled[0] : event.key === "End" ? enabled.at(-1) :
                enabled[Math.max(0, Math.min(enabled.length - 1, current + (event.key === "ArrowDown" ? 1 : -1)))]);
            return;
        }
        if (event.key.length !== 1 || event.altKey) return;
        event.preventDefault();
        if (!opened) open(entry);
        if (active !== entry) return;
        const now = performance.now();
        typeBuffer = now - typeTime > 700 ? event.key : typeBuffer + event.key;
        typeTime = now;
        const query = [...typeBuffer].every((char) => char === typeBuffer[0]) ? typeBuffer[0] : typeBuffer;
        const start = query.length === 1 ? entry.index + 1 : entry.index;
        for (let offset = 0; offset < entry.options.length; offset++) {
            const index = (Math.max(0, start) + offset) % entry.options.length, option = entry.options[index];
            if (!option.disabled && !list.querySelector(`[data-option-index="${index}"]`)?.hidden
                && option.label.trim().toLocaleLowerCase().startsWith(query.toLocaleLowerCase())) {
                highlight(index);
                break;
            }
        }
    }
    function syncEntry(entry) {
        const { select, trigger, value } = entry;
        const options = optionsFor(select);
        const signature = JSON.stringify(options.map((option) => [option.value, option.label, option.displayLabel, option.count, option.disabled, option.group, option.detail]));
        const replaced = options.some((option, index) => option.node !== entry.options[index]?.node);
        if (entry.sizer && signature !== entry.signature) {
            clearRendered(entry.sizer);
            entry.sizer.replaceChildren(...options.map(option => {
                const size = document.createElement("span");
                size.textContent = option.label;
                return size;
            }));
        }
        const selected = options.filter(option => option.node.selected);
        const selectedKey = entry.multiple ? JSON.stringify(selected.map(option => option.value)) : select.value;
        if (active === entry && (signature !== entry.signature || replaced || !entry.multiple && selectedKey !== entry.selectedValue || unavailable(entry))) close();
        entry.options = options;
        entry.signature = signature;
        entry.selectedValue = selectedKey;
        const state = select.dataset.selectState;
        const text = state === "loading" ? "Loading options..." : state === "stale" ? "Refresh to choose" :
            entry.multiple && selected.length > 1 ? selected.length === options.length ? select.dataset.allLabel || "All results" : `${selected.length} ${select.dataset.selectionNoun || "statuses"}`
                : select.selectedOptions[0]?.label || (options.length ? "Choose an option" : "No options available");
        const presentation = JSON.stringify([text, selectedKey, state]);
        if (entry.presentation !== presentation) {
            clearRendered(value);
            value.textContent = text;
            if (!["loading", "stale"].includes(state)) decorateOption(value, { id: select.id, value: entry.multiple && selected.length !== 1 ? "all" : select.value, label: text });
            entry.presentation = presentation;
        }
        attribute(trigger, "disabled", unavailable(entry) || !options.some((option) => !option.disabled) ? "" : null);
        attribute(trigger, "aria-busy", state === "loading" ? "true" : null);
        attribute(trigger, "aria-invalid", select.getAttribute("aria-invalid"));
        attribute(trigger, "aria-required", select.required ? "true" : null);
        attribute(trigger, "data-filter-active", entry.filter && (entry.multiple ? selected.length < options.length : selected[0]?.value !== options[0]?.value) ? "true" : null);
        const activeDescription = active === entry ? popup.querySelector(`[data-option-index="${entry.index}"]`)?.getAttribute("aria-describedby") : null;
        const tooltipDescriptions = (trigger.getAttribute("aria-describedby") || "").split(/\s+/)
            .filter(id => document.getElementById(id)?.getAttribute("role") === "tooltip");
        attribute(trigger, "aria-describedby", [select.getAttribute("aria-describedby"), activeDescription, ...tooltipDescriptions].filter(Boolean).join(" ") || null);
        attribute(trigger, "aria-label", select.getAttribute("aria-label"));
        attribute(trigger, "aria-labelledby", select.getAttribute("aria-label") ? null : select.getAttribute("aria-labelledby") || entry.labelIds.join(" ") || null);
        if (active === entry && !visible(entry)) close();
    }
    function enhance(select) {
        if (select.multiple && select.dataset.selectMode !== "multiple" || !select.multiple && select.size > 1) throw new TypeError("Multiple selection requires an explicit select mode.");
        const filter = Boolean(select.closest("#filters")) || select.dataset.selectPresentation === "filter";
        const trigger = document.createElement("button"), wrapper = document.createElement("span"), value = document.createElement("span");
        const id = select.id || "evidence-select-" + ++sequence;
        const labels = [...select.labels];
        const labelContainers = [];
        for (const label of labels) if (label.contains(select)) {
            const container = document.createElement("div");
            const originalClass = label.getAttribute("class"), originalId = label.getAttribute("id");
            container.className = [originalClass, "select-field"].filter(Boolean).join(" ");
            if (originalId) container.id = originalId;
            label.replaceWith(container);
            container.append(label, select);
            label.removeAttribute("class");
            label.removeAttribute("id");
            labelContainers.push({ container, label, originalClass, originalId });
        }
        trigger.id = id + "-control";
        trigger.type = "button";
        trigger.className = "select-trigger" + (filter ? " select-trigger-filter" : "");
        trigger.dataset.selectId = id;
        trigger.setAttribute("role", "combobox");
        trigger.setAttribute("aria-haspopup", "listbox");
        trigger.setAttribute("aria-expanded", "false");
        trigger.setAttribute("aria-controls", list.id);
        const labelIds = labels.map((label, index) => {
            if (!label.id) label.id = id + "-label-" + index;
            return label.id;
        });
        for (const label of labels) label.htmlFor = trigger.id;
        wrapper.className = "select-control";
        wrapper.dataset.selectFor = id;
        value.className = "select-value";
        const chevron = ux.icon("chevron");
        chevron.classList.add("select-chevron");
        trigger.append(value, chevron);
        // An intrinsic grid shares the trigger's real font and tracks option/font
        // changes without measuring the caption's smaller em size.
        const sizer = select.closest(".chart-heading") ? document.createElement("span") : null;
        if (sizer) {
            sizer.className = "select-option-sizer";
            sizer.setAttribute("aria-hidden", "true");
            trigger.append(sizer);
        }
        const entry = { select, trigger, wrapper, value, sizer, labelIds, labels, labelContainers, multiple: select.multiple,
            filter, options: [], signature: "", selectedValue: null };
        controls.set(select, entry);
        select.replaceWith(wrapper);
        wrapper.append(select, trigger);
        select.classList.add("select-source");
        attribute(select, "aria-hidden", "true");
        select.tabIndex = -1;
        ux.tooltip(trigger, () => trigger.getAttribute("aria-expanded") === "true" || value.scrollWidth <= value.clientWidth ? "" : value.textContent);
        listen(trigger, "click", () => active === entry ? close(true) : open(entry));
        listen(trigger, "keydown", (event) => keydown(event, entry));
        listen(select, "change", () => syncEntry(entry));
        listen(select, "invalid", (event) => { event.preventDefault(); attribute(trigger, "aria-invalid", "true"); trigger.focus(); });
        syncEntry(entry);
    }
    function sync() {
        document.querySelectorAll("select:not([data-native-select])").forEach((select) => { if (!controls.has(select)) enhance(select); });
        for (const [select, entry] of controls) {
            if (!select.isConnected) {
                if (active === entry) close();
                if (entry.wrapper.isConnected) entry.wrapper.remove();
                controls.delete(select);
            } else {
                attribute(entry.wrapper, "hidden", select.hidden ? "" : null);
                syncEntry(entry);
            }
        }
    }
    function withdrawAccess() {
        withdrawalRevision++;
        close(false);
        cancelAnimationFrame(frame);
        frame = 0;
        typeBuffer = "";
        typeTime = 0;
        dismissedPointer = null;
        clearRendered(popup, list);
        list.replaceChildren();
        for (const name of ["aria-labelledby", "aria-label", "aria-multiselectable"]) clearAttribute(list, name);
        popup.replaceChildren(list);
        clearAttribute(popup, "style");
        clearAttribute(popup, "data-side");
        popup.classList.remove("select-popup-multiple", "select-popup-filter");
        for (const entry of controls.values()) {
            entry.options.length = 0;
            entry.options = [];
            entry.draft?.clear();
            entry.draft = null;
            entry.updateDraft = null;
            entry.signature = "";
            entry.selectedValue = null;
            entry.presentation = null;
            entry.index = -1;
            if (entry.sizer) { clearRendered(entry.sizer); entry.sizer.replaceChildren(); }
            clearRendered(entry.value);
            entry.value.replaceChildren();
            for (const attribute of [...entry.value.attributes]) {
                if (attribute.name !== "class") clearAttribute(entry.value, attribute.name);
            }
            entry.value.className = "select-value";
            attribute(entry.trigger, "aria-activedescendant", null);
        }
        sync();
    }
    listen(popup, "pointerdown", (event) => event.preventDefault());
    listen(popup, "keydown", (event) => {
        if (event.key === "Escape" && active) { event.preventDefault(); event.stopPropagation(); close(true); }
    });
    listen(popup, "pointermove", (event) => {
        const row = event.target.closest(".select-option");
        if (row && list.contains(row)) highlight(Number(row.dataset.optionIndex), false);
    });
    listen(popup, "click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const row = event.target.closest(".select-option");
        if (row && list.contains(row)) commit(Number(row.dataset.optionIndex));
    });
    listen(document, "pointerdown", (event) => {
        dismissedPointer = null;
        if (!active || active.trigger.contains(event.target) || popup.contains(event.target)) return;
        dismissedPointer = event.pointerId;
        event.preventDefault();
        event.stopImmediatePropagation();
        close(true);
    }, { capture: true });
    listen(document, "click", (event) => {
        if (dismissedPointer == null || event.detail === 0) return;
        dismissedPointer = null;
        event.preventDefault();
        event.stopImmediatePropagation();
    }, { capture: true });
    listen(document, "pointercancel", () => { dismissedPointer = null; }, { capture: true });
    listen(document, "focusin", (event) => { if (active && event.target !== active.trigger && !popup.contains(event.target)) close(); });
    ux.dismissOnFrameFocus(() => { if (active) close(); }, { signal: events.signal });
    listen(document, "scroll", schedulePosition, { capture: true });
    listen(window, "resize", schedulePosition);
    listen(document.fonts, "loadingdone", schedulePosition);
    if (window.visualViewport) {
        listen(window.visualViewport, "resize", schedulePosition);
        listen(window.visualViewport, "scroll", schedulePosition);
    }
    listen(document, "toggle", () => { if (active && !visible(active)) close(); }, { capture: true });
    listen(document, "close", event => {
        if (active && event.target instanceof HTMLDialogElement && !event.target.open && event.target.contains(active.trigger)) close();
    }, { capture: true });
    listen(window, "pagehide", () => close());
    listen(document, "visibilitychange", () => { if (document.hidden) close(); });
    listen(document, "reset", () => queueMicrotask(sync));
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true,
        attributeFilter: ["disabled", "hidden", "selected", "label", "value", "class", "aria-label", "aria-labelledby", "aria-describedby", "aria-invalid", "required", "data-select-state", "data-all-label", "data-detail", "data-disabled-reason", "data-option-label", "data-count", "open"] });
    sync();
    return { sync, close, withdrawAccess, destroy() {
        close();
        observer.disconnect();
        events.abort();
        cancelAnimationFrame(frame);
        popup.remove();
        for (const { select, trigger, wrapper, labels, labelContainers } of controls.values()) {
            for (const label of labels) if (label.htmlFor === trigger.id) label.htmlFor = select.id;
            select.classList.remove("select-source");
            select.removeAttribute("aria-hidden");
            select.removeAttribute("tabindex");
            wrapper.replaceWith(select);
            for (const { container, label, originalClass, originalId } of labelContainers) {
                label.append(select);
                attribute(label, "class", originalClass);
                attribute(label, "id", originalId);
                container.replaceWith(label);
            }
        }
        controls.clear();
    } };
}
