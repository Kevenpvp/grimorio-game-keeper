/** Public labels for the trusted script modules registered in the server runtime. */
export const CUSTOM_ABILITY_SCRIPTS = [
  {
    key: "example",
    label: "Exemplo — registrar eventos (não altera o combate)",
  },
] as const;

export type CustomAbilityScriptKey = (typeof CUSTOM_ABILITY_SCRIPTS)[number]["key"];
