import type { GameCommand, GameState, MatchConditionModule, PlayerId } from "@numeral-lord/game-core";

export type CapabilityTarget = "terrain" | "unit" | "match";

export interface CapabilityDefinition<Config = unknown> {
  /** 能力的全局稳定标识，例如 `core/power-conductor`。 */
  readonly id: string;
  /** 此能力可附加到地形、单位，或整局对局规则。 */
  readonly target: CapabilityTarget;
  /** 作者未写配置时，引擎应使用的默认配置。 */
  readonly defaultConfig: Config;
}

/** A terrain or unit opts into a capability by adding one of these bindings. */
export interface CapabilityBinding {
  /** 已注册能力的 id；必须与某个 CapabilityDefinition.id 对应。 */
  readonly id: string;
  /** 此地形/单位对该能力的专属配置；省略时使用能力的默认配置。 */
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface TerrainDefinition {
  /** 地形的稳定 id，地图保存时记录它，不使用可翻译的显示名称。 */
  readonly id: string;
  /** 编辑器和游戏界面显示的名称。 */
  readonly displayName: string;
  /** 此地形从公共能力池中选中的能力；空数组表示没有游戏能力。 */
  readonly capabilities: readonly CapabilityBinding[];
}

export interface UnitDefinition {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: readonly CapabilityBinding[];
}

export interface RuleEvent {
  /** 事件的稳定类型，例如 `unit-exhausted`；客户端据此播放表现。 */
  readonly type: string;
  /** 事件的数据。客户端不能自行伪造，必须由规则内核或 Mod 返回。 */
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface DeterministicRandom {
  nextInt(upperExclusive: number): number;
}

export interface RuleContext {
  readonly state: GameState;
  readonly actorId: PlayerId;
  readonly random: DeterministicRandom;
}

export interface CommandRule {
  readonly commandType: GameCommand["type"] | string;
  resolve(context: RuleContext, command: GameCommand): readonly RuleEvent[];
}

/** Mod victory rules use the same executable interface as the shared engine. */
export type VictoryCondition = MatchConditionModule;

export interface TeamVictory {
  readonly teamId: string;
  readonly reason: string;
}

export interface ModDefinition {
  readonly id: string;
  readonly version: string;
  readonly capabilities: readonly CapabilityDefinition[];
  readonly terrains: readonly TerrainDefinition[];
  readonly units: readonly UnitDefinition[];
  readonly commandRules: readonly CommandRule[];
  readonly victoryConditions: readonly VictoryCondition[];
}

export function defineMod(definition: ModDefinition): ModDefinition {
  return definition;
}
