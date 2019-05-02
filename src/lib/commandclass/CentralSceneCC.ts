import { IDriver } from "../driver/IDriver";
import { ZWaveError, ZWaveErrorCodes } from "../error/ZWaveError";
import { JSONObject } from "../util/misc";
import {
	CCCommand,
	CCCommandOptions,
	ccValue,
	CommandClass,
	commandClass,
	CommandClassDeserializationOptions,
	gotDeserializationOptions,
	implementedVersion,
} from "./CommandClass";
import { CommandClasses } from "./CommandClasses";

export enum CentralSceneCommand {
	SupportedGet = 0x01,
	SupportedReport = 0x02,
	Notification = 0x03,
	ConfigurationSet = 0x04,
	ConfigurationGet = 0x05,
	ConfigurationReport = 0x06,
}

export enum CentralSceneKeys {
	KeyPressed = 0x00,
	KeyReleased = 0x01,
	KeyHeldDown = 0x02,
	KeyPressed2x = 0x03,
	KeyPressed3x = 0x04,
	KeyPressed4x = 0x05,
	KeyPressed5x = 0x06,
}

@commandClass(CommandClasses["Central Scene"])
@implementedVersion(3)
// TODO: The XYZGet commands should expect an answer
export class CentralSceneCC extends CommandClass {
	public ccCommand!: CentralSceneCommand;
}

@CCCommand(CentralSceneCommand.Notification)
export class CentralSceneCCNotification extends CentralSceneCC {
	public constructor(
		driver: IDriver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);
		this._sequenceNumber = this.payload[0];
		this._keyAttribute = this.payload[1] & 0b111;
		this._sceneNumber = this.payload[2];
		this._slowRefresh = !!(this.payload[1] & 0b1000_0000);
	}

	// TODO: Is this some kind of dictionary with multiple values?

	private _sequenceNumber: number;
	public get sequenceNumber(): number {
		return this._sequenceNumber;
	}

	private _keyAttribute: CentralSceneKeys;
	public get keyAttribute(): CentralSceneKeys {
		return this._keyAttribute;
	}

	private _sceneNumber: number;
	public get sceneNumber(): number {
		return this._sceneNumber;
	}

	private _slowRefresh: boolean;
	public get slowRefresh(): boolean {
		return this._slowRefresh;
	}

	/*
	If the Slow Refresh field is false:
	 - A new Key Held Down notification MUST be sent every 200ms until the key is released.
	 - The Sequence Number field MUST be updated at each notification transmission.
	 - If not receiving a new Key Held Down notification within 400ms, a controlling node SHOULD use an adaptive timeout approach as described in 4.17.1.
	If the Slow Refresh field is true:
	 - A new Key Held Down notification MUST be sent every 55 seconds until the key is released.
	 - The Sequence Number field MUST be updated at each notification refresh.
	 - If not receiving a new Key Held Down notification within 60 seconds after the most recent Key Held Down notification,
	*/

	public toJSON(): JSONObject {
		return super.toJSONInherited({
			sequenceNumber: this.sequenceNumber,
			keyAttribute: CentralSceneKeys[this.keyAttribute],
			sceneNumber: this.sceneNumber,
			slowRefresh: this.slowRefresh,
		});
	}
}

@CCCommand(CentralSceneCommand.SupportedGet)
export class CentralSceneCCSupportedGet extends CentralSceneCC {
	public constructor(
		driver: IDriver,
		options: CommandClassDeserializationOptions | CCCommandOptions,
	) {
		super(driver, options);
	}
}

@CCCommand(CentralSceneCommand.SupportedReport)
export class CentralSceneCCSupportedReport extends CentralSceneCC {
	public constructor(
		driver: IDriver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);

		this._sceneCount = this.payload[0];
		this._supportsSlowRefresh = !!(this.payload[1] & 0b1000_0000);
		const bitMaskBytes = this.payload[1] & 0b110;
		this._keyAttributesHaveIdenticalSupport = !!(this.payload[1] & 0b1);
		const numEntries = this._keyAttributesHaveIdenticalSupport
			? 1
			: this.sceneCount;
		this._supportedKeyAttributes = [];
		for (let i = 0; i < numEntries; i++) {
			let mask = 0;
			for (let j = 0; j < bitMaskBytes; j++) {
				mask += this.payload[3 + bitMaskBytes * i + j] << (8 * j);
			}
			this._supportedKeyAttributes.push(mask);
		}
		this.persistValues();
	}

	private _sceneCount: number;
	@ccValue() public get sceneCount(): number {
		return this._sceneCount;
	}

	private _supportsSlowRefresh: boolean;
	@ccValue() public get supportsSlowRefresh(): boolean {
		return this._supportsSlowRefresh;
	}

	private _supportedKeyAttributes: CentralSceneKeys[];
	@ccValue()
	public get supportedKeyAttributes(): readonly CentralSceneKeys[] {
		return this._supportedKeyAttributes;
	}

	private _keyAttributesHaveIdenticalSupport: boolean;
	@ccValue() public get keyAttributesHaveIdenticalSupport(): boolean {
		return this._keyAttributesHaveIdenticalSupport;
	}

	public supportsKeyAttribute(
		sceneNumber: number,
		keyAttribute: CentralSceneKeys,
	): boolean {
		const bitArrayIndex = this._keyAttributesHaveIdenticalSupport
			? 0
			: sceneNumber - 1;
		const bitmap = this._supportedKeyAttributes[bitArrayIndex];
		return !!(bitmap & (1 << keyAttribute));
	}
}

@CCCommand(CentralSceneCommand.ConfigurationGet)
export class CentralSceneCCConfigurationGet extends CentralSceneCC {
	public constructor(
		driver: IDriver,
		options: CommandClassDeserializationOptions | CCCommandOptions,
	) {
		super(driver, options);
	}
}

interface CentralSceneCCConfigurationSetOptions extends CCCommandOptions {
	slowRefresh: boolean;
}

@CCCommand(CentralSceneCommand.ConfigurationSet)
export class CentralSceneCCConfigurationSet extends CentralSceneCC {
	public constructor(
		driver: IDriver,
		options:
			| CommandClassDeserializationOptions
			| CentralSceneCCConfigurationSetOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			throw new ZWaveError(
				`${this.constructor.name}: deserialization not implemented`,
				ZWaveErrorCodes.Deserialization_NotImplemented,
			);
		} else {
			this.slowRefresh = options.slowRefresh;
		}
	}

	public slowRefresh: boolean;

	public serialize(): Buffer {
		this.payload = Buffer.from([this.slowRefresh ? 0b1000_0000 : 0]);
		return super.serialize();
	}
}

@CCCommand(CentralSceneCommand.ConfigurationReport)
export class CentralSceneCCConfigurationReport extends CentralSceneCC {
	public constructor(
		driver: IDriver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);
		this._slowRefresh = !!(this.payload[0] & 0b1000_0000);
		this.persistValues();
	}

	private _slowRefresh: boolean;
	@ccValue() public get slowRefresh(): boolean {
		return this._slowRefresh;
	}
}
