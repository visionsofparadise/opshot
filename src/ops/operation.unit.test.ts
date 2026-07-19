import {
  createDateSetOperation,
  createMapDeleteOperation,
  createMapEntriesOperation,
  createMapSetOperation,
  createRemoveOperation,
  createSetAddOperation,
  createSetDeleteOperation,
  createSetEntriesOperation,
  createValueOperation,
  isOperation,
  type Operation,
} from "./operation";

const readValue = (half: Operation): unknown => ("value" in half ? half.value : undefined);
const readKey = (half: Operation): unknown => ("key" in half ? half.key : undefined);
const readEntries = (half: Operation): unknown => ("entries" in half ? half.entries : undefined);
const readMember = (half: Operation): unknown => ("member" in half ? half.member : undefined);
const readMembers = (half: Operation): unknown => ("members" in half ? half.members : undefined);

describe("operation", () => {
  it("mints a fresh equal clone on every read of a cloneable value", () => {
    const half = createValueOperation("add", "/node", { nested: { x: 1 }, list: [1, 2] });

    expect(readValue(half)).not.toBe(readValue(half));
    expect(readValue(half)).toEqual({ nested: { x: 1 }, list: [1, 2] });
    expect((readValue(half) as { nested: object }).nested).not.toBe((readValue(half) as { nested: object }).nested);
  });

  it("rides keys and members by identity while cloning values per read", () => {
    const key = { id: 1 };
    const value = { count: 2 };

    const mapSet = createMapSetOperation("/map", key, value);

    expect(readKey(mapSet)).toBe(key);
    expect(readValue(mapSet)).not.toBe(value);
    expect(readValue(mapSet)).toEqual({ count: 2 });

    const mapDelete = createMapDeleteOperation("/map", key);

    expect(readKey(mapDelete)).toBe(key);

    const mapEntries = createMapEntriesOperation("/map", [[key, value]]);
    const entriesRead = readEntries(mapEntries) as Array<[{ id: number }, { count: number }]>;

    expect(entriesRead).not.toBe(readEntries(mapEntries));
    expect(entriesRead[0]?.[0]).toBe(key);
    expect(entriesRead[0]?.[1]).not.toBe(value);
    expect(entriesRead).toEqual([[{ id: 1 }, { count: 2 }]]);

    const setAdd = createSetAddOperation("/set", key);
    const setDelete = createSetDeleteOperation("/set", key);

    expect(readMember(setAdd)).toBe(key);
    expect(readMember(setDelete)).toBe(key);

    const setEntries = createSetEntriesOperation("/set", [key]);
    const membersRead = readMembers(setEntries) as Array<{ id: number }>;

    expect(membersRead[0]).toBe(key);
    expect(membersRead).toEqual([{ id: 1 }]);
  });

  it("keeps non-cloneable payloads as own enumerable data properties", () => {
    const half = createValueOperation("replace", "/count", 2);
    const descriptor = Object.getOwnPropertyDescriptor(half, "value");

    expect(descriptor?.value).toBe(2);
    expect(descriptor?.enumerable).toBe(true);
    expect(descriptor?.get).toBeUndefined();

    const run = (): string => "a";
    const withFunction = createValueOperation("add", "/run", run);

    expect(Object.getOwnPropertyDescriptor(withFunction, "value")?.value).toBe(run);

    const dateSet = createDateSetOperation("/date", 1700000000000);
    const epochDescriptor = Object.getOwnPropertyDescriptor(dateSet, "epoch");

    expect(epochDescriptor?.value).toBe(1700000000000);
    expect(epochDescriptor?.enumerable).toBe(true);

    const stringKey = createMapDeleteOperation("/map", "a/b");

    expect(Object.getOwnPropertyDescriptor(stringKey, "key")?.value).toBe("a/b");
  });

  it("fails isOperation for spread, JSON, and structuredClone copies while the original passes", () => {
    const half = createValueOperation("add", "/node", { nested: true });

    expect(isOperation(half)).toBe(true);

    const spread = { ...half };

    expect("value" in spread).toBe(false);
    expect(isOperation(spread)).toBe(false);

    const json = JSON.parse(JSON.stringify(half)) as object;

    expect(json).toEqual({ op: "add", path: "/node" });
    expect(isOperation(json)).toBe(false);

    const structured = structuredClone(half);

    expect("value" in structured).toBe(false);
    expect(isOperation(structured)).toBe(false);

    expect(isOperation(null)).toBe(false);
    expect(isOperation(undefined)).toBe(false);
    expect(isOperation({ op: "add", path: "/node", value: 1 })).toBe(false);
  });

  it("keeps halves branded through an envelope-level spread", () => {
    const op = { isPatch: true, do: createValueOperation("add", "/node", { nested: true }), undo: createRemoveOperation("/node") };
    const spread = { ...op };

    expect(spread.do).toBe(op.do);
    expect(isOperation(spread.do)).toBe(true);
    expect(isOperation(spread.undo)).toBe(true);
    expect(readValue(spread.do)).toEqual({ nested: true });
  });

  it("hides cloned values behind the getter while keys, members, and scalars stay own keys", () => {
    expect(Object.keys(createValueOperation("add", "/node", { nested: true }))).toEqual(["op", "path"]);
    expect(Object.keys(createValueOperation("replace", "/count", 2))).toEqual(["op", "path", "value"]);
    expect(Object.keys(createRemoveOperation("/count"))).toEqual(["op", "path"]);
    expect(Object.keys(createDateSetOperation("/date", 0))).toEqual(["op", "path", "epoch"]);
    expect(Object.keys(createMapSetOperation("/map", "a", { nested: true }))).toEqual(["op", "path", "key"]);
    expect(Object.keys(createMapSetOperation("/map", { id: 1 }, { nested: true }))).toEqual(["op", "path", "key"]);
    expect(Object.keys(createSetAddOperation("/set", { id: 1 }))).toEqual(["op", "path", "member"]);
    expect(Object.keys(createSetEntriesOperation("/set", [{ id: 1 }]))).toEqual(["op", "path", "members"]);
  });
});
