import { Notice, Platform, Plugin, TFile, TFolder } from "obsidian";
import { installStarter, STARTER_DIR, STARTER_LIB } from "./starter.ts";
import { emptyHarness, parseHarness, relinkSub, isHarnessExt } from "./model.ts";
import { EXPORTS } from "./output.ts";
import type { Schematic } from "./schematic.ts";
import { freePath, showShortcuts } from "./ui.ts";
import { HarnessView, VIEW_TYPE } from "./view.ts";

// Schematic keys as commands too: they show in the command palette and can get their own hotkeys
const SCHEMATIC: [string, string, (s: Schematic) => unknown][] = [
	["search", "Search components (Space)", s => s.openSearch()],
	["fit", "Fit schematic to view (F)", s => s.fit()],
	["toggle-net", "Toggle whole-net highlight (N)", s => s.toggle("net")],
	["toggle-ids", "Toggle component IDs (I)", s => s.toggle("ids")],
	["toggle-destinations", "Toggle destinations: type where each cavity goes (D)", s => s.toggle("dest")],
	["duplicate", "Duplicate selected components", s => s.duplicateSelection()],
	["copy", "Copy selected components", s => s.copy()],
	["paste", "Paste components", s => s.paste()],
	["next-warning", "Go to the next warning", s => s.nextWarning()],
];

export default class DCWiringPlugin extends Plugin {
	async onload() {
		this.registerView(VIEW_TYPE, leaf => new HarnessView(leaf));
		this.registerExtensions(["dc", "dclib"], VIEW_TYPE);
		this.addRibbonIcon("cable", "New harness", () => this.create());
		this.addCommand({ id: "new-harness", name: "New harness", callback: () => this.create() });
		for (const x of EXPORTS) this.addCommand({ id: x.id, name: x.name, checkCallback: check => {
			const v = this.app.workspace.getActiveViewOfType(HarnessView);
			if (!v || (x.desktop && !Platform.isDesktopApp)) return false;
			if (!check) void x.run(v);
			return true;
		} });
		this.addCommand({
			id: "open-layout-beside", name: "Open layout beside schematic", checkCallback: checking => {
				const view = this.app.workspace.getActiveViewOfType(HarnessView);
				if (!view?.file || checking) return !!view?.file;
				const file = view.file;
				view.showTab("schematic");
				const leaf = this.app.workspace.getLeaf("split", "vertical");
				void leaf.openFile(file).then(() => (leaf.view as HarnessView).showTab("layout"));
			},
		});
		for (const [id, name, run] of SCHEMATIC) this.addCommand({ id, name, checkCallback: checking =>
			this.app.workspace.getActiveViewOfType(HarnessView)?.schematicAction(run, checking) ?? false });
		this.addCommand({ id: "show-shortcuts", name: "Show keyboard and mouse shortcuts", callback: () => showShortcuts(this.app) });
		this.addCommand({ id: "edit-title-block", name: "Harness settings: units, voltage drop, title block", checkCallback: checking => { // id kept so existing hotkeys survive
			const v = this.app.workspace.getActiveViewOfType(HarnessView);
			if (v && !checking) v.editSettings();
			return !!v;
		} });
		this.addCommand({ id: "new-part-library", name: "New part library", callback: () => this.create(undefined, "DClib") });
		// only in a harness, not in a library: a library has nothing to add from or to
		const inHarness = (run: (v: HarnessView) => void) => (checking: boolean) => {
			const v = this.app.workspace.getActiveViewOfType(HarnessView);
			if (!v || v.isLib) return false;
			if (!checking) run(v);
			return true;
		};
		this.addCommand({ id: "add-parts-to-library", name: "Add all harness parts to a part library", checkCallback: inHarness(v => v.addAllToLibrary()) });
		this.addCommand({ id: "add-part-from-library", name: "Add a part from a part library", checkCallback: inHarness(v => v.addFromLibrary()) });
		this.addCommand({ id: "install-starter-library", name: "Install starter parts library (DT, Superseal, Sumitomo DL)", callback: () => this.installStarter() });
		// keep sub-harness links working when a harness file is renamed or moved
		this.registerEvent(this.app.vault.on("rename", async (file, oldPath) => {
			if (!(file instanceof TFile) || !isHarnessExt(file.extension)) return;
			for (const f of this.app.vault.getFiles()) {
				if (!isHarnessExt(f.extension) || f === file) continue;
				if (this.app.workspace.getLeavesOfType(VIEW_TYPE).some(l => (l.view as HarnessView).file === f)) continue; // open views fix themselves
				if (!(await this.app.vault.cachedRead(f)).includes(JSON.stringify(oldPath))) continue;
				await this.app.vault.process(f, text => {
					try {
						const h = parseHarness(text);
						return relinkSub(h, oldPath, file.path) ? JSON.stringify(h, null, "\t") : text;
					} catch { return text; } // not valid JSON: leave it alone
				});
			}
		}));
		this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
			if (file instanceof TFolder) menu.addItem(i => i.setTitle("New harness").setIcon("cable").onClick(() => this.create(file)));
		}));
	}

	/** Writes the starter library and its face images; a library already there keeps the user's own parts. */
	private async installStarter() {
		const vault = this.app.vault;
		const file = vault.getFileByPath(STARTER_LIB);
		let existing;
		try {
			if (file) existing = parseHarness(await vault.read(file));
		} catch (e) {
			return void new Notice(`DC Wiring: ${STARTER_LIB} can't be read (${(e as Error).message}); nothing was changed.`);
		}
		for (const dir of [STARTER_DIR, `${STARTER_DIR}/images`]) if (!vault.getFolderByPath(dir)) await vault.createFolder(dir);
		const { lib, images } = installStarter(existing);
		const write = async (path: string, text: string) => {
			const f = vault.getFileByPath(path);
			return f ? (await vault.modify(f, text), f) : vault.create(path, text);
		};
		for (const [path, svg] of Object.entries(images)) await write(path, svg);
		const out = await write(STARTER_LIB, JSON.stringify(lib, null, "\t"));
		new Notice(`DC Wiring: starter library installed, ${lib.parts.length} parts.${existing ? " Starter parts were reset; your own parts were kept." : ""}`);
		const open = this.app.workspace.getLeavesOfType(VIEW_TYPE).find(l => (l.view as HarnessView).file === out);
		if (open) this.app.workspace.setActiveLeaf(open, { focus: true }); else await this.app.workspace.getLeaf(true).openFile(out);
	}

	private async create(folder?: TFolder, ext = "DC") {
		const dir = folder ?? this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? "");
		const file = await this.app.vault.create(freePath(this.app, dir.path, ext === "DClib" ? "Parts library" : "Harness", ext), JSON.stringify(emptyHarness(), null, "\t"));
		await this.app.workspace.getLeaf(true).openFile(file);
	}
}
