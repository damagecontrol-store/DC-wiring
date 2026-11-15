import { Plugin, TFile, TFolder } from "obsidian";
import { emptyHarness, parseHarness, relinkSub } from "./model.ts";
import { freePath } from "./ui.ts";
import { HarnessView, VIEW_TYPE } from "./view.ts";

export default class DCWiringPlugin extends Plugin {
	async onload() {
		this.registerView(VIEW_TYPE, leaf => new HarnessView(leaf));
		this.registerExtensions(["harness"], VIEW_TYPE);
		this.addRibbonIcon("cable", "New harness", () => this.create());
		this.addCommand({ id: "new-harness", name: "New harness", callback: () => this.create() });
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
		// keep sub-harness links working when a .harness file is renamed or moved
		this.registerEvent(this.app.vault.on("rename", async (file, oldPath) => {
			if (!(file instanceof TFile) || file.extension !== "harness") return;
			for (const f of this.app.vault.getFiles()) {
				if (f.extension !== "harness" || f === file) continue;
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

	private async create(folder?: TFolder) {
		const dir = folder ?? this.app.fileManager.getNewFileParent(this.app.workspace.getActiveFile()?.path ?? "");
		const file = await this.app.vault.create(freePath(this.app, dir.path, "Harness"), JSON.stringify(emptyHarness(), null, "\t"));
		await this.app.workspace.getLeaf(true).openFile(file);
	}
}
