export function toInstant(value, label = "time") {
  const candidate = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(candidate.getTime())) throw new TypeError(`${label} must resolve to a valid instant`);
  return candidate;
}

export function resolveClock(options = {}, fallback) {
  if (options.clock !== undefined && typeof options.clock !== "function") {
    throw new TypeError("options.clock must be a function");
  }
  const supplied = options.clock ? options.clock() : options.now;
  return toInstant(supplied ?? fallback, "clock");
}
