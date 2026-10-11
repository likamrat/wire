export const percentageChartStyles = `
.percentage-section {margin-block:24px;container-type:inline-size}
.percentage-heading {margin-bottom:4px}
.percentage-scope {color:var(--muted);font-size:var(--type-small);max-width:none;margin:4px 0 16px}
.percentage-panels {display:grid;grid-template-columns:minmax(0,1fr);align-items:start;gap:16px 24px}
.percentage-card {min-width:0;padding:16px;background:var(--paper);border:1px solid var(--rule);border-radius:var(--radius)}
.percentage-card-heading {min-height:44px;margin-bottom:8px}
.percentage-card h3 {font-size:var(--type-section);overflow-wrap:anywhere}
.percentage-denominator {display:block;font-size:var(--type-small);font-weight:var(--weight-regular);color:var(--muted);text-transform:none;letter-spacing:0}
.percentage-content {position:relative;min-width:0}
.percentage-visual {width:7rem;max-width:100%;margin-inline:auto}
.percentage-ring {display:block;width:100%;height:auto;aspect-ratio:1;overflow:visible}
.percentage-face {fill:var(--column-label);stroke:none;pointer-events:visibleFill}
.percentage-ring a {cursor:pointer}
.percentage-ring a:focus:not(:focus-visible) {outline:none}
.percentage-face.percentage-active {fill:var(--column-label);fill-opacity:.8}
.percentage-legend {list-style:none;margin:0;padding:0;min-width:0;display:grid;gap:8px}
.percentage-legend-row {display:grid;grid-template-columns:20px minmax(0,1fr) minmax(0,max-content);align-items:center;column-gap:8px;color:var(--ink);min-width:0}
.percentage-tool-list .percentage-legend-row {grid-template-columns:minmax(0,1fr) minmax(0,max-content)}
.percentage-cue {display:flex;align-items:center;justify-content:center;color:var(--column-label)}
.percentage-cue svg {width:20px;height:20px;fill:currentColor}
.percentage-label {display:block;min-width:44px;max-width:100%;overflow-wrap:anywhere;font-size:var(--type-small);line-height:1.4;min-height:44px;align-content:center;border-radius:var(--radius-small)}
.percentage-label[href] {color:var(--accent);text-decoration:none;scroll-margin-block:calc(var(--app-header-height,76px) + 16px) 16px}
.percentage-label[href]:is(:hover,:active) {background:var(--canvas);color:var(--ink)}
.percentage-label:focus-visible {outline:2px solid var(--focus);outline-offset:2px}
.percentage-value {display:flex;align-items:baseline;justify-content:flex-end;flex-wrap:wrap;gap:0 .35em;font-size:var(--type-small);line-height:1.4;min-width:0;max-width:100%;overflow-wrap:anywhere;text-align:end;font-variant-numeric:tabular-nums}
.percentage-value>* {min-width:0;max-width:100%}
.percentage-value span {color:var(--muted)}
.percentage-value strong {font-weight:var(--weight-strong)}
.percentage-bar-track {grid-column:2/-1;height:8px;background:var(--canvas);border-radius:var(--radius-pill);overflow:hidden}
.percentage-tool-list .percentage-bar-track {grid-column:1/-1}
.percentage-bar {display:block;height:100%;background:var(--column-label,var(--accent));border-radius:var(--radius-pill);min-width:0}
.percentage-legend-row:has(a) .percentage-bar-track {cursor:pointer}
.percentage-note,.percentage-service-scope,.percentage-coverage {color:var(--muted);font-size:var(--type-small);line-height:1.5;max-width:none}
.percentage-service-scope {margin:0 0 8px}
.percentage-coverage {margin-top:16px}
.percentage-coverage p {margin:8px 0;max-width:none}
.percentage-gap-list {margin:8px 0}
.percentage-gap-list>div {display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px}
.percentage-gap-list dt {font-weight:var(--weight-regular);overflow-wrap:anywhere}
.percentage-gap-list dd {margin:0;font-variant-numeric:tabular-nums;color:var(--ink)}
.percentage-empty {padding-block:8px;color:var(--muted);font-size:var(--type-small)}
.percentage-exact {margin-top:8px;min-width:0}
.percentage-exact>summary {cursor:pointer;min-height:44px;align-content:center;font-size:var(--type-small);color:var(--accent);border-radius:var(--radius-small)}
.percentage-exact>summary:focus-visible {outline:2px solid var(--focus);outline-offset:2px}
.percentage-table-wrap {width:100%;min-width:0}
.percentage-table {border-collapse:collapse;width:100%;table-layout:fixed;font-size:var(--type-small);margin:8px 0}
.percentage-table caption {caption-side:top;text-align:start;color:var(--muted);font-size:var(--type-small);padding-block:8px;overflow-wrap:anywhere}
.percentage-table :is(th,td) {padding:6px;text-align:end;border-bottom:1px solid var(--rule);white-space:normal;overflow-wrap:anywhere;min-width:0}
.percentage-table th:first-child {text-align:start;width:50%;font-weight:var(--weight-medium)}
.percentage-table tfoot :is(th,td) {font-weight:var(--weight-strong)}
.percentage-card[data-breakdown=outcomes] .percentage-content {display:grid;grid-template-columns:7rem minmax(0,1fr);gap:16px;align-items:center}
.percentage-card[data-breakdown=outcomes] .percentage-legend {grid-template-columns:repeat(auto-fit,minmax(min(100%,15rem),1fr));gap:4px 24px}
@container(min-width:44rem) {
 .percentage-panels {grid-template-columns:repeat(2,minmax(0,1fr))}
 .percentage-card[data-breakdown=outcomes] {grid-column:1/-1}
}
@container(max-width:28rem) {
 .percentage-card[data-breakdown=outcomes] .percentage-content {grid-template-columns:minmax(0,1fr)}
}
@container(max-width:22rem) {
 .percentage-legend-row {grid-template-columns:20px minmax(0,1fr)}
 .percentage-tool-list .percentage-legend-row {grid-template-columns:minmax(0,1fr)}
 .percentage-value {grid-column:2/-1;justify-content:flex-start;text-align:start}
 .percentage-tool-list .percentage-value {grid-column:1/-1}
 .percentage-table :is(th,td) {padding-inline:3px}
 .percentage-table thead {position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
 .percentage-table :is(tbody,tfoot) {display:block}
 .percentage-table tr {display:grid;grid-template-columns:minmax(0,1fr);border-bottom:1px solid var(--rule)}
 .percentage-table :is(th,td) {border:0;text-align:start}
 .percentage-table th:first-child {width:auto}
 .percentage-table td {display:flex;justify-content:space-between;gap:12px;white-space:nowrap}
 .percentage-table td::before {content:attr(data-label);color:var(--muted);font-weight:var(--weight-regular)}
}
@media(forced-colors:active) {
 .percentage-face {fill:CanvasText}
 .percentage-face.percentage-active {fill:Highlight;fill-opacity:1}
 .percentage-cue,.percentage-value span {color:CanvasText}
 .percentage-bar {background:CanvasText}
 .percentage-label:focus-visible,.percentage-exact>summary:focus-visible {outline-color:Highlight}
}
`;
