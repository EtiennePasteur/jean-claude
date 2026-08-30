import type { JsonPatchOperation } from '../config/schema.ts';

/** A JSON Patch failure, carrying the index of the offending operation. */
export class JsonPatchError extends Error {
  constructor(
    message: string,
    readonly index: number,
  ) {
    super(`jsonPatch[${index}]: ${message}`);
    this.name = 'JsonPatchError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep merge. Plain objects are merged recursively; arrays and scalars from
 * `source` overwrite whatever `target` holds.
 */
export function deepMerge(target: unknown, source: Record<string, unknown>): unknown {
  if (!isPlainObject(target)) return structuredClone(source);

  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const existing = result[key];
    result[key] = isPlainObject(value) && isPlainObject(existing) ? deepMerge(existing, value) : structuredClone(value);
  }
  return result;
}

/** Decode a JSON Pointer (RFC 6901) into its segments. */
export function parseJsonPointer(pointer: string): string[] {
  if (pointer === '') return [];
  return pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

type Container = Record<string, unknown> | unknown[];

function isContainer(value: unknown): value is Container {
  return typeof value === 'object' && value !== null;
}

/** Resolve every segment but the last, returning the parent container and the final key. */
function resolveParent(root: unknown, segments: string[], index: number): { parent: Container; key: string } {
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    if (!isContainer(current)) throw new JsonPatchError(`path crosses a non-container value ("${segment}")`, index);
    current = Array.isArray(current) ? current[Number(segment)] : current[segment];
  }
  if (!isContainer(current)) throw new JsonPatchError('the parent of the target path does not exist', index);
  return { parent: current, key: segments.at(-1)! };
}

function arrayIndex(array: unknown[], key: string, index: number, { allowAppend = false } = {}): number {
  if (key === '-') {
    if (!allowAppend) throw new JsonPatchError('"-" is only usable with `add`', index);
    return array.length;
  }
  const position = Number(key);
  if (!Number.isInteger(position) || position < 0 || position > array.length - (allowAppend ? 0 : 1)) {
    throw new JsonPatchError(`invalid array index "${key}"`, index);
  }
  return position;
}

function readPointer(root: unknown, pointer: string, index: number): unknown {
  const segments = parseJsonPointer(pointer);
  let current = root;
  for (const segment of segments) {
    if (!isContainer(current)) throw new JsonPatchError(`path "${pointer}" cannot be resolved`, index);
    current = Array.isArray(current) ? current[arrayIndex(current, segment, index)] : current[segment];
  }
  return current;
}

function writePointer(root: unknown, pointer: string, value: unknown, index: number, mode: 'add' | 'replace'): unknown {
  const segments = parseJsonPointer(pointer);
  if (segments.length === 0) return value;

  const { parent, key } = resolveParent(root, segments, index);
  if (Array.isArray(parent)) {
    const position = arrayIndex(parent, key, index, { allowAppend: mode === 'add' });
    if (mode === 'add') parent.splice(position, 0, value);
    else parent[position] = value;
  } else {
    if (mode === 'replace' && !(key in parent)) throw new JsonPatchError(`key "${key}" does not exist`, index);
    parent[key] = value;
  }
  return root;
}

function removePointer(root: unknown, pointer: string, index: number): unknown {
  const segments = parseJsonPointer(pointer);
  if (segments.length === 0) throw new JsonPatchError('`remove` on the document root is not allowed', index);

  const { parent, key } = resolveParent(root, segments, index);
  if (Array.isArray(parent)) {
    parent.splice(arrayIndex(parent, key, index), 1);
  } else {
    if (!(key in parent)) throw new JsonPatchError(`key "${key}" does not exist`, index);
    delete parent[key];
  }
  return root;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
}

/**
 * Apply a JSON Patch (RFC 6902) to a copy of the document.
 * The input document is never mutated.
 */
export function applyJsonPatch(document: unknown, operations: JsonPatchOperation[]): unknown {
  let result = structuredClone(document);

  for (const [index, operation] of operations.entries()) {
    switch (operation.op) {
      case 'add':
        result = writePointer(result, operation.path, structuredClone(operation.value), index, 'add');
        break;
      case 'replace':
        result = writePointer(result, operation.path, structuredClone(operation.value), index, 'replace');
        break;
      case 'remove':
        result = removePointer(result, operation.path, index);
        break;
      case 'move': {
        if (operation.from === undefined) throw new JsonPatchError('`move` requires `from`', index);
        const moved = structuredClone(readPointer(result, operation.from, index));
        result = removePointer(result, operation.from, index);
        result = writePointer(result, operation.path, moved, index, 'add');
        break;
      }
      case 'copy': {
        if (operation.from === undefined) throw new JsonPatchError('`copy` requires `from`', index);
        const copied = structuredClone(readPointer(result, operation.from, index));
        result = writePointer(result, operation.path, copied, index, 'add');
        break;
      }
      case 'test': {
        const actual = readPointer(result, operation.path, index);
        if (!deepEqual(actual, operation.value)) {
          throw new JsonPatchError(`\`test\` failed at "${operation.path}"`, index);
        }
        break;
      }
    }
  }

  return result;
}
