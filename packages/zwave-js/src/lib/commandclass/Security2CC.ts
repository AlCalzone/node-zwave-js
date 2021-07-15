import {
	CommandClasses,
	encodeBitMask,
	parseBitMask,
	parseCCList,
	SecurityClasses,
	validatePayload,
	ZWaveError,
	ZWaveErrorCodes,
} from "@zwave-js/core";
import type { Driver } from "../driver/Driver";
import {
	CCCommand,
	CCCommandOptions,
	CommandClass,
	commandClass,
	CommandClassDeserializationOptions,
	expectedCCResponse,
	gotDeserializationOptions,
	implementedVersion,
} from "./CommandClass";

// All the supported commands
export enum Security2Command {
	NonceGet = 0x01,
	NonceReport = 0x02,
	MessageEncapsulation = 0x03,
	KEXGet = 0x04,
	KEXReport = 0x05,
	KEXSet = 0x06,
	KEXFail = 0x07,
	PublicKeyReport = 0x08,
	NetworkKeyGet = 0x09,
	NetworkKeyReport = 0x0a,
	NetworkKeyVerify = 0x0b,
	TransferEnd = 0x0c,
	CommandsSupportedGet = 0x0d,
	CommandsSupportedReport = 0x0e,
}

export enum KEXSchemes {
	KEXScheme1 = 1,
}

export enum ECDHProfiles {
	Curve25519 = 0,
}

export enum KEXFailType {
	NoKeyMatch = 0x01, // KEX_KEY
	NoSupportedScheme = 0x02, // KEX_SCHEME
	NoSupportedCurve = 0x03, // KEX_CURVES
	Decrypt = 0x05,
	BootstrappingCanceled = 0x06, // CANCEL
	WrongSecurityLevel = 0x07, // AUTH
	KeyNotGranted = 0x08, // GET
	NoVerify = 0x09, // VERIFY
	DifferentKey = 0x0a, // REPORT
}

function securityClassToBitMask(key: SecurityClasses): Buffer {
	return encodeBitMask(
		[key],
		SecurityClasses.S0_Legacy,
		SecurityClasses.S2_Unauthenticated,
	);
}

function bitMaskToSecurityClass(
	buffer: Buffer,
	offset: number,
): SecurityClasses {
	const keys = parseBitMask(
		buffer.slice(offset, offset + 1),
		SecurityClasses.S2_Unauthenticated,
	);
	validatePayload(keys.length === 1);
	return keys[0];
}

@commandClass(CommandClasses["Security 2"])
@implementedVersion(1)
export class Security2CC extends CommandClass {
	declare ccCommand: Security2Command;
}

type Security2CCNonceReportOptions = CCCommandOptions & {
	sequenceNumber: number;
	MOS: boolean;
} & (
		| {
				SOS: true;
				receiverEI: Buffer;
		  }
		| {
				SOS: false;
				receiverEI?: undefined;
		  }
	);

@CCCommand(Security2Command.NonceReport)
export class Security2CCNonceReport extends Security2CC {
	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| Security2CCNonceReportOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			validatePayload(this.payload.length >= 2);
			this.sequenceNumber = this.payload[0];
			this.MOS = !!(this.payload[1] & 0b10);
			this.SOS = !!(this.payload[1] & 0b1);

			if (this.SOS) {
				// If the SOS flag is set, the REI field MUST be included in the command
				validatePayload(this.payload.length >= 18);
				this.receiverEI = this.payload.slice(2, 18);
			}
		} else {
			this.sequenceNumber = options.sequenceNumber;
			this.SOS = options.SOS;
			this.MOS = options.MOS;
			if (options.SOS) this.receiverEI = options.receiverEI;
		}
	}

	public readonly sequenceNumber: number;
	public readonly SOS: boolean;
	public readonly MOS: boolean;
	public readonly receiverEI?: Buffer;

	public serialize(): Buffer {
		this.payload = Buffer.from([
			this.sequenceNumber,
			(this.MOS ? 0b10 : 0) + (this.SOS ? 0b1 : 0),
		]);
		if (this.SOS) {
			this.payload = Buffer.concat([this.payload, this.receiverEI!]);
		}
		return super.serialize();
	}
}

