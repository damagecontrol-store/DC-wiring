import { Menu } from "obsidian";
import { computeNets, nextId, netWires, pinKey, portLabel, removeComponent, signalOf, wireLabel, type Component, type End, type Harness, type Wire } from "./model.ts";
import { insertIndex, labelPoint, orthoPoints, roundedPath, routeAround, separate, STUB, type P, type Rect } from "./route.ts";
import { wireColors } from "./ui.ts";
import { drawWiringTables, wiringTableItem } from "./wiringtable.ts";

const NS = "http://www.w3.org/2000/svg";
export const W = 140, HDR = 24, ROW = 20, GRID = 20, CELL = 18;

export type Selection = { wires?: string[]; component?: string } | null;

/** What the canvas needs from its host view. */
export interface Host {
	h: Harness;
	sel: Selection;
	select(sel: Selection): void;
	changed(): void;
	editComponent(c: Component): void;
	editWire(id: string): void;
	editSignal(c: Component, pin: number): void;
	subs: Map<string, Harness>; // loaded sub-harness files by vault path
	openSub(c: Component): void;
	addSub(x: number, y: number): void;
}

type Drag =
	| { mode: "move"; id: string; dx: number; dy: number; moved: boolean }
	| { mode: "pan"; sx: number; sy: number; px: number; py: number }
	| { mode: "wire"; from: End; line: SVGLineElement }
	| { mode: "bend"; w: Wire; i: number; moved: boolean };

function el<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attrs: Record<string, string | number>, text?: string) {
	const e = document.createElementNS(NS, tag);
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
	if (text !== undefined) e.textContent = text;
	parent.appendChild(e);
	return e;
}

/** Top of a connector's pin grid: under the pin rows and, if there is one, the part label. */
const faceTop = (c: Component, hasPart: boolean) => c.y + HDR + c.pins * ROW + (hasPart ? 22 : 8);
const centerX = (c: Component) => c.kind === "splice" ? c.x : c.x + W / 2;
const snap = (v: number) => Math.round(v / GRID) * GRID;

export function anchor(c: Component, pin: number, towardX: number) {
	if (c.kind === "splice") return { x: c.x, y: c.y, dx: towardX >= c.x ? 1 : -1 };
	const right = towardX > c.x + W / 2;
	return { x: right ? c.x + W : c.x, y: c.y + HDR + (pin - 1) * ROW + ROW / 2, dx: right ? 1 : -1 };
}

let canvases = 0; // each canvas needs its own pattern id: url(#id) picks the first match in the whole page

export class Schematic {
	svg: SVGSVGElement;
	private gridId = `dcw-grid-${++canvases}`;
	private g: SVGGElement;
	private view = { x: 40, y: 40, z: 1 };
	private drag: Drag | null = null;

