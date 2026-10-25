/** The attacker gains +1 on the attack roll when the target has an active Stun.
 * The +1 is added AFTER the ordinary minimum-zero speed calculation.
 * Dodge rolls are deliberately unchanged.
 */
export function attackDiceModifier(attackSpeed: number, targetSpeed: number, targetStunned: boolean): number {
  return Math.max(0, Math.floor((attackSpeed - targetSpeed) / 10)) + (targetStunned ? 1 : 0);
}

export function hasActiveStun(
  characterId: string,
  effects: ReadonlyArray<{ character_id: string; effect_type: string; duration: number }>,
): boolean {
  return effects.some((effect) => effect.character_id === characterId
    && effect.effect_type === "stun" && Number(effect.duration) > 0);
}