interface Security2CCNonceGetOptions extends CCCommandOptions {
	sequenceNumber: number;
}

@CCCommand(Security2Command.NonceGet)
@expectedCCResponse(Security2CCNonceReport)
export class Security2CCNonceGet extends Security2CC {
	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| Security2CCNonceGetOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			validatePayload(this.payload.length >= 1);
			this.sequenceNumber = this.payload[0];
		} else {
			this.sequenceNumber = options.sequenceNumber;
		}
	}

	public sequenceNumber: number;

	public serialize(): Buffer {
		this.payload = Buffer.from([this.sequenceNumber]);
		return super.serialize();
	}
}

@CCCommand(Security2Command.KEXReport)
export class Security2CCKEXReport extends Security2CC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);
		validatePayload(this.payload.length >= 4);
		this.requestCSA = !!(this.payload[0] & 0b10);
		this.echo = !!(this.payload[0] & 0b1);
		this.supportedKEXSchemes = parseBitMask(this.payload.slice(1, 2), 0);
		this.supportedECDHProfiles = parseBitMask(
			this.payload.slice(2, 3),
			ECDHProfiles.Curve25519,
		);
		this.requestedKeys = parseBitMask(
			this.payload.slice(3, 4),
			SecurityClasses.S2_Unauthenticated,
		);
	}

	public readonly requestCSA: boolean;
	public readonly echo: boolean;
	public readonly supportedKEXSchemes: readonly KEXSchemes[];
	public readonly supportedECDHProfiles: readonly ECDHProfiles[];
	public readonly requestedKeys: readonly SecurityClasses[];
}

@CCCommand(Security2Command.KEXGet)
@expectedCCResponse(Security2CCKEXReport)
export class Security2CCKEXGet extends Security2CC {}

interface Security2CCKEXSetOptions extends CCCommandOptions {
	requestCSA: boolean;
	echo: boolean;
	supportedKEXSchemes: KEXSchemes[];
	supportedECDHProfiles: ECDHProfiles[];
	requestedKeys: SecurityClasses[];
}

@CCCommand(Security2Command.KEXSet)
export class Security2CCKEXSet extends Security2CC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions | Security2CCKEXSetOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			// TODO: Deserialize payload
			throw new ZWaveError(
				`${this.constructor.name}: deserialization not implemented`,
				ZWaveErrorCodes.Deserialization_NotImplemented,
			);
		} else {
			this.requestCSA = options.requestCSA;
			this.echo = options.echo;
			this.selectedKEXSchemes = options.supportedKEXSchemes;
			this.selectedECDHProfiles = options.supportedECDHProfiles;
			this.grantedKeys = options.requestedKeys;
		}
	}

	public requestCSA: boolean;
	public echo: boolean;
	public selectedKEXSchemes: KEXSchemes[];
	public selectedECDHProfiles: ECDHProfiles[];
	public grantedKeys: SecurityClasses[];

	public serialize(): Buffer {
		this.payload = Buffer.concat([
			Buffer.from([(this.requestCSA ? 0b10 : 0) + (this.echo ? 0b1 : 0)]),
			encodeBitMask(this.selectedKEXSchemes, 8, KEXSchemes.KEXScheme1),
			encodeBitMask(
				this.selectedECDHProfiles,
				7,
				ECDHProfiles.Curve25519,
			),
			encodeBitMask(
				this.grantedKeys,
				SecurityClasses.S0_Legacy,
				SecurityClasses.S2_Unauthenticated,
			),
		]);
		return super.serialize();
	}
}

interface Security2CCKEXFailOptions extends CCCommandOptions {
	failType: KEXFailType;
}

@CCCommand(Security2Command.KEXFail)
export class Security2CCKEXFail extends Security2CC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions | Security2CCKEXFailOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			validatePayload(this.payload.length >= 1);
			this.failType = this.payload[0];
		} else {
			this.failType = options.failType;
		}
	}

	public failType: KEXFailType;

	public serialize(): Buffer {
		this.payload = Buffer.from([this.failType]);
		return super.serialize();
	}
}

interface Security2CCPublicKeyReportOptions extends CCCommandOptions {
	includingNode: boolean;
	publicKey: Buffer;
}

