// Part libraries: a .harnesslib file is a harness file holding only parts. Parts match by part number.
// Pure: no Obsidian imports, so tests can load it.

import { nextId, type Harness, type Part } from "./model.ts";

/** The part as it would be stored in another file: no id, configuration items by part number. */
function portable(p: Part, h: Harness) {
	const { id: _, ...rest } = p;
	if (rest.configurations) rest.configurations = rest.configurations.map(cf => ({
		...cf, items: cf.items.map(i => ({ ...i, partId: h.parts.find(x => x.id === i.partId)?.number ?? "" })),
	}));
	return rest;
}

// key order and empty fields don't make a part different
const canon = (v: unknown) => JSON.stringify(v, (_, x) => x && typeof x === "object" && !Array.isArray(x)
	? Object.fromEntries(Object.entries(x).filter(([, y]) => y !== "" && y !== false && y != null).sort(([a], [b]) => a < b ? -1 : 1))
	: x);

export type Sync = "missing" | "in-sync" | "out-of-sync";

/** How a part compares with the library part of the same number. Undefined when it has no number to match on. */
export function syncStatus(p: Part, h: Harness, lib: Harness): Sync | undefined {
	if (!p.number) return;
	const q = lib.parts.find(x => x.number === p.number);
	if (!q) return "missing";
	return canon(portable(p, h)) === canon(portable(q, lib)) ? "in-sync" : "out-of-sync";
}

/**
 * Copies a part into another file, replacing the part with the same number there (keeping its id).
 * Accessories its configurations use are added when missing. Returns the part's id in `to`.
 */
export function copyPart(p: Part, from: Harness, to: Harness): string {
	const old = to.parts.find(x => x.number === p.number);
	const { configurations, ...rest } = structuredClone(p);
	const copy: Part = { ...rest, id: old?.id ?? nextId(to, "P", to.parts) };
	if (old) to.parts[to.parts.indexOf(old)] = copy; else to.parts.push(copy);
	// after the part is in place, so a configuration that refers to its own part doesn't loop
	if (configurations) copy.configurations = configurations.map(cf => ({
		...cf,
		items: cf.items.flatMap(i => {
			const acc = from.parts.find(x => x.id === i.partId);
			// shortcut: accessories without a part number can't be matched across files, so they are left out
			if (!acc?.number) return [];
			return [{ ...i, partId: to.parts.find(x => x.number === acc.number)?.id ?? copyPart(acc, from, to) }];
		}),
	}));
	return copy.id;
}
