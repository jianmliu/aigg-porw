#![cfg(feature = "repository-conformance")]

use sha2::{Digest, Sha256};

const EXPECTED_REPOSITORY: &str = "https://github.com/jianmliu/aigg-spec.git";
const EXPECTED_TAG: &str = "porw-sketch-tile-v2.0.0-private.4";
const EXPECTED_COMMIT: &str = "4e4a9390008948c1912be9a8eb0653ea1e03cd64";
const EXPECTED_SCHEME_ID: &str = "aigg:porw:sketch-tile:v2";
const EXPECTED_VECTOR_SET: &str = "sketch-tile-v2.0.0";
const EXPECTED_CACHE_PATH: &str = "spec-cache/conformance/porw/sketch-tile-v2.json";
const EXPECTED_PROVENANCE_CACHE_PATH: &str =
    "spec-cache/conformance/porw/sketch-tile-v2.provenance.json";
const EXPECTED_VECTOR_SHA256: &str =
    "fb321155cfb731e2506df13c8c741d97647875998cd825212c6494a7292e00e7";
const EXPECTED_PROVENANCE_SHA256: &str =
    "fbb301486fb47da28fbfdad96a062abb3ad88615e0e3a1044ff0e0dbd3d1fc50";

fn repository_root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn read_regular_file(path: &std::path::Path, label: &str) -> Vec<u8> {
    let metadata = std::fs::symlink_metadata(path)
        .unwrap_or_else(|error| panic!("missing {label} at {}: {error}", path.display()));
    assert!(
        metadata.file_type().is_file(),
        "{label} must be a regular non-symlink file: {}",
        path.display()
    );
    std::fs::read(path)
        .unwrap_or_else(|error| panic!("cannot read {label} at {}: {error}", path.display()))
}

#[test]
fn spec_lock_pins_the_current_research_vector_and_disables_economic_consequences() {
    let root = repository_root();
    let lock_path = root.join("spec-lock.json");
    let lock_bytes = read_regular_file(&lock_path, "spec lock");
    let lock: serde_json::Value = serde_json::from_slice(&lock_bytes)
        .unwrap_or_else(|error| panic!("invalid spec lock at {}: {error}", lock_path.display()));

    assert_eq!(lock["schema_version"], 1);
    assert_eq!(lock["aigg_spec"]["repository"], EXPECTED_REPOSITORY);
    assert_eq!(lock["aigg_spec"]["tag"], EXPECTED_TAG);
    assert_eq!(lock["aigg_spec"]["commit"], EXPECTED_COMMIT);
    assert_eq!(lock["aigg_spec"]["tag_status"], "current");
    assert_eq!(lock["aigg_spec"]["classification"], "canonical-research");
    assert_eq!(lock["conformance"]["scheme_id"], EXPECTED_SCHEME_ID);
    assert_eq!(lock["conformance"]["vector_set"], EXPECTED_VECTOR_SET);
    assert_eq!(lock["conformance"]["cache_path"], EXPECTED_CACHE_PATH);
    assert_eq!(
        lock["conformance"]["provenance_cache_path"],
        EXPECTED_PROVENANCE_CACHE_PATH
    );
    assert_eq!(lock["conformance"]["sha256"], EXPECTED_VECTOR_SHA256);
    assert_eq!(
        lock["conformance"]["provenance_sha256"],
        EXPECTED_PROVENANCE_SHA256
    );

    let vector_path = root.join(EXPECTED_CACHE_PATH);
    let provenance_path = root.join(EXPECTED_PROVENANCE_CACHE_PATH);
    let vector_bytes = read_regular_file(&vector_path, "cached conformance vector");
    let provenance_bytes = read_regular_file(&provenance_path, "cached vector provenance");
    let vector: serde_json::Value = serde_json::from_slice(&vector_bytes).unwrap_or_else(|error| {
        panic!(
            "invalid cached conformance vector at {}: {error}",
            vector_path.display()
        )
    });
    let provenance: serde_json::Value =
        serde_json::from_slice(&provenance_bytes).unwrap_or_else(|error| {
            panic!(
                "invalid cached vector provenance at {}: {error}",
                provenance_path.display()
            )
        });
    let vector_sha256 = format!("{:x}", Sha256::digest(&vector_bytes));
    let provenance_sha256 = format!("{:x}", Sha256::digest(&provenance_bytes));

    assert_eq!(vector_sha256, EXPECTED_VECTOR_SHA256);
    assert_eq!(provenance_sha256, EXPECTED_PROVENANCE_SHA256);
    assert_eq!(
        vector["scheme"]["id"], lock["conformance"]["scheme_id"],
        "the cached vector must implement the locked scheme"
    );
    assert_eq!(vector["params"]["tile_bytes"], 4096);
    assert_eq!(vector["params"]["tile_words"], 1024);
    assert_eq!(vector["params"]["golden32"], "0x9e3779b9");
    assert_eq!(
        vector["params"]["coverage_order"],
        "strictly ascending tile index"
    );
    assert_eq!(vector["params"]["hash"], "blake3");
    assert_eq!(vector["sketches"].as_array().map(Vec::len), Some(3));
    assert_eq!(provenance["classification"], "canonical-research");
    assert_eq!(provenance["scheme_id"], lock["conformance"]["scheme_id"]);
    assert_eq!(provenance["vector_set"], lock["conformance"]["vector_set"]);
    assert_eq!(provenance["sha256"], lock["conformance"]["sha256"]);
    assert_eq!(
        provenance["release_tags"][EXPECTED_TAG]["status"],
        lock["aigg_spec"]["tag_status"]
    );
    assert_eq!(lock["implementation"]["classification"], "research");
    assert_eq!(lock["implementation"]["economic_consequences"], "disabled");
    for consequence in ["rewards", "custody", "slashing", "eligibility"] {
        assert_eq!(
            lock["implementation"]["production"][consequence], "disabled",
            "production {consequence} must remain disabled"
        );
    }
}
