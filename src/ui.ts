import { App, FuzzySuggestModal, Modal, normalizePath, renderMatches, Setting, type FuzzyMatch, type SearchMatches } from "obsidian";

export interface Field {
	key: string;
	label: string;
	value: string;
	options?: Record<string, string>; // value -> label; turns the field into a dropdown
	preview?: (v: string) => string; // shown under the field while typing, e.g. the result of a calculation
	multiline?: boolean; // text area: Enter adds a line instead of saving
}

/** One small form for every edit dialog. Calls onSubmit with the edited values. */
export class FormModal extends Modal {
	constructor(app: App, private heading: string, private fields: Field[], private onSubmit: (v: Record<string, string>) => void) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText(this.heading);
		const values: Record<string, string> = {};
		const submit = () => { this.close(); this.onSubmit(values); };
		for (const f of this.fields) {
			values[f.key] = f.value;
			const s = new Setting(this.contentEl).setName(f.label);
			if (f.options) s.addDropdown(d => d.addOptions(f.options!).setValue(f.value).onChange(v => values[f.key] = v));
			else if (f.multiline) s.addTextArea(t => t.setValue(f.value).onChange(v => values[f.key] = v));
			else s.addText(t => {
				t.setValue(f.value).onChange(v => { values[f.key] = v; if (f.preview) s.setDesc(f.preview(v)); });
				if (f.preview) s.setDesc(f.preview(f.value));
				t.inputEl.addEventListener("keydown", e => { if (e.key === "Enter") submit(); });
			});
		}
		new Setting(this.contentEl).addButton(b => b.setButtonText("Save").setCta().onClick(submit));
		(this.contentEl.querySelector("input, select") as HTMLElement | null)?.focus();
	}

	onClose() { this.contentEl.empty(); }
}

// DIN 47100 / VW-style abbreviations used on automotive drawings.
const ABBR: Record<string, string> = {
	sw: "black", bk: "black", ws: "white", wh: "white", rt: "red", rd: "red", gn: "green", bl: "blue", bu: "blue",
	ge: "yellow", ye: "yellow", br: "saddlebrown", bn: "saddlebrown", brown: "saddlebrown", or: "orange", og: "orange",
	vi: "violet", vt: "violet", gr: "grey", gy: "grey", rs: "pink", pk: "pink",
	// Dutch
	zwart: "black", wit: "white", rood: "red", groen: "green", blauw: "blue", geel: "yellow", bruin: "saddlebrown",
	oranje: "orange", paars: "violet", grijs: "grey", roze: "pink",
};

// a name the browser doesn't know would draw no wire at all
const isColor = (c: string) => typeof CSS === "undefined" || CSS.supports("color", c);

/** "rd/wh" -> ["red", "white"]: base colour and optional stripe. */
export function wireColors(color: string): [string, string | undefined] {
	const [base, stripe] = color.toLowerCase().split(/[\/\-]/).map(s => s.trim()).map(s => ABBR[s] ?? s);
	return [base && isColor(base) ? base : "grey", stripe && isColor(stripe) ? stripe : undefined];
}

/** First unused path for a new file: "<name>.DC", then "<name> 2.DC", ... */
export function freePath(app: App, dir: string, name: string, ext = "DC"): string {
	for (let n = 1; ; n++) {
		const path = normalizePath(`${dir}/${name}${n > 1 ? " " + n : ""}.${ext}`);
		if (!app.vault.getAbstractFileByPath(path)) return path;
	}
}

/** Fuzzy list to pick one item from, optionally with a picture and a smaller second line of details per row. */
export class Picker<T> extends FuzzySuggestModal<T> {
	constructor(app: App, placeholder: string, private items: T[], private text: (t: T) => string, private done: (t: T) => void,
		private image?: (t: T) => string | undefined, private detail?: (t: T) => string) {
		super(app);
		this.setPlaceholder(placeholder);
	}
	getItems() { return this.items; }
	// search covers both lines: the title, a space, then the details
	getItemText(t: T) { const d = this.detail?.(t); return d ? `${this.text(t)} ${d}` : this.text(t); }
	onChooseItem(t: T) { this.done(t); }
	renderSuggestion(m: FuzzyMatch<T>, el: HTMLElement) {
		const src = this.image?.(m.item), detail = this.detail?.(m.item);
		if (!src && !detail) return super.renderSuggestion(m, el);
		el.addClass("dcw-suggest-rich");
		if (src) el.createEl("img", { attr: { src, alt: "" } });
		const box = el.createDiv(), title = this.text(m.item), cut = title.length + 1;
		const part = (a: number, b: number, shift: number): SearchMatches =>
			m.match.matches.filter(([s, e]) => s < b && e > a).map(([s, e]) => [Math.max(s, a) - shift, Math.min(e, b) - shift]);
		renderMatches(box.createDiv(), title, part(0, title.length, 0));
		if (detail) renderMatches(box.createDiv({ cls: "dcw-suggest-detail" }), detail, part(cut, cut + detail.length, cut));
	}
}

const SHORTCUTS: [string, [string, string][]][] = [
	["Schematic keys", [
		["Space", "Search components"], ["F", "Fit to view"], ["N", "Highlight the whole net or only direct wires"], ["I", "Show component IDs"],
		["D", "Destinations: type where each cavity of the selected connector goes"], ["Arrow keys", "Nudge the selection"],
		["Mod D", "Duplicate"], ["Mod C / Mod V", "Copy and paste components, also into another harness"],
		["Delete, Backspace or X", "Delete the selection"], ["Mod Z / Mod Shift Z", "Undo / redo"], ["Esc", "Clear the selection"], ["?", "This list"],
	]],
	["Schematic mouse", [
		["Right-click", "On the canvas: add components. On a component or wire: edit, assign a part, delete"], ["Drag pin to pin", "Draw a wire"],
		["Mod-drag from a pin", "Move that pin's wires to another pin"], ["Drag a connector's small square onto another", "Mate the two connectors"],
		["Double-click a wire", "Add a bend point; double-click the point to remove it"], ["Double-click a component", "Edit it"],
		["Shift-click / Shift-drag", "Add to the selection / box select"], ["Drag the canvas, middle-drag", "Pan"], ["Pinch or Mod-scroll", "Zoom"],
	]],
	["Layout", [
		["Drag from a connector's dot to another", "Lay a bundle"], ["Double-click a bundle", "Add a bend point"], ["Double-click a bundle's length", "Edit the bundle"],
		["Delete or Backspace", "Delete the selected bundle or branch point"],
	]],
];

/** Every key and mouse gesture, in one list (the ? key and the "Show shortcuts" command). */
export function showShortcuts(app: App) {
	const m = new Modal(app);
	m.titleEl.setText("DC Wiring shortcuts");
	const mod = navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl";
	for (const [title, rows] of SHORTCUTS) {
		m.contentEl.createEl("h4", { text: title });
		const t = m.contentEl.createEl("table", { cls: "dcw-shortcuts" });
		for (const [k, what] of rows) {
			const tr = t.createEl("tr");
			tr.createEl("td").createEl("kbd", { text: k.replace(/Mod/g, mod) });
			tr.createEl("td", { text: what });
		}
	}
	m.open();
}
