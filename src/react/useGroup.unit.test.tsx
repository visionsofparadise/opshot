// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";

import { createMeta } from "../createMeta";
import { useGroup } from "./useGroup";

describe("useGroup", () => {
  it("returns the same group instance across re-renders", () => {
    const { result, rerender } = renderHook(() => useGroup());

    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
  });

  it("delivers merged meta through a group created with a token", () => {
    const token = createMeta<{ replay: boolean }>({ replay: false });
    const heard = new Array<{ replay: boolean }>();

    const { result } = renderHook(() => useGroup(token));

    result.current.subscribe((_state, _ops, emission) => {
      if (!emission.isSideEffect) heard.push(emission.meta);
    });

    const state = result.current.createState({ count: 0 });

    act(() => {
      state.mutate((mutable) => {
        mutable.count += 1;
      });
    });

    expect(heard).toEqual([{ replay: false }]);
  });
});
