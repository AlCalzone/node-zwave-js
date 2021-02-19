export enum KEXSchemes {
	KEXScheme1 = 1,
}

export enum ECDHProfiles {
	Curve25519 = 0,
}

export enum KEXFailType {
	NoKeyMatch = 0x01, // KEX_KEY
	NoSupportedScheme = 0x02, // KEX_SCHEME
	NoSupportedCurve = 0x03, // KEX_CURVES
	Decrypt = 0x05,
	BootstrappingCanceled = 0x06, // CANCEL
	WrongSecurityLevel = 0x07, // AUTH
	KeyNotGranted = 0x08, // GET
	NoVerify = 0x09, // VERIFY
	DifferentKey = 0x0a, // REPORT
}
