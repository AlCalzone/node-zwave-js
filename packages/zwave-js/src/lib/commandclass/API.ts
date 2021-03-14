import type { ValueID } from "@zwave-js/core";
import {
	CommandClasses,
	Maybe,
	NODE_ID_BROADCAST,
	unknownBoolean,
	ZWaveError,
	ZWaveErrorCodes,
} from "@zwave-js/core";
import { getEnumMemberName, ObjectKeyMap } from "@zwave-js/shared";
import { isArray } from "alcalzone-shared/typeguards";
import type { Driver, SendCommandOptions } from "../driver/Driver";
import type { Endpoint } from "../node/Endpoint";
import { VirtualEndpoint } from "../node/VirtualEndpoint";
import { getCommandClass } from "./CommandClass";

export type ValueIDProperties = Pick<ValueID, "property" | "propertyKey">;

/** Used to identify the method on the CC API class that handles setting values on nodes directly */
export const SET_VALUE: unique symbol = Symbol.for("CCAPI_SET_VALUE");
export type SetValueImplementation = (
	property: ValueIDProperties,
	value: unknown,
) => Promise<void>;

/** Used to identify the method on the CC API class that handles polling values from nodes */
export const POLL_VALUE: unique symbol = Symbol.for("CCAPI_POLL_VALUE");
export type PollValueImplementation<T extends unknown = unknown> = (
	property: ValueIDProperties,
) => Promise<T | undefined>;

// Since the setValue API is called from a point with very generic parameters,
// we must do narrowing inside the API calls. These three methods are for convenience
export function throwUnsupportedProperty(
	cc: CommandClasses,
	property: string | number,
): never {
	throw new ZWaveError(
		`${CommandClasses[cc]}: "${property}" is not a supported property`,
		ZWaveErrorCodes.Argument_Invalid,
	);
}

export function throwUnsupportedPropertyKey(
	cc: CommandClasses,
	property: string | number,
	propertyKey: string | number,
): never {
	throw new ZWaveError(
		`${CommandClasses[cc]}: "${propertyKey}" is not a supported property key for property "${property}"`,
		ZWaveErrorCodes.Argument_Invalid,
	);
}

export function throwMissingPropertyKey(
	cc: CommandClasses,
	property: string | number,
): never {
	throw new ZWaveError(
		`${CommandClasses[cc]}: property "${property}" requires a property key, but none was given`,
		ZWaveErrorCodes.Argument_Invalid,
	);
}

export function throwWrongValueType(
	cc: CommandClasses,
	property: string | number,
	expectedType: string,
	receivedType: string,
): never {
	throw new ZWaveError(
		`${CommandClasses[cc]}: "${property}" must be of type "${expectedType}", received "${receivedType}"`,
		ZWaveErrorCodes.Argument_Invalid,
	);
}

/**
 * The base class for all CC APIs exposed via `Node.commandClasses.<CCName>`
 * @publicAPI
 */
export class CCAPI {
	public constructor(
		protected readonly driver: Driver,
		protected readonly endpoint: Endpoint | VirtualEndpoint,
	) {
		this.ccId = getCommandClass(this);
		this.scheduledPolls = new ObjectKeyMap();
	}

	/**
	 * @internal
	 * The identifier of the Command Class this API is for
	 */
	public readonly ccId: CommandClasses;

	protected [SET_VALUE]: SetValueImplementation | undefined;
	/**
	 * Can be used on supported CC APIs to set a CC value by property name (and optionally the property key)
	 */
	public get setValue(): SetValueImplementation | undefined {
		// wotan-disable-next-line no-restricted-property-access
		return this[SET_VALUE];
	}

	/** Whether a successful setValue call should imply that the value was successfully updated */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	public isSetValueOptimistic(valueId: ValueID): boolean {
		return true;
	}

	protected [POLL_VALUE]: PollValueImplementation | undefined;
	/**
	 * Can be used on supported CC APIs to poll a CC value by property name (and optionally the property key)
	 */
	public get pollValue(): PollValueImplementation | undefined {
		// wotan-disable-next-line no-restricted-property-access
		const implementation = this[POLL_VALUE]?.bind(this);
		if (!implementation) return;
		// Polling manually should cancel scheduled polls to avoid polling too often
		// Therefore return a wrapper which takes care of that
		return (property) => {
			// Cancel any scheduled polls
			if (this.scheduledPolls.has(property)) {
				clearTimeout(this.scheduledPolls.get(property)!);
				this.scheduledPolls.delete(property);
			}
			// Call the implementation
			return implementation(property);
		};
	}

