# Historical A100 benchmark manifest

This directory preserves a native-GPU result imported from the Subspace
repository.  The text file is historical evidence, not a result reproduced by
the current checkout.

## Provenance and integrity

- Source repository: `https://github.com/jianmliu/subspace`
- Source commit: `8d8569004c2322aabe26cd59c12bbfe7dc4de1a1`
- Source path: `porw-poc/results/gpu-bench-20260820-151723.txt`
- Preserved file: `gpu-bench-20260820-151723.txt`
- Raw size: `1068` bytes
- Raw SHA-256: `48aa261cd63d144a421c8fb9573a8af13b7a19cd4258df5ab08ceb187192afe2`
- Imported split commit that introduced the artifact:
  `46ba416dbbb60cc433ed97aeabe3749ab9badffe`

## Facts recorded in the source artifact

- Hostname: `placid-wicked-love`
- UTC time: `2026-08-20 15:17:23 UTC`
- GPU: `NVIDIA A100 80GB PCIe`
- Reported memory: `81920 MiB`
- Reported maximum memory clock: `1512 MHz`
- Native correctness result: `11 passed, 1 warning in 2.49s`

| E | N | K | M | top-k | Weight size | Wrapper baseline | Wrapper fused | Wrapper ratio | Wrapper sweep |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 8 | 1024 | 2048 | 4 | 2 | 0.03 GB | 0.230 ms | 0.248 ms | 8.03% | 370 GB/s |
| 8 | 1024 | 2048 | 64 | 2 | 0.03 GB | 0.253 ms | 0.271 ms | 7.42% | 377 GB/s |
| 64 | 512 | 2048 | 64 | 8 | 0.13 GB | 0.571 ms | 0.586 ms | 2.71% | 848 GB/s |
| 64 | 4096 | 2048 | 16 | 8 | 1.07 GB | 1.110 ms | 1.206 ms | 8.65% | 1401 GB/s |

## Fields absent from the source artifact

- Python version: `not recorded in source artifact`
- PyTorch version: `not recorded in source artifact`
- Triton version: `not recorded in source artifact`
- CUDA runtime version: `not recorded in source artifact`
- NVIDIA driver version: `not recorded in source artifact`
- GPU power limit or power policy: `not recorded in source artifact`
- Warm-up count: `not recorded in source artifact`
- Timed iteration or sample count: `not recorded in source artifact`
- Slot seed: `not recorded in source artifact`

The throughput values above apply only to this historical native A100 run.
CPU or Triton-interpreter correctness runs do not update throughput claims.

The imported benchmark timed the complete public wrappers. Each baseline and
fused callback therefore included GPU-to-CPU routing transfer, NumPy alignment
and validation, fresh device-buffer allocation/transfers, and result D2H
copies. Their reported ratio is historical **end-to-end wrapper timing**, not a
device-side fused-kernel overhead measurement. The sweep callback likewise
included wrapper preparation. These values must not be relabeled under the
current prepared-device-launch benchmark semantics without a new native-GPU
run.
