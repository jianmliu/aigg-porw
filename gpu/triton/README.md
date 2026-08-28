# PoRW P1 PoC — 推理融合 sketch 可行性验证

背景设计与可行性记录来自锁定的导入基线：
[`proof-of-resident-weights.md`](https://github.com/jianmliu/subspace/blob/8d8569004c2322aabe26cd59c12bbfe7dc4de1a1/docs/proof-of-resident-weights.md)
与 [`porw-p1-feasibility.md`](https://github.com/jianmliu/subspace/blob/8d8569004c2322aabe26cd59c12bbfe7dc4de1a1/docs/porw-p1-feasibility.md)。

## 内容

- `porw_sketch/spec.py` — sketch 的 NumPy 实现参考；规范权威来自锁定的
  私有 `aigg-spec` 发布，不由此文件定义。
- `porw_sketch/kernels.py` — Triton kernel：
  - `moe_gemm_sketch_kernel`：vLLM `fused_moe_kernel` 的结构复刻 +
    在权重 tile 加载点融合 sketch（`ENABLE_SKETCH` constexpr 可开关）；
  - `sketch_sweep_kernel`：独立扫描（S1，用于 dense/cuBLAS 层）。
- `porw_sketch/reference.py` — `moe_align_block_size` 最小复刻与 GEMM 参考。
- `tests/test_sketch.py` — 纯 NumPy 性质与 host wrapper 输入验证，以及单独
  门控的 Triton kernel 测试；纯测试不受 CUDA/Triton 可用性影响。
- `tests/test_conformance.py` — 独立的 Python BLAKE3/NumPy 锁定向量验证；
  不导入 Rust、Solidity 或 Triton 结果。
- `bench_gpu.py` — GPU 开销基准（需真实 GPU，测融合开销 % 与扫描 GB/s）。
- `requirements-test.in`、两个平台 hash lock 与 `ENVIRONMENT.md` —
  CPython 3.12.13 的固定测试环境及平台限制。

## 运行

```bash
gpu/triton/.venv/bin/python -m pytest gpu/triton/tests -q -rs
TRITON_INTERPRET=1 gpu/triton/.venv/bin/python \
  -m pytest gpu/triton/tests/test_sketch.py -q -rs
```

环境创建、固定版本及 GPU 基准命令见 [`ENVIRONMENT.md`](ENVIRONMENT.md)。
`TRITON_INTERPRET=1` 必须显式设置；不会因为缺少 CUDA 而自动声称解释器已运行。
安装必须使用对应平台的 lock 与 `pip --require-hashes`，不能直接从 `.in`
文件安装。

## 当前验证状态

- **当前 Darwin arm64 主机：**纯 NumPy 性质测试与锁定向量 conformance
  已通过。Triton 无可安装的 Darwin arm64 发行版，因此解释器 kernel 测试是
  environment-limited skip，不是通过。
- **历史 native GPU：**导入的 A100 80GB PCIe 原始结果与字段限制保存在
  [`benchmarks/gpu/historical/subspace-8d856900`](../../benchmarks/gpu/historical/subspace-8d856900/)
  中；它不是当前 checkout 的复测。
- **发布前门槛：**Task 9 Linux x86_64 CI 必须通过 Triton 解释器测试；native
  GPU 仍需使用当前脚本复测，新输出只写入 `benchmarks/gpu/generated/`。
  该脚本拒绝 dirty worktree，临时隔离 Triton cache，并为已创建的每个结果
  记录最终 success/failed 状态；生成目录被 Git 忽略。

## 纯参考测试已验证的性质

1. sketch 实现：确定性、slot 敏感性、任意分块/求和顺序不变性，以及
   单个 word 的单比特变化会改变线性 sketch；这不是抗碰撞声明。
2. 锁定向量：reference buffer/hash、系数、全部 sketch case、slot seed、
   weights/partials Merkle 树、ticket chunk、audit beacon、committed opening、
   interior non-inclusion、Fraud/NoFraud 代数结果逐项独立重算。向量不包含
   boundary admission 等部署策略案例。向量与 canonical provenance companion
   的原始 SHA-256 也被固定，因此没有另行语义执行的 formula、note 与说明
   文本仍受字节级完整性检查覆盖。
3. 攻击演示：tile 级常数系数方案可由 4 字节/tile 的摘要重现；v2 的两个
   word MSB 变化可确定性碰撞，但对应 BLAKE3 weights leaf 不同。已记录的
   64 泛函/最小二乘实验只说明这些具体实验未重现测试输出，不构成一般
   抗伪造或安全性结论。

当 Triton kernel gate 在受支持环境通过时，它验证 GEMM、coverage、batch
invariance，以及 fused/sweep 与 NumPy reference 的逐 tile 一致性；当前
Darwin arm64 结果不能替代该 gate。

## 实现 v2（u32 优化版）

- 字粒度 16-bit → **32-bit**（PRF 调用减半）；
- kernel 全部**原生 u32** 环绕算术（不再 int64+掩码模拟）；
  >int31 的常数经 int32 张量传入、kernel 内 bitcast，规避 Triton 字面量
  提升为 int64 的跨端不一致；
- **系数强制为奇数**（`c_j |= 1`）：这只防止单个 word 的 MSB 变化独自
  消失。对任意新鲜 slot，两个 word 的 MSB 变化仍会确定性抵消：奇数
  `c_p, c_q` 满足 `2^31 * (c_p + c_q) = 0 mod 2^32`；
- sweep kernel 支持覆盖子集（`tile_ids`）——S1-over-coverage 主路线的
  执行原语；
- 基准新增 1 GB 权重配置（压穿 A100 L2，真实 HBM 流式形态）。

## 研究限制

u32 线性 sketch 是代数一致性检查，不抗碰撞，也不证明字节完全相等、
权重驻留或推理执行。密码学 Merkle opening 只能认证抽样字节与 commitment
一致，并依赖部署层的准入和 challenge 假设。身份、签名、deadline、共识与
经济后果均属于适配器范围。

## 待 native GPU 复测

- 1 GB 配置下的融合开销与 sweep GB/s（预期 sweep 显著高于 v1 的
  947–1119 GB/s）；
- 融合版剩余差距归因（fp32 dot 基线 vs fp16 tensor core 为后续项）。
