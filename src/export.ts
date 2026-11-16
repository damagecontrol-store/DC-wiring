// Pure builders for exported files: CSV tables and the printable HTML report. No Obsidian or DOM here.
import { routeWires, wireLength } from "./bundles.ts";
import { coreName } from "./cable.ts";
import { cavName, compLabel, labelOf } from "./components.ts";
import { bom, computeNets, signalOf, type BomRow, type Component, type End, type Harness, type Wire } from "./model.ts";
import { effectiveWire } from "./parts.ts";

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
	return [["Wire", "Name", "From", "From signal", "To", "To signal", "Colour", "Gauge", "Length (mm)", "Part"],
		...h.wires.map(w => { const o = wireOut(h, w, routes); return [w.id, w.name, endLabel(h, w.from), signalOf(h, w.from, nets), endLabel(h, w.to), signalOf(h, w.to, nets), o.color, o.gauge, o.length, partNo(h, w.partId)]; })];
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
export function reportHtml(h: Harness, t: TitleBlock, svg: string, fromSubs: BomRow[] = []): string {
	const nets = computeNets(h);
	const block = ([["Company", t.company], ["Title", t.title], ["Drawing no.", t.drawing], ["Date", t.date], ["Drawn by", t.drawnBy]] as const)
		.filter(([, v]) => v).map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join("");
	const comps = h.components.filter(c => c.kind !== "harness" && h.wires.some(w => w.from.c === c.id || w.to.c === c.id));
	return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(t.title)}</title><style>
body { font: 11px system-ui, sans-serif; color: #000; margin: 16px; }
h1 { font-size: 18px; } h2 { font-size: 14px; margin-top: 24px; break-after: avoid; }
table { border-collapse: collapse; margin-bottom: 8px; } th, td { border: 1px solid #999; padding: 2px 6px; text-align: left; }
.head { display: flex; justify-content: space-between; gap: 24px; } .notes { white-space: pre-wrap; max-width: 60%; }
.schematic svg { max-width: 100%; height: auto; max-height: 90vh; }
section { break-inside: avoid; } @page { size: landscape; margin: 10mm; }
</style></head><body>
<div class="head"><div><h1>${esc(t.title)}</h1><div class="notes">${esc(t.notes)}</div></div><table class="title-block">${block}</table></div>
<div class="schematic">${svg}</div>
<h2>Bill of materials</h2>${htmlTable(bomTable(h, fromSubs))}
<h2>Connections</h2>${htmlTable(connectionsTable(h))}
${comps.map(c => `<section><h2>${esc(compTitle(c))}</h2>${htmlTable([WIRING_HEAD, ...wiringRows(h, c, nets).map(wiringCells)])}</section>`).join("\n")}
</body></html>`;
}
