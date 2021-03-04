import {
	CommandClasses,
	computeMAC,
	decryptAES128OFB,
	encryptAES128OFB,
	generateAuthKey,
	generateEncryptionKey,
	getCCName,
	Maybe,
	MessageOrCCLogEntry,
	MessageRecord,
	parseCCList,
	SecurityManager,
	validatePayload,
	ZWaveError,
	ZWaveErrorCodes,
} from "@zwave-js/core";
import { buffer2hex, num2hex, pick } from "@zwave-js/shared";
import { randomBytes } from "crypto";
import type { ZWaveController } from "../controller/Controller";
import {
	SendDataRequest,
	TransmitOptions,
} from "../controller/SendDataMessages";
import type { Driver } from "../driver/Driver";
import { MessagePriority } from "../message/Constants";
import { PhysicalCCAPI } from "./API";
import {
	API,
	CCCommand,
	CCCommandOptions,
	CommandClass,
	commandClass,
	CommandClassDeserializationOptions,
	expectedCCResponse,
	gotDeserializationOptions,
	implementedVersion,
} from "./CommandClass";

// @noSetValueAPI This is an encapsulation CC

// All the supported commands
export enum SecurityCommand {
	CommandsSupportedGet = 0x02,
	CommandsSupportedReport = 0x03,
	SchemeGet = 0x04,
	SchemeReport = 0x05,
	SchemeInherit = 0x08,
	NetworkKeySet = 0x06,
	NetworkKeyVerify = 0x07,
	NonceGet = 0x40,
	NonceReport = 0x80,
	CommandEncapsulation = 0x81,
	CommandEncapsulationNonceGet = 0xc1,
}

function getAuthenticationData(
	senderNonce: Buffer,
	receiverNonce: Buffer,
	ccCommand: SecurityCommand,
	sendingNodeId: number,
	receivingNodeId: number,
	encryptedPayload: Buffer,
): Buffer {
	return Buffer.concat([
		senderNonce,
		receiverNonce,
		Buffer.from([
			ccCommand,
			sendingNodeId,
			receivingNodeId,
			encryptedPayload.length,
		]),
		encryptedPayload,
	]);
}

const HALF_NONCE_SIZE = 8;

// TODO: Ignore commands if received via multicast

@API(CommandClasses.Security)
export class SecurityCCAPI extends PhysicalCCAPI {
	public supportsCommand(_cmd: SecurityCommand): Maybe<boolean> {
		// All commands are mandatory
		return true;
	}

	public async sendEncapsulated(
		encapsulated: CommandClass,
		requestNextNonce: boolean = false,
	): Promise<void> {
		if (requestNextNonce) {
			this.assertSupportsCommand(
				SecurityCommand,
				SecurityCommand.CommandEncapsulation,
			);
		} else {
			this.assertSupportsCommand(
				SecurityCommand,
				SecurityCommand.CommandEncapsulationNonceGet,
			);
		}

		const cc = new (requestNextNonce
			? SecurityCCCommandEncapsulationNonceGet
			: SecurityCCCommandEncapsulation)(this.driver, {
			nodeId: this.endpoint.nodeId,
			encapsulated,
		});
		await this.driver.sendCommand(cc, this.commandOptions);
	}

