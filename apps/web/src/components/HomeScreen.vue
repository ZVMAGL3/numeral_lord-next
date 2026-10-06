<script setup lang="ts">
const emit = defineEmits<{
  start: [];
  maps: [];
  workshop: [];
}>();
</script>

<template>
  <section class="home-screen" aria-label="游戏主页">
    <div class="menu-content">
      <div class="menu-grid">
        <button class="menu-card online-card" type="button" @click="emit('start')">
          <span class="card-top">01 / PLAY</span>
          <span class="card-art" aria-hidden="true">
            <svg viewBox="0 0 260 150" fill="none" role="presentation">
              <path d="M130 19 168 41v43l-38 22-38-22V41l38-22Z" />
              <path d="m52 69 28 16v32l-28 16-28-16V85l28-16Zm156 0 28 16v32l-28 16-28-16V85l28-16Z" />
              <path d="m92 76-28 15m104-15 28 15M130 106v27" />
              <circle cx="130" cy="62" r="13" /><circle cx="52" cy="101" r="9" /><circle cx="208" cy="101" r="9" />
            </svg>
          </span>
          <span class="card-bottom"><span><strong>联机大厅</strong><small>创建房间 · 加入对局</small></span><span class="card-enter" aria-hidden="true">→</span></span>
        </button>

        <button class="menu-card map-card" type="button" @click="emit('maps')">
          <span class="card-top">02 / MAPS</span>
          <span class="card-art" aria-hidden="true">
            <svg viewBox="0 0 260 150" fill="none" role="presentation">
              <path d="m78 20 34 20v39L78 99 44 79V40l34-20Zm68 0 34 20v39l-34 20-34-20V40l34-20Z" />
              <path d="m112 79 34 20v39l-34 20-34-20V99l34-20Zm68 0 34 20v39l-34 20-34-20V99l34-20Z" />
              <path d="m66 63 10-10 7 7 12-13m51 15 10-10 7 7 12-13m-64 78 12-13 10 9 12-15" />
            </svg>
          </span>
          <span class="card-bottom"><span><strong>地图配置</strong><small>导入地图码 · 管理地图</small></span><span class="card-enter" aria-hidden="true">→</span></span>
        </button>

        <button class="menu-card workshop-card" type="button" @click="emit('workshop')">
          <span class="card-top">03 / WORKSHOP</span>
          <span class="card-art" aria-hidden="true">
            <svg viewBox="0 0 260 150" fill="none" role="presentation">
              <path d="m130 14 39 22v45l-39 22-39-22V36l39-22Z" />
              <path d="m130 14 39 22-39 23-39-23m39 23v44" />
              <path d="m52 79 26 15v30l-26 15-26-15V94l26-15Zm156 0 26 15v30l-26 15-26-15V94l26-15Z" />
              <path d="m91 82-15 10m93-10 15 10M130 104v25" />
            </svg>
          </span>
          <span class="card-bottom"><span><strong>创意工坊</strong><small>地块 Mod · 地图作品</small></span><span class="card-enter" aria-hidden="true">→</span></span>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.home-screen { position: relative; display: flex; min-height: 0; align-items: center; overflow: visible; padding: clamp(18px,3vh,32px) 0; }
