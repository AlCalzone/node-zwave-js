import {
	CommandClasses,
	CRC16_CCITT,
	validatePayload,
	ZWaveError,
	ZWaveErrorCodes,
} from "@zwave-js/core";
import type { Driver } from "../driver/Driver";
import {
	CCCommand,
	CCCommandOptions,
	CCResponseRole,
	CommandClass,
	commandClass,
	CommandClassDeserializationOptions,
	expectedCCResponse,
	gotDeserializationOptions,
	implementedVersion,
} from "./CommandClass";

// All the supported commands
export enum TransportServiceCommand {
	FirstSegment = 0xc0,
	SegmentComplete = 0xe8,
	SegmentRequest = 0xc8,
	SegmentWait = 0xf0,
	SubsequentSegment = 0xe0,
}

const MAX_SEGMENT_SIZE = 39;

@commandClass(CommandClasses["Transport Service"])
@implementedVersion(2)
export class TransportServiceCC extends CommandClass {
	declare ccCommand: TransportServiceCommand;

	// Override the default helper method
	public static getCCCommand(data: Buffer): number | undefined {
		const originalCCCommand = super.getCCCommand(data)!;
		// Transport Service only uses the higher 5 bits for the command
		return originalCCCommand & 0b11111_000;
	}

	// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
	protected deserialize(data: Buffer) {
		const ret = super.deserialize(data) as {
			ccId: CommandClasses;
			ccCommand: number;
			payload: Buffer;
		};
		// Transport Service re-uses the lower 3 bits of the ccCommand as payload
		ret.payload = Buffer.concat([
			Buffer.from([ret.ccCommand & 0b111]),
			ret.payload,
		]);
		return ret;
	}

	/** Encapsulates a command that should be sent in multiple segments */
	public static encapsulate(
		_driver: Driver,
		_cc: CommandClass,
	): TransportServiceCC {
		throw new Error("not implemented");
	}
}

interface TransportServiceCCFirstSegmentOptions extends CCCommandOptions {
	datagramSize: number;
	sessionId: number;
	headerExtension?: Buffer | undefined;
	partialDatagram: Buffer;
}

@CCCommand(TransportServiceCommand.FirstSegment)
// @expectedCCResponse(TransportServiceCCReport)
export class TransportServiceCCFirstSegment extends TransportServiceCC {
	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| TransportServiceCCFirstSegmentOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			// Deserialization has already split the datagram size from the ccCommand.
			// Therefore we have one more payload byte

			validatePayload(this.payload.length >= 6); // 2 bytes dgram size, 1 byte sessid/ext, 1+ bytes payload, 2 bytes checksum

			// Verify the CRC
			const headerBuffer = Buffer.from([
				this.ccId,
				this.ccCommand | this.payload[0],
			]);
			const ccBuffer = this.payload.slice(1, -2);
			let expectedCRC = CRC16_CCITT(headerBuffer);
			expectedCRC = CRC16_CCITT(ccBuffer, expectedCRC);
			const actualCRC = this.payload.readUInt16BE(
				this.payload.length - 2,
			);
			validatePayload(expectedCRC === actualCRC);

			this.datagramSize = this.payload.readUInt16BE(0);
			this.sessionId = this.payload[2] >>> 4;
			let payloadOffset = 3;

			// If there is a header extension, read it
			const hasHeaderExtension = !!(this.payload[2] & 0b1000);
			if (hasHeaderExtension) {
				const extLength = this.payload[3];
				this.headerExtension = this.payload.slice(4, 4 + extLength);
				payloadOffset += 1 + extLength;
			}

			this.partialDatagram = this.payload.slice(payloadOffset, -2);
			// A node supporting the Transport Service Command Class, version 2
			// MUST NOT send Transport Service segments with the Payload field longer than 39 bytes.
			validatePayload(this.partialDatagram.length <= MAX_SEGMENT_SIZE);
		} else {
			this.datagramSize = options.datagramSize;
			this.sessionId = options.sessionId;
			this.headerExtension = options.headerExtension;
			this.partialDatagram = options.partialDatagram;
		}
	}

	public datagramSize: number;
	public sessionId: number;
	public headerExtension: Buffer | undefined;
	public partialDatagram: Buffer;
	public encapsulated!: CommandClass;

	public serialize(): Buffer {
		// Transport Service re-uses the lower 3 bits of the ccCommand as payload
		this.ccCommand =
			(this.ccCommand & 0b11111_000) |
			((this.datagramSize >>> 8) & 0b111);

		const ext = !!this.headerExtension && this.headerExtension.length >= 1;
		this.payload = Buffer.from([
			this.datagramSize & 0xff,
			((this.sessionId & 0b1111) << 4) | (ext ? 0b1000 : 0),
		]);
		if (ext) {
			this.payload = Buffer.concat([
				this.payload,
				Buffer.from([this.headerExtension!.length]),
				this.headerExtension!,
			]);
		}
		this.payload = Buffer.concat([
			this.payload,
			this.partialDatagram,
			Buffer.alloc(2, 0), // checksum
		]);

		// Compute and save the CRC16 in the payload
		// The CC header is included in the CRC computation
		const headerBuffer = Buffer.from([this.ccId, this.ccCommand]);
		let crc = CRC16_CCITT(headerBuffer);
		crc = CRC16_CCITT(this.payload.slice(0, -2), crc);
		// Write the checksum into the last two bytes of the payload
		this.payload.writeUInt16BE(crc, this.payload.length - 2);

		return super.serialize();
	}

	public expectMoreMessages(): boolean {
		return true; // The FirstSegment message always expects more messages
	}

	public getPartialCCSessionId(): Record<string, any> | undefined {
		// Only use the session ID to identify the session, not the CC command
		return { ccCommand: undefined, sessionId: this.sessionId };
	}

	protected computeEncapsulationOverhead(): number {
		// Transport Service CC (first segment) adds 1 byte datagram size, 1 byte Session ID/..., 2 bytes checksum and (0 OR n+1) bytes header extension
		return (
			super.computeEncapsulationOverhead() +
			4 +
			(this.headerExtension?.length ? 1 + this.headerExtension.length : 0)
		);
	}
}

