import { test } from "node:test";
import assert from "node:assert/strict";
import { addLibConnector, compLabel, copyClip, designations, duplicate, pasteClip, readClip, matches, mateError, moveConnections, netSignals, parseCavities, pasteSignals, resolveTarget } from "./components.ts";
import { computeNets, emptyHarness, netWires, parseHarness, removeComponent, signalOf, type Harness } from "./model.ts";
import { starterLibrary } from "./starter.ts";

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

test("copy and paste into another harness: new ids, shared parts by number, accessories remapped", () => {
	const src = emptyHarness();
	src.parts = [
		{ id: "P1", number: "HOUSING", manufacturer: "", description: "", price: 1, type: "connector", configurations: [{ name: "Default", items: [{ partId: "P2" }] }] },
		{ id: "P2", number: "PIN", manufacturer: "", description: "", price: 0.1, type: "contact" },
		{ id: "P3", number: "FLRY 1", manufacturer: "", description: "", price: 0.2, type: "wire" },
	];
	src.components = [
		{ id: "C1", kind: "connector", name: "ECU", x: 100, y: 100, pins: 2, partId: "P1" },
		{ id: "C2", kind: "connector", name: "C2", x: 300, y: 100, pins: 2 },
		{ id: "C3", kind: "connector", name: "Left out", x: 500, y: 100, pins: 1 },
	];
	src.wires = [
		{ id: "W1", from: { c: "C1", pin: 1 }, to: { c: "C2", pin: 1 }, color: "rd", gauge: "1", length: 0, partId: "P3", twist: "TW1" },
		{ id: "W2", from: { c: "C1", pin: 2 }, to: { c: "C2", pin: 2 }, color: "bk", gauge: "1", length: 0, twist: "TW1" },
		{ id: "W3", from: { c: "C2", pin: 1 }, to: { c: "C3", pin: 1 }, color: "bk", gauge: "1", length: 0 },
	];
	src.mates = [{ a: "C1", b: "C2" }];
	const clip = readClip(JSON.stringify(copyClip(src, ["C1", "C2"])))!;
	assert.deepEqual(clip.parts.map(p => p.number), ["HOUSING", "PIN", "FLRY 1"]); // the configuration's contact comes along
	assert.deepEqual(clip.wires.map(w => w.id), ["W1", "W2"]); // W3 leads out of the selection

	const dst = emptyHarness();
	dst.parts = [{ id: "P1", number: "PIN", manufacturer: "", description: "", price: 0.1, type: "contact",
		configurations: [{ name: "Own", items: [{ partId: "P1" }] }] }]; // same id as the clip's housing, different part
	dst.components = [{ id: "C1", kind: "connector", name: "Existing", x: 0, y: 0, pins: 1 }];
	const ids = pasteClip(dst, clip, { x: 0, y: 400 });
	assert.deepEqual(ids, ["C2", "C3"]);
	const ecu = dst.components.find(c => c.id === "C2")!;
	assert.deepEqual([ecu.name, ecu.x, ecu.y], ["ECU", 0, 400]);
	assert.equal(dst.components.find(c => c.id === "C3")!.name, "C3"); // unlabelled stays unlabelled
	const housing = dst.parts.find(p => p.id === ecu.partId)!;
	assert.equal(housing.number, "HOUSING");
	assert.equal(housing.configurations![0].items[0].partId, "P1"); // PIN already existed as P1
	assert.equal(dst.parts.filter(p => p.number === "PIN").length, 1);
	assert.equal(dst.parts[0].configurations![0].items[0].partId, "P1"); // dst's own part untouched
	assert.deepEqual(dst.wires.map(w => [w.from.c, w.to.c]), [["C2", "C3"], ["C2", "C3"]]);
	assert.equal(dst.parts.find(p => p.id === dst.wires[0].partId)!.number, "FLRY 1");
	assert.ok(dst.wires[0].twist && dst.wires[0].twist === dst.wires[1].twist);
	assert.deepEqual(dst.mates, [{ a: "C2", b: "C3" }]);
});

test("paste refuses clipboard text that isn't a clip, and a broken clip leaves the harness alone", () => {
	assert.equal(readClip("hello"), undefined);
	assert.equal(readClip(JSON.stringify({ components: [] })), undefined);
	const h = emptyHarness(), before = JSON.stringify(h);
	const bad = { dcWiring: 1 as const, components: [{ id: "X", kind: "rocket", name: "", x: 0, y: 0, pins: 1 }], wires: [], mates: [], parts: [] };
	assert.throws(() => pasteClip(h, bad as never, { x: 0, y: 0 }));
	assert.equal(JSON.stringify(h), before);
});

test("a library connector arrives with its pins, cavity names, part and accessories", () => {
	const lib = starterLibrary(), h = emptyHarness();
	const dt = lib.parts.find(p => p.number === "DT04-4P")!;
	const id = addLibConnector(h, lib, dt, undefined, 100, 60);
	const c = h.components.find(c => c.id === id)!;
	assert.deepEqual([c.kind, c.pins, c.x, c.y, c.cavities], ["connector", 4, 100, 60, ["1", "2", "3", "4"]]);
	assert.equal(h.parts.find(p => p.id === c.partId)?.number, "DT04-4P");
	assert.deepEqual(h.parts.map(p => p.number).sort(), ["0460-202-16141", "114017", "DT04-4P", "W4P"]);
	h.parts.find(p => p.number === "DT04-4P")!.price = 1.5; // the harness's own copy is reused, not overwritten
	const id2 = addLibConnector(h, lib, dt, undefined, 0, 0);
	assert.equal(h.components.find(c => c.id === id2)!.partId, c.partId);
	assert.equal(h.parts.find(p => p.number === "DT04-4P")!.price, 1.5);
	assert.equal(h.parts.length, 4);
	const dl = lib.parts.find(p => p.number === "6195-0003")!;
	const id3 = addLibConnector(h, lib, dl, "0.75–0.85 mm²", 0, 0);
	assert.equal(h.components.find(c => c.id === id3)!.config, "0.75–0.85 mm²");
	assert.equal(h.components.find(c => c.id === id3)!.pins, 2);
});
