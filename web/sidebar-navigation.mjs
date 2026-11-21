export function initializeNavigationPreference() {
    const key = "workiq-evidence.navigation", widthKey = key + "-width";
    const root = document.documentElement, listeners = new Set();
    const valid = value => value === "expanded" || value === "collapsed";
    let preference = "expanded", width = null, storage, storageUnavailable = false;
    const validWidth = value => Number.isInteger(value) && value >= 216 && value <= 520;
    function readWidth(raw) {
        if (raw === null) return null;
        if (/^\d{3}$/.test(raw) && validWidth(Number(raw))) return Number(raw);
        console.warn("Unrecognized navigation width. Using the default width.");
        return null;
    }
    function paintWidth(value) {
        if (value === null) {
            delete root.dataset.navigationSized;
            root.style.removeProperty("--navigation-preferred-width");
        } else {
            root.dataset.navigationSized = "";
            root.style.setProperty("--navigation-preferred-width", value + "px");
        }
    }
    function storageFailure(error) {
        if (!["SecurityError", "QuotaExceededError"].includes(error.name)) throw error;
        storageUnavailable = true;
        console.warn("Navigation preference storage is unavailable. Changes apply to this panel only.");
    }
    try {
        storage = window.localStorage;
        const stored = storage.getItem(key);
        if (valid(stored)) preference = stored;
        else if (stored !== null) console.warn("Unrecognized saved navigation preference. Keeping navigation expanded.");
        width = readWidth(storage.getItem(widthKey));
    } catch (error) { storageFailure(error); }
    function apply() {
        root.dataset.navigation = preference;
        paintWidth(width);
        for (const listener of listeners) listener({ preference, width, storageUnavailable });
    }
    window.addEventListener("storage", event => {
        if (storageUnavailable || event.storageArea !== storage) return;
        if (event.key === widthKey) { width = readWidth(event.newValue); apply(); return; }
        if (event.key !== key && event.key !== null) return;
        if (!valid(event.newValue)) {
            console.warn("Unrecognized navigation preference from another panel. Keeping the current navigation.");
            return;
        }
        preference = event.newValue;
        apply();
    });
    apply();
    return {
        subscribe(listener) { listeners.add(listener); listener({ preference, width, storageUnavailable }); },
        previewWidth: paintWidth,
        setWidth(value) {
            if (value !== null && !validWidth(value)) throw new RangeError("Choose a supported navigation width.");
            width = value;
            try {
                storage = window.localStorage;
                if (value === null) storage.removeItem(widthKey);
                else storage.setItem(widthKey, String(value));
                storageUnavailable = false;
            } catch (error) { storageFailure(error); }
            apply();
        },
        setPreference(value) {
            if (!valid(value)) throw new Error("Choose expanded or collapsed navigation.");
            preference = value;
            try {
                storage = window.localStorage;
                storage.setItem(key, preference);
                storageUnavailable = false;
            } catch (error) { storageFailure(error); }
            apply();
        },
    };
}

