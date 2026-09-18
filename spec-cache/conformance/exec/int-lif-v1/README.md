# `aigg:exec:int-lif:v1` — conformance material (real FlyWire export)

Cached here so the execution kind can be re-verified without re-downloading 850 MB.
The payload itself (28 MB) is not committed; it is reproduced byte for byte by
`gpu/triton/demo/fly_brain/flywire_export.py` from the public sources named in the
manifest (Zenodo 10676866, CC-BY-4.0; flywire_annotations). Its sha256 is in the manifest.

| file | content |
|---|---|
| `flywire-fafb-v783-min5.payload-manifest.json` | exporter manifest: 139,255 neurons, 2,700,513 post-sorted signed records (≥5 synapses), sha256 of the payload |
| `flywire-fafb-v783-min5.ids.json` | `model_id` (keccak weights root), exec-kind digest, `mep_id` for steps = 100, stride = 10 |
| `flywire-fafb-v783-min5.int-lif-v1.seed7-500steps.numpy.json` | the numpy reference trajectory (`web/porw-browser/int_lif.py`): sha256 of the state-leaf preimages after every step 0..500 with the canonical stimulus set of seed 7 (151 neurons), spike totals |
| `int-lif-v1.transition-vectors.json` | single-neuron transition vectors covering every branch (stimulated, refractory, spike, sub-threshold, inhibitory input) — also compiled into `contracts/evm/test/fixtures/LifVectors.sol` |

Reproduce: export the payload, then
`node web/porw-browser/test_lif.mjs <payload> <numpy.json>` (wasm scatter == wasm rows == numpy
for all 500 steps) and `forge test --match-contract LifRowCheckTest`.
