// Pure helpers for schematic editing: labels, cavities, duplicate, move connections, destinations, search.
import { computeNets, nextId, parseHarness, pinKey, type Component, type End, type Harness, type Kind, type Part, type Wire } from "./model.ts";

export const PREFIX: Record<Kind, string> = { connector: "C", splice: "S", harness: "H", cable: "CB", terminal: "T", diode: "D", resistor: "R", note: "N" };
export const TERMINAL_TYPES = ["ferrule", "ring", "spade", "male QC", "female QC", "loose end"];

/** The user's label, or "" when the component only has its id. */
export const labelOf = (c: Component) => c.name && c.name !== c.id ? c.name : "";

/** How a component is named outside the canvas: its label, or its id. A shared label gets the id: "Sensor:C2". */
export function compLabel(h: Harness, c: Component): string {
	const l = labelOf(c);
	if (!l) return c.id;
	return h.components.some(o => o !== c && o.name === l) ? `${l}:${c.id}` : l;
}

/** Cavity designation of a pin: its own, else the pin number. */
export const cavName = (c: Component, pin: number) => c.cavities?.[pin - 1] || String(pin);

const letters = (i: number): string => (i >= 26 ? letters(Math.floor(i / 26) - 1) : "") + String.fromCharCode(65 + (i % 26));

/** Designations from a template: "letters" A, B, C…; "grid" A1, A2…, B1 (row letter, column number). Undefined = numbers. */
export function designations(tpl: string, pins: number, cols?: number): string[] | undefined {
	if (tpl === "letters") return Array.from({ length: pins }, (_, i) => letters(i));
	if (tpl === "grid") { const n = cols || pins; return Array.from({ length: pins }, (_, i) => letters(Math.floor(i / n)) + (i % n + 1)); }
}

/** Typed "A1, A2, , B1" -> one designation per pin, or undefined when every one is the plain pin number. */
export function parseCavities(text: string, pins: number): string[] | undefined {
	const list = text.split(",").map(s => s.trim()).slice(0, pins);
	while (list.length < pins) list.push("");
	return list.every((s, i) => !s || s === String(i + 1)) ? undefined : list;
}

/** Each line of a pasted column goes into the next cavity. N/C cavities are skipped, blank lines leave a signal as it is. */
export function pasteSignals(c: Component, pin: number, text: string) {
	const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
	let p = pin;
	for (const line of lines) {
		while (c.nc?.includes(p)) p++;
		if (p > c.pins) break;
		if (line.trim()) c.signals = { ...c.signals, [p]: line.trim() };
		p++;
	}
}

/** Every distinct signal on a pin's net (its own first). More than one is a conflict. */
export function netSignals(h: Harness, e: End, nets = computeNets(h)): string[] {
	const own = h.components.find(c => c.id === e.c)?.signals?.[e.pin];
	const out = own ? [own] : [];
	const net = nets.get(pinKey(e));
	if (net !== undefined) for (const c of h.components) for (const [p, s] of Object.entries(c.signals ?? {}))
		if (s && !out.includes(s) && nets.get(`${c.id}:${p}`) === net) out.push(s);
	return out;
}

/** Moves every wire end on one pin to another. A wire that would end up on the target at both ends stays. Returns how many moved. */
export function moveConnections(h: Harness, from: End, to: End): number {
	let n = 0;
	for (const w of h.wires) for (const [k, o] of [["from", "to"], ["to", "from"]] as const) {
		if (pinKey(w[k]) === pinKey(from) && pinKey(w[o]) !== pinKey(to)) { w[k] = { ...to }; n++; }
	}
	return n;
}

/** Copies components (and the wires between them) 2 grid steps down-right. Returns the new ids. */
export function duplicate(h: Harness, ids: string[]): string[] {
	const map = new Map<string, string>();
	for (const id of ids) {
		const c = h.components.find(c => c.id === id);
		if (!c) continue;
		const copy = { ...structuredClone(c), id: nextId(h, PREFIX[c.kind], h.components), x: c.x + 40, y: c.y + 40 };
		if (!labelOf(c)) copy.name = copy.id; // an unlabelled copy stays unlabelled, not "labelled" with the old id
		h.components.push(copy);
		map.set(id, copy.id);
	}
	for (const w of [...h.wires]) {
		const a = map.get(w.from.c), b = map.get(w.to.c);
		if (!a || !b) continue;
		const copy = { ...structuredClone(w), id: nextId(h, "W", h.wires), from: { c: a, pin: w.from.pin }, to: { c: b, pin: w.to.pin } };
		if (copy.points) copy.points = copy.points.map(p => ({ x: p.x + 40, y: p.y + 40 }));
		h.wires.push(copy);
	}
	return [...map.values()];
}

/** Components on the clipboard, with the wires and mates between them and every part they use. */
export interface Clip { dcWiring: 1; components: Component[]; wires: Wire[]; mates: { a: string; b: string }[]; parts: Part[] }

export function copyClip(h: Harness, ids: string[]): Clip {
	const inside = (id: string) => ids.includes(id);
	const components = h.components.filter(c => inside(c.id));
	const wires = h.wires.filter(w => inside(w.from.c) && inside(w.to.c));
	const need = new Set([...components.flatMap(c => [c.partId, ...Object.values(c.contacts ?? {})]), ...wires.map(w => w.partId)].filter((x): x is string => !!x));
	for (const id of need) for (const cf of h.parts.find(p => p.id === id)?.configurations ?? []) for (const it of cf.items) need.add(it.partId); // accessories come along
	return structuredClone({ dcWiring: 1, components, wires, mates: (h.mates ?? []).filter(m => inside(m.a) && inside(m.b)), parts: h.parts.filter(p => need.has(p.id)) });
}

