import { test } from "node:test";
import assert from "node:assert/strict";
import { bom, emptyHarness, parseHarness, removePart, setContact, subBom, type Harness } from "./model.ts";
import { assignPart, effectiveWire, followPart, loadedParts, partChoices, partFrom, partSummary, partsUsedBy, setGaugeUnit } from "./parts.ts";
import { fromMm2, toMm2 } from "./units.ts";
import { validate } from "./validate.ts";
import { copyPart, syncStatus } from "./library.ts";

test("gauge conversion between AWG, mm² and cmil", () => {
	assert.ok(Math.abs(toMm2("20AWG")! - 0.518) < 0.001);
	assert.ok(Math.abs(toMm2("4/0 awg")! - 107.2) < 0.1);
	assert.equal(toMm2("0,5"), 0.5);
	assert.equal(toMm2("18", "AWG"), toMm2("18 AWG"));
	assert.ok(Math.abs(toMm2("250 kcmil")! - 126.7) < 0.1);
	assert.equal(toMm2("red"), undefined);
	assert.equal(toMm2(""), undefined);
	assert.equal(fromMm2(0.5, "AWG"), "20");
	assert.equal(fromMm2(toMm2("2/0 AWG")!, "AWG"), "2/0");
	assert.equal(fromMm2(toMm2("12 AWG")!, "cmil"), "6530");
	assert.equal(fromMm2(toMm2("16AWG")!, "mm²"), "1.31");
});

test("old parts without a type still load and count as before", () => {
	const h = parseHarness(JSON.stringify({ version: 1, components: [], wires: [], parts: [{ id: "P1", number: "X", price: 1 }] }));
	assert.equal(h.parts[0].type, undefined);
	assert.deepEqual(bom(h).map(r => [r.qty, r.unit, r.used]), [[0, "pcs", false]]);
});

test("a wire part's colour, stripe and gauge win over the wire's own", () => {
	const h = emptyHarness();
	h.parts = [{ id: "P1", number: "FLRY", manufacturer: "", description: "", price: 0, type: "wire", colour: "red", gauge: "1" }];
	const w = { id: "W1", from: { c: "C1", pin: 1 }, to: { c: "C2", pin: 1 }, color: "blue/white", gauge: "0.5", length: 0, partId: "P1" };
	assert.deepEqual([effectiveWire(h, w).color, effectiveWire(h, w).gauge], ["red", "1"]);
	h.parts[0] = { ...h.parts[0], colour: undefined, gauge: "", stripe: "black" };
	assert.deepEqual([effectiveWire(h, w).color, effectiveWire(h, w).gauge], ["blue/black", "0.5"]);
	assert.equal(effectiveWire(h, { ...w, partId: undefined }).color, "blue/white");
});

/** Connector C1 with 3 pins: pin 1 has a 0.5 mm² wire, pin 2 a 2.5 mm² wire, pin 3 is empty. */
function withConfig(): Harness {
	const h = emptyHarness();
	const part = (id: string, type: any, extra = {}) => ({ id, number: id, manufacturer: "", description: "", price: 1, type, ...extra });
	h.parts = [
		part("HOUSING", "connector", { cavities: 3, configurations: [{ name: "Default", items: [
			{ partId: "SMALL" }, { partId: "PLUG" }, { partId: "SEAL" }, { partId: "BOOT" },
		] }, { name: "Bare", items: [] }] }),
		part("SMALL", "contact", { gaugeMin: "22 AWG", gaugeMax: "0.75" }),
		part("PLUG", "cavity-plug"),
		part("SEAL", "cavity-seal"),
		part("BOOT", "boot"),
		part("WIRE", "wire", { gauge: "0.5" }),
	];
	h.components = [
		{ id: "C1", kind: "connector", name: "C1", x: 0, y: 0, pins: 3, partId: "HOUSING" },
		{ id: "C2", kind: "connector", name: "C2", x: 0, y: 0, pins: 2 },
	];
	h.wires = [
		{ id: "W1", from: { c: "C1", pin: 1 }, to: { c: "C2", pin: 1 }, color: "red", gauge: "", length: 1000, partId: "WIRE" },
		{ id: "W2", from: { c: "C1", pin: 2 }, to: { c: "C2", pin: 2 }, color: "red", gauge: "2.5", length: 1000 },
	];
	return h;
}