	constructor(private host: Host) {
		this.svg = document.createElementNS(NS, "svg");
		this.svg.addClass("dcw-canvas");
		const defs = el(this.svg, "defs", {});
		const pat = el(defs, "pattern", { id: this.gridId, width: GRID, height: GRID, patternUnits: "userSpaceOnUse" });
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

	/** Zooms to show everything. False if the canvas has no size yet (hidden tab) or nothing to show. */
	fit(): boolean {
		const r = this.svg.getBoundingClientRect();
		const ex = this.host.h.components.map(c => this.extent(c));
		if (!ex.length || !r.width) return false;
		const minX = Math.min(...ex.map(e => e.x1)) - 40, minY = Math.min(...ex.map(e => e.y1)) - 40;
		const maxX = Math.max(...ex.map(e => e.x2)) + 40, maxY = Math.max(...ex.map(e => e.y2)) + 40;
		const z = Math.min(2, r.width / (maxX - minX), r.height / (maxY - minY));
		this.view = { z, x: (r.width - (maxX - minX) * z) / 2 - minX * z, y: (r.height - (maxY - minY) * z) / 2 - minY * z };
		this.applyView();
		return true;
	}

	render() {
		const { h, sel } = this.host;
		this.g.replaceChildren();
		this.applyView();
		el(this.g, "rect", { x: -1e5, y: -1e5, width: 2e5, height: 2e5, fill: `url(#${this.gridId})`, "data-bg": 1 });

		const lit = sel ? netWires(h, sel) : null;
		const nets = computeNets(h);

		const routed = h.wires.flatMap(w => {
			const ends = this.ends(w);
			return ends ? [{ w, ...ends, offset: 0 }] : [];
		});
		// Wires leaving and arriving at the same columns run side by side. Ordered by height so they
		// don't cross: going down, the top wire turns last; going up, first.
		const groups = new Map<string, typeof routed>();
		for (const r of routed) {
			if (r.w.points?.length) continue;
			const [l, rt] = r.a.x <= r.b.x ? [r.a, r.b] : [r.b, r.a];
			const key = `${l.x}|${l.dx}|${rt.x}|${rt.dx}|${Math.sign(rt.y - l.y)}`;
			groups.set(key, [...groups.get(key) ?? [], r]);
		}
		for (const grp of groups.values()) {
			const left = (r: typeof routed[0]) => r.a.x <= r.b.x ? r.a : r.b, right = (r: typeof routed[0]) => r.a.x <= r.b.x ? r.b : r.a;
			grp.sort((p, q) => left(p).y - left(q).y);
			grp.forEach((r, i) => r.offset = (right(r).y >= left(r).y ? -1 : 1) * (i - (grp.length - 1) / 2) * 6);
		}

		for (const { w, a, b, offset } of routed) {
			const pts = orthoPoints(a, b, w.points, offset);
			const d = roundedPath(pts);
			const g = el(this.g, "g", { class: "dcw-wire", "data-wire": w.id });
			if (lit && !lit.has(w.id)) g.addClass("is-dim");
			if (sel?.wires?.includes(w.id)) el(g, "path", { d, class: "dcw-glow" });
			const [base, stripe] = wireColors(w.color);
			el(g, "path", { d, class: "dcw-outline" });
			el(g, "path", { d, class: "dcw-core", stroke: base });
			if (stripe) el(g, "path", { d, class: "dcw-stripe", stroke: stripe });
			el(g, "path", { d, class: "dcw-hit" });
			const lp = labelPoint(pts);
			const label = wireLabel(h, w);
			if (label) el(g, "text", { x: lp.x, y: lp.y - 5, class: "dcw-wlabel" }, label);
		}

		for (const c of h.components) {
			const g = el(this.g, "g", { class: "dcw-comp", "data-comp": c.id });
			if (sel?.component === c.id) g.addClass("is-selected");
			const part = h.parts.find(p => p.id === c.partId);
			if (c.kind === "splice") {
				el(g, "circle", { cx: c.x, cy: c.y, r: 11, class: "dcw-splice" }); // ring = drag handle
				el(g, "circle", { cx: c.x, cy: c.y, r: 4, class: "dcw-pin", "data-pin": 1, "data-comp": c.id });
				el(g, "text", { x: c.x, y: c.y - 12, class: "dcw-label is-center" }, c.name);
				if (part) el(g, "text", { x: c.x, y: c.y + 22, class: "dcw-part is-center" }, part.number);
				continue;
			}
			const hgt = HDR + c.pins * ROW;
			const sub = c.kind === "harness" ? this.host.subs.get(c.file ?? "") : undefined;
			if (c.kind === "harness") g.addClass("is-sub");
			el(g, "rect", { x: c.x, y: c.y, width: W, height: hgt, rx: 4, class: "dcw-body" });
			el(g, "text", { x: c.x + 8, y: c.y + 16, class: "dcw-label" },
				c.kind === "harness" ? `⧉ ${c.name}${sub ? "" : " (file not found)"}` : `${c.id}  ${c.name}`);
			if (c.kind === "harness" && !c.pins) el(g, "text", { x: c.x + 8, y: c.y + HDR + 14, class: "dcw-hint" }, "No connectors shown in main yet");
			for (let p = 1; p <= c.pins; p++) {
				const y = c.y + HDR + (p - 1) * ROW;
				el(g, "line", { x1: c.x, y1: y, x2: c.x + W, y2: y, class: "dcw-sep" });
				el(g, "rect", { x: c.x, y, width: W, height: ROW, class: "dcw-row", "data-row": p });
				if (c.kind === "harness") {
					const ref = c.ports?.[p - 1] ?? "", label = sub && portLabel(sub, ref);
					el(g, "text", { x: c.x + 8, y: y + 14, class: label || !sub ? "dcw-signal" : "dcw-signal is-missing" }, label || `${ref}${sub ? " (missing)" : ""}`);
					for (const x of [c.x, c.x + W]) el(g, "circle", { cx: x, cy: y + ROW / 2, r: 4, class: "dcw-pin", "data-pin": p, "data-comp": c.id });
					continue;
				}
				el(g, "text", { x: c.x + 10, y: y + 14, class: "dcw-pinno" }, String(p));
				const own = c.signals?.[p];
				const sig = own || signalOf(h, { c: c.id, pin: p }, nets);
				if (sig) el(g, "text", { x: c.x + 30, y: y + 14, class: own ? "dcw-signal" : "dcw-signal is-inherited" }, sig);
				for (const x of [c.x, c.x + W]) el(g, "circle", { cx: x, cy: y + ROW / 2, r: 4, class: "dcw-pin", "data-pin": p, "data-comp": c.id });
			}
			if (part) el(g, "text", { x: c.x, y: c.y + hgt + 14, class: "dcw-part" }, `${part.number}${part.manufacturer ? " · " + part.manufacturer : ""}`);
			if (c.layout) this.face(g, c, faceTop(c, !!part), lit);
		}
		drawWiringTables(this.g, this.host);
		// bend point handles of the selected wire, on top of everything
		for (const w of h.wires) if (sel?.wires?.includes(w.id)) (w.points ?? []).forEach((p, i) =>
			el(this.g, "rect", { x: p.x - 4, y: p.y - 4, width: 8, height: 8, class: "dcw-wp", "data-wp": `${w.id}:${i}` }));
		if (this.drag?.mode === "wire") this.g.appendChild(this.drag.line);
	}

	/** Everything a component draws: box, labels, part label and pin grid. The one place for this size. */
	private extent(c: Component): Rect {
		if (c.kind === "splice") return { x1: c.x - 12, y1: c.y - 24, x2: c.x + 12, y2: c.y + 26 };
		const hasPart = this.host.h.parts.some(p => p.id === c.partId);
		let x1 = c.x, x2 = c.x + W, y2 = c.y + HDR + c.pins * ROW + (hasPart ? 18 : 0);
		if (c.kind === "harness" && !c.pins) y2 += 20; // "No connectors shown" hint
		if (c.layout) {
			const fw = c.layout.cols * CELL + 8;
			y2 = faceTop(c, hasPart) + c.layout.rows * CELL + 8;
			x1 = Math.min(x1, c.x + (W - fw) / 2);
			x2 = Math.max(x2, c.x + (W + fw) / 2);
		}
		return { x1, y1: c.y, x2, y2 };
	}

	/** Area auto route keeps wires out of. Splices are not obstacles: wires meet there. */
	private box(c: Component): Rect | undefined {
		if (c.kind === "splice") return;
		const e = this.extent(c), m = 12; // < STUB, so a wire's own stub point stays outside its connector
		return { x1: e.x1 - m, y1: e.y1 - m, x2: e.x2 + m, y2: e.y2 + m };
	}

	/** Routes wires (all, or the given ids) around connectors and stores the result as bend points. */
	autoRoute(ids?: string[]) {
		const h = this.host.h;
		const wires = ids ? h.wires.filter(w => ids.includes(w.id)) : h.wires;
		const obstacles = h.components.flatMap(c => this.box(c) ?? []);
		const done: { w: Wire; path: P[] }[] = [];
		for (const w of wires) {
			const ends = this.ends(w);
			if (!ends) continue;
			const s = { x: ends.a.x + ends.a.dx * STUB, y: ends.a.y }, e = { x: ends.b.x + ends.b.dx * STUB, y: ends.b.y };
			const path = routeAround(s, e, obstacles);
			if (path) done.push({ w, path });
		}
		separate(done.map(d => d.path));
		for (const { w, path } of done) {
			const via = path.slice(1, -1);
			if (via.length) w.points = via; else delete w.points;
		}
		return { routed: done.length, total: wires.length };
	}

	/** Pin anchors of a wire, each facing the other end. */
	private ends(w: Wire) {
		const ca = this.host.h.components.find(c => c.id === w.from.c), cb = this.host.h.components.find(c => c.id === w.to.c);
		if (!ca || !cb) return;
		return { a: anchor(ca, w.from.pin, centerX(cb)), b: anchor(cb, w.to.pin, centerX(ca)) };
	}

	private bendPoint(el: Element | null) {
		const ref = el?.closest("[data-wp]")?.getAttribute("data-wp");
		if (!ref) return;
		const [id, i] = ref.split(":");
		const w = this.host.h.wires.find(w => w.id === id);
		return w?.points?.[Number(i)] ? { w, i: Number(i) } : undefined;
	}

	/** Connector face: pins in their rows x cols grid, ringed in the colour of the wire on them. */
	private face(g: SVGGElement, c: Component, top: number, lit: Set<string> | null) {
		const { rows, cols } = c.layout!;
		const fw = cols * CELL + 8, left = c.x + (W - fw) / 2;
		el(g, "rect", { x: left, y: top, width: fw, height: rows * CELL + 8, rx: 4, class: "dcw-face" });
		for (let p = 1; p <= c.pins; p++) {
			const cx = left + 4 + ((p - 1) % cols) * CELL + CELL / 2, cy = top + 4 + Math.floor((p - 1) / cols) * CELL + CELL / 2;
			const w = this.host.h.wires.find(w => (w.from.c === c.id && w.from.pin === p) || (w.to.c === c.id && w.to.pin === p));
			const cav = el(g, "circle", { cx, cy, r: 7, class: "dcw-pin dcw-cavity", "data-pin": p, "data-comp": c.id, "data-row": p });
			if (w) { cav.style.stroke = wireColors(w.color)[0]; cav.addClass("is-wired"); } // inline: beats the .dcw-pin stroke
			if (lit && w && !lit.has(w.id)) cav.addClass("is-dim");
			el(g, "text", { x: cx, y: cy + 3, class: "dcw-cavno" }, String(p));
		}
	}

	private down(e: PointerEvent) {
		if (e.button !== 0) return;
		const t = e.target as Element;
		const p = this.world(e);
		const pin = t.closest("[data-pin]");
		const comp = t.closest("[data-comp]");
		const wire = t.closest("[data-wire]");
		this.svg.setPointerCapture(e.pointerId);
		const bp = this.bendPoint(t);
		if (bp) {
			this.drag = { mode: "bend", w: bp.w, i: bp.i, moved: false };
		} else if (pin) {
			const from = { c: pin.getAttribute("data-comp")!, pin: Number(pin.getAttribute("data-pin")) };
			const line = el(this.g, "line", { x1: pin.getAttribute("cx")!, y1: pin.getAttribute("cy")!, x2: p.x, y2: p.y, class: "dcw-temp" });
			this.drag = { mode: "wire", from, line };
		} else if (comp) {
			const c = this.host.h.components.find(c => c.id === comp.getAttribute("data-comp"))!;
			this.drag = { mode: "move", id: c.id, dx: p.x - c.x, dy: p.y - c.y, moved: false };
			this.host.select({ component: c.id });
		} else if (wire) {
			this.host.select({ wires: [wire.getAttribute("data-wire")!] });
		} else {
			this.drag = { mode: "pan", sx: e.clientX, sy: e.clientY, px: this.view.x, py: this.view.y };
			if (this.host.sel) this.host.select(null);
		}
	}

	private move(e: PointerEvent) {
		const d = this.drag;
		if (!d) return;
		if (d.mode === "pan") {
			this.view.x = d.px + e.clientX - d.sx;
			this.view.y = d.py + e.clientY - d.sy;
			this.applyView();
		} else if (d.mode === "bend") {
			const p = this.world(e), pt = d.w.points![d.i], x = snap(p.x), y = snap(p.y);
			if (x !== pt.x || y !== pt.y) { pt.x = x; pt.y = y; d.moved = true; this.render(); }
		} else if (d.mode === "move") {
			const p = this.world(e), c = this.host.h.components.find(c => c.id === d.id)!;
			const x = snap(p.x - d.dx), y = snap(p.y - d.dy);
			if (x !== c.x || y !== c.y) { c.x = x; c.y = y; d.moved = true; this.render(); }
		} else {
			const p = this.world(e);
			d.line.setAttribute("x2", String(p.x));
			d.line.setAttribute("y2", String(p.y));
		}
	}

	private up(e: PointerEvent) {
		const d = this.drag;
		this.drag = null;
		if (!d) return;
		if ((d.mode === "move" || d.mode === "bend") && d.moved) this.host.changed();
		if (d.mode !== "wire") return;
		d.line.remove();
		const pin = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-pin]");
		if (!pin) return;
		const to = { c: pin.getAttribute("data-comp")!, pin: Number(pin.getAttribute("data-pin")) };
		if (pinKey(to) === pinKey(d.from)) return;
		const h = this.host.h;
		const id = nextId(h, "W", h.wires);
		h.wires.push({ id, from: d.from, to, color: "black", gauge: "", length: 0 });
		this.host.sel = { wires: [id] };
		this.host.changed();
	}

