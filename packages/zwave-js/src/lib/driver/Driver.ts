import { JsonlDB, JsonlDBOptions } from "@alcalzone/jsonl-db";
import * as Sentry from "@sentry/node";
import { ConfigManager } from "@zwave-js/config";
import {
	CommandClasses,
	deserializeCacheValue,
	Duration,
	highResTimestamp,
	LogConfig,
	SecurityManager,
	serializeCacheValue,
	ValueMetadata,
	ZWaveError,
	ZWaveErrorCodes,
	ZWaveLogContainer,
} from "@zwave-js/core";
import {
	MessageHeaders,
	ZWaveSerialPort,
	ZWaveSerialPortBase,
	ZWaveSocket,
} from "@zwave-js/serial";
import { DeepPartial, num2hex, pick, stringify } from "@zwave-js/shared";
import { wait } from "alcalzone-shared/async";
import {
	createDeferredPromise,
	DeferredPromise,
} from "alcalzone-shared/deferred-promise";
import { entries } from "alcalzone-shared/objects";
import { isArray } from "alcalzone-shared/typeguards";
import { EventEmitter } from "events";
import fsExtra from "fs-extra";
import path from "path";
import SerialPort from "serialport";
import { URL } from "url";
import * as util from "util";
import { interpret } from "xstate";
import { FirmwareUpdateStatus } from "../commandclass";
import {
	CommandClass,
	getImplementedVersion,
} from "../commandclass/CommandClass";
import { DeviceResetLocallyCCNotification } from "../commandclass/DeviceResetLocallyCC";
import {
	isEncapsulatingCommandClass,
	isMultiEncapsulatingCommandClass,
} from "../commandclass/EncapsulatingCommandClass";
import {
	ICommandClassContainer,
	isCommandClassContainer,
} from "../commandclass/ICommandClassContainer";
import { MultiChannelCC } from "../commandclass/MultiChannelCC";
import { messageIsPing } from "../commandclass/NoOperationCC";
import {
	SecurityCC,
	SecurityCCCommandEncapsulationNonceGet,
} from "../commandclass/SecurityCC";
import {
	SupervisionCC,
	SupervisionCCGet,
	SupervisionCCReport,
	SupervisionResult,
	SupervisionStatus,
} from "../commandclass/SupervisionCC";
import { WakeUpCCNoMoreInformation } from "../commandclass/WakeUpCC";
import { ApplicationCommandRequest } from "../controller/ApplicationCommandRequest";
import {
	ApplicationUpdateRequest,
	ApplicationUpdateRequestNodeInfoReceived,
} from "../controller/ApplicationUpdateRequest";
import { BridgeApplicationCommandRequest } from "../controller/BridgeApplicationCommandRequest";
import { ZWaveController } from "../controller/Controller";
import {
	MAX_SEND_ATTEMPTS,
	SendDataAbort,
	SendDataMulticastRequest,
	SendDataRequest,
} from "../controller/SendDataMessages";
import { ControllerLogger } from "../log/Controller";
import { DriverLogger } from "../log/Driver";
import {
	FunctionType,
	MessagePriority,
	MessageType,
} from "../message/Constants";
import { getDefaultPriority, Message } from "../message/Message";
import { isNodeQuery } from "../node/INodeQuery";
import type { ZWaveNode } from "../node/Node";
import { InterviewStage, NodeStatus } from "../node/Types";
import type { FileSystem } from "./FileSystem";
import {
	createSendThreadMachine,
	SendThreadInterpreter,
	TransactionReducer,
	TransactionReducerResult,
} from "./SendThreadMachine";
import { throttlePresets } from "./ThrottlePresets";
import { Transaction } from "./Transaction";

// eslint-disable-next-line
const { version: libVersion } = require("../../../package.json");
// This is made with cfonts:
const libNameString = `
███████╗ ██╗    ██╗  █████╗  ██╗   ██╗ ███████╗             ██╗ ███████╗
╚══███╔╝ ██║    ██║ ██╔══██╗ ██║   ██║ ██╔════╝             ██║ ██╔════╝
  ███╔╝  ██║ █╗ ██║ ███████║ ██║   ██║ █████╗   █████╗      ██║ ███████╗
 ███╔╝   ██║███╗██║ ██╔══██║ ╚██╗ ██╔╝ ██╔══╝   ╚════╝ ██   ██║ ╚════██║
███████╗ ╚███╔███╔╝ ██║  ██║  ╚████╔╝  ███████╗        ╚█████╔╝ ███████║
╚══════╝  ╚══╝╚══╝  ╚═╝  ╚═╝   ╚═══╝   ╚══════╝         ╚════╝  ╚══════╝
`;

export interface ZWaveOptions {
	/** Specify timeouts in milliseconds */
	timeouts: {
		/** how long to wait for an ACK */
		ack: number; // >=1, default: 1000 ms
		/** not sure */
		byte: number; // >=1, default: 150 ms
		/**
		 * How long to wait for a controller response. Usually this timeout should never elapse,
		 * so this is merely a safeguard against the driver stalling
		 */
		response: number; // [500...5000], default: 1600 ms
		/** How long to wait for a callback from the host for a SendData[Multicast]Request */
		sendDataCallback: number; // >=10000, default: 65000 ms
		/** How much time a node gets to process a request and send a response */
		report: number; // [1000...40000], default: 10000 ms
		/** How long generated nonces are valid */
		nonce: number; // [3000...20000], default: 5000 ms

		/**
		 * @internal
		 * How long to wait for a poll after setting a value
		 */
		refreshValue: number;
	};

	attempts: {
		/** How often the driver should try communication with the controller before giving up */
		controller: number; // [1...3], default: 3
		/** How often the driver should try sending SendData commands before giving up */
		sendData: number; // [1...5], default: 3
		/** Whether a command should be retried when a node acknowledges the receipt but no response is received */
		retryAfterTransmitReport: boolean; // default: false
		/**
		 * How many attempts should be made for each node interview before giving up
		 */
		nodeInterview: number; // [1...10], default: 5
	};

	/**
	 * Optional log configuration
	 */
	logConfig?: LogConfig;

	/**
	 * @internal
	 * Set this to true to skip the controller interview. Useful for testing purposes
	 */
	skipInterview?: boolean;

	storage: {
		/** Allows you to replace the default file system driver used to store and read the cache */
		driver: FileSystem;
		/** Allows you to specify a different cache directory */
		cacheDir: string;
		/**
		 * How frequently the values and metadata should be written to the DB files. This is a compromise between data loss
		 * in cause of a crash and disk wear:
		 *
		 * * `"fast"` immediately writes every change to disk
		 * * `"slow"` writes at most every 5 minutes or after 500 changes - whichever happens first
		 * * `"normal"` is a compromise between the two options
		 */
		throttle: "fast" | "normal" | "slow";
	};

	/** Specify the network key to use for encryption. This must be a Buffer of exactly 16 bytes. */
	networkKey?: Buffer;

	/**
	 * Some Command Classes support reporting that a value is unknown.
	 * When this flag is `false`, unknown values are exposed as `undefined`.
	 * When it is `true`, unknown values are exposed as the literal string "unknown" (even if the value is normally numeric).
	 * Default: `false` */
	preserveUnknownValues?: boolean;
}

const defaultOptions: ZWaveOptions = {
	timeouts: {
		ack: 1000,
		byte: 150,
		response: 1600,
		report: 10000,
		nonce: 5000,
		sendDataCallback: 65000, // as defined in INS13954
		refreshValue: 5000, // Default should handle most slow devices until we have a better solution
	},
	attempts: {
		controller: 3,
		sendData: 3,
		retryAfterTransmitReport: false,
		nodeInterview: 5,
	},
	preserveUnknownValues: false,
	skipInterview: false,
	storage: {
		driver: fsExtra,
		cacheDir: path.resolve(__dirname, "../../..", "cache"),
		throttle: "normal",
	},
};

/**
 * Merges the user-defined options with the default options
 */
function applyDefaultOptions(
	target: Record<string, any> | undefined,
	source: Record<string, any>,
): Record<string, any> {
	target = target || {};
	for (const [key, value] of entries(source)) {
		if (!(key in target)) {
			target[key] = value;
		} else {
			if (typeof value === "object") {
				// merge objects
				target[key] = applyDefaultOptions(target[key], value);
			} else if (typeof target[key] === "undefined") {
				// don't override single keys
				target[key] = value;
			}
		}
	}
	return target;
}

/** Ensures that the options are valid */
function checkOptions(options: ZWaveOptions): void {
	if (options.timeouts.ack < 1) {
		throw new ZWaveError(
			`The ACK timeout must be positive!`,
			ZWaveErrorCodes.Driver_InvalidOptions,
		);
	}
	if (options.timeouts.byte < 1) {
		throw new ZWaveError(
			`The BYTE timeout must be positive!`,
			ZWaveErrorCodes.Driver_InvalidOptions,
		);
	}
	if (options.timeouts.response < 500 || options.timeouts.response > 5000) {
		throw new ZWaveError(
			`The Response timeout must be between 500 and 5000 milliseconds!`,
			ZWaveErrorCodes.Driver_InvalidOptions,
		);
	}
	if (options.timeouts.report < 1000 || options.timeouts.report > 40000) {
		throw new ZWaveError(
			`The Report timeout must be between 1000 and 40000 milliseconds!`,
			ZWaveErrorCodes.Driver_InvalidOptions,
		);
	}
	if (options.timeouts.nonce < 3000 || options.timeouts.nonce > 20000) {
		throw new ZWaveError(
			`The Nonce timeout must be between 3000 and 20000 milliseconds!`,
			ZWaveErrorCodes.Driver_InvalidOptions,
		);
	}
	if (options.timeouts.sendDataCallback < 10000) {
		throw new ZWaveError(
			`The Send Data Callback timeout must be at least 10000 milliseconds!`,
			ZWaveErrorCodes.Driver_InvalidOptions,
		);
	}
	if (options.networkKey != undefined && options.networkKey.length !== 16) {
		throw new ZWaveError(
			`The network key must be a buffer with length 16!`,
			ZWaveErrorCodes.Driver_InvalidOptions,
		);
	}
	if (options.attempts.controller < 1 || options.attempts.controller > 3) {
		throw new ZWaveError(
			`The Controller attempts must be between 1 and 3!`,
			ZWaveErrorCodes.Driver_InvalidOptions,
		);
	}
	if (
		options.attempts.sendData < 1 ||
		options.attempts.sendData > MAX_SEND_ATTEMPTS
	) {
		throw new ZWaveError(
			`The SendData attempts must be between 1 and ${MAX_SEND_ATTEMPTS}!`,
			ZWaveErrorCodes.Driver_InvalidOptions,
		);
	}
	if (
		options.attempts.nodeInterview < 1 ||
		options.attempts.nodeInterview > 10
	) {
		throw new ZWaveError(
			`The Node interview attempts must be between 1 and 10!`,
			ZWaveErrorCodes.Driver_InvalidOptions,
		);
	}
}

