import { test } from "node:test";
import assert from "node:assert/strict";
import { compLabel, designations, duplicate, matches, mateError, moveConnections, netSignals, parseCavities, pasteSignals, resolveTarget } from "./components.ts";
import { computeNets, emptyHarness, netWires, parseHarness, removeComponent, signalOf, type Harness } from "./model.ts";

function sample(): Harness {
	const h = emptyHarness();
	h.components = [
		{ id: "C1", kind: "connector", name: "ECU", x: 0, y: 0, pins: 3, signals: { 1: "VCC" } },
		{ id: "D1", kind: "diode", name: "", x: 0, y: 0, pins: 2 },
		{ id: "C2", kind: "connector", name: "C2", x: 0, y: 0, pins: 3, cavities: ["A", "B", "C"], nc: [3] },
	];
	h.wires = [
		{ id: "W1", from: { c: "C1", pin: 1 }, to: { c: "D1", pin: 1 }, color: "red", gauge: "", length: 0 },
		{ id: "W2", from: { c: "D1", pin: 2 }, to: { c: "C2", pin: 1 }, color: "red", gauge: "", length: 0, points: [{ x: 10, y: 10 }] },
	];
	return h;
}

test("nets and signals stop at a diode; selecting the diode lights both sides", () => {
	const h = sample(), n = computeNets(h);
	assert.notEqual(n.get("C1:1"), n.get("C2:1"));
	assert.equal(signalOf(h, { c: "C2", pin: 1 }), undefined);
	assert.deepEqual([...netWires(h, { wires: ["W1"] })], ["W1"]);
	assert.deepEqual([...netWires(h, { component: "D1" })].sort(), ["W1", "W2"]);
});

test("mated connectors join pin for pin, only when cavity counts match", () => {
	const h = sample();
	h.mates = [{ a: "C1", b: "C2" }];
	assert.equal(computeNets(h).get("C1:1"), computeNets(h).get("C2:1"));
	assert.equal(mateError(h, h.mates[0]), undefined);
	h.components[2].pins = 2;
	assert.equal(mateError(h, h.mates[0]), "cavities do not match");
	assert.notEqual(computeNets(h).get("C1:1"), computeNets(h).get("C2:1"));
	removeComponent(h, "C2");
	assert.deepEqual(h.mates, []);
});

test("global signals with the same name share a net; conflicts list every signal", () => {
	const h = sample();
	h.components[2].signals = { 1: "VCC" };
	assert.notEqual(computeNets(h).get("C1:1"), computeNets(h).get("C2:1"));
	h.components[0].globals = [1];
	h.components[2].globals = [1];
	assert.equal(computeNets(h).get("C1:1"), computeNets(h).get("C2:1"));
	h.components[2].signals = { 2: "GND" };
	h.wires.push({ id: "W3", from: { c: "C1", pin: 1 }, to: { c: "C2", pin: 2 }, color: "", gauge: "", length: 0 });
	assert.deepEqual(netSignals(h, { c: "D1", pin: 1 }), ["VCC", "GND"]);
});

test("new kinds load with fixed pin counts; unknown kinds still fail", () => {
	const h = parseHarness(JSON.stringify({ components: [{ id: "D1", kind: "diode", pins: 7 }, { id: "N1", kind: "note", text: "hi" }, { id: "T1", kind: "terminal" }] }));
	assert.deepEqual(h.components.map(c => c.pins), [2, 0, 1]);
	assert.throws(() => parseHarness(JSON.stringify({ components: [{ id: "X1", kind: "blob" }] })));
});

test("labels name components, shared labels get the id", () => {
	const h = sample();
	assert.equal(compLabel(h, h.components[0]), "ECU");
	assert.equal(compLabel(h, h.components[2]), "C2");
	h.components[2].name = "ECU";
	assert.equal(compLabel(h, h.components[2]), "ECU:C2");
});

test("cavity designations from templates and typed text", () => {
	assert.deepEqual(designations("letters", 3), ["A", "B", "C"]);
	assert.deepEqual(designations("grid", 4, 2), ["A1", "A2", "B1", "B2"]);
	assert.equal(designations("letters", 28)![27], "AB");
	assert.equal(designations("numbers", 3), undefined);
	assert.deepEqual(parseCavities("A1, , B1, extra", 3), ["A1", "", "B1"]);
	assert.equal(parseCavities("1,2", 3), undefined);
});

test("pasting a column fills the next cavities, skipping N/C", () => {
	const c = sample().components[2];
	c.nc = [2];
	c.signals = { 3: "keep" };
	pasteSignals(c, 1, "CAN H\nCAN L\n\n");
	assert.deepEqual(c.signals, { 1: "CAN H", 3: "CAN L" });
	pasteSignals(c, 1, "X\n\nY\nZ");
	assert.deepEqual(c.signals, { 1: "X", 3: "CAN L" });
});

test("move connections moves every wire end on a pin", () => {
	const h = sample();
	h.wires.push({ id: "W3", from: { c: "C1", pin: 2 }, to: { c: "D1", pin: 1 }, color: "", gauge: "", length: 0 });
	assert.equal(moveConnections(h, { c: "D1", pin: 1 }, { c: "C1", pin: 3 }), 2);
	assert.deepEqual(h.wires.map(w => w.to), [{ c: "C1", pin: 3 }, { c: "C2", pin: 1 }, { c: "C1", pin: 3 }]);
	assert.equal(moveConnections(h, { c: "C1", pin: 1 }, { c: "C1", pin: 3 }), 0); // would be a loop
});

test("duplicate copies components and the wires between them with fresh ids", () => {
	const h = sample();
	const ids = duplicate(h, ["D1", "C2"]);
	assert.deepEqual(ids, ["D2", "C3"]);
	assert.equal(compLabel(h, h.components.find(c => c.id === "C3")!), "C3");
	const w = h.wires.at(-1)!;
	assert.equal(w.id, "W3");
	assert.deepEqual([w.from, w.to, w.points], [{ c: "D2", pin: 2 }, { c: "C3", pin: 1 }, [{ x: 50, y: 50 }]]);
	assert.equal(h.wires.length, 3); // W1 goes to C1, which wasn't copied
	assert.deepEqual(h.wires[1].points, [{ x: 10, y: 10 }]); // original untouched
});

test("destinations resolve ids, labels and designations", () => {
	const h = sample();
	assert.deepEqual(resolveTarget(h, "c1:2"), { c: "C1", pin: 2 });
	assert.deepEqual(resolveTarget(h, "ECU:3"), { c: "C1", pin: 3 });
	assert.deepEqual(resolveTarget(h, "C2:b"), { c: "C2", pin: 2 });
	assert.match(resolveTarget(h, "C2:C") as string, /N\/C/);
	assert.match(resolveTarget(h, "ECU") as string, /Which cavity/);
	assert.match(resolveTarget(h, "nope:1") as string, /No component/);
	h.components.push({ id: "S1", kind: "splice", name: "S1", x: 0, y: 0, pins: 1 });
	assert.deepEqual(resolveTarget(h, "S1"), { c: "S1", pin: 1 });
});

test("search matches labels, signals and cavities", () => {
	const h = sample();
	assert.ok(matches(h, h.components[0], "vcc"));
	assert.ok(matches(h, h.components[2], "b"));
	assert.ok(!matches(h, h.components[1], "ecu"));
});
