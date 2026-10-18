export function mountThemeControl(theme, ux) {
    const trigger = document.getElementById("themePreference");
    const track = document.createElement("span");
    track.className = "theme-track";
    track.setAttribute("aria-hidden", "true");
    const thumb = document.createElement("span");
    thumb.className = "theme-thumb";
    track.append(thumb);
    for (const name of ["sun", "moon"]) {
        const glyph = ux.icon(name);
        glyph.classList.add("theme-" + name);
        track.append(glyph);
    }
    trigger.replaceChildren(track);
    trigger.setAttribute("role", "switch");
    trigger.setAttribute("aria-label", "Dark theme");
    const settingsTrigger = document.getElementById("settingsThemePreference");
    settingsTrigger.replaceChildren(track.cloneNode(true));
    settingsTrigger.setAttribute("role", "switch");
    let nextTheme;
    trigger.addEventListener("click", () => {
        theme.setPreference(nextTheme);
        ux.hideTooltip();
    });
    settingsTrigger.addEventListener("click", () => {
        theme.setPreference(nextTheme);
        ux.hideTooltip();
    });
    theme.subscribe((state) => {
        nextTheme = state.theme === "light" ? "dark" : "light";
        const label = `Switch to ${nextTheme} theme`;
        trigger.value = state.preference;
        trigger.setAttribute("aria-checked", String(state.theme === "dark"));
        ux.tooltip(trigger, label);
        settingsTrigger.setAttribute("aria-checked", String(state.theme === "dark"));
        ux.tooltip(settingsTrigger, label);
        document.getElementById("themeStorageNotice").hidden = !state.storageUnavailable;
    });
}
