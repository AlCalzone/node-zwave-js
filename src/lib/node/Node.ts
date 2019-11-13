import { composeObject } from "alcalzone-shared/objects";
import { isArray, isObject } from "alcalzone-shared/typeguards";
import { Overwrite } from "alcalzone-shared/types";
import { EventEmitter } from "events";
import { CCAPI } from "../commandclass/API";
import {
	CentralSceneCCNotification,
	CentralSceneKeys,
	getSceneValueId,
} from "../commandclass/CentralSceneCC";
import {
	CommandClass,
	getCCConstructor,
	getCCValueMetadata,
} from "../commandclass/CommandClass";
import { CommandClasses, getCCName } from "../commandclass/CommandClasses";
import { ConfigurationCC } from "../commandclass/ConfigurationCC";
import { getEndpointCCsValueId } from "../commandclass/MultiChannelCC";
import { NotificationCCReport } from "../commandclass/NotificationCC";
import { WakeUpCC, WakeUpCCWakeUpNotification } from "../commandclass/WakeUpCC";
import { lookupDevice } from "../config/Devices";
import { lookupNotification } from "../config/Notifications";
import {
	ApplicationUpdateRequest,
	ApplicationUpdateRequestNodeInfoReceived,
	ApplicationUpdateRequestNodeInfoRequestFailed,
} from "../controller/ApplicationUpdateRequest";
import {
	Baudrate,
	GetNodeProtocolInfoRequest,
	GetNodeProtocolInfoResponse,
} from "../controller/GetNodeProtocolInfoMessages";
import {
	GetRoutingInfoRequest,
	GetRoutingInfoResponse,
} from "../controller/GetRoutingInfoMessages";
import { Driver } from "../driver/Driver";
import { ZWaveError, ZWaveErrorCodes } from "../error/ZWaveError";
import log from "../log";
import { topologicalSort } from "../util/graph";
import { getEnumMemberName, JSONObject, Mixin } from "../util/misc";
import { num2hex, stringify } from "../util/strings";
import { CacheMetadata, CacheValue } from "../values/Cache";
import { ValueMetadata } from "../values/Metadata";
import {
	BasicDeviceClasses,
	DeviceClass,
	GenericDeviceClass,
	SpecificDeviceClass,
} from "./DeviceClass";
import { Endpoint } from "./Endpoint";
import { InterviewStage, IZWaveNode, NodeStatus } from "./INode";
import { NodeUpdatePayload } from "./NodeInfo";
import {
	RequestNodeInfoRequest,
	RequestNodeInfoResponse,
} from "./RequestNodeInfoMessages";
import {
	MetadataUpdatedArgs,
	ValueAddedArgs,
	ValueDB,
	ValueID,
	valueIdToString,
	ValueRemovedArgs,
	ValueUpdatedArgs,
} from "./ValueDB";

export interface TranslatedValueID extends ValueID {
	commandClassName: string;
	propertyKeyName?: string;
}

export type ZWaveNodeValueAddedArgs = ValueAddedArgs & TranslatedValueID;
export type ZWaveNodeValueUpdatedArgs = ValueUpdatedArgs & TranslatedValueID;
export type ZWaveNodeValueRemovedArgs = ValueRemovedArgs & TranslatedValueID;
export type ZWaveNodeMetadataUpdatedArgs = MetadataUpdatedArgs &
	TranslatedValueID;

export type ZWaveNodeValueAddedCallback = (
	node: ZWaveNode,
	args: ZWaveNodeValueAddedArgs,
) => void;
export type ZWaveNodeValueUpdatedCallback = (
	node: ZWaveNode,
	args: ZWaveNodeValueUpdatedArgs,
) => void;
export type ZWaveNodeValueRemovedCallback = (
	node: ZWaveNode,
	args: ZWaveNodeValueRemovedArgs,
) => void;
export type ZWaveNodeMetadataUpdatedCallback = (
	node: ZWaveNode,
	args: ZWaveNodeMetadataUpdatedArgs,
) => void;

export type ZWaveNotificationCallback = (
	node: ZWaveNode,
	notificationLabel: string,
	parameters?: Buffer,
) => void;

interface ZWaveNodeValueEventCallbacks {
	"value added": ZWaveNodeValueAddedCallback;
	"value updated": ZWaveNodeValueUpdatedCallback;
	"value removed": ZWaveNodeValueRemovedCallback;
	"metadata updated": ZWaveNodeMetadataUpdatedCallback;
	notification: ZWaveNotificationCallback;
}

type ZWaveNodeEventCallbacks = Overwrite<
	{
		[K in "wake up" | "sleep" | "interview completed" | "dead" | "alive"]: (
			node: ZWaveNode,
		) => void;
	},
	ZWaveNodeValueEventCallbacks
>;

export type ZWaveNodeEvents = Extract<keyof ZWaveNodeEventCallbacks, string>;

export interface ZWaveNode {
	on<TEvent extends ZWaveNodeEvents>(
		event: TEvent,
		callback: ZWaveNodeEventCallbacks[TEvent],
	): this;
	once<TEvent extends ZWaveNodeEvents>(
		event: TEvent,
		callback: ZWaveNodeEventCallbacks[TEvent],
	): this;
	removeListener<TEvent extends ZWaveNodeEvents>(
		event: TEvent,
		callback: ZWaveNodeEventCallbacks[TEvent],
	): this;
	off<TEvent extends ZWaveNodeEvents>(
		event: TEvent,
		callback: ZWaveNodeEventCallbacks[TEvent],
	): this;
	removeAllListeners(event?: ZWaveNodeEvents): this;

	emit<TEvent extends ZWaveNodeEvents>(
		event: TEvent,
		...args: Parameters<ZWaveNodeEventCallbacks[TEvent]>
	): this;
}

/**
 * A ZWaveNode represents a node in a Z-Wave network. It is also an instance
 * of its root endpoint (index 0)
 */
