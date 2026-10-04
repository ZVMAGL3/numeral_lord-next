import { createRouter, createWebHistory } from "vue-router";
import App from "../App.vue";

declare module "vue-router" {
  interface RouteMeta {
    page?: "home" | "maps" | "workshop" | "rooms";
  }
}

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: "/",
      // 父级应用常驻，页面切换只替换子路由，避免联机状态被卸载。
      component: App,
      children: [
        { path: "", name: "home", component: () => import("../routes/HomeRoute.vue"), meta: { page: "home" } },
        { path: "rooms", name: "rooms", component: () => import("../routes/RoomsRoute.vue"), meta: { page: "rooms" } },
        { path: "maps", name: "maps", component: () => import("../routes/MapsRoute.vue"), meta: { page: "maps" } },
        { path: "maps/edit/:mapId", name: "map-editor", component: () => import("../routes/MapsRoute.vue"), meta: { page: "maps" } },
        { path: "workshop", name: "workshop", component: () => import("../routes/WorkshopRoute.vue"), meta: { page: "workshop" } }
      ]
    },
    { path: "/:pathMatch(.*)*", redirect: "/" }
  ]
});
