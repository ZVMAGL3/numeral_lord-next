# 衰蚀地 Mod v0.3.0 说明

本文说明衰蚀地 Mod 的规则声明，方便阅读和分享。代码块使用 JSONC（带注释的 JSON），注释版不能直接作为严格 JSON 导入。

## 规则概述

- 衰蚀地可被单位占领，并能传导电力。
- 每名玩家自己的回合开始时，该玩家所有位于衰蚀地上的单位兵力减 1。
- 规则不要求单位通电，因此游兵和通电兵都适用；对手单位和中立单位不受影响。
- 兵力降至 0 后移除单位，是游戏引擎执行通用减兵效果的行为。
- 地块图案、占领外框等视觉表现由客户端绘制，不包含在这段规则声明中。

## 带注释的 Mod 声明

```jsonc
{
  // 名称是地块显示名称的唯一来源。
  "name": "衰蚀地",
  "description": "",
  "definition": {
    // Mod 的稳定 ID；地块 ID 会据此自动生成。
    "id": "mod-decay-terrain",

    // 工坊发布的 Mod 版本。
    "version": "0.3.0",

    // 声明一个可附加到地形上的自定义能力。
    "capabilities": [
      {
        "id": "mod/decay-terrain/turn-start-drain",
        "target": "terrain",
        "defaultConfig": {}
      }
    ],

    // 定义“哪些单位位于带有衰蚀效果的地块上”。
    "spatialPatterns": [
      {
        "id": "mod-decay-terrain/units-on-decay",

      // 从带有衰蚀能力的地块开始查找。
      "starts": {
        "op": "terrain-has",
        "capabilityId": "mod/decay-terrain/turn-start-drain"
      },

      // 重复步数是 0，所以不会扩散到邻格；
      // 实际匹配的是起始衰蚀地块本身。
      "expression": {
        "op": "repeat",
        "min": 0,
        "max": 0,
        "item": {
          "op": "step",
          "relation": "hex-neighbor",
          "where": {
            "op": "terrain-has",
            "capabilityId": "mod/decay-terrain/turn-start-drain"
          }
        }
      },

      // 从匹配到的地块中取出上面的单位，并按单位 ID 去重。
      "result": {
        "entity": "unit",
        "distinctBy": "id"
      }
      }
    ],

    // 声明触发时机、作用对象和效果。
    "rules": [
      {
        "id": "mod-decay-terrain/lose-strength-at-turn-start",

      // 在回合开始时触发。
      "trigger": "turn-start",

      "target": {
        "scope": "pattern-units",
        "patternId": "mod-decay-terrain/units-on-decay",

        // 只影响当前回合玩家自己的单位；
        // 对手单位和中立单位不受影响。
        "owner": "actor"
      },

      "effects": [
        {
          "type": "change-strength",

          // 兵力减 1；减至 0 时由游戏引擎移除单位。
          "amount": -1
        }
      ]
      }
    ],

    // 一个 Mod 只声明一个地块；ID 和名称从上方 Mod 信息派生。
    "terrain": {
      "capabilities": [
        // 单位可以站在这块地上。
        { "id": "core/occupiable" },

        // 这块地可以传导电力。
        { "id": "core/power-conductor" },

        // 赋予这块地本 Mod 定义的回合开始减兵效果。
        { "id": "mod/decay-terrain/turn-start-drain" }
      ]
    }
  }
}
```

## 阅读提示

`owner: "actor"` 中的 actor 指当前回合玩家。`spatialPatterns` 负责找出衰蚀地上的单位，`rules` 再对这些单位执行减兵效果。

如果需要将定义导入系统，请使用工坊中保存的无注释版本；JSON 标准不允许 `//` 注释。
