import { createMeta, isMeta } from "./createMeta";
import { createState } from "./createState";
import { isState } from "./isState";

describe("createMeta", () => {
  it("brands tokens: a forged defaults object is not a token, and a token state is still a state", () => {
    const token = createMeta<{ replay: boolean }>({ replay: false });

    expect(isMeta(token)).toBe(true);
    expect(isMeta({ defaults: {} })).toBe(false);
    expect(isMeta(undefined)).toBe(false);
    expect(isState(createState({ count: 0 }, token))).toBe(true);
  });
});