interface TransportServiceCCSubsequentSegmentOptions
	extends TransportServiceCCFirstSegmentOptions {
	datagramOffset: number;
}
@CCCommand(TransportServiceCommand.SubsequentSegment)
// @expectedCCResponse(TransportServiceCCReport)
export class TransportServiceCCSubsequentSegment extends TransportServiceCC {
	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| TransportServiceCCSubsequentSegmentOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			// Deserialization has already split the datagram size from the ccCommand.
			// Therefore we have one more payload byte

			validatePayload(this.payload.length >= 7); // 2 bytes dgram size, 1 byte sessid/ext/offset, 1 byte offset, 1+ bytes payload, 2 bytes checksum

			// Verify the CRC
			const headerBuffer = Buffer.from([
				this.ccId,
				this.ccCommand | this.payload[0],
			]);
			const ccBuffer = this.payload.slice(1, -2);
			let expectedCRC = CRC16_CCITT(headerBuffer);
			expectedCRC = CRC16_CCITT(ccBuffer, expectedCRC);
			const actualCRC = this.payload.readUInt16BE(
				this.payload.length - 2,
			);
			validatePayload(expectedCRC === actualCRC);

			this.datagramSize = this.payload.readUInt16BE(0);
			this.sessionId = this.payload[2] >>> 4;
			this.datagramOffset =
				((this.payload[2] & 0b111) << 8) + this.payload[3];
			let payloadOffset = 4;

			// If there is a header extension, read it
			const hasHeaderExtension = !!(this.payload[2] & 0b1000);
			if (hasHeaderExtension) {
				const extLength = this.payload[4];
				this.headerExtension = this.payload.slice(5, 5 + extLength);
				payloadOffset += 1 + extLength;
			}

			this.partialDatagram = this.payload.slice(payloadOffset, -2);
			// A node supporting the Transport Service Command Class, version 2
			// MUST NOT send Transport Service segments with the Payload field longer than 39 bytes.
			validatePayload(this.partialDatagram.length <= MAX_SEGMENT_SIZE);
		} else {
			this.datagramSize = options.datagramSize;
			this.datagramOffset = options.datagramOffset;
			this.sessionId = options.sessionId;
			this.headerExtension = options.headerExtension;
			this.partialDatagram = options.partialDatagram;
		}
	}

	public datagramSize: number;
	public datagramOffset: number;
	public sessionId: number;
	public headerExtension: Buffer | undefined;
	public partialDatagram: Buffer;

	// This can only be received
	private _encapsulated!: CommandClass;
	public get encapsulated(): CommandClass {
		return this._encapsulated;
	}

	public expectMoreMessages(
		session: [
			TransportServiceCCFirstSegment,
			...TransportServiceCCSubsequentSegment[]
		],
	): boolean {
		if (!(session[0] instanceof TransportServiceCCFirstSegment)) {
			// First segment is missing
			return true;
		}
		const datagramSize = session[0].datagramSize;
		const chunkSize = session[0].partialDatagram.length;
		const received = new Array<boolean>(
			Math.ceil(datagramSize / chunkSize),
		).fill(false);
		for (const segment of [...session, this]) {
			const offset =
				segment instanceof TransportServiceCCFirstSegment
					? 0
					: segment.datagramOffset;
			received[offset / chunkSize] = true;
		}
		// Expect more messages as long as we haven't received everything
		return !received.every(Boolean);
	}

	public getPartialCCSessionId(): Record<string, any> | undefined {
		// Only use the session ID to identify the session, not the CC command
		return { ccCommand: undefined, sessionId: this.sessionId };
	}

	public mergePartialCCs(
		partials: [
			TransportServiceCCFirstSegment,
			...TransportServiceCCSubsequentSegment[]
		],
	): void {
		// Concat the CC buffers
		const datagram = Buffer.allocUnsafe(this.datagramSize);
		for (const partial of [...partials, this]) {
			// Ensure that we don't try to write out-of-bounds
			const offset =
				partial instanceof TransportServiceCCFirstSegment
					? 0
					: partial.datagramOffset;
			if (offset + partial.partialDatagram.length > datagram.length) {
				throw new ZWaveError(
					`The partial datagram offset and length in a segment are not compatible to the communicated datagram length`,
					ZWaveErrorCodes.PacketFormat_InvalidPayload,
				);
			}
			partial.partialDatagram.copy(datagram, offset);
		}

		// and deserialize the CC
		this._encapsulated = CommandClass.from(this.driver, {
			data: datagram,
			fromEncapsulation: true,
			encapCC: this,
		});
	}

	public serialize(): Buffer {
		// Transport Service re-uses the lower 3 bits of the ccCommand as payload
		this.ccCommand =
			(this.ccCommand & 0b11111_000) |
			((this.datagramSize >>> 8) & 0b111);

		const ext = !!this.headerExtension && this.headerExtension.length >= 1;
		this.payload = Buffer.from([
			this.datagramSize & 0xff,
			((this.sessionId & 0b1111) << 4) |
				(ext ? 0b1000 : 0) |
				((this.datagramOffset >>> 8) & 0b111),
			this.datagramOffset & 0xff,
		]);
		if (ext) {
			this.payload = Buffer.concat([
				this.payload,
				Buffer.from([this.headerExtension!.length]),
				this.headerExtension!,
			]);
		}
		this.payload = Buffer.concat([
			this.payload,
			this.partialDatagram,
			Buffer.alloc(2, 0), // checksum
		]);

		// Compute and save the CRC16 in the payload
		// The CC header is included in the CRC computation
		const headerBuffer = Buffer.from([this.ccId, this.ccCommand]);
		let crc = CRC16_CCITT(headerBuffer);
		crc = CRC16_CCITT(this.payload.slice(0, -2), crc);
		// Write the checksum into the last two bytes of the payload
		this.payload.writeUInt16BE(crc, this.payload.length - 2);

		return super.serialize();
	}

	protected computeEncapsulationOverhead(): number {
		// Transport Service CC (first segment) adds 1 byte datagram size, 1 byte Session ID/..., 1 byte offset, 2 bytes checksum and (0 OR n+1) bytes header extension
		return (
			super.computeEncapsulationOverhead() +
			5 +
			(this.headerExtension?.length ? 1 + this.headerExtension.length : 0)
		);
	}
}

