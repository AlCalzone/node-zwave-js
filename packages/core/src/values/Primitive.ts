import { ZWaveError, ZWaveErrorCodes } from "../error/ZWaveError";
import {
	getBitMaskWidth,
	getMinimumShiftForBitMask,
	validatePayload,
} from "../util/misc";

type Brand<K, T> = K & { __brand: T };

type BrandedUnknown<T> = Brand<"unknown", T>;
export type Maybe<T> = T | BrandedUnknown<T>;

export const unknownNumber = "unknown" as Maybe<number>;
export const unknownBoolean = "unknown" as Maybe<boolean>;

/** Parses a boolean that is encoded as a single byte and might also be "unknown" */
export function parseMaybeBoolean(
	val: number,
	preserveUnknown: boolean = true,
): Maybe<boolean> | undefined {
	return val === 0xfe
		? preserveUnknown
			? unknownBoolean
			: undefined
		: parseBoolean(val);
}

/** Parses a boolean that is encoded as a single byte */
export function parseBoolean(val: number): boolean | undefined {
	return val === 0 ? false : val === 0xff ? true : undefined;
}

/** Parses a single-byte number from 0 to 100, which might also be "unknown" */
export function parseMaybeNumber(
	val: number,
	preserveUnknown: boolean = true,
): Maybe<number> | undefined {
	return val === 0xfe
		? preserveUnknown
			? unknownNumber
			: undefined
		: parseNumber(val);
}

/** Parses a single-byte number from 0 to 100 */
export function parseNumber(val: number): number | undefined {
	return val <= 99 ? val : val === 0xff ? 99 : undefined;
}

/** Parses a floating point value with a scale from a buffer */
export function parseFloatWithScale(payload: Buffer): {
	value: number;
	scale: number;
	bytesRead: number;
} {
	validatePayload(payload.length >= 1);
	const precision = (payload[0] & 0b111_00_000) >>> 5;
	const scale = (payload[0] & 0b000_11_000) >>> 3;
	const size = payload[0] & 0b111;
	validatePayload(size >= 1, size <= 4, payload.length >= 1 + size);
	const value = payload.readIntBE(1, size) / Math.pow(10, precision);
	return { value, scale, bytesRead: 1 + size };
}

function getPrecision(num: number): number {
	if (!Number.isFinite(num)) return 0;
	let e = 1;
	let p = 0;
	while (Math.round(num * e) / e !== num) {
		e *= 10;
		p++;
	}
	return p;
}

/** The minimum and maximum values that can be stored in each numeric value type */
export const IntegerLimits = Object.freeze({
	UInt8: Object.freeze({ min: 0, max: 0xff }),
	UInt16: Object.freeze({ min: 0, max: 0xffff }),
	UInt24: Object.freeze({ min: 0, max: 0xffffff }),
	UInt32: Object.freeze({ min: 0, max: 0xffffffff }),
	Int8: Object.freeze({ min: -0x80, max: 0x7f }),
	Int16: Object.freeze({ min: -0x8000, max: 0x7fff }),
	Int24: Object.freeze({ min: -0x800000, max: 0x7fffff }),
	Int32: Object.freeze({ min: -0x80000000, max: 0x7fffffff }),
});

export function getMinIntegerSize(
	value: number,
	signed: boolean,
): 1 | 2 | 4 | undefined {
	if (signed) {
		if (value >= IntegerLimits.Int8.min && value <= IntegerLimits.Int8.max)
			return 1;
		else if (
			value >= IntegerLimits.Int16.min &&
			value <= IntegerLimits.Int16.max
		)
			return 2;
		else if (
			value >= IntegerLimits.Int32.min &&
			value <= IntegerLimits.Int32.max
		)
			return 4;
	} else if (value >= 0) {
		if (value <= IntegerLimits.UInt8.max) return 1;
		if (value <= IntegerLimits.UInt16.max) return 2;
		if (value <= IntegerLimits.UInt32.max) return 4;
	}
	// Not a valid size
}

