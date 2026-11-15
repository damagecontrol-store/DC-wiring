import { FuzzySuggestModal, Modal, Setting, type App, type TFile } from "obsidian";
import type { Harness, Part, PartType } from "./model.ts";
import { HAS_CONFIGS, PART_TYPES, type PartField } from "./parts.ts";

const COMMON: PartField[] = [
	{ key: "number", label: "Part number" },
	{ key: "internalNumber", label: "Internal part number" },
	{ key: "manufacturer", label: "Manufacturer" },
	{ key: "description", label: "Description" },
	{ key: "url", label: "URL" },
	{ key: "price", label: "Price (per piece, or per metre)", kind: "number" },
	{ key: "colour", label: "Colour" },
];
const REQUIRED = ["number", "manufacturer", "description", "price"];

/** Edits a part in place, showing the fields of its type. Calls done once on close, so the edit is one undo step. */
export class PartModal extends Modal {
	constructor(app: App, private h: Harness, private p: Part, private done: () => void) { super(app); }

	onOpen() { this.draw(); }

	onClose() {
		for (const cf of this.p.configurations ?? []) cf.items = cf.items.filter(i => i.partId);
		if (!this.p.configurations?.length || !HAS_CONFIGS.includes(this.p.type!)) delete this.p.configurations;
		this.contentEl.empty();
		this.done();
	}

	private draw() {
		const { p, contentEl: el } = this;
		const rec = p as unknown as Record<string, unknown>;
		el.empty();
		this.titleEl.setText(`Part ${p.number || p.id}`);
		// empty optional fields are dropped so the file stays small and library sync compares cleanly
		const set = (k: string, v: unknown) => {
			if (REQUIRED.includes(k)) rec[k] = v == null || Number.isNaN(v) ? (k === "price" ? 0 : "") : v;
			else if (v === "" || v === undefined || v === false || Number.isNaN(v)) delete rec[k];
			else rec[k] = v;
		};
		new Setting(el).setName("Type").addDropdown(d => d
			.addOption("", "Generic")
			.addOptions(Object.fromEntries(Object.entries(PART_TYPES).map(([k, t]) => [k, t.label.replace(/s$/, "")])))
			.setValue(p.type ?? "")
			.onChange(v => { set("type", v as PartType); this.draw(); }));
		const field = (f: PartField) => {
			const s = new Setting(el).setName(f.label);
			if (f.kind === "bool") s.addToggle(t => t.setValue(!!rec[f.key]).onChange(v => set(f.key, v)));
			else if (f.options) s.addDropdown(d => d.addOption("", "—").addOptions(Object.fromEntries(f.options!.map(o => [o, o])))
				.setValue(String(rec[f.key] ?? "")).onChange(v => set(f.key, v)));
			else s.addText(t => t.setValue(String(rec[f.key] ?? "")).onChange(v => {
				set(f.key, f.kind === "number" ? (v.trim() ? Number(v) : undefined) : v.trim());
				if (f.key === "number") this.titleEl.setText(`Part ${v.trim() || p.id}`);
			}));
		};
		[...COMMON, ...(p.type ? PART_TYPES[p.type].fields : []), { key: "excludeFromBom", label: "Exclude from BOM", kind: "bool" } as PartField].forEach(field);
		if (p.type && HAS_CONFIGS.includes(p.type)) this.drawConfigs();
		new Setting(el).addButton(b => b.setButtonText("Done").setCta().onClick(() => this.close()));
	}

	/** Configurations: named accessory lists. Contacts, plugs and seals get a rule for which cavities they go into. */
	private drawConfigs() {
		const { p, contentEl: el } = this;
		el.createEl("h4", { text: "Configurations" });
		const options = Object.fromEntries(this.h.parts.filter(x => x !== p).map(x => [x.id, `${x.number || x.id}${x.type ? " (" + x.type + ")" : ""}`]));
		const cfs = p.configurations ??= [];
		for (const cf of cfs) {
			new Setting(el).setName("Configuration").setDesc(cf === cfs[0] ? "Used unless a component picks another" : "")
				.addText(t => t.setValue(cf.name).onChange(v => cf.name = v.trim() || cf.name))
				.addExtraButton(b => b.setIcon("trash").setTooltip("Delete configuration").onClick(() => { cfs.splice(cfs.indexOf(cf), 1); this.draw(); }));
			for (const it of cf.items) {
				const type = this.h.parts.find(x => x.id === it.partId)?.type;
				const s = new Setting(el).setClass("dcw-config-item");
				s.addDropdown(d => d.addOption("", "— choose a part —").addOptions(options).setValue(it.partId).onChange(v => { it.partId = v; delete it.apply; this.draw(); }));
				if (type === "contact" || type === "cavity-plug" || type === "cavity-seal") s.addDropdown(d => d
					.addOptions({ connected: "Connected cavities", unconnected: "Unconnected cavities", never: "Never" })
					.setValue(it.apply ?? (type === "cavity-plug" ? "unconnected" : "connected"))
					.onChange(v => it.apply = v as typeof it.apply));
				s.addExtraButton(b => b.setIcon("x").setTooltip("Remove from configuration").onClick(() => { cf.items.splice(cf.items.indexOf(it), 1); this.draw(); }));
			}
			new Setting(el).setDesc("Contacts and plugs: each cavity takes the first that fits, so put specific gauge ranges first.")
				.addButton(b => b.setButtonText("Add accessory").onClick(() => { cf.items.push({ partId: "" }); this.draw(); }));
		}
		new Setting(el).addButton(b => b.setButtonText("Add configuration").onClick(() => {
			cfs.push({ name: cfs.length ? `Configuration ${cfs.length + 1}` : "Default", items: [] });
			this.draw();
		}));
	}
}

/** Pick a .harnesslib file, or null for a new library. */
export class LibraryPicker extends FuzzySuggestModal<TFile | null> {
	constructor(app: App, private files: TFile[], private pick: (f: TFile | null) => void) {
		super(app);
		this.setPlaceholder("Choose a part library, or create a new one");
	}
	getItems() { return [null, ...this.files]; }
	getItemText(f: TFile | null) { return f ? f.path : "＋ New part library"; }
	onChooseItem(f: TFile | null) { this.pick(f); }
}

export interface LibPart { lib: string; part: Part }

/** Pick a part from any library. */
export class LibPartPicker extends FuzzySuggestModal<LibPart> {
	constructor(app: App, private items: LibPart[], private pick: (x: LibPart) => void) {
		super(app);
		this.setPlaceholder("Add a library part to this harness");
	}
	getItems() { return this.items; }
	getItemText(x: LibPart) { return `${x.part.number} ${x.part.manufacturer} ${x.part.description} · ${x.lib}`; }
	onChooseItem(x: LibPart) { this.pick(x); }
}
