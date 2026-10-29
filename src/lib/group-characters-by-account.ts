/** Group the master's character library by linked account, never by the
 * editable player_name field. Unlinked characters belong to NPCs. */
export type CharacterForAccountGrouping = {
  id: string;
  name: string;
  player_name: string | null;
  owner_id: string | null;
};
export type CharacterAccountProfile = {
  id: string;
  email: string | null;
  display_name: string | null;
};
export type CharacterAccountGroup<T extends CharacterForAccountGrouping> = {
  id: string;
  ownerId: string | null;
  email: string | null;
  displayName: string | null;
  isNpc: boolean;
  characters: T[];
};

export function groupCharactersByAccount<T extends CharacterForAccountGrouping>(
  characters: readonly T[],
  profiles: readonly CharacterAccountProfile[],
  search = "",
): CharacterAccountGroup<T>[] {
  const profilesById = new Map(profiles.map((profile) => [profile.id, profile]));
  const grouped = new Map<string, CharacterAccountGroup<T>>();
  const term = search.trim().toLocaleLowerCase("pt-BR");

  for (const character of characters) {
    const ownerId = character.owner_id;
    const profile = ownerId ? profilesById.get(ownerId) : undefined;
    const email = profile?.email?.trim() || null;
    const displayName = profile?.display_name?.trim() || null;
    const groupId = ownerId ? `account:${ownerId}` : "npc";

    // Search matches both individual characters and the linked account.
    const accountMatches = [email, displayName].some((value) =>
      value?.toLocaleLowerCase("pt-BR").includes(term)
    );
    const characterMatches = [character.name, character.player_name].some((value) =>
      value?.toLocaleLowerCase("pt-BR").includes(term)
    );
    if (term && !accountMatches && !characterMatches) continue;

    let group = grouped.get(groupId);
    if (!group) {
      group = {
        id: groupId,
        ownerId,
        email,
        displayName,
        isNpc: ownerId === null,
        characters: [],
      };
      grouped.set(groupId, group);
    }
    group.characters.push(character);
  }
  return [...grouped.values()].sort((a, b) => {
    if (a.isNpc !== b.isNpc) return a.isNpc ? 1 : -1;
    return (a.email ?? a.displayName ?? "").localeCompare(
      b.email ?? b.displayName ?? "", "pt-BR", { sensitivity: "base" }
    );
  });
}
