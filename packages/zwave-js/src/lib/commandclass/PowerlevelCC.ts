import {
	CommandClasses,
	enumValuesToMetadataStates,
	Maybe,
	MessageOrCCLogEntry,
	MessageRecord,
	validatePayload,
	ValueMetadata,
	ZWaveError,
	ZWaveErrorCodes,
} from "@zwave-js/core";
import { getEnumMemberName, pick } from "@zwave-js/shared";
import type { Driver } from "../driver/Driver";
import { NodeStatus } from "../node/Types";
import { CCAPI } from "./API";
import {
	API,
	CCCommand,
	CCCommandOptions,
	ccValue,
	ccValueMetadata,
	CommandClass,
	commandClass,
	CommandClassDeserializationOptions,
	expectedCCResponse,
	gotDeserializationOptions,
	implementedVersion,
} from "./CommandClass";

// All the supported commands
export enum PowerlevelCommand {
	Set = 0x01,
	Get = 0x02,
	Report = 0x03,
	TestNodeSet = 0x04,
	TestNodeGet = 0x05,
	TestNodeReport = 0x06,
}

export enum Powerlevel {
	NormalPower = 0x00,
	Minus1dBm = 0x01,
	Minus2dBm = 0x02,
	Minus3dBm = 0x03,
	Minus4dBm = 0x04,
	Minus5dBm = 0x05,
	Minus6dBm = 0x06,
	Minus7dBm = 0x07,
	Minus8dBm = 0x08,
	Minus9dBm = 0x09,
}

export enum PowerlevelTestStatus {
	TestFailed = 0x00,
	TestSuccess = 0x01,
	TestInProgress = 0x02,
}

@API(CommandClasses.Powerlevel)
export class PowerlevelCCAPI extends CCAPI {
	public supportsCommand(cmd: PowerlevelCommand): Maybe<boolean> {
		switch (cmd) {
			case PowerlevelCommand.Get:
			case PowerlevelCommand.TestNodeGet:
				return this.isSinglecast();
			case PowerlevelCommand.Set:
			case PowerlevelCommand.TestNodeSet:
				return true;
		}
		return super.supportsCommand(cmd);
	}

	public async setNormalPowerlevel(): Promise<void> {
		this.assertSupportsCommand(PowerlevelCommand, PowerlevelCommand.Set);

		const cc = new PowerlevelCCSet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
			powerlevel: Powerlevel.NormalPower,
		});
		await this.driver.sendCommand(cc, this.commandOptions);
	}

	public async setCustomPowerlevel(
		powerlevel: Powerlevel,
		timeout: number,
	): Promise<void> {
		this.assertSupportsCommand(PowerlevelCommand, PowerlevelCommand.Set);

		const cc = new PowerlevelCCSet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
			powerlevel,
			timeout,
		});
		await this.driver.sendCommand(cc, this.commandOptions);
	}

	public async getPowerlevel(): Promise<
		Pick<PowerlevelCCReport, "powerlevel" | "timeout"> | undefined
	> {
		this.assertSupportsCommand(PowerlevelCommand, PowerlevelCommand.Get);

		const cc = new PowerlevelCCGet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
		});
		const response = await this.driver.sendCommand<PowerlevelCCReport>(
			cc,
			this.commandOptions,
		);
		if (response) {
			return pick(response, ["powerlevel", "timeout"]);
		}
	}

	public async startTestNode(
		testNodeId: number,
		powerlevel: Powerlevel,
		testFrameCount: number,
	): Promise<void> {
		this.assertSupportsCommand(
			PowerlevelCommand,
			PowerlevelCommand.TestNodeSet,
		);

		const cc = new PowerlevelCCTestNodeSet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
			testNodeId,
			powerlevel,
			testFrameCount,
		});
		await this.driver.sendCommand(cc, this.commandOptions);
	}

	public async getTestNodeResult(): Promise<
		| Pick<
				PowerlevelCCTestNodeReport,
				"testNodeId" | "testStatus" | "testFrameAcknowlegedCount"
		  >
		| undefined
	> {
		this.assertSupportsCommand(
			PowerlevelCommand,
			PowerlevelCommand.TestNodeGet,
		);

		const cc = new PowerlevelCCTestNodeGet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
		});
		const response = await this.driver.sendCommand<PowerlevelCCTestNodeReport>(
			cc,
			this.commandOptions,
		);
		if (response) {
			return pick(response, [
				"testNodeId",
				"testStatus",
				"testFrameAcknowlegedCount",
			]);
		}
	}
}

@commandClass(CommandClasses.Powerlevel)
@implementedVersion(1)
export class PowerlevelCC extends CommandClass {
	declare ccCommand: PowerlevelCommand;
}

type PowerlevelCCSetOptions = CCCommandOptions &
	(
		| {
				powerlevel: Powerlevel;
				timeout: number;
		  }
		| {
				powerlevel: typeof Powerlevel.NormalPower;
		  }
	);

