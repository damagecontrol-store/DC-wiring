// Harness document model. Stored as pretty JSON in a .harness file.
import { wireLength } from "./bundles.ts";

import { loadedParts, effectiveWire } from "./parts.ts";
import type { GaugeUnit, LengthUnit } from "./units.ts";

export type Kind = "connector" | "splice" | "harness" | "cable"; // harness = sub-harness block

export interface Component {
	id: string; // C1, S1
	kind: Kind;
	name: string;
	x: number;
	y: number;
	pins: number; // splice always 1
	layout?: { rows: number; cols: number }; // pin grid, numbered row by row; pins = rows * cols
	signals?: Record<number, string>; // pin -> label
	partId?: string;
	exposed?: boolean; // connector: its pins show on the block when this harness is used as a sub-harness
	file?: string; // sub-harness block: vault path of the .harness file
	ports?: string[]; // sub-harness block: "C4:1" per pin, in pin order. Only grows, so pin numbers stay stable
	wiringTable?: { dx: number; dy: number }; // schematic: wiring table shown at this offset from the component
	cores?: Core[]; // cable: core n is pin n ("CB1.n"); wires on both sides of a core share its pin, so nets pass through
	shield?: boolean; // cable: pin 0 is the shield, so adding cores never renumbers it
	length?: number; // cable: mm, counted in the BOM as metres
	pos?: { x: number; y: number }; // centre on the Layout view; unset = its schematic x, y
	config?: string; // name of the part's configuration in use; the part's first one when unset
}

export interface Core { color: string; gauge: string }

export interface End { c: string; pin: number }

export interface Wire {
	id: string; // W1
	name?: string; // shown on the canvas instead of the id
	from: End;
	to: End;
	color: string; // "red" or "red/white" (base/stripe)
	gauge: string; // e.g. "0.5" (mm²) or "20AWG"
	length: number; // mm
	partId?: string;
	points?: { x: number; y: number }[]; // schematic bend points, in order from -> to
	twist?: string; // wires with the same id are twisted together
	ident?: { label?: string; colors?: string[] }; // marking printed on the wire
}

/** Named frame around components, e.g. a device (ECU, fuse box) the harness plugs into. */
export interface Group { id: string; name: string; members: string[]; partId?: string; locked?: boolean }

export interface CanvasImage { id: string; path: string; x: number; y: number; w: number; h: number } // path: vault file

export interface Part {
	id: string;
	number: string;
	manufacturer: string;
	description: string;
	price: number; // per piece, or per metre for wire parts
	type?: PartType; // unset: generic part from before typed parts
	internalNumber?: string;
	url?: string;
	colour?: string; // housing, insulation, or contact plating
	excludeFromBom?: boolean;
	// type-specific, see PART_TYPES in parts.ts for which type uses which
	cavities?: number;
	gender?: string; // connector: male/female, contact: pin/socket
	shell?: boolean;
	gauge?: string; // wire; plain number is in the harness gauge unit
	stripe?: string;
	insulation?: number; // mm
	diameter?: number; // mm
	cores?: number;
	shield?: boolean;
	terminalType?: string;
	size?: string; // terminal stud or tab size
	contactType?: string; // crimp/solder/other
	gaugeMin?: string; // contact / terminal / splice wire range
	gaugeMax?: string;
	coveringType?: string;
	cutToLength?: boolean;
	length?: number; // mm, fixed-length covering
	value?: string; // resistor ohms, diode rating
	configurations?: Configuration[];
}

export type PartType = "connector" | "wire" | "cable" | "terminal" | "splice" | "diode" | "resistor" | "covering" | "contact"
	| "cavity-plug" | "cavity-seal" | "lock" | "dust-cover" | "boot" | "backshell" | "mount" | "group" | "other";

/** A named list of accessory parts that come with every component using the part. */
export interface Configuration {
	name: string;
	items: { partId: string; apply?: "connected" | "unconnected" | "never" }[]; // apply: contacts, plugs and seals only
}

