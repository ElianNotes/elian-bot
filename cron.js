// cron.js — standard 5-field cron with CORRECT semantics.
// Battle-tested 5-field parser. Zero dependencies.
//
//   minute  hour  day-of-month  month  day-of-week
//
// Each field accepts: "*", a number, "*/n", "a-b", "a-b/n", "a,b,c" (any mix).
// Standard rules implemented below:
//   1. DOM/DOW = OR when BOTH are restricted (real cron semantics).
//   2. 0 and 7 are BOTH Sunday.
// validateCron() reports a human reason when an expression is malformed OR when
// it is well-formed but can never fire (e.g. "0 0 30 2 *" — Feb 30th).

const FIELD_BOUNDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day-of-month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day-of-week", min: 0, max: 7 } // 0 and 7 both mean Sunday
];

// Parse one field into a Set of allowed integers, plus a `restricted` flag
// (true unless the field is a bare "*"). `restricted` is what the OR rule needs.
function parseField(expr, min, max, fieldName) {
  const raw = String(expr).trim();
  if (raw === "") throw new Error(`empty ${fieldName} field`);

  const restricted = raw !== "*";
  const out = new Set();

  for (const part of raw.split(",")) {
    const token = part.trim();
    if (token === "") throw new Error(`empty term in ${fieldName} field`);

    let step = 1;
    let body = token;
    if (body.includes("/")) {
      const [b, s] = body.split("/");
      step = parseInt(s, 10);
      if (!Number.isInteger(step) || step < 1) {
        throw new Error(`invalid step "/${s}" in ${fieldName} field`);
      }
      body = b;
    }

    let lo, hi;
    if (body === "*") {
      lo = min;
      hi = max;
    } else if (body.includes("-")) {
      const [a, b] = body.split("-");
      lo = parseInt(a, 10);
      hi = parseInt(b, 10);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
        throw new Error(`invalid range "${body}" in ${fieldName} field`);
      }
    } else {
      lo = parseInt(body, 10);
      hi = lo;
      if (!Number.isInteger(lo)) {
        throw new Error(`invalid value "${body}" in ${fieldName} field`);
      }
    }

    if (lo < min || hi > max || lo > hi) {
      throw new Error(
        `${fieldName} value out of range (${lo}-${hi}); allowed ${min}-${max}`
      );
    }
    for (let i = lo; i <= hi; i += step) out.add(i);
  }

  return { set: out, restricted };
}

// Normalize a day-of-week set so 7 collapses to 0 (both Sunday). Date.getDay()
// returns 0..6, so we only ever test against 0..6.
function normalizeWeekdays(set) {
  const out = new Set();
  for (const v of set) out.add(v === 7 ? 0 : v);
  return out;
}

function parseCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(
      `expected 5 fields (minute hour day month weekday), got ${parts.length}: "${expr}"`
    );
  }
  const fields = parts.map((p, i) =>
    parseField(p, FIELD_BOUNDS[i].min, FIELD_BOUNDS[i].max, FIELD_BOUNDS[i].name)
  );
  return {
    minutes: fields[0].set,
    hours: fields[1].set,
    daysOfMonth: fields[2].set,
    domRestricted: fields[2].restricted,
    months: fields[3].set,
    weekdays: normalizeWeekdays(fields[4].set),
    dowRestricted: fields[4].restricted
  };
}

// Does a given Date satisfy the parsed cron? Implements the DOM/DOW OR rule.
function matches(cron, d) {
  if (!cron.minutes.has(d.getMinutes())) return false;
  if (!cron.hours.has(d.getHours())) return false;
  if (!cron.months.has(d.getMonth() + 1)) return false;

  const domOk = cron.daysOfMonth.has(d.getDate());
  const dowOk = cron.weekdays.has(d.getDay());

  // Standard rule:
  //  - both restricted  -> OR  (match if either day field matches)
  //  - only DOM restricted -> DOM must match
  //  - only DOW restricted -> DOW must match
  //  - neither restricted  -> any day
  if (cron.domRestricted && cron.dowRestricted) return domOk || dowOk;
  if (cron.domRestricted) return domOk;
  if (cron.dowRestricted) return dowOk;
  return true;
}

// Next fire strictly after fromDate. Returns a Date, or throws if no fire
// within ~4 years (treat that as "never fires").
function nextFire(expr, fromDate) {
  const cron = parseCron(expr);
  const d = new Date(fromDate.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // candidate must be strictly after fromDate

  const limit = new Date(fromDate.getTime() + 4 * 366 * 24 * 60 * 60 * 1000);
  while (d < limit) {
    if (matches(cron, d)) return new Date(d.getTime());
    d.setMinutes(d.getMinutes() + 1);
  }
  throw new Error(`no fire time within 4 years for "${expr}" (never fires)`);
}

// Validate without throwing. Returns:
//   { ok: true,  next: Date }                      — fires; next shows when
//   { ok: false, reason: string, neverFires?: bool }
function validateCron(expr) {
  let cron;
  try {
    cron = parseCron(expr);
  } catch (err) {
    return { ok: false, reason: err.message };
  }
  try {
    const next = nextFire(expr, new Date());
    return { ok: true, next };
  } catch {
    return {
      ok: false,
      neverFires: true,
      reason: `"${expr}" is valid syntax but never fires (e.g. an impossible date like Feb 30th)`
    };
  }
}

module.exports = { parseCron, matches, nextFire, validateCron };
