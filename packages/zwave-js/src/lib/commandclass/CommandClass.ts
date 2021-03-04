import {
	CacheMetadata,
	CacheValue,
	CommandClasses,
	deserializeCacheValue,
	getCCName,
	MessageOrCCLogEntry,
	MessageRecord,
	NODE_ID_BROADCAST,
	parseCCId,
	serializeCacheValue,
	stripUndefined,
	ValueDB,
	ValueID,
	valueIdToString,
	ValueMetadata,
	ZWaveError,
	ZWaveErrorCodes,
} from "@zwave-js/core";
import {
	buffer2hex,
	getEnumMemberName,
	JSONObject,
	num2hex,
	staticExtends,
} from "@zwave-js/shared";
import { isArray } from "alcalzone-shared/typeguards";
import type { Driver } from "../driver/Driver";
import type { Endpoint } from "../node/Endpoint";
import type { ZWaveNode } from "../node/Node";
import { InterviewStage } from "../node/Types";
import type { VirtualEndpoint } from "../node/VirtualEndpoint";
import { CCAPI } from "./API";
import {
	EncapsulatingCommandClass,
	isEncapsulatingCommandClass,
} from "./EncapsulatingCommandClass";

export type MulticastDestination = [number, number, ...number[]];

export type CommandClassDeserializationOptions = { data: Buffer } & (
	| {
			fromEncapsulation?: false;
			nodeId: number;
	  }
	| {
			fromEncapsulation: true;
			encapCC: CommandClass;
	  }
);

export function gotDeserializationOptions(
	options: CommandClassOptions,
): options is CommandClassDeserializationOptions {
	return "data" in options && Buffer.isBuffer(options.data);
}

export interface CCCommandOptions {
	nodeId: number | MulticastDestination;
	endpoint?: number;
	supervised?: boolean;
}

interface CommandClassCreationOptions extends CCCommandOptions {
	ccId?: number; // Used to overwrite the declared CC ID
	ccCommand?: number; // undefined = NoOp
	payload?: Buffer;
}

function gotCCCommandOptions(options: any): options is CCCommandOptions {
	return typeof options.nodeId === "number" || isArray(options.nodeId);
}

export type CommandClassOptions =
	| CommandClassCreationOptions
	| CommandClassDeserializationOptions;

// @publicAPI
export class CommandClass {
	// empty constructor to parse messages
	public constructor(driver: Driver, options: CommandClassOptions) {
		this.driver = driver;
		// Extract the cc from declared metadata if not provided by the CC constructor
		this.ccId =
			("ccId" in options && options.ccId) || getCommandClass(this);
		// Default to the root endpoint - Inherited classes may override this behavior
		this.endpointIndex =
			("endpoint" in options ? options.endpoint : undefined) ?? 0;
		// Default to non-supervised commands
		this.supervised =
			("supervised" in options ? options.supervised : undefined) ?? false;

		// We cannot use @ccValue for non-derived classes, so register interviewComplete as an internal value here
		this.registerValue("interviewComplete", true);

		if (gotDeserializationOptions(options)) {
			// For deserialized commands, try to invoke the correct subclass constructor
			const CCConstructor =
				getCCConstructor(CommandClass.getCommandClass(options.data)) ??
				CommandClass;
			const ccCommand = CCConstructor.getCCCommand(options.data);
			if (ccCommand != undefined) {
				const CommandConstructor = getCCCommandConstructor(
					this.ccId,
					ccCommand,
				);
				if (
					CommandConstructor &&
					(new.target as any) !== CommandConstructor
				) {
					return new CommandConstructor(driver, options);
				}
			}

			// If the constructor is correct or none was found, fall back to normal deserialization
			if (options.fromEncapsulation) {
				// Propagate the node ID and endpoint index from the encapsulating CC
				this.nodeId = options.encapCC.nodeId;
				if (!this.endpointIndex && options.encapCC.endpointIndex) {
					this.endpointIndex = options.encapCC.endpointIndex;
				}
				// And remember which CC encapsulates this CC
				this.encapsulatingCC = options.encapCC as any;
			} else {
				this.nodeId = options.nodeId;
			}
			({
				ccId: this.ccId,
				ccCommand: this.ccCommand,
				payload: this.payload,
			} = this.deserialize(options.data));
		} else if (gotCCCommandOptions(options)) {
			const {
				nodeId,
				ccCommand = getCCCommand(this),
				payload = Buffer.allocUnsafe(0),
			} = options;
			this.nodeId = nodeId;
			this.ccCommand = ccCommand;
			this.payload = payload;
		}

		if (this.isSinglecast() && this.nodeId !== NODE_ID_BROADCAST) {
			// For singlecast CCs, set the CC version as high as possible
			this.version = this.driver.getSafeCCVersionForNode(
				this.ccId,
				this.nodeId,
				this.endpointIndex,
			);
			// If we received a CC from a node, it must support at least version 1
			// Make sure that the interview is complete or we cannot be sure that the assumption is correct
			const node = this.getNodeUnsafe();
			if (
				node?.interviewStage === InterviewStage.Complete &&
				this.version === 0 &&
				gotDeserializationOptions(options)
			) {
				this.version = 1;
			}

			// If the node or endpoint is included securely, send secure commands if possible
			const endpoint = this.getNodeUnsafe()?.getEndpoint(
				this.endpointIndex,
			);
			this.secure =
				node?.isSecure !== false &&
				!!(endpoint ?? node)?.isCCSecure(this.ccId) &&
				!!this.driver.securityManager;
		} else {
			// For multicast and broadcast CCs, we just use the highest implemented version to serialize
			// Older nodes will ignore the additional fields
			this.version = getImplementedVersion(this.ccId);
			// Security does not support multicast
		}
	}

