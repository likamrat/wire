// Pack existing widgets by their natural size; their renderers still own all data.
export function mountDashboardLayout(host) {
    const view = host.ownerDocument.defaultView;
    const selector = ".analyze-outcome-summary,.analyze-chart-main,#percentageCharts .percentage-card";
    const widgets = new Set();
    const resize = new view.ResizeObserver(measure);
    const children = new view.MutationObserver(refresh);
    host.dataset.dashboardLayout = "packed";

    function measure() {
        if (!host.checkVisibility()) return;
        const gap = parseFloat(view.getComputedStyle(host).columnGap);
        if (!Number.isFinite(gap) || gap < 0) throw new Error("Dashboard packing requires a nonnegative pixel gutter.");
        const sizes = [...widgets].map(widget => [widget, Math.ceil(widget.getBoundingClientRect().height + gap)]);
        for (const [widget, span] of sizes) {
            const value = `span ${Math.max(1, span)}`;
            if (widget.style.gridRowEnd !== value) widget.style.gridRowEnd = value;
        }
    }
    function refresh() {
        const model = host.querySelector("#percentageCharts [data-breakdown=models]");
        if (model && model.parentElement.firstElementChild !== model) model.parentElement.prepend(model);
        const current = new Set(host.querySelectorAll(selector));
        for (const widget of widgets) if (!current.has(widget)) {
            resize.unobserve(widget);
            widget.style.removeProperty("grid-row-end");
            widgets.delete(widget);
        }
        for (const widget of current) if (!widgets.has(widget)) {
            widgets.add(widget);
            resize.observe(widget);
        }
        measure();
    }
    children.observe(host, { childList: true, subtree: true });
    refresh();
    return {
        refresh,
        dispose() {
            resize.disconnect();
            children.disconnect();
            for (const widget of widgets) widget.style.removeProperty("grid-row-end");
            widgets.clear();
            delete host.dataset.dashboardLayout;
        },
    };
}
