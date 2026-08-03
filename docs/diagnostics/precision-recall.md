# Deterministic diagnostics fixture report

Corpus: 30 synthetic positive, negative, and edge fixtures.

| Rule                                             |  TP |  TN |  FP |  FN | Precision | Recall |
| ------------------------------------------------ | --: | --: | --: | --: | --------: | -----: |
| no-tests-after-final-change                      |   2 |   1 |   0 |   0 |      1.00 |   1.00 |
| success-claim-after-unresolved-failure           |   1 |   2 |   0 |   0 |      1.00 |   1.00 |
| repeated-identical-failed-command                |   2 |   1 |   0 |   0 |      1.00 |   1.00 |
| modified-file-without-observed-inspection        |   2 |   1 |   0 |   0 |      1.00 |   1.00 |
| unresolved-error-at-session-end                  |   2 |   1 |   0 |   0 |      1.00 |   1.00 |
| pre-existing-versus-introduced-failure           |   2 |   1 |   0 |   0 |      1.00 |   1.00 |
| compaction-followed-by-user-correction           |   2 |   1 |   0 |   0 |      1.00 |   1.00 |
| skill-instruction-contradiction-signal           |   1 |   2 |   0 |   0 |      1.00 |   1.00 |
| repeated-tool-error-loop                         |   2 |   1 |   0 |   0 |      1.00 |   1.00 |
| declined-approval-followed-by-equivalent-request |   1 |   2 |   0 |   0 |      1.00 |   1.00 |

Overall precision: 1.00. Overall recall: 1.00.

This report measures only the committed deterministic fixture corpus; it is not a claim about real-world incidence or quality.
