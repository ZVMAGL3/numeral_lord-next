import type { CellId, PlayerId, UnitId } from "./state.js";

export interface CommandBase {
  readonly commandId: string;
  readonly actorId: PlayerId;
  readonly expectedSequence: number;
}

export interface MoveUnitCommand extends CommandBase {
  readonly type: "move-unit";
  readonly unitId: UnitId;
  readonly destinationId: CellId;
}

/** Attack is independent from movement so ranged units do not need to move. */
export interface AttackUnitCommand extends CommandBase {
  readonly type: "attack-unit";
  readonly unitId: UnitId;
  readonly targetId: CellId;
}

/** Ends the movement/attack part of the current player's turn. */
export interface EndActionPhaseCommand extends CommandBase {
  readonly type: "end-action-phase";
}

/** Ends the current player's point-allocation part and advances the seat. */
export interface EndReinforcementPhaseCommand extends CommandBase {
  readonly type: "end-reinforcement-phase";
}

export interface ReinforceUnitCommand extends CommandBase {
  readonly type: "reinforce-unit";
  readonly unitId: UnitId;
}

export type GameCommand = MoveUnitCommand
  | AttackUnitCommand
  | ReinforceUnitCommand
  | EndActionPhaseCommand
  | EndReinforcementPhaseCommand;
