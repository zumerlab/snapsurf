# Resident sensor value probe v2

Status: **DESCRIPTIVE_SINGLE_RUN**

| Exterior decoy labels | Scope elements | report p50 | mark p50 | read p50 | mark+read p95 | retained heap p50 |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 54 | 2,507 B | 0.8 ms | 0.9 ms | 2.1 ms | 76,660 B |
| 1,000 | 54 | 2,507 B | 0.9 ms | 1 ms | 2.2 ms | 76,660 B |
| 10,000 | 54 | 2,507 B | 1 ms | 1.15 ms | 2.355 ms | 76,660 B |

Median report-byte growth from 100 to 10,000 exterior labels: **0%**.
p50 renderer TaskDuration growth: **19.88%** (single-run CPU proxy; no speed claim).

The prior state stayed as an opaque in-memory graph and never crossed the boundary. The report is descriptive: no expected result, PASS/FAIL, task verdict, SVG, or pixel capture.

At 100 labels, the portable counterfactual was 6,412 B (baseline + receipt), 2.56× the resident report p50; it is a wire-ready artifact comparison, not observed network egress.
At 1,000 labels, the portable counterfactual was 6,412 B (baseline + receipt), 2.56× the resident report p50; it is a wire-ready artifact comparison, not observed network egress.
At 10,000 labels, the portable counterfactual was 6,412 B (baseline + receipt), 2.56× the resident report p50; it is a wire-ready artifact comparison, not observed network egress.

The heap delta is a noisy Chromium diagnostic after forced GC, not an exact allocation measurement. No performance threshold was preregistered; timings are descriptive.
