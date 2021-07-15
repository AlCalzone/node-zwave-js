/** Management class and utils for Security S2 */

import * as crypto from "crypto";
import { ZWaveError, ZWaveErrorCodes } from "../error/ZWaveError";
import { increment } from "./bufferUtils";
import { SecurityClasses } from "./constants";
import {
	computeNoncePRK,
	deriveMEI,
	deriveNetworkKeys,
	encryptAES128ECB,
} from "./crypto";
import { CtrDRBG } from "./ctr_drbg";

interface NetworkKeys {
	pnk: Buffer;
	keyCCM: Buffer;
	keyMPAN: Buffer;
	personalizationString: Buffer;
}

export class SecurityManager2 {
	public constructor() {
		this.rng = new CtrDRBG(
			128,
			false,
			crypto.randomBytes(32),
			undefined,
			Buffer.alloc(32, 0),
		);
	}

	/** PRNG used to initialize the others */
	private rng: CtrDRBG;
	/** A map of PRNGs for each node */
	private nodeRNG = new Map<number, CtrDRBG>();
	/** A map of MPAN states for each multicast group */
	private mpanStates = new Map<number, Buffer>();
	/** A map of permanent network keys per security class */
	private networkKeys = new Map<SecurityClasses, NetworkKeys>();
	/** Which node has been assigned which security class */
	private nodeClasses = new Map<number, SecurityClasses>();
	/** Which multicast group has been assigned which security class */
	private groupClasses = new Map<number, SecurityClasses>();

	/** Sets the PNK for a given security class and derives the encryption keys from it */
	public setKey(securityClass: SecurityClasses, key: Buffer): void {
		if (key.length !== 16) {
			throw new ZWaveError(
				`The network key must consist of 16 bytes!`,
				ZWaveErrorCodes.Argument_Invalid,
			);
		} else if (!(securityClass in SecurityClasses)) {
			throw new ZWaveError(
				`Invalid security class!`,
				ZWaveErrorCodes.Argument_Invalid,
			);
		}
		this.networkKeys.set(securityClass, {
			pnk: key,
			...deriveNetworkKeys(key),
		});
	}

	public assignSecurityClassSinglecast(
		nodeId: number,
		securityClass: SecurityClasses,
	): void {
		this.nodeClasses.set(nodeId, securityClass);
	}

	public assignSecurityClassMulticast(
		group: number,
		securityClass: SecurityClasses,
	): void {
		this.groupClasses.set(group, securityClass);
	}

	/** Initializes the singlecast PAN generator for a given node */
	public initializeSPAN(
		receiver: number,
		senderEI: Buffer,
		receiverEI: Buffer,
	): void {
		if (senderEI.length !== 16 || receiverEI.length !== 16) {
			throw new ZWaveError(
				`The entropy input must consist of 16 bytes`,
				ZWaveErrorCodes.Argument_Invalid,
			);
		} else if (!this.nodeClasses.has(receiver)) {
			throw new ZWaveError(
				`Node ${receiver} has not been assigned to a security class yet!`,
				ZWaveErrorCodes.Security2CC_NotInitialized,
			);
		}
		const keys = this.networkKeys.get(this.nodeClasses.get(receiver)!);
		if (!keys) {
			throw new ZWaveError(
				`The network keys for the security class of node ${receiver} have not been set up yet!`,
				ZWaveErrorCodes.Security2CC_NotInitialized,
			);
		}

		const noncePRK = computeNoncePRK(senderEI, receiverEI);
		const MEI = deriveMEI(noncePRK);

		this.nodeRNG.set(
			receiver,
			new CtrDRBG(128, false, MEI, undefined, keys.personalizationString),
		);
	}

	public nextNonce(receiver: number): Buffer {
		if (!this.nodeRNG.has(receiver)) {
			throw new ZWaveError(
				`The Singlecast PAN has not been initialized for Node ${receiver}`,
				ZWaveErrorCodes.Security2CC_NotInitialized,
			);
		}
		const ret = this.nodeRNG.get(receiver)!.generate(16);
		return ret.slice(0, 13);
	}

	public initializeMPAN(group: number): void {
		this.mpanStates.set(group, this.rng.generate(16));
	}

	public nextMPAN(group: number): Buffer {
		if (!this.mpanStates.has(group)) {
			throw new ZWaveError(
				`The MPAN state has not been initialized for multicast group ${group}`,
				ZWaveErrorCodes.Security2CC_NotInitialized,
			);
		} else if (!this.groupClasses.has(group)) {
			throw new ZWaveError(
				`Multicast group ${group} has not been assigned to a security class yet!`,
				ZWaveErrorCodes.Security2CC_NotInitialized,
			);
		}
		const keys = this.networkKeys.get(this.groupClasses.get(group)!);
		if (!keys) {
			throw new ZWaveError(
				`The network keys for the security class of multicast group ${group} have not been set up yet!`,
				ZWaveErrorCodes.Security2CC_NotInitialized,
			);
		}

		// Compute the next MPAN
		const stateN = this.mpanStates.get(group)!;
		const ret = encryptAES128ECB(stateN, keys.keyMPAN);
		// Increment the inner state
		increment(stateN);
		return ret;
	}
}
