// One reader's views; visibility remains in the existing keyed presentation owner.
export function createReaderSections({ root, presentation, ux, isCurrent, requestClose, onChange }) {
    const doc = root.ownerDocument, views = [], details = [];
    const reducedMotion = doc.defaultView.matchMedia("(prefers-reduced-motion: reduce)");
    let active = true;
    const current = () => active && root.isConnected && isCurrent();
    function element(tag, cls, text) {
        const node = doc.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    const present = () => views.filter(view => root.contains(view.element));
    const snapshot = () => {
        const sections = present().filter(view => view.collapsible), open = sections.filter(view => view.isOpen()).length;
        return { total: sections.length, open, canExpand: open < sections.length, canCollapse: open > 0 };
    };
    function refresh() { if (active) onChange?.(snapshot()); }
    function finishAll() { for (const view of views) view.finish(); }
    const motionChanged = () => { if (reducedMotion.matches) finishAll(); };
    reducedMotion.addEventListener("change", motionChanged);
    function request(open, targets, animate = true) {
        if (!current()) return;
        const changed = targets.filter(view => view.collapsible && root.contains(view.element) && view.isOpen() !== open);
        if (!changed.length) return;
        const commit = () => {
            if (!current()) return;
            for (const view of changed) if (root.contains(view.element)) view.apply(open, animate);
            refresh();
        };
        if (!open && requestClose) requestClose(changed, commit);
        else commit();
    }
    function add(name, title, { key, metadata, collapsible = true, initialOpen = true } = {}) {
        if (views.some(view => view.key === key)) throw new Error("Reader sections require distinct presentation owners.");
        const section = element("section", "reader-section");
        section.dataset.readerSection = name;
        section.dataset.disclosureKey = key;
        section.dataset.viewKey = "disclosure:" + key;
        const heading = element("h2", "reader-section-heading");
        const toggle = element(collapsible ? "button" : "span", collapsible ? "reader-section-toggle" : "reader-section-title");
        if (collapsible) toggle.type = "button";
        toggle.id = "reader-toggle-" + encodeURIComponent(key);
        toggle.append(element("span", "", title));
        if (collapsible) toggle.append(ux.icon("disclosure"));
        const actions = element("div", "reader-section-actions");
        if (metadata) {
            const context = element("span", "reader-section-context", metadata);
            context.id = "reader-context-" + encodeURIComponent(key);
            heading.append(context);
        }
        heading.prepend(toggle);
        heading.append(actions);
        const notice = element("p", "reader-section-notice");
        notice.hidden = true;
        notice.setAttribute("role", "status");
        const clip = element("div", "reader-section-clip"), content = element("div", "reader-section-content");
        clip.id = "reader-body-" + encodeURIComponent(key);
        clip.setAttribute("role", "region");
        clip.setAttribute("aria-labelledby", toggle.id);
        if (collapsible) toggle.setAttribute("aria-controls", clip.id);
        clip.append(content);
        section.append(heading, notice, clip);
        const listeners = new Set();
        let animation = null;
        const isOpen = () => !collapsible || presentation.isOpen(key, initialOpen);
        function finish() {
            animation?.cancel();
            animation = null;
            clip.style.height = "";
            clip.style.overflow = "";
            clip.hidden = !isOpen();
            clip.inert = !isOpen();
        }
        function apply(open, animate) {
            const height = clip.hidden ? 0 : clip.getBoundingClientRect().height;
            animation?.cancel();
            animation = null;
            presentation.setOpen(key, open);
            toggle.setAttribute("aria-expanded", String(open));
            section.dataset.open = String(open);
            notice.hidden = true;
            if (!open && content.contains(doc.activeElement)) toggle.focus({ preventScroll: true });
            clip.hidden = false;
            clip.inert = !open;
            // Text owners clear body/Copy immediately on hide, including pending getters.
            for (const listener of listeners) listener(open);
            const target = open ? content.getBoundingClientRect().height : 0;
            if (!animate || reducedMotion.matches || height === target) { finish(); return; }
            clip.style.overflow = "hidden";
            clip.inert = true;
            animation = clip.animate([{ height: height + "px" }, { height: target + "px" }],
                { duration: 180, easing: "cubic-bezier(.2,0,0,1)", fill: "both" });
            animation.onfinish = finish;
        }
        if (collapsible) toggle.setAttribute("aria-expanded", String(isOpen()));
        section.dataset.open = String(isOpen());
        clip.hidden = !isOpen();
        clip.inert = !isOpen();
        const view = {
            name, key, collapsible, element: section, body: content, actions, toggle, isOpen, apply, finish,
            visibility: {
                isOpen: () => current() && isOpen(),
                isCurrent: current,
                subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
            },
            showNotice(message) { notice.textContent = message; notice.hidden = false; },
            dispose() { finish(); listeners.clear(); },
        };
        if (collapsible) toggle.addEventListener("click", () => request(!isOpen(), [view]));
        views.push(view);
        return view;
    }
    function detail({ key, toggle, body, visibility, initialOpen = false, render }) {
        let live = true;
        const owned = {
            isCurrent: () => live && current() && visibility.isCurrent(),
            isOpen: () => owned.isCurrent() && visibility.isOpen() && presentation.isOpen(key, initialOpen),
        };
        body.id = "reader-detail-" + encodeURIComponent(key);
        body.dataset.disclosureKey = key;
        toggle.setAttribute("aria-controls", body.id);
        function paint() {
            body.replaceChildren();
            body.hidden = !owned.isOpen();
            toggle.setAttribute("aria-expanded", String(presentation.isOpen(key, initialOpen)));
            if (!body.hidden) body.append(render(owned));
        }
        const unsubscribe = visibility.subscribe(paint);
        toggle.addEventListener("click", () => {
            if (!owned.isCurrent() || !visibility.isOpen()) return;
            const selection = doc.defaultView.getSelection();
            if (selection && !selection.isCollapsed && toggle.contains(selection.anchorNode)) return;
            presentation.setOpen(key, !presentation.isOpen(key, initialOpen));
            paint();
        });
        details.push(() => {
            live = false;
            unsubscribe();
            body.replaceChildren();
            body.hidden = true;
            toggle.setAttribute("aria-expanded", "false");
            toggle.disabled = true;
            render = null;
        });
        paint();
    }
    let width = root.getBoundingClientRect().width, font = getComputedStyle(root).fontSize;
    const observer = new ResizeObserver(() => {
        const next = root.getBoundingClientRect().width, nextFont = getComputedStyle(root).fontSize;
        if (width !== next || font !== nextFont) finishAll();
        width = next; font = nextFont;
    });
    observer.observe(root);
    return {
        add, detail, refresh, snapshot, settle: finishAll,
        setAll(open) { request(open, present()); },
        reveal(node) {
            if (!current()) return;
            for (const view of present()) if (view.body.contains(node) && !view.isOpen()) view.apply(true, false);
            refresh();
        },
        dispose() {
            active = false;
            reducedMotion.removeEventListener("change", motionChanged);
            observer.disconnect();
            for (const dispose of details) dispose();
            details.length = 0;
            for (const view of views) view.dispose();
            views.length = 0;
        },
    };
}
