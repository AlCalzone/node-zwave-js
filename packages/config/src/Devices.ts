import { ZWaveError, ZWaveErrorCodes } from "@zwave-js/core";
import {
	JSONObject,
	ObjectKeyMap,
	ReadonlyObjectKeyMap,
	stringify,
} from "@zwave-js/shared";
import { entries } from "alcalzone-shared/objects";
import { isArray, isObject } from "alcalzone-shared/typeguards";
import * as fs from "fs-extra";
import { pathExists, readFile, writeFile } from "fs-extra";
import JSON5 from "json5";
import path from "path";
import { CompatConfig } from "./CompatConfig";
import type { ConfigLogger } from "./Logger";
import {
	configDir,
	enumFilesRecursive,
	formatId,
	hexKeyRegex4Digits,
	throwInvalidConfig,
} from "./utils";

export interface FirmwareVersionRange {
	min: string;
	max: string;
}

export interface DeviceConfigIndexEntry {
	manufacturerId: string;
	manufacturer: string;
	label: string;
	productType: string;
	productId: string;
	firmwareVersion: FirmwareVersionRange;
	filename: string;
}

export type ParamInfoMap = ReadonlyObjectKeyMap<
	{ parameter: number; valueBitMask?: number },
	ParamInformation
>;

export const devicesDir = path.join(configDir, "devices");
export const indexPath = path.join(devicesDir, "index.json");
export type DeviceConfigIndex = DeviceConfigIndexEntry[];

async function hasChangedDeviceFiles(
	dir: string,
	lastChange: Date,
): Promise<boolean> {
	// Check if there are any files BUT index.json that were changed
	// or directories that were modified
	const filesAndDirs = await fs.readdir(dir);
	for (const f of filesAndDirs) {
		const fullPath = path.join(dir, f);

		const stat = await fs.stat(fullPath);
		if (
			(dir !== devicesDir || f !== "index.json") &&
			(stat.isFile() || stat.isDirectory()) &&
			stat.mtime > lastChange
		) {
			return true;
		} else if (stat.isDirectory()) {
			// we need to go deeper!
			if (await hasChangedDeviceFiles(fullPath, lastChange)) return true;
		}
	}
	return false;
}

/**
 * @internal
 * Loads the index file to quickly access the device configs.
 * Transparently handles updating the index if necessary
 */
export async function loadDeviceIndexInternal(
	logger?: ConfigLogger,
): Promise<DeviceConfigIndex> {
	// The index file needs to be regenerated if it does not exist
	let needsUpdate = !(await pathExists(indexPath));
	let index: DeviceConfigIndex | undefined;
	let mtimeIndex: Date | undefined;
	// ...or if cannot be parsed
	if (!needsUpdate) {
		try {
			const fileContents = await readFile(indexPath, "utf8");
			index = JSON5.parse(fileContents);
			mtimeIndex = (await fs.stat(indexPath)).mtime;
		} catch {
			logger?.print(
				"Error while parsing index file - regenerating...",
				"warn",
			);
			needsUpdate = true;
		} finally {
			if (!index) {
				logger?.print(
					"Index file was malformed - regenerating...",
					"warn",
				);
				needsUpdate = true;
			}
		}
	}

	// ...or if there were any changes in the file system
	if (!needsUpdate) {
		needsUpdate = await hasChangedDeviceFiles(devicesDir, mtimeIndex!);
		if (needsUpdate) {
			logger?.print(
				"Device configuration files on disk changed - regenerating index...",
				"verbose",
			);
		}
	}

	if (needsUpdate) {
		index = [];

		const configFiles = await enumFilesRecursive(
			devicesDir,
			(file) => file.endsWith(".json") && !file.endsWith("index.json"),
		);

		for (const file of configFiles) {
			const relativePath = path
				.relative(devicesDir, file)
				.replace(/\\/g, "/");
			// Try parsing the file
			try {
				const config = await DeviceConfig.from(file, devicesDir);
				// Add the file to the index
				index.push(
					...config.devices.map((dev: any) => ({
						manufacturerId: formatId(
							config.manufacturerId.toString(16),
						),
						manufacturer: config.manufacturer,
						label: config.label,
						...dev,
						firmwareVersion: config.firmwareVersion,
						filename: relativePath,
					})),
				);
			} catch (e: unknown) {
				throw new ZWaveError(
					`Error parsing config file ${relativePath}: ${
						(e as Error).message
					}`,
					ZWaveErrorCodes.Config_Invalid,
				);
			}
		}

		// Save the index to disk (but not during unit tests)
		await writeFile(
			path.join(indexPath),
			`// This file is auto-generated. DO NOT edit it by hand if you don't know what you're doing!"
${stringify(index, "\t")}
`,
			"utf8",
		);
		logger?.print("Device index regenerated", "verbose");
	}

	return index!;
}

