import { CommandClasses, enumValuesToMetadataStates } from "@zwave-js/core";
import type { Driver } from "../driver/Driver";
import { createEmptyMockDriver } from "../test/mocks";
import { getCCValueMetadata } from "./CommandClass";
import {
	Powerlevel,
	PowerlevelCC,
	PowerlevelCCGet,
	PowerlevelCCReport,
	PowerlevelCCSet,
	PowerlevelCommand,
} from "./PowerlevelCC";

const fakeDriver = (createEmptyMockDriver() as unknown) as Driver;

function buildCCBuffer(payload: Buffer): Buffer {
	return Buffer.concat([
		Buffer.from([
			CommandClasses.Powerlevel, // CC
		]),
		payload,
	]);
}

describe("lib/commandclass/PowerlevelCC => ", () => {
	it("the Get command should serialize correctly", () => {
		const cc = new PowerlevelCCGet(fakeDriver, { nodeId: 1 });
		const expected = buildCCBuffer(
			Buffer.from([
				PowerlevelCommand.Get, // CC Command
			]),
		);
		expect(cc.serialize()).toEqual(expected);
	});

	it("the Set NormalPower command should serialize correctly", () => {
		const cc = new PowerlevelCCSet(fakeDriver, {
			nodeId: 2,
			powerlevel: Powerlevel.NormalPower,
		});
		const expected = buildCCBuffer(
			Buffer.from([
				PowerlevelCommand.Set, // CC Command
				Powerlevel.NormalPower, // powerlevel
				0, // timeout (ignored)
			]),
		);
		expect(cc.serialize()).toEqual(expected);
	});

	it("the Set NormalPower command with timeout should serialize correctly", () => {
		const cc = new PowerlevelCCSet(fakeDriver, {
			nodeId: 2,
			powerlevel: Powerlevel.NormalPower,
			timeout: 50,
		});
		const expected = buildCCBuffer(
			Buffer.from([
				PowerlevelCommand.Set, // CC Command
				Powerlevel.NormalPower, // powerlevel
				50, // timeout (ignored)
			]),
		);
		expect(cc.serialize()).toEqual(expected);
	});

	it("the Set Custom power command should serialize correctly", () => {
		const cc = new PowerlevelCCSet(fakeDriver, {
			nodeId: 2,
			powerlevel: Powerlevel.Minus1dBm,
			timeout: 50,
		});
		const expected = buildCCBuffer(
			Buffer.from([
				PowerlevelCommand.Set, // CC Command
				Powerlevel.Minus1dBm, // powerlevel
				50, // timeout
			]),
		);
		expect(cc.serialize()).toEqual(expected);
	});

	it("the Report command should be deserialized correctly (NormalPower)", () => {
		const ccData = buildCCBuffer(
			Buffer.from([
				PowerlevelCommand.Report, // CC Command
				Powerlevel.NormalPower, // powerlevel
				50, // timeout (ignored because NormalPower)
			]),
		);
		const cc = new PowerlevelCCReport(fakeDriver, {
			nodeId: 5,
			data: ccData,
		});

		expect(cc.powerlevel).toBe(Powerlevel.NormalPower);
		expect(cc.timeout).toBeUndefined(); // timeout does not apply to NormalPower
	});

	it("the Report command should be deserialized correctly (custom power)", () => {
		const ccData = buildCCBuffer(
			Buffer.from([
				PowerlevelCommand.Report, // CC Command
				Powerlevel.Minus3dBm, // powerlevel
				50, // timeout (ignored because NormalPower)
			]),
		);
		const cc = new PowerlevelCCReport(fakeDriver, {
			nodeId: 5,
			data: ccData,
		});

		expect(cc.powerlevel).toBe(Powerlevel.Minus3dBm);
		expect(cc.timeout).toBe(50); // timeout does not apply to NormalPower
	});

	it("deserializing an unsupported command should return an unspecified version of PowerlevelCC", () => {
		const serializedCC = buildCCBuffer(
			Buffer.from([255]), // not a valid command
		);
		const cc: any = new PowerlevelCC(fakeDriver, {
			nodeId: 1,
			data: serializedCC,
		});
		expect(cc.constructor).toBe(PowerlevelCC);
	});

	it("the CC values should have the correct metadata", () => {
		// Powerlevel
		const powerlevelValueMeta = getCCValueMetadata(
			CommandClasses.Powerlevel,
			"powerlevel",
		);
		expect(powerlevelValueMeta).toMatchObject({
			readable: true,
			writeable: true,
			states: enumValuesToMetadataStates(Powerlevel),
			label: "Power level",
		});

		// timeout [1, 255]
		const targetValueMeta = getCCValueMetadata(
			CommandClasses.Powerlevel,
			"timeout",
		);
		expect(targetValueMeta).toMatchObject({
			readable: true,
			writeable: true,
			min: 1,
			max: 255,
			label: "Timeout",
		});
	});
});
