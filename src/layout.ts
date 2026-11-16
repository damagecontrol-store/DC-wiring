import { Menu } from "obsidian";
import { labelOf, selComps } from "./components.ts";
import { nodePos, onLayout, removeBranchPoint, routeWires, spliceSpots, splitBundle } from "./bundles.ts";
import { formatLength } from "./length.ts";
import { nextId, type BranchPoint, type Bundle, type Component, type Harness } from "./model.ts";
import { insertIndex, labelPoint, type P } from "./route.ts";
import { partItem, type Selection } from "./schematic.ts";

const NS = "http://www.w3.org/2000/svg";
const BW = 120, BH = 28, GRID = 20; // component box on the layout, centred on its position

export type LayoutSel = { bundle?: string; bp?: string } | null;

/** What the layout canvas needs from its host view. */
export interface LayoutHost {
	h: Harness;
	sel: Selection;
	lsel: LayoutSel;
	select(sel: Selection): void;
	selectLayout(s: LayoutSel): void;
	changed(): void;
	editComponent(c: Component): void;
	pickPart(c: Component): void;
	editBundle(b: Bundle): void;
	addCovering(x: Bundle | BranchPoint): void;
	openSub(c: Component): void;
}

type Drag =
	| { mode: "move"; at: P; c?: Component; dx: number; dy: number; moved: boolean }
	| { mode: "pan"; sx: number; sy: number; px: number; py: number }
	| { mode: "bundle"; from: string; line: SVGLineElement }
	| { mode: "bend"; b: Bundle; i: number; moved: boolean };

/** A box in the background colour behind a label, so a bundle line running under it doesn't show through. */
function backed(t: SVGTextElement) {
	const b = t.getBBox(); // zero when the view is hidden: then no box, which is harmless
	if (!b.width) return;
	const r = document.createElementNS(NS, "rect");
	for (const [k, v] of Object.entries({ x: b.x - 3, y: b.y - 1, width: b.width + 6, height: b.height + 2, rx: 3, class: "dcw-label-bg" })) r.setAttribute(k, String(v));
	t.before(r);
}

function el<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attrs: Record<string, string | number>, text?: string) {
	const e = document.createElementNS(NS, tag);
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
	if (text !== undefined) e.textContent = text;
	parent.appendChild(e);
	return e;
}

const snap = (v: number) => Math.round(v / GRID) * GRID;
let canvases = 0;

/** Physical harness: components, branch points and the bundles between them. */
export class Layout {
	svg: SVGSVGElement;
	private gridId = `dcw-lgrid-${++canvases}`;
	private g: SVGGElement;
	private view = { x: 40, y: 40, z: 1 };
	private drag: Drag | null = null;

	constructor(private host: LayoutHost) {
		this.svg = document.createElementNS(NS, "svg");
		this.svg.addClass("dcw-canvas");
		const pat = el(el(this.svg, "defs", {}), "pattern", { id: this.gridId, width: GRID, height: GRID, patternUnits: "userSpaceOnUse" });
		el(pat, "circle", { cx: 1, cy: 1, r: 1, class: "dcw-dot" });
		this.g = el(this.svg, "g", {});
		this.svg.addEventListener("pointerdown", e => this.down(e));
		this.svg.addEventListener("pointermove", e => this.move(e));
		this.svg.addEventListener("pointerup", e => this.up(e));
		this.svg.addEventListener("wheel", e => this.wheel(e), { passive: false });
		this.svg.addEventListener("contextmenu", e => this.menu(e));
		this.svg.addEventListener("dblclick", e => this.dbl(e));
	}

	private world(e: MouseEvent) {
		const r = this.svg.getBoundingClientRect();
		return { x: (e.clientX - r.left - this.view.x) / this.view.z, y: (e.clientY - r.top - this.view.y) / this.view.z };
	}

	private applyView() {
		this.g.setAttribute("transform", `translate(${this.view.x},${this.view.y}) scale(${this.view.z})`);
	}

	private comps() { return this.host.h.components.filter(onLayout); }

