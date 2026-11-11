/**
 * The storms the benchmark replays. Every SDK under test sees exactly the same sequence of errors:
 * same count, same kinds, same order, same pacing — only the reporting differs.
 */
export interface Scenario {
  name: string;
  /** One line for the results table. */
  description: string;
  /** Distinct kinds of error in the storm (distinct issues, once grouped). */
  kinds: number;
  /** Which kind the i-th error of the storm is. Deterministic, so every run is identical. */
  kindOf(i: number): number;
}

/**
 * Ten kinds weighted the way incidents usually look: one dominant failure and a tail of
 * consequences. Weights are 1/rank (Zipf), so kind 0 is about a third of the storm.
 */
const INCIDENT_KINDS = 10;
const incidentCumulative = (() => {
  const weights = Array.from({ length: INCIDENT_KINDS }, (_, k) => 1 / (k + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  return weights.map((w) => (acc += w / total));
})();

/** A fixed pseudo-random sequence (mulberry32), so "random" kinds are the same on every run. */
function seeded(i: number): number {
  let t = (i + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export const SCENARIOS: Record<string, Scenario> = {
  storm: {
    name: "storm",
    description: "one error, repeated (a database timeout)",
    kinds: 1,
    kindOf: () => 0,
  },
  incident: {
    name: "incident",
    description: "10 kinds of error, one dominant (Zipf-weighted)",
    kinds: INCIDENT_KINDS,
    kindOf: (i) => {
      const r = seeded(i);
      const k = incidentCumulative.findIndex((c) => r < c);
      return k === -1 ? INCIDENT_KINDS - 1 : k;
    },
  },
  cardinality: {
    name: "cardinality",
    description: "5,000 kinds of error, evenly spread (grouping's worst case)",
    kinds: 5000,
    kindOf: (i) => i % 5000,
  },
};
