# Codex: Kompaktieren und neu anlegen (2026-11-24)

Die Auswertung der lokalen Codex-Sitzungsdaten umfasst 36 Kompaktierungen in 69 untersuchten Sitzungen.

- Der /compact- bzw. Auto-Compact-Turn meldet lokal 0 Token. Codex kompaktiert serverseitig (`/responses/compact`); die eigentlichen Kosten sind lokal nicht sichtbar.
- Erster Turn nach dem Compact: 24–73k Input, davon nur ~12k gecacht (gemeinsames Präfix). Es werden also 12–60k ungecacht gelesen.
- Mehrfach-Compact in einer Session: die Basis wächst, z. B. 39k → 46k → 49k → 67k → 73k bzw. 34k → 44k → 50k.
- Neu anlegen (Live-Test): erster Turn 20,6k Input, davon 14k gecacht, also ~6,6k ungecacht. Der Wiederaufnahmebrief selbst hat ~400 Token. Die neue Sitzung übernimmt ihren Arbeitsstand aus dem Brief.
- Neue Sessions wachsen durch erneutes Lesen von Dateien: Median 95k bei Request 20, 239k bei Request 100.

Anthropic beschreibt einen Ansatz mit neuen Sitzungen und einer Übergabe über Fortschrittsdatei, Git und Feature-Liste. Die Claude-Code-Dokumentation erklärt, wie der Cache beim Kompaktieren genutzt und anschließend für den reduzierten Verlauf neu aufgebaut wird. Die ACE-Studie beschreibt den Verlust von Details bei wiederholtem Umschreiben von Kontext. [Anthropic](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents) · [Claude Code](https://code.claude.com/docs/en/prompt-caching#compacting-the-conversation) · [ACE](https://arxiv.org/abs/2510.04618)

Aus den Messungen ergibt sich die kombinierte Strategie für Leerlauf und Wiederaufnahme.

- Mitten in einem Arbeitspaket: vor dem Abkühlen warm kompaktieren, weil das Arbeitsdetail erhalten bleibt.
- An Paketgrenzen (CHECKPOINT gilt, keine laufenden Worker), nach 2 Kompaktierungen oder bei einer Basis über ~60k nach dem Compact: neu anlegen plus Brief.
- Bei kaltem Kontext schlägt die Factory eine Erneuerung mit Brief vor. Die Erneuerung nutzt einen Rewind im selben Tab, sofern der Agent einen geeigneten Rücksprungpunkt hat und der Provider Rewind unterstützt. [Cold-context design](../cold-context-resume.md#same-tab-refresh-via-rewind)

## Erneuern im selben Tab per Rewind

Im Live-Test startete Codex den Thread vor einer ausgewählten Nutzernachricht neu. Agent-ID, Tab, Labels und Position blieben erhalten. Der bisherige Thread blieb lokal gespeichert.

- Vor dem ersten Rewind lag der Kontext bei 31k Token. Danach brauchte der erste Turn mit Brief 21,7k Input-Token, davon 14k gecacht.
- Beim zweiten Rewind diente der vorherige Brief als Rücksprungpunkt. Der nächste Turn brauchte 22,1k Input-Token, davon 14k gecacht. Vor dem Brief blieb ein kurzer Testwechsel von rund 0,5k Token erhalten.

Paseo kann nur auf echte `user_message`-Einträge zurückspulen. Nachrichten, die via `paseo send` aus einem Agenten gesendet werden, erscheinen als Tool-Aufrufe. Die Factory stellt den Brief nach einem manuellen Rewind ohne Absender-Agent zu, damit der nächste Rewind ihn als Rücksprungpunkt verwenden kann. Die Timeline im Tab zeigt den Verlauf bis zum Rücksprungpunkt und die neuen Nachrichten. [Implementierung und Fallbacks](../cold-context-resume.md#same-tab-refresh-via-rewind)
