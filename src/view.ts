import { FuzzySuggestModal, Notice, TextFileView, TFile, type App, type WorkspaceLeaf } from "obsidian";
import { bom, emptyHarness, formatPins, nextId, parseHarness, parsePins, relinkSub, removeComponent, removePart, signalOf, subBom, syncPorts, type BomRow, type Component, type End, type Harness, type Part } from "./model.ts";
import { Schematic, type Host, type Selection } from "./schematic.ts";
import { FormModal, freePath, type Field } from "./ui.ts";
import { copyPart, syncStatus } from "./library.ts";
import { effectiveWire, PART_TYPES, setGaugeUnit } from "./parts.ts";
import { LibPartPicker, LibraryPicker, PartModal } from "./partview.ts";
import { GAUGE_UNITS, LENGTH_UNITS, type GaugeUnit, type LengthUnit } from "./units.ts";
import { validate } from "./validate.ts";

export const VIEW_TYPE = "dc-wiring-harness";
type Tab = "schematic" | "connections" | "parts";

export class HarnessView extends TextFileView implements Host {
	h: Harness = emptyHarness();
	sel: Selection = null;
	subs = new Map<string, Harness>();
	private parents: TFile[] = []; // harnesses that use this one as a sub-harness
	private tab: Tab = "schematic";
	private broken: string | null = null; // text of a file that failed to parse: saved back untouched
	private schematic = new Schematic(this);
	private bar!: HTMLElement;
	private body!: HTMLElement;
	private fitted = false;
	private history: string[] = []; // saved states, newest last; Cmd/Ctrl+Z steps back
	libs = new Map<string, Harness>(); // part libraries in the vault, by path
	private partSort: { key: string; dir: number } = { key: "", dir: 1 };
	private partFilter = "";

	constructor(leaf: WorkspaceLeaf) { super(leaf); }

	getViewType() { return VIEW_TYPE; }
	getDisplayText() { return this.file?.basename ?? "Harness"; }
	getIcon() { return "cable"; }
	// Obsidian writes this back whenever a view closes, so a broken file must get its own text back
	getViewData() { return this.broken ?? JSON.stringify(this.h, null, "\t"); }

	setViewData(data: string, clear: boolean) {
		try {
			this.h = parseHarness(data);
			this.broken = null;
		} catch (e) {
			this.h = emptyHarness();
			this.broken = data;
			new Notice(`DC Wiring: ${this.file?.name} can't be read (${(e as Error).message}). Editing is disabled so the file is not overwritten.`);
		}
		this.history = [this.getViewData()]; // a new or externally changed file starts a fresh undo list
		// fit when a file opens with content; an empty one stays at 100% while you add the first parts
		if (clear) { this.sel = null; this.fitted = !this.h.components.length; }
		this.render();
		void this.loadLinks();
	}

	/** Loads sub-harness files (recursively) and finds parent harnesses, then refreshes block pins. */
	private async loadLinks() {
		const vault = this.app.vault, me = this.file?.path;
		const read = async (path: string) => {
			const f = vault.getAbstractFileByPath(path);
			if (!(f instanceof TFile)) return;
			try { return parseHarness(await vault.cachedRead(f)); } catch { return; }
		};
		const subs = new Map<string, Harness>();
		const walk = async (h: Harness) => {
			for (const c of h.components) {
				if (c.kind !== "harness" || !c.file || subs.has(c.file)) continue;
				const sub = await read(c.file);
				if (!sub) continue;
				subs.set(c.file, sub);
				await walk(sub);
			}
		};
		await walk(this.h);
		const parents: TFile[] = [];
		for (const f of vault.getFiles()) {
			if (f.extension !== "harness" || f.path === me) continue;
			const p = await read(f.path);
			if (p?.components.some(c => c.kind === "harness" && c.file === me)) parents.push(f);
		}
		const libs = new Map<string, Harness>();
		for (const f of vault.getFiles()) if (f.extension === "harnesslib" && f.path !== me) {
			const lib = await read(f.path);
			if (lib) libs.set(f.path, lib);
		}
		if (this.file?.path !== me) return; // switched files while loading
		this.libs = libs;
		this.subs = subs;
		this.parents = parents;
		let changed = false;
		for (const c of this.h.components) {
			const sub = c.kind === "harness" && c.file ? subs.get(c.file) : undefined;
			if (sub && syncPorts(c, sub)) changed = true;
		}
		if (changed && this.broken === null) this.requestSave();
		this.render();
	}

