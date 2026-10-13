export function initializeNavigationPreference() {
    const key = "workiq-evidence.navigation";
    const root = document.documentElement, listeners = new Set();
    const valid = value => value === "expanded" || value === "collapsed";
    let preference = "expanded", storage, storageUnavailable = false;
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
    } catch (error) { storageFailure(error); }
    function apply() {
        root.dataset.navigation = preference;
        for (const listener of listeners) listener({ preference, storageUnavailable });
    }
    window.addEventListener("storage", event => {
        if (storageUnavailable || event.storageArea !== storage || (event.key !== key && event.key !== null)) return;
        if (!valid(event.newValue)) {
            console.warn("Unrecognized navigation preference from another panel. Keeping the current navigation.");
            return;
        }
        preference = event.newValue;
        apply();
    });
    apply();
    return {
        subscribe(listener) { listeners.add(listener); listener({ preference, storageUnavailable }); },
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
    const media = matchMedia("(max-width: 699px)");
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    const trigger = $("navigationToggle"), drawer = $("navigationDrawer");
    const content = $("navigationContent"), rail = $("sidebar");
    const collapse = $("navigationCollapse");
    const header = document.querySelector(".app-header");
    const brand = $("shellBrand");
    function measure() {
        document.documentElement.style.setProperty("--app-header-height", Math.ceil(header.getBoundingClientRect().height) + "px");
        if (!media.matches) document.documentElement.style.setProperty("--app-sidebar-width", rail.getBoundingClientRect().width + "px");
    }
    const headerSize = new ResizeObserver(measure);
    headerSize.observe(header);
    headerSize.observe(rail);
    let restoreFocus = true, collapsed = false, navigationFocus = null;
    let animations = [], motionOrigin = null, drawerExit = null;
    function captureBrand() {
        const link = brand.querySelector(".brand-home"), bounds = link.getBoundingClientRect();
        return {
            link, bounds,
            inset: bounds.x - brand.getBoundingClientRect().x - parseFloat(getComputedStyle(brand).paddingLeft),
            caption: brand.querySelector(".brand-caption"), captionOpacity: getComputedStyle(brand.querySelector(".brand-caption")).opacity,
            layers: [...link.querySelectorAll("svg")].filter(node => getComputedStyle(node).display !== "none").map(node => ({
                node, bounds: node.getBoundingClientRect(), matrix: node.getScreenCTM(), opacity: getComputedStyle(node).opacity,
            })),
        };
    }
    function captureGeometry() {
        return {
            width: rail.getBoundingClientRect().width,
            brand: captureBrand(),
            labels: [...content.querySelectorAll(".navigation-label,.navigation-group-label")].map(node => {
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
    function glide(from) {
        const to = captureGeometry();
        if (Math.abs(from.width - to.width) < 1) return;
        const timing = { duration: 320, easing: "cubic-bezier(.2,0,0,1)", fill: "both" };
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
            // Register both approved SVGs in their shared artwork coordinates so their W
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
        animate(targetBrand.caption, [
            { opacity: originBrand.captionOpacity, visibility: "visible" },
            { opacity: targetBrand.captionOpacity, visibility: "visible" },
        ]);
        for (const [index, target] of to.labels.entries()) {
            const origin = from.labels[index];
            const first = { width: origin.width + "px" }, last = { width: target.width + "px" };
            if (target.node.classList.contains("navigation-group-label")) {
                Object.assign(first, { height: origin.height + "px", paddingTop: origin.paddingTop, paddingBottom: origin.paddingBottom });
                Object.assign(last, { height: target.height + "px", paddingTop: target.paddingTop, paddingBottom: target.paddingBottom });
            }
            animate(target.node, [first, last]);
            animate(target.node, [{ opacity: origin.opacity }, { opacity: target.opacity }],
                { ...timing, duration: collapsed ? 120 : 200, delay: collapsed ? 0 : 60 });
        }
        for (const [index, target] of to.rows.entries()) animate(target.node, [{ columnGap: from.rows[index].gap }, { columnGap: target.gap }]);
        width.addEventListener("finish", () => { if (animations.includes(width)) finishMotion(); }, { once: true });
        measure();
    }
    // A breakpoint can hide the focused rail before the media change callback runs.
    document.addEventListener("focusin", event => {
        navigationFocus = rail.contains(event.target) || drawer.contains(event.target) ? event.target : null;
    });
    document.addEventListener("focusout", event => {
        if (event.target === navigationFocus && event.target.checkVisibility()) navigationFocus = null;
    });
    const label = () => collapsed ? "Expand navigation" : "Collapse navigation";
    ux.tooltip(collapse, label, { placement: "right", tone: "contrast" });
    for (const node of content.querySelectorAll("[data-nav]")) {
        const name = node.textContent.trim();
        node.setAttribute("aria-label", name);
        ux.tooltip(node, () => !media.matches && collapsed ? name : "", { placement: "right", tone: "contrast" });
    }
    preference.subscribe(state => {
        ux.hideTooltip();
        finishMotion();
        collapsed = state.preference === "collapsed";
        collapse.setAttribute("aria-expanded", String(!collapsed));
        collapse.setAttribute("aria-label", label());
        collapse.replaceChildren(ux.icon(collapsed ? "navigation-expand" : "navigation-collapse"));
        $("navigationStorageNotice").hidden = !state.storageUnavailable;
        if (motionOrigin && !media.matches && !reducedMotion.matches) glide(motionOrigin);
        measure();
    });
    collapse.addEventListener("click", () => {
        motionOrigin = captureGeometry();
        try { preference.setPreference(collapsed ? "expanded" : "collapsed"); }
        finally { motionOrigin = null; }
    });
    function close(restore = true) {
        restoreFocus = restore;
        if (!drawer.open) return;
        function finish() {
            drawerExit?.cancel();
            drawerExit = null;
            drawer.close();
            trigger.setAttribute("aria-expanded", "false");
        }
        if (!restore || reducedMotion.matches || !media.matches) { finish(); return; }
        if (drawerExit) return;
        drawerExit = drawer.animate([{ transform: getComputedStyle(drawer).transform }, { transform: "translateX(-100%)" }],
            { duration: 180, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" });
        drawerExit.addEventListener("finish", finish, { once: true });
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
        drawer.showModal();
        trigger.setAttribute("aria-expanded", "true");
        content.querySelector("[aria-current=page]")?.focus();
    });
    $("closeNavigation").addEventListener("click", () => close());
    drawer.addEventListener("cancel", event => { event.preventDefault(); close(); });
    window.addEventListener("keydown", event => {
        if (!drawer.open || event.key !== "Escape") return;
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
    window.addEventListener("resize", finishMotion);
    reducedMotion.addEventListener("change", () => {
        if (!reducedMotion.matches) return;
        finishMotion();
        if (drawerExit) drawerExit.finish();
    });
    document.addEventListener("visibilitychange", () => { if (document.hidden) finishMotion(); });
    media.addEventListener("change", layout);
    layout();
    return { close };
}