	/**
	 * Requests a new nonce for Security CC encapsulation
	 */
	public async getNonce(
		options: {
			/** Whether the command should be sent as a standalone transaction. Default: false */
			standalone?: boolean;
			/** Whether the received nonce should be stored as "free". Default: false */
			storeAsFreeNonce?: boolean;
		} = {},
	): Promise<Buffer | undefined> {
		this.assertSupportsCommand(SecurityCommand, SecurityCommand.NonceGet);

		const { standalone = false, storeAsFreeNonce = false } = options;

		const cc = new SecurityCCNonceGet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
		});
		const response = await this.driver.sendCommand<SecurityCCNonceReport>(
			cc,
			{
				...this.commandOptions,
				// Standalone nonce requests must be handled immediately
				priority: standalone
					? MessagePriority.Normal
					: MessagePriority.PreTransmitHandshake,
				// Only try getting a nonce once
				maxSendAttempts: 1,
				// We don't want failures causing us to treat the node as asleep or dead
				// The "real" transaction will do that for us
				changeNodeStatusOnMissingACK: standalone,
			},
		);

		if (!response) return;

		const nonce = response.nonce;
		if (storeAsFreeNonce) {
			const secMan = this.driver.securityManager!;
			secMan.setNonce(
				{
					issuer: this.endpoint.nodeId,
					nonceId: secMan.getNonceId(nonce),
				},
				{ nonce, receiver: this.driver.controller.ownNodeId! },
				{ free: true },
			);
		}
		return nonce;
	}

	/**
	 * Responds to a NonceGet request. The message is sent without any retransmission etc.
	 * The return value indicates whether a nonce was successfully sent
	 */
	public async sendNonce(): Promise<boolean> {
		this.assertSupportsCommand(
			SecurityCommand,
			SecurityCommand.NonceReport,
		);

		if (!this.driver.securityManager) {
			throw new ZWaveError(
				`Nonces can only be sent if secure communication is set up!`,
				ZWaveErrorCodes.Driver_NoSecurity,
			);
		}

		const nonce = this.driver.securityManager.generateNonce(
			this.endpoint.nodeId,
			HALF_NONCE_SIZE,
		);
		const nonceId = this.driver.securityManager.getNonceId(nonce);

		const cc = new SecurityCCNonceReport(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
			nonce,
		});
		const msg = new SendDataRequest(this.driver, {
			command: cc,
			// Seems we need these options or some nodes won't accept the nonce
			transmitOptions: TransmitOptions.ACK | TransmitOptions.AutoRoute,
		});
		try {
			await this.driver.sendMessage(msg, {
				...this.commandOptions,
				priority: MessagePriority.Handshake,
			});
		} catch (e) {
			if (
				e instanceof ZWaveError &&
				(e.code === ZWaveErrorCodes.Controller_ResponseNOK ||
					e.code === ZWaveErrorCodes.Controller_CallbackNOK ||
					e.code === ZWaveErrorCodes.Controller_NodeTimeout ||
					e.code === ZWaveErrorCodes.Controller_MessageDropped)
			) {
				// The nonce could not be sent, invalidate it
				this.driver.securityManager.deleteNonce(nonceId);
				return false;
			} else {
				// Pass other errors through
				throw e;
			}
		}
		return true;
	}

	public async getSecurityScheme(): Promise<[0]> {
		this.assertSupportsCommand(SecurityCommand, SecurityCommand.SchemeGet);

		const cc = new SecurityCCSchemeGet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
		});
		await this.driver.sendCommand(cc, this.commandOptions);
		// There is only one scheme, so we hardcode it
		return [0];
	}

	public async inheritSecurityScheme(): Promise<void> {
		this.assertSupportsCommand(
			SecurityCommand,
			SecurityCommand.SchemeInherit,
		);

		const cc = new SecurityCCSchemeInherit(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
		});
		await this.driver.sendCommand(cc, this.commandOptions);
		// There is only one scheme, so we don't return anything here
	}

	public async setNetworkKey(networkKey: Buffer): Promise<void> {
		this.assertSupportsCommand(
			SecurityCommand,
			SecurityCommand.NetworkKeySet,
		);

		const keySet = new SecurityCCNetworkKeySet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
			networkKey,
		});
		const cc = new SecurityCCCommandEncapsulation(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
			encapsulated: keySet,
			alternativeNetworkKey: Buffer.alloc(16, 0),
		});
		await this.driver.sendCommand(cc, this.commandOptions);
	}

	// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
	public async getSupportedCommands() {
		this.assertSupportsCommand(
			SecurityCommand,
			SecurityCommand.CommandsSupportedGet,
		);

		const cc = new SecurityCCCommandsSupportedGet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
		});
		const response = await this.driver.sendCommand<SecurityCCCommandsSupportedReport>(
			cc,
			this.commandOptions,
		);
		if (response) {
			return pick(response, ["supportedCCs", "controlledCCs"]);
		}
	}
}

@commandClass(CommandClasses.Security)
@implementedVersion(1)
export class SecurityCC extends CommandClass {
	declare ccCommand: SecurityCommand;
	// Force singlecast for the Security CC (for now)
	declare nodeId: number;
	// Define the securityManager and controller.ownNodeId as existing
	declare driver: Driver & {
		securityManager: SecurityManager;
		controller: ZWaveController & {
			ownNodeId: number;
		};
	};