	openSub(c: Component) {
		if (!c.file) return;
		const f = this.app.vault.getAbstractFileByPath(c.file);
		if (!(f instanceof TFile)) return void new Notice(`DC Wiring: ${c.file} not found.`);
		void this.app.workspace.getLeaf(false).openFile(f); // not openLinkText: "#" in a name would read as a heading
	}

	addSub(x: number, y: number) {
		const me = this.file;
		if (!me) return;
		new SubPicker(this.app, me, async file => {
			if (!file) {
				file = await this.app.vault.create(freePath(this.app, me.parent?.path ?? "", `${me.basename} - Sub`), JSON.stringify(emptyHarness(), null, "\t"));
			}
			this.h.components.push({ id: nextId(this.h, "H", this.h.components), kind: "harness", name: file.basename, x, y, pins: 0, file: file.path, ports: [] });
			this.changed();
			await this.loadLinks();
		}).open();
	}

	clear() { this.h = emptyHarness(); this.sel = null; }

	// A harness opened in a background tab has no size yet: fit once it is shown.
	onResize() { this.fitInitially(); }

	private fitInitially() {
		if (!this.fitted && this.tab === "schematic") this.fitted = this.schematic.fit();
	}

	async onOpen() {
		this.contentEl.addClass("dcw-view");
		this.contentEl.tabIndex = 0;
		this.bar = this.contentEl.createDiv("dcw-bar");
		this.body = this.contentEl.createDiv("dcw-body-wrap");
		// a linked harness changed: refresh sub-harness blocks, BOM roll-up and the "Part of" links
		const onVault = (f: unknown) => { if (f instanceof TFile && (f.extension === "harness" || f.extension === "harnesslib") && f !== this.file) void this.loadLinks(); };
		this.registerEvent(this.app.vault.on("modify", onVault));
		this.registerEvent(this.app.vault.on("delete", onVault));
		this.registerEvent(this.app.vault.on("rename", (f, oldPath) => {
			if (this.broken === null && relinkSub(this.h, oldPath, f.path)) this.requestSave();
			onVault(f);
		}));
		this.registerDomEvent(this.contentEl, "keydown", e => {
			if ((e.target as HTMLElement).closest("input, select, textarea")) return;
			// delete only where the selection is visible
			if ((e.key === "Delete" || e.key === "Backspace") && this.tab === "schematic") this.deleteSelection();
			if (e.key === "Escape") this.select(null);
			if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z") { e.preventDefault(); this.undo(); }
		});
	}

	// --- Host ---
	select(sel: Selection) {
		if (JSON.stringify(sel) === JSON.stringify(this.sel)) return; // same selection: keep DOM so double-clicks land
		this.sel = sel;
		this.render();
	}

	changed() {
		if (this.broken !== null) return void new Notice("DC Wiring: file is not valid JSON, changes are not saved.");
		this.requestSave();
		const now = this.getViewData();
		if (now !== this.history[this.history.length - 1]) this.history = [...this.history.slice(-49), now];
		this.render();
	}

	// shortcut: undo only (no redo), last 50 edits, cleared when the file changes outside this view
	private undo() {
		if (this.broken !== null || this.history.length < 2) return void new Notice("DC Wiring: nothing to undo.");
		this.history.pop();
		this.h = parseHarness(this.history[this.history.length - 1]);
		this.sel = null;
		this.requestSave();
		this.render();
	}

