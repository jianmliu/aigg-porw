// model id (keccak weights Merkle root, scheme aigg:porw:sketch-tile-keccak:v1) + MEP id of a payload file
//   node model_id.mjs <payload.bin> [steps] [commit stride]     (int-lif: the stride is the fifth mep_id field; default 10)
import fs from "node:fs";
import * as V from "./verify.js";
import { decodeHeader } from "./model.js";
import { makeMep } from "./mep.js";
import { lifExecKind } from "./lif.js";
const p = new Uint8Array(fs.readFileSync(process.argv[2])); const steps = Number(process.argv[3] || 100); const commitStride = Number(process.argv[4] || 10); const hdr = decodeHeader(p);
const n = Math.floor(p.length / V.TILE_BYTES); const lv = []; for (let t = 0; t < n; t++) lv.push(V.weightsLeaf(t, p.subarray(t * V.TILE_BYTES, (t + 1) * V.TILE_BYTES)));
const modelId = V.merkleRoot(lv); const mep = makeMep({ name: hdr.name, modelId, steps, execKind: hdr.version === 2 ? lifExecKind() : undefined, commitStride });
console.log(JSON.stringify({ name: hdr.name, version: hdr.version, neurons: hdr.neurons, synapses: hdr.synapses, tiles: n, schemeId: V.SCHEME_ID, schemeDigest: V.hex(mep.schemeDigest), modelId: V.hex(modelId), execKind: V.hex(mep.execKind), steps, field5: mep.clampQ16, mepId: V.hex(mep.mepId) }, null, 1));
