import { test } from "node:test";
import assert from "node:assert/strict";
import { bomTable, connectionsTable, csv, cutList, htmlTable, reportHtml, wiringRows, wiringTables } from "./export.ts";
import { emptyHarness, type Harness } from "./model.ts";

function sample(): Harness {
	const h = emptyHarness();
	h.components = [
		{ id: "C1", kind: "connector", name: "ECU", x: 0, y: 0, pins: 3, signals: { 1: "VCC" }, partId: "P1" },
		{ id: "S1", kind: "splice", name: "S1", x: 0, y: 0, pins: 1 },
		{ id: "C2", kind: "connector", name: "Lamp, rear", x: 0, y: 0, pins: 2, partId: "P1" },
		{ id: "H1", kind: "harness", name: "Door", x: 0, y: 0, pins: 1, file: "Door.harness", ports: ["C4:1"] },
	];
	h.wires = [
		{ id: "W1", from: { c: "C1", pin: 1 }, to: { c: "S1", pin: 1 }, color: "red", gauge: "1", length: 500, partId: "P2" },
		{ id: "W2", name: "LAMP+", from: { c: "S1", pin: 1 }, to: { c: "C2", pin: 1 }, color: "red", gauge: "1", length: 250, partId: "P2" },
		{ id: "W3", from: { c: "C1", pin: 2 }, to: { c: "H1", pin: 1 }, color: "black", gauge: "0.5", length: 0 },
	];
	h.parts = [
		{ id: "P1", number: "DT04-2P", manufacturer: "TE", description: "2 pin \"DT\"", price: 2 },
		{ id: "P2", number: "FLRY 1.0", manufacturer: "", description: "", price: 0.4 },
	];
	return h;
}

test("csv quotes commas, quotes and newlines and starts with a BOM", () => {
	assert.equal(csv([["a", 'say "hi"', "x,y"], ["line\nbreak", 1.5, undefined]]), '﻿a,"say ""hi""","x,y"\r\n"line\nbreak",1.5,\r\n');
});

test("BOM table has own parts, sub-harness roll-up and a total", () => {
	const sub = { part: { id: "X", number: "SUB-1", manufacturer: "", description: "", price: 1 }, qty: 3, unit: "pcs", total: 3, used: true };
	const t = bomTable(sample(), [sub]);
	assert.deepEqual(t[1], ["DT04-2P", "TE", '2 pin "DT"', 2, "pcs", 2, 4, ""]);
	assert.deepEqual(t[2].slice(3, 5), [0.75, "m"]);
	assert.equal(t[3][7], "sub-harness");
	assert.deepEqual(t[4][6], 7.3);
});

test("connections list both ends with signals", () => {
	const t = connectionsTable(sample());
	assert.deepEqual(t[2], ["W2", "LAMP+", "S1 S1 : 1", "VCC", "C2 Lamp, rear : 1", "VCC", "red", "1", 250, "FLRY 1.0"]);
	assert.equal(t[3][4], "Door › C4:1");
});

test("wiring rows: one per wire end, empty cavities kept", () => {
	const h = sample();
	const rows = wiringRows(h, h.components[0]);
	assert.deepEqual(rows.map(r => [r.cavity, r.wire]), [[1, "W1"], [2, "W3"], [3, ""]]);
	assert.equal(rows[0].destination, "S1 S1 : 1 (VCC)");
	assert.equal(wiringRows(h, h.components[1]).length, 2); // splice: both wires on cavity 1
	assert.equal(wiringTables(h).length, 1 + 3 + 2 + 2);
});

test("cut list sorts by gauge, then colour", () => {
	assert.deepEqual(cutList(sample()).slice(1).map(r => r[0]), ["W3", "W1", "LAMP+"]);
});

test("html escapes cell text", () => {
	assert.equal(htmlTable([["a"], ["<b>&"]]), "<table><tr><th>a</th></tr><tr><td>&lt;b&gt;&amp;</td></tr></table>");
	assert.match(reportHtml(sample(), { title: "T<1>", drawnBy: "me" }, "<svg/>"), /<h1>T&lt;1&gt;<\/h1>[\s\S]*Drawn by<\/th><td>me[\s\S]*<svg\/>/);
});
