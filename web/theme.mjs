// Serialized into the head so saved preferences apply before the first paint.
export function initializeTheme() {
    const key = "workiq-evidence.theme";
    const root = document.documentElement;
    const listeners = new Set();
    const valid = (value) => value === "light" || value === "dark";
    let preference, storage, storageUnavailable = false;

    function storageFailure(error) {
        if (!["SecurityError", "QuotaExceededError"].includes(error.name)) throw error;
        storageUnavailable = true;
        console.warn("Theme preference storage is unavailable. Changes apply to this panel only.");
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

    if (!preference) {
        // Snapshot the available appearance once, before paint; never follow later host/OS changes.
        const host = [root, document.body].map((node) => node?.getAttribute("data-color-mode")).find(valid);
        preference = host || (window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light");
        if (!storageUnavailable) save();
    }
    function state() { return { preference, theme: preference, storageUnavailable }; }
    function apply() {
        root.dataset.evidenceTheme = preference;
        root.dataset.evidenceThemePreference = preference;
        for (const listener of listeners) listener(state());
    }
    window.addEventListener("storage", (event) => {
        if (storageUnavailable) return;
        if (event.storageArea !== storage || (event.key !== key && event.key !== null)) return;
        if (!valid(event.newValue)) {
            console.warn("Unrecognized theme preference from another panel. Keeping the current theme.");
            return;
        }
        preference = event.newValue;
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
    };
}
