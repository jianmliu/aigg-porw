# License inventory

This repository has no repository-wide license. Components retain their own
declared or recorded terms.

| Component | Recorded terms | Status |
| --- | --- | --- |
| `crates/porw-core/` | 0BSD, declared in `Cargo.toml` and `LICENSE-0BSD` | Licensed as stated for the Rust crate only. |
| `contracts/evm/src/` and `contracts/evm/test/` | SPDX `MIT` headers in the imported Solidity files | Existing per-file terms preserved. |
| `contracts/evm/lib/forge-std/` | MIT or Apache-2.0, with `LICENSE-MIT` and `LICENSE-APACHE` | Vendored historical baseline; existing upstream terms preserved. |
| `gpu/triton/` | No license was recorded in the imported source baseline | Unresolved and private-only pending explicit clearance before any public distribution. |
| `spec-cache/` | Exact artifacts from a private `aigg-spec` release | Read-only private implementation input; this inventory does not grant redistribution rights. |
| Root documentation and repository metadata | No repository-wide license declared | Private repository material; no relicensing is implied. |
