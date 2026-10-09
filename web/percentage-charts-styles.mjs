export const percentageChartStyles = `
.percentage-section {margin-block:24px;container-type:inline-size}
.percentage-heading {display:flex;align-items:center;gap:12px;margin-bottom:4px}
.percentage-scope {color:var(--muted);font-size:var(--type-small);max-width:none;margin-bottom:16px}
.percentage-panels {display:grid;grid-template-columns:minmax(0,1fr);align-items:start;gap:20px}
.percentage-card {min-width:0;padding:20px;border-radius:var(--radius);background:var(--paper)}
.percentage-card-heading {display:flex;align-items:center;justify-content:space-between;gap:8px 16px;flex-wrap:wrap;min-height:44px;margin-bottom:8px}
.percentage-card h3 {font-size:var(--type-section);min-width:0;overflow-wrap:anywhere}
.percentage-denominator {display:inline-block;max-width:100%;font-size:var(--type-small);font-weight:var(--weight-regular);color:var(--muted)}
.percentage-content {position:relative;display:grid;grid-template-columns:minmax(0,22.5rem) minmax(0,1fr);align-items:start;align-content:start;gap:12px 16px;min-width:0;container-type:inline-size}
.percentage-content,.percentage-exact {max-width:calc(48rem - 40px)}
.percentage-visual {width:min(100%,22.5rem);margin-inline:auto;min-width:0}
.percentage-ring {display:block;width:100%;height:auto;aspect-ratio:240/200;overflow:hidden}
.percentage-face {stroke:var(--column-label);stroke-width:var(--slice-outline,.7px);pointer-events:visibleFill}
.percentage-ring a {cursor:pointer}
/* SVG links get a UA pointer-focus box even when :focus-visible is false. */
.percentage-ring a:focus:not(:focus-visible) {outline:none}
.percentage-slice {fill-opacity:var(--glass-cap-opacity)}
.percentage-outer-wall {fill-opacity:var(--glass-front-opacity)}
.percentage-inner-wall {fill-opacity:var(--glass-side-opacity)}
.percentage-face[data-thin=true] {fill:var(--column-label);fill-opacity:1;stroke:none}
.percentage-face.percentage-active {stroke:var(--column-label);stroke-width:1.6px;filter:brightness(var(--percentage-active-brightness,1.05))}
.percentage-legend-row.percentage-active .percentage-label {color:var(--ink)}
.percentage-rim {fill:none;stroke:var(--glass-rim);stroke-width:1.1;stroke-opacity:.85;pointer-events:none}
.percentage-glint {fill:var(--glass-rim);opacity:var(--glass-glint);pointer-events:none}
/* A broad light-surface annulus needs less white than a small column cap. */
:root[data-evidence-theme=light] .percentage-ring {--glass-cap-opacity:.96;--glass-front-opacity:.98;--glass-side-opacity:.94;--glass-glint:.14;--percentage-active-brightness:.9}
:root[data-evidence-theme=light] .percentage-ring .dimensional-stop-cap {stop-color:color-mix(in srgb,var(--column-top) 95%,var(--column-label))}
:root[data-evidence-theme=light] .percentage-ring .dimensional-stop-top {stop-color:color-mix(in srgb,var(--column-mid) 80%,var(--column-top))}
:root[data-evidence-theme=light] .percentage-ring .dimensional-stop-base {stop-color:color-mix(in srgb,var(--column-mid) 70%,var(--column-label))}
:root[data-evidence-theme=light] .percentage-ring .dimensional-stop-side {stop-color:color-mix(in srgb,var(--column-mid) 60%,var(--column-label))}
:root[data-evidence-theme=light] .percentage-rim {stroke-opacity:.4}
.percentage-center {display:flex;flex-wrap:wrap;align-items:baseline;justify-content:center;gap:4px 8px;text-align:center;pointer-events:none}
.percentage-content:has(.percentage-tool-list) {grid-template-columns:minmax(0,1fr)}
.percentage-content:has(.percentage-tool-list)>.percentage-center {justify-content:start;text-align:start}
.percentage-center strong {font-size:1.5rem;font-weight:var(--weight-strong);line-height:1.2;max-width:100%;overflow-wrap:anywhere}
.percentage-center span {font-size:var(--type-caption);color:var(--muted)}
.percentage-legend {list-style:none;margin:0;padding:0;min-width:0;width:100%;max-width:100%;display:grid;grid-template-columns:24px minmax(0,1fr) minmax(0,max-content);align-content:start;column-gap:8px}
.percentage-legend-row {display:grid;grid-column:1/-1;grid-template-columns:subgrid;align-items:center;gap:0 8px;min-height:44px;padding:0 0 12px;color:var(--ink);scroll-margin-block:calc(var(--app-header-height,76px) + 16px) 16px}
.percentage-cue {display:flex;align-items:center;justify-content:center;color:var(--column-label)}
.percentage-cue svg {width:20px;height:20px;fill:currentColor}
.percentage-label {min-width:0;max-width:100%;justify-self:start;overflow-wrap:anywhere;font-size:var(--type-small);line-height:1.4;min-height:44px;align-content:center;border-radius:var(--radius-small)}
.percentage-label[href] {color:var(--accent);text-decoration:none;scroll-margin-block:calc(var(--app-header-height,76px) + 16px) 16px}
.percentage-label[href]:is(:hover,:active) {background:transparent;color:var(--ink)}
.percentage-label:focus-visible {outline:2px solid var(--focus);outline-offset:2px}
.percentage-value {display:flex;align-items:baseline;justify-content:flex-end;flex-wrap:wrap;gap:0 .35em;font-size:var(--type-small);line-height:1.4;min-width:0;max-width:100%;overflow-wrap:anywhere;text-align:end;font-variant-numeric:tabular-nums}
.percentage-value>* {min-width:0;max-width:100%}
.percentage-value span {color:var(--muted);font-size:inherit}
.percentage-value strong {font-weight:var(--weight-strong)}
.percentage-members {grid-column:2/-1;font-size:var(--type-caption);color:var(--muted);overflow-wrap:anywhere;max-width:32ch}
.percentage-evidence p {margin:4px 0;font:inherit;color:inherit}
.percentage-note {color:var(--muted);font-size:var(--type-caption);margin-top:16px;max-width:none}
.percentage-exact>.percentage-note {margin-top:8px}
.percentage-empty {padding-block:24px;color:var(--muted);font-size:var(--type-small)}
.percentage-switch {display:flex;gap:4px;flex-wrap:wrap}
.percentage-switch button {min-height:44px;padding:6px 12px;font-size:var(--type-control);line-height:var(--leading-control);background:var(--pill-fill);color:var(--pill-ink);border-color:var(--pill-border);font-weight:var(--pill-weight)}
.percentage-switch button:hover:not(:disabled) {background:var(--pill-hover);color:var(--pill-ink);border-color:var(--pill-border)}
.percentage-switch button:active:not(:disabled) {background:var(--pill-pressed);color:var(--pill-ink);border-color:var(--pill-border)}
.percentage-switch button[aria-pressed=true] {background:var(--pill-hover);color:var(--pill-ink);border-color:var(--pill-border);font-weight:var(--weight-strong);box-shadow:inset 0 0 0 1px var(--pill-border)}
.percentage-tool-list {grid-column:1/-1;width:100%;max-width:42rem;grid-template-columns:minmax(0,1fr) minmax(0,max-content)}
.percentage-tool-list .percentage-members {grid-column:1/-1}
.percentage-bar-track {grid-column:2/-1;height:8px;background:var(--canvas);border-radius:0;overflow:hidden}
.percentage-tool-list .percentage-bar-track {grid-column:1/-1}
.percentage-bar {display:block;height:100%;background:var(--column-label,var(--accent));min-width:0}
.percentage-exact {margin-top:4px;min-width:0}
.percentage-exact>summary {cursor:pointer;min-height:44px;align-content:center;font-size:var(--type-small);color:var(--accent);border-radius:var(--radius-small)}
.percentage-table-wrap {width:100%;min-width:0}
.percentage-table {border-collapse:collapse;width:100%;table-layout:auto;font-size:var(--type-small);margin:8px 0}
.percentage-table caption {caption-side:top;text-align:start;color:var(--muted);font-size:var(--type-caption);padding-block:8px;overflow-wrap:anywhere}
.percentage-table :is(th,td) {padding:10px 6px;text-align:end;border-bottom:1px solid var(--rule);white-space:normal;overflow-wrap:anywhere;min-width:0}
.percentage-table th:first-child {text-align:start;width:60%;font-weight:var(--weight-medium)}
.percentage-table small {display:block;font-size:var(--type-caption);font-weight:var(--weight-regular);color:var(--muted)}
.percentage-table tfoot :is(th,td) {font-weight:var(--weight-strong)}
@container(min-width:64rem) {
 .percentage-panels {grid-template-columns:repeat(2,minmax(0,1fr))}
 .percentage-panels {row-gap:0;align-items:stretch}
 .percentage-panels>.percentage-card {display:grid;grid-template-rows:subgrid;grid-row:span 3}
}
@container(max-width:44rem) {.percentage-visual,.percentage-legend {grid-column:1/-1}}
@container(max-width:21rem) {
 .percentage-card {padding:16px}
 .percentage-legend {grid-template-columns:20px minmax(0,1fr) fit-content(42%)}
 .percentage-legend-row {gap:4px 8px}
 .percentage-tool-list {grid-template-columns:minmax(0,1fr) fit-content(42%)}
 .percentage-table :is(th,td) {padding-inline:3px}
}
@media(forced-colors:active) {
 .percentage-face,.percentage-face[data-thin=true] {fill:Canvas;stroke:CanvasText;fill-opacity:1}
 .percentage-face.percentage-active {fill:Highlight;stroke:HighlightText;filter:none}
 .percentage-rim,.percentage-glint {display:none}
 .percentage-cue,.percentage-value span,.percentage-label {color:CanvasText}
 .percentage-bar {background:CanvasText}
 .percentage-label:focus-visible {outline-color:Highlight}
}
@media(prefers-reduced-transparency:reduce) {.percentage-face {fill-opacity:1}.percentage-glint {display:none}}
`;
