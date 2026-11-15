import { Menu } from "obsidian";
import { computeNets, nextId, netWires, pinKey, portLabel, removeComponent, signalOf, wireLabel, type Component, type End, type Harness, type Wire } from "./model.ts";
import { insertIndex, labelPoint, orthoPoints, roundedPath, routeAround, separate, STUB, type P, type Rect } from "./route.ts";
import { wireColors } from "./ui.ts";
import { coreOf, twist, untwist } from "./cable.ts";
import { groupOf, isLocked, moveGroup, ungroup, wireLocked } from "./groups.ts";
import type { CanvasImage, Group } from "./model.ts";

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
	// groups, twisted wires, images
	editGroup(id: string): void;
	pickGroup(c: Component): void;
	saveGroupAsSub(id: string): void;
	twistWith(wireId: string): void;
	addImage(x: number, y: number): void;
	imageSrc(path: string): string | undefined;
}

type Drag =
	| { mode: "move"; id: string; dx: number; dy: number; moved: boolean }
	| { mode: "pan"; sx: number; sy: number; px: number; py: number }
	| { mode: "wire"; from: End; line: SVGLineElement }
	| { mode: "bend"; w: Wire; i: number; moved: boolean }
	| { mode: "group"; g: Group; sx: number; sy: number; ox: number; oy: number }
	| { mode: "image"; img: CanvasImage; dx: number; dy: number; resize: boolean; moved: boolean };

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
	const row = c.kind === "cable" && pin === 0 ? c.pins : pin - 1; // cable shield: the row under the cores
	return { x: right ? c.x + W : c.x, y: c.y + HDR + row * ROW + ROW / 2, dx: right ? 1 : -1 };
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
		this.images();
		this.groups();

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
			// shortcut: ident and twist marks sit level at the label point, also on vertical runs; follow the path if that reads badly
			if (w.ident) this.ident(g, lp, w.ident);
			if (w.twist) for (const s of [-1, 1]) el(g, "path", { d: `M${lp.x - 12},${lp.y + 12} q3,${s * 5} 6,0 t6,0 t6,0 t6,0`, class: "dcw-twist" });
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
			if (c.kind === "cable") { this.cable(g, c, part?.number); continue; }
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
		if (c.kind === "cable" && c.shield) y2 += ROW;
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
		const hdr = this.host.h.groups?.find(g => g.id === t.closest("[data-group-hdr]")?.getAttribute("data-group-hdr"));
		const img = this.host.h.images?.find(i => i.id === t.closest("[data-img]")?.getAttribute("data-img"));
		if (bp) {
			this.drag = { mode: "bend", w: bp.w, i: bp.i, moved: false };
		} else if (hdr) {
			this.drag = { mode: "group", g: hdr, sx: p.x, sy: p.y, ox: 0, oy: 0 };
		} else if (img) {
			this.drag = { mode: "image", img, dx: p.x - img.x, dy: p.y - img.y, resize: t.hasAttribute("data-img-resize"), moved: false };
		} else if (pin) {
			const from = { c: pin.getAttribute("data-comp")!, pin: Number(pin.getAttribute("data-pin")) };
			const line = el(this.g, "line", { x1: pin.getAttribute("cx")!, y1: pin.getAttribute("cy")!, x2: p.x, y2: p.y, class: "dcw-temp" });
			this.drag = { mode: "wire", from, line };
		} else if (comp) {
			const c = this.host.h.components.find(c => c.id === comp.getAttribute("data-comp"))!;
			if (!isLocked(this.host.h, c.id)) this.drag = { mode: "move", id: c.id, dx: p.x - c.x, dy: p.y - c.y, moved: false };
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
		} else if (d.mode === "group") {
			const p = this.world(e), x = snap(p.x - d.sx), y = snap(p.y - d.sy);
			if (x !== d.ox || y !== d.oy) { moveGroup(this.host.h, d.g, x - d.ox, y - d.oy); d.ox = x; d.oy = y; this.render(); }
		} else if (d.mode === "image") {
			const p = this.world(e), i = d.img;
			if (d.resize) { i.w = Math.max(GRID, snap(p.x - i.x)); i.h = Math.max(GRID, snap(p.y - i.y)); }
			else { i.x = snap(p.x - d.dx); i.y = snap(p.y - d.dy); }
			d.moved = true;
			this.render();
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
		if ((d.mode === "move" || d.mode === "bend" || d.mode === "image") && d.moved) this.host.changed();
		if (d.mode === "group" && (d.ox || d.oy)) this.host.changed();
		if (d.mode !== "wire") return;
		d.line.remove();
		const pin = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-pin]");
		if (!pin) return;
		const to = { c: pin.getAttribute("data-comp")!, pin: Number(pin.getAttribute("data-pin")) };
		if (pinKey(to) === pinKey(d.from)) return;
		const h = this.host.h;
		const id = nextId(h, "W", h.wires);
		const core = coreOf(h, d.from) ?? coreOf(h, to); // a wire onto a cable core is that core's end
		h.wires.push({ id, from: d.from, to, color: core?.color || "black", gauge: core?.gauge ?? "", length: 0 });
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
		const hdr = t.closest("[data-group-hdr]")?.getAttribute("data-group-hdr");
		if (hdr) return this.host.editGroup(hdr);
		if (bp) {
			bp.w.points!.splice(bp.i, 1);
			if (!bp.w.points!.length) delete bp.w.points;
			return this.host.changed();
		}
		const w = h.wires.find(w => w.id === t.closest("[data-wire]")?.getAttribute("data-wire"));
		const ends = w && !wireLocked(h, w) && this.ends(w);
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
		if (isLocked(h, c.id)) return;
		const row = t.closest("[data-row]")?.getAttribute("data-row");
		if (row) this.host.editSignal(c, Number(row));
		else this.host.editComponent(c);
	}

	private menu(e: MouseEvent) {
		e.preventDefault();
		const t = e.target as Element, h = this.host.h, m = new Menu();
		const wire = t.closest("[data-wire]")?.getAttribute("data-wire");
		const c = h.components.find(c => c.id === t.closest("[data-comp]")?.getAttribute("data-comp"));
		if (this.extraMenu(m, t, wire, c)) return m.showAtMouseEvent(e);
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
			m.addItem(i => i.setTitle(c.kind === "harness" ? "Remove sub-harness (keeps its file)" : `Delete ${kind}`).setIcon("trash").onClick(() => {
				removeComponent(h, c.id);
				this.host.sel = null;
				this.host.changed();
			}));
		} else {
			const p = this.world(e);
			m.addItem(i => i.setTitle("Add connector").setIcon("plug").onClick(() => this.add("connector", p.x, p.y)));
			m.addItem(i => i.setTitle("Add splice").setIcon("git-merge").onClick(() => this.add("splice", p.x, p.y)));
			m.addItem(i => i.setTitle("Add cable").setIcon("cable").onClick(() => this.addCable(p.x, p.y)));
			m.addItem(i => i.setTitle("Add image…").setIcon("image").onClick(() => this.host.addImage(snap(p.x), snap(p.y))));
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

	addCable(x?: number, y?: number) {
		const h = this.host.h;
		if (x === undefined || y === undefined) ({ x, y } = this.center());
		const id = nextId(h, "CB", h.components);
		h.components.push({ id, kind: "cable", name: "Cable", x: snap(x), y: snap(y), pins: 2, cores: [{ color: "black", gauge: "" }, { color: "red", gauge: "" }] });
		this.host.sel = { component: id };
		this.host.changed();
	}

	/** Cable: a rounded box with a row per core (drawn in its colour) and the shield last. */
	private cable(g: SVGGElement, c: Component, part?: string) {
		const rows = c.pins + (c.shield ? 1 : 0), hgt = HDR + rows * ROW;
		el(g, "rect", { x: c.x, y: c.y, width: W, height: hgt, rx: 12, class: "dcw-body dcw-cable" });
		el(g, "text", { x: c.x + 10, y: c.y + 16, class: "dcw-label" }, `${c.id}  ${c.name}`);
		if (c.length) el(g, "text", { x: c.x + W - 10, y: c.y + 16, class: "dcw-pinno is-end" }, `${c.length} mm`);
		for (let r = 0; r < rows; r++) {
			const pin = r < c.pins ? r + 1 : 0, y = c.y + HDR + r * ROW, core = c.cores?.[pin - 1];
			el(g, "line", { x1: c.x, y1: y, x2: c.x + W, y2: y, class: "dcw-sep" });
			el(g, "text", { x: c.x + 10, y: y + 14, class: "dcw-pinno" }, pin ? String(pin) : "S");
			const line = { x1: c.x + 28, y1: y + ROW / 2, x2: c.x + W - 34, y2: y + ROW / 2 };
			if (!core) el(g, "line", { ...line, class: "dcw-shield" });
			else {
				const [base, stripe] = wireColors(core.color);
				el(g, "line", { ...line, class: "dcw-core", stroke: base });
				if (stripe) el(g, "line", { ...line, class: "dcw-stripe", stroke: stripe });
				if (core.gauge) el(g, "text", { x: c.x + W - 10, y: y + 14, class: "dcw-pinno is-end" }, core.gauge);
			}
			for (const x of [c.x, c.x + W]) el(g, "circle", { cx: x, cy: y + ROW / 2, r: 4, class: "dcw-pin", "data-pin": pin, "data-comp": c.id });
		}
		if (part) el(g, "text", { x: c.x, y: c.y + hgt + 14, class: "dcw-part" }, part);
	}

	/** Wire ident: colour bands, then the label, centred on the wire. */
	private ident(g: SVGGElement, at: P, ident: NonNullable<Wire["ident"]>) {
		const colors = ident.colors ?? [], label = ident.label ?? "", lw = label ? label.length * 6 + 8 : 0;
		let x = at.x - (colors.length * 6 + lw) / 2;
		for (const c of colors) { el(g, "rect", { x, y: at.y - 6, width: 6, height: 12, fill: wireColors(c)[0], class: "dcw-band" }); x += 6; }
		if (!label) return;
		el(g, "rect", { x, y: at.y - 7, width: lw, height: 14, rx: 2, class: "dcw-ident" });
		el(g, "text", { x: x + lw / 2, y: at.y + 4, class: "dcw-identtext" }, label);
	}

	private images() {
		for (const i of this.host.h.images ?? []) {
			const g = el(this.g, "g", { class: "dcw-image", "data-img": i.id });
			const src = this.host.imageSrc(i.path);
			if (src) el(g, "image", { href: src, x: i.x, y: i.y, width: i.w, height: i.h });
			else el(g, "text", { x: i.x + 8, y: i.y + 16, class: "dcw-hint" }, `${i.path} (not found)`);
			el(g, "rect", { x: i.x, y: i.y, width: i.w, height: i.h, class: "dcw-imgframe" });
			el(g, "rect", { x: i.x + i.w - 6, y: i.y + i.h - 6, width: 12, height: 12, class: "dcw-wp dcw-resize", "data-img-resize": 1 });
		}
	}

	/** Group frames, behind wires and components. Dragging the header moves the members. */
	private groups() {
		const h = this.host.h;
		for (const grp of h.groups ?? []) {
			const ex = h.components.filter(c => grp.members.includes(c.id)).map(c => this.extent(c));
			if (!ex.length) continue;
			const x1 = Math.min(...ex.map(e => e.x1)) - 16, y1 = Math.min(...ex.map(e => e.y1)) - 16 - HDR;
			const x2 = Math.max(...ex.map(e => e.x2)) + 16, y2 = Math.max(...ex.map(e => e.y2)) + 16;
			const g = el(this.g, "g", { class: grp.locked ? "dcw-group is-locked" : "dcw-group", "data-group": grp.id });
			el(g, "rect", { x: x1, y: y1, width: x2 - x1, height: y2 - y1, rx: 6, class: "dcw-gframe" });
			el(g, "rect", { x: x1, y: y1, width: x2 - x1, height: HDR, rx: 6, class: "dcw-ghdr", "data-group-hdr": grp.id });
			const part = h.parts.find(p => p.id === grp.partId);
			el(g, "text", { x: x1 + 8, y: y1 + 16, class: "dcw-label" }, `${grp.locked ? "🔒 " : ""}${grp.name}${part ? "  · " + part.number : ""}`);
		}
	}

	/** Menus for groups, images, twisted and locked items. True when the menu is complete. */
	private extraMenu(m: Menu, t: Element, wire: string | null | undefined, c: Component | undefined): boolean {
		const h = this.host.h, done = () => this.host.changed();
		const w = h.wires.find(w => w.id === wire);
		if (w) {
			if (wireLocked(h, w)) return !!m.addItem(i => i.setTitle(`Locked in ${groupOf(h, w.from.c)!.name}`).setIcon("lock").setDisabled(true));
			const sel = this.host.sel?.wires ?? [];
			if (sel.length > 1 && sel.includes(w.id)) m.addItem(i => i.setTitle("Twist selected together").setIcon("git-merge").onClick(() => { twist(h, sel); done(); }));
			m.addItem(i => i.setTitle("Twist with…").setIcon("git-merge").onClick(() => this.host.twistWith(w.id)));
			if (w.twist) m.addItem(i => i.setTitle("Untwist").setIcon("git-branch").onClick(() => { untwist(h, w.id); done(); }));
			return false;
		}
		if (c) {
			const grp = groupOf(h, c.id);
			if (grp?.locked) return !!m.addItem(i => i.setTitle(`Locked in ${grp.name}`).setIcon("lock").setDisabled(true));
			m.addItem(i => i.setTitle("Add to group…").setIcon("group").onClick(() => this.host.pickGroup(c)));
			if (grp) m.addItem(i => i.setTitle(`Remove from ${grp.name}`).setIcon("ungroup").onClick(() => { grp.members = grp.members.filter(x => x !== c.id); if (!grp.members.length) ungroup(h, grp.id); done(); }));
			return false;
		}
		const grp = h.groups?.find(g => g.id === t.closest("[data-group]")?.getAttribute("data-group"));
		if (grp) {
			m.addItem(i => i.setTitle("Edit group").setIcon("pencil").onClick(() => this.host.editGroup(grp.id)));
			m.addItem(i => i.setTitle(grp.locked ? "Unlock" : "Lock").setIcon(grp.locked ? "unlock" : "lock").onClick(() => { if (grp.locked) delete grp.locked; else grp.locked = true; done(); }));
			m.addItem(i => i.setTitle("Save as sub-harness…").setIcon("file-symlink").onClick(() => this.host.saveGroupAsSub(grp.id)));
			m.addItem(i => i.setTitle("Ungroup").setIcon("ungroup").onClick(() => { ungroup(h, grp.id); done(); }));
			return true;
		}
		const img = h.images?.find(i => i.id === t.closest("[data-img]")?.getAttribute("data-img"));
		if (img) {
			m.addItem(i => i.setTitle("Remove image").setIcon("trash").onClick(() => { h.images = h.images!.filter(x => x !== img); if (!h.images.length) delete h.images; done(); }));
			return true;
		}
		return false;
	}
}
