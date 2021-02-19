import { validatePayload, ZWaveError, ZWaveErrorCodes } from "@zwave-js/core";
import type { TypedClassDecorator } from "@zwave-js/shared";

enum S2ExtensionType {
	SPAN = 0x01,
	MPAN = 0x02,
	MGRP = 0x03,
	MOS = 0x04,
}

const METADATA_S2ExtensionMap = Symbol("S2ExtensionMap");
const METADATA_S2Extension = Symbol("S2Extension");

type S2ExtensionMap = Map<S2ExtensionType, Constructable<Security2Extension>>;

export type Constructable<
	T extends Security2Extension
> = typeof Security2Extension & {
	new (options: Security2ExtensionOptions): T;
};

/**
 * Looks up the S2 extension constructor for a given S2 extension type
 */
export function getS2ExtensionConstructor(
	type: S2ExtensionType,
): Constructable<Security2Extension> | undefined {
	// Retrieve the constructor map from the CommandClass class
	const map = Reflect.getMetadata(
		METADATA_S2ExtensionMap,
		Security2Extension,
	) as S2ExtensionMap | undefined;
	return map?.get(type);
}

/**
 * Defines the command class associated with a Z-Wave message
 */
export function extensionType(
	type: S2ExtensionType,
): TypedClassDecorator<Security2Extension> {
	return (extensionClass) => {
		Reflect.defineMetadata(METADATA_S2Extension, type, extensionClass);

		const map: S2ExtensionMap =
			Reflect.getMetadata(METADATA_S2ExtensionMap, Security2Extension) ||
			new Map();
		map.set(
			type,
			(extensionClass as unknown) as Constructable<Security2Extension>,
		);
		Reflect.defineMetadata(
			METADATA_S2ExtensionMap,
			map,
			Security2Extension,
		);
	};
}

/**
 * Retrieves the command class defined for a Z-Wave message class
 */
export function getExtensionType<T extends Security2Extension>(
	ext: T,
): S2ExtensionType {
	// get the class constructor
	const constr = ext.constructor;
	// retrieve the current metadata
	const ret: S2ExtensionType | undefined = Reflect.getMetadata(
		METADATA_S2Extension,
		constr,
	);
	if (ret == undefined) {
		throw new ZWaveError(
			`No S2 extension type defined for ${constr.name}!`,
			ZWaveErrorCodes.CC_Invalid,
		);
	}
	return ret;
}

interface Security2ExtensionCreationOptions {
	critical: boolean;
	payload?: Buffer;
}

interface Security2ExtensionDeserializationOptions {
	data: Buffer;
}

type Security2ExtensionOptions =
	| Security2ExtensionCreationOptions
	| Security2ExtensionDeserializationOptions;

function gotDeserializationOptions(
	options: Record<string, any>,
): options is Security2ExtensionDeserializationOptions {
	return "data" in options && Buffer.isBuffer(options.data);
}

export class Security2Extension {
	public constructor(options: Security2ExtensionOptions) {
		if (gotDeserializationOptions(options)) {
			validatePayload(options.data.length >= 2);
			const totalLength = options.data[0];
			validatePayload(options.data.length >= totalLength);
			const controlByte = options.data[1];
			this.moreToFollow = !!(controlByte & 0b1000_0000);
			this.critical = !!(controlByte & 0b0100_0000);
			this.type = controlByte & 0b11_1111;
			this.payload = options.data.slice(2, totalLength);
		} else {
			this.type = getExtensionType(this);
			this.critical = options.critical;
			this.payload = options.payload ?? Buffer.allocUnsafe(0);
		}
	}

	public type: S2ExtensionType;
	public critical: boolean;
	public readonly moreToFollow?: boolean;
	public payload: Buffer;

	public isEncrypted(): boolean {
		return false;
	}

	public serialize(moreToFollow: boolean): Buffer {
		return Buffer.concat([
			Buffer.from([
				2 + this.payload.length,
				(moreToFollow ? 0b1000_0000 : 0) |
					(this.critical ? 0b0100_0000 : 0) |
					(this.type & 0b11_1111),
			]),
			this.payload,
		]);
	}