test("configurations load contacts by gauge, plugs into empty cavities, accessories once", () => {
	const h = withConfig();
	assert.deepEqual(loadedParts(h, h.components[0]), [
		{ partId: "BOOT" },
		{ partId: "SMALL", pin: 1 }, { partId: "SEAL", pin: 1 },
		{ partId: "SEAL", pin: 2 }, // 2.5 mm² fits no contact
		{ partId: "PLUG", pin: 3 },
	]);
	const qty = Object.fromEntries(bom(h).map(r => [r.part.id, `${r.qty} ${r.unit}`]));
	assert.deepEqual(qty, { HOUSING: "1 pcs", SMALL: "1 pcs", PLUG: "1 pcs", SEAL: "2 pcs", BOOT: "1 pcs", WIRE: "1 m" });
	h.components[0].config = "Bare";
	assert.deepEqual(loadedParts(h, h.components[0]), []);
	removePart(h, "SMALL");
	assert.equal(h.parts[0].configurations![0].items.length, 3);
});

test("excluded parts are flagged and left out of sub-harness roll-ups", () => {
	const h = withConfig();
	h.parts.find(p => p.id === "BOOT")!.excludeFromBom = true;
	assert.equal(bom(h).find(r => r.part.id === "BOOT")!.excluded, true);
	const parent = emptyHarness();
	parent.components = [{ id: "H1", kind: "harness", name: "s", x: 0, y: 0, pins: 0, file: "s.harness" }];
	assert.ok(!subBom(parent, () => h).some(r => r.part.number === "BOOT"));
});

test("validation finds gauge, cavity, part and duplicate problems", () => {
	const h = withConfig();
	h.components[0].pins = 4;
	h.parts.push({ id: "DUP", number: "WIRE", manufacturer: "", description: "", price: 0 });
	const msgs = validate(h).map(w => `${w.id}${w.pin ? ":" + w.pin : ""} ${w.message}`);
	assert.deepEqual(msgs, [
		"C1 4 pins, but part HOUSING has 3 cavities",
		`C1:2 pin 2: 2.5 mm² fits no contact in configuration "Default"`,
		"W2 No part",
		"WIRE Duplicate part number WIRE",
		"DUP Duplicate part number WIRE",
		"DUP Not used",
	]);
});

test("changing the gauge unit keeps typed gauges the same size", () => {
	const h = withConfig();
	h.components.push({ id: "CB1", kind: "cable", name: "CB1", x: 0, y: 0, pins: 2, cores: [{ color: "rd", gauge: "0.35" }, { color: "bk", gauge: "" }] });
	h.parts.push({ id: "CAB", number: "CAB", manufacturer: "", description: "", price: 0, type: "cable", coreList: [{ color: "rd", gauge: "0.5" }] });
	setGaugeUnit(h, "AWG");
	assert.equal(h.gaugeUnit, "AWG");
	assert.deepEqual(h.components[2].cores!.map(k => k.gauge), ["0.35 mm²", ""]);
	assert.equal(h.parts.find(p => p.id === "CAB")!.coreList![0].gauge, "0.5 mm²");
	assert.equal(h.wires[1].gauge, "2.5 mm²");
	assert.equal(h.parts.find(p => p.id === "SMALL")!.gaugeMax, "0.75 mm²");
	assert.equal(h.parts.find(p => p.id === "SMALL")!.gaugeMin, "22 AWG");
});

test("library sync by part number, push and pull with accessories", () => {
	const h = withConfig(), lib = emptyHarness();
	const housing = h.parts[0];
	assert.equal(syncStatus(housing, h, lib), "missing");
	copyPart(housing, h, lib);
	assert.deepEqual(lib.parts.map(p => p.number), ["HOUSING", "SMALL", "PLUG", "SEAL", "BOOT"]);
	assert.equal(syncStatus(housing, h, lib), "in-sync");
	housing.price = 9;
	assert.equal(syncStatus(housing, h, lib), "out-of-sync");
	copyPart(lib.parts[0], lib, h); // pull: harness part takes the library's values and keeps its id
	assert.equal(h.parts[0].id, "HOUSING");
	assert.equal(h.parts[0].price, 1);
	assert.equal(h.parts.length, 6);
	assert.equal(syncStatus({ ...housing, number: "" }, h, lib), undefined);
});

