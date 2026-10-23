# Load simulation results

Generated 2026-10-21T18:12:52.881Z. Intent TTL 15s, user max fee $0.5, 120s of arrivals per run.

Raw capacity (fills/s if a rollup were empty): A=10.0, B=8.3, C=3.8; background load uses A 30%, B 20%, C 40%.

## Experiment 1: load sweep

| strategy | λ (intents/s) | throughput | fail rate | avg latency (s) | p95 latency (s) | avg fee ($) |
|---|---|---|---|---|---|---|
| always A | 2 | 1.88 | 0.0% | 0.43 | 0.90 | 0.0677 |
| always A | 6 | 5.95 | 0.0% | 1.03 | 3.55 | 0.2161 |
| always A | 10 | 4.90 | 50.3% | 8.30 | 14.80 | 0.1949 |
| always A | 14 | 4.73 | 65.3% | 9.48 | 13.35 | 0.1687 |
| always A | 20 | 4.48 | 77.7% | 9.86 | 14.15 | 0.1551 |
| always B | 2 | 1.88 | 0.0% | 1.99 | 3.70 | 0.0122 |
| always B | 6 | 5.95 | 0.0% | 2.18 | 4.00 | 0.0138 |
| always B | 10 | 2.94 | 70.1% | 8.85 | 14.45 | 0.0126 |
| always B | 14 | 1.83 | 86.5% | 8.90 | 14.75 | 0.0124 |
| always B | 20 | 1.32 | 93.5% | 8.24 | 13.90 | 0.0123 |
| always C | 2 | 1.88 | 0.0% | 1.65 | 3.15 | 0.0428 |
| always C | 6 | 0.69 | 88.4% | 8.25 | 14.50 | 0.0277 |
| always C | 10 | 0.57 | 94.2% | 8.00 | 14.45 | 0.0276 |
| always C | 14 | 0.51 | 96.3% | 8.33 | 14.20 | 0.0275 |
| always C | 20 | 0.44 | 97.8% | 7.65 | 13.65 | 0.0275 |
| round-robin | 2 | 1.88 | 0.0% | 1.12 | 3.35 | 0.0359 |
| round-robin | 6 | 5.95 | 0.0% | 1.28 | 3.30 | 0.0418 |
| round-robin | 10 | 8.33 | 15.4% | 2.75 | 13.35 | 0.0492 |
| round-robin | 14 | 9.99 | 26.7% | 1.89 | 7.80 | 0.0614 |
| round-robin | 20 | 14.05 | 30.1% | 3.11 | 10.50 | 0.1426 |
| router: cheapest | 2 | 1.88 | 0.0% | 1.99 | 3.70 | 0.0122 |
| router: cheapest | 6 | 5.95 | 0.0% | 2.03 | 3.70 | 0.0141 |
| router: cheapest | 10 | 9.85 | 0.0% | 6.52 | 11.60 | 0.0239 |
| router: cheapest | 14 | 13.63 | 0.0% | 7.03 | 11.95 | 0.0492 |
| router: cheapest | 20 | 15.40 | 23.4% | 9.06 | 11.95 | 0.0937 |
| router: balanced | 2 | 1.88 | 0.0% | 1.29 | 2.55 | 0.0266 |
| router: balanced | 6 | 5.95 | 0.0% | 1.92 | 3.55 | 0.0176 |
| router: balanced | 10 | 9.85 | 0.0% | 2.29 | 3.95 | 0.0267 |
| router: balanced | 14 | 13.63 | 0.0% | 5.24 | 11.15 | 0.0473 |
| router: balanced | 20 | 15.47 | 23.0% | 8.56 | 11.95 | 0.0965 |

## Experiment 2: incident (B background traffic ×4.5 at 30–60s, C halted at 75–100s, λ=5)

| strategy | fail rate | avg latency (s) | p95 latency (s) | avg fee ($) | share of confirmed |
|---|---|---|---|---|---|
| always A | 0.0% | 0.54 | 1.05 | 0.1131 | A:582 |
| always B | 2.1% | 6.58 | 13.50 | 0.0142 | B:570 |
| always C | 78.4% | 8.62 | 14.00 | 0.0285 | C:126 |
| round-robin | 11.0% | 1.77 | 4.45 | 0.0379 | A:194 C:130 B:194 |
| router: cheapest | 0.0% | 2.58 | 6.55 | 0.0155 | B:505 C:77 |
| router: balanced | 0.2% | 2.19 | 4.05 | 0.0195 | C:155 B:408 A:18 |
