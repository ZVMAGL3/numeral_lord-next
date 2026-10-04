<script setup lang="ts">
const emit = defineEmits<{ close: [] }>();

const conditions = [
  {
    name: "格子存在",
    properties: [{ name: "op", value: '"cell-exists"' }],
    description: "匹配任意存在的棋盘格。",
    example: { op: "cell-exists" }
  },
  {
    name: "地块拥有能力",
    properties: [{ name: "op", value: '"terrain-has"' }, { name: "capabilityId", value: "已声明的能力 ID" }],
    description: "capabilityId 填游戏或 Mod 已声明的能力 ID。",
    example: { op: "terrain-has", capabilityId: "mod/my-mod/my-capability" }
  },
  {
    name: "单位所属方",
    properties: [{ name: "op", value: '"unit-owner-is"' }, { name: "owner", value: '"actor" | "other"' }],
    description: "owner 可填 actor（当前方）或 other（对方）。",
    example: { op: "unit-owner-is", owner: "actor" }
  },
  {
    name: "单位队伍",
    properties: [{ name: "op", value: '"unit-team-is"' }, { name: "team", value: '"actor" | "other"' }],
    description: "team 可填 actor（当前方队伍）或 other（对方队伍）。",
    example: { op: "unit-team-is", team: "actor" }
  },
  {
    name: "单位标记",
    properties: [{ name: "op", value: '"unit-has-marker"' }, { name: "marker", value: "单位标记 ID" }],
    description: "marker 填驻守单位的标记 ID。",
    example: { op: "unit-has-marker", marker: "mod/my-mod/bonus-income" }
  },
  {
    name: "单位已通电",
    properties: [{ name: "op", value: '"unit-is-powered"' }],
    description: "判断驻守单位是否接入供电网络；仅可用于收益前置条件。",
    example: { op: "unit-is-powered" }
  },
  {
    name: "全部满足",
    properties: [{ name: "op", value: '"all"' }, { name: "items", value: "1–16 项条件" }],
    description: "items 是 1–16 项条件组成的数组；每项可继续嵌套。",
    example: { op: "all", items: [{ op: "unit-is-powered" }, { op: "unit-has-marker", marker: "mod/my-mod/bonus-income" }] }
  },
  {
    name: "任一满足",
    properties: [{ name: "op", value: '"any"' }, { name: "items", value: "1–16 项条件" }],
    description: "items 是 1–16 项条件组成的数组；其中任一项满足即可。",
    example: { op: "any", items: [{ op: "unit-is-powered" }, { op: "unit-has-marker", marker: "mod/my-mod/bonus-income" }] }
  },
  {
    name: "条件取反",
    properties: [{ name: "op", value: '"not"' }, { name: "item", value: "一项条件" }],
    description: "item 是一项条件；其不满足时本条件满足。",
    example: { op: "not", item: { op: "unit-is-powered" } }
  }
] as const;
</script>

<template>
  <div class="condition-reference-backdrop" role="presentation" @click.self="emit('close')">
    <section class="condition-reference" role="dialog" aria-modal="true" aria-labelledby="condition-reference-title">
      <header>
        <div><small>RULE REFERENCE</small><h2 id="condition-reference-title">条件语法参考</h2><p>条件字段、可用值与 JSON 写法</p></div>
        <button type="button" aria-label="关闭条件语法参考" @click="emit('close')">关闭</button>
      </header>
      <div class="condition-reference-content">
        <p class="condition-reference-note">收益先检查己方占领，再判断这里的条件；all/any 每组 1–16 项，组合最多嵌套 12 层。</p>
        <div class="condition-reference-table-wrap" role="region" aria-label="全部条件属性" tabindex="0">
          <table>
            <colgroup><col class="condition-column" /><col class="properties-column" /><col class="example-column" /></colgroup>
            <thead>
              <tr><th scope="col">条件</th><th scope="col">属性及取值</th><th scope="col">JSON 示例</th></tr>
            </thead>
            <tbody>
              <tr v-for="item in conditions" :key="item.name">
                <th scope="row">{{ item.name }}</th>
                <td><div class="condition-properties"><div v-for="property in item.properties" :key="property.name" class="condition-property-row"><code>{{ property.name }}</code><span>{{ property.value }}</span></div><small>{{ item.description }}</small></div></td>
                <td><pre><code>{{ JSON.stringify(item.example, null, 2) }}</code></pre></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p class="condition-reference-footnote"><code>mod/my-mod/…</code> 是占位 ID，请替换为实际能力或单位标记 ID。单位通电条件仅用于收益规则。</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.condition-reference-backdrop{position:fixed;z-index:1000;inset:0;display:grid;place-items:center;padding:18px;background:rgba(3,10,18,.78);backdrop-filter:blur(5px)}
