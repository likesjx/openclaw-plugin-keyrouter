export type CandidateModel = {
  id: string;
  inputCost?: number;
  outputCost?: number;
};

export function selectCheapest(candidates: CandidateModel[]): CandidateModel | null {
  if (!candidates.length) {
    return null;
  }

  const score = (m: CandidateModel): number => {
    const input = typeof m.inputCost === "number" ? m.inputCost : Number.POSITIVE_INFINITY;
    const output = typeof m.outputCost === "number" ? m.outputCost : Number.POSITIVE_INFINITY;
    return input + output;
  };

  return candidates.reduce((best, current) => (score(current) < score(best) ? current : best));
}
