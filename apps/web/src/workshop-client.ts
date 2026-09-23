import { Client, type Room } from "@colyseus/sdk";
import type { MapSubmission, MapWorkshopEntry, TerrainModEntry, TerrainModSubmission } from "./components/WorkshopPanel.vue";

/** Server summaries omit the install flag, which is client-build-specific. */
export type WorkshopMapSummary = Omit<MapWorkshopEntry, "code"> & {
  readonly mapId: string;
  readonly requiredTerrainModIds: readonly string[];
};

export type WorkshopTerrainModSummary = Omit<TerrainModEntry, "installed" | "sourceFiles"> & {
  readonly modId: string;
};

export interface WorkshopCatalogPayload {
  readonly maps: readonly WorkshopMapSummary[];
  readonly terrainMods: readonly WorkshopTerrainModSummary[];
}

export type WorkshopDetailPayload =
  | { readonly kind: "map"; readonly entry: WorkshopMapSummary & { readonly code: string } }
  | { readonly kind: "terrain-mod"; readonly entry: WorkshopTerrainModSummary & { readonly sourceFiles: NonNullable<TerrainModEntry["sourceFiles"]> } };

export interface WorkshopPublishedPayload {
  readonly kind: "map" | "terrain-mod";
  readonly id: string;
}

export interface WorkshopIdentity {
  readonly name: string;
}

export type WorkshopConnectionStatus = "offline" | "connecting" | "connected";

export interface WorkshopClientEvents {
  readonly catalog: (payload: WorkshopCatalogPayload) => void;
  readonly detail: (payload: WorkshopDetailPayload) => void;
  readonly published: (payload: WorkshopPublishedPayload) => void;
  readonly error: (message: string) => void;
  readonly status?: (status: WorkshopConnectionStatus) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function connectionFailureMessage(error: unknown): string {
  const detail = errorMessage(error);
  if (/provided room name.*not defined|^not found$/i.test(detail)) {
    return "当前联机服务器尚未启用创意工坊；可先浏览内置示例，社区作品需等待服务端更新。";
  }
  return `无法连接创意工坊：${detail}`;
}

/**
 * Optional workshop connection, separate from the PvP room. It transports
 * source files as inert text and never imports/evaluates published Mod code.
 */
export class WorkshopClient {
  private room: Room | undefined;
  private connecting: Promise<boolean> | undefined;
  private generation = 0;
  private currentStatus: WorkshopConnectionStatus = "offline";

  constructor(
    private readonly relayEndpoint: string,
    private readonly events: WorkshopClientEvents
  ) {}

  get status(): WorkshopConnectionStatus { return this.currentStatus; }
  get connected(): boolean { return this.room !== undefined; }

  async connect(identity: WorkshopIdentity): Promise<boolean> {
    if (this.room) return true;
    if (this.connecting) return this.connecting;
    const generation = ++this.generation;
    this.setStatus("connecting");
    const promise = (async () => {
      try {
        const room = await new Client(this.relayEndpoint).joinOrCreate("workshop", identity);
        if (generation !== this.generation) {
          void room.leave();
          return false;
        }
        this.room = room;
        room.onMessage("workshop-list", (payload: unknown) => {
          if (!this.isCurrent(room, generation)) return;
          if (!isRecord(payload) || !Array.isArray(payload.maps) || !Array.isArray(payload.terrainMods)) {
            this.events.error("创意工坊返回了无效的作品列表。");
            return;
          }
          this.events.catalog(payload as unknown as WorkshopCatalogPayload);
        });
        room.onMessage("workshop-detail", (payload: unknown) => {
          if (!this.isCurrent(room, generation)) return;
          if (!isRecord(payload) || (payload.kind !== "map" && payload.kind !== "terrain-mod") || !isRecord(payload.entry)) {
            this.events.error("创意工坊返回了无效的作品详情。");
            return;
          }
          this.events.detail(payload as unknown as WorkshopDetailPayload);
        });
        room.onMessage("workshop-published", (payload: unknown) => {
          if (!this.isCurrent(room, generation)) return;
          if (!isRecord(payload) || (payload.kind !== "map" && payload.kind !== "terrain-mod") || typeof payload.id !== "string") {
            this.events.error("创意工坊返回了无效的发布回执。");
            return;
          }
          this.events.published(payload as unknown as WorkshopPublishedPayload);
        });
        room.onMessage("workshop-error", (payload: unknown) => {
          if (!this.isCurrent(room, generation)) return;
          this.events.error(isRecord(payload) && typeof payload.message === "string" ? payload.message : "创意工坊操作失败。");
        });
        room.onLeave(() => {
          if (!this.isCurrent(room, generation)) return;
          this.room = undefined;
          this.setStatus("offline");
          this.events.error("创意工坊连接已断开。");
        });
        room.onError((code, message) => {
          if (!this.isCurrent(room, generation)) return;
          this.events.error(`创意工坊连接错误（${code}）：${message}`);
        });
        this.setStatus("connected");
        room.send("workshop-list");
        return true;
      } catch (error) {
        if (generation === this.generation) {
          this.setStatus("offline");
          this.events.error(connectionFailureMessage(error));
        }
        return false;
      } finally {
        if (generation === this.generation) this.connecting = undefined;
      }
    })();
    this.connecting = promise;
    return promise;
  }

  requestList(): boolean {
    return this.send("workshop-list");
  }

  requestDetail(kind: "map" | "terrain-mod", id: string): boolean {
    return this.send("workshop-get", { kind, id });
  }

  publishMap(entry: MapSubmission): boolean {
    return this.send("publish-map", entry);
  }

  publishTerrainMod(entry: TerrainModSubmission): boolean {
    return this.send("publish-terrain-mod", entry);
  }

  async leave(): Promise<void> {
    ++this.generation;
    const room = this.room;
    this.room = undefined;
    this.connecting = undefined;
    this.setStatus("offline");
    if (room) {
      try { await room.leave(); } catch { /* Already disconnected. */ }
    }
  }

  private isCurrent(room: Room, generation: number): boolean {
    return this.room === room && this.generation === generation;
  }

  private setStatus(status: WorkshopConnectionStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.events.status?.(status);
  }

  private send(type: string, payload?: unknown): boolean {
    if (!this.room) {
      this.events.error("创意工坊尚未连接。");
      return false;
    }
    this.room.send(type, payload);
    return true;
  }
}
