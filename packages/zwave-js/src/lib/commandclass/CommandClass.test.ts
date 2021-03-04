import {
	assertZWaveError,
	CommandClasses,
	ZWaveErrorCodes,
} from "@zwave-js/core";
import { SendDataRequest } from "../controller/SendDataMessages";
import type { Driver } from "../driver/Driver";
import { ZWaveNode } from "../node/Node";
import { createEmptyMockDriver } from "../test/mocks";
import { BasicCC, BasicCCSet } from "./BasicCC";
import {
	CentralSceneCCNotification,
	CentralSceneCommand,
	CentralSceneKeys,
} from "./CentralSceneCC";
import {
	CommandClass,
	commandClass,
	expectedCCResponse,
	getExpectedCCResponse,
	getImplementedVersion,
	getImplementedVersionStatic,
	implementedVersion,
} from "./CommandClass";
import "./index";

@implementedVersion(7)
@commandClass(0xffff as any)
class DummyCC extends CommandClass {}
class DummyCCSubClass1 extends DummyCC {
	private x: any;
}
@expectedCCResponse(DummyCCSubClass1)
class DummyCCSubClass2 extends DummyCC {
	private y: any;
}

const fakeDriver = (createEmptyMockDriver() as unknown) as Driver;

describe("lib/commandclass/CommandClass => ", () => {
	describe("creating and serializing()", () => {
		let node2: ZWaveNode;

		beforeEach(() => {
			node2 = new ZWaveNode(2, fakeDriver as any);
			(fakeDriver.controller.nodes as any).set(2, node2);
		});

		afterEach(() => {
			node2.destroy();
			(fakeDriver.controller.nodes as any).delete(2);
		});

		it(`should work for unspecified commands`, () => {
			// Repro for #1219
			const cc = new CommandClass(fakeDriver, {
				nodeId: 2,
				ccId: 0x5d,
				ccCommand: 0x02,
				payload: Buffer.from([1, 2, 3]),
			});
			const msg = new SendDataRequest(fakeDriver, {
				command: cc,
				callbackId: 0xfe,
			});
			expect(msg.serialize()).toEqual(
				Buffer.from("010c001302055d0201020325fe63", "hex"),
			);
		});
	});

	describe("from()", () => {
		it("throws CC_NotImplemented when receiving a non-implemented CC", () => {
			// This is a Node Provisioning CC. Change it when that CC is implemented
			assertZWaveError(
				() =>
					CommandClass.from(fakeDriver, {
						data: Buffer.from("78030100", "hex"),
						nodeId: 5,
					}),
				{
					errorCode: ZWaveErrorCodes.CC_NotImplemented,
				},
			);
		});

		it("does not throw when the CC is implemented", () => {
			expect(() =>
				CommandClass.from(fakeDriver, {
					// CRC-16 with BasicCC
					data: Buffer.from("560120024d26", "hex"),
					nodeId: 5,
				}),
			).not.toThrow();
		});
	});

	describe("getImplementedVersion()", () => {
		it("should return the implemented version for a CommandClass instance", () => {
			const cc = new BasicCC(fakeDriver, { nodeId: 1 });
			expect(getImplementedVersion(cc)).toBe(2);
		});

		it("should return the implemented version for a numeric CommandClass key", () => {
			const cc = CommandClasses.Basic;
			expect(getImplementedVersion(cc)).toBe(2);
		});

		it.skip("should return 0 for a non-implemented CommandClass instance", () => {
			// const cc = new CommandClass(undefined);
			// expect(getImplementedVersion(cc)).toBe(0);
		});

		it("should return the implemented version for a numeric CommandClass key", () => {
			const cc = -1;
			expect(getImplementedVersion(cc)).toBe(0);
		});

		it("should work with inheritance", () => {});
	});

	describe("getImplementedVersionStatic()", () => {
		it("should return the implemented version for a CommandClass constructor", () => {
			expect(getImplementedVersionStatic(BasicCC)).toBe(2);
		});

		it("should work on inherited classes", () => {
			expect(getImplementedVersionStatic(DummyCCSubClass1)).toBe(7);
		});
	});

	it.skip("serializing with an undefined or null payload should behave like an empty payload", () => {
		// const cc1 = new CommandClass(undefined, 1, 1, Buffer.from([]));
		// const cc2 = new CommandClass(undefined, 1, 1, undefined);
		// const cc3 = new CommandClass(undefined, 1, 1, null);
		// const serialized1 = cc1.serialize();
		// const serialized2 = cc2.serialize();
		// const serialized3 = cc3.serialize();
		// expect(serialized1).toEqual(serialized2);
		// expect(serialized2).toEqual(serialized3);
	});

	describe("expectMoreMessages()", () => {
		it("returns false by default", () => {
			const cc = new DummyCC(fakeDriver, { nodeId: 1 });
			expect(cc.expectMoreMessages([])).toBeFalse();
		});
	});

	describe("getExpectedCCResponse()", () => {
		it("returns the expected CC response like it was defined", () => {
			const cc = new DummyCCSubClass2(fakeDriver, { nodeId: 1 });
			const actual = getExpectedCCResponse(cc);
			expect(actual).toBe(DummyCCSubClass1);
		});
	});

	describe("persistValues()", () => {
		let node2: ZWaveNode;

		beforeEach(() => {
			node2 = new ZWaveNode(2, fakeDriver as any);
			(fakeDriver.controller.nodes as any).set(2, node2);
		});

		afterEach(() => {
			node2.destroy();
			(fakeDriver.controller.nodes as any).delete(2);
		});

		it(`should not update "interviewComplete" in the value DB`, () => {
			// Repro for #383
			const cc = new BasicCCSet(fakeDriver, {
				nodeId: 2,
				targetValue: 55,
			});
			cc.interviewComplete = true;

			const mockSetValue = jest.fn();
			node2.valueDB.setValue = mockSetValue;
			cc.persistValues();

			const properties = mockSetValue.mock.calls
				.map(([arg0]) => arg0)
				.map(({ property }) => property);
			expect(properties).not.toContainValue("interviewComplete");
		});

		it(`should not store values marked as "events" (non-stateful)`, async () => {
			const cc = new CentralSceneCCNotification(fakeDriver, {
				nodeId: 2,
				data: Buffer.from([
					CommandClasses["Central Scene"],
					CentralSceneCommand.Notification,
					1, // seq number
					CentralSceneKeys.KeyPressed,
					1, // scene number
				]),
			});

			// Central Scene should use the value notification event instead of added/updated
			const spyN = jest.fn();
			const spyA = jest.fn();
			node2.on("value notification", spyN);
			node2.on("value added", spyA);
			node2.on("value updated", spyA);
			await node2.handleCommand(cc);

			expect(spyA).not.toBeCalled();
			expect(spyN).toBeCalled();
			expect(spyN.mock.calls[0][1].value).toBe(
				CentralSceneKeys.KeyPressed,
			);

			// and not persist the value in the DB
			expect(
				node2.valueDB.getValues(CommandClasses["Central Scene"]),
			).toHaveLength(0);
		});
	});
});
