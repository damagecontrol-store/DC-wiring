// Design checks shown as warnings. Pure: no Obsidian imports, so tests can load it.

import { routeWires, wireLength } from "./bundles.ts";
import { bom, type Harness, type Wire } from "./model.ts";
import { configOf, effectiveWire, fitsRange, loadedParts, pinGauge } from "./parts.ts";
import { formatGauge, toMm2 } from "./units.ts";

// shortcut: copper at 20 °C; a hot wire (~80 °C) has ~25 % more resistance, add a temperature setting if that matters
const COPPER = 0.0175; // Ω·mm²/m

/** Voltage drop over the wire itself in V, or undefined without a current, gauge or length. The return path is its own wire (or chassis). */
export function voltageDrop(h: Harness, w: Wire, routes = routeWires(h)): number | undefined {
	const mm2 = toMm2(effectiveWire(h, w).gauge, h.gaugeUnit), m = wireLength(h, w, routes) / 1000;
	if (!w.current || !mm2 || !m) return;
	return w.current * COPPER * m / mm2;
}

/** Warnings drawn on the Schematic: wire and component ones. "No part" is left out, or every new wire would light up. */
export const canvasWarnings = (h: Harness) => validate(h).filter(w => w.kind !== "part" && w.message !== "No part");

/** Drop as a percentage of the harness supply voltage. */
export const dropPercent = (h: Harness, v: number) => 100 * v / (h.voltage || 12);

export interface Warning { kind: "component" | "wire" | "part"; id: string; pin?: number; message: string }

export function validate(h: Harness): Warning[] {
	const out: Warning[] = [];
	const part = (id?: string) => h.parts.find(p => p.id === id);
	for (const c of h.components) {
		const p = part(c.partId);
		if (p?.type === "connector" && p.cavities && p.cavities !== c.pins)
			out.push({ kind: "component", id: c.id, message: `${c.pins} pins, but part ${p.number || p.id} has ${p.cavities} cavities` });
		for (const [pin, id] of Object.entries(c.contacts ?? {})) {
			const k = part(id), g = pinGauge(h, c.id, Number(pin));
			if (k?.type === "contact" && g !== undefined && !fitsRange(h, k, g))
				out.push({ kind: "component", id: c.id, pin: Number(pin), message: `pin ${pin}: contact ${k.number || k.id} does not take ${formatGauge(g, h.gaugeUnit ?? "mm²")}` });
		}
		const cf = configOf(h, c);
		const contacts = cf?.items.filter(i => part(i.partId)?.type === "contact" && (i.apply ?? "connected") === "connected") ?? [];
		if (!contacts.length) continue;
		const loaded = loadedParts(h, c);
		for (let pin = 1; pin <= c.pins; pin++) {
			if (!h.wires.some(w => (w.from.c === c.id && w.from.pin === pin) || (w.to.c === c.id && w.to.pin === pin))) continue;
			if (c.contacts?.[pin] !== undefined) continue; // chosen by hand, checked above
			if (loaded.some(l => l.pin === pin && ["contact", "cavity-plug"].includes(part(l.partId)?.type ?? ""))) continue;
			const g = pinGauge(h, c.id, pin);
			out.push({ kind: "component", id: c.id, pin, message: g === undefined
				? `pin ${pin}: a wire has no gauge, so no contact fits`
				: `pin ${pin}: ${formatGauge(g, h.gaugeUnit ?? "mm²")} fits no contact in configuration "${cf!.name}"` });
		}
	}
	const routes = routeWires(h), limit = h.maxDrop ?? 5;
	for (const w of h.wires) {
		if (!part(w.partId)) out.push({ kind: "wire", id: w.id, message: "No part" });
		const max = part(w.partId)?.ampacity;
		if (w.current && max && w.current > max) out.push({ kind: "wire", id: w.id, message: `${w.current} A is over the part's ${max} A rating` });
		const v = voltageDrop(h, w, routes);
		if (v !== undefined && dropPercent(h, v) > limit)
			out.push({ kind: "wire", id: w.id, message: `${v.toFixed(2)} V drop (${dropPercent(h, v).toFixed(1)} %), over the ${limit} % limit` });
	}
	const seen = new Map<string, number>();
	for (const p of h.parts) if (p.number) seen.set(p.number, (seen.get(p.number) ?? 0) + 1);
	for (const r of bom(h)) {
		if ((seen.get(r.part.number) ?? 0) > 1) out.push({ kind: "part", id: r.part.id, message: `Duplicate part number ${r.part.number}` });
		if (!r.used) out.push({ kind: "part", id: r.part.id, message: "Not used" });
	}
	return out;
}