@Mixin([EventEmitter])
export class ZWaveNode extends Endpoint implements IZWaveNode {
	public constructor(
		public readonly id: number,
		driver: Driver,
		deviceClass?: DeviceClass,
		supportedCCs: CommandClasses[] = [],
		controlledCCs: CommandClasses[] = [],
	) {
		// Define this node's intrinsic endpoint as the root device (0)
		super(id, driver, 0);

		this._valueDB = new ValueDB();
		for (const event of [
			"value added",
			"value updated",
			"value removed",
			"metadata updated",
		] as const) {
			this._valueDB.on(event, this.translateValueEvent.bind(this, event));
		}

		this._deviceClass = deviceClass;
		for (const cc of supportedCCs) this.addCC(cc, { isSupported: true });
		for (const cc of controlledCCs) this.addCC(cc, { isControlled: true });
	}

	/**
	 * Enhances a value id so it can be consumed better by applications
	 */
	private translateValueID<T extends ValueID>(
		valueId: T,
	): T & TranslatedValueID {
		// Try to retrieve the speaking CC name
		const commandClassName = getCCName(valueId.commandClass);
		const ret: T & TranslatedValueID = {
			commandClassName,
			...valueId,
		};
		const ccConstructor: typeof CommandClass =
			(getCCConstructor(valueId.commandClass) as any) || CommandClass;
		// Try to retrieve the speaking property key
		if (valueId.propertyKey != undefined) {
			const propertyKey = ccConstructor.translatePropertyKey(
				valueId.propertyName,
				valueId.propertyKey,
			);
			ret.propertyKeyName = propertyKey;
		}
		return ret;
	}

	/**
	 * Enhances the raw event args of the ValueDB so it can be consumed better by applications
	 */
	private translateValueEvent<T extends ValueID>(
		eventName: keyof ZWaveNodeValueEventCallbacks,
		arg: T,
	): void {
		// Try to retrieve the speaking CC name
		const outArg = this.translateValueID(arg);
		// If this is a metadata event, make sure we return the merged metadata
		if ("metadata" in outArg) {
			((outArg as unknown) as MetadataUpdatedArgs).metadata = this.getValueMetadata(
				arg,
			);
		}
		// Log the value change
		const ccInstance = this.createCCInstanceInternal(arg.commandClass);
		const isInternalValue =
			ccInstance && ccInstance.isInternalValue(arg.propertyName as any);
		// I don't like the splitting and any but its the easiest solution here
		const [changeTarget, changeType] = eventName.split(" ");
		const logArgument = {
			...outArg,
			nodeId: this.nodeId,
			internal: isInternalValue,
		};
		if (changeTarget === "value") {
			log.controller.value(changeType as any, logArgument as any);
		} else if (changeTarget === "metadata") {
			log.controller.metadataUpdated(logArgument);
		}
		if (!isInternalValue) {
			// And pass the translated event to our listeners
			this.emit(eventName, this, outArg as any);
		}
	}

	//#region --- properties ---

	private _status: NodeStatus = NodeStatus.Unknown;
	/**
	 * Which status the node is believed to be in. Changing this emits the corresponding events.
	 * There should be no need to set this property from outside this library.
	 */
	public get status(): NodeStatus {
		return this._status;
	}
	public set status(value: NodeStatus) {
		const oldStatus = this._status;
		this._status = value;
		if (oldStatus === this._status) return;

		if (oldStatus !== NodeStatus.Unknown) {
			if (oldStatus === NodeStatus.Dead) {
				this.emit("alive", this);
			}
			if (this._status === NodeStatus.Asleep) {
				this.emit("sleep", this);
			} else if (this._status === NodeStatus.Awake) {
				this.emit("wake up", this);
			} else if (this._status === NodeStatus.Dead) {
				this.emit("dead", this);
			}
		}
	}

	private _deviceClass: DeviceClass | undefined;
	public get deviceClass(): DeviceClass | undefined {
		return this._deviceClass;
	}

	private _isListening: boolean | undefined;
	public get isListening(): boolean | undefined {
		return this._isListening;
	}

	private _isFrequentListening: boolean | undefined;
	public get isFrequentListening(): boolean | undefined {
		return this._isFrequentListening;
	}

	private _isRouting: boolean | undefined;
	public get isRouting(): boolean | undefined {
		return this._isRouting;
	}

	private _maxBaudRate: Baudrate | undefined;
	public get maxBaudRate(): Baudrate | undefined {
		return this._maxBaudRate;
	}

	private _isSecure: boolean | undefined;
	public get isSecure(): boolean | undefined {
		return this._isSecure;
	}

	private _version: number | undefined;
	/** The Z-Wave protocol version this node implements */
	public get version(): number | undefined {
		return this._version;
	}

	private _isBeaming: boolean | undefined;
	public get isBeaming(): boolean | undefined {
		return this._isBeaming;
	}

	public get manufacturerId(): number | undefined {
		return this.getValue({
			commandClass: CommandClasses["Manufacturer Specific"],
			propertyName: "manufacturerId",
		});
	}

	public get productId(): number | undefined {
		return this.getValue({
			commandClass: CommandClasses["Manufacturer Specific"],
			propertyName: "productId",
		});
	}

	public get productType(): number | undefined {
		return this.getValue({
			commandClass: CommandClasses["Manufacturer Specific"],
			propertyName: "productType",
		});
	}

	public get firmwareVersion(): string | undefined {
		return this.getValue({
			commandClass: CommandClasses.Version,
			propertyName: "firmwareVersion",
		});
	}

	private _neighbors: readonly number[] = [];
	/** The IDs of all direct neighbors of this node */
	public get neighbors(): readonly number[] {
		return this._neighbors;
	}

	private nodeInfoReceived: boolean = false;

	private _valueDB = new ValueDB();
	/**
	 * Provides access to this node's values
	 * @internal
	 */
	public get valueDB(): ValueDB {
		return this._valueDB;
	}

	/**
	 * Retrieves a stored value for a given value id.
	 * This does not request an updated value from the node!
	 */
	/* wotan-disable-next-line no-misused-generics */
	public getValue<T = unknown>(valueId: ValueID): T | undefined {
		return this._valueDB.getValue(valueId);
	}