function isHexKeyWith4Digits(val: any): val is string {
	return typeof val === "string" && hexKeyRegex4Digits.test(val);
}

const firmwareVersionRegex = /^\d{1,3}\.\d{1,3}$/;
function isFirmwareVersion(val: any): val is string {
	return (
		typeof val === "string" &&
		firmwareVersionRegex.test(val) &&
		val
			.split(".")
			.map((str) => parseInt(str, 10))
			.every((num) => num >= 0 && num <= 255)
	);
}

export class DeviceConfig {
	public static async from(
		filename: string,
		relativeTo?: string,
	): Promise<DeviceConfig> {
		const relativePath = relativeTo
			? path.relative(relativeTo, filename).replace(/\\/g, "/")
			: filename;
		const fileContents = await readFile(filename, "utf8");

		return new DeviceConfig(relativePath, fileContents);
	}

	public constructor(filename: string, fileContents: string) {
		const definition = JSON5.parse(fileContents);
		if (!isHexKeyWith4Digits(definition.manufacturerId)) {
			throwInvalidConfig(
				`device`,
				`packages/config/config/devices/${filename}:
manufacturer id must be a hexadecimal number with 4 digits`,
			);
		}
		this.manufacturerId = parseInt(definition.manufacturerId, 16);

		for (const prop of ["manufacturer", "label", "description"] as const) {
			if (typeof definition[prop] !== "string") {
				throwInvalidConfig(
					`device`,
					`packages/config/config/devices/${filename}:
${prop} is not a string`,
				);
			}
			this[prop] = definition[prop];
		}

		if (
			!isArray(definition.devices) ||
			!(definition.devices as any[]).every(
				(dev: unknown) =>
					isObject(dev) &&
					isHexKeyWith4Digits(dev.productType) &&
					isHexKeyWith4Digits(dev.productId),
			)
		) {
			throwInvalidConfig(
				`device`,
				`packages/config/config/devices/${filename}:
devices is malformed (not an object or type/id that is not a 4-digit hex key)`,
			);
		}
		this.devices = (definition.devices as any[]).map(
			({ productType, productId }) => ({ productType, productId }),
		);

		if (
			!isObject(definition.firmwareVersion) ||
			!isFirmwareVersion(definition.firmwareVersion.min) ||
			!isFirmwareVersion(definition.firmwareVersion.max)
		) {
			throwInvalidConfig(
				`device`,
				`packages/config/config/devices/${filename}:
firmwareVersion is malformed or invalid`,
			);
		} else {
			const { min, max } = definition.firmwareVersion;
			this.firmwareVersion = { min, max };
		}

		if (definition.associations != undefined) {
			const associations = new Map<number, AssociationConfig>();
			if (!isObject(definition.associations)) {
				throwInvalidConfig(
					`device`,
					`packages/config/config/devices/${filename}:
associations is not an object`,
				);
			}
			for (const [key, assocDefinition] of entries(
				definition.associations,
			)) {
				if (!/^[1-9][0-9]*$/.test(key))
					throwInvalidConfig(
						`device`,
						`packages/config/config/devices/${filename}:
found non-numeric group id "${key}" in associations`,
					);
				const keyNum = parseInt(key, 10);
				associations.set(
					keyNum,
					new AssociationConfig(filename, keyNum, assocDefinition),
				);
			}
			this.associations = associations;
		}

		if (definition.paramInformation != undefined) {
			const paramInformation = new ObjectKeyMap<
				{ parameter: number; valueBitMask?: number },
				ParamInformation
			>();
			if (!isObject(definition.paramInformation)) {
				throwInvalidConfig(
					`device`,
					`packages/config/config/devices/${filename}:
paramInformation is not an object`,
				);
			}
			for (const [key, paramDefinition] of entries(
				definition.paramInformation,
			)) {
				const match = /^(\d+)(?:\[0x([0-9a-fA-F]+)\])?$/.exec(key);
				if (!match) {
					throwInvalidConfig(
						`device`,
						`packages/config/config/devices/${filename}: 
found invalid param number "${key}" in paramInformation`,
					);
				}
				const keyNum = parseInt(match[1], 10);
				const bitMask =
					match[2] != undefined ? parseInt(match[2], 16) : undefined;
				paramInformation.set(
					{ parameter: keyNum, valueBitMask: bitMask },
					new ParamInformation(
						filename,
						keyNum,
						bitMask,
						paramDefinition,
					),
				);
			}
			this.paramInformation = paramInformation;
		}

		if (definition.proprietary != undefined) {
			if (!isObject(definition.proprietary)) {
				throwInvalidConfig(
					`device`,
					`packages/config/config/devices/${filename}:
proprietary is not an object`,
				);
			}
			this.proprietary = definition.proprietary;
		}

		if (definition.compat != undefined) {
			if (!isObject(definition.compat)) {
				throwInvalidConfig(
					`device`,
					`packages/config/config/devices/${filename}:
compat is not an object`,
				);
			}
			this.compat = new CompatConfig(filename, definition.compat);
		}
	}