	/** Zooms to show everything. False if the canvas has no size yet or nothing to show. */
	fit(): boolean {
		const h = this.host.h, r = this.svg.getBoundingClientRect();
		const ps = [...this.comps().map(c => nodePos(h, c.id)!), ...h.branchPoints ?? []];
		if (!ps.length || !r.width) return false;
		const minX = Math.min(...ps.map(p => p.x)) - BW, minY = Math.min(...ps.map(p => p.y)) - 60;
		const maxX = Math.max(...ps.map(p => p.x)) + BW, maxY = Math.max(...ps.map(p => p.y)) + 60;
		const z = Math.min(2, r.width / (maxX - minX), r.height / (maxY - minY));
		this.view = { z, x: (r.width - (maxX - minX) * z) / 2 - minX * z, y: (r.height - (maxY - minY) * z) / 2 - minY * z };
		this.applyView();
		return true;
	}

	/** Middle of the visible canvas, snapped to the grid. */
	center(): P {
		const r = this.svg.getBoundingClientRect();
		return { x: snap((r.width / 2 - this.view.x) / this.view.z), y: snap((r.height / 2 - this.view.y) / this.view.z) };
	}

	render() {
		const { h, sel, lsel } = this.host;
		this.g.replaceChildren();
		this.applyView();
		el(this.g, "rect", { x: -1e5, y: -1e5, width: 2e5, height: 2e5, fill: `url(#${this.gridId})` });

		const routes = routeWires(h);
		const count = new Map<string, number>();
		for (const r of routes.values()) for (const b of r.bundles) count.set(b, (count.get(b) ?? 0) + 1);
		// the bundle paths of the selected wires, or of the wires on the selected component
		const picked = h.wires.filter(w => sel?.wires?.includes(w.id) || (sel?.component && (w.from.c === sel.component || w.to.c === sel.component)));
		const lit = new Set(picked.flatMap(w => routes.get(w.id)?.bundles ?? []));

		const labels: (() => void)[] = []; // drawn after every bundle line, so a later bundle never crosses a label
		for (const b of h.bundles ?? []) {
			const pts = this.points(b);
			if (!pts) continue;
			const n = count.get(b.id) ?? 0;
			const g = el(this.g, "g", { class: "dcw-bundle", "data-bundle": b.id });
			if (!n) g.addClass("is-empty");
			if (lit.has(b.id)) g.addClass("is-lit");
			if (lsel?.bundle === b.id) g.addClass("is-selected");
			const d = "M" + pts.map(p => `${p.x},${p.y}`).join(" L");
			if (b.coverings?.length) el(g, "path", { d, class: "dcw-sleeve" });
			el(g, "path", { d, class: "dcw-bline" });
			el(g, "path", { d, class: "dcw-hit" });
			const lp = labelPoint(pts);
			labels.push(() => {
				const lg = el(this.g, "g", { "data-bundle": b.id }); // still opens the bundle's menu and editor
				backed(el(lg, "text", { x: lp.x, y: lp.y - 8, class: "dcw-blen", "data-blen": b.id },
					`${b.label ? b.label + " · " : ""}${formatLength(b.length)} · ${n} wire${n === 1 ? "" : "s"}`));
				if (b.coverings?.length) backed(el(lg, "text", { x: lp.x, y: lp.y + 18, class: "dcw-blen" }, this.coverText(b)));
			});
		}
		for (const draw of labels) draw();

		for (const c of this.comps()) {
			const p = nodePos(h, c.id)!;
			const g = el(this.g, "g", { class: "dcw-comp", "data-comp": c.id });
			if (c.kind === "harness") g.addClass("is-sub");
			if (sel?.component === c.id) g.addClass("is-selected");
			el(g, "rect", { x: p.x - BW / 2, y: p.y - BH / 2, width: BW, height: BH, rx: 4, class: "dcw-body" });
			el(g, "text", { x: p.x, y: p.y + 4, class: "dcw-label is-center" }, c.kind === "harness" ? `⧉ ${c.name}` : labelOf(c) ? `${c.id}  ${labelOf(c)}` : c.id);
			el(g, "circle", { cx: p.x + BW / 2, cy: p.y, r: 5, class: "dcw-pin", "data-node": c.id });
		}

		for (const bp of h.branchPoints ?? []) {
			const g = el(this.g, "g", { class: "dcw-comp", "data-bp": bp.id });
			if (lsel?.bp === bp.id) g.addClass("is-selected");
			el(g, "circle", { cx: bp.x, cy: bp.y, r: 10, class: "dcw-splice" }); // ring = drag handle
			el(g, "circle", { cx: bp.x, cy: bp.y, r: 4, class: "dcw-pin", "data-node": bp.id });
			el(g, "text", { x: bp.x, y: bp.y - 14, class: "dcw-hint is-center" }, bp.id);
			if (bp.coverings?.length) el(g, "text", { x: bp.x, y: bp.y + 24, class: "dcw-hint is-center" }, this.coverText(bp));
		}

		// splices are placed automatically: a marker beside the node they sit at
		const stacked = new Map<string, number>();
		for (const [s, node] of spliceSpots(h)) {
			const p = nodePos(h, node)!, k = stacked.get(node) ?? 0;
			stacked.set(node, k + 1);
			const x = p.x + 16, y = p.y + 16 + k * 16;
			const g = el(this.g, "g", { class: "dcw-smark" });
			if (picked.some(w => w.from.c === s || w.to.c === s) || sel?.component === s) g.addClass("is-lit");
			el(g, "rect", { x: x - 4, y: y - 4, width: 8, height: 8, transform: `rotate(45 ${x} ${y})` });
			el(g, "text", { x: x + 8, y: y + 4 }, (c => c && labelOf(c))(h.components.find(c => c.id === s)) || s);
		}

		// bend point handles of the selected bundle
		const sb = h.bundles?.find(b => b.id === lsel?.bundle);
		(sb?.points ?? []).forEach((p, i) => el(this.g, "rect", { x: p.x - 4, y: p.y - 4, width: 8, height: 8, class: "dcw-wp", "data-lp": `${sb!.id}:${i}` }));
		if (this.drag?.mode === "bundle") this.g.appendChild(this.drag.line);
	}

