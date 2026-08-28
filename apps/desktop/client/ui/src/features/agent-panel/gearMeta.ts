import type { BalancedAskCategory, ParticipationGear } from '@orison/shared-contracts';

/**
 * Story 3.5 Step 7: participation-gear presentation table (quick switch in the
 * AgentPanel header + full settings in AgentSettings). Pure i18n option lists —
 * the gear VALUE semantics live in shared-contracts participationGearSchema and
 * the prompt protocol segment (agent side), never here.
 */

export const GEAR_OPTIONS: { value: ParticipationGear; i18nKey: string }[] = [
  { value: 'smart', i18nKey: 'agent.gearSmart' },
  { value: 'steer', i18nKey: 'agent.gearSteer' },
  { value: 'balanced', i18nKey: 'agent.gearBalanced' },
  { value: 'hands_off', i18nKey: 'agent.gearHandsOff' },
];

export const ASK_CATEGORY_OPTIONS: { value: BalancedAskCategory; i18nKey: string }[] = [
  { value: 'protagonist_safety', i18nKey: 'agent.gearAskCategoryProtagonistSafety' },
  { value: 'information_gap', i18nKey: 'agent.gearAskCategoryInformationGap' },
  { value: 'direction_turn', i18nKey: 'agent.gearAskCategoryDirectionTurn' },
];

/** i18n key for a gear badge/label (unknown values fall back to smart's key). */
export function gearLabelKey(gear: ParticipationGear): string {
  return GEAR_OPTIONS.find((g) => g.value === gear)?.i18nKey ?? 'agent.gearSmart';
}