	protected driver: Driver;

	/** This CC's identifier */
	public ccId: CommandClasses;
	public ccCommand?: number;

	/** The ID of the target node(s) */
	public nodeId!: number | MulticastDestination;

	// Work around https://github.com/Microsoft/TypeScript/issues/27555
	public payload!: Buffer;

	/** The version of the command class used */
	// Work around https://github.com/Microsoft/TypeScript/issues/27555
	public version!: number;

	/** Which endpoint of the node this CC belongs to. 0 for the root device. */
	public endpointIndex: number;

	/**
	 * @internal
	 * Whether the command progress should be supervised.
	 * This only has an effect if the target endpoint supports the Supervision CC.
	 *
	 * Don't use this directly, but rather use `Driver.sendSupervisedCommand`
	 */
	public supervised: boolean;

	/** Contains a reference to the encapsulating CC if this CC is encapsulated */
	public encapsulatingCC?: EncapsulatingCommandClass;

	/**
	 * @internal
	 * Whether the command should be sent encrypted
	 * This only has an effect if the target node supports Security.
	 */
	public secure: boolean = false;

	/** Returns true if this CC is an extended CC (0xF100..0xFFFF) */
	public isExtended(): boolean {
		return this.ccId >= 0xf100;
	}

	/** Whether the interview for this CC was previously completed */
	public get interviewComplete(): boolean {
		return !!this.getValueDB().getValue<boolean>({
			commandClass: this.ccId,
			endpoint: this.endpointIndex,
			property: "interviewComplete",
		});
	}
	public set interviewComplete(value: boolean) {
		this.getValueDB().setValue(
			{
				commandClass: this.ccId,
				endpoint: this.endpointIndex,
				property: "interviewComplete",
			},
			value,
		);
	}

	/** Can be used by endpoints to test if the root device was already interviewed */
	public get rootDeviceInterviewComplete(): boolean {
		return !!this.getValueDB().getValue<boolean>({
			commandClass: this.ccId,
			endpoint: 0,
			property: "interviewComplete",
		});
	}

	/**
	 * Deserializes a CC from a buffer that contains a serialized CC
	 */
	// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
	protected deserialize(data: Buffer) {
		const ccId = CommandClass.getCommandClass(data);
		const ccIdLength = this.isExtended() ? 2 : 1;
		if (data.length > ccIdLength) {
			// This is not a NoOp CC (contains command and payload)
			const ccCommand = data[ccIdLength];
			const payload = data.slice(ccIdLength + 1);
			return {
				ccId,
				ccCommand,
				payload,
			};
		} else {
			// NoOp CC (no command, no payload)
			const payload = Buffer.allocUnsafe(0);
			return { ccId, payload };
		}
	}

	/**
	 * Serializes this CommandClass to be embedded in a message payload or another CC
	 */
	public serialize(): Buffer {
		// NoOp CCs have no command and no payload
		if (this.ccId === CommandClasses["No Operation"])
			return Buffer.from([this.ccId]);
		else if (this.ccCommand == undefined) {
			throw new ZWaveError(
				"Cannot serialize a Command Class without a command",
				ZWaveErrorCodes.CC_Invalid,
			);
		}

		const payloadLength = this.payload.length;
		const ccIdLength = this.isExtended() ? 2 : 1;
		const data = Buffer.allocUnsafe(ccIdLength + 1 + payloadLength);
		data.writeUIntBE(this.ccId, 0, ccIdLength);
		data[ccIdLength] = this.ccCommand;
		if (payloadLength > 0 /* implies payload != undefined */) {
			this.payload.copy(data, 1 + ccIdLength);
		}
		return data;
	}

	/** Extracts the CC id from a buffer that contains a serialized CC */
	public static getCommandClass(data: Buffer): CommandClasses {
		return parseCCId(data).ccId;
	}

	/** Extracts the CC command from a buffer that contains a serialized CC  */
	public static getCCCommand(data: Buffer): number | undefined {
		if (data[0] === 0) return undefined; // NoOp
		const isExtendedCC = data[0] >= 0xf1;
		return isExtendedCC ? data[2] : data[1];
	}

	/**
	 * Retrieves the correct constructor for the CommandClass in the given Buffer.
	 * It is assumed that the buffer only contains the serialized CC. This throws if the CC is not implemented.
	 */
	public static getConstructor(ccData: Buffer): Constructable<CommandClass> {
		// Encapsulated CCs don't have the two header bytes
		const cc = CommandClass.getCommandClass(ccData);
		const ret = getCCConstructor(cc);
		if (!ret) {
			const ccName = getCCName(cc);
			throw new ZWaveError(
				`The command class ${ccName} is not implemented`,
				ZWaveErrorCodes.CC_NotImplemented,
			);
		}
		return ret;
	}

	/**
	 * Creates an instance of the CC that is serialized in the given buffer
	 */
	public static from(
		driver: Driver,
		options: CommandClassDeserializationOptions,
	): CommandClass {
		// Fall back to unspecified command class in case we receive one that is not implemented
		const Constructor = CommandClass.getConstructor(options.data);
		const ret = new Constructor(driver, options);
		return ret;
	}

	/** Generates a representation of this CC for the log */
	public toLogEntry(): MessageOrCCLogEntry {
		let tag = this.constructor.name;
		const message: MessageRecord = {};
		if (this.constructor === CommandClass) {
			tag = `${getEnumMemberName(
				CommandClasses,
				this.ccId,
			)} CC (not implemented)`;
			if (this.ccCommand != undefined) {
				message.command = num2hex(this.ccCommand);
			}
		}
		if (this.payload.length > 0) {
			message.payload = buffer2hex(this.payload);
		}
		return {
			tags: [tag],
			message,
		};
	}