	protected scheduledPolls: ObjectKeyMap<ValueIDProperties, NodeJS.Timeout>;
	/**
	 * Schedules a value to be polled after a given time. Schedules are deduplicated on a per-property basis.
	 * @returns `true` if the poll was scheduled, `false` otherwise
	 */
	protected schedulePoll(
		property: ValueIDProperties,
		timeoutMs: number = this.driver.options.timeouts.refreshValue,
	): boolean {
		if (this.scheduledPolls.has(property)) return false;
		// wotan-disable-next-line no-restricted-property-access
		if (!this[POLL_VALUE]) return false;

		this.scheduledPolls.set(
			property,
			setTimeout(async () => {
				try {
					await this.pollValue!(property);
				} catch {
					/* ignore */
				}
			}, timeoutMs).unref(),
		);
		return true;
	}

	/**
	 * Retrieves the version of the given CommandClass this endpoint implements
	 */
	public get version(): number {
		return this.endpoint.getCCVersion(this.ccId);
	}

	/** Determines if this simplified API instance may be used. */
	public isSupported(): boolean {
		return (
			// NoOperation is always supported
			this.ccId === CommandClasses["No Operation"] ||
			// Basic should always be supported. Since we are trying to hide it from library consumers
			// we cannot trust supportsCC to test it
			this.ccId === CommandClasses.Basic ||
			this.endpoint.supportsCC(this.ccId)
		);
	}

	/**
	 * Determine whether the linked node supports a specific command of this command class.
	 * "unknown" means that the information has not been received yet
	 */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	public supportsCommand(command: number): Maybe<boolean> {
		// This needs to be overwritten per command class. In the default implementation, we don't know anything!
		return unknownBoolean;
	}

