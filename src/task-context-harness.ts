import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const TASK_CONTEXT_DIRECTORY = "harness";
export const TASK_CONTEXT_INDEX_NAME = "index.json";

const MAX_INDEX_BYTES = 256 * 1024;
const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_SET_CONTENT_CHARACTERS = 64_000;
const MAX_INDEX_ENTRIES = 500;
const MAX_MATCHED_ENTRIES = 8;
const MAX_ENTRY_CHARACTERS = 8_000;
const MAX_TOTAL_CHARACTERS = 24_000;
const MAX_PATH_HINTS = 50;
const MAX_TRIGGER_VALUES = 64;
const MAX_ALWAYS_ENTRIES = 2;

export type TaskContextKind = "rule" | "decision" | "knowledge" | "procedure" | "note";
export type TaskContextScope = "global" | "project";

export interface TaskContextConfig {
  stateDir: string;
  workspaceAliases: Record<string, string>;
}

export interface TaskContextWorkspace {
  root: string;
  sourceRoot?: string;
}

export interface TaskContextWhen {
  always?: boolean;
  keywords?: string[];
  allKeywords?: string[];
  patterns?: string[];
  paths?: string[];
}

export interface SetTaskContextEntryInput {
  scope?: TaskContextScope;
  entry: {
    id: string;
    title: string;
    kind: TaskContextKind;
    priority?: number;
    when: TaskContextWhen;
    content: string;
  };
}

export interface TaskContextHarnessDescriptor {
  available: boolean;
  projectKey: string;
  scopes: TaskContextScope[];
  diagnostics: string[];
}

export interface TaskContextMatchedEntry {
  id: string;
  title: string;
  kind: TaskContextKind;
  scope: TaskContextScope;
  source: string;
  priority: number;
  truncated: boolean;
}

export interface PreparedTaskContext extends TaskContextHarnessDescriptor {
  matchedEntries: TaskContextMatchedEntry[];
  context: string;
  truncated: boolean;
}

export interface StoredTaskContextEntry {
  projectKey: string;
  scope: TaskContextScope;
  id: string;
  title: string;
  kind: TaskContextKind;
  source: string;
}

interface ParsedWhen {
  always: boolean;
  keywords: string[];
  allKeywords: string[];
  patterns: string[];
  paths: string[];
}

interface ParsedEntry {
  id: string;
  title: string;
  kind: TaskContextKind;
  path: string;
  priority: number;
  when: ParsedWhen;
  scope: TaskContextScope;
  scopeRoot: string;
  scopeLabel: string;
  order: number;
}

interface ScopeLocation {
  scope: TaskContextScope;
  root: string;
  label: string;
}

interface LoadedScope {
  location: ScopeLocation;
  entries: ParsedEntry[];
}

interface RawHarnessIndex {
  version: 1;
  entries: unknown[];
}

export async function inspectTaskContextHarness(
  config: TaskContextConfig,
  workspace: TaskContextWorkspace,
): Promise<TaskContextHarnessDescriptor> {
  const diagnostics: string[] = [];
  const projectKey = await taskContextProjectKey(config, workspace);
  const locations = scopeLocations(config.stateDir, projectKey);
  const scopes: TaskContextScope[] = [];

  for (const location of locations) {
    const loaded = await loadScope(location, config.stateDir, diagnostics);
    if (loaded) scopes.push(location.scope);
  }

  return {
    available: scopes.length > 0,
    projectKey,
    scopes,
    diagnostics,
  };
}