	/** Generates the JSON representation of this CC */
	public toJSON(): JSONObject {
		return this.toJSONInternal();
	}

	private toJSONInternal(): JSONObject {
		const ret: JSONObject = {
			nodeId: this.nodeId,
			ccId: CommandClasses[this.ccId] || num2hex(this.ccId),
		};
		if (this.ccCommand != undefined) {
			ret.ccCommand = num2hex(this.ccCommand);
		}
		if (this.payload.length > 0) {
			ret.payload = "0x" + this.payload.toString("hex");
		}
		return ret;
	}

	protected toJSONInherited(props: JSONObject): JSONObject {
		const { payload, ...ret } = this.toJSONInternal();
		return stripUndefined({ ...ret, ...props });
	}

	// This needs to be overwritten per command class. In the default implementation, don't do anything
	/**
	 * Performs the interview procedure for this CC according to SDS14223
	 * @param complete Whether a complete interview should be performed or only the necessary steps on startup
	 */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	public async interview(complete: boolean = true): Promise<void> {
		// Empty on purpose
	}

	/** Determines which CC interviews must be performed before this CC can be interviewed */
	public determineRequiredCCInterviews(): readonly CommandClasses[] {
		// By default, all CCs require the VersionCC interview

		// There are two exceptions to this rule:
		// * ManufacturerSpecific must be interviewed first
		// * VersionCC itself must be done after that
		// These exceptions are defined in the overrides of this method of each corresponding CC

		return [CommandClasses.Version];
	}

	/**
	 * Whether the endpoint interview may be skipped by a CC. Can be overwritten by a subclass.
	 */
	public skipEndpointInterview(): boolean {
		// By default no interview may be skipped
		return false;
	}

	/**
	 * Maps a BasicCC value to a more specific CC implementation. Returns true if the value was mapped, false otherwise.
	 * @param value The value of the received BasicCC
	 */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	public setMappedBasicValue(value: number): boolean {
		// By default, don't map
		return false;
	}

	public isSinglecast(): this is SinglecastCC<this> {
		return typeof this.nodeId === "number";
	}

	public isMulticast(): this is MulticastCC<this> {
		return isArray(this.nodeId);
	}

	/**
	 * Returns the node this CC is linked to. Throws if the controller is not yet ready.
	 */
	public getNode(): ZWaveNode | undefined {
		if (this.isSinglecast()) {
			return this.driver.controller.nodes.get(this.nodeId);
		}
	}

	/**
	 * @internal
	 * Returns the node this CC is linked to (or undefined if the node doesn't exist)
	 */
	public getNodeUnsafe(): ZWaveNode | undefined {
		try {
			return this.getNode();
		} catch (e: unknown) {
			// This was expected
			if (
				e instanceof ZWaveError &&
				e.code === ZWaveErrorCodes.Driver_NotReady
			) {
				return undefined;
			}
			// Something else happened
			throw e;
		}
	}

	public getEndpoint(): Endpoint | undefined {
		return this.getNode()?.getEndpoint(this.endpointIndex);
	}

	/** Returns the value DB for this CC's node */
	protected getValueDB(): ValueDB {
		const node = this.getNode();
		if (node == undefined) {
			throw new ZWaveError(
				"The node for this CC does not exist or the driver is not ready yet",
				ZWaveErrorCodes.Driver_NotReady,
			);
		}
		return node.valueDB;
	}

	/** Which variables should be persisted when requested */
	private _registeredCCValues = new Map<string | number, boolean>();
	/**
	 * Creates a value that will be stored in the valueDB alongside with the ones marked with `@ccValue()`
	 * @param property The property the value belongs to
	 * @param internal Whether the value should be exposed to library users
	 */
	public registerValue(
		property: string | number,
		internal: boolean = false,
	): void {
		this._registeredCCValues.set(property, internal);
	}

	/** Returns a list of all value names that are defined for this CommandClass */
	public getDefinedValueIDs(): ValueID[] {
		// In order to compare value ids, we need them to be strings
		const ret = new Map<string, ValueID>();

		const addValueId = (
			property: string | number,
			propertyKey?: string | number,
		): void => {
			const valueId: ValueID = {
				commandClass: this.ccId,
				endpoint: this.endpointIndex,
				property,
				propertyKey,
			};
			const dbKey = valueIdToString(valueId);
			if (!ret.has(dbKey)) ret.set(dbKey, valueId);
		};

		// Return all manually registered CC values that are not internal
		const registeredCCValueNames = [...this._registeredCCValues]
			.filter(([, isInternal]) => !isInternal)
			.map(([key]) => key);
		registeredCCValueNames.forEach((property) => addValueId(property));

		// Return all defined non-internal CC values that are available in the current version of this CC
		const valueDefinitions = getCCValueDefinitions(this);
		const definedCCValueNames = [...valueDefinitions]
			.filter(
				([, options]) =>
					options.internal !== true &&
					(options.minVersion == undefined ||
						options.minVersion <= this.version),
			)
			.map(([key]) => key);
		definedCCValueNames.forEach((property) => addValueId(property));

		const kvpDefinitions = getCCKeyValuePairDefinitions(this);

		// Also return all existing value ids that are not internal (values AND metadata without values!)
		const existingValueIds = [
			...this.getValueDB().getValues(this.ccId),
			...this.getValueDB().getAllMetadata(this.ccId),
		]
			.filter((valueId) => valueId.endpoint === this.endpointIndex)
			// allow the value id if it is NOT registered or it is registered as non-internal
			.filter(
				(valueId) =>
					!this._registeredCCValues.has(valueId.property) ||
					this._registeredCCValues.get(valueId.property)! === false,
			)
			// allow the value id if it is NOT defined or it is defined as non-internal
			.filter(
				(valueId) =>
					!valueDefinitions.has(valueId.property) ||
					valueDefinitions.get(valueId.property)! === false,
			)
			.filter(
				(valueId) =>
					!kvpDefinitions.has(valueId.property) ||
					kvpDefinitions.get(valueId.property)! === false,
			);
		existingValueIds.forEach(({ property, propertyKey }) =>
			addValueId(property, propertyKey),
		);

		return [...ret.values()];
	}

