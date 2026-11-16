import { test } from "node:test";
import assert from "node:assert/strict";
import { bom, computeNets, emptyHarness, parseHarness, removeComponent, signalOf, type Harness } from "./model.ts";
import { coreName, parseCores, partCores, setCores, twist, twistedWith, untwist, wiresLost } from "./cable.ts";
import { fitsItem, partFrom } from "./parts.ts";
import { addToGroup, splitGroup, wireLocked } from "./groups.ts";
import { routeWires, wireLength } from "./bundles.ts";

const wire = (id: string, a: string, b: string) => {
	const [ac, ap] = a.split(":"), [bc, bp] = b.split(":");
	return { id, from: { c: ac, pin: Number(ap) }, to: { c: bc, pin: Number(bp) }, color: "black", gauge: "", length: 100 };
};

function cabled(): Harness {
	const h = emptyHarness();
	h.components = [
		{ id: "C1", kind: "connector", name: "ECU", x: 0, y: 0, pins: 2, signals: { 1: "CAN H" } },
		{ id: "CB1", kind: "cable", name: "Bus", x: 200, y: 0, pins: 2, cores: parseCores("ye 0.35, gn 0.35"), shield: true, length: 2000, partId: "P1" },
		{ id: "C2", kind: "connector", name: "Dash", x: 400, y: 0, pins: 2 },
	];
	h.wires = [wire("W1", "C1:1", "CB1:1"), wire("W2", "CB1:1", "C2:1"), wire("W3", "C1:2", "CB1:2"), wire("W4", "CB1:0", "C2:2")];
	h.parts = [{ id: "P1", number: "2x0.35 shielded", manufacturer: "", description: "", price: 1.5 }];
	return h;
}

test("a cable core conducts between its two ends; cores and shield are separate nets", () => {
	const h = cabled(), n = computeNets(h);
	assert.equal(n.get("C1:1"), n.get("C2:1"));
	assert.notEqual(n.get("C1:1"), n.get("C1:2"));
	assert.notEqual(n.get("CB1:0"), n.get("CB1:1"));
	assert.equal(signalOf(h, { c: "C2", pin: 1 }), "CAN H");
	assert.equal(coreName(h.components[1], 2), "CB1.2");
	assert.equal(coreName(h.components[1], 0), "CB1.S");
});

test("cables parse, count in metres, and dropping cores drops their wires", () => {
	const h = parseHarness(JSON.stringify(cabled()));
	assert.equal(h.components[1].pins, 2);
	assert.deepEqual(bom(h).map(r => [r.qty, r.unit]), [[2, "m"]]);
	setCores(h, h.components[1], parseCores("ye"), false);
	assert.deepEqual(h.wires.map(w => w.id), ["W1", "W2"]);
	assert.equal(h.components[1].pins, 1);
	assert.deepEqual(parseCores("rd/wh 0.5, bk"), [{ color: "rd/wh", gauge: "0.5" }, { color: "bk", gauge: "" }]);
});

test("twist joins groups, untwist dissolves a group of one", () => {
	const h = cabled();
	twist(h, ["W1", "W3"]);
	twist(h, ["W3", "W4"]);
	assert.deepEqual(twistedWith(h, "W1"), ["W3", "W4"]);
	untwist(h, "W4");
	assert.deepEqual(twistedWith(h, "W1"), ["W3"]);
	untwist(h, "W1");
	assert.ok(h.wires.every(w => !w.twist));
	twist(h, ["W1", "W2"]);
	assert.equal(h.wires[0].twist, "TW2"); // ids are not reused
});

test("groups: one group per component, locked inside only, group part is one BOM line, delete cleans up", () => {
	const h = cabled();
	const g = addToGroup(h, "C1", undefined, "ECU");
	addToGroup(h, "CB1", g.id);
	g.locked = true;
	h.parts.push({ id: "P2", number: "ECU 123", manufacturer: "", description: "", price: 300 });
	g.partId = "P2";
	assert.equal(wireLocked(h, h.wires[0]), true); // C1 -> CB1, both inside
	assert.equal(wireLocked(h, h.wires[1]), false); // CB1 -> C2 leaves the group
	const g2 = addToGroup(h, "CB1", undefined, "Other");
	assert.deepEqual(g.members, ["C1"]);
	assert.deepEqual(g2.members, ["CB1"]);
	assert.deepEqual(bom(h).map(r => [r.qty, r.unit, r.total]), [[2, "m", 3], [1, "pcs", 300]]);
	removeComponent(h, "CB1");
	assert.deepEqual(h.groups!.map(g => g.id), ["G1"]);
});