@CCCommand(PowerlevelCommand.Set)
export class PowerlevelCCSet extends PowerlevelCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions | PowerlevelCCSetOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			// TODO: Deserialize payload
			throw new ZWaveError(
				`${this.constructor.name}: deserialization not implemented`,
				ZWaveErrorCodes.Deserialization_NotImplemented,
			);
		} else {
			if ("timeout" in options) {
				if (options.timeout < 1 || options.timeout > 255) {
					throw new ZWaveError(
						`${this.constructor.name}: The timeout parameter must be between 1 and 255.`,
						ZWaveErrorCodes.Argument_Invalid,
					);
				}
				this.timeout = options.timeout;
			}
			this.powerlevel = options.powerlevel;
		}
	}

	public powerlevel: Powerlevel;
	public timeout?: number;

	public serialize(): Buffer {
		this.payload = Buffer.from([this.powerlevel, this.timeout ?? 0x00]);
		return super.serialize();
	}

	public toLogEntry(): MessageOrCCLogEntry {
		const message: MessageRecord = {
			powerlevel: getEnumMemberName(Powerlevel, this.powerlevel),
		};
		if (this.timeout != undefined) {
			message.timeout = this.timeout;
		}
		return {
			...super.toLogEntry(),
			message,
		};
	}
}

@CCCommand(PowerlevelCommand.Report)
export class PowerlevelCCReport extends PowerlevelCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);

		this.powerlevel = this.payload[0];
		if (this.powerlevel !== Powerlevel.NormalPower) {
			this.timeout = this.payload[1];
		}

		this.persistValues();
	}

	@ccValue({ stateful: false })
	@ccValueMetadata({
		...ValueMetadata.UInt8,
		states: enumValuesToMetadataStates(Powerlevel),
		label: "Power level",
		description: "The current power level  in effect on the node.",
	})
	public readonly powerlevel: Powerlevel;

	@ccValue({ stateful: false })
	@ccValueMetadata({
		...ValueMetadata.UInt8,
		min: 1,
		max: 255,
		label: "Timeout",
		description: "Time in seconds before node returns to Normal power.",
	})
	public readonly timeout?: number;

	public toLogEntry(): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(),
			message: { "Power level": this.powerlevel, Timeout: this.timeout },
		};
	}
}

@CCCommand(PowerlevelCommand.Get)
@expectedCCResponse(PowerlevelCCReport)
export class PowerlevelCCGet extends PowerlevelCC {}

interface PowerlevelCCTestNodeSetOptions extends CCCommandOptions {
	testNodeId: number;
	powerlevel: Powerlevel;
	testFrameCount: number;
}

@CCCommand(PowerlevelCommand.TestNodeSet)
export class PowerlevelCCTestNodeSet extends PowerlevelCC {
	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| PowerlevelCCTestNodeSetOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			// TODO: Deserialize payload
			throw new ZWaveError(
				`${this.constructor.name}: deserialization not implemented`,
				ZWaveErrorCodes.Deserialization_NotImplemented,
			);
		} else {
			const testNode = driver.controller.nodes.get(options.testNodeId);
			if (!testNode) {
				throw new ZWaveError(
					`${this.constructor.name}: Node Id ${options.testNodeId} doesn't exist.`,
					ZWaveErrorCodes.Argument_Invalid,
				);
			}
			if (testNode.isFrequentListening) {
				throw new ZWaveError(
					`${this.constructor.name}: Node Id ${options.testNodeId} is FLiRS, which is not allowed for the Test Node.`,
					ZWaveErrorCodes.Argument_Invalid,
				);
			}
			if (testNode.status !== NodeStatus.Awake) {
				throw new ZWaveError(
					`${this.constructor.name}: Node Id ${options.testNodeId} status is ${testNode.status}, but the Test Node must be Awake.`,
					ZWaveErrorCodes.Argument_Invalid,
				);
			}

			this.testNodeId = options.testNodeId;
			this.powerlevel = options.powerlevel;
			this.testFrameCount = options.testFrameCount;
		}
	}

	public testNodeId: number;
	public powerlevel: Powerlevel;
	public testFrameCount: number;

	public serialize(): Buffer {
		this.payload = Buffer.from([
			this.testNodeId,
			this.powerlevel,
			(this.testFrameCount >> 8) & 0xff,
			this.testFrameCount & 0xff,
		]);
		return super.serialize();
	}

	public toLogEntry(): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(),
			message: {
				testNodeId: this.testNodeId,
				powerlevel: this.powerlevel,
				testFrameCount: this.testFrameCount,
			},
		};
	}
}

@CCCommand(PowerlevelCommand.TestNodeReport)
export class PowerlevelCCTestNodeReport extends PowerlevelCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);

		validatePayload(this.payload.length >= 4);
		this.testNodeId = this.payload[0];
		this.testStatus = this.payload[1];
		this.testFrameAcknowlegedCount =
			(this.payload[2] << 8) | this.payload[3];

		this.persistValues();
	}

	@ccValue({ stateful: false })
	@ccValueMetadata({
		...ValueMetadata.ReadOnlyUInt8,
		label: "Test Node Id",
	})
	public readonly testNodeId: number;

	@ccValue({ stateful: false })
	@ccValueMetadata({
		...ValueMetadata.ReadOnlyUInt8,
		states: enumValuesToMetadataStates(PowerlevelTestStatus),
		label: "Test Status",
	})
	public readonly testStatus: PowerlevelTestStatus;

	@ccValue({ stateful: false })
	@ccValueMetadata({
		...ValueMetadata.ReadOnlyUInt16,
		min: 1,
		max: 65535,
		label: "Test frame acknowledged count",
	})
	public readonly testFrameAcknowlegedCount;

	public toLogEntry(): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(),
			message: {
				"Test Node Id": this.testNodeId,
				"Test status": this.testStatus,
				"Test frame acknowledged count": this.testFrameAcknowlegedCount,
			},
		};
	}
}

@CCCommand(PowerlevelCommand.TestNodeGet)
@expectedCCResponse(PowerlevelCCTestNodeReport)
export class PowerlevelCCTestNodeGet extends PowerlevelCC {}
