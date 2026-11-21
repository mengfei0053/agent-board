// Grok tasks target a deployed BDK agent. A CLI model name is not a bot slug.
export function validBotSlug(slug) {
  return typeof slug === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug) && slug === slug.trim();
}

export const teamIdHint = "Cursor Team ID 须留空或填写 1 至 9007199254740991 的十进制整数，不可有前导零。";

export function validTeamId(value) {
  return value === "" || (typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value)));
}

export function grokBotAvailable(config) {
  return config?.enabled === true && validBotSlug(config.slug);
}