/**
 * Function signature for a message handler. The return type signals if the
 * message was handled (`true`) or further handlers should be called (`false`)
 */
export type RequestHandler<T extends Message = Message> = (
	msg: T,
) => boolean | Promise<boolean>;
interface RequestHandlerEntry<T extends Message = Message> {
	invoke: RequestHandler<T>;
	oneTime: boolean;
}

interface AwaitedCommandEntry {
	promise: DeferredPromise<CommandClass>;
	timeout?: NodeJS.Timeout;
	predicate: (cc: CommandClass) => boolean;
}

export interface SendMessageOptions {
	/** The priority of the message to send. If none is given, the defined default priority of the message class will be used. */
	priority?: MessagePriority;
	/** If an exception should be thrown when the message to send is not supported. Setting this to false is is useful if the capabilities haven't been determined yet. Default: true */
	supportCheck?: boolean;
	/**
	 * Whether the driver should update the node status to asleep or dead when a transaction is not acknowledged (repeatedly).
	 * Setting this to false will cause the simply transaction to be rejected on failure.
	 * Default: true
	 */
	changeNodeStatusOnMissingACK?: boolean;
	/** Sets the number of milliseconds after which a message expires. When the expiration timer elapses, the promise is rejected with the error code `Controller_MessageExpired`. */
	expire?: number;
	/**
	 * Internal information used to identify or mark this transaction
	 * @internal
	 */
	tag?: any;
}

export interface SendCommandOptions extends SendMessageOptions {
	/** How many times the driver should try to send the message. Defaults to the configured Driver option */
	maxSendAttempts?: number;
}

export type SupervisionUpdateHandler = (
	status: SupervisionStatus,
	remainingDuration?: Duration,
) => void;

export type SendSupervisedCommandOptions = SendCommandOptions &
	(
		| {
				requestStatusUpdates: false;
		  }
		| {
				requestStatusUpdates: true;
				onUpdate: SupervisionUpdateHandler;
		  }
	);

// Strongly type the event emitter events

export interface DriverEventCallbacks {
	"driver ready": () => void;
	"all nodes ready": () => void;
	error: (err: Error) => void;
}

export type DriverEvents = Extract<keyof DriverEventCallbacks, string>;

export interface Driver {
	on<TEvent extends DriverEvents>(
		event: TEvent,
		callback: DriverEventCallbacks[TEvent],
	): this;
	once<TEvent extends DriverEvents>(
		event: TEvent,
		callback: DriverEventCallbacks[TEvent],
	): this;
	removeListener<TEvent extends DriverEvents>(
		event: TEvent,
		callback: DriverEventCallbacks[TEvent],
	): this;
	off<TEvent extends DriverEvents>(
		event: TEvent,
		callback: DriverEventCallbacks[TEvent],
	): this;
	removeAllListeners(event?: DriverEvents): this;

	emit<TEvent extends DriverEvents>(
		event: TEvent,
		...args: Parameters<DriverEventCallbacks[TEvent]>
	): boolean;
}

/**
 * The driver is the core of this library. It controls the serial interface,
 * handles transmission and receipt of messages and manages the network cache.
 * Any action you want to perform on the Z-Wave network must go through a driver
 * instance or its associated nodes.
 */
export class Driver extends EventEmitter {
	/** The serial port instance */
	private serial: ZWaveSerialPortBase | undefined;
	/** An instance of the Send Thread state machine */
	private sendThread: SendThreadInterpreter;

	/** A map of handlers for all sorts of requests */
	private requestHandlers = new Map<FunctionType, RequestHandlerEntry[]>();
	/** A map of awaited commands */
	private awaitedCommands: AwaitedCommandEntry[] = [];

	/** A map of all current supervision sessions that may still receive updates */
	private supervisionSessions = new Map<number, SupervisionUpdateHandler>();

	public readonly cacheDir: string;

	private _valueDB: JsonlDB | undefined;
	/** @internal */
	public get valueDB(): JsonlDB | undefined {
		return this._valueDB;
	}
	private _metadataDB: JsonlDB<ValueMetadata> | undefined;
	/** @internal */
	public get metadataDB(): JsonlDB<ValueMetadata> | undefined {
		return this._metadataDB;
	}

	public readonly configManager: ConfigManager;

	private _logContainer: ZWaveLogContainer;
	private _driverLog: DriverLogger;
	/** @internal */
	public get driverLog(): DriverLogger {
		return this._driverLog;
	}

	private _controllerLog: ControllerLogger;
	/** @internal */
	public get controllerLog(): ControllerLogger {
		return this._controllerLog;
	}

	private _controller: ZWaveController | undefined;
	/** Encapsulates information about the Z-Wave controller and provides access to its nodes */
	public get controller(): ZWaveController {
		if (this._controller == undefined) {
			throw new ZWaveError(
				"The controller is not yet ready!",
				ZWaveErrorCodes.Driver_NotReady,
			);
		}
		return this._controller;
	}

	private _securityManager: SecurityManager | undefined;
	/** @internal */
	public get securityManager(): SecurityManager | undefined {
		return this._securityManager;
	}

	public constructor(
		private port: string,
		options?: DeepPartial<ZWaveOptions>,
	) {
		super();

		// merge given options with defaults
		this.options = applyDefaultOptions(
			options,
			defaultOptions,
		) as ZWaveOptions;
		// And make sure they contain valid values
		checkOptions(this.options);

		this._logContainer = new ZWaveLogContainer(this.options.logConfig);
		this._driverLog = new DriverLogger(this._logContainer);
		this._controllerLog = new ControllerLogger(this._logContainer);

		this.cacheDir = this.options.storage.cacheDir;

		// Initialize config manager
		this.configManager = new ConfigManager(this._logContainer);

		// register some cleanup handlers in case the program doesn't get closed cleanly
		this._cleanupHandler = this._cleanupHandler.bind(this);
		process.on("exit", this._cleanupHandler);
		process.on("SIGINT", this._cleanupHandler);
		process.on("uncaughtException", this._cleanupHandler);

		// And initialize but don't start the send thread machine
		const sendThreadMachine = createSendThreadMachine(
			{
				sendData: this.writeSerial.bind(this),
				createSendDataAbort: () => new SendDataAbort(this),
				notifyUnsolicited: (msg) => {
					void this.handleUnsolicitedMessage(msg);
				},
				notifyRetry: (
					command,
					lastError,
					message,
					attempts,
					maxAttempts,
					delay,
				) => {
					if (command === "SendData") {
						this.controllerLog.logNode(
							message.getNodeId() ?? 255,
							`did not respond after ${attempts}/${maxAttempts} attempts. Scheduling next try in ${delay} ms.`,
							"warn",
						);
					} else {
						// Translate the error into a better one
						let errorReason: string;
						switch (lastError) {
							case "response timeout":
								errorReason = "No response from controller";
								break;
							case "callback timeout":
								errorReason = "No callback from controller";
								break;
							case "response NOK":
								errorReason =
									"The controller response indicated failure";
								break;
							case "callback NOK":
								errorReason =
									"The controller callback indicated failure";
								break;
							case "ACK timeout":
							case "CAN":
							case "NAK":
							default:
								errorReason =
									"Failed to execute controller command";
								break;
						}
						this.controllerLog.print(
							`${errorReason} after ${attempts}/${maxAttempts} attempts. Scheduling next try in ${delay} ms.`,
							"warn",
						);
					}
				},
				timestamp: highResTimestamp,
				rejectTransaction: (transaction, error) => {
					// If a node failed to respond in time, it might be sleeping
					if (this.isMissingNodeACK(transaction, error)) {
						if (this.handleMissingNodeACK(transaction)) return;
					}
					transaction.promise.reject(error);
				},
				resolveTransaction: (transaction, result) => {
					transaction.promise.resolve(result);
				},
				logOutgoingMessage: (msg: Message) => {
					this.driverLog.logMessage(msg, {
						direction: "outbound",
					});
					if (process.env.NODE_ENV !== "test") {
						// Enrich error data in case something goes wrong
						Sentry.addBreadcrumb({
							category: "message",
							timestamp: Date.now() / 1000,
							type: "debug",
							data: {
								direction: "outbound",
								msgType: msg.type,
								functionType: msg.functionType,
								name: msg.constructor.name,
								nodeId: msg.getNodeId(),
								...msg.toLogEntry(),
							},
						});
					}
				},
				log: this.driverLog.print.bind(this.driverLog),
			},
			pick(this.options, ["timeouts", "attempts"]),
		);
		this.sendThread = interpret(sendThreadMachine);
		// this.sendThread.onTransition((state) => {
		// 	if (state.changed)
		// 		this.driverLog.print(
		// 			`send thread state: ${state.toStrings().slice(-1)[0]}`,
		// 			"verbose",
		// 		);
		// });
	}

	/** Updates the logging configuration without having to restart the driver. */
	public updateLogConfig(config: DeepPartial<LogConfig>): void {
		this._logContainer.updateConfiguration(config);
	}

	/** Returns the current logging configuration. */
	public getLogConfig(): LogConfig {
		return this._logContainer.getConfiguration();
	}

	/** Enumerates all existing serial ports */
	public static async enumerateSerialPorts(): Promise<string[]> {
		const ports = await SerialPort.list();
		return ports.map((port) => port.path);
	}

	/** @internal */
	public options: ZWaveOptions;

	private _wasStarted: boolean = false;
	private _isOpen: boolean = false;