export async function prepareTaskContext(
  config: TaskContextConfig,
  workspace: TaskContextWorkspace,
  input: { task: string; paths?: string[] },
): Promise<PreparedTaskContext> {
  const diagnostics: string[] = [];
  const projectKey = await taskContextProjectKey(config, workspace);
  const locations = scopeLocations(config.stateDir, projectKey);
  const loadedScopes: LoadedScope[] = [];

  for (const location of locations) {
    const loaded = await loadScope(location, config.stateDir, diagnostics);
    if (loaded) loadedScopes.push(loaded);
  }

  const entriesById = new Map<string, ParsedEntry>();
  for (const loaded of loadedScopes) {
    for (const entry of loaded.entries) entriesById.set(entry.id, entry);
  }

  let alwaysEntries = 0;
  const taskText = normalizeText(input.task);
  const rawTask = input.task;
  const pathHints = normalizePathHints(input.paths, diagnostics);
  const candidates = [...entriesById.values()]
    .filter((entry) => {
      if (entry.when.always) {
        alwaysEntries += 1;
        if (alwaysEntries > MAX_ALWAYS_ENTRIES) {
          diagnostics.push(
            `An additional always task-context entry was ignored because at most ${MAX_ALWAYS_ENTRIES} are allowed.`,
          );
          return false;
        }
      }
      return entryMatches(entry, taskText, rawTask, pathHints, diagnostics);
    })
    .sort(compareEntries);

  const matchedEntries: TaskContextMatchedEntry[] = [];
  const contextSections: string[] = [];
  let totalCharacters = 0;
  let truncated = candidates.length > MAX_MATCHED_ENTRIES;

  for (const entry of candidates.slice(0, MAX_MATCHED_ENTRIES)) {
    const loaded = await loadEntryContent(entry, diagnostics);
    if (!loaded) continue;

    const remaining = MAX_TOTAL_CHARACTERS - totalCharacters;
    if (remaining <= 0) {
      truncated = true;
      break;
    }

    let content = loaded.content;
    let entryTruncated = loaded.truncated;
    if (content.length > remaining) {
      content = content.slice(0, remaining).trimEnd();
      entryTruncated = true;
      truncated = true;
    }

    const source = `${entry.scopeLabel}/${normalizeRelativePath(entry.path)}`;
    matchedEntries.push({
      id: entry.id,
      title: entry.title,
      kind: entry.kind,
      scope: entry.scope,
      source,
      priority: entry.priority,
      truncated: entryTruncated,
    });
    contextSections.push(formatEntryContext(entry, source, content, entryTruncated));
    totalCharacters += content.length;
  }

  return {
    available: loadedScopes.length > 0,
    projectKey,
    scopes: loadedScopes.map(({ location }) => location.scope),
    diagnostics,
    matchedEntries,
    context: formatSelectedContext(contextSections),
    truncated: truncated || matchedEntries.some((entry) => entry.truncated),
  };
}

export async function setTaskContextEntry(
  config: TaskContextConfig,
  workspace: TaskContextWorkspace,
  input: SetTaskContextEntryInput,
): Promise<StoredTaskContextEntry> {
  const scope = input.scope ?? "project";
  const projectKey = await taskContextProjectKey(config, workspace);
  const location = scopeLocations(config.stateDir, projectKey).find(
    (candidate) => candidate.scope === scope,
  );
  if (!location) throw new Error(`Unknown task-context scope: ${scope}`);

  const id = validateEntryId(input.entry.id);
  const title = requireBoundedString(input.entry.title, "title", 200);
  const kind = requireTaskContextKind(input.entry.kind);
  const priority = normalizePriority(input.entry.priority);
  const when = parseWhen(input.entry.when);
  if (!when || !hasTrigger(when)) {
    throw new Error("A task-context entry requires at least one positive trigger.");
  }
  const content = input.entry.content.trim();
  if (!content) throw new Error("Task-context entry content must not be empty.");
  if (content.length > MAX_SET_CONTENT_CHARACTERS) {
    throw new Error(
      `Task-context entry content exceeds ${MAX_SET_CONTENT_CHARACTERS} characters.`,
    );
  }

  const resolved = await ensureWritableScope(location, config.stateDir);
  const rawIndex = await loadWritableIndex(resolved.indexPath);
  const entryPath = `entries/${id}.md`;
  const nextEntry = {
    id,
    title,
    kind,
    path: entryPath,
    priority,
    when: serializeWhen(when),
  };
  const nextEntries = rawIndex.entries.filter(
    (candidate) => !isRecord(candidate) || candidate.id !== id,
  );
  nextEntries.push(nextEntry);

  const alwaysEntries = nextEntries.filter(
    (candidate) => isRecord(candidate) && isRecord(candidate.when) && candidate.when.always === true,
  ).length;
  if (alwaysEntries > MAX_ALWAYS_ENTRIES) {
    throw new Error(`At most ${MAX_ALWAYS_ENTRIES} always task-context entries are allowed per scope.`);
  }

  const entryAbsolutePath = resolve(resolved.scopeRoot, entryPath);
  if (!isPathInsideRoot(entryAbsolutePath, resolved.scopeRoot)) {
    throw new Error("Task-context entry path escaped its scope.");
  }

  await writeAtomic(entryAbsolutePath, `${content}\n`);
  await writeAtomic(
    resolved.indexPath,
    `${JSON.stringify({ version: 1, entries: nextEntries }, null, 2)}\n`,
  );

  return {
    projectKey,
    scope,
    id,
    title,
    kind,
    source: `${location.label}/${entryPath}`,
  };
}

