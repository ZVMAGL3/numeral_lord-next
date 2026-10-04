import { Client, type Room } from "@colyseus/sdk";
import type { TerrainModDefinition, TerrainModDefinitionAssetReferences, WorkshopTerrainModPreview } from "@numeral-lord/content-schema";
import type { MapSubmission, MapWorkshopEntry, TerrainModEntry, TerrainModSubmission } from "./types";

/** Server summaries omit the install flag, which is client-build-specific. */
export type WorkshopMapSummary = Omit<MapWorkshopEntry, "code"> & {
  readonly mapId: string;
  readonly requiredTerrainModIds: readonly string[];
};

export type WorkshopTerrainModSummary = Omit<TerrainModEntry, "installed" | "definition" | "preview" | "visualAssetUrls"> & {
  readonly modId: string;
};

export interface WorkshopCatalogPayload {
  readonly maps: readonly WorkshopMapSummary[];
  readonly terrainMods: readonly WorkshopTerrainModSummary[];
}

export type WorkshopDetailPayload =
  | { readonly kind: "map"; readonly entry: WorkshopMapSummary & { readonly code: string } }
  | { readonly kind: "terrain-mod"; readonly entry: WorkshopTerrainModSummary & { readonly definition?: TerrainModDefinition; readonly visualAssetUrls?: Readonly<Record<string, string>> } };

type WorkshopDetailWirePayload =
  | { readonly kind: "map"; readonly entry: WorkshopMapSummary & { readonly code: string } }
  | { readonly kind: "terrain-mod"; readonly entry: WorkshopTerrainModSummary & { readonly definition?: TerrainModDefinitionAssetReferences } };

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
  readonly preview: (payload: WorkshopTerrainModPreview) => void;
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

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("读取地块图片失败。"));
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("地块图片格式无效。"));
    reader.readAsDataURL(blob);
  });
}

/**
 * Optional workshop connection, separate from the PvP room. It transports
 * source files as inert text and never imports/evaluates published Mod code.
 */
export class WorkshopClient {
  private room: Room | undefined;
  private connecting: Promise<boolean> | undefined;
  private readonly pendingReadRequests = new Map<string, { readonly type: "workshop-get" | "workshop-preview"; readonly payload: unknown }>();
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
          void this.receiveDetail(payload as unknown as WorkshopDetailWirePayload, room, generation);
        });
        room.onMessage("workshop-preview", (payload: unknown) => {
          if (!this.isCurrent(room, generation)) return;
          if (!isRecord(payload) || typeof payload.id !== "string" || !isRecord(payload.preview)
            || typeof payload.preview.terrainId !== "string" || typeof payload.preview.displayName !== "string"
            || !Array.isArray(payload.preview.visualAssets)) {
            this.events.error("创意工坊返回了无效的地块预览。");
            return;
          }
          try {
            const preview = payload.preview as Record<string, unknown>;
            const assets = (preview.visualAssets as unknown[]).map((asset: unknown) => {
              if (!isRecord(asset) || typeof asset.id !== "string" || typeof asset.url !== "string") {
                throw new Error("创意工坊返回了无效的图片地址。");
              }
              return { id: asset.id, url: this.assetUrl(asset.url) };
            });
            this.events.preview({
              id: payload.id,
              preview: { ...preview, visualAssets: assets }
            } as unknown as WorkshopTerrainModPreview);
          } catch {
            this.events.error("创意工坊返回了无效的地块图片地址。");
          }
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
        for (const request of this.pendingReadRequests.values()) room.send(request.type, request.payload);
        this.pendingReadRequests.clear();
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

  requestTerrainModPreview(id: string): boolean {
    return this.send("workshop-preview", { id });
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
    this.pendingReadRequests.clear();
    this.setStatus("offline");
    if (room) {
      try { await room.leave(); } catch { /* Already disconnected. */ }
    }
  }

  private isCurrent(room: Room, generation: number): boolean {
    return this.room === room && this.generation === generation;
  }

  private async receiveDetail(payload: WorkshopDetailWirePayload, room: Room, generation: number): Promise<void> {
    try {
      if (payload.kind === "map") {
        if (this.isCurrent(room, generation)) this.events.detail(payload);
        return;
      }
      const definition = payload.entry.definition;
      if (!definition) {
        if (this.isCurrent(room, generation)) this.events.detail(payload as unknown as WorkshopDetailPayload);
        return;
      }
      const visualAssetUrls = Object.fromEntries((definition.visualAssets ?? []).map(({ id, url }) => [id, url]));
      const visualAssets = await Promise.all((definition.visualAssets ?? []).map(async ({ id, url }) => ({
        id,
        dataUrl: await this.downloadTerrainAsset(url)
      })));
      if (!this.isCurrent(room, generation)) return;
      this.events.detail({
        ...payload,
        entry: {
          ...payload.entry,
          visualAssetUrls,
          definition: {
            ...definition,
            ...(visualAssets.length ? { visualAssets } : {})
          } as TerrainModDefinition
        }
      } as WorkshopDetailPayload);
    } catch (error) {
      if (this.isCurrent(room, generation)) {
        this.events.error(error instanceof Error ? error.message : "地块图片暂时无法加载。");
      }
    }
  }

  private assetUrl(reference: string): string {
    if (!/^assets\/terrain\/[a-f0-9]{64}\.(?:png|webp|svg)$/.test(reference)) {
      throw new Error("地块图片地址无效。");
    }
    return new URL(reference, this.httpBaseUrl()).href;
  }

  async uploadTerrainAsset(dataUrl: string): Promise<string> {
    const match = /^data:(image\/(?:png|webp|svg\+xml));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
    if (!match) throw new Error("地块图片格式无效，无法上传。 ");
    const contentType = match[1]!;
    const binary = atob(match[2]!);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const response = await fetch(new URL("assets/terrain", this.httpBaseUrl()), {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: new Blob([bytes], { type: contentType })
    });
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message = isRecord(payload) && typeof payload.error === "string" ? payload.error : `地块图片上传失败（${response.status}）。`;
      throw new Error(message);
    }
    if (!isRecord(payload) || typeof payload.url !== "string") throw new Error("创意工坊没有返回图片地址。 ");
    this.assetUrl(payload.url);
    return payload.url;
  }

  async downloadTerrainAsset(reference: string): Promise<string> {
    const response = await fetch(this.assetUrl(reference), { cache: "force-cache" });
    if (!response.ok) throw new Error(`地块贴图下载失败（${response.status}）。`);
    return readBlobAsDataUrl(await response.blob());
  }

  private httpBaseUrl(): URL {
    const base = new URL(this.relayEndpoint, window.location.href);
    base.protocol = base.protocol === "wss:" ? "https:" : "http:";
    base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
    base.search = "";
    base.hash = "";
    return base;
  }

  private setStatus(status: WorkshopConnectionStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.events.status?.(status);
  }

  private send(type: string, payload?: unknown): boolean {
    if (!this.room) {
      if (this.connecting && (type === "workshop-get" || type === "workshop-preview")) {
        // Cards can request detail/artwork while the first connection is still
        // joining. Keep these read-only requests and flush them after the
        // catalog request instead of surfacing a transient offline error.
        this.pendingReadRequests.set(`${type}:${JSON.stringify(payload)}`, { type, payload });
        return true;
      }
      this.events.error("创意工坊尚未连接。");
      return false;
    }
    this.room.send(type, payload);
    return true;
  }
}
