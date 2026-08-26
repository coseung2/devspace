import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export const TASK_STATUSES = [
  "working",
  "input_required",
  "completed",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskRecord {
  taskId: string;
  callerKey: string;
  operation: string;
  workspaceId?: string;
  agentId?: string;
  processSessionId?: number;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  updatedAt: string;
  pollIntervalMs: number;
  ttlMs: number | null;
  inputRequests: string[];
  result?: unknown;
  error?: string;
  cancelRequested: boolean;
  approvalRequired: boolean;
}

export interface CreateTaskInput {
  taskId?: string;
  callerKey: string;
  operation: string;
  workspaceId?: string;
  agentId?: string;
  processSessionId?: number;
  pollIntervalMs?: number;
  ttlMs?: number | null;
  status?: TaskStatus;
  statusMessage?: string;
  approvalRequired?: boolean;
}

export interface TaskUpdateInput {
  status?: TaskStatus;
  statusMessage?: string;
  inputResponse?: string;
  result?: unknown;
  error?: string;
  processSessionId?: number;
  cancelRequested?: boolean;
}

export interface TaskStore {
  create(input: CreateTaskInput): TaskRecord;
  get(taskId: string, callerKey?: string): TaskRecord | undefined;
  update(taskId: string, callerKey: string, input: TaskUpdateInput): TaskRecord;
  requestCancel(taskId: string, callerKey: string): TaskRecord;
  list(callerKey: string, workspaceId?: string): TaskRecord[];
  listAll(): TaskRecord[];
}

const TERMINAL_STATUSES = new Set<TaskStatus>(["completed", "failed", "cancelled"]);

function now(): string {
  return new Date().toISOString();
}

function clone(record: TaskRecord): TaskRecord {
  return {
    ...record,
    inputRequests: [...record.inputRequests],
  };
}

function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (from === to) return;
  if (TERMINAL_STATUSES.has(from)) {
    throw new Error(`Task is already ${from}.`);
  }
  if (to === "working" || to === "input_required" || TERMINAL_STATUSES.has(to)) {
    return;
  }
  throw new Error(`Unsupported task transition: ${from} -> ${to}`);
}

function newTask(input: CreateTaskInput): TaskRecord {
  const timestamp = now();
  return {
    taskId: input.taskId ?? `task_${randomUUID()}`,
    callerKey: input.callerKey,
    operation: input.operation,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    processSessionId: input.processSessionId,
    status: input.status ?? "working",
    statusMessage: input.statusMessage,
    createdAt: timestamp,
    updatedAt: timestamp,
    pollIntervalMs: input.pollIntervalMs ?? 1_000,
    ttlMs: input.ttlMs ?? 24 * 60 * 60 * 1_000,
    inputRequests: [],
    cancelRequested: false,
    approvalRequired: input.approvalRequired ?? false,
  };
}

export class InMemoryTaskStore implements TaskStore {
  protected readonly records = new Map<string, TaskRecord>();

  create(input: CreateTaskInput): TaskRecord {
    const record = newTask(input);
    if (this.records.has(record.taskId)) throw new Error(`Task ${record.taskId} already exists.`);
    this.records.set(record.taskId, record);
    return clone(record);
  }

  get(taskId: string, callerKey?: string): TaskRecord | undefined {
    const record = this.records.get(taskId);
    if (!record || (callerKey !== undefined && record.callerKey !== callerKey)) return undefined;
    return clone(record);
  }

  update(taskId: string, callerKey: string, input: TaskUpdateInput): TaskRecord {
    const record = this.requireOwned(taskId, callerKey);
    if (TERMINAL_STATUSES.has(record.status)) throw new Error(`Task is already ${record.status}.`);
    if (input.status) assertTransition(record.status, input.status);
    if (input.status) record.status = input.status;
    if (input.statusMessage !== undefined) record.statusMessage = input.statusMessage;
    if (input.inputResponse !== undefined) record.inputRequests.push(input.inputResponse);
    if (input.result !== undefined) record.result = input.result;
    if (input.error !== undefined) record.error = input.error;
    if (input.processSessionId !== undefined) record.processSessionId = input.processSessionId;
    if (input.cancelRequested !== undefined) record.cancelRequested = input.cancelRequested;
    record.updatedAt = now();
    return clone(record);
  }

  requestCancel(taskId: string, callerKey: string): TaskRecord {
    const record = this.requireOwned(taskId, callerKey);
    if (!TERMINAL_STATUSES.has(record.status)) {
      record.cancelRequested = true;
      record.status = "cancelled";
      record.statusMessage = "Cancellation requested by caller.";
      record.updatedAt = now();
    }
    return clone(record);
  }

