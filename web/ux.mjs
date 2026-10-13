// Kept self-contained because the local shell serializes this function into its nonce-authorized script.
export function createEvidenceUX(icons) {
    const descriptions = new WeakMap();
    const tooltipOptions = new WeakMap();
    const disabledReasons = new WeakMap();
    const pendingIcons = new WeakMap();
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

    function tooltipText(node) {
        const value = descriptions.get(node);
        return typeof value === "function" ? value() : value;
    }
    function positionTooltip() {
        if (!active) return;
        if (!active.isConnected || !active.checkVisibility()) { hideTooltip(); return; }
        const options = tooltipOptions.get(active) || {}, anchor = options.anchor || active;
        if (!anchor.isConnected || !anchor.checkVisibility()) { hideTooltip(); return; }
        const box = anchor.getBoundingClientRect(), tip = bubble.getBoundingClientRect();
        const width = document.documentElement.clientWidth, height = window.innerHeight;
        const gap = parseFloat(getComputedStyle(bubble).getPropertyValue("--tooltip-gap"));
        const boundary = active.closest("[data-ux-tooltip-boundary]");
        if (boundary) {
            const clip = boundary.getBoundingClientRect(), x = box.left + box.width / 2, y = box.top + box.height / 2;
            if (x < Math.max(0, clip.left) || x > Math.min(width, clip.right) || y < Math.max(0, clip.top) || y > Math.min(height, clip.bottom)) {
                hideTooltip();
                return;
            }
        }
        if (options.placement === "right" && box.right + gap + tip.width <= width - gap) {
            bubble.style.left = box.right + gap + "px";
            bubble.style.top = Math.max(gap, Math.min(height - tip.height - gap, box.top + (box.height - tip.height) / 2)) + "px";
            return;
        }
        const above = box.top - tip.height - gap;
        const top = options.placement === "top" && above >= gap ? above
            : box.bottom + gap + tip.height <= height - gap ? box.bottom + gap : above;
        bubble.style.left = Math.max(gap, Math.min(width - tip.width - gap, box.left + (box.width - tip.width) / 2)) + "px";
        bubble.style.top = Math.max(gap, Math.min(height - tip.height - gap, top)) + "px";
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
            else active.removeAttribute("aria-describedby");
        }
        if (bubble.matches(":popover-open")) bubble.hidePopover();
        bubble.hidden = true;
        bubble.textContent = "";
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
    function showTooltip(node, source = "focus") {
        if (!node?.isConnected || !node.checkVisibility()) return;
        const key = identity(node);
        if (source !== "help" && (source === "pointer" ? suppressedPointer === key : suppressedFocus === key)) return;
        const text = tooltipText(node);
        if (!text) { hideTooltip(); return; }
        clearTooltip();
        active = node;
        bubble.textContent = text;
        bubble.dataset.tone = tooltipOptions.get(node)?.tone || "default";
        (node.closest("dialog[open]") || document.body).append(bubble);
        const ids = new Set((node.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
        ids.add(bubble.id);
        node.setAttribute("aria-describedby", [...ids].join(" "));
        bubble.hidden = false;
        if (typeof bubble.showPopover === "function") bubble.showPopover();
        positionTooltip();
        tooltipResize.observe(bubble);
        tooltipResize.observe(node);
        const anchor = tooltipOptions.get(node)?.anchor;
        if (anchor && anchor !== node) tooltipResize.observe(anchor);
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
            showTooltip(owner, "help");
            pinned = owner;
        }
    });
    listen(document, "keydown", (event) => {
        if (event.isTrusted) { restoredPage = false; inputSource = "focus"; }
        // Tab starts a deliberate keyboard visit; rendering never emits a Tab.
        if (event.key === "Tab") suppressedFocus = null;
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
            }
        }
        if (active && (!active.isConnected || !active.checkVisibility())) hideTooltip();
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
        descriptions.set(node, text);
        tooltipOptions.set(node, options);
        node.dataset.uxTooltip = "";
        node.removeAttribute("title");
        if (active === node) {
            const value = tooltipText(node);
            if (!value) hideTooltip();
            else { bubble.textContent = value; positionTooltip(); }
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
        if (!Object.hasOwn(icons, name) || typeof icons[name] !== "string") throw new TypeError(`Unknown Fluent icon: ${name}`);
        const svg = new DOMParser().parseFromString(icons[name], "image/svg+xml").documentElement;
        if (svg.localName !== "svg" || svg.namespaceURI !== "http://www.w3.org/2000/svg" || svg.querySelector("parsererror")) throw new TypeError(`Invalid Fluent icon: ${name}`);
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
            showTooltip(control, "help");
            pinned = control;
        });
        return control;
    }
    function copyButton({ label, getText, tooltip: help = label, showLabel = false }) {
        if (!label || typeof getText !== "function") throw new TypeError("Clipboard controls require a contextual label and an explicit text getter.");
        const control = document.createElement("button");
        control.type = "button";
        control.className = "ux-copy" + (showLabel ? " ux-copy-labeled" : "");
        control.setAttribute("aria-label", label);
        function paintIcon(name) {
            control.replaceChildren(icon(name));
            if (showLabel) {
                const text = document.createElement("span");
                text.textContent = label;
                control.append(text);
            }
        }
        paintIcon("copy");
        tooltip(control, help);
        const status = document.createElement("p");
        status.className = "ux-copy-status visually-hidden";
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        status.hidden = true;
        let pending = false, resetTimer;
        class CopyUnavailableError extends Error {}
        control.addEventListener("click", async () => {
            if (pending || control.disabled) return;
            clearTimeout(resetTimer);
            pending = true;
            control.setAttribute("aria-disabled", "true");
            control.dataset.copyState = "pending";
            paintIcon("copy");
            control.parentElement.append(status);
            status.hidden = false;
            status.className = showLabel ? "ux-copy-status pending" : "ux-copy-status visually-hidden";
            status.setAttribute("role", "status");
            status.textContent = "Writing to clipboard...";
            let reading = true;
            try {
                const text = getText();
                if (typeof text !== "string") throw new CopyUnavailableError("The text is unavailable. Reopen this section and try again.");
                reading = false;
                if (!navigator.clipboard?.writeText) throw new CopyUnavailableError("Clipboard access is unavailable in this browser. Select the text and copy it manually.");
                await navigator.clipboard.writeText(text);
                control.dataset.copyState = "success";
                paintIcon("check");
                status.className = showLabel ? "ux-copy-status" : "ux-copy-status visually-hidden";
                status.textContent = "Copied to clipboard.";
                tooltip(control, "Copied to clipboard.");
                resetTimer = setTimeout(() => {
                    control.dataset.copyState = "idle";
                    paintIcon("copy");
                    tooltip(control, help);
                }, 2200);
            } catch (error) {
                control.dataset.copyState = "error";
                status.className = "ux-copy-status error";
                status.setAttribute("role", "alert");
                status.textContent = error instanceof CopyUnavailableError ? error.message : reading
                    ? "The text is unavailable. Reopen this section and try again."
                    : error?.name === "NotAllowedError"
                        ? "Couldn't copy. Clipboard permission was denied. Select the text and copy it manually."
                        : "Couldn't copy to the clipboard. Select the text and copy it manually.";
                tooltip(control, "Copy failed. Select the text and copy it manually, or try again.");
            } finally {
                pending = false;
                control.removeAttribute("aria-disabled");
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
        let marker = node.querySelector(":scope > [data-progress-icon]");
        if (!marker) {
            marker = node.querySelector(":scope > .fluent-icon");
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
                // Keep a 20px optical glyph centered in the action's existing 24px slot.
                marker.classList.add("progress-icon-large");
                marker.setAttribute("viewBox", "-2 -2 24 24");
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
    return { icon, tooltip, helpButton, copyButton, codeBlock, attachCopy, inlineCode, explainDisabled, hideTooltip, restoreFocus, pending,
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