	/** Determines if the given value is an internal value */
	public isInternalValue(property: keyof this): boolean {
		// A value is internal if any of the possible definitions say so (true)
		if (this._registeredCCValues.get(property as string) === true)
			return true;
		const ccValueDefinition = getCCValueDefinitions(this).get(
			property as string,
		);
		if (ccValueDefinition?.internal === true) return true;
		const ccKeyValuePairDefinition = getCCKeyValuePairDefinitions(this).get(
			property as string,
		);
		if (ccKeyValuePairDefinition?.internal === true) return true;
		return false;
	}

	/** Determines if the given value should always be persisted */
	public shouldValueAlwaysBeCreated(property: keyof this): boolean {
		const ccValueDefinition = getCCValueDefinitions(this).get(
			property as string,
		);
		if (ccValueDefinition?.forceCreation === true) return true;
		const ccKeyValuePairDefinition = getCCKeyValuePairDefinitions(this).get(
			property as string,
		);
		if (ccKeyValuePairDefinition?.forceCreation === true) return true;
		return false;
	}

	/** Determines if the given value should be persisted or represents an event */
	public isStatefulValue(property: keyof this): boolean {
		const ccValueDefinition = getCCValueDefinitions(this).get(
			property as string,
		);
		if (ccValueDefinition?.stateful === false) return false;
		const ccKeyValuePairDefinition = getCCKeyValuePairDefinitions(this).get(
			property as string,
		);
		if (ccKeyValuePairDefinition?.stateful === false) return false;
		return true;
	}

	/** Persists all values on the given node into the value. Returns true if the process succeeded, false otherwise */
	public persistValues(valueNames?: (keyof this)[]): boolean {
		// In order to avoid cluttering applications with heaps of unsupported properties,
		// we filter out those that are only available in future versions of this CC
		// or have no version constraint
		const keyValuePairDefinitions = getCCKeyValuePairDefinitions(this);
		const keyValuePairs = [...keyValuePairDefinitions].filter(
			([, options]) =>
				options.minVersion == undefined ||
				options.minVersion <= this.version,
		);
		const ccValueDefinitions = [...getCCValueDefinitions(this)].filter(
			([, options]) =>
				options.minVersion == undefined ||
				options.minVersion <= this.version,
		);
		// If not specified otherwise, persist all registered values in the value db
		// But filter out those that don't match the minimum version
		if (!valueNames) {
			valueNames = ([
				...this._registeredCCValues.keys(),
				...ccValueDefinitions.map(([key]) => key),
				...keyValuePairs.map(([key]) => key),
			] as unknown) as (keyof this)[];
		}
		let db: ValueDB;
		try {
			db = this.getValueDB();
		} catch {
			return false;
		}

		const cc = getCommandClass(this);
		for (const variable of valueNames as string[]) {
			// interviewComplete automatically updates the value DB, so no need to persist again
			if (variable === "interviewComplete") continue;
			// Only persist non-undefined values
			const sourceValue = this[variable as keyof this];
			if (
				sourceValue == undefined &&
				!this.shouldValueAlwaysBeCreated(variable as keyof this)
			) {
				continue;
			}

			if (keyValuePairDefinitions.has(variable)) {
				// This value is one or more key value pair(s) to be stored in a map
				if (sourceValue instanceof Map) {
					// Just copy the entries
					for (const [propertyKey, value] of (sourceValue as Map<
						string | number,
						unknown
					>).entries()) {
						db.setValue(
							{
								commandClass: cc,
								endpoint: this.endpointIndex,
								property: variable,
								propertyKey,
							},
							value,
						);
					}
				} else if (isArray(sourceValue)) {
					const [propertyKey, value] = (sourceValue as any) as [
						string | number,
						unknown,
					];
					db.setValue(
						{
							commandClass: cc,
							endpoint: this.endpointIndex,
							property: variable,
							propertyKey,
						},
						value,
					);
				} else {
					throw new ZWaveError(
						`ccKeyValuePairs can only be Maps or [key, value]-tuples`,
						ZWaveErrorCodes.Argument_Invalid,
					);
				}
			} else {
				// This value belongs to a simple property
				const valueId: ValueID = {
					commandClass: cc,
					endpoint: this.endpointIndex,
					property: variable,
				};
				// Avoid overwriting existing values with undefined if forceCreation is true
				if (sourceValue != undefined || !db.hasValue(valueId)) {
					// Tell the value DB if this is a stateful value
					const stateful = this.isStatefulValue(
						variable as keyof this,
					);
					db.setValue(valueId, sourceValue, { stateful });
				}
			}
		}
		return true;
	}

	/** Serializes all values to be stored in the cache */
	public serializeValuesForCache(): CacheValue[] {
		const ccValues = this.getValueDB().getValues(getCommandClass(this));
		return (
			ccValues
				// only serialize non-undefined values
				.filter(({ value }) => value != undefined)
				.map(({ value, commandClass, ...props }) => {
					return {
						...props,
						value: serializeCacheValue(value),
					};
				})
		);
	}