/** A run of wires on the Layout view, between two components or branch points. */
export interface Bundle {
	id: string; // B1
	from: string; // component or branch point id
	to: string;
	length: number; // mm
	points?: { x: number; y: number }[]; // layout bend points, in order from -> to
	label?: string;
}

export interface BranchPoint { id: string; x: number; y: number } // BP1

export interface Harness {
	version: 1;
	components: Component[];
	wires: Wire[];
	parts: Part[];
	currency?: string; // symbol shown with prices
	lengthUnit?: LengthUnit;
	gaugeUnit?: GaugeUnit; // unit of gauges typed as a plain number; mm² when unset
	hideWireIds?: boolean; // canvas: don't label unnamed wires with their id
	bundles?: Bundle[];
	branchPoints?: BranchPoint[];
	seq?: Record<string, number>; // last id number handed out per prefix, so deleted ids are never reused
	export?: { company?: string; title?: string; drawing?: string; date?: string; drawnBy?: string; notes?: string }; // title block and notes of exported drawings
	groups?: Group[];
	images?: CanvasImage[];
}

export const emptyHarness = (): Harness => ({ version: 1, components: [], wires: [], parts: [] });

/**
 * Reads a .harness file. Throws on anything that would break drawing (missing ids or wire ends),
 * so the view opens it read-only. Fills harmless defaults for display fields.
 */
export function parseHarness(text: string): Harness {
	if (!text.trim()) return emptyHarness();
	const h = JSON.parse(text) as Partial<Harness>;
	if (!h || typeof h !== "object" || Array.isArray(h)) throw new Error("not a harness object");
	const isEnd = (e: unknown) => !!e && typeof (e as End).c === "string" && typeof (e as End).pin === "number";
	const components = (h.components ?? []).map(c => {
		if (typeof c?.id !== "string" || !["connector", "splice", "harness", "cable"].includes(c.kind)) throw new Error(`component ${c?.id ?? "?"} needs an id and a kind`);
		return {
			...c, name: c.name ?? c.id, x: c.x ?? 0, y: c.y ?? 0,
			pins: c.kind === "splice" ? 1 : c.kind === "harness" ? (c.ports ?? []).length : c.kind === "cable" ? (c.cores ?? []).length : Math.max(1, c.pins || 1),
		};
	});
	const wires = (h.wires ?? []).map(w => {
		if (typeof w?.id !== "string" || !isEnd(w.from) || !isEnd(w.to)) throw new Error(`wire ${w?.id ?? "?"} needs an id, "from" and "to"`);
		return { ...w, color: w.color ?? "", gauge: w.gauge ?? "", length: w.length ?? 0 };
	});
	const parts = (h.parts ?? []).map(p => {
		if (typeof p?.id !== "string") throw new Error("every part needs an id");
		return { ...p, number: p.number ?? "", manufacturer: p.manufacturer ?? "", description: p.description ?? "", price: p.price ?? 0 };
	});
	for (const b of h.bundles ?? []) if (typeof b?.id !== "string" || typeof b.from !== "string" || typeof b.to !== "string") throw new Error(`bundle ${b?.id ?? "?"} needs an id, "from" and "to"`);
	// keep fields this version doesn't know about, so saving never drops them
	return { ...h, version: 1, components, wires, parts };
}

/** "8" -> 8 pins, "2x4" -> 8 pins in 2 rows of 4. Undefined if not valid. */
export function parsePins(s: string): { pins: number; layout?: { rows: number; cols: number } } | undefined {
	const m = s.trim().toLowerCase().match(/^(\d+)\s*(?:[x×*]\s*(\d+))?$/);
	if (!m) return;
	const a = Number(m[1]), b = m[2] === undefined ? undefined : Number(m[2]);
	const pins = b === undefined ? a : a * b;
	if (pins < 1 || pins > 200 || b === 0) return;
	return b === undefined ? { pins } : { pins, layout: { rows: a, cols: b } };
}