	/** Start the driver */
	// wotan-disable async-function-assignability
	public async start(): Promise<void> {
		// avoid starting twice
		if (this._wasDestroyed) {
			throw new ZWaveError(
				"The driver was destroyed. Create a new instance and start that one.",
				ZWaveErrorCodes.Driver_Destroyed,
			);
		}
		if (this._wasStarted) return Promise.resolve();
		this._wasStarted = true;

		// Enforce that an error handler is attached
		if ((this as EventEmitter).listenerCount("error") === 0) {
			throw new ZWaveError(
				`Before starting the driver, a handler for the "error" event must be attached.`,
				ZWaveErrorCodes.Driver_NoErrorHandler,
			);
		}

		const spOpenPromise = createDeferredPromise();

		// Log which version is running
		this.driverLog.print(libNameString, "info");
		this.driverLog.print(`version ${libVersion}`, "info");
		this.driverLog.print("", "info");

		this.driverLog.print("starting driver...");
		this.sendThread.start();

		// Open the serial port
		if (this.port.startsWith("tcp://")) {
			const url = new URL(this.port);
			this.driverLog.print(`opening serial port ${this.port}`);
			this.serial = new ZWaveSocket(
				{
					host: url.hostname,
					port: parseInt(url.port),
				},
				this._logContainer,
			);
		} else {
			this.driverLog.print(`opening serial port ${this.port}`);
			this.serial = new ZWaveSerialPort(this.port, this._logContainer);
		}
		this.serial
			.on("data", this.serialport_onData.bind(this))
			.on("error", (err) => {
				this.driverLog.print(
					`serial port errored: ${err.message}`,
					"error",
				);
				if (this._isOpen) {
					this.serialport_onError(err);
				} else {
					spOpenPromise.reject(err);
					void this.destroy();
				}
			});
		// If the port is already open, close it first
		if (this.serial.isOpen) await this.serial.close();

		// IMPORTANT: Test code expects the open promise to be created and returned synchronously
		// Everything async (inluding opening the serial port) must happen in the setImmediate callback

		// asynchronously open the serial port
		setImmediate(async () => {
			try {
				await this.serial!.open();
			} catch (e) {
				const message = `Failed to open the serial port: ${e.message}`;
				this.driverLog.print(message, "error");

				spOpenPromise.reject(
					new ZWaveError(message, ZWaveErrorCodes.Driver_Failed),
				);
				void this.destroy();
				return;
			}
			this.driverLog.print("serial port opened");
			this._isOpen = true;
			spOpenPromise.resolve();

			await this.writeHeader(MessageHeaders.NAK);
			// set unref, so stopping the process doesn't need to wait for the 1500ms
			await wait(1500, true);

			// Load the necessary configuration
			this.driverLog.print("loading configuration...");
			try {
				await this.configManager.loadDeviceClasses();
				await this.configManager.loadManufacturers();
				await this.configManager.loadDeviceIndex();
				await this.configManager.loadNotifications();
				await this.configManager.loadNamedScales();
				await this.configManager.loadSensorTypes();
				await this.configManager.loadMeters();
				await this.configManager.loadIndicators();
			} catch (e) {
				const message = `Failed to load the configuration: ${e.message}`;
				this.driverLog.print(message, "error");
				this.emit(
					"error",
					new ZWaveError(message, ZWaveErrorCodes.Driver_Failed),
				);
				void this.destroy();
				return;
			}

			this.driverLog.print("beginning interview...");
			try {
				await this.initializeControllerAndNodes();
			} catch (e: unknown) {
				let message: string;
				if (
					e instanceof ZWaveError &&
					e.code === ZWaveErrorCodes.Controller_MessageDropped
				) {
					message = `Failed to initialize the driver, no response from the controller. Are you sure this is a Z-Wave controller?`;
				} else {
					message = `Failed to initialize the driver: ${
						e instanceof Error ? e.message : String(e)
					}`;
				}
				this.driverLog.print(message, "error");
				this.emit(
					"error",
					new ZWaveError(message, ZWaveErrorCodes.Driver_Failed),
				);
				void this.destroy();
				return;
			}
		});

		return spOpenPromise;
	}
	// wotan-enable async-function-assignability

	private _controllerInterviewed: boolean = false;
	private _nodesReady = new Set<number>();
	private _nodesReadyEventEmitted: boolean = false;

	/** Indicates whether all nodes are ready, i.e. the "all nodes ready" event has been emitted */
	public get allNodesReady(): boolean {
		return this._nodesReadyEventEmitted;
	}

	/**
	 * Initializes the variables for controller and nodes,
	 * adds event handlers and starts the interview process.
	 */
	private async initializeControllerAndNodes(): Promise<void> {
		if (this._controller == undefined) {
			this._controller = new ZWaveController(this);
			this._controller
				.on("node added", this.onNodeAdded.bind(this))
				.on("node removed", this.onNodeRemoved.bind(this));
		}

		const initValueDBs = async (): Promise<void> => {
			// Always start the value and metadata databases
			const options: JsonlDBOptions<any> = {
				ignoreReadErrors: true,
				...throttlePresets[this.options.storage.throttle],
			};

			const valueDBFile = path.join(
				this.cacheDir,
				`${this._controller!.homeId!.toString(16)}.values.jsonl`,
			);
			this._valueDB = new JsonlDB(valueDBFile, {
				...options,
				reviver: (key, value) => deserializeCacheValue(value),
				serializer: (key, value) => serializeCacheValue(value),
			});
			await this._valueDB.open();

			const metadataDBFile = path.join(
				this.cacheDir,
				`${this._controller!.homeId!.toString(16)}.metadata.jsonl`,
			);
			this._metadataDB = new JsonlDB(metadataDBFile, options);
			await this._metadataDB.open();

			if (process.env.NO_CACHE === "true") {
				// Since value/metadata DBs are append-only, we need to clear them
				// if the cache should be ignored
				this._valueDB.clear();
				this._metadataDB.clear();
			}
		};

		if (!this.options.skipInterview) {
			// Interview the controller.
			await this._controller.interview(initValueDBs, async () => {
				// Try to restore the network information from the cache
				if (process.env.NO_CACHE !== "true") {
					await this.restoreNetworkStructureFromCache();
				}
			});
			// No need to initialize databases if skipInterview is true, because it is only used in some
			// Driver unit tests that don't need access to them
		}

		// We need to know the controller node id to set up the security manager
		if (this.options.networkKey) {
			this._securityManager = new SecurityManager({
				networkKey: this.options.networkKey,
				ownNodeId: this._controller.ownNodeId!,
				nonceTimeout: this.options.timeouts.nonce,
			});
		}

		// in any case we need to emit the driver ready event here
		this._controllerInterviewed = true;
		this.driverLog.print("driver ready");
		this.emit("driver ready");

		// Add event handlers for the nodes
		for (const node of this._controller.nodes.values()) {
			this.addNodeEventHandlers(node);
		}
		// Before interviewing nodes reset our knowledge about their ready state
		this._nodesReady.clear();
		this._nodesReadyEventEmitted = false;

		if (!this.options.skipInterview) {
			// Now interview all nodes
			// First complete the controller interview
			const controllerNode = this._controller.nodes.get(
				this._controller.ownNodeId!,
			)!;
			await this.interviewNode(controllerNode);
			// Then do all the nodes in parallel
			for (const node of this._controller.nodes.values()) {
				if (node.id === this._controller.ownNodeId) continue;
				// don't await the interview, because it may take a very long time
				// if a node is asleep
				void this.interviewNode(node);
			}
		}
	}

	private retryNodeInterviewTimeouts = new Map<number, NodeJS.Timeout>();
	/**
	 * @internal
	 * Starts or resumes the interview of a Z-Wave node. It is advised to NOT
	 * await this method as it can take a very long time (minutes to hours)!
	 *
	 * WARNING: Do not call this method from application code. To refresh the information
	 * for a specific node, use `node.refreshInfo()` instead
	 */
	public async interviewNode(node: ZWaveNode): Promise<void> {
		if (node.interviewStage === InterviewStage.Complete) {
			node.interviewStage = InterviewStage.RestartFromCache;
		}

		// Avoid having multiple restart timeouts active
		if (this.retryNodeInterviewTimeouts.has(node.id)) {
			clearTimeout(this.retryNodeInterviewTimeouts.get(node.id)!);
			this.retryNodeInterviewTimeouts.delete(node.id);
		}

		// Drop all pending messages that come from a previous interview attempt
		this.rejectTransactions(
			(t) =>
				t.priority === MessagePriority.NodeQuery &&
				t.message.getNodeId() === node.id,
			"The interview was restarted",
			ZWaveErrorCodes.Controller_MessageDropped,
		);

		const maxInterviewAttempts = this.options.attempts.nodeInterview;

		try {
			if (!(await node.interview())) {
				// Find out if we may retry the interview
				if (node.status === NodeStatus.Dead) {
					this.controllerLog.logNode(
						node.id,
						`Interview attempt (${node.interviewAttempts}/${maxInterviewAttempts}) failed, node is dead.`,
						"warn",
					);
					node.emit("interview failed", node, {
						errorMessage: "The node is dead",
						isFinal: true,
					});
				} else if (node.interviewAttempts < maxInterviewAttempts) {
					// This is most likely because the node is unable to handle our load of requests now. Give it some time
					const retryTimeout = Math.min(
						30000,
						node.interviewAttempts * 5000,
					);
					this.controllerLog.logNode(
						node.id,
						`Interview attempt ${node.interviewAttempts}/${maxInterviewAttempts} failed, retrying in ${retryTimeout} ms...`,
						"warn",
					);
					node.emit("interview failed", node, {
						errorMessage: `Attempt ${node.interviewAttempts}/${maxInterviewAttempts} failed`,
						isFinal: false,
						attempt: node.interviewAttempts,
						maxAttempts: maxInterviewAttempts,
					});
					// Schedule the retry and remember the timeout instance
					this.retryNodeInterviewTimeouts.set(
						node.id,
						setTimeout(() => {
							this.retryNodeInterviewTimeouts.delete(node.id);
							void this.interviewNode(node);
						}, retryTimeout).unref(),
					);
				} else {
					this.controllerLog.logNode(
						node.id,
						`Failed all interview attempts, giving up.`,
						"warn",
					);
					node.emit("interview failed", node, {
						errorMessage: `Maximum interview attempts reached`,
						isFinal: true,
						attempt: maxInterviewAttempts,
						maxAttempts: maxInterviewAttempts,
					});
				}
			}
		} catch (e: unknown) {
			if (e instanceof ZWaveError) {
				if (
					e.code === ZWaveErrorCodes.Driver_NotReady ||
					e.code === ZWaveErrorCodes.Controller_NodeRemoved
				) {
					// This only happens when a node is removed during the interview - we don't log this
					return;
				}
				this.controllerLog.logNode(
					node.id,
					`Error during node interview: ${e.message}`,
					"error",
				);
			} else {
				throw e;
			}
		}
	}

