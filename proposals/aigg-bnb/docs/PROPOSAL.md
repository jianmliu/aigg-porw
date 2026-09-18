# Proposal: a verifiable fly-brain compute mesh on BNB Chain (draft)

**Summary.** Any browser tab becomes a bonded instance of the real *Drosophila* connectome
(FlyWire v783, 139,255 neurons, 2.7M synaptic connections): it keeps the model resident,
proves that residency (PoRW), runs deterministic integer neural simulation, and takes
distributed research tasks — parameter sweeps, stimulus-response predictions, in-silico
ablations — whose results anyone can re-execute or dispute down to a single synapse term
on-chain. BNB Chain provides the bond and settlement (opBNB), Greenfield the model store.

**Why BNB Chain.** Cheap, fast settlement makes the honest path (one signed claim per
instance per epoch, a few results per task) essentially free at 10k+ instances; Greenfield
gives publishers a content-addressed home for released brains; the wallet ecosystem
(EIP-712 typed data, one delegation per session) makes onboarding a single click.

**What exists.** aigg-porw: browser node (WASM SIMD, shared-memory workers), keccak PoRW
scheme with on-chain fraud proofs, two deterministic execution kinds (integer SpMV; integer
LIF on the real FlyWire export, bit-identical wasm/numpy/JS/Solidity), settlement and
interactive dispute contracts with measured gas, relay transport with censorship fallbacks,
EIP-712 session keys. This repo: the BNB deployment (beacon, Greenfield pointer, parameters,
deployment script).

**Asks.** Testnet deployment support (opBNB), Greenfield storage for released brains,
review of the beacon choice (commit-reveal vs a VRF service), and a small bounty pool to
seed the first bonded relays and instances.

**Deliverables.** (1) opBNB testnet deployment with the FlyWire brain published on Greenfield
testnet; (2) a public page: load the brain in your browser, delegate a session key, earn by
executing verified tasks; (3) a research-task track: a reproducible stimulus-response study
run by the mesh with every result disputable.
