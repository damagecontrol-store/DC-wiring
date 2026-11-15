// Unit settings and gauge conversion. Pure: no Obsidian imports, so tests can load it.

export const GAUGE_UNITS = ["mm²", "AWG", "cmil", "kcmil"] as const;
export type GaugeUnit = typeof GAUGE_UNITS[number];

/** Millimetres per unit. */
export const LENGTH_UNITS = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8, yd: 914.4 } as const;
export type LengthUnit = keyof typeof LENGTH_UNITS;

const CMIL = Math.PI / 4 * 0.0254 ** 2; // mm² per circular mil

const awgToMm2 = (n: number) => Math.PI / 4 * (0.127 * 92 ** ((36 - n) / 39)) ** 2;

/**
 * "0.5", "0.5 mm²", "20AWG", "4/0 AWG", "250 kcmil" -> mm². A plain number is read in the given unit.
 * Undefined when empty or not a gauge.
 */
export function toMm2(s: string | undefined, unit: GaugeUnit = "mm²"): number | undefined {
	const m = (s ?? "").trim().toLowerCase().replace(",", ".").match(/^(\d+(?:\.\d+)?|[1-4]\/0)\s*(mm²|mm2|awg|kcmil|mcm|cmil)?$/);
	if (!m) return;
	const u = m[2] === "mm2" ? "mm²" : m[2] === "mcm" ? "kcmil" : m[2] ? GAUGE_UNITS.find(g => g.toLowerCase() === m[2])! : unit;
	const awg = m[1].includes("/") ? 1 - Number(m[1][0]) : Number(m[1]); // 1/0 = AWG 0, 4/0 = AWG -3
	if (m[1].includes("/") && u !== "AWG") return;
	if (u === "AWG") return awgToMm2(awg);
	const v = Number(m[1]);
	return u === "mm²" ? v : u === "cmil" ? v * CMIL : v * 1000 * CMIL;
}

/** mm² -> number in the unit: nearest whole AWG, mm² to 2 decimals, whole cmil. */
export function fromMm2(mm2: number, unit: GaugeUnit): string {
	if (unit === "AWG") {
		const n = Math.round(36 - 39 * Math.log(Math.sqrt(mm2 * 4 / Math.PI) / 0.127) / Math.log(92));
		return n <= 0 ? `${1 - n}/0` : String(n);
	}
	if (unit === "mm²") return String(Math.round(mm2 * 100) / 100);
	const cmil = Math.round(mm2 / CMIL);
	return String(unit === "cmil" ? cmil : cmil / 1000);
}

export const formatGauge = (mm2: number, unit: GaugeUnit) => `${fromMm2(mm2, unit)} ${unit}`;
