<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

const isRevealed = ref(false);
const isTucking = ref(false);
const isFullscreen = ref(false);
const isSupported = ref(false);
const errorMessage = ref("");
let tuckTimer: number | undefined;

function syncFullscreenState(): void {
  isFullscreen.value = document.fullscreenElement !== null;
  isSupported.value = document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === "function";
}

function clearTuckTimer(): void {
  if (tuckTimer !== undefined) window.clearTimeout(tuckTimer);
  tuckTimer = undefined;
}

function showBriefly(): void {
  isTucking.value = false;
  isRevealed.value = true;
  clearTuckTimer();
  tuckTimer = window.setTimeout(() => {
    tuckTimer = undefined;
    isRevealed.value = false;
    isTucking.value = true;
  }, 3000);
}

function finishTuckTransition(event: TransitionEvent): void {
  if (event.propertyName !== "right" || !isTucking.value) return;
  isTucking.value = false;
  errorMessage.value = "";
}

function handleButtonClick(): void {
  if (!isRevealed.value && !isTucking.value) {
    errorMessage.value = "";
    showBriefly();
    return;
  }

  void toggleFullscreen();
}

async function toggleFullscreen(): Promise<void> {
  clearTuckTimer();
  isTucking.value = false;
  isRevealed.value = true;
  errorMessage.value = "";
  if (!isFullscreen.value && !isSupported.value) {
    errorMessage.value = "当前浏览器不支持全屏";
    showBriefly();
    return;
  }

  try {
    if (isFullscreen.value) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    errorMessage.value = "浏览器未允许切换全屏";
  }
  showBriefly();
  syncFullscreenState();
}

onMounted(() => {
  syncFullscreenState();
  document.addEventListener("fullscreenchange", syncFullscreenState);
});

onBeforeUnmount(() => {
  document.removeEventListener("fullscreenchange", syncFullscreenState);
  clearTuckTimer();
});
</script>

<template>
  <div class="fullscreen-ball" :class="{ revealed: isRevealed }" @transitionend.self="finishTuckTransition">
    <small v-if="errorMessage" class="fullscreen-ball-message" role="status">{{ errorMessage }}</small>
    <button
      class="fullscreen-ball-button"
      type="button"
      :aria-label="errorMessage || (!isRevealed ? '展开全屏控制' : isFullscreen ? '退出全屏' : '进入全屏')"
      :title="errorMessage || (!isRevealed ? '点击展开' : isFullscreen ? '点击退出全屏' : '点击进入全屏')"
      @click.stop="handleButtonClick"
    ><span aria-hidden="true">⛶</span></button>
  </div>
</template>

<style scoped>
.fullscreen-ball { position: fixed; z-index: 1201; right: calc(max(8px, env(safe-area-inset-right)) - 27px); bottom: max(20px, env(safe-area-inset-bottom)); width: 48px; height: 48px; transition: right .22s ease; }
.fullscreen-ball.revealed { right: max(14px, env(safe-area-inset-right)); }
.fullscreen-ball-button { display: grid; width: 48px; height: 48px; place-items: center; padding: 0; border: 1px solid rgba(110, 205, 195, .52); border-radius: 50%; color: #a9f2e7; background: linear-gradient(145deg, rgba(16, 48, 61, .97), rgba(8, 25, 39, .97)); box-shadow: 0 8px 28px rgba(0, 0, 0, .35), inset 0 1px rgba(255,255,255,.08); font-size: 18px; cursor: pointer; transition: background .16s ease, border-color .16s ease, transform .16s ease; }
.fullscreen-ball-button:hover, .fullscreen-ball-button:focus-visible { transform: scale(1.04); border-color: rgba(113, 231, 211, .85); background: #143749; outline: none; }
.fullscreen-ball:not(.revealed) .fullscreen-ball-button > span { transform: translateX(-10px); }
.fullscreen-ball-message { position: absolute; right: calc(100% + 8px); top: 50%; width: max-content; max-width: min(220px, 65vw); transform: translateY(-50%); padding: 7px 9px; border: 1px solid rgba(111, 165, 186, .35); border-radius: 8px; color: #dcecf5; background: #10283a; box-shadow: 0 6px 20px rgba(0,0,0,.32); font-size: 10px; }
@media (max-width: 360px) {
  .fullscreen-ball { right: calc(max(8px, env(safe-area-inset-right)) - 23px); }
}
</style>