	/** Adds the necessary event handlers for a node instance */
	private addNodeEventHandlers(node: ZWaveNode): void {
		node.on("wake up", this.onNodeWakeUp.bind(this))
			.on("sleep", this.onNodeSleep.bind(this))
			.on("alive", this.onNodeAlive.bind(this))
			.on("dead", this.onNodeDead.bind(this))
			.on("interview completed", this.onNodeInterviewCompleted.bind(this))
			.on("ready", this.onNodeReady.bind(this))
			.on(
				"firmware update finished",
				this.onNodeFirmwareUpdated.bind(this),
			);
	}

	/** Removes a node's event handlers that were added with addNodeEventHandlers */
	private removeNodeEventHandlers(node: ZWaveNode): void {
		node.removeAllListeners("wake up")
			.removeAllListeners("sleep")
			.removeAllListeners("alive")
			.removeAllListeners("dead")
			.removeAllListeners("interview completed")
			.removeAllListeners("ready")
			.removeAllListeners("firmware update finished");
	}

	/** Is called when a node wakes up */
	private onNodeWakeUp(node: ZWaveNode, oldStatus: NodeStatus): void {
		this.controllerLog.logNode(
			node.id,
			`The node is ${
				oldStatus === NodeStatus.Unknown ? "" : "now "
			}awake.`,
		);

		// Make sure to handle the pending messages as quickly as possible
		if (oldStatus === NodeStatus.Asleep) {
			this.sendThread.send({
				type: "reduce",
				reducer: ({ message }) => {
					// Ignore messages that are not for this node
					if (message.getNodeId() !== node.id)
						return { type: "keep" };
					// Resolve pings, so we don't need to send them (we know the node is awake)
					if (messageIsPing(message))
						return { type: "resolve", message: undefined };
					// Re-queue all other transactions for this node, so they get added in front of the others
					return { type: "requeue" };
				},
			});
		}
	}

	/** Is called when a node goes to sleep */
	private onNodeSleep(node: ZWaveNode, oldStatus: NodeStatus): void {
		this.controllerLog.logNode(
			node.id,
			`The node is ${
				oldStatus === NodeStatus.Unknown ? "" : "now "
			}asleep.`,
		);

		// Move all its pending messages to the WakeupQueue
		// This clears the current transaction and continues sending the next messages
		this.moveMessagesToWakeupQueue(node.id);
	}

	/** Is called when a previously dead node starts communicating again */
	private onNodeAlive(node: ZWaveNode, oldStatus: NodeStatus): void {
		this.controllerLog.logNode(
			node.id,
			`The node is ${
				oldStatus === NodeStatus.Unknown ? "" : "now "
			}alive.`,
		);
		if (
			oldStatus === NodeStatus.Dead &&
			node.interviewStage !== InterviewStage.Complete
		) {
			void this.interviewNode(node);
		}
	}

	/** Is called when a node is marked as dead */
	private onNodeDead(node: ZWaveNode, oldStatus: NodeStatus): void {
		this.controllerLog.logNode(
			node.id,
			`The node is ${
				oldStatus === NodeStatus.Unknown ? "" : "now "
			}dead.`,
		);

		// This could mean that we need to ignore it in the all nodes ready check,
		// so perform the check again
		this.checkAllNodesReady();
	}

	/** Is called when a node is ready to be used */
	private onNodeReady(node: ZWaveNode): void {
		this._nodesReady.add(node.id);
		this.controllerLog.logNode(node.id, "The node is ready to be used");

		this.checkAllNodesReady();
	}

	/** Checks if all nodes are ready and emits the "all nodes ready" event if they are */
	private checkAllNodesReady(): void {
		// Only emit "all nodes ready" once
		if (this._nodesReadyEventEmitted) return;

		for (const [id, node] of this.controller.nodes) {
			// Ignore dead nodes or the all nodes ready event will never be emitted without physical user interaction
			if (node.status === NodeStatus.Dead) continue;

			if (!this._nodesReady.has(id)) return;
		}
		// All nodes are ready
		this.controllerLog.print("All nodes are ready to be used");
		this.emit("all nodes ready");
		this._nodesReadyEventEmitted = true;
	}

	/** Is called when a node interview is completed */
	private onNodeInterviewCompleted(node: ZWaveNode): void {
		this.debounceSendNodeToSleep(node);
	}

	/** This is called when a new node has been added to the network */
	private onNodeAdded(node: ZWaveNode): void {
		this.addNodeEventHandlers(node);
		if (!this.options.skipInterview) {
			// Interview the node
			// don't await the interview, because it may take a very long time
			// if a node is asleep
			void this.interviewNode(node);
		}
	}

	/** This is called when a node was removed from the network */
	private onNodeRemoved(node: ZWaveNode): void {
		// Remove all listeners
		this.removeNodeEventHandlers(node);
		// purge node values from the DB
		node.valueDB.clear();

		this.rejectAllTransactionsForNode(
			node.id,
			"The node was removed from the network",
			ZWaveErrorCodes.Controller_NodeRemoved,
		);

		// Asynchronously remove the node from all possible associations, ignore potential errors
		this.controller.removeNodeFromAllAssocations(node.id).catch((err) => {
			this.driverLog.print(
				`Failed to remove node ${node.id} from all associations: ${err.message}`,
				"error",
			);
		});

		// Remove the node id from all cached neighbor lists and asynchronously make the affected nodes update their neighbor lists
		for (const otherNode of this.controller.nodes.values()) {
			if (otherNode !== node && otherNode.neighbors.includes(node.id)) {
				otherNode.removeNodeFromCachedNeighbors(node.id);
				otherNode.queryNeighborsInternal().catch((err) => {
					this.driverLog.print(
						`Failed to update neighbors for node ${otherNode.id}: ${err.message}`,
						"warn",
					);
				});
			}
		}

		// And clean up all remaining resources used by the node
		node.destroy();

		// If this was a failed node it could mean that all nodes are now ready
		this.checkAllNodesReady();
	}

	/** This is called when a node's firmware was updated */
	private onNodeFirmwareUpdated(
		node: ZWaveNode,
		status: FirmwareUpdateStatus,
		waitTime?: number,
	): void {
		// Don't do this for non-successful updates
		if (status < FirmwareUpdateStatus.OK_WaitingForActivation) return;

		// Wait at least 5 seconds
		if (!waitTime) waitTime = 5000;
		this.controllerLog.logNode(
			node.id,
			`Firmware updated, scheduling interview in ${waitTime} ms...`,
		);
		// We reuse the retryNodeInterviewTimeouts here because they serve a similar purpose
		this.retryNodeInterviewTimeouts.set(
			node.id,
			setTimeout(() => {
				this.retryNodeInterviewTimeouts.delete(node.id);
				void node.refreshInfo();
			}, waitTime).unref(),
		);
	}

	/** Checks if there are any pending messages for the given node */
	private hasPendingMessages(node: ZWaveNode): boolean {
		const { queue, currentTransaction } = this.sendThread.state.context;
		return (
			!!queue.find((t) => t.message.getNodeId() === node.id) ||
			currentTransaction?.message.getNodeId() === node.id
		);
	}

	/**
	 * Retrieves the maximum version of a command class the given endpoint supports.
	 * Returns 0 when the CC is not supported. Also returns 0 when the node was not found.
	 * Falls back to querying the root endpoint if an endpoint was not found on the node
	 *
	 * @param cc The command class whose version should be retrieved
	 * @param nodeId The node for which the CC version should be retrieved
	 * @param endpointIndex The endpoint in question
	 */
	public getSupportedCCVersionForEndpoint(
		cc: CommandClasses,
		nodeId: number,
		endpointIndex: number = 0,
	): number {
		if (
			this._controller == undefined ||
			!this.controller.nodes.has(nodeId)
		) {
			return 0;
		}
		const node = this.controller.nodes.get(nodeId)!;
		const endpoint = node.getEndpoint(endpointIndex);
		if (endpoint) return endpoint.getCCVersion(cc);
		// We sometimes receive messages from an endpoint, but can't find that endpoint.
		// In that case fall back to the root endpoint to determine the supported version.
		return node.getCCVersion(cc);
	}

	/**
	 * Retrieves the maximum version of a command class that can be used to communicate with a node.
	 * Returns 1 if the node claims that it does not support a CC.
	 * Throws if the CC is not implemented in this library yet.
	 *
	 * @param cc The command class whose version should be retrieved
	 * @param nodeId The node for which the CC version should be retrieved
	 * @param endpointIndex The endpoint for which the CC version should be retrieved
	 */
	public getSafeCCVersionForNode(
		cc: CommandClasses,
		nodeId: number,
		endpointIndex: number = 0,
	): number {
		const supportedVersion = this.getSupportedCCVersionForEndpoint(
			cc,
			nodeId,
			endpointIndex,
		);
		if (supportedVersion === 0) {
			// For unsupported CCs use version 1, no matter what
			return 1;
		} else {
			// For supported versions find the maximum version supported by both the
			// node and this library
			const implementedVersion = getImplementedVersion(cc);
			if (
				implementedVersion !== 0 &&
				implementedVersion !== Number.POSITIVE_INFINITY
			) {
				return Math.min(supportedVersion, implementedVersion);
			}
			throw new ZWaveError(
				"Cannot retrieve the version of a CC that is not implemented",
				ZWaveErrorCodes.CC_NotSupported,
			);
		}
	}

	/**
	 * Performs a hard reset on the controller. This wipes out all configuration!
	 *
	 * The returned Promise resolves when the hard reset has been performed.
	 * It does not wait for the initialization process which is started afterwards.
	 */
	public async hardReset(): Promise<void> {
		this.ensureReady(true);
		// Calling ensureReady with true ensures that _controller is defined
		await this._controller!.hardReset();

		// Clean up
		this.rejectTransactions(() => true, `The controller was hard-reset`);
		this.sendNodeToSleepTimers.forEach((timeout) => clearTimeout(timeout));
		this.sendNodeToSleepTimers.clear();
		this.retryNodeInterviewTimeouts.forEach((timeout) =>
			clearTimeout(timeout),
		);
		this.retryNodeInterviewTimeouts.clear();

		this._controllerInterviewed = false;
		void this.initializeControllerAndNodes();
	}