	public readonly manufacturer!: string;
	public readonly manufacturerId: number;
	public readonly label!: string;
	public readonly description!: string;
	public readonly devices: readonly {
		productType: string;
		productId: string;
	}[];
	public readonly firmwareVersion: FirmwareVersionRange;
	public readonly associations?: ReadonlyMap<number, AssociationConfig>;
	public readonly paramInformation?: ParamInfoMap;
	/**
	 * Contains manufacturer-specific support information for the
	 * ManufacturerProprietary CC
	 */
	public readonly proprietary?: Record<string, unknown>;
	/** Contains compatibility options */
	public readonly compat?: CompatConfig;
}

export class AssociationConfig {
	public constructor(
		filename: string,
		groupId: number,
		definition: JSONObject,
	) {
		this.groupId = groupId;
		if (typeof definition.label !== "string") {
			throwInvalidConfig(
				"devices",
				`packages/config/config/devices/${filename}:
Association ${groupId} has a non-string label`,
			);
		}
		this.label = definition.label;

		if (
			definition.description != undefined &&
			typeof definition.description !== "string"
		) {
			throwInvalidConfig(
				"devices",
				`packages/config/config/devices/${filename}:
Association ${groupId} has a non-string description`,
			);
		}
		this.description = definition.description;

		if (typeof definition.maxNodes !== "number") {
			throwInvalidConfig(
				"devices",
				`packages/config/config/devices/${filename}:
maxNodes for association ${groupId} is not a number`,
			);
		}
		this.maxNodes = definition.maxNodes;

		if (
			definition.isLifeline != undefined &&
			definition.isLifeline !== true
		) {
			throwInvalidConfig(
				"devices",
				`packages/config/config/devices/${filename}:
isLifeline in association ${groupId} must be either true or left out`,
			);
		}
		this.isLifeline = !!definition.isLifeline;

		if (
			definition.noEndpoint != undefined &&
			definition.noEndpoint !== true
		) {
			throwInvalidConfig(
				"devices",
				`packages/config/config/devices/${filename}:
noEndpoint in association ${groupId} must be either true or left out`,
			);
		}
		this.noEndpoint = !!definition.noEndpoint;
	}

	public readonly groupId: number;
	public readonly label: string;
	public readonly description?: string;
	public readonly maxNodes: number;
	/**
	 * Whether this association group is used to report updates to the controller.
	 * While Z-Wave+ defines a single lifeline, older devices may have multiple lifeline associations.
	 */
	public readonly isLifeline: boolean;
	/** Some devices support multi channel associations but require some of its groups to use node id associations */
	public readonly noEndpoint: boolean;
}

