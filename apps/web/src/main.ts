import { createApp } from "vue";
import Root from "./Root.vue";
import "./style.css";
import { createPinia } from "pinia";
import { router } from "./router";

createApp(Root).use(createPinia()).use(router).mount("#app");