	private _wasDestroyed: boolean = false;
	/**
	 * Ensures that the driver is ready to communicate (serial port open and not destroyed).
	 * If desired, also checks that the controller interview has been completed.
	 */
	private ensureReady(includingController: boolean = false): void {
		if (!this._wasStarted || !this._isOpen || this._wasDestroyed) {
			throw new ZWaveError(
				"The driver is not ready or has been destroyed",
				ZWaveErrorCodes.Driver_NotReady,
			);
		}
		if (includingController && !this._controllerInterviewed) {
			throw new ZWaveError(
				"The controller is not ready yet",
				ZWaveErrorCodes.Driver_NotReady,
			);
		}
	}

	/** Indicates whether the driver is ready, i.e. the "driver ready" event was emitted */
	public get ready(): boolean {
		return (
			this._wasStarted &&
			this._isOpen &&
			!this._wasDestroyed &&
			this._controllerInterviewed
		);
	}

	private _cleanupHandler = (): void => {
		void this.destroy();
	};

	/**
	 * Terminates the driver instance and closes the underlying serial connection.
	 * Must be called under any circumstances.
	 */
	public async destroy(): Promise<void> {
		// Ensure this is only called once
		if (this._wasDestroyed) return;
		this._wasDestroyed = true;
		this.driverLog.print("destroying driver instance...");

		// First stop the send thread machine and close the serial port, so nothing happens anymore
		if (this.sendThread.initialized) this.sendThread.stop();
		if (this.serial != undefined) {
			if (this.serial.isOpen) await this.serial.close();
			this.serial = undefined;
		}

		try {
			// Attempt to save the network to cache
			await this.saveNetworkToCacheInternal();
		} catch (e) {
			this.driverLog.print(
				`Saving the network to cache failed: ${e.message}`,
				"error",
			);
		}

		try {
			// Attempt to close the value DBs
			await this._valueDB?.close();
			await this._metadataDB?.close();
		} catch (e) {
			this.driverLog.print(
				`Closing the value DBs failed: ${e.message}`,
				"error",
			);
		}

		// Remove all timeouts
		for (const timeout of [
			this.saveToCacheTimer,
			...this.sendNodeToSleepTimers.values(),
			...this.retryNodeInterviewTimeouts.values(),
		]) {
			if (timeout) clearTimeout(timeout);
		}

		// Destroy all nodes
		this._controller?.nodes.forEach((n) => n.destroy());

		process.removeListener("exit", this._cleanupHandler);
		process.removeListener("SIGINT", this._cleanupHandler);
		process.removeListener("uncaughtException", this._cleanupHandler);

		// destroy loggers as the very last thing
		this._logContainer.destroy();
	}

	private serialport_onError(err: Error): void {
		this.emit("error", err);
	}

	/**
	 * Is called when the serial port has received a single-byte message or a complete message buffer
	 */
	private async serialport_onData(
		data:
			| Buffer
			| MessageHeaders.ACK
			| MessageHeaders.CAN
			| MessageHeaders.NAK,
	): Promise<void> {
		if (typeof data === "number") {
			switch (data) {
				// single-byte messages - just forward them to the send thread
				case MessageHeaders.ACK: {
					this.sendThread.send("ACK");
					return;
				}
				case MessageHeaders.NAK: {
					this.sendThread.send("NAK");
					return;
				}
				case MessageHeaders.CAN: {
					this.sendThread.send("CAN");
					return;
				}
			}
		}

		let msg: Message | undefined;
		try {
			msg = Message.from(this, data);
			// all good, send ACK
			await this.writeHeader(MessageHeaders.ACK);
		} catch (e) {
			const response = this.handleDecodeError(e, data);
			if (response) await this.writeHeader(response);
		}

		// If the message could be decoded, forward it to the send thread
		if (msg) {
			if (isCommandClassContainer(msg)) {
				// SecurityCCCommandEncapsulationNonceGet is two commands in one, but
				// we're not set up to handle things like this. Reply to the nonce get
				// and handle the encapsulation part normally
				if (
					msg.command instanceof
					SecurityCCCommandEncapsulationNonceGet
				) {
					void msg.getNodeUnsafe()?.handleSecurityNonceGet();
				}

				// Assemble partial CCs on the driver level. Only forward complete messages to the send thread machine
				if (!this.assemblePartialCCs(msg)) return;
			}

			try {
				this.driverLog.logMessage(msg, { direction: "inbound" });

				if (process.env.NODE_ENV !== "test") {
					// Enrich error data in case something goes wrong
					Sentry.addBreadcrumb({
						category: "message",
						timestamp: Date.now() / 1000,
						type: "debug",
						data: {
							direction: "inbound",
							msgType: msg.type,
							functionType: msg.functionType,
							name: msg.constructor.name,
							nodeId: msg.getNodeId(),
							...msg.toLogEntry(),
						},
					});
				}
			} catch (e) {
				// We shouldn't throw just because logging a message fails
				this.driverLog.print(`Logging a message failed: ${e.message}`);
			}
			this.sendThread.send({ type: "message", message: msg });
		}
	}

	/** Handles a decoding error and returns the desired reply to the stick */
	private handleDecodeError(
		e: Error,
		data: Buffer,
	): MessageHeaders | undefined {
		if (e instanceof ZWaveError) {
			switch (e.code) {
				case ZWaveErrorCodes.PacketFormat_Invalid:
				case ZWaveErrorCodes.PacketFormat_Checksum:
				case ZWaveErrorCodes.PacketFormat_Truncated:
					this.driverLog.print(
						`Dropping message because it contains invalid data`,
						"warn",
					);
					return MessageHeaders.NAK;

				case ZWaveErrorCodes.Deserialization_NotImplemented:
				case ZWaveErrorCodes.CC_NotImplemented:
					this.driverLog.print(
						`Dropping message because it could not be deserialized: ${e.message}`,
						"warn",
					);
					return MessageHeaders.ACK;

				case ZWaveErrorCodes.Driver_NotReady:
					this.driverLog.print(
						`Dropping message because the driver is not ready to handle it yet.`,
						"warn",
					);
					return MessageHeaders.ACK;

				case ZWaveErrorCodes.PacketFormat_InvalidPayload:
					this.driverLog.print(
						`Dropping message with invalid data${
							typeof e.context === "string"
								? ` (Reason: ${e.context})`
								: ""
						}:
0x${data.toString("hex")}`,
						"warn",
					);
					return MessageHeaders.ACK;

				case ZWaveErrorCodes.Driver_NoSecurity:
					this.driverLog.print(
						`Dropping message because network key is not set or the driver is not yet ready to receive secure messages.`,
						"warn",
					);
					return MessageHeaders.ACK;
			}
		} else {
			if (/database is not open/.test(e.message)) {
				// The JSONL-DB is not open yet
				this.driverLog.print(
					`Dropping message because the driver is not ready to handle it yet.`,
					"warn",
				);
				return MessageHeaders.ACK;
			}
		}
		// Pass all other errors through
		throw e;
	}

	/** Checks if a transaction failed because a node didn't respond in time */
	private isMissingNodeACK(
		transaction: Transaction,
		e: ZWaveError,
	): transaction is Transaction & {
		message: SendDataRequest;
	} {
		return (
			// If the node does not acknowledge our request, it is either asleep or dead
			e.code === ZWaveErrorCodes.Controller_CallbackNOK &&
			transaction.message instanceof SendDataRequest &&
			// Ignore pre-transmit handshakes because the actual transaction will be retried
			transaction.priority !== MessagePriority.PreTransmitHandshake
		);
	}

	/**
	 * Handles the case that a node failed to respond in time.
	 * Returns `true` if the transaction failure was handled, `false` if it needs to be rejected.
	 */
	private handleMissingNodeACK(
		transaction: Transaction & {
			message: SendDataRequest;
		},
	): boolean {
		const node = transaction.message.getNodeUnsafe();
		if (!node) return false; // This should never happen, but whatever

		if (!transaction.changeNodeStatusOnTimeout) {
			// The sender of this transaction doesn't want it to change the status of the node
			return false;
		} else if (node.canSleep) {
			this.controllerLog.logNode(
				node.id,
				`The node did not respond after ${transaction.message.maxSendAttempts} attempts.
It is probably asleep, moving its messages to the wakeup queue.`,
				"warn",
			);
			// Mark the node as asleep
			// The handler for the asleep status will move the messages to the wakeup queue
			// We need to re-add the current transaction if that is allowed because otherwise it will be dropped silently
			if (this.mayMoveToWakeupQueue(transaction)) {
				this.sendThread.send({ type: "add", transaction });
			} else {
				transaction.promise.reject(
					new ZWaveError(
						`The node is asleep`,
						ZWaveErrorCodes.Controller_MessageDropped,
					),
				);
			}
			node.markAsAsleep();
			return true;
		} else {
			const errorMsg = `Node ${node.id} did not respond after ${transaction.message.maxSendAttempts} attempts, it is presumed dead`;
			this.controllerLog.logNode(node.id, errorMsg, "warn");

			node.markAsDead();
			this.rejectAllTransactionsForNode(node.id, errorMsg);
			// The above call will reject the transaction, no need to do it again
			return false;
		}
	}