	private points(b: Bundle): P[] | undefined {
		const a = nodePos(this.host.h, b.from), z = nodePos(this.host.h, b.to);
		return a && z && [a, ...b.points ?? [], z];
	}

	private bendPoint(t: Element | null) {
		const [id, i] = t?.closest("[data-lp]")?.getAttribute("data-lp")?.split(":") ?? [];
		const b = this.host.h.bundles?.find(b => b.id === id);
		return b?.points?.[Number(i)] ? { b, i: Number(i) } : undefined;
	}

	private bundleAt(t: Element) {
		const id = t.closest("[data-bundle]")?.getAttribute("data-bundle");
		return this.host.h.bundles?.find(b => b.id === id);
	}

	private down(e: PointerEvent) {
		if (e.button !== 0) return;
		const t = e.target as Element, h = this.host.h, p = this.world(e);
		this.svg.setPointerCapture(e.pointerId);
		const bend = this.bendPoint(t), node = t.closest("[data-node]");
		const c = h.components.find(c => c.id === t.closest("[data-comp]")?.getAttribute("data-comp"));
		const bp = h.branchPoints?.find(b => b.id === t.closest("[data-bp]")?.getAttribute("data-bp"));
		const bundle = this.bundleAt(t);
		if (bend) this.drag = { mode: "bend", ...bend, moved: false };
		else if (node) {
			const line = el(this.g, "line", { x1: node.getAttribute("cx")!, y1: node.getAttribute("cy")!, x2: p.x, y2: p.y, class: "dcw-temp" });
			this.drag = { mode: "bundle", from: node.getAttribute("data-node")!, line };
		} else if (c) {
			const at = nodePos(h, c.id)!;
			this.drag = { mode: "move", at: { ...at }, c, dx: p.x - at.x, dy: p.y - at.y, moved: false };
			this.host.select({ component: c.id });
		} else if (bp) {
			this.drag = { mode: "move", at: bp, dx: p.x - bp.x, dy: p.y - bp.y, moved: false };
			this.host.selectLayout({ bp: bp.id });
		} else if (bundle) this.host.selectLayout({ bundle: bundle.id });
		else {
			this.drag = { mode: "pan", sx: e.clientX, sy: e.clientY, px: this.view.x, py: this.view.y };
			if (this.host.sel || this.host.lsel) this.host.select(null);
		}
	}