	/** Returns the number of bytes the first extension in the buffer occupies */
	public static getExtensionLength(data: Buffer): number {
		return data[0];
	}

	/**
	 * Retrieves the correct constructor for the next extension in the given Buffer.
	 * It is assumed that the buffer has been checked beforehand
	 */
	public static getConstructor(
		data: Buffer,
	): Constructable<Security2Extension> {
		const type = data[1] & 0b11_1111;
		return getS2ExtensionConstructor(type) ?? Security2Extension;
	}

	/** Creates an instance of the S2 extension that is serialized in the given buffer */
	public static from(data: Buffer): Security2Extension {
		const Constructor = Security2Extension.getConstructor(data);
		const ret = new Constructor({ data });
		return ret;
	}
}

interface SPANExtensionOptions {
	senderEI: Buffer;
}

@extensionType(S2ExtensionType.SPAN)
export class SPANExtension extends Security2Extension {
	public constructor(
		options:
			| Security2ExtensionDeserializationOptions
			| SPANExtensionOptions,
	) {
		if (gotDeserializationOptions(options)) {
			super(options);
			validatePayload(this.payload.length === 16);
			this.senderEI = this.payload;
		} else {
			super({ critical: true });
			if (options.senderEI.length !== 16) {
				throw new ZWaveError(
					"The sender's entropy must be a 16-byte buffer!",
					ZWaveErrorCodes.Argument_Invalid,
				);
			}
			this.senderEI = options.senderEI;
		}
	}

	public senderEI: Buffer;

	public serialize(moreToFollow: boolean): Buffer {
		this.payload = this.senderEI;
		return super.serialize(moreToFollow);
	}
}

interface MPANExtensionOptions {
	groupId: number;
	innerMPANState: Buffer;
}

@extensionType(S2ExtensionType.MPAN)
export class MPANExtension extends Security2Extension {
	public constructor(
		options:
			| Security2ExtensionDeserializationOptions
			| MPANExtensionOptions,
	) {
		if (gotDeserializationOptions(options)) {
			super(options);
			validatePayload(this.payload.length === 17);
			this.groupId = this.payload[0];
			this.innerMPANState = this.payload.slice(1);
		} else {
			if (options.innerMPANState.length !== 16) {
				throw new ZWaveError(
					"The inner MPAN state must be a 16-byte buffer!",
					ZWaveErrorCodes.Argument_Invalid,
				);
			}
			super({ critical: true });
			this.groupId = options.groupId;
			this.innerMPANState = options.innerMPANState;
		}
	}

	public groupId: number;
	public innerMPANState: Buffer;

	public isEncrypted(): boolean {
		return true;
	}

	public serialize(moreToFollow: boolean): Buffer {
		this.payload = Buffer.concat([
			Buffer.from([this.groupId]),
			this.innerMPANState,
		]);
		return super.serialize(moreToFollow);
	}
}

interface MGRPExtensionOptions {
	groupId: number;
}

@extensionType(S2ExtensionType.MGRP)
export class MGRPExtension extends Security2Extension {
	public constructor(
		options:
			| Security2ExtensionDeserializationOptions
			| MGRPExtensionOptions,
	) {
		if (gotDeserializationOptions(options)) {
			super(options);
			validatePayload(this.payload.length === 1);
			this.groupId = this.payload[0];
		} else {
			super({ critical: true });
			this.groupId = options.groupId;
		}
	}

	public groupId: number;

	public serialize(moreToFollow: boolean): Buffer {
		this.payload = Buffer.from([this.groupId]);
		return super.serialize(moreToFollow);
	}
}

@extensionType(S2ExtensionType.MOS)
export class MOSExtension extends Security2Extension {
	public constructor(options?: Security2ExtensionDeserializationOptions) {
		if (options && gotDeserializationOptions(options)) {
			super(options);
		} else {
			super({ critical: false });
		}
	}
}