	/** Serializes metadata to be stored in the cache */
	public serializeMetadataForCache(): CacheMetadata[] {
		const allMetadata = this.getValueDB().getAllMetadata(
			getCommandClass(this),
		);
		return (
			allMetadata
				// Strip out the command class
				.map(({ commandClass, ...props }) => props)
		);
	}

	/** Deserializes values from the cache */
	public deserializeValuesFromCache(values: CacheValue[]): void {
		const cc = getCommandClass(this);
		for (const val of values) {
			this.getValueDB().setValue(
				{
					commandClass: cc,
					endpoint: val.endpoint,
					property: val.property,
					propertyKey: val.propertyKey,
				},
				deserializeCacheValue(val.value),
				{
					// Don't emit the added/updated events, as this will spam applications with untranslated events
					noEvent: true,
					// Don't throw when there is an invalid Value ID in the cache
					noThrow: true,
				},
			);
		}
	}

	/** Deserializes value metadata from the cache */
	public deserializeMetadataFromCache(allMetadata: CacheMetadata[]): void {
		const cc = getCommandClass(this);
		for (const meta of allMetadata) {
			this.getValueDB().setMetadata(
				{
					commandClass: cc,
					endpoint: meta.endpoint,
					property: meta.property,
					propertyKey: meta.propertyKey,
				},
				meta.metadata,
				{
					// Don't emit the added/updated events, as this will spam applications with untranslated events
					noEvent: true,
					// Don't throw when there is an invalid Value ID in the cache
					noThrow: true,
				},
			);
		}
	}

	/**
	 * When a CC supports to be split into multiple partial CCs, this can be used to identify the
	 * session the partial CCs belong to.
	 * If a CC expects `mergePartialCCs` to be always called, you should return an empty object here.
	 */
	public getPartialCCSessionId(): Record<string, any> | undefined {
		return undefined; // Only select CCs support to be split
	}

	/**
	 * When a CC supports to be split into multiple partial CCs, this indicates that the last report hasn't been received yet.
	 * @param session The previously received set of messages received in this partial CC session
	 */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	public expectMoreMessages(session: CommandClass[]): boolean {
		return false; // By default, all CCs are monolithic
	}

	/** Include previously received partial responses into a final CC */
	/* istanbul ignore next */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	public mergePartialCCs(partials: CommandClass[]): void {
		// This is highly CC dependent
		// Overwrite this in derived classes, by default do nothing
	}

	/** Tests whether this CC expects at least one command in return */
	public expectsCCResponse(): boolean {
		let expected:
			| DynamicCCResponse<this>
			| ReturnType<DynamicCCResponse<this>> = getExpectedCCResponse(this);

		// Evaluate dynamic CC responses
		if (
			typeof expected === "function" &&
			!staticExtends(expected, CommandClass)
		) {
			expected = expected(this);
		}
		if (expected === undefined) return false;
		if (isArray(expected)) {
			return expected.every((cc) => staticExtends(cc, CommandClass));
		} else {
			return staticExtends(expected, CommandClass);
		}
	}

	public isExpectedCCResponse(received: CommandClass): boolean {
		if (received.nodeId !== this.nodeId) return false;

		let expected:
			| DynamicCCResponse<this>
			| ReturnType<DynamicCCResponse<this>> = getExpectedCCResponse(this);

		// Evaluate dynamic CC responses
		if (
			typeof expected === "function" &&
			!staticExtends(expected, CommandClass)
		) {
			expected = expected(this);
		}

		if (expected == undefined) {
			// Fallback, should not happen if the expected response is defined correctly
			return false;
		} else if (
			isArray(expected) &&
			expected.every((cc) => staticExtends(cc, CommandClass))
		) {
			// The CC always expects a response from the given list, check if the received
			// message is in that list
			if (expected.every((base) => !(received instanceof base))) {
				return false;
			}
		} else if (staticExtends(expected, CommandClass)) {
			// The CC always expects the same single response, check if this is the one
			if (!(received instanceof expected)) return false;
		}

		// If the CC wants to test the response, let it
		const predicate = getCCResponsePredicate(this);
		const ret = predicate?.(this, received) ?? true;

		if (ret === "checkEncapsulated") {
			if (
				isEncapsulatingCommandClass(this) &&
				isEncapsulatingCommandClass(received)
			) {
				return this.encapsulated.isExpectedCCResponse(
					received.encapsulated,
				);
			} else {
				// Fallback, should not happen if the expected response is defined correctly
				return false;
			}
		}

		return ret;
	}

	/**
	 * Translates a property identifier into a speaking name for use in an external API
	 * @param property The property identifier that should be translated
	 * @param _propertyKey The (optional) property key the translated name may depend on
	 */
	public translateProperty(
		property: string | number,
		_propertyKey?: string | number,
	): string {
		// Overwrite this in derived classes, by default just return the property key
		return property.toString();
	}

	/**
	 * Translates a property key into a speaking name for use in an external API
	 * @param property The property the key in question belongs to
	 * @param propertyKey The property key for which the speaking name should be retrieved
	 */
	public translatePropertyKey(
		property: string | number,
		propertyKey: string | number,
	): string | undefined {
		// Overwrite this in derived classes, by default just return the property key
		return propertyKey.toString();
	}

	/** Whether this CC needs to exchange one or more messages before it can be sent */
	public requiresPreTransmitHandshake(): boolean {
		return false; // By default it doesn't
	}

	/**
	 * Perform a handshake before the actual message will be transmitted.
	 */
	public preTransmitHandshake(): Promise<void> {
		return Promise.resolve();
		// By default do nothing
		// If handshake messages should be sent, they need the highest priority
	}

	/** Returns the number of bytes that are added to the payload by this CC */
	protected computeEncapsulationOverhead(): number {
		// Default is ccId (+ ccCommand):
		return (this.isExtended() ? 2 : 1) + 1;
	}

