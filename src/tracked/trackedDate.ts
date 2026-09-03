import { assertMutableFacade } from "./facadeGuard";

class DateSetYearError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DateSetYearError";
	}
}

const setLegacyYear = (date: Date, year: unknown): number => {
	const setYear: unknown = Reflect.get(date, "setYear");

	if (typeof setYear !== "function") throw new DateSetYearError("opshot: Date.setYear is not available");

	const epochMs: unknown = Reflect.apply(setYear, date, [year]);

	if (typeof epochMs !== "number") throw new DateSetYearError("opshot: Date.setYear returned a non-number");

	return epochMs;
};

type DateConstructorArgs =
	| []
	| [value: number | string]
	| [
			year: number,
			monthIndex: number,
			date?: number,
			hours?: number,
			minutes?: number,
			seconds?: number,
			milliseconds?: number,
	  ];

const constructDate = (args: DateConstructorArgs): Date => {
	switch (args.length) {
		case 0:
			return new Date();
		case 1:
			return new Date(args[0]);
		case 2:
			return new Date(args[0], args[1]);
		case 3:
			return new Date(args[0], args[1], args[2]);
		case 4:
			return new Date(args[0], args[1], args[2], args[3]);
		case 5:
			return new Date(args[0], args[1], args[2], args[3], args[4]);
		case 6:
			return new Date(args[0], args[1], args[2], args[3], args[4], args[5]);
		case 7:
			return new Date(args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
	}
};

const MAX_TIME = 8.64e15;

const clipTime = (epochMs: number): number => {
	if (!Number.isFinite(epochMs) || Math.abs(epochMs) > MAX_TIME) return Number.NaN;

	return Math.trunc(epochMs) + 0;
};

/**
 * Tracked `Date` for use in state.
 *
 * @example
 * createMutableState({ when: new TrackedDate() })
 */
export class TrackedDate {
	private epochMs: number;

	constructor(...args: DateConstructorArgs) {
		this.epochMs = constructDate(args).getTime();
	}

	private readDate(): Date {
		return new Date(this.epochMs);
	}

	private readEpochMs(): number {
		return clipTime(this.epochMs);
	}

	private write(mutate: (value: Date) => number): number {
		assertMutableFacade(this, "epochMs");

		const epochMs = mutate(this.readDate());

		this.epochMs = epochMs;

		return epochMs;
	}

	toString(): string {
		return this.readDate().toString();
	}

	toDateString(): string {
		return this.readDate().toDateString();
	}

	toTimeString(): string {
		return this.readDate().toTimeString();
	}

	toLocaleString(locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions): string {
		return this.readDate().toLocaleString(locales, options);
	}

	toLocaleDateString(locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions): string {
		return this.readDate().toLocaleDateString(locales, options);
	}

	toLocaleTimeString(locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions): string {
		return this.readDate().toLocaleTimeString(locales, options);
	}

	valueOf(): number {
		return this.readEpochMs();
	}

	getTime(): number {
		return this.readEpochMs();
	}

	getFullYear(): number {
		return this.readDate().getFullYear();
	}

	getYear(): number {
		return this.readDate().getFullYear() - 1900;
	}

	getUTCFullYear(): number {
		return this.readDate().getUTCFullYear();
	}

	getMonth(): number {
		return this.readDate().getMonth();
	}

	getUTCMonth(): number {
		return this.readDate().getUTCMonth();
	}

	getDate(): number {
		return this.readDate().getDate();
	}

	getUTCDate(): number {
		return this.readDate().getUTCDate();
	}

	getDay(): number {
		return this.readDate().getDay();
	}

	getUTCDay(): number {
		return this.readDate().getUTCDay();
	}

	getHours(): number {
		return this.readDate().getHours();
	}

	getUTCHours(): number {
		return this.readDate().getUTCHours();
	}

	getMinutes(): number {
		return this.readDate().getMinutes();
	}

	getUTCMinutes(): number {
		return this.readDate().getUTCMinutes();
	}

	getSeconds(): number {
		return this.readDate().getSeconds();
	}

	getUTCSeconds(): number {
		return this.readDate().getUTCSeconds();
	}

	getMilliseconds(): number {
		return this.readDate().getMilliseconds();
	}

	getUTCMilliseconds(): number {
		return this.readDate().getUTCMilliseconds();
	}

	getTimezoneOffset(): number {
		return this.readDate().getTimezoneOffset();
	}

	setYear(year: number): number;
	setYear(year: unknown): number {
		return this.write((date) => setLegacyYear(date, year));
	}

	setTime(...args: [time: number]): number {
		return this.write((date) => date.setTime(...args));
	}

	setMilliseconds(...args: [milliseconds: number]): number {
		return this.write((date) => date.setMilliseconds(...args));
	}

	setUTCMilliseconds(...args: [milliseconds: number]): number {
		return this.write((date) => date.setUTCMilliseconds(...args));
	}

	setSeconds(...args: [seconds: number, milliseconds?: number]): number {
		return this.write((date) => date.setSeconds(...args));
	}

	setUTCSeconds(...args: [seconds: number, milliseconds?: number]): number {
		return this.write((date) => date.setUTCSeconds(...args));
	}

	setMinutes(...args: [minutes: number, seconds?: number, milliseconds?: number]): number {
		return this.write((date) => date.setMinutes(...args));
	}

	setUTCMinutes(...args: [minutes: number, seconds?: number, milliseconds?: number]): number {
		return this.write((date) => date.setUTCMinutes(...args));
	}

	setHours(...args: [hours: number, minutes?: number, seconds?: number, milliseconds?: number]): number {
		return this.write((date) => date.setHours(...args));
	}

	setUTCHours(...args: [hours: number, minutes?: number, seconds?: number, milliseconds?: number]): number {
		return this.write((date) => date.setUTCHours(...args));
	}

	setDate(...args: [dateValue: number]): number {
		return this.write((date) => date.setDate(...args));
	}

	setUTCDate(...args: [dateValue: number]): number {
		return this.write((date) => date.setUTCDate(...args));
	}

	setMonth(...args: [month: number, dateValue?: number]): number {
		return this.write((date) => date.setMonth(...args));
	}

	setUTCMonth(...args: [month: number, dateValue?: number]): number {
		return this.write((date) => date.setUTCMonth(...args));
	}

	setFullYear(...args: [year: number, month?: number, dateValue?: number]): number {
		return this.write((date) => date.setFullYear(...args));
	}

	setUTCFullYear(...args: [year: number, month?: number, dateValue?: number]): number {
		return this.write((date) => date.setUTCFullYear(...args));
	}

	toUTCString(): string {
		return this.readDate().toUTCString();
	}

	toGMTString(): string {
		return this.readDate().toUTCString();
	}

	toISOString(): string {
		return this.readDate().toISOString();
	}

	[Symbol.toPrimitive](hint: "default" | "string" | "number"): string | number {
		if (hint === "number") return this.readEpochMs();

		return this.readDate()[Symbol.toPrimitive](hint);
	}

	declare readonly [Symbol.toStringTag]: "TrackedDate";
}

Object.defineProperty(TrackedDate.prototype, Symbol.toStringTag, {
	value: "TrackedDate",
	enumerable: false,
	configurable: false,
	writable: false,
});