export async function taskContextProjectKey(
  config: TaskContextConfig,
  workspace: TaskContextWorkspace,
): Promise<string> {
  const projectRoot = workspace.sourceRoot ?? workspace.root;
  const canonicalProjectRoot = await canonicalPath(projectRoot);

  for (const [alias, aliasPath] of Object.entries(config.workspaceAliases)) {
    if ((await canonicalPath(aliasPath)) === canonicalProjectRoot) {
      return safeProjectKey(alias);
    }
  }

  const digest = createHash("sha256").update(canonicalProjectRoot).digest("hex").slice(0, 16);
  return `path-${digest}`;
}

function scopeLocations(stateDir: string, projectKey: string): ScopeLocation[] {
  const harnessRoot = resolve(stateDir, TASK_CONTEXT_DIRECTORY);
  return [
    {
      scope: "global",
      root: join(harnessRoot, "global"),
      label: "global",
    },
    {
      scope: "project",
      root: join(harnessRoot, "projects", projectKey),
      label: `project:${projectKey}`,
    },
  ];
}

async function loadScope(
  location: ScopeLocation,
  stateDir: string,
  diagnostics: string[],
): Promise<LoadedScope | undefined> {
  const indexCandidate = join(location.root, TASK_CONTEXT_INDEX_NAME);
  const indexRealPath = await tryRealpath(indexCandidate);
  if (!indexRealPath) return undefined;

  const stateRealPath = await canonicalPath(stateDir);
  const harnessCandidate = resolve(stateDir, TASK_CONTEXT_DIRECTORY);
  const harnessRealPath = await tryRealpath(harnessCandidate);
  if (!harnessRealPath || !isPathInsideRoot(harnessRealPath, stateRealPath)) {
    diagnostics.push("The task-context harness root resolves outside the DevSpace state directory.");
    return undefined;
  }

  const scopeRealPath = await tryRealpath(location.root);
  if (!scopeRealPath || !isPathInsideRoot(scopeRealPath, harnessRealPath)) {
    diagnostics.push(`${location.label} task-context scope resolves outside the harness root.`);
    return undefined;
  }
  if (!isPathInsideRoot(indexRealPath, scopeRealPath)) {
    diagnostics.push(`${location.label}/${TASK_CONTEXT_INDEX_NAME} resolves outside its scope.`);
    return undefined;
  }

  try {
    const indexStats = await stat(indexRealPath);
    if (!indexStats.isFile()) {
      diagnostics.push(`${location.label}/${TASK_CONTEXT_INDEX_NAME} is not a file.`);
      return undefined;
    }
    if (indexStats.size > MAX_INDEX_BYTES) {
      diagnostics.push(
        `${location.label}/${TASK_CONTEXT_INDEX_NAME} exceeds ${MAX_INDEX_BYTES} bytes and was ignored.`,
      );
      return undefined;
    }

    const parsed = JSON.parse(await readFile(indexRealPath, "utf8")) as unknown;
    return {
      location: { ...location, root: scopeRealPath },
      entries: parseIndex(parsed, { ...location, root: scopeRealPath }, diagnostics),
    };
  } catch (error) {
    diagnostics.push(
      `Unable to read ${location.label}/${TASK_CONTEXT_INDEX_NAME}: ${errorMessage(error)}`,
    );
    return undefined;
  }
}

