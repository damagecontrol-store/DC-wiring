import { test } from "node:test";
import assert from "node:assert/strict";
import { formatLength, parseLength } from "./length.ts";

const mm = (s: string, unit?: string) => parseLength(s, unit)?.mm;

test("length maths", () => {
	assert.equal(mm("40 + 30 + 40"), 110);
	assert.deepEqual(parseLength("2 * 30cm"), { mm: 600, unit: "cm" });
	assert.equal(mm("2 x 30cm"), 600);
	assert.deepEqual(parseLength("1200 / 4"), { mm: 300, unit: "mm" });
	assert.equal(mm("5' 3\""), 5 * 304.8 + 3 * 25.4);
	assert.deepEqual(parseLength("1m 20cm"), { mm: 1200, unit: "mm" });
	assert.deepEqual(parseLength("(10 + 20) cm"), { mm: 300, unit: "cm" });
	assert.deepEqual(parseLength("30cm + 20cm"), { mm: 500, unit: "cm" });
	assert.equal(mm("30 + 20cm"), 230);
	assert.equal(mm("1.5 m"), 1500);
	assert.equal(mm("2 yd - 1 ft"), 2 * 914.4 - 304.8);
	assert.equal(mm("12", "in"), 12 * 25.4);
});

test("length maths rejects nonsense", () => {
	for (const s of ["", "abc", "10cm * 2cm", "1 / 0", "5 +", "(3", "-5", "3cm mm", "10 / 2cm", "2 - 5"]) assert.equal(mm(s), undefined, s);
});

test("format length", () => {
	assert.equal(formatLength(600, "cm"), "60 cm");
	assert.equal(formatLength(1234.567), "1234.57 mm");
});
