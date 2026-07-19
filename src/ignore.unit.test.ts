import { createState } from "./createState";
import { ignore, type Ignored } from "./ignore";

describe("ignore", () => {
  it("keeps an ignored value's interior writable on the snapshot; the field itself stays non-reassignable", () => {
    const element = { currentTime: 0 };
    const state = createState({ position: 0, element: ignore(element) });

    // Compile-time assertion: Snapshot<T> leaves the ignored value's interior mutable.
    state.element.currentTime = 5;

    expect(element.currentTime).toBe(5);
    expect(state.element).toBe(element);

    expect(() => {
      // @ts-expect-error the ignored field itself is not reassignable on the snapshot
      state.element = { currentTime: 0 };
    }).toThrow();
  });

  it("Ignored<T> types an ignored field in an explicit interface without erasing the marker", () => {
    interface Player {
      element: Ignored<{ currentTime: number }>;
    }

    const element = { currentTime: 0 };
    const state = createState<Player>(() => ({ element: ignore(element) }));

    // Compile-time assertion: an Ignored<T>-typed field keeps its interior mutable through the interface.
    state.element.currentTime = 9;

    expect(element.currentTime).toBe(9);
    expect(state.element).toBe(element);
  });
});