	/**
	 * Retrieves metadata for a given value id.
	 * This can be used to enhance the user interface of an application
	 */
	public getValueMetadata(valueId: ValueID): ValueMetadata {
		const { commandClass, propertyName } = valueId;
		return {
			// Merge static metadata
			...getCCValueMetadata(commandClass, propertyName),
			// with potentially existing dynamic metadata
			...this._valueDB.getMetadata(valueId),
		};
	}

	/** Returns a list of all value names that are defined on all endpoints of this node */
	public getDefinedValueIDs(): TranslatedValueID[] {
		const ret: TranslatedValueID[] = [];
		for (const endpoint of this.getAllEndpoints()) {
			for (const cc of endpoint.implementedCommandClasses.keys()) {
				const ccInstance = endpoint.createCCInstanceUnsafe(cc);
				if (ccInstance) {
					ret.push(
						...ccInstance
							.getDefinedValueIDs()
							.map(this.translateValueID),
					);
				}
			}
		}
		return ret;
	}

	/**
	 * Updates a value for a given property of a given CommandClass on the node.
	 * This will communicate with the node!
	 */
	public async setValue(valueId: ValueID, value: unknown): Promise<boolean> {
		// Try to retrieve the corresponding CC API
		try {
			// Access the CC API by name
			const endpointInstance = this.getEndpoint(valueId.endpoint || 0);
			if (!endpointInstance) return false;
			const api = (endpointInstance.commandClasses as any)[
				valueId.commandClass
			] as CCAPI;
			// Check if the setValue method is implemented
			if (!api.setValue) return false;
			// And call it
			await api.setValue(
				{
					propertyName: valueId.propertyName,
					propertyKey: valueId.propertyKey,
				},
				value,
			);
			return true;
		} catch (e) {
			if (
				e instanceof ZWaveError &&
				(e.code === ZWaveErrorCodes.CC_NotImplemented ||
					e.code === ZWaveErrorCodes.CC_NoAPI)
			) {
				// This CC or API is not implemented
				return false;
			}
			throw e;
		}
	}

	public get endpointCountIsDynamic(): boolean | undefined {
		return this.getValue({
			commandClass: CommandClasses["Multi Channel"],
			propertyName: "countIsDynamic",
		});
	}

	public get endpointsHaveIdenticalCapabilities(): boolean | undefined {
		return this.getValue({
			commandClass: CommandClasses["Multi Channel"],
			propertyName: "identicalCapabilities",
		});
	}

	public get individualEndpointCount(): number | undefined {
		return this.getValue({
			commandClass: CommandClasses["Multi Channel"],
			propertyName: "individualCount",
		});
	}

	public get aggregatedEndpointCount(): number | undefined {
		return this.getValue({
			commandClass: CommandClasses["Multi Channel"],
			propertyName: "aggregatedCount",
		});
	}

	private getEndpointCCs(index: number): CommandClasses[] | undefined {
		return this.getValue(
			getEndpointCCsValueId(
				this.endpointsHaveIdenticalCapabilities ? 1 : index,
			),
		);
	}

	/** Returns the current endpoint count of this node */
	public getEndpointCount(): number {
		return (
			(this.individualEndpointCount || 0) +
			(this.aggregatedEndpointCount || 0)
		);
	}

	/** Cache for this node's endpoint instances */
	private _endpointInstances = new Map<number, Endpoint>();
	/**
	 * Returns an endpoint of this node with the given index. 0 returns the node itself.
	 */
	public getEndpoint(index: 0): Endpoint;
	public getEndpoint(index: number): Endpoint | undefined;
	public getEndpoint(index: number): Endpoint | undefined {
		if (index < 0)
			throw new ZWaveError(
				"The endpoint index must be positive!",
				ZWaveErrorCodes.Argument_Invalid,
			);
		// Zero is the root endpoint - i.e. this node
		if (index === 0) return this;
		// Check if the requested endpoint exists on the physical node
		if (index > this.getEndpointCount()) return undefined;
		// Create an endpoint instance if it does not exist
		if (!this._endpointInstances.has(index)) {
			this._endpointInstances.set(
				index,
				new Endpoint(
					this.id,
					this.driver,
					index,
					this.getEndpointCCs(index),
				),
			);
		}
		return this._endpointInstances.get(index)!;
	}

	/** Returns a list of all endpoints of this node, including the root endpoint (index 0) */
	public getAllEndpoints(): Endpoint[] {
		const ret: Endpoint[] = [this];
		for (let i = 1; i <= this.getEndpointCount(); i++) {
			// Iterating over the endpoint count ensures that we don't get undefined
			ret.push(this.getEndpoint(i)!);
		}
		return ret;
	}

	/**
	 * This tells us which interview stage was last completed
	 */
	public interviewStage: InterviewStage = InterviewStage.None;

	//#endregion

	/** Utility function to check if this node is the controller */
	public isControllerNode(): boolean {
		return this.id === this.driver.controller.ownNodeId;
	}

	//#region --- interview ---

	/**
	 * @internal
	 * Interviews this node. Returns true when it succeeded, false otherwise
	 */
	public async interview(): Promise<boolean> {
		if (this.interviewStage === InterviewStage.Complete) {
			log.controller.logNode(
				this.id,
				`skipping interview because it is already completed`,
			);
			return true;
		} else {
			log.controller.interviewStart(this);
		}

		// The interview is done in several stages. At each point, the interview process might be aborted
		// due to a stage failing. The reached stage is saved, so we can continue it later without
		// repeating stages unnecessarily

		if (this.interviewStage === InterviewStage.None) {
			// do a full interview starting with the protocol info
			log.controller.logNode(
				this.id,
				`new node, doing a full interview...`,
			);
			await this.queryProtocolInfo();
		}

		// The following stages require communication with the node. Before continuing, we
		// ping the node to see if it is alive and awake

		if (this.interviewStage >= InterviewStage.ProtocolInfo) {
			// Make sure the device answers
			if (!(await this.ping())) return false;
		}

		if (this.interviewStage === InterviewStage.ProtocolInfo) {
			await this.queryNodeInfo();
		}

		// // TODO:
		// // SecurityReport,			// [ ] Retrieve a list of Command Classes that require Security

		// At this point the basic interview of new nodes is done. Start here when re-interviewing known nodes
		// to get updated information about command classes
		if (
			this.interviewStage === InterviewStage.RestartFromCache ||
			this.interviewStage === InterviewStage.NodeInfo
		) {
			await this.interviewCCs();
		}

		if (this.interviewStage === InterviewStage.CommandClasses) {
			// Load a config file for this node if it exists and overwrite the previously reported information
			await this.overwriteConfig();
		}

		if (this.interviewStage === InterviewStage.OverwriteConfig) {
			// Request a list of this node's neighbors
			await this.queryNeighbors();
		}

		// for testing purposes we skip to the end
		await this.setInterviewStage(InterviewStage.Complete);

		// Tell listeners that the interview is completed
		// The driver will send this node to sleep
		this.emit("interview completed", this);
		return true;
	}