	editComponent(c: Component) {
		const fields: Field[] = [{ key: "name", label: "Name", value: c.name }];
		if (c.kind === "connector") {
			fields.push({ key: "pins", label: "Pins (count like 8, or rows x columns like 2x4)", value: formatPins(c) });
			fields.push({ key: "exposed", label: "Show in main harness (when this file is used as a sub-harness)", value: c.exposed ? "yes" : "", options: { "": "No", yes: "Yes" } });
		}
		const cfs = this.h.parts.find(p => p.id === c.partId)?.configurations ?? [], before = c.partId;
		const config: Field[] = cfs.length > 1 ? [{ key: "config", label: "Configuration", value: c.config ?? cfs[0].name, options: Object.fromEntries(cfs.map(cf => [cf.name, cf.name])) }] : [];
		new FormModal(this.app, `Edit ${c.id}`, [...fields, this.partField(c.partId), ...config], v => {
			c.name = v.name.trim() || c.name;
			if (v.pins !== undefined) {
				const p = parsePins(v.pins);
				if (!p) new Notice(`DC Wiring: "${v.pins}" is not a pin count. Use e.g. 8 or 2x4.`);
				else {
					if (p.pins < c.pins) this.h.wires = this.h.wires.filter(w => !((w.from.c === c.id && w.from.pin > p.pins) || (w.to.c === c.id && w.to.pin > p.pins)));
					c.pins = p.pins;
					if (p.layout) c.layout = p.layout; else delete c.layout;
				}
			}
			if (v.exposed !== undefined) { if (v.exposed) c.exposed = true; else delete c.exposed; }
			c.partId = v.partId || undefined;
			if (v.config && c.partId === before && v.config !== cfs[0].name) c.config = v.config; else delete c.config;
			this.changed();
		}).open();
	}

	editPart(p: Part) { new PartModal(this.app, this.h, p, () => this.changed()).open(); }

	get isLib() { return this.file?.extension === "harnesslib"; }

	private editUnits() {
		new FormModal(this.app, "Units", [
			{ key: "currency", label: "Currency symbol", value: this.h.currency ?? "" },
			{ key: "length", label: "Default length unit", value: this.h.lengthUnit ?? "mm", options: Object.fromEntries(Object.keys(LENGTH_UNITS).map(u => [u, u])) },
			{ key: "gauge", label: "Default gauge unit", value: this.h.gaugeUnit ?? "mm²", options: Object.fromEntries(GAUGE_UNITS.map(u => [u, u])) },
		], v => {
			if (v.currency.trim()) this.h.currency = v.currency.trim(); else delete this.h.currency;
			if (v.length === "mm") delete this.h.lengthUnit; else this.h.lengthUnit = v.length as LengthUnit;
			setGaugeUnit(this.h, v.gauge as GaugeUnit);
			this.changed();
		}).open();
	}

	// --- Part libraries ---

