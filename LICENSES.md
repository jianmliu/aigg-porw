# License inventory

This repository has no repository-wide license. Components retain their own
declared or recorded terms.

| Component | Recorded terms | Status |
| --- | --- | --- |
| `crates/porw-core/` | 0BSD, declared in `Cargo.toml` and `LICENSE-0BSD` | Licensed as stated for the Rust crate only. |
| `contracts/evm/src/` and `contracts/evm/test/` | SPDX `MIT` headers in the imported Solidity files | Existing per-file terms preserved. |
| `contracts/evm/lib/forge-std/` | MIT or Apache-2.0, with `LICENSE-MIT` and `LICENSE-APACHE` | Vendored historical baseline; existing upstream terms preserved. |
| `gpu/triton/` | No license was recorded in the imported source baseline | Unresolved and private-only pending explicit clearance before any public distribution. |
| `packages/python/` | No repository-authored license grant; `LICENSE-NOTICE.md` is informational | Private-only pending explicit clearance before any public distribution. |
| `spec-cache/` | Exact artifacts from a private `aigg-spec` release | Read-only private implementation input; this inventory does not grant redistribution rights. |
| Root documentation and repository metadata | No repository-wide license declared | Private repository material; no relicensing is implied. |

## Locked Python dependency inventory

The following inventory was audited from the metadata and license files of the
exact distributions in `packages/python/uv.lock`. These dependencies are not
vendored into the `aigg-porw` wheel; downstream installation and distribution
must continue to comply with their own terms. `colorama` is retained because it
is a locked Windows platform-marker dependency even though it is not installed
on Darwin.

| Locked distribution | Dependency role | Recorded metadata terms |
| --- | --- | --- |
| `blake3==1.0.9` | Runtime, direct | `CC0-1.0 OR Apache-2.0` (`License` metadata) |
| `numpy==2.5.2` | Runtime, direct | `BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0` (`License-Expression`; bundled component notices recorded in its wheel) |
| `hatchling==1.32.0` | Dev/build, direct | `MIT` (`License-Expression`) |
| `mypy==1.20.2` | Dev, direct | `MIT` (`License-Expression`; bundled typeshed license file recorded) |
| `pytest==9.1.1` | Dev, direct | `MIT` (`License-Expression`) |
| `ruff==0.16.5` | Dev, direct | `MIT` (`License-Expression`) |
| `colorama==0.4.6` | Pytest transitive, Windows marker | BSD 3-Clause text (`LICENSE.txt`) |
| `iniconfig==2.3.0` | Pytest transitive | `MIT` (`License-Expression`) |
| `librt==0.15.0` | Mypy transitive, non-PyPy marker | `MIT` (`License-Expression`) |
| `mypy-extensions==1.1.0` | Mypy transitive | `MIT` (`License-Expression`) |
| `packaging==26.3` | Hatchling/pytest transitive | `Apache-2.0 OR BSD-2-Clause` (`License-Expression`) |
| `pathspec==1.1.1` | Hatchling/mypy transitive | `MPL-2.0` (license classifier and `LICENSE`) |
| `pluggy==1.6.0` | Hatchling/pytest transitive | `MIT` (`License` metadata and classifier) |
| `pygments==2.21.0` | Pytest transitive | `BSD-2-Clause` (`License-Expression`) |
| `tomlkit==0.15.1` | Hatchling transitive | `MIT` (`License` metadata and classifier) |
| `trove-classifiers==2026.6.1.19` | Hatchling transitive | Apache Software License (classifier and `LICENSE`) |
| `typing-extensions==4.16.0` | Mypy transitive | `PSF-2.0` (`License-Expression`) |
