# Live benchmark (real Anvil rollups)

Generated 2026-10-21T18:19:22.171Z. 10s of transfer intents per run; static policies have re-routing disabled.

| load (intents/s) | policy | confirmed | success | avg end-to-end (s) | p95 (s) | avg fee ($) | executed on |
|---|---|---|---|---|---|---|---|
| 4 | router: balanced | 40/40 | 100% | 1.15 | 2.03 | 0.0281 | C:40 |
| 4 | router: cheapest | 40/40 | 100% | 2.38 | 4.06 | 0.0123 | B:40 |
| 4 | always A | 40/40 | 100% | 0.65 | 1.03 | 0.0702 | A:40 |
| 4 | always B | 40/40 | 100% | 1.95 | 3.87 | 0.0122 | B:40 |
| 4 | always C | 40/40 | 100% | 1.06 | 2.04 | 0.0281 | C:40 |
| 12 | router: balanced | 120/120 | 100% | 1.80 | 4.03 | 0.0186 | C:48 B:72 |
| 12 | router: cheapest | 120/120 | 100% | 2.02 | 4.04 | 0.0149 | B:100 C:20 |
| 12 | always A | 120/120 | 100% | 0.64 | 1.02 | 0.0702 | A:120 |
| 12 | always B | 120/120 | 100% | 2.85 | 4.83 | 0.0122 | B:120 |
| 12 | always C | 105/120 | 88% | 8.30 | 14.76 | 0.0281 | C:105 |
| 20 | router: balanced | 200/200 | 100% | 3.22 | 5.85 | 0.0196 | C:64 B:128 A:8 |
| 20 | router: cheapest | 200/200 | 100% | 4.76 | 8.37 | 0.0148 | B:168 C:32 |
| 20 | always A | 200/200 | 100% | 3.81 | 6.56 | 0.0702 | A:200 |
| 20 | always B | 200/200 | 100% | 5.78 | 10.39 | 0.0122 | B:200 |
| 20 | always C | 86/200 | 43% | 8.31 | 15.01 | 0.0281 | C:86 |
