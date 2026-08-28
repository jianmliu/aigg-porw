# Security posture

## Classification and production effects

This repository and release line are classified as **research**. Production
rewards, custody, slashing, and eligibility effects are disabled. No deployment
may use the current code or its outputs to grant or remove any of those effects.

Passing the conformance suites demonstrates agreement with locked proof-math
fixtures. It is not a security audit, an economic-security analysis, or evidence
of production readiness. A proof of available resident capacity does not prove
that a worker executed an inference request, returned the requested model's
output, or served a user's workload.

## Mandatory gates before a production-capable release

The following work is required before any release may enable production rewards,
custody, slashing, or eligibility effects:

1. a documented threat model covering prover, challenger, verifier, deployment
   adapter, compiler, GPU runtime, supply-chain, and economic adversaries;
2. adversarial, property, and fuzz testing across Rust, Triton/Python, Solidity,
   and every boundary between them;
3. an independent review of the PoRW construction and its security assumptions;
4. an independent smart-contract review, including deployment adapters and the
   complete challenge lifecycle; and
5. validation that deployment policy cannot confuse capacity availability with
   inference execution.

These are release gates, not optional recommendations. The present conformance
and gas evidence does not satisfy them.

## Reporting research security issues

Report vulnerabilities privately through this repository's GitHub Security
Advisories. Do not include secrets, production credentials, or personal data in
an issue. Because the software is research-only and production effects are
disabled, no response-time or bounty commitment is implied.
