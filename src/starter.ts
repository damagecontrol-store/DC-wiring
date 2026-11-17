// The starter parts library: common generic connectors with their accessories and drawn face views.
// Pure: no Obsidian imports, so tests can load it.
// Sources: Deutsch DT Family catalog pp. 18–21; TE catalog 1654292-2 (AMP Superseal 1.5, 06-2016);
// Sumitomo DL Sealed Series 2.3 mm (090) catalog M-02..M-06. Cavity numbers inside the arrangement are not in
// these catalogs (they are molded on the housing), so STARTER_FACES numbering must be checked against a real housing.

import { emptyHarness, nextId, type Configuration, type Harness, type Part } from "./model.ts";
import { copyPart } from "./library.ts";

export const STARTER_DIR = "DC Wiring starter parts";
export const STARTER_LIB = `${STARTER_DIR}/Starter parts.DClib`;

/** Cavity numbers by row, as seen from the mating face. */
export const STARTER_FACES: Record<string, number[][]> = {};

const seq = (a: number, b: number) => Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => a < b ? a + i : a - i);
const grid = (rows: number, cols: number) => Array.from({ length: rows }, (_, r) => seq(r * cols + 1, r * cols + cols));
const mirror = (rows: number[][]) => rows.map(r => [...r].reverse());

const DT: [number, string, string, number[][]][] = [
	[2, "DT04-2P", "DT06-2S", [[1, 2]]],
	[3, "DT04-3P", "DT06-3S", [[1, 2], [3]]],
	[4, "DT04-4P", "DT06-4S", [[1, 2], [4, 3]]],
	[6, "DT04-6P", "DT06-6S", [[1, 6], [2, 5], [3, 4]]],
	[8, "DT04-08PA", "DT06-08SA", [seq(1, 4), seq(8, 5)]],
	[12, "DT04-12PA", "DT06-12SA", [seq(1, 6), seq(12, 7)]],
];
const SUPERSEAL: [number, string, string][] = [
	[1, "282103-1", "282079-2"], [2, "282104-1", "282080-1"], [3, "282105-1", "282087-1"],
	[4, "282106-1", "282088-1"], [5, "282107-1", "282089-1"], [6, "282108-1", "282090-1"],
];
const DL: [number, string, string, number[][]][] = [
	[1, "6195-0240", "6195-0066", [[1]]], [2, "6195-0006", "6195-0003", grid(1, 2)], [3, "6195-0012", "6195-0009", grid(1, 3)],
	[4, "6195-0018", "6195-0015", grid(2, 2)], [6, "6195-0024", "6195-0021", grid(2, 3)], [8, "6195-0054", "6195-0051", grid(2, 4)],
	[12, "6195-0152", "6195-0149", grid(3, 4)], [16, "6188-0495", "6189-0715", grid(4, 4)],
];

