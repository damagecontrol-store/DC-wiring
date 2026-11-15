import { test } from "node:test";
import assert from "node:assert/strict";
import { removeBranchPoint, routeWires, spliceSpots, splitBundle, wireLength } from "./bundles.ts";
import { bom, parseHarness, removeComponent, type Harness } from "./model.ts";

// C1 --B1 100-- BP1 --B2 200-- C2,  BP1 --B3 50-- C3
const make = (): Harness => parseHarness(JSON.stringify({
	components: [
		{ id: "C1", kind: "connector", x: 0, y: 0, pins: 2 },
		{ id: "C2", kind: "connector", x: 300, y: 0, pins: 2 },
		{ id: "C3", kind: "connector", x: 100, y: 100, pins: 2 },
		{ id: "C4", kind: "connector", x: 900, y: 900, pins: 1 },
		{ id: "S1", kind: "splice", x: 0, y: 0, pins: 1 },
	],
	wires: [
		{ id: "W1", from: { c: "C1", pin: 1 }, to: { c: "C2", pin: 1 }, length: 999, partId: "P1" },
		{ id: "W2", from: { c: "C1", pin: 2 }, to: { c: "C4", pin: 1 }, length: 40, partId: "P1" },
		{ id: "W3", from: { c: "S1", pin: 1 }, to: { c: "C2", pin: 2 } },
		{ id: "W4", from: { c: "S1", pin: 1 }, to: { c: "C3", pin: 1 } },
	],
	parts: [{ id: "P1" }],
	branchPoints: [{ id: "BP1", x: 100, y: 0 }],
	bundles: [
		{ id: "B1", from: "C1", to: "BP1", length: 100 },
		{ id: "B2", from: "BP1", to: "C2", length: 200 },
		{ id: "B3", from: "C3", to: "BP1", length: 50 },
	],
}));

test("wires take the shortest bundle path; unrouted wires keep their typed length", () => {
	const h = make(), r = routeWires(h);
	assert.deepEqual(r.get("W1"), { bundles: ["B1", "B2"], length: 300 });
	assert.equal(r.has("W2"), false);
	assert.equal(wireLength(h, h.wires[1]), 40);
	assert.equal(bom(h)[0].qty, (300 + 40) / 1000);
	h.bundles!.push({ id: "B4", from: "C1", to: "C2", length: 250 });
	assert.deepEqual(routeWires(h).get("W1"), { bundles: ["B4"], length: 250 });
});

test("splices sit at the branch point with the least wire", () => {
	const h = make();
	assert.equal(spliceSpots(h).get("S1"), "BP1");
	assert.deepEqual(routeWires(h).get("W3"), { bundles: ["B2"], length: 200 });
	assert.deepEqual(routeWires(h).get("W4"), { bundles: ["B3"], length: 50 });
});

test("split a bundle, then delete the branch point to merge it back", () => {
	const h = make();
	h.bundles![1].points = [{ x: 200, y: 100 }];
	const bp = splitBundle(h, "B2", { x: 100, y: 100 })!; // first half 100 long, second 100 + 100√2 drawn
	assert.equal(bp, "BP2");
	const [b2, b5] = h.bundles!.slice(1, 3);
	assert.deepEqual([b2.from, b2.to, b2.points, b5.id, b5.from, b5.to, b5.points], ["BP1", "BP2", undefined, "B4", "BP2", "C2", [{ x: 200, y: 100 }]]);
	assert.equal(b2.length + b5.length, 200);
	assert.equal(b2.length, Math.round(200 * 100 / (200 + 100 * Math.SQRT2)));
	assert.equal(routeWires(h).get("W1")!.length, 300);

	removeBranchPoint(h, "BP2");
	assert.deepEqual(h.bundles!.map(b => [b.id, b.from, b.to, b.length]), [["B1", "C1", "BP1", 100], ["B2", "BP1", "C2", 200], ["B3", "C3", "BP1", 50]]);
	assert.deepEqual(h.bundles![1].points, [{ x: 100, y: 100 }, { x: 200, y: 100 }]);

	removeBranchPoint(h, "BP1"); // three bundles: they go with it
	assert.deepEqual(h.bundles, []);
	assert.equal(routeWires(h).size, 0);
});

test("merging reverses a bundle drawn the other way", () => {
	const h = make();
	h.bundles = [{ id: "B1", from: "BP1", to: "C1", length: 10, points: [{ x: 50, y: 50 }] }, { id: "B2", from: "C2", to: "BP1", length: 20, label: "trunk" }];
	removeBranchPoint(h, "BP1");
	assert.deepEqual(h.bundles, [{ id: "B1", from: "C1", to: "C2", length: 30, points: [{ x: 50, y: 50 }, { x: 100, y: 0 }], label: "trunk" }]);
});

test("a bundle without ends makes the file read-only", () => {
	assert.throws(() => parseHarness(JSON.stringify({ bundles: [{ id: "B1", from: "C1" }] })), /B1/);
	assert.equal(parseHarness("{}").bundles, undefined); // old files stay as they were
});

test("deleting a component drops its bundles", () => {
	const h = make();
	removeComponent(h, "C3");
	assert.deepEqual(h.bundles!.map(b => b.id), ["B1", "B2"]);
});
