// Typed parts: which fields each type has, wires taking their look from their part, and configuration accessories.
// Pure: no Obsidian imports, so tests can load it.

import { nextId, type Component, type Configuration, type Harness, type Kind, type Part, type PartType, type Wire } from "./model.ts";
import { toMm2, type GaugeUnit } from "./units.ts";

export interface PartField { key: keyof Part; label: string; kind?: "number" | "bool" | "cores" | "list"; options?: string[] }

const range: PartField[] = [{ key: "gaugeMin", label: "Wire gauge, thinnest" }, { key: "gaugeMax", label: "Wire gauge, thickest" }];

/** Part types in display order, with their own fields (the common fields are in every editor). */
export const PART_TYPES: Record<PartType, { label: string; fields: PartField[] }> = {
	connector: { label: "Connectors", fields: [
		{ key: "cavities", label: "Cavities", kind: "number" },
		{ key: "designations", label: "Cavity names, one per cavity (e.g. A1, A2, B1, B2)", kind: "list" },
		{ key: "gender", label: "Gender", options: ["male", "female"] },
		{ key: "shell", label: "Shell (wire can connect to the housing)", kind: "bool" },
	] },
	wire: { label: "Wires", fields: [
		{ key: "gauge", label: "Gauge" },
		{ key: "stripe", label: "Stripe" },
		{ key: "insulation", label: "Insulation (mm)", kind: "number" },
		{ key: "diameter", label: "Diameter (mm)", kind: "number" },
	] },
	cable: { label: "Cables", fields: [
		{ key: "coreList", label: "Cores: colour and gauge, comma separated (e.g. rd 0.5, bk/wh 0.5)", kind: "cores" },
		{ key: "shield", label: "Shield", kind: "bool" },
		{ key: "diameter", label: "Diameter (mm)", kind: "number" },
	] },
	terminal: { label: "Terminals", fields: [
		{ key: "terminalType", label: "Terminal type", options: ["ring", "spade", "quick-connect", "ferrule", "other"] },
		{ key: "size", label: "Size (stud or tab)" },
		...range,
	] },
	splice: { label: "Splices", fields: range },
	diode: { label: "Diodes", fields: [{ key: "value", label: "Rating" }] },
	resistor: { label: "Resistors", fields: [{ key: "value", label: "Resistance" }] },
	covering: { label: "Coverings", fields: [
		{ key: "coveringType", label: "Covering type", options: ["heatshrink", "tape", "corrugated tubing", "spiral wrap", "tubing", "braided sleeve"] },
		{ key: "cutToLength", label: "Cut to length (priced per metre)", kind: "bool" },
		{ key: "length", label: "Fixed length (mm)", kind: "number" },
		{ key: "diameter", label: "Diameter (mm)", kind: "number" },
	] },
	contact: { label: "Contacts", fields: [
		{ key: "contactType", label: "Type", options: ["crimp", "solder", "other"] },
		{ key: "gender", label: "Gender", options: ["pin", "socket"] },
		...range,
	] },
	"cavity-plug": { label: "Cavity plugs", fields: [] },
	"cavity-seal": { label: "Cavity seals", fields: [] },
	lock: { label: "Locks", fields: [] },
	"dust-cover": { label: "Dust covers", fields: [] },
	boot: { label: "Boots", fields: [] },
	backshell: { label: "Backshells", fields: [] },
	mount: { label: "Mounts", fields: [] },
	group: { label: "Groups", fields: [] },
	other: { label: "Other", fields: [] },
};

/** Part types that carry configurations of accessories. */
export const HAS_CONFIGS: PartType[] = ["connector", "terminal", "splice", "diode", "resistor"];

/** A wire as drawn and validated: a wire part's colour, stripe and gauge win over the wire's own. */
export function effectiveWire(h: Harness, w: Wire): Wire {
	const p = h.parts.find(p => p.id === w.partId && p.type === "wire");
	if (!p) return w;
	const base = w.color.split(/[\/\-]/)[0];
	// a part colour means the whole look comes from the part, so a plain part also drops the wire's stripe
	const color = p.colour ? [p.colour, p.stripe].filter(Boolean).join("/") : p.stripe ? `${base}/${p.stripe}` : w.color;
	return { ...w, color, gauge: p.gauge || w.gauge };
}

/** What a part can be assigned to: a component or a wire. */
export type Item = Component | Wire;
const isComp = (x: Item): x is Component => "kind" in x;
const KIND_TYPE: Partial<Record<Kind, PartType>> = { connector: "connector", terminal: "terminal", splice: "splice", diode: "diode", resistor: "resistor", cable: "cable" };
// component terminal types -> terminal part types
const TERMINAL: Record<string, string> = { ring: "ring", spade: "spade", ferrule: "ferrule", "male QC": "quick-connect", "female QC": "quick-connect", "loose end": "other" };

