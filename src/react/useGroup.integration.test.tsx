// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";

import { createChannel } from "../createChannel";
import { transact } from "../transact";
import { useGroup } from "./useGroup";

describe("useGroup", () => {
	it("returns the same group instance across re-renders", () => {
		const { result, rerender } = renderHook(() => useGroup());

		const first = result.current;

		rerender();

		expect(result.current).toBe(first);
	});

	it("delivers channel meta through states minted from the group", () => {
		const channel = createChannel<{ replay: boolean }>({ replay: false });
		const heard = new Array<{ replay: boolean }>();

		const { result } = renderHook(() => useGroup());

		channel.subscribe(result.current, (_state, _ops, context) => {
			if (context.isTransaction) heard.push(context.meta);
		});

		const state = result.current.createMutableState({ count: 0 });

		act(() => {
			channel.transact(state, () => {
				state.count += 1;
			});
		});

		expect(heard).toEqual([{ replay: false }]);
		expect(state.count).toBe(1);
	});

	it("accepts free-function transact on a group-minted state", () => {
		const { result } = renderHook(() => useGroup());
		const state = result.current.createMutableState({ count: 0 });

		act(() => {
			transact(state, () => {
				state.count = 3;
			});
		});

		expect(state.count).toBe(3);
	});
});
