<script setup lang="ts">
defineProps<{
  name: string;
}>();

const emit = defineEmits<{
  "update:name": [name: string];
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
        <label class="player-name">
          <span>玩家名字</span>
          <input
            :value="name"
            type="text"
            maxlength="24"
            autocomplete="nickname"
            placeholder="输入你的名字"
            aria-label="玩家名字"
            @input="emit('update:name', ($event.target as HTMLInputElement).value)"
            @keydown.enter.prevent="emit('start')"
          />
        </label>
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
.home-screen { position: relative; display: grid; align-items: center; min-height: min(680px, calc(100dvh - 150px)); overflow: hidden; padding: clamp(25px, 5vw, 66px); border: 1px solid rgba(119,152,184,.24); border-radius: 26px; background: radial-gradient(circle at 50% -15%, rgba(61,99,132,.18), transparent 49%), linear-gradient(150deg,#121e2d,#0d1724 70%); box-shadow: 0 25px 70px rgba(3,9,18,.28); }
.home-screen::before { position: absolute; inset: 0; content: ""; opacity: .22; background-image: linear-gradient(rgba(139,169,196,.16) 1px, transparent 1px), linear-gradient(90deg,rgba(139,169,196,.16) 1px,transparent 1px); background-size: 42px 42px; mask-image: linear-gradient(to bottom,transparent,#000 30%,#000 70%,transparent); pointer-events: none; }
.menu-content { position: relative; z-index: 1; width: min(970px,100%); margin: 0 auto; }
.menu-heading { display: flex; align-items: end; justify-content: space-between; gap: 22px; margin-bottom: clamp(22px,3.5vw,36px); }
.menu-eyebrow { color: #7db6ca; font: 800 10px/1.3 ui-monospace,Consolas,monospace; letter-spacing: .15em; }
.menu-heading h2 { margin: 8px 0 0; color: #f4f8ff; font-size: clamp(31px,4vw,43px); letter-spacing: -.04em; line-height: 1.15; }
.player-name { display: grid; width: min(252px,100%); gap: 7px; color: #aac0d0; font-size: 11px; font-weight: 750; }
.player-name input { width: 100%; height: 45px; padding: 0 13px; border: 1px solid rgba(135,176,202,.38); border-radius: 10px; outline: none; background: rgba(7,21,33,.8); color: #f5faff; font-size: 14px; }
.player-name input:focus-visible { border-color: #83e9d8; box-shadow: 0 0 0 3px rgba(131,233,216,.14); }
.menu-grid { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: clamp(13px,2vw,22px); }
.menu-card { --accent: #7fe4d8; position: relative; display: flex; min-width: 0; min-height: 315px; flex-direction: column; justify-content: space-between; margin: 0; padding: clamp(18px,2.5vw,28px); overflow: hidden; border: 1px solid rgba(129,172,194,.28); border-radius: 20px; background: linear-gradient(155deg,rgba(27,55,73,.88),rgba(14,32,48,.96)); color: #f4f9ff; text-align: left; transition: border-color .18s ease,transform .18s ease,box-shadow .18s ease; }
.map-card { --accent: #afc5ee; background: linear-gradient(155deg,rgba(33,50,77,.89),rgba(17,31,50,.96)); }
.workshop-card { --accent: #f3c77e; background: linear-gradient(155deg,rgba(64,49,44,.88),rgba(27,31,43,.96)); }
.menu-card::before { position: absolute; inset: auto -12% -58% -12%; height: 90%; content: ""; border-radius: 50%; background: var(--accent); filter: blur(82px); opacity: .08; pointer-events: none; }
.menu-card:hover { transform: translateY(-4px); border-color: var(--accent); box-shadow: 0 16px 40px rgba(3,11,22,.28); }
.menu-card:focus-visible { outline: 3px solid var(--accent); outline-offset: 4px; }
.card-top,.card-bottom { position: relative; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; }
.card-top { color: var(--accent); font: 800 10px/1.3 ui-monospace,Consolas,monospace; letter-spacing: .12em; }
.card-mark { display: grid; width: 30px; height: 30px; place-items: center; border: 1px solid rgba(183,209,231,.22); border-radius: 50%; color: #d9e8f3; font: 500 17px/1 system-ui,sans-serif; letter-spacing: 0; }
.card-art { position: relative; z-index: 1; display: grid; min-height: 167px; place-items: center; color: var(--accent); }
.card-art svg { width: min(100%,285px); height: 150px; opacity: .83; filter: drop-shadow(0 0 22px rgba(110,222,217,.16)); stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.map-card .card-art svg { filter: drop-shadow(0 0 22px rgba(153,183,235,.17)); }
.workshop-card .card-art svg { filter: drop-shadow(0 0 22px rgba(243,199,126,.17)); }
.card-bottom { align-items: end; border-top: 1px solid rgba(166,194,216,.17); padding-top: 18px; }
.card-bottom strong,.card-bottom small { display: block; }
.card-bottom strong { font-size: clamp(21px,2.4vw,28px); line-height: 1.2; }
.card-bottom small { margin-top: 7px; color: #9db5c8; font-size: 11px; font-weight: 500; }
.card-enter { color: var(--accent); font-size: 29px; font-weight: 300; line-height: 1; transition: transform .18s ease; }
.menu-card:hover .card-enter { transform: translateX(4px); }
@media (max-width:800px) { .menu-grid { grid-template-columns: repeat(2,minmax(0,1fr)); }.home-screen { min-height: 0; }.menu-heading { align-items: stretch; flex-direction: column; }.player-name { width: 100%; }.menu-card { min-height: 280px; }.card-art { min-height: 138px; }.card-art svg { height: 130px; } }
@media (max-width:560px) { .home-screen { padding: 21px 15px; border-radius: 20px; }.menu-grid { grid-template-columns: 1fr; }.menu-heading { gap: 17px; margin-bottom: 20px; }.menu-card { min-height: 207px; padding: 17px 19px; }.card-art { position: absolute; top: 32px; right: -30px; width: 52%; min-height: 0; opacity: .45; }.card-art svg { height: 126px; }.card-bottom { margin-top: 110px; }.card-bottom strong { font-size: 22px; } }
@media (orientation: landscape) and (min-width: 520px) and (max-height: 850px) {
  .home-screen { min-height: 0; padding: clamp(10px,2.5vh,22px) clamp(12px,2vw,26px); border-radius: 18px; }
  .menu-content { display: grid; width: min(1100px,100%); height: 100%; max-height: 100%; grid-template-rows: auto minmax(0,1fr); align-content: center; gap: clamp(6px,1.4vh,12px); }
  .menu-heading { align-items: center; justify-content: flex-end; gap: 0; margin: 0; }
  .menu-heading > div { display: none; }
  .player-name { width: min(270px,45%); gap: 5px; font-size: 10px; }
  .player-name input { height: clamp(34px,5.5vh,42px); font-size: 13px; }
  .menu-grid { width: 100%; height: clamp(165px,44dvh,320px); max-height: 100%; align-self: center; grid-template-columns: repeat(3,minmax(0,1fr)); gap: clamp(8px,1.5vw,16px); }
  .menu-card { min-height: 0; padding: clamp(10px,1.7vw,20px); border-radius: 15px; }
  .card-top,.card-bottom { gap: 8px; }
  .card-mark { width: 26px; height: 26px; }
  .card-art { position: relative; top: auto; right: auto; width: auto; min-height: 0; flex: 1; opacity: 1; }
  .card-art svg { height: min(17dvh,112px); max-height: 100%; }
  .card-bottom { margin-top: 0; padding-top: clamp(8px,1.5vh,14px); }
  .card-bottom strong { font-size: clamp(15px,2vw,24px); }
  .card-bottom small { margin-top: 4px; font-size: 10px; }
}
@media (orientation: landscape) and (min-width: 520px) and (max-height: 480px) {
  .menu-grid { height: clamp(156px,45dvh,220px); }
  .menu-card { padding: 9px 11px; }
  .card-art svg { height: min(14dvh,76px); }
  .card-bottom small { display: none; }
}
@media (orientation: landscape) and (min-width: 520px) and (max-width: 620px) and (max-height: 850px) {
  .menu-card { padding: 9px; }
  .card-art { display: none; }
  .card-bottom strong { font-size: 14px; }
  .card-enter { font-size: 22px; }
}
@media (prefers-reduced-motion:reduce) { .menu-card,.card-enter { transition: none; }.menu-card:hover,.menu-card:hover .card-enter { transform: none; } }
</style>