export function getIntegerLimits(
	size: 1 | 2 | 3 | 4,
	signed: boolean,
): { min: number; max: number } {
	return (IntegerLimits as any)[`${signed ? "" : "U"}Int${size * 8}`];
}

/**
 * Encodes a floating point value with a scale into a buffer
 * @param override can be used to overwrite the automatic computation of precision and size with fixed values
 */
export function encodeFloatWithScale(
	value: number,
	scale: number,
	override: {
		size?: number;
		precision?: number;
	} = {},
): Buffer {
	const precision = override.precision ?? Math.min(getPrecision(value), 7);
	value = Math.round(value * Math.pow(10, precision));
	let size: number | undefined = getMinIntegerSize(value, true);
	if (size == undefined) {
		throw new ZWaveError(
			`Cannot encode the value ${value} because its too large or too small to fit into 4 bytes`,
			ZWaveErrorCodes.Arithmetic,
		);
	} else if (override.size != undefined && override.size > size) {
		size = override.size;
	}
	const ret = Buffer.allocUnsafe(1 + size);
	ret[0] =
		((precision & 0b111) << 5) | ((scale & 0b11) << 3) | (size & 0b111);
	ret.writeIntBE(value, 1, size);
	return ret;
}

/** Parses a bit mask into a numeric array */
export function parseBitMask(mask: Buffer, startValue: number = 1): number[] {
	const numBits = mask.length * 8;

	const ret: number[] = [];
	for (let index = 1; index <= numBits; index++) {
		const byteNum = (index - 1) >>> 3; // id / 8
		const bitNum = (index - 1) % 8;
		if ((mask[byteNum] & (2 ** bitNum)) !== 0)
			ret.push(index + startValue - 1);
	}
	return ret;
}

/** Serializes a numeric array with a given maximum into a bit mask */
export function encodeBitMask(
	values: number[],
	maxValue: number,
	startValue: number = 1,
): Buffer {
	const numBytes = Math.ceil((maxValue - startValue + 1) / 8);
	const ret = Buffer.alloc(numBytes, 0);
	for (let val = startValue; val <= maxValue; val++) {
		if (values.indexOf(val) === -1) continue;
		const byteNum = (val - startValue) >>> 3; // id / 8
		const bitNum = (val - startValue) % 8;
		ret[byteNum] |= 2 ** bitNum;
	}
	return ret;
}

/**
 * Parses a partial value from a "full" value. Example:
 * ```txt
 *   Value = 01110000
 *   Mask  = 00110000
 *   ----------------
 *             11     => 3 (unsigned) or -1 (signed)
 * ```
 *
 * @param value The full value the partial should be extracted from
 * @param bitMask The bit mask selecting the partial value
 * @param signed Whether the partial value should be interpreted as signed
 */
export function parsePartial(
	value: number,
	bitMask: number,
	signed: boolean,
): number {
	const shift = getMinimumShiftForBitMask(bitMask);
	const width = getBitMaskWidth(bitMask);
	let ret = (value & bitMask) >>> shift;
	// If the high bit is set and this value should be signed, we need to convert it
	if (signed && !!(ret & (2 ** (width - 1)))) {
		// To represent a negative partial as signed, the high bits must be set to 1
		ret = ~(~ret & (bitMask >>> shift));
	}
	return ret;
}

/**
 * Encodes a partial value into a "full" value. Example:
 * ```txt
 *   Value   = 01··0000
 * + Partial =   10     (2 or -2 depending on signed interpretation)
 *   Mask    = 00110000
 *   ------------------
 *             01100000
 * ```
 *
 * @param fullValue The full value the partial should be merged into
 * @param partialValue The partial to be merged
 * @param bitMask The bit mask selecting the partial value
 */
export function encodePartial(
	fullValue: number,
	partialValue: number,
	bitMask: number,
): number {
	return (
		(fullValue & ~bitMask) |
		((partialValue << getMinimumShiftForBitMask(bitMask)) & bitMask)
	);
}
