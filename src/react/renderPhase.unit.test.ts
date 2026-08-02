const reactSlots = vi.hoisted(() => ({
	modern: undefined as { H?: unknown } | undefined,
	legacy: undefined as { ReactCurrentDispatcher?: { current?: unknown } } | undefined,
}));

vi.mock("react", () => ({
	get __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE() {
		return reactSlots.modern;
	},
	get __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED() {
		return reactSlots.legacy;
	},
}));

const loadDetector = async (): Promise<typeof import("./renderPhase")> => {
	vi.resetModules();

	return import("./renderPhase");
};

const nonRender = { tag: "ContextOnlyDispatcher" };
const mountRender = { tag: "HooksDispatcherOnMount" };
const updateRender = { tag: "HooksDispatcherOnUpdate" };

describe("renderPhase", () => {
	beforeEach(() => {
		reactSlots.modern = undefined;
		reactSlots.legacy = undefined;
	});

	it("answers not-rendering until the non-render dispatcher is learned", async () => {
		reactSlots.modern = { H: mountRender };

		const detector = await loadDetector();

		expect(detector.isRendering()).toBe(false);
	});

	it("distinguishes both render dispatchers from the learned one by identity", async () => {
		reactSlots.modern = { H: nonRender };

		const detector = await loadDetector();

		detector.learnNonRenderDispatcher();

		expect(detector.isRendering()).toBe(false);

		reactSlots.modern.H = mountRender;
		expect(detector.isRendering()).toBe(true);

		reactSlots.modern.H = updateRender;
		expect(detector.isRendering()).toBe(true);

		reactSlots.modern.H = nonRender;
		expect(detector.isRendering()).toBe(false);
	});

	it("learns nothing from an empty slot, and reads an empty slot as not rendering", async () => {
		reactSlots.modern = { H: null };

		const detector = await loadDetector();

		detector.learnNonRenderDispatcher();
		reactSlots.modern.H = mountRender;

		expect(detector.isRendering()).toBe(false);

		reactSlots.modern.H = nonRender;
		detector.learnNonRenderDispatcher();
		reactSlots.modern.H = null;

		expect(detector.isRendering()).toBe(false);

		reactSlots.modern.H = mountRender;
		expect(detector.isRendering()).toBe(true);
	});

	it("reads React 18's dispatcher slot when React 19's is absent", async () => {
		reactSlots.legacy = { ReactCurrentDispatcher: { current: nonRender } };

		const detector = await loadDetector();

		detector.learnNonRenderDispatcher();

		expect(detector.isRendering()).toBe(false);

		if (reactSlots.legacy.ReactCurrentDispatcher === undefined) throw new Error("missing dispatcher");

		reactSlots.legacy.ReactCurrentDispatcher.current = updateRender;

		expect(detector.isRendering()).toBe(true);
	});

	it("never reports rendering when no slot is exposed, so the caller's fallback is permanent", async () => {
		const detector = await loadDetector();

		detector.learnNonRenderDispatcher();

		expect(detector.isRendering()).toBe(false);
	});
});