function parseIndex(
  value: unknown,
  location: ScopeLocation,
  diagnostics: string[],
): ParsedEntry[] {
  if (!isRecord(value)) {
    diagnostics.push(`${location.label}/${TASK_CONTEXT_INDEX_NAME} must contain a JSON object.`);
    return [];
  }
  if (value.version !== 1) {
    diagnostics.push(
      `${location.label}/${TASK_CONTEXT_INDEX_NAME} has unsupported version ${String(value.version)}.`,
    );
    return [];
  }
  if (!Array.isArray(value.entries)) {
    diagnostics.push(`${location.label}/${TASK_CONTEXT_INDEX_NAME} must contain an entries array.`);
    return [];
  }

  const parsed: ParsedEntry[] = [];
  const ids = new Set<string>();
  for (const [index, candidate] of value.entries.slice(0, MAX_INDEX_ENTRIES).entries()) {
    const entry = parseEntry(candidate, index, location, diagnostics);
    if (!entry) continue;
    if (ids.has(entry.id)) {
      diagnostics.push(
        `${location.label} task-context index contains a duplicate entry id; the later copy was ignored.`,
      );
      continue;
    }
    ids.add(entry.id);
    parsed.push(entry);
  }
  if (value.entries.length > MAX_INDEX_ENTRIES) {
    diagnostics.push(
      `${location.label}/${TASK_CONTEXT_INDEX_NAME} contains more than ${MAX_INDEX_ENTRIES} entries; the remainder were ignored.`,
    );
  }
  return parsed;
}

function parseEntry(
  value: unknown,
  order: number,
  location: ScopeLocation,
  diagnostics: string[],
): ParsedEntry | undefined {
  if (!isRecord(value)) {
    diagnostics.push(`${location.label} task-context index contains a non-object entry.`);
    return undefined;
  }

  const id = optionalBoundedString(value.id, 128);
  const path = optionalBoundedString(value.path, 512);
  if (!id || !path) {
    diagnostics.push(`${location.label} task-context index contains an entry without valid id and path fields.`);
    return undefined;
  }
  if (!ENTRY_ID_PATTERN.test(id)) {
    diagnostics.push(`${location.label} task-context index contains an entry with an invalid id.`);
    return undefined;
  }
  if (!isSafeRelativePath(path)) {
    diagnostics.push(`${location.label} task-context index contains an entry with an unsafe path.`);
    return undefined;
  }

  const title = optionalBoundedString(value.title, 200) ?? id;
  const kind = isTaskContextKind(value.kind) ? value.kind : "note";
  const priority = normalizePriority(value.priority);
  const when = parseWhen(value.when);
  if (!when || !hasTrigger(when)) {
    diagnostics.push(`${location.label} task-context index contains an entry without a valid positive trigger.`);
    return undefined;
  }

  return {
    id,
    title,
    kind,
    path,
    priority,
    when,
    scope: location.scope,
    scopeRoot: location.root,
    scopeLabel: location.label,
    order,
  };
}

function parseWhen(value: unknown): ParsedWhen | undefined {
  if (!isRecord(value)) return undefined;
  return {
    always: value.always === true,
    keywords: stringArray(value.keywords, 128),
    allKeywords: stringArray(value.allKeywords, 128),
    patterns: stringArray(value.patterns, 512),
    paths: stringArray(value.paths, 512),
  };
}

function serializeWhen(when: ParsedWhen): TaskContextWhen {
  return {
    ...(when.always ? { always: true } : {}),
    ...(when.keywords.length > 0 ? { keywords: when.keywords } : {}),
    ...(when.allKeywords.length > 0 ? { allKeywords: when.allKeywords } : {}),
    ...(when.patterns.length > 0 ? { patterns: when.patterns } : {}),
    ...(when.paths.length > 0 ? { paths: when.paths } : {}),
  };
}

function hasTrigger(when: ParsedWhen): boolean {
  return when.always
    || when.keywords.length > 0
    || when.allKeywords.length > 0
    || when.patterns.length > 0
    || when.paths.length > 0;
}

function entryMatches(
  entry: ParsedEntry,
  taskText: string,
  rawTask: string,
  paths: string[],
  diagnostics: string[],
): boolean {
  const { when } = entry;
  if (when.always) return true;
  if (when.keywords.some((keyword) => taskText.includes(normalizeText(keyword)))) return true;
  if (
    when.allKeywords.length > 0
    && when.allKeywords.every((keyword) => taskText.includes(normalizeText(keyword)))
  ) {
    return true;
  }

  for (const pattern of when.patterns) {
    try {
      if (new RegExp(pattern, "i").test(rawTask)) return true;
    } catch (error) {
      diagnostics.push(`${entry.scopeLabel} task-context index contains an invalid pattern: ${errorMessage(error)}`);
    }
  }

  for (const pattern of when.paths) {
    try {
      const matcher = globToRegExp(normalizeRelativePath(pattern));
      if (paths.some((path) => matcher.test(path))) return true;
    } catch (error) {
      diagnostics.push(`${entry.scopeLabel} task-context index contains an invalid path pattern: ${errorMessage(error)}`);
    }
  }

  return false;
}

