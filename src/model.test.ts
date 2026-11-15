import { test } from "node:test";
import assert from "node:assert/strict";
import { bom, computeNets, relinkSub, emptyHarness, netWires, nextId, parseHarness, parsePins, portLabel, removeComponent, removePart, signalOf, subBom, syncPorts, wireLabel, type Harness } from "./model.ts";

function sample(): Harness {
	const h = emptyHarness();
	h.components = [
		{ id: "C1", kind: "connector", name: "ECU", x: 0, y: 0, pins: 3, signals: { 1: "VCC" }, partId: "P1" },
		{ id: "S1", kind: "splice", name: "S1", x: 0, y: 0, pins: 1 },
		{ id: "C2", kind: "connector", name: "Lamp", x: 0, y: 0, pins: 2, partId: "P1" },
	];
	h.wires = [
		{ id: "W1", from: { c: "C1", pin: 1 }, to: { c: "S1", pin: 1 }, color: "red", gauge: "1", length: 500, partId: "P2" },
		{ id: "W2", from: { c: "S1", pin: 1 }, to: { c: "C2", pin: 1 }, color: "red", gauge: "1", length: 250, partId: "P2" },
		{ id: "W3", from: { c: "C1", pin: 2 }, to: { c: "C2", pin: 2 }, color: "black", gauge: "1", length: 750 },
	];
	h.parts = [
		{ id: "P1", number: "DT04-2P", manufacturer: "TE", description: "", price: 2 },
		{ id: "P2", number: "FLRY 1.0", manufacturer: "", description: "", price: 0.4 },
	];
	return h;
}

test("nets join through splices and stay apart otherwise", () => {
	const n = computeNets(sample());
	assert.equal(n.get("C1:1"), n.get("C2:1"));
	assert.notEqual(n.get("C1:1"), n.get("C1:2"));
});

test("selecting a wire highlights its whole net", () => {
	assert.deepEqual([...netWires(sample(), { wires: ["W1"] })].sort(), ["W1", "W2"]);
	assert.equal(netWires(sample(), { component: "C2" }).size, 3);
});

test("signals propagate over the net", () => {
	assert.equal(signalOf(sample(), { c: "C2", pin: 1 }), "VCC");
	assert.equal(signalOf(sample(), { c: "C2", pin: 2 }), undefined);
});

test("bom counts pieces and wire metres", () => {
	const [conn, wire] = bom(sample());
	assert.deepEqual([conn.qty, conn.unit, conn.total], [2, "pcs", 4]);
	assert.equal(wire.unit, "m");
	assert.ok(Math.abs(wire.qty - 0.75) < 1e-9 && Math.abs(wire.total - 0.3) < 1e-9);
});

test("pin counts accept rows x cols", () => {
	assert.deepEqual(parsePins("8"), { pins: 8 });
	assert.deepEqual(parsePins(" 2x4 "), { pins: 8, layout: { rows: 2, cols: 4 } });
	assert.deepEqual(parsePins("3×6"), { pins: 18, layout: { rows: 3, cols: 6 } });
	for (const bad of ["", "0", "2x0", "abc", "20x20"]) assert.equal(parsePins(bad), undefined, bad);
});

test("ids, removal and parsing", () => {
	const h = sample();
	assert.equal(nextId(h, "C", h.components), "C3");
	removeComponent(h, "S1");
	assert.deepEqual(h.wires.map(w => w.id), ["W3"]);
	removePart(h, "P1");
	assert.equal(h.components[0].partId, undefined);
	assert.deepEqual(parseHarness(""), emptyHarness());
	assert.equal(parseHarness('{"components":[{"id":"S1","kind":"splice"}]}').components[0].pins, 1);
	assert.throws(() => parseHarness("{broken"));
});

test("sub-harness ports: exposed pins only, stable numbering, labels", () => {
	const sub = sample();
	sub.components[0].exposed = true; // C1 ECU, 3 pins
	const block = { id: "H1", kind: "harness" as const, name: "Sub", x: 0, y: 0, pins: 0, file: "sub.harness" };
	assert.equal(syncPorts(block, sub), true);
	assert.deepEqual(block.ports, ["C1:1", "C1:2", "C1:3"]);
	assert.equal(block.pins, 3);
	assert.equal(syncPorts(block, sub), false);
	assert.equal(portLabel(sub, "C1:1"), "C1 ECU : 1  VCC");
	// C1 shrinks, C2 gets exposed: old pin numbers stay, missing port has no label
	sub.components[0].pins = 2;
	sub.components[2].exposed = true;
	syncPorts(block, sub);
	assert.deepEqual(block.ports, ["C1:1", "C1:2", "C1:3", "C2:1", "C2:2"]);
	assert.equal(portLabel(sub, "C1:3"), undefined);
});

test("parse sets a sub-harness block's pins from its ports", () => {
	const h = parseHarness('{"components":[{"id":"H1","kind":"harness","name":"x","x":0,"y":0,"file":"a.harness","ports":["C1:1","C1:2"]}]}');
	assert.equal(h.components[0].pins, 2);
});