	public async interview(complete: boolean = true): Promise<void> {
		const node = this.getNode()!;
		const endpoint = this.getEndpoint()!;
		const api = endpoint.commandClasses.Security.withOptions({
			priority: MessagePriority.NodeQuery,
		});

		// This only needs to be done once
		if (complete) {
			this.driver.controllerLog.logNode(node.id, {
				message: "querying securely supported commands...",
				direction: "outbound",
			});

			const resp = await api.getSupportedCommands();
			if (!resp) {
				if (node.isSecure === true) {
					this.driver.controllerLog.logNode(node.id, {
						endpoint: this.endpointIndex,
						message:
							"Querying securely supported commands timed out, skipping Security interview...",
						level: "warn",
					});
					// TODO: Abort interview?
				} else {
					// We didn't know if the node was secure, assume that it is not actually included securely
					this.driver.controllerLog.logNode(
						node.id,
						`The node is not included securely. Continuing interview non-securely.`,
					);
					node.isSecure = false;
				}
				return;
			}

			const logLines: string[] = [
				"received secure commands",
				"supported CCs:",
			];
			for (const cc of resp.supportedCCs) {
				logLines.push(`· ${getCCName(cc)}`);
			}
			logLines.push("controlled CCs:");
			for (const cc of resp.controlledCCs) {
				logLines.push(`· ${getCCName(cc)}`);
			}
			this.driver.controllerLog.logNode(node.id, {
				message: logLines.join("\n"),
				direction: "inbound",
			});

			// Remember which commands are supported securely
			for (const cc of resp.supportedCCs) {
				endpoint.addCC(cc, {
					isSupported: true,
					secure: true,
				});
			}
			for (const cc of resp.controlledCCs) {
				endpoint.addCC(cc, {
					isControlled: true,
					secure: true,
				});
			}

			// We know for sure that the node is included securely
			if (node.isSecure !== true) {
				node.isSecure = true;
				this.driver.controllerLog.logNode(
					node.id,
					`The node is included securely.`,
				);
			}

			// Remember that the interview is complete
			this.interviewComplete = true;
		}
	}

	/** Tests if a should be sent secure and thus requires encapsulation */
	public static requiresEncapsulation(cc: CommandClass): boolean {
		return (
			cc.secure &&
			// Already encapsulated (SecurityCCCommandEncapsulationNonceGet is a subclass)
			!(cc instanceof SecurityCCCommandEncapsulation) &&
			// Cannot be sent encapsulated
			!(cc instanceof SecurityCCNonceGet) &&
			!(cc instanceof SecurityCCNonceReport) &&
			!(cc instanceof SecurityCCSchemeGet) &&
			!(cc instanceof SecurityCCSchemeReport)
		);
	}

	/** Encapsulates a command that should be sent encrypted */
	public static encapsulate(
		driver: Driver,
		cc: CommandClass,
	): SecurityCCCommandEncapsulation {
		// TODO: When to return a SecurityCCCommandEncapsulationNonceGet?
		return new SecurityCCCommandEncapsulation(driver, {
			nodeId: cc.nodeId,
			encapsulated: cc,
		});
	}
}

interface SecurityCCNonceReportOptions extends CCCommandOptions {
	nonce: Buffer;
}

@CCCommand(SecurityCommand.NonceReport)
export class SecurityCCNonceReport extends SecurityCC {
	constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| SecurityCCNonceReportOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			validatePayload.withReason("Invalid nonce length")(
				this.payload.length === HALF_NONCE_SIZE,
			);
			this.nonce = this.payload;
		} else {
			if (options.nonce.length !== HALF_NONCE_SIZE) {
				throw new ZWaveError(
					`Nonce must have length ${HALF_NONCE_SIZE}!`,
					ZWaveErrorCodes.Argument_Invalid,
				);
			}
			this.nonce = options.nonce;
		}
	}

	// @noCCValues The nonce is only used temporary
	public nonce: Buffer;

	public serialize(): Buffer {
		this.payload = this.nonce;
		return super.serialize();
	}

	public toLogEntry(): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(),
			message: { nonce: buffer2hex(this.nonce) },
		};
	}
}

@CCCommand(SecurityCommand.NonceGet)
@expectedCCResponse(SecurityCCNonceReport)
export class SecurityCCNonceGet extends SecurityCC {}

interface SecurityCCCommandEncapsulationOptions extends CCCommandOptions {
	encapsulated: CommandClass;
	alternativeNetworkKey?: Buffer;
}

function getCCResponseForCommandEncapsulation(
	sent: SecurityCCCommandEncapsulation,
) {
	if (sent.encapsulated.expectsCCResponse()) {
		return SecurityCCCommandEncapsulation;
	}
}