	/** Updates this node's interview stage and saves to cache when appropriate */
	private async setInterviewStage(
		completedStage: InterviewStage,
	): Promise<void> {
		this.interviewStage = completedStage;
		// Also save to the cache after certain stages
		switch (completedStage) {
			case InterviewStage.ProtocolInfo:
			case InterviewStage.NodeInfo:
			case InterviewStage.CommandClasses:
			case InterviewStage.Complete:
				await this.driver.saveNetworkToCache();
		}
		log.controller.interviewStage(this);
	}

	/** Step #1 of the node interview */
	protected async queryProtocolInfo(): Promise<void> {
		log.controller.logNode(this.id, {
			message: "querying protocol info...",
			direction: "outbound",
		});
		const resp = await this.driver.sendMessage<GetNodeProtocolInfoResponse>(
			new GetNodeProtocolInfoRequest(this.driver, { nodeId: this.id }),
		);
		this._deviceClass = resp.deviceClass;
		this._isListening = resp.isListening;
		this._isFrequentListening = resp.isFrequentListening;
		this._isRouting = resp.isRouting;
		this._maxBaudRate = resp.maxBaudRate;
		this._isSecure = resp.isSecure;
		this._version = resp.version;
		this._isBeaming = resp.isBeaming;

		let logMessage = "received response for protocol info:";
		if (this.deviceClass) {
			logMessage += `
basic device class:    ${BasicDeviceClasses[this.deviceClass.basic]} (${num2hex(
				this.deviceClass.basic,
			)})
generic device class:  ${this.deviceClass.generic.name} (${num2hex(
				this.deviceClass.generic.key,
			)})
specific device class: ${this.deviceClass.specific.name} (${num2hex(
				this.deviceClass.specific.key,
			)})`;
		}
		logMessage += `
is a listening device: ${this.isListening}
is frequent listening: ${this.isFrequentListening}
is a routing device:   ${this.isRouting}
is a secure device:    ${this.isSecure}
is a beaming device:   ${this.isBeaming}
is a listening device: ${this.isListening}
maximum baud rate:     ${this.maxBaudRate} kbps
version:               ${this.version}`;
		log.controller.logNode(this.id, {
			message: logMessage,
			direction: "inbound",
		});

		if (!this.isListening && !this.isFrequentListening) {
			// This is a "sleeping" device which must support the WakeUp CC.
			// We are requesting the supported CCs later, but those commands may need to go into the
			// wakeup queue. Thus we need to mark WakeUp as supported
			this.addCC(CommandClasses["Wake Up"], {
				isSupported: true,
			});
			// Assume the node is awake, after all we're communicating with it.
			this.setAwake(true);
		}

		await this.setInterviewStage(InterviewStage.ProtocolInfo);
	}

	/** Node interview: pings the node to see if it responds */
	protected async ping(): Promise<boolean> {
		if (this.isControllerNode()) {
			log.controller.logNode(this.id, "not pinging the controller");
		} else {
			log.controller.logNode(this.id, {
				message: "pinging the node...",
				direction: "outbound",
			});

			try {
				await this.commandClasses["No Operation"].send();
				log.controller.logNode(this.id, {
					message: "ping successful",
					direction: "inbound",
				});
			} catch (e) {
				log.controller.logNode(this.id, "ping failed: " + e.message);
				return false;
			}
		}
		return true;
	}

	/** Step #5 of the node interview */
	protected async queryNodeInfo(): Promise<void> {
		if (this.isControllerNode()) {
			log.controller.logNode(
				this.id,
				"not querying node info from the controller",
			);
		} else {
			log.controller.logNode(this.id, {
				message: "querying node info...",
				direction: "outbound",
			});
			const resp = await this.driver.sendMessage<
				RequestNodeInfoResponse | ApplicationUpdateRequest
			>(new RequestNodeInfoRequest(this.driver, { nodeId: this.id }));
			if (
				(resp instanceof RequestNodeInfoResponse && !resp.wasSent) ||
				resp instanceof ApplicationUpdateRequestNodeInfoRequestFailed
			) {
				log.controller.logNode(
					this.id,
					`querying the node info failed`,
					"error",
				);
			} else if (
				resp instanceof ApplicationUpdateRequestNodeInfoReceived
			) {
				const logLines: string[] = [
					"node info received",
					"supported CCs:",
				];
				for (const cc of resp.nodeInformation.supportedCCs) {
					const ccName = CommandClasses[cc];
					logLines.push(`· ${ccName ? ccName : num2hex(cc)}`);
				}
				logLines.push("controlled CCs:");
				for (const cc of resp.nodeInformation.controlledCCs) {
					const ccName = CommandClasses[cc];
					logLines.push(`· ${ccName ? ccName : num2hex(cc)}`);
				}
				log.controller.logNode(this.id, {
					message: logLines.join("\n"),
					direction: "inbound",
				});
				this.updateNodeInfo(resp.nodeInformation);
			}
		}
		await this.setInterviewStage(InterviewStage.NodeInfo);
	}

