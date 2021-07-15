import * as crypto from "crypto";
import { leftShift1, xor, zeroPad } from "./bufferUtils";

function encrypt(
	algorithm: string,
	blockSize: number,
	trimToInputLength: boolean,
	input: Buffer,
	key: Buffer,
	iv: Buffer,
): Buffer {
	const cipher = crypto.createCipheriv(algorithm, key, iv);
	cipher.setAutoPadding(false);

	const { output: plaintext, paddingLength } = zeroPad(input, blockSize);
	const ret = Buffer.concat([cipher.update(plaintext), cipher.final()]);

	if (trimToInputLength && paddingLength > 0) {
		return ret.slice(0, -paddingLength);
	} else {
		return ret;
	}
}

function decrypt(
	algorithm: string,
	blockSize: number,
	trimToInputLength: boolean,
	input: Buffer,
	key: Buffer,
	iv: Buffer,
): Buffer {
	const cipher = crypto.createDecipheriv(algorithm, key, iv);
	cipher.setAutoPadding(false);

	const { output: ciphertext, paddingLength } = zeroPad(input, blockSize);
	const ret = Buffer.concat([cipher.update(ciphertext), cipher.final()]);

	if (trimToInputLength && paddingLength > 0) {
		return ret.slice(0, -paddingLength);
	} else {
		return ret;
	}
}

/** Encrypts a payload using AES-128-ECB (as described in SDS10865) */
export function encryptAES128ECB(plaintext: Buffer, key: Buffer): Buffer {
	return encrypt("aes-128-ecb", 16, false, plaintext, key, Buffer.from([]));
}

/** Encrypts a payload using AES-OFB (as described in SDS10865) */
export const encryptAES128OFB = encrypt.bind(
	undefined,
	"aes-128-ofb",
	16,
	true,
);

/** Decrypts a payload using AES-OFB (as described in SDS10865) */
export const decryptAES128OFB = decrypt.bind(
	undefined,
	"aes-128-ofb",
	16,
	true,
);

/** Computes a message authentication code for Security S0 (as described in SDS10865) */
export function computeMAC(
	authData: Buffer,
	key: Buffer,
	iv: Buffer = Buffer.alloc(16, 0),
): Buffer {
	const ciphertext = encrypt("aes-128-cbc", 16, false, authData, key, iv);
	// The MAC is the first 8 bytes of the last 16 byte block
	return ciphertext.slice(-16, -8);
}

/** Decodes a DER-encoded x25519 key (PKCS#8 or SPKI) */
export function decodeX25519KeyDER(key: Buffer): Buffer {
	// We could parse this with asn1js but that doesn't seem necessary for now
	return key.slice(-32);
}

/** Encodes an x25519 key from a raw buffer with DER/PKCS#8 */
export function encodeX25519KeyDERPKCS8(key: Buffer): Buffer {
	// We could encode this with asn1js but that doesn't seem necessary for now
	return Buffer.concat([
		Buffer.from("302e020100300506032b656e04220420", "hex"),
		key,
	]);
}

/** Encodes an x25519 key from a raw buffer with DER/SPKI */
export function encodeX25519KeyDERSPKI(key: Buffer): Buffer {
	// We could encode this with asn1js but that doesn't seem necessary for now
	return Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), key]);
}

// Decoding with asn1js for reference:
// const asn1 = require("asn1js");
// const public = asn1.fromBER(keypair.publicKey.buffer);
// const private = asn1.fromBER(keypair.privateKey.buffer);
// const privateKeyBER = private.result.valueBlock.value[2].valueBlock.valueHex;
// const privateKey = Buffer.from(
// 	asn1.fromBER(privateKeyBER).result.valueBlock.valueHex,
// );
// const publicKey = Buffer.from(
// 	public.result.valueBlock.value[1].valueBlock.valueHex,
// );

const Z128 = Buffer.alloc(16, 0);
const R128 = Buffer.from("00000000000000000000000000000087", "hex");

function generateAES128CMACSubkeys(key: Buffer): [k1: Buffer, k2: Buffer] {
	// NIST SP 800-38B, chapter 6.1
	const L = encryptAES128ECB(Z128, key);
	const k1 = !(L[0] & 0x80) ? leftShift1(L) : xor(leftShift1(L), R128);
	const k2 = !(k1[0] & 0x80) ? leftShift1(k1) : xor(leftShift1(k1), R128);
	return [k1, k2];
}

