// Display preferences only. Store a hide timestamp under an opaque record key, never its text.
export function createCardVisibility(host, changed) {
    const prefix = "wire.hidden-card.v1.";
    let snapshot, owner, refs = new Map(), hidden = new Map(), revision = 0, storageError = "";
    const keyFor = ref => `${prefix}${owner}.${ref}`;
    function read(bindingChanged = false) {
        const next = new Map(), previousError = storageError;
        storageError = "";
        if (snapshot) try {
            const admitted = new Set(refs.values());
            for (const storage of [host.sessionStorage, host.localStorage]) for (let i = 0; i < storage.length; i++) {
                const key = storage.key(i);
                if (!key?.startsWith(owner ? prefix + owner + "." : prefix)) continue;
                const ref = key.slice(key.lastIndexOf(".") + 1);
                if (!admitted.has(ref)) continue;
                const raw = storage.getItem(key);
                if (raw === null) continue;
                const [order, time] = raw.split(":").map(Number);
                next.set(ref, { ref, order: Number.isSafeInteger(order) && order > 0 ? order : 0,
                    at: Number.isSafeInteger(time) && time > 0 ? time : null });
            }
        } catch (error) {
            if (error.name !== "SecurityError") throw error;
            storageError = "Browser storage is unavailable. WIRE cannot check which interaction cards are hidden.";
        }
        if (bindingChanged || storageError !== previousError || next.size !== hidden.size || [...next.values()].some(entry => {
            const previous = hidden.get(entry.ref);
            return !previous || entry.order !== previous.order || entry.at !== previous.at;
        })) revision++;
        hidden = next;
    }
    host.addEventListener("storage", event => {
        if (!snapshot || event.key !== null && !event.key?.startsWith(prefix)) return;
        read(); changed();
    });
    return {
        bind(next) {
            if (next === snapshot) return;
            const previousOwner = owner, previousRefs = refs;
            snapshot = next; owner = next?.namedDrafts?.source; refs = new Map();
            for (const item of next?.scenarios ?? []) if (/^card-[a-f0-9]{32}$/.test(item.cardVisibilityRef)) refs.set(item.scenarioId, item.cardVisibilityRef);
            for (const r of next?.exportCatalog?.requests ?? []) {
                const ref = refs.get(r.scenarioId);
                if (ref) for (const alias of r.aliases) refs.set(alias, ref);
            }
            read(owner !== previousOwner || refs.size !== previousRefs.size || [...refs].some(([id, ref]) => previousRefs.get(id) !== ref));
        },
        version: () => revision,
        available: id => Boolean(owner && !storageError && refs.has(id)),
        ref: id => refs.get(id),
        has: id => storageError ? refs.has(id) : hidden.has(refs.get(id)),
        any: () => Boolean(storageError || hidden.size),
        problem: () => storageError || (hidden.size && !owner ? "The card owner could not be verified. Hidden cards stay out of view." : ""),
        entries: () => owner && !storageError ? [...hidden.values()].sort((a,b) => b.order - a.order) : [],
        hide(id, duration) {
            const ref = refs.get(id);
            if (!owner || !ref || !["tab", "manual"].includes(duration)) throw new Error("Reopen the current interaction before hiding it.");
            const storage = duration === "tab" ? host.sessionStorage : host.localStorage;
            const order = [...hidden.values()].reduce((last, item) => Math.max(last, item.order), 0) + 1;
            storage.setItem(keyFor(ref), `${order}:${Date.now()}`); read();
            return ref;
        },
        restore(keys) {
            for (const ref of keys) if (owner && hidden.has(ref)) {
                host.localStorage.removeItem(keyFor(ref)); host.sessionStorage.removeItem(keyFor(ref));
            }
            read();
        },
    };
}