async function loadEntryContent(
  entry: ParsedEntry,
  diagnostics: string[],
): Promise<{ content: string; truncated: boolean } | undefined> {
  const candidate = resolve(entry.scopeRoot, entry.path);
  if (!isPathInsideRoot(candidate, entry.scopeRoot)) {
    diagnostics.push(`${entry.scopeLabel} entry ${entry.id} escaped its scope.`);
    return undefined;
  }

  const realPath = await tryRealpath(candidate);
  if (!realPath) {
    diagnostics.push(`${entry.scopeLabel} entry ${entry.id} points to a missing file.`);
    return undefined;
  }
  if (!isPathInsideRoot(realPath, entry.scopeRoot)) {
    diagnostics.push(`${entry.scopeLabel} entry ${entry.id} resolves outside its scope.`);
    return undefined;
  }

  try {
    const sourceStats = await stat(realPath);
    if (!sourceStats.isFile()) {
      diagnostics.push(`${entry.scopeLabel} entry ${entry.id} does not point to a file.`);
      return undefined;
    }
    if (sourceStats.size > MAX_SOURCE_BYTES) {
      diagnostics.push(
        `${entry.scopeLabel} entry ${entry.id} exceeds ${MAX_SOURCE_BYTES} bytes and was ignored.`,
      );
      return undefined;
    }

    const raw = (await readFile(realPath, "utf8")).trim();
    if (!raw) return { content: "", truncated: false };
    if (raw.length <= MAX_ENTRY_CHARACTERS) return { content: raw, truncated: false };
    return {
      content: raw.slice(0, MAX_ENTRY_CHARACTERS).trimEnd(),
      truncated: true,
    };
  } catch (error) {
    diagnostics.push(
      `Unable to read ${entry.scopeLabel} entry ${entry.id}: ${errorMessage(error)}`,
    );
    return undefined;
  }
}

function compareEntries(left: ParsedEntry, right: ParsedEntry): number {
  if (left.priority !== right.priority) return right.priority - left.priority;
  if (left.scope !== right.scope) return left.scope === "project" ? -1 : 1;
  return left.order - right.order || left.id.localeCompare(right.id);
}

function formatEntryContext(
  entry: ParsedEntry,
  source: string,
  content: string,
  truncated: boolean,
): string {
  return [
    `## ${entry.title}`,
    `Kind: ${entry.kind}`,
    `Source: ${source}`,
    "",
    content,
    ...(truncated ? ["", "[Entry truncated by DevSpace.]"] : []),
  ].join("\n");
}

function formatSelectedContext(sections: string[]): string {
  if (sections.length === 0) return "";
  return [
    "[DevSpace selected task context]",
    "Repository instructions and the current user request remain authoritative. Apply only the matched context below. Do not infer, enumerate, or retrieve unmatched harness entries.",
    "",
    ...sections,
  ].join("\n\n");
}

async function ensureWritableScope(
  location: ScopeLocation,
  stateDir: string,
): Promise<{ scopeRoot: string; indexPath: string }> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const stateRealPath = await realpath(stateDir);

  const harnessRoot = resolve(stateDir, TASK_CONTEXT_DIRECTORY);
  await mkdir(harnessRoot, { recursive: true, mode: 0o700 });
  const harnessRealPath = await realpath(harnessRoot);
  if (!isPathInsideRoot(harnessRealPath, stateRealPath)) {
    throw new Error("Task-context harness root resolves outside the DevSpace state directory.");
  }

  await mkdir(location.root, { recursive: true, mode: 0o700 });
  const scopeRoot = await realpath(location.root);
  if (!isPathInsideRoot(scopeRoot, harnessRealPath)) {
    throw new Error("Task-context scope resolves outside the harness root.");
  }

  const entriesRoot = join(scopeRoot, "entries");
  await mkdir(entriesRoot, { recursive: true, mode: 0o700 });
  const entriesRealPath = await realpath(entriesRoot);
  if (!isPathInsideRoot(entriesRealPath, scopeRoot)) {
    throw new Error("Task-context entries directory resolves outside its scope.");
  }

  return {
    scopeRoot,
    indexPath: join(scopeRoot, TASK_CONTEXT_INDEX_NAME),
  };
}

