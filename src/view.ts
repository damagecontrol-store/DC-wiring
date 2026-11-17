import { FuzzySuggestModal, Menu, Notice, TextFileView, TFile, type App, type WorkspaceLeaf } from "obsidian";
import { exportMenu } from "./output.ts";
import { routeWires } from "./bundles.ts";
import { Layout, type LayoutSel } from "./layout.ts";
import { formatLength, parseLength } from "./length.ts";
import { bom, emptyHarness, isHarnessExt, isLibExt, formatPins, nextId, parseHarness, parsePins, relinkSub, removeComponent, removePart, setContact, signalOf, subBom, syncPorts, type BomRow, type BranchPoint, type Bundle, type Component, type End, type Harness, type Part } from "./model.ts";
import { NOTE_COLORS, Schematic, type Host, type Selection } from "./schematic.ts";
import { FormModal, freePath, Picker, showShortcuts, type Field } from "./ui.ts";
import { coreName, formatCores, parseCores, partCores, setCores, twist, twistedWith, wiresLost } from "./cable.ts";
import { addToGroup, isLocked, splitGroup, wireLocked } from "./groups.ts";
import { copyPart, syncStatus } from "./library.ts";
import { assignPart, effectiveWire, fitsRange, followPart, PART_TYPES, partChoices, partFrom, partSummary, partsUsedBy, pinGauge, setGaugeUnit, type Item } from "./parts.ts";
import { LibPartPicker, LibraryPicker, PartModal } from "./partview.ts";
import { GAUGE_UNITS, LENGTH_UNITS, type GaugeUnit, type LengthUnit } from "./units.ts";
import { canvasWarnings, dropPercent, validate, voltageDrop } from "./validate.ts";
import { cavName, compLabel, designations, labelOf, parseCavities, pasteSignals, selComps, TERMINAL_TYPES } from "./components.ts";

export const VIEW_TYPE = "dc-wiring-harness";
type Tab = "schematic" | "layout" | "connections" | "parts";

const COLS_KEY = "dcw-parts-hidden-columns"; // per device, shared by every harness and library