	private move(e: PointerEvent) {
		const d = this.drag;
		if (!d) return;
		if (d.mode === "pan") {
			this.view.x = d.px + e.clientX - d.sx;
			this.view.y = d.py + e.clientY - d.sy;
			this.applyView();
		} else if (d.mode === "bundle") {
			const p = this.world(e);
			d.line.setAttribute("x2", String(p.x));
			d.line.setAttribute("y2", String(p.y));
		} else {
			const p = this.world(e), at = d.mode === "move" ? d.at : d.b.points![d.i];
			const x = snap(p.x - (d.mode === "move" ? d.dx : 0)), y = snap(p.y - (d.mode === "move" ? d.dy : 0));
			if (x === at.x && y === at.y) return;
			at.x = x; at.y = y; d.moved = true;
			if (d.mode === "move" && d.c) d.c.pos = at; // the first move gives it its own layout position
			this.render();
		}
	}

	private up(e: PointerEvent) {
		const d = this.drag;
		this.drag = null;
		if (!d) return;
		if (d.mode === "move" || d.mode === "bend") return void (d.moved && this.host.changed());
		if (d.mode !== "bundle") return;
		d.line.remove();
		const t = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-node], [data-comp], [data-bp]");
		const to = t?.getAttribute("data-node") ?? t?.getAttribute("data-comp") ?? t?.getAttribute("data-bp");
		const h = this.host.h;
		if (!to || to === d.from || h.bundles?.some(b => (b.from === d.from && b.to === to) || (b.from === to && b.to === d.from))) return;
		const a = nodePos(h, d.from)!, z = nodePos(h, to)!;
		const id = nextId(h, "B", h.bundles ??= []);
		// a starting length the user overwrites: the drawn distance, 1 canvas unit = 1 mm
		h.bundles.push({ id, from: d.from, to, length: Math.round(Math.hypot(z.x - a.x, z.y - a.y) / 10) * 10 });
		this.host.lsel = { bundle: id };
		this.host.changed();
	}

	private wheel(e: WheelEvent) {
		e.preventDefault();
		if (e.ctrlKey || e.metaKey) {
			const r = this.svg.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
			const z = Math.min(4, Math.max(0.1, this.view.z * Math.exp(-e.deltaY * 0.01)));
			this.view.x = mx - (mx - this.view.x) * z / this.view.z;
			this.view.y = my - (my - this.view.y) * z / this.view.z;
			this.view.z = z;
		} else {
			this.view.x -= e.deltaX;
			this.view.y -= e.deltaY;
		}
		this.applyView();
	}

	private dbl(e: MouseEvent) {
		// a click re-renders the canvas, so ask what is under the pointer now
		const t = document.elementFromPoint(e.clientX, e.clientY) ?? (e.target as Element), h = this.host.h;
		const bend = this.bendPoint(t);
		if (bend) {
			bend.b.points!.splice(bend.i, 1);
			if (!bend.b.points!.length) delete bend.b.points;
			return this.host.changed();
		}
		const b = this.bundleAt(t);
		if (b && t.closest("[data-blen]")) return this.host.editBundle(b);
		if (b) {
			const raw = this.world(e), p = { x: snap(raw.x), y: snap(raw.y) }, pts = this.points(b)!;
			const via = b.points ?? [];
			via.splice(insertIndex(pts[0], pts[pts.length - 1], via, p), 0, p);
			b.points = via;
			this.host.lsel = { bundle: b.id };
			return this.host.changed();
		}
		const c = h.components.find(c => c.id === t.closest("[data-comp]")?.getAttribute("data-comp"));
		if (c) c.kind === "harness" ? this.host.openSub(c) : this.host.editComponent(c);
	}

	private coverText(x: Bundle | BranchPoint) {
		return x.coverings!.map(id => { const p = this.host.h.parts.find(p => p.id === id); return p?.number || p?.coveringType || id; }).join(" + ");
	}

	/** "Add covering…" plus one "Remove" per covering on a bundle or branch point. */
	private coverItems(m: Menu, x: Bundle | BranchPoint) {
		m.addItem(i => i.setTitle("from" in x ? "Add covering…" : "Add covering or boot…").setIcon("package").onClick(() => this.host.addCovering(x)));
		for (const id of x.coverings ?? []) m.addItem(i => i.setTitle(`Remove ${this.host.h.parts.find(p => p.id === id)?.number || id}`).setIcon("x").onClick(() => {
			x.coverings = x.coverings!.filter(c => c !== id);
			if (!x.coverings.length) delete x.coverings;
			this.host.changed();
		}));
	}

	private menu(e: MouseEvent) {
		e.preventDefault();
		const t = e.target as Element, h = this.host.h, m = new Menu(), p = this.world(e);
		const b = this.bundleAt(t);
		const bp = t.closest("[data-bp]")?.getAttribute("data-bp");
		const c = h.components.find(c => c.id === t.closest("[data-comp]")?.getAttribute("data-comp"));
		if (b) {
			m.addItem(i => i.setTitle("Edit bundle").setIcon("pencil").onClick(() => this.host.editBundle(b)));
			this.coverItems(m, b);
			m.addItem(i => i.setTitle("Add branch point").setIcon("git-fork").onClick(() => {
				const id = splitBundle(h, b.id, { x: snap(p.x), y: snap(p.y) });
				this.host.lsel = id ? { bp: id } : null;
				this.host.changed();
			}));
			if (b.points?.length) m.addItem(i => i.setTitle("Clear bend points").setIcon("eraser").onClick(() => { delete b.points; this.host.changed(); }));
			m.addItem(i => i.setTitle("Delete bundle").setIcon("trash").onClick(() => this.remove({ bundle: b.id })));
		} else if (bp) {
			this.coverItems(m, h.branchPoints!.find(x => x.id === bp)!);
			m.addItem(i => i.setTitle("Delete branch point").setIcon("trash").onClick(() => this.remove({ bp })));
		} else if (c) {
			m.addItem(i => i.setTitle("Edit").setIcon("pencil").onClick(() => this.host.editComponent(c)));
			const many = selComps(this.host.sel);
			if (c.kind !== "note") partItem(m, h, c, many.includes(c.id) ? h.components.filter(x => many.includes(x.id) && x.kind === c.kind).length : 1, () => this.host.pickPart(c), () => this.host.changed());
		} else {
			m.addItem(i => i.setTitle("Add branch point").setIcon("git-fork").onClick(() => this.addBranchPoint(p)));
			m.addItem(i => i.setTitle("Fit to view").setIcon("maximize").onClick(() => this.fit()));
		}
		m.showAtMouseEvent(e);
	}

	addBranchPoint(p = this.center()) {
		const h = this.host.h;
		const id = nextId(h, "BP", h.branchPoints ??= []);
		h.branchPoints.push({ id, x: snap(p.x), y: snap(p.y) });
		this.host.lsel = { bp: id };
		this.host.changed();
	}

	/** Deletes a bundle or branch point (merging the two bundles it joins, if exactly two). */
	remove(s: LayoutSel) {
		const h = this.host.h;
		if (s?.bundle) h.bundles = h.bundles?.filter(b => b.id !== s.bundle);
		if (s?.bp) removeBranchPoint(h, s.bp);
		this.host.sel = this.host.lsel = null;
		this.host.changed();
	}
}
