import * as crypto from "crypto";
import { ZWaveErrorCodes } from "../error/ZWaveError";
import { assertZWaveError } from "../test/assertZWaveError";
import { SecurityClasses } from "./constants";
import { SecurityManager2 } from "./Manager2";

describe("lib/security/Manager2", () => {
	// beforeAll(() => {
	// 	jest.useFakeTimers();
	// });

	// afterAll(() => {
	// 	jest.clearAllTimers();
	// 	jest.useRealTimers();
	// });

	function dummyInit(
		man: SecurityManager2,
		options: {
			keys?: boolean;
			nodeId?: number;
			secClass?: SecurityClasses;
			multicastGroup?: number;
		} = {},
	): void {
		if (options.keys !== false) {
			man.setKey(SecurityClasses.S0_Legacy, crypto.randomBytes(16));
			man.setKey(
				SecurityClasses.S2_AccessControl,
				crypto.randomBytes(16),
			);
			man.setKey(
				SecurityClasses.S2_Authenticated,
				crypto.randomBytes(16),
			);
			man.setKey(
				SecurityClasses.S2_Unauthenticated,
				crypto.randomBytes(16),
			);
		}
		if (options.nodeId) {
			man.assignSecurityClassSinglecast(
				options.nodeId,
				options.secClass ?? SecurityClasses.S2_Authenticated,
			);
			man.initializeSPAN(
				options.nodeId,
				crypto.randomBytes(16),
				crypto.randomBytes(16),
			);
		}
		if (options.multicastGroup) {
			man.assignSecurityClassMulticast(
				options.multicastGroup,
				options.secClass ?? SecurityClasses.S2_Authenticated,
			);
			man.initializeMPAN(options.multicastGroup);
		}
	}

	describe("nextNonce", () => {
		it("should throw if the PRNG for the given receiver node has not been initialized", () => {
			const man = new SecurityManager2();
			assertZWaveError(() => man.nextNonce(2), {
				errorCode: ZWaveErrorCodes.Security2CC_NotInitialized,
				messageMatches: "initialized",
			});
		});

		it("should generate a 13-byte nonce otherwise", () => {
			const man = new SecurityManager2();
			dummyInit(man, { nodeId: 2 });

			const ret = man.nextNonce(2);
			expect(Buffer.isBuffer(ret)).toBeTrue();
			expect(ret.length).toBe(13);
		});

		it("two nonces should be different", () => {
			const man = new SecurityManager2();
			dummyInit(man, { nodeId: 2 });

			const nonce1 = man.nextNonce(2);
			const nonce2 = man.nextNonce(2);
			expect(nonce1).not.toEqual(nonce2);
		});
	});

	describe("initializeSPAN", () => {
		it("should throw if either entropy input does not have length 16", () => {
			const man = new SecurityManager2();
			assertZWaveError(
				() => man.initializeSPAN(2, Buffer.alloc(15), Buffer.alloc(16)),
				{
					errorCode: ZWaveErrorCodes.Argument_Invalid,
					messageMatches: "16 bytes",
				},
			);

			assertZWaveError(
				() => man.initializeSPAN(2, Buffer.alloc(16), Buffer.alloc(1)),
				{
					errorCode: ZWaveErrorCodes.Argument_Invalid,
					messageMatches: "16 bytes",
				},
			);
		});

		it("should throw if the node has not been assigned to a security class", () => {
			const man = new SecurityManager2();
			assertZWaveError(
				() => man.initializeSPAN(2, Buffer.alloc(16), Buffer.alloc(16)),
				{
					errorCode: ZWaveErrorCodes.Security2CC_NotInitialized,
					messageMatches: "security class",
				},
			);
		});

		it("should throw if the keys for the node's security class have not been set up", () => {
			const man = new SecurityManager2();
			man.assignSecurityClassSinglecast(
				2,
				SecurityClasses.S2_Authenticated,
			);
			assertZWaveError(
				() => man.initializeSPAN(2, Buffer.alloc(16), Buffer.alloc(16)),
				{
					errorCode: ZWaveErrorCodes.Security2CC_NotInitialized,
					messageMatches: "network key",
				},
			);
		});

		it("should not throw otherwise", () => {
			const man = new SecurityManager2();
			dummyInit(man, { nodeId: 2 });
			expect(() =>
				man.initializeSPAN(2, Buffer.alloc(16), Buffer.alloc(16)),
			).not.toThrow();
		});
	});

	describe("setKeys", () => {
		it("throws if the network key does not have length 16", () => {
			const man = new SecurityManager2();
			assertZWaveError(
				() =>
					man.setKey(
						SecurityClasses.S2_Authenticated,
						Buffer.alloc(15),
					),
				{
					errorCode: ZWaveErrorCodes.Argument_Invalid,
					messageMatches: "16 bytes",
				},
			);
		});

		it("throws if the security class is not valid", () => {
			const man = new SecurityManager2();
			assertZWaveError(() => man.setKey(-1 as any, Buffer.alloc(16)), {
				errorCode: ZWaveErrorCodes.Argument_Invalid,
				messageMatches: "security class",
			});
		});
	});

	describe("nextMPAN", () => {
		it("should throw if the MPAN state for the given multicast group has not been initialized", () => {
			const man = new SecurityManager2();
			assertZWaveError(() => man.nextMPAN(1), {
				errorCode: ZWaveErrorCodes.Security2CC_NotInitialized,
				messageMatches: "initialized",
			});
		});

		it("should throw if the multicast group has not been assigned to a security class", () => {
			const man = new SecurityManager2();
			man.initializeMPAN(1);
			assertZWaveError(() => man.nextMPAN(1), {
				errorCode: ZWaveErrorCodes.Security2CC_NotInitialized,
				messageMatches: "security class",
			});
		});

		it("should throw if the keys for the group's security class have not been set up", () => {
			const man = new SecurityManager2();
			man.assignSecurityClassMulticast(
				1,
				SecurityClasses.S2_Authenticated,
			);
			man.initializeMPAN(1);
			assertZWaveError(() => man.nextMPAN(1), {
				errorCode: ZWaveErrorCodes.Security2CC_NotInitialized,
				messageMatches: "network key",
			});
		});

		it("should generate a 16-byte buffer otherwise", () => {
			const man = new SecurityManager2();
			dummyInit(man, { multicastGroup: 1 });
			const ret = man.nextMPAN(1);

			expect(Buffer.isBuffer(ret)).toBeTrue();
			expect(ret.length).toBe(16);
		});

		it("two nonces should be different", () => {
			const man = new SecurityManager2();
			dummyInit(man, { multicastGroup: 2 });

			const nonce1 = man.nextMPAN(2);
			const nonce2 = man.nextMPAN(2);
			expect(nonce1).not.toEqual(nonce2);
		});
	});
});
