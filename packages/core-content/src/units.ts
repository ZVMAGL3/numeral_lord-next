import type { UnitCatalog } from "@numeral-lord/game-core";
import { defineMod, type CapabilityBinding } from "@numeral-lord/game-sdk";

/**
 * The first built-in unit. Each combat concern is deliberately its own
 * capability so maps and Mods can mix them without inheriting a new class.
 */
const move: CapabilityBinding = { id: "core/move", config: { maxDistance: 1 } };
const attack: CapabilityBinding = { id: "core/attack", config: { movesIntoTarget: true } };
const attackRange: CapabilityBinding = { id: "core/attack-range", config: { min: 1, max: 1 } };
const counterattack: CapabilityBinding = { id: "core/counterattack" };
const counterattackLimit: CapabilityBinding = { id: "core/counterattack-limit", config: { maxPerActionPhase: 1 } };
/** Action result loses one point, but never falls below one; a one-point action exhausts the unit. */
const actionStrengthDecay: CapabilityBinding = {
  id: "core/action-strength-decay",
  config: { amount: 1, minimumStrength: 1 }
};
/** A powered unit must retain one point at its origin, so one point cannot act. */
const poweredActionThreshold: CapabilityBinding = { id: "core/powered-action-threshold", config: { minimumStrength: 2 } };
/** Each powered unit supplies one reinforcement point during its owner's turn. */
const poweredIncome: CapabilityBinding = { id: "core/powered-income", config: { amount: 1 } };
/** 攻击结算成功后，本回合不能再次行动；这是单位能力，不是地图效果。 */
const exhaustAfterAttack: CapabilityBinding = { id: "core/exhaust-after-attack" };

export const coreUnitMod = defineMod({
  id: "core-units",
  version: "0.1.0",
  capabilities: [
    { id: "core/move", target: "unit", defaultConfig: { maxDistance: 1 } },
    { id: "core/attack", target: "unit", defaultConfig: { movesIntoTarget: true } },
    { id: "core/attack-range", target: "unit", defaultConfig: { min: 1, max: 1 } },
    { id: "core/counterattack", target: "unit", defaultConfig: {} },
    { id: "core/counterattack-limit", target: "unit", defaultConfig: { maxPerActionPhase: 1 } },
    {
      id: "core/action-strength-decay",
      target: "unit",
      defaultConfig: { amount: 1, minimumStrength: 1 }
    },
    { id: "core/powered-action-threshold", target: "unit", defaultConfig: { minimumStrength: 2 } },
    { id: "core/powered-income", target: "unit", defaultConfig: { amount: 1 } },
    { id: "core/exhaust-after-attack", target: "unit", defaultConfig: {} }
  ],
  terrains: [],
  units: [{
    id: "core/roamer",
    displayName: "游兵",
    capabilities: [
      move,
      attack,
      attackRange,
      counterattack,
      counterattackLimit,
      actionStrengthDecay,
      poweredActionThreshold,
      poweredIncome,
      exhaustAfterAttack
    ]
  }],
  commandRules: [],
  victoryConditions: []
});

export const coreUnitCatalog: UnitCatalog = Object.fromEntries(
  coreUnitMod.units.map((unit) => [unit.id, unit])
);
