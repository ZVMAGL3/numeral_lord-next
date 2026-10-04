import type { InjectionKey } from "vue";
import type { useAppRuntime } from "./app-runtime";

// 子路由从常驻应用壳读取共享会话，不重复建立连接或复制对局状态。
export const appRuntimeKey: InjectionKey<ReturnType<typeof useAppRuntime>> = Symbol("app-runtime");
