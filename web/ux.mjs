// Kept self-contained because the local shell serializes this function into its nonce-authorized script.
export function createEvidenceUX(icons) {
    const descriptions = new WeakMap();
    const tooltipOptions = new WeakMap();
    const disabledReasons = new WeakMap();
    const pendingIcons = new WeakMap();
    const copySources = new WeakMap();
    const bubble = document.createElement("div");
    bubble.id = "evidence-tooltip";
    bubble.className = "ux-tooltip";
    bubble.setAttribute("role", "tooltip");
    bubble.setAttribute("popover", "manual");
    bubble.hidden = true;
    document.body.append(bubble);
    const events = new AbortController();
    const tooltipResize = new ResizeObserver(() => positionTooltip());
    let active = null, hovered = null, focused = null, pinned = null, opening = null, openTimer = null, closeTimer = null;
    let suppressedPointer = null, suppressedFocus = null, pointer = null;
    let inputSource = "focus", focusSource = null;
    let restoredPage = ["reload", "back_forward"].includes(performance.getEntriesByType("navigation")[0]?.type);
    let restoredPointer = restoredPage;

    function listen(node, type, handler, options = {}) {
        node.addEventListener(type, handler, { ...options, signal: events.signal });
    }
    function setOwnedText(node, value = "") {
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        for (let text = walker.nextNode(); text; text = walker.nextNode()) text.data = "";
        node.textContent = value;
    }
    function removeOwnedAttribute(node, name) {
        const attribute = node.getAttributeNode(name);
        if (attribute) attribute.value = "";
        node.removeAttribute(name);
    }
    // Keep only the current interaction's identities, not a history of visited controls.
    function identity(node) {
        if (!node) return null;
        node = tooltipOptions.get(node)?.owner || node;
        if (node.id) return "id:" + node.id;
        const owner = node.closest("[data-view-key], [id]");
        const scope = owner?.dataset.viewKey || owner?.id || "";
        const peers = [...(owner || document.body).querySelectorAll("[data-ux-tooltip]")];
        return JSON.stringify([scope, node.tagName, node.getAttribute("aria-label"), node.getAttribute("href"), peers.indexOf(node)]);
    }
    function suppressHover(node) {
        const key = identity(node);
        suppressedPointer = node.matches(":hover") || identity(hovered) === key || bubble.matches(":hover") ? key : null;
    }
    function suppress(node) {
        if (!node) return;
        suppressHover(node);
        suppressedFocus = identity(node);
    }

    function tooltipText(registration) {
        const value = registration.text;
        const text = typeof value === "function" ? value() : value;
        return text ? String(text) : "";
    }
    function currentTooltip(node, registration) {
        return descriptions.get(node) === registration && node.isConnected && node.checkVisibility();
    }
    function retireTooltip(node) {
        const registration = descriptions.get(node);
        if (registration) registration.text = null;
        descriptions.delete(node); tooltipOptions.delete(node);
        removeOwnedAttribute(node, "data-ux-tooltip");
    }
    function visibleTooltipBox(node) {
        const raw = node.getBoundingClientRect();
        const box = { left: Math.max(0, raw.left), right: Math.min(document.documentElement.clientWidth, raw.right),
            top: Math.max(0, raw.top), bottom: Math.min(window.innerHeight, raw.bottom) };
        if (box.right <= box.left || box.bottom <= box.top) return null;
        for (let parent = node.parentElement; parent; parent = parent.parentElement) {
            const css = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
            const left = bounds.left + (parent.clientLeft || 0), top = bounds.top + (parent.clientTop || 0);
            const boundary = parent.hasAttribute("data-ux-tooltip-boundary");
            if (boundary || ["hidden", "clip", "auto", "scroll"].includes(css.overflowX)) {
                box.left = Math.max(box.left, left);
                box.right = Math.min(box.right, parent instanceof HTMLElement ? left + parent.clientWidth : bounds.right);
            }
            if (boundary || ["hidden", "clip", "auto", "scroll"].includes(css.overflowY)) {
                box.top = Math.max(box.top, top);
                box.bottom = Math.min(box.bottom, parent instanceof HTMLElement ? top + parent.clientHeight : bounds.bottom);
            }
            if (box.right <= box.left || box.bottom <= box.top) return null;
        }
        return box;
    }
    function positionTooltip() {
        if (!active) return;
        const target = active;
        if (!target.isConnected || !target.checkVisibility()) { hideTooltip(); return; }
        const options = tooltipOptions.get(target) || {}, anchor = options.anchor || target;
        if (!anchor.isConnected || !anchor.checkVisibility()) { hideTooltip(); return; }
        const box = visibleTooltipBox(anchor), tip = bubble.getBoundingClientRect();
        if (!box) { hideTooltip(); return; }
        const width = document.documentElement.clientWidth, height = window.innerHeight;
        const gap = parseFloat(getComputedStyle(bubble).getPropertyValue("--tooltip-gap"));
        const owner = options.owner || target;
        const group = (owner.closest(".ux-disabled-help") || owner).parentElement;
        const neighbors = [...(group?.querySelectorAll("button,a[href],input,select,textarea,summary,[role=button],[role=combobox]") || [])]
            .filter(node => node !== owner && !node.contains(owner) && !owner.contains(node));
        const avoid = typeof options.avoid === "function" ? options.avoid() : options.avoid;
        if (active !== target || tooltipOptions.get(target) !== options) return;
        if (!target.isConnected || !target.checkVisibility()) { hideTooltip(); return; }
        const protectedBoxes = [...new Set([...neighbors, ...(avoid || [])])]
            .filter(node => node.isConnected && node.checkVisibility({ visibilityProperty: true }))
            .map(visibleTooltipBox).filter(Boolean);
        const centerX = (box.left + box.right - tip.width) / 2, centerY = (box.top + box.bottom - tip.height) / 2;
        const sides = {
            right: { left: box.right + gap, top: centerY }, left: { left: box.left - tip.width - gap, top: centerY },
            bottom: { left: centerX, top: box.bottom + gap }, top: { left: centerX, top: box.top - tip.height - gap },
        };
        const order = options.placement === "right" ? ["right", "left", "bottom", "top"]
            : options.placement === "top" ? ["top", "bottom", "right", "left"] : ["bottom", "top", "right", "left"];
        const preferred = sides[order[0]];
        const candidates = order.map(side => sides[side]);
        for (const rect of protectedBoxes) candidates.push(
            { left: preferred.left, top: rect.top - tip.height - gap },
            { left: preferred.left, top: rect.bottom + gap },
            { left: rect.left - tip.width - gap, top: preferred.top },
            { left: rect.right + gap, top: preferred.top });
        const overlap = (point, rect) => Math.max(0, Math.min(point.left + tip.width, rect.right) - Math.max(point.left, rect.left))
            * Math.max(0, Math.min(point.top + tip.height, rect.bottom) - Math.max(point.top, rect.top));
        const ranked = candidates.map((point, index) => {
            const clamped = { left: Math.max(gap, Math.min(width - tip.width - gap, point.left)),
                top: Math.max(gap, Math.min(height - tip.height - gap, point.top)) };
            return { ...clamped, index, ownerOverlap: overlap(clamped, box),
                overlap: protectedBoxes.reduce((sum, rect) => sum + overlap(clamped, rect), 0),
                distance: Math.hypot(clamped.left - preferred.left, clamped.top - preferred.top) };
        }).sort((a, b) => a.ownerOverlap - b.ownerOverlap || a.overlap - b.overlap || a.distance - b.distance || a.index - b.index);
        const position = ranked[0];
        if (bubble.style.left !== position.left + "px") bubble.style.left = position.left + "px";
        if (bubble.style.top !== position.top + "px") bubble.style.top = position.top + "px";
    }
    function clearTooltip() {
        tooltipResize.disconnect();
        clearTimeout(openTimer);
        clearTimeout(closeTimer);
        openTimer = null;
        closeTimer = null;
        opening = null;
        if (active) {
            const ids = (active.getAttribute("aria-describedby") || "").split(/\s+/).filter((id) => id && id !== bubble.id);
            if (ids.length) active.setAttribute("aria-describedby", ids.join(" "));
            else removeOwnedAttribute(active, "aria-describedby");
        }
        if (bubble.matches(":popover-open")) bubble.hidePopover();
        bubble.hidden = true;
        setOwnedText(bubble);
        active = null;
        pinned = null;
    }
    function hideTooltip() {
        const node = active || opening;
        if (node) {
            suppressHover(node);
            if (identity(focused) === identity(node)) suppressedFocus = identity(node);
        }
        clearTooltip();
    }
    function restoreFocus(node) {
        if (!node) return;
        suppress(trigger(node));
        if (focused === trigger(node)) focusSource = "restored";
        node.focus({ preventScroll: true });
    }
    function dismissOnFrameFocus(requestClose, { signal = events.signal } = {}) {
        const enteredFrame = () => queueMicrotask(() => {
            if (!signal.aborted && !events.signal.aborted && document.hasFocus()
                && document.activeElement instanceof HTMLIFrameElement) requestClose(document.activeElement);
        });
        window.addEventListener("blur", enteredFrame, { signal });
        return () => window.removeEventListener("blur", enteredFrame);
    }
    // Embedded documents do not bubble pointer/focus events into the shell.
    // Keep native auto-popover dismissal without inspecting or modifying the frame.
    dismissOnFrameFocus(frame => {
        hideTooltip();
        for (const panel of document.querySelectorAll('[popover="auto"]:popover-open')) {
            if (!panel.contains(frame)) panel.hidePopover();
        }
    });
    function dismissOnOutside(dialog, requestClose) {
        if (!(dialog instanceof HTMLDialogElement) || typeof requestClose !== "function") {
            throw new TypeError("Outside dismissal requires a native dialog and its owner's close handler.");
        }
        let outsidePointer = null;
        const outside = event => {
            if (event.target !== dialog || !dialog.open || !dialog.matches(":modal")) return false;
            const box = dialog.getBoundingClientRect();
            return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
        };
        listen(dialog, "pointerdown", event => {
            outsidePointer = event.button === 0 && outside(event) ? event.pointerId : null;
        });
        listen(dialog, "pointercancel", () => { outsidePointer = null; });
        listen(dialog, "close", () => { outsidePointer = null; });
        listen(dialog, "click", event => {
            const dismiss = outsidePointer !== null && event.detail > 0 && outside(event);
            outsidePointer = null;
            if (!dismiss) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            requestClose();
        });
    }
    function showTooltip(node, source = "focus") {
        if (!node?.isConnected || !node.checkVisibility()) return false;
        const registration = descriptions.get(node);
        if (!registration) return false;
        const key = identity(node);
        if (source !== "help" && (source === "pointer" ? suppressedPointer === key : suppressedFocus === key)) return false;
        const text = tooltipText(registration);
        if (!currentTooltip(node, registration)) return false;
        if (!text) { hideTooltip(); return false; }
        clearTooltip();
        if (!currentTooltip(node, registration)) return false;
        active = node;
        setOwnedText(bubble, text);
        bubble.scrollTop = bubble.scrollLeft = 0;
        bubble.dataset.tone = tooltipOptions.get(node)?.tone || "default";
        (node.closest("dialog[open]") || document.body).append(bubble);
        const ids = new Set((node.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
        ids.add(bubble.id);
        node.setAttribute("aria-describedby", [...ids].join(" "));
        bubble.hidden = false;
        if (typeof bubble.showPopover === "function") bubble.showPopover();
        if (active !== node || !currentTooltip(node, registration)) return false;
        positionTooltip();
        tooltipResize.observe(bubble);
        tooltipResize.observe(node);
        const anchor = tooltipOptions.get(node)?.anchor;
        if (anchor && anchor !== node) tooltipResize.observe(anchor);
        return active === node && currentTooltip(node, registration);
    }
    function scheduleClose() {
        clearTimeout(openTimer);
        openTimer = null;
        opening = null;
        // Outside movement and description refreshes must not extend the transit grace.
        if (closeTimer !== null) return;
        closeTimer = setTimeout(() => {
            closeTimer = null;
            const liveOwner = node => {
                const owner = tooltipOptions.get(node)?.owner || node;
                return node?.isConnected && owner?.isConnected ? owner : null;
            };
            const owner = liveOwner(active);
            const keyboardVisit = owner && owner === liveOwner(focused) && focusSource === "focus";
            const sameOwnerHover = owner && owner === liveOwner(hovered);
            if (!bubble.matches(":hover") && !sameOwnerHover && !keyboardVisit && active !== pinned) clearTooltip();
        }, 120);
    }
    function cancelClose() {
        clearTimeout(closeTimer);
        closeTimer = null;
    }
    function trigger(target) { return target instanceof Element ? target.closest("[data-ux-tooltip]") : null; }
    // A layout update can synthesize pointerover without a new pointer visit.
    // Only movement across a target boundary begins another hover episode.
    listen(document, "pointermove", (event) => {
        if (event.pointerType === "touch" || !event.isTrusted) return;
        if (pointer?.x === event.clientX && pointer?.y === event.clientY) return;
        pointer = { x: event.clientX, y: event.clientY };
        restoredPage = false;
        if (bubble.contains(event.target)) { cancelClose(); return; }
        const node = trigger(event.target);
        if (node && node === active) cancelClose();
        if (node && node === hovered) return;
        const key = identity(node);
        if (key !== suppressedPointer) suppressedPointer = null;
        hovered = node;
        clearTimeout(openTimer);
        openTimer = null;
        opening = null;
        if (!node) { scheduleClose(); return; }
        if (node === active) return;
        if (key === suppressedPointer) return;
        opening = node;
        openTimer = setTimeout(() => { openTimer = null; opening = null; showTooltip(node, "pointer"); }, tooltipOptions.get(node)?.immediatePointer === true ? 0 : 180);
    });
    listen(document, "pointerover", (event) => {
        if (bubble.contains(event.target) || active && active.contains(event.target)) cancelClose();
        else if (restoredPointer && event.pointerType !== "touch") {
            restoredPointer = false;
            hovered = trigger(event.target);
            suppressedPointer = identity(hovered);
            pointer = { x: event.clientX, y: event.clientY };
        }
    });
    listen(document, "pointerout", (event) => {
        if (bubble.contains(event.target) && !bubble.contains(event.relatedTarget)) { scheduleClose(); return; }
        const node = trigger(event.target);
        if (!node || node.contains(event.relatedTarget)) return;
        if (hovered === node) hovered = null;
        scheduleClose();
    });
    listen(document, "focusin", (event) => {
        const node = trigger(event.target);
        focused = node;
        focusSource = inputSource;
        if (restoredPage) { suppressedFocus = identity(node); focusSource = "restored"; return; }
        if (identity(node) !== suppressedFocus) suppressedFocus = null;
        else if (node) focusSource = "restored";
        if (node) showTooltip(node);
    });
    listen(document, "focusout", (event) => {
        const node = trigger(event.target);
        if (node && !node.contains(event.relatedTarget)) {
            if (focused === node) { focused = null; focusSource = null; }
            if (pinned === node) pinned = null;
            scheduleClose();
        }
    });
    function action(target) {
        const node = target instanceof Element ? target.closest("button,a[href],input[type=button],input[type=submit],input[type=reset],input[type=checkbox],input[type=radio],summary,[role=button]") : null;
        return node && !node.matches(":disabled,[aria-disabled=true],.ux-help") ? node : null;
    }
    function activate(target) {
        const control = action(target);
        if (!control) return;
        const node = trigger(control);
        hideTooltip();
        suppress(node);
    }
    listen(document, "pointerdown", (event) => {
        restoredPage = false;
        inputSource = "pointer";
        if (focused && focused.contains(event.target)) focusSource = "pointer";
        if (!bubble.contains(event.target)) {
            if (active && !active.contains(event.target)) hideTooltip();
            activate(event.target);
        }
    }, { capture: true });
    listen(document, "click", (event) => activate(event.target), { capture: true });
    listen(document, "click", (event) => {
        const node = trigger(event.target);
        if (tooltipOptions.get(node)?.helpOnActivate) {
            const owner = tooltipOptions.get(node)?.owner || node;
            if (showTooltip(owner, "help")) pinned = owner;
        }
    });
    listen(document, "keydown", (event) => {
        if (event.isTrusted) { restoredPage = false; inputSource = "focus"; }
        // Tab starts a deliberate keyboard visit; rendering never emits a Tab.
        if (event.key === "Tab") suppressedFocus = null;
        if (active && focused === active && focusSource === "focus" && ["PageDown", "PageUp"].includes(event.key)
            && !event.target.closest?.("input,textarea,select,[contenteditable],[role=combobox],[role=option],[role=menuitem]")
            && bubble.scrollHeight > bubble.clientHeight) {
            bubble.scrollTop += (event.key === "PageDown" ? 1 : -1) * bubble.clientHeight * .8;
            event.preventDefault();
            event.stopImmediatePropagation();
            return;
        }
        if (event.key === "Escape" && (active || openTimer)) {
            hideTooltip();
            event.preventDefault();
            // An expanded combobox still owns Escape, even if pointer hover opened help.
            if (!event.target.closest?.('[role="combobox"][aria-expanded="true"]')) event.stopImmediatePropagation();
        }
    }, { capture: true });
    listen(document, "scroll", positionTooltip, { capture: true });
    listen(window, "resize", positionTooltip);
    listen(document, "toggle", (event) => {
        if (active && event.target instanceof HTMLDetailsElement && !event.target.open && event.target.contains(active)) hideTooltip();
    }, { capture: true });
    listen(document, "close", hideTooltip, { capture: true });
    listen(window, "pagehide", hideTooltip);
    listen(window, "pageshow", event => { if (event.persisted) { restoredPage = restoredPointer = true; pointer = null; hideTooltip(); } });
    listen(window, "hashchange", hideTooltip);
    listen(window, "popstate", hideTooltip);
    listen(document, "visibilitychange", () => { if (document.visibilityState === "hidden") hideTooltip(); });
    const observer = new MutationObserver((changes) => {
        for (const change of changes) {
            if (change.type === "attributes") syncDisabled(change.target);
            else {
                enhanceDisclosures(change.target);
                for (const node of change.addedNodes) if (node instanceof Element) enhanceDisclosures(node);
                for (const node of change.removedNodes) if (node instanceof Element && !node.isConnected) {
                    for (const control of [node, ...node.querySelectorAll(".ux-copy,[data-ux-tooltip]")]) retireRegistrations(control);
                }
            }
        }
        if (active && (!active.isConnected || !active.checkVisibility())) hideTooltip();
        else if (active) positionTooltip();
        if (opening && (!opening.isConnected || !opening.checkVisibility())) hideTooltip();
        if (hovered && !hovered.isConnected) hovered = null;
        if (focused && !focused.isConnected) { focused = null; focusSource = null; }
        if (pinned && !pinned.isConnected) pinned = null;
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled", "hidden"] });
    enhanceDisclosures(document.body);

    function enhanceDisclosures(root) {
        const owner = root.closest("details>summary");
        const summaries = [...root.querySelectorAll("details>summary")];
        if (owner) summaries.unshift(owner);
        for (const summary of summaries) {
            const host = summary.classList.contains("saved-report-summary") ? summary.querySelector(".saved-report-manage") : summary;
            if (!host) continue;
            if (!host.querySelector(":scope>.disclosure-icon")) {
                const glyph = icon("disclosure");
                glyph.classList.add("disclosure-icon");
                if (host === summary) host.prepend(glyph);
                else host.append(glyph);
            }
            summary.classList.add("ux-disclosure");
        }
    }

    function tooltip(node, text, options = {}) {
        const previous = descriptions.get(node);
        if (previous) previous.text = null;
        const registration = { text };
        descriptions.set(node, registration);
        tooltipOptions.set(node, options);
        node.dataset.uxTooltip = "";
        removeOwnedAttribute(node, "title");
        if (active === node) {
            const value = tooltipText(registration);
            if (active !== node || !currentTooltip(node, registration)) return node;
            if (!value) hideTooltip();
            else { setOwnedText(bubble, value); positionTooltip(); }
        }
        return node;
    }
    function syncDisabled(control) {
        const entry = disabledReasons.get(control);
        if (!entry) return;
        entry.wrapper.tabIndex = control.disabled ? 0 : -1;
        if (entry.help) entry.help.hidden = !control.disabled;
        if (entry.compact) {
            entry.wrapper.hidden = control.hidden;
            if (control.disabled) {
                control.removeAttribute("data-ux-tooltip");
                if (active === control) hideTooltip();
            } else if (descriptions.has(control)) control.dataset.uxTooltip = "";
        }
        if (control.disabled) {
            entry.help?.setAttribute("aria-label", "About unavailable " + (control.getAttribute("aria-label") || control.textContent));
            entry.wrapper.setAttribute("role", "group");
            entry.wrapper.setAttribute("aria-label", control.getAttribute("aria-label") || control.textContent);
            tooltip(entry.wrapper, entry.reason, { owner: control, ...(entry.compact ? { anchor: control } : {}) });
        } else {
            entry.wrapper.removeAttribute("role");
            entry.wrapper.removeAttribute("aria-label");
            entry.wrapper.removeAttribute("data-ux-tooltip");
            if (active === entry.wrapper) hideTooltip();
        }
    }
    function explainDisabled(control, reason, { compact = false } = {}) {
        const existing = disabledReasons.get(control);
        if (existing) { existing.reason = reason; syncDisabled(control); return existing.wrapper; }
        const wrapper = document.createElement("span");
        wrapper.className = "ux-disabled-help";
        control.replaceWith(wrapper);
        const entry = { wrapper, reason, compact, help: null };
        wrapper.append(control);
        if (!compact) {
            entry.help = helpButton("unavailable action", () => typeof entry.reason === "function" ? entry.reason() : entry.reason);
            wrapper.append(entry.help);
        }
        disabledReasons.set(control, entry);
        syncDisabled(control);
        return wrapper;
    }
    function icon(name) {
        if (!Object.hasOwn(icons, name) || typeof icons[name] !== "string") throw new TypeError(`Unknown Lucide icon: ${name}`);
        const svg = new DOMParser().parseFromString(icons[name], "image/svg+xml").documentElement;
        if (svg.localName !== "svg" || svg.namespaceURI !== "http://www.w3.org/2000/svg" || svg.querySelector("parsererror")) throw new TypeError(`Invalid Lucide icon: ${name}`);
        const node = document.importNode(svg, true);
        node.setAttribute("aria-hidden", "true");
        node.setAttribute("focusable", "false");
        node.removeAttribute("id");
        return node;
    }
    function helpButton(label, text) {
        const control = document.createElement("button");
        control.type = "button";
        control.className = "ux-help";
        control.setAttribute("aria-label", "About " + label);
        const glyph = icon("info");
        control.append(glyph);
        tooltip(control, text, { anchor: glyph });
        control.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (showTooltip(control, "help")) pinned = control;
        });
        return control;
    }
    function utility(control, role, label, tip = label) {
        control.classList.add("icon-action", "icon-only");
        control.setAttribute("aria-label", label);
        control.replaceChildren(icon(role));
        tooltip(control, tip);
        return control;
    }
    function copyButton({ label, getText, tooltip: help = label }) {
        if (!label || typeof getText !== "function") throw new TypeError("Clipboard controls require a contextual label and an explicit text getter.");
        const control = document.createElement("button");
        control.type = "button";
        control.className = "ux-copy";
        const source = { read: getText, revoke };
        copySources.set(control, source);
        getText = null;
        control.setAttribute("aria-label", label);
        function paintIcon(name) {
            control.replaceChildren(icon(name));
        }
        paintIcon("copy");
        tooltip(control, help);
        const status = document.createElement("p");
        status.className = "ux-copy-status visually-hidden";
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        status.hidden = true;
        let pending = false, retired = false, resetTimer;
        const current = () => !retired && control.isConnected && copySources.get(control) === source;
        function revoke() {
            retired = true; source.read = null; label = help = "";
            clearTimeout(resetTimer);
            copySources.delete(control);
            retireTooltip(control);
            for (const name of ["data-ux-tooltip", "data-copy-state", "aria-label", "aria-disabled", "aria-busy"]) removeOwnedAttribute(control, name);
            control.disabled = true;
            setOwnedText(status); status.remove();
        }
        class CopyUnavailableError extends Error {}
        control.addEventListener("click", async () => {
            if (retired || !control.isConnected || pending || control.disabled) return;
            clearTimeout(resetTimer);
            pending = true;
            control.setAttribute("aria-disabled", "true");
            control.setAttribute("aria-busy", "true");
            control.dataset.copyState = "pending";
            paintIcon("pending");
            control.parentElement.append(status);
            status.hidden = false;
            status.className = "ux-copy-status visually-hidden";
            status.setAttribute("role", "status");
            setOwnedText(status, "Writing to clipboard...");
            let reading = true;
            try {
                let text = control.isConnected ? copySources.get(control)?.read?.() : null;
                if (!current()) { text = null; return; }
                if (typeof text !== "string") throw new CopyUnavailableError("The text is unavailable. Reopen this section and try again.");
                reading = false;
                const clipboard = navigator.clipboard, write = clipboard?.writeText;
                if (!current()) { text = null; return; }
                if (typeof write !== "function") throw new CopyUnavailableError("Clipboard access is unavailable in this browser. Select the text and copy it manually.");
                const writing = write.call(clipboard, text);
                text = null;
                await writing;
                if (!current()) return;
                control.dataset.copyState = "success";
                paintIcon("check");
                status.className = "ux-copy-status visually-hidden";
                setOwnedText(status, "Copied to clipboard.");
                tooltip(control, "Copied to clipboard.");
                resetTimer = setTimeout(() => {
                    if (!current()) return;
                    control.dataset.copyState = "idle";
                    paintIcon("copy");
                    tooltip(control, help);
                }, 2200);
            } catch (error) {
                if (!current()) return;
                control.dataset.copyState = "error";
                paintIcon("copy");
                status.className = "ux-copy-status error";
                status.setAttribute("role", "alert");
                setOwnedText(status, error instanceof CopyUnavailableError ? error.message : reading
                    ? "The text is unavailable. Reopen this section and try again."
                    : error?.name === "NotAllowedError"
                        ? "Couldn't copy. Clipboard permission was denied. Select the text and copy it manually."
                        : "Couldn't copy to the clipboard. Select the text and copy it manually.");
                tooltip(control, "Copy failed. Select the text and copy it manually, or try again.");
            } finally {
                pending = false;
                if (current()) {
                    removeOwnedAttribute(control, "aria-disabled");
                    removeOwnedAttribute(control, "aria-busy");
                }
            }
        });
        return control;
    }
    function attachCopy(target, { label, copyLabel = "Copy " + label.toLowerCase(), getText, tooltip: help, prose = false }) {
        const block = document.createElement("section");
        block.className = "ux-code-block" + (prose ? " prose" : "");
        const toolbar = document.createElement("div");
        toolbar.className = "ux-code-toolbar";
        const heading = document.createElement("span");
        heading.className = "ux-code-label";
        heading.textContent = label;
        toolbar.append(heading, copyButton({ label: copyLabel, getText, tooltip: help }));
        target.replaceWith(block);
        block.append(toolbar, target);
        target.tabIndex = 0;
        target.setAttribute("aria-label", label);
        return block;
    }
    function codeBlock(text, { label = "Recorded text", ...options } = {}) {
        if (typeof text !== "string") throw new TypeError("Code blocks require exact text.");
        const pre = document.createElement("pre");
        pre.textContent = text;
        return attachCopy(pre, { ...options, label, getText: () => pre.textContent });
    }
    function inlineCode(text, { label = "Copy API path", tooltip: help = label } = {}) {
        const wrapper = document.createElement("span");
        wrapper.className = "ux-inline-code";
        const code = document.createElement("code");
        code.textContent = text;
        wrapper.append(code, copyButton({ label, getText: () => code.textContent, tooltip: help }));
        return wrapper;
    }
    function pending(node, value) {
        node.dataset.pending = String(value);
        const control = node.matches("button");
        if (control) node.setAttribute("aria-busy", String(value));
        if (control && !node.querySelector(":scope > .wire-icon,:scope > [data-progress-icon]")) return;
        let marker = node.querySelector(":scope > [data-progress-icon]");
        if (!marker) {
            marker = node.querySelector(":scope > .wire-icon");
            if (!marker) {
                marker = document.createElement("span");
                marker.className = "progress-slot";
                marker.append(icon("pending-small"));
                if (control || node.matches("a,input,select,textarea,summary,[role=button],[role=link]")) node.prepend(marker);
                else {
                    marker.classList.add("progress-slot-trailing");
                    node.append(marker);
                }
            }
            marker.dataset.progressIcon = "";
            marker.setAttribute("aria-hidden", "true");
        }
        if (value && marker.matches("svg") && !pendingIcons.has(marker)) {
            const original = marker, size = Number(original.getAttribute("width"));
            marker = icon(size === 16 ? "pending-small" : "pending");
            for (const name of original.classList) marker.classList.add(name);
            if (size === 24) {
                marker.classList.add("progress-icon-large");
                marker.setAttribute("width", "24"); marker.setAttribute("height", "24");
                marker.dataset.iconSize = "24";
            }
            marker.dataset.progressIcon = "";
            original.replaceWith(marker);
            pendingIcons.set(marker, original);
        } else if (!value && pendingIcons.has(marker)) {
            const original = pendingIcons.get(marker);
            pendingIcons.delete(marker);
            marker.replaceWith(original);
            marker = original;
        }
        marker.classList.toggle("pending-indicator", value);
    }
    function withdrawAccess(roots) {
        const contains = node => node && roots.some(root => root === node || root.contains(node));
        suppressedPointer = suppressedFocus = null;
        pointer = null;
        if ([active, opening, hovered, focused, pinned].some(contains)) {
            clearTooltip();
            active = opening = hovered = focused = pinned = null;
            suppressedPointer = suppressedFocus = null;
        }
        for (const root of roots) for (const node of [root, ...root.querySelectorAll("*")]) {
            retireRegistrations(node);
        }
    }
    function retireRegistrations(node) {
        copySources.get(node)?.revoke();
        retireTooltip(node); disabledReasons.delete(node); pendingIcons.delete(node);
    }
    function countShare({ count, percentage }) {
        if (!Number.isSafeInteger(count) || count < 0 || percentage !== undefined && typeof percentage !== "string") {
            throw new TypeError("Widget values require an exact count and an optional formatted share.");
        }
        const value = document.createElement("span"), primary = document.createElement("strong");
        value.className = "percentage-value";
        primary.textContent = percentage ?? count.toLocaleString();
        value.append(primary);
        if (percentage !== undefined) {
            const secondary = document.createElement("span");
            secondary.textContent = `(${count.toLocaleString()})`;
            value.append(document.createTextNode(" "), secondary);
        }
        return value;
    }
    return { icon, utility, tooltip, helpButton, copyButton, codeBlock, attachCopy, inlineCode, explainDisabled, hideTooltip, restoreFocus, dismissOnOutside, dismissOnFrameFocus, pending, withdrawAccess, countShare,
        destroy() {
            clearTooltip();
            observer.disconnect();
            events.abort();
            bubble.remove();
            active = hovered = focused = pinned = opening = null;
            pointer = suppressedPointer = suppressedFocus = null;
            focusSource = null;
        },
    };
}
