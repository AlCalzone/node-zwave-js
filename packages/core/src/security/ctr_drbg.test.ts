import * as fs from "fs";
import * as path from "path";
import { CtrDRBG } from "./ctr_drbg";

function getVectors(alg: string) {
	const text = fs.readFileSync(
		path.join(__dirname, "ctr_drbg.test.vectors.txt"),
		"utf8",
	);
	const vectors = [];

	let from = -1;

	while (true) {
		from = text.indexOf(`[${alg}]`, from + 1);

		if (from === -1) break;

		for (let i = 0; i < 15; i++) {
			const vector: Record<string, any> = {};
			const start = text.indexOf(`COUNT = ${i}`, from);
			const end = text.indexOf("\n\n", start);
			const items = text.slice(start, end).split("\n");

			for (let j = 1; j < items.length; j++) {
				const key = items[j].split(" = ")[0];
				const value = Buffer.from(items[j].split(" = ")[1], "hex");

				if (vector[key]) vector[key] = [vector[key], value];
				else vector[key] = value;
			}

			vectors.push(vector);
		}
	}

	return vectors;
}

describe("CtrDRBG", () => {
	for (const df of [false, true]) {
		for (const id of ["AES-128"]) {
			const name = id + (df ? " use df" : " no df");
			const vectors = getVectors(name);
			const bits = parseInt(id.slice(-3)) as 128;

			for (const [i, vector] of vectors.entries()) {
				it(`should pass ${name} NIST vector #${
					i + 1
				} (ctr,df=${df})`, () => {
					const drbg = new CtrDRBG(bits, df);

					drbg.init(
						vector.EntropyInput,
						vector.Nonce,
						vector.PersonalizationString,
					);

					drbg.reseed(
						vector.EntropyInputReseed,
						vector.AdditionalInputReseed,
					);

					drbg.generate(
						vector.ReturnedBits.length,
						vector.AdditionalInput[0],
					);

					const result = drbg.generate(
						vector.ReturnedBits.length,
						vector.AdditionalInput[1],
					);

					expect(result).toEqual(vector.ReturnedBits);
				});
			}
		}
	}
});