	private async writeLib(path: string, edit: (lib: Harness) => void) {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile)) return;
		try {
			await this.app.vault.process(f, text => { const lib = parseHarness(text); edit(lib); return JSON.stringify(lib, null, "\t"); });
		} catch (e) { new Notice(`DC Wiring: ${path} can't be read (${(e as Error).message}).`); }
	}

	/** Adds or updates every numbered part of this harness in a library the user picks (or a new one). */
	addAllToLibrary() {
		const files = this.app.vault.getFiles().filter(f => f.extension === "harnesslib" && f !== this.file);
		new LibraryPicker(this.app, files, async f => {
			const path = f?.path ?? (await this.app.vault.create(freePath(this.app, this.file?.parent?.path ?? "", "Parts library", "harnesslib"), JSON.stringify(emptyHarness(), null, "\t"))).path;
			const parts = this.h.parts.filter(p => p.number);
			await this.writeLib(path, lib => { for (const p of parts) copyPart(p, this.h, lib); });
			new Notice(`DC Wiring: ${parts.length} parts added to ${path}${parts.length < this.h.parts.length ? "; parts without a part number were skipped" : ""}.`);
		}).open();
	}

	/** Copies one library part (and its accessories) into this harness. */
	addFromLibrary() {
		const items = [...this.libs].flatMap(([lib, h]) => h.parts.filter(p => p.number).map(part => ({ lib, part })));
		if (!items.length) return void new Notice("DC Wiring: no part libraries with numbered parts in this vault.");
		new LibPartPicker(this.app, items, x => { copyPart(x.part, this.libs.get(x.lib)!, this.h); this.changed(); }).open();
	}

	editWire(id: string) {
		const w = this.h.wires.find(w => w.id === id);
		if (!w) return;
		new FormModal(this.app, `Edit ${w.id}`, [
			{ key: "name", label: "Name (shown instead of the ID)", value: w.name ?? "" },
			{ key: "color", label: "Colour (e.g. red, rd/wh, sw/ge)", value: w.color },
			{ key: "gauge", label: "Gauge (mm² or AWG)", value: w.gauge },
			{ key: "length", label: "Length (mm)", value: String(w.length || "") },
			this.partField(w.partId),
		], v => {
			if (v.name.trim()) w.name = v.name.trim(); else delete w.name;
			w.color = v.color.trim() || w.color;
			w.gauge = v.gauge.trim();
			w.length = Math.max(0, Number(v.length) || 0);
			w.partId = v.partId || undefined;
			this.changed();
		}).open();
	}

	editSignal(c: Component, pin: number) {
		new FormModal(this.app, `${c.id} pin ${pin} signal`, [{ key: "s", label: "Signal (e.g. +12V, GND, CAN H)", value: c.signals?.[pin] ?? "" }], v => {
			c.signals = { ...c.signals, [pin]: v.s.trim() };
			if (!c.signals[pin]) delete c.signals[pin];
			this.changed();
		}).open();
	}

	private partField(partId?: string) {
		const options: Record<string, string> = { "": "— none —" };
		for (const p of this.h.parts) options[p.id] = `${p.number}${p.internalNumber ? " [" + p.internalNumber + "]" : ""}${p.manufacturer ? " (" + p.manufacturer + ")" : ""}`;
		return { key: "partId", label: this.h.parts.length ? "Part" : "Part (add parts in the Parts tab)", value: partId ?? "", options };
	}

	private autoRoute() {
		const ids = this.sel?.wires;
		const manual = this.h.wires.filter(w => (!ids || ids.includes(w.id)) && w.points?.length).length;
		// no undo yet, so don't silently throw away hand-placed routing
		if (manual && !window.confirm(`Replace the bend points on ${manual} wire${manual > 1 ? "s" : ""} with automatic routes?`)) return;
		const r = this.schematic.autoRoute(ids);
		new Notice(`Auto routed ${r.routed} of ${r.total} wires${r.routed < r.total ? ". The rest have no free path; move connectors apart." : "."}`);
		this.changed();
	}

	private deleteSelection() {
		if (!this.sel) return;
		if (this.sel.component) removeComponent(this.h, this.sel.component);
		if (this.sel.wires) this.h.wires = this.h.wires.filter(w => !this.sel!.wires!.includes(w.id));
		this.sel = null;
		this.changed();
	}

	// --- Rendering ---
	render() {
		if (!this.bar) return;
		if (this.isLib) this.tab = "parts"; // a library holds only parts
		this.renderBar();
		// keep the svg mounted while on the schematic, so a drag keeps its pointer capture
		if (this.tab !== "schematic" || this.schematic.svg.parentElement !== this.body) this.body.empty();
		if (this.tab === "schematic") {
			this.body.appendChild(this.schematic.svg);
			this.schematic.render();
			if (!this.fitted && this.h.components.length) requestAnimationFrame(() => this.fitInitially());
		} else if (this.tab === "connections") this.renderConnections();
		else this.renderParts();
	}

	private renderBar() {
		this.bar.empty();
		const tabs = this.bar.createDiv("dcw-tabs");
		for (const [t, label] of this.isLib ? [["parts", "Library parts"] as const] : [["schematic", "Schematic"], ["connections", "Connections"], ["parts", "Parts"]] as const) {
			const b = tabs.createEl("button", { text: label, cls: t === this.tab ? "is-active" : "" });
			b.onclick = () => { this.tab = t; this.render(); };
		}
		const actions = this.bar.createDiv("dcw-actions");
		if (this.tab === "schematic") {
			actions.createEl("button", { text: "+ Connector" }).onclick = () => this.schematic.add("connector");
			actions.createEl("button", { text: "+ Splice" }).onclick = () => this.schematic.add("splice");
			actions.createEl("button", { text: "+ Sub-harness" }).onclick = () => { const p = this.schematic.center(); this.addSub(p.x, p.y); };
			actions.createEl("button", { text: this.sel?.wires ? "Auto route selected" : "Auto route" }).onclick = () => this.autoRoute();
			actions.createEl("button", { text: "Fit" }).onclick = () => this.schematic.fit();
			const ids = actions.createEl("button", { text: "Wire IDs", cls: this.h.hideWireIds ? "" : "is-active", attr: { "aria-label": "Show IDs on wires without a name" } });
			ids.onclick = () => { if (this.h.hideWireIds) delete this.h.hideWireIds; else this.h.hideWireIds = true; this.changed(); };
		} else if (this.tab === "parts") {
			actions.createEl("button", { text: "+ Part" }).onclick = () => {
				const p: Part = { id: nextId(this.h, "P", this.h.parts), number: "", manufacturer: "", description: "", price: 0 };
				this.h.parts.push(p);
				this.editPart(p);
			};
			if (!this.isLib) {
				actions.createEl("button", { text: "From library" }).onclick = () => this.addFromLibrary();
				actions.createEl("button", { text: "All to library" }).onclick = () => this.addAllToLibrary();
			}
			actions.createEl("button", { text: "Units" }).onclick = () => this.editUnits();
		}
		if (this.parents.length) {
			const up = actions.createSpan({ cls: "dcw-parents", text: "Part of: " });
			this.parents.forEach((f, i) => {
				if (i) up.appendText(", ");
				up.createEl("a", { text: f.basename, href: "#" }).onclick = e => { e.preventDefault(); void this.app.workspace.getLeaf(false).openFile(f); };
			});
		}
		const s = this.h;
		if (!this.isLib) actions.createSpan({ cls: "dcw-stats", text: `${s.components.length} components · ${s.wires.length} wires` });
	}

	private renderConnections() {
		const end = (e: End) => {
			const c = this.h.components.find(c => c.id === e.c);
			if (c?.kind === "harness") return `${c.name} › ${c.ports?.[e.pin - 1] ?? e.pin}`;
			return `${e.c} ${c?.name ?? ""} : ${e.pin}`;
		};
		const warnings = validate(this.h);
		const general = warnings.filter(w => w.kind === "component" && !w.pin);
		if (general.length) this.body.createDiv({ cls: "dcw-warnings", text: "⚠ " + general.map(w => `${w.id}: ${w.message}`).join(" · ") });
		const table = this.body.createEl("table", { cls: "dcw-table" });
		const head = table.createEl("tr");
		for (const t of ["ID", "Name", "From", "To", "Signal", "Colour", "Gauge", "Length (mm)", "Part", "Warnings", ""]) head.createEl("th", { text: t });
		for (const w of this.h.wires) {
			const tr = table.createEl("tr", { cls: this.sel?.wires?.includes(w.id) ? "is-selected" : "" });
			tr.onclick = e => { if (!(e.target as HTMLElement).closest("input, select")) this.select({ wires: [w.id] }); };
			tr.createEl("td", { text: w.id });
			const nameIn = tr.createEl("td").createEl("input", { value: w.name ?? "", placeholder: w.id });
			nameIn.onchange = () => { if (nameIn.value.trim()) w.name = nameIn.value.trim(); else delete w.name; this.changed(); };
			tr.createEl("td", { text: end(w.from) });
			tr.createEl("td", { text: end(w.to) });
			tr.createEl("td", { text: signalOf(this.h, w.from) ?? "" });
			const eff = effectiveWire(this.h, w);
			for (const key of ["color", "gauge", "length"] as const) {
				const input = tr.createEl("td").createEl("input", { value: String(eff[key] || ""), type: key === "length" ? "number" : "text" });
				if (eff[key] !== w[key]) { input.disabled = true; input.title = "Set by the wire part"; }
				input.onchange = () => {
					if (key === "length") w.length = Math.max(0, Number(input.value) || 0);
					else w[key] = input.value.trim();
					this.changed();
				};
			}
			this.partSelect(tr.createEl("td"), w.partId, id => { w.partId = id; this.changed(); });
			tr.createEl("td", { cls: "dcw-warn", text: warnings.filter(x => x.kind === "wire" ? x.id === w.id
				: x.kind === "component" && [w.from, w.to].some(e => e.c === x.id && e.pin === x.pin)).map(x => x.message).join("; ") });
			const del = tr.createEl("td").createEl("button", { text: "✕", attr: { "aria-label": `Delete ${w.id}` } });
			del.onclick = e => {
				e.stopPropagation();
				this.h.wires = this.h.wires.filter(x => x !== w);
				if (this.sel?.wires?.includes(w.id)) this.sel = null;
				this.changed();
			};
		}
		if (!this.h.wires.length) this.body.createDiv({ cls: "dcw-empty", text: "No wires yet. Drag from one pin to another on the Schematic." });
	}

	private renderParts() {
		const cur = (n: number) => `${this.h.currency ?? ""}${n.toFixed(2)}`;
		const qty = (r: BomRow) => `${r.unit === "m" ? r.qty.toFixed(2) : r.qty} ${r.unit}`;
		const lib = this.isLib, libs = lib ? [] : [...this.libs];
		const warnings = validate(this.h).filter(w => w.kind === "part" && w.message !== "Not used"); // "Not used" shows in Qty
		const search = this.body.createEl("input", { type: "search", cls: "dcw-search", placeholder: "Filter parts", value: this.partFilter });
		search.oninput = () => {
			this.partFilter = search.value;
			this.render();
			const s = this.body.querySelector<HTMLInputElement>(".dcw-search");
			s?.focus();
			s?.setSelectionRange(s.value.length, s.value.length);
		};
		const cols: [string, string][] = [["Part number", "number"], ["Internal", "internalNumber"], ["Manufacturer", "manufacturer"], ["Description", "description"], ["Unit price", "price"]];
		if (!lib) cols.push(["Qty", "qty"], ["Total", "total"]);
		if (libs.length) cols.push(["Libraries", ""]);
		cols.push(["Warnings", ""], ["", ""]);
		const table = this.body.createEl("table", { cls: "dcw-table" });
		const head = table.createEl("tr");
		for (const [t, key] of cols) {
			const sorted = key && this.partSort.key === key;
			const th = head.createEl("th", { text: t + (sorted ? (this.partSort.dir > 0 ? " ▲" : " ▼") : ""), cls: key ? "dcw-sortable" : "" });
			if (key) th.onclick = () => { this.partSort = { key, dir: sorted ? -this.partSort.dir : 1 }; this.render(); };
		}
		const f = this.partFilter.trim().toLowerCase();
		const val = (r: BomRow) => { const k = this.partSort.key; return k === "qty" || k === "total" ? r[k] : (r.part as unknown as Record<string, unknown>)[k] ?? ""; };
		const rows = bom(this.h);
		const shown = rows
			.filter(r => !f || [r.part.number, r.part.internalNumber, r.part.manufacturer, r.part.description, r.part.type].some(s => s?.toLowerCase().includes(f)))
			.sort((a, b) => {
				if (!this.partSort.key) return 0;
				const x = val(a), y = val(b);
				return this.partSort.dir * (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true }));
			});
		const sections: [string, BomRow[]][] = [...Object.entries(PART_TYPES).map(([t, d]) => [d.label, shown.filter(r => r.part.type === t)] as [string, BomRow[]]),
			["Generic parts", shown.filter(r => !r.part.type)]];
		for (const [label, list] of sections) {
			if (!list.length) continue;
			table.createEl("tr", { cls: "dcw-section" }).createEl("td", { text: label, attr: { colspan: cols.length } });
			for (const r of list) {
				const p = r.part;
				const tr = table.createEl("tr", { cls: [!lib && !r.used ? "is-unused" : "", r.excluded ? "is-excluded" : ""].join(" ").trim() });
				tr.ondblclick = () => this.editPart(p);
				for (const key of ["number", "internalNumber", "manufacturer", "description", "price"] as const) {
					const input = tr.createEl("td").createEl("input", { value: String(p[key] ?? ""), type: key === "price" ? "number" : "text" });
					if (key === "number") input.placeholder = "Part number";
					input.onchange = () => {
						const v = input.value.trim();
						if (key === "price") p.price = Number(v) || 0;
						else if (key === "internalNumber") { if (v) p.internalNumber = v; else delete p.internalNumber; }
						else p[key] = v;
						this.changed();
					};
				}
				if (!lib) {
					tr.createEl("td", { text: !r.used ? "Not used" : qty(r) + (r.excluded ? " (excluded)" : "") });
					tr.createEl("td", { text: cur(r.total) });
				}
				if (libs.length) {
					const td = tr.createEl("td", { cls: "dcw-libs" });
					for (const [path, l] of libs) {
						const st = syncStatus(p, this.h, l), name = path.split("/").pop()!.replace(/\.harnesslib$/, "");
						const push = () => this.writeLib(path, x => { copyPart(p, this.h, x); });
						if (st === "missing") td.createEl("button", { text: `+ ${name}`, attr: { "aria-label": `Add to ${path}` } }).onclick = push;
						else if (st === "in-sync") td.createSpan({ text: `✓ ${name}`, attr: { "aria-label": `In sync with ${path}` } });
						else if (st === "out-of-sync") {
							td.createSpan({ text: `≠ ${name} `, attr: { "aria-label": `Out of sync with ${path}` } });
							td.createEl("button", { text: "Push", attr: { "aria-label": `Update the part in ${path} to match this harness` } }).onclick = push;
							td.createEl("button", { text: "Pull", attr: { "aria-label": `Update this part to match ${path}` } }).onclick = () => {
								copyPart(l.parts.find(x => x.number === p.number)!, l, this.h);
								this.changed();
							};
						}
					}
				}
				tr.createEl("td", { cls: "dcw-warn", text: warnings.filter(w => w.id === p.id).map(w => w.message).join("; ") });
				const td = tr.createEl("td", { cls: "dcw-row-actions" });
				td.createEl("button", { text: "✎", attr: { "aria-label": "Edit part" } }).onclick = () => this.editPart(p);
				td.createEl("button", { text: "✕", attr: { "aria-label": "Delete part" } }).onclick = () => { removePart(this.h, p.id); this.changed(); };
			}
		}
		if (lib) {
			if (!rows.length) this.body.createDiv({ cls: "dcw-empty", text: "No parts in this library yet. Add one with “+ Part”, or use “All to library” in a harness." });
			return;
		}
		const fromSubs: BomRow[] = subBom(this.h, p => this.subs.get(p), new Set(this.file ? [this.file.path] : []));
		if (fromSubs.length) {
			table.createEl("tr", { cls: "dcw-section" }).createEl("td", { text: "From sub-harnesses (edit them in their own file)", attr: { colspan: cols.length } });
			for (const r of fromSubs) {
				const tr = table.createEl("tr", { cls: "dcw-readonly" });
				for (const t of [r.part.number, r.part.internalNumber ?? "", r.part.manufacturer, r.part.description, cur(r.part.price), qty(r), cur(r.total)]) tr.createEl("td", { text: t });
				tr.createEl("td", { attr: { colspan: cols.length - 7 } });
			}
		}
		const total = table.createEl("tr", { cls: "dcw-total" });
		total.createEl("td", { text: "Total", attr: { colspan: 6 } });
		total.createEl("td", { text: cur([...rows.filter(r => !r.excluded), ...fromSubs].reduce((s, r) => s + r.total, 0)) });
		if (!rows.length) this.body.createDiv({ cls: "dcw-empty", text: "No parts yet. Add one with “+ Part”, then assign it to connectors and wires." });
	}

	private partSelect(parent: HTMLElement, value: string | undefined, set: (id: string | undefined) => void) {
		const s = parent.createEl("select", { cls: "dropdown" });
		s.createEl("option", { text: this.h.parts.length ? "— none —" : "No part", value: "" });
		for (const p of this.h.parts) s.createEl("option", { text: p.number || p.id, value: p.id });
		s.value = value ?? "";
		s.onchange = () => set(s.value || undefined);
	}
}

/** Pick an existing .harness file to use as a sub-harness, or null for a new one. */
class SubPicker extends FuzzySuggestModal<TFile | null> {
	constructor(app: App, private self: TFile, private done: (f: TFile | null) => void) {
		super(app);
		this.setPlaceholder("Choose a harness to use as sub-harness, or create a new one");
	}
	getItems() { return [null, ...this.app.vault.getFiles().filter(f => f.extension === "harness" && f !== this.self)]; }
	getItemText(f: TFile | null) { return f ? f.path : "＋ New sub-harness"; }
	onChooseItem(f: TFile | null) { this.done(f); }
}
