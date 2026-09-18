// model id (keccak weights Merkle root, scheme aigg:porw:sketch-tile-keccak:v2), synapse root and MEP id
// of a payload file -- exactly the fields MEPRegistry.registerMEP pins.
//   node model_id.mjs <payload.bin>
import fs from "node:fs";
import * as V from "./verify.js";
import { loadKernelFromBytes } from "./porw.js";
import { PorwNode } from "./node.js";
const p = new Uint8Array(fs.readFileSync(process.argv[2]));
const wasm = fs.readFileSync(new URL("./sketch.wasm", import.meta.url));
const node = new PorwNode(await loadKernelFromBytes(wasm), { privHex: "0x" + "11".repeat(32) });
const st = await node.loadModel("model", p, { maxSteps: 1 });
console.log(JSON.stringify({
  name: st.hdr.name, version: st.hdr.version, neurons: st.hdr.neurons, synapses: st.hdr.synapses, tiles: st.nTiles,
  schemeDigest: V.hex(st.mep.schemeDigest), modelId: V.hex(st.modelId), execKind: V.hex(st.mep.execKind),
  synapseRoot: V.hex(st.csr.synapseRoot), mepId: V.hex(st.mep.mepId),
}, null, 1));
