// Orthogonal wire routing for the schematic. Pure geometry, no DOM.

export interface P { x: number; y: number }
export interface Anchor extends P { dx: number } // dx: which way the wire leaves the pin (+1 right, -1 left)

export const STUB = 20; // straight run out of a pin before the first bend

/**
 * Corner points of a right-angle wire from a to b.
 * Without bend points: out, across at a middle x (shifted by midOffset), in.
 * With bend points: through each one, horizontal first then vertical.
 */
export function orthoPoints(a: Anchor, b: Anchor, via: P[] = [], midOffset = 0): P[] {
	const s = { x: a.x + a.dx * STUB, y: a.y }, e = { x: b.x + b.dx * STUB, y: b.y };
	const out: P[] = [{ x: a.x, y: a.y }];
	if (!via.length) {
		const mx = (s.x + e.x) / 2 + midOffset;
		out.push({ x: mx, y: a.y }, { x: mx, y: b.y });
	} else {
		const stops = [s, ...via, e];
		out.push(s);
		for (let i = 1; i < stops.length; i++) {
			const p = stops[i - 1], q = stops[i];
			if (p.x !== q.x && p.y !== q.y) out.push({ x: q.x, y: p.y });
			out.push(q);
		}
	}
	out.push({ x: b.x, y: b.y });
	return simplify(out);
}

/** Drops repeated points and points in the middle of a straight run. */
export function simplify(pts: P[]): P[] {
	const out: P[] = [];
	for (const p of pts) {
		const last = out[out.length - 1];
		if (last && last.x === p.x && last.y === p.y) continue;
		const prev = out[out.length - 2];
		if (prev && last && ((prev.x === last.x && last.x === p.x) || (prev.y === last.y && last.y === p.y))) out.pop();
		out.push(p);
	}
	return out;
}

/** SVG path through the points with rounded corners. */
export function roundedPath(pts: P[], r = 6): string {
	let d = `M${pts[0].x},${pts[0].y}`;
	for (let i = 1; i < pts.length - 1; i++) {
		const p = pts[i - 1], c = pts[i], n = pts[i + 1];
		const l1 = Math.hypot(c.x - p.x, c.y - p.y), l2 = Math.hypot(n.x - c.x, n.y - c.y);
		const rr = Math.min(r, l1 / 2, l2 / 2);
		const a = { x: c.x - (c.x - p.x) / l1 * rr, y: c.y - (c.y - p.y) / l1 * rr };
		const b = { x: c.x + (n.x - c.x) / l2 * rr, y: c.y + (n.y - c.y) / l2 * rr };
		d += ` L${a.x},${a.y} Q${c.x},${c.y} ${b.x},${b.y}`;
	}
	const last = pts[pts.length - 1];
	return d + ` L${last.x},${last.y}`;
}

/** Middle of the longest segment: where the wire label goes. */
export function labelPoint(pts: P[]): P {
	let best = 0, at = { x: pts[0].x, y: pts[0].y };
	for (let i = 1; i < pts.length; i++) {
		const p = pts[i - 1], q = pts[i], l = Math.hypot(q.x - p.x, q.y - p.y);
		if (l > best) { best = l; at = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }; }
	}
	return at;
}

/** Where a new bend point p fits best in via: the slot that adds the least straight-line length. */
export function insertIndex(a: P, b: P, via: P[], p: P): number {
	const len = (ps: P[]) => ps.slice(1).reduce((s, q, i) => s + Math.hypot(q.x - ps[i].x, q.y - ps[i].y), 0);
	let best = 0, bestLen = Infinity;
	for (let i = 0; i <= via.length; i++) {
		const l = len([a, ...via.slice(0, i), p, ...via.slice(i), b]);
		if (l < bestLen) { bestLen = l; best = i; }
	}
	return best;
}

export interface Rect { x1: number; y1: number; x2: number; y2: number }

/**
 * Shortest right-angle path from s to e that stays out of the obstacles, with a cost per bend.
 * Searches a sparse grid made of the obstacle edges, the gaps between them, and s/e.
 * Leaves and arrives horizontally (pins stick out sideways). Undefined if there is no way through.
 */