	private wheel(e: WheelEvent) {
		e.preventDefault();
		if (e.ctrlKey || e.metaKey) { // pinch or ctrl+wheel zooms, like Obsidian Canvas
			const r = this.svg.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
			const z = Math.min(4, Math.max(0.2, this.view.z * Math.exp(-e.deltaY * 0.01)));
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
		const bp = this.bendPoint(t);
		if (bp) {
			bp.w.points!.splice(bp.i, 1);
			if (!bp.w.points!.length) delete bp.w.points;
			return this.host.changed();
		}
		const w = h.wires.find(w => w.id === t.closest("[data-wire]")?.getAttribute("data-wire"));
		const ends = w && this.ends(w);
		if (w && ends) {
			const raw = this.world(e), p = { x: snap(raw.x), y: snap(raw.y) };
			const via = w.points ?? [];
			via.splice(insertIndex(ends.a, ends.b, via, p), 0, p);
			w.points = via;
			this.host.sel = { wires: [w.id] };
			return this.host.changed();
		}
		const c = h.components.find(c => c.id === t.closest("[data-comp]")?.getAttribute("data-comp"));
		if (!c) return;
		if (c.kind === "harness") return this.host.openSub(c);
		const row = t.closest("[data-row]")?.getAttribute("data-row");
		if (row) this.host.editSignal(c, Number(row));
		else this.host.editComponent(c);
	}

	private menu(e: MouseEvent) {
		e.preventDefault();
		const t = e.target as Element, h = this.host.h, m = new Menu();
		const wire = t.closest("[data-wire]")?.getAttribute("data-wire");
		const c = h.components.find(c => c.id === t.closest("[data-comp]")?.getAttribute("data-comp"));
		if (wire) {
			m.addItem(i => i.setTitle("Edit wire").setIcon("pencil").onClick(() => this.host.editWire(wire)));
			const w = h.wires.find(w => w.id === wire)!;
			m.addItem(i => i.setTitle("Auto route").setIcon("route").onClick(() => { this.autoRoute([wire]); this.host.changed(); }));
			if (w.points?.length) m.addItem(i => i.setTitle("Clear bend points").setIcon("eraser").onClick(() => { delete w.points; this.host.changed(); }));
			m.addItem(i => i.setTitle("Delete wire").setIcon("trash").onClick(() => {
				h.wires = h.wires.filter(w => w.id !== wire);
				this.host.sel = null;
				this.host.changed();
			}));
		} else if (c) {
			const kind = c.kind === "harness" ? "sub-harness" : c.kind;
			if (c.kind === "harness") m.addItem(i => i.setTitle("Open sub-harness").setIcon("file-symlink").onClick(() => this.host.openSub(c)));
			m.addItem(i => i.setTitle(`Edit ${kind}`).setIcon("pencil").onClick(() => this.host.editComponent(c)));
			wiringTableItem(m, c, this.host);
			m.addItem(i => i.setTitle(c.kind === "harness" ? "Remove sub-harness (keeps its file)" : `Delete ${kind}`).setIcon("trash").onClick(() => {
				removeComponent(h, c.id);
				this.host.sel = null;
				this.host.changed();
			}));
		} else {
			const p = this.world(e);
			m.addItem(i => i.setTitle("Add connector").setIcon("plug").onClick(() => this.add("connector", p.x, p.y)));
			m.addItem(i => i.setTitle("Add splice").setIcon("git-merge").onClick(() => this.add("splice", p.x, p.y)));
			m.addItem(i => i.setTitle("Add sub-harness…").setIcon("layers").onClick(() => this.host.addSub(snap(p.x), snap(p.y))));
			m.addItem(i => i.setTitle("Fit to view").setIcon("maximize").onClick(() => this.fit()));
		}
		m.showAtMouseEvent(e);
	}

	/** Middle of the visible canvas, snapped to the grid. */
	center() {
		const r = this.svg.getBoundingClientRect();
		return { x: snap((r.width / 2 - this.view.x) / this.view.z), y: snap((r.height / 2 - this.view.y) / this.view.z) };
	}

	add(kind: Component["kind"], x?: number, y?: number) {
		const h = this.host.h;
		if (x === undefined || y === undefined) ({ x, y } = this.center());
		const id = nextId(h, kind === "splice" ? "S" : "C", h.components);
		h.components.push({ id, kind, name: kind === "splice" ? id : "Connector", x: snap(x), y: snap(y), pins: kind === "splice" ? 1 : 4 });
		this.host.sel = { component: id };
		this.host.changed();
	}
}