export class ParamInformation {
	public constructor(
		filename: string,
		parameterNumber: number,
		valueBitMask: number | undefined,
		definition: JSONObject,
	) {
		this.parameterNumber = parameterNumber;
		this.valueBitMask = valueBitMask;

		if (typeof definition.label !== "string") {
			throwInvalidConfig(
				"devices",
				`packages/config/config/devices/${filename}:
Parameter #${parameterNumber} has a non-string label`,
			);
		}
		this.label = definition.label;

		if (
			definition.description != undefined &&
			typeof definition.description !== "string"
		) {
			throwInvalidConfig(
				"devices",
				`packages/config/config/devices/${filename}:
Parameter #${parameterNumber} has a non-string description`,
			);
		}
		this.description = definition.description;

		if (
			typeof definition.valueSize !== "number" ||
			definition.valueSize <= 0
		) {
			throwInvalidConfig(
				"devices",
				`packages/config/config/devices/${filename}:
Parameter #${parameterNumber} has an invalid value size`,
			);
		}
		this.valueSize = definition.valueSize;

		if (typeof definition.minValue !== "number") {
			throwInvalidConfig(
				"devices",
				`packages/config/config/devices/${filename}:
Parameter #${parameterNumber} has a non-numeric property minValue`,
			);
		}
		this.minValue = definition.minValue;

		if (typeof definition.maxValue !== "number") {
			throwInvalidConfig(
				"devices",
				`packages/config/config/devices/${filename}:
Parameter #${parameterNumber} has a non-numeric property maxValue`,
			);
		}
		this.maxValue = definition.maxValue;

		if (typeof definition.defaultValue !== "number") {
			throwInvalidConfig(
				"devices",
				`packages/config/config/devices/${filename}:
Parameter #${parameterNumber} has a non-numeric property defaultValue`,
			);
		}
		this.defaultValue = definition.defaultValue;

		if (
			definition.unsigned != undefined &&
			typeof definition.unsigned !== "boolean"
		) {
			throwInvalidConfig(
				"devices",
				`packages/config/config/devices/${filename}:
Parameter #${parameterNumber} has a non-boolean property unsigned`,
			);
		}
		this.unsigned = definition.unsigned === true;

		if (typeof definition.readOnly !== "boolean") {
			throwInvalidConfig(
				"devices",
				`packages/config/config/devices/${filename}:
Parameter #${parameterNumber}: readOnly must be a boolean!`,
			);
		}
		this.readOnly = definition.readOnly;

		if (typeof definition.writeOnly !== "boolean") {
			throwInvalidConfig(
				"devices",
				`packages/config/config/devices/${filename}:
Parameter #${parameterNumber}: writeOnly must be a boolean!`,
			);
		}
		this.writeOnly = definition.writeOnly;

		if (typeof definition.allowManualEntry !== "boolean") {
			throwInvalidConfig(
				"devices",
				`packages/config/config/devices/${filename}:
Parameter #${parameterNumber}: allowManualEntry must be a boolean!`,
			);
		}
		this.allowManualEntry = definition.allowManualEntry;

		if (
			isArray(definition.options) &&
			!definition.options.every(
				(opt: unknown) =>
					isObject(opt) &&
					typeof opt.label === "string" &&
					typeof opt.value === "number",
			)
		) {
			throwInvalidConfig(
				"devices",
				`packages/config/config/devices/${filename}:
Parameter #${parameterNumber}: options is malformed!`,
			);
		}
		this.options =
			definition.options?.map(
				({ label, value }: { label: string; value: any }) => ({
					label,
					value,
				}),
			) ?? [];
	}

	public readonly parameterNumber: number;
	public readonly valueBitMask?: number;
	public readonly label: string;
	public readonly description?: string;
	public readonly valueSize: number;
	public readonly minValue: number;
	public readonly maxValue: number;
	public readonly unsigned?: boolean;
	public readonly defaultValue: number;
	public readonly readOnly: boolean;
	public readonly writeOnly: boolean;
	public readonly allowManualEntry: boolean;
	public readonly options: readonly ConfigOption[];
}

export interface ConfigOption {
	value: number;
	label: string;
}
