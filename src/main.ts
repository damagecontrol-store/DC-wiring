import { Platform, Plugin, TFile, TFolder } from "obsidian";
import { emptyHarness, parseHarness, relinkSub, isHarnessExt } from "./model.ts";
import { EXPORTS } from "./output.ts";
import { freePath } from "./ui.ts";
import { HarnessView, VIEW_TYPE } from "./view.ts";

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

	private async create(folder?: TFolder, ext = "DC") {
		const dir = folder ?? this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? "");
		const file = await this.app.vault.create(freePath(this.app, dir.path, ext === "DClib" ? "Parts library" : "Harness", ext), JSON.stringify(emptyHarness(), null, "\t"));
		await this.app.workspace.getLeaf(true).openFile(file);
	}
}
