import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { PositionPayload } from "./protocol.js";

export interface NetworkResult { priors: number[]; value: number }

export function pythonExecutable(): string {
  if (process.env.HUNXIAO_PYTHON) return process.env.HUNXIAO_PYTHON;
  const relative = process.platform === "win32" ? "./.venv/Scripts/python.exe" : "./.venv/bin/python";
  const local = fileURLToPath(new URL(relative, import.meta.url));
  if (!existsSync(local)) throw new Error("训练环境未建立：按 README 配置 .venv，或设置 HUNXIAO_PYTHON。");
  return local;
}

interface Request {
  positions: PositionPayload[];
  resolve: (results: NetworkResult[]) => void;
  reject: (error: Error) => void;
}

export class InferenceService {
  private child: ChildProcessWithoutNullStreams;
  private waiting: Request[] = [];
  private pending = new Map<number, { requests: Request[]; timer: NodeJS.Timeout; started: number }>();
  private nextId = 0;
  private flushTimer: NodeJS.Timeout | undefined;
  private failure: Error | undefined;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private ready: Promise<void>;
  private readyTimer: NodeJS.Timeout;
  readonly stats = { calls: 0, positions: 0, maxBatch: 0, inferenceRoundtripMs: 0, device: "starting", torch: "" };

  constructor(checkpoint: string, fingerprint: string, device = "auto", private maxBatch = 32, private waitMs = 2) {
    this.ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    // A rejected startup is also observed when no job has reached its first leaf yet.
    void this.ready.catch(() => {});
    this.child = spawn(pythonExecutable(), ["-u", fileURLToPath(new URL("./python/serve.py", import.meta.url)),
      "--checkpoint", checkpoint, "--fingerprint", fingerprint, "--device", device], { stdio: "pipe", windowsHide: true });
    this.readyTimer = setTimeout(() => this.fail(new Error("网络服务启动超过 90 秒")), 90_000);
    let stderr = "";
    this.child.stderr.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-8000); });
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("exit", (code) => {
      if (code !== 0 || this.pending.size || this.waiting.length || this.stats.device === "starting") {
        this.fail(new Error(`网络服务退出 (${code})：${stderr}`));
      }
    });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line) as { ready?: boolean; device?: string; torch?: string; id?: number; error?: string; results?: NetworkResult[] };
        if (message.ready) {
          clearTimeout(this.readyTimer);
          this.stats.device = message.device ?? "unknown";
          this.stats.torch = message.torch ?? "";
          this.readyResolve();
          return;
        }
        const batch = this.pending.get(message.id ?? -1);
        if (!batch) throw new Error("网络服务返回未知请求 ID");
        clearTimeout(batch.timer);
        if (message.error) throw new Error(message.error);
        const expected = batch.requests.reduce((sum, request) => sum + request.positions.length, 0);
        if (!message.results || message.results.length !== expected) throw new Error("网络服务结果长度错误");
        const results = message.results;
        let offset = 0;
        for (const request of batch.requests) {
          const slice = results.slice(offset, offset + request.positions.length);
          for (let i = 0; i < slice.length; i += 1) {
            const result = slice[i]!;
            if (!Number.isFinite(result.value) || Math.abs(result.value) > 1.0001 || result.priors.length !== request.positions[i]!.candidates.length
              || result.priors.some((p) => !Number.isFinite(p) || p < 0)
              || Math.abs(result.priors.reduce((a, b) => a + b, 0) - 1) > 1e-4) {
              throw new Error("网络服务输出非有限数值或非法候选分布");
            }
          }
          request.resolve(slice);
          offset += slice.length;
        }
        this.stats.inferenceRoundtripMs += performance.now() - batch.started;
        this.pending.delete(message.id!);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async start(): Promise<void> { await this.ready; }

  async evaluate(positions: PositionPayload[]): Promise<NetworkResult[]> {
    await this.ready;
    if (this.failure) throw this.failure;
    if (!positions.length) return [];
    return new Promise<NetworkResult[]>((resolve, reject) => {
      this.waiting.push({ positions, resolve, reject });
      if (this.waiting.reduce((sum, item) => sum + item.positions.length, 0) >= this.maxBatch) this.flush();
      else if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), this.waitMs);
    });
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.waiting.length || this.failure) return;
    const requests: Request[] = [];
    let count = 0;
    while (this.waiting.length && (count < this.maxBatch || !requests.length)) {
      const next = this.waiting[0]!;
      if (requests.length && count + next.positions.length > this.maxBatch) break;
      requests.push(this.waiting.shift()!);
      count += next.positions.length;
    }
    const id = this.nextId++;
    const timer = setTimeout(() => this.fail(new Error(`网络推理请求 ${id} 超过 90 秒`)), 90_000);
    this.pending.set(id, { requests, timer, started: performance.now() });
    this.stats.calls += 1;
    this.stats.positions += count;
    this.stats.maxBatch = Math.max(this.stats.maxBatch, count);
    this.child.stdin.write(JSON.stringify({ id, positions: requests.flatMap((request) => request.positions) }) + "\n", (error) => {
      if (error) this.fail(error);
    });
    if (this.waiting.length) this.flushTimer = setTimeout(() => this.flush(), this.waitMs);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    clearTimeout(this.readyTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.readyReject(error);
    for (const request of this.waiting.splice(0)) request.reject(error);
    for (const batch of this.pending.values()) {
      clearTimeout(batch.timer);
      for (const request of batch.requests) request.reject(error);
    }
    this.pending.clear();
    this.child.kill();
  }

  close(): void {
    clearTimeout(this.readyTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.waiting.length || this.pending.size) this.fail(new Error("网络服务被关闭"));
    else this.child.stdin.end();
  }
}
