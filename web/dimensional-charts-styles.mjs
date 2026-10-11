import { createDimensionalCharts } from "../lib/dimensional-charts.mjs";

const faces = ["top", "mid", "base", "side", "cap", "label"];
const servicePalette = createDimensionalCharts().servicePalette;
const services = theme => Object.fromEntries(Object.values(servicePalette).map(entry => [
    entry.token, faces.map(face => entry[theme][face]),
]));
const light = {
    orange: ["#815200", "#815200", "#815200", "#815200", "#815200", "#815200"],
    cyan: ["#006580", "#006580", "#006580", "#006580", "#006580", "#006580"],
    teal: ["#007458", "#007458", "#007458", "#007458", "#007458", "#007458"],
    pink: ["#a52b75", "#a52b75", "#a52b75", "#a52b75", "#a52b75", "#a52b75"],
    slate: ["#586071", "#586071", "#586071", "#586071", "#586071", "#586071"],
    violet: ["#6842ba", "#6842ba", "#6842ba", "#6842ba", "#6842ba", "#6842ba"],
    ...services("light"),
};
const dark = {
    orange: ["#f59e0b", "#f59e0b", "#f59e0b", "#f59e0b", "#f59e0b", "#f59e0b"],
    cyan: ["#06b6d4", "#06b6d4", "#06b6d4", "#06b6d4", "#06b6d4", "#06b6d4"],
    teal: ["#10b981", "#10b981", "#10b981", "#10b981", "#10b981", "#10b981"],
    pink: ["#ed58a5", "#ed58a5", "#ed58a5", "#ed58a5", "#ed58a5", "#ed58a5"],
    slate: ["#a2a9b9", "#a2a9b9", "#a2a9b9", "#a2a9b9", "#a2a9b9", "#a2a9b9"],
    violet: ["#ad88f0", "#ad88f0", "#ad88f0", "#ad88f0", "#ad88f0", "#ad88f0"],
    ...services("dark"),
};
const tokens = palette => Object.entries(palette).map(([tone, colors]) => colors.map((color, index) => `--chart-${tone}-${faces[index]}:${color};`).join("")).join("");
export const dimensionalColumnStyles = `
:root {${tokens(light)}--glass-front-opacity:1;--glass-side-opacity:1;--glass-cap-opacity:1;--glass-glint:0;--glass-rim:transparent;--glass-end-light:#d0d5d5;--glass-end-shade:#d0d5d5;--glass-ground-light:transparent;--glass-ground-dark:transparent;--glass-ground-rule:transparent;--glass-shadow:transparent}
@media(prefers-color-scheme:dark) {:root:not([data-evidence-theme]) {${tokens(dark)}--glass-end-light:#535b61;--glass-end-shade:#535b61}}
:root[data-evidence-theme=light] {${tokens(light)}}
:root[data-evidence-theme=dark] {${tokens(dark)}--glass-end-light:#535b61;--glass-end-shade:#535b61}
${Object.keys(light).map(tone => `.dimensional-tone-${tone} {${faces.map(face => `--column-${face}:var(--chart-${tone}-${face});`).join("")}color:var(--column-mid)}`).join("\n")}
.dimensional-stop-top {stop-color:var(--column-top)}
.dimensional-stop-mid {stop-color:var(--column-mid)}
.dimensional-stop-base {stop-color:var(--column-base)}
.dimensional-stop-side {stop-color:var(--column-side)}
.dimensional-stop-cap {stop-color:var(--column-cap)}
.dimensional-stop-end-light {stop-color:var(--glass-end-light)}
.dimensional-stop-end-shade {stop-color:var(--glass-end-shade)}
.dimensional-column {display:block;overflow:visible;max-width:none;pointer-events:none}
.dimensional-column .time-segment {background:none}
.dimensional-front,.dimensional-side {stroke:none;pointer-events:visibleFill}
.dimensional-front {fill-opacity:var(--glass-front-opacity)}
.dimensional-side {fill-opacity:var(--glass-side-opacity)}
.dimensional-column [data-thin=true] :is(.dimensional-front,.dimensional-side) {fill:var(--column-label);fill-opacity:1}
.dimensional-column .dimensional-tone-slate[data-thin=true] :is(.dimensional-front,.dimensional-side) {fill:var(--column-mid)}
.dimensional-column [data-segment][data-ux-tooltip]:hover :is(.dimensional-front,.dimensional-side) {fill-opacity:1}
.dimensional-cap-clear {fill-opacity:1;stroke:none;pointer-events:visibleFill}
.dimensional-edge {fill:none;stroke:var(--column-label);stroke-width:.65;pointer-events:none}
.dimensional-glint {fill:var(--glass-rim);opacity:var(--glass-glint);pointer-events:none}
.dimensional-glint-front {opacity:var(--glass-glint)}
.dimensional-rim {fill:none;stroke:var(--glass-rim);stroke-width:1.1;stroke-opacity:.85;pointer-events:none}
.dimensional-rim:not(.dimensional-spine) {stroke-width:.65;stroke-opacity:.5}
.dimensional-spine {stroke-opacity:.8}
.dimensional-ground {position:absolute;inset:0;overflow:visible;pointer-events:none}
.dimensional-ground * {pointer-events:none}
.dimensional-ground-light {stop-color:var(--glass-ground-light);stop-opacity:.25}
.dimensional-ground-dark {stop-color:var(--glass-ground-dark);stop-opacity:.28}
.dimensional-ground-surface {stroke:var(--glass-ground-rule);stroke-opacity:.2;stroke-width:1}
.dimensional-ground-edge {fill:none;stroke:var(--glass-ground-rule);stroke-opacity:.6;stroke-width:1.5}
@media(prefers-reduced-transparency:reduce) {
 .dimensional-front,.dimensional-side,.dimensional-cap {fill-opacity:1}
 .dimensional-glint,.dimensional-spine {display:none}
}
@media(forced-colors:active) {
 .dimensional-front,.dimensional-column [data-thin=true] .dimensional-front,.dimensional-column .dimensional-tone-slate[data-thin=true] .dimensional-front {fill:CanvasText;fill-opacity:1}
 .dimensional-side,.dimensional-cap {fill:Canvas;stroke:CanvasText;fill-opacity:1}
 .dimensional-glint,.dimensional-rim,.dimensional-ground-surface {display:none}
 .dimensional-ground-edge {stroke:CanvasText}
}
`;
export const dimensionalChartStyles = `
${dimensionalColumnStyles}
.flat-comparison {display:grid;gap:12px;min-width:0}
.flat-comparison-row {min-width:0}
.flat-comparison-action {display:grid;grid-template-columns:minmax(0,1fr) minmax(0,max-content);gap:8px 16px;align-items:center;min-height:44px;width:100%;padding:8px 0;border:0;border-radius:var(--radius-small);background:transparent;text-decoration:none;font-size:var(--type-small);color:var(--ink);text-align:start;scroll-margin-block:calc(var(--app-header-height,76px) + 16px) 16px}
.flat-comparison-action .group-name {overflow-wrap:anywhere;min-width:0;font-family:var(--font)}
.flat-comparison-action:is(a,button) {color:var(--accent);cursor:pointer}
.flat-comparison-action:is(a,button):is(:hover,:active) {background:var(--canvas);color:var(--ink);border:0}
.flat-comparison-action:focus-visible {outline:2px solid var(--focus);outline-offset:2px}
.flat-comparison-count {font-variant-numeric:tabular-nums;font-weight:var(--weight-strong);min-width:0;overflow-wrap:anywhere}
.flat-comparison-track {display:flex;grid-column:1/-1;height:12px;min-width:0;background:var(--canvas)}
.flat-comparison-segment {display:block;height:100%;min-width:0;flex-shrink:0;background:var(--column-label)}
@media(max-width:500px) {.flat-comparison-action {grid-template-columns:minmax(0,1fr)}}
@media(forced-colors:active) {.flat-comparison-segment {background:CanvasText}.flat-comparison-action:focus-visible {outline-color:Highlight}}
.dimensional-scroll {overflow-x:auto;overflow-y:hidden;padding:8px 4px calc(max(16px,1rem) + 1px);scrollbar-width:thin;min-width:0;max-width:100%}
.dimensional-plot {position:relative;min-width:0;margin-inline:auto}
.dimensional-comparison {display:grid;grid-auto-flow:column;grid-auto-columns:var(--scene-pitch);gap:0;position:relative}
.dimensional-category {min-width:0;display:grid;grid-template-rows:var(--scene-base) auto;gap:0;align-content:stretch}
.dimensional-category.service-chart-row {grid-template-columns:minmax(0,1fr);margin:0;position:relative;border:0;padding:0}
.dimensional-stage {position:relative;min-width:0}
.dimensional-stage .time-zero {position:absolute;bottom:0;left:50%;transform:translateX(-50%)}
.dimensional-action,.dimensional-plot .time-column {position:absolute;bottom:0;display:block;max-width:none;min-width:0;min-height:0;border:0;border-radius:0;padding:0;background:transparent;pointer-events:none}
.dimensional-category .dimensional-action {min-height:0}
.dimensional-action .row-bar,.dimensional-plot .time-stack {display:block;position:absolute;bottom:0;width:100%;height:auto;border-radius:0;overflow:visible;background:transparent;pointer-events:none}
.dimensional-action:hover:not(:disabled),.dimensional-action:active:not(:disabled),.dimensional-plot .time-column:hover:not(:disabled) {background:transparent;border:0}
.dimensional-plot .time-column:hover .time-stack {filter:none;outline:0}
.dimensional-action:focus-visible,.dimensional-plot .time-column:focus-visible {outline:0}
.dimensional-count {position:absolute;bottom:calc(100% + 8px);left:var(--column-center,50%);transform:translateX(-50%);display:flex;align-items:center;justify-content:center;min-height:44px;padding:8px;color:var(--ink);font-size:1.125rem;line-height:1.2;font-weight:var(--weight-strong);font-variant-numeric:tabular-nums;white-space:nowrap;pointer-events:none}
:is(.dimensional-action,.time-column) .dimensional-count {pointer-events:auto;color:var(--accent);text-decoration:none;cursor:pointer}
:is(.dimensional-action,.time-column):is(:hover,:active) .dimensional-count {background:transparent;color:var(--ink)}
:is(.dimensional-action,.time-column) .dimensional-count {border-radius:var(--radius-small)}
:is(.dimensional-action,.time-column):focus-visible .dimensional-count {outline:2px solid var(--focus);outline-offset:2px}
.dimensional-plot .time-slot .dimensional-count {font-size:1rem}
.dimensional-category-label {padding:24px 8px 0;text-align:center;min-width:0;position:relative;align-self:start}
.dimensional-category-label .group-name {display:block;font-family:var(--font);font-size:var(--type-small);color:var(--ink);line-height:var(--leading-ui);font-weight:var(--weight-medium);overflow-wrap:anywhere;text-wrap:balance}
.dimensional-label-line {min-width:0;width:100%;max-width:calc(6rem + 88px);margin-inline:auto}
.dimensional-reading {color:var(--muted);font-size:var(--type-caption);line-height:1.5;margin:max(16px,1rem) 0 0;max-width:80ch}
#chartFooter:has(.chart-size-note) {flex-wrap:wrap}
#chartFooter>.chart-size-note {flex:1 1 28ch;min-width:0;white-space:normal}
.chart-details {margin-top:0;min-width:0}
.chart-details>summary {min-height:44px;align-content:center;color:var(--accent);font-size:var(--type-small);cursor:pointer}
#chartReadingNotes p {max-width:80ch}
#chartFooter:has(>span:only-child:empty) {display:none}
.dimensional-plot .time-chart {position:relative;height:var(--scene-base);display:block;border:0;gap:0;margin:0;padding:0}
.dimensional-plot .time-slot {position:absolute;bottom:0;height:100%;min-width:0;display:block}
.dimensional-plot .time-slot .time-zero {position:absolute;bottom:0;left:50%;transform:translateX(-50%)}
.dimensional-plot .time-zero {height:1px;background:var(--control)}
.dimensional-time-labels {display:grid;grid-auto-flow:column;grid-auto-columns:var(--scene-pitch);min-height:48px;margin:0;padding-top:24px;color:var(--muted);font-size:var(--type-small);text-align:center}
.dimensional-time-labels>span {padding-inline:8px;overflow-wrap:anywhere;min-width:0}
.flat-time-plot {position:relative;min-width:100%;--time-gutter:40px}
.flat-time-plot .time-chart {position:relative;display:grid;grid-template-columns:repeat(var(--time-bins),minmax(0,1fr));height:calc(var(--time-height) + 4rem);gap:0;margin:0 0 0 var(--time-gutter);padding:0;border:0;border-bottom:1px solid var(--control)}
.flat-time-plot .time-slot {position:relative;display:block;height:100%;min-width:0}
.flat-time-plot .time-column {position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:84px;min-width:0;min-height:0;padding:0;border:0;border-radius:0;background:transparent;pointer-events:none}
.flat-time-plot .time-stack {display:block;width:100%;height:100%;overflow:visible;border-radius:0;pointer-events:none}
.flat-time-column {display:block;max-width:none;overflow:visible;pointer-events:none}
.flat-time-segment {fill:var(--column-label);fill-opacity:1;stroke:none;pointer-events:visibleFill}
.flat-time-column [data-ux-tooltip]:hover {fill-opacity:1}
.flat-time-plot .time-column:hover .time-stack {filter:none;outline:0}
.flat-time-plot .time-column:focus-visible {outline:0}
.flat-time-plot .dimensional-count {font-size:1rem;min-width:44px}
.flat-time-plot .time-zero {position:absolute;bottom:0;left:50%;transform:translateX(-50%);height:0;background:none}
.flat-time-plot .dimensional-time-labels {grid-template-columns:repeat(var(--time-bins),minmax(0,1fr));grid-auto-flow:row;grid-auto-columns:auto;padding:12px 0 0;margin-left:var(--time-gutter);font-size:var(--type-small);min-height:44px}
.flat-time-axis {position:absolute;bottom:0;left:calc(-1 * var(--time-gutter));height:var(--time-height);width:calc(var(--time-gutter) - 12px);display:flex;flex-direction:column;justify-content:space-between;align-items:flex-end;color:var(--muted);font-size:var(--type-small);font-variant-numeric:tabular-nums;pointer-events:none}
.flat-time-axis>span {line-height:1}
.flat-time-axis>span:first-child {transform:translateY(-50%)}
.flat-time-axis>span:last-child {transform:translateY(50%)}
#chart:has(.flat-time-plot)+#chartFooter {justify-content:flex-start;gap:8px 24px}
#chart:has(.flat-time-plot)+#chartFooter>span {white-space:normal;min-width:0}
@media(forced-colors:active) {.flat-time-segment {fill:CanvasText;fill-opacity:1}.flat-time-plot .time-chart {border-color:CanvasText}}
@media(prefers-reduced-motion:reduce) {.flat-time-column,.flat-time-plot .time-column {animation:none;transition:none}}
#homeView:has(.dimensional-plot) .swatch {background:var(--chart-teal-label)}
#homeView:has(.dimensional-plot) .swatch.failure {background:var(--chart-pink-label)}
#homeView:has(.dimensional-plot) .swatch.transport {background:var(--chart-cyan-label)}
#homeView:has(.dimensional-plot) .swatch.partial {background:var(--chart-orange-label)}
#homeView:has(.dimensional-plot) .swatch.unknown {background:var(--chart-slate-label)}
#homeView:has(.dimensional-plot) .swatch.other {background:var(--chart-violet-label)}
@media(max-width:600px) {.chart-panel:has(.dimensional-plot) {padding-inline:16px}}
@media(prefers-reduced-motion:reduce) {.dimensional-column,.dimensional-action {animation:none;transition:none}}
`;
