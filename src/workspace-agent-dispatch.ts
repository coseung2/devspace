import { randomUUID } from "node:crypto";

const WORKSPACE_AGENT_TRIGGER_TIMEOUT_MS = 15_000;
const DEFAULT_WORKSPACE_AGENT_RETRY_DELAYS_MS = [2_000, 5_000, 10_000] as const;

export interface AgentDispatchRequest {
  taskId: string;
  workspaceId: string;
  prompt: string;
}

export type AgentDispatcher = (request: AgentDispatchRequest) => Promise<void>;

export interface WorkspaceAgentRetryEvent {
  taskId: string;
  workspaceId: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  status?: number;
  error?: string;
}

export interface WorkspaceAgentDispatcherOptions {
  triggerUrl: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  retryDelaysMs?: readonly number[];
  sleepImpl?: (delayMs: number) => Promise<void>;
  onRetry?: (event: WorkspaceAgentRetryEvent) => void;
}

export function workspaceAgentDispatcherFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): AgentDispatcher | undefined {
  const triggerUrl = env.DEVSPACE_WORKSPACE_AGENT_TRIGGER_URL?.trim();
  const accessToken = env.DEVSPACE_WORKSPACE_AGENT_ACCESS_TOKEN?.trim();

  if (!triggerUrl && !accessToken) return undefined;
  if (!triggerUrl || !accessToken) {
    throw new Error(
      "DEVSPACE_WORKSPACE_AGENT_TRIGGER_URL and DEVSPACE_WORKSPACE_AGENT_ACCESS_TOKEN must be configured together.",
    );
  }

  return createWorkspaceAgentDispatcher({ triggerUrl, accessToken, fetchImpl });
}

export function createWorkspaceAgentDispatcher(
  options: WorkspaceAgentDispatcherOptions,
): AgentDispatcher {
  const endpoint = validateWorkspaceAgentTriggerUrl(options.triggerUrl);
  const accessToken = options.accessToken.trim();
  if (accessToken.length < 16) {
    throw new Error("DEVSPACE_WORKSPACE_AGENT_ACCESS_TOKEN is too short.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_WORKSPACE_AGENT_RETRY_DELAYS_MS;
  const sleepImpl = options.sleepImpl ?? sleep;
  const onRetry = options.onRetry ?? logWorkspaceAgentRetry;

  return async ({ taskId, workspaceId, prompt }) => {
    const idempotencyKey = randomUUID();
    const maxAttempts = retryDelaysMs.length + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({ input: prompt }),
          redirect: "error",
          signal: AbortSignal.timeout(WORKSPACE_AGENT_TRIGGER_TIMEOUT_MS),
        });
      } catch (error) {
        const safeError = safeErrorMessage(error, accessToken);
        const retryDelayMs = retryDelaysMs[attempt - 1];
        if (retryDelayMs !== undefined) {
          onRetry({
            taskId,
            workspaceId,
            attempt,
            maxAttempts,
            delayMs: retryDelayMs,
            error: safeError,
          });
          await sleepImpl(retryDelayMs);
          continue;
        }
        throw new Error(
          `Workspace Agent trigger request failed after ${attempt} attempt${attempt === 1 ? "" : "s"}: ${safeError}`,
        );
      }

      if (response.status === 202) return;

      const responseText = await response.text().catch(() => "");
      const safeMessage = redactAndCompact(responseText, accessToken);
      const retryDelayMs = retryDelaysMs[attempt - 1];
      if (retryDelayMs !== undefined && isRetryableWorkspaceAgentStatus(response.status)) {
        onRetry({
          taskId,
          workspaceId,
          attempt,
          maxAttempts,
          delayMs: retryDelayMs,
          status: response.status,
        });
        await sleepImpl(retryDelayMs);
        continue;
      }

      throw new Error(
        `Workspace Agent trigger failed with HTTP ${response.status} after ${attempt} attempt${attempt === 1 ? "" : "s"}${safeMessage ? `: ${safeMessage}` : ""}`,
      );
    }
  };
}

function isRetryableWorkspaceAgentStatus(status: number): boolean {
  return status === 409 || status === 429 || (status >= 500 && status <= 599);
}

function safeErrorMessage(error: unknown, accessToken: string): string {
  if (error instanceof Error) {
    return redactAndCompact(error.message || error.name, accessToken) || error.name;
  }
  return redactAndCompact(String(error), accessToken) || "unknown request error";
}

function redactAndCompact(value: string, accessToken: string): string {
  return value
    .replaceAll(accessToken, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function logWorkspaceAgentRetry(event: WorkspaceAgentRetryEvent): void {
  const reason = event.status ? `HTTP ${event.status}` : event.error ?? "request error";
  console.warn(
    `[devspace] Workspace Agent trigger task=${event.taskId} workspace=${event.workspaceId} attempt=${event.attempt}/${event.maxAttempts} failed (${reason}); retrying in ${event.delayMs}ms`,
  );
}

function validateWorkspaceAgentTriggerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DEVSPACE_WORKSPACE_AGENT_TRIGGER_URL must be a valid URL.");
  }

  if (url.protocol !== "https:" || url.hostname !== "api.chatgpt.com") {
    throw new Error(
      "DEVSPACE_WORKSPACE_AGENT_TRIGGER_URL must use https://api.chatgpt.com.",
    );
  }
  if (!/^\/v1\/workspace_agents\/[^/]+\/trigger$/.test(url.pathname)) {
    throw new Error(
      "DEVSPACE_WORKSPACE_AGENT_TRIGGER_URL must be a Workspace Agent trigger endpoint.",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "DEVSPACE_WORKSPACE_AGENT_TRIGGER_URL must not contain credentials, query parameters, or fragments.",
    );
  }

  return url.toString();
}