export function routeAround(s: P, e: P, obstacles: Rect[], bendCost = 40): P[] | undefined {
	const axis = (vals: number[]) => {
		const lo = Math.min(...vals) - 40, hi = Math.max(...vals) + 40;
		const v = [...new Set([lo, hi, ...vals])].sort((a, b) => a - b);
		const mids = v.slice(1).map((x, i) => (x + v[i]) / 2); // run through the middle of gaps
		return [...new Set([...v, ...mids])].sort((a, b) => a - b);
	};
	const xs = axis([s.x, e.x, ...obstacles.flatMap(r => [r.x1, r.x2])]);
	const ys = axis([s.y, e.y, ...obstacles.flatMap(r => [r.y1, r.y2])]);
	const blocked = (x: number, y: number) => obstacles.some(r => x > r.x1 && x < r.x2 && y > r.y1 && y < r.y2);
	const nx = xs.length, ny = ys.length;
	const si = xs.indexOf(s.x) * ny + ys.indexOf(s.y), ei = xs.indexOf(e.x) * ny + ys.indexOf(e.y);
	if (blocked(s.x, s.y) || blocked(e.x, e.y)) return;

	// state = node * 2 + dir (0 horizontal, 1 vertical)
	const dist = new Float64Array(nx * ny * 2).fill(Infinity), prev = new Int32Array(nx * ny * 2).fill(-1);
	const heap: [number, number][] = [];
	const push = (d: number, st: number) => {
		heap.push([d, st]);
		for (let i = heap.length - 1; i > 0;) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
	};
	const pop = () => {
		const top = heap[0], last = heap.pop()!;
		if (heap.length) {
			heap[0] = last;
			for (let i = 0; ;) {
				const l = 2 * i + 1, r = l + 1; let m = i;
				if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
				if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
				if (m === i) break;
				[heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
			}
		}
		return top;
	};
	dist[si * 2] = 0; push(0, si * 2);
	dist[si * 2 + 1] = bendCost; push(bendCost, si * 2 + 1);
	let end = -1;
	while (heap.length) {
		const [d, st] = pop();
		if (d > dist[st]) continue;
		const node = st >> 1, dir = st & 1, i = Math.floor(node / ny), j = node % ny;
		if (node === ei) { if (dir === 0) { end = st; break; } const h = st - 1, nd = d + bendCost; if (nd < dist[h]) { dist[h] = nd; prev[h] = st; push(nd, h); } continue; }
		for (const [di, dj, nd] of [[1, 0, 0], [-1, 0, 0], [0, 1, 1], [0, -1, 1]]) {
			const a = i + di, b = j + dj;
			if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
			if (blocked((xs[i] + xs[a]) / 2, (ys[j] + ys[b]) / 2) || blocked(xs[a], ys[b])) continue;
			const ns = (a * ny + b) * 2 + nd;
			const cost = d + Math.abs(xs[a] - xs[i]) + Math.abs(ys[b] - ys[j]) + (nd !== dir ? bendCost : 0);
			if (cost < dist[ns]) { dist[ns] = cost; prev[ns] = st; push(cost, ns); }
		}
	}
	if (end < 0) return;
	const pts: P[] = [];
	for (let st = end; st >= 0; st = prev[st]) { const n = st >> 1; pts.push({ x: xs[Math.floor(n / ny)], y: ys[n % ny] }); }
	return simplify(pts.reverse());
}

/**
 * Spreads wires that share a run: interior segments on the same line that overlap get
 * shifted gap apart. First and last segments stay put (they are tied to the pins). Mutates paths.
 */
export function separate(paths: P[][], gap = 6) {
	for (const vertical of [true, false]) {
		const segs: { path: P[]; k: number; at: number; lo: number; hi: number }[] = [];
		for (const path of paths) for (let k = 1; k + 2 < path.length; k++) {
			const p = path[k], q = path[k + 1];
			if (vertical ? p.x !== q.x : p.y !== q.y) continue;
			const [a, b] = vertical ? [p.y, q.y] : [p.x, q.x];
			segs.push({ path, k, at: vertical ? p.x : p.y, lo: Math.min(a, b), hi: Math.max(a, b) });
		}
		segs.sort((a, b) => a.at - b.at || a.lo - b.lo);
		for (let i = 0; i < segs.length;) {
			const cluster = [segs[i]];
			let hi = segs[i].hi, j = i + 1;
			for (; j < segs.length && segs[j].at === segs[i].at && segs[j].lo < hi; j++) { cluster.push(segs[j]); hi = Math.max(hi, segs[j].hi); }
			cluster.forEach((s, n) => {
				const off = (n - (cluster.length - 1) / 2) * gap;
				for (const p of [s.path[s.k], s.path[s.k + 1]]) vertical ? p.x = s.at + off : p.y = s.at + off;
			});
			i = j;
		}
	}
}