	/** Computes the maximum net payload size that can be transmitted inside this CC */
	public getMaxPayloadLength(baseLength: number): number {
		let ret = baseLength;
		let cur: CommandClass | undefined = this;
		while (cur) {
			ret -= cur.computeEncapsulationOverhead();
			cur = isEncapsulatingCommandClass(cur)
				? cur.encapsulated
				: undefined;
		}
		return ret;
	}

	/** Checks whether this CC is encapsulated with one that has the given CC id and (optionally) CC Command */
	public isEncapsulatedWith(
		ccId: CommandClasses,
		ccCommand?: number,
	): boolean {
		let cc: CommandClass = this;
		// Check whether there was a S0 encapsulation
		while (cc.encapsulatingCC) {
			cc = cc.encapsulatingCC;
			if (
				cc.ccId === ccId &&
				(ccCommand === undefined || cc.ccCommand === ccCommand)
			) {
				return true;
			}
		}
		return false;
	}
}

export type SinglecastCC<T extends CommandClass = CommandClass> = T & {
	nodeId: number;
};

export type MulticastCC<T extends CommandClass = CommandClass> = T & {
	nodeId: MulticastDestination;
};

// =======================
// use decorators to link command class values to actual command classes

const METADATA_commandClass = Symbol("commandClass");
const METADATA_commandClassMap = Symbol("commandClassMap");
const METADATA_ccResponse = Symbol("ccResponse");
const METADATA_ccCommand = Symbol("ccCommand");
const METADATA_ccCommandMap = Symbol("ccCommandMap");
const METADATA_ccValues = Symbol("ccValues");
const METADATA_ccKeyValuePairs = Symbol("ccKeyValuePairs");
const METADATA_ccValueMeta = Symbol("ccValueMeta");
const METADATA_version = Symbol("version");
const METADATA_API = Symbol("API");
const METADATA_APIMap = Symbol("APIMap");

export type Constructable<T extends CommandClass> = typeof CommandClass & {
	// I don't like the any, but we need it to support half-implemented CCs (e.g. report classes)
	new (driver: Driver, options: any): T;
};
type APIConstructor = new (
	driver: Driver,
	endpoint: Endpoint | VirtualEndpoint,
) => CCAPI;

// eslint-disable-next-line @typescript-eslint/ban-types
type TypedClassDecorator<TTarget extends Object> = <
	// wotan-disable-next-line no-misused-generics
	T extends TTarget,
	TConstructor extends new (...args: any[]) => T
>(
	apiClass: TConstructor,
) => TConstructor | void;

type CommandClassMap = Map<CommandClasses, Constructable<CommandClass>>;
type CCCommandMap = Map<string, Constructable<CommandClass>>;
type APIMap = Map<CommandClasses, APIConstructor>;

function getCCCommandMapKey(ccId: CommandClasses, ccCommand: number): string {
	return JSON.stringify({ ccId, ccCommand });
}

/**
 * May be used to define different expected CC responses depending on the sent CC
 */
export type DynamicCCResponse<
	TSent extends CommandClass,
	TReceived extends CommandClass = CommandClass
> = (
	sentCC: TSent,
) => Constructable<TReceived> | Constructable<TReceived>[] | undefined;

export type CCResponseRole =
	| boolean // The response was either expected or unexpected
	| "checkEncapsulated"; // The response role depends on the encapsulated CC

/**
 * A predicate function to test if a received CC matches the sent CC
 */
export type CCResponsePredicate<
	TSent extends CommandClass,
	TReceived extends CommandClass = CommandClass
> = (sentCommand: TSent, receivedCommand: TReceived) => CCResponseRole;

/**
 * Defines the command class associated with a Z-Wave message
 */
export function commandClass(
	cc: CommandClasses,
): TypedClassDecorator<CommandClass> {
	return (messageClass) => {
		Reflect.defineMetadata(METADATA_commandClass, cc, messageClass);

		// also store a map in the Message metadata for lookup.
		const map: CommandClassMap =
			Reflect.getMetadata(METADATA_commandClassMap, CommandClass) ||
			new Map();
		map.set(cc, (messageClass as any) as Constructable<CommandClass>);
		Reflect.defineMetadata(METADATA_commandClassMap, map, CommandClass);
	};
}

/**
 * Retrieves the command class defined for a Z-Wave message class
 */
export function getCommandClass<T extends CommandClass | CCAPI>(
	cc: T,
): CommandClasses {
	// get the class constructor
	const constr = cc.constructor;
	// retrieve the current metadata
	const ret: CommandClasses | undefined =
		cc instanceof CommandClass
			? Reflect.getMetadata(METADATA_commandClass, constr)
			: cc instanceof CCAPI
			? Reflect.getMetadata(METADATA_API, constr)
			: undefined;
	if (ret == undefined) {
		throw new ZWaveError(
			`No command class defined for ${constr.name}!`,
			ZWaveErrorCodes.CC_Invalid,
		);
	}
	return ret;
}

/**
 * Retrieves the function type defined for a Z-Wave message class
 */
export function getCommandClassStatic<T extends Constructable<CommandClass>>(
	classConstructor: T,
): CommandClasses {
	// retrieve the current metadata
	const ret = Reflect.getMetadata(METADATA_commandClass, classConstructor) as
		| CommandClasses
		| undefined;
	if (ret == undefined) {
		throw new ZWaveError(
			`No command class defined for ${classConstructor.name}!`,
			ZWaveErrorCodes.CC_Invalid,
		);
	}
	return ret;
}

/**
 * Looks up the command class constructor for a given command class type and function type
 */
