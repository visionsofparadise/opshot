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

describe("renderPhase", () => {
	beforeEach(() => {
		reactSlots.modern = undefined;
		reactSlots.legacy = undefined;
	});

	it("never reports rendering when no slot is exposed, so the caller's fallback is permanent", async () => {
		const detector = await loadDetector();

		detector.learnNonRenderDispatcher();

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
});
