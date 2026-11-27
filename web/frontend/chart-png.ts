type ChartPicture = {
    title: string;
    context: string[];
    parts: (Element | null)[];
};

// Shared by the Vite entry and the standalone shell. Only the chart owner
// supplies paint fragments; the exporter never clones the dashboard or reads records.
export function createChartDownload({ icon, current, save, report }: {
    icon: () => SVGElement;
    current: () => () => boolean;
    save: (blob: Blob, filename: string) => void;
    report: (reason: string) => void;
}) {
    const svgNS = "http://www.w3.org/2000/svg";
    const layout = `display position top right bottom left box-sizing width height min-width min-height max-width max-height
        margin padding border-top border-right border-bottom border-left border-radius box-shadow background-color background-image background-size background-position background-repeat
        border-collapse border-spacing table-layout flex flex-direction flex-wrap gap align-items align-self align-content justify-content justify-items justify-self order
        grid-template-columns grid-template-rows grid-auto-flow grid-column grid-row
        overflow-x overflow-y white-space overflow-wrap text-align vertical-align font-family font-size font-weight font-style
        font-variant-numeric line-height letter-spacing color opacity transform transform-origin clip-path`.trim().split(/\s+/);
    const paint = `display color fill fill-rule fill-opacity stroke stroke-width stroke-opacity stroke-linecap stroke-linejoin
        stroke-dasharray opacity stop-color stop-opacity font-family font-size font-weight text-anchor dominant-baseline`.trim().split(/\s+/);
    const vectorTags = new Set("svg g path line polyline polygon circle ellipse rect text tspan defs linearGradient stop pattern".split(" "));
    const geometry = new Set("id viewBox preserveAspectRatio d x y x1 x2 y1 y2 dx dy cx cy r rx ry width height points transform offset gradientUnits gradientTransform patternUnits patternTransform".split(" "));
    function copyStyle(source: CSSStyleDeclaration, target: CSSStyleDeclaration, properties: string[]) {
        for (const key of properties) {
            const value = source.getPropertyValue(key);
            // Permit references to this SVG's paint servers only, never a page or resource URL.
            if (value.includes("url(") && !/^url\(["']?#[\w.-]+["']?\)$/.test(value)) continue;
            target.setProperty(key, value);
        }
    }
    function copy(node: Node, doc: Document): Node | null {
        if (node instanceof Text) return doc.createTextNode(node.data);
        if (!(node instanceof Element) || node.matches("[hidden],.visually-hidden,input,select,details,script,style,img,iframe,[role=tooltip],.token-day-reading,.trends-mark-focus,.trends-point-actions,.token-history-pages,.time-segment-link,.trends-legend-row[data-hidden=true]")) return null;
        if (node.matches("button") && !node.matches(".comparison-chart-mark,.comparison-outcome-values button,[data-edit-period]")) return null;
        if (node.matches("[data-edit-period] svg")) return null;
        const css = getComputedStyle(node);
        if (css.display === "none" || css.visibility !== "visible" || css.opacity === "0") return null;
        const vector = node.namespaceURI === svgNS;
        let result: HTMLElement | SVGElement;
        if (vector) {
            const tag = node.localName === "a" ? "g" : node.localName;
            if (!vectorTags.has(tag)) return null;
            result = doc.createElementNS(svgNS, tag);
            for (const attr of node.attributes) if (geometry.has(attr.name)) result.setAttribute(attr.name, attr.value);
            copyStyle(css, result.style, paint);
            if (tag === "svg") copyStyle(css, result.style, ["width", "height", "overflow", "vertical-align"]);
            // Some marks (including daily token bars) are positioned by CSS.
            if (css.transform !== "none" && !node.hasAttribute("transform")) result.style.transform = css.transform;
        } else {
            result = doc.createElement("div");
            copyStyle(css, result.style, layout);
            // Keep the live viewport's clip and offset, not its native controls.
            result.style.scrollbarWidth = "none";
            if (node.matches("[data-edit-period]")) {
                result.style.background = "none"; result.style.border = "0"; result.style.boxShadow = "none";
            }
            if (node.matches(".trends-series")) {
                const swatch = doc.createElement("span");
                swatch.style.cssText = "width:12px;height:4px;align-self:center;border-radius:2px";
                swatch.style.backgroundColor = css.getPropertyValue("--series-color");
                if (node.querySelector("input")?.checkVisibility()) result.append(swatch);
            }
        }
        for (const child of node.childNodes) {
            const retained = copy(child, doc);
            if (retained) {
                if ((node.scrollLeft || node.scrollTop) && (retained instanceof HTMLElement || retained instanceof SVGElement)) {
                    retained.style.translate = `${-node.scrollLeft}px ${-node.scrollTop}px`;
                }
                result.append(retained);
            }
        }
        return result;
    }
    async function render(chart: ChartPicture, valid: () => boolean) {
        const parts = chart.parts.filter((part): part is Element => !!part && part.checkVisibility() && part.getBoundingClientRect().height > 0);
        if (!parts.length) throw Error("This chart has no visible data to download.");
        const first = parts[0], theme = getComputedStyle(first);
        const frame = document.createElement("iframe");
        frame.setAttribute("aria-hidden", "true"); frame.tabIndex = -1;
        frame.style.cssText = "position:fixed;inset:0;width:1px;height:1px;visibility:hidden;pointer-events:none;border:0";
        // This scriptless, network-disabled document can decode a data image
        // without allowing data images or arbitrary frames in the workspace.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const loaded = new Promise<void>((resolve, reject) => {
            frame.onload = () => resolve(); frame.onerror = () => reject(Error("The local chart image renderer could not open."));
            timer = setTimeout(() => reject(Error("The local chart image renderer did not respond.")), 10000);
        });
        frame.src = "/assets/chart-image-frame";
        document.body.append(frame);
        try {
            const width = Math.ceil(Math.max(...parts.map(part => part.getBoundingClientRect().width))) + 40;
            const paper = document.createElement("div");
            paper.style.cssText = `box-sizing:border-box;padding:20px;width:${width}px;overflow:hidden`;
            paper.style.fontFamily = theme.fontFamily;
            paper.style.color = theme.getPropertyValue("--ink");
            paper.style.backgroundColor = theme.getPropertyValue("--paper");
            const title = document.createElement("div");
            title.style.cssText = "font-size:21px;font-weight:600;line-height:1.3;overflow-wrap:anywhere";
            title.textContent = chart.title; paper.append(title);
            const caption = document.createElement("div");
            caption.style.cssText = "margin:4px 0 12px;font-size:14px;line-height:1.45;overflow-wrap:anywhere";
            caption.style.color = theme.getPropertyValue("--muted");
            caption.textContent = [...new Set(chart.context.filter(Boolean))].join(" · "); paper.append(caption);
            for (const part of parts) {
                const block = copy(part, document);
                if (block instanceof HTMLElement || block instanceof SVGElement) {
                    block.style.margin = "0"; paper.append(block);
                }
            }
            const fonts = document.createElement("style");
            fonts.textContent = [...document.styleSheets].flatMap(sheet => [...sheet.cssRules])
                .filter(rule => rule instanceof CSSFontFaceRule && rule.style.getPropertyValue("src").includes("data:font/woff2"))
                .map(rule => rule.cssText).join("\n");
            paper.prepend(fonts);
            await loaded;
            if (!valid()) return;
            const doc = frame.contentDocument;
            if (!doc || !doc.querySelector("meta[name=wire-chart-image]")) throw Error("The local chart image renderer is unavailable.");
            doc.head.append(fonts.cloneNode(true));
            await doc.fonts.load(`16px ${theme.fontFamily}`);
            if (!valid()) return;
            doc.body.append(paper);
            const height = Math.ceil(paper.getBoundingClientRect().height);
            const scale = Math.min(3, 8192 / width, 8192 / height, Math.sqrt(24_000_000 / (width * height)));
            if (scale < 2) throw Error("This chart is too large for a high-resolution image. Narrow the dates or filters and try again.");
            const canvas = document.createElement("canvas");
            canvas.width = Math.ceil(width * scale); canvas.height = Math.ceil(height * scale);
            const markup = new XMLSerializer().serializeToString(paper);
            paper.remove();
            const image = doc.createElement("img");
            image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
                `<svg xmlns="${svgNS}" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${width} ${height}"><foreignObject width="${width}" height="${height}">${markup}</foreignObject></svg>`);
            await image.decode();
            const context = canvas.getContext("2d");
            if (!context) throw Error("This browser could not create a chart image.");
            context.drawImage(image, 0, 0);
            const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
            if (!blob) throw Error("This browser could not encode the chart as a PNG.");
            if (valid()) save(blob, `WIRE-${chart.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").slice(0, 100)}.png`);
        } finally { clearTimeout(timer); frame.remove(); }
    }
    return (read: () => ChartPicture | null) => {
        const button = document.createElement("button");
        button.type = "button"; button.className = "quiet icon-only chart-download";
        button.title = "Download chart as PNG"; button.setAttribute("aria-label", button.title);
        button.append(icon());
        button.addEventListener("click", async () => {
            if (button.getAttribute("aria-busy") === "true") return;
            const authorized = current();
            const valid = () => authorized() && button.isConnected && button.checkVisibility();
            if (!valid()) return;
            button.setAttribute("aria-busy", "true");
            try {
                const chart = read();
                if (!chart) throw Error("Wait for the current chart to finish loading, then try again.");
                await render(chart, valid);
            } catch (error) {
                if (valid()) report(`Chart download failed. ${error instanceof Error ? error.message : "The image could not be created."}`);
            } finally { button.removeAttribute("aria-busy"); }
        });
        return button;
    };
}
