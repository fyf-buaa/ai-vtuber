export type LegacyDetectedLanguage = "zh" | "ja" | "en";

export function detectLegacyLanguage(text: string): LegacyDetectedLanguage {
  if (/[\u3040-\u30ff]/u.test(text)) {
    return "ja";
  }
  if (/\p{Script=Han}/u.test(text)) {
    return "zh";
  }
  if (/\p{Script=Latin}/u.test(text)) {
    return "en";
  }
  return "zh";
}
