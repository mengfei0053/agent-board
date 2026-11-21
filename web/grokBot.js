// Grok tasks target a deployed BDK agent. A CLI model name is not a bot slug.
export function validBotSlug(slug) {
  return typeof slug === "string" && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug) && slug === slug.trim();
}

export function grokBotAvailable(config) {
  return config?.enabled === true && validBotSlug(config.slug);
}