/** Computes a message authentication code for Security S2 (as described in SDS13783) */
export function computeCMAC(message: Buffer, key: Buffer): Buffer {
	const blockSize = 16;
	const numBlocks = Math.ceil(message.length / blockSize);
	let lastBlock = message.slice((numBlocks - 1) * blockSize);
	const lastBlockIsComplete =
		message.length > 0 && message.length % blockSize === 0;
	if (!lastBlockIsComplete) {
		lastBlock = zeroPad(
			Buffer.concat([lastBlock, Buffer.from([0x80])]),
			blockSize,
		).output;
	}

	// Compute all steps but the last one
	let ret = Z128;
	for (let i = 0; i < numBlocks - 1; i++) {
		ret = xor(ret, message.slice(i * blockSize, (i + 1) * blockSize));
		ret = encryptAES128ECB(ret, key);
	}
	// Compute the last step
	const [k1, k2] = generateAES128CMACSubkeys(key);
	ret = xor(ret, xor(lastBlockIsComplete ? k1 : k2, lastBlock));
	ret = encryptAES128ECB(ret, key);

	return ret.slice(0, blockSize);
}

const constantPRK = Buffer.alloc(16, 0x33);

/** Computes the Pseudo Random Key (PRK) used to derive auth, encryption and nonce keys */
export function computePRK(
	ecdhSharedSecret: Buffer,
	pubKeyA: Buffer,
	pubKeyB: Buffer,
): Buffer {
	const message = Buffer.concat([ecdhSharedSecret, pubKeyA, pubKeyB]);
	return computeCMAC(message, constantPRK);
}

const constantTE = Buffer.alloc(15, 0x88);

/** Derives the temporary auth, encryption and nonce keys from the PRK */
export function deriveTempKeys(
	PRK: Buffer,
): { tempKeyCCM: Buffer; tempPersonalizationString: Buffer } {
	const T1 = computeCMAC(
		Buffer.concat([constantTE, Buffer.from([0x01])]),
		PRK,
	);
	const T2 = computeCMAC(
		Buffer.concat([T1, constantTE, Buffer.from([0x02])]),
		PRK,
	);
	const T3 = computeCMAC(
		Buffer.concat([T2, constantTE, Buffer.from([0x03])]),
		PRK,
	);
	return {
		tempKeyCCM: T1,
		tempPersonalizationString: Buffer.concat([T2, T3]),
	};
}

const constantNK = Buffer.alloc(15, 0x55);

/** Derives the CCM, MPAN keys and the personalization string from the permanent network key (PNK) */
export function deriveNetworkKeys(
	PNK: Buffer,
): { keyCCM: Buffer; keyMPAN: Buffer; personalizationString: Buffer } {
	const T1 = computeCMAC(
		Buffer.concat([constantNK, Buffer.from([0x01])]),
		PNK,
	);
	const T2 = computeCMAC(
		Buffer.concat([T1, constantNK, Buffer.from([0x02])]),
		PNK,
	);
	const T3 = computeCMAC(
		Buffer.concat([T2, constantNK, Buffer.from([0x03])]),
		PNK,
	);
	const T4 = computeCMAC(
		Buffer.concat([T3, constantNK, Buffer.from([0x04])]),
		PNK,
	);
	return {
		keyCCM: T1,
		keyMPAN: T4,
		personalizationString: Buffer.concat([T2, T3]),
	};
}

const constantNonce = Buffer.alloc(16, 0x26);

/** Computes the Pseudo Random Key (PRK) used to derive the mixed entropy input (MEI) for nonce generation */
export function computeNoncePRK(senderEI: Buffer, receiverEI: Buffer): Buffer {
	const message = Buffer.concat([senderEI, receiverEI]);
	return computeCMAC(message, constantNonce);
}

const constantEI = Buffer.alloc(15, 0x88);

/** Derives the MEI from the nonce PRK */
export function deriveMEI(noncePRK: Buffer): Buffer {
	const T1 = computeCMAC(
		Buffer.concat([
			constantEI,
			Buffer.from([0x00]),
			constantEI,
			Buffer.from([0x01]),
		]),
		noncePRK,
	);
	const T2 = computeCMAC(
		Buffer.concat([T1, constantEI, Buffer.from([0x02])]),
		noncePRK,
	);
	return Buffer.concat([T1, T2]);
}
