import { test } from "node:test";
import assert from "node:assert/strict";
import { insertIndex, labelPoint, orthoPoints, roundedPath, routeAround, separate, simplify } from "./route.ts";

const isOrtho = (pts: { x: number; y: number }[]) => pts.slice(1).every((q, i) => q.x === pts[i].x || q.y === pts[i].y);

test("auto route is out, across, in at right angles", () => {
	const pts = orthoPoints({ x: 0, y: 0, dx: 1 }, { x: 200, y: 100, dx: -1 });
	assert.deepEqual(pts, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 100 }]);
	assert.equal(orthoPoints({ x: 0, y: 0, dx: 1 }, { x: 200, y: 100, dx: -1 }, [], 6)[1].x, 106);
});

test("straight wire collapses to two points", () => {
	assert.deepEqual(orthoPoints({ x: 0, y: 50, dx: 1 }, { x: 200, y: 50, dx: -1 }), [{ x: 0, y: 50 }, { x: 200, y: 50 }]);
});

test("route passes through every bend point at right angles", () => {
	const via = [{ x: 60, y: 200 }, { x: 140, y: 240 }];
	const pts = orthoPoints({ x: 0, y: 0, dx: 1 }, { x: 200, y: 100, dx: -1 }, via);
	assert.ok(isOrtho(pts));
	for (const v of via) assert.ok(pts.some(p => p.x === v.x && p.y === v.y));
});

test("simplify drops duplicates and collinear points", () => {
	assert.deepEqual(simplify([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }]), [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }]);
});

test("rounded path has no NaN and a curve per corner", () => {
	const d = roundedPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 3 }, { x: 200, y: 3 }]);
	assert.ok(!d.includes("NaN"));
	assert.equal(d.split("Q").length - 1, 2);
});

test("label sits on the longest segment; new bend points go in the nearest slot", () => {
	assert.deepEqual(labelPoint([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 100 }]), { x: 10, y: 50 });
	const via = [{ x: 100, y: 0 }, { x: 200, y: 0 }];
	assert.equal(insertIndex({ x: 0, y: 0 }, { x: 300, y: 0 }, via, { x: 50, y: 10 }), 0);
	assert.equal(insertIndex({ x: 0, y: 0 }, { x: 300, y: 0 }, via, { x: 150, y: 10 }), 1);
	assert.equal(insertIndex({ x: 0, y: 0 }, { x: 300, y: 0 }, via, { x: 260, y: 10 }), 2);
});

test("routes around a box that blocks the straight path", () => {
	const box = { x1: 80, y1: -50, x2: 120, y2: 50 };
	const pts = routeAround({ x: 0, y: 0 }, { x: 200, y: 0 }, [box])!;
	assert.ok(pts && isOrtho(pts));
	assert.deepEqual(pts[0], { x: 0, y: 0 });
	assert.deepEqual(pts[pts.length - 1], { x: 200, y: 0 });
	// no segment passes through the box
	for (let i = 1; i < pts.length; i++) {
		const p = pts[i - 1], q = pts[i];
		const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
		assert.ok(!(mx > box.x1 && mx < box.x2 && my > box.y1 && my < box.y2), JSON.stringify(pts));
		if (p.y === q.y) assert.ok(!(p.y > box.y1 && p.y < box.y2 && Math.min(p.x, q.x) < box.x1 && Math.max(p.x, q.x) > box.x2));
	}
});

test("free path is a straight line; enclosed end has no route", () => {
	assert.deepEqual(routeAround({ x: 0, y: 0 }, { x: 200, y: 0 }, []), [{ x: 0, y: 0 }, { x: 200, y: 0 }]);
	assert.equal(routeAround({ x: 0, y: 0 }, { x: 100, y: 0 }, [{ x1: 90, y1: -10, x2: 110, y2: 10 }]), undefined);
});

test("separate spreads overlapping interior runs, keeps ends", () => {
	const mk = (y: number) => [{ x: 0, y }, { x: 100, y }, { x: 100, y: 300 + y }, { x: 200, y: 300 + y }];
	const a = mk(0), b = mk(20);
	separate([a, b]);
	assert.notEqual(a[1].x, b[1].x);
	assert.equal(a[1].x, a[2].x); // still vertical
	assert.deepEqual([a[0], b[0]], [{ x: 0, y: 0 }, { x: 0, y: 20 }]);
});