.condition-reference{display:flex;flex-direction:column;width:min(820px,100%);max-height:min(88dvh,900px);overflow:hidden;padding:0;border:1px solid rgba(126,192,208,.35);border-radius:16px;color:#d9eaf0;background:linear-gradient(145deg,#182d40,#0c1b2a);box-shadow:0 20px 70px #0009}
.condition-reference>header{position:relative;z-index:2;display:flex;flex:none;justify-content:space-between;align-items:flex-start;gap:15px;padding:18px;border-bottom:1px solid rgba(140,180,202,.17);background:linear-gradient(145deg,#182d40,#0c1b2a)}
.condition-reference-content{display:block;flex:1;min-width:0;min-height:0;overflow:auto;padding:10px 18px 18px;scrollbar-width:thin;scrollbar-color:rgba(125,187,204,.36) transparent}
.condition-reference-content::-webkit-scrollbar{width:6px}.condition-reference-content::-webkit-scrollbar-track{background:transparent}.condition-reference-content::-webkit-scrollbar-thumb{border-radius:8px;background:rgba(125,187,204,.36)}
.condition-reference>header small{color:#73ddd0;font-size:9px;font-weight:800;letter-spacing:.14em}
.condition-reference h2{margin:3px 0;color:#f0f6fa;font-size:21px}
.condition-reference>header p,.condition-reference-note,.condition-reference-footnote{margin:0;color:#92aebe;font-size:10px;line-height:1.55}
.condition-reference>header button{width:auto;margin:0;padding:6px 11px;border:1px solid rgba(137,184,203,.28);border-radius:8px;color:#c6dce7;background:#14283a;font-size:10px}
.condition-reference-table-wrap{min-width:0;margin:10px 0;border:1px solid rgba(126,177,200,.18);border-radius:9px;background:rgba(7,20,32,.42)}
table{width:100%;min-width:700px;border-collapse:collapse;table-layout:fixed;font-size:10px;line-height:1.45}
.condition-column{width:120px}.properties-column{width:230px}.example-column{width:auto}
thead{color:#9fe0d8;background:rgba(30,66,78,.56);text-align:left}
thead th{position:sticky;top:0;z-index:2;background:#183044;box-shadow:0 1px 0 rgba(126,177,200,.18)}
th,td{padding:8px 10px;border-bottom:1px solid rgba(126,177,200,.13);text-align:left;vertical-align:top}
tbody th{color:#d7e9ee;font-weight:700;white-space:nowrap}tbody tr:last-child th,tbody tr:last-child td{border-bottom:0}tbody tr:hover{background:rgba(36,89,85,.1)}
.condition-properties{display:grid;gap:4px}.condition-property-row{display:flex;align-items:baseline;gap:7px;min-width:0}.condition-property-row code{flex:none;padding:2px 5px;border-radius:4px;color:#a8d8dc;background:#071522;font:9px ui-monospace,Consolas,monospace}.condition-property-row span{min-width:0;color:#b7ceda;overflow-wrap:anywhere}.condition-properties>small{margin-top:2px;color:#829eae;font-size:9px;line-height:1.4}
td pre{max-height:100px;overflow:auto;margin:0;padding:7px 8px;border:1px solid rgba(126,177,200,.1);border-radius:6px;color:#a8d8dc;background:#071522;font:9px/1.4 ui-monospace,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
.condition-reference-footnote code{color:#a8d8dc;font:9px ui-monospace,Consolas,monospace}
@media(max-width:580px){.condition-reference-backdrop{padding:9px}.condition-reference{border-radius:12px}.condition-reference>header{padding:12px}.condition-reference-content{padding:9px 12px 12px}.condition-reference h2{font-size:18px}}
</style>
