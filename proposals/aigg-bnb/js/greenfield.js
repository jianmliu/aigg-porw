// Fetch a MEP's model bytes from a Greenfield storage provider and verify them against model_id
// (the keccak weights Merkle root) BEFORE the node loads them. The SP is untrusted: a wrong or
// stale object is rejected, so a malicious SP can only deny service.
//   pointer "gnfd://<bucket>/<object>" -> GET {spEndpoint}/view/{bucket}/{object}   (public-read objects)
import * as V from "../../../web/porw-browser/verify.js";

export function parsePointer(da) {
  const s = typeof da === "string" ? da : new TextDecoder().decode(da);
  const m = /^gnfd:\/\/([a-z0-9._-]+)\/([A-Za-z0-9._\/-]+)$/.exec(s); if (!m) throw new Error("not a gnfd pointer: " + s);
  return { bucket: m[1], object: m[2] };
}
export const objectUrl = (spEndpoint, ptr) => `${spEndpoint.replace(/\/$/, "")}/view/${ptr.bucket}/${ptr.object}`;
/** independent model id of a payload (keccak weights root over 4 KiB tiles) */
export function modelIdOf(bytes) { const n = Math.floor(bytes.length / V.TILE_BYTES); const lv = []; for (let t = 0; t < n; t++) lv.push(V.weightsLeaf(t, bytes.subarray(t * V.TILE_BYTES, (t + 1) * V.TILE_BYTES))); return V.merkleRoot(lv); }
/** download + verify; resolves { bytes, modelId, url } or throws "model id mismatch" */
export async function fetchVerified(spEndpoint, weightsDA, expectedModelId, { fetchImpl = fetch } = {}) {
  const ptr = parsePointer(weightsDA); const url = objectUrl(spEndpoint, ptr);
  const res = await fetchImpl(url); if (!res.ok) throw new Error(`SP ${res.status} for ${url}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length % V.TILE_BYTES !== 0) throw new Error("payload not tile-aligned");
  const modelId = modelIdOf(bytes);
  if (!V.eq(modelId, expectedModelId)) throw new Error(`model id mismatch: SP served ${V.hex(modelId)}, MEP pins ${V.hex(expectedModelId)}`);
  return { bytes, modelId, url };
}