interface TransportServiceCCSegmentRequestOptions extends CCCommandOptions {
	sessionId: number;
	datagramOffset: number;
}

function testResponseForSegmentRequest(
	sent: TransportServiceCCSegmentRequest,
	received: TransportServiceCC,
): CCResponseRole {
	return (
		(sent.datagramOffset === 0 &&
			received instanceof TransportServiceCCFirstSegment &&
			received.sessionId === sent.sessionId) ||
		(sent.datagramOffset > 0 &&
			received instanceof TransportServiceCCSubsequentSegment &&
			sent.datagramOffset === received.datagramOffset &&
			received.sessionId === sent.sessionId)
	);
}

@CCCommand(TransportServiceCommand.SegmentRequest)
@expectedCCResponse(TransportServiceCC, testResponseForSegmentRequest)
export class TransportServiceCCSegmentRequest extends TransportServiceCC {
	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| TransportServiceCCSegmentRequestOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			validatePayload(this.payload.length >= 3);
			this.sessionId = this.payload[1] >>> 4;
			this.datagramOffset =
				((this.payload[1] & 0b111) << 8) + this.payload[2];
		} else {
			this.sessionId = options.sessionId;
			this.datagramOffset = options.datagramOffset;
		}
	}

	public sessionId: number;
	public datagramOffset: number;

	public serialize(): Buffer {
		this.payload = Buffer.from([
			((this.sessionId & 0b1111) << 4) |
				((this.datagramOffset >>> 8) & 0b111),
			this.datagramOffset & 0xff,
		]);
		return super.serialize();
	}
}

interface TransportServiceCCSegmentCompleteOptions extends CCCommandOptions {
	sessionId: number;
}

@CCCommand(TransportServiceCommand.SegmentComplete)
export class TransportServiceCCSegmentComplete extends TransportServiceCC {
	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| TransportServiceCCSegmentCompleteOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			validatePayload(this.payload.length >= 2);
			this.sessionId = this.payload[1] >>> 4;
		} else {
			this.sessionId = options.sessionId;
		}
	}

	public sessionId: number;

	public serialize(): Buffer {
		this.payload = Buffer.from([(this.sessionId & 0b1111) << 4]);
		return super.serialize();
	}
}

interface TransportServiceCCSegmentWaitOptions extends CCCommandOptions {
	pendingSegments: number;
}

@CCCommand(TransportServiceCommand.SegmentWait)
export class TransportServiceCCSegmentWait extends TransportServiceCC {
	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| TransportServiceCCSegmentWaitOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			validatePayload(this.payload.length >= 2);
			this.pendingSegments = this.payload[1];
		} else {
			this.pendingSegments = options.pendingSegments;
		}
	}

	public pendingSegments: number;

	public serialize(): Buffer {
		this.payload = Buffer.from([this.pendingSegments]);
		return super.serialize();
	}
}
