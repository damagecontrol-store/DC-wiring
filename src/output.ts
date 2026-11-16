// Export menu and commands: writes CSV, SVG and HTML files next to the harness in the vault.
import { arrayBufferToBase64, Menu, Notice, Platform, TFile } from "obsidian";
import { bomTable, connectionsTable, csv, cutList, reportHtml, wiringTables } from "./export.ts";
import { Schematic } from "./schematic.ts";
import { FormModal, freePath } from "./ui.ts";
import type { HarnessView } from "./view.ts";


async function save(v: HarnessView, suffix: string, ext: string, text: string) {
	const f = v.file;
	if (!f) return;
	const path = freePath(v.app, f.parent?.path ?? "", `${f.basename} ${suffix}`, ext);
	await v.app.vault.create(path, text);
	new Notice(`DC Wiring: exported ${path}`);
}

// presentation properties the canvas sets through CSS classes and Obsidian variables
const PROPS = ["fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity", "font-size", "font-family", "font-weight", "font-style", "text-anchor", "paint-order"];

const MIME: Record<string, string> = { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/** The schematic as a standalone SVG, in light theme colours, without selection or grid. Canvas images are embedded. */
async function schematicSvg(v: HarnessView): Promise<string> {
	// read first: the theme swap below must stay synchronous. Obsidian's own image urls don't work outside the app
	const embedded = new Map<string, string>();
	for (const i of v.h.images ?? []) {
		const f = v.app.vault.getAbstractFileByPath(i.path);
		if (f instanceof TFile) embedded.set(i.id, `data:${MIME[f.extension.toLowerCase()] ?? "application/octet-stream"};base64,${arrayBufferToBase64(await v.app.vault.readBinary(f))}`);
	}
	const s = new Schematic(v), sel = v.sel, body = document.body, dark = body.hasClass("theme-dark");
	v.sel = null;
	s.svg.setAttribute("style", "position:fixed;left:-10000px;top:0;width:100px;height:100px"); // laid out, so styles compute
	v.contentEl.appendChild(s.svg);
	// all synchronous, so the theme swap is never painted
	if (dark) body.classList.replace("theme-dark", "theme-light");
	try {
		s.render();
		const g = s.svg.querySelector(":scope > g") as SVGGElement;
		g.querySelector("[data-bg]")?.remove();
		for (const img of Array.from(g.querySelectorAll("[data-img] image"))) {
			const src = embedded.get(img.parentElement!.getAttribute("data-img")!);
			if (src) img.setAttribute("href", src); else img.remove();
		}
		for (const e of Array.from(g.querySelectorAll("*"))) {
			const cs = getComputedStyle(e);
			e.setAttribute("style", PROPS.map(p => `${p}:${cs.getPropertyValue(p)}`).join(";"));
		}
		const b = g.getBBox(), m = 20, bg = getComputedStyle(s.svg).backgroundColor;
		const [x, y, w, h] = [b.x - m, b.y - m, b.width + 2 * m, b.height + 2 * m].map(Math.round);
		g.removeAttribute("transform");
		return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}" width="${w}" height="${h}">`
			+ `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${bg}"/>${new XMLSerializer().serializeToString(g)}</svg>`;
	} finally {
		if (dark) body.classList.replace("theme-light", "theme-dark");
		s.svg.remove();
		v.sel = sel;
	}
}

const today = () => new Date().toISOString().slice(0, 10);
const report = async (v: HarnessView) => reportHtml(v.h, { title: v.file?.basename, date: today(), ...v.h.export }, await schematicSvg(v), v.subParts());

/** Prints the report with the system dialog, which offers "Save as PDF". */
async function print(v: HarnessView) {
	const html = await report(v);
	const f = document.body.createEl("iframe", { attr: { style: "position:fixed;width:0;height:0;border:0" } });
	f.onload = () => {
		f.contentWindow!.addEventListener("afterprint", () => f.remove());
		f.contentWindow!.print();
	};
	f.srcdoc = html;
}

function editTitleBlock(v: HarnessView) {
	const t = v.h.export ?? {};
	new FormModal(v.app, "Title block and notes", [
		{ key: "company", label: "Company", value: t.company ?? "" },
		{ key: "title", label: "Title (empty: file name)", value: t.title ?? "" },
		{ key: "drawing", label: "Drawing number", value: t.drawing ?? "" },
		{ key: "date", label: "Date (empty: today)", value: t.date ?? "" },
		{ key: "drawnBy", label: "Drawn by", value: t.drawnBy ?? "" },
		{ key: "notes", label: "Notes", value: t.notes ?? "" },
	], vals => {
		const kept = Object.fromEntries(Object.entries(vals).map(([k, s]) => [k, s.trim()]).filter(([, s]) => s));
		if (Object.keys(kept).length) v.h.export = kept; else delete v.h.export;
		v.changed();
	}).open();
}

export const EXPORTS: { id: string; name: string; run: (v: HarnessView) => unknown; desktop?: boolean }[] = [
	{ id: "export-bom", name: "Export BOM (CSV)", run: v => save(v, "BOM", "csv", csv(bomTable(v.h, v.subParts()))) },
	{ id: "export-connections", name: "Export connections (CSV)", run: v => save(v, "Connections", "csv", csv(connectionsTable(v.h))) },
	{ id: "export-wiring-tables", name: "Export wiring tables per connector (CSV)", run: v => save(v, "Wiring tables", "csv", csv(wiringTables(v.h))) },
	{ id: "export-cut-list", name: "Export cut list (CSV)", run: v => save(v, "Cut list", "csv", csv(cutList(v.h))) },
	{ id: "export-schematic-svg", name: "Export schematic (SVG)", run: async v => save(v, "Schematic", "svg", await schematicSvg(v)) },
	{ id: "export-report", name: "Export report (HTML)", run: async v => save(v, "Report", "html", await report(v)) },
	{ id: "print-report", name: "Print report / save as PDF", run: print, desktop: true },
	{ id: "edit-title-block", name: "Edit title block and notes", run: editTitleBlock },
];

export function exportMenu(v: HarnessView, e: MouseEvent) {
	const m = new Menu();
	for (const x of EXPORTS) if (!x.desktop || Platform.isDesktopApp) m.addItem(i => i.setTitle(x.name).onClick(() => x.run(v)));
	m.showAtMouseEvent(e);
}
