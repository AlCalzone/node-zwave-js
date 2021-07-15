/** Management class and utils for Security S0 */

import { randomBytes } from "crypto";
import { ZWaveError, ZWaveErrorCodes } from "../error/ZWaveError";
import { encryptAES128ECB } from "./crypto";

const authKeyBase = Buffer.alloc(16, 0x55);
const encryptionKeyBase = Buffer.alloc(16, 0xaa);

export function generateAuthKey(networkKey: Buffer): Buffer {
	return encryptAES128ECB(authKeyBase, networkKey);
}

export function generateEncryptionKey(networkKey: Buffer): Buffer {
	return encryptAES128ECB(encryptionKeyBase, networkKey);
}

interface NonceKey {
	/** The node that has created this nonce */
	issuer: number;
	nonceId: number;
}

interface NonceEntry {
	nonce: Buffer;
	/** The node this nonce was created for */
	receiver: number;
}

export interface SecurityManagerOptions {
	networkKey: Buffer;
	ownNodeId: number;
	nonceTimeout: number;
}

export interface SetNonceOptions {
	free?: boolean;
}

export class SecurityManager {
	public constructor(options: SecurityManagerOptions) {
		this.networkKey = options.networkKey;
		this.ownNodeId = options.ownNodeId;
		this.nonceTimeout = options.nonceTimeout;
	}

	private ownNodeId: number;
	private nonceTimeout: number;

	private _networkKey!: Buffer;
	public get networkKey(): Buffer {
		return this._networkKey;
	}
	public set networkKey(v: Buffer) {
		if (v.length !== 16) {
			throw new ZWaveError(
				`The network key must be 16 bytes long!`,
				ZWaveErrorCodes.Argument_Invalid,
			);
		}
		this._networkKey = v;
		this._authKey = generateAuthKey(this._networkKey);
		this._encryptionKey = generateEncryptionKey(this._networkKey);
	}

	private _authKey!: Buffer;
	public get authKey(): Buffer {
		return this._authKey;
	}

	private _encryptionKey!: Buffer;
	public get encryptionKey(): Buffer {
		return this._encryptionKey;
	}

	private _nonceStore = new Map<string, NonceEntry>();
	private _freeNonceIDs = new Set<string>();
	private _nonceTimers = new Map<string, NodeJS.Timeout>();

	private normalizeId(id: number | NonceKey): string {
		let ret: NonceKey;
		if (typeof id === "number") {
			ret = {
				issuer: this.ownNodeId,
				nonceId: id,
			};
		} else {
			ret = {
				issuer: id.issuer,
				nonceId: id.nonceId,
			};
		}
		return JSON.stringify(ret);
	}

	/** Generates a nonce for the current node */
	public generateNonce(receiver: number, length: number): Buffer {
		let nonce: Buffer;
		let nonceId: number;
		do {
			nonce = randomBytes(length);
			nonceId = this.getNonceId(nonce);
		} while (this.hasNonce(nonceId));

		this.setNonce(nonceId, { receiver, nonce }, { free: false });
		return nonce;
	}

	public getNonceId(nonce: Buffer): number {
		return nonce[0];
	}

	public setNonce(
		id: number | NonceKey,
		entry: NonceEntry,
		{ free = true }: SetNonceOptions = {},
	): void {
		const key = this.normalizeId(id);
		if (this._nonceTimers.has(key)) {
			clearTimeout(this._nonceTimers.get(key)!);
		}
		this._nonceStore.set(key, entry);
		if (free) this._freeNonceIDs.add(key);
		this._nonceTimers.set(
			key,
			setTimeout(() => {
				this.expireNonce(key);
			}, this.nonceTimeout).unref(),
		);
	}

	/** Deletes ALL nonces that were issued for a given node, except the given nonce id */
	public deleteAllNoncesForReceiver(receiver: number): void {
		for (const [key, entry] of this._nonceStore) {
			if (entry.receiver === receiver) {
				this.deleteNonceInternal(key);
			}
		}
	}

	public deleteNonce(id: number | NonceKey): void {
		const key = this.normalizeId(id);
		const nonceReceiver = this._nonceStore.get(key)?.receiver;
		// Delete the nonce that was requested to be deleted
		this.deleteNonceInternal(key);
		// And all others for the same receiver aswell
		if (nonceReceiver) {
			this.deleteAllNoncesForReceiver(nonceReceiver);
		}
	}

	private deleteNonceInternal(key: string) {
		if (this._nonceTimers.has(key)) {
			clearTimeout(this._nonceTimers.get(key)!);
		}
		this._nonceStore.delete(key);
		this._nonceTimers.delete(key);
		this._freeNonceIDs.delete(key);
	}

	private expireNonce(key: string): void {
		this.deleteNonceInternal(key);
	}

	public getNonce(id: number | NonceKey): Buffer | undefined {
		return this._nonceStore.get(this.normalizeId(id))?.nonce;
	}

	public hasNonce(id: number | NonceKey): boolean {
		return this._nonceStore.has(this.normalizeId(id));
	}

	public getFreeNonce(nodeId: number): Buffer | undefined {
		// Iterate through the known free nonce IDs to find one for the given node
		for (const key of this._freeNonceIDs) {
			const nonceKey = JSON.parse(key) as NonceKey;
			if (nonceKey.issuer === nodeId) {
				this._freeNonceIDs.delete(key);
				return this._nonceStore.get(key)?.nonce;
			}
		}
	}
}