export function getCCConstructor(
	cc: CommandClasses,
): Constructable<CommandClass> | undefined {
	// Retrieve the constructor map from the CommandClass class
	const map = Reflect.getMetadata(METADATA_commandClassMap, CommandClass) as
		| CommandClassMap
		| undefined;
	if (map != undefined) return map.get(cc);
}

/**
 * Defines the implemented version of a Z-Wave command class
 */
export function implementedVersion(
	version: number,
): TypedClassDecorator<CommandClass> {
	return (ccClass) => {
		Reflect.defineMetadata(METADATA_version, version, ccClass);
	};
}

/**
 * Retrieves the implemented version defined for a Z-Wave command class
 */
export function getImplementedVersion<T extends CommandClass>(
	cc: T | CommandClasses,
): number {
	// get the class constructor
	let constr: Constructable<CommandClass> | undefined;
	if (typeof cc === "number") {
		constr = getCCConstructor(cc);
	} else {
		constr = cc.constructor as Constructable<CommandClass>;
	}
	// retrieve the current metadata
	let ret: number | undefined;
	if (constr != undefined)
		ret = Reflect.getMetadata(METADATA_version, constr);
	if (ret == undefined) ret = 0;

	return ret;
}

/**
 * Retrieves the implemented version defined for a Z-Wave command class
 */
export function getImplementedVersionStatic<
	T extends Constructable<CommandClass>
>(classConstructor: T): number {
	// retrieve the current metadata
	const ret =
		(Reflect.getMetadata(METADATA_version, classConstructor) as
			| number
			| undefined) || 0;
	return ret;
}

/**
 * Defines the CC command a subclass of a CC implements
 */
export function CCCommand(command: number): TypedClassDecorator<CommandClass> {
	return (ccClass) => {
		Reflect.defineMetadata(METADATA_ccCommand, command, ccClass);

		// also store a map in the Message metadata for lookup.
		const ccId = getCommandClassStatic(
			(ccClass as unknown) as typeof CommandClass,
		);
		const map: CCCommandMap =
			Reflect.getMetadata(METADATA_ccCommandMap, CommandClass) ||
			new Map();
		map.set(
			getCCCommandMapKey(ccId, command),
			(ccClass as unknown) as Constructable<CommandClass>,
		);
		Reflect.defineMetadata(METADATA_ccCommandMap, map, CommandClass);
	};
}

/**
 * Retrieves the CC command a subclass of a CC implements
 */
function getCCCommand<T extends CommandClass>(cc: T): number | undefined {
	// get the class constructor
	const constr = cc.constructor as Constructable<CommandClass>;

	// retrieve the current metadata
	const ret = Reflect.getMetadata(METADATA_ccCommand, constr) as
		| number
		| undefined;

	return ret;
}

/**
 * Looks up the command class constructor for a given command class type and function type
 */
// wotan-disable-next-line no-misused-generics
function getCCCommandConstructor<TBase extends CommandClass>(
	ccId: CommandClasses,
	ccCommand: number,
): Constructable<TBase> | undefined {
	// Retrieve the constructor map from the CommandClass class
	const map = Reflect.getMetadata(METADATA_ccCommandMap, CommandClass) as
		| CCCommandMap
		| undefined;
	if (map != undefined)
		return (map.get(getCCCommandMapKey(ccId, ccCommand)) as unknown) as
			| Constructable<TBase>
			| undefined;
}

/**
 * Defines the expected response associated with a Z-Wave message
 */
export function expectedCCResponse<
	TSent extends CommandClass,
	TReceived extends CommandClass
>(
	cc: Constructable<TReceived> | DynamicCCResponse<TSent, TReceived>,
	predicate?: CCResponsePredicate<TSent, TReceived>,
): TypedClassDecorator<CommandClass> {
	return (ccClass) => {
		Reflect.defineMetadata(METADATA_ccResponse, { cc, predicate }, ccClass);
	};
}

/**
 * Retrieves the expected response (static or dynamic) defined for a Z-Wave message class
 */
export function getExpectedCCResponse<T extends CommandClass>(
	ccClass: T,
): typeof CommandClass | DynamicCCResponse<T> | undefined {
	// get the class constructor
	const constr = ccClass.constructor;
	// retrieve the current metadata
	const ret = Reflect.getMetadata(METADATA_ccResponse, constr) as
		| { cc: typeof CommandClass | DynamicCCResponse<T> }
		| undefined;
	return ret?.cc;
}

/**
 * Retrieves the CC response predicate defined for a Z-Wave message class
 */
export function getCCResponsePredicate<T extends CommandClass>(
	ccClass: T,
): CCResponsePredicate<T> | undefined {
	// get the class constructor
	const constr = ccClass.constructor;
	// retrieve the current metadata
	const ret = Reflect.getMetadata(METADATA_ccResponse, constr) as
		| { predicate: CCResponsePredicate<T> | undefined }
		| undefined;
	return ret?.predicate;
}

export interface CCValueOptions {
	/**
	 * Whether the decorated CC value is internal. Internal values are not
	 * exposed to the user.
	 */
	internal?: boolean;
	/**
	 * The minimum CC version required for this value to exist.
	 */
	minVersion?: number;
	/**
	 * Whether this value should always be created/persisted, even if it is undefined. Default: false
	 */
	forceCreation?: boolean;
	/**
	 * Whether this value represents a state (`true`) or a notification/event (`false`). Default: `true`
	 */
	stateful?: boolean;
}

/**
 * Marks the decorated property as a value of the Command Class. This allows saving it on the node with persistValues()
 * @param internal Whether the value should be exposed to library users
 */
