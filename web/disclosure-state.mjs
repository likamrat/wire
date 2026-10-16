// Panel-local presentation only. No evidence, draft, consent or storage access.
export function createDisclosureState() {
    const opened = new Map(), pages = new Map(), orders = new Map();
    const isOpen = (key, initial = false) => opened.has(key) ? opened.get(key) : initial;
    return {
        isOpen,
        openSummary(keys, initial = false) {
            const open = keys.filter(key => isOpen(key, initial)).length;
            return { total: keys.length, open, canExpand: open < keys.length, canCollapse: open > 0 };
        },
        setOpen: (key, value) => opened.set(key, Boolean(value)),
        forget(key) { opened.delete(key); pages.delete(key); orders.delete(key); },
        page(key, total, size) {
            const value = Math.min(pages.get(key) || 0, Math.max(0, Math.ceil(total / size) - 1));
            pages.set(key, value);
            return value;
        },
        setPage(key, value) { pages.set(key, Math.max(0, value)); },
        ordered(key, values, identify) {
            const incoming = new Map(values.map(value => [identify(value), value]));
            const ids = (orders.get(key) || []).filter(id => incoming.has(id));
            const known = new Set(ids);
            for (const id of incoming.keys()) if (!known.has(id)) ids.push(id);
            orders.set(key, ids);
            return ids.map(id => incoming.get(id));
        },
    };
}
