import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyHarness } from "./model.ts";
import { fitsRange } from "./parts.ts";
import { toMm2 } from "./units.ts";
import { faceSvg, installStarter, STARTER_DIR, STARTER_FACES, starterLibrary } from "./starter.ts";

const lib = starterLibrary();
const byNumber = (n: string) => lib.parts.find(p => p.number === n)!;
const housings = lib.parts.filter(p => p.type === "connector");

test("starter library: DT, Superseal and Sumitomo DL parts with unique numbers", () => {
	assert.equal(housings.length, 12 + 12 + 16);
	assert.equal(lib.parts.length, 27 + 16 + 22);
	assert.equal(new Set(lib.parts.map(p => p.number)).size, lib.parts.length);
});

test("starter library: every connector's names, count and face agree", () => {
	for (const p of housings) {
		assert.equal(p.designations?.length, p.cavities, p.number);
		const nums = STARTER_FACES[p.number].flat().sort((a, b) => a - b);
		assert.deepEqual(nums, Array.from({ length: p.cavities! }, (_, i) => i + 1), p.number);
	}
});

test("starter library: plug faces mirror receptacle faces", () => {
	assert.deepEqual(STARTER_FACES["DT04-4P"], [[1, 2], [4, 3]]);
	assert.deepEqual(STARTER_FACES["DT06-4S"], [[2, 1], [3, 4]]);
	assert.deepEqual(STARTER_FACES["DT06-3S"], [[2, 1], [3]]);
});

test("starter library: configuration items point at parts in the library", () => {
	const ids = new Set(lib.parts.map(p => p.id));
	for (const p of housings) {
		assert.ok(p.configurations?.length, p.number);
		for (const cf of p.configurations!) for (const i of cf.items) assert.ok(ids.has(i.partId), `${p.number} ${cf.name}`);
	}
	const dt = byNumber("DT04-4P").configurations![0].items.map(i => [lib.parts.find(p => p.id === i.partId)!.number, i.apply]);
	assert.deepEqual(dt, [["W4P", undefined], ["0460-202-16141", "connected"], ["114017", "unconnected"]]);
	assert.deepEqual(byNumber("6195-0003").configurations!.map(c => c.name), ["0.3–0.5 mm²", "0.75–0.85 mm²"]);
});

test("starter library: contact ranges read the same in an AWG harness", () => {
	const awg = { ...lib, gaugeUnit: "AWG" as const };
	assert.ok(fitsRange(awg, byNumber("0462-201-16141"), toMm2("18AWG")));
	assert.ok(!fitsRange(awg, byNumber("0462-201-16141"), toMm2("12AWG")));
});

test("starter library: reinstall keeps user parts and resets starter parts", () => {
	const mine = installStarter().lib;
	mine.parts.push({ id: "P999", number: "MY-1", manufacturer: "", description: "mine", price: 2 });
	const dt = mine.parts.find(p => p.number === "DT04-4P")!;
	dt.description = "edited";
	const again = installStarter(mine).lib;
	assert.ok(again.parts.some(p => p.number === "MY-1"));
	const dt2 = again.parts.find(p => p.number === "DT04-4P")!;
	assert.equal(dt2.id, dt.id);
	assert.equal(dt2.description, byNumber("DT04-4P").description);
	assert.equal(new Set(again.parts.map(p => p.number)).size, again.parts.length);
	assert.equal(installStarter(emptyHarness()).lib.parts.length, lib.parts.length);
});

test("starter library: face svg shows every cavity number and the caption", () => {
	const svg = faceSvg("DT04-12PA", STARTER_FACES["DT04-12PA"]);
	for (let n = 1; n <= 12; n++) assert.ok(svg.includes(`>${n}</text>`), String(n));
	assert.ok(svg.includes("Mating face, not to scale"));
	assert.ok(svg.startsWith("<svg"));
});

test("starter library: images cover every housing", () => {
	const { images } = installStarter();
	assert.equal(Object.keys(images).length, housings.length);
	for (const p of housings) assert.ok(images[p.image!], p.number);
	assert.ok(Object.keys(images).every(k => k.startsWith(`${STARTER_DIR}/images/`) && k.endsWith(".svg")));
});
