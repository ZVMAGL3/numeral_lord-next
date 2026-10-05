# 油田 Mod 示例

油田不是原生地形。它位于独立的 `packages/oil-field-mod/`；`core-content` 不导入油田包。地图码只声明它需要 `mod-oil-field`，实际运行时由客户端/服务器的内容装配层决定是否安装该地块 Mod。

## 目录结构

```text
packages/oil-field-mod/
├─ package.json
├─ tsconfig.json
└─ src/index.ts
```

`src/index.ts` 暴露三样东西：

- `oilFieldMod`：Mod 的稳定 `id`、版本、能力注册、地形和胜负条件。
- `OIL_FIELD_TERRAIN_ID`：地图数据里保存的稳定地形 ID（`mod/oil-field`）。
- `oilFieldTerrainCatalog`：可以传给规则引擎的地形目录。

油田自身只组合公共能力：可占据、占据时收益 2 点、离开时留下 1 点游兵。它没有 `power-conductor`，所以油田收益和供电是两条独立规则。

## 地图如何声明依赖、运行时如何装配

地图码的 `terrainLegend` 显式将字符 `X` 指向 `mod/oil-field`，`requiredTerrainModIds` 包含 `mod-oil-field`。字符只是地图内的局部符号，不代表全局或旧格式约定；这是地块依赖，不是 `matchConditionIds` 胜负条件。网页端在 `apps/web/src/content/installed-content.ts` 合并已安装的地形目录：

```ts
import { oilFieldMod, oilFieldTerrainCatalog } from "@numeral-lord/oil-field-mod";

const installedTerrainCatalog = {
  ...coreTerrainCatalog,
  ...oilFieldTerrainCatalog
};
const terrainModIds = Object.fromEntries(
  [oilFieldMod.terrain.id, oilFieldMod.id]
);
```

没安装依赖时，`parseMapCode(code, { allowUnknownTerrainMods: true })` 仍可校验并收藏地图码；真正开局的 `createMatchFromMapCode` 永远要求完整已安装目录。创意工坊中发布的地块源码目前只能预览，不能直接安装执行。

## 新增一个 Mod 的最小步骤

1. 新建 `packages/<your-mod>/`，使用独立的包名和 `mod/<name>` 地形 ID。
2. 在 `defineMod({ ... })` 中声明版本、能力、地形、单位或胜负条件。
3. 只依赖 `game-sdk` 与 `game-core` 的公开类型；能力通过 `CapabilityBinding` 组合，不修改核心引擎。
4. 导出自己的 catalog，在地图/房间创建时显式合并。
5. 如果需要新的规则能力，在 Mod 的 `capabilities` 中注册稳定 ID，并在规则扩展中实现它；不要把 UI 组件写进规则包。

这样 Mod 可以被网页、服务端和无界面的 AI 训练程序共同加载。地图不安装某个 Mod 时，核心目录不会认识该 Mod 的地形，因而不会产生隐式规则。
