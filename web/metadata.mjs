// Self-contained for serialization into the nonce-authorized application shell.
export function createInlineMetadata(ux) {
    function span(className, text) {
        const node = document.createElement("span");
        node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function item(label, { helpLabel = label, help, separator = false, helpWithLabel = false, leading = null } = {}) {
        if (typeof label !== "string" || !label.trim()) throw new TypeError("Inline metadata requires a non-empty text label.");
        const group = span("metadata-item");
        if (separator) {
            const divider = span("metadata-separator", "/");
            divider.setAttribute("aria-hidden", "true");
            group.append(divider, document.createTextNode(" "));
        }
        const text = span("metadata-label");
        if (help !== undefined) {
            const parts = /^(.*?)(\S+)(\s*)$/s.exec(label);
            const tail = span("metadata-tail");
            const end = span("metadata-tail-end");
            const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(parts[2])];
            const last = graphemes.at(-1);
            const control = ux.helpButton(helpLabel, help);
            control.classList.add("metadata-help");
            control.addEventListener("keydown", (event) => {
                if (event.key === "Enter" || event.key === " ") event.stopPropagation();
            });
            // A long final word can reflow, but the help never loses its last grapheme.
            const glyph = control.firstElementChild;
            end.append(span("metadata-tail-text", last.segment + parts[3]), helpWithLabel ? glyph : control);
            tail.append(document.createTextNode(parts[2].slice(0, last.index)), end);
            text.append(document.createTextNode(parts[1]), tail);
            if (helpWithLabel) {
                control.classList.add("metadata-help-with-label");
                if (leading) control.append(leading);
                control.append(text);
                group.append(control);
                return group;
            }
        } else text.textContent = label;
        group.append(text);
        return group;
    }

    function row(entries) {
        const node = document.createElement("div");
        node.className = "inline-metadata";
        for (const [index, { label, ...options }] of entries.entries()) {
            if (index) node.append(document.createTextNode(" "));
            node.append(item(label, { ...options, separator: index > 0 }));
        }
        return node;
    }

    return { item, row };
}
