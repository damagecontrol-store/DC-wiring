// Typed parts: which fields each type has, wires taking their look from their part, and configuration accessories.
// Pure: no Obsidian imports, so tests can load it.

import type { Component, Configuration, Harness, Part, PartType, Wire } from "./model.ts";
import { toMm2, type GaugeUnit } from "./units.ts";

export interface PartField { key: keyof Part; label: string; kind?: "number" | "bool"; options?: string[] }

const range: PartField[] = [{ key: "gaugeMin", label: "Wire gauge, thinnest" }, { key: "gaugeMax", label: "Wire gauge, thickest" }];

/** Part types in display order, with their own fields (the common fields are in every editor). */
export const PART_TYPES: Record<PartType, { label: string; fields: PartField[] }> = {
	connector: { label: "Connectors", fields: [
		{ key: "cavities", label: "Cavities", kind: "number" },
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
		{ key: "cores", label: "Cores", kind: "number" },
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
 */
export function loadedParts(h: Harness, c: Component): { partId: string; pin?: number }[] {
	const cf = configOf(h, c);
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