async function loadWritableIndex(indexPath: string): Promise<RawHarnessIndex> {
  const existing = await tryRealpath(indexPath);
  if (!existing) return { version: 1, entries: [] };

  const indexStats = await stat(existing);
  if (!indexStats.isFile()) throw new Error("Task-context index is not a file.");
  if (indexStats.size > MAX_INDEX_BYTES) {
    throw new Error(`Task-context index exceeds ${MAX_INDEX_BYTES} bytes.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(existing, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to parse task-context index: ${errorMessage(error)}`);
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error("Task-context index must have version 1 and an entries array.");
  }
  return { version: 1, entries: parsed.entries };
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    if (!isErrnoException(error) || !["EEXIST", "EPERM"].includes(error.code ?? "")) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    await rm(path, { force: true });
    await rename(temporaryPath, path);
  }
  await chmod(path, 0o600);
}

function normalizePathHints(paths: string[] | undefined, diagnostics: string[]): string[] {
  if (!paths) return [];
  if (paths.length > MAX_PATH_HINTS) {
    diagnostics.push(`Only the first ${MAX_PATH_HINTS} path hints were considered.`);
  }
  return paths
    .slice(0, MAX_PATH_HINTS)
    .map((path) => normalizeRelativePath(path))
    .filter(Boolean);
}

function normalizeText(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeRelativePath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
}

function globToRegExp(glob: string): RegExp {
  let expression = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          expression += "(?:.*/)?";
        } else {
          expression += ".*";
        }
      } else {
        expression += "[^/]*";
      }
      continue;
    }
    if (character === "?") {
      expression += "[^/]";
      continue;
    }
    expression += escapeRegExp(character ?? "");
  }
  return new RegExp(`${expression}$`, "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isSafeRelativePath(value: string): boolean {
  const normalized = normalizeRelativePath(value);
  if (!normalized || isAbsolute(normalized) || /^[A-Za-z]:\//.test(normalized)) return false;
  const segments = normalized.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isPathInsideRoot(path: string, root: string): boolean {
  const relationship = relative(resolve(root), resolve(path));
  return relationship === ""
    || (!isAbsolute(relationship)
      && relationship !== ".."
      && !relationship.startsWith(`..${sep}`));
}

async function canonicalPath(path: string): Promise<string> {
  return (await tryRealpath(path)) ?? resolve(path);
}

async function tryRealpath(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch (error) {
    if (isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return undefined;
    }
    throw error;
  }
}

const ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function validateEntryId(value: string): string {
  const id = requireBoundedString(value, "id", 128);
  if (!ENTRY_ID_PATTERN.test(id)) {
    throw new Error("Task-context entry id must use letters, numbers, dot, underscore, or hyphen.");
  }
  return id;
}

function safeProjectKey(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 128);
  return normalized || `path-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function requireTaskContextKind(value: unknown): TaskContextKind {
  if (!isTaskContextKind(value)) throw new Error(`Invalid task-context kind: ${String(value)}`);
  return value;
}

function isTaskContextKind(value: unknown): value is TaskContextKind {
  return value === "rule"
    || value === "decision"
    || value === "knowledge"
    || value === "procedure"
    || value === "note";
}

function normalizePriority(value: unknown): number {
  return Number.isInteger(value)
    ? Math.max(-1_000, Math.min(1_000, Number(value)))
    : 0;
}

function stringArray(value: unknown, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .slice(0, MAX_TRIGGER_VALUES)
      .map((entry) => optionalBoundedString(entry, maxLength))
      .filter((entry): entry is string => Boolean(entry)),
  )];
}

function requireBoundedString(value: unknown, field: string, maxLength: number): string {
  const parsed = optionalBoundedString(value, maxLength);
  if (!parsed) throw new Error(`Task-context entry ${field} must be a non-empty string up to ${maxLength} characters.`);
  return parsed;
}

function optionalBoundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return undefined;
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
