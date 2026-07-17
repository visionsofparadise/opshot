// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";

import { createGroup } from "./createGroup";
import { type Op } from "./diff";
import { useCreateGroup, useCreateState } from "./react";
import { unwrap } from "./unwrap";

interface Counter {
  count: number;
  increment: () => void;
}

const counterDefine = (mutate: (callback: (draft: Counter) => void) => void): Counter => ({
  count: 0,
  increment: () => {
    mutate((draft) => {
      draft.count += 1;
    });
  },
});

describe("useCreateState", () => {
  it("returns the same state instance across re-renders", () => {
    const { result, rerender } = renderHook(() => useCreateState<Counter>(counterDefine));

    const first = result.current;

    rerender();

    expect(result.current.op).toBe(first.op);
    expect(result.current.op.isSameState(first)).toBe(true);
  });

  it("creates a working standalone state from a plain-object define", () => {
    const { result } = renderHook(() => useCreateState<{ count: number }>({ count: 0 }));

    act(() => {
      result.current.op.mutate((draft) => {
        draft.count += 1;
      });
    });

    expect(unwrap(result.current).count).toBe(1);
  });

  it("mints through a group so group.subscribe hears its ops", () => {
    const group = createGroup();
    const heard: Array<Array<Op>> = [];

    group.subscribe((_state, ops) => {
      heard.push(ops);
    });

    const { result } = renderHook(() => useCreateState<Counter>(counterDefine, group));

    act(() => {
      result.current.increment();
    });

    expect(heard).toHaveLength(1);
    expect(unwrap(result.current).count).toBe(1);
  });
});

describe("useCreateGroup", () => {
  it("returns the same group instance across re-renders", () => {
    const { result, rerender } = renderHook(() => useCreateGroup());

    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });
});
