// Wiring table nodes on the schematic: a connector's wiring next to it, tethered, draggable.
import { Menu } from "obsidian";
import { wiringRows, type WiringRow } from "./export.ts";
import { computeNets, type Component } from "./model.ts";
import { W, type Host } from "./schematic.ts";

const NS = "http://www.w3.org/2000/svg";
const RH = 16, CH = 6; // row height, rough width of a 10px character
const COLS: [keyof WiringRow, string][] = [["cavity", "Cav"], ["signal", "Signal"], ["destination", "Destination"], ["wire", "Wire"], ["color", "Colour"], ["gauge", "Gauge"], ["length", "mm"]];

function el(parent: Element, tag: string, attrs: Record<string, string | number>, text?: string) {
	const e = document.createElementNS(NS, tag);
	for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
	if (text !== undefined) e.textContent = text;
	parent.appendChild(e);
	return e;
}

/** Draws the wiring table of every component that has one shown. g is the canvas's world group. */
export function drawWiringTables(g: SVGGElement, host: Host) {
	const h = host.h, nets = computeNets(h);
	for (const c of h.components) {
		const pos = c.wiringTable;
		if (!pos || c.kind === "harness") continue;
		const rows = wiringRows(h, c, nets).filter(r => r.wire);
		const cols = COLS.filter(([k]) => k === "cavity" || rows.some(r => r[k] !== ""));
		const widths = cols.map(([k, label]) => Math.max(label.length, ...rows.map(r => String(r[k]).length)) * CH + 12);
		const tw = widths.reduce((a, b) => a + b, 0), th = (rows.length + 1) * RH;

		const tether = el(g, "line", { class: "dcw-wt-tether" });
		const t = el(g, "g", { class: "dcw-wt" });
		el(t, "rect", { x: 0, y: 0, width: tw, height: th, rx: 3, class: "dcw-wt-body" });
		[cols.map(([, label]) => label), ...rows.map(r => cols.map(([k]) => String(r[k])))].forEach((cells, i) => {
			if (i) el(t, "line", { x1: 0, y1: i * RH, x2: tw, y2: i * RH, class: "dcw-sep" });
			let x = 0;
			cells.forEach((s, j) => { el(t, "text", { x: x + 6, y: i * RH + 12, class: i ? "dcw-wt-cell" : "dcw-wt-head" }, s); x += widths[j]; });
		});
		if (!rows.length) el(t, "text", { x: 6, y: RH + 12, class: "dcw-hint" }, "No wires");

		const place = () => {
			const x = c.x + pos.dx, y = c.y + pos.dy;
			t.setAttribute("transform", `translate(${x},${y})`);
			const ax = c.kind === "splice" ? c.x : x + tw / 2 < c.x + W / 2 ? c.x : c.x + W, ay = c.kind === "splice" ? c.y : c.y + 12;
			for (const [k, v] of Object.entries({ x1: ax, y1: ay, x2: x + tw / 2 < ax ? x + tw : x, y2: y + RH / 2 })) tether.setAttribute(k, String(v));
		};
		place();

		// own drag: the canvas handlers only know components, wires and bend points
		let drag: { sx: number; sy: number; dx: number; dy: number; moved: boolean } | null = null;
		const world = (e: PointerEvent) => new DOMPoint(e.clientX, e.clientY).matrixTransform(g.getScreenCTM()!.inverse());
		t.addEventListener("pointerdown", e => {
			if (e.button !== 0) return;
			e.stopPropagation();
			t.setPointerCapture(e.pointerId);
			const p = world(e);
			drag = { sx: p.x, sy: p.y, dx: pos.dx, dy: pos.dy, moved: false };
		});
		t.addEventListener("pointermove", e => {
			if (!drag) return;
			const p = world(e);
			pos.dx = Math.round(drag.dx + p.x - drag.sx);
			pos.dy = Math.round(drag.dy + p.y - drag.sy);
			drag.moved = true;
			place();
		});
		t.addEventListener("pointerup", () => { if (drag?.moved) host.changed(); drag = null; });
		t.addEventListener("contextmenu", e => {
			e.preventDefault();
			e.stopPropagation();
			const m = new Menu();
			m.addItem(i => i.setTitle("Hide wiring table").setIcon("eye-off").onClick(() => { delete c.wiringTable; host.changed(); }));
			m.showAtMouseEvent(e);
		});
	}
}

/** Context menu entry on a connector or splice. */
export function wiringTableItem(m: Menu, c: Component, host: Host) {
	if (c.kind === "harness") return;
	m.addItem(i => i.setTitle(c.wiringTable ? "Hide wiring table" : "Show wiring table").setIcon("table").onClick(() => {
		if (c.wiringTable) delete c.wiringTable;
		else c.wiringTable = c.kind === "splice" ? { dx: 40, dy: 20 } : { dx: W + 60, dy: 0 };
		host.changed();
	}));
}
