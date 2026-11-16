import { FuzzySuggestModal, Modal, Setting, TFile, type App } from "obsidian";
import { Picker } from "./ui.ts";
import type { Harness, Part, PartType } from "./model.ts";
import { HAS_CONFIGS, PART_TYPES, type PartField } from "./parts.ts";
import { formatCores, parseCores } from "./cable.ts";

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
	/** manufacturers: names used in this harness and the libraries, suggested while typing so they are spelled one way */
	constructor(app: App, private h: Harness, private p: Part, private done: () => void, private manufacturers: string[] = []) { super(app); }

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
		// redrawing empties the dialog, which would jump it back to the top
		const top = this.modalEl.scrollTop, inner = el.scrollTop;
		window.setTimeout(() => { this.modalEl.scrollTop = top; el.scrollTop = inner; });
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
			if (f.kind === "cores") s.addText(t => t.setValue(formatCores(p.coreList)).onChange(v => {
				const cores = parseCores(v);
				set("coreList", cores.length ? cores : undefined);
				set("cores", cores.length || undefined);
			}));
			else if (f.kind === "bool") s.addToggle(t => t.setValue(!!rec[f.key]).onChange(v => set(f.key, v)));
			else if (f.options) s.addDropdown(d => d.addOption("", "—").addOptions(Object.fromEntries(f.options!.map(o => [o, o])))
				.setValue(String(rec[f.key] ?? "")).onChange(v => set(f.key, v)));
			else if (f.kind === "list") s.addText(t => t.setValue((rec[f.key] as string[] | undefined)?.join(", ") ?? "").onChange(v => {
				const list = v.split(",").map(x => x.trim());
				set(f.key, list.some(Boolean) ? list : undefined);
			}));
			else s.addText(t => {
				t.setValue(String(rec[f.key] ?? "")).onChange(v => {
					set(f.key, f.kind === "number" ? (v.trim() ? Number(v) : undefined) : v.trim());
					if (f.key === "number") this.titleEl.setText(`Part ${v.trim() || p.id}`);
				});
				if (f.key === "manufacturer" && this.manufacturers.length) {
					const list = el.createEl("datalist", { attr: { id: `dcw-mfr-${p.id}` } });
					for (const m of this.manufacturers) list.createEl("option", { value: m });
					t.inputEl.setAttr("list", list.id);
				}
			});
		};
		[...COMMON, ...(p.type ? PART_TYPES[p.type].fields : []), { key: "excludeFromBom", label: "Exclude from BOM", kind: "bool" } as PartField].forEach(field);
		this.drawImage();
		if (p.type && HAS_CONFIGS.includes(p.type)) this.drawConfigs();
		new Setting(el).addButton(b => b.setButtonText("Done").setCta().onClick(() => this.close()));
	}

	/** A picture of the part: any image file in the vault. */
	private drawImage() {
		const { p, contentEl: el } = this;
		const file = p.image ? this.app.vault.getAbstractFileByPath(p.image) : null;
		const s = new Setting(el).setName("Image").setDesc(p.image && !file ? `${p.image} is missing` : "")
			.addButton(b => b.setButtonText(p.image ? "Change…" : "Choose…").onClick(() => {
				const files = this.app.vault.getFiles().filter(f => /^(png|jpe?g|gif|svg|webp)$/i.test(f.extension));
				new Picker(this.app, "Choose an image from the vault", files, f => f.path, f => { p.image = f.path; this.draw(); }).open();
			}));
		if (p.image) s.addExtraButton(b => b.setIcon("x").setTooltip("Remove image").onClick(() => { delete p.image; this.draw(); }));
		if (file instanceof TFile) el.createEl("img", { cls: "dcw-part-image", attr: { src: this.app.vault.getResourcePath(file), alt: p.number || p.id } });
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
				.addExtraButton(b => b.setIcon("copy").setTooltip("Duplicate configuration").onClick(() => {
					cfs.splice(cfs.indexOf(cf) + 1, 0, { name: `${cf.name} copy`, items: cf.items.map(i => ({ ...i })) });
					this.draw();
				}))
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
