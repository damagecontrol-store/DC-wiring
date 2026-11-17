import { Menu, Notice } from "obsidian";
import { cavName, compLabel, copyClip, duplicate, pasteClip, readClip, labelOf, matches, mateError, moveConnections, netSignals, PREFIX, resolveTarget, selComps } from "./components.ts";
import { computeNets, nextId, netWires, pinKey, portLabel, removeComponent, wireLabel, type Component, type End, type Harness, type Wire } from "./model.ts";
import { routeWires } from "./bundles.ts";
import { formatLength } from "./length.ts";
import { effectiveWire, loadedParts } from "./parts.ts";
import { insertIndex, labelPoint, orthoPoints, roundedPath, routeAround, separate, STUB, type P, type Rect } from "./route.ts";
import { wireColors } from "./ui.ts";
import { canvasWarnings } from "./validate.ts";
import { drawWiringTables, wiringTableItem } from "./wiringtable.ts";
import { coreOf, twist, untwist } from "./cable.ts";
import { groupOf, isLocked, moveGroup, ungroup, wireLocked } from "./groups.ts";
import type { CanvasImage, Group } from "./model.ts";

const NS = "http://www.w3.org/2000/svg";
export const W = 140, HDR = 24, ROW = 20, GRID = 20, CELL = 18;
const DW = 60; // diode / resistor symbol width
export const NOTE_COLORS = ["yellow", "orange", "red", "green", "blue", "purple"];

// component: one selected; components: several (box select, shift-click)
export type Selection = { wires?: string[]; component?: string; components?: string[] } | null;

/** What the canvas needs from its host view. */
export interface Host {
	h: Harness;
	sel: Selection;
	select(sel: Selection): void;
	changed(): void;
	editComponent(c: Component): void;
	editWire(id: string): void;
	editSignal(c: Component, pin: number): void;
	pickPart(x: Component | Wire): void;
	pickContact(c: Component, pin: number): void;
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
	| { mode: "move"; sx: number; sy: number; items: { o: P; x: number; y: number }[]; moved: boolean }
	| { mode: "pan"; sx: number; sy: number; px: number; py: number }
	| { mode: "wire"; from: End; line: SVGLineElement; kind: "wire" | "move" | "mate" } // move: Mod-drag moves a pin's wires
	| { mode: "bend"; w: Wire; i: number; moved: boolean }
	| { mode: "group"; g: Group; sx: number; sy: number; ox: number; oy: number }
	| { mode: "image"; img: CanvasImage; dx: number; dy: number; resize: boolean; moved: boolean }
	| { mode: "box"; x: number; y: number; rect: SVGRectElement };

function el<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attrs: Record<string, string | number>, text?: string) {
	const e = document.createElementNS(NS, tag);
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
	if (text !== undefined) e.textContent = text;
	parent.appendChild(e);
	return e;
}

/** Top of a connector's pin grid: under the pin rows and, if there is one, the part label. */
const faceTop = (c: Component, hasPart: boolean) => c.y + HDR + c.pins * ROW + (hasPart ? 22 : 8);
const twoPin = (c: Component) => c.kind === "diode" || c.kind === "resistor";
const centerX = (c: Component) => c.kind === "splice" ? c.x : c.x + (twoPin(c) ? DW : W) / 2;
const snap = (v: number) => Math.round(v / GRID) * GRID;

/** "Assign part…", or the assigned part's number so it reads as what is there now. */
export function partItem(m: Menu, h: Harness, x: Component | Wire, n: number, pick: () => void, changed: () => void) {
	const p = h.parts.find(p => p.id === x.partId), many = n > 1 ? ` to ${n}` : "";
	m.addItem(i => i.setTitle(p ? `Part: ${p.number || p.id}${"config" in x && x.config ? " · " + x.config : ""} (change${many}…)` : `Assign part${many}…`)
		.setIcon("package").onClick(pick));
	if (p && "kind" in x) m.addItem(i => i.setTitle(x.excludeFromBom ? "Include in BOM" : "Exclude from BOM").setIcon(x.excludeFromBom ? "list-plus" : "list-x").onClick(() => {
		if (x.excludeFromBom) delete x.excludeFromBom; else x.excludeFromBom = true;
		changed();
	}));
}

function toggleIn(c: Component, key: "nc" | "globals", pin: number) {
	const list = c[key] ?? [], next = list.includes(pin) ? list.filter(p => p !== pin) : [...list, pin];
	if (next.length) c[key] = next; else delete c[key];
}

export function anchor(c: Component, pin: number, towardX: number) {
	if (c.kind === "splice") return { x: c.x, y: c.y, dx: towardX >= c.x ? 1 : -1 };
	if (twoPin(c)) return { x: pin === 1 ? c.x : c.x + DW, y: c.y + 10, dx: pin === 1 ? -1 : 1 };
	const right = towardX > c.x + W / 2;
	const row = c.kind === "cable" && pin === 0 ? c.pins : pin - 1; // cable shield: the row under the cores
	return { x: right ? c.x + W : c.x, y: c.y + HDR + row * ROW + ROW / 2, dx: right ? 1 : -1 };
}

let canvases = 0; // each canvas needs its own pattern id: url(#id) picks the first match in the whole page