test("save group as sub-harness: moves members and inner wires, reconnects leaving wires to the block", () => {
	const h = emptyHarness();
	h.components = [
		{ id: "C1", kind: "connector", name: "ECU", x: 100, y: 40, pins: 2 },
		{ id: "S1", kind: "splice", name: "S1", x: 300, y: 60, pins: 1 },
		{ id: "C2", kind: "connector", name: "Lamp", x: 600, y: 0, pins: 2 },
	];
	h.wires = [wire("W1", "C1:1", "S1:1"), wire("W2", "C2:1", "C1:2"), wire("W3", "S1:1", "C2:2")];
	addToGroup(h, "C1", undefined, "Front");
	addToGroup(h, "S1", "G1");
	assert.throws(() => splitGroup(h, "G1", "Front.harness"), /W3 leaves the group from S1/);
	assert.equal(h.components.length, 3); // untouched
	h.wires.pop();
	const sub = splitGroup(h, "G1", "Front.harness");
	assert.deepEqual(sub.components.map(c => c.id), ["C1", "S1"]);
	assert.deepEqual(sub.wires.map(w => w.id), ["W1"]);
	assert.equal(sub.components[0].exposed, true);
	const block = h.components.find(c => c.kind === "harness")!;
	assert.deepEqual([block.id, block.name, block.file, block.ports, block.x, block.y], ["H1", "Front", "Front.harness", ["C1:1", "C1:2"], 100, 40]);
	assert.deepEqual(h.wires.map(w => [w.id, w.to]), [["W2", { c: "H1", pin: 2 }]]);
	assert.equal(h.groups, undefined);
});

test("save group as sub-harness: bundles into the group end at the block, so wires stay routed", () => {
	const h = emptyHarness();
	h.components = [
		{ id: "C1", kind: "connector", name: "ECU", x: 0, y: 0, pins: 2, pos: { x: 10, y: 20 } },
		{ id: "C3", kind: "connector", name: "Plug", x: 50, y: 0, pins: 2 },
		{ id: "C2", kind: "connector", name: "Lamp", x: 600, y: 0, pins: 2 },
	];
	h.wires = [wire("W1", "C1:1", "C3:1"), wire("W2", "C2:1", "C1:2")];
	h.bundles = [{ id: "B1", from: "C1", to: "C3", length: 100 }, { id: "B2", from: "C2", to: "C1", length: 800 }];
	h.mates = [{ a: "C3", b: "C2" }];
	addToGroup(h, "C1", undefined, "Front");
	addToGroup(h, "C3", "G1");
	splitGroup(h, "G1", "Front.DC");
	assert.deepEqual(h.bundles, [{ id: "B2", from: "C2", to: "H1", length: 800 }]); // inside one dropped, crossing one repointed
	assert.equal(h.mates?.length, 0);
	assert.deepEqual(h.components.find(c => c.id === "H1")!.pos, { x: 10, y: 20 });
	assert.equal(wireLength(h, h.wires[0], routeWires(h)), 800); // W2 still routed
});

test("cable parts list their cores; a cable taking the part gets them, and partFrom copies them back", () => {
	const h = cabled(), cb = h.components[1];
	const p = { id: "P9", number: "3x0.5", manufacturer: "", description: "", price: 1, type: "cable" as const, coreList: parseCores("rd 0.5"), cores: 1 };
	assert.equal(partCores({ ...p, type: "wire" }), undefined);
	const pc = partCores(p)!;
	assert.deepEqual(wiresLost(h, cb, pc.cores, pc.shield).map(w => w.id), ["W3", "W4"]); // core 2 and the shield go
	assert.equal(fitsItem(p, cb), false); // 1 core vs 2
	const back = partFrom(h, cb);
	assert.deepEqual([back.cores, back.coreList, back.shield], [2, parseCores("ye 0.35, gn 0.35"), true]);
	assert.equal(fitsItem(back, cb), true);
});