@CCCommand(SecurityCommand.CommandEncapsulation)
@expectedCCResponse(
	getCCResponseForCommandEncapsulation,
	() => "checkEncapsulated",
)
export class SecurityCCCommandEncapsulation extends SecurityCC {
	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| SecurityCCCommandEncapsulationOptions,
	) {
		super(driver, options);

		if (!(this.driver.controller.ownNodeId as unknown)) {
			throw new ZWaveError(
				`Secure commands can can only be sent when the controller's node id is known!`,
				ZWaveErrorCodes.Driver_NotReady,
			);
		} else if (!(this.driver.securityManager as unknown)) {
			throw new ZWaveError(
				`Secure commands can only be sent when the network key for the driver is set`,
				ZWaveErrorCodes.Driver_NoSecurity,
			);
		}

		if (gotDeserializationOptions(options)) {
			// HALF_NONCE_SIZE bytes iv, 1 byte frame control, at least 1 CC byte, 1 byte nonce id, 8 bytes auth code
			validatePayload(
				this.payload.length >= HALF_NONCE_SIZE + 1 + 1 + 1 + 8,
			);
			const iv = this.payload.slice(0, HALF_NONCE_SIZE);
			const encryptedPayload = this.payload.slice(HALF_NONCE_SIZE, -9);
			const nonceId = this.payload[this.payload.length - 9];
			const authCode = this.payload.slice(-8);

			// Retrieve the used nonce from the nonce store
			const nonce = this.driver.securityManager.getNonce(nonceId);
			// Only accept the message if the nonce hasn't expired
			validatePayload.withReason(
				`Nonce ${num2hex(
					nonceId,
				)} expired, cannot decode security encapsulated command.`,
			)(!!nonce);
			// and mark the nonce as used
			this.driver.securityManager.deleteNonce(nonceId);

			this.authKey = this.driver.securityManager.authKey;
			this.encryptionKey = this.driver.securityManager.encryptionKey;

			// Validate the encrypted data
			const authData = getAuthenticationData(
				iv,
				nonce!,
				this.ccCommand,
				this.nodeId,
				this.driver.controller.ownNodeId,
				encryptedPayload,
			);
			const expectedAuthCode = computeMAC(authData, this.authKey);
			// Only accept messages with a correct auth code
			validatePayload.withReason(
				"Invalid auth code, won't accept security encapsulated command.",
			)(authCode.equals(expectedAuthCode));

			// Decrypt the encapsulated CC
			const frameControlAndDecryptedCC = decryptAES128OFB(
				encryptedPayload,
				this.encryptionKey,
				Buffer.concat([iv, nonce!]),
			);
			const frameControl = frameControlAndDecryptedCC[0];
			this.sequenceCounter = frameControl & 0b1111;
			this.sequenced = !!(frameControl & 0b1_0000);
			this.secondFrame = !!(frameControl & 0b10_0000);

			this.decryptedCCBytes = frameControlAndDecryptedCC.slice(1);
		} else {
			this.encapsulated = options.encapsulated;
			options.encapsulated.encapsulatingCC = this as any;
			if (options.alternativeNetworkKey) {
				this.authKey = generateAuthKey(options.alternativeNetworkKey);
				this.encryptionKey = generateEncryptionKey(
					options.alternativeNetworkKey,
				);
			} else {
				this.authKey = this.driver.securityManager.authKey;
				this.encryptionKey = this.driver.securityManager.encryptionKey;
			}
		}
	}

	private sequenced: boolean | undefined;
	private secondFrame: boolean | undefined;
	private sequenceCounter: number | undefined;

	private decryptedCCBytes: Buffer | undefined;
	public encapsulated!: CommandClass;

	private authKey: Buffer;
	private encryptionKey: Buffer;
	public nonceId: number | undefined;

	public getPartialCCSessionId(): Record<string, any> | undefined {
		if (this.sequenced) {
			return {
				// Treat Encapsulation and EncapsulationNonceGet as one
				ccCommand: undefined,
				sequence: this.sequenceCounter,
			};
		} else {
			return {
				// Treat Encapsulation and EncapsulationNonceGet as one
				ccCommand: undefined,
			};
		}
	}

	public expectMoreMessages(): boolean {
		return !!this.sequenced && !this.secondFrame;
	}

	public mergePartialCCs(partials: SecurityCCCommandEncapsulation[]): void {
		// Concat the CC buffers
		this.decryptedCCBytes = Buffer.concat(
			[...partials, this].map((cc) => cc.decryptedCCBytes!),
		);
		// make sure this contains a complete CC command that's worth splitting
		validatePayload(this.decryptedCCBytes.length >= 2);
		// and deserialize the CC
		this.encapsulated = CommandClass.from(this.driver, {
			data: this.decryptedCCBytes,
			fromEncapsulation: true,
			encapCC: this,
		});
	}

	public requiresPreTransmitHandshake(): boolean {
		// We require a new nonce if there is no free one,
		// we don't have one yet or if the old one has expired
		const secMan = this.driver.securityManager;

		// If the nonce is already known we don't need a handshake
		if (
			this.nonceId != undefined &&
			secMan.hasNonce({
				issuer: this.nodeId,
				nonceId: this.nonceId,
			})
		) {
			return false;
		}

		// Try to get a free nonce before requesting a new one
		const freeNonce = secMan.getFreeNonce(this.nodeId);
		if (freeNonce) {
			this.nonceId = secMan.getNonceId(freeNonce);
			return false;
		}

		return true;
	}

	public async preTransmitHandshake(): Promise<void> {
		// Request a nonce
		const nonce = await this.getNode()!.commandClasses.Security.getNonce();
		// TODO: Handle this more intelligent
		if (nonce) {
			// and store it
			const secMan = this.driver.securityManager;
			this.nonceId = secMan.getNonceId(nonce);
			secMan.setNonce(
				{
					issuer: this.nodeId,
					nonceId: this.nonceId,
				},
				{ nonce, receiver: this.driver.controller.ownNodeId },
				// The nonce is reserved for this command
				{ free: false },
			);
		}
	}

	public serialize(): Buffer {
		function throwNoNonce(): never {
			throw new ZWaveError(
				`Security CC requires a nonce to be sent!`,
				ZWaveErrorCodes.SecurityCC_NoNonce,
			);
		}

		// Try to find an active nonce
		if (this.nonceId == undefined) throwNoNonce();
		const receiverNonce = this.driver.securityManager.getNonce({
			issuer: this.nodeId,
			nonceId: this.nonceId,
		});
		if (!receiverNonce) throwNoNonce();
		// and mark it as used
		this.driver.securityManager.deleteNonce({
			issuer: this.nodeId,
			nonceId: this.nonceId,
		});

		const serializedCC = this.encapsulated.serialize();
		const plaintext = Buffer.concat([
			Buffer.from([0]), // TODO: frame control
			serializedCC,
		]);
		// Encrypt the payload
		const senderNonce = randomBytes(HALF_NONCE_SIZE);
		const iv = Buffer.concat([senderNonce, receiverNonce]);
		const ciphertext = encryptAES128OFB(plaintext, this.encryptionKey, iv);
		// And generate the auth code
		const authData = getAuthenticationData(
			senderNonce,
			receiverNonce,
			this.ccCommand,
			this.driver.controller.ownNodeId,
			this.nodeId,
			ciphertext,
		);
		const authCode = computeMAC(authData, this.authKey);

		this.payload = Buffer.concat([
			senderNonce,
			ciphertext,
			Buffer.from([this.nonceId]),
			authCode,
		]);
		return super.serialize();
	}

	protected computeEncapsulationOverhead(): number {
		// Security CC adds 8 bytes IV, 1 byte frame control, 1 byte nonce ID, 8 bytes MAC
		return super.computeEncapsulationOverhead() + 18;
	}

	public toLogEntry(): MessageOrCCLogEntry {
		const message: MessageRecord = {};
		if (this.nonceId != undefined) {
			message["nonce id"] = this.nonceId;
		}
		if (this.sequenced != undefined) {
			message.sequenced = this.sequenced;
			if (this.sequenced) {
				if (this.secondFrame != undefined) {
					message["second frame"] = this.secondFrame;
				}
				if (this.sequenceCounter != undefined) {
					message["sequence counter"] = this.sequenceCounter;
				}
			}
		}
		return {
			...super.toLogEntry(),
			message,
		};
	}
}