@CCCommand(Security2Command.PublicKeyReport)
export class Security2CCPublicKeyReport extends Security2CC {
	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| Security2CCPublicKeyReportOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			validatePayload(this.payload.length >= 17);
			this.includingNode = !!(this.payload[0] & 0b1);
			this.publicKey = this.payload.slice(1);
		} else {
			this.includingNode = options.includingNode;
			this.publicKey = options.publicKey;
		}
	}

	public includingNode: boolean;
	public publicKey: Buffer;

	public serialize(): Buffer {
		this.payload = Buffer.concat([
			Buffer.from([this.includingNode ? 1 : 0]),
			this.publicKey,
		]);
		return super.serialize();
	}
}

interface Security2CCNetworkKeyReportOptions extends CCCommandOptions {
	grantedKey: SecurityClasses;
	networkKey: Buffer;
}

@CCCommand(Security2Command.NetworkKeyReport)
export class Security2CCNetworkKeyReport extends Security2CC {
	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| Security2CCNetworkKeyReportOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			// TODO: Deserialize payload
			throw new ZWaveError(
				`${this.constructor.name}: deserialization not implemented`,
				ZWaveErrorCodes.Deserialization_NotImplemented,
			);
		} else {
			this.grantedKey = options.grantedKey;
			this.networkKey = options.networkKey;
		}
	}

	public grantedKey: SecurityClasses;
	public networkKey: Buffer;

	public serialize(): Buffer {
		this.payload = Buffer.concat([
			securityClassToBitMask(this.grantedKey),
			this.networkKey,
		]);
		return super.serialize();
	}
}

interface Security2CCNetworkKeyGetOptions extends CCCommandOptions {
	requestedKey: SecurityClasses;
}

@CCCommand(Security2Command.NetworkKeyGet)
@expectedCCResponse(Security2CCNetworkKeyReport)
export class Security2CCNetworkKeyGet extends Security2CC {
	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| Security2CCNetworkKeyGetOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			validatePayload(this.payload.length >= 1);
			this.requestedKey = bitMaskToSecurityClass(this.payload, 0);
		} else {
			this.requestedKey = options.requestedKey;
		}
	}

	public requestedKey: SecurityClasses;

	public serialize(): Buffer {
		this.payload = securityClassToBitMask(this.requestedKey);
		return super.serialize();
	}
}

@CCCommand(Security2Command.NetworkKeyVerify)
export class Security2CCNetworkKeyVerify extends Security2CC {}

interface Security2CCTransferEndOptions extends CCCommandOptions {
	keyVerified: boolean;
	keyRequestComplete: boolean;
}

@CCCommand(Security2Command.TransferEnd)
export class Security2CCTransferEnd extends Security2CC {
	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| Security2CCTransferEndOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			validatePayload(this.payload.length >= 1);
			this.keyVerified = !!(this.payload[0] & 0b10);
			this.keyRequestComplete = !!(this.payload[0] & 0b1);
		} else {
			this.keyVerified = options.keyVerified;
			this.keyRequestComplete = options.keyRequestComplete;
		}
	}

	public keyVerified: boolean;
	public keyRequestComplete: boolean;

	public serialize(): Buffer {
		this.payload = Buffer.from([
			(this.keyVerified ? 0b10 : 0) + (this.keyRequestComplete ? 0b1 : 0),
		]);
		return super.serialize();
	}
}

@CCCommand(Security2Command.CommandsSupportedReport)
export class Security2CCCommandsSupportedReport extends Security2CC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);
		const CCs = parseCCList(this.payload);

		// SDS13783: A sending node MAY terminate the list of supported command classes with the
		// COMMAND_CLASS_MARK command class identifier.
		// A receiving node MUST stop parsing the list of supported command classes if it detects the
		// COMMAND_CLASS_MARK command class identifier in the Security 2 Commands Supported Report
		this.supportedCCs = CCs.supportedCCs;
	}

	public readonly supportedCCs: CommandClasses[];
}

@CCCommand(Security2Command.CommandsSupportedGet)
@expectedCCResponse(Security2CCCommandsSupportedReport)
export class Security2CCCommandsSupportedGet extends Security2CC {}