.menu-content { position: relative; z-index: 1; width: min(960px,100%); margin: 0 auto; transform: translateY(clamp(10px,1.8vh,20px)); }
.menu-grid { display: grid; height: clamp(210px,28vh,306px); grid-template-columns: repeat(3,minmax(0,1fr)); gap: clamp(10px,1.2vw,16px); }
.menu-card { --accent: #7fe4d8; position: relative; display: flex; min-width: 0; min-height: 0; flex-direction: column; justify-content: space-between; gap: 10px; margin: 0; padding: clamp(16px,1.6vw,24px); overflow: hidden; border: 1px solid rgba(129,172,194,.31); border-radius: clamp(16px,1.4vw,22px); background: linear-gradient(148deg,rgba(27,55,73,.9),rgba(14,32,48,.97)); color: #f4f9ff; text-align: left; transition: border-color .18s ease,transform .18s ease,box-shadow .18s ease,background .18s ease; }
.map-card { --accent: #afc5ee; background: linear-gradient(148deg,rgba(33,50,77,.91),rgba(17,31,50,.97)); }
.workshop-card { --accent: #f3c77e; background: linear-gradient(148deg,rgba(64,49,44,.9),rgba(27,31,43,.97)); }
.menu-card::before { position: absolute; inset: auto -12% -58% -12%; height: 90%; content: ""; border-radius: 50%; background: var(--accent); filter: blur(82px); opacity: .09; pointer-events: none; }
.menu-card:hover { transform: translateY(-4px); border-color: color-mix(in srgb,var(--accent) 76%,white); box-shadow: 0 18px 46px rgba(3,11,22,.35); }
.menu-card:focus-visible { outline: 3px solid var(--accent); outline-offset: 4px; }
.card-top,.card-bottom { position: relative; z-index: 1; display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 10px; width: 100%; }
.card-top { color: var(--accent); font: 800 10px/1.3 ui-monospace,Consolas,monospace; letter-spacing: .13em; }
.card-art { position: relative; z-index: 1; display: grid; min-width: 0; min-height: 0; flex: 1; place-items: center; color: var(--accent); }
.card-art svg { width: min(100%,190px); height: clamp(64px,10vh,110px); opacity: .9; filter: drop-shadow(0 0 22px rgba(110,222,217,.17)); stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.map-card .card-art svg { filter: drop-shadow(0 0 22px rgba(153,183,235,.18)); }
.workshop-card .card-art svg { filter: drop-shadow(0 0 22px rgba(243,199,126,.18)); }
.card-bottom { flex: none; align-items: end; border-top: 1px solid rgba(166,194,216,.2); padding-top: clamp(12px,2vh,20px); }
.card-bottom strong,.card-bottom small { display: block; }
.card-bottom strong { font-size: clamp(19px,1.6vw,26px); line-height: 1.2; }
.card-bottom small { margin-top: 5px; color: #a9bfce; font-size: clamp(10px,.9vw,12px); font-weight: 500; }
.card-enter { flex: none; color: var(--accent); font-size: clamp(23px,2vw,30px); font-weight: 300; line-height: 1; transition: transform .18s ease; }
.menu-card:hover .card-enter { transform: translateX(4px); }
@media (max-width:680px) and (orientation:portrait) {
  .home-screen { padding: 10px 0; }
  .menu-content { width: 100%; transform: translateY(clamp(6px,1vh,10px)); }
  .menu-grid { height: clamp(148px,18vh,164px); gap: clamp(5px,1.5vw,8px); }
  .menu-card { gap: 4px; padding: 10px clamp(5px,1.5vw,9px); border-radius: 14px; }
  .card-top { font-size: clamp(8px,1.9vw,9px); letter-spacing: .025em; }
  .card-art svg { width: min(82%,76px); height: clamp(42px,7vh,58px); }
  .card-bottom { align-items: center; gap: 5px; padding-top: 7px; }
  .card-bottom strong { font-size: clamp(12px,3.4vw,14px); white-space: nowrap; }
  .card-bottom small { display: none; }
  .card-enter { font-size: 18px; }
}
@media (orientation:landscape) and (min-width:520px) and (max-width:900px) and (max-height:850px) {
  .home-screen { padding-block: 8px; }
  .menu-content { transform: translateY(clamp(8px,1.5vh,14px)); }
  .menu-grid { height: clamp(146px,43vh,190px); gap: clamp(8px,1.2vw,15px); }
  .menu-card { gap: 5px; padding: clamp(9px,1.2vw,14px); border-radius: 14px; }
  .card-top { font-size: 9px; }
  .card-art svg { width: min(100%,150px); height: clamp(48px,14vh,68px); }
  .card-bottom { padding-top: 8px; }
  .card-bottom strong { font-size: clamp(13px,1.8vh,16px); }
  .card-bottom small { margin-top: 5px; font-size: 10px; }
  .card-enter { font-size: 24px; }
}
@media (orientation:landscape) and (min-width:520px) and (max-width:900px) and (max-height:480px) {
  .home-screen { padding-block: 4px; }
  .menu-content { transform: translateY(4px); }
  .menu-grid { height: clamp(126px,42vh,162px); gap: 7px; }
  .menu-card { gap: 3px; padding: 7px; border-radius: 11px; }
  .card-top { font-size: 8px; }
  .card-art svg { width: min(88%,88px); height: clamp(40px,14vh,54px); }
  .card-bottom { padding-top: 4px; }
  .card-bottom strong { font-size: 11px; }
  .card-bottom small { display: none; }
  .card-enter { font-size: 19px; }
}
@media (orientation:landscape) and (min-width:901px) and (max-height:620px) {
  .home-screen { padding-block: 4px; }
  .menu-content { transform: translateY(10px); }
  .menu-grid { height: clamp(140px,29vh,174px); gap: clamp(10px,1.2vw,15px); }
  .menu-card { gap: 5px; padding: 12px; }
  .card-art svg { width: min(100%,150px); height: clamp(44px,11vh,66px); }
  .card-bottom { padding-top: 7px; }
}
@media (max-width:360px) and (orientation:portrait) {
  .menu-grid { height: clamp(130px,24vh,146px); }
  .menu-card { padding: 7px 4px; }
  .card-top { font-size: 8px; }
  .card-art svg { width: min(80%,58px); height: clamp(38px,7vh,46px); }
  .card-bottom { gap: 2px; padding-top: 4px; }
  .card-bottom strong { font-size: 11px; }
  .card-enter { font-size: 15px; }
}
@media (prefers-reduced-motion:reduce) { .menu-card,.card-enter { transition: none; }.menu-card:hover,.menu-card:hover .card-enter { transform: none; } }
</style>