export class HarnessView extends TextFileView implements Host {
	h: Harness = emptyHarness();
	sel: Selection = null;
	lsel: LayoutSel = null; // bundle or branch point picked on the Layout tab
	subs = new Map<string, Harness>();
	private parents: TFile[] = []; // harnesses that use this one as a sub-harness
	private tab: Tab = "schematic";
	private broken: string | null = null; // text of a file that failed to parse: saved back untouched
	private schematic = new Schematic(this);
	private layout = new Layout(this);
	private layoutFitted = false;
	private bar!: HTMLElement;
	private body!: HTMLElement;
	private fitted = false;
	private history: string[] = []; // saved states, newest last; Cmd/Ctrl+Z steps back
	libs = new Map<string, Harness>(); // part libraries in the vault, by path
	private partSort: { key: string; dir: number } = { key: "", dir: 1 };
	private partFilter = "";
	private connSort: { key: string; dir: number } = { key: "", dir: 1 };
	private connFilter = "";
	private onlySelected = false;
	private future: string[] = []; // undone states, for redo

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
		this.future = [];
		// fit when a file opens with content; an empty one stays at 100% while you add the first parts
		if (clear) { this.sel = this.lsel = null; this.fitted = this.layoutFitted = !this.h.components.length; }
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
			if (!isHarnessExt(f.extension) || f.path === me) continue;
			const p = await read(f.path);
			if (p?.components.some(c => c.kind === "harness" && c.file === me)) parents.push(f);
		}
		const libs = new Map<string, Harness>();
		for (const f of vault.getFiles()) if (isLibExt(f.extension) && f.path !== me) {
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

	editGroup(id: string) {
		const g = this.h.groups?.find(g => g.id === id);
		if (!g) return;
		new FormModal(this.app, `Edit group ${g.id}`, [
			{ key: "name", label: "Name (e.g. the device: ECU, fuse box)", value: g.name },
			{ ...this.partField(g.partId), label: "Part (the device, counted once in the BOM)" },
			{ key: "locked", label: "Locked (contents can't be edited or moved)", value: g.locked ? "yes" : "", options: { "": "No", yes: "Yes" } },
		], v => {
			g.name = v.name.trim() || g.name;
			g.partId = v.partId || undefined;
			if (v.locked) g.locked = true; else delete g.locked;
			this.changed();
		}).open();
	}

	pickGroup(c: Component) {
		const items = [{ id: "", name: "＋ New group" }, ...this.h.groups ?? []];
		// a selected component brings the rest of the selection along; locked groups keep their members
		const ids = selComps(this.sel).includes(c.id) ? selComps(this.sel).filter(id => !isLocked(this.h, id)) : [c.id];
		new Picker(this.app, `Add ${ids.length > 1 ? ids.length + " components" : c.id} to group`, items, g => g.name, g => {
			const grp = addToGroup(this.h, ids[0], g.id);
			for (const id of ids.slice(1)) addToGroup(this.h, id, grp.id);
			this.changed();
			if (!g.id) this.editGroup(grp.id);
		}).open();
	}

	async saveGroupAsSub(id: string) {
		const me = this.file, g = this.h.groups?.find(g => g.id === id);
		if (!me || !g) return;
		const path = freePath(this.app, me.parent?.path ?? "", `${me.basename} - ${g.name.replace(/[\\/:*?"<>|#^[\]]/g, "-")}`);
		const h = structuredClone(this.h); // the file is created first: a failed create must not lose the group
		let sub: Harness;
		try { sub = splitGroup(h, id, path); } catch (e) { return void new Notice(`DC Wiring: ${(e as Error).message}`); }
		await this.app.vault.create(path, JSON.stringify(sub, null, "\t"));
		this.h = h;
		this.sel = null;
		this.changed();
		await this.loadLinks();
	}

	twistWith(wireId: string) {
		const others = this.h.wires.filter(w => w.id !== wireId && !twistedWith(this.h, wireId).includes(w.id));
		new Picker(this.app, `Twist ${wireId} with`, others, w => `${w.id} ${w.name ?? ""} ${w.color}`, w => { twist(this.h, [wireId, w.id]); this.changed(); }).open();
	}

	/** Pick a connector housing from the part libraries in this harness's folder; with none there, add a blank one. */
	addConnector(x?: number, y?: number) {
		const dir = this.file?.parent?.path;
		const items = [...this.libs].filter(([path]) => this.app.vault.getFileByPath(path)?.parent?.path === dir)
			.flatMap(([lib, h]) => h.parts.filter(p => p.type === "connector" && p.number).flatMap(part => {
				const cfs = part.configurations ?? [];
				return cfs.length > 1 ? cfs.map(cf => ({ lib, part, config: cf.name as string | undefined })) : [{ lib, part, config: undefined }];
			}));
		if (!items.length) return this.schematic.add("connector", x, y);
		new Picker(this.app, "Add a connector: pick a housing from this folder's part library", [null, ...items],
			t => t ? `${t.part.number} · ${t.part.description}${t.config ? ` · ${t.config}` : ""} · ${t.part.cavities ?? "?"} cav` : "Blank connector (4 pins)",
			t => t ? this.schematic.addFromLib(this.libs.get(t.lib)!, t.part, t.config, x, y) : this.schematic.add("connector", x, y)).open();
	}

	addImage(x: number, y: number) {
		const files = this.app.vault.getFiles().filter(f => ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif"].includes(f.extension.toLowerCase()));
		new Picker(this.app, "Choose an image from the vault", files, f => f.path, f => {
			const images = this.h.images ?? [];
			images.push({ id: nextId(this.h, "I", images), path: f.path, x, y, w: 240, h: 160 });
			this.h.images = images;
			this.changed();
		}).open();
	}

	imageSrc(path: string) {
		const f = this.app.vault.getAbstractFileByPath(path);
		return f instanceof TFile ? this.app.vault.getResourcePath(f) : undefined;
	}

	clear() { this.h = emptyHarness(); this.sel = this.lsel = null; }

	// A harness opened in a background tab has no size yet: fit once it is shown.
	onResize() { this.fitInitially(); }

	private fitInitially() {
		if (!this.fitted && this.tab === "schematic") this.fitted = this.schematic.fit();
		if (!this.layoutFitted && this.tab === "layout") this.layoutFitted = this.layout.fit();
	}

	async onOpen() {
		this.contentEl.addClass("dcw-view");
		this.contentEl.tabIndex = 0;
		this.bar = this.contentEl.createDiv("dcw-bar");
		this.body = this.contentEl.createDiv("dcw-body-wrap");
		// a linked harness changed: refresh sub-harness blocks, BOM roll-up and the "Part of" links
		const onVault = (f: unknown) => { if (f instanceof TFile && (isHarnessExt(f.extension) || isLibExt(f.extension)) && f !== this.file) void this.loadLinks(); };
		this.registerEvent(this.app.vault.on("modify", onVault));
		this.registerEvent(this.app.vault.on("delete", onVault));
		this.registerEvent(this.app.vault.on("rename", (f, oldPath) => {
			if (this.broken === null && relinkSub(this.h, oldPath, f.path)) this.requestSave();
			onVault(f);
		}));
		this.registerDomEvent(this.contentEl, "keydown", e => {
			if ((e.target as HTMLElement).closest("input, select, textarea")) return;
			const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
			if (mod && k === "z" && !e.shiftKey) { e.preventDefault(); this.undo(); }
			else if (mod && (k === "y" || k === "z")) { e.preventDefault(); this.redo(); }
			else if (e.key === "Escape") this.select(null);
			else if (e.key === "?") showShortcuts(this.app);
			else if (this.tab === "layout") { if (!mod && (e.key === "Delete" || e.key === "Backspace") && this.lsel) this.layout.remove(this.lsel); }
			else if (this.tab !== "schematic") return;
			// delete only where the selection is visible
			else if (!mod && (e.key === "Delete" || e.key === "Backspace" || k === "x")) this.deleteSelection();
			else if (this.schematic.key(e)) { e.preventDefault(); e.stopPropagation(); }
		});
	}

	// --- Host ---
	select(sel: Selection) {
		if (JSON.stringify(sel) === JSON.stringify(this.sel) && !this.lsel) return; // same selection: keep DOM so double-clicks land
		this.sel = sel;
		this.lsel = null;
		this.render();
		for (const v of this.siblings()) { v.sel = sel; v.lsel = null; v.render(); }
	}

	/** Picks a bundle or branch point; a bundle also selects the wires routed through it, for the other tabs. */
	selectLayout(s: LayoutSel) {
		if (JSON.stringify(s) === JSON.stringify(this.lsel)) return;
		const wires = s?.bundle ? [...routeWires(this.h)].filter(([, r]) => r.bundles.includes(s.bundle!)).map(([id]) => id) : [];
		this.sel = wires.length ? { wires } : null;
		this.lsel = s;
		this.render();
		for (const v of this.siblings()) { v.sel = this.sel; v.lsel = s; v.render(); }
	}

	/** Other open views of this file (split screen): they share edits and selection with this one. */
	private siblings(): HarnessView[] {
		return this.app.workspace.getLeavesOfType(VIEW_TYPE).map(l => l.view)
			.filter((v): v is HarnessView => v instanceof HarnessView && v !== this && v.file === this.file);
	}

	showTab(t: Tab) { this.tab = t; this.render(); }

	changed() {
		if (this.broken !== null) return void new Notice("DC Wiring: file is not valid JSON, changes are not saved.");
		this.requestSave();
		const now = this.getViewData();
		if (now !== this.history[this.history.length - 1]) { this.history = [...this.history.slice(-49), now]; this.future = []; }
		this.render();
		for (const v of this.siblings()) { v.h = parseHarness(now); v.sel = this.sel; v.lsel = this.lsel; v.render(); }
	}

	// shortcut: last 50 edits, cleared when the file changes outside this view
	private undo() {
		if (this.broken !== null || this.history.length < 2) return void new Notice("DC Wiring: nothing to undo.");
		this.future.push(this.history.pop()!);
		this.h = parseHarness(this.history[this.history.length - 1]);
		this.sel = this.lsel = null;
		this.requestSave();
		this.render();
		for (const v of this.siblings()) { v.h = parseHarness(this.getViewData()); v.sel = v.lsel = null; v.render(); }
	}

	private redo() {
		const next = this.future.pop();
		if (this.broken !== null || next === undefined) return void new Notice("DC Wiring: nothing to redo.");
		this.history.push(next);
		this.h = parseHarness(next);
		this.sel = null;
		this.requestSave();
		this.render();
		for (const v of this.siblings()) { v.h = parseHarness(next); v.sel = v.lsel = null; v.render(); } // or their next edit saves the old state
	}

	editComponent(c: Component) {
		const sub = c.kind === "harness";
		if (c.kind === "note") return new FormModal(this.app, `Edit ${c.id}`, [
			{ key: "text", label: "Text", value: c.text ?? "", multiline: true },
			{ key: "color", label: "Colour", value: c.color ?? "yellow", options: Object.fromEntries(NOTE_COLORS.map(k => [k, k[0].toUpperCase() + k.slice(1)])) },
		], v => { c.text = v.text; c.color = v.color; this.changed(); }).open();
		const fields: Field[] = [{ key: "name", label: sub ? "Name" : "Label (shown instead of the ID; empty = ID)", value: sub ? c.name : labelOf(c) }];
		if (c.kind === "connector") {
			fields.push({ key: "pins", label: "Pins (count like 8, or rows x columns like 2x4)", value: formatPins(c) });
			fields.push({ key: "cavities", label: "Cavity designations, comma separated (empty = pin numbers)", value: c.cavities?.join(", ") ?? "" });
			fields.push({ key: "tpl", label: "Or set all designations to", value: "", options: { "": "— as typed above —", numbers: "Numbers: 1, 2, 3", letters: "Letters: A, B, C", grid: "Grid: A1, A2, B1 (rows x columns)" } });
			fields.push({ key: "exposed", label: "Show in main harness (when this file is used as a sub-harness)", value: c.exposed ? "yes" : "", options: { "": "No", yes: "Yes" } });
		}
		if (c.kind === "terminal") fields.push({ key: "terminal", label: "Type", value: c.terminal ?? "ring", options: Object.fromEntries(TERMINAL_TYPES.map(t => [t, t])) });
		if (c.kind === "cable") fields.push(
			{ key: "cores", label: "Cores: colour and gauge, comma separated (e.g. rd 0.5, bk 0.5)", value: formatCores(c.cores) },
			{ key: "shield", label: "Shield", value: c.shield ? "yes" : "", options: { "": "No", yes: "Yes" } },
			{ key: "length", label: "Length (mm)", value: String(c.length || "") },
		);
		const cfs = this.h.parts.find(p => p.id === c.partId)?.configurations ?? [], before = c.partId;
		const config: Field[] = cfs.length > 1 ? [{ key: "config", label: "Configuration", value: c.config ?? cfs[0].name, options: Object.fromEntries(cfs.map(cf => [cf.name, cf.name])) }] : [];
		new FormModal(this.app, `Edit ${c.id}`, [...fields, this.partField(c.partId), ...config], v => {
			if (v.cores !== undefined) {
				const cores = parseCores(v.cores);
				if (cores.length) setCores(this.h, c, cores, !!v.shield);
				else new Notice("DC Wiring: a cable needs at least one core.");
				c.length = Math.max(0, Number(v.length) || 0);
			}
			c.name = v.name.trim() || (sub ? c.name : c.id);
			if (v.pins !== undefined) {
				const p = parsePins(v.pins);
				if (!p) new Notice(`DC Wiring: "${v.pins}" is not a pin count. Use e.g. 8 or 2x4.`);
				else {
					if (p.pins < c.pins) this.h.wires = this.h.wires.filter(w => !((w.from.c === c.id && w.from.pin > p.pins) || (w.to.c === c.id && w.to.pin > p.pins)));
					c.pins = p.pins;
					if (p.layout) c.layout = p.layout; else delete c.layout;
					for (const key of ["nc", "globals"] as const) {
						const kept = c[key]?.filter(n => n <= c.pins);
						if (kept?.length) c[key] = kept; else delete c[key];
					}
				}
			}
			if (v.cavities !== undefined) {
				const list = v.tpl ? designations(v.tpl, c.pins, c.layout?.cols) : parseCavities(v.cavities, c.pins);
				if (list) c.cavities = list; else delete c.cavities;
			}
			if (v.terminal !== undefined) c.terminal = v.terminal;
			if (v.exposed !== undefined) { if (v.exposed) c.exposed = true; else delete c.exposed; }
			c.partId = v.partId || undefined;
			// a newly chosen cable part brings its cores; cancelling keeps the cores typed above
			if (c.kind === "cable" && c.partId !== before) { const p = this.h.parts.find(p => p.id === c.partId); if (p) this.cablesFollow(p, [c]); }
			if (v.config && c.partId === before && v.config !== cfs[0].name) c.config = v.config; else delete c.config;
			this.changed();
		}).open();
	}

	editBundle(b: Bundle) {
		const calc = (s: string) => { const r = parseLength(s); return r ? `= ${formatLength(r.mm, r.unit)}` : "Not a length"; };
		new FormModal(this.app, `Edit ${b.id}`, [
			{ key: "length", label: "Length (e.g. 40 + 30 + 40, 2 * 30cm, 1m 20cm)", value: String(b.length), preview: calc },
			{ key: "label", label: "Label", value: b.label ?? "" },
		], v => {
			const r = parseLength(v.length);
			if (r) b.length = Math.round(r.mm * 10) / 10;
			else new Notice(`DC Wiring: "${v.length}" is not a length.`);
			if (v.label.trim()) b.label = v.label.trim(); else delete b.label;
			this.changed();
		}).open();
	}

	/** Parts of the sub-harnesses, rolled up for this harness's BOM (also used by the exports). */
	subParts(): BomRow[] { return subBom(this.h, p => this.subs.get(p), new Set(this.file ? [this.file.path] : [])); }

	editPart(p: Part) {
		const mfrs = [...new Set([...this.h.parts, ...[...this.libs.values()].flatMap(l => l.parts)].map(x => x.manufacturer).filter(Boolean))].sort();
		new PartModal(this.app, this.h, p, () => {
			this.cablesFollow(p, this.h.components.filter(c => c.kind === "cable" && c.partId === p.id));
			followPart(this.h, p);
			this.changed();
		}, mfrs).open();
	}

	/** Gives cables their part's cores and shield, asking first when that removes wires. False when the user says no. */
	private cablesFollow(p: Part, cables: Component[]): boolean {
		const pc = partCores(p);
		if (!pc || !cables.length) return true;
		const lost = cables.flatMap(c => wiresLost(this.h, c, pc.cores, pc.shield));
		if (lost.length && !window.confirm(`${p.number || p.id} has ${pc.cores.length} core${pc.cores.length > 1 ? "s" : ""}${pc.shield ? " and a shield" : ", no shield"}. `
			+ `This removes ${lost.length} wire${lost.length > 1 ? "s" : ""} on cores it does not have: ${lost.map(w => w.id).join(", ")}. Continue?`)) return false;
		for (const c of cables) setCores(this.h, c, pc.cores, pc.shield);
		return true;
	}

	/** Picks the contact (or cavity plug) for one cavity, overriding the configuration. Contacts that take the pin's wires come first. */
	pickContact(c: Component, pin: number) {
		const h = this.h, g = pinGauge(h, c.id, pin);
		const rank = (p: Part) => p.type === "contact" ? (fitsRange(h, p, g) ? 2 : 1) : p.type === "cavity-plug" ? 1 : 0;
		const set = (id: string | undefined) => { setContact(c, pin, id); this.changed(); };
		const opts: { text: string; run: () => void }[] = [...h.parts].sort((a, b) => rank(b) - rank(a)).map(p => ({
			text: [p.number || p.id, p.manufacturer, p.description, p.type === "contact" && (p.gaugeMin || p.gaugeMax) && `${p.gaugeMin ?? ""}–${p.gaugeMax ?? ""}`,
				rank(p) < 2 && `(${p.type === "contact" ? "does not fit the wire" : p.type ?? "generic"})`].filter(Boolean).join("  "),
			run: () => set(p.id),
		}));
		opts.unshift({ text: "＋ Create new contact", run: () => {
			const p: Part = { id: nextId(h, "P", h.parts), number: "", manufacturer: "", description: "", price: 0, type: "contact" };
			h.parts.push(p);
			setContact(c, pin, p.id);
			this.editPart(p);
		} });
		if (c.contacts?.[pin] !== undefined) opts.push({ text: "↺ Use the configuration's contact", run: () => set(undefined) });
		if (c.contacts?.[pin] !== "") opts.push({ text: "✕ No contact in this cavity", run: () => set("") });
		new Picker(this.app, `Contact for ${c.id}:${cavName(c, pin)}`, opts, o => o.text, o => o.run()).open();
	}

	/** Adds a covering to a bundle, or a covering or boot to a branch point. Those part types are listed first. */
	addCovering(x: Bundle | BranchPoint) {
		const h = this.h, types: (string | undefined)[] = "from" in x ? ["covering"] : ["covering", "boot"];
		const add = (id: string) => { x.coverings = [...x.coverings ?? [], id]; };
		const parts = [...h.parts].sort((a, b) => Number(types.includes(b.type)) - Number(types.includes(a.type)));
		const opts: { text: string; run: () => void }[] = parts.map(p => ({
			text: [p.number || p.id, p.coveringType, p.cutToLength && "cut to length", p.manufacturer, p.description, !types.includes(p.type) && `(${p.type ?? "generic"})`].filter(Boolean).join("  "),
			run: () => { add(p.id); this.changed(); },
		}));
		opts.unshift({ text: "＋ Create new covering", run: () => {
			const p: Part = { id: nextId(h, "P", h.parts), number: "", manufacturer: "", description: "", price: 0, type: "covering", ...("from" in x ? { cutToLength: true } : {}) };
			h.parts.push(p);
			add(p.id);
			this.editPart(p);
		} });
		new Picker(this.app, `Add a covering to ${x.id}`, opts, o => o.text, o => o.run()).open();
	}

	/**
	 * Assign part: a searchable list with the parts that fit first, each configuration its own entry, plus
	 * creating a part from the item. Applies to every selected item of the same kind when the item is selected.
	 */
	pickPart(x: Item) {
		const sel = this.sel, h = this.h;
		const items: Item[] = "kind" in x
			? (selComps(sel).includes(x.id) ? h.components.filter(c => selComps(sel).includes(c.id) && c.kind === x.kind) : [x])
			: (sel?.wires?.includes(x.id) ? h.wires.filter(w => sel.wires!.includes(w.id)) : [x]);
		const what = items.length > 1 ? `${items.length} ${"kind" in x ? "components" : "wires"}` : x.id;
		const opts: { text: string; run: () => void }[] = partChoices(h, x).map(({ part: p, config, fits }) => ({
			text: [p.number || p.id, config && `· ${config}`, p.internalNumber && `[${p.internalNumber}]`, p.manufacturer, p.description,
				!fits && `(${p.type ?? "generic"})`].filter(Boolean).join("  "),
			run: () => {
				if (!this.cablesFollow(p, items.filter((i): i is Component => "kind" in i && i.kind === "cable"))) return;
				assignPart(h, items, p.id, config);
				this.changed();
			},
		}));
		opts.unshift({ text: "＋ Create new part from this", run: () => { const p = partFrom(h, x); assignPart(h, items, p.id); this.editPart(p); } });
		if (items.some(i => i.partId)) opts.push({ text: "✕ Unassign part", run: () => { assignPart(h, items); this.changed(); } });
		new Picker(this.app, `Assign a part to ${what}`, opts, o => o.text, o => o.run()).open();
	}

	get isLib() { return !!this.file && isLibExt(this.file.extension); }

	/** Everything set once per harness: units, electrical limits and the title block of exports. A library only has units. */
	editSettings() {
		const h = this.h, t = h.export ?? {};
		const TITLE = ["company", "title", "drawing", "date", "drawnBy", "notes"] as const;
		new FormModal(this.app, this.isLib ? "Library settings" : "Harness settings", [
			{ key: "currency", label: "Currency symbol", value: h.currency ?? "" },
			{ key: "length", label: "Default length unit", value: h.lengthUnit ?? "mm", options: Object.fromEntries(Object.keys(LENGTH_UNITS).map(u => [u, u])) },
			{ key: "gauge", label: "Default gauge unit", value: h.gaugeUnit ?? "mm²", options: Object.fromEntries(GAUGE_UNITS.map(u => [u, u])) },
			...this.isLib ? [] : [
				{ key: "voltage", label: "Supply voltage (V), for voltage drop", value: String(h.voltage ?? 12) },
				{ key: "maxDrop", label: "Allowed voltage drop per wire (%)", value: String(h.maxDrop ?? 5) },
				{ key: "company", label: "Title block: company", value: t.company ?? "" },
				{ key: "title", label: "Title block: title (empty: file name)", value: t.title ?? "" },
				{ key: "drawing", label: "Title block: drawing number", value: t.drawing ?? "" },
				{ key: "date", label: "Title block: date (empty: today)", value: t.date ?? "" },
				{ key: "drawnBy", label: "Title block: drawn by", value: t.drawnBy ?? "" },
				{ key: "notes", label: "Notes on exported drawings", value: t.notes ?? "", multiline: true },
			],
		], v => {
			if (v.currency.trim()) h.currency = v.currency.trim(); else delete h.currency;
			if (v.length === "mm") delete h.lengthUnit; else h.lengthUnit = v.length as LengthUnit;
			setGaugeUnit(h, v.gauge as GaugeUnit);
			if (!this.isLib) {
				const volts = Number(v.voltage), drop = Number(v.maxDrop); // defaults are left out of the file
				if (volts > 0 && volts !== 12) h.voltage = volts; else delete h.voltage;
				if (drop > 0 && drop !== 5) h.maxDrop = drop; else delete h.maxDrop;
				const kept = Object.fromEntries(TITLE.map(k => [k, v[k].trim()]).filter(([, s]) => s));
				if (Object.keys(kept).length) h.export = kept; else delete h.export;
			}
			this.changed();
		}).open();
	}

	/** Runs a Schematic action for a command; false (command hidden) when the Schematic isn't showing. */
	schematicAction(run: (s: Schematic) => unknown, checking: boolean): boolean {
		if (this.tab !== "schematic" || this.isLib) return false;
		if (!checking) void run(this.schematic);
		return true;
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
		const files = this.app.vault.getFiles().filter(f => isLibExt(f.extension) && f !== this.file);
		new LibraryPicker(this.app, files, async f => {
			const path = f?.path ?? (await this.app.vault.create(freePath(this.app, this.file?.parent?.path ?? "", "Parts library", "DClib"), JSON.stringify(emptyHarness(), null, "\t"))).path;
			const parts = this.h.parts.filter(p => p.number);
			await this.writeLib(path, lib => { for (const p of parts) copyPart(p, this.h, lib); });
			new Notice(`DC Wiring: ${parts.length} parts added to ${path}${parts.length < this.h.parts.length ? "; parts without a part number were skipped" : ""}.`);
		}).open();
	}

	/** Copies one library part (and its accessories) into this harness. */
	addFromLibrary() {
		const items = [...this.libs].flatMap(([lib, h]) => h.parts.filter(p => p.number).map(part => ({ lib, part })));
		if (!items.length) return void new Notice("DC Wiring: no part libraries with numbered parts in this vault. Run \"Install starter parts library\" for common DT, Superseal and Sumitomo DL connectors.");
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
			{ key: "current", label: "Current (A), for voltage drop", value: String(w.current ?? "") },
			this.partField(w.partId),
			{ key: "identLabel", label: "Ident label (printed on the wire)", value: w.ident?.label ?? "" },
			{ key: "identColors", label: "Ident colour bands, comma separated (e.g. rd, gn)", value: (w.ident?.colors ?? []).join(", ") },
		], v => {
			const label = v.identLabel.trim(), colors = v.identColors.split(",").map(s => s.trim()).filter(Boolean);
			if (label || colors.length) w.ident = { ...label ? { label } : {}, ...colors.length ? { colors } : {} }; else delete w.ident;
			if (v.name.trim()) w.name = v.name.trim(); else delete w.name;
			w.color = v.color.trim() || w.color;
			w.gauge = v.gauge.trim();
			w.length = Math.max(0, Number(v.length) || 0);
			if (Number(v.current) > 0) w.current = Number(v.current); else delete w.current;
			w.partId = v.partId || undefined;
			this.changed();
		}).open();
	}

	editSignal(c: Component, pin: number) {
		const m = new FormModal(this.app, `${compLabel(this.h, c)} cavity ${cavName(c, pin)}`, [
			{ key: "s", label: "Signal (e.g. +12V, GND, CAN H). Paste a column to fill the next cavities", value: c.signals?.[pin] ?? "" },
			{ key: "cav", label: "Cavity designation (empty = pin number)", value: c.cavities?.[pin - 1] ?? "" },
		], v => {
			c.signals = { ...c.signals, [pin]: v.s.trim() };
			if (!c.signals[pin]) delete c.signals[pin];
			if (!c.signals[pin] && c.globals) toggleOff(c, pin);
			const cav = Array.from({ length: c.pins }, (_, i) => c.cavities?.[i] ?? "");
			cav[pin - 1] = v.cav.trim();
			if (cav.some((s, i) => s && s !== String(i + 1))) c.cavities = cav; else delete c.cavities;
			this.changed();
		});
		m.open();
		// an input drops newlines, so a pasted column is caught before it lands
		m.contentEl.querySelector("input")?.addEventListener("paste", e => {
			const text = e.clipboardData?.getData("text") ?? "";
			if (!text.trim().includes("\n")) return;
			e.preventDefault();
			m.close();
			pasteSignals(c, pin, text);
			this.changed();
		});
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
		const ids = selComps(this.sel);
		const locked = ids.some(id => isLocked(this.h, id)) || this.h.wires.some(w => this.sel!.wires?.includes(w.id) && wireLocked(this.h, w));
		if (locked) return void new Notice("DC Wiring: unlock the group first.");
		for (const id of ids) removeComponent(this.h, id);
		if (this.sel.wires) this.h.wires = this.h.wires.filter(w => !this.sel!.wires!.includes(w.id));
		this.sel = null;
		this.changed();
	}

	// --- Rendering ---
	render() {
		if (!this.bar) return;
		if (this.isLib) this.tab = "parts"; // a library holds only parts
		this.renderBar();
		// keep the svg mounted while on a canvas, so a drag keeps its pointer capture
		const svg = this.tab === "schematic" ? this.schematic.el : this.tab === "layout" ? this.layout.svg : null;
		if (!svg || svg.parentElement !== this.body) this.body.empty();
		if (this.tab === "layout") {
			this.body.appendChild(this.layout.svg);
			this.layout.render();
			if (!this.layoutFitted && this.h.components.length) requestAnimationFrame(() => this.fitInitially());
		} else if (this.tab === "schematic") {
			this.body.appendChild(this.schematic.el);
			this.schematic.render();
			if (!this.fitted && this.h.components.length) requestAnimationFrame(() => this.fitInitially());
		} else if (this.tab === "connections") this.renderConnections();
		else this.renderParts();
		this.body.querySelector(".dcw-canvas-hint")?.remove(); // the canvas stays mounted between renders
		const hint = this.tab === "schematic" && !this.h.components.length
			? "Right-click the canvas or use + Connector to add parts. Drag from one pin to another to draw a wire. Press ? for all shortcuts."
			: this.tab === "layout" && !this.h.components.length ? "Add connectors on the Schematic first; they show up here to lay out."
			: this.tab === "layout" && !this.h.bundles?.length ? "Drag from the dot on one connector to another to lay a bundle between them. Wires then take their length from the bundles."
			: "";
		if (hint) this.body.createDiv({ cls: "dcw-canvas-hint", text: hint });
	}

	private renderBar() {
		// a clicked button is about to be removed: keep the keyboard in this view, or undo, delete and search stop working
		if (this.bar.contains(document.activeElement)) this.contentEl.focus({ preventScroll: true });
		this.bar.empty();
		const tabs = this.bar.createDiv("dcw-tabs");
		for (const [t, label] of this.isLib ? [["parts", "Library parts"] as const] : [["schematic", "Schematic"], ["layout", "Layout"], ["connections", "Connections"], ["parts", "Parts"]] as const) {
			const b = tabs.createEl("button", { text: label, cls: t === this.tab ? "is-active" : "" });
			b.onclick = () => { this.tab = t; this.render(); };
		}
		const actions = this.bar.createDiv("dcw-actions");
		if (this.tab === "schematic") {
			actions.createEl("button", { text: "+ Connector" }).onclick = () => this.addConnector();
			actions.createEl("button", { text: "+ Splice" }).onclick = () => this.schematic.add("splice");
			actions.createEl("button", { text: "+ Cable" }).onclick = () => this.schematic.addCable();
			actions.createEl("button", { text: "+ Sub-harness" }).onclick = () => { const p = this.schematic.center(); this.addSub(p.x, p.y); };
			actions.createEl("button", { text: this.sel?.wires ? "Auto route selected" : "Auto route" }).onclick = () => this.autoRoute();
			actions.createEl("button", { text: "Fit" }).onclick = () => this.schematic.fit();
			const ids = actions.createEl("button", { text: "Wire IDs", cls: this.h.hideWireIds ? "" : "is-active", attr: { "aria-label": "Show IDs on wires without a name" } });
			ids.onclick = () => { if (this.h.hideWireIds) delete this.h.hideWireIds; else this.h.hideWireIds = true; this.changed(); };
			const n = canvasWarnings(this.h).length;
			if (n) actions.createEl("button", { text: `⚠ ${n}`, cls: "dcw-warnbtn", attr: { "aria-label": "Go to the next warning" } }).onclick = () => this.schematic.nextWarning();
		} else if (this.tab === "layout") {
			actions.createEl("button", { text: "+ Branch point" }).onclick = () => this.layout.addBranchPoint();
			actions.createEl("button", { text: "Fit" }).onclick = () => this.layout.fit();
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
		}
		actions.createEl("button", { text: "Settings", attr: { "aria-label": "Units, voltage drop limit and title block" } }).onclick = () => this.editSettings();
		actions.createEl("button", { text: "Export" }).onclick = e => exportMenu(this, e);
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
		const h = this.h;
		const end = (e: End) => {
			const c = h.components.find(c => c.id === e.c);
			if (c?.kind === "harness") return `${c.name} › ${c.ports?.[e.pin - 1] ?? e.pin}`;
			if (c?.kind === "cable") return `${coreName(c, e.pin)} ${c.name}`;
			return c ? `${compLabel(h, c)} : ${cavName(c, e.pin)}` : `${e.c} : ${e.pin}`;
		};
		const warnings = validate(h);
		const general = warnings.filter(w => w.kind === "component" && !w.pin);
		if (general.length) this.body.createDiv({ cls: "dcw-warnings", text: "⚠ " + general.map(w => `${w.id}: ${w.message}`).join(" · ") });
		const bar = this.body.createDiv({ cls: "dcw-parts-bar" });
		const search = bar.createEl("input", { type: "search", cls: "dcw-search", placeholder: "Filter wires: ID, name, end, signal, colour, gauge, part", value: this.connFilter });
		search.oninput = () => {
			this.connFilter = search.value;
			this.render();
			const s = this.body.querySelector<HTMLInputElement>(".dcw-search");
			s?.focus();
			s?.setSelectionRange(s.value.length, s.value.length);
		};
		const routes = routeWires(h);
		const rows = h.wires.map(w => {
			const eff = effectiveWire(h, w), drop = voltageDrop(h, w, routes);
			const warn = warnings.filter(x => x.kind === "wire" ? x.id === w.id : x.kind === "component" && [w.from, w.to].some(e => e.c === x.id && e.pin === x.pin)).map(x => x.message);
			const sort: Record<string, string | number> = { id: w.id, name: w.name ?? "", from: end(w.from), to: end(w.to), signal: signalOf(h, w.from) ?? "",
				color: eff.color, gauge: eff.gauge, length: routes.get(w.id)?.length ?? w.length, current: w.current ?? 0, drop: drop ?? 0,
				part: h.parts.find(p => p.id === w.partId)?.number ?? "", warn: warn.join("; ") };
			return { w, eff, drop, warn, sort };
		});
		const f = this.connFilter.trim().toLowerCase();
		const k = this.connSort.key;
		const shown = rows
			.filter(r => !f || ["id", "name", "from", "to", "signal", "color", "gauge", "part"].some(x => String(r.sort[x]).toLowerCase().includes(f)))
			.sort((a, b) => {
				if (!k) return 0;
				const x = a.sort[k], y = b.sort[k];
				return this.connSort.dir * (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true }));
			});
		const table = this.body.createEl("table", { cls: "dcw-table dcw-connections" });
		const head = table.createEl("tr");
		for (const [key, t] of [["id", "ID"], ["name", "Name"], ["from", "From"], ["to", "To"], ["signal", "Signal"], ["color", "Colour"], ["gauge", "Gauge"],
			["length", "Length (mm)"], ["current", "Current (A)"], ["drop", "Drop"], ["part", "Part"], ["", "Twisted with"], ["warn", "Warnings"], ["", ""]]) {
			const sorted = !!key && k === key;
			const th = head.createEl("th", { text: t + (sorted ? (this.connSort.dir > 0 ? " ▲" : " ▼") : ""), cls: key ? "dcw-sortable" : "" });
			if (key) th.onclick = () => { this.connSort = { key, dir: sorted ? -this.connSort.dir : 1 }; this.render(); };
		}
		for (const { w, eff, drop, warn } of shown) {
			const tr = table.createEl("tr", { cls: this.sel?.wires?.includes(w.id) ? "is-selected" : "" });
			tr.onclick = e => { if (!(e.target as HTMLElement).closest("input, select")) this.select({ wires: [w.id] }); };
			const id = tr.createEl("td", { cls: "dcw-nowrap", text: w.id });
			if (warn.length) id.createSpan({ cls: "dcw-warn", text: " ⚠", attr: { title: warn.join("\n") } });
			const nameIn = tr.createEl("td").createEl("input", { value: w.name ?? "", placeholder: w.id });
			nameIn.onchange = () => { if (nameIn.value.trim()) w.name = nameIn.value.trim(); else delete w.name; this.changed(); };
			tr.createEl("td", { cls: "dcw-nowrap", text: end(w.from) });
			tr.createEl("td", { cls: "dcw-nowrap", text: end(w.to) });
			tr.createEl("td", { cls: "dcw-nowrap", text: signalOf(h, w.from) ?? "" });
			for (const key of ["color", "gauge", "length"] as const) {
				const r = key === "length" && routes.get(w.id);
				if (r) { tr.createEl("td", { text: String(Math.round(r.length)), attr: { title: `Routed through ${r.bundles.join(", ") || "no bundles"}` } }); continue; }
				const input = tr.createEl("td").createEl("input", { value: String(eff[key] || ""), type: key === "length" ? "number" : "text" });
				if (eff[key] !== w[key]) { input.disabled = true; input.title = "Set by the wire part"; }
				input.onchange = () => {
					if (key === "length") w.length = Math.max(0, Number(input.value) || 0);
					else w[key] = input.value.trim();
					this.changed();
				};
			}
			const amps = tr.createEl("td").createEl("input", { value: String(w.current ?? ""), type: "number", attr: { min: "0", step: "any" } });
			amps.onchange = () => { const a = Number(amps.value); if (a > 0) w.current = a; else delete w.current; this.changed(); };
			tr.createEl("td", { cls: "dcw-nowrap", text: drop === undefined ? "" : `${drop.toFixed(2)} V (${dropPercent(h, drop).toFixed(1)} %)` });
			this.partSelect(tr.createEl("td"), w.partId, id => { w.partId = id; this.changed(); });
			tr.createEl("td", { text: twistedWith(h, w.id).join(", ") });
			tr.createEl("td", { cls: "dcw-warn", text: warn.join("; ") });
			const del = tr.createEl("td").createEl("button", { text: "✕", attr: { "aria-label": `Delete ${w.id}` } });
			del.onclick = e => {
				e.stopPropagation();
				h.wires = h.wires.filter(x => x !== w);
				if (this.sel?.wires?.includes(w.id)) this.sel = null;
				this.changed();
			};
		}
		// each cable core is a conductor too: its ends are the wires landing on it. Not filtered, so hidden while filtering
		if (!f) for (const c of h.components) {
			if (c.kind !== "cable") continue;
			table.createEl("tr", { cls: "dcw-section" }).createEl("td", { text: `Cable ${c.id} ${c.name}`, attr: { colspan: 14 } });
			for (const pin of [...(c.cores ?? []).keys()].map(i => i + 1).concat(c.shield ? [0] : [])) {
				const ends = h.wires.flatMap(w => w.from.c === c.id && w.from.pin === pin ? [w.to] : w.to.c === c.id && w.to.pin === pin ? [w.from] : []);
				const core = c.cores?.[pin - 1];
				const tr = table.createEl("tr", { cls: "dcw-readonly" });
				for (const t of [coreName(c, pin), "", ends[0] ? end(ends[0]) : "", ends.slice(1).map(end).join(", "),
					signalOf(h, { c: c.id, pin }) ?? "", core?.color ?? "shield", core?.gauge ?? "", String(c.length || ""), "", "", h.parts.find(p => p.id === c.partId)?.number ?? "", "", ""]) tr.createEl("td", { text: t });
			}
		}
		if (!h.wires.length) this.body.createDiv({ cls: "dcw-empty", text: "No wires yet. Drag from one pin to another on the Schematic." });
		else if (!shown.length) this.body.createDiv({ cls: "dcw-empty", text: "No wires match the filter." });
	}

	private renderParts() {
		const h = this.h, cur = (n: number) => `${h.currency ?? ""}${n.toFixed(2)}`;
		const qty = (r: BomRow) => `${r.unit === "m" ? r.qty.toFixed(2) : r.qty} ${r.unit}`;
		const lib = this.isLib, libs = lib ? [] : [...this.libs];
		const warnings = validate(h).filter(w => w.kind === "part" && w.message !== "Not used"); // "Not used" shows in Qty
		const hidden = new Set<string>(this.app.loadLocalStorage(COLS_KEY) ?? []);
		const bar = this.body.createDiv({ cls: "dcw-parts-bar" });
		const search = bar.createEl("input", { type: "search", cls: "dcw-search", placeholder: "Filter parts", value: this.partFilter });
		search.oninput = () => {
			this.partFilter = search.value;
			this.render();
			const s = this.body.querySelector<HTMLInputElement>(".dcw-search");
			s?.focus();
			s?.setSelectionRange(s.value.length, s.value.length);
		};
		const picked = selComps(this.sel).length || this.sel?.wires?.length ? partsUsedBy(h, { components: selComps(this.sel), wires: this.sel?.wires }) : undefined;
		if (!lib) {
			const only = bar.createEl("button", { text: "Only selected", cls: this.onlySelected ? "mod-cta" : "",
				attr: { "aria-label": "Show only the parts used by the components and wires selected on the Schematic or Layout" } });
			only.onclick = () => { this.onlySelected = !this.onlySelected; this.render(); };
		}
		// cell: draws one cell; sub: text for the read-only sub-harness rows
		type Col = { key: string; title: string; sort?: boolean; cell: (td: HTMLElement, r: BomRow) => void; sub?: (r: BomRow) => string };
		const edit = (key: "number" | "internalNumber" | "manufacturer" | "description" | "price") => (td: HTMLElement, r: BomRow) => {
			const p = r.part, input = td.createEl("input", { value: String(p[key] ?? ""), type: key === "price" ? "number" : "text" });
			if (key === "number") input.placeholder = "Part number";
			input.onchange = () => {
				const v = input.value.trim();
				if (key === "price") p.price = Number(v) || 0;
				else if (key === "internalNumber") { if (v) p.internalNumber = v; else delete p.internalNumber; }
				else p[key] = v;
				this.changed();
			};
		};
		const all: Col[] = [
			{ key: "number", title: "Part number", sort: true, cell: edit("number"), sub: r => r.part.number },
			{ key: "specs", title: "Specs", cell: (td, r) => { td.setText(partSummary(r.part)); td.addClass("dcw-specs"); }, sub: r => partSummary(r.part) },
			{ key: "internalNumber", title: "Internal", sort: true, cell: edit("internalNumber"), sub: r => r.part.internalNumber ?? "" },
			{ key: "manufacturer", title: "Manufacturer", sort: true, cell: edit("manufacturer"), sub: r => r.part.manufacturer },
			{ key: "description", title: "Description", sort: true, cell: edit("description"), sub: r => r.part.description },
			{ key: "price", title: "Unit price", sort: true, cell: edit("price"), sub: r => cur(r.part.price) },
		];
		if (!lib) all.push(
			{ key: "qty", title: "Qty", sort: true, cell: (td, r) => { td.addClass("dcw-nowrap"); td.setText(!r.used ? "Not used" : qty(r) + (r.excluded ? " (excluded)" : "")); }, sub: qty },
			{ key: "total", title: "Total", sort: true, cell: (td, r) => td.setText(cur(r.total)), sub: r => cur(r.total) },
		);
		if (libs.length) all.push({ key: "libs", title: "Libraries", cell: (td, r) => {
			const p = r.part;
			td.addClass("dcw-libs");
			for (const [path, l] of libs) {
				const st = syncStatus(p, h, l), name = path.split("/").pop()!.replace(/\.dclib$/i, "");
				const push = () => this.writeLib(path, x => { copyPart(p, h, x); });
				if (st === "missing") td.createEl("button", { text: `+ ${name}`, attr: { "aria-label": `Add to ${path}` } }).onclick = push;
				else if (st === "in-sync") td.createSpan({ text: `✓ ${name}`, attr: { "aria-label": `In sync with ${path}` } });
				else if (st === "out-of-sync") {
					td.createSpan({ text: `≠ ${name} `, attr: { "aria-label": `Out of sync with ${path}` } });
					td.createEl("button", { text: "Push", attr: { "aria-label": `Update the part in ${path} to match this harness` } }).onclick = push;
					td.createEl("button", { text: "Pull", attr: { "aria-label": `Update this part to match ${path}` } }).onclick = () => {
						copyPart(l.parts.find(x => x.number === p.number)!, l, h);
						this.changed();
					};
				}
			}
		} });
		all.push({ key: "warnings", title: "Warnings", cell: (td, r) => { td.addClass("dcw-warn"); td.setText(warnings.filter(w => w.id === r.part.id).map(w => w.message).join("; ")); } });
		const cols = all.filter(c => c.key === "number" || !hidden.has(c.key));
		const colsBtn = bar.createEl("button", { text: "Columns" });
		colsBtn.onclick = e => {
			const m = new Menu();
			for (const c of all) if (c.key !== "number") m.addItem(i => i.setTitle(c.title).setChecked(!hidden.has(c.key)).onClick(() => {
				if (hidden.has(c.key)) hidden.delete(c.key); else hidden.add(c.key);
				this.app.saveLocalStorage(COLS_KEY, [...hidden]);
				this.render();
			}));
			m.showAtMouseEvent(e);
		};

		const table = this.body.createEl("table", { cls: "dcw-table" });
		const head = table.createEl("tr");
		for (const c of cols) {
			const sorted = c.sort && this.partSort.key === c.key;
			const th = head.createEl("th", { text: c.title + (sorted ? (this.partSort.dir > 0 ? " ▲" : " ▼") : ""), cls: c.sort ? "dcw-sortable" : "" });
			if (c.sort) th.onclick = () => { this.partSort = { key: c.key, dir: sorted ? -this.partSort.dir : 1 }; this.render(); };
		}
		head.createEl("th");
		const span = cols.length + 1;
		const f = this.partFilter.trim().toLowerCase();
		const val = (r: BomRow) => { const k = this.partSort.key; return k === "qty" || k === "total" ? r[k] : (r.part as unknown as Record<string, unknown>)[k] ?? ""; };
		const rows = bom(h);
		const shown = rows
			.filter(r => !f || [r.part.number, r.part.internalNumber, r.part.manufacturer, r.part.description, r.part.type, partSummary(r.part)].some(s => s?.toLowerCase().includes(f)))
			.filter(r => lib || !this.onlySelected || !!picked?.has(r.part.id))
			.sort((a, b) => {
				if (!this.partSort.key) return 0;
				const x = val(a), y = val(b);
				return this.partSort.dir * (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true }));
			});
		const sections: [string, BomRow[]][] = [...Object.entries(PART_TYPES).map(([t, d]) => [d.label, shown.filter(r => r.part.type === t)] as [string, BomRow[]]),
			["Generic parts", shown.filter(r => !r.part.type)]];
		for (const [label, list] of sections) {
			if (!list.length) continue;
			table.createEl("tr", { cls: "dcw-section" }).createEl("td", { text: label, attr: { colspan: span } });
			for (const r of list) {
				const p = r.part;
				const tr = table.createEl("tr", { cls: [!lib && !r.used ? "is-unused" : "", r.excluded ? "is-excluded" : "", picked?.has(p.id) ? "is-picked" : ""].join(" ").trim() });
				tr.ondblclick = () => this.editPart(p);
				for (const c of cols) c.cell(tr.createEl("td"), r);
				const td = tr.createEl("td", { cls: "dcw-row-actions" });
				td.createEl("button", { text: "✎", attr: { "aria-label": "Edit part" } }).onclick = () => this.editPart(p);
				td.createEl("button", { text: "✕", attr: { "aria-label": "Delete part" } }).onclick = () => { removePart(h, p.id); this.changed(); };
			}
		}
		if (lib) {
			if (!rows.length) this.body.createDiv({ cls: "dcw-empty", text: "No parts in this library yet. Add one with “+ Part”, or use “All to library” in a harness." });
			return;
		}
		const fromSubs = this.onlySelected ? [] : this.subParts();
		if (fromSubs.length) {
			table.createEl("tr", { cls: "dcw-section" }).createEl("td", { text: "From sub-harnesses (edit them in their own file)", attr: { colspan: span } });
			for (const r of fromSubs) {
				const tr = table.createEl("tr", { cls: "dcw-readonly" });
				for (const c of cols) tr.createEl("td", { text: c.sub?.(r) ?? "" });
				tr.createEl("td");
			}
		}
		// the total sits in the Total column, or at the end when that column is hidden
		const total = table.createEl("tr", { cls: "dcw-total" }), at = cols.findIndex(c => c.key === "total");
		const sum = cur([...rows.filter(r => !r.excluded), ...fromSubs].reduce((s, r) => s + r.total, 0));
		total.createEl("td", { text: this.onlySelected ? "Total (all parts)" : "Total", attr: { colspan: at > 0 ? at : cols.length } });
		total.createEl("td", { text: sum });
		if (!rows.length) this.body.createDiv({ cls: "dcw-empty", text: "No parts yet. Add one with “+ Part”, then assign it to connectors and wires." });
		else if (this.onlySelected && !shown.length) this.body.createDiv({ cls: "dcw-empty", text: "Nothing selected uses a part. Select components or wires on the Schematic or Layout." });
	}

	private partSelect(parent: HTMLElement, value: string | undefined, set: (id: string | undefined) => void) {
		const s = parent.createEl("select", { cls: "dropdown" });
		s.createEl("option", { text: this.h.parts.length ? "— none —" : "No part", value: "" });
		for (const p of this.h.parts) s.createEl("option", { text: p.number || p.id, value: p.id });
		s.value = value ?? "";
		s.onchange = () => set(s.value || undefined);
	}
}

// a cleared signal can't stay global
function toggleOff(c: Component, pin: number) {
	c.globals = c.globals!.filter(p => p !== pin);
	if (!c.globals.length) delete c.globals;
}

/** Pick an existing harness file to use as a sub-harness, or null for a new one. */
class SubPicker extends FuzzySuggestModal<TFile | null> {
	constructor(app: App, private self: TFile, private done: (f: TFile | null) => void) {
		super(app);
		this.setPlaceholder("Choose a harness to use as sub-harness, or create a new one");
	}
	getItems() { return [null, ...this.app.vault.getFiles().filter(f => isHarnessExt(f.extension) && f !== this.self)]; }
	getItemText(f: TFile | null) { return f ? f.path : "＋ New sub-harness"; }
	onChooseItem(f: TFile | null) { this.done(f); }
}