	/** Step #? of the node interview */
	protected async interviewCCs(): Promise<void> {
		// We determine the correct interview order by topologically sorting a dependency graph
		let interviewGraph = this.buildCCInterviewGraph();
		let interviewOrder: CommandClasses[];
		try {
			interviewOrder = topologicalSort(interviewGraph);
		} catch (e) {
			// This interview cannot be done
			throw new ZWaveError(
				"The CC interview cannot be completed because there are circular dependencies between CCs!",
				ZWaveErrorCodes.CC_Invalid,
			);
		}

		// Now that we know the correct order, do the interview in sequence
		for (const cc of interviewOrder) {
			try {
				let instance: CommandClass;
				try {
					instance = this.createCCInstance(cc)!;
				} catch (e) {
					if (
						e instanceof ZWaveError &&
						e.code === ZWaveErrorCodes.CC_NotSupported
					) {
						// The CC is no longer supported. This can happen if the node tells us
						// something different in the Version interview than it did in its NIF
						continue;
					}
					// we want to pass all other errors through
					throw e;
				}
				await instance.interview(!instance.interviewComplete);
				await this.driver.saveNetworkToCache();
			} catch (e) {
				// TODO: Should this cancel the entire interview procedure?
				log.controller.print(
					`${getEnumMemberName(
						CommandClasses,
						cc,
					)}: Interview failed:\n${e.message}`,
					"error",
				);
			}
		}

		// Now query ALL endpoints
		for (
			let endpointIndex = 1;
			endpointIndex <= this.getEndpointCount();
			endpointIndex++
		) {
			const endpoint = this.getEndpoint(endpointIndex);
			if (!endpoint) continue;

			interviewGraph = endpoint.buildCCInterviewGraph();
			try {
				interviewOrder = topologicalSort(interviewGraph);
			} catch (e) {
				// This interview cannot be done
				throw new ZWaveError(
					"The CC interview cannot be completed because there are circular dependencies between CCs!",
					ZWaveErrorCodes.CC_Invalid,
				);
			}

			// Now that we know the correct order, do the interview in sequence
			for (const cc of interviewOrder) {
				try {
					let instance: CommandClass;
					try {
						instance = endpoint.createCCInstance(cc)!;
					} catch (e) {
						if (
							e instanceof ZWaveError &&
							e.code === ZWaveErrorCodes.CC_NotSupported
						) {
							// The CC is no longer supported. This can happen if the node tells us
							// something different in the Version interview than it did in its NIF
							continue;
						}
						// we want to pass all other errors through
						throw e;
					}
					await instance.interview(!instance.interviewComplete);
					await this.driver.saveNetworkToCache();
				} catch (e) {
					// TODO: Should this cancel the entire interview procedure?
					log.controller.print(
						`${getEnumMemberName(
							CommandClasses,
							cc,
						)}: Interview failed:\n${e.message}`,
						"error",
					);
				}
			}
		}

		// If a node or endpoint supports any actuator CC, don't offer the Basic CC
		for (const endpoint of this.getAllEndpoints()) {
			endpoint.hideBasicCCInFavorOfActuatorCCs();
		}

		// TODO: Overwrite the reported config with configuration files (like OZW does)

		await this.setInterviewStage(InterviewStage.CommandClasses);
	}

	/**
	 * @internal
	 * Handles the receipt of a NIF / NodeUpdatePayload
	 */
	public updateNodeInfo(nodeInfo: NodeUpdatePayload): void {
		if (!this.nodeInfoReceived) {
			for (const cc of nodeInfo.supportedCCs)
				this.addCC(cc, { isSupported: true });
			for (const cc of nodeInfo.controlledCCs)
				this.addCC(cc, { isControlled: true });
			this.nodeInfoReceived = true;
		}

		// As the NIF is sent on wakeup, treat this as a sign that the node is awake
		this.setAwake(true);
	}

	/** Overwrites the reported configuration with information from a config file */
	protected async overwriteConfig(): Promise<void> {
		if (this.isControllerNode()) {
			log.controller.logNode(
				this.id,
				"not loading device config for the controller",
			);
		} else if (
			this.manufacturerId == undefined ||
			this.productId == undefined ||
			this.productType == undefined
		) {
			log.controller.logNode(
				this.id,
				"device information incomplete, cannot load config file",
				"error",
			);
		} else {
			log.controller.logNode(this.id, "trying to load device config");
			const config = await lookupDevice(
				this.manufacturerId,
				this.productType,
				this.productId,
				this.firmwareVersion,
			);
			if (config) {
				if (isObject(config.configuration)) {
					const configCC = this.createCCInstance(ConfigurationCC)!;
					configCC.deserializeParamInformationFromConfig(
						config.configuration,
					);
				} else {
					log.controller.logNode(
						this.id,
						"  invalid config file!",
						"error",
					);
				}
			} else {
				log.controller.logNode(
					this.id,
					"  no device config file found!",
				);
			}
		}
		await this.setInterviewStage(InterviewStage.OverwriteConfig);
	}

	/** @internal */
	public async queryNeighborsInternal(): Promise<void> {
		log.controller.logNode(this.id, {
			message: "requesting node neighbors...",
			direction: "outbound",
		});
		try {
			const resp = await this.driver.sendMessage<GetRoutingInfoResponse>(
				new GetRoutingInfoRequest(this.driver, {
					nodeId: this.id,
					removeBadLinks: false,
					removeNonRepeaters: false,
				}),
			);
			this._neighbors = resp.nodeIds;
			log.controller.logNode(this.id, {
				message: `  node neighbors received: ${this._neighbors.join(
					", ",
				)}`,
				direction: "inbound",
			});
		} catch (e) {
			log.controller.logNode(
				this.id,
				`  requesting the node neighbors failed: ${e.message}`,
				"error",
			);
			throw e;
		}
	}

	/** Queries a node for its neighbor nodes during the node interview */
	protected async queryNeighbors(): Promise<void> {
		await this.queryNeighborsInternal();
		await this.setInterviewStage(InterviewStage.Neighbors);
	}

	//#endregion

	// TODO: Add a handler around for each CC to interpret the received data

