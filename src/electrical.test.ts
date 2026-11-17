import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyHarness } from "./model.ts";
import { dropPercent, validate, voltageDrop } from "./validate.ts";

function feed() {
	const h = emptyHarness();
	h.components = [
		{ id: "C1", kind: "connector", name: "Fuse box", x: 0, y: 0, pins: 1 },
		{ id: "C2", kind: "connector", name: "Fan", x: 200, y: 0, pins: 1 },
	];
	h.wires = [{ id: "W1", from: { c: "C1", pin: 1 }, to: { c: "C2", pin: 1 }, color: "rd", gauge: "1", length: 3000, partId: "P1", current: 15 }];
	h.parts = [{ id: "P1", number: "FLRY 1.0", manufacturer: "", description: "", price: 0, type: "wire", ampacity: 10 }];
	return h;
}

const wireMsgs = (h: ReturnType<typeof feed>) => validate(h).filter(w => w.kind === "wire").map(w => w.message);

test("voltage drop is current × copper resistance over the wire length", () => {
	const h = feed();
	const v = voltageDrop(h, h.wires[0])!;
	assert.ok(Math.abs(v - 15 * 0.0175 * 3 / 1) < 1e-9); // 0.7875 V
	assert.ok(Math.abs(dropPercent(h, v) - 6.5625) < 1e-9); // of the default 12 V
	h.wires[0].gauge = "16AWG"; // ~1.31 mm²: AWG gauges convert
	assert.ok(voltageDrop(h, h.wires[0])! < v);
	delete h.wires[0].current;
	assert.equal(voltageDrop(h, h.wires[0]), undefined);
});

test("warns about current over the part rating and drop over the limit", () => {
	const h = feed();
	assert.deepEqual(wireMsgs(h), ["15 A is over the part's 10 A rating", "0.79 V drop (6.6 %), over the 5 % limit"]);
	h.voltage = 24; // same drop is 3.3 % of 24 V
	h.parts[0].ampacity = 20;
	assert.deepEqual(wireMsgs(h), []);
	h.maxDrop = 3;
	assert.deepEqual(wireMsgs(h), ["0.79 V drop (3.3 %), over the 3 % limit"]);
});