test("sub BOM rolls up nested sub-harnesses, merges equal parts, survives cycles", () => {
	const inner = sample();
	const mid = sample();
	mid.components.push({ id: "H1", kind: "harness", name: "inner", x: 0, y: 0, pins: 0, file: "inner" });
	const top = emptyHarness();
	top.components.push({ id: "H1", kind: "harness", name: "mid", x: 0, y: 0, pins: 0, file: "mid" });
	inner.components.push({ id: "H9", kind: "harness", name: "loop", x: 0, y: 0, pins: 0, file: "mid" }); // cycle back
	const files: Record<string, Harness> = { mid, inner };
	const rows = subBom(top, p => files[p]);
	const conn = rows.find(r => r.part.number === "DT04-2P")!;
	assert.deepEqual([conn.qty, conn.total], [4, 8]); // 2 in mid + 2 in inner
	assert.ok(Math.abs(rows.find(r => r.unit === "m")!.qty - 1.5) < 1e-9);
	assert.equal(subBom(top, () => undefined).length, 0);
});

test("wire label prefers the name, can hide ids, and the setting survives parsing", () => {
	const h = sample();
	const w = h.wires[0];
	assert.equal(wireLabel(h, w), "W1 1");
	w.name = "IGN feed";
	assert.equal(wireLabel(h, w), "IGN feed 1");
	h.hideWireIds = true;
	assert.equal(wireLabel(h, h.wires[1]), "1");
	assert.equal(parseHarness(JSON.stringify(h)).hideWireIds, true);
	assert.equal("hideWireIds" in parseHarness("{}"), false);
});

test("audit 3: ids are never reused after a delete", () => {
	const h = sample(); // C1, S1, C2
	assert.equal(nextId(h, "C", h.components), "C3");
	h.components = h.components.filter(c => c.id !== "C2");
	assert.equal(nextId(h, "C", h.components), "C4"); // not C2 or C3 again
	assert.equal(parseHarness(JSON.stringify(h)).seq?.C, 4); // survives save + load
});

test("audit 4: unknown top-level fields survive load and save", () => {
	const h = parseHarness('{"description":"Engine bay","components":[]}') as Harness & { description?: string };
	assert.equal(h.description, "Engine bay");
	assert.equal(h.version, 1);
});

test("audit 5: a part assigned to wires without length counts as used", () => {
	const h = sample();
	for (const w of h.wires) w.length = 0;
	const wire = bom(h).find(r => r.part.id === "P2")!;
	assert.deepEqual([wire.qty, wire.used], [0, true]);
	h.parts.push({ id: "P9", number: "spare", manufacturer: "", description: "", price: 1 });
	assert.equal(bom(h).find(r => r.part.id === "P9")!.used, false);
});

test("audit 6: a sub-harness loop does not count the main harness twice", () => {
	const main = sample();
	main.components.push({ id: "H1", kind: "harness", name: "A", x: 0, y: 0, pins: 0, file: "A" });
	const A = emptyHarness();
	A.components.push({ id: "H1", kind: "harness", name: "main", x: 0, y: 0, pins: 0, file: "main" });
	const files: Record<string, Harness> = { main, A };
	assert.equal(subBom(main, p => files[p], new Set(["main"])).length, 0);
});

test("audit 7 + 10: relink renamed sub-harness files; different prices are not merged", () => {
	const h = emptyHarness();
	h.components.push({ id: "H1", kind: "harness", name: "a", x: 0, y: 0, pins: 0, file: "old.harness" });
	assert.equal(relinkSub(h, "old.harness", "new/a.harness"), true);
	assert.equal(h.components[0].file, "new/a.harness");
	assert.equal(relinkSub(h, "old.harness", "x"), false);

	const a = sample(), b = sample();
	b.parts[0].price = 3; // same connector part, other price
	const top = emptyHarness();
	top.components.push({ id: "H1", kind: "harness", name: "a", x: 0, y: 0, pins: 0, file: "a" }, { id: "H2", kind: "harness", name: "b", x: 0, y: 0, pins: 0, file: "b" });
	const rows = subBom(top, p => ({ a, b } as Record<string, Harness>)[p]).filter(r => r.part.number === "DT04-2P");
	assert.equal(rows.length, 2);
	for (const r of rows) assert.equal(r.total, r.qty * r.part.price);
});

test("audit2 1: the same sub-harness used twice is counted twice", () => {
	const door = emptyHarness();
	door.parts.push({ id: "P1", number: "DT06-2S", manufacturer: "Deutsch", description: "", price: 2 });
	door.components.push({ id: "C1", kind: "connector", name: "Lock", x: 0, y: 0, pins: 2, partId: "P1" });
	const car = emptyHarness();
	car.components.push(
		{ id: "H1", kind: "harness", name: "Door left", x: 0, y: 0, pins: 0, file: "Door" },
		{ id: "H2", kind: "harness", name: "Door right", x: 0, y: 0, pins: 0, file: "Door" });
	const [row] = subBom(car, p => p === "Door" ? door : undefined);
	assert.deepEqual([row.qty, row.total], [2, 4]);
});

test("audit2 3: files with missing ends are rejected, missing display fields get defaults", () => {
	assert.throws(() => parseHarness('{"wires":[{"id":"W1","from":{"c":"C1","pin":1}}]}'), /W1/);
	assert.throws(() => parseHarness('{"components":[{"name":"x"}]}'));
	assert.throws(() => parseHarness("[]"));
	assert.throws(() => parseHarness("null"));
	const h = parseHarness('{"components":[{"id":"C1","kind":"connector"}],"wires":[{"id":"W1","from":{"c":"C1","pin":1},"to":{"c":"C1","pin":1}}],"parts":[{"id":"P1"}]}');
	assert.deepEqual([h.wires[0].color, h.wires[0].length, h.components[0].name, h.components[0].x, h.parts[0].price], ["", 0, "C1", 0, 0]);
});
