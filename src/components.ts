// Pure helpers for schematic editing: labels, cavities, duplicate, move connections, destinations, search.
import { computeNets, nextId, pinKey, type Component, type End, type Harness, type Kind } from "./model.ts";

export const PREFIX: Record<Kind, string> = { connector: "C", splice: "S", harness: "H", terminal: "T", diode: "D", resistor: "R", note: "N" };
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
