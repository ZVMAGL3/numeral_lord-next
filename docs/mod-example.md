# 油田 Mod 示例

油田现在不是原生地形。它位于 `packages/oil-field-mod/`，作为一个可以被地图显式安装的可选内容包。核心包只提供公共能力和原生地形；地图是否出现油田，由地图装配时是否合并这个 Mod 的目录决定。

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

## 地图如何安装 Mod

演示地图在 `packages/core-content/src/demo-match.ts` 中显式安装：

```ts
const terrainCatalog = {
  ...coreTerrainCatalog,
  ...oilFieldTerrainCatalog
};

return startMatch(initialState, terrainCatalog, coreUnitCatalog, coreMatchConditionCatalog).state;
```

要做一张不含油田的地图，只使用 `coreTerrainCatalog`，并且不要在地图字符串中写 `F`。要让地图使用油田，需要同时满足两点：地图码把格子写成 `F`，装配器把 `oilFieldTerrainCatalog` 合并进运行时目录。

## 新增一个 Mod 的最小步骤

1. 新建 `packages/<your-mod>/`，使用独立的包名和 `mod/<name>` 地形 ID。
2. 在 `defineMod({ ... })` 中声明版本、能力、地形、单位或胜负条件。
3. 只依赖 `game-sdk` 与 `game-core` 的公开类型；能力通过 `CapabilityBinding` 组合，不修改核心引擎。
4. 导出自己的 catalog，在地图/房间创建时显式合并。
5. 如果需要新的规则能力，在 Mod 的 `capabilities` 中注册稳定 ID，并在规则扩展中实现它；不要把 UI 组件写进规则包。

这样 Mod 可以被网页、服务端和无界面的 AI 训练程序共同加载。地图不安装某个 Mod 时，核心目录不会认识该 Mod 的地形，因而不会产生隐式规则。
