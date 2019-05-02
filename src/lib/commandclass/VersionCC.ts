import { SendDataRequest } from "../controller/SendDataMessages";
import { ZWaveLibraryTypes } from "../controller/ZWaveLibraryTypes";
import { IDriver } from "../driver/IDriver";
import { ZWaveError, ZWaveErrorCodes } from "../error/ZWaveError";
import { MessagePriority } from "../message/Constants";
import { ZWaveNode } from "../node/Node";
import { Maybe } from "../values/Primitive";
import {
	CCCommand,
	CCCommandOptions,
	ccValue,
	CommandClass,
	commandClass,
	CommandClassDeserializationOptions,
	expectedCCResponse,
	gotDeserializationOptions,
	implementedVersion,
	StateKind,
} from "./CommandClass";
import { CommandClasses } from "./CommandClasses";

export enum VersionCommand {
	Get = 0x11,
	Report = 0x12,
	CommandClassGet = 0x13,
	CommandClassReport = 0x14,
	CapabilitiesGet = 0x15,
	CapabilitiesReport = 0x16,
	ZWaveSoftwareGet = 0x17,
	ZWaveSoftwareReport = 0x18,
}

function parseVersion(buffer: Buffer): string {
	if (buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 0) return "unused";
	return `${buffer[0]}.${buffer[1]}.${buffer[2]}`;
}

@commandClass(CommandClasses.Version)
@implementedVersion(3)
export class VersionCC extends CommandClass {
	public ccCommand!: VersionCommand;

	public supportsCommand(cmd: VersionCommand): Maybe<boolean> {
		switch (cmd) {
			case VersionCommand.Get:
				return true; // This is mandatory
			case VersionCommand.CommandClassGet:
				return true; // This is mandatory
			case VersionCommand.CapabilitiesGet:
				return this.version >= 3;
			// case VersionCommand.ZWaveSoftwareGet:
			// 	return this._supportsZWaveSoftwareGet;
		}
		return super.supportsCommand(cmd);
	}
	// TODO: After splitting this into separate commands, the following does no longer work
	// private _supportsZWaveSoftwareGet: Maybe<boolean> = unknownBoolean;

	/** Requests static or dynamic state for a given from a node */
	public static async requestState(
		driver: IDriver,
		node: ZWaveNode,
		kind: StateKind,
	): Promise<void> {
		// TODO: Check if we have requested that information before and store it
		if (kind & StateKind.Static) {
			const cc = new VersionCCGet(driver, { nodeId: node.id });
			const request = new SendDataRequest(driver, { command: cc });
			await driver.sendMessage(request, {
				priority: MessagePriority.NodeQuery,
			});
		}
	}
}

@CCCommand(VersionCommand.Report)
export class VersionCCReport extends VersionCC {
	public constructor(
		driver: IDriver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);
		this._libraryType = this.payload[0];
		this._protocolVersion = `${this.payload[1]}.${this.payload[2]}`;
		this._firmwareVersions = [`${this.payload[3]}.${this.payload[4]}`];
		if (this.version >= 2) {
			this._hardwareVersion = this.payload[5];
			const additionalFirmwares = this.payload[6];
			for (let i = 0; i < additionalFirmwares; i++) {
				this.firmwareVersions.push(
					`${this.payload[7 + 2 * i]}.${this.payload[7 + 2 * i + 1]}`,
				);
			}
		}
		this.persistValues();
	}

	private _libraryType: ZWaveLibraryTypes;
	@ccValue() public get libraryType(): ZWaveLibraryTypes {
		return this._libraryType;
	}
	private _protocolVersion: string;
	@ccValue() public get protocolVersion(): string {
		return this._protocolVersion;
	}
	private _firmwareVersions: string[];
	@ccValue() public get firmwareVersions(): string[] {
		return this._firmwareVersions;
	}
	private _hardwareVersion: number | undefined;
	@ccValue() public get hardwareVersion(): number | undefined {
		return this._hardwareVersion;
	}
}

@CCCommand(VersionCommand.Get)
@expectedCCResponse(VersionCCReport)
export class VersionCCGet extends VersionCC {
	public constructor(
		driver: IDriver,
		options: CommandClassDeserializationOptions | CCCommandOptions,
	) {
		super(driver, options);
	}
}

@CCCommand(VersionCommand.CommandClassReport)
export class VersionCCCommandClassReport extends VersionCC {
	public constructor(
		driver: IDriver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);
		this._requestedCC = this.payload[0];
		this._ccVersion = this.payload[1];
		// No need to persist this, we're storing it manually
	}

	private _ccVersion: number;
	public get ccVersion(): number {
		return this._ccVersion;
	}

	private _requestedCC: CommandClasses;
	public get requestedCC(): CommandClasses {
		return this._requestedCC;
	}
}

interface VersionCCCommandClassGetOptions extends CCCommandOptions {
	requestedCC: CommandClasses;
}