	private partialCCSessions = new Map<string, CommandClass[]>();
	/**
	 * Assembles partial CCs of in a message body. Returns `true` when the message is complete and can be handled further.
	 * If the message expects another partial one, this returns `false`.
	 */
	private assemblePartialCCs(msg: Message & ICommandClassContainer): boolean {
		let command: CommandClass | undefined = msg.command;
		let sessionId: Record<string, any> | undefined;
		// We search for the every CC that provides us with a session ID
		// There might be newly-completed CCs that contain a partial CC,
		// so investigate the entire CC encapsulation stack.
		while (true) {
			sessionId = command.getPartialCCSessionId();

			if (sessionId) {
				// This CC belongs to a partial session
				const partialSessionKey = JSON.stringify({
					nodeId: msg.getNodeId()!,
					ccId: msg.command.ccId,
					ccCommand: msg.command.ccCommand!,
					...sessionId,
				});
				if (!this.partialCCSessions.has(partialSessionKey)) {
					this.partialCCSessions.set(partialSessionKey, []);
				}
				const session = this.partialCCSessions.get(partialSessionKey)!;
				if (command.expectMoreMessages(session)) {
					// this is not the final one, store it
					session.push(command);
					// and don't handle the command now
					this.driverLog.logMessage(msg, {
						secondaryTags: ["partial"],
						direction: "inbound",
					});
					return false;
				} else {
					// this is the final one, merge the previous responses
					this.partialCCSessions.delete(partialSessionKey);
					try {
						command.mergePartialCCs(session);
					} catch (e: unknown) {
						if (e instanceof ZWaveError) {
							switch (e.code) {
								case ZWaveErrorCodes.Deserialization_NotImplemented:
								case ZWaveErrorCodes.CC_NotImplemented:
									this.driverLog.print(
										`Dropping message because it could not be deserialized: ${e.message}`,
										"warn",
									);
									// Don't continue handling this message
									return false;

								case ZWaveErrorCodes.PacketFormat_InvalidPayload:
									this.driverLog.print(
										`Could not assemble partial CCs because the payload is invalid. Dropping them.`,
										"warn",
									);
									// Don't continue handling this message
									return false;

								case ZWaveErrorCodes.Driver_NotReady:
									this.driverLog.print(
										`Could not assemble partial CCs because the driver is not ready yet. Dropping them`,
										"warn",
									);
									// Don't continue handling this message
									return false;
							}
						}
						throw e;
					}
					// Assembling this CC was successful - but it might contain another partial CC
				}
			} else {
				// No partial CC, just continue
			}

			// If this is an encapsulating CC, we need to look one level deeper
			if (isEncapsulatingCommandClass(command)) {
				command = command.encapsulated;
			} else {
				break;
			}
		}
		return true;
	}

	/**
	 * Is called when a message is received that does not belong to any ongoing transactions
	 * @param msg The decoded message
	 */
	private async handleUnsolicitedMessage(msg: Message): Promise<void> {
		if (msg.type === MessageType.Request) {
			// This is a request we might have registered handlers for
			try {
				await this.handleRequest(msg);
			} catch (e) {
				if (
					e instanceof ZWaveError &&
					e.code === ZWaveErrorCodes.Driver_NotReady
				) {
					this.driverLog.print(
						`Cannot handle message because the driver is not ready to handle it yet.`,
						"warn",
					);
				} else {
					throw e;
				}
			}
		} else {
			this.driverLog.transactionResponse(msg, undefined, "unexpected");
			this.driverLog.print("unexpected response, discarding...", "warn");
		}
	}

	/**
	 * Registers a handler for messages that are not handled by the driver as part of a message exchange.
	 * The handler function needs to return a boolean indicating if the message has been handled.
	 * Registered handlers are called in sequence until a handler returns `true`.
	 *
	 * @param fnType The function type to register the handler for
	 * @param handler The request handler callback
	 * @param oneTime Whether the handler should be removed after its first successful invocation
	 */
	public registerRequestHandler<T extends Message>(
		fnType: FunctionType,
		handler: RequestHandler<T>,
		oneTime: boolean = false,
	): void {
		const handlers: RequestHandlerEntry<T>[] = this.requestHandlers.has(
			fnType,
		)
			? this.requestHandlers.get(fnType)!
			: [];
		const entry: RequestHandlerEntry<T> = { invoke: handler, oneTime };
		handlers.push(entry);
		this.driverLog.print(
			`added${oneTime ? " one-time" : ""} request handler for ${
				FunctionType[fnType]
			} (${num2hex(fnType)})...
${handlers.length} registered`,
		);
		this.requestHandlers.set(fnType, handlers as RequestHandlerEntry[]);
	}

	/**
	 * Unregisters a message handler that has been added with `registerRequestHandler`
	 * @param fnType The function type to unregister the handler for
	 * @param handler The previously registered request handler callback
	 */
	public unregisterRequestHandler(
		fnType: FunctionType,
		handler: RequestHandler,
	): void {
		const handlers = this.requestHandlers.has(fnType)
			? this.requestHandlers.get(fnType)!
			: [];
		for (let i = 0, entry = handlers[i]; i < handlers.length; i++) {
			// remove the handler if it was found
			if (entry.invoke === handler) {
				handlers.splice(i, 1);
				break;
			}
		}
		this.driverLog.print(
			`removed request handler for ${FunctionType[fnType]} (${fnType})...
${handlers.length} left`,
		);
		this.requestHandlers.set(fnType, handlers);
	}

	/**
	 * Checks whether a CC may be handled or should be ignored.
	 * This method expects `cc` to be unwrapped.
	 */
	private mayHandleUnsolicitedCommand(cc: CommandClass): boolean {
		// This should only be necessary for unsolicited commands, since the response matching
		// is pretty strict and looks at the encapsulation order

		// From SDS11847:
		// A controlling node MUST discard a received Report/Notification type command if it is
		// not received using S0 encapsulation and the corresponding Command Class is supported securely only

		if (cc.secure && cc.ccId !== CommandClasses.Security) {
			const commandName = cc.constructor.name;
			if (
				commandName.endsWith("Report") ||
				commandName.endsWith("Notification")
			) {
				// Check whether there was a S0 encapsulation
				if (cc.isEncapsulatedWith(CommandClasses.Security)) return true;
				// none found, don't accept the CC
				this.controllerLog.logNode(
					cc.nodeId as number,
					`command must be encrypted but was received without Security encapsulation - discarding it...`,
					"warn",
				);
				return false;
			}
		}
		return true;
	}

	/**
	 * Is called when a Request-type message was received
	 */
	private async handleRequest(msg: Message): Promise<void> {
		let handlers: RequestHandlerEntry[] | undefined;

		// For further actions, we are only interested in the innermost CC
		if (isCommandClassContainer(msg)) this.unwrapCommands(msg);

		if (isNodeQuery(msg) || isCommandClassContainer(msg)) {
			const node = msg.getNodeUnsafe();
			if (node) {
				// We have received an unsolicited message from a dead node, bring it back to life
				if (node.status === NodeStatus.Dead) {
					node.markAsAlive();
				}
			}
		}

		if (isCommandClassContainer(msg)) {
			const node = msg.getNodeUnsafe();
			// If we receive an encrypted message but assume the node is insecure, change our assumption
			if (
				node?.isSecure === false &&
				(msg.command.ccId === CommandClasses.Security ||
					msg.command.isEncapsulatedWith(CommandClasses.Security))
			) {
				node.isSecure = true;
				// Force a new interview
				void node.refreshInfo();
			}

			// Check if we may even handle the command
			if (!this.mayHandleUnsolicitedCommand(msg.command)) return;
		}

		if (
			msg instanceof ApplicationCommandRequest ||
			msg instanceof BridgeApplicationCommandRequest
		) {
			// we handle ApplicationCommandRequests differently because they are handled by the nodes directly
			const nodeId = msg.command.nodeId;
			// cannot handle ApplicationCommandRequests without a controller
			if (this._controller == undefined) {
				this.driverLog.print(
					`  the controller is not ready yet, discarding...`,
					"warn",
				);
				return;
			} else if (!this.controller.nodes.has(nodeId)) {
				this.driverLog.print(
					`  the node is unknown or not initialized yet, discarding...`,
					"warn",
				);
				return;
			}

			const node = this.controller.nodes.get(nodeId)!;
			// Check if we need to handle the command ourselves
			if (
				msg.command.ccId === CommandClasses["Device Reset Locally"] &&
				msg.command instanceof DeviceResetLocallyCCNotification
			) {
				this.controllerLog.logNode(msg.command.nodeId, {
					message: `The node was reset locally, removing it`,
					direction: "inbound",
				});
				if (!(await this.controller.isFailedNode(msg.command.nodeId))) {
					try {
						// Force a ping of the node, so it gets added to the failed nodes list
						node.markAsAwake();
						await node.commandClasses["No Operation"].send();
					} catch {
						// this is expected
					}
				}

				try {
					// ...because we can only remove failed nodes
					await this.controller.removeFailedNode(msg.command.nodeId);
				} catch (e) {
					this.controllerLog.logNode(msg.command.nodeId, {
						message: `removing the node failed: ${e}`,
						level: "error",
					});
				}
			} else if (
				msg.command.ccId === CommandClasses.Supervision &&
				msg.command instanceof SupervisionCCReport &&
				this.supervisionSessions.has(msg.command.sessionId)
			) {
				// Supervision commands are handled here
				this.controllerLog.logNode(msg.command.nodeId, {
					message: `Received update for a Supervision session`,
					direction: "inbound",
				});

				// Call the update handler
				this.supervisionSessions.get(msg.command.sessionId)!(
					msg.command.status,
					msg.command.duration,
				);
				// If this was a final report, remove the handler
				if (!msg.command.moreUpdatesFollow) {
					this.supervisionSessions.delete(msg.command.sessionId);
				}
			} else {
				// check if someone is waiting for this command
				for (const entry of this.awaitedCommands) {
					if (entry.predicate(msg.command)) {
						// resolve the promise - this will remove the entry from the list
						entry.promise.resolve(msg.command);
						return;
					}
				}
				// noone is waiting, dispatch the command to the node itself
				await node.handleCommand(msg.command);
			}

			return;
		} else if (msg instanceof ApplicationUpdateRequest) {
			if (msg instanceof ApplicationUpdateRequestNodeInfoReceived) {
				const node = msg.getNodeUnsafe();
				if (node) {
					this.controllerLog.logNode(node.id, {
						message: "Received updated node info",
						direction: "inbound",
					});
					node.updateNodeInfo(msg.nodeInformation);

					// Tell the send thread that we received a NIF from the node
					this.sendThread.send({ type: "NIF", nodeId: node.id });
					return;
				}
			}
		} else {
			// TODO: This deserves a nicer formatting
			this.driverLog.print(
				`handling request ${FunctionType[msg.functionType]} (${
					msg.functionType
				})`,
			);
			handlers = this.requestHandlers.get(msg.functionType);
		}

		if (handlers != undefined && handlers.length > 0) {
			this.driverLog.print(
				`  ${handlers.length} handler${
					handlers.length !== 1 ? "s" : ""
				} registered!`,
			);
			// loop through all handlers and find the first one that returns true to indicate that it handled the message
			for (let i = 0; i < handlers.length; i++) {
				this.driverLog.print(`  invoking handler #${i}`);
				// Invoke the handler and remember its result
				const handler = handlers[i];
				let handlerResult = handler.invoke(msg);
				if (handlerResult instanceof Promise) {
					handlerResult = await handlerResult;
				}
				if (handlerResult) {
					this.driverLog.print(`    the message was handled`);
					if (handler.oneTime) {
						this.driverLog.print(
							"  one-time handler was successfully called, removing it...",
						);
						handlers.splice(i, 1);
					}
					// don't invoke any more handlers
					break;
				}
			}
		} else {
			this.driverLog.print("  no handlers registered!", "warn");
		}
	}