export function ccValue(options?: CCValueOptions): PropertyDecorator {
	return (target: unknown, property: string | number | symbol) => {
		if (!target || !(target instanceof CommandClass)) return;
		// Set default arguments
		if (!options) options = {};
		if (options.internal == undefined) options.internal = false;
		if (options.minVersion == undefined) options.minVersion = 1;
		if (options.forceCreation == undefined) options.forceCreation = false;
		// get the class constructor
		const constr = target.constructor as typeof CommandClass;
		const cc = getCommandClassStatic(constr);
		// retrieve the current metadata
		const metadata =
			Reflect.getMetadata(METADATA_ccValues, CommandClass) ?? {};
		if (!(cc in metadata)) metadata[cc] = new Map();
		// And add the variable
		const variables: Map<string | number, CCValueOptions> = metadata[cc];
		variables.set(property as string | number, options);
		// store back to the object
		Reflect.defineMetadata(METADATA_ccValues, metadata, CommandClass);
	};
}

/**
 * Returns all CC values and their definitions that have been defined with @ccValue()
 */
function getCCValueDefinitions(
	commandClass: CommandClass,
): ReadonlyMap<string | number, CCValueOptions> {
	// get the class constructor
	const constr = commandClass.constructor as typeof CommandClass;
	const cc = getCommandClassStatic(constr);
	// retrieve the current metadata
	const metadata = Reflect.getMetadata(METADATA_ccValues, CommandClass) ?? {};
	if (!(cc in metadata)) return new Map();
	return metadata[cc] as Map<string | number, CCValueOptions>;
}

/**
 * Marks the decorated property as the key of a Command Class's key value pair,
 * which can later be saved with persistValues()
 * @param internal Whether the key value pair should be exposed to library users
 */
export function ccKeyValuePair(options?: CCValueOptions): PropertyDecorator {
	return (target: unknown, property: string | number | symbol) => {
		if (!target || !(target instanceof CommandClass)) return;
		// Set default arguments
		if (!options) options = {};
		if (options.internal == undefined) options.internal = false;
		if (options.minVersion == undefined) options.minVersion = 1;
		if (options.forceCreation == undefined) options.forceCreation = false;
		// get the class constructor
		const constr = target.constructor as typeof CommandClass;
		const cc = getCommandClassStatic(constr);
		// retrieve the current metadata
		const metadata =
			Reflect.getMetadata(METADATA_ccKeyValuePairs, CommandClass) || {};
		if (!(cc in metadata)) metadata[cc] = new Map();
		// And add the variable
		const variables: Map<string | number, CCValueOptions> = metadata[cc];
		variables.set(property as string | number, options);
		// store back to the object
		Reflect.defineMetadata(
			METADATA_ccKeyValuePairs,
			metadata,
			CommandClass,
		);
	};
}

/**
 * Returns all CC key value pairs and their definitions that have been defined with @ccKeyValuePair()
 */
function getCCKeyValuePairDefinitions(
	commandClass: CommandClass,
): ReadonlyMap<string | number, CCValueOptions> {
	// get the class constructor
	const constr = commandClass.constructor as typeof CommandClass;
	const cc = getCommandClassStatic(constr);
	// retrieve the current metadata
	const metadata =
		Reflect.getMetadata(METADATA_ccKeyValuePairs, CommandClass) || {};
	if (!(cc in metadata)) return new Map();
	return metadata[cc] as Map<string | number, CCValueOptions>;
}

/**
 * Defines additional metadata for the given CC value
 */
export function ccValueMetadata(meta: ValueMetadata): PropertyDecorator {
	return (target: unknown, property: string | number | symbol) => {
		if (!target || !(target instanceof CommandClass)) return;
		// get the class constructor
		const constr = target.constructor as typeof CommandClass;
		const cc = getCommandClassStatic(constr);
		// retrieve the current metadata
		const metadata =
			Reflect.getMetadata(METADATA_ccValueMeta, CommandClass) || {};
		if (!(cc in metadata)) metadata[cc] = new Map();
		// And add the variable
		const variables: Map<string | number, ValueMetadata> = metadata[cc];
		variables.set(property as string | number, meta);
		// store back to the object
		Reflect.defineMetadata(METADATA_ccValueMeta, metadata, CommandClass);
	};
}

/**
 * Retrieves defined metadata for the given CC value. If none is found, the default settings are returned.
 */
export function getCCValueMetadata(
	cc: CommandClasses,
	property: string | number,
): ValueMetadata {
	// retrieve the current metadata
	const metadata =
		Reflect.getMetadata(METADATA_ccValueMeta, CommandClass) || {};
	if (!(cc in metadata)) return ValueMetadata.Any;
	const map = metadata[cc] as Map<string | number, ValueMetadata>;
	if (map.has(property)) return map.get(property)!;
	return ValueMetadata.Any;
}

/**
 * Defines the simplified API associated with a Z-Wave command class
 */
export function API(cc: CommandClasses): TypedClassDecorator<CCAPI> {
	return (apiClass) => {
		// and store the metadata
		Reflect.defineMetadata(METADATA_API, cc, apiClass);

		// also store a map in the CCAPI metadata for lookup.
		const map = (Reflect.getMetadata(METADATA_APIMap, CCAPI) ||
			new Map()) as APIMap;
		map.set(cc, (apiClass as any) as APIConstructor);
		Reflect.defineMetadata(METADATA_APIMap, map, CCAPI);
	};
}

/**
 * Retrieves the implemented version defined for a Z-Wave command class
 */
export function getAPI(cc: CommandClasses): APIConstructor | undefined {
	// Retrieve the constructor map from the CCAPI class
	const map = Reflect.getMetadata(METADATA_APIMap, CCAPI) as
		| APIMap
		| undefined;
	const ret = map?.get(cc);

	return ret;
}