  list(callerKey: string, workspaceId?: string): TaskRecord[] {
    return [...this.records.values()]
      .filter((record) => record.callerKey === callerKey && (workspaceId === undefined || record.workspaceId === workspaceId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(clone);
  }

  listAll(): TaskRecord[] {
    return [...this.records.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(clone);
  }

  private requireOwned(taskId: string, callerKey: string): TaskRecord {
    const record = this.records.get(taskId);
    if (!record || record.callerKey !== callerKey) throw new Error(`Task ${taskId} not found.`);
    return record;
  }
}

interface TaskRow {
  task_id: string;
  caller_key: string;
  operation: string;
  workspace_id: string | null;
  agent_id: string | null;
  process_session_id: number | null;
  status: TaskStatus;
  status_message: string | null;
  created_at: string;
  updated_at: string;
  poll_interval_ms: number;
  ttl_ms: number | null;
  input_requests_json: string;
  result_json: string | null;
  error: string | null;
  cancel_requested: number;
  approval_required: number;
}

export class SqliteTaskStore implements TaskStore {
  constructor(private readonly sqlite: Database.Database) {
    sqlite.exec(`
      create table if not exists mcp_tasks (
        task_id text primary key,
        caller_key text not null,
        operation text not null,
        workspace_id text,
        agent_id text,
        process_session_id integer,
        status text not null,
        status_message text,
        created_at text not null,
        updated_at text not null,
        poll_interval_ms integer not null,
        ttl_ms integer,
        input_requests_json text not null,
        result_json text,
        error text,
        cancel_requested integer not null default 0,
        approval_required integer not null default 0
      );
      create index if not exists mcp_tasks_caller_updated_idx on mcp_tasks(caller_key, updated_at desc);
      create index if not exists mcp_tasks_workspace_updated_idx on mcp_tasks(workspace_id, updated_at desc);
    `);
    const columns = this.sqlite.prepare("pragma table_info(mcp_tasks)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "approval_required")) {
      this.sqlite.exec("alter table mcp_tasks add column approval_required integer not null default 0");
    }
  }

  create(input: CreateTaskInput): TaskRecord {
    const record = newTask(input);
    this.sqlite.prepare(`
      insert into mcp_tasks (
        task_id, caller_key, operation, workspace_id, agent_id, process_session_id,
        status, status_message, created_at, updated_at, poll_interval_ms, ttl_ms,
        input_requests_json, result_json, error, cancel_requested, approval_required
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.taskId,
      record.callerKey,
      record.operation,
      record.workspaceId ?? null,
      record.agentId ?? null,
      record.processSessionId ?? null,
      record.status,
      record.statusMessage ?? null,
      record.createdAt,
      record.updatedAt,
      record.pollIntervalMs,
      record.ttlMs,
      JSON.stringify(record.inputRequests),
      null,
      null,
      0,
      record.approvalRequired ? 1 : 0,
    );
    return clone(record);
  }

  get(taskId: string, callerKey?: string): TaskRecord | undefined {
    const row = this.sqlite.prepare("select * from mcp_tasks where task_id = ?").get(taskId) as TaskRow | undefined;
    if (!row || (callerKey !== undefined && row.caller_key !== callerKey)) return undefined;
    return fromRow(row);
  }

  update(taskId: string, callerKey: string, input: TaskUpdateInput): TaskRecord {
    const record = this.get(taskId, callerKey);
    if (!record) throw new Error(`Task ${taskId} not found.`);
    if (TERMINAL_STATUSES.has(record.status)) throw new Error(`Task is already ${record.status}.`);
    if (input.status) assertTransition(record.status, input.status);
    const updated = {
      ...record,
      status: input.status ?? record.status,
      statusMessage: input.statusMessage !== undefined ? input.statusMessage : record.statusMessage,
      inputRequests: input.inputResponse === undefined ? record.inputRequests : [...record.inputRequests, input.inputResponse],
      result: input.result !== undefined ? input.result : record.result,
      error: input.error !== undefined ? input.error : record.error,
      processSessionId: input.processSessionId !== undefined ? input.processSessionId : record.processSessionId,
      cancelRequested: input.cancelRequested ?? record.cancelRequested,
      updatedAt: now(),
    };
    this.write(updated);
    return clone(updated);
  }

  requestCancel(taskId: string, callerKey: string): TaskRecord {
    const record = this.get(taskId, callerKey);
    if (!record) throw new Error(`Task ${taskId} not found.`);
    if (TERMINAL_STATUSES.has(record.status)) return record;
    return this.update(taskId, callerKey, {
      status: "cancelled",
      statusMessage: "Cancellation requested by caller.",
      cancelRequested: true,
    });
  }

  list(callerKey: string, workspaceId?: string): TaskRecord[] {
    const rows = workspaceId === undefined
      ? this.sqlite.prepare("select * from mcp_tasks where caller_key = ? order by updated_at desc").all(callerKey) as TaskRow[]
      : this.sqlite.prepare("select * from mcp_tasks where caller_key = ? and workspace_id = ? order by updated_at desc").all(callerKey, workspaceId) as TaskRow[];
    return rows.map(fromRow);
  }

  listAll(): TaskRecord[] {
    return (this.sqlite.prepare("select * from mcp_tasks order by updated_at desc").all() as TaskRow[]).map(fromRow);
  }

  private write(record: TaskRecord): void {
    this.sqlite.prepare(`
      update mcp_tasks set
        status = ?, status_message = ?, process_session_id = ?, updated_at = ?,
        input_requests_json = ?, result_json = ?, error = ?, cancel_requested = ?
      where task_id = ? and caller_key = ?
    `).run(
      record.status,
      record.statusMessage ?? null,
      record.processSessionId ?? null,
      record.updatedAt,
      JSON.stringify(record.inputRequests),
      record.result === undefined ? null : JSON.stringify(record.result),
      record.error ?? null,
      record.cancelRequested ? 1 : 0,
      record.taskId,
      record.callerKey,
    );
  }
}

function fromRow(row: TaskRow): TaskRecord {
  return {
    taskId: row.task_id,
    callerKey: row.caller_key,
    operation: row.operation,
    workspaceId: row.workspace_id ?? undefined,
    agentId: row.agent_id ?? undefined,
    processSessionId: row.process_session_id ?? undefined,
    status: row.status,
    statusMessage: row.status_message ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pollIntervalMs: row.poll_interval_ms,
    ttlMs: row.ttl_ms,
    inputRequests: JSON.parse(row.input_requests_json) as string[],
    result: row.result_json === null ? undefined : JSON.parse(row.result_json) as unknown,
    error: row.error ?? undefined,
    cancelRequested: row.cancel_requested === 1,
    approvalRequired: row.approval_required === 1,
  };
}
