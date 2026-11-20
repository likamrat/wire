import { palettes } from "./theme.mjs";
import { uxIcons } from "./ux-icons.mjs";

function preview(id, mode) {
    return `<span class="palette-scene" data-preview-palette="${id}" data-preview-mode="${mode}" aria-hidden="true">
      <span class="palette-titlebar"><b>WIRE</b><span>Work IQ · 4 calls</span></span>
      <span class="palette-mini"><span class="palette-rail">${uxIcons["navigation-analyze"]}${uxIcons.reports}</span>
      <span class="palette-panels"><span class="palette-chart"><b>Tool outcomes</b>
        <span class="palette-strip"><i></i><i></i><i></i></span>
        <span class="palette-ok">✓ Completed <span>50% (2)</span></span><span class="palette-fail">× Failed <span>25% (1)</span></span>
        <span class="palette-unknown">? Unknown <span>25% (1)</span></span><span class="palette-partial">△ Partial <span>0% (0)</span></span>
      </span><span class="palette-reader"><b>Interaction reader</b><span class="palette-author">User prompt</span>
        <span>Find the handover notes.</span><span class="palette-files">Files · Call 3 <span class="palette-fail">failed</span></span>
        <span class="palette-action">Show call</span>
      </span></span></span><span class="palette-inks"><i></i><i></i><i></i><i></i><i></i></span></span>`;
}
export const paletteGallery = `
<section class="palette-gallery" aria-labelledby="paletteTitle">
  <div class="palette-toolbar"><div><h3 id="paletteTitle">Color palette</h3><span id="paletteSelection"></span></div>
  <div><button id="findPalette" aria-expanded="false" aria-controls="paletteFind" type="button">Find palette</button>
  <button id="resetPalette" type="button">Reset palette</button></div></div>
  <div id="paletteFind" hidden><label for="paletteQuery">Find a palette by name</label><input id="paletteQuery" type="search" autocomplete="off">
    <div id="recentPalettes" hidden></div></div>
  <fieldset class="palette-grid" aria-labelledby="paletteTitle" aria-describedby="paletteStorageNotice">
  ${Object.entries(palettes).map(([id,name]) => `<label class="palette-option"><input id="palette-${id}" type="radio" name="screenPalette" value="${id}" aria-label="${name}${id === "petrol" ? ", default" : ""}">
    ${preview(id,"light")}${preview(id,"dark")}<span class="palette-caption"><span>${name}${id === "petrol" ? ' <small>Default</small>' : ""}</span><span class="palette-active">✓ Active</span></span></label>`).join("")}</fieldset>
  <p id="paletteEmpty" hidden>No palettes match.</p>
  <details class="palette-comparison"><summary>Compare Light and Dark</summary><div>${["light","dark"].map(mode =>
        `<div><b>${mode === "light" ? "Light" : "Dark"}</b>${preview("petrol",mode)}</div>`).join("")}</div></details>
  <p id="paletteStorageNotice" class="notice" role="status" hidden>Palette could not be saved in this browser. Your choice applies to this panel only.
  <button type="button" id="retryPalette">Try saving again</button></p><span id="paletteAnnouncement" role="status" class="visually-hidden"></span>
</section>`;

