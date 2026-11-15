// Layout view logic: where things are, and how wires run through bundles.
import { nextId, type Bundle, type Component, type Harness, type Wire } from "./model.ts";
import { insertIndex, type P } from "./route.ts";

export interface Route { bundles: string[]; length: number } // bundle ids in order from -> to; length in mm

/** Components drawn on the Layout view. Splices are placed automatically, notes are schematic only. */
export const onLayout = (c: Component) => !["splice", "note"].includes(c.kind);

/** Layout position of a component or branch point. */
export function nodePos(h: Harness, id: string): P | undefined {
	const bp = h.branchPoints?.find(p => p.id === id);
	if (bp) return bp;
	const c = h.components.find(c => c.id === id);
	return c && (c.pos ?? { x: c.x, y: c.y });
}

const polyLength = (ps: P[]) => ps.slice(1).reduce((s, q, i) => s + Math.hypot(q.x - ps[i].x, q.y - ps[i].y), 0);

/** Shortest distance (by bundle length) from src to every node it reaches, and the bundle each was reached by. */
function dijkstra(bundles: Bundle[], src: string) {
	const dist = new Map([[src, 0]]), via = new Map<string, Bundle>(), done = new Set<string>();
	for (;;) {
		let u: string | undefined;
		for (const [n, d] of dist) if (!done.has(n) && (u === undefined || d < dist.get(u)!)) u = n;
		if (u === undefined) return { dist, via };
		done.add(u);
		for (const b of bundles) {
			const v = b.from === u ? b.to : b.to === u ? b.from : undefined;
			const d = dist.get(u)! + (b.length || 0);
			if (v !== undefined && d < (dist.get(v) ?? Infinity)) { dist.set(v, d); via.set(v, b); }
		}
	}
}

/**
 * Where each splice sits on the layout: the node with the least total bundle length to the other ends of its
 * wires. Branch points win ties. Splices with no reachable spot are left out.
 */
export function spliceSpots(h: Harness, from = memo(h)): Map<string, string> {
	const out = new Map<string, string>();
	const nodes = [...(h.branchPoints ?? []).map(p => p.id), ...h.components.filter(onLayout).map(c => c.id)];
	for (const s of h.components) {
		if (s.kind !== "splice") continue;
		// shortcut: wires to another splice are ignored here, upgrade if splice chains need exact placement
		const ends = h.wires.flatMap(w => w.from.c === s.id ? [w.to.c] : w.to.c === s.id ? [w.from.c] : [])
			.filter(c => h.components.find(x => x.id === c)?.kind !== "splice");
		const dists = ends.map(e => from(e).dist).filter(d => d.size > 1);
		let best = Infinity;
		for (const n of nodes) {
			const total = dists.reduce((t, d) => t + (d.get(n) ?? Infinity), 0);
			if (dists.length && total < best) { best = total; out.set(s.id, n); }
		}
	}
	return out;
}

const memo = (h: Harness) => {
	const cache = new Map<string, ReturnType<typeof dijkstra>>();
	return (src: string) => cache.get(src) ?? cache.set(src, dijkstra(h.bundles ?? [], src)).get(src)!;
};

/** Every wire whose ends are both joined by bundles, with its shortest path through them. */
export function routeWires(h: Harness): Map<string, Route> {
	const out = new Map<string, Route>();
	if (!h.bundles?.length) return out;
	const from = memo(h), spots = spliceSpots(h, from);
	const nodes = new Set(h.bundles.flatMap(b => [b.from, b.to]));
	for (const w of h.wires) {
		const a = spots.get(w.from.c) ?? w.from.c, z = spots.get(w.to.c) ?? w.to.c;
		if (!nodes.has(a) || !nodes.has(z)) continue;
		const { dist, via } = from(a);
		if (!dist.has(z)) continue;
		const path: string[] = [];
		for (let n = z; n !== a;) { const b = via.get(n)!; path.unshift(b.id); n = b.from === n ? b.to : b.from; }
		out.set(w.id, { bundles: path, length: dist.get(z)! });
	}
	return out;
}

// shortcut: without routes this routes the whole harness per call; pass routes when looping over many wires
/** Length to cut: the bundle path length when the wire is routed, else its typed length. */
export function wireLength(h: Harness, w: Wire, routes = routeWires(h)): number {
	return routes.get(w.id)?.length ?? (w.length || 0);
}

/** Splits a bundle with a new branch point at p. Length is shared in proportion to the drawn halves. */
export function splitBundle(h: Harness, id: string, p: P): string | undefined {
	const b = h.bundles?.find(b => b.id === id), a = b && nodePos(h, b.from), z = b && nodePos(h, b.to);
	if (!b || !a || !z) return;
	const via = b.points ?? [], i = insertIndex(a, z, via, p);
	const l1 = polyLength([a, ...via.slice(0, i), p]), l2 = polyLength([p, ...via.slice(i), z]);
	const first = Math.round(b.length * (l1 + l2 ? l1 / (l1 + l2) : 0.5));
	const bp = { id: nextId(h, "BP", h.branchPoints ??= []), x: p.x, y: p.y };
	h.branchPoints.push(bp);
	const rest: Bundle = { id: nextId(h, "B", h.bundles!), from: bp.id, to: b.to, length: b.length - first };
	if (i < via.length) rest.points = via.slice(i);
	b.to = bp.id;
	b.length = first;
	if (i) b.points = via.slice(0, i); else delete b.points;
	h.bundles!.splice(h.bundles!.indexOf(b) + 1, 0, rest);
	return bp.id;
}

/** Deletes a branch point. One joining exactly two bundles merges them; otherwise its bundles go too. */
export function removeBranchPoint(h: Harness, id: string) {
	const bp = h.branchPoints?.find(p => p.id === id);
	if (!bp) return;
	h.branchPoints = h.branchPoints!.filter(p => p !== bp);
	const at = (h.bundles ?? []).filter(b => b.from === id || b.to === id);
	const rev = (b: Bundle): Bundle => ({ ...b, from: b.to, to: b.from, points: b.points && [...b.points].reverse() });
	const [a, z] = at.length === 2 ? [at[0].to === id ? at[0] : rev(at[0]), at[1].from === id ? at[1] : rev(at[1])] : [];
	h.bundles = (h.bundles ?? []).flatMap(b => {
		if (b !== at[0] || !a || !z || a.from === z.to) return at.includes(b) ? [] : [b];
		const m: Bundle = { ...a, to: z.to, length: a.length + z.length, points: [...a.points ?? [], { x: bp.x, y: bp.y }, ...z.points ?? []] };
		if (!m.label && z.label) m.label = z.label;
		return [m];
	});
}
