import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";

/** The app keeps its existing screen components, but navigation is URL-backed. */
export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: "/", component: App },
    { path: "/rooms", component: App },
    { path: "/maps", component: App },
    { path: "/workshop", component: App },
    { path: "/:pathMatch(.*)*", redirect: "/" }
  ]
});
