// This file is auto-generated by maintenance/generateCCExports.ts
// Do not edit it by hand or your changes will be lost!

import * as fs from "fs";

// Load all CC files to ensure all metadata gets loaded
const definedCCs = fs
	.readdirSync(__dirname)
	.filter((file) => /CC.(js|ts)$/.test(file));
for (const file of definedCCs) {
	require(`./${file}`);
}

// explicitly export specific things from the CCs
export { AlarmSensorType } from "./AlarmSensorCC";
export type { AlarmSensorValueMetadata } from "./AlarmSensorCC";
export { CCAPI } from "./API";
export { AssociationGroupInfoProfile } from "./AssociationGroupInfoCC";
export type { AssociationGroup } from "./AssociationGroupInfoCC";
export {
	BarrierState,
	SubsystemState,
	SubsystemType,
} from "./BarrierOperatorCC";
export { BatteryChargingStatus, BatteryReplacementStatus } from "./BatteryCC";
export { BinarySensorType } from "./BinarySensorCC";
export type { BinarySensorValueMetadata } from "./BinarySensorCC";
export { CentralSceneKeys } from "./CentralSceneCC";
export { ScheduleOverrideType } from "./ClimateControlScheduleCC";
export { Weekday } from "./ClockCC";
export { ColorComponent } from "./ColorSwitchCC";
export type { ColorTable } from "./ColorSwitchCC";
export { CommandClass } from "./CommandClass";
export type { ConfigValue } from "./ConfigurationCC";
export { DoorLockMode, DoorLockOperationType } from "./DoorLockCC";
export type { DoorHandleStatus } from "./DoorLockCC";
export {
	FirmwareDownloadStatus,
	FirmwareUpdateActivationStatus,
	FirmwareUpdateRequestStatus,
	FirmwareUpdateStatus,
} from "./FirmwareUpdateMetaDataCC";
export type { IndicatorMetadata } from "./IndicatorCC";
export { DeviceIdType } from "./ManufacturerSpecificCC";
export { RateType } from "./MeterCC";
export type { MeterMetadata } from "./MeterCC";
export type { Association } from "./MultiChannelAssociationCC";
export type {
	MultilevelSensorCCReportOptions,
	MultilevelSensorValue,
	MultilevelSensorValueMetadata,
} from "./MultilevelSensorCC";
export { LevelChangeDirection, SwitchType } from "./MultilevelSwitchCC";
export type { MultilevelSwitchLevelChangeMetadata } from "./MultilevelSwitchCC";
export type { NotificationMetadata } from "./NotificationCC";
export { LocalProtectionState, RFProtectionState } from "./ProtectionCC";
export { ToneId } from "./SoundSwitchCC";
export { SupervisionStatus } from "./SupervisionCC";
export type { SupervisionResult } from "./SupervisionCC";
export { ThermostatFanState } from "./ThermostatFanStateCC";
export { ThermostatMode } from "./ThermostatModeCC";
export { ThermostatOperatingState } from "./ThermostatOperatingStateCC";
export { SetbackType } from "./ThermostatSetbackCC";
export { ThermostatSetpointType } from "./ThermostatSetpointCC";
export type { ThermostatSetpointMetadata } from "./ThermostatSetpointCC";
export { KeypadMode, UserIDStatus } from "./UserCodeCC";
export { ZWavePlusNodeType, ZWavePlusRoleType } from "./ZWavePlusCC";
