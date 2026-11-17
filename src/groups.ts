// Groups: named frames around components (devices, regions). Pure, no DOM.
import { nextId, removeComponent, syncPorts, type Component, type End, type Group, type Harness, type Wire } from "./model.ts";

export const groupOf = (h: Harness, compId: string) => h.groups?.find(g => g.members.includes(compId));
export const isLocked = (h: Harness, compId: string) => !!groupOf(h, compId)?.locked;
/** Wires between two members of a locked group are locked too; wires from outside stay editable. */
export function wireLocked(h: Harness, w: Wire) {
	const g = groupOf(h, w.from.c);
	return !!g?.locked && g.members.includes(w.to.c);
}

/** Moves a component into a group (a new one named `name` when groupId is not found). A component is in one group at most. */
export function addToGroup(h: Harness, compId: string, groupId?: string, name = "Group"): Group {
	removeFromGroup(h, compId);
	let g = h.groups?.find(g => g.id === groupId);
	if (!g) {
		g = { id: nextId(h, "G", h.groups ?? []), name, members: [] };
		h.groups = [...h.groups ?? [], g];
	}
	g.members.push(compId);
	return g;
}

/** Takes a component out of its group; an emptied group is removed. */
export function removeFromGroup(h: Harness, compId: string) {
	if (h.groups) h.groups = h.groups.filter(g => (g.members = g.members.filter(m => m !== compId)).length);
}

export function ungroup(h: Harness, groupId: string) {
	h.groups = h.groups?.filter(g => g.id !== groupId);
	if (!h.groups?.length) delete h.groups;
}

/** Moves the members and the bend points of wires inside the group. */
export function moveGroup(h: Harness, g: Group, dx: number, dy: number) {
	for (const c of h.components) if (g.members.includes(c.id)) { c.x += dx; c.y += dy; }
	for (const w of h.wires) if (g.members.includes(w.from.c) && g.members.includes(w.to.c)) for (const p of w.points ?? []) { p.x += dx; p.y += dy; }
}

/**
 * Moves a group's components and internal wires out of h into a new harness stored at `file`, and puts a
 * sub-harness block in their place. Connectors with wires leaving the group are exposed, and those wires
 * reconnect to the block's ports. Throws (leaving h untouched) when a wire leaves from anything but a connector,
 * since only connectors can be ports. Returns the new harness.
 */
export function splitGroup(h: Harness, groupId: string, file: string): Harness {
	const g = h.groups?.find(g => g.id === groupId);
	if (!g) throw new Error(`no group ${groupId}`);
	const inside = (e: End) => g.members.includes(e.c);
	const comps = h.components.filter(c => g.members.includes(c.id));
	const internal = h.wires.filter(w => inside(w.from) && inside(w.to));
	const crossing = h.wires.filter(w => inside(w.from) !== inside(w.to));
	const inner = (w: Wire) => inside(w.from) ? w.from : w.to;
	for (const w of crossing) {
		const c = comps.find(c => c.id === inner(w).c)!;
		if (c.kind !== "connector") throw new Error(`${w.id} leaves the group from ${c.id}; only connectors can connect a sub-harness`);
	}
	for (const w of crossing) comps.find(c => c.id === inner(w).c)!.exposed = true;
	const used = new Set([...comps, ...internal].map(x => x.partId));
	const sub: Harness = { version: 1, components: comps, wires: internal, parts: h.parts.filter(p => used.has(p.id)).map(p => ({ ...p })) };
	const block: Component = {
		id: nextId(h, "H", h.components), kind: "harness", name: g.name, pins: 0, file, ports: [],
		x: Math.min(...comps.map(c => c.x)), y: Math.min(...comps.map(c => c.y)), ...g.partId ? { partId: g.partId } : {},
	};
	const placed = comps.find(c => c.pos); // keep the block where the group sat on the Layout view
	if (placed?.pos) block.pos = { ...placed.pos };
	syncPorts(block, sub);
	for (const w of crossing) {
		const e = inner(w);
		Object.assign(e, { c: block.id, pin: block.ports!.indexOf(`${e.c}:${e.pin}`) + 1 });
		delete w.points; // drawn for the old connector position
	}
	// bundles into the group now end at the block, so the wires to it stay routed and keep their lengths
	const member = (id: string) => g.members.includes(id);
	h.bundles = h.bundles?.filter(b => !(member(b.from) && member(b.to)));
	for (const b of h.bundles ?? []) { if (member(b.from)) b.from = block.id; if (member(b.to)) b.to = block.id; }
	for (const id of [...g.members]) removeComponent(h, id); // also drops internal wires, mates and group membership
	h.components.push(block);
	ungroup(h, g.id);
	return sub;
}
