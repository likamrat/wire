import { uxIcons } from "./ux-icons.mjs";

// Labels, help and results belong to the caller; the field owns its shared geometry.
export function searchFieldMarkup({ id, clearId, placeholder = "Search", describedBy, controls }) {
    const attribute = value => String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    return `<div class="search-capsule">
  <span class="wire-search-icon">${uxIcons.search}</span>
  <input id="${attribute(id)}" class="search-capsule-input" type="search" placeholder="${attribute(placeholder)}" autocomplete="off" spellcheck="false"${describedBy ? ` aria-describedby="${attribute(describedBy)}"` : ""}${controls ? ` aria-controls="${attribute(controls)}" aria-expanded="false"` : ""}>
  <button id="${attribute(clearId)}" type="button" class="quiet search-capsule-clear" hidden>Clear search</button>
</div>`;
}

// Serialized into the nonce-authorized shell; no imports or query policy here.
export function createSearchFields(ux) {
    const owners = new WeakMap();
    function mount(input, { clearLabel, onInput, onClear = onInput, focusAfterClear = () => input.focus() }) {
        const root = input.closest(".search-capsule"), button = root?.querySelector(".search-capsule-clear");
        if (!root || !button || typeof onInput !== "function" || !clearLabel) throw new TypeError("Search fields require shared markup, a clear label and an input handler.");
        owners.get(input)?.dispose();
        const events = new AbortController();
        ux.utility(button, "close", clearLabel);
        function sync(value = input.value) {
            if (input.value !== value) input.value = value;
            button.hidden = !input.value;
            button.disabled = input.matches(":disabled") || input.readOnly;
        }
        function clear() {
            if (events.signal.aborted || input.matches(":disabled") || input.readOnly || input.closest("[inert]")) return;
            input.value = "";
            sync();
            onClear();
            focusAfterClear();
        }
        input.addEventListener("input", event => { sync(); onInput(event); }, { signal: events.signal });
        button.addEventListener("click", clear, { signal: events.signal });
        const field = { sync, clear, dispose() {
            events.abort();
            if (owners.get(input) === field) owners.delete(input);
        } };
        owners.set(input, field);
        sync();
        return field;
    }
    return { mount };
}

export const searchFieldStyles = `
:root .search-capsule {position:relative;display:grid;grid-template-columns:minmax(0,1fr);align-items:center;min-width:0}
.wire-search-icon {position:absolute;inset-inline-start:14px;top:50%;transform:translateY(-50%);display:flex;pointer-events:none;color:var(--muted)}
:root input.search-capsule-input {grid-area:1/1;width:100%;min-width:0;min-height:var(--pill-height);border:1px solid transparent;border-radius:var(--radius-pill);padding-inline:42px calc(var(--pill-height) + 12px);background:linear-gradient(var(--paper),var(--paper)) padding-box,linear-gradient(110deg,var(--search-ring-start),var(--search-ring-middle),var(--search-ring-end)) border-box;background-size:100% 100%,200% 100%;background-position:0 0,0 50%;box-shadow:0 0 12px color-mix(in srgb,var(--search-ring-middle) 16%,transparent),var(--surface-shadow);transition:background-position .32s ease-out,box-shadow .2s ease-out}
:root input.search-capsule-input:is(:hover,[aria-expanded=true]) {background-position:0 0,65% 50%;box-shadow:0 0 14px color-mix(in srgb,var(--search-ring-middle) 24%,transparent),var(--surface-shadow)}
:root input.search-capsule-input:focus-visible {outline:2px solid var(--search-ring-focus);outline-offset:-2px;background-position:0 0,100% 50%;box-shadow:0 0 16px color-mix(in srgb,var(--search-ring-middle) 28%,transparent),var(--surface-shadow)}
:root input.search-capsule-input::-webkit-search-cancel-button {display:none}
:root button.search-capsule-clear {grid-area:1/1;align-self:center;justify-self:end;margin-inline-end:2px;border-radius:var(--radius-pill);z-index:1}
@media(forced-colors:active) {
 :root input.search-capsule-input {box-shadow:none;border-color:CanvasText;background:Canvas}
 :root input.search-capsule-input:is(:hover,:focus-visible,[aria-expanded=true]) {box-shadow:none}
 :root input.search-capsule-input:focus-visible {outline-color:Highlight}
}
`;
