# Private research release process

## Release identity

- Release: `v0.1.0-research.1`
- Classification: `research`
- Scheme: `aigg:porw:sketch-tile:v2`
- Normative spec tag: `porw-sketch-tile-v2.0.0-private.4`
- Normative spec commit: `4e4a9390008948c1912be9a8eb0653ea1e03cd64`
- Vector SHA-256:
  `fb321155cfb731e2506df13c8c741d97647875998cd825212c6494a7292e00e7`
- Provenance SHA-256:
  `fbb301486fb47da28fbfdad96a062abb3ad88615e0e3a1044ff0e0dbd3d1fc50`

Earlier private spec tags `.private.1`, `.private.2`, and `.private.3` are
superseded evidence and are not compatibility targets for this release.

The release remains private. It publishes no package or contract and integrates
neither Subspace nor `ai3-inference` as a consumer.

## Required release gates

Before the annotated tag is created, all of the following must apply to the exact
commit being tagged:

1. the complete implementation diff has passed independent specification and
   code-quality review;
2. the Linux x86_64 conformance workflow has run CPython 3.12.13 with the
   hash-locked dependencies and completed every required Triton interpreter
   kernel test with zero skips;
3. Rust default, workspace, `scale`, and no-default-features gates pass;
4. the canonical vector and provenance match `spec-lock.json` byte for byte;
5. the full Solidity suite and the Foundry 1.7.1/London real-Anvil
   `--check-committed` benchmark pass without deterministic drift, and CI
   uploads the resulting fresh report rather than the committed baseline; and
6. the worktree and submodule are clean.

The tag must not be created from a locally exceptional or skipped gate. Conformance
is not a security audit. The mandatory production-security work in
[`SECURITY.md`](SECURITY.md) remains outstanding, and production rewards,
custody, slashing, and eligibility effects remain disabled.

## Reproduce the local portions

From the repository root:

```sh
cargo test --workspace --locked
cargo test -p aigg-porw-core --locked
cargo test -p aigg-porw-core --features scale --locked
cargo check -p aigg-porw-core --no-default-features --locked

gpu/triton/.venv/bin/python -m pytest \
  gpu/triton/tests/test_sketch.py \
  gpu/triton/tests/test_conformance.py \
  gpu/triton/tests/test_kernel_validation.py \
  gpu/triton/tests/test_benchmark_honesty.py -q -rs

(cd contracts/evm && forge clean && forge test -vv)
contracts/evm/scripts/run-anvil-benchmark.sh --check-committed
git diff --check
git status --short --branch
```

The Darwin command can reproduce CPU conformance, but it cannot discharge the
Linux Triton interpreter gate when Triton is unavailable. Only the required
Linux CI result is release evidence for that gate.

## Tag only after review and Linux CI

The release controller must run these commands from the reviewed commit after
confirming the required CI checks belong to that same commit:

```sh
set -euo pipefail

# Set this to the independently reviewed commit approved for release.
test -n "${EXPECTED_REVIEWED_COMMIT:?set EXPECTED_REVIEWED_COMMIT}"
command -v gh >/dev/null
git fetch --no-tags origin \
  refs/heads/main:refs/remotes/origin/main
release_commit="$(git rev-parse --verify "${EXPECTED_REVIEWED_COMMIT}^{commit}")"
test "$(git rev-parse --verify HEAD)" = "$release_commit"
test "$(git rev-parse --verify refs/remotes/origin/main)" = "$release_commit"
test -z "$(git status --porcelain --untracked-files=all)"
test -z "$(git submodule status --recursive | sed -n '/^[+-U]/p')"
test -z "$(git tag --list v0.1.0-research.1)"

# Query check runs for the immutable commit, not a branch-level badge. The API
# command and each required conclusion are fail-fast prerequisites to tagging.
repo="jianmliu/aigg-porw"
for required_check in \
  "Rust, spec lock, and Triton interpreter" \
  "Solidity and receipt-backed London gas"
do
  summary="$(gh api --method GET \
    "repos/$repo/commits/$release_commit/check-runs" \
    -f per_page=100 \
    -f filter=latest \
    --jq ".check_runs | map(select(.name == \"$required_check\")) | [length, (map(select(.status == \"completed\" and .conclusion == \"success\")) | length)] | @tsv")"
  read -r matching successful <<<"$summary"
  test "$matching" -ge 1
  test "$successful" = "$matching"
done

git tag -a v0.1.0-research.1 "$release_commit" \
  -m "Private PoRW research release 0.1.0"
test "$(git cat-file -t refs/tags/v0.1.0-research.1)" = tag
test "$(git rev-list -n 1 v0.1.0-research.1)" = "$release_commit"
git push origin refs/tags/v0.1.0-research.1
```

The reviewed commit is fast-forwarded to private `origin/main` only after its
exact-head checks succeed; this procedure therefore tags that protected remote
identity. Never retarget or force-push the release tag.