	/**
	 * @internal
	 * Handles an ApplicationCommandRequest received from this node
	 */
	public async handleCommand(command: CommandClass): Promise<void> {
		if (command instanceof CentralSceneCCNotification) {
			return this.handleCentralSceneNotification(command);
		} else if (command instanceof WakeUpCCWakeUpNotification) {
			return this.handleWakeUpNotification();
		} else if (command instanceof NotificationCCReport) {
			return this.handleNotificationReport(command);
		}

		log.controller.logNode(this.id, {
			message: `TODO: no handler for application command ${stringify(
				command,
			)}`,
			direction: "inbound",
		});
	}

	/** Stores information about a currently held down key */
	private centralSceneKeyHeldDownContext:
		| {
				timeout: NodeJS.Timer;
				sceneNumber: number;
		  }
		| undefined;
	private lastCentralSceneNotificationSequenceNumber: number | undefined;

	/** Handles the receipt of a Central Scene notifification */
	private async handleCentralSceneNotification(
		command: CentralSceneCCNotification,
	): Promise<void> {
		// Did we already receive this command?
		if (
			command.sequenceNumber ===
			this.lastCentralSceneNotificationSequenceNumber
		) {
			return;
		} else {
			this.lastCentralSceneNotificationSequenceNumber =
				command.sequenceNumber;
		}
		/*
		If the Slow Refresh field is false:
		- A new Key Held Down notification MUST be sent every 200ms until the key is released.
		- The Sequence Number field MUST be updated at each notification transmission.
		- If not receiving a new Key Held Down notification within 400ms, a controlling node SHOULD use an adaptive timeout approach as described in 4.17.1:
		A controller SHOULD apply an adaptive approach based on the reception of the Key Released Notification. 
		Initially, the controller SHOULD time out if not receiving any Key Held Down Notification refresh after 
		400ms and consider this to be a Key Up Notification. If, however, the controller subsequently receives a 
		Key Released Notification, the controller SHOULD consider the sending node to be operating with the Slow 
		Refresh capability enabled.

		If the Slow Refresh field is true:
		- A new Key Held Down notification MUST be sent every 55 seconds until the key is released.
		- The Sequence Number field MUST be updated at each notification refresh.
		- If not receiving a new Key Held Down notification within 60 seconds after the most recent Key Held Down 
		notification, a receiving node MUST respond as if it received a Key Release notification.
		*/

		const setSceneValue = (
			sceneNumber: number,
			key: CentralSceneKeys,
		): void => {
			const valueId = getSceneValueId(sceneNumber);
			this.valueDB.setValue(valueId, key);
		};

		const forceKeyUp = (): void => {
			// force key up event
			setSceneValue(
				this.centralSceneKeyHeldDownContext!.sceneNumber,
				CentralSceneKeys.KeyReleased,
			);
			// clear old timer
			clearTimeout(this.centralSceneKeyHeldDownContext!.timeout);
			// clear the key down context
			this.centralSceneKeyHeldDownContext = undefined;
		};

		if (
			this.centralSceneKeyHeldDownContext &&
			this.centralSceneKeyHeldDownContext.sceneNumber !==
				command.sceneNumber
		) {
			// The user pressed another button, force release
			forceKeyUp();
		}

		if (command.keyAttribute === CentralSceneKeys.KeyHeldDown) {
			// Set or refresh timer to force a release of the key
			if (this.centralSceneKeyHeldDownContext) {
				clearTimeout(this.centralSceneKeyHeldDownContext.timeout);
			}
			this.centralSceneKeyHeldDownContext = {
				sceneNumber: command.sceneNumber,
				// Unref'ing long running timers allows the process to exit mid-timeout
				timeout: setTimeout(
					forceKeyUp,
					command.slowRefresh ? 60000 : 400,
				).unref(),
			};
		} else if (command.keyAttribute === CentralSceneKeys.KeyReleased) {
			// Stop the release timer
			if (this.centralSceneKeyHeldDownContext) {
				clearTimeout(this.centralSceneKeyHeldDownContext.timeout);
				this.centralSceneKeyHeldDownContext = undefined;
			}
		}

		setSceneValue(command.sceneNumber, command.keyAttribute);
		log.controller.logNode(this.id, {
			message: `received CentralScene notification ${stringify(command)}`,
			direction: "inbound",
		});
	}

	/** Handles the receipt of a Wake Up notification */
	private handleWakeUpNotification(): void {
		log.controller.logNode(this.id, {
			message: `received wakeup notification`,
			direction: "inbound",
		});
		this.setAwake(true);
	}

	/**
	 * Allows automatically resetting notification values to idle if the node does not do it itself
	 */
	private notificationIdleTimeouts = new Map<string, NodeJS.Timeout>();
	/** Schedules a notification value to be reset */
	private scheduleNotificationIdleReset(
		valueId: ValueID,
		handler: () => void,
	): void {
		this.clearNotificationIdleReset(valueId);
		const key = valueIdToString(valueId);
		this.notificationIdleTimeouts.set(
			key,
			// Unref'ing long running timeouts allows to quit the application before the timeout elapses
			setTimeout(handler, 5 * 3600 * 1000 /* 5 minutes */).unref(),
		);
	}

	/** Removes a scheduled notification reset */
	private clearNotificationIdleReset(valueId: ValueID): void {
		const key = valueIdToString(valueId);
		if (this.notificationIdleTimeouts.has(key)) {
			clearTimeout(this.notificationIdleTimeouts.get(key)!);
			this.notificationIdleTimeouts.delete(key);
		}
	}