	private lastCallbackId = 0xff;
	/**
	 * Returns the next callback ID. Callback IDs are used to correllate requests
	 * to the controller/nodes with its response
	 */
	public getNextCallbackId(): number {
		this.lastCallbackId = (this.lastCallbackId + 1) & 0xff;
		if (this.lastCallbackId < 1) this.lastCallbackId = 1;
		return this.lastCallbackId;
	}

	private encapsulateCommands(msg: Message & ICommandClassContainer): void {
		// The encapsulation order (from outside to inside) is as follows:
		// 5. Any one of the following combinations:
		//   a. Security (S0 or S2) followed by transport service
		//   b. Transport Service
		//   c. Security (S0 or S2)
		//   d. CRC16
		// b and d are mutually exclusive, security is not
		// 4. Multi Channel
		// 3. Supervision
		// 2. Multi Command
		// 1. Encapsulated Command Class (payload), e.g. Basic Set

		// TODO: 2.

		// 3.
		if (SupervisionCC.requiresEncapsulation(msg.command)) {
			msg.command = SupervisionCC.encapsulate(this, msg.command);
		}

		// 4.
		if (MultiChannelCC.requiresEncapsulation(msg.command)) {
			msg.command = MultiChannelCC.encapsulate(this, msg.command);
		}

		// 5.
		if (SecurityCC.requiresEncapsulation(msg.command)) {
			msg.command = SecurityCC.encapsulate(this, msg.command);
		}
	}

	private unwrapCommands(msg: Message & ICommandClassContainer): void {
		// Unwrap encapsulating CCs until we get to the core
		while (
			isEncapsulatingCommandClass(msg.command) ||
			isMultiEncapsulatingCommandClass(msg.command)
		) {
			const unwrapped = msg.command.encapsulated;
			if (isArray(unwrapped)) {
				this.driverLog.print(
					`Received a command that contains multiple CommandClasses. This is not supported yet! Discarding the message...`,
					"warn",
				);
				return;
			}
			msg.command = unwrapped;
		}
	}

	// wotan-disable no-misused-generics
	/**
	 * Sends a message to the Z-Wave stick.
	 * @param msg The message to send
	 * @param options (optional) Options regarding the message transmission
	 */
	public async sendMessage<TResponse extends Message = Message>(
		msg: Message,
		options: SendMessageOptions = {},
	): Promise<TResponse> {
		this.ensureReady();

		let node: ZWaveNode | undefined;

		// Don't send messages to dead nodes
		if (isNodeQuery(msg) || isCommandClassContainer(msg)) {
			node = msg.getNodeUnsafe();
			if (!messageIsPing(msg) && node?.status === NodeStatus.Dead) {
				// Instead of throwing immediately, try to ping the node first - if it responds, continue
				if (!(await node.ping())) {
					throw new ZWaveError(
						`The message cannot be sent because node ${node.id} is dead`,
						ZWaveErrorCodes.Controller_MessageDropped,
					);
				}
			}
		}

		if (options.priority == undefined)
			options.priority = getDefaultPriority(msg);
		if (options.priority == undefined) {
			const className = msg.constructor.name;
			const msgTypeName = FunctionType[msg.functionType];
			throw new ZWaveError(
				`No default priority has been defined for ${className} (${msgTypeName}), so you have to provide one for your message`,
				ZWaveErrorCodes.Driver_NoPriority,
			);
		}

		if (options.supportCheck == undefined) options.supportCheck = true;
		if (
			options.supportCheck &&
			this._controller != undefined &&
			!this._controller.isFunctionSupported(msg.functionType)
		) {
			throw new ZWaveError(
				`Your hardware does not support the ${
					FunctionType[msg.functionType]
				} function`,
				ZWaveErrorCodes.Driver_NotSupported,
			);
		}

		// When sending a message to a node that is known to be sleeping,
		// the priority must be WakeUp, so the message gets deprioritized
		// in comparison with messages to awake nodes.
		// However there are a few exceptions...
		if (
			!!node &&
			// Pings can be used to check if a node is really asleep, so they should be sent regardless
			!messageIsPing(msg) &&
			// Nodes that can sleep and support the Wake Up CC should have their messages queued for wakeup
			node.canSleep &&
			(node.supportsCC(CommandClasses["Wake Up"]) ||
				// If we don't know the Wake Up support yet, also change the priority or RequestNodeInfoRequests will get stuck
				// in front of the queue
				node.interviewStage < InterviewStage.NodeInfo) &&
			// If we move multicasts to the wakeup queue, it is unlikely
			// that there is ever a points where all targets are awake
			!(msg instanceof SendDataMulticastRequest) &&
			// Handshake messages are meant to be sent immediately
			options.priority !== MessagePriority.Handshake &&
			options.priority !== MessagePriority.PreTransmitHandshake
		) {
			options.priority = MessagePriority.WakeUp;
		}

		// create the transaction and enqueue it
		const promise = createDeferredPromise<TResponse>();
		const transaction = new Transaction(
			this,
			msg,
			promise,
			options.priority,
		);

		if (options.changeNodeStatusOnMissingACK != undefined) {
			transaction.changeNodeStatusOnTimeout =
				options.changeNodeStatusOnMissingACK;
		}
		transaction.tag = options.tag;

		// start sending now (maybe)
		this.sendThread.send({ type: "add", transaction });

		// If the transaction should expire, start the timeout
		let expirationTimeout: NodeJS.Timeout | undefined;
		if (options.expire) {
			expirationTimeout = setTimeout(() => {
				this.sendThread.send({
					type: "reduce",
					reducer: (t: Transaction) => {
						if (t === transaction)
							return {
								type: "reject",
								message: `The message has expired`,
								code: ZWaveErrorCodes.Controller_MessageExpired,
							};
						return { type: "keep" };
					},
				});
			}, options.expire).unref();
		}

		try {
			const ret = await promise;
			if (expirationTimeout) clearTimeout(expirationTimeout);
			if (node) {
				if (node.canSleep) {
					// If the node is not meant to be kept awake, try to send it back to sleep
					if (!node.keepAwake) {
						this.debounceSendNodeToSleep(node);
					}
					// The node must be awake because it answered
					node.markAsAwake();
				} else if (node.status !== NodeStatus.Alive) {
					// The node status was unknown or dead - in either case it must be alive because it answered
					node.markAsAlive();
				}
			}
			return ret;
		} catch (e) {
			if (e instanceof ZWaveError) {
				if (
					// If a controller command failed (that is not SendData), pass the response/callback through
					(e.code === ZWaveErrorCodes.Controller_ResponseNOK ||
						e.code === ZWaveErrorCodes.Controller_CallbackNOK) &&
					e.context instanceof Message &&
					e.context.functionType !== FunctionType.SendData &&
					e.context.functionType !== FunctionType.SendDataMulticast
				) {
					return e.context as TResponse;
				}
			}
			throw e;
		}
	}
	// wotan-enable no-misused-generics

	/**
	 * Sends a command to a Z-Wave node. If the node returns a command in response, that command will be the return value.
	 * If the command expects no response **or** the response times out, nothing will be returned
	 * @param command The command to send. It will be encapsulated in a SendData[Multicast]Request.
	 * @param options (optional) Options regarding the message transmission
	 */
	// wotan-disable-next-line no-misused-generics
	public async sendCommand<TResponse extends CommandClass = CommandClass>(
		command: CommandClass,
		options: SendCommandOptions = {},
	): Promise<TResponse | undefined> {
		let msg: SendDataRequest | SendDataMulticastRequest;
		if (command.isSinglecast()) {
			msg = new SendDataRequest(this, { command });
		} else if (command.isMulticast()) {
			msg = new SendDataMulticastRequest(this, { command });
		} else {
			throw new ZWaveError(
				`A CC must either be singlecast or multicast`,
				ZWaveErrorCodes.Argument_Invalid,
			);
		}
		// Specify the number of send attempts for the request
		if (options.maxSendAttempts != undefined) {
			msg.maxSendAttempts = options.maxSendAttempts;
		}

		// Automatically encapsulate commands before sending
		this.encapsulateCommands(msg);

		try {
			const resp = await this.sendMessage(msg, options);

			// And unwrap the response if there was any
			if (isCommandClassContainer(resp)) {
				this.unwrapCommands(resp);
				return resp.command as TResponse;
			}
		} catch (e: unknown) {
			// A timeout always has to be expected. In this case return nothing.
			if (
				e instanceof ZWaveError &&
				e.code === ZWaveErrorCodes.Controller_NodeTimeout
			) {
				if (command.isSinglecast()) {
					this.controllerLog.logNode(
						command.nodeId,
						e.message,
						"warn",
					);
				}
			} else {
				// We don't want to swallow any other errors
				throw e;
			}
		}
	}

	/**
	 * Sends a supervised command to a Z-Wave node. When status updates are requested, the passed callback will be executed for every non-final update.
	 * @param command The command to send
	 * @param options (optional) Options regarding the message transmission
	 */
	public async sendSupervisedCommand(
		command: CommandClass,
		options: SendSupervisedCommandOptions = {
			requestStatusUpdates: false,
		},
	): Promise<SupervisionResult | undefined> {
		// Check if the target supports this command
		if (!command.getNode()?.supportsCC(CommandClasses.Supervision)) {
			throw new ZWaveError(
				`Node ${
					command.nodeId as number
				} does not support the Supervision CC!`,
				ZWaveErrorCodes.CC_NotSupported,
			);
		}

		// Create the encapsulating CC so we have a session ID
		command = SupervisionCC.encapsulate(
			this,
			command,
			options.requestStatusUpdates,
		);

		const resp = await this.sendCommand<SupervisionCCReport>(
			command,
			options,
		);
		if (!resp) return;

		// If future updates are expected, listen for them
		if (options.requestStatusUpdates && resp.moreUpdatesFollow) {
			this.supervisionSessions.set(
				(command as SupervisionCCGet).sessionId,
				options.onUpdate,
			);
		}
		// In any case, return the status
		return {
			status: resp.status,
			remainingDuration: resp.duration,
		};
	}

