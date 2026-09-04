export function mean(values) {
  if (values.length === 0) throw new RangeError("mean requires at least one value");
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