export const galleryStyles = `
.palette-gallery {margin-block:var(--space-md) var(--space-lg);min-width:0}
.palette-toolbar,.palette-toolbar>div:last-child,.palette-caption,.palette-titlebar {display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:6px 12px}
.palette-toolbar {margin-bottom:12px}.palette-toolbar>div:last-child {gap:4px}
#paletteSelection,.palette-caption small,.palette-titlebar {color:var(--muted);font-size:var(--type-caption)}
#paletteFind {margin:8px 0 12px}#paletteFind label{display:block}#paletteQuery {max-width:100%;width:min(100%,24rem)}
.palette-grid,.palette-comparison>div {min-width:0;border:0;padding:0;margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,18rem),1fr));gap:12px}
.palette-option {display:flex;flex-direction:column;container-type:inline-size;position:relative;cursor:pointer;background:var(--paper);border:1px solid var(--control);border-radius:8px;min-width:0}
.palette-option>input {position:absolute;width:1px;height:1px;min-height:0;clip-path:inset(50%);padding:0;margin:0;border:0}
.palette-option:has(:checked){outline:2px solid var(--accent-fill);outline-offset:-1px}
.palette-option:has(:focus-visible){outline:3px solid var(--focus);outline-offset:3px}
.palette-caption{margin-top:auto;min-height:44px;padding:8px 12px;border-radius:0 0 8px 8px}.palette-option:has(:checked) .palette-caption {background:var(--accent-soft)}
.palette-option:hover .palette-caption{background:var(--hover)}.palette-option:active .palette-caption{background:var(--pill-pressed)}
.palette-active{font-size:var(--type-caption);color:var(--accent);visibility:hidden}.palette-option:has(:checked) .palette-active{visibility:visible}
.palette-scene {display:flex;flex-direction:column;flex:1;background:var(--page);color:var(--ink);font-size:var(--type-caption);border-radius:7px 7px 0 0;overflow:hidden}
.palette-titlebar{background:var(--paper);border-bottom:1px solid var(--rule);padding:7px 10px}.palette-titlebar>b{color:var(--ink)}
.palette-mini{display:grid;flex:1;grid-template-columns:1.55rem minmax(0,1fr)}.palette-rail{display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px 2px;background:var(--screen-rail);color:var(--accent)}
.palette-rail .wire-icon{width:1rem;height:1rem}.palette-panels{display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:6px;min-width:0}
.palette-chart,.palette-reader{display:flex;flex-direction:column;min-width:0;gap:2px;border:1px solid var(--rule);border-radius:5px;padding:6px;background:var(--screen-plot);overflow-wrap:anywhere}
.palette-reader{background:var(--canvas)}.palette-chart>span:not(.palette-strip){display:flex;justify-content:space-between;flex-wrap:wrap;gap:0 4px}
.palette-ok{color:var(--success)}.palette-fail{color:var(--danger)}.palette-unknown{color:var(--unknown)}.palette-partial{color:var(--warning)}.palette-author{color:var(--screen-prompt-user)}.palette-files{color:var(--screen-service-files)}
.palette-action{align-self:start;margin-top:auto;padding:2px 6px;background:var(--accent-fill);color:var(--on-accent);border-radius:3px}
.palette-strip,.palette-inks{display:grid;grid-template-columns:2fr 1fr 1fr;gap:2px;height:8px;margin:3px 0}.palette-strip i:nth-child(1){background:var(--success)}.palette-strip i:nth-child(2){background:var(--danger)}.palette-strip i:nth-child(3){background:var(--unknown)}
.palette-inks{grid-template-columns:2fr 1fr 1fr 1fr 1fr;gap:0;height:3px;margin:0}.palette-inks i:nth-child(1){background:var(--accent-fill)}.palette-inks i:nth-child(2){background:var(--screen-service-files)}.palette-inks i:nth-child(3){background:var(--warning)}.palette-inks i:nth-child(4){background:var(--success)}.palette-inks i:nth-child(5){background:var(--danger)}
.palette-comparison summary{cursor:pointer;align-content:center;min-height:44px}.palette-comparison>div>div{container-type:inline-size}
:root:not([data-evidence-theme=dark]) .palette-option>[data-preview-mode=dark],:root[data-evidence-theme=dark] .palette-option>[data-preview-mode=light]{display:none}
@container(max-width:19rem){.palette-panels{grid-template-columns:1fr}.palette-reader{display:grid;grid-template-columns:1fr auto}.palette-reader>b,.palette-reader>.palette-files{grid-column:1/-1}.palette-author{grid-column:1/-1}}
@media(forced-colors:active){.palette-option:has(:checked){outline-color:Highlight}.palette-option:has(:focus-visible){outline:3px dashed Highlight}.palette-strip i,.palette-action{border:1px solid CanvasText}}
`;
