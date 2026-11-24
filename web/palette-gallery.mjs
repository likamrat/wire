import { palettes } from "./theme.mjs";
import { uxIcons } from "./ux-icons.mjs";

const swatchRoles = ["accent-fill", "screen-prompt-user", "screen-service-files", "screen-prompt-agent", "screen-activity-assistance", "danger"];
export const currentPaletteSwatches = `<span class="palette-swatches" aria-hidden="true">${swatchRoles.map(() => "<i></i>").join("")}</span>`;

export function palettePreview(id, mode) {
    return `<span class="palette-scene" data-preview-palette="${id}" data-preview-mode="${mode}" aria-hidden="true">
      <span class="palette-rail"></span><span class="palette-sheet"><span class="palette-type"><i></i><i></i></span>
      <span class="palette-strip"><i></i><i></i><i></i><i></i></span></span></span>`;
}
export const paletteGallery = `
<section class="palette-gallery" aria-labelledby="paletteTitle">
  <div class="palette-toolbar"><div class="settings-row-copy"><h3 id="paletteTitle">Color palette</h3><span id="paletteSelection" hidden></span></div>
  <div><button id="findPalette" aria-expanded="false" aria-controls="paletteFind" type="button">Find palette</button>
  <button id="resetPalette" type="button">Reset palette</button></div></div>
  <div id="paletteFind" hidden><label for="paletteQuery">Find a palette by name</label><input id="paletteQuery" type="search" autocomplete="off">
    <div id="recentPalettes" hidden></div></div>
  <fieldset class="palette-grid" aria-labelledby="paletteTitle" aria-describedby="paletteStorageNotice">
  ${Object.entries(palettes).map(([id,name]) => `<label class="palette-option"><input id="palette-${id}" type="radio" name="screenPalette" value="${id}" aria-label="${name}${id === "petrol" ? ", default" : ""}">
    ${palettePreview(id,"light")}${palettePreview(id,"dark")}<span class="palette-caption"><span>${name}${id === "petrol" ? ' <small>Default</small>' : ""}</span><span class="palette-active">${uxIcons["select-check"]} Active</span></span></label>`).join("")}</fieldset>
  <p id="paletteEmpty" hidden>No palettes match.</p>
  <details class="palette-comparison"><summary>Compare Light and Dark</summary><div>${["light","dark"].map(mode =>
        `<div><b>${mode === "light" ? "Light" : "Dark"}</b>${palettePreview("petrol",mode)}</div>`).join("")}</div></details>
  <p id="paletteStorageNotice" class="notice" role="status" hidden>Palette could not be saved in this browser. Your choice applies to this panel only.
  <button type="button" id="retryPalette">Try saving again</button></p><span id="paletteAnnouncement" role="status" class="visually-hidden"></span>
</section>`;

export const galleryStyles = `
.palette-gallery {margin-block:var(--space-md) var(--space-lg);min-width:0}
.palette-toolbar,.palette-toolbar>div:last-child,.palette-caption {display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px 12px}
.palette-toolbar {margin-bottom:12px}.palette-toolbar>div:last-child {gap:4px}
#paletteSelection,.palette-caption small {color:var(--muted);font-size:var(--type-caption)}
#paletteFind {margin:8px 0 12px}#paletteFind label{display:block}#paletteQuery {max-width:100%;width:min(100%,24rem)}
.palette-grid,.palette-comparison>div {min-width:0;border:0;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,12rem),1fr));gap:12px}
.palette-option {display:flex;flex-direction:column;container-type:inline-size;position:relative;cursor:pointer;background:var(--paper);border:1px solid var(--control);border-radius:8px;min-width:0}
.palette-option>input {position:absolute;width:1px;height:1px;min-height:0;clip-path:inset(50%);padding:0;margin:0;border:0}
.palette-option:has(:checked){outline:2px solid var(--accent-fill);outline-offset:-1px}
.palette-option:has(:focus-visible){outline:3px solid var(--focus);outline-offset:3px}
.palette-caption{margin-top:auto;min-height:44px;padding:8px 12px;border-radius:0 0 8px 8px}.palette-option:has(:checked) .palette-caption {background:var(--accent-soft)}
.palette-option:hover .palette-caption{background:var(--hover)}.palette-option:active .palette-caption{background:var(--pill-pressed)}
.palette-active{display:inline-flex;align-items:center;gap:.25em;font-size:var(--type-caption);color:var(--accent);visibility:hidden}.palette-option:has(:checked) .palette-active{visibility:visible}
.palette-scene {display:grid;grid-template-columns:1.15rem 1fr;gap:6px;padding:8px;background:var(--page);border-radius:7px 7px 0 0}
.palette-rail{background:var(--screen-rail);border-inline-start:3px solid var(--accent-fill);border-radius:3px}
.palette-sheet{display:grid;gap:8px;padding:8px;background:var(--screen-plot);border:1px solid var(--rule);border-radius:4px}
.palette-type{display:flex;align-items:center;gap:4px}.palette-type i{height:3px;width:25%;background:var(--ink);border-radius:2px}.palette-type i+i{width:14%;background:var(--muted)}
.palette-strip{display:grid;grid-template-columns:4fr 2fr 1fr 1fr;gap:2px;height:6px}.palette-strip i:nth-child(1){background:var(--tool-positive)}.palette-strip i:nth-child(2){background:var(--tool-negative)}.palette-strip i:nth-child(3){background:var(--warning)}.palette-strip i:nth-child(4){background:var(--unknown)}
.palette-swatches{display:flex;gap:3px;align-items:center}
.palette-swatches i{width:.75rem;height:.75rem;border-radius:3px}
${swatchRoles.map((role, index) => `.palette-swatches i:nth-child(${index + 1}){background:var(--${role})}`).join("\n")}
@media(forced-colors:active){.palette-swatches{display:none}}
.palette-comparison summary{cursor:pointer;align-content:center;min-height:44px}.palette-comparison>div>div{container-type:inline-size}
:root:not([data-evidence-theme=dark]) .palette-option>[data-preview-mode=dark],:root[data-evidence-theme=dark] .palette-option>[data-preview-mode=light]{display:none}
@media(forced-colors:active){.palette-option:has(:checked){outline-color:Highlight}.palette-option:has(:focus-visible){outline:3px dashed Highlight}.palette-strip i{border:1px solid CanvasText}}
`;
