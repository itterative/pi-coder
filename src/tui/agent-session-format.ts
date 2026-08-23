export function compactNumber(value: number): string {
    const absolute = Math.abs(value);
    const units = [
        { value: 1_000_000_000, suffix: "b" },
        { value: 1_000_000, suffix: "m" },
        { value: 1_000, suffix: "k" },
    ];
    const unit = units.find((candidate) => absolute >= candidate.value);
    if (!unit) return String(value);
    const scaled = value / unit.value;
    const precision = Math.abs(scaled) < 10 ? 1 : 0;
    return `${Number(scaled.toFixed(precision))}${unit.suffix}`;
}
