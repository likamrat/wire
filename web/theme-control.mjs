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
    const $ = id => document.getElementById(id);
    const options = [...document.querySelectorAll("input[name=screenPalette]")];
    const names = new Map(options.map(input => [input.value, input.getAttribute("aria-label").replace(/, default$/, "")]));
    const recent = [];
    let active, nextTheme;
    function choose(value) {
        if (value !== active) {
            const index = recent.indexOf(value);
            if (index >= 0) recent.splice(index, 1);
            recent.unshift(value);
        }
        theme.setPalette(value);
    }
    function filter() {
        const q = $("paletteQuery").value.trim().toLowerCase();
        let matches = 0;
        for (const input of options) {
            const visible = names.get(input.value).toLowerCase().includes(q);
            input.parentElement.hidden = !visible;
            if (visible) matches++;
        }
        $("paletteEmpty").hidden = matches > 0;
        const used = $("recentPalettes");
        used.hidden = !!q || recent.length < 2;
        used.replaceChildren();
        if (!used.hidden) {
            used.append("Used this visit: ");
            for (const value of recent.slice(0, 3)) {
                const button = document.createElement("button"); button.type = "button"; button.textContent = names.get(value);
                button.onclick = () => { choose(value); $("palette-" + value).focus(); };
                used.append(button);
            }
        }
        return matches;
    }
    function find(show) {
        $("paletteFind").hidden = !show; $("findPalette").setAttribute("aria-expanded", String(show));
        if (!show) $("paletteQuery").value = "";
        filter(); (show ? $("paletteQuery") : $("findPalette")).focus();
    }
    for (const input of options) input.onchange = () => choose(input.value);
    $("findPalette").onclick = () => find($("paletteFind").hidden);
    $("paletteQuery").oninput = () => { $("paletteAnnouncement").textContent = `${filter()} palettes shown.`; };
    $("paletteQuery").onkeydown = event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); find(false); }
    };
    $("resetPalette").onclick = () => { $("paletteQuery").value = ""; choose("petrol"); $("palette-petrol").focus(); };
    $("retryPalette").onclick = () => { choose(active); $("palette-" + active).focus(); };
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
        const changed = active !== undefined && active !== state.palette;
        active = state.palette;
        const mode = state.theme === "light" ? "Light" : "Dark";
        $("settingsModeLabel").textContent = mode;
        $("generalThemeValue").textContent = `${names.get(active)} · ${mode}${state.storageUnavailable || state.paletteStorageUnavailable ? " (this panel only)" : ""}`;
        $("paletteSelection").textContent = `Active: ${names.get(active)}`;
        for (const input of options) input.checked = input.value === active;
        $("resetPalette").disabled = active === "petrol";
        $("paletteStorageNotice").hidden = !state.paletteStorageUnavailable;
        for (const sample of document.querySelectorAll(".palette-comparison .palette-scene")) sample.dataset.previewPalette = active;
        if (changed) $("paletteAnnouncement").textContent = `${names.get(active)} active.`;
        filter();
    });
}