@CCCommand(VersionCommand.CommandClassGet)
@expectedCCResponse(VersionCCCommandClassReport)
export class VersionCCCommandClassGet extends VersionCC {
	public constructor(
		driver: IDriver,
		options:
			| CommandClassDeserializationOptions
			| VersionCCCommandClassGetOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			// TODO: Deserialize payload
			throw new ZWaveError(
				`${this.constructor.name}: deserialization not implemented`,
				ZWaveErrorCodes.Deserialization_NotImplemented,
			);
		} else {
			this.requestedCC = options.requestedCC;
		}
	}

	public requestedCC: CommandClasses;

	public serialize(): Buffer {
		this.payload = Buffer.from([this.requestedCC]);
		return super.serialize();
	}
}

@CCCommand(VersionCommand.CapabilitiesReport)
export class VersionCCCapabilitiesReport extends VersionCC {
	public constructor(
		driver: IDriver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);
		const capabilities = this.payload[0];
		this._supportsZWaveSoftwareGet = !!(capabilities & 0b100);
		this.persistValues();
	}

	private _supportsZWaveSoftwareGet: boolean;
	@ccValue() public get supportsZWaveSoftwareGet(): boolean {
		return this._supportsZWaveSoftwareGet;
	}
}

@CCCommand(VersionCommand.CapabilitiesGet)
@expectedCCResponse(VersionCCCapabilitiesReport)
export class VersionCCCapabilitiesGet extends VersionCC {
	public constructor(
		driver: IDriver,
		options: CommandClassDeserializationOptions | CCCommandOptions,
	) {
		super(driver, options);
	}
}

@CCCommand(VersionCommand.ZWaveSoftwareReport)
export class VersionCCZWaveSoftwareReport extends VersionCC {
	public constructor(
		driver: IDriver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);
		this._sdkVersion = parseVersion(this.payload);
		this._applicationFrameworkAPIVersion = parseVersion(
			this.payload.slice(3),
		);
		if (this._applicationFrameworkAPIVersion !== "unused") {
			this._applicationFrameworkBuildNumber = this.payload.readUInt16BE(
				6,
			);
		} else {
			this._applicationFrameworkBuildNumber = 0;
		}
		this._hostInterfaceVersion = parseVersion(this.payload.slice(8));
		if (this._hostInterfaceVersion !== "unused") {
			this._hostInterfaceBuildNumber = this.payload.readUInt16BE(11);
		} else {
			this._hostInterfaceBuildNumber = 0;
		}
		this._zWaveProtocolVersion = parseVersion(this.payload.slice(13));
		if (this._zWaveProtocolVersion !== "unused") {
			this._zWaveProtocolBuildNumber = this.payload.readUInt16BE(16);
		} else {
			this._zWaveProtocolBuildNumber = 0;
		}
		this._applicationVersion = parseVersion(this.payload.slice(18));
		if (this._applicationVersion !== "unused") {
			this._applicationBuildNumber = this.payload.readUInt16BE(21);
		} else {
			this._applicationBuildNumber = 0;
		}
		this.persistValues();
	}

	private _sdkVersion: string;
	@ccValue() public get sdkVersion(): string {
		return this._sdkVersion;
	}
	private _applicationFrameworkAPIVersion: string;
	@ccValue() public get applicationFrameworkAPIVersion(): string {
		return this._applicationFrameworkAPIVersion;
	}
	private _applicationFrameworkBuildNumber: number;
	@ccValue() public get applicationFrameworkBuildNumber(): number {
		return this._applicationFrameworkBuildNumber;
	}
	private _hostInterfaceVersion: string;
	@ccValue() public get hostInterfaceVersion(): string {
		return this._hostInterfaceVersion;
	}
	private _hostInterfaceBuildNumber: number;
	@ccValue() public get hostInterfaceBuildNumber(): number {
		return this._hostInterfaceBuildNumber;
	}
	private _zWaveProtocolVersion: string;
	@ccValue() public get zWaveProtocolVersion(): string {
		return this._zWaveProtocolVersion;
	}
	private _zWaveProtocolBuildNumber: number;
	@ccValue() public get zWaveProtocolBuildNumber(): number {
		return this._zWaveProtocolBuildNumber;
	}
	private _applicationVersion: string;
	@ccValue() public get applicationVersion(): string {
		return this._applicationVersion;
	}
	private _applicationBuildNumber: number;
	@ccValue() public get applicationBuildNumber(): number {
		return this._applicationBuildNumber;
	}
}

@CCCommand(VersionCommand.ZWaveSoftwareGet)
@expectedCCResponse(VersionCCZWaveSoftwareReport)
export class VersionCCZWaveSoftwareGet extends VersionCC {
	public constructor(
		driver: IDriver,
		options: CommandClassDeserializationOptions | CCCommandOptions,
	) {
		super(driver, options);
	}
}
