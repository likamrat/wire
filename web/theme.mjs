export const palettes = Object.freeze({ petrol: "Petrol & coral", linen: "Linen & graphite", blue: "Blueprint", field: "Field notes" });

// Serialized into the head so saved preferences apply before the first paint.
export function initializeTheme(paletteIds) {
    const key = "workiq-evidence.theme";
    const paletteKey = "workiq-evidence.palette.v1";
    const root = document.documentElement;
    const listeners = new Set();
    const valid = (value) => value === "light" || value === "dark";
    let preference, storage, storageUnavailable = false, palette = paletteIds[0], paletteStorageUnavailable = false;
    const validPalette = value => paletteIds.includes(value);

    function storageFailure(error, isPalette = false) {
        if (!["SecurityError", "QuotaExceededError"].includes(error.name)) throw error;
        if (isPalette) paletteStorageUnavailable = true;
        else storageUnavailable = true;
        console.warn(`${isPalette ? "Palette" : "Theme"} preference storage is unavailable. Changes apply to this panel only.`);
    }
    function save() {
        try {
            storage = window.localStorage;
            storage.setItem(key, preference);
            storageUnavailable = false;
        } catch (error) { storageFailure(error); }
    }
    try {
        storage = window.localStorage;
        const stored = storage.getItem(key);
        if (valid(stored)) preference = stored;
        else if (stored !== null && stored !== "system") console.warn("Unrecognized saved theme preference. Saving the current appearance instead.");
    } catch (error) { storageFailure(error); }

    if (!storageUnavailable) {
        try {
            const stored = storage.getItem(paletteKey);
            if (validPalette(stored)) palette = stored;
            else if (stored !== null) console.warn("Unrecognized saved palette. Using the default palette.");
        } catch (error) { storageFailure(error, true); }
    } else paletteStorageUnavailable = true;
    if (!preference) {
        // Snapshot the available appearance once, before paint; never follow later host/OS changes.
        const host = [root, document.body].map((node) => node?.getAttribute("data-color-mode")).find(valid);
        preference = host || (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
        if (!storageUnavailable) save();
    }
    function state() { return { preference, theme: preference, storageUnavailable, palette, paletteStorageUnavailable }; }
    function apply() {
        root.dataset.evidenceTheme = preference;
        root.dataset.evidenceThemePreference = preference;
        root.dataset.evidencePalette = palette;
        for (const listener of listeners) listener(state());
    }
    window.addEventListener("storage", (event) => {
        if (event.storageArea !== storage || ![key, paletteKey, null].includes(event.key)) return;
        // Read the current value: an older queued notification may arrive after a newer local write.
        const isPalette = event.key !== key;
        if (isPalette ? paletteStorageUnavailable : storageUnavailable) return;
        try {
            const latest = storage.getItem(isPalette ? paletteKey : key);
            if (isPalette && (latest === null || validPalette(latest))) palette = latest ?? paletteIds[0];
            else if (!isPalette && valid(latest)) preference = latest;
            else { console.warn("Unrecognized appearance preference from another panel. Keeping the current choice."); return; }
        } catch (error) { storageFailure(error, isPalette); }
        apply();
    });
    apply();
    return {
        subscribe(listener) { listeners.add(listener); listener(state()); },
        setPreference(value) {
            if (!valid(value)) throw new Error("Choose Light or Dark.");
            preference = value;
            save();
            apply();
        },
        setPalette(value) {
            if (!validPalette(value)) throw new Error("Choose a supported color palette.");
            palette = value;
            try {
                storage = window.localStorage;
                storage.setItem(paletteKey, value);
                paletteStorageUnavailable = false;
            } catch (error) { storageFailure(error, true); }
            apply();
        },
    };
}