// This is the same message, but with another CC command
@CCCommand(SecurityCommand.CommandEncapsulationNonceGet)
export class SecurityCCCommandEncapsulationNonceGet extends SecurityCCCommandEncapsulation {}

@CCCommand(SecurityCommand.SchemeReport)
export class SecurityCCSchemeReport extends SecurityCC {
	// @noCCValues This CC has no values

	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);
		validatePayload(
			this.payload.length >= 1,
			// Since it is unlikely that any more schemes will be added to S0, we hardcode the default scheme here (bit 0 = 0)
			(this.payload[0] & 0b1) === 0,
		);
	}
}

@CCCommand(SecurityCommand.SchemeGet)
@expectedCCResponse(SecurityCCSchemeReport)
export class SecurityCCSchemeGet extends SecurityCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions | CCCommandOptions,
	) {
		super(driver, options);
		// Don't care, we won't get sent this and we have no options
	}

	public serialize(): Buffer {
		// Since it is unlikely that any more schemes will be added to S0, we hardcode the default scheme here (bit 0 = 0)
		this.payload = Buffer.from([0]);
		return super.serialize();
	}

	public toLogEntry(): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(),
			// Hide the default payload line
			message: undefined,
		};
	}
}

@CCCommand(SecurityCommand.SchemeInherit)
@expectedCCResponse(SecurityCCSchemeReport)
export class SecurityCCSchemeInherit extends SecurityCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions | CCCommandOptions,
	) {
		super(driver, options);
		// Don't care, we won't get sent this and we have no options
	}

	public serialize(): Buffer {
		// Since it is unlikely that any more schemes will be added to S0, we hardcode the default scheme here (bit 0 = 0)
		this.payload = Buffer.from([0]);
		return super.serialize();
	}

	public toLogEntry(): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(),
			// Hide the default payload line
			message: undefined,
		};
	}
}

