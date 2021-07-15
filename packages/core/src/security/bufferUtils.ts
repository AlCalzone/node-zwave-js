export function zeroPad(
	input: Buffer,
	blockSize: number,
): { output: Buffer; paddingLength: number } {
	const padding =
		input.length % blockSize === 0
			? Buffer.from([])
			: Buffer.alloc(blockSize - (input.length % blockSize), 0);
	return {
		output: Buffer.concat([input, padding]),
		paddingLength: padding.length,
	};
}
/** Left-Shifts a buffer by 1 bit */
export function leftShift1(input: Buffer): Buffer {
	const ret = Buffer.allocUnsafe(input.length);
	for (let i = 0; i < input.length - 1; i++) {
		ret[i] = (input[i] << 1) + (!!(input[i + 1] & 0x80) ? 1 : 0);
	}
	ret[ret.length - 1] = input[input.length - 1] << 1;
	return ret;
}

/** Computes the byte-wise XOR of two buffers with the same length */
export function xor(b1: Buffer, b2: Buffer): Buffer {
	if (b1.length !== b2.length) {
		throw new Error("The buffers must have the same length");
	}
	const ret = Buffer.allocUnsafe(b1.length);
	for (let i = 0; i < b1.length; i++) {
		ret[i] = b1[i] ^ b2[i];
	}
	return ret;
}

/** Increments a multi-byte integer in a buffer */
export function increment(buffer: Buffer): void {
	for (let i = buffer.length - 1; i >= 0; i--) {
		buffer[i] += 1;
		if (buffer[i] !== 0x00) break;
	}
}
