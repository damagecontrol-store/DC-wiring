import { FuzzySuggestModal, Notice, TextFileView, TFile, type App, type WorkspaceLeaf } from "obsidian";
import { bom, emptyHarness, formatPins, nextId, parseHarness, parsePins, relinkSub, removeComponent, removePart, signalOf, subBom, syncPorts, type BomRow, type Component, type End, type Harness } from "./model.ts";
import { Schematic, type Host, type Selection } from "./schematic.ts";
import { FormModal, freePath, type Field } from "./ui.ts";

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
		if (this.file?.path !== me) return; // switched files while loading
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
		const onVault = (f: unknown) => { if (f instanceof TFile && f.extension === "harness" && f !== this.file) void this.loadLinks(); };
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
		new FormModal(this.app, `Edit ${c.id}`, [...fields, this.partField(c.partId)], v => {
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
			this.changed();
		}).open();
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
		for (const p of this.h.parts) options[p.id] = `${p.number}${p.manufacturer ? " (" + p.manufacturer + ")" : ""}`;
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
		for (const [t, label] of [["schematic", "Schematic"], ["connections", "Connections"], ["parts", "Parts"]] as const) {
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
				this.h.parts.push({ id: nextId(this.h, "P", this.h.parts), number: "", manufacturer: "", description: "", price: 0 });
				this.changed();
			};
		}
		if (this.parents.length) {
			const up = actions.createSpan({ cls: "dcw-parents", text: "Part of: " });
			this.parents.forEach((f, i) => {
				if (i) up.appendText(", ");
				up.createEl("a", { text: f.basename, href: "#" }).onclick = e => { e.preventDefault(); void this.app.workspace.getLeaf(false).openFile(f); };
			});
		}
		const s = this.h;
		actions.createSpan({ cls: "dcw-stats", text: `${s.components.length} components · ${s.wires.length} wires` });
	}

	private renderConnections() {
		const end = (e: End) => {
			const c = this.h.components.find(c => c.id === e.c);
			if (c?.kind === "harness") return `${c.name} › ${c.ports?.[e.pin - 1] ?? e.pin}`;
			return `${e.c} ${c?.name ?? ""} : ${e.pin}`;
		};
		const table = this.body.createEl("table", { cls: "dcw-table" });
		const head = table.createEl("tr");
		for (const t of ["ID", "Name", "From", "To", "Signal", "Colour", "Gauge", "Length (mm)", "Part", ""]) head.createEl("th", { text: t });
		for (const w of this.h.wires) {
			const tr = table.createEl("tr", { cls: this.sel?.wires?.includes(w.id) ? "is-selected" : "" });
			tr.onclick = e => { if (!(e.target as HTMLElement).closest("input, select")) this.select({ wires: [w.id] }); };
			tr.createEl("td", { text: w.id });
			const nameIn = tr.createEl("td").createEl("input", { value: w.name ?? "", placeholder: w.id });
			nameIn.onchange = () => { if (nameIn.value.trim()) w.name = nameIn.value.trim(); else delete w.name; this.changed(); };
			tr.createEl("td", { text: end(w.from) });
			tr.createEl("td", { text: end(w.to) });
			tr.createEl("td", { text: signalOf(this.h, w.from) ?? "" });
			for (const key of ["color", "gauge", "length"] as const) {
				const input = tr.createEl("td").createEl("input", { value: String(w[key] || ""), type: key === "length" ? "number" : "text" });
				input.onchange = () => {
					if (key === "length") w.length = Math.max(0, Number(input.value) || 0);
					else w[key] = input.value.trim();
					this.changed();
				};
			}
			this.partSelect(tr.createEl("td"), w.partId, id => { w.partId = id; this.changed(); });
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
		const cur = (n: number) => n.toFixed(2);
		const table = this.body.createEl("table", { cls: "dcw-table" });
		const head = table.createEl("tr");
		for (const t of ["Part number", "Manufacturer", "Description", "Unit price", "Qty", "Total", ""]) head.createEl("th", { text: t });
		const rows = bom(this.h);
		for (const r of rows) {
			const p = r.part;
			const tr = table.createEl("tr", { cls: r.used ? "" : "is-unused" });
			for (const key of ["number", "manufacturer", "description", "price"] as const) {
				const input = tr.createEl("td").createEl("input", { value: String(p[key] ?? ""), type: key === "price" ? "number" : "text" });
				if (key === "number") input.placeholder = "Part number";
				input.onchange = () => {
					if (key === "price") p.price = Number(input.value) || 0;
					else p[key] = input.value.trim();
					this.changed();
				};
			}
			tr.createEl("td", { text: !r.used ? "Not used" : `${r.unit === "m" ? r.qty.toFixed(2) : r.qty} ${r.unit}` });
			tr.createEl("td", { text: cur(r.total) });
			const del = tr.createEl("td").createEl("button", { text: "✕", attr: { "aria-label": "Delete part" } });
			del.onclick = () => { removePart(this.h, p.id); this.changed(); };
		}
		const fromSubs: BomRow[] = subBom(this.h, p => this.subs.get(p), new Set(this.file ? [this.file.path] : []));
		if (fromSubs.length) {
			table.createEl("tr", { cls: "dcw-section" }).createEl("td", { text: "From sub-harnesses (edit them in their own file)", attr: { colspan: 7 } });
			for (const r of fromSubs) {
				const tr = table.createEl("tr", { cls: "dcw-readonly" });
				for (const t of [r.part.number, r.part.manufacturer, r.part.description, cur(r.part.price)]) tr.createEl("td", { text: t });
				tr.createEl("td", { text: `${r.unit === "m" ? r.qty.toFixed(2) : r.qty} ${r.unit}` });
				tr.createEl("td", { text: cur(r.total) });
				tr.createEl("td");
			}
		}
		const total = table.createEl("tr", { cls: "dcw-total" });
		total.createEl("td", { text: "Total", attr: { colspan: 5 } });
		total.createEl("td", { text: cur([...rows, ...fromSubs].reduce((s, r) => s + r.total, 0)) });
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