/** The starter parts as a library file: housings first by family, each with a "Standard" or per-wire-size configuration. */
export function starterLibrary(): Harness {
	const lib = emptyHarness();
	const add = (p: Omit<Part, "id" | "price">) => {
		const part = { id: nextId(lib, "P", lib.parts), price: 0, ...p } as Part;
		lib.parts.push(part);
		return part.id;
	};
	const housing = (number: string, manufacturer: string, description: string, gender: string, rows: number[][], configurations: Configuration[]) => {
		STARTER_FACES[number] = rows;
		const n = rows.flat().length;
		add({ type: "connector", number, manufacturer, description, gender, cavities: n, designations: seq(1, n).map(String),
			image: `${STARTER_DIR}/images/${number}.svg`, configurations });
	};
	const std = (...items: Configuration["items"]): Configuration[] => [{ name: "Standard", items }];

	const TE_D = "TE Connectivity (Deutsch)";
	const pin = add({ type: "contact", number: "0460-202-16141", manufacturer: TE_D, description: "DT size 16 solid pin contact, 16–20 AWG",
		contactType: "crimp", gender: "pin", gaugeMin: "0.5 mm²", gaugeMax: "1.5 mm²" });
	const socket = add({ type: "contact", number: "0462-201-16141", manufacturer: TE_D, description: "DT size 16 solid socket contact, 16–20 AWG",
		contactType: "crimp", gender: "socket", gaugeMin: "0.5 mm²", gaugeMax: "1.5 mm²" });
	const dtPlug = add({ type: "cavity-plug", number: "114017", manufacturer: TE_D, description: "DT sealing plug, size 12/16", colour: "white" });
	for (const [w, rec, plug, rows] of DT) {
		const wp = add({ type: "lock", number: `W${w}P`, manufacturer: TE_D, description: `DT wedgelock for ${w} way receptacle` });
		const ws = add({ type: "lock", number: `W${w}S`, manufacturer: TE_D, description: `DT wedgelock for ${w} way plug` });
		housing(rec, TE_D, `DT receptacle, ${w} way (pin contacts)`, "male", rows,
			std({ partId: wp }, { partId: pin, apply: "connected" }, { partId: dtPlug, apply: "unconnected" }));
		housing(plug, TE_D, `DT plug, ${w} way (socket contacts)`, "female", mirror(rows),
			std({ partId: ws }, { partId: socket, apply: "connected" }, { partId: dtPlug, apply: "unconnected" }));
	}

	const TE = "TE Connectivity";
	const tab = add({ type: "contact", number: "282109-1", manufacturer: TE, description: "Superseal 1.5 tab contact, tin, 0.75–1.5 mm²",
		contactType: "crimp", gender: "pin", gaugeMin: "0.75 mm²", gaugeMax: "1.5 mm²" });
	const rcpt = add({ type: "contact", number: "282110-1", manufacturer: TE, description: "Superseal 1.5 receptacle contact, tin, 0.75–1.5 mm²",
		contactType: "crimp", gender: "socket", gaugeMin: "0.75 mm²", gaugeMax: "1.5 mm²" });
	const seal = add({ type: "cavity-seal", number: "281934-2", manufacturer: TE, description: "Superseal 1.5 wire seal, insulation 1.7–2.4 mm", colour: "yellow" });
	const ssPlug = add({ type: "cavity-plug", number: "282081-1", manufacturer: TE, description: "Superseal 1.5 cavity plug", colour: "red" });
	for (const [w, cap, plug] of SUPERSEAL) {
		const rows = [seq(1, w)];
		housing(cap, TE, `Superseal 1.5 cap housing, ${w} way (tab contacts)`, "male", rows,
			std({ partId: tab, apply: "connected" }, { partId: seal, apply: "connected" }, { partId: ssPlug, apply: "unconnected" }));
		housing(plug, TE, `Superseal 1.5 plug housing, ${w} way (receptacle contacts)`, "female", mirror(rows),
			std({ partId: rcpt, apply: "connected" }, { partId: seal, apply: "connected" }, { partId: ssPlug, apply: "unconnected" }));
	}

	const SWS = "Sumitomo Wiring Systems";
	const term = (number: string, gender: string, lo: string, hi: string) => add({ type: "contact", number, manufacturer: SWS,
		description: `DL 090 ${gender === "pin" ? "male" : "female"} terminal, tin, ${lo}–${hi} mm²`, contactType: "crimp", gender, gaugeMin: `${lo} mm²`, gaugeMax: `${hi} mm²` });
	const mS = term("8230-4472", "pin", "0.3", "0.5"), fS = term("8100-1427", "socket", "0.3", "0.5");
	const mM = term("8230-4562", "pin", "0.75", "0.85"), fM = term("8100-1429", "socket", "0.75", "0.85");
	const sealS = add({ type: "cavity-seal", number: "7165-0516", manufacturer: SWS, description: "DL 090 wire seal, cable diameter 1.4–1.6 mm", colour: "black" });
	const sealM = add({ type: "cavity-seal", number: "7165-0515", manufacturer: SWS, description: "DL 090 wire seal, cable diameter 1.6–2.4 mm", colour: "gray" });
	// shortcut: no dummy plug in the configurations, the catalog doesn't say which of 7161-9787 / 7165-0193 fits which housing
	const sizes = (t: string, m: string): Configuration[] => [
		{ name: "0.3–0.5 mm²", items: [{ partId: t, apply: "connected" }, { partId: sealS, apply: "connected" }] },
		{ name: "0.75–0.85 mm²", items: [{ partId: m, apply: "connected" }, { partId: sealM, apply: "connected" }] },
	];
	for (const [w, male, female, rows] of DL) {
		housing(male, SWS, `DL 090 sealed male housing, ${w} way`, "male", rows, sizes(mS, mM));
		housing(female, SWS, `DL 090 sealed female housing, ${w} way`, "female", mirror(rows), sizes(fS, fM));
	}
	return lib;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** A face view: rows centred (so a DT 3 way is a triangle), one numbered circle per cavity. Fixed colours: it renders as an image. */
export function faceSvg(number: string, rows: number[][]): string {
	const P = 40, cols = Math.max(...rows.map(r => r.length));
	const w = Math.max(cols * P + 40, 200), h = rows.length * P + 80, left = (w - cols * P) / 2;
	const cells = rows.flatMap((r, y) => r.map((n, x) => {
		const cx = left + (cols - r.length) * P / 2 + x * P + P / 2, cy = 40 + y * P + P / 2;
		return `<circle cx="${cx}" cy="${cy}" r="14" fill="#fff" stroke="#333" stroke-width="2"/><text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="14">${n}</text>`;
	}));
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="sans-serif">`
		+ `<rect width="${w}" height="${h}" fill="#f4f4f4"/>`
		+ `<text x="${w / 2}" y="24" text-anchor="middle" font-size="15" font-weight="bold">${esc(number)}</text>`
		+ `<rect x="${left - 10}" y="34" width="${cols * P + 20}" height="${rows.length * P + 12}" rx="10" fill="#ccc" stroke="#333" stroke-width="2"/>`
		+ cells.join("")
		+ `<text x="${w / 2}" y="${h - 10}" text-anchor="middle" font-size="11" fill="#555">Mating face, not to scale</text></svg>`;
}

/** The library to write: a fresh one, or `existing` with every starter part added or reset by part number. Plus the face images by vault path. */
export function installStarter(existing?: Harness): { lib: Harness; images: Record<string, string> } {
	const base = starterLibrary();
	const lib = existing ?? base;
	if (existing) for (const p of base.parts) copyPart(p, base, existing);
	const images = Object.fromEntries(base.parts.filter(p => p.type === "connector").map(p => [p.image!, faceSvg(p.number, STARTER_FACES[p.number])]));
	return { lib, images };
}
