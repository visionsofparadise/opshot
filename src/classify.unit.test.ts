import { createMutableState } from "./createMutableState";
import { admissionLane, unfrozenAdmissionLane } from "./classify";

describe("admissionLane", () => {
	it("classifies freeze as untracked", () => {
		expect(admissionLane(Object.freeze({ a: 1 }))).toBe("untracked");
	});

	it("classifies a primitive as a leaf and createMutableState returns it unchanged", () => {
		expect(admissionLane(1)).toBe("leaf");
		expect(createMutableState(1 as never)).toBe(1);
	});
});

describe("unfrozenAdmissionLane", () => {
	it("classifies a frozen Map as dangerous", () => {
		const frozenMap = Object.freeze(new Map());

		expect(admissionLane(frozenMap)).toBe("untracked");
		expect(unfrozenAdmissionLane(frozenMap)).toBe("dangerous");
	});

	it("classifies a frozen plain object as tracked", () => {
		expect(unfrozenAdmissionLane(Object.freeze({ a: 1 }))).toBe("tracked");
	});
});

describe("private name detection", () => {
	const instanceOf = (source: string): object => new (new Function(`return ${source}`)() as new () => object)();

	it.each([
		["bare field", "class A { #x; }"],
		["field with initializer", "class A { #x = 1; }"],
		["field with no semicolon", "class A { #x }"],
		["static private field", "class A { static #x = 1; }"],
		["private method", "class A { #m() {} }"],
		["static private method", "class A { static #m() {} }"],
		["private getter", "class A { get #x() { return 1 } }"],
		["private setter", "class A { set #x(v) {} }"],
		["static private getter", "class A { static get #x() { return 1 } }"],
		["async private method", "class A { async #m() {} }"],
		["static async private method", "class A { static async #m() {} }"],
		["generator private method", "class A { *#g() {} }"],
		["async generator private method", "class A { async *#g() {} }"],
		["static generator private method", "class A { static *#g() {} }"],
		["field with block comment before semicolon", "class A { #x /* the count */; }"],
		["comment then field", "class A { // note\n\t#x;\n}"],
		["two declarations", "class A { #x; get #y(){ return 1 } }"],
		["method then field", "class A { #m(){} #x; }"],
		["minified body", "class A{static #x=1;#m(){return this.#x}}"],
		["newline-separated fields", "class A {\n\t#x\n\t#y\n}"],
		["static field newline", "class A {\n\tstatic #count\n}"],
		["trailing line comment", "class A {\n\t#x // the count\n}"],
		["CRLF field", "class A {\r\n\t#x\r\n}"],
		["read through the instance", "class A { #x = 1; p(){ return this.#x } }"],
		["call to a private method", "class A { #m(){} c(){ return this.#m() } }"],
		["optional-chained access", "class A { #x; p(o){ return o?.#x } }"],
		["increment", "class A { #x = 0; i(){ this.#x++ } }"],
		["compound assignment", "class A { #x = 0; a(n){ this.#x += n } }"],
		["constructor-only assignment", "class A { #x; constructor(){ this.#x = 1 } }"],
		["access on another object", "class A { #x; eq(o){ return o.#x } }"],
		["static block", "class A { static #x; static { A.#x = 1 } }"],
		["tagged-template call of a private method", "class A { #m(s){ return s } p(){ return this.#m`x` } }"],
		["dot broken across lines", "class A { #x; p(){ return this\n\t\t.#x } }"],
		["brand check", "class A { #b; static is(o){ return #b in o } }"],
		["brand check inside a nested class", "class A { #b; f(){ return class { g(o){ return #b in o } } } }"],
		["destructuring target", "class A { #x; f(o){ ({ a: this.#x } = o) } }"],
		["residual: literal private-field code in a string", 'class A { p(){ return "call this.#x = 1 to set it" } }'],
	] as const)("refuses %s", (_label, source) => {
		expect(admissionLane(instanceOf(source))).toBe("dangerous");
	});

	it.each([
		["hash-prefixed anchor in a string", 'class A { constructor(){ this.x = "#anchor" } }'],
		["issue reference at a line-end comment", "class A { p(){ 1 // see #foo\n} }"],
		["named reference in a block comment", "class A { p(){ /* see #foo for why */ return 1 } }"],
		["jsdoc continuation ending in #foo", "class A { /**\n * #foo\n */ p(){ return 1 } }"],
		["issue number in a block comment", "class A { p(){ /* issue #42 */ return 1 } }"],
		["regex over a hash", "class A { p(){ return /#\\w+/ } }"],
		["hash-prefixed tag", 'class A { p(){ return "#tag" } }'],
		["three-digit hex colour", 'class A { p(){ return "#fff" } }'],
		["CSS colour with semicolon", 'class A { p(){ return "color: #f0a;" } }'],
		["CSS rule in a string", 'class A { p(){ return "a { color: #f0a; }" } }'],
		["querySelector id", 'class A { p(){ return document.querySelector("#app") } }'],
		["MDN URL fragment", 'class A { p(){ return "https://developer.mozilla.org/#Key_names" } }'],
		["CSS id selector rule", 'class A { p(){ return "#main-content { color: red }" } }'],
		["template interpolation", "class A { p(id){ return `#${id}` } }"],
		["numbered step", 'class A { p(){ return "step #1" } }'],
		["markdown heading", 'class A { p(){ return "# Title" } }'],
		["shebang", 'class A { p(){ return "#!/usr/bin/env node" } }'],
		["region marker at a line end", "class A { p(){ 1 // #region\n} }"],
		["compact region marker", "class A { p(){ //#region\n return 1 } }"],
		["HTML hex entity", 'class A { p(){ return "&#x1D306;" } }'],
		["jsdoc member link", "class A { /** {@link LRUCache#dump} */ p(){ return 1 } }"],
		["commented-out private fields", "class A { // #head;\n // #tail;\n }"],
		["prose brand-check lookalike", 'class A { p(){ return "put #tag in the list" } }'],
		["template literal CSS block", "class A { p(){ return `a { color: #f0a; }` } }"],
		["template literal line that is only #x", "class A { p(){ return `\n#x\n` } }"],
	] as const)("tracks %s", (_label, source) => {
		expect(admissionLane(instanceOf(source))).toBe("tracked");
	});
});
