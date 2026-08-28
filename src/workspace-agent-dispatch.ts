const WORKSPACE_AGENT_TRIGGER_TIMEOUT_MS = 15_000;

export interface AgentDispatchRequest {
  taskId: string;
  workspaceId: string;
  prompt: string;
}

export type AgentDispatcher = (request: AgentDispatchRequest) => Promise<void>;

export interface WorkspaceAgentDispatcherOptions {
  triggerUrl: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
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

  return async ({ prompt }) => {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ input: prompt }),
      redirect: "error",
      signal: AbortSignal.timeout(WORKSPACE_AGENT_TRIGGER_TIMEOUT_MS),
    });

    if (response.status === 202) return;

    const responseText = await response.text().catch(() => "");
    const safeMessage = responseText
      .replaceAll(accessToken, "[redacted]")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    throw new Error(
      `Workspace Agent trigger failed with HTTP ${response.status}${safeMessage ? `: ${safeMessage}` : ""}`,
    );
  };
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