export const formatPins = (c: Component) => c.layout ? `${c.layout.rows}x${c.layout.cols}` : String(c.pins);

export const pinKey =(e: End) => `${e.c}:${e.pin}`;

/**
 * Next id with the given prefix: C1, C2, ... Never hands out a number twice, even after a delete:
 * sub-harness blocks in other files refer to connectors by id.
 */
export function nextId(h: Harness, prefix: string, used: { id: string }[]): string {
	const nums = used.map(u => u.id.startsWith(prefix) ? Number(u.id.slice(prefix.length)) : 0);
	const n = Math.max(h.seq?.[prefix] ?? 0, ...nums.filter(n => !isNaN(n))) + 1;
	h.seq = { ...h.seq, [prefix]: n };
	return prefix + n;
}

/** Maps every pin key that has a wire to a net number. */
export function computeNets(h: Harness): Map<string, number> {
	const parent = new Map<string, string>();
	const find = (k: string): string => {
		if (!parent.has(k)) parent.set(k, k);
		let r = k;
		while (parent.get(r) !== r) r = parent.get(r)!;
		parent.set(k, r);
		return r;
	};
	for (const w of h.wires) parent.set(find(pinKey(w.from)), find(pinKey(w.to)));
	const ids = new Map<string, number>();
	const out = new Map<string, number>();
	for (const k of parent.keys()) {
		const r = find(k);
		if (!ids.has(r)) ids.set(r, ids.size + 1);
		out.set(k, ids.get(r)!);
	}
	return out;
}

/** Wires electrically connected to anything in the selection. */
export function netWires(h: Harness, sel: { wires?: string[]; component?: string }): Set<string> {
	const nets = computeNets(h);
	const hit = new Set<number>();
	for (const w of h.wires) {
		if (sel.wires?.includes(w.id)) hit.add(nets.get(pinKey(w.from))!);
		if (sel.component && (w.from.c === sel.component || w.to.c === sel.component)) hit.add(nets.get(pinKey(w.from))!);
	}
	return new Set(h.wires.filter(w => hit.has(nets.get(pinKey(w.from))!)).map(w => w.id));
}

/** Signal label of a pin: its own, else the first one found on its net. */
export function signalOf(h: Harness, e: End, nets = computeNets(h)): string | undefined {
	const own = h.components.find(c => c.id === e.c)?.signals?.[e.pin];
	if (own) return own;
	const net = nets.get(pinKey(e));
	if (net === undefined) return;
	for (const c of h.components) for (const [p, s] of Object.entries(c.signals ?? {}))
		if (s && nets.get(`${c.id}:${p}`) === net) return s;
}

export interface BomRow { part: Part; qty: number; unit: string; total: number; used: boolean; excluded?: boolean }

/** Bill of materials: pieces for components and their configuration accessories, metres for wires. Excluded parts are flagged, not dropped. */
export function bom(h: Harness): BomRow[] {
	const acc = new Map<string, number>();
	for (const c of h.components) for (const l of loadedParts(h, c)) acc.set(l.partId, (acc.get(l.partId) ?? 0) + 1);
	return h.parts.map(part => {
		const comps = h.components.filter(c => c.partId === part.id && c.kind !== "cable").length + (h.groups ?? []).filter(g => g.partId === part.id).length + (acc.get(part.id) ?? 0);
		const mm = h.wires.filter(w => w.partId === part.id).reduce((s, w) => s + wireLength(h, w), 0)
			+ h.components.filter(c => c.kind === "cable" && c.partId === part.id).reduce((s, c) => s + (c.length || 0), 0);
		const onWires = h.wires.some(w => w.partId === part.id) || h.components.some(c => c.kind === "cable" && c.partId === part.id);
		const t = part.type;
		const isWire = t ? t === "wire" || t === "cable" || (t === "covering" && !!part.cutToLength) : mm > 0 || (comps === 0 && onWires);
		const qty = isWire ? mm / 1000 : comps;
		return { part, qty, unit: isWire ? "m" : "pcs", total: qty * (part.price || 0), used: comps > 0 || onWires, excluded: !!part.excludeFromBom };
	});
}

