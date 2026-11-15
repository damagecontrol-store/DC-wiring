// Length maths for length fields: "40 + 30 + 40", "2 * 30cm", "5' 3\"", "(10 + 20) cm".

export const UNITS: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, '"': 25.4, ft: 304.8, "'": 304.8, yd: 914.4 };

// a plain number has no unit yet: it is a scale factor next to * and /, else a length in the default unit
type Val = { n: number; unit?: string };

/**
 * Parses a length expression. Plain numbers are in `unit`. Returns the length in mm and the unit to show
 * it in: the one unit every number stated, else `unit`. Undefined if it is not a valid length.
 */
export function parseLength(text: string, unit = "mm"): { mm: number; unit: string } | undefined {
	const toks = text.toLowerCase().match(/\d+(?:\.\d+)?|\.\d+|mm|cm|in|ft|yd|m|["'+\-*/x×()]|\S/g) ?? [];
	let i = 0;
	const seen = new Set<string>();
	const fail = () => { throw new Error(); };
	const mm = (v: Val) => { if (v.unit) return v.n; seen.add(unit); return v.n * UNITS[unit]; };
	const withUnit = (v: Val): Val => {
		const u = toks[i];
		if (!(u in UNITS)) return v;
		i++;
		if (v.unit) fail(); // "3cm mm"
		seen.add(u === '"' ? "in" : u === "'" ? "ft" : u);
		return { n: v.n * UNITS[u], unit: "mm" };
	};
	const primary = (): Val => {
		const t = toks[i++];
		if (t === "(") {
			const v = expr();
			if (toks[i++] !== ")") fail();
			return withUnit(v);
		}
		if (t === undefined || isNaN(Number(t))) fail();
		return withUnit({ n: Number(t) });
	};
	// lengths side by side add up: 5' 3", 1m 20cm
	const side = (): Val => {
		let v = primary();
		while (toks[i] === "(" || /^[\d.]/.test(toks[i] ?? "")) v = add(v, primary());
		return v;
	};
	const add = (a: Val, b: Val, sign = 1): Val =>
		!a.unit && !b.unit ? { n: a.n + sign * b.n } : { n: mm(a) + sign * mm(b), unit: "mm" };
	const term = (): Val => {
		let v = side();
		for (let op = toks[i]; op === "*" || op === "x" || op === "×" || op === "/"; op = toks[i]) {
			i++;
			const r = side();
			if (op === "/") { if (r.unit || r.n === 0) fail(); v = { ...v, n: v.n / r.n }; }
			else if (v.unit && r.unit) fail(); // area, not a length
			else v = { n: v.n * r.n, unit: v.unit ?? r.unit };
		}
		return v;
	};
	const expr = (): Val => {
		let v = term();
		for (let op = toks[i]; op === "+" || op === "-"; op = toks[i]) { i++; v = add(v, term(), op === "+" ? 1 : -1); }
		return v;
	};
	try {
		if (!toks.length) return;
		const v = expr();
		if (i < toks.length) return;
		const out = mm(v);
		if (!isFinite(out) || out < 0) return;
		return { mm: out, unit: seen.size === 1 ? [...seen][0] : unit };
	} catch { return; }
}

/** 600 mm in "cm" -> "60 cm". */
export function formatLength(mm: number, unit = "mm"): string {
	const f = UNITS[unit] ?? 1;
	return `${Math.round(mm / f * 100) / 100} ${unit in UNITS ? unit : "mm"}`;
}