/** The clipboard text as a Clip, or undefined when it is something else. */
export function readClip(text: string): Clip | undefined {
	try {
		const c = JSON.parse(text) as Clip;
		return c?.dcWiring === 1 && [c.components, c.wires, c.parts].every(Array.isArray) ? { ...c, mates: Array.isArray(c.mates) ? c.mates : [] } : undefined;
	} catch { return undefined; }
}

/**
 * Adds a clip with new ids, its top-left corner at `at`. A part whose number is already in h is shared; others get new ids.
 * Throws, leaving h untouched, when the clip would make a broken harness. Returns the new component ids.
 */
export function pasteClip(h: Harness, clip: Clip, at: { x: number; y: number }): string[] {
	const t = structuredClone(h);
	const pid = new Map<string, string>();
	for (const p of clip.parts) pid.set(p.id, (p.number && t.parts.find(x => x.number === p.number)?.id) || "");
	const added: Part[] = [];
	for (const p of clip.parts) if (!pid.get(p.id)) { const id = nextId(t, "P", t.parts); pid.set(p.id, id); const np = { ...structuredClone(p), id }; added.push(np); t.parts.push(np); }
	const remap = (id?: string) => id && (pid.get(id) ?? id);
	for (const p of added) for (const cf of p.configurations ?? []) for (const it of cf.items) it.partId = remap(it.partId)!; // h's own parts keep their ids
	const dx = at.x - Math.min(...clip.components.map(c => c.x)), dy = at.y - Math.min(...clip.components.map(c => c.y));
	const cid = new Map<string, string>();
	for (const c of clip.components) {
		const id = nextId(t, PREFIX[c.kind] ?? "C", t.components);
		cid.set(c.id, id);
		const copy: Component = { ...structuredClone(c), id, x: c.x + dx, y: c.y + dy, partId: remap(c.partId) };
		if (!labelOf(c)) copy.name = id;
		if (c.contacts) copy.contacts = Object.fromEntries(Object.entries(c.contacts).map(([pin, p]) => [pin, p && remap(p)!]));
		delete copy.pos; // shortcut: lands at its schematic spot on the Layout; keep a shifted pos if people paste laid-out groups
		if (!copy.partId) delete copy.partId;
		t.components.push(copy);
	}
	const twists = new Map<string, string>();
	for (const w of clip.wires) {
		const a = cid.get(w.from?.c), b = cid.get(w.to?.c);
		if (!a || !b) continue;
		const copy: Wire = { ...structuredClone(w), id: nextId(t, "W", t.wires), from: { c: a, pin: w.from.pin }, to: { c: b, pin: w.to.pin }, partId: remap(w.partId) };
		if (!copy.partId) delete copy.partId;
		if (copy.points) copy.points = copy.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
		if (w.twist) copy.twist = twists.get(w.twist) ?? twists.set(w.twist, nextId(t, "TW", t.wires.flatMap(x => x.twist ? [{ id: x.twist }] : []))).get(w.twist);
		t.wires.push(copy);
	}
	const mates = clip.mates.flatMap(m => cid.has(m.a) && cid.has(m.b) ? [{ a: cid.get(m.a)!, b: cid.get(m.b)! }] : []);
	if (mates.length) t.mates = [...t.mates ?? [], ...mates];
	parseHarness(JSON.stringify(t)); // throws on a malformed clip
	Object.assign(h, t);
	return [...cid.values()];
}

/** "C2:3", "ECU:A1", "S1" or "ECU" (single pin) -> the pin it names, or an error message. */
export function resolveTarget(h: Harness, text: string): End | string {
	const t = text.trim(), i = t.lastIndexOf(":");
	const name = (i < 0 ? t : t.slice(0, i)).toLowerCase(), cav = i < 0 ? undefined : t.slice(i + 1).trim().toLowerCase();
	const pinned = h.components.filter(c => c.pins > 0);
	const c = pinned.find(c => c.id.toLowerCase() === name) ?? pinned.find(c => c.name.toLowerCase() === name);
	if (!c) return `No component "${t}"`;
	let pin: number | undefined;
	if (cav === undefined || cav === "") { if (c.pins === 1) pin = 1; }
	else {
		for (let p = 1; p <= c.pins && !pin; p++) if (cavName(c, p).toLowerCase() === cav) pin = p;
		if (!pin && /^\d+$/.test(cav) && Number(cav) <= c.pins) pin = Number(cav);
	}
	if (!pin) return `Which cavity of ${c.id}? Type e.g. ${c.id}:1`;
	if (c.nc?.includes(pin)) return `${c.id}:${cavName(c, pin)} is not connected (N/C)`;
	return { c: c.id, pin };
}

/** Search: id, label, signals, cavity names, terminal type, note text and part number. */
export function matches(h: Harness, c: Component, q: string): boolean {
	const part = h.parts.find(p => p.id === c.partId);
	const hay = [c.id, c.name, c.terminal, c.text, part?.number, ...Object.values(c.signals ?? {}), ...(c.cavities ?? [])];
	return hay.some(s => s?.toLowerCase().includes(q.toLowerCase()));
}

/** Why a mate is invalid, or undefined. */
export function mateError(h: Harness, m: { a: string; b: string }): string | undefined {
	const a = h.components.find(c => c.id === m.a), b = h.components.find(c => c.id === m.b);
	if (!a || !b) return "missing connector";
	if (a.pins !== b.pins) return "cavities do not match";
}

/** Component ids in a selection, whether it holds one or many. */
export const selComps = (sel: { component?: string; components?: string[] } | null) => sel?.components ?? (sel?.component ? [sel.component] : []);