// Move the same navigation nodes into a native modal on narrow screens.
export function mountSidebarNavigation(ux, preference) {
    const $ = (id) => document.getElementById(id);
    const timing = { duration: 320, easing: "cubic-bezier(.2,0,0,1)", fill: "both" };
    const media = matchMedia("(max-width: 699px)");
    const trigger = $("navigationToggle"), drawer = $("navigationDrawer");
    const content = $("navigationContent"), rail = $("sidebar");
    const collapse = $("navigationCollapse");
    const header = document.querySelector(".app-header");
    const brand = $("shellBrand");
    const divider = document.createElement("div");
    divider.className = "navigation-resize";
    divider.tabIndex = 0;
    divider.setAttribute("role", "separator");
    divider.setAttribute("aria-label", "Navigation width");
    divider.setAttribute("aria-orientation", "vertical");
    divider.setAttribute("aria-controls", rail.id);
    rail.append(divider);
    const minWidth = () => $("wireAccountEntry").hidden ? 216 : 248;
    // Match the CSS viewport after space is reserved for a native scrollbar.
    const maxWidth = () => Math.min(520, Math.floor(document.documentElement.getBoundingClientRect().width * .45));
    const bounded = value => Math.max(minWidth(), Math.min(maxWidth(), Math.round(value)));
    function measure() {
        document.documentElement.style.setProperty("--app-header-height", Math.ceil(header.getBoundingClientRect().height) + "px");
        if (!media.matches) {
            const current = rail.getBoundingClientRect().width;
            document.documentElement.style.setProperty("--app-sidebar-width", current + "px");
            if (!collapsed && !rail.hasAttribute("data-navigation-moving")) {
                divider.setAttribute("aria-valuemin", String(minWidth()));
                divider.setAttribute("aria-valuemax", String(maxWidth()));
                divider.setAttribute("aria-valuenow", String(Math.round(current)));
                divider.setAttribute("aria-valuetext", `${Math.round(current)} pixels wide`);
            }
        }
    }
    const headerSize = new ResizeObserver(measure);
    headerSize.observe(header);
    headerSize.observe(rail);
    let restoreFocus = true, collapsed = false, navigationFocus = null;
    let animations = [], motionOrigin = null, drawerAnimation = null, drawerClosing = false;
    let savedWidth = null, drag = null, frame = 0;
    function endDrag(commit) {
        if (!drag) return;
        const { id, width, start } = drag;
        drag = null;
        cancelAnimationFrame(frame); frame = 0;
        rail.removeAttribute("data-resizing");
        if (divider.hasPointerCapture(id)) divider.releasePointerCapture(id);
        if (commit && width !== start) preference.setWidth(width);
        else preference.previewWidth(savedWidth);
    }
    ux.tooltip(divider, () => drag ? "" : "Drag or use arrow keys to resize. Double-click or press Enter to reset.", { placement: "right" });
    divider.addEventListener("pointerdown", event => {
        if (!event.isPrimary || event.button !== 0 || collapsed || media.matches) return;
        event.preventDefault();
        ux.restoreFocus(divider); ux.hideTooltip();
        const start = Math.round(rail.getBoundingClientRect().width);
        drag = { id: event.pointerId, x: event.clientX, start, width: start };
        rail.dataset.resizing = "";
        divider.setPointerCapture(event.pointerId);
    });
    divider.addEventListener("pointermove", event => {
        if (drag?.id !== event.pointerId) return;
        drag.width = bounded(drag.start + event.clientX - drag.x);
        if (!frame) frame = requestAnimationFrame(() => { frame = 0; preference.previewWidth(drag.width); });
    });
    divider.addEventListener("pointerup", event => {
        if (drag?.id === event.pointerId) {
            drag.width = bounded(drag.start + event.clientX - drag.x);
            endDrag(true);
        }
    });
    for (const type of ["pointercancel", "lostpointercapture"]) divider.addEventListener(type, event => {
        if (drag?.id === event.pointerId) endDrag(false);
    });
    divider.addEventListener("dblclick", () => preference.setWidth(null));
    divider.addEventListener("keydown", event => {
        if (drag) {
            if (event.key === "Escape") { event.preventDefault(); endDrag(false); }
            return;
        }
        const width = rail.getBoundingClientRect().width;
        const next = { ArrowLeft: width - 16, ArrowRight: width + 16, Home: minWidth(), End: maxWidth(), Enter: null }[event.key];
        if (next === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
        event.preventDefault(); ux.hideTooltip();
        preference.setWidth(next === null ? null : bounded(next));
    });
    window.addEventListener("blur", () => endDrag(false));
    function captureBrand() {
        const link = brand.querySelector(".brand-home"), bounds = link.getBoundingClientRect();
        return {
            link, bounds,
            inset: bounds.x - brand.getBoundingClientRect().x - parseFloat(getComputedStyle(brand).paddingLeft),
            layers: [...link.querySelectorAll("svg")].filter(node => getComputedStyle(node).display !== "none").map(node => ({
                node, bounds: node.getBoundingClientRect(), matrix: node.getScreenCTM(), opacity: getComputedStyle(node).opacity,
            })),
        };
    }
    function captureGeometry() {
        return {
            width: rail.getBoundingClientRect().width,
            brand: captureBrand(),
            labels: [...content.querySelectorAll(".navigation-label,.navigation-group-label,.wire-account-copy")].map(node => {
                const style = getComputedStyle(node), bounds = node.getBoundingClientRect();
                return { node, width: bounds.width, height: bounds.height, opacity: style.opacity,
                    paddingTop: style.paddingTop, paddingBottom: style.paddingBottom };
            }),
            rows: [...content.querySelectorAll("[data-nav]")].map(node => ({ node, gap: getComputedStyle(node).columnGap })),
        };
    }
    function finishMotion() {
        const previous = animations;
        animations = [];
        for (const animation of previous) animation.cancel();
        rail.removeAttribute("data-navigation-moving");
        measure();
    }
    content.addEventListener("click", event => {
        if (rail.hasAttribute("data-navigation-moving") && event.target instanceof Element
            && event.target.closest("#wireAccountTrigger,#wireFeedback")) finishMotion();
    }, { capture: true });
    function glide(from) {
        const to = captureGeometry();
        if (Math.abs(from.width - to.width) < 1) return;
        const animate = (node, keyframes, options = timing) => {
            const animation = node.animate(keyframes, options);
            animations.push(animation);
            return animation;
        };
        rail.dataset.navigationMoving = "";
        const width = animate(rail, [{ width: from.width + "px", minWidth: "0px" }, { width: to.width + "px", minWidth: "0px" }]);
        const originBrand = from.brand, targetBrand = to.brand;
        animate(targetBrand.link, [
            { width: originBrand.bounds.width + "px", marginLeft: originBrand.inset + "px",
                transform: `translateY(${originBrand.bounds.y - targetBrand.bounds.y}px)`, justifySelf: "start" },
            { width: targetBrand.bounds.width + "px", marginLeft: targetBrand.inset + "px", transform: "translateY(0px)", justifySelf: "start" },
        ]);
        const visibleOrigin = originBrand.layers.find(layer => Number(layer.opacity) > 0);
        const visibleTarget = targetBrand.layers.find(layer => Number(layer.opacity) > 0);
        for (const target of targetBrand.layers) {
            const origin = originBrand.layers.find(layer => layer.node === target.node);
            // Register both approved SVGs in their shared artwork coordinates so their symbol
            // follows one path through the fade, including a reversal partway through it.
            const transform = (source, linkBounds) => {
                const scale = source.matrix.a / target.matrix.a;
                const x = source.matrix.e - linkBounds.x - (target.bounds.x - targetBrand.bounds.x)
                    - scale * (target.matrix.e - target.bounds.x);
                const y = source.matrix.f - linkBounds.y - (target.bounds.y - targetBrand.bounds.y)
                    - scale * (target.matrix.f - target.bounds.y);
                return `translate(${x}px,${y}px) scale(${scale})`;
            };
            animate(target.node, [
                { opacity: origin.opacity, transform: transform(Number(origin.opacity) > 0 ? origin : visibleOrigin, originBrand.bounds) },
                { opacity: target.opacity, transform: transform(visibleTarget, targetBrand.bounds) },
            ]);
        }
        for (const [index, target] of to.labels.entries()) {
            const origin = from.labels[index];
            const first = { width: origin.width + "px" }, last = { width: target.width + "px" };
            if (target.node.classList.contains("navigation-group-label")) {
                Object.assign(first, { height: origin.height + "px", paddingTop: origin.paddingTop, paddingBottom: origin.paddingBottom });
                Object.assign(last, { height: target.height + "px", paddingTop: target.paddingTop, paddingBottom: target.paddingBottom });
            }
            animate(target.node, [first, last]);
            animate(target.node, [{ opacity: origin.opacity, visibility: "visible" }, { opacity: target.opacity, visibility: "visible" }],
                { ...timing, duration: collapsed ? 120 : 200, delay: collapsed ? 0 : 60 });
        }
        for (const [index, target] of to.rows.entries()) animate(target.node, [{ columnGap: from.rows[index].gap }, { columnGap: target.gap }]);
        width.addEventListener("finish", () => { if (animations.includes(width)) finishMotion(); }, { once: true });
        measure();
    }
    // A breakpoint can hide the focused rail before the media change callback runs.
    document.addEventListener("focusin", event => {
        navigationFocus = rail.contains(event.target) || drawer.contains(event.target) || brand.contains(event.target) ? event.target : null;
    });
    document.addEventListener("focusout", event => {
        if (event.target === navigationFocus && event.target.checkVisibility()) navigationFocus = null;
    });
    const label = () => collapsed ? "Expand navigation" : "Collapse navigation";
    const headerHelpAvoid = () => [...content.querySelectorAll("[data-nav]"),
        ...(media.matches ? [$("closeNavigation")] : [$("wireSearch"), $("themePreference"),
            $("openChartReference"), $("openAnalyzeFilters"), $("refreshBtn")])].filter(Boolean);
    ux.tooltip(brand.querySelector(".brand-home"), "WorkIQ Request Explorer", {
        anchor: brand, placement: "right", tone: "contrast", avoid: headerHelpAvoid,
    });
    ux.tooltip(collapse, label, { placement: "right", tone: "contrast", avoid: headerHelpAvoid });
    for (const node of content.querySelectorAll(".primary-navigation [data-nav]")) {
        const name = node.textContent.trim();
        node.setAttribute("aria-label", name);
        ux.tooltip(node, () => !media.matches && collapsed ? name : "", { placement: "right", tone: "contrast" });
    }
    const feedback = $("wireFeedback");
    const panel = document.createElement("section");
    panel.id = "wireFeedbackPanel";
    panel.className = "wire-feedback-panel";
    panel.popover = "auto";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-labelledby", "wireFeedbackTitle");
    panel.innerHTML = `<h2 id="wireFeedbackTitle">Report a bug or suggest a feature</h2>
        <label for="wireIssueTitle">Title</label>
        <input id="wireIssueTitle" type="text" required maxlength="256" placeholder="Summarize the issue" autofocus>
        <label for="wireFeedbackText">Description <span>(optional)</span></label>
        <textarea id="wireFeedbackText" placeholder="Add details about the bug or feature"></textarea>
        <p id="wireFeedbackNotice">Review on GitHub. The issue is public only after you submit it.</p>
        <p id="wireFeedbackError" role="alert" hidden></p>
        <div class="wire-feedback-actions"><button type="button" id="wireFeedbackCancel">Cancel</button><button type="button" id="wireFeedbackOpen" class="primary" aria-describedby="wireFeedbackNotice" disabled>Open on GitHub</button></div>`;
    feedback.parentElement.after(panel);
    const title = $("wireIssueTitle"), description = $("wireFeedbackText"), openIssue = $("wireFeedbackOpen"), error = $("wireFeedbackError");
    let toggling = false;
    for (const node of content.querySelectorAll(".footer-utilities > *")) {
        ux.tooltip(node, () => !toggling && !panel.matches(":popover-open") ? node.getAttribute("aria-label") : "", {
            placement: "top", tone: "contrast", avoid: () => [...node.parentElement.children].filter(sibling => sibling !== node),
        });
    }
    panel.addEventListener("beforetoggle", event => {
        toggling = true;
        ux.hideTooltip();
        if (event.newState === "closed") {
            title.value = description.value = "";
            openIssue.disabled = true;
            error.hidden = true;
        }
    });
    panel.addEventListener("toggle", () => { toggling = false; });
    panel.addEventListener("input", () => { openIssue.disabled = !title.value.trim(); error.hidden = true; });
    $("wireFeedbackCancel").addEventListener("click", () => { panel.hidePopover(); ux.restoreFocus(feedback); });
    openIssue.addEventListener("click", () => {
        if (!title.value.trim()) return;
        const url = new URL("https://github.com/likamrat/wire/issues/new");
        url.searchParams.set("title", title.value.trim());
        if (description.value) url.searchParams.set("body", description.value);
        if (url.href.length > 8192) {
            error.textContent = "The description is too long for a link. Shorten it and add the rest on GitHub.";
            error.hidden = false;
            return;
        }
        // Keep both fields intact if the host blocks opening a new tab.
        window.open(url.href, "_blank", "noopener,noreferrer");
    });
    preference.subscribe(state => {
        savedWidth = state.width;
        endDrag(false);
        ux.hideTooltip();
        finishMotion();
        collapsed = state.preference === "collapsed";
        collapse.setAttribute("aria-expanded", String(!collapsed));
        collapse.setAttribute("aria-label", label());
        collapse.replaceChildren(ux.icon(collapsed ? "navigation-expand" : "navigation-collapse"));
        $("navigationStorageNotice").hidden = !state.storageUnavailable;
        if (motionOrigin && !media.matches) glide(motionOrigin);
        measure();
    });
    collapse.addEventListener("click", () => {
        motionOrigin = captureGeometry();
        try { preference.setPreference(collapsed ? "expanded" : "collapsed"); }
        finally { motionOrigin = null; }
    });
    function finishDrawerMotion() {
        drawerAnimation?.cancel();
        drawerAnimation = null;
        if (drawerClosing) {
            drawerClosing = false;
            drawer.close();
            trigger.setAttribute("aria-expanded", "false");
        }
    }
    function moveDrawer(entering) {
        const from = drawerAnimation ? getComputedStyle(drawer).transform : entering ? "translateX(-100%)" : "translateX(0)";
        drawerAnimation?.cancel();
        drawerAnimation = null;
        drawerClosing = !entering;
        const animation = drawer.animate([{ transform: from }, { transform: entering ? "translateX(0)" : "translateX(-100%)" }],
            timing);
        drawerAnimation = animation;
        animation.addEventListener("finish", () => { if (drawerAnimation === animation) finishDrawerMotion(); }, { once: true });
    }
    function close(restore = true) {
        restoreFocus = restore;
        if (!drawer.open) return;
        if (!restore || !media.matches) { drawerClosing = true; finishDrawerMotion(); return; }
        if (!drawerClosing) moveDrawer(false);
    }
    function layout() {
        const active = document.activeElement === document.body && navigationFocus ? navigationFocus : document.activeElement;
        const navigationFocused = rail.contains(active) || drawer.contains(active);
        ux.hideTooltip();
        finishMotion();
        if (!media.matches) close(false);
        (media.matches ? $("drawerContent") : rail).append(content);
        if (media.matches) {
            $("drawerBrand").append(brand);
        } else {
            header.querySelector(".workspace-toolbar").before(brand);
        }
        trigger.hidden = !media.matches;
        if (navigationFocused || brand.contains(active)) {
            const destination = content.contains(active) || brand.contains(active) ? active : collapse;
            ux.restoreFocus(media.matches ? trigger : destination);
        }
        else if (!media.matches && active === trigger) ux.restoreFocus(collapse);
        measure();
    }
    trigger.addEventListener("click", () => {
        restoreFocus = true;
        ux.hideTooltip();
        const entering = !drawer.open || drawerClosing;
        drawer.showModal();
        trigger.setAttribute("aria-expanded", "true");
        if (entering) moveDrawer(true);
        content.querySelector("[aria-current=page]")?.focus();
    });
    $("closeNavigation").addEventListener("click", () => close());
    drawer.addEventListener("cancel", event => { event.preventDefault(); close(); });
    window.addEventListener("keydown", event => {
        if (!drawer.open || event.key !== "Escape") return;
        if (event.defaultPrevented || drawer.querySelector("#wireAccountMenu:popover-open,#wireFeedbackPanel:popover-open")) return;
        ux.hideTooltip();
        event.preventDefault();
        event.stopPropagation();
        close();
    }, { capture: true });
    drawer.addEventListener("click", (event) => {
        if (event.target !== drawer) return;
        const bounds = drawer.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
    });
    drawer.addEventListener("close", () => {
        trigger.setAttribute("aria-expanded", "false");
        ux.hideTooltip();
        if (restoreFocus && media.matches) ux.restoreFocus(trigger);
        restoreFocus = true;
    });
    function settleMotion() {
        endDrag(false);
        finishMotion();
        finishDrawerMotion();
    }
    window.addEventListener("resize", settleMotion);
    document.addEventListener("visibilitychange", () => { if (document.hidden) settleMotion(); });
    media.addEventListener("change", layout);
    layout();
    return { close, timing };
}