@CCCommand(SecurityCommand.NetworkKeyVerify)
export class SecurityCCNetworkKeyVerify extends SecurityCC {}

interface SecurityCCNetworkKeySetOptions extends CCCommandOptions {
	networkKey: Buffer;
}

@CCCommand(SecurityCommand.NetworkKeySet)
@expectedCCResponse(SecurityCCNetworkKeyVerify)
export class SecurityCCNetworkKeySet extends SecurityCC {
	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| SecurityCCNetworkKeySetOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			// TODO: Deserialize payload
			throw new ZWaveError(
				`${this.constructor.name}: deserialization not implemented`,
				ZWaveErrorCodes.Deserialization_NotImplemented,
			);
		} else {
			if (options.networkKey.length !== 16) {
				throw new ZWaveError(
					`The network key must have length 16!`,
					ZWaveErrorCodes.Argument_Invalid,
				);
			}
			this.networkKey = options.networkKey;
		}
	}

	public networkKey: Buffer;

	public serialize(): Buffer {
		this.payload = this.networkKey;
		return super.serialize();
	}

	public toLogEntry(): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(),
			message: { "network key": buffer2hex(this.networkKey) },
		};
	}
}

@CCCommand(SecurityCommand.CommandsSupportedReport)
export class SecurityCCCommandsSupportedReport extends SecurityCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);
		validatePayload(this.payload.length >= 1);
		this.reportsToFollow = this.payload[0];
		const list = parseCCList(this.payload.slice(1));
		this._supportedCCs = list.supportedCCs;
		this._controlledCCs = list.controlledCCs;
	}

	public readonly reportsToFollow: number;

	public getPartialCCSessionId(): Record<string, any> | undefined {
		// Nothing special we can distinguish sessions with
		return {};
	}

	public expectMoreMessages(): boolean {
		return this.reportsToFollow > 0;
	}

	private _supportedCCs: CommandClasses[];
	public get supportedCCs(): CommandClasses[] {
		return this._supportedCCs;
	}

	private _controlledCCs: CommandClasses[];
	public get controlledCCs(): CommandClasses[] {
		return this._controlledCCs;
	}

	public mergePartialCCs(
		partials: SecurityCCCommandsSupportedReport[],
	): void {
		// Concat the lists of CCs
		this._supportedCCs = [...partials, this]
			.map((report) => report._supportedCCs)
			.reduce((prev, cur) => prev.concat(...cur), []);
		this._controlledCCs = [...partials, this]
			.map((report) => report._controlledCCs)
			.reduce((prev, cur) => prev.concat(...cur), []);
	}

	public toLogEntry(): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(),
			message: {
				reportsToFollow: this.reportsToFollow,
				supportedCCs: this._supportedCCs
					.map((cc) => getCCName(cc))
					.map((cc) => `\n· ${cc}`)
					.join(""),
				controlledCCs: this._controlledCCs
					.map((cc) => getCCName(cc))
					.map((cc) => `\n· ${cc}`)
					.join(""),
			},
		};
	}
}

@CCCommand(SecurityCommand.CommandsSupportedGet)
@expectedCCResponse(SecurityCCCommandsSupportedReport)
export class SecurityCCCommandsSupportedGet extends SecurityCC {}
