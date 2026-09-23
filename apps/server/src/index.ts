import { applyIntent, getLegalIntents } from "@numeral-lord/game-core/node";
import type {
  GameIntent,
  GameState,
  MatchConditionCatalog,
  TerrainCatalog,
  UnitCatalog
} from "@numeral-lord/game-core/node";
import { RelayRoom, Server, WebSocketTransport, type Client } from "colyseus";
import { pathToFileURL } from "node:url";

export { getLegalIntents };

/** Relay metadata used by the browser to keep player ownership deterministic. */
export class PvpRelayRoom extends RelayRoom {
  private hostSessionId: string | undefined;
  private readonly accounts = new Map<string, { accountId: string; playerId: string; displayName: string }>();

  override onCreate(options: {
    maxClients?: number;
    allowReconnectionTime?: number;
    metadata?: unknown;
  }): void {
    if (options.maxClients) this.maxClients = options.maxClients;
    if (options.allowReconnectionTime) {
      this.allowReconnectionTime = Math.min(options.allowReconnectionTime, 40);
    }
    if (options.metadata) this.setMetadata(options.metadata);

    // Only the two game transport messages are relayed. The server does not
    // interpret game rules, but it does bind a command to the sender's seat
    // and rejects snapshots from anyone other than the current host.
    this.onMessage("player-intent", (client, payload: Record<string, unknown> = {}) => {
      const account = this.accounts.get(client.sessionId);
      if (!account) return;
      this.broadcast("player-intent", { ...payload, playerId: account.playerId }, { except: client });
    });
    this.onMessage("host-snapshot", (client, payload: Record<string, unknown> = {}) => {
      if (client.sessionId !== this.hostSessionId) return;
      this.broadcast("host-snapshot", payload, { except: client });
    });
  }

  private broadcastMembers(): void {
    this.broadcast("room-members", {
      members: [...this.accounts.entries()].map(([sessionId, account]) => ({ sessionId, ...account }))
    });
  }

  override onJoin(client: Client, options: Record<string, unknown> = {}): void {
    super.onJoin(client, options);
    const seat = this.clients.findIndex((candidate) => candidate.sessionId === client.sessionId);
    const playerId = `player-${Math.max(1, seat + 1)}`;
    const requestedAccountId = typeof options.accountId === "string" ? options.accountId.trim() : "";
    const requestedName = typeof options.name === "string" ? options.name.trim() : "";
    const account = {
      accountId: requestedAccountId || `guest-${playerId}`,
      playerId,
      displayName: requestedName || `玩家 ${seat + 1}`
    };
    this.accounts.set(client.sessionId, account);
    if (!this.hostSessionId) this.hostSessionId = client.sessionId;

    client.send("room-role", {
      ...account,
      isHost: client.sessionId === this.hostSessionId
    });
    this.broadcast("room-host", { sessionId: this.hostSessionId });
    this.broadcastMembers();
  }

  override async onLeave(client: Client, code: number): Promise<void> {
    const wasHost = client.sessionId === this.hostSessionId;
    this.accounts.delete(client.sessionId);
    await super.onLeave(client, code);
    if (wasHost) {
      const nextHost = this.clients[0];
      this.hostSessionId = nextHost?.sessionId;
      if (nextHost) {
        this.broadcast("room-host", { sessionId: this.hostSessionId });
      }
    }
    this.broadcastMembers();
  }
}

/**
 * Optional headless entry point for a future authoritative deployment.
 * The current PvP room deliberately does not call it: the host executes
 * game-core locally and the relay only transports commands/snapshots.
 */
export function validateIntent(
  state: GameState,
  intent: GameIntent,
  commandId: string,
  catalogs: {
    readonly terrains: TerrainCatalog;
    readonly units: UnitCatalog;
    readonly matchConditions?: MatchConditionCatalog;
  }
) {
  return applyIntent(state, intent, commandId, catalogs.terrains, catalogs.units, catalogs.matchConditions);
}

/**
 * The first online slice deliberately keeps the backend thin:
 * - Colyseus owns room discovery, seats, reconnect windows and transport.
 * - RelayRoom broadcasts the host's authoritative snapshot/messages.
 * - The browser and the headless game-core remain responsible for rules.
 *
 * `validateIntent` stays exported for a later server-authoritative mode, but
 * it is not called by this relay room. A host conflict is resolved by the
 * host's snapshot, which is the contract for today's local-first PvP test.
 */
export function createGameServer(): Server {
  const gameServer = new Server({
    transport: new WebSocketTransport()
  });

  gameServer.define("pvp", PvpRelayRoom, {
    maxClients: 4,
    allowReconnectionTime: 30,
    metadata: {
      protocol: "host-authoritative-relay",
      version: "0.1.0"
    }
  });
  return gameServer;
}

export async function startServer(
  port = Number(process.env.PORT ?? 2567),
  host = process.env.HOST ?? "0.0.0.0"
): Promise<void> {
  const gameServer = createGameServer();
  await gameServer.listen(port, host);
  console.info(`Numeral Lord relay server listening on ${host}:${port}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startServer();
}