export class Schematic {
	el: HTMLDivElement; // svg plus the search box and toggle bar on top of it
	svg: SVGSVGElement;
	private opts = { net: true, ids: true, dest: false };
	private query = "";
	private toggles: HTMLDivElement;
	private search: HTMLDivElement;
	private results: HTMLDivElement;
	private targets: HTMLDataListElement;
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
		this.el = createDiv("dcw-schematic");
		this.el.appendChild(this.svg);
		this.toggles = this.el.createDiv("dcw-toggles");
		this.search = this.el.createDiv("dcw-search is-hidden");
		const input = this.search.createEl("input", { type: "search", placeholder: "Search components (Esc closes)" });
		input.oninput = () => { this.query = input.value.trim(); this.render(); };
		input.onkeydown = e => {
			if (e.key === "Enter") (this.results.firstElementChild as HTMLElement | null)?.click();
			if (e.key !== "Escape") return;
			this.query = input.value = "";
			this.search.addClass("is-hidden");
			this.render();
			(this.el.closest(".dcw-view") as HTMLElement | null)?.focus(); // so hotkeys keep working
		};
		this.results = this.search.createDiv("dcw-results");
		this.targets = this.el.createEl("datalist", { attr: { id: `dcw-targets-${canvases}` } });
	}

	/** Canvas hotkeys. True when the key was used. */
	key(e: KeyboardEvent): boolean {
		const k = e.key.toLowerCase(), ids = selComps(this.host.sel), h = this.host.h;
		if (e.metaKey || e.ctrlKey) {
			if (k === "d") this.duplicateSelection();
			else if (k === "c" && ids.length) void this.copy();
			else if (k === "v") void this.paste();
			else return false;
			return true;
		}
		if (e.altKey) return false;
		const step = ({ arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] } as Record<string, number[]>)[k];
		if (step) {
			if (!ids.length) return false;
			for (const it of this.moveItems(ids)) { it.o.x += step[0] * GRID; it.o.y += step[1] * GRID; }
			this.host.changed();
		} else if (k === "f") this.fit();
		else if (k === "n") this.toggle("net");
		else if (k === "i") this.toggle("ids");
		else if (k === "d") this.toggle("dest");
		else if (k === " ") this.openSearch();
		else return false;
		return true;
	}

	openSearch() {
		this.search.removeClass("is-hidden");
		const input = this.search.querySelector("input")!;
		input.focus();
		input.select();
	}

	duplicateSelection() {
		const copies = duplicate(this.host.h, selComps(this.host.sel));
		if (copies.length) { this.host.sel = copies.length > 1 ? { components: copies } : { component: copies[0] }; this.host.changed(); }
	}

	/** Puts the selected components, the wires between them and their parts on the clipboard. */
	async copy() {
		const ids = selComps(this.host.sel);
		if (!ids.length) return void new Notice("DC Wiring: select components to copy.");
		await navigator.clipboard.writeText(JSON.stringify(copyClip(this.host.h, ids)));
		new Notice(`DC Wiring: copied ${ids.length} component${ids.length > 1 ? "s" : ""}.`);
	}

	/** Pastes copied components into the middle of the view, with new ids. Parts with the same number are shared, not added twice. */
	async paste() {
		const clip = readClip(await navigator.clipboard.readText());
		if (!clip) return void new Notice("DC Wiring: the clipboard holds no copied components.");
		let ids: string[];
		try { ids = pasteClip(this.host.h, clip, this.center()); }
		catch (e) { return void new Notice(`DC Wiring: can't paste (${(e as Error).message}).`); }
		this.host.sel = ids.length > 1 ? { components: ids } : ids.length ? { component: ids[0] } : null;
		this.host.changed();
	}

	toggle(k: "net" | "ids" | "dest") {
		this.opts[k] = !this.opts[k];
		this.render();
	}

	private renderOverlay() {
		this.toggles.empty();
		for (const [k, text, label] of [["net", "Net", "Highlight the whole net (N)"], ["ids", "IDs", "Show component IDs (I)"], ["dest", "Dest", "Destinations: type a target next to each cavity (D)"]] as const) {
			const b = this.toggles.createEl("button", { text, cls: this.opts[k] ? "is-active" : "", attr: { "aria-label": label } });
			b.onclick = () => this.toggle(k);
		}
		this.results.empty();
		if (!this.query) return;
		const h = this.host.h;
		for (const c of h.components.filter(c => matches(h, c, this.query)).slice(0, 30)) {
			this.results.createDiv({ text: `${compLabel(h, c)}${labelOf(c) ? ` (${c.id})` : ""} · ${c.kind}` }).onclick = () => {
				this.host.select({ component: c.id });
				this.centerOn(c);
			};
		}
		if (!this.results.childElementCount) this.results.createDiv({ cls: "dcw-hint", text: "No matches" });
	}

	private centerOn(...cs: Component[]) {
		const ex = cs.map(c => this.extent(c)), r = this.svg.getBoundingClientRect();
		const x = (Math.min(...ex.map(e => e.x1)) + Math.max(...ex.map(e => e.x2))) / 2, y = (Math.min(...ex.map(e => e.y1)) + Math.max(...ex.map(e => e.y2))) / 2;
		this.view.x = r.width / 2 - x * this.view.z;
		this.view.y = r.height / 2 - y * this.view.z;
		this.applyView();
	}

	private warnAt = -1; // which warning "next warning" showed last
	/** Selects the next warning on the canvas, centres on it and says what it is. */
	nextWarning() {
		const h = this.host.h, ws = canvasWarnings(h);
		if (!ws.length) return;
		const x = ws[this.warnAt = (this.warnAt + 1) % ws.length];
		const w = x.kind === "wire" ? h.wires.find(w => w.id === x.id) : undefined;
		const cs = h.components.filter(c => w ? c.id === w.from.c || c.id === w.to.c : c.id === x.id);
		this.host.select(w ? { wires: [w.id] } : { component: x.id });
		if (cs.length) this.centerOn(...cs);
		new Notice(`${x.id}: ${x.message}`);
	}

	/** Header / label text: the label, with the id in front when IDs are shown. */
	private title(c: Component) {
		return this.opts.ids ? [c.id, labelOf(c)].filter(Boolean).join("  ") : labelOf(c) || c.id;
	}

	private selectComps(ids: string[]) {
		this.host.select(ids.length > 1 ? { components: ids } : ids.length ? { component: ids[0] } : null);
	}

	/** What moves with these components: themselves and, when several move, the bend points of wires between them. */
	private moveItems(ids: string[]) {
		const h = this.host.h;
		const items: { o: P; x: number; y: number }[] = h.components.filter(c => ids.includes(c.id)).map(o => ({ o, x: o.x, y: o.y }));
		if (ids.length > 1) for (const w of h.wires) if (ids.includes(w.from.c) && ids.includes(w.to.c)) for (const o of w.points ?? []) items.push({ o, x: o.x, y: o.y });
		return items;
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

		const comps = selComps(sel);
		const lit = !sel ? null : this.opts.net ? netWires(h, { ...sel, components: comps })
			: new Set(h.wires.filter(w => sel.wires?.includes(w.id) || comps.includes(w.from.c) || comps.includes(w.to.c)).map(w => w.id));
		const nets = computeNets(h);
		const routes = h.bundles?.length ? routeWires(h) : null;
		const warns = canvasWarnings(h);
		this.renderOverlay();

		for (const m of h.mates ?? []) {
			const a = h.components.find(c => c.id === m.a), b = h.components.find(c => c.id === m.b);
			if (!a || !b) continue;
			const [l, r] = a.x <= b.x ? [a, b] : [b, a], x1 = l.x + W, x2 = r.x, y1 = l.y + HDR / 2, y2 = r.y + HDR / 2;
			const err = mateError(h, m);
			const g = el(this.g, "g", { class: err ? "dcw-mate is-error" : "dcw-mate" });
			el(g, "path", { d: `M${x1} ${y1} H${(x1 + x2) / 2} V${y2} H${x2}` });
			el(g, "text", { x: x2 - (x2 - x1) / 4, y: y2 - 4, class: "dcw-wlabel" }, err ?? "mated"); // near the far end: mates from one side don't stack labels
		}

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

		// wire labels: placed apart so side-by-side wires don't print on top of each other, drawn after every wire so none crosses them
		const labels: { x: number; y: number; text: string; dim: boolean; warn: boolean }[] = [];
		for (const { w, a, b, offset } of routed) {
			const pts = orthoPoints(a, b, w.points, offset);
			const d = roundedPath(pts);
			const g = el(this.g, "g", { class: "dcw-wire", "data-wire": w.id });
			if (lit && !lit.has(w.id)) g.addClass("is-dim");
			if (routes && !routes.has(w.id)) g.addClass("is-unrouted"); // has a layout, but no bundle path
			const ww = warns.filter(x => x.kind === "wire" && x.id === w.id);
			if (ww.length) { g.addClass("has-warning"); el(g, "title", {}, ww.map(x => x.message).join("\n")); }
			if (sel?.wires?.includes(w.id)) el(g, "path", { d, class: "dcw-glow" });
			const [base, stripe] = wireColors(effectiveWire(h, w).color);
			el(g, "path", { d, class: "dcw-outline" });
			el(g, "path", { d, class: "dcw-core", stroke: base });
			if (stripe) el(g, "path", { d, class: "dcw-stripe", stroke: stripe });
			el(g, "path", { d, class: "dcw-hit" });
			const lp = labelPoint(pts);
			const label = [ww.length ? "⚠" : "", wireLabel(h, w)].filter(Boolean).join(" "); // a halo alone is lost on red wires
			if (label) {
				let y = lp.y - 5;
				while (labels.some(q => Math.abs(q.x - lp.x) < 40 && Math.abs(q.y - y) < 11)) y += 12;
				labels.push({ x: lp.x, y, text: label, dim: !!lit && !lit.has(w.id), warn: ww.length > 0 });
			}
			// shortcut: ident and twist marks sit level at the label point, also on vertical runs; follow the path if that reads badly
			if (w.ident) this.ident(g, lp, w.ident);
			if (w.twist) for (const s of [-1, 1]) el(g, "path", { d: `M${lp.x - 12},${lp.y + 12} q3,${s * 5} 6,0 t6,0 t6,0 t6,0`, class: "dcw-twist" });
		}
		for (const l of labels) el(this.g, "text", { x: l.x, y: l.y, class: "dcw-wlabel" + (l.dim ? " is-dim" : "") + (l.warn ? " is-warning" : "") }, l.text);

		for (const c of h.components) {
			const g = el(this.g, "g", { class: "dcw-comp", "data-comp": c.id });
			if (comps.includes(c.id)) g.addClass("is-selected");
			if (this.query && !matches(h, c, this.query)) g.addClass("is-dim");
			const part = h.parts.find(p => p.id === c.partId);
			if (c.kind === "note") { this.note(g, c); continue; }
			if (twoPin(c)) { this.twoPin(g, c, part?.number); continue; }
			if (c.kind === "splice") {
				el(g, "circle", { cx: c.x, cy: c.y, r: 11, class: "dcw-splice" }); // ring = drag handle
				el(g, "circle", { cx: c.x, cy: c.y, r: 4, class: "dcw-pin", "data-pin": 1, "data-comp": c.id });
				el(g, "text", { x: c.x, y: c.y - 12, class: "dcw-label is-center" }, this.title(c));
				if (part) el(g, "text", { x: c.x, y: c.y + 22, class: "dcw-part is-center" }, part.number);
				continue;
			}
			if (c.kind === "cable") { this.cable(g, c, part?.number); continue; }
			const hgt = HDR + c.pins * ROW;
			const sub = c.kind === "harness" ? this.host.subs.get(c.file ?? "") : undefined;
			if (c.kind === "harness") g.addClass("is-sub");
			el(g, "rect", { x: c.x, y: c.y, width: W, height: hgt, rx: 4, class: "dcw-body" });
			el(g, "text", { x: c.x + 8, y: c.y + 16, class: "dcw-label" },
				c.kind === "harness" ? `⧉ ${c.name}${sub ? "" : " (file not found)"}` : c.kind === "terminal" ? `${this.title(c)} · ${c.terminal || "terminal"}` : this.title(c));
			// mate handles: drag one onto another connector
			if (c.kind === "connector") for (const x of [c.x - 4, c.x + W - 4]) el(g, "rect", { x, y: c.y + 8, width: 8, height: 8, class: "dcw-matehandle", "data-mate": c.id });
			if (c.kind === "harness" && !c.pins) el(g, "text", { x: c.x + 8, y: c.y + HDR + 14, class: "dcw-hint" }, "No connectors shown in main yet");
			for (let p = 1; p <= c.pins; p++) {
				const y = c.y + HDR + (p - 1) * ROW;
				el(g, "line", { x1: c.x, y1: y, x2: c.x + W, y2: y, class: "dcw-sep" });
				el(g, "rect", { x: c.x, y, width: W, height: ROW, class: warns.some(x => x.id === c.id && x.pin === p) ? "dcw-row is-warning" : "dcw-row", "data-row": p });
				if (c.kind === "harness") {
					const ref = c.ports?.[p - 1] ?? "", label = sub && portLabel(sub, ref);
					const full = label || `${ref}${sub ? " (missing)" : ""}`;
					// the block is a fixed width: cut long labels, the full text is in the tooltip
					const txt = el(g, "text", { x: c.x + 8, y: y + 14, class: label || !sub ? "dcw-signal" : "dcw-signal is-missing" }, full.length > 21 ? full.slice(0, 20) + "…" : full);
					el(txt, "title", {}, full);
					for (const x of [c.x, c.x + W]) el(g, "circle", { cx: x, cy: y + ROW / 2, r: 4, class: "dcw-pin", "data-pin": p, "data-comp": c.id });
					continue;
				}
				el(g, "text", { x: c.x + 10, y: y + 14, class: "dcw-pinno" }, cavName(c, p));
				if (c.nc?.includes(p)) { el(g, "text", { x: c.x + 34, y: y + 14, class: "dcw-signal is-nc" }, "N/C"); continue; } // no pin: can't be wired
				const own = c.signals?.[p];
				const sigs = own ? [own] : netSignals(h, { c: c.id, pin: p }, nets);
				const cls = own ? (c.globals?.includes(p) ? "dcw-signal is-global" : "dcw-signal") : sigs.length > 1 ? "dcw-signal is-conflict" : "dcw-signal is-inherited";
				if (sigs.length) el(g, "text", { x: c.x + 34, y: y + 14, class: cls }, sigs.join(" / "));
				for (const x of [c.x, c.x + W]) el(g, "circle", { cx: x, cy: y + ROW / 2, r: 4, class: "dcw-pin", "data-pin": p, "data-comp": c.id });
			}
			if (part) el(g, "text", { x: c.x, y: c.y + hgt + 14, class: "dcw-part" }, `${part.number}${part.manufacturer ? " · " + part.manufacturer : ""}`);
			if (c.layout) this.face(g, c, faceTop(c, !!part), lit);
		}
		for (const c of h.components) {
			const cw = warns.filter(x => x.kind === "component" && x.id === c.id);
			if (!cw.length) continue;
			const e = this.extent(c);
			el(el(this.g, "text", { x: e.x2 - 4, y: e.y1 + 14, class: "dcw-warnmark" }, "⚠"), "title", {}, cw.map(x => x.message).join("\n"));
		}
		drawWiringTables(this.g, this.host);
		// bend point handles of the selected wire, on top of everything
		for (const w of h.wires) if (sel?.wires?.includes(w.id)) (w.points ?? []).forEach((p, i) =>
			el(this.g, "rect", { x: p.x - 4, y: p.y - 4, width: 8, height: 8, class: "dcw-wp", "data-wp": `${w.id}:${i}` }));
		if (this.opts.dest && comps.length === 1) this.destinations(h.components.find(c => c.id === comps[0]));
		if (this.drag?.mode === "wire") this.g.appendChild(this.drag.line);
		if (this.drag?.mode === "box") this.g.appendChild(this.drag.rect);
	}

	/** Diode or resistor: a symbol between two pins, 1 on the left, 2 on the right. */
	private twoPin(g: SVGGElement, c: Component, part?: string) {
		const cy = c.y + 10, mid = c.x + DW / 2;
		el(g, "rect", { x: c.x, y: c.y, width: DW, height: 20, class: "dcw-grab" });
		el(g, "line", { x1: c.x, y1: cy, x2: c.x + DW, y2: cy, class: "dcw-lead" });
		if (c.kind === "resistor") el(g, "rect", { x: mid - 15, y: cy - 6, width: 30, height: 12, class: "dcw-symbol" });
		else {
			const s = c.flipped ? -1 : 1; // triangle points from anode to the cathode bar
			el(g, "path", { d: `M${mid - 8 * s} ${cy - 8} V${cy + 8} L${mid + 8 * s} ${cy} Z M${mid + 8 * s} ${cy - 8} V${cy + 8}`, class: "dcw-symbol" });
		}
		el(g, "text", { x: mid, y: c.y - 6, class: "dcw-label is-center" }, this.title(c));
		if (part) el(g, "text", { x: mid, y: c.y + 32, class: "dcw-part is-center" }, part);
		for (const p of [1, 2]) el(g, "circle", { cx: p === 1 ? c.x : c.x + DW, cy, r: 4, class: "dcw-pin", "data-pin": p, "data-comp": c.id });
	}

	private noteSize(c: Component) {
		const lines = (c.text || "Double-click to edit").split("\n");
		return { lines, w: Math.max(120, ...lines.map(l => l.length * 7 + 16)), h: 12 + lines.length * 16 };
	}

	private note(g: SVGGElement, c: Component) {
		const { lines, w, h } = this.noteSize(c), col = NOTE_COLORS.includes(c.color ?? "") ? c.color : "yellow";
		const r = el(g, "rect", { x: c.x, y: c.y, width: w, height: h, rx: 4, class: "dcw-note" });
		r.style.fill = `rgba(var(--color-${col}-rgb), 0.2)`;
		r.style.stroke = `rgb(var(--color-${col}-rgb))`;
		lines.forEach((l, i) => el(g, "text", { x: c.x + 8, y: c.y + 20 + i * 16, class: c.text ? "dcw-notetext" : "dcw-notetext is-empty" }, l));
	}

	/** An input next to each cavity of the selected connector or terminal: type "C2:3" and Enter to wire it there. */
	private destinations(c?: Component) {
		if (!c || (c.kind !== "connector" && c.kind !== "terminal")) return;
		const h = this.host.h, nets = computeNets(h);
		this.targets.empty();
		for (const o of h.components) for (let p = 1; p <= o.pins && o.kind !== "harness"; p++) {
			if (o.nc?.includes(p) || o === c) continue;
			const sig = netSignals(h, { c: o.id, pin: p }, nets)[0];
			this.targets.createEl("option", { value: o.pins === 1 ? o.id : `${o.id}:${cavName(o, p)}`, attr: { label: [compLabel(h, o), o.pins > 1 && cavName(o, p), sig].filter(Boolean).join(" · ") } });
		}
		for (let p = 1; p <= c.pins; p++) {
			if (c.nc?.includes(p)) continue;
			const fo = el(this.g, "foreignObject", { x: c.x + W + 10, y: c.y + HDR + (p - 1) * ROW + 1, width: 110, height: ROW - 2, "data-dest": p });
			const input = fo.appendChild(createEl("input", { cls: "dcw-dest", attr: { placeholder: "→ destination", list: this.targets.id } }));
			input.onkeydown = e => {
				if (e.key === "Escape") input.blur();
				if (e.key !== "Enter" || !input.value.trim()) return;
				const to = resolveTarget(h, input.value);
				if (typeof to === "string") return void new Notice(`DC Wiring: ${to}`);
				if (pinKey(to) === `${c.id}:${p}`) return;
				h.wires.push({ id: nextId(h, "W", h.wires), from: { c: c.id, pin: p }, to, color: "black", gauge: "", length: 0 });
				this.host.changed();
				// keep typing: on to the next cavity
				(this.g.querySelector(`[data-dest="${p + 1}"] input`) as HTMLInputElement | null)?.focus();
			};
		}
	}

	/** Everything a component draws: box, labels, part label and pin grid. The one place for this size. */
	private extent(c: Component): Rect {
		if (c.kind === "splice") return { x1: c.x - 12, y1: c.y - 24, x2: c.x + 12, y2: c.y + 26 };
		if (twoPin(c)) return { x1: c.x - 4, y1: c.y - 20, x2: c.x + DW + 4, y2: c.y + 36 };
		if (c.kind === "note") { const s = this.noteSize(c); return { x1: c.x, y1: c.y, x2: c.x + s.w, y2: c.y + s.h }; }
		const hasPart = this.host.h.parts.some(p => p.id === c.partId);
		let x1 = c.x, x2 = c.x + W, y2 = c.y + HDR + c.pins * ROW + (hasPart || (c.kind === "cable" && c.length) ? 18 : 0);
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

	/** Area auto route keeps wires out of. Splices, diodes and resistors are not obstacles: wires meet there. Notes neither. */
	private box(c: Component): Rect | undefined {
		if (c.kind !== "connector" && c.kind !== "terminal" && c.kind !== "harness") return;
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
			const cav = el(g, "circle", c.nc?.includes(p) ? { cx, cy, r: 7, class: "dcw-cavity is-nc", "data-row": p }
				: { cx, cy, r: 7, class: "dcw-pin dcw-cavity", "data-pin": p, "data-comp": c.id, "data-row": p });
			if (w) { cav.style.stroke = wireColors(effectiveWire(this.host.h, w).color)[0]; cav.addClass("is-wired"); } // inline: beats the .dcw-pin stroke
			if (lit && w && !lit.has(w.id)) cav.addClass("is-dim");
			el(g, "text", { x: cx, y: cy + 3, class: "dcw-cavno" }, cavName(c, p));
		}
	}

	private down(e: PointerEvent) {
		const t = e.target as Element;
		if ((e.button !== 0 && e.button !== 1) || t.closest("foreignObject")) return;
		const p = this.world(e);
		const pin = t.closest("[data-pin]");
		const comp = t.closest("[data-comp]");
		const wire = t.closest("[data-wire]");
		const mate = t.closest("[data-mate]");
		this.svg.setPointerCapture(e.pointerId);
		const bp = this.bendPoint(t);
		const sel = this.host.sel, cur = selComps(sel);
		const hdr = this.host.h.groups?.find(g => g.id === t.closest("[data-group-hdr]")?.getAttribute("data-group-hdr"));
		const img = this.host.h.images?.find(i => i.id === t.closest("[data-img]")?.getAttribute("data-img"));
		if (e.button === 1) { // middle-drag pans
			this.drag = { mode: "pan", sx: e.clientX, sy: e.clientY, px: this.view.x, py: this.view.y };
		} else if (bp) {
			this.drag = { mode: "bend", w: bp.w, i: bp.i, moved: false };
		} else if (hdr) {
			this.drag = { mode: "group", g: hdr, sx: p.x, sy: p.y, ox: 0, oy: 0 };
		} else if (img) {
			this.drag = { mode: "image", img, dx: p.x - img.x, dy: p.y - img.y, resize: t.hasAttribute("data-img-resize"), moved: false };
		} else if (mate) {
			const line = el(this.g, "line", { x1: p.x, y1: p.y, x2: p.x, y2: p.y, class: "dcw-temp is-mate" });
			this.drag = { mode: "wire", from: { c: mate.getAttribute("data-mate")!, pin: 0 }, line, kind: "mate" };
		} else if (pin) {
			const from = { c: pin.getAttribute("data-comp")!, pin: Number(pin.getAttribute("data-pin")) };
			const kind = e.metaKey || e.ctrlKey ? "move" : "wire";
			const line = el(this.g, "line", { x1: pin.getAttribute("cx")!, y1: pin.getAttribute("cy")!, x2: p.x, y2: p.y, class: kind === "move" ? "dcw-temp is-move" : "dcw-temp" });
			this.drag = { mode: "wire", from, line, kind };
		} else if (comp) {
			const id = comp.getAttribute("data-comp")!;
			if (e.shiftKey) return this.selectComps(cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]);
			const ids = cur.includes(id) && cur.length > 1 ? cur : [id];
			if (!ids.some(x => isLocked(this.host.h, x))) this.drag = { mode: "move", sx: p.x, sy: p.y, items: this.moveItems(ids), moved: false };
			if (ids.length === 1) this.host.select({ component: id });
		} else if (wire) {
			const id = wire.getAttribute("data-wire")!, ws = sel?.wires ?? [];
			if (!e.shiftKey) this.host.select({ wires: [id] });
			else this.host.select({ ...sel, wires: ws.includes(id) ? ws.filter(x => x !== id) : [...ws, id] });
		} else if (e.shiftKey) {
			this.drag = { mode: "box", x: p.x, y: p.y, rect: el(this.g, "rect", { x: p.x, y: p.y, width: 0, height: 0, class: "dcw-box" }) };
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
			const p = this.world(e), dx = snap(p.x - d.sx), dy = snap(p.y - d.sy), first = d.items[0];
			if (first && (first.o.x !== first.x + dx || first.o.y !== first.y + dy)) {
				for (const it of d.items) { it.o.x = it.x + dx; it.o.y = it.y + dy; }
				d.moved = true;
				this.render();
			}
		} else if (d.mode === "box") {
			const p = this.world(e);
			for (const [k, v] of Object.entries({ x: Math.min(p.x, d.x), y: Math.min(p.y, d.y), width: Math.abs(p.x - d.x), height: Math.abs(p.y - d.y) })) d.rect.setAttribute(k, String(v));
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
		const h = this.host.h;
		if (d.mode === "box") {
			d.rect.remove();
			const p = this.world(e), x1 = Math.min(p.x, d.x), x2 = Math.max(p.x, d.x), y1 = Math.min(p.y, d.y), y2 = Math.max(p.y, d.y);
			const hit = h.components.filter(c => { const r = this.extent(c); return r.x1 >= x1 && r.x2 <= x2 && r.y1 >= y1 && r.y2 <= y2; }).map(c => c.id);
			return this.selectComps([...new Set([...selComps(this.host.sel), ...hit])]);
		}
		if (d.mode !== "wire") return;
		d.line.remove();
		const under = document.elementFromPoint(e.clientX, e.clientY);
		if (d.kind === "mate") {
			const other = h.components.find(c => c.id === under?.closest("[data-comp]")?.getAttribute("data-comp"));
			const pair = (m: { a: string; b: string }) => [m.a, m.b].includes(d.from.c) && [m.a, m.b].includes(other!.id);
			if (other?.kind !== "connector" || other.id === d.from.c || h.mates?.some(pair)) return;
			h.mates = [...h.mates ?? [], { a: d.from.c, b: other.id }];
			const err = mateError(h, h.mates[h.mates.length - 1]);
			if (err) new Notice(`DC Wiring: ${d.from.c} and ${other.id} ${err}; their pins are not joined.`);
			return this.host.changed();
		}
		const pin = under?.closest("[data-pin]");
		if (!pin) return;
		const to = { c: pin.getAttribute("data-comp")!, pin: Number(pin.getAttribute("data-pin")) };
		if (pinKey(to) === pinKey(d.from)) return;
		if (d.kind === "move") return void (moveConnections(h, d.from, to) && this.host.changed());
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
		const t = e.target as Element, h = this.host.h, m = new Menu();
		if (t.closest("foreignObject")) return; // destination input: the normal text menu
		e.preventDefault();
		const wire = t.closest("[data-wire]")?.getAttribute("data-wire");
		const c = h.components.find(c => c.id === t.closest("[data-comp]")?.getAttribute("data-comp"));
		if (this.extraMenu(m, t, wire, c)) return m.showAtMouseEvent(e);
		if (wire) {
			m.addItem(i => i.setTitle("Edit wire").setIcon("pencil").onClick(() => this.host.editWire(wire)));
			const w = h.wires.find(w => w.id === wire)!;
			partItem(m, h, w, this.host.sel?.wires?.includes(wire) ? this.host.sel.wires.length : 1, () => this.host.pickPart(w), () => this.host.changed());
			m.addItem(i => i.setTitle("Select wires on net").setIcon("network").onClick(() => this.host.select({ wires: [...netWires(h, { wires: [wire] })] })));
			m.addItem(i => i.setTitle("Auto route").setIcon("route").onClick(() => { this.autoRoute([wire]); this.host.changed(); }));
			if (w.points?.length) m.addItem(i => i.setTitle("Clear bend points").setIcon("eraser").onClick(() => { delete w.points; this.host.changed(); }));
			m.addItem(i => i.setTitle("Delete wire").setIcon("trash").onClick(() => {
				h.wires = h.wires.filter(w => w.id !== wire);
				this.host.sel = null;
				this.host.changed();
			}));
		} else if (c) {
			const row = Number(t.closest("[data-row]")?.getAttribute("data-row"));
			if (row && (c.kind === "connector" || c.kind === "terminal")) {
				const nc = c.nc?.includes(row), global = c.globals?.includes(row);
				m.addItem(i => i.setTitle("Edit signal").setIcon("tag").onClick(() => this.host.editSignal(c, row)));
				if (c.signals?.[row]) m.addItem(i => i.setTitle(global ? "Make signal local" : "Make signal global").setIcon("globe").onClick(() => {
					toggleIn(c, "globals", row);
					this.host.changed();
				}));
				if (c.kind === "connector") {
					const own = c.contacts?.[row], cur = h.parts.find(p => p.id === loadedParts(h, c).find(l => l.pin === row && ["contact", "cavity-plug"].includes(h.parts.find(p => p.id === l.partId)?.type ?? ""))?.partId);
					const title = own === "" ? "Contact: none (change…)" : cur ? `Contact: ${cur.number || cur.id}${own === undefined ? " from configuration" : ""} (change…)` : "Assign contact…";
					m.addItem(i => i.setTitle(title).setIcon("pin").onClick(() => this.host.pickContact(c, row)));
				}
				m.addItem(i => i.setTitle(nc ? "Clear not connected" : "Mark as not connected").setIcon("circle-slash").onClick(() => {
					if (!nc && h.wires.some(w => pinKey(w.from) === `${c.id}:${row}` || pinKey(w.to) === `${c.id}:${row}`)) return void new Notice("DC Wiring: remove the wires on this cavity first.");
					toggleIn(c, "nc", row);
					this.host.changed();
				}));
				m.addSeparator();
			}
			const many = selComps(this.host.sel);
			if (many.length > 1 && many.includes(c.id)) {
				m.addItem(i => i.setTitle(`Duplicate ${many.length} components`).setIcon("copy").onClick(() => {
					this.host.sel = { components: duplicate(h, many) };
					this.host.changed();
				}));
				m.addItem(i => i.setTitle(`Delete ${many.length} components`).setIcon("trash").onClick(() => {
					for (const id of many) removeComponent(h, id);
					this.host.sel = null;
					this.host.changed();
				}));
				m.addSeparator();
			}
			if (c.kind === "diode") m.addItem(i => i.setTitle("Flip direction").setIcon("arrow-left-right").onClick(() => {
				if (c.flipped) delete c.flipped; else c.flipped = true;
				this.host.changed();
			}));
			for (const mt of h.mates ?? []) if (mt.a === c.id || mt.b === c.id) m.addItem(i => i.setTitle(`Unmate ${mt.a === c.id ? mt.b : mt.a}`).setIcon("unlink").onClick(() => {
				h.mates = h.mates!.filter(x => x !== mt);
				if (!h.mates.length) delete h.mates;
				this.host.changed();
			}));
			const kind = c.kind === "harness" ? "sub-harness" : c.kind;
			if (c.kind === "harness") m.addItem(i => i.setTitle("Open sub-harness").setIcon("file-symlink").onClick(() => this.host.openSub(c)));
			m.addItem(i => i.setTitle(`Edit ${kind}`).setIcon("pencil").onClick(() => this.host.editComponent(c)));
			if (c.kind !== "note") partItem(m, h, c, many.includes(c.id) ? h.components.filter(x => many.includes(x.id) && x.kind === c.kind).length : 1, () => this.host.pickPart(c), () => this.host.changed());
			wiringTableItem(m, c, this.host);
			m.addItem(i => i.setTitle(c.kind === "harness" ? "Remove sub-harness (keeps its file)" : `Delete ${kind}`).setIcon("trash").onClick(() => {
				removeComponent(h, c.id);
				this.host.sel = null;
				this.host.changed();
			}));
		} else {
			const p = this.world(e);
			m.addItem(i => i.setTitle("Add connector").setIcon("plug").onClick(() => this.add("connector", p.x, p.y)));
			m.addItem(i => i.setTitle("Add terminal").setIcon("circle-dot").onClick(() => this.add("terminal", p.x, p.y)));
			m.addItem(i => i.setTitle("Add splice").setIcon("git-merge").onClick(() => this.add("splice", p.x, p.y)));
			m.addItem(i => i.setTitle("Add cable").setIcon("cable").onClick(() => this.addCable(p.x, p.y)));
			m.addItem(i => i.setTitle("Add image…").setIcon("image").onClick(() => this.host.addImage(snap(p.x), snap(p.y))));
			m.addItem(i => i.setTitle("Add diode").setIcon("triangle-right").onClick(() => this.add("diode", p.x, p.y)));
			m.addItem(i => i.setTitle("Add resistor").setIcon("rectangle-horizontal").onClick(() => this.add("resistor", p.x, p.y)));
			m.addItem(i => i.setTitle("Add note").setIcon("sticky-note").onClick(() => this.add("note", p.x, p.y)));
			m.addItem(i => i.setTitle("Add sub-harness…").setIcon("layers").onClick(() => this.host.addSub(snap(p.x), snap(p.y))));
			m.addItem(i => i.setTitle("Fit to view").setIcon("maximize").onClick(() => this.fit()));
		}
		m.showAtMouseEvent(e);
	}

	/** Middle of the visible canvas, snapped to the grid, stepped aside while something already sits there. */
	center() {
		const r = this.svg.getBoundingClientRect();
		let x = snap((r.width / 2 - this.view.x) / this.view.z), y = snap((r.height / 2 - this.view.y) / this.view.z);
		// a new 4-pin connector's box, plus a gap; move down until it overlaps nothing
		const free = () => !this.host.h.components.some(c => {
			const e = this.extent(c);
			return x < e.x2 + GRID && x + W > e.x1 - GRID && y < e.y2 + GRID && y + HDR + 4 * ROW > e.y1 - GRID;
		});
		for (let i = 0; i < 100 && !free(); i++) y += GRID;
		return { x, y };
	}

	add(kind: Exclude<Component["kind"], "harness" | "cable">, x?: number, y?: number) {
		const h = this.host.h;
		if (x === undefined || y === undefined) ({ x, y } = this.center());
		const id = nextId(h, PREFIX[kind], h.components);
		const pins = { connector: 4, splice: 1, terminal: 1, diode: 2, resistor: 2, note: 0 }[kind];
		// name = id means "no label"; the label is set in the edit dialog
		h.components.push({ id, kind, name: id, x: snap(x), y: snap(y), pins, ...kind === "terminal" ? { terminal: "ring" } : {} });
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
		// length under the box with the part: in the title row a long name ran into it
		const below = [part, c.length ? formatLength(c.length, this.host.h.lengthUnit) : ""].filter(Boolean).join(" · ");
		if (below) el(g, "text", { x: c.x, y: c.y + hgt + 14, class: "dcw-part" }, below);
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
			const n = selComps(this.host.sel).includes(c.id) ? selComps(this.host.sel).length : 1;
			m.addItem(i => i.setTitle(n > 1 ? `Add ${n} components to group…` : "Add to group…").setIcon("group").onClick(() => this.host.pickGroup(c)));
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