	protected assertSupportsCommand(
		commandEnum: unknown,
		command: number,
	): void {
		if (this.supportsCommand(command) !== true) {
			const hasNodeId = typeof this.endpoint.nodeId === "number";

			throw new ZWaveError(
				`${
					hasNodeId
						? "This virtual node"
						: `Node #${this.endpoint.nodeId as number}`
				}${
					this.endpoint.index > 0
						? ` (Endpoint ${this.endpoint.index})`
						: ""
				} does not support the command ${getEnumMemberName(
					commandEnum,
					command,
				)}!`,
				ZWaveErrorCodes.CC_NotSupported,
			);
		}
	}

	protected assertPhysicalEndpoint(
		endpoint: Endpoint | VirtualEndpoint,
	): asserts endpoint is Endpoint {
		if (endpoint instanceof VirtualEndpoint) {
			throw new ZWaveError(
				`This method is not supported for virtual nodes!`,
				ZWaveErrorCodes.CC_NotSupported,
			);
		}
	}

	/** Returns the command options to use for sendCommand calls */
	protected get commandOptions(): SendCommandOptions {
		// No default options
		return {};
	}

	/** Creates an instance of this API, scoped to use the given options */
	public withOptions(options: SendCommandOptions): this {
		const mergedOptions = {
			...this.commandOptions,
			...options,
		};
		return new Proxy(this, {
			get: (target, property) => {
				if (property === "commandOptions") {
					return mergedOptions;
				} else {
					return (target as any)[property];
				}
			},
		});
	}

	protected isSinglecast(): this is this & { endpoint: Endpoint } {
		return (
			typeof this.endpoint.nodeId === "number" &&
			this.endpoint.nodeId !== NODE_ID_BROADCAST
		);
	}

	protected isMulticast(): this is this & {
		endpoint: VirtualEndpoint & {
			nodeId: number[];
		};
	} {
		return (
			this.endpoint instanceof VirtualEndpoint &&
			isArray(this.endpoint.nodeId)
		);
	}

	protected isBroadcast(): this is this & {
		endpoint: VirtualEndpoint & {
			nodeId: typeof NODE_ID_BROADCAST;
		};
	} {
		return (
			this.endpoint instanceof VirtualEndpoint &&
			this.endpoint.nodeId === NODE_ID_BROADCAST
		);
	}
}

/** A CC API that is only available for physical endpoints */
export class PhysicalCCAPI extends CCAPI {
	public constructor(driver: Driver, endpoint: Endpoint | VirtualEndpoint) {
		super(driver, endpoint);
		this.assertPhysicalEndpoint(endpoint);
	}

	protected declare readonly endpoint: Endpoint;
}

// This interface is auto-generated by maintenance/generateCCAPIInterface.ts
// Do not edit it by hand or your changes will be lost
export interface CCAPIs {
	[Symbol.iterator](): Iterator<CCAPI>;

	// AUTO GENERATION BELOW
	"Alarm Sensor": import("./AlarmSensorCC").AlarmSensorCCAPI;
	Association: import("./AssociationCC").AssociationCCAPI;
	"Association Group Information": import("./AssociationGroupInfoCC").AssociationGroupInfoCCAPI;
	"Barrier Operator": import("./BarrierOperatorCC").BarrierOperatorCCAPI;
	Basic: import("./BasicCC").BasicCCAPI;
	Battery: import("./BatteryCC").BatteryCCAPI;
	"Binary Sensor": import("./BinarySensorCC").BinarySensorCCAPI;
	"Binary Switch": import("./BinarySwitchCC").BinarySwitchCCAPI;
	"CRC-16 Encapsulation": import("./CRC16CC").CRC16CCAPI;
	"Central Scene": import("./CentralSceneCC").CentralSceneCCAPI;
	"Climate Control Schedule": import("./ClimateControlScheduleCC").ClimateControlScheduleCCAPI;
	Clock: import("./ClockCC").ClockCCAPI;
	"Color Switch": import("./ColorSwitchCC").ColorSwitchCCAPI;
	Configuration: import("./ConfigurationCC").ConfigurationCCAPI;
	"Door Lock": import("./DoorLockCC").DoorLockCCAPI;
	"Firmware Update Meta Data": import("./FirmwareUpdateMetaDataCC").FirmwareUpdateMetaDataCCAPI;
	Indicator: import("./IndicatorCC").IndicatorCCAPI;
	Language: import("./LanguageCC").LanguageCCAPI;
	Lock: import("./LockCC").LockCCAPI;
	"Manufacturer Proprietary": import("./ManufacturerProprietaryCC").ManufacturerProprietaryCCAPI;
	"Manufacturer Specific": import("./ManufacturerSpecificCC").ManufacturerSpecificCCAPI;
	Meter: import("./MeterCC").MeterCCAPI;
	"Multi Channel Association": import("./MultiChannelAssociationCC").MultiChannelAssociationCCAPI;
	"Multi Channel": import("./MultiChannelCC").MultiChannelCCAPI;
	"Multi Command": import("./MultiCommandCC").MultiCommandCCAPI;
	"Multilevel Sensor": import("./MultilevelSensorCC").MultilevelSensorCCAPI;
	"Multilevel Switch": import("./MultilevelSwitchCC").MultilevelSwitchCCAPI;
	"No Operation": import("./NoOperationCC").NoOperationCCAPI;
	"Node Naming and Location": import("./NodeNamingCC").NodeNamingAndLocationCCAPI;
	Notification: import("./NotificationCC").NotificationCCAPI;
	Powerlevel: import("./PowerlevelCC").PowerlevelCCAPI;
	Protection: import("./ProtectionCC").ProtectionCCAPI;
	"Scene Activation": import("./SceneActivationCC").SceneActivationCCAPI;
	"Scene Actuator Configuration": import("./SceneActuatorConfigurationCC").SceneActuatorConfigurationCCAPI;
	"Scene Controller Configuration": import("./SceneControllerConfigurationCC").SceneControllerConfigurationCCAPI;
	Security: import("./SecurityCC").SecurityCCAPI;
	"Sound Switch": import("./SoundSwitchCC").SoundSwitchCCAPI;
	Supervision: import("./SupervisionCC").SupervisionCCAPI;
	"Thermostat Fan Mode": import("./ThermostatFanModeCC").ThermostatFanModeCCAPI;
	"Thermostat Fan State": import("./ThermostatFanStateCC").ThermostatFanStateCCAPI;
	"Thermostat Mode": import("./ThermostatModeCC").ThermostatModeCCAPI;
	"Thermostat Operating State": import("./ThermostatOperatingStateCC").ThermostatOperatingStateCCAPI;
	"Thermostat Setback": import("./ThermostatSetbackCC").ThermostatSetbackCCAPI;
	"Thermostat Setpoint": import("./ThermostatSetpointCC").ThermostatSetpointCCAPI;
	Time: import("./TimeCC").TimeCCAPI;
	"Time Parameters": import("./TimeParametersCC").TimeParametersCCAPI;
	"User Code": import("./UserCodeCC").UserCodeCCAPI;
	Version: import("./VersionCC").VersionCCAPI;
	"Wake Up": import("./WakeUpCC").WakeUpCCAPI;
	"Z-Wave Plus Info": import("./ZWavePlusCC").ZWavePlusCCAPI;
}
