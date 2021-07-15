/*!
 * ctr-drbg.js - ctr-drbg implementation for bcrypto
 * Copyright (c) 2019, Christopher Jeffrey (MIT License).
 * https://github.com/bcoin-org/bcrypto
 *
 * Parts of this software are based on google/boringssl:
 *   https://github.com/google/boringssl
 *
 * Resources:
 *   https://csrc.nist.gov/publications/detail/sp/800-90a/archive/2012-01-23
 *   https://github.com/google/boringssl/blob/master/crypto/fipsmodule/rand/ctrdrbg.c
 *   https://github.com/google/boringssl/blob/master/crypto/fipsmodule/rand/internal.h
 *   https://github.com/openssl/openssl/blob/master/crypto/rand/drbg_lib.c
 *   https://github.com/cryptocoinjs/drbg.js/blob/master/ctr.js
 *   https://github.com/netroby/jdk9-dev/blob/master/jdk/src/java.base/share/classes/sun/security/provider/CtrDrbg.java
 */

import { increment } from "./bufferUtils";
import { encryptAES128ECB } from "./crypto";

const MAX_GENERATE_LENGTH = 65536;
// const RESEED_INTERVAL = 0x1000000000000;

export class CtrDRBG {
	constructor(
		bits: 128,
		derivation: boolean,
		entropy?: Buffer,
		nonce?: Buffer,
		pers?: Buffer,
	) {
		this.ctr = Buffer.alloc(16, 0);
		this.keySize = bits >>> 3;
		this.blkSize = 16;
		this.entSize = this.keySize + this.blkSize;
		this.slab = Buffer.alloc(this.entSize);
		this.K = this.slab.slice(0, this.keySize);
		this.V = this.slab.slice(this.keySize);
		this.derivation = derivation;
		// this.rounds = 0;
		this.initialized = false;

		if (entropy) this.init(entropy, nonce, pers);
	}

	/** The internal counter */
	private ctr: Buffer;
	private readonly keySize: number;
	private readonly blkSize: number;
	private readonly entSize: number;
	private slab: Buffer;
	private K: Buffer;
	private V: Buffer;
	private readonly derivation: boolean;
	// private rounds: number;
	private initialized: boolean;

	init(
		entropy: Buffer,
		nonce: Buffer = Buffer.alloc(0),
		pers: Buffer = Buffer.alloc(0),
	): this {
		let seed: Buffer;

		if (this.derivation) {
			seed = this.derive(entropy, nonce, pers);
		} else {
			if (entropy.length + nonce.length > this.entSize)
				throw new Error("Entropy is too long.");

			if (pers.length > this.entSize)
				throw new Error("Personalization string is too long.");

			seed = Buffer.alloc(this.entSize, 0);

			entropy.copy(seed, 0);
			nonce.copy(seed, entropy.length);

			for (let i = 0; i < pers.length; i++) seed[i] ^= pers[i];
		}

		this.slab.fill(0);
		this.V.copy(this.ctr, 0);
		this.update(seed);
		this.initialized = true;
		// this.rounds = 1;

		return this;
	}

	reseed(entropy: Buffer, add: Buffer = Buffer.alloc(0)): this {
		// if (this.rounds === 0)
		if (!this.initialized) throw new Error("DRBG not initialized.");

		let seed: Buffer;

		if (this.derivation) {
			seed = this.derive(entropy, add);
		} else {
			if (add.length > this.entSize)
				throw new Error("Additional data is too long.");

			seed = Buffer.alloc(this.entSize, 0x00);
			entropy.copy(seed, 0);
			for (let i = 0; i < add.length; i++) seed[i] ^= add[i];
		}

		this.update(seed);
		// this.rounds = 1;

		return this;
	}

	private next(): Buffer {
		increment(this.ctr);
		return encryptAES128ECB(this.ctr, this.K);
	}

	generate(len: number, add?: Buffer): Buffer {
		// if (this.rounds === 0)
		if (!this.initialized) throw new Error("DRBG not initialized.");

		// if (this.rounds > RESEED_INTERVAL)
		// 	throw new Error("Reseed is required.");

		if (len > MAX_GENERATE_LENGTH)
			throw new Error("Requested length is too long.");

		if (add && add.length > 0) {
			if (this.derivation) add = this.derive(add);

			this.update(add);
		}

		const blocks = Math.ceil(len / this.blkSize);
		const out = Buffer.alloc(blocks * this.blkSize);

		for (let i = 0; i < blocks; i++) {
			const ciphertext = this.next();
			ciphertext.copy(out, i * this.blkSize);
		}

		this.update(add);
		// this.rounds += 1;
		this.initialized = true;

		return out.slice(0, len);
	}

	/*
	 * Helpers
	 */

	update(seed: Buffer = Buffer.alloc(0)): this {
		if (seed.length > this.entSize) throw new Error("Seed is too long.");

		const newSlab = Buffer.alloc(this.slab.length, 0);
		// this.slab.fill(0);

		for (let i = 0; i < this.entSize; i += this.blkSize) {
			this.next().copy(newSlab, i);
			// ciphertext.copy(this.slab, i);
		}

		// for (let i = 0; i < seed.length; i++) this.slab[i] ^= seed[i];
		for (let i = 0; i < seed.length; i++) newSlab[i] ^= seed[i];

		newSlab.copy(this.slab, 0);
		this.V.copy(this.ctr, 0);

		return this;
	}

	serialize(...input: Buffer[]): Buffer {
		const N = this.entSize;

		let L = 0;

		for (const item of input) L += item.length;

		let size = this.blkSize + 4 + 4 + L + 1;

		if (size % this.blkSize) size += this.blkSize - (size % this.blkSize);

		// S = IV || (L || N || input || 0x80 || 0x00...)
		const S = Buffer.alloc(size, 0x00);

		let pos = this.blkSize;
		S.writeUInt32BE(L, pos);
		pos += 4;
		S.writeUInt32BE(N, pos);
		pos += 4;

		for (const item of input) pos += item.copy(S, pos);

		S[pos++] = 0x80;

		return S;
	}

	derive(...input: Buffer[]): Buffer {
		const S = this.serialize(...input);
		const N = S.length / this.blkSize;
		const K = Buffer.alloc(this.keySize);
		const blocks = Math.ceil(this.entSize / this.blkSize);
		const slab = Buffer.alloc(blocks * this.blkSize);
		const out = Buffer.alloc(blocks * this.blkSize);
		const chain = Buffer.alloc(this.blkSize);

		for (let i = 0; i < K.length; i++) K[i] = i;

		for (let i = 0; i < blocks; i++) {
			chain.fill(0);

			S.writeUInt32BE(i, 0);

			// chain = BCC(K, IV || S)
			for (let j = 0; j < N; j++) {
				for (let k = 0; k < chain.length; k++)
					chain[k] ^= S[j * this.blkSize + k];

				// encrypt in-place
				encryptAES128ECB(chain, K).copy(chain, 0);
				// ctx.encrypt(chain, 0, chain, 0);
			}

			chain.copy(slab, i * this.blkSize);
		}

		const k = slab.slice(0, this.keySize);
		const x = slab.slice(this.keySize, this.entSize);

		for (let i = 0; i < blocks; i++) {
			// encrypt in-place
			encryptAES128ECB(x, k).copy(x, 0);
			// ctx.encrypt(x, 0, x, 0);
			x.copy(out, i * this.blkSize);
		}

		return out.slice(0, this.entSize);
	}
}