export function removeComponent(h: Harness, id: string) {
	h.components = h.components.filter(c => c.id !== id);
	h.wires = h.wires.filter(w => w.from.c !== id && w.to.c !== id);
	if (h.groups) h.groups = h.groups.filter(g => (g.members = g.members.filter(m => m !== id)).length);
	if (h.bundles) h.bundles = h.bundles.filter(b => b.from !== id && b.to !== id);
}

export function removePart(h: Harness, id: string) {
	h.parts = h.parts.filter(p => p.id !== id);
	for (const x of [...h.components, ...h.wires, ...h.groups ?? []]) if (x.partId === id) delete x.partId;
	for (const p of h.parts) for (const cf of p.configurations ?? []) cf.items = cf.items.filter(i => i.partId !== id);
}

// --- Sub-harnesses ---

/** Pins a harness offers to a parent: every pin of its exposed connectors, as "C4:1". */
export function exposedPorts(sub: Harness): string[] {
	return sub.components.filter(c => c.kind === "connector" && c.exposed)
		.flatMap(c => Array.from({ length: c.pins }, (_, i) => `${c.id}:${i + 1}`));
}

/** Adds the sub-harness's new ports to the block. Existing ports keep their pin number. Returns true if changed. */
export function syncPorts(block: Component, sub: Harness): boolean {
	const ports = block.ports ?? [];
	const fresh = exposedPorts(sub).filter(p => !ports.includes(p));
	if (!fresh.length && block.pins === ports.length) return false;
	block.ports = [...ports, ...fresh];
	block.pins = block.ports.length;
	return true;
}

/** "C4 ECU : 1  +12V" for a port, or undefined if the sub-harness no longer has it. */
export function portLabel(sub: Harness, ref: string): string | undefined {
	const [id, pin] = ref.split(":");
	const c = sub.components.find(c => c.id === id && c.kind === "connector" && c.exposed);
	if (!c || Number(pin) > c.pins) return;
	const sig = signalOf(sub, { c: id, pin: Number(pin) });
	return `${c.id} ${c.name} : ${pin}${sig ? "  " + sig : ""}`;
}

/**
 * Parts used inside sub-harnesses (and theirs, recursively), merged by part number and manufacturer.
 * load returns a parsed sub-harness by path, or undefined if not available. seen holds the files above
 * this one in the chain: a file is skipped only when it would contain itself (a loop), so the same
 * sub-harness used twice is counted twice.
 */
export function subBom(h: Harness, load: (path: string) => Harness | undefined, seen = new Set<string>()): BomRow[] {
	const merged = new Map<string, BomRow>();
	const add = (r: BomRow) => {
		const key = `${r.part.number}|${r.part.manufacturer}|${r.unit}|${r.part.price}`;
		const m = merged.get(key);
		if (m) { m.qty += r.qty; m.total += r.total; } else merged.set(key, { ...r });
	};
	for (const c of h.components) {
		if (c.kind !== "harness" || !c.file || seen.has(c.file)) continue;
		const sub = load(c.file);
		if (!sub) continue;
		for (const r of [...bom(sub), ...subBom(sub, load, new Set([...seen, c.file]))]) if (r.qty && !r.excluded) add(r);
	}
	return [...merged.values()];
}

/** Text drawn on a wire: its name (or id unless hidden), then its gauge. */
export function wireLabel(h: Harness, w: Wire): string {
	const name = w.name || (h.hideWireIds ? "" : w.id);
	return [name, effectiveWire(h, w).gauge].filter(Boolean).join(" ");
}

/** Points sub-harness blocks at a renamed file. Returns true if anything changed. */
export function relinkSub(h: Harness, oldPath: string, newPath: string): boolean {
	let hit = false;
	for (const c of h.components) if (c.kind === "harness" && c.file === oldPath) { c.file = newPath; hit = true; }
	return hit;
}
