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
      <header class="menu-heading">
        <div>
          <span class="menu-eyebrow">NUMERAL LORD / MAIN MENU</span>
          <h2>选择入口</h2>
        </div>
      </header>

      <div class="menu-grid">
        <button class="menu-card online-card" type="button" @click="emit('start')">
          <span class="card-top"><span>01 / PLAY</span><span class="card-mark" aria-hidden="true">↗</span></span>
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
          <span class="card-top"><span>02 / MAPS</span><span class="card-mark" aria-hidden="true">↗</span></span>
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
          <span class="card-top"><span>03 / WORKSHOP</span><span class="card-mark" aria-hidden="true">↗</span></span>
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
.home-screen { position: relative; display: flex; min-height: 0; align-items: center; overflow: hidden; padding: clamp(14px,2.4vw,32px) 0; }
.menu-content { position: relative; z-index: 1; display: grid; width: min(1440px,100%); grid-template-rows: auto auto; align-content: center; gap: clamp(16px,3vh,28px); margin: 0 auto; }
.menu-heading { display: flex; align-items: end; justify-content: space-between; gap: 22px; margin: 0; }
.menu-eyebrow { color: #7db6ca; font: 800 10px/1.3 ui-monospace,Consolas,monospace; letter-spacing: .15em; }
.menu-heading h2 { margin: 7px 0 0; color: #f4f8ff; font-size: clamp(27px,3.1vw,38px); letter-spacing: -.04em; line-height: 1.15; }
.menu-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: clamp(10px,1.5vw,20px); }
.menu-card { --accent: #7fe4d8; position: relative; display: flex; min-width: 0; min-height: clamp(200px,31vh,330px); flex-direction: column; justify-content: space-between; gap: 8px; margin: 0; padding: clamp(14px,2vw,24px); overflow: hidden; border: 1px solid rgba(129,172,194,.28); border-radius: 18px; background: linear-gradient(145deg,rgba(27,55,73,.88),rgba(14,32,48,.96)); color: #f4f9ff; text-align: left; transition: border-color .18s ease,transform .18s ease,box-shadow .18s ease; }
.map-card { --accent: #afc5ee; background: linear-gradient(145deg,rgba(33,50,77,.89),rgba(17,31,50,.96)); }
.workshop-card { --accent: #f3c77e; background: linear-gradient(145deg,rgba(64,49,44,.88),rgba(27,31,43,.96)); }
.menu-card::before { position: absolute; inset: auto -12% -58% -12%; height: 90%; content: ""; border-radius: 50%; background: var(--accent); filter: blur(82px); opacity: .08; pointer-events: none; }
.menu-card:hover { transform: translateY(-3px); border-color: var(--accent); box-shadow: 0 16px 40px rgba(3,11,22,.28); }
.menu-card:focus-visible { outline: 3px solid var(--accent); outline-offset: 4px; }
.card-top,.card-bottom { position: relative; z-index: 1; display: flex; min-width: 0; align-items: center; justify-content: space-between; gap: 10px; width: 100%; }
.card-top { color: var(--accent); font: 800 10px/1.3 ui-monospace,Consolas,monospace; letter-spacing: .12em; }
.card-mark { display: grid; width: 28px; height: 28px; flex: none; place-items: center; border: 1px solid rgba(183,209,231,.22); border-radius: 50%; color: #d9e8f3; font: 500 16px/1 system-ui,sans-serif; letter-spacing: 0; }
.card-art { position: relative; z-index: 1; display: grid; min-width: 0; min-height: 0; flex: 1; place-items: center; color: var(--accent); }
.card-art svg { width: min(100%,190px); height: clamp(80px,14vh,130px); opacity: .88; filter: drop-shadow(0 0 18px rgba(110,222,217,.16)); stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.map-card .card-art svg { filter: drop-shadow(0 0 18px rgba(153,183,235,.17)); }
.workshop-card .card-art svg { filter: drop-shadow(0 0 18px rgba(243,199,126,.17)); }
.card-bottom { flex: none; align-items: end; border-top: 1px solid rgba(166,194,216,.17); padding-top: clamp(8px,1.5vh,15px); }
.card-bottom strong,.card-bottom small { display: block; }
.card-bottom strong { font-size: clamp(16px,1.8vw,23px); line-height: 1.2; }
.card-bottom small { margin-top: 6px; color: #9db5c8; font-size: 10px; font-weight: 500; }
.card-enter { flex: none; color: var(--accent); font-size: 26px; font-weight: 300; line-height: 1; transition: transform .18s ease; }
.menu-card:hover .card-enter { transform: translateX(3px); }
@media (max-width:680px) {
  .home-screen { padding: 8px 0; }
  .menu-content { width: 100%; gap: clamp(12px,2.5vh,22px); }
  .menu-heading { align-items: flex-start; }
  .menu-eyebrow { font-size: 8px; }
  .menu-heading h2 { margin-top: 4px; font-size: clamp(21px,5.5vw,29px); }
  .menu-grid { grid-template-columns: repeat(3,minmax(0,1fr)); gap: clamp(4px,1.5vw,8px); }
  .menu-card { min-height: clamp(108px,21dvh,178px); gap: 3px; padding: 8px clamp(4px,1.4vw,9px); border-radius: 12px; }
  .card-top { gap: 2px; font-size: clamp(6px,1.55vw,8px); letter-spacing: .025em; }
  .card-mark { width: 18px; height: 18px; font-size: 11px; }
  .card-art { width: 100%; flex: 1; }
  .card-art svg { width: min(72%,58px); height: clamp(30px,5.5vh,48px); max-height: 48px; }
  .card-bottom { flex: none; flex-direction: column; justify-content: center; gap: 0; padding: 4px 0 0; border-top: 1px solid rgba(166,194,216,.17); text-align: center; }
  .card-bottom strong { font-size: clamp(9px,2.7vw,12px); white-space: nowrap; }
  .card-bottom small,.card-enter { display: none; }
}
@media (orientation: landscape) and (min-width:520px) and (max-height:850px) {
  .home-screen { padding: 8px 0; }
  .menu-content { gap: clamp(8px,2vh,16px); }
  .menu-heading h2 { font-size: clamp(23px,3.3vh,32px); }
  .menu-grid { grid-template-columns: repeat(3,minmax(0,1fr)); gap: clamp(7px,1.2vw,14px); }
  .menu-card { min-height: clamp(150px,37vh,240px); gap: 4px; padding: clamp(9px,1.6vw,17px); border-radius: 14px; }
  .card-top { gap: 6px; font-size: 9px; }
  .card-mark { width: 24px; height: 24px; font-size: 14px; }
  .card-art { width: 100%; flex: 1; }
  .card-art svg { width: min(100%,110px); height: clamp(34px,9vh,68px); max-height: 68px; }
  .card-bottom { flex-direction: row; align-items: center; gap: 6px; padding-top: 7px; border-top: 1px solid rgba(166,194,216,.17); text-align: left; }
  .card-bottom strong { font-size: clamp(13px,1.8vw,18px); }
  .card-bottom small { margin-top: 4px; font-size: 9px; }
  .card-enter { font-size: 20px; }
}
@media (max-width:360px) and (orientation: portrait) {
  .menu-card { min-height: clamp(96px,19dvh,132px); }
  .card-top { font-size: 6px; }
  .card-mark { width: 15px; height: 15px; font-size: 9px; }
  .card-art svg { width: min(70%,44px); height: 30px; }
  .card-bottom strong { font-size: 9px; }
}
@media (prefers-reduced-motion:reduce) { .menu-card,.card-enter { transition: none; }.menu-card:hover,.menu-card:hover .card-enter { transform: none; } }
</style>