	/** Handles the receipt of a Notification Report */
	private handleNotificationReport(command: NotificationCCReport): void {
		if (command.notificationType == undefined) {
			log.controller.logNode(this.id, {
				message: `received unsupported notification ${stringify(
					command,
				)}`,
				direction: "inbound",
			});
			return;
		}

		// Look up the received notification in the config
		const notificationConfig = lookupNotification(command.notificationType);

		if (notificationConfig) {
			// This is a known notification (status or event)
			const propertyName = notificationConfig.name;

			/** Returns a single notification state to idle */
			const setStateIdle = (prevValue: number): void => {
				const valueConfig = notificationConfig.lookupValue(prevValue);
				// Only known variables may be reset to idle
				if (!valueConfig || valueConfig.type !== "state") return;
				// Some properties may not be reset to idle
				if (!valueConfig.idle) return;

				const propertyKey = valueConfig.variableName;
				const valueId = {
					commandClass: command.ccId,
					endpoint: command.endpointIndex,
					propertyName,
					propertyKey,
				};
				// Since the node has reset the notification itself, we don't need the idle reset
				this.clearNotificationIdleReset(valueId);
				this.valueDB.setValue(valueId, 0 /* idle */);
			};

			const value = command.notificationEvent!;
			if (value === 0) {
				// Generic idle notification, this contains a value to be reset
				if (
					Buffer.isBuffer(command.eventParameters) &&
					command.eventParameters.length
				) {
					// The target value is the first byte of the event parameters
					setStateIdle(command.eventParameters[0]);
				} else {
					// Reset all values to idle
					const nonIdleValues = this.valueDB
						.getValues(CommandClasses.Notification)
						.filter(
							v =>
								(v.endpoint || 0) === command.endpointIndex &&
								v.propertyName === propertyName &&
								typeof v.value === "number" &&
								v.value !== 0,
						);
					for (const v of nonIdleValues) {
						setStateIdle(v.value as number);
					}
				}
				return;
			}

			let propertyKey: string;
			// Find out which property we need to update
			const valueConfig = notificationConfig.lookupValue(value);
			let allowIdleReset: boolean;
			if (!valueConfig) {
				// This is an unknown value, collect it in an unknown bucket
				propertyKey = "unknown";
				// We don't know what this notification refers to, so we don't force a reset
				allowIdleReset = false;
			} else if (valueConfig.type === "state") {
				propertyKey = valueConfig.variableName;
				allowIdleReset = valueConfig.idle;
			} else {
				this.emit(
					"notification",
					this,
					valueConfig.label,
					command.eventParameters,
				);
				return;
			}
			// Now that we've gathered all we need to know, update the value in our DB
			const valueId = {
				commandClass: command.ccId,
				endpoint: command.endpointIndex,
				propertyName,
				propertyKey,
			};
			this.valueDB.setValue(valueId, value);
			// Nodes before V8 don't necessarily reset the notification to idle
			// Set a fallback timer in case the node does not reset it.
			if (
				allowIdleReset &&
				this.driver.getSafeCCVersionForNode(
					CommandClasses.Notification,
					this.id,
				) <= 7
			) {
				this.scheduleNotificationIdleReset(valueId, () =>
					setStateIdle(value),
				);
			}
		} else {
			// This is an unknown notification
			const propertyName = `UNKNOWN_${num2hex(command.notificationType)}`;
			const valueId = {
				commandClass: command.ccId,
				endpoint: command.endpointIndex,
				propertyName,
			};
			this.valueDB.setValue(valueId, command.notificationEvent);
			// We don't know what this notification refers to, so we don't force a reset
		}
	}

	/**
	 * @internal
	 * Serializes this node in order to store static data in a cache
	 */
	public serialize(): JSONObject {
		return {
			id: this.id,
			interviewStage:
				this.interviewStage >= InterviewStage.RestartFromCache
					? InterviewStage[InterviewStage.Complete]
					: InterviewStage[this.interviewStage],
			deviceClass: this.deviceClass && {
				basic: this.deviceClass.basic,
				generic: this.deviceClass.generic.key,
				specific: this.deviceClass.specific.key,
			},
			isListening: this.isListening,
			isFrequentListening: this.isFrequentListening,
			isRouting: this.isRouting,
			maxBaudRate: this.maxBaudRate,
			isSecure: this.isSecure,
			isBeaming: this.isBeaming,
			version: this.version,
			commandClasses: composeObject(
				[...this.implementedCommandClasses.entries()]
					.sort((a, b) => Math.sign(a[0] - b[0]))
					.map(([cc, info]) => {
						// Store the normal CC info
						const ret = {
							name: CommandClasses[cc],
							...info,
						} as any;
						// If the CC is implemented and has values or value metadata,
						// store them
						const ccInstance = this.createCCInstance(cc);
						if (ccInstance) {
							// Store values if there ara any
							const ccValues = ccInstance.serializeValuesForCache();
							if (ccValues.length > 0) ret.values = ccValues;
							const ccMetadata = ccInstance.serializeMetadataForCache();
							if (ccMetadata.length > 0)
								ret.metadata = ccMetadata;
						}
						return [num2hex(cc), ret] as [string, object];
					}),
			),
			// endpointCountIsDynamic: this.endpointCountIsDynamic,
			// endpointsHaveIdenticalCapabilities: this
			// 	.endpointsHaveIdenticalCapabilities,
			// individualEndpointCount: this.individualEndpointCount,
			// aggregatedEndpointCount: this.aggregatedEndpointCount,
			// endpoints:
			// 	this.endpointCommandClasses &&
			// 	composeObject(
			// 		[...this.endpointCommandClasses.entries()]
			// 			.sort((a, b) => Math.sign(a[0] - b[0]))
			// 			.map(([cc, caps]) => {
			// 				return [
			// 					cc.toString(),
			// 					{
			// 						genericClass: caps.genericClass.key,
			// 						specificClass: caps.specificClass.key,
			// 						isDynamic: caps.isDynamic,
			// 						supportedCCs: caps.supportedCCs,
			// 					},
			// 				] as [string, object];
			// 			}),
			// 	),
		};
	}

