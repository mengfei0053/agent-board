/**
 * Continue without a bound session must not drop the new instruction.
 * The original task prompt stays, and the follow-up is appended explicitly.
 */
export function mergeContinueWithoutSession(original: string, continuePrompt: string): string {
  const base = (original || "").trim();
  const extra = (continuePrompt || "").trim();
  if (!extra) return base;
  if (!base) return extra;
  return `${base}\n\n---\n\n【继续指令】\n${extra}`;
}