export const partTypeFor = (x: Item): PartType | undefined => isComp(x) ? KIND_TYPE[x.kind] : "wire";

/** Whether a part suits a component or wire: its type, and its cavities, cores or terminal type when the part has them. */
export function fitsItem(p: Part, x: Item): boolean {
	const type = partTypeFor(x);
	if (!type || p.type !== type || !isComp(x)) return !!type && p.type === type;
	if (x.kind === "connector") return p.cavities === undefined || p.cavities === x.pins;
	if (x.kind === "cable") { const n = p.coreList?.length ?? p.cores; return n === undefined || n === x.pins; }
	if (x.kind === "terminal") return !p.terminalType || !x.terminal || p.terminalType === TERMINAL[x.terminal];
	return true;
}

export interface Choice { part: Part; config?: string; fits: boolean }

/** Assign-part options: parts that fit first, then the rest. A part with several configurations gets one option per configuration. */
export function partChoices(h: Harness, x: Item): Choice[] {
	const fit = h.parts.filter(p => fitsItem(p, x)), rest = h.parts.filter(p => !fitsItem(p, x));
	return [...fit, ...rest].flatMap(part => {
		const fits = fit.includes(part), cfs = part.configurations ?? [];
		return cfs.length > 1 ? cfs.map(cf => ({ part, config: cf.name, fits })) : [{ part, fits }];
	});
}

/** Assigns a part (and configuration) to every item; no part unassigns. The part's first configuration is the unset default. */
export function assignPart(h: Harness, items: Item[], partId?: string, config?: string) {
	const first = h.parts.find(p => p.id === partId)?.configurations?.[0]?.name;
	const part = h.parts.find(p => p.id === partId);
	for (const x of items) {
		if (partId) x.partId = partId; else delete x.partId;
		if (isComp(x)) { const cav = partCavities(part, x); if (cav) x.cavities = cav; }
		if (isComp(x)) { if (partId && config && config !== first) x.config = config; else delete x.config; }
	}
}

/** Cavity names a connector takes from its part: only when the part names exactly one per pin. */
export function partCavities(p: Part | undefined, c: Component): string[] | undefined {
	return p?.type === "connector" && c.kind === "connector" && p.designations?.length === c.pins ? [...p.designations] : undefined;
}

/** After a part edit: connectors using it take its cavity names. */
export function followPart(h: Harness, p: Part) {
	for (const c of h.components) if (c.partId === p.id) { const cav = partCavities(p, c); if (cav) c.cavities = cav; }
}

/** A new part filled in from a component or wire (type, cavities, cores, colour, gauge), added to the harness. */
export function partFrom(h: Harness, x: Item): Part {
	const p: Part = { id: nextId(h, "P", h.parts), number: "", manufacturer: "", description: "", price: 0 };
	const type = partTypeFor(x);
	if (type) p.type = type;
	if (!isComp(x)) {
		const [colour, stripe] = x.color.split(/[\/\-]/);
		if (colour) p.colour = colour;
		if (stripe) p.stripe = stripe;
		if (x.gauge) p.gauge = x.gauge;
	} else if (x.kind === "connector") { p.cavities = x.pins; if (x.cavities?.some(Boolean)) p.designations = x.cavities.map((s, i) => s || String(i + 1)); }
	else if (x.kind === "cable") { p.cores = x.pins; if (x.cores?.length) p.coreList = x.cores.map(k => ({ ...k })); if (x.shield) p.shield = true; }
	else if (x.kind === "terminal" && x.terminal && TERMINAL[x.terminal]) p.terminalType = TERMINAL[x.terminal];
	h.parts.push(p);
	return p;
}

/** One line of a part's main specs for the Parts table, e.g. "4 cav · female" or "ring · M6 · 0.5–1.5". */
export function partSummary(p: Part): string {
	const range = p.gaugeMin || p.gaugeMax ? `${p.gaugeMin ?? "?"}–${p.gaugeMax ?? "?"}` : "";
	const cores = p.coreList?.length ?? p.cores;
	const bits: Partial<Record<PartType, unknown[]>> = {
		connector: [p.cavities && `${p.cavities} cav`, p.gender, p.shell && "shell"],
		wire: [p.gauge, [p.colour, p.stripe].filter(Boolean).join("/")],
		cable: [cores && `${cores} core${cores > 1 ? "s" : ""}`, p.shield && "shielded"],
		terminal: [p.terminalType, p.size, range],
		contact: [p.contactType, p.gender, range],
		splice: [range],
		diode: [p.value],
		resistor: [p.value],
		covering: [p.coveringType, p.cutToLength ? "cut to length" : p.length && `${p.length} mm`, p.diameter && `Ø${p.diameter} mm`],
	};
	return (p.type ? bits[p.type] ?? [] : []).filter(Boolean).join(" · ");
}

