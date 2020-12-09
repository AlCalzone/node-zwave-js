import {
	assertZWaveError,
	CommandClasses,
	ZWaveErrorCodes,
} from "@zwave-js/core";
import type { MockSerialPort } from "@zwave-js/serial";
import { BatteryCCAPI } from "../commandclass/BatteryCC";
import type { BinarySensorCCAPI } from "../commandclass/BinarySensorCC";
import { ZWaveController } from "../controller/Controller";
import type { Driver } from "../driver/Driver";
import { createAndStartDriver } from "../test/utils";
import { ZWaveNode } from "./Node";

describe("lib/node/VirtualEndpoint", () => {
	let driver: Driver;
	let serialport: MockSerialPort;

	beforeEach(async () => {
		({ driver, serialport } = await createAndStartDriver());
		driver["_controller"] = new ZWaveController(driver);
		driver["_controller"].isFunctionSupported = () => true;
	});

	function makePhysicalNode(nodeId: number): ZWaveNode {
		const node = new ZWaveNode(nodeId, driver);
		(driver.controller.nodes as Map<number, ZWaveNode>).set(nodeId, node);
		return node;
	}

	// function setNumEndpoints(node: ZWaveNode, numEndpoints: number) {
	// 	node.valueDB.setValue(
	// 		{
	// 			commandClass: CommandClasses["Multi Channel"],
	// 			property: "individualCount",
	// 		},
	// 		numEndpoints,
	// 	);
	// }

	afterEach(async () => {
		await driver.destroy();
		driver.removeAllListeners();
	});

	describe("createAPI", () => {
		it("throws if a non-implemented API should be created", () => {
			const broadcast = driver.controller.getBroadcastNode();
			assertZWaveError(() => broadcast.createAPI(0xbada55), {
				errorCode: ZWaveErrorCodes.CC_NoAPI,
				messageMatches: "no associated API",
			});
		});

		it("the broadcast API throws when trying to access a non-supported CC", async () => {
			makePhysicalNode(2);
			makePhysicalNode(3);
			const broadcast = driver.controller.getBroadcastNode();

			// We must not use Basic CC here, because that is assumed to be always supported
			const api = broadcast.createAPI(
				CommandClasses["Binary Sensor"],
			) as BinarySensorCCAPI;

			// this does not throw
			api.isSupported();
			// this does
			await assertZWaveError(() => api.get(), {
				errorCode: ZWaveErrorCodes.CC_NotSupported,
				messageMatches: "does not support",
			});
		});
	});

	describe("commandClasses dictionary", () => {
		it("throws when trying to access a non-implemented CC", () => {
			makePhysicalNode(2);
			makePhysicalNode(3);
			const broadcast = driver.controller.getBroadcastNode();

			assertZWaveError(() => (broadcast.commandClasses as any).FOOBAR, {
				errorCode: ZWaveErrorCodes.CC_NotImplemented,
				messageMatches: "FOOBAR is not implemented",
			});
		});

		it("returns all supported CCs when being enumerated", () => {
			// No supported CCs, empty array
			const node2 = makePhysicalNode(2);
			const node3 = makePhysicalNode(3);
			let broadcast = driver.controller.getBroadcastNode();
			let actual = [...broadcast.commandClasses];
			expect(actual).toEqual([]);

			// Supported and controlled CCs
			node2.addCC(CommandClasses.Battery, { isSupported: true });
			node2.addCC(CommandClasses["Wake Up"], { isControlled: true });
			node3.addCC(CommandClasses.Battery, { isSupported: true });
			node3.addCC(CommandClasses.Version, { isSupported: true });
			broadcast = driver.controller.getBroadcastNode();

			actual = [...broadcast.commandClasses];
			expect(actual).toHaveLength(1);
			expect(actual.map((api) => api.constructor)).toIncludeAllMembers([
				BatteryCCAPI,
				// VersionCCAPI cannot be used in broadcast
				// WakeUpCCAPI is not supported (only controlled), so no API!
			]);
		});

		it("returns [object Object] when turned into a string", () => {
			makePhysicalNode(2);
			makePhysicalNode(3);
			const broadcast = driver.controller.getBroadcastNode();
			expect((broadcast.commandClasses as any)[Symbol.toStringTag]).toBe(
				"[object Object]",
			);
		});

		it("returns undefined for other symbol properties", () => {
			makePhysicalNode(2);
			makePhysicalNode(3);
			const broadcast = driver.controller.getBroadcastNode();
			expect(
				(broadcast.commandClasses as any)[Symbol.unscopables],
			).toBeUndefined();
		});
	});

	describe("uses the correct commands behind the scenes", () => {
		it("broadcast", () => {
			makePhysicalNode(2);
			makePhysicalNode(3);
			const broadcast = driver.controller.getBroadcastNode();
			broadcast.commandClasses.Basic.set(99);
			// » [Node 255] [REQ] [SendData]
			//   │ transmit options: 0x25
			//   │ callback id:        1
			//   └─[BasicCCSet]
			expect(serialport.lastWrite).toEqual(
				Buffer.from("010a0013ff0320016325017c", "hex"),
			);
		});

		it("multicast", () => {
			makePhysicalNode(2);
			makePhysicalNode(3);
			const broadcast = driver.controller.getMulticastGroup(2, 3);
			broadcast.commandClasses.Basic.set(99);
			// » [Node 2, 3] [REQ] [SendData]
			//   │ transmit options: 0x25
			//   │ callback id:        1
			//   └─[BasicCCSet]
			expect(serialport.lastWrite).toEqual(
				Buffer.from("010c001402020303200163250181", "hex"),
			);
		});
	});
});