	/**
	 * @internal
	 * Deserializes the information of this node from a cache.
	 */
	public deserialize(obj: any): void {
		if (obj.interviewStage in InterviewStage) {
			this.interviewStage =
				typeof obj.interviewStage === "number"
					? obj.interviewStage
					: InterviewStage[obj.interviewStage];
		}
		if (isObject(obj.deviceClass)) {
			const { basic, generic, specific } = obj.deviceClass;
			if (
				typeof basic === "number" &&
				typeof generic === "number" &&
				typeof specific === "number"
			) {
				const genericDC = GenericDeviceClass.get(generic);
				this._deviceClass = new DeviceClass(
					basic,
					genericDC,
					SpecificDeviceClass.get(genericDC.key, specific),
				);
			}
		}

		// Parse single properties
		const tryParse = (
			key: Extract<keyof ZWaveNode, string>,
			type: "boolean" | "number" | "string",
		): void => {
			if (typeof obj[key] === type)
				this[`_${key}` as keyof this] = obj[key];
		};
		tryParse("isListening", "boolean");
		tryParse("isFrequentListening", "boolean");
		tryParse("isRouting", "boolean");
		tryParse("maxBaudRate", "number");
		tryParse("isSecure", "boolean");
		tryParse("isBeaming", "boolean");
		tryParse("version", "number");

		function enforceType(
			val: any,
			type: "boolean" | "number" | "string",
		): any {
			return typeof val === type ? val : undefined;
		}

		// Parse CommandClasses
		if (isObject(obj.commandClasses)) {
			const ccDict = obj.commandClasses;
			for (const ccHex of Object.keys(ccDict)) {
				// First make sure this key describes a valid CC
				if (!/^0x[0-9a-fA-F]+$/.test(ccHex)) continue;
				const ccNum = parseInt(ccHex);
				if (!(ccNum in CommandClasses)) continue;

				// Parse the information we have
				const {
					isSupported,
					isControlled,
					version,
					values,
					metadata,
				} = ccDict[ccHex];
				this.addCC(ccNum, {
					isSupported: enforceType(isSupported, "boolean"),
					isControlled: enforceType(isControlled, "boolean"),
					version: enforceType(version, "number"),
				});
				if (isArray(values) && values.length > 0) {
					// If any exist, deserialize the values aswell
					const ccInstance = this.createCCInstance(ccNum);
					if (ccInstance) {
						try {
							ccInstance.deserializeValuesFromCache(
								values as CacheValue[],
							);
						} catch (e) {
							log.controller.logNode(this.id, {
								message: `Error during deserialization of CC values from cache:\n${e}`,
								level: "error",
							});
						}
					}
				}
				if (isArray(metadata) && metadata.length > 0) {
					// If any exist, deserialize the values aswell
					const ccInstance = this.createCCInstance(ccNum);
					if (ccInstance) {
						try {
							ccInstance.deserializeMetadataFromCache(
								metadata as CacheMetadata[],
							);
						} catch (e) {
							log.controller.logNode(this.id, {
								message: `Error during deserialization of CC value metadata from cache:\n${e}`,
								level: "error",
							});
						}
					}
				}
			}
		}
		// // Parse endpoint capabilities
		// tryParse("endpointCountIsDynamic", "boolean");
		// tryParse("endpointsHaveIdenticalCapabilities", "boolean");
		// tryParse("individualEndpointCount", "number");
		// tryParse("aggregatedEndpointCount", "number");
		// if (isObject(obj.endpoints)) {
		// 	const endpointDict = obj.endpoints;
		// 	// Make sure the endpointCapabilities Map exists
		// 	if (!this.endpointCommandClasses) {
		// 		this.valueDB.setValue(
		// 			{
		// 				commandClass: CommandClasses["Multi Channel"],
		// 				endpoint: 0,
		// 				propertyName: "_endpointCapabilities",
		// 			},
		// 			new Map(),
		// 		);
		// 	}
		// 	for (const index of Object.keys(endpointDict)) {
		// 		// First make sure this key describes a valid endpoint
		// 		const indexNum = parseInt(index);
		// 		if (
		// 			indexNum < 1 ||
		// 			indexNum >
		// 				(this.individualEndpointCount || 0) +
		// 					(this.aggregatedEndpointCount || 0)
		// 		) {
		// 			continue;
		// 		}

		// 		// Parse the information we have
		// 		const {
		// 			genericClass,
		// 			specificClass,
		// 			isDynamic,
		// 			supportedCCs,
		// 		} = endpointDict[index];
		// 		if (
		// 			typeof genericClass === "number" &&
		// 			typeof specificClass === "number" &&
		// 			typeof isDynamic === "boolean" &&
		// 			isArray(supportedCCs) &&
		// 			supportedCCs.every(cc => typeof cc === "number")
		// 		) {
		// 			this.endpointCommandClasses!.set(indexNum, {
		// 				genericClass: GenericDeviceClass.get(genericClass),
		// 				specificClass: SpecificDeviceClass.get(
		// 					genericClass,
		// 					specificClass,
		// 				),
		// 				isDynamic,
		// 				supportedCCs,
		// 			});
		// 		}
		// 	}
		// }
	}

	/**
	 * @internal
	 * Changes the assumed sleep state of the node
	 * @param awake Whether the node should be assumed awake
	 */
	public setAwake(awake: boolean): void {
		if (!this.supportsCC(CommandClasses["Wake Up"])) return;
		WakeUpCC.setAwake(this, awake);
	}

	/** Returns whether the node is currently assumed awake */
	public isAwake(): boolean {
		const isAsleep =
			this.supportsCC(CommandClasses["Wake Up"]) &&
			!WakeUpCC.isAwake(this);
		return !isAsleep;
	}

	/**
	 * Whether the node should be kept awake when there are no pending messages.
	 */
	public keepAwake: boolean = false;

	private isSendingNoMoreInformation: boolean = false;
	/**
	 * @internal
	 * Sends the node a WakeUpCCNoMoreInformation so it can go back to sleep
	 */
	public async sendNoMoreInformation(): Promise<boolean> {
		// Don't send the node back to sleep if it should be kept awake
		if (this.keepAwake) return false;

		// Avoid calling this method more than once
		if (this.isSendingNoMoreInformation) return false;
		this.isSendingNoMoreInformation = true;

		let msgSent = false;
		if (this.isAwake() && this.interviewStage === InterviewStage.Complete) {
			log.controller.logNode(this.id, {
				message: "Sending node back to sleep...",
				direction: "outbound",
			});
			await this.commandClasses["Wake Up"].sendNoMoreInformation();
			this.setAwake(false);
			log.controller.logNode(this.id, "  Node asleep");

			msgSent = true;
		}

		this.isSendingNoMoreInformation = false;
		return msgSent;
	}
}
