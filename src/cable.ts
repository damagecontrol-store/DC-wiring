// Cables (cores + shield) and twisted wires. Pure, no DOM.
import { nextId, type Component, type Core, type End, type Harness } from "./model.ts";

/** "rd 0.5, bk/wh 0.35" -> one core per comma item: colour, then optional gauge. */
export function parseCores(s: string): Core[] {
	return s.split(",").map(x => x.trim()).filter(Boolean).map(x => {
		const [color, gauge = ""] = x.split(/\s+/);
		return { color, gauge };
	});
}

export const formatCores = (cores: Core[] = []) => cores.map(k => [k.color, k.gauge].filter(Boolean).join(" ")).join(", ");

/** "CB1.2", or "CB1.S" for the shield. */
export const coreName = (c: Component, pin: number) => `${c.id}.${pin === 0 ? "S" : pin}`;

/** The cable core a wire end lands on, if any. */
export function coreOf(h: Harness, e: End): Core | undefined {
	const c = h.components.find(c => c.id === e.c);
	return c?.kind === "cable" ? c.cores?.[e.pin - 1] : undefined;
}

/** Sets a cable's cores and shield, dropping wires on cores that no longer exist. */
export function setCores(h: Harness, c: Component, cores: Core[], shield: boolean) {
	const gone = (e: End) => e.c === c.id && (e.pin === 0 ? !shield : e.pin > cores.length);
	h.wires = h.wires.filter(w => !gone(w.from) && !gone(w.to));
	c.cores = cores;
	c.pins = cores.length;
	if (shield) c.shield = true; else delete c.shield;
}

/** Twists the wires together, merging any twist groups they were already in. */
export function twist(h: Harness, ids: string[]) {
	const ws = h.wires.filter(w => ids.includes(w.id));
	if (ws.length < 2) return;
	const old = new Set(ws.flatMap(w => w.twist ?? []));
	const id = [...old][0] ?? nextId(h, "T", h.wires.flatMap(w => w.twist ? [{ id: w.twist }] : []));
	for (const w of h.wires) if (ids.includes(w.id) || (w.twist && old.has(w.twist))) w.twist = id;
}

/** Takes a wire out of its twist group; a group left with one wire is dissolved. */
export function untwist(h: Harness, id: string) {
	const w = h.wires.find(w => w.id === id);
	if (!w?.twist) return;
	const rest = h.wires.filter(x => x.twist === w.twist && x !== w);
	delete w.twist;
	if (rest.length < 2) for (const x of rest) delete x.twist;
}

/** Other wires twisted with this one. */
export function twistedWith(h: Harness, id: string): string[] {
	const t = h.wires.find(w => w.id === id)?.twist;
	return t ? h.wires.filter(w => w.twist === t && w.id !== id).map(w => w.id) : [];
}