	/**
	 * Sends a supervised command to a Z-Wave node if the Supervision CC is supported. If not, a normal command is sent.
	 * This does not return any Report values, so only use this for Set-type commands.
	 *
	 * @param command The command to send
	 * @param options (optional) Options regarding the message transmission
	 */
	public async trySendCommandSupervised(
		command: CommandClass,
		options?: SendSupervisedCommandOptions,
	): Promise<SupervisionResult | undefined> {
		if (command.getNode()?.supportsCC(CommandClasses.Supervision)) {
			return this.sendSupervisedCommand(command, options);
		} else {
			await this.sendCommand(command, options);
		}
	}

	/**
	 * Sends a low-level message like ACK, NAK or CAN immediately
	 * @param message The low-level message to send
	 */
	private writeHeader(header: MessageHeaders): Promise<void> {
		// ACK, CAN, NAK
		return this.writeSerial(Buffer.from([header]));
	}

	/** Sends a raw datagram to the serialport (if that is open) */
	private async writeSerial(data: Buffer): Promise<void> {
		return this.serial?.writeAsync(data);
	}

	/**
	 * Waits until a command is received or a timeout has elapsed. Returns the received command.
	 * @param timeout The number of milliseconds to wait. If the timeout elapses, the returned promise will be rejected
	 * @param predicate A predicate function to test all incoming command classes
	 */
	// wotan-disable-next-line no-misused-generics
	public waitForCommand<T extends CommandClass>(
		predicate: (cc: CommandClass) => boolean,
		timeout: number,
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const entry: AwaitedCommandEntry = {
				predicate,
				promise: createDeferredPromise<CommandClass>(),
				timeout: undefined,
			};
			this.awaitedCommands.push(entry);
			const removeEntry = () => {
				if (entry.timeout) clearTimeout(entry.timeout);
				const index = this.awaitedCommands.indexOf(entry);
				if (index !== -1) this.awaitedCommands.splice(index, 1);
			};
			// When the timeout elapses, remove the wait entry and reject the returned Promise
			entry.timeout = setTimeout(() => {
				removeEntry();
				reject(
					new ZWaveError(
						`Received no matching command within the provided timeout!`,
						ZWaveErrorCodes.Controller_NodeTimeout,
					),
				);
			}, timeout).unref();
			// When the promise is resolved, remove the wait entry and resolve the returned Promise
			void entry.promise.then((cc) => {
				removeEntry();
				resolve(cc as T);
			});
		});
	}

	/** Checks if a message is allowed to go into the wakeup queue */
	private mayMoveToWakeupQueue(transaction: Transaction): boolean {
		const msg = transaction.message;
		switch (true) {
			// Pings and handshake responses will block the send queue until wakeup,
			// so they must be dropped
			case messageIsPing(msg):
			case transaction.priority === MessagePriority.Handshake:
			// Outgoing handshake requests are very likely not valid after wakeup, so drop them too
			case transaction.priority === MessagePriority.PreTransmitHandshake:
			// We also don't want to immediately send the node to sleep when it wakes up
			case isCommandClassContainer(msg) &&
				msg.command instanceof WakeUpCCNoMoreInformation:
			// compat queries because they will be recreated when the node wakes up
			case transaction.tag === "compat":
				return false;
		}

		return true;
	}

	/** Moves all messages for a given node into the wakeup queue */
	private moveMessagesToWakeupQueue(nodeId: number): void {
		const reject: TransactionReducerResult = {
			type: "reject",
			message: `The node is asleep`,
			code: ZWaveErrorCodes.Controller_MessageDropped,
		};
		const requeue: TransactionReducerResult = {
			type: "requeue",
			priority: MessagePriority.WakeUp,
		};

		const reducer: TransactionReducer = (transaction, _source) => {
			const msg = transaction.message;
			if (msg.getNodeId() !== nodeId) return { type: "keep" };
			// Drop all messages that are not allowed in the wakeup queue
			// For all other messages, change the priority to wakeup
			return this.mayMoveToWakeupQueue(transaction) ? requeue : reject;
		};

		// Apply the reducer to the send thread
		this.sendThread.send({ type: "reduce", reducer });
	}

	/**
	 * @internal
	 * Rejects all pending transactions that match a predicate and removes them from the send queue
	 */
	public rejectTransactions(
		predicate: (t: Transaction) => boolean,
		errorMsg: string = `The message has been removed from the queue`,
		errorCode: ZWaveErrorCodes = ZWaveErrorCodes.Controller_MessageDropped,
	): void {
		const reducer: TransactionReducer = (transaction) => {
			if (predicate(transaction)) {
				return {
					type: "reject",
					message: errorMsg,
					code: errorCode,
				};
			} else {
				return { type: "keep" };
			}
		};
		// Apply the reducer to the send thread
		this.sendThread.send({ type: "reduce", reducer });
	}

	/**
	 * @internal
	 * Rejects all pending transactions for a node and removes them from the send queue
	 */
	public rejectAllTransactionsForNode(
		nodeId: number,
		errorMsg: string = `The node is dead`,
		errorCode: ZWaveErrorCodes = ZWaveErrorCodes.Controller_MessageDropped,
	): void {
		this.rejectTransactions(
			(t) => t.message.getNodeId() === nodeId,
			errorMsg,
			errorCode,
		);
	}

	/** Re-sorts the send queue */
	private sortSendQueue(): void {
		this.sendThread.send("sortQueue");
	}

	private lastSaveToCache: number = 0;
	private readonly saveToCacheInterval: number = 150;
	private saveToCacheTimer: NodeJS.Timer | undefined;
	private isSavingToCache: boolean = false;

	/**
	 * Does the work for saveNetworkToCache. This is not throttled, so any call
	 * to this method WILL save the network.
	 */
	private async saveNetworkToCacheInternal(): Promise<void> {
		if (!this._controller || !this.controller.homeId) return;

		await this.options.storage.driver.ensureDir(this.cacheDir);
		const cacheFile = path.join(
			this.cacheDir,
			this.controller.homeId.toString(16) + ".json",
		);

		const serializedObj = this.controller.serialize();
		const jsonString = stringify(serializedObj);
		await this.options.storage.driver.writeFile(
			cacheFile,
			jsonString,
			"utf8",
		);
	}

	/**
	 * Saves the current configuration and collected data about the controller and all nodes to a cache file.
	 * For performance reasons, these calls may be throttled.
	 */
	public async saveNetworkToCache(): Promise<void> {
		// TODO: Detect if the network needs to be saved at all
		if (!this._controller || !this.controller.homeId) return;
		// Ensure this method isn't being executed too often
		if (
			this.isSavingToCache ||
			Date.now() - this.lastSaveToCache < this.saveToCacheInterval
		) {
			// Schedule a save in a couple of ms to collect changes
			if (!this.saveToCacheTimer) {
				this.saveToCacheTimer = setTimeout(
					() => void this.saveNetworkToCache(),
					this.saveToCacheInterval,
				);
			}
			return;
		} else {
			this.saveToCacheTimer = undefined;
		}
		this.isSavingToCache = true;
		await this.saveNetworkToCacheInternal();
		this.isSavingToCache = false;
		this.lastSaveToCache = Date.now();
	}

	/**
	 * Restores a previously stored Z-Wave network state from cache to speed up the startup process
	 */
	public async restoreNetworkStructureFromCache(): Promise<void> {
		if (!this._controller || !this.controller.homeId) return;

		const cacheFile = path.join(
			this.cacheDir,
			`${this.controller.homeId.toString(16)}.json`,
		);
		if (!(await this.options.storage.driver.pathExists(cacheFile))) return;

		try {
			this.driverLog.print(
				`Cache file for homeId ${num2hex(
					this.controller.homeId,
				)} found, attempting to restore the network from cache...`,
			);
			const cacheString = await this.options.storage.driver.readFile(
				cacheFile,
				"utf8",
			);
			await this.controller.deserialize(JSON.parse(cacheString));
			this.driverLog.print(
				`Restoring the network from cache was successful!`,
			);
		} catch (e) {
			const message = `Restoring the network from cache failed: ${e}`;
			this.emit(
				"error",
				new ZWaveError(message, ZWaveErrorCodes.Driver_InvalidCache),
			);
			this.driverLog.print(message, "error");
		}
	}

	private sendNodeToSleepTimers = new Map<number, NodeJS.Timeout>();
	/**
	 * @internal
	 * Marks a node for a later sleep command. Every call refreshes the period until the node actually goes to sleep
	 */
	public debounceSendNodeToSleep(node: ZWaveNode): void {
		// TODO: This should be a single command to the send thread
		// Delete old timers if any exist
		if (this.sendNodeToSleepTimers.has(node.id)) {
			clearTimeout(this.sendNodeToSleepTimers.get(node.id)!);
		}

		// Sends a node to sleep if it has no more messages.
		const sendNodeToSleep = (node: ZWaveNode): void => {
			this.sendNodeToSleepTimers.delete(node.id);
			if (!this.hasPendingMessages(node)) {
				void node.sendNoMoreInformation().catch(() => {
					/* ignore errors */
				});
			}
		};

		// If a sleeping node has no messages pending (and supports the Wake Up CC), we may send it back to sleep
		if (
			node.supportsCC(CommandClasses["Wake Up"]) &&
			!this.hasPendingMessages(node)
		) {
			this.sendNodeToSleepTimers.set(
				node.id,
				setTimeout(() => sendNodeToSleep(node), 1000).unref(),
			);
		}
	}

	/** Computes the maximum net CC payload size for the given CC or SendDataRequest */
	public computeNetCCPayloadSize(
		commandOrMsg: CommandClass | SendDataRequest,
	): number {
		// Recreate the correct encapsulation structure
		const msg =
			commandOrMsg instanceof SendDataRequest
				? commandOrMsg
				: new SendDataRequest(this, { command: commandOrMsg });
		this.encapsulateCommands(msg);
		return msg.command.getMaxPayloadLength(msg.getMaxPayloadLength());
	}

	// This does not all need to be printed to the console
	public [util.inspect.custom](): string {
		return "[Driver]";
	}
}
