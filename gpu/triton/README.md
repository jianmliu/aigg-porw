# PoRW P1 PoC — 推理融合 sketch 可行性验证

见设计文档 `docs/proof-of-resident-weights.md` 与可行性报告
`docs/porw-p1-feasibility.md`。

## 内容

- `porw_sketch/spec.py` — sketch 的 NumPy 实现参考；规范权威来自锁定的
  私有 `aigg-spec` 发布，不由此文件定义。
- `porw_sketch/kernels.py` — Triton kernel：
  - `moe_gemm_sketch_kernel`：vLLM `fused_moe_kernel` 的结构复刻 +
    在权重 tile 加载点融合 sketch（`ENABLE_SKETCH` constexpr 可开关）；
  - `sketch_sweep_kernel`：独立扫描（S1，用于 dense/cuBLAS 层）。
- `porw_sketch/reference.py` — `moe_align_block_size` 最小复刻与 GEMM 参考。
- `tests/test_sketch.py` — 10 项验证（无 GPU 时自动走 Triton CPU 解释器）。
- `bench_gpu.py` — GPU 开销基准（需真实 GPU，测融合开销 % 与扫描 GB/s）。

## 运行

```bash
pip install numpy torch triton pytest   # CPU 环境即可
python -m pytest tests/ -q              # TRITON_INTERPRET=1 自动启用
```

## 已验证（CPU 解释器，与 GPU 后端语义一致）

1. sketch 实现：确定性、slot 敏感性、任意分块/求和顺序不变性，以及
   单个 word 的单比特变化会改变线性 sketch；这不是抗碰撞声明。
2. 融合 kernel：GEMM 结果正确；覆盖到的 tile 的 sketch 与锁定向量及实现参考逐位一致；
   冷专家不产生覆盖；不同 batch 组成下 sketch/覆盖不变（幂等存储语义）；
   融合路径与独立扫描路径逐 tile 一致（dense 与 MoE 可共用验证器）。
3. 攻击演示：tile 级常数系数方案可由 4 字节/tile 的摘要重现；已记录的
   64 泛函/最小二乘实验只说明这些具体实验未重现测试输出，不构成一般
   抗伪造或安全性结论。

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

## 待 GPU 复测（bench_gpu.py，同一条 ssh 命令）

- 1 GB 配置下的融合开销与 sweep GB/s（预期 sweep 显著高于 v1 的
  947–1119 GB/s）；
- 融合版剩余差距归因（fp32 dot 基线 vs fp16 tensor core 为后续项）。
