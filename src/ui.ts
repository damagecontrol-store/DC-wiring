import { App, FuzzySuggestModal, Modal, normalizePath, Setting } from "obsidian";

export interface Field {
	key: string;
	label: string;
	value: string;
	options?: Record<string, string>; // value -> label; turns the field into a dropdown
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
			else s.addText(t => {
				t.setValue(f.value).onChange(v => values[f.key] = v);
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

/** First unused path for a new harness: "<name>.harness", then "<name> 2.harness", ... */
export function freePath(app: App, dir: string, name: string): string {
	for (let n = 1; ; n++) {
		const path = normalizePath(`${dir}/${name}${n > 1 ? " " + n : ""}.harness`);
		if (!app.vault.getAbstractFileByPath(path)) return path;
	}
}

/** Fuzzy list to pick one item from. */
export class Picker<T> extends FuzzySuggestModal<T> {
	constructor(app: App, placeholder: string, private items: T[], private text: (t: T) => string, private done: (t: T) => void) {
		super(app);
		this.setPlaceholder(placeholder);
	}
	getItems() { return this.items; }
	getItemText(t: T) { return this.text(t); }
	onChooseItem(t: T) { this.done(t); }
}
