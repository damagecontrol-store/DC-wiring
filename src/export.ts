// Pure builders for exported files: CSV tables and the printable HTML report. No Obsidian or DOM here.
import { routeWires, wireLength } from "./bundles.ts";
import { coreName } from "./cable.ts";
import { cavName, compLabel, labelOf } from "./components.ts";
import { bom, computeNets, signalOf, type BomRow, type Component, type End, type Harness, type Wire } from "./model.ts";
import { effectiveWire } from "./parts.ts";
import { voltageDrop } from "./validate.ts";

type Cell = string | number | undefined;

const csvCell = (v: Cell) => {
	const s = v === undefined ? "" : String(v);
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** RFC 4180 CSV. Starts with a UTF-8 BOM, or Excel reads accents and ² as garbage. */
export const csv = (rows: Cell[][]) => "﻿" + rows.map(r => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

const qty = (r: BomRow) => r.unit === "m" ? Number(r.qty.toFixed(3)) : r.qty;
const money = (n: number) => Number(n.toFixed(2));

/** "Lamp : 1" (label, else id; pin designation), "CB1.2" for a cable core, "Door › C4:1" for a sub-harness pin. */
export function endLabel(h: Harness, e: End): string {
	const c = h.components.find(c => c.id === e.c);
	if (!c) return `${e.c} : ${e.pin}`;
	if (c.kind === "harness") return `${compLabel(h, c)} › ${c.ports?.[e.pin - 1] ?? e.pin}`;
	if (c.kind === "cable") return coreName(c, e.pin);
	return `${compLabel(h, c)} : ${cavName(c, e.pin)}`;
}

/** Section and sheet title of a component: "ECU (C1)", or just "C1" without a label. */
const compTitle = (c: Component) => labelOf(c) ? `${labelOf(c)} (${c.id})` : c.id;

/** What a wire really is: colour and gauge from its part, length routed through bundles when it is. */
function wireOut(h: Harness, w: Wire, routes: ReturnType<typeof routeWires>) {
	const e = effectiveWire(h, w);
	return { color: e.color, gauge: e.gauge, length: Math.round(wireLength(h, w, routes)) || ("" as const) };
}

/** BOM of this harness, then the parts rolled up from its sub-harnesses, then a total. */
export function bomTable(h: Harness, fromSubs: BomRow[] = []): Cell[][] {
	const head = ["Part number", "Manufacturer", "Description", "Qty", "Unit", "Unit price", "Total", "Source"];
	const row = (r: BomRow, src: string) => [r.part.number, r.part.manufacturer, r.part.description, qty(r), r.unit, r.part.price, money(r.total), src];
	const own = bom(h).filter(r => !r.excluded); // like the Parts tab: excluded parts are neither listed nor paid for
	return [head, ...own.map(r => row(r, r.used ? "" : "not used")), ...fromSubs.map(r => row(r, "sub-harness")),
		["Total", "", "", "", "", "", money([...own, ...fromSubs].reduce((s, r) => s + r.total, 0)), ""]];
}

const partNo = (h: Harness, id?: string) => h.parts.find(p => p.id === id)?.number ?? "";

/** Every wire with both ends and their signals. */
export function connectionsTable(h: Harness): Cell[][] {
	const nets = computeNets(h), routes = routeWires(h);
	return [["Wire", "Name", "From", "From signal", "To", "To signal", "Colour", "Gauge", "Length (mm)", "Current (A)", "Drop (V)", "Part"],
		...h.wires.map(w => {
			const o = wireOut(h, w, routes), v = voltageDrop(h, w, routes);
			return [w.id, w.name, endLabel(h, w.from), signalOf(h, w.from, nets), endLabel(h, w.to), signalOf(h, w.to, nets), o.color, o.gauge, o.length, w.current, v === undefined ? undefined : Number(v.toFixed(2)), partNo(h, w.partId)];
		})];
}

export interface WiringRow { cavity: string; signal: string; destination: string; wire: string; color: string; gauge: string; length: number | "" }

/** One row per wire end on each cavity of a connector or splice; a cavity with no wire gets one empty row. */
export function wiringRows(h: Harness, c: Component, nets = computeNets(h), routes = routeWires(h)): WiringRow[] {
	const rows: WiringRow[] = [];
	for (let pin = c.kind === "cable" && c.shield ? 0 : 1; pin <= c.pins; pin++) { // a cable's shield is pin 0
		const signal = signalOf(h, { c: c.id, pin }, nets) ?? "";
		const ends = h.wires.flatMap(w => [[w.from, w.to, w], [w.to, w.from, w]] as const).filter(([a]) => a.c === c.id && a.pin === pin);
		const cavity = pin === 0 ? "S" : cavName(c, pin);
		if (!ends.length) rows.push({ cavity, signal, destination: "", wire: "", color: "", gauge: "", length: "" });
		for (const [, b, w] of ends) {
			const sig = signalOf(h, b, nets);
			rows.push({ cavity, signal, destination: endLabel(h, b) + (sig ? ` (${sig})` : ""), wire: w.name || w.id, ...wireOut(h, w, routes) });
		}
	}
	return rows;
}

const WIRING_HEAD = ["Cavity", "Signal", "Destination", "Wire", "Colour", "Gauge", "Length (mm)"];
const wiringCells = (r: WiringRow): Cell[] => [r.cavity, r.signal, r.destination, r.wire, r.color, r.gauge, r.length];

/** Wiring table of every connector and splice in one sheet, the component in the first column. */
export function wiringTables(h: Harness): Cell[][] {
	const nets = computeNets(h), routes = routeWires(h);
	return [["Component", ...WIRING_HEAD], ...h.components.filter(c => c.kind !== "harness" && c.kind !== "note")
		.flatMap(c => wiringRows(h, c, nets, routes).map(r => [compTitle(c), ...wiringCells(r)]))];
}

const byNumber = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** Cut list: wires grouped by gauge, then colour, so each reel is cut in one go. */
export function cutList(h: Harness): Cell[][] {
	const routes = routeWires(h);
	const wires = h.wires.map(w => ({ w, ...wireOut(h, w, routes) }))
		.sort((a, b) => byNumber(a.gauge, b.gauge) || byNumber(a.color, b.color) || byNumber(a.w.id, b.w.id));
	return [["Wire", "Gauge", "Colour", "Length (mm)", "Part", "From", "To"],
		...wires.map(({ w, gauge, color, length }) => [w.name || w.id, gauge, color, length, partNo(h, w.partId), endLabel(h, w.from), endLabel(h, w.to)])];
}

// --- HTML report ---

export type TitleBlock = NonNullable<Harness["export"]>;

export const esc = (s: Cell) => (s === undefined ? "" : String(s)).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

/** First row is the header. */
export const htmlTable = (rows: Cell[][]) =>
	`<table><tr>${rows[0].map(c => `<th>${esc(c)}</th>`).join("")}</tr>${rows.slice(1).map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</table>`;

/**
 * Printable report: title block, notes, schematic, BOM, connections and a wiring table per connector.
 * svg is the standalone schematic (already self-contained markup, inserted as is).
 */
export function reportHtml(h: Harness, t: TitleBlock, svg: string, fromSubs: BomRow[] = [], brand?: { fontCss: string; logo: string }): string {
	const nets = computeNets(h);
	const block = ([["Company", t.company], ["Title", t.title], ["Drawing no.", t.drawing], ["Date", t.date], ["Drawn by", t.drawnBy]] as const)
		.filter(([, v]) => v).map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join("");
	const comps = h.components.filter(c => c.kind !== "harness" && h.wires.some(w => w.from.c === c.id || w.to.c === c.id));
	// Damage Control style (DC-design-system tokens) on white paper: ink text, mint table heads, title-bar gradient headings
	return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(t.title)}</title><style>
${brand?.fontCss ?? ""}
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; box-sizing: border-box; }
body { font: 11px "IBM Plex Sans Condensed", sans-serif; color: #01190C; background: #fff; margin: 16px; }
.head { display: flex; align-items: center; gap: 20px; padding: 12px 16px; color: #C9E9D9;
	background: linear-gradient(90deg, #01190C 0%, #43A574 99.83%); box-shadow: 6px 3px 0 0 #0000004d; }
.head img { height: 48px; } .head .name { flex: 1; }
.path { font: 600 11px "Exo 2", sans-serif; color: #9AD5B8; }
h1 { font: 700 26px/1.1 Oxanium, sans-serif; margin: 2px 0 0; }
.head table { width: auto; margin: 0; color: #C9E9D9; } .head th, .head td { border: 0; padding: 1px 6px; background: none; }
.head th { color: #9AD5B8; text-transform: none; letter-spacing: 0; }
.notes { white-space: pre-wrap; margin: 12px 0 0; padding: 8px 12px; background: #C9E9D9; border-left: 4px solid #43A574; }
h2 { font: 600 13px "Exo 2", sans-serif; color: #C9E9D9; margin: 22px 0 0; padding: 4px 10px; break-after: avoid;
	background: linear-gradient(90deg, #01190C 0%, #43A574 99.83%); border: 2px solid; border-color: #9AD5B8 #476254 #476254 #9AD5B8; }
table { border-collapse: collapse; width: 100%; margin-bottom: 8px; }
th, td { border: 1px solid #9AD5B8; padding: 2px 6px; text-align: left; }
th { background: #C9E9D9; font: 600 10px "Exo 2", sans-serif; text-transform: uppercase; letter-spacing: 0.04em; }
.schematic { border: 2px solid; border-color: #9AD5B8 #476254 #476254 #9AD5B8; border-top: 0; padding: 8px; }
.schematic svg { display: block; max-width: 100%; height: auto; max-height: 125mm; margin: 0 auto; }
.foot { margin-top: 24px; font: 600 9px "Exo 2", sans-serif; color: #476254; }
section { break-inside: avoid; } @page { size: landscape; margin: 10mm; }
</style></head><body>
<div class="head">${brand ? `<img src="${brand.logo}" alt="Damage Control">` : ""}<div class="name"><div class="path">DC:\\Wiring\\${esc(t.drawing || t.title)}</div><h1>${esc(t.title)}</h1></div><table class="title-block">${block}</table></div>
${t.notes ? `<div class="notes">${esc(t.notes)}</div>` : ""}
<h2>Schematic</h2><div class="schematic">${svg}</div>
<h2>Bill of materials</h2>${htmlTable(bomTable(h, fromSubs))}
<h2>Connections</h2>${htmlTable(connectionsTable(h))}
${comps.map(c => `<section><h2>${esc(compTitle(c))}</h2>${htmlTable([WIRING_HEAD, ...wiringRows(h, c, nets).map(wiringCells)])}</section>`).join("\n")}
<div class="foot">DC Wiring · Damage Control</div>
</body></html>`;
}
