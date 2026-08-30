import { describe, expect, it } from 'vitest';

import { applyJsonPatch, deepMerge, JsonPatchError, parseJsonPointer } from '../src/util/json.ts';

describe('parseJsonPointer', () => {
  it('returns an empty array for the document root', () => {
    expect(parseJsonPointer('')).toEqual([]);
  });

  it('splits the segments', () => {
    expect(parseJsonPointer('/a/0/b')).toEqual(['a', '0', 'b']);
  });

  it('unescapes ~1 and ~0', () => {
    expect(parseJsonPointer('/a~1b/c~0d')).toEqual(['a/b', 'c~d']);
  });
});

describe('deepMerge', () => {
  it('merges objects recursively', () => {
    expect(deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } })).toEqual({ a: { b: 1, c: 3 } });
  });

  it('overwrites arrays rather than concatenating them', () => {
    expect(deepMerge({ a: [1, 2, 3] }, { a: [9] })).toEqual({ a: [9] });
  });

  it('replaces a non-object target with the source', () => {
    expect(deepMerge(42, { a: 1 })).toEqual({ a: 1 });
    expect(deepMerge([1, 2], { a: 1 })).toEqual({ a: 1 });
  });

  it('does not mutate the target', () => {
    const target = { a: { b: 1 } };
    deepMerge(target, { a: { b: 2 } });
    expect(target).toEqual({ a: { b: 1 } });
  });

  it('treats null as an explicit value', () => {
    expect(deepMerge({ a: 1 }, { a: null })).toEqual({ a: null });
  });
});

describe('applyJsonPatch', () => {
  it('replaces a field inside an array - the original use case', () => {
    const document = [{ title: 'Shopping', details: 'bla-bla-bla' }];
    const result = applyJsonPatch(document, [{ op: 'replace', path: '/0/title', value: 'Dining' }]);

    expect(result).toEqual([{ title: 'Dining', details: 'bla-bla-bla' }]);
    expect(document).toEqual([{ title: 'Shopping', details: 'bla-bla-bla' }]);
  });

  it('adds a key to an object', () => {
    expect(applyJsonPatch({ a: 1 }, [{ op: 'add', path: '/b', value: 2 }])).toEqual({ a: 1, b: 2 });
  });

  it('inserts into an array at an index', () => {
    expect(applyJsonPatch([1, 3], [{ op: 'add', path: '/1', value: 2 }])).toEqual([1, 2, 3]);
  });

  it('appends to an array with "-"', () => {
    expect(applyJsonPatch([1, 2], [{ op: 'add', path: '/-', value: 3 }])).toEqual([1, 2, 3]);
  });

  it('removes an object key and an array element', () => {
    expect(applyJsonPatch({ a: 1, b: 2 }, [{ op: 'remove', path: '/b' }])).toEqual({ a: 1 });
    expect(applyJsonPatch([1, 2, 3], [{ op: 'remove', path: '/1' }])).toEqual([1, 3]);
  });

  it('moves and copies', () => {
    expect(applyJsonPatch({ a: 1 }, [{ op: 'move', from: '/a', path: '/b' }])).toEqual({ b: 1 });
    expect(applyJsonPatch({ a: 1 }, [{ op: 'copy', from: '/a', path: '/b' }])).toEqual({ a: 1, b: 1 });
  });

  it('replaces the whole document through the root pointer', () => {
    expect(applyJsonPatch({ a: 1 }, [{ op: 'replace', path: '', value: [1, 2] }])).toEqual([1, 2]);
  });

  it('applies operations in order', () => {
    const result = applyJsonPatch({ a: 1 }, [
      { op: 'add', path: '/b', value: 2 },
      { op: 'replace', path: '/b', value: 3 },
    ]);
    expect(result).toEqual({ a: 1, b: 3 });
  });

  it('lets a satisfied `test` through', () => {
    expect(() => applyJsonPatch({ a: { b: [1] } }, [{ op: 'test', path: '/a', value: { b: [1] } }])).not.toThrow();
  });

  it('fails a false `test`, naming the operation index', () => {
    expect(() => applyJsonPatch({ a: 1 }, [{ op: 'test', path: '/a', value: 2 }])).toThrow(JsonPatchError);
    expect(() => applyJsonPatch({ a: 1 }, [{ op: 'test', path: '/a', value: 2 }])).toThrow(/jsonPatch\[0\]/);
  });

  it('rejects a `replace` on a missing key', () => {
    expect(() => applyJsonPatch({ a: 1 }, [{ op: 'replace', path: '/zzz', value: 1 }])).toThrow(/does not exist/);
  });

  it('rejects an out-of-bounds array index', () => {
    expect(() => applyJsonPatch([1], [{ op: 'replace', path: '/5', value: 1 }])).toThrow(/invalid array index/);
  });

  it('rejects "-" outside of an `add`', () => {
    expect(() => applyJsonPatch([1], [{ op: 'remove', path: '/-' }])).toThrow(/`add`/);
  });

  it('rejects `remove` on the document root', () => {
    expect(() => applyJsonPatch({ a: 1 }, [{ op: 'remove', path: '' }])).toThrow(/root/);
  });

  it('reports the index of the offending operation', () => {
    const run = (): unknown =>
      applyJsonPatch({ a: 1 }, [
        { op: 'add', path: '/b', value: 2 },
        { op: 'replace', path: '/zzz', value: 3 },
      ]);
    expect(run).toThrow(/jsonPatch\[1\]/);
  });
});
