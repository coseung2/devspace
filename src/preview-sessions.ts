import { randomBytes } from "node:crypto";
import http from "node:http";
import type { Request, Response } from "express";
import type { ProcessSessionManager } from "./process-sessions.js";

const PREVIEW_READY_TIMEOUT_MS = 15_000;
const PREVIEW_READY_POLL_MS = 100;

function previewAssetPrefix(urlPath: string): string {
  return urlPath.endsWith("/") ? urlPath : `${urlPath}/`;
}

function rewriteHtmlAssetUrls(html: string, urlPath: string): string {
  const prefix = previewAssetPrefix(urlPath);
  return html.replace(
    /((?:src|href|action|poster)\s*=\s*["'])\/(?!\/)/gi,
    `$1${prefix}`,
  );
}

export interface OpenPreviewInput {
  workspaceId: string;
  command: string;
  cwd: string;
  port: number;
  workspaceRoot: string;
  environment?: Record<string, string>;
}

export interface PreviewSession {
  id: string;
  workspaceId: string;
  port: number;
  processSessionId: number;
  urlPath: string;
  accessToken: string;
  startedAt: string;
}

export class PreviewSessionManager {
  private readonly sessions = new Map<string, PreviewSession>();

  constructor(private readonly processSessions: ProcessSessionManager) {}

  async open(input: OpenPreviewInput): Promise<PreviewSession> {
    const snapshot = await this.processSessions.start({
      workspaceId: input.workspaceId,
      command: input.command,
      cwd: input.cwd,
      workspaceRoot: input.workspaceRoot,
      yieldTimeMs: 1_000,
      environment: {
        HOST: "0.0.0.0",
        HOSTNAME: "0.0.0.0",
        VITE_HOST: "0.0.0.0",
        PORT: String(input.port),
        ...input.environment,
      },
    });

    if (!snapshot.running || snapshot.sessionId === undefined) {
      const output = snapshot.output.trim();
      throw new Error(
        `Preview server exited before it was ready${output ? `:\n${output}` : "."}`,
      );
    }

    try {
      await this.waitForReady(input.port);
    } catch (error) {
      try {
        this.processSessions.terminate(input.workspaceId, snapshot.sessionId);
      } catch {
        // The process may have exited while readiness was being checked.
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Preview server did not become ready on port ${input.port}: ${detail}`);
    }

    const id = `pv_${randomBytes(18).toString("base64url")}`;
    const session: PreviewSession = {
      id,
      workspaceId: input.workspaceId,
      port: input.port,
      processSessionId: snapshot.sessionId,
      urlPath: `/preview/${id}/`,
      accessToken: randomBytes(32).toString("base64url"),
      startedAt: new Date().toISOString(),
    };
    this.sessions.set(id, session);
    return session;
  }

  private async waitForReady(port: number): Promise<void> {
    const deadline = Date.now() + PREVIEW_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const reachable = await new Promise<boolean>((resolve) => {
        const request = http.get({ hostname: "127.0.0.1", port, path: "/", timeout: PREVIEW_READY_POLL_MS }, (response) => {
          response.resume();
          response.once("end", () => resolve(true));
        });
        request.once("error", () => resolve(false));
        request.once("timeout", () => {
          request.destroy();
          resolve(false);
        });
      });
      if (reachable) return;
      await new Promise((resolve) => setTimeout(resolve, PREVIEW_READY_POLL_MS));
    }
    throw new Error("Timed out waiting for the development server.");
  }

  get(id: string): PreviewSession | undefined {
    return this.sessions.get(id);
  }

  upgrade(request: http.IncomingMessage, socket: import("node:net").Socket, head: Buffer): void {
    const requestUrl = new URL(request.url ?? "/", "http://devspace.local");
    const match = requestUrl.pathname.match(/^\/preview\/([^/]+)(?:\/.*)?$/);
    const preview = match ? this.sessions.get(match[1]) : undefined;
    if (!preview) {
      socket.destroy();
      return;
    }

    const queryToken = requestUrl.searchParams.get("token");
    const cookieToken = String(request.headers.cookie ?? "")
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`devspace_preview_${preview.id}=`))
      ?.split("=")[1];
    if (queryToken !== preview.accessToken && cookieToken !== preview.accessToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    requestUrl.searchParams.delete("token");
    const suffix = requestUrl.pathname.replace(`/preview/${preview.id}`, "").replace(/^\//, "");
    const target = http.request({
      hostname: "127.0.0.1",
      port: preview.port,
      method: request.method,
      path: `/${suffix}${requestUrl.search}`,
      headers: { ...request.headers, host: `127.0.0.1:${preview.port}` },
    });
    target.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
      const responseHeaders = Object.entries(upstreamResponse.headers)
        .flatMap(([name, value]) => value === undefined ? [] : (Array.isArray(value) ? value.map((item) => `${name}: ${item}`) : [`${name}: ${value}`]));
      socket.write(`HTTP/1.1 ${upstreamResponse.statusCode ?? 101} ${upstreamResponse.statusMessage ?? "Switching Protocols"}\r\n${responseHeaders.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstreamSocket.write(head);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
    });
    target.on("response", (upstreamResponse) => {
      upstreamResponse.resume();
      socket.destroy();
    });
    target.on("error", () => socket.destroy());
    target.end();
  }

  close(id: string): PreviewSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Unknown preview session: ${id}`);
    this.processSessions.terminate(session.workspaceId, session.processSessionId);
    this.sessions.delete(id);
    return session;
  }

  closeAll(): void {
    for (const session of this.sessions.values()) {
      try {
        this.close(session.id);
      } catch {
        // The process session may already have exited and been cleaned up.
      }
    }
    this.sessions.clear();
  }

  proxy(request: Request, response: Response, session: PreviewSession, suffix: string): void {
    const requestUrl = new URL(request.originalUrl, "http://devspace.local");
    const queryToken = requestUrl.searchParams.get("token");
    const cookieToken = request.header("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`devspace_preview_${session.id}=`))
      ?.split("=")[1];
    if (queryToken !== session.accessToken && cookieToken !== session.accessToken) {
      response.status(401).json({ error: "Preview access token is missing or invalid." });
      return;
    }
    requestUrl.searchParams.delete("token");
    const query = requestUrl.search;
    const targetPath = `/${suffix.replace(/^\/+/, "")}${query}`;
    const headers = { ...request.headers, host: `127.0.0.1:${session.port}` };
    delete headers["content-length"];
    delete headers["accept-encoding"];

    const target = http.request(
      {
        hostname: "127.0.0.1",
        port: session.port,
        method: request.method,
        path: targetPath,
        headers,
      },
      (upstream) => {
        const contentType = String(upstream.headers["content-type"] ?? "").toLowerCase();
        const rewriteHtml = contentType.includes("text/html");
        response.status(upstream.statusCode ?? 502);
        for (const [name, value] of Object.entries(upstream.headers)) {
          if (value === undefined) continue;
          if (rewriteHtml && (name === "content-length" || name === "content-encoding")) continue;
          response.setHeader(name, value);
        }
        if (queryToken === session.accessToken) {
          response.setHeader(
            "set-cookie",
            `devspace_preview_${session.id}=${session.accessToken}; Path=/preview/${session.id}/; HttpOnly; SameSite=Strict`,
          );
        }
        if (!rewriteHtml) {
          upstream.pipe(response);
          return;
        }
        const chunks: Buffer[] = [];
        upstream.on("data", (chunk: Buffer) => chunks.push(chunk));
        upstream.on("end", () => {
          const html = Buffer.concat(chunks).toString("utf8");
          response.end(rewriteHtmlAssetUrls(html, session.urlPath));
        });
      },
    );

    target.on("error", (error) => {
      if (!response.headersSent) {
        response.status(502).json({ error: `Preview server is unavailable: ${error.message}` });
      } else {
        response.end();
      }
    });
    request.pipe(target);
  }
}
