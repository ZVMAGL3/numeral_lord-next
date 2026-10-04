<script setup lang="ts">
import { inject, proxyRefs } from "vue";
import HomeScreen from "../components/HomeScreen.vue";
import { appRuntimeKey } from "../app/app-runtime-key";

const runtime = inject(appRuntimeKey);
if (!runtime) throw new Error("主页未连接应用运行时");
const page = proxyRefs(runtime.home);
</script>

<template>
  <HomeScreen
    :name="page.playerName"
    @update:name="page.updatePlayerName"
    @start="page.startFromHome"
    @maps="page.openMapLibrary"
    @workshop="page.openWorkshop"
  />
</template>