/** Part ids the selected components and wires use, accessories included. */
export function partsUsedBy(h: Harness, sel: { components?: string[]; wires?: string[] }): Set<string> {
	const out = new Set<string>();
	for (const c of h.components) if (sel.components?.includes(c.id)) {
		if (c.partId) out.add(c.partId);
		for (const l of loadedParts(h, c)) out.add(l.partId);
	}
	for (const w of h.wires) if (w.partId && sel.wires?.includes(w.id)) out.add(w.partId);
	return out;
}

export function configOf(h: Harness, c: Component): Configuration | undefined {
	const cfs = h.parts.find(p => p.id === c.partId)?.configurations;
	return cfs?.find(cf => cf.name === c.config) ?? cfs?.[0];
}

/** Sum of the gauges (mm²) of the wires on a pin; undefined when it has none or one has no readable gauge. */
export function pinGauge(h: Harness, c: string, pin: number): number | undefined {
	const unit: GaugeUnit = h.gaugeUnit ?? "mm²";
	const ws = h.wires.filter(w => (w.from.c === c && w.from.pin === pin) || (w.to.c === c && w.to.pin === pin));
	let sum = 0;
	for (const w of ws) {
		const g = toMm2(effectiveWire(h, w).gauge, unit);
		if (g === undefined) return;
		sum += g;
	}
	return ws.length ? sum : undefined;
}

/** Whether a gauge (mm²) is inside a contact's range. A part without a range takes any gauge. */
export function fitsRange(h: Harness, p: Part, mm2: number | undefined): boolean {
	const unit = h.gaugeUnit ?? "mm²";
	const a = toMm2(p.gaugeMin, unit), b = toMm2(p.gaugeMax, unit);
	if (a === undefined && b === undefined) return true;
	if (mm2 === undefined) return false;
	let lo = a ?? 0, hi = b ?? Infinity;
	if (lo > hi) [lo, hi] = [hi, lo]; // typed the wrong way round, easy with AWG
	// 5% slack: datasheets mix 0.5 mm² and 20 AWG (0.52 mm²) for the same size
	return mm2 >= lo * 0.95 && mm2 <= hi * 1.05;
}

const SLOTS: PartType[][] = [["contact", "cavity-plug"], ["cavity-seal"]];

/**
 * Accessory parts a component gets from its part's configuration. Contacts, cavity plugs and seals go per pin:
 * each pin takes the first contact or plug whose rule fits (and the first fitting seal); the rest count once.
 * A contact set by hand on a cavity (c.contacts) replaces the configuration's contact or plug there.
 */
export function loadedParts(h: Harness, c: Component): { partId: string; pin?: number }[] {
	const cf = configOf(h, c) ?? (c.contacts ? { name: "", items: [] } : undefined); // cavity overrides count without a configuration too
	if (!cf) return [];
	const items = cf.items.flatMap(i => {
		const p = h.parts.find(p => p.id === i.partId);
		return p ? [{ p, apply: i.apply ?? (p.type === "cavity-plug" ? "unconnected" : "connected") }] : [];
	});
	const perPin = SLOTS.flat();
	const out: { partId: string; pin?: number }[] = items.filter(x => !perPin.includes(x.p.type!)).map(x => ({ partId: x.p.id }));
	for (let pin = 1; pin <= c.pins; pin++) {
		const connected = h.wires.some(w => (w.from.c === c.id && w.from.pin === pin) || (w.to.c === c.id && w.to.pin === pin));
		const gauge = connected ? pinGauge(h, c.id, pin) : undefined;
		for (const slot of SLOTS) {
			const own = c.contacts?.[pin];
			if (slot === SLOTS[0] && own !== undefined) { if (own) out.push({ partId: own, pin }); continue; } // set by hand on this cavity
			const hit = items.find(x => slot.includes(x.p.type!) && x.apply === (connected ? "connected" : "unconnected")
				&& (!connected || x.p.type !== "contact" || fitsRange(h, x.p, gauge)));
			if (hit) out.push({ partId: hit.p.id, pin });
		}
	}
	return out;
}

/**
 * Switches the harness gauge unit. Plain-number gauges were typed in the old unit, so they get it written out
 * instead of silently changing size.
 */
export function setGaugeUnit(h: Harness, unit: GaugeUnit) {
	const old = h.gaugeUnit ?? "mm²";
	if (unit === old) return;
	const pin = (s?: string) => s && /^\d+(?:[.,]\d+)?$/.test(s.trim()) ? `${s.trim()} ${old}` : s;
	for (const w of h.wires) w.gauge = pin(w.gauge) ?? "";
	for (const p of h.parts) for (const k of ["gauge", "gaugeMin", "gaugeMax"] as const) if (p[k]) p[k] = pin(p[k]);
	if (unit === "mm²") delete h.gaugeUnit; else h.gaugeUnit = unit;
}
