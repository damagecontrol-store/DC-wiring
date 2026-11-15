import { test } from "node:test";
import assert from "node:assert/strict";
import { bom, emptyHarness, parseHarness, removePart, subBom, type Harness } from "./model.ts";
import { effectiveWire, loadedParts, setGaugeUnit } from "./parts.ts";
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
	setGaugeUnit(h, "AWG");
	assert.equal(h.gaugeUnit, "AWG");
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