test("assign part: fitting parts first, one option per configuration, create from component, assign many", () => {
	const h = emptyHarness();
	h.components = [
		{ id: "C1", kind: "connector", name: "ECU", x: 0, y: 0, pins: 4 },
		{ id: "C2", kind: "connector", name: "Lamp", x: 0, y: 0, pins: 4 },
		{ id: "T1", kind: "terminal", name: "T1", x: 0, y: 0, pins: 1, terminal: "male QC" },
	];
	h.wires = [{ id: "W1", from: { c: "C1", pin: 1 }, to: { c: "C2", pin: 1 }, color: "red/white", gauge: "0.5", length: 100 }];
	h.parts = [
		{ id: "P1", number: "2-pin", manufacturer: "", description: "", price: 0, type: "connector", cavities: 2 },
		{ id: "P2", number: "4-pin", manufacturer: "", description: "", price: 0, type: "connector", cavities: 4,
			configurations: [{ name: "Default", items: [] }, { name: "Sealed", items: [] }] },
		{ id: "P3", number: "QC", manufacturer: "", description: "", price: 0, type: "terminal", terminalType: "quick-connect" },
	];
	const c1 = h.components[0];
	assert.deepEqual(partChoices(h, c1).map(x => [x.part.id, x.config, x.fits]),
		[["P2", "Default", true], ["P2", "Sealed", true], ["P1", undefined, false], ["P3", undefined, false]]);
	assert.equal(partChoices(h, h.components[2])[0].part.id, "P3");
	assignPart(h, [c1, h.components[1]], "P2", "Sealed");
	assert.deepEqual([c1.partId, c1.config, h.components[1].config], ["P2", "Sealed", "Sealed"]);
	assignPart(h, [c1], "P2", "Default");
	assert.equal(c1.config, undefined); // the first configuration is the default
	assignPart(h, [c1], undefined);
	assert.equal(c1.partId, undefined);
	const wp = partFrom(h, h.wires[0]);
	assert.deepEqual([wp.id, wp.type, wp.colour, wp.stripe, wp.gauge], ["P4", "wire", "red", "white", "0.5"]);
	assert.equal(partFrom(h, h.components[2]).terminalType, "quick-connect");
	assert.equal(partFrom(h, c1).cavities, 4);
});

test("a contact set on a cavity replaces the configuration's, \"\" removes it, and is checked against the wire gauge", () => {
	const h = withConfig(), c1 = h.components[0];
	setContact(c1, 2, "SMALL"); // 2.5 mm² wire: too thick for SMALL
	setContact(c1, 3, "");
	assert.deepEqual(loadedParts(h, c1).filter(l => l.pin), [
		{ partId: "SMALL", pin: 1 }, { partId: "SEAL", pin: 1 },
		{ partId: "SMALL", pin: 2 }, { partId: "SEAL", pin: 2 }, // seal still from the configuration
	]);
	assert.deepEqual(validate(h).filter(w => w.id === "C1").map(w => w.message), ["pin 2: contact SMALL does not take 2.5 mm²"]);
	const bare = h.components[1]; // no part at all: the hand-set contact still counts
	setContact(bare, 1, "SMALL");
	assert.deepEqual(loadedParts(h, bare), [{ partId: "SMALL", pin: 1 }]);
	setContact(c1, 3, undefined);
	assert.deepEqual(c1.contacts, { 2: "SMALL" });
	removePart(h, "SMALL");
	assert.equal(c1.contacts, undefined);
	assert.throws(() => parseHarness(JSON.stringify({ ...h, components: [{ ...c1, contacts: { 1: 5 } }, h.components[1]] })), /contacts/);
});

test("parts table helpers: spec summary, parts used by a selection, excluded components", () => {
	const h = withConfig();
	assert.equal(partSummary({ ...h.parts[0], gender: "female" }), "3 cav · female");
	assert.equal(partSummary(h.parts[1]), "22 AWG–0.75");
	assert.equal(partSummary({ id: "X", number: "", manufacturer: "", description: "", price: 0, type: "covering", coveringType: "tape", length: 50 }), "tape · 50 mm");
	assert.equal(partSummary({ id: "X", number: "", manufacturer: "", description: "", price: 0 }), "");
	assert.deepEqual([...partsUsedBy(h, { components: ["C1"] })].sort(), ["BOOT", "HOUSING", "PLUG", "SEAL", "SMALL"]);
	assert.deepEqual([...partsUsedBy(h, { wires: ["W1", "W2"] })], ["WIRE"]);
	h.components[0].excludeFromBom = true;
	const r = Object.fromEntries(bom(h).map(r => [r.part.id, [r.qty, r.used]]));
	assert.deepEqual([r.HOUSING, r.SMALL], [[0, true], [0, false]]);
});

test("connector parts name their cavities; connectors with as many pins take the names", () => {
	const h = emptyHarness();
	h.components = [
		{ id: "C1", kind: "connector", name: "C1", x: 0, y: 0, pins: 4 },
		{ id: "C2", kind: "connector", name: "C2", x: 0, y: 0, pins: 2 },
	];
	const p = { id: "P1", number: "DT", manufacturer: "", description: "", price: 0, type: "connector" as const, cavities: 4, designations: ["A1", "A2", "B1", "B2"] };
	h.parts = [p];
	assignPart(h, h.components, "P1");
	assert.deepEqual(h.components.map(c => c.cavities), [["A1", "A2", "B1", "B2"], undefined]); // C2 has 2 pins: left alone
	p.designations = ["1", "2", "3", "X"];
	followPart(h, p);
	assert.deepEqual(h.components[0].cavities, ["1", "2", "3", "X"]);
	assert.deepEqual(partFrom(h, h.components[0]).designations, ["1", "2", "3", "X"]);
	assert.equal(partFrom(h, h.components[1]).designations, undefined);
});
